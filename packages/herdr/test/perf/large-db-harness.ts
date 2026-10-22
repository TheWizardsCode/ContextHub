/**
 * Large-DB Herdr refresh budget harness and baseline (F1 —
 * WL-0MVJV2N3A001LE5G).
 *
 * The parent epic (WL-0MVJC1EQX001QR9W) needs measurable, repeatable evidence
 * for its acceptance criteria at the operator's real scale (~2,600 items /
 * ~100 MB worklog DB):
 *
 *   - a default-view refresh (event → data load → render) ≤ ~1.5 s p95 wall,
 *   - ≤ ~200 ms aggregate TUI event-loop blocking during a refresh,
 *   - a documented per-spawn RSS budget and ≤ ~300 MB aggregate for a pane,
 *   - write → reflect ≤ ~2 s p95 through the event-driven watch path,
 *   - one consolidated `wl worklist` read per refresh and zero spawns when
 *     idle (the documented no-regression invariants, parent AC 6).
 *
 * Before this harness those numbers were only quoted ad hoc in the epic's
 * intake ("Existing state"), so a regression could not be caught and F3–F6
 * could not prove their targets. This module is the verification foundation:
 *
 *   1. a DETERMINISTIC fixture generator that builds a real large worklog in a
 *      throwaway temp `.worklog` (never the repository's own worklog),
 *   2. metric collectors for the refresh data path (`doRefresh`'s concurrent
 *      `fetchNextItems` / `fetchChildrenForItems` / `fetchReviewQueueState` /
 *      `fetchActionableCount` fan-out) — wall and CPU time, event-loop
 *      blocking, spawn accounting through the fetcher's injectable exec seam,
 *      and per-spawn / pane RSS,
 *   3. the write → reflect measurement over the REAL `watchDbChanges`
 *      primitive,
 *   4. the checked-in budget policy (`large-db-budget.json`): recorded
 *      baselines, the parent AC targets and a host-load–tolerant ratchet.
 *
 * ## Two profiles
 *
 * - `default` — small enough for the default test suite (a few hundred items,
 *   a few MB) and generated in well under a second. The default-suite ratchet
 *   test (`packages/herdr/src/large-db-refresh-budget.test.ts`) measures this
 *   profile and fails when a metric exceeds its recorded budget plus headroom.
 * - `full` — the parent's real scale (~2,600 items, nested parent/child
 *   subtrees, dependency edges, comments and FTS volume, ~124 MB on disk —
 *   the operator's own worklog is ~109 MB). Generated in ~5 s, so it runs on
 *   demand rather than in the default suite:
 *
 *     `npm run test:perf:large`                                (text)
 *     `npm run test:perf:large -- --json`                       (machine-readable)
 *     `npm run test:perf:large -- --json --update-budget`        (re-baseline)
 *
 * ## Regression policy (host-load tolerant)
 *
 * Shared CI hosts inflate wall-clock time under contention, so the pass/fail
 * gate is CPU time: `process.resourceUsage()` for the harness process plus the
 * per-spawn CPU recorded by the F1 spawn instrumentation
 * (`WL_SPAWN_COUNT_FILE`, WL-0MVFRR98A008MM19) for every spawned `wl`. CPU
 * time is load independent (the same approach as the startup import budget,
 * WL-0MVFRRAXD001E7AN). Wall time, event-loop blocking and RSS get their own
 * (wider, documented) headroom, and every sample must be a genuine fast-path
 * refresh — one consolidated `wl worklist` spawn, not a per-subset fan-out.
 *
 * ## Usage (module)
 *
 * ```ts
 * const report = await runLargeDbHarness({ profile: 'default' });
 * const evaluation = evaluateLargeDbBudget(report, readLargeDbBudget(repoRoot));
 * ```
 *
 * Usage (CLI):
 *
 * ```sh
 * npx tsx packages/herdr/test/perf/large-db-harness.ts --profile default --json
 * npm run test:perf:large -- --profile full --json --target dist --update-budget
 * ```
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WorklogDatabase } from '../../../../src/database.js';
import { bumpStateCounter } from '../../../../src/read-cache.js';
import { readSpawnRecords, summariseSpawnRecords } from '../../../../src/spawn-counter.js';
import { resolveStartupTarget } from '../../../../bench/wl-startup-perf.js';
import {
  buildWlArgs,
  createInProcessRefreshScope,
  fetchActionableCount,
  fetchChildrenForItems,
  fetchNextItems,
  fetchReviewQueueState,
  resetExecFileAsync,
  resetWorklogDir,
  setExecFileAsync,
  setWorklogDir,
} from '../../src/fetcher.js';
import { DbChangeTracker, stateCounterFilePath, watchDbChanges } from '../../src/db-change.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root of this checkout (or worktree). */
export const REPO_ROOT = path.resolve(here, '..', '..', '..', '..');

/** Repository-relative location of the checked-in budget file. */
export const BUDGET_RELATIVE_PATH = 'packages/herdr/test/perf/large-db-budget.json';

/** Current budget schema version. */
export const BUDGET_VERSION = 1;

/** CLI target whose invocation the measurement drives. */
export type LargeDbTarget = 'src' | 'dist';

// ── Fixture scale / profiles ─────────────────────────────────────────

/** Shape of the generated large worklog. */
export interface LargeDbScale {
  /** Total work items (roots + nested). */
  items: number;
  /** Characters of description text per item. */
  descriptionChars: number;
  /** Comments generated per item (they also land in the FTS index). */
  commentsPerItem: number;
  /** Characters of comment text (the other DB-size driver). */
  commentChars: number;
  /** Root "epic" items that own children (nested parent/child structure). */
  parentGroups: number;
  /** Depth-1 children per parent. */
  childrenPerParent: number;
  /** Depth-2 children per depth-1 child (nested subtrees). */
  grandchildrenPerParent: number;
  /** One dependency edge every N items (0 disables edges). */
  dependencyEvery: number;
  /** Parents expanded in the measured default view. */
  expandedParents: number;
  /** Browse window (`wl worklist -n`) the default view requests. */
  browseCount: number;
}

/** Name of a checked-in fixture profile. */
export type LargeDbProfileName = 'default' | 'full';

/**
 * The two fixture profiles.
 *
 * `default` is the default-suite size (a few MB DB, generated in ~1 s);
 * `full` is the parent epic's real scale (~2,600 items / ~100 MB on disk,
 * including the comment and FTS volume that dominates a real worklog),
 * generated in ~15 s and run on demand via `npm run test:perf:large`.
 *
 * Description text is deliberately kept to a plausible intake-brief size
 * (a few KB): the operator's 100 MB DB is dominated by comments, audit
 * results and the FTS index, not by 40 KB descriptions — and a fixture with
 * uniform 40 KB descriptions would push a single `wl worklist --json`
 * payload past the CLI's own 5 MB `maxBuffer`, which is a different
 * (payload-size) problem than refresh cost.
 */
export const LARGE_DB_PROFILES: Record<LargeDbProfileName, LargeDbScale> = {
  default: {
    items: 300,
    descriptionChars: 3_000,
    commentsPerItem: 2,
    commentChars: 600,
    parentGroups: 12,
    childrenPerParent: 3,
    grandchildrenPerParent: 2,
    dependencyEvery: 10,
    expandedParents: 12,
    browseCount: 30,
  },
  full: {
    items: 2_600,
    descriptionChars: 6_000,
    commentsPerItem: 10,
    commentChars: 2_200,
    parentGroups: 40,
    childrenPerParent: 4,
    grandchildrenPerParent: 2,
    dependencyEvery: 10,
    expandedParents: 20,
    browseCount: 30,
  },
};

/** Deterministic PRNG seed shared by every generated fixture. */
export const FIXTURE_SEED = 0x5eed_1a2b;

// ── Fixture generator ────────────────────────────────────────────────

/** A generated large worklog fixture. */
export interface LargeDbFixture {
  /** Throwaway project root (temp directory). */
  rootDir: string;
  /** `.worklog` directory inside {@link rootDir}. */
  worklogDir: string;
  /** Absolute path of the SQLite database. */
  dbPath: string;
  /** Items actually written. */
  itemCount: number;
  /** Dependency edges written. */
  dependencyEdges: number;
  /** Root "epic" item ids (the nested parents). */
  parentIds: string[];
  /** The subset expanded in the measured default view. */
  expandedParentIds: string[];
  /** SQLite database size on disk (MiB). */
  dbSizeMb: number;
  /** Whole `.worklog` directory size on disk (MiB). */
  diskSizeMb: number;
  /** Wall time spent generating the fixture (ms). */
  generationMs: number;
  /** Remove the fixture's temp directory (idempotent). */
  cleanup(): void;
}

/** Deterministic pseudo-random generator (xorshift32). */
function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const FIXTURE_WORDS = [
  'refresh',
  'worklist',
  'herdr',
  'pane',
  'budget',
  'latency',
  'spawn',
  'sqlite',
  'memory',
  'dependency',
  'parent',
  'child',
  'audit',
  'stage',
  'status',
  'render',
  'event',
  'loop',
  'cache',
  'worklog',
  'in-process',
  'consolidated',
];

/** Deterministic filler text of exactly `length` characters. */
function fillerText(random: () => number, length: number): string {
  let text = '';
  while (text.length < length) {
    text += `${FIXTURE_WORDS[Math.floor(random() * FIXTURE_WORDS.length)]} `;
  }
  return text.slice(0, length);
}

/** MiB rounded to one decimal. */
function toMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** Total size in bytes of every regular file directly inside `dir`. */
function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir)) {
    try {
      const stat = fs.statSync(path.join(dir, entry));
      if (stat.isFile()) total += stat.size;
    } catch {
      // A transient sidecar (e.g. -wal being checkpointed) may vanish.
    }
  }
  return total;
}

/**
 * Generate a deterministic large worklog fixture in a throwaway temp
 * `.worklog`.
 *
 * The fixture is written as a JSONL snapshot and imported through the
 * database's own single-transaction bulk import (`refreshFromJsonlIfNewer` —
 * the same path `wl sync` / `wl doctor migrate` use), then the JSONL is
 * deleted so the fixture matches the runtime shape of a real worklog (SQLite
 * is the source of truth; JSONL only exists transiently). Bulk import is
 * ~30× faster than 2,600 individual `create()` transactions.
 *
 * Nothing outside the returned temp directory is touched: no repository
 * worklog, no operator cache (`WL_CACHE_DIR` is set by the runner, not here).
 *
 * @param scale Fixture shape (use {@link LARGE_DB_PROFILES}).
 * @param options.seed PRNG seed (defaults to {@link FIXTURE_SEED}).
 * @param options.prefix Work-item id prefix (default `LDB`).
 */
export function generateLargeWorklog(
  scale: LargeDbScale,
  options: { seed?: number; prefix?: string } = {},
): LargeDbFixture {
  const startedAt = performance.now();
  const random = createRandom(options.seed ?? FIXTURE_SEED);
  const prefix = options.prefix ?? 'LDB';
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-large-db-'));
  const worklogDir = path.join(rootDir, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });

  // `wl` refuses to run without the init semaphore; the config keeps the
  // prefix/name shaped like a real project.
  fs.writeFileSync(
    path.join(worklogDir, 'initialized'),
    JSON.stringify({ version: '1.0.22', initializedAt: '2024-01-01T00:00:00.000Z' }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(worklogDir, 'config.json'),
    JSON.stringify({ projectName: 'Herdr Large DB Fixture', prefix }),
    'utf-8',
  );

  const ids = Array.from(
    { length: scale.items },
    (_, index) => `${prefix}-${String(index).padStart(7, '0')}`,
  );

  // Nested structure: parents → children → grandchildren, then roots. Ids are
  // positional, so the shape is deterministic without extra bookkeeping.
  const parentCount = Math.min(scale.parentGroups, scale.items);
  const childCount = Math.min(parentCount * scale.childrenPerParent, scale.items - parentCount);
  const grandchildCount = Math.min(
    childCount * scale.grandchildrenPerParent,
    scale.items - parentCount - childCount,
  );
  const parentIds = ids.slice(0, parentCount);
  const childIds = ids.slice(parentCount, parentCount + childCount);
  const grandchildIds = ids.slice(parentCount + childCount, parentCount + childCount + grandchildCount);

  const parentOf = new Map<string, string>();
  childIds.forEach((id, index) => {
    parentOf.set(id, parentIds[index % Math.max(1, parentCount)]);
  });
  grandchildIds.forEach((id, index) => {
    parentOf.set(id, childIds[index % Math.max(1, childCount)]);
  });

  // One outbound dependency edge every `dependencyEvery` items, always to an
  // earlier item so the graph is acyclic.
  const dependenciesByItem = new Map<string, { from: string; to: string }[]>();
  let dependencyEdges = 0;
  if (scale.dependencyEvery > 0) {
    for (let index = scale.dependencyEvery; index < ids.length; index += scale.dependencyEvery) {
      const edge = { from: ids[index], to: ids[index - scale.dependencyEvery] };
      const list = dependenciesByItem.get(edge.from) ?? [];
      list.push(edge);
      dependenciesByItem.set(edge.from, list);
      dependencyEdges += 1;
    }
  }

  // Realistic mix: mostly open items, a small mandatory subset (critical /
  // blocked / in-progress roots) and a bounded review queue (completed roots
  // in `in_review`) — the shape a real large worklog has, so the measured
  // `wl worklist --json` payload stays the size the operator sees.
  const statusFor = (index: number): 'open' | 'in-progress' | 'blocked' | 'completed' => {
    const bucket = index % 20;
    if (bucket === 11) return 'in-progress';
    if (bucket === 12) return 'blocked';
    if (bucket >= 13) return 'completed';
    return 'open';
  };
  const priorityFor = (index: number): 'critical' | 'high' | 'medium' | 'low' => {
    const bucket = index % 20;
    if (bucket === 0) return 'critical';
    if (bucket <= 4) return 'high';
    if (bucket >= 17) return 'low';
    return 'medium';
  };
  const baseTime = Date.parse('2024-01-01T00:00:00.000Z');

  const lines: string[] = new Array(ids.length);
  ids.forEach((id, index) => {
    const status = statusFor(index);
    lines[index] = JSON.stringify({
      type: 'workitem',
      data: {
        id,
        title: `Large DB fixture item ${index} ${fillerText(random, 24)}`,
        description: `${id} deterministic fixture body.\n${fillerText(random, scale.descriptionChars)}`,
        status,
        priority: priorityFor(index),
        sortIndex: (index + 1) * 100,
        parentId: parentOf.get(id) ?? null,
        createdAt: new Date(baseTime + index * 1_000).toISOString(),
        updatedAt: new Date(baseTime + index * 1_000).toISOString(),
        tags: index % 7 === 0 ? ['large-db'] : [],
        assignee: '',
        // Every fifth completed root sits in the review queue, which the
        // default view always reads (mandatory subset) — a real large-DB cost
        // driver, kept bounded so the payload matches the operator's.
        stage: status === 'completed' && index % 5 === 0 ? 'in_review' : '',
        issueType: 'task',
        createdBy: '',
        deletedBy: '',
        deleteReason: '',
        risk: '',
        effort: '',
        needsProducerReview: false,
        dependencies: dependenciesByItem.get(id) ?? [],
      },
    });
  });

  // Comments are part of a real worklog's volume (and its FTS index): the
  // operator's 109 MB DB carries ~6.6 M comment characters. Generated after
  // the work items so their ids are available.
  if (scale.commentsPerItem > 0) {
    for (let itemIndex = 0; itemIndex < ids.length; itemIndex += 1) {
      for (let commentIndex = 0; commentIndex < scale.commentsPerItem; commentIndex += 1) {
        lines.push(
          JSON.stringify({
            type: 'comment',
            data: {
              id: `CMT-${String(itemIndex).padStart(7, '0')}-${commentIndex}`,
              workItemId: ids[itemIndex],
              author: commentIndex % 2 === 0 ? 'implement' : 'producer',
              comment: `${fillerText(random, scale.commentChars)}`,
              createdAt: new Date(baseTime + itemIndex * 1_000 + commentIndex * 100).toISOString(),
              references: [],
            },
          }),
        );
      }
    }
  }

  const jsonlPath = path.join(worklogDir, 'worklog-data.jsonl');
  fs.writeFileSync(jsonlPath, `${lines.join('\n')}\n`, 'utf-8');

  const dbPath = path.join(worklogDir, 'worklog.db');
  const db = new WorklogDatabase(prefix, dbPath, jsonlPath, true, false);
  const itemCount = db.list({}).length;
  db.close();

  // Ephemeral-JSONL pattern: SQLite is the runtime source of truth. Leaving
  // the snapshot behind would make every new connection re-import it.
  fs.rmSync(jsonlPath, { force: true });

  const generationMs = Math.round(performance.now() - startedAt);
  const dbSizeMb = toMb(fs.statSync(dbPath).size);
  const diskSizeMb = toMb(directorySize(worklogDir));

  return {
    rootDir,
    worklogDir,
    dbPath,
    itemCount,
    dependencyEdges,
    parentIds,
    expandedParentIds: parentIds.slice(0, Math.max(1, Math.min(scale.expandedParents, parentIds.length))),
    dbSizeMb,
    diskSizeMb,
    generationMs,
    cleanup(): void {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

// ── Metric helpers ───────────────────────────────────────────────────

/** Nearest-rank percentile (p95 of a small sample is its maximum). */
export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/** Round to one decimal. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Aggregate TUI event-loop blocking observed during one measured segment. */
export interface EventLoopBlocking {
  /** Sum of the delays attributable to a blocked loop (ms). */
  totalBlockedMs: number;
  /** Longest single stall (ms). */
  maxBlockedMs: number;
  /** Probe ticks observed. */
  samples: number;
}

/**
 * Start a 1 ms event-loop heartbeat probe.
 *
 * Each tick records how much later than expected it ran; delays beyond
 * `toleranceMs` are attributed to the event loop being blocked (synchronous
 * SQLite work, JSON parsing). Summing them yields the aggregate blocking the
 * operator perceives as lag during a refresh, which is what the parent AC
 * bounds (≤ ~200 ms aggregate). The tolerance absorbs the normal timer
 * granularity so an idle loop reports ~0.
 */
export function startEventLoopProbe(toleranceMs = 2): { stop(): EventLoopBlocking } {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let last = performance.now();
  let total = 0;
  let max = 0;
  let samples = 0;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    const now = performance.now();
    const delay = Math.max(0, now - last - toleranceMs);
    total += delay;
    if (delay > max) max = delay;
    samples += 1;
    last = now;
    handle = setTimeout(tick, 1);
  };
  handle = setTimeout(tick, 1);

  return {
    stop(): EventLoopBlocking {
      stopped = true;
      if (handle !== null) clearTimeout(handle);
      handle = null;
      return {
        totalBlockedMs: round1(total),
        maxBlockedMs: round1(max),
        samples,
      };
    },
  };
}

/** One measured default-view refresh. */
export interface RefreshSample {
  wallMs: number;
  /** Harness CPU + spawned `wl` CPU (user + system, ms). */
  cpuMs: number;
  spawns: number;
  spawnKinds: Record<string, number>;
  /** Argument vectors (after `buildWlArgs`) the fetcher spawned. */
  spawnArgs: string[][];
  eventLoopBlockedMs: number;
  maxEventLoopBlockedMs: number;
  /** Highest per-spawn peak RSS in this refresh (MiB, null when unknown). */
  peakRssPerSpawnMb: number | null;
  /** Sum of the per-spawn peaks in this refresh (MiB, null when unknown). */
  aggregateSpawnRssMb: number | null;
}

/** Measured write → reflect latencies over the real watch primitive. */
export interface WriteToReflectMetrics {
  detectMs: number[];
  reflectMs: number[];
  p50DetectMs: number;
  p95DetectMs: number;
  p50ReflectMs: number;
  p95ReflectMs: number;
}

/** One idle tick: whether the change tracker reported a change and what it spawned. */
export interface IdleTickResult {
  changed: boolean;
  spawns: number;
}

/** Full report of one harness run (what the budget policy evaluates). */
export interface LargeDbReport {
  profile: LargeDbProfileName;
  target: LargeDbTarget;
  invocation: string;
  node: string;
  host: string;
  capturedAt: string;
  samples: number;
  dataset: {
    items: number;
    descriptionChars: number;
    parentGroups: number;
    expandedParents: number;
    dependencyEdges: number;
    dbSizeMb: number;
    diskSizeMb: number;
    generationMs: number;
  };
  refresh: {
    p50WallMs: number;
    p95WallMs: number;
    p50CpuMs: number;
    p95CpuMs: number;
    eventLoopBlockingP95Ms: number;
    maxEventLoopBlockedMs: number;
    spawnsPerRefresh: number;
    /** Number of consolidated `wl worklist` invocations in one refresh. */
    consolidatedWorklistSpawns: number;
    /** Measured refreshes that issued a consolidated `wl worklist` read. */
    consolidatedWorklistReads: number;
    spawnKinds: Record<string, number>;
    peakRssPerSpawnMb: number | null;
    aggregateSpawnRssMb: number | null;
  };
  pane: {
    /** Harness (= pane) process peak RSS after the measured refreshes. */
    peakRssMb: number;
    /** Extra peak RSS a refresh added on top of the primed baseline (MiB). */
    refreshRssDeltaMb: number;
    /**
     * Aggregate RSS held by one pane for a refresh: the pane's own added peak
     * plus its largest concurrent `wl` child (MiB). This is the number the
     * parent AC's ≤ ~300 MB aggregate ceiling applies to.
     */
    aggregateRssMb: number;
  };
  idle: IdleTickResult;
  writeToReflect: WriteToReflectMetrics;
  samplesDetail: RefreshSample[];
}

// ── Budget schema ────────────────────────────────────────────────────

/** Parent epic AC numbers, asserted once `enforced` is true. */
export interface LargeDbAcTargets {
  /** Parent AC2: default-view refresh p95 wall time. */
  refreshP95WallMs: number;
  /** Parent AC1: aggregate TUI event-loop blocking during a refresh. */
  eventLoopBlockingP95Ms: number;
  /** Parent AC5: documented per-spawn peak-RSS budget. */
  peakRssPerSpawnMb: number;
  /** Parent AC5: aggregate RSS ceiling for a single pane. */
  paneAggregateRssMb: number;
  /** Parent AC4: write → reflect p95 via the event-driven watch. */
  writeToReflectP95Ms: number;
  /** Parent AC6: exactly one consolidated `wl worklist` read per refresh. */
  spawnsPerRefresh: number;
  /** Parent AC6: zero spawns when nothing changed. */
  idleSpawns: number;
  /** True once a full-scale baseline within target has been recorded. */
  enforced: boolean;
  note: string;
}

/** Host-load tolerance policy for the measured ratchet. */
export interface LargeDbRegressionPolicy {
  /** Measured refreshes per run (default-suite test uses this). */
  refreshSamples: number;
  /** Measured write → reflect samples per run. */
  writeToReflectSamples: number;
  /** Allowed CPU growth over the recorded p95 before failing (%). */
  cpuHeadroomPct: number;
  /** Allowed wall-time growth over the recorded p95 before failing (%). */
  wallHeadroomPct: number;
  /** Absolute wall-time slack (ms) on top of the percentage headroom. */
  wallFloorMs: number;
  /** Allowed peak/aggregate RSS growth over the recorded value (%). */
  rssHeadroomPct: number;
  /** Allowed event-loop-blocking growth over the recorded p95 (%). */
  eventLoopHeadroomPct: number;
  /** Absolute event-loop slack (ms) on top of the percentage headroom. */
  eventLoopFloorMs: number;
  note: string;
}

/** Recorded metrics for one profile + CLI target. */
export interface LargeDbBaselineMetrics {
  refreshP50WallMs: number;
  refreshP95WallMs: number;
  refreshP95CpuMs: number;
  eventLoopBlockingP95Ms: number;
  maxEventLoopBlockedMs: number;
  spawnsPerRefresh: number;
  peakRssPerSpawnMb: number | null;
  aggregateSpawnRssMb: number | null;
  paneAggregateRssMb: number;
  writeToReflectP95Ms: number;
}

/** One recorded baseline (per profile + CLI target). */
export interface LargeDbBaseline {
  capturedAt: string;
  node: string;
  host: string;
  target: LargeDbTarget;
  /** Exact command used, so the measurement can be reproduced. */
  method: string;
  dataset: LargeDbReport['dataset'];
  metrics: LargeDbBaselineMetrics;
}

/** A fixture profile plus its recorded baselines, keyed by CLI target. */
export interface LargeDbProfile {
  scale: LargeDbScale;
  baselines: Record<string, LargeDbBaseline | undefined>;
}

/** The checked-in large-DB refresh budget. */
export interface LargeDbBudget {
  version: number;
  $comment?: string;
  /** Commands that reproduce / re-baseline the numbers. */
  commands: Record<string, string>;
  acTargets: LargeDbAcTargets;
  regression: LargeDbRegressionPolicy;
  profiles: Record<string, LargeDbProfile | undefined>;
}

/** Defaults used when the budget file is first generated / regenerated. */
export function defaultLargeDbBudget(): LargeDbBudget {
  return {
    version: BUDGET_VERSION,
    $comment:
      'Herdr large-DB refresh budget (parent WL-0MVJC1EQX001QR9W). The `default` profile is ' +
      'measured by the default-suite ratchet test (packages/herdr/src/large-db-refresh-budget.test.ts); ' +
      'the `full` profile (~2,600 items / ~124 MB, the operator-observed scale) is run on demand ' +
      'with `npm run test:perf:large`. ' +
      'A metric exceeding its recorded baseline plus documented headroom fails the ratchet — ' +
      're-baseline deliberately with `npm run test:perf:large -- --json --update-budget`.',
    commands: {
      defaultProfile:
        'npx tsx packages/herdr/test/perf/large-db-harness.ts --profile default --json',
      fullScale: 'npm run test:perf:large -- --json',
      fullScaleDist:
        'npm run build && npm run test:perf:large -- --json --target dist',
      rebaseline:
        'npm run test:perf:large -- --json --update-budget  (add --target src|dist to pick the invocation)',
    },
    acTargets: {
      refreshP95WallMs: 1500,
      eventLoopBlockingP95Ms: 200,
      peakRssPerSpawnMb: 130,
      paneAggregateRssMb: 300,
      writeToReflectP95Ms: 2000,
      spawnsPerRefresh: 1,
      idleSpawns: 0,
      enforced: false,
      note:
        'Parent epic acceptance criteria at ~2,600 items / ~100 MB (WL-0MVJC1EQX001QR9W): a ' +
        'default-view refresh ≤ ~1.5 s p95 wall, ≤ ~200 ms aggregate event-loop blocking, a ' +
        'documented per-spawn peak-RSS budget below the ~130–145 MB/spawn pre-change baseline ' +
        'and ≤ ~300 MB aggregate for a single pane, write → reflect ≤ ~2 s p95, one consolidated ' +
        '`wl worklist` read per refresh and zero spawns when idle. `enforced` flips true once a ' +
        'full-scale baseline within target is recorded (F7 re-verification).',
    },
    regression: {
      refreshSamples: 5,
      writeToReflectSamples: 5,
      cpuHeadroomPct: 100,
      wallHeadroomPct: 200,
      wallFloorMs: 500,
      rssHeadroomPct: 25,
      eventLoopHeadroomPct: 200,
      eventLoopFloorMs: 100,
      note:
        'CPU time (process.resourceUsage for the harness plus the per-spawn CPU from the ' +
        'WL_SPAWN_COUNT_FILE instrumentation) is the load-independent regression gate, with ' +
        '100 % headroom because the tsx `src` target varies ~50 % run-to-run on a shared host. ' +
        'Wall time and event-loop blocking get 200 % + a 500 ms / 100 ms floor; peak and ' +
        'aggregate RSS keep a tighter 25 % headroom so memory regressions still fail promptly.',
    },
    profiles: {
      default: {
        scale: { ...LARGE_DB_PROFILES.default },
        baselines: {},
      },
      full: {
        scale: { ...LARGE_DB_PROFILES.full },
        baselines: {},
      },
    },
  };
}

/** Absolute path to the budget file for a repository root. */
export function budgetFilePath(repoRoot: string): string {
  return path.join(repoRoot, BUDGET_RELATIVE_PATH);
}

/** Read and validate the checked-in budget (throws with actionable guidance). */
export function readLargeDbBudget(repoRoot: string): LargeDbBudget {
  const file = budgetFilePath(repoRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new Error(
      `large-DB refresh budget not found at ${BUDGET_RELATIVE_PATH} — regenerate it with ` +
        '`npm run test:perf:large -- --json --update-budget`',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `large-DB refresh budget at ${BUDGET_RELATIVE_PATH} is not valid JSON: ` +
        `${(error as Error).message}`,
    );
  }

  const budget = parsed as LargeDbBudget;
  const problems: string[] = [];
  if (budget.version !== BUDGET_VERSION) {
    problems.push(`version must be ${BUDGET_VERSION} (found ${String(budget.version)})`);
  }
  for (const key of ['refreshP95WallMs', 'eventLoopBlockingP95Ms', 'writeToReflectP95Ms'] as const) {
    if (!budget.acTargets || typeof budget.acTargets[key] !== 'number') {
      problems.push(`acTargets.${key} must be a number`);
    }
  }
  if (!budget.regression || typeof budget.regression.cpuHeadroomPct !== 'number') {
    problems.push('regression.cpuHeadroomPct must be a number');
  }
  if (!budget.profiles || typeof budget.profiles !== 'object') {
    problems.push('profiles must be an object');
  } else {
    for (const [name, profile] of Object.entries(budget.profiles)) {
      if (!profile || typeof profile !== 'object' || !profile.scale) {
        problems.push(`profiles.${name}.scale must be an object`);
        continue;
      }
      if (!Number.isFinite(profile.scale.items) || profile.scale.items <= 0) {
        problems.push(`profiles.${name}.scale.items must be a positive number`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `large-DB refresh budget at ${BUDGET_RELATIVE_PATH} is invalid: ${problems.join('; ')} — ` +
        'regenerate it with `npm run test:perf:large -- --json --update-budget`',
    );
  }
  return budget;
}

/** Write the budget file (pretty-printed, newline-terminated). */
export function writeLargeDbBudget(repoRoot: string, budget: LargeDbBudget): string {
  const file = budgetFilePath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(budget, null, 2)}\n`, 'utf-8');
  return file;
}

/** Convert a report into the baseline shape recorded in the budget file. */
export function baselineFromReport(report: LargeDbReport): LargeDbBaseline {
  return {
    capturedAt: report.capturedAt,
    node: report.node,
    host: report.host,
    target: report.target,
    method: report.invocation,
    dataset: report.dataset,
    metrics: {
      refreshP50WallMs: report.refresh.p50WallMs,
      refreshP95WallMs: report.refresh.p95WallMs,
      refreshP95CpuMs: report.refresh.p95CpuMs,
      eventLoopBlockingP95Ms: report.refresh.eventLoopBlockingP95Ms,
      maxEventLoopBlockedMs: report.refresh.maxEventLoopBlockedMs,
      spawnsPerRefresh: report.refresh.spawnsPerRefresh,
      peakRssPerSpawnMb: report.refresh.peakRssPerSpawnMb,
      aggregateSpawnRssMb: report.refresh.aggregateSpawnRssMb,
      paneAggregateRssMb: report.pane.aggregateRssMb,
      writeToReflectP95Ms: report.writeToReflect.p95ReflectMs,
    },
  };
}

// ── Budget evaluation (pure) ─────────────────────────────────────────

/** One policy check (measured value vs. its limit). */
export interface LargeDbBudgetCheck {
  metric: string;
  measured: number | null;
  limit: number | null;
  ok: boolean;
  detail: string;
}

/** Result of evaluating a measurement against the budget. */
export interface LargeDbBudgetEvaluation {
  ok: boolean;
  profile: string;
  target: string;
  checks: LargeDbBudgetCheck[];
  violations: string[];
}

/** Numbers the policy needs from a report (a report satisfies this). */
export interface LargeDbEvaluationInput {
  profile: LargeDbProfileName | string;
  target: LargeDbTarget | string;
  refresh: {
    p95WallMs: number;
    p95CpuMs: number;
    eventLoopBlockingP95Ms: number;
    maxEventLoopBlockedMs: number;
    spawnsPerRefresh: number;
    consolidatedWorklistSpawns: number;
    peakRssPerSpawnMb: number | null;
    aggregateSpawnRssMb: number | null;
  };
  pane: { peakRssMb: number; aggregateRssMb: number };
  idle: IdleTickResult;
  writeToReflect: { p95ReflectMs: number };
}

/**
 * Evaluate a measurement against the recorded budget.
 *
 * Rules (in order):
 *   1. a baseline must exist for the measured profile + CLI target;
 *   2. the spawn invariants hold unconditionally — exactly one consolidated
 *      `wl worklist` read per refresh, and zero spawns on an idle tick;
 *   3. p95 CPU time must stay within `cpuHeadroomPct` (the load-tolerant gate);
 *   4. p95 wall time must stay within `wallHeadroomPct` + `wallFloorMs`;
 *   5. p95 event-loop blocking must stay within `eventLoopHeadroomPct` +
 *      `eventLoopFloorMs`;
 *   6. per-spawn, aggregate-spawn and pane peak RSS must stay within
 *      `rssHeadroomPct`;
 *   7. write → reflect p95 must stay within `wallHeadroomPct` + `wallFloorMs`;
 *   8. the parent AC targets are asserted for the `full` profile once
 *      `acTargets.enforced` is true.
 */
export function evaluateLargeDbBudget(
  input: LargeDbEvaluationInput,
  budget: LargeDbBudget,
): LargeDbBudgetEvaluation {
  const checks: LargeDbBudgetCheck[] = [];
  const violations: string[] = [];
  const policy = budget.regression;
  const profile = budget.profiles[input.profile];
  const baseline = profile?.baselines?.[String(input.target)];
  const ac = budget.acTargets;

  const push = (check: LargeDbBudgetCheck): void => {
    checks.push(check);
    if (!check.ok) {
      violations.push(
        `${input.profile}/${input.target}: ${check.metric} ${String(check.measured)} ` +
          `exceeds limit ${String(check.limit)} (${check.detail})`,
      );
    }
  };

  if (!profile) {
    violations.push(
      `no recorded profile '${String(input.profile)}' in ${BUDGET_RELATIVE_PATH} — ` +
        'regenerate it with `npm run test:perf:large -- --json --update-budget`',
    );
    return { ok: false, profile: String(input.profile), target: String(input.target), checks, violations };
  }
  if (!baseline) {
    violations.push(
      `no recorded baseline for profile '${String(input.profile)}' target ` +
        `'${String(input.target)}' in ${BUDGET_RELATIVE_PATH} — record it with ` +
        `\`npm run test:perf:large -- --profile ${String(input.profile)} --target ${String(input.target)} --json --update-budget\``,
    );
    return { ok: false, profile: String(input.profile), target: String(input.target), checks, violations };
  }

  // 2. Spawn invariants (unconditional, recorded baseline or not).
  push({
    metric: 'spawnsPerRefresh',
    measured: input.refresh.spawnsPerRefresh,
    limit: ac.spawnsPerRefresh,
    ok: input.refresh.spawnsPerRefresh === ac.spawnsPerRefresh,
    detail: 'one consolidated `wl worklist` read per default-view refresh (parent AC6)',
  });
  push({
    metric: 'consolidatedWorklistSpawns',
    measured: input.refresh.consolidatedWorklistSpawns,
    limit: ac.spawnsPerRefresh,
    ok: input.refresh.consolidatedWorklistSpawns === ac.spawnsPerRefresh,
    detail: 'every measured refresh must spawn `wl worklist` exactly once',
  });
  push({
    metric: 'idleSpawns',
    measured: input.idle.spawns,
    limit: ac.idleSpawns,
    ok: input.idle.spawns === ac.idleSpawns,
    detail: 'an idle tick (no DB change) must never spawn `wl` (parent AC6)',
  });
  push({
    metric: 'idleChanged',
    measured: input.idle.changed ? 1 : 0,
    limit: 0,
    ok: input.idle.changed === false,
    detail: 'the change tracker must report no change for an idle tick',
  });

  // 3. CPU time — the load-independent regression gate.
  const cpuLimit = baseline.metrics.refreshP95CpuMs * (1 + policy.cpuHeadroomPct / 100);
  push({
    metric: 'refreshP95CpuMs',
    measured: round1(input.refresh.p95CpuMs),
    limit: Math.round(cpuLimit),
    ok: input.refresh.p95CpuMs <= cpuLimit,
    detail:
      `recorded p95 ${baseline.metrics.refreshP95CpuMs} ms + ${policy.cpuHeadroomPct}% CPU ` +
      'headroom (CPU time is the load-independent gate)',
  });

  // 4. Wall time.
  const wallLimit =
    baseline.metrics.refreshP95WallMs * (1 + policy.wallHeadroomPct / 100) + policy.wallFloorMs;
  push({
    metric: 'refreshP95WallMs',
    measured: round1(input.refresh.p95WallMs),
    limit: Math.round(wallLimit),
    ok: input.refresh.p95WallMs <= wallLimit,
    detail:
      `recorded p95 ${baseline.metrics.refreshP95WallMs} ms + ${policy.wallHeadroomPct}% wall ` +
      `headroom + ${policy.wallFloorMs} ms floor`,
  });

  // 5. Event-loop blocking.
  const loopLimit =
    baseline.metrics.eventLoopBlockingP95Ms * (1 + policy.eventLoopHeadroomPct / 100) +
    policy.eventLoopFloorMs;
  push({
    metric: 'eventLoopBlockingP95Ms',
    measured: round1(input.refresh.eventLoopBlockingP95Ms),
    limit: Math.round(loopLimit),
    ok: input.refresh.eventLoopBlockingP95Ms <= loopLimit,
    detail:
      `recorded p95 ${baseline.metrics.eventLoopBlockingP95Ms} ms + ` +
      `${policy.eventLoopHeadroomPct}% headroom + ${policy.eventLoopFloorMs} ms floor`,
  });

  // 6. Memory.
  const rssLimit = (recorded: number | null): number | null =>
    recorded === null ? null : recorded * (1 + policy.rssHeadroomPct / 100);
  const rssChecks: Array<[string, number | null, number | null]> = [
    ['peakRssPerSpawnMb', input.refresh.peakRssPerSpawnMb, baseline.metrics.peakRssPerSpawnMb],
    ['aggregateSpawnRssMb', input.refresh.aggregateSpawnRssMb, baseline.metrics.aggregateSpawnRssMb],
    ['paneAggregateRssMb', input.pane.aggregateRssMb, baseline.metrics.paneAggregateRssMb],
  ];
  for (const [metric, measured, recorded] of rssChecks) {
    const limit = rssLimit(recorded);
    if (limit === null || measured === null) continue;
    push({
      metric,
      measured: round1(measured),
      limit: Math.round(limit * 10) / 10,
      ok: measured <= limit,
      detail: `recorded ${round1(recorded as number)} MiB + ${policy.rssHeadroomPct}% RSS headroom`,
    });
  }

  // 7. Write → reflect.
  const reflectLimit =
    baseline.metrics.writeToReflectP95Ms * (1 + policy.wallHeadroomPct / 100) + policy.wallFloorMs;
  push({
    metric: 'writeToReflectP95Ms',
    measured: round1(input.writeToReflect.p95ReflectMs),
    limit: Math.round(reflectLimit),
    ok: input.writeToReflect.p95ReflectMs <= reflectLimit,
    detail:
      `recorded p95 ${baseline.metrics.writeToReflectP95Ms} ms + ${policy.wallHeadroomPct}% ` +
      `headroom + ${policy.wallFloorMs} ms floor`,
  });

  // 8. Parent AC targets — only for the full-scale profile, once enforced.
  if (ac.enforced && input.profile === 'full') {
    const acChecks: Array<[string, number | null, number]> = [
      ['AC refreshP95WallMs', input.refresh.p95WallMs, ac.refreshP95WallMs],
      ['AC eventLoopBlockingP95Ms', input.refresh.eventLoopBlockingP95Ms, ac.eventLoopBlockingP95Ms],
      ['AC peakRssPerSpawnMb', input.refresh.peakRssPerSpawnMb, ac.peakRssPerSpawnMb],
      ['AC paneAggregateRssMb', input.pane.aggregateRssMb, ac.paneAggregateRssMb],
      ['AC writeToReflectP95Ms', input.writeToReflect.p95ReflectMs, ac.writeToReflectP95Ms],
    ];
    for (const [metric, measured, limit] of acChecks) {
      if (measured === null) continue;
      push({
        metric,
        measured: round1(measured),
        limit,
        ok: measured <= limit,
        detail: 'parent epic acceptance criterion (enforced at full scale)',
      });
    }
  }

  return {
    ok: violations.length === 0,
    profile: String(input.profile),
    target: String(input.target),
    checks,
    violations,
  };
}

// ── CLI invocation resolution ────────────────────────────────────────

/** Executable + leading args of the `wl` CLI the harness spawns. */
export interface LargeDbCliInvocation {
  target: LargeDbTarget;
  command: string[];
  /** Human-readable method recorded in baselines. */
  method: string;
}

/** Walk up from `startDir` to the nearest `node_modules/.bin/tsx`. */
function resolveTsxBin(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        'large-db harness: no node_modules/.bin/tsx found — run `npm install` (or build the ' +
          'CLI and use --target dist)',
      );
    }
    dir = parent;
  }
}

/**
 * Resolve the CLI invocation the harness drives.
 *
 * `auto` prefers a fresh `dist/cli.js` (what `/usr/local/bin/wl` runs) and
 * falls back to `tsx src/cli.ts` when there is no build (or a stale one) —
 * the same freshness rule as the startup benchmark, so the numbers never
 * describe code that no longer exists in `src/`.
 */
export function resolveCliInvocation(
  target: 'auto' | LargeDbTarget,
  repoRoot: string = REPO_ROOT,
): LargeDbCliInvocation {
  const resolved = resolveStartupTarget(target, repoRoot);
  if (resolved === 'dist') {
    const entry = path.join(repoRoot, 'dist', 'cli.js');
    return {
      target: 'dist',
      command: [process.execPath, entry],
      method:
        `${process.execPath} ${path.relative(repoRoot, entry)} <argv> — built CLI, warm runs ` +
        'after a priming refresh; CPU/RSS from the WL_SPAWN_COUNT_FILE spawn records',
    };
  }
  const tsx = resolveTsxBin(repoRoot);
  const entry = path.join(repoRoot, 'src', 'cli.ts');
  return {
    target: 'src',
    command: [process.execPath, tsx, entry],
    method:
      `${process.execPath} ${path.relative(repoRoot, tsx)} ${path.relative(repoRoot, entry)} ` +
      '<argv> — tsx target, warm runs after a priming refresh; CPU/RSS from the ' +
      'WL_SPAWN_COUNT_FILE spawn records',
  };
}

// ── Harness runner ───────────────────────────────────────────────────

/** Options accepted by {@link runLargeDbHarness}. */
export interface LargeDbHarnessOptions {
  /** Fixture profile (default `default`). */
  profile?: LargeDbProfileName;
  /** Override the profile's scale (used by focused tests). */
  scale?: Partial<LargeDbScale>;
  /** Measured refresh samples (default: the budget policy's value, else 5). */
  samples?: number;
  /** Write → reflect samples (default: the budget policy's value, else 5). */
  writeSamples?: number;
  /** CLI target to drive (default `auto`). */
  target?: 'auto' | LargeDbTarget;
  /** Repository root (defaults to this checkout). */
  repoRoot?: string;
  /** Keep the generated fixture on disk for inspection. */
  keep?: boolean;
  /** Pre-generated fixture (skips generation; the caller owns cleanup). */
  fixture?: LargeDbFixture;
}

/**
 * Run the resolved CLI target, resolving `{ stdout, stderr }`.
 *
 * Deliberately NOT `promisify(execFile)`: test setups replace
 * `child_process.execFile` with a plain mock function, which drops Node's
 * custom promisify implementation (it resolves `{ stdout, stderr }`); the
 * generic promisify then resolves only `stdout`, which the fetcher's
 * `result.stdout` contract cannot consume. Wrapping the callback form keeps
 * the seam identical in the CLI and under vitest.
 */
function runCliTarget(
  invocation: LargeDbCliInvocation,
  argv: string[],
  options: unknown,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      invocation.command[0],
      [...invocation.command.slice(1), ...argv],
      options as Record<string, unknown>,
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** One measured refresh, with the fetcher's exec seam recording the spawns. */
async function measureRefresh(
  refresh: () => Promise<void>,
  spawnFile: string,
  spawnArgs: string[][],
): Promise<RefreshSample> {
  fs.rmSync(spawnFile, { force: true });
  spawnArgs.length = 0;

  const cpuStart = process.cpuUsage();
  const probe = startEventLoopProbe();
  const startedAt = performance.now();
  await refresh();
  const wallMs = performance.now() - startedAt;
  const blocking = probe.stop();
  const cpu = process.cpuUsage(cpuStart);

  const summary = summariseSpawnRecords(spawnFile);
  const records = readSpawnRecords(spawnFile);
  const peakRssPerSpawnMb = summary.maxRssKb === null ? null : round1(summary.maxRssKb / 1024);
  const withRss = records.filter((record) => record.maxRssKb !== null);
  const aggregateSpawnRssMb =
    withRss.length === 0
      ? null
      : round1(withRss.reduce((total, record) => total + (record.maxRssKb as number), 0) / 1024);

  return {
    wallMs: round1(wallMs),
    cpuMs: round1((cpu.user + cpu.system) / 1000 + summary.cpuSeconds * 1000),
    spawns: summary.total,
    spawnKinds: summary.byKind,
    spawnArgs: spawnArgs.map((args) => [...args]),
    eventLoopBlockedMs: blocking.totalBlockedMs,
    maxEventLoopBlockedMs: blocking.maxBlockedMs,
    peakRssPerSpawnMb,
    aggregateSpawnRssMb,
  };
}

/** True when a spawn's argument vector is the consolidated worklist read. */
function isConsolidatedWorklistSpawn(args: string[]): boolean {
  const index = args.indexOf('worklist');
  return index !== -1 && args.indexOf('list', index) === -1;
}

/**
 * Run the large-DB harness: generate the fixture, measure the default-view
 * refresh, the idle tick and the write → reflect latency, then restore every
 * piece of global state it touched (env, fetcher worklog dir / exec seam).
 *
 * The measured refresh mirrors `doRefresh`'s default-view data path exactly:
 * the item fetch, the batched expanded-children read, the review-queue state
 * and the actionable count run CONCURRENTLY, the children/actionable reads
 * share ONE refresh-scoped SQLite connection, and the item read is the single
 * consolidated `wl worklist` spawn.
 */
export async function runLargeDbHarness(
  options: LargeDbHarnessOptions = {},
): Promise<LargeDbReport> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const profileName: LargeDbProfileName = options.profile ?? 'default';
  const scale: LargeDbScale = { ...LARGE_DB_PROFILES[profileName], ...options.scale };
  const samples = Math.max(1, options.samples ?? 5);
  const writeSamples = Math.max(1, options.writeSamples ?? 5);
  const invocation = resolveCliInvocation(options.target ?? 'auto', repoRoot);

  const fixture = options.fixture ?? generateLargeWorklog(scale);
  const cacheDir = path.join(fixture.rootDir, 'cache');
  const spawnFile = path.join(fixture.rootDir, 'spawns.log');

  const savedCacheDir = process.env.WL_CACHE_DIR;
  const savedSpawnFile = process.env.WL_SPAWN_COUNT_FILE;
  const spawnArgs: string[][] = [];

  const refresh = async (): Promise<void> => {
    const scope = createInProcessRefreshScope();
    try {
      await Promise.all([
        fetchNextItems(scale.browseCount),
        fetchChildrenForItems(fixture.expandedParentIds, undefined, scope),
        fetchReviewQueueState(),
        fetchActionableCount(scope),
      ]);
    } finally {
      scope.close();
    }
  };

  try {
    process.env.WL_CACHE_DIR = cacheDir;
    process.env.WL_SPAWN_COUNT_FILE = spawnFile;
    setWorklogDir(fixture.worklogDir);
    // Every `wl` invocation funnels through the fetcher's injectable exec
    // seam: count it, record its argv, and run the resolved CLI target.
    setExecFileAsync((async (file: unknown, args: unknown, execOptions: unknown) => {
      const argv = (args as string[]) ?? [];
      spawnArgs.push([...argv]);
      void file;
      return runCliTarget(invocation, argv, execOptions);
    }) as Parameters<typeof setExecFileAsync>[0]);

    // Preflight: the measured default view relies on the in-process SQLite
    // read path (shared refresh scope). Without the built `@worklog/shared`
    // package every read fails open to per-parent CLI spawns, which would look
    // like a multi-spawn regression instead of a missing build step.
    const preflightScope = createInProcessRefreshScope();
    let inProcessItems: number | undefined;
    try {
      inProcessItems = await preflightScope.read((db) => db.list({}).length);
    } finally {
      preflightScope.close();
    }
    if (inProcessItems === undefined) {
      throw new Error(
        'large-db harness: the in-process SQLite read path is unavailable, so the default-view ' +
          'refresh would fall back to per-parent `wl` spawns and the measurement would not ' +
          'describe the plugin. Build the shared package first (`npm run build:shared`).',
      );
    }

    // Prime the read cache so the first measured refresh is genuinely warm and
    // the read-cache entry exists for every sample.
    await refresh();
    await refresh();
    const rssBeforeSamplesKb = process.resourceUsage().maxRSS;

    const measured: RefreshSample[] = [];
    for (let index = 0; index < samples; index += 1) {
      measured.push(await measureRefresh(refresh, spawnFile, spawnArgs));
    }

    // Idle tick: the pane's 30 s tick path consults the change tracker first;
    // with no write since the last refresh it must report no change and spawn
    // nothing (the zero-spawn-when-idle guarantee).
    const tracker = new DbChangeTracker(cacheDir, fixture.worklogDir);
    tracker.dbChanged();
    fs.rmSync(spawnFile, { force: true });
    const idleChanged = tracker.dbChanged();
    const idleSpawns = summariseSpawnRecords(spawnFile).total;

    // Write → reflect over the REAL watch primitive: bump the cross-process
    // state counter exactly as a `wl` write does, then measure detection
    // (debounced watch callback) and reflection (watch + refresh data path).
    const detectMs: number[] = [];
    const reflectMs: number[] = [];
    let pending: ((at: number) => void) | null = null;
    // `fs.watch` needs the state directory to exist; create it (and prime the
    // counter file) the same way a `wl` write would before arming the watch.
    fs.mkdirSync(path.dirname(stateCounterFilePath(cacheDir, fixture.worklogDir)), {
      recursive: true,
    });
    const watch = watchDbChanges(cacheDir, fixture.worklogDir, () => {
      const at = performance.now();
      if (pending !== null) {
        const resolve = pending;
        pending = null;
        resolve(at);
      }
    });
    const watchActive = watch.active;
    try {
      for (let index = 0; index < writeSamples; index += 1) {
        const startedAt = performance.now();
        const detectedAt = await new Promise<number>((resolve) => {
          pending = resolve;
          bumpStateCounter(cacheDir, fixture.worklogDir);
        });
        detectMs.push(round1(detectedAt - startedAt));
        await refresh();
        reflectMs.push(round1(performance.now() - startedAt));
      }
    } finally {
      watch.dispose();
    }
    if (!watchActive) {
      throw new Error(
        'large-db harness: the DB-change watch could not be armed in this environment, so the ' +
          'write → reflect measurement is unavailable — check fs.watch availability for ' +
          path.dirname(stateCounterFilePath(cacheDir, fixture.worklogDir)),
      );
    }

    const spawnCounts = measured.map((sample) => sample.spawns);
    const worklistSpawnsPerRefresh = measured.map((sample) =>
      sample.spawnArgs.filter((args) => isConsolidatedWorklistSpawn(args)).length,
    );
    const consolidatedReads = worklistSpawnsPerRefresh.filter((count) => count > 0).length;
    const spawnKinds: Record<string, number> = {};
    for (const sample of measured) {
      for (const [kind, count] of Object.entries(sample.spawnKinds)) {
        spawnKinds[kind] = (spawnKinds[kind] ?? 0) + count;
      }
    }

    const peakRssPerSpawn = measured
      .map((sample) => sample.peakRssPerSpawnMb)
      .filter((value): value is number => value !== null);
    const aggregateSpawnRss = measured
      .map((sample) => sample.aggregateSpawnRssMb)
      .filter((value): value is number => value !== null);
    const peakRssPerSpawnMb = peakRssPerSpawn.length > 0 ? Math.max(...peakRssPerSpawn) : null;
    const aggregateSpawnRssMb = aggregateSpawnRss.length > 0 ? Math.max(...aggregateSpawnRss) : null;
    const refreshRssDeltaMb = round1(
      Math.max(0, process.resourceUsage().maxRSS - rssBeforeSamplesKb) / 1024,
    );

    const report: LargeDbReport = {
      profile: profileName,
      target: invocation.target,
      invocation: invocation.method,
      node: process.version,
      host: os.hostname(),
      capturedAt: new Date().toISOString(),
      samples: measured.length,
      dataset: {
        items: fixture.itemCount,
        descriptionChars: scale.descriptionChars,
        parentGroups: fixture.parentIds.length,
        expandedParents: fixture.expandedParentIds.length,
        dependencyEdges: fixture.dependencyEdges,
        dbSizeMb: fixture.dbSizeMb,
        diskSizeMb: fixture.diskSizeMb,
        generationMs: fixture.generationMs,
      },
      refresh: {
        p50WallMs: round1(percentile(measured.map((sample) => sample.wallMs), 0.5) ?? 0),
        p95WallMs: round1(percentile(measured.map((sample) => sample.wallMs), 0.95) ?? 0),
        p50CpuMs: round1(percentile(measured.map((sample) => sample.cpuMs), 0.5) ?? 0),
        p95CpuMs: round1(percentile(measured.map((sample) => sample.cpuMs), 0.95) ?? 0),
        eventLoopBlockingP95Ms: round1(
          percentile(measured.map((sample) => sample.eventLoopBlockedMs), 0.95) ?? 0,
        ),
        maxEventLoopBlockedMs: round1(
          Math.max(...measured.map((sample) => sample.maxEventLoopBlockedMs), 0),
        ),
        spawnsPerRefresh: percentile(spawnCounts, 0.95) ?? 0,
        consolidatedWorklistSpawns: percentile(worklistSpawnsPerRefresh, 0.95) ?? 0,
        consolidatedWorklistReads: consolidatedReads,
        spawnKinds,
        peakRssPerSpawnMb,
        aggregateSpawnRssMb,
      },
      pane: {
        peakRssMb: round1(process.resourceUsage().maxRSS / 1024),
        refreshRssDeltaMb,
        aggregateRssMb: round1(refreshRssDeltaMb + (peakRssPerSpawnMb ?? 0)),
      },
      idle: { changed: idleChanged, spawns: idleSpawns },
      writeToReflect: {
        detectMs,
        reflectMs,
        p50DetectMs: round1(percentile(detectMs, 0.5) ?? 0),
        p95DetectMs: round1(percentile(detectMs, 0.95) ?? 0),
        p50ReflectMs: round1(percentile(reflectMs, 0.5) ?? 0),
        p95ReflectMs: round1(percentile(reflectMs, 0.95) ?? 0),
      },
      samplesDetail: measured,
    };

    return report;
  } finally {
    resetExecFileAsync();
    resetWorklogDir();
    if (savedCacheDir === undefined) delete process.env.WL_CACHE_DIR;
    else process.env.WL_CACHE_DIR = savedCacheDir;
    if (savedSpawnFile === undefined) delete process.env.WL_SPAWN_COUNT_FILE;
    else process.env.WL_SPAWN_COUNT_FILE = savedSpawnFile;

    if (!options.keep) fixture.cleanup();
  }
}

/** Report the parent AC verdicts for a measurement (report-only view). */
export function withinAcTargets(
  report: LargeDbReport,
  budget: LargeDbBudget,
): Record<string, boolean> {
  const ac = budget.acTargets;
  return {
    refreshP95WallMs: report.refresh.p95WallMs <= ac.refreshP95WallMs,
    eventLoopBlockingP95Ms: report.refresh.eventLoopBlockingP95Ms <= ac.eventLoopBlockingP95Ms,
    peakRssPerSpawnMb:
      report.refresh.peakRssPerSpawnMb === null ||
      report.refresh.peakRssPerSpawnMb <= ac.peakRssPerSpawnMb,
    paneAggregateRssMb: report.pane.aggregateRssMb <= ac.paneAggregateRssMb,
    writeToReflectP95Ms: report.writeToReflect.p95ReflectMs <= ac.writeToReflectP95Ms,
    spawnsPerRefresh: report.refresh.spawnsPerRefresh === ac.spawnsPerRefresh,
    idleSpawns: report.idle.spawns === ac.idleSpawns,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────

interface CliOptions extends LargeDbHarnessOptions {
  json: boolean;
  updateBudget: boolean;
}

/** Parse CLI arguments (exported for the contract tests). */
export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, updateBudget: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const readValue = (): string | undefined => {
      if (!next || next.startsWith('--')) return undefined;
      index += 1;
      return next;
    };
    switch (arg) {
      case '--profile': {
        const value = readValue();
        if (value !== 'default' && value !== 'full') {
          throw new Error(`--profile requires 'default' or 'full' (got '${value ?? ''}')`);
        }
        options.profile = value;
        break;
      }
      case '--target': {
        const value = readValue();
        if (value !== 'auto' && value !== 'src' && value !== 'dist') {
          throw new Error(`--target requires 'auto', 'src' or 'dist' (got '${value ?? ''}')`);
        }
        options.target = value;
        break;
      }
      case '--samples': {
        const value = readValue();
        if (!value || !Number.isFinite(Number(value))) {
          throw new Error('--samples requires a number');
        }
        options.samples = Number(value);
        break;
      }
      case '--write-samples': {
        const value = readValue();
        if (!value || !Number.isFinite(Number(value))) {
          throw new Error('--write-samples requires a number');
        }
        options.writeSamples = Number(value);
        break;
      }
      case '--keep':
        options.keep = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--update-budget':
        options.updateBudget = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option '${arg}'`);
    }
  }
  return options;
}

/** Render a report as human-readable text. */
export function formatReport(
  report: LargeDbReport,
  budget: LargeDbBudget,
  evaluation: LargeDbBudgetEvaluation,
): string {
  const ac = withinAcTargets(report, budget);
  const lines = [
    '',
    '================================================',
    '  Herdr large-DB refresh budget harness',
    '================================================',
    '',
    `  profile:            ${report.profile} (${report.target} CLI target)`,
    `  dataset:            ${report.dataset.items} items, ${report.dataset.dbSizeMb} MB db, ` +
      `${report.dataset.dependencyEdges} dependency edges, ${report.dataset.parentGroups} parents ` +
      `(${report.dataset.expandedParents} expanded)`,
    `  generation:         ${report.dataset.generationMs} ms`,
    `  refresh wall:       p50 ${report.refresh.p50WallMs} ms, p95 ${report.refresh.p95WallMs} ms`,
    `  refresh cpu:        p50 ${report.refresh.p50CpuMs} ms, p95 ${report.refresh.p95CpuMs} ms`,
    `  event-loop blocked: p95 ${report.refresh.eventLoopBlockingP95Ms} ms ` +
      `(max stall ${report.refresh.maxEventLoopBlockedMs} ms)`,
    `  spawns per refresh: ${report.refresh.spawnsPerRefresh} ` +
      `(${report.refresh.consolidatedWorklistSpawns} worklist read/refresh, ` +
      `${report.refresh.consolidatedWorklistReads}/${report.samples} refreshes)`,
    `  peak RSS / spawn:   ${report.refresh.peakRssPerSpawnMb ?? 'n/a'} MB`,
    `  pane aggregate RSS: ${report.pane.aggregateRssMb} MB ` +
      `(refresh delta ${report.pane.refreshRssDeltaMb} MB, process peak ${report.pane.peakRssMb} MB)`,
    `  idle tick:          ${report.idle.spawns} spawns (changed: ${report.idle.changed})`,
    `  write -> reflect:   p50 ${report.writeToReflect.p50ReflectMs} ms, ` +
      `p95 ${report.writeToReflect.p95ReflectMs} ms ` +
      `(watch detection p95 ${report.writeToReflect.p95DetectMs} ms)`,
    '',
    `  parent AC targets:  ${Object.entries(ac)
      .map(([metric, ok]) => `${metric}=${ok ? 'met' : 'MISSED'}`)
      .join(', ')}`,
    `  budget ratchet:     ${evaluation.ok ? 'PASS' : 'FAIL'}`,
    '',
  ];
  if (!evaluation.ok) {
    lines.push('  violations:');
    for (const violation of evaluation.violations) lines.push(`    - ${violation}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const budget = readLargeDbBudget(REPO_ROOT);
  const profile = options.profile ?? 'default';

  const report = await runLargeDbHarness({
    ...options,
    profile,
    samples: options.samples ?? (profile === 'full' ? 5 : budget.regression.refreshSamples),
    writeSamples:
      options.writeSamples ??
      (profile === 'full' ? 5 : budget.regression.writeToReflectSamples),
  });

  if (options.updateBudget) {
    // Start from the documented template (comments, commands, policy notes)
    // and preserve every already-recorded baseline for the other targets.
    const existing = readLargeDbBudget(REPO_ROOT);
    const updated = defaultLargeDbBudget();
    for (const [name, recorded] of Object.entries(existing.profiles)) {
      const target = updated.profiles[name];
      if (!target || !recorded) continue;
      target.baselines = { ...recorded.baselines };
    }
    updated.acTargets = { ...updated.acTargets, enforced: existing.acTargets.enforced };
    const targetProfile = updated.profiles[profile];
    if (!targetProfile) throw new Error(`budget has no '${profile}' profile to update`);
    targetProfile.scale = {
      ...LARGE_DB_PROFILES[profile],
      ...((options.scale ?? {}) as Partial<LargeDbScale>),
    };
    targetProfile.baselines = {
      ...targetProfile.baselines,
      [report.target]: baselineFromReport(report),
    };
    const file = writeLargeDbBudget(REPO_ROOT, updated);
    if (!options.json) process.stdout.write(`\n  budget updated: ${file}\n`);
  }

  const evaluation = evaluateLargeDbBudget(report, readLargeDbBudget(REPO_ROOT));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        { report, evaluation, acTargets: withinAcTargets(report, readLargeDbBudget(REPO_ROOT)) },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${formatReport(report, readLargeDbBudget(REPO_ROOT), evaluation)}\n`);
  }

  if (!evaluation.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`large-db harness failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
