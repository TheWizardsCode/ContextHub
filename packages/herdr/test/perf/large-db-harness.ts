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
 * ## End-to-end parent AC report (F7)
 *
 * `--ac-report` runs the F1 refresh budget, the F3 sync-in-flight scenario, the
 * F4 in-process expand profile and the F5 spawn burst in one process and
 * aggregates the parent epic's six acceptance criteria into a single JSON
 * document (plus a human summary). This is the evidence run for
 * WL-0MVJV2QHO003K6H3:
 *
 *     npm run build && npm run test:perf:large -- --ac-report --json --target dist
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
 * npm run test:perf:large -- --ac-report --json --target dist
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
  DEFAULT_WL_SPAWN_CAP,
  createInProcessRefreshScope,
  extractItems,
  fetchActionableCount,
  fetchChildrenForItem,
  fetchChildrenForItems,
  fetchItemDetails,
  fetchNextItems,
  fetchOutboundDepsForItems,
  fetchReviewQueueState,
  getInProcessOpenStats,
  resetInProcessOpenStats,
  resetExecFileAsync,
  resetWlSpawnCap,
  resetWorklogDir,
  setExecFileAsync,
  setWlSpawnCap,
  setWorklogDir,
  type WorkItem,
} from '../../src/fetcher.js';
import { DbChangeTracker, stateCounterFilePath, watchDbChanges } from '../../src/db-change.js';
import {
  DEFAULT_DOWNTIME_CPU_GATE_PERCENT,
  HOST_CPU_MIN_SAMPLE_WINDOW_MS,
  cpuPercentFromSamples,
  parseProcStatCpu,
  type CpuStatSample,
} from '../../src/host-cpu.js';
import { regroupWorkItems } from '../../src/grouping.js';
import { WorkItemListState, formatItemLine } from '../../src/worklist.js';
import {
  formatSyncNotice,
  getSyncStatus,
  runSync as runBackgroundSync,
  _resetSyncInFlight,
  _resetSyncSpawnForTests,
  _setSyncSpawnForTests,
  type SyncChildLike,
  type SyncRunState,
} from '../../src/auto-sync.js';
import { acquireFileLock, releaseFileLock } from '../../../../src/file-lock.js';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Re-export the documented per-pane spawn cap for policy tests + docs. */
export { DEFAULT_WL_SPAWN_CAP };

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

// ── Host-contention indicators ───────────────────────────────────────
//
// The 1 ms event-loop probe counts OS descheduling as "blocked" (and its
// aggregate grows with the measured window), so an absolute reading only
// describes the plugin when the HOST is not CPU-starved. Sampling the 1-min
// load average once after the run is not enough: the average trails the
// window (WL-0MVMSE2S0006L56D — a shared multi-agent host read 0.69
// load/core while `/proc/stat` showed ~100 % utilisation and refreshes
// blocked 400 ms). These helpers therefore measure the host DURING the
// window: per-core load (max), host CPU utilisation from a `/proc/stat`
// delta, and an idle-loop canary that quantifies ambient probe noise.

/** load1 ÷ cores above which an absolute event-loop reading describes the host. */
export const HOST_LOAD_LIMIT_PER_CORE = 0.75;

/** Host CPU utilisation (%) at or above which the host counts as contended. */
export const HOST_CPU_LIMIT_PERCENT = DEFAULT_DOWNTIME_CPU_GATE_PERCENT;

/** Idle-window blocking fraction (of the window) that marks a noisy host. */
export const HOST_NOISE_RATIO_LIMIT = 0.05;

/** Idle-window blocking (ms) treated as probe/timer granularity, not noise. */
export const HOST_NOISE_FLOOR_MS = 10;

/** Per-core load observed across a measured window. */
export interface HostLoadSamples {
  /** `loadavg[0] / cpus` when the window opened. */
  start: number;
  /** Highest `loadavg[0] / cpus` sampled WHILE the window was open. */
  max: number;
  /** `loadavg[0] / cpus` at the last sample. */
  end: number;
  /** Readings collected (opening sample + periodic samples + closing sample). */
  samples: number;
}

/** Where a host CPU utilisation reading came from. */
export type HostCpuProbeSource = 'proc-stat' | 'unavailable';

/** Host CPU utilisation measured across a window (`/proc/stat` delta). */
export interface HostCpuSamples {
  /** Aggregate host utilisation (`0–100`), or `null` when unmeasurable. */
  cpuPercent: number | null;
  /** `proc-stat` on Linux; `unavailable` elsewhere (load fallback applies). */
  cpuSource: HostCpuProbeSource;
}

/** Event-loop blocking measured over an IDLE window (no product work). */
export interface IdleLoopNoise {
  /** Window length (ms). */
  durationMs: number;
  /** Aggregate blocking measured while the loop was idle (ms). */
  blockedMs: number;
  /** Longest single stall (ms). */
  maxBlockedMs: number;
}

/** Host conditions measured across a scenario's measured window. */
export interface HostConditions {
  /** Per-core load sampled before, during and after the window. */
  loadPerCore: HostLoadSamples;
  /** Host-wide CPU utilisation across the window (`null` when unmeasurable). */
  cpuPercent: number | null;
  /** Source of {@link HostConditions.cpuPercent}. */
  cpuSource: HostCpuProbeSource;
  /** Ambient event-loop noise measured on an idle window, same host/run. */
  idleNoise: IdleLoopNoise;
}

/** Current 1-min load, normalised per core. */
function currentLoadPerCore(): number {
  const load1 = os.loadavg()[0] ?? 0;
  return load1 / Math.max(1, os.cpus().length);
}

/**
 * Start sampling the per-core load for as long as a measured window is open.
 *
 * The closing `stop()` sample is what the old single post-run read did; the
 * periodic samples additionally catch a contention spike that ENDED before
 * the window closed (the load average trails the window).
 */
export function startHostLoadProbe(intervalMs = 250): {
  peek(): HostLoadSamples;
  stop(): HostLoadSamples;
} {
  const start = currentLoadPerCore();
  let latest = start;
  let max = start;
  let samples = 1;
  let result: HostLoadSamples | null = null;
  const sample = (): void => {
    latest = currentLoadPerCore();
    if (latest > max) max = latest;
    samples += 1;
  };
  const handle = setInterval(sample, Math.max(50, Math.round(intervalMs)));
  // Never keep the process alive on the sampler's account.
  handle.unref?.();
  return {
    peek(): HostLoadSamples {
      return result ?? { start, max, end: latest, samples };
    },
    stop(): HostLoadSamples {
      if (result !== null) return result;
      clearInterval(handle);
      sample();
      result = { start, max, end: latest, samples };
      return result;
    },
  };
}

/** Read the aggregate `cpu` line of `/proc/stat` (null when unavailable). */
function readProcStatSample(): CpuStatSample | null {
  try {
    return parseProcStatCpu(fs.readFileSync('/proc/stat', 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Start measuring host CPU utilisation from a `/proc/stat` delta.
 *
 * Unlike the 1-min load average this is an instantaneous, interval-scoped
 * reading: a shared host running other agents' test suites shows up as high
 * utilisation even when its load average happens to sit just below the
 * guard. Non-Linux hosts (and windows shorter than
 * {@link HOST_CPU_MIN_SAMPLE_WINDOW_MS}) report `unavailable`, so callers
 * fall back to the load signal.
 */
export function startHostCpuProbe(): { stop(): HostCpuSamples } {
  const startedAt = performance.now();
  const first = readProcStatSample();
  let result: HostCpuSamples | null = null;
  return {
    stop(): HostCpuSamples {
      if (result !== null) return result;
      const windowMs = performance.now() - startedAt;
      const last = readProcStatSample();
      if (first === null || last === null || windowMs < HOST_CPU_MIN_SAMPLE_WINDOW_MS) {
        result = { cpuPercent: null, cpuSource: 'unavailable' };
      } else {
        result = { cpuPercent: cpuPercentFromSamples(first, last), cpuSource: 'proc-stat' };
      }
      return result;
    },
  };
}

/**
 * Measure ambient event-loop noise on an IDLE window.
 *
 * The same 1 ms probe that measures a refresh, but with nothing to do: on a
 * quiet host it reports ~0, on a starved host it reports the scheduling
 * noise the host injects into any measurement. Callers use it as a
 * self-calibrating contention signal (no fixed host assumption).
 */
export async function measureIdleLoopNoise(durationMs = 250): Promise<IdleLoopNoise> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { durationMs: 0, blockedMs: 0, maxBlockedMs: 0 };
  }
  const startedAt = performance.now();
  const probe = startEventLoopProbe();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });
  const blocking = probe.stop();
  return {
    durationMs: round1(performance.now() - startedAt),
    blockedMs: blocking.totalBlockedMs,
    maxBlockedMs: blocking.maxBlockedMs,
  };
}

/**
 * Pure policy: is the host too contended for an ABSOLUTE 1 ms event-loop
 * reading to describe the plugin? (WL-0MVMSE2S0006L56D)
 *
 * Contended when ANY in-window signal says so:
 *  - host CPU utilisation at/above {@link HOST_CPU_LIMIT_PERCENT} (the same
 *    threshold the downtime dispatcher uses to stop launching work),
 *  - peak per-core load above {@link HOST_LOAD_LIMIT_PER_CORE} (the legacy
 *    fallback for hosts without `/proc/stat`),
 *  - idle-window blocking above `max(HOST_NOISE_FLOOR_MS, 5 % of the
 *    window)` (direct evidence the probe is measuring the host).
 *
 * Pure and deterministic, so the policy is unit-tested without a loaded
 * host. Unusable/absent inputs never flag contention (fail-open: the caller
 * keeps its absolute assertion).
 */
export function hostContendedForAbsoluteTiming(
  conditions: Pick<HostConditions, 'loadPerCore' | 'cpuPercent' | 'idleNoise'> | undefined,
  limits: {
    maxLoadPerCore?: number;
    maxCpuPercent?: number;
    noiseRatio?: number;
    noiseFloorMs?: number;
  } = {},
): boolean {
  if (conditions === undefined) return false;
  const maxLoadPerCore = limits.maxLoadPerCore ?? HOST_LOAD_LIMIT_PER_CORE;
  const maxCpuPercent = limits.maxCpuPercent ?? HOST_CPU_LIMIT_PERCENT;
  const noiseRatio = limits.noiseRatio ?? HOST_NOISE_RATIO_LIMIT;
  const noiseFloorMs = limits.noiseFloorMs ?? HOST_NOISE_FLOOR_MS;

  const load = conditions.loadPerCore;
  if (
    load !== undefined &&
    Number.isFinite(load.max) &&
    Number.isFinite(load.start) &&
    Number.isFinite(load.end) &&
    Math.max(load.start, load.max, load.end) > maxLoadPerCore
  ) {
    return true;
  }

  const cpuPercent = conditions.cpuPercent;
  if (typeof cpuPercent === 'number' && Number.isFinite(cpuPercent) && cpuPercent >= maxCpuPercent) {
    return true;
  }

  const idle = conditions.idleNoise;
  if (idle !== undefined && Number.isFinite(idle.durationMs) && idle.durationMs > 0) {
    const allowance = Math.max(noiseFloorMs, idle.durationMs * noiseRatio);
    if (Number.isFinite(idle.blockedMs) && idle.blockedMs > allowance) return true;
  }

  return false;
}

/**
 * Pure policy: does the with-sync event-loop reading stay inside its headroom?
 *
 * Absolute `totalBlockedMs` is the SUM of every >2 ms probe delay, so it grows
 * with the window: a host that stretches the refresh (e.g. a slow `tsx` CLI
 * spawn under external load) accumulates more absolute "blocking" with no
 * product change. Compare the BLOCKING RATE (blocked ÷ wall) instead, which is
 * window-length independent, and allow the documented relative headroom on top
 * of a floor (`minRate`, default 25 % of wall). The absolute AC numbers remain
 * gated at full scale on a quiet host by the F7 `--ac-report`.
 */
export function eventLoopHeadroomOk(
  baselineBlockedMs: number,
  baselineWallMs: number,
  measuredBlockedMs: number,
  measuredWallMs: number,
  limits: { minRate?: number; relativeHeadroom?: number } = {},
): boolean {
  const minRate = limits.minRate ?? 0.25;
  const relativeHeadroom = limits.relativeHeadroom ?? 3;
  const baseRate = baselineBlockedMs / Math.max(1, baselineWallMs);
  const measuredRate = measuredBlockedMs / Math.max(1, measuredWallMs);
  return measuredRate <= Math.max(minRate, baseRate * relativeHeadroom);
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
  /**
   * In-process SQLite connections this refresh opened (F6 —
   * WL-0MVJV2PX4005JH8D). The default-view fast path must open AT MOST ONE
   * and share it across every helper read; each scoped refresh but the last
   * closes it, so a value above 1 means a helper opened its own connection.
   */
  inProcessOpens: number;
  /**
   * Event-loop ms this refresh spent constructing in-process connections
   * (F6). The read-only / no-DDL open keeps this in the low single digits
   * on an already-initialised store.
   */
  inProcessOpenMs: number;
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
    /**
     * Highest in-process opens in one refresh (F6). The single-open
     * invariant: this must never exceed 1.
     */
    inProcessOpensPerRefresh: number;
    /** p95 event-loop ms spent opening the refresh's in-process connection (F6). */
    inProcessOpenMsP95: number;
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
  /** F5: documented max concurrent `wl` read spawns per pane (fetcher semaphore). */
  wlSpawnCap?: number;
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
      expandProfile:
        'npx tsx packages/herdr/test/perf/large-db-harness.ts --profile full --expand --json',
      spawnBurst: 'npm run test:perf:large -- --spawn-burst 8 --json',
      syncInFlight: 'npm run test:perf:large -- --sync-in-flight --samples 5 --json',
      acReport:
        'npm run build && npm run test:perf:large -- --ac-report --json --target dist  (F7 end-to-end parent AC evidence)',
    },
    acTargets: {
      refreshP95WallMs: 1500,
      eventLoopBlockingP95Ms: 200,
      peakRssPerSpawnMb: 130,
      paneAggregateRssMb: 300,
      writeToReflectP95Ms: 2000,
      spawnsPerRefresh: 1,
      idleSpawns: 0,
      wlSpawnCap: DEFAULT_WL_SPAWN_CAP,
      enforced: false,
      note:
        'Parent epic acceptance criteria at ~2,600 items / ~100 MB (WL-0MVJC1EQX001QR9W): a ' +
        'default-view refresh ≤ ~1.5 s p95 wall, ≤ ~200 ms aggregate event-loop blocking, a ' +
        'documented per-spawn peak-RSS budget below the ~130–145 MB/spawn pre-change baseline ' +
        'and ≤ ~300 MB aggregate for a single pane, write → reflect ≤ ~2 s p95, one consolidated ' +
        '`wl worklist` read per refresh and zero spawns when idle. F5 (WL-0MVJV2PC2008PY64) adds ' +
        '`wlSpawnCap` — the documented max concurrent `wl` read spawns per pane (enforced by the ' +
        'fetcher semaphore; the pane aggregate spawn RSS is bounded by cap × per-spawn peak, ' +
        'asserted by the spawn-burst scenario); F8 (WL-0MVKVJYV6008SL9G) tightened it from 2 to ' +
        '1 after F7 measured a cold 144.6–175.3 MB per-spawn peak on the built CLI at full ' +
        'scale, which made `2 × peak` breach the ceiling. AC5 is enforced as the epic states it: EITHER the ' +
        'per-spawn peak is inside `peakRssPerSpawnMb` OR the capped fan-out ' +
        '(`wlSpawnCap × peak`) stays inside `paneAggregateRssMb`. The AC numbers are asserted for ' +
        'the built (`dist`) CLI only — the `src` (tsx) target pays tsx module-load cost inside ' +
        'every spawn and does not describe what `wl` runs. `enforced` was flipped true by F7 ' +
        '(WL-0MVJV2QHO003K6H3) after a compliant full-scale `dist` baseline was recorded.',
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

  // 8. Parent AC targets — only for the enforced full-scale profile measured
  //    through the BUILT CLI (`dist`). The `src` (tsx) target pays tsx's own
  //    module-load cost inside every spawned `wl`, so its wall-clock numbers
  //    describe the dev harness, not what `/usr/local/bin/wl` does; the AC
  //    numbers are therefore asserted for `dist` only.
  if (ac.enforced && input.profile === 'full' && String(input.target) === 'dist') {
    const acChecks: Array<[string, number | null, number]> = [
      ['AC refreshP95WallMs', input.refresh.p95WallMs, ac.refreshP95WallMs],
      ['AC eventLoopBlockingP95Ms', input.refresh.eventLoopBlockingP95Ms, ac.eventLoopBlockingP95Ms],
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

    // AC5 is an OR (see withinSpawnMemoryBudget): a per-spawn budget OR a
    // capped fan-out whose `cap × peak` aggregate stays inside the ceiling.
    const peak = input.refresh.peakRssPerSpawnMb;
    if (peak !== null) {
      const cap = ac.wlSpawnCap ?? 1;
      const aggregateBound = round1(cap * peak);
      const ok = withinSpawnMemoryBudget(peak, ac);
      push({
        metric: 'AC spawnMemoryBudget',
        measured: round1(peak),
        limit: ac.peakRssPerSpawnMb,
        ok,
        detail:
          `per-spawn peak ${round1(peak)} MB vs ${ac.peakRssPerSpawnMb} MB budget; ` +
          `capped fan-out ${cap} × ${round1(peak)} = ${aggregateBound} MB vs ` +
          `${ac.paneAggregateRssMb} MB pane ceiling (either route satisfies AC5)`,
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
  resetInProcessOpenStats();

  const cpuStart = process.cpuUsage();
  const probe = startEventLoopProbe();
  const startedAt = performance.now();
  await refresh();
  const wallMs = performance.now() - startedAt;
  const blocking = probe.stop();
  const cpu = process.cpuUsage(cpuStart);
  const inProcess = getInProcessOpenStats();

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
    inProcessOpens: inProcess.opens,
    inProcessOpenMs: round1(inProcess.openMs),
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
    const inProcessOpenMsSamples = measured.map((sample) => sample.inProcessOpenMs);
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
        inProcessOpensPerRefresh: percentile(
          measured.map((sample) => sample.inProcessOpens),
          0.95,
        ) ?? 0,
        inProcessOpenMsP95: percentile(inProcessOpenMsSamples, 0.95) ?? 0,
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

// ── Expand / hydrator-dep read profile (F4 — WL-0MVJV2ORY002MNFF) ────
//
// F1's measured refresh covers the batched expanded-children read
// (`fetchChildrenForItems`) and its spawn invariants. F4 extends the
// harness to the two remaining per-node reads AC1/AC2 eliminate on the
// in-process path:
//
//   1. the SINGLE-parent expand read (`fetchChildrenForItem`) — the
//      per-expand keypress path used to spawn `wl list --parent <id>`;
//   2. the hydrator OUTBOUND-dependency read (`fetchOutboundDepsForItems`)
//      — the batched in-process dep seam the hydrator now prefers over one
//      `wl dep list <id>` spawn per candidate (plus a `wl show` per edge).
//
// Both are measured on the SAME fixture logic as the refresh (default for
// the default suite, `full` via `--profile full` for the operator-scale
// ~2,600-item case), and both assert zero spawns when the in-process path
// is available plus exact parity with the CLI spawn path (the correctness
// half of AC1: ordering, fields, depth and enrichment semantics).

export interface ExpandReadProfileOptions {
  /** Fixture profile (default `default`). */
  profile?: LargeDbProfileName;
  /** Override the profile's scale (used by focused tests). */
  scale?: Partial<LargeDbScale>;
  /** CLI target to drive (default `auto`). */
  target?: 'auto' | LargeDbTarget;
  /** Repository root (defaults to this checkout). */
  repoRoot?: string;
}

/** Measured F4 expand/dep-read profile (one fixture run). */
export interface ExpandReadMetrics {
  profile: LargeDbProfileName;
  target: LargeDbTarget;
  /** Items in the fixture (the ~2,600-item case via the `full` profile). */
  datasetItems: number;
  /** Spawns the single-parent expand issued (0 on the in-process path). */
  expandSpawns: number;
  expandWallMs: number;
  /** Children returned for the sampled expanded parent. */
  expandChildren: number;
  /** True when the in-process expand rows equal the `wl list --parent` spawn rows. */
  childrenMatchCli: boolean;
  /** Spawns the batched hydrator dep read issued (0 on the in-process path). */
  hydratorDepSpawns: number;
  hydratorDepWallMs: number;
  /** Items the batched hydrator dep read covered. */
  hydratorDepItems: number;
  /** True when the batched dep rows match the `wl dep list` spawn rows (ids + status). */
  dependencyRowsMatchCli: boolean;
}

/** Project the rows AC1 pins (ordering, fields, depth, childCount, status). */
function projectChildRows(items: WorkItem[]): unknown[] {
  return items.map((item) => ({
    id: item.id,
    parentId: item.parentId ?? null,
    depth: item.depth ?? null,
    childCount: item.childCount ?? 0,
    status: item.status ?? null,
    stage: item.stage ?? null,
  }));
}

/**
 * Run the F4 expand / hydrator-dep read profile (WL-0MVJV2ORY002MNFF).
 *
 * Restores every piece of global state it touches (env, fetcher worklog dir
 * / exec seam) and deletes the generated fixture unless the caller asks to
 * keep it. Spawn accounting goes through the fetcher's injectable exec seam
 * (arguments are recorded and the real resolved CLI runs), so a zero-spawn
 * assertion is exact regardless of whether the CLI records itself.
 */
export async function runExpandReadProfile(
  options: ExpandReadProfileOptions = {},
): Promise<ExpandReadMetrics> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const profileName: LargeDbProfileName = options.profile ?? 'default';
  const scale: LargeDbScale = { ...LARGE_DB_PROFILES[profileName], ...(options.scale ?? {}) };
  const fixture = generateLargeWorklog(scale);
  const cacheDir = path.join(fixture.rootDir, 'cache');
  const invocation = resolveCliInvocation(options.target ?? 'auto', repoRoot);
  const spawnArgs: string[][] = [];

  const savedCacheDir = process.env.WL_CACHE_DIR;
  try {
    process.env.WL_CACHE_DIR = cacheDir;
    setWorklogDir(fixture.worklogDir);
    setExecFileAsync((async (file: unknown, args: unknown, execOptions: unknown) => {
      const argv = (args as string[]) ?? [];
      spawnArgs.push([...argv]);
      void file;
      return runCliTarget(invocation, argv, execOptions);
    }) as Parameters<typeof setExecFileAsync>[0]);

    // Preflight: the in-process read path must be available, else the zero-
    // spawn assertions would describe a degraded run (missing build step).
    const preflightScope = createInProcessRefreshScope();
    let inProcessItems: number | undefined;
    try {
      inProcessItems = await preflightScope.read((db) => db.list({}).length);
    } finally {
      preflightScope.close();
    }
    if (inProcessItems === undefined) {
      throw new Error(
        'large-db harness: the in-process SQLite read path is unavailable, so the expand/dep ' +
          'read profile would fall back to per-node `wl` spawns. Build the shared package first ' +
          '(`npm run build:shared`).',
      );
    }

    const sampleParent = fixture.expandedParentIds[0];

    // ── Single-parent expand, in-process ────────────────────────────
    spawnArgs.length = 0;
    const expandStart = performance.now();
    const viaDb = await fetchChildrenForItem(sampleParent, 2);
    const expandWallMs = round1(performance.now() - expandStart);
    const expandSpawns = spawnArgs.length;

    // The CLI spawn path for the SAME parent: run the resolved CLI directly
    // and apply the EXACT production fallback pipeline the fetcher uses
    // (`extractItems` → depth → `regroupWorkItems`) so the comparison is
    // against the real CLI semantics the in-process read replaces.
    const cliOut = await runCliTarget(
      invocation,
      buildWlArgs(['list', '--parent', sampleParent, '--json']),
      undefined,
    );
    const viaCli = regroupWorkItems(
      extractItems(JSON.parse(cliOut.stdout)).map((item) => ({ ...item, depth: 2 })),
    );
    // The parity probe must not be vacuously green: the CLI returned rows
    // for the sampled expanded parent (a populated subtree on every profile).
    if (viaCli.length === 0) {
      throw new Error('expand profile: the CLI parity probe returned no parent children');
    }
    const childrenMatchCli =
      JSON.stringify(projectChildRows(viaDb)) === JSON.stringify(projectChildRows(viaCli));

    // ── Hydrator batched dependency read, in-process ────────────────
    // Candidates: the expanded parents plus a slice of their children, so the
    // batched seam is exercised over real dependency edges (the generator
    // writes one every `dependencyEvery` items).
    spawnArgs.length = 0;
    const depStart = performance.now();
    const depCandidates = [
      ...fixture.expandedParentIds,
      ...viaDb.slice(0, 5).map((child) => child.id),
    ];
    const byItem = await fetchOutboundDepsForItems(depCandidates);
    const hydratorDepWallMs = round1(performance.now() - depStart);
    const hydratorDepSpawns = spawnArgs.length;
    const hydratorDepItems = depCandidates.length;

    // Parity probe: pick the first candidate with an outbound edge and
    // compare ids + status to the real `wl dep list` spawn output (run
    // through the SAME resolved CLI the harness measures, so the comparison
    // is against the exact CLI semantics the in-process read replaces).
    let dependencyRowsMatchCli = true;
    const depSample = depCandidates.find((id) => (byItem?.get(id) ?? []).length > 0);
    if (depSample !== undefined) {
      spawnArgs.length = 0;
      const output = await runCliTarget(
        invocation,
        buildWlArgs(['dep', 'list', depSample, '--json']),
        undefined,
      );
      const payload = JSON.parse(output.stdout) as { outbound?: unknown[] } | null;
      const cliRows = new Map<string, string | undefined>();
      for (const raw of payload?.outbound ?? []) {
        const row = raw as { id?: unknown; status?: unknown };
        if (typeof row.id !== 'string') continue;
        cliRows.set(row.id, typeof row.status === 'string' ? row.status : undefined);
      }
      const dbRows = (byItem?.get(depSample) ?? []).map((target) => [
        target.id,
        typeof target.status === 'string' ? target.status : undefined,
      ] as const);
      if (dbRows.length !== cliRows.size) {
        dependencyRowsMatchCli = false;
      } else {
        for (const [id, status] of dbRows) {
          if (cliRows.get(id) !== status) {
            dependencyRowsMatchCli = false;
            break;
          }
        }
      }
    }

    // Sanity guard: the dep parity probe really came from the CLI (the
    // sample had at least one outbound edge, so a vacuous empty-vs-empty
    // match would fail the non-vacuous guard below instead).
    const depSampleCount = depSample !== undefined ? (byItem?.get(depSample) ?? []).length : 0;
    if (depSample === undefined || depSampleCount < 1) {
      throw new Error('expand profile: no fixture item had an outbound dependency edge');
    }

    return {
      profile: profileName,
      target: invocation.target,
      datasetItems: fixture.itemCount,
      expandSpawns,
      expandWallMs,
      expandChildren: viaDb.length,
      childrenMatchCli,
      hydratorDepSpawns,
      hydratorDepWallMs,
      hydratorDepItems,
      dependencyRowsMatchCli,
    };
  } finally {
    resetExecFileAsync();
    resetWorklogDir();
    if (savedCacheDir === undefined) delete process.env.WL_CACHE_DIR;
    else process.env.WL_CACHE_DIR = savedCacheDir;
    fixture.cleanup();
  }
}

// ── Auto-sync isolation scenarios (F3 — WL-0MVJV2O7H003HY9N) ─────────
//
// F1/F2 measure the refresh. F3 has to prove the OPPOSITE direction: a long
// `wl sync` running in the background can never make the pane wait. Two
// scenarios provide that evidence deterministically, without a real 36 s
// sync process:
//
//   - `runSyncInFlightScenario()` — a hooked ("in flight forever" until the
//     measurement ends) sync started through the REAL `runSync`, so the
//     in-flight instrumentation (PID + monotonic start), the off-loop spawn
//     and the pane's non-blocking notice are all exercised; concurrent
//     refreshes are measured against a no-sync baseline from the same host.
//   - `runSyncLockContentionScenario()` — the sync-shaped writer holds both
//     the per-worklog sync FILE lock and a real SQLite write transaction on
//     the worklog DB; concurrent refreshes must complete without waiting.

/** Options for the F3 auto-sync isolation scenarios. */
export interface SyncIsolationScenarioOptions {
  /** Fixture profile (default `default`). */
  profile?: LargeDbProfileName;
  /** Override the profile's scale. */
  scale?: Partial<LargeDbScale>;
  /** Measured refresh samples in each phase (default 3). */
  samples?: number;
  /** Simulated `wl sync` duration in ms (default: the operator-observed ~36 s). */
  syncDurationMs?: number;
  /** Ambience-window length for the host-contention canary (default 250 ms). */
  idleCanaryMs?: number;
  /** CLI target to drive (default `auto`). */
  target?: 'auto' | LargeDbTarget;
  /** Repository root (defaults to this checkout). */
  repoRoot?: string;
  /** Keep the generated fixture on disk for inspection. */
  keep?: boolean;
  /** Pre-generated fixture (the caller owns cleanup). */
  fixture?: LargeDbFixture;
}

/** One refresh measured while the hooked long sync was in flight. */
export interface SyncInFlightSample extends RefreshSample {
  /** Monotonic elapsed time of the sync when this refresh ended (ms). */
  syncElapsedAtEndMs: number;
  /** How much of the simulated sync duration was still left (ms). */
  syncRemainingAtEndMs: number;
  /** PID reported by the in-flight instrumentation at refresh end. */
  syncPidAtEnd: number | undefined;
  /** The pane's status-notice text at refresh end. */
  noticeText: string;
}

/** Report of the "refresh while a long sync is in flight" scenario. */
export interface SyncInFlightReport {
  profile: LargeDbProfileName;
  target: LargeDbTarget;
  invocation: string;
  samples: number;
  /** Simulated sync duration (ms). */
  syncDurationMs: number;
  /** PID observed at spawn time — the instrumentation the pane reads. */
  syncPid: number | undefined;
  /** `getSyncStatus().state` at spawn time (must be `syncing`). */
  syncStateAtSpawn: SyncRunState;
  /** Event-loop blocking attributable to STARTING the sync (ms). */
  spawnBlockingMs: number;
  /** The pane's notice text while the sync was in flight. */
  noticeWhileInFlight: string;
  /** Refresh measurements with NO sync in flight (same run, same host). */
  baseline: RefreshSample[];
  /** Refresh measurements taken while the long sync was in flight. */
  withSync: SyncInFlightSample[];
  /** Smallest sync-remaining across all with-sync refreshes (ms). */
  minRemainingAtEndMs: number;
  /** True when EVERY with-sync refresh finished before the sync did. */
  noWaitGap: boolean;
  /** Sync state after the hook settled (must be `synced`). */
  settledState: SyncRunState;
  /** Outcome success of the hooked sync run. */
  lastOutcomeSuccess: boolean | undefined;
  /** Host conditions measured across this scenario's window. */
  hostConditions: HostConditions;
}

/** Context shared by the F3 isolation scenarios (mirrors F1's setup). */
interface IsolationContext {
  fixture: LargeDbFixture;
  profile: LargeDbProfileName;
  invocation: LargeDbCliInvocation;
  scale: LargeDbScale;
  spawnFile: string;
  spawnArgs: string[][];
  refresh: () => Promise<void>;
  cleanup: () => void;
}

/**
 * Set up the fixture, cache dir, spawn-count file, fetcher exec seam, the
 * in-process read preflight and cache priming — the same environment the F1
 * ratchet measures, so both scenarios describe the real data path. The caller
 * owns `cleanup()` (restores env + exec seam, drops the fixture).
 */
async function openIsolationContext(
  options: SyncIsolationScenarioOptions,
): Promise<IsolationContext> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const profileName: LargeDbProfileName = options.profile ?? 'default';
  const scale: LargeDbScale = { ...LARGE_DB_PROFILES[profileName], ...options.scale };
  const invocation = resolveCliInvocation(options.target ?? 'auto', repoRoot);
  const fixture = options.fixture ?? generateLargeWorklog(scale);
  const cacheDir = path.join(fixture.rootDir, 'cache');
  const spawnFile = path.join(fixture.rootDir, 'spawns.log');
  const spawnArgs: string[][] = [];
  const savedCacheDir = process.env.WL_CACHE_DIR;
  const savedSpawnFile = process.env.WL_SPAWN_COUNT_FILE;

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

  process.env.WL_CACHE_DIR = cacheDir;
  process.env.WL_SPAWN_COUNT_FILE = spawnFile;
  setWorklogDir(fixture.worklogDir);
  setExecFileAsync((async (file: unknown, args: unknown, execOptions: unknown) => {
    const argv = (args as string[]) ?? [];
    spawnArgs.push([...argv]);
    void file;
    return runCliTarget(invocation, argv, execOptions);
  }) as Parameters<typeof setExecFileAsync>[0]);

  // Preflight: the measured path relies on the in-process SQLite read path.
  const preflightScope = createInProcessRefreshScope();
  let inProcessItems: number | undefined;
  try {
    inProcessItems = await preflightScope.read((db) => db.list({}).length);
  } finally {
    preflightScope.close();
  }
  if (inProcessItems === undefined) {
    throw new Error(
      'sync-isolation harness: the in-process SQLite read path is unavailable, so the default-view ' +
        'refresh would fall back to per-parent `wl` spawns — build the shared package first ' +
        '(`npm run build:shared`).',
    );
  }
  // Prime the read cache so the measured refreshes are genuinely warm.
  await refresh();
  await refresh();

  return {
    fixture,
    profile: profileName,
    invocation,
    scale,
    spawnFile,
    spawnArgs,
    refresh,
    cleanup: () => {
      resetExecFileAsync();
      resetWorklogDir();
      if (savedCacheDir === undefined) delete process.env.WL_CACHE_DIR;
      else process.env.WL_CACHE_DIR = savedCacheDir;
      if (savedSpawnFile === undefined) delete process.env.WL_SPAWN_COUNT_FILE;
      else process.env.WL_SPAWN_COUNT_FILE = savedSpawnFile;
      if (!options.keep) fixture.cleanup();
    },
  };
}

/**
 * F5 (WL-0MVJV2PC2008PY64) — bounded `wl` spawn concurrency scenario.
 *
 * The parent AC 5 per-pane RSS ceiling (≤ ~300 MB) cannot be guaranteed by
 * documented intent alone: a spawn-heavy fan-out (fallback per-subset reads,
 * per-edge `wl show`/`wl dep list` probes) could keep a dozen `wl` processes
 * alive at once. This scenario drives a burst of DISTINCT single-item reads
 * through the real fetcher exec seam on the same fixture the refresh ratchet
 * uses, and asserts the three F5 invariants for each phase:
 *
 *   1. the observed peak SIMULTANEOUS child-process count never exceeds the
 *      documented cap (`DEFAULT_WL_SPAWN_CAP`);
 *   2. the derived aggregate spawn-RSS bound `cap × per-spawn peak` stays at
 *      or below the documented ceiling (parent AC 5 ≈ 300 MB);
 *   3. queued/deferred reads never block the TUI event loop (the thaw release
 *      is a microtask, and children run off-loop) — aggregate loop blocking
 *      stays within the parent AC 1 ≤ ~200 ms bound.
 *
 * Every burst read (`wl show <id>`) spawns unconditionally (no in-process
 * SQLite shortcut) and is cacheable, so each recorded spawn carries its own
 * peak RSS (the `wl show` procedure — open + one item — is also the
 * documented lower bound a per-spawn budget must not regress).
 */
export interface SpawnCapScenarioOptions {
  /** Fixture profile (default `default`). */
  profile?: LargeDbProfileName;
  /** Override the profile's scale (used by focused tests). */
  scale?: Partial<LargeDbScale>;
  /** CLI target to drive (default `auto`). */
  target?: 'auto' | LargeDbTarget;
  /** Repository root (defaults to this checkout). */
  repoRoot?: string;
  /** Distinct reads to fan out concurrently (default 8). */
  burst?: number;
  /** Repeat samples per phase for a stable p95 (default 1 at `default`). */
  samples?: number;
  /** Keep the generated fixture for inspection. */
  keep?: boolean;
}

/** One phase of the spawn-cap scenaario (`capped` vs `uncapped` reference). */
export interface SpawnCapPhaseReport {
  /** The spawn-concurrency cap in effect for this phase. */
  cap: number;
  /** Reads issued (each is one distinct `wl show` reading a real item). */
  burst: number;
  /** Peak simultaneous child `wl` processes observed (via the exec seam). */
  peakConcurrentSpawns: number;
  /** Total child spawns issued (must equal `burst`: nothing may drop). */
  spawns: number;
  /** Per-spawn peak RSS recorded by the CLI's own spawn instrumentation (MiB). */
  peakRssPerSpawnMb: number | null;
  /** Documented aggregate spawn-RSS bound: `cap × per-spawn peak` (MiB). */
  aggregateRssBoundMb: number | null;
  /** Aggregate TUI event-loop blocking during the phase (ms). */
  eventLoopBlockedMs: number;
  /** Longest single event-loop stall during the phase (ms). */
  maxEventLoopBlockedMs: number;
  /** Wall time of the phase (ms). */
  wallMs: number;
}

/** Combined result of the F5 spawn-concurrency scenario. */
export interface SpawnCapScenarioReport {
  profile: LargeDbProfileName;
  target: LargeDbTarget;
  datasetItems: number;
  capped: SpawnCapPhaseReport;
  /** Same burst with the cap widened to the burst size (the fan-out picture). */
  uncapped: SpawnCapPhaseReport;
  ok: boolean;
  violations: string[];
}

/**
 * Run the F5 spawn-concurrency scenario (both phases on one fixture).
 *
 * Restores every piece of global state it touches (env, fetcher worklog dir,
 * exec seam, spawn cap) and deletes the fixture unless the caller asks to
 * keep it. The `uncapped` reference phase widens the cap to the burst size,
 * so the two measured `peakConcurrentSpawns` numbers are the before/after
 * evidence for the documented budget.
 */
export async function runSpawnConcurrencyScenario(
  options: SpawnCapScenarioOptions = {},
): Promise<SpawnCapScenarioReport> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const profileName: LargeDbProfileName = options.profile ?? 'default';
  const scale: LargeDbScale = { ...LARGE_DB_PROFILES[profileName], ...(options.scale ?? {}) };
  const burst = Math.min(Math.max(2, options.burst ?? 8), scale.expandedParents);
  const samples = Math.max(1, options.samples ?? 1);
  const fixture = generateLargeWorklog(scale);
  const cacheDir = path.join(fixture.rootDir, 'cache');
  const spawnFile = path.join(fixture.rootDir, 'spawns.log');
  const invocation = resolveCliInvocation(options.target ?? 'auto', repoRoot);

  const savedCacheDir = process.env.WL_CACHE_DIR;
  const savedSpawnFile = process.env.WL_SPAWN_COUNT_FILE;

  try {
    process.env.WL_CACHE_DIR = cacheDir;
    process.env.WL_SPAWN_COUNT_FILE = spawnFile;
    setWorklogDir(fixture.worklogDir);

    // The distinct single-item reads driving the burst. Each `wl show <id>`
    // spawns unconditionally through the fetcher's injectable exec seam and
    // is a cacheable read, so the CLI records per-spawn peak RSS that the
    // spawn-count instrumentation picks up.
    const sampleIds = fixture.parentIds.slice(0, burst);
    const reads = (): Array<Promise<unknown>> => sampleIds.map((id) => fetchItemDetails(id));

    const runPhase = async (cap: number): Promise<SpawnCapPhaseReport> => {
      setWlSpawnCap(cap);
      const wallSamples: number[] = [];
      const blockedSamples: number[] = [];
      const maxStalls: number[] = [];
      let peakConcurrentSpawns = 0;
      let spawns = 0;
      for (let index = 0; index < samples; index += 1) {
        fs.rmSync(spawnFile, { force: true });
        // Clear the CLI read cache so every burst read is a COLD (`read-work`)
        // spawn — the worst case for per-spawn RSS and the case a memory
        // budget must bound. A warm (`cache-hit`) burst would under-report.
        fs.rmSync(cacheDir, { recursive: true, force: true });
        let active = 0;
        setExecFileAsync((async (file: unknown, args: unknown, execOptions: unknown) => {
          const argv = (args as string[]) ?? [];
          void file;
          active += 1;
          if (active > peakConcurrentSpawns) peakConcurrentSpawns = active;
          try {
            return await runCliTarget(invocation, argv, execOptions);
          } finally {
            active -= 1;
          }
        }) as Parameters<typeof setExecFileAsync>[0]);

        const probe = startEventLoopProbe();
        const startedAt = performance.now();
        const results = await Promise.allSettled(reads());
        const wallMs = performance.now() - startedAt;
        const blocking = probe.stop();
        void results;

        wallSamples.push(wallMs);
        blockedSamples.push(blocking.totalBlockedMs);
        maxStalls.push(blocking.maxBlockedMs);
        spawns += summariseSpawnRecords(spawnFile).total;
      }

      const summary = summariseSpawnRecords(spawnFile);
      const peakRssPerSpawnMb =
        summary.maxRssKb === null ? null : round1(summary.maxRssKb / 1024);
      return {
        cap,
        burst,
        peakConcurrentSpawns: Math.max(peakConcurrentSpawns, 0),
        spawns,
        peakRssPerSpawnMb,
        aggregateRssBoundMb:
          peakRssPerSpawnMb === null ? null : round1(cap * peakRssPerSpawnMb),
        eventLoopBlockedMs: round1(Math.max(...blockedSamples, 0)),
        maxEventLoopBlockedMs: round1(Math.max(...maxStalls, 0)),
        wallMs: round1(Math.max(...wallSamples)),
      };
    };

    // Phase 1 — the capped production path: the documented cap in effect.
    const capped = await runPhase(DEFAULT_WL_SPAWN_CAP);
    // Phase 2 — uncapped reference: same burst, cap widened to the burst
    // size so the fan-out the cap bounds is measured, not assumed.
    const uncapped = await runPhase(burst);

    const report: SpawnCapScenarioReport = {
      profile: profileName,
      target: invocation.target,
      datasetItems: fixture.itemCount,
      capped,
      uncapped,
      ok: false,
      violations: [],
    };

    const evaluation = evaluateSpawnCapReport(report, readLargeDbBudget(REPO_ROOT));
    report.ok = evaluation.ok;
    report.violations = evaluation.violations;
    return report;
  } finally {
    resetExecFileAsync();
    resetWlSpawnCap();
    resetWorklogDir();
    if (savedCacheDir === undefined) delete process.env.WL_CACHE_DIR;
    else process.env.WL_CACHE_DIR = savedCacheDir;
    if (savedSpawnFile === undefined) delete process.env.WL_SPAWN_COUNT_FILE;
    else process.env.WL_SPAWN_COUNT_FILE = savedSpawnFile;
    if (!options.keep) fixture.cleanup();
  }
}

/**
 * Pure policy for the F5 spawn-concurrency scenario (deterministic, so the
 * default suite can exercise every violation without a real run).
 */
export function evaluateSpawnCapReport(
  report: SpawnCapScenarioReport,
  budget: LargeDbBudget = readLargeDbBudget(REPO_ROOT),
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  const phase = report.capped;

  // 1. The observed concurrent child count must never exceed the cap.
  if (phase.peakConcurrentSpawns > phase.cap) {
    violations.push(
      `spawn cap exceeded: peak ${phase.peakConcurrentSpawns} concurrent ` +
        `spawns > documented cap ${phase.cap}`,
    );
  }

  // 2. Nothing may be dropped: every burst read settles to a spawn record.
  if (phase.spawns !== phase.burst) {
    violations.push(
      `spawn accounting: expected ${phase.burst} spawns for ${phase.burst} reads, ` +
        `recorded ${phase.spawns}`,
    );
  }

  // 3. The documented aggregate spawn-RSS bound (cap × per-spawn peak) must
  //    stay at or below the parent ceiling the budget records.
  const ceiling = budget.acTargets?.paneAggregateRssMb ?? 300;
  if (phase.aggregateRssBoundMb !== null && phase.aggregateRssBoundMb > ceiling) {
    violations.push(
      `aggregate spawn-RSS bound ${phase.aggregateRssBoundMb} MB ` +
        `(cap ${phase.cap} × peak ${phase.peakRssPerSpawnMb ?? 'n/a'} MB) exceeds the ` +
        `documented ${ceiling} MB ceiling`,
    );
  }

  // 4. Queued/deferred reads must never block input: the event loop stays
  //    within the parent AC 1 ≤ ~200 ms total-blocking budget.
  if (phase.eventLoopBlockedMs > 200) {
    violations.push(
      `event loop blocked ${phase.eventLoopBlockedMs} ms during the burst ` +
        `(documented ≤ 200 ms) — queued reads blocked input`,
    );
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Render the F5 spawn-cap scenario report as human-readable text.
 */
export function formatSpawnCapReport(report: SpawnCapScenarioReport): string {
  const rows = (phase: SpawnCapPhaseReport): string =>
    [
      `    cap:                    ${phase.cap} concurrent spawns`,
      `    reads issued:           ${phase.burst}`,
      `    spawns recorded:        ${phase.spawns} (${phase.spawns === phase.burst ? 'none dropped' : 'DROPPED'})`,
      `    peak concurrent wl:     ${phase.peakConcurrentSpawns} child processes`,
      `    per-spawn peak RSS:     ${phase.peakRssPerSpawnMb ?? 'n/a'} MB`,
      `    aggregate bound:        ${phase.aggregateRssBoundMb ?? 'n/a'} MB (cap × per-spawn peak)`,
      `    event-loop blocked:     ${phase.eventLoopBlockedMs} ms (max stall ${phase.maxEventLoopBlockedMs} ms)`,
      `    wall:                   ${phase.wallMs} ms`,
    ].join('\n');
  return [
    '',
    '================================================',
    '  Bounded wl spawn concurrency (F5)',
    '================================================',
    '',
    `  profile:         ${report.profile} (${report.target} CLI target, ` +
      `${report.datasetItems} items)`,
    `  capped phase:`,
    rows(report.capped),
    `  uncapped reference:`,
    rows(report.uncapped),
    `  result:          ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
  ].join('\n');
}

/**
 * F3 AC1/AC2/AC3 — a concurrent default-view refresh while a long `wl sync`
 * is in flight.
 *
 *   1. Refreshes are measured first with no sync running (baseline, same
 *      host, same fixture) so host load cannot be mistaken for sync coupling.
 *   2. A hooked sync is started through the REAL `runSync` with the injectable
 *      spawn seam: the instrumentation (PID + monotonic start), the off-loop
 *      spawn cost and the pane's notice text are all the production ones.
 *   3. The hook stays in flight until every with-sync refresh has completed,
 *      so `noWaitGap` proves the refresh never waited on the sync (the sync
 *      still had `minRemainingAtEndMs` of its simulated duration left).
 *
 * The simulated duration is pure arithmetic (the hook does not sleep), so a
 * default-suite run can use the operator-observed ~36 s figure at zero cost.
 */
export async function runSyncInFlightScenario(
  options: SyncIsolationScenarioOptions = {},
): Promise<SyncInFlightReport> {
  const samples = Math.max(1, options.samples ?? 3);
  const syncDurationMs = Math.max(1, options.syncDurationMs ?? 36_000);
  const ctx = await openIsolationContext(options);
  const hostLoadProbe = startHostLoadProbe();
  const hostCpuProbe = startHostCpuProbe();
  try {
    // Phase 1 — baseline refreshes, no sync in flight.
    const baseline: RefreshSample[] = [];
    for (let index = 0; index < samples; index += 1) {
      baseline.push(await measureRefresh(ctx.refresh, ctx.spawnFile, ctx.spawnArgs));
    }

    // Ambience canary — idle-loop noise on the SAME host/run, right before
    // the measured phase.
    const idleNoise = await measureIdleLoopNoise(options.idleCanaryMs ?? 250);

    // Phase 2 — hold a long sync in flight through the REAL runSync.
    _resetSyncInFlight();
    const control = { close: null as ((code?: number | null) => void) | null };
    const child: SyncChildLike = {
      pid: 900_000 + (process.pid % 500),
      on: (event, cb) => {
        if (event === 'close') control.close = cb;
        return child;
      },
      kill: () => {
        // no-op: the hook ends when the scenario closes it.
      },
      unref: () => {
        // no-op: the hook is not a real process.
      },
    };
    _setSyncSpawnForTests(() => child);

    const probe = startEventLoopProbe();
    const syncStartedAtMonotonic = performance.now();
    const syncPromise = runBackgroundSync(ctx.fixture.worklogDir, { ifIdle: true });
    const spawnBlocking = probe.stop();
    const statusAtSpawn = getSyncStatus();
    const noticeWhileInFlight = formatSyncNotice();

    const withSync: SyncInFlightSample[] = [];
    for (let index = 0; index < samples; index += 1) {
      const sample = await measureRefresh(ctx.refresh, ctx.spawnFile, ctx.spawnArgs);
      const elapsed = performance.now() - syncStartedAtMonotonic;
      const atEnd = getSyncStatus();
      withSync.push({
        ...sample,
        syncElapsedAtEndMs: round1(elapsed),
        syncRemainingAtEndMs: round1(syncDurationMs - elapsed),
        syncPidAtEnd: atEnd.pid,
        noticeText: formatSyncNotice(),
      });
    }

    // Phase 3 — settle the hook: the sync "completes" normally.
    control.close?.(0);
    await syncPromise;
    const settled = getSyncStatus();

    const remaining = withSync.map((sample) => sample.syncRemainingAtEndMs);
    const hostSamples = hostLoadProbe.stop();
    const cpu = hostCpuProbe.stop();
    return {
      profile: ctx.profile,
      target: ctx.invocation.target,
      invocation: ctx.invocation.method,
      samples: withSync.length,
      syncDurationMs,
      syncPid: statusAtSpawn.pid,
      syncStateAtSpawn: statusAtSpawn.state,
      spawnBlockingMs: round1(spawnBlocking.totalBlockedMs),
      noticeWhileInFlight,
      baseline,
      withSync,
      minRemainingAtEndMs: round1(Math.min(...remaining)),
      noWaitGap: remaining.every((value) => value > 0),
      settledState: settled.state,
      lastOutcomeSuccess: settled.lastOutcome?.success,
      hostConditions: {
        loadPerCore: hostSamples,
        cpuPercent: cpu.cpuPercent,
        cpuSource: cpu.cpuSource,
        idleNoise,
      },
    };
  } finally {
    hostLoadProbe.stop();
    hostCpuProbe.stop();
    _resetSyncSpawnForTests();
    _resetSyncInFlight();
    ctx.cleanup();
  }
}

/** Report of the "refresh while the sync holds its locks" scenario. */
export interface SyncLockContentionReport {
  profile: LargeDbProfileName;
  target: LargeDbTarget;
  invocation: string;
  baseline: RefreshSample[];
  underWriterLock: RefreshSample[];
  /** Whether the per-worklog sync file lock was held throughout. */
  syncFileLockHeld: boolean;
  /** Whether a real SQLite write transaction was open throughout. */
  writerTransactionOpen: boolean;
  dbItemCount: number;
  /** Host conditions measured across this scenario's window. */
  hostConditions: HostConditions;
}

/**
 * F3 AC3 (lock contention) — a refresh while a sync-shaped WRITER holds both
 * (a) the per-worklog sync file lock (`worklog-data.jsonl.lock`, the exact
 * lock `wl sync --if-idle` takes) and (b) a real SQLite write transaction on
 * the worklog DB (the shape of the sync's persist phase). The pane's
 * in-process refresh scope must complete without waiting on either: the
 * refresh never shares the sync's handle and never takes its file lock.
 */
export async function runSyncLockContentionScenario(
  options: SyncIsolationScenarioOptions = {},
): Promise<SyncLockContentionReport> {
  const samples = Math.max(1, options.samples ?? 3);
  const ctx = await openIsolationContext(options);
  const hostLoadProbe = startHostLoadProbe();
  const hostCpuProbe = startHostCpuProbe();
  try {
    const baseline: RefreshSample[] = [];
    for (let index = 0; index < samples; index += 1) {
      baseline.push(await measureRefresh(ctx.refresh, ctx.spawnFile, ctx.spawnArgs));
    }

    const idleNoise = await measureIdleLoopNoise(options.idleCanaryMs ?? 250);

    const db = new Database(ctx.fixture.dbPath);
    const dbItemCount = (db.prepare('SELECT COUNT(*) AS n FROM workitems').get() as { n: number }).n;
    const lockPath = `${path.join(ctx.fixture.worklogDir, 'worklog-data.jsonl')}.lock`;
    acquireFileLock(lockPath, { timeout: 5_000 });
    let writerTransactionOpen = false;
    try {
      // Hold an exclusive write transaction: the sync's persist writes. WAL
      // mode means a reader never blocks on the writer — that is the property
      // the pane relies on.
      db.pragma('busy_timeout = 0');
      db.exec('BEGIN IMMEDIATE');
      const row = db.prepare('SELECT id FROM workitems LIMIT 1').get() as { id?: string } | undefined;
      if (row?.id) {
        db.prepare('UPDATE workitems SET updatedAt = updatedAt WHERE id = ?').run(row.id);
      }
      writerTransactionOpen = true;

      const underWriterLock: RefreshSample[] = [];
      for (let index = 0; index < samples; index += 1) {
        underWriterLock.push(await measureRefresh(ctx.refresh, ctx.spawnFile, ctx.spawnArgs));
      }
      const hostSamples = hostLoadProbe.stop();
      const cpu = hostCpuProbe.stop();
      return {
        profile: ctx.profile,
        target: ctx.invocation.target,
        invocation: ctx.invocation.method,
        baseline,
        underWriterLock,
        syncFileLockHeld: true,
        writerTransactionOpen,
        dbItemCount,
        hostConditions: {
          loadPerCore: hostSamples,
          cpuPercent: cpu.cpuPercent,
          cpuSource: cpu.cpuSource,
          idleNoise,
        },
      };
    } finally {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already rolled back — nothing to undo.
      }
      db.close();
      releaseFileLock(lockPath);
    }
  } finally {
    hostLoadProbe.stop();
    hostCpuProbe.stop();
    ctx.cleanup();
  }
}

/**
 * Parent AC 5 — the memory budget is an **OR**, exactly as the epic states it:
 *
 *   - route (a) a spawn's peak RSS is at or below the documented per-spawn
 *     budget (below the ~130–145 MB/spawn pre-change baseline), or
 *   - route (b) the pane's concurrent spawn fan-out is capped, so the
 *     aggregate spawn RSS (`cap × peak`) stays inside the documented pane
 *     ceiling (≤ ~300 MB).
 *
 * A `null` peak means the measured refresh issued no spawn at all (the
 * in-process read path), which trivially satisfies the criterion.
 */
export function withinSpawnMemoryBudget(
  peakRssPerSpawnMb: number | null,
  ac: LargeDbAcTargets,
): boolean {
  if (peakRssPerSpawnMb === null) return true;
  if (peakRssPerSpawnMb <= ac.peakRssPerSpawnMb) return true;
  const cap = ac.wlSpawnCap ?? 1;
  return cap * peakRssPerSpawnMb <= ac.paneAggregateRssMb;
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
    spawnMemoryBudget: withinSpawnMemoryBudget(report.refresh.peakRssPerSpawnMb, ac),
    writeToReflectP95Ms: report.writeToReflect.p95ReflectMs <= ac.writeToReflectP95Ms,
    spawnsPerRefresh: report.refresh.spawnsPerRefresh === ac.spawnsPerRefresh,
    idleSpawns: report.idle.spawns === ac.idleSpawns,
  };
}

// ── Single cheap in-process open (F6 — WL-0MVJV2PX4005JH8D) ──────────

/**
 * Documented budget for one refresh's in-process SQLite open (F6).
 *
 * The open runs synchronously inside the refresh (on the TUI event loop), so
 * it must never threaten the parent AC 1 ≤ ~200 ms event-loop bound. The
 * pre-F6 open measured 46–70 ms cold (schema DDL + additive-column probes +
 * the FTS5 probe's virtual-table create/drop — F2); the read-only no-DDL open
 * of an already-initialised store is a pragmas-only open, measured in the low
 * single-digit ms. This budget leaves generous headroom for a loaded host
 * while still failing if the DDL path creeps back in.
 */
export const IN_PROCESS_OPEN_BUDGET_MS = 25;

/**
 * F6 invariant: a default-view refresh performs AT MOST ONE in-process SQLite
 * open, reuses that single connection across its helpers, and the open cost
 * stays inside {@link IN_PROCESS_OPEN_BUDGET_MS}.
 *
 * Returns the violations (empty = pass) so both the on-demand full-scale run
 * and the default-suite test can assert the same policy.
 */
export function assertOpenBudget(report: LargeDbReport): string[] {
  const violations: string[] = [];
  const opens = report.refresh.inProcessOpensPerRefresh;
  if (opens > 1) {
    violations.push(
      `in-process opens per refresh: ${opens} (expected at most 1 — one shared connection per refresh)`,
    );
  }
  if (report.refresh.inProcessOpenMsP95 > IN_PROCESS_OPEN_BUDGET_MS) {
    violations.push(
      `in-process open cost p95: ${report.refresh.inProcessOpenMsP95} ms ` +
        `(budget ${IN_PROCESS_OPEN_BUDGET_MS} ms — read-only open must skip the schema/FTS DDL)`,
    );
  }
  return violations;
}

// ── End-to-end parent AC report (F7 — WL-0MVJV2QHO003K6H3) ───────────
//
// F1–F6 each verify their own slice. The parent epic's acceptance criteria
// are only proven when every measurement is taken together, at the operator's
// real scale, AFTER all the fixes. This mode runs the existing scenarios in
// one process and renders one JSON report plus a human summary:
//
//   AC1  pane responsive during refresh   -> refresh event-loop probe + spawn burst
//   AC2  refresh ≤ ~1.5 s p95, one read   -> refresh report + in-process expand
//   AC3  a long sync cannot stall the pane -> sync-in-flight scenario
//   AC4  write → reflect ≤ ~2 s p95       -> the real watchDbChanges path
//   AC5  documented memory budget         -> per-spawn budget OR capped fan-out
//   AC6  no regressions                   -> spawn/idle/open/watch invariants
//
// The full Herdr + TUI test suites are the other half of AC6 and are run by
// the workflow's test gate; this report cites that evidence rather than
// re-running the suite inside the harness.
//
// Run it at the operator's scale with:
//
//   npm run build && npm run test:perf:large -- --ac-report --json --target dist

export type LargeDbAcId = 'AC1' | 'AC2' | 'AC3' | 'AC4' | 'AC5' | 'AC6';

/** One measured number behind an AC verdict. */
export interface LargeDbAcMeasurement {
  metric: string;
  measured: number | string | boolean | null;
  target: number | string | boolean;
  ok: boolean;
  note?: string;
}

/** One parent acceptance criterion and the evidence for it. */
export interface LargeDbAcVerdict {
  id: LargeDbAcId;
  criterion: string;
  status: 'met' | 'unmet';
  /** Which harness scenario produced the numbers. */
  evidence: string;
  measurements: LargeDbAcMeasurement[];
}

/** Options for {@link runAcReport} (the scenarios share these). */
export interface LargeDbAcReportOptions {
  /** Fixture profile (default `full` — the operator's real scale). */
  profile?: LargeDbProfileName;
  /** Override the profile's scale (used by focused tests). */
  scale?: Partial<LargeDbScale>;
  /** Refresh samples per scenario (default 5 at `full`, 3 otherwise). */
  samples?: number;
  /** Write → reflect samples (default 5 at `full`, 3 otherwise). */
  writeSamples?: number;
  /** Simulated in-flight sync duration (default: the operator-observed ~36 s). */
  syncDurationMs?: number;
  /** Concurrent reads fanned out by the F5 spawn-cap scenario (default 8). */
  burst?: number;
  /** CLI target to drive (default `auto`). */
  target?: 'auto' | LargeDbTarget;
  /** Repository root (defaults to this checkout). */
  repoRoot?: string;
  /** Keep the generated fixtures on disk for inspection. */
  keep?: boolean;
}

/** Scenario outputs aggregated by {@link buildAcReport}. */
export interface LargeDbAcReportInputs {
  refresh: LargeDbReport;
  syncInFlight: SyncInFlightReport;
  spawnCap: SpawnCapScenarioReport;
  expand: ExpandReadMetrics;
  budget: LargeDbBudget;
  /** Override the report timestamp (tests). */
  generatedAt?: string;
}

/** The end-to-end parent AC report (one JSON document). */
export interface LargeDbAcReport {
  generatedAt: string;
  profile: LargeDbProfileName;
  target: LargeDbTarget;
  invocation: string;
  dataset: LargeDbReport['dataset'];
  /**
   * Host conditions at report time. The parent ACs are user-perceived
   * (wall-clock / event-loop lag) numbers, so a run under heavy external CPU
   * contention is not a valid measurement of the plugin — quote the load
   * alongside the numbers.
   */
  environment: {
    node: string;
    host: string;
    cpuCount: number;
    loadAverage: [number, number, number];
    loadPerCore1m: number;
  };
  samples: { refresh: number; writeToReflect: number; syncInFlight: number };
  acs: LargeDbAcVerdict[];
  ok: boolean;
  budget: {
    enforced: boolean;
    acTargets: LargeDbAcTargets;
    evaluation: LargeDbBudgetEvaluation;
  };
  /** Raw scenario reports, so every quoted number is reproducible. */
  evidence: {
    refresh: LargeDbReport;
    syncInFlight: SyncInFlightReport;
    spawnCap: SpawnCapScenarioReport;
    expand: ExpandReadMetrics;
    openBudgetViolations: string[];
    spawnCapViolations: string[];
  };
}

/**
 * Aggregate the F1/F3/F4/F5/F6 measurements into per-AC verdicts.
 *
 * Pure: it makes no measurements itself, so the AC mapping is deterministic
 * and testable independently of a (slow) full-scale run.
 */
export function buildAcReport(inputs: LargeDbAcReportInputs): LargeDbAcReport {
  const { refresh, syncInFlight, spawnCap, expand, budget } = inputs;
  const ac = budget.acTargets;
  const cap = ac.wlSpawnCap ?? 1;
  const peakRssPerSpawnMb = refresh.refresh.peakRssPerSpawnMb;
  const aggregateBoundMb = peakRssPerSpawnMb === null ? null : round1(cap * peakRssPerSpawnMb);
  const withSyncBlockingP95 =
    percentile(syncInFlight.withSync.map((sample) => sample.eventLoopBlockedMs), 0.95) ?? 0;
  const openViolations = assertOpenBudget(refresh);
  const memoryVerdict = withinSpawnMemoryBudget(peakRssPerSpawnMb, ac) && spawnCap.ok;

  const verdict = (
    id: LargeDbAcId,
    criterion: string,
    evidence: string,
    measurements: LargeDbAcMeasurement[],
    /**
     * Explicit satisfaction for a criterion that is an OR of routes (AC5):
     * its individual route measurements are intentionally not all `ok`.
     * Defaults to "every measurement is ok".
     */
    satisfied?: boolean,
  ): LargeDbAcVerdict => ({
    id,
    criterion,
    evidence,
    measurements,
    status: (satisfied ?? measurements.every((measurement) => measurement.ok))
      ? 'met'
      : 'unmet',
  });

  const acs: LargeDbAcVerdict[] = [
    verdict(
      'AC1',
      'Pane stays responsive during refresh: a default-view refresh does not block the TUI ' +
        'event loop for more than ~200 ms of perceived lag in aggregate — keystrokes/commands ' +
        'process promptly while a refresh is in flight.',
      'refresh event-loop probe (runLargeDbHarness) + capped spawn burst ' +
        '(runSpawnConcurrencyScenario)',
      [
        {
          metric: 'refreshEventLoopBlockingP95Ms',
          measured: refresh.refresh.eventLoopBlockingP95Ms,
          target: ac.eventLoopBlockingP95Ms,
          ok: refresh.refresh.eventLoopBlockingP95Ms <= ac.eventLoopBlockingP95Ms,
        },
        {
          metric: 'maxSingleStallMs',
          measured: refresh.refresh.maxEventLoopBlockedMs,
          target: 'report-only',
          ok: true,
        },
        {
          metric: 'spawnBurstEventLoopBlockedMs',
          measured: spawnCap.capped.eventLoopBlockedMs,
          target: ac.eventLoopBlockingP95Ms,
          ok: spawnCap.capped.eventLoopBlockedMs <= ac.eventLoopBlockingP95Ms,
        },
      ],
    ),
    verdict(
      'AC2',
      'Single-figure refresh cost on large DBs: a default-view refresh end-to-end (event → ' +
        'data load → render) is bounded to ≤ ~1.5 s wall-clock p95 on a DB of ~2,600 items / ' +
        '~100 MB, including per-expand child fetches; the consolidated `wl worklist` single-read ' +
        'path stays the norm.',
      'refresh report (runLargeDbHarness) + in-process expand/hydrator read profile ' +
        '(runExpandReadProfile)',
      [
        {
          metric: 'refreshP95WallMs',
          measured: refresh.refresh.p95WallMs,
          target: ac.refreshP95WallMs,
          ok: refresh.refresh.p95WallMs <= ac.refreshP95WallMs,
        },
        {
          metric: 'spawnsPerRefresh',
          measured: refresh.refresh.spawnsPerRefresh,
          target: ac.spawnsPerRefresh,
          ok: refresh.refresh.spawnsPerRefresh === ac.spawnsPerRefresh,
        },
        {
          metric: 'expandSpawns',
          measured: expand.expandSpawns,
          target: 0,
          ok: expand.expandSpawns === 0,
          note: 'per-expand child fetches are served in-process',
        },
        {
          metric: 'expandChildrenMatchCli',
          measured: expand.childrenMatchCli,
          target: true,
          ok: expand.childrenMatchCli,
        },
        {
          metric: 'hydratorDepSpawns',
          measured: expand.hydratorDepSpawns,
          target: 0,
          ok: expand.hydratorDepSpawns === 0,
        },
        {
          metric: 'hydratorDepRowsMatchCli',
          measured: expand.dependencyRowsMatchCli,
          target: true,
          ok: expand.dependencyRowsMatchCli,
        },
      ],
    ),
    verdict(
      'AC3',
      'Auto-sync cannot stall the pane: while a long `wl sync` is in flight in the background, ' +
        'the pane remains responsive — no lock wait, no event-loop stall, at most a brief ' +
        'non-blocking status notice.',
      'sync-in-flight scenario through the real runSync (runSyncInFlightScenario)',
      [
        {
          metric: 'noWaitGap',
          measured: syncInFlight.noWaitGap,
          target: true,
          ok: syncInFlight.noWaitGap,
          note: `min sync remaining at refresh end ${syncInFlight.minRemainingAtEndMs} ms`,
        },
        {
          metric: 'syncSpawnEventLoopMs',
          measured: syncInFlight.spawnBlockingMs,
          target: ac.eventLoopBlockingP95Ms,
          ok: syncInFlight.spawnBlockingMs <= ac.eventLoopBlockingP95Ms,
        },
        {
          metric: 'refreshEventLoopBlockingP95MsWithSync',
          measured: round1(withSyncBlockingP95),
          target: ac.eventLoopBlockingP95Ms,
          ok: withSyncBlockingP95 <= ac.eventLoopBlockingP95Ms,
        },
        {
          metric: 'statusNoticeShown',
          measured: syncInFlight.noticeWhileInFlight,
          target: 'non-blocking sync notice',
          ok: /syncing/i.test(syncInFlight.noticeWhileInFlight),
        },
        {
          metric: 'spawnsPerRefreshWithSync',
          measured: syncInFlight.withSync[0]?.spawns ?? 0,
          target: ac.spawnsPerRefresh,
          ok: (syncInFlight.withSync[0]?.spawns ?? 0) === ac.spawnsPerRefresh,
          note: 'the sync adds no refresh spawn',
        },
        {
          metric: 'syncSettledState',
          measured: syncInFlight.settledState,
          target: 'synced',
          ok: syncInFlight.settledState === 'synced',
        },
      ],
    ),
    verdict(
      'AC4',
      'Change reflection latency: after a `wl` write, the pane reflects the change within ~2 s ' +
        'p95 via the event-driven watch path at large-DB scale.',
      'real watchDbChanges write → reflect path (runLargeDbHarness)',
      [
        {
          metric: 'writeToReflectP95Ms',
          measured: refresh.writeToReflect.p95ReflectMs,
          target: ac.writeToReflectP95Ms,
          ok: refresh.writeToReflect.p95ReflectMs <= ac.writeToReflectP95Ms,
        },
        {
          metric: 'watchDetectionP95Ms',
          measured: refresh.writeToReflect.p95DetectMs,
          target: ac.writeToReflectP95Ms,
          ok: refresh.writeToReflect.p95DetectMs <= ac.writeToReflectP95Ms,
        },
      ],
    ),
    verdict(
      'AC5',
      'Reduced memory footprint: a refresh\'s spawned `wl` processes peak at no more than a ' +
        'documented per-spawn budget below the ~130–145 MB/spawn observed baseline, OR ' +
        'concurrent spawns are bounded so aggregate RSS for a single pane stays under a ' +
        'documented ceiling (e.g. ≤ ~300 MB).',
      'refresh spawn records (runLargeDbHarness) + capped/uncapped spawn burst ' +
        '(runSpawnConcurrencyScenario; policy evaluateSpawnCapReport)',
      [
        {
          metric: 'peakRssPerSpawnMb',
          measured: peakRssPerSpawnMb,
          target: ac.peakRssPerSpawnMb,
          ok: peakRssPerSpawnMb === null || peakRssPerSpawnMb <= ac.peakRssPerSpawnMb,
          note: 'route (a): per-spawn budget (informational when route (b) applies)',
        },
        {
          metric: 'cappedFanOutPeak',
          measured: spawnCap.capped.peakConcurrentSpawns,
          target: cap,
          ok: spawnCap.capped.peakConcurrentSpawns <= cap,
          note: 'route (b): concurrent `wl` read spawns stay at the documented cap',
        },
        {
          metric: 'cappedAggregateSpawnRssMb',
          measured: spawnCap.capped.aggregateRssBoundMb,
          target: ac.paneAggregateRssMb,
          ok:
            spawnCap.capped.aggregateRssBoundMb !== null &&
            spawnCap.capped.aggregateRssBoundMb <= ac.paneAggregateRssMb,
          note: `cap ${cap} × peak ${spawnCap.capped.peakRssPerSpawnMb ?? 'n/a'} MB`,
        },
        {
          metric: 'memoryBudgetRoute',
          measured: memoryVerdict ? 'satisfied' : 'missed',
          target: 'per-spawn budget OR capped aggregate ≤ pane ceiling',
          ok: memoryVerdict,
        },
      ],
      memoryVerdict,
    ),
    verdict(
      'AC6',
      'No regressions: the full Herdr plugin + TUI test suites pass; the zero-spawn-when-idle ' +
        'guarantee and event-driven watch semantics are preserved.',
      'spawn/idle/open/watch invariants measured here (runLargeDbHarness + F6 assertOpenBudget); ' +
        'the full Herdr + TUI suites are recorded on the work item by the test gate',
      [
        {
          metric: 'spawnsPerRefresh',
          measured: refresh.refresh.spawnsPerRefresh,
          target: ac.spawnsPerRefresh,
          ok: refresh.refresh.spawnsPerRefresh === ac.spawnsPerRefresh,
          note: 'one consolidated `wl worklist` read per refresh',
        },
        {
          metric: 'idleSpawns',
          measured: refresh.idle.spawns,
          target: ac.idleSpawns,
          ok: refresh.idle.spawns === ac.idleSpawns,
        },
        {
          metric: 'inProcessOpensPerRefresh',
          measured: refresh.refresh.inProcessOpensPerRefresh,
          target: 1,
          ok: refresh.refresh.inProcessOpensPerRefresh <= 1,
        },
        {
          metric: 'inProcessOpenMsP95',
          measured: refresh.refresh.inProcessOpenMsP95,
          target: IN_PROCESS_OPEN_BUDGET_MS,
          ok: refresh.refresh.inProcessOpenMsP95 <= IN_PROCESS_OPEN_BUDGET_MS,
        },
        {
          metric: 'watchDetectionP95Ms',
          measured: refresh.writeToReflect.p95DetectMs,
          target: '> 0 (event-driven, not a polling tick)',
          ok: refresh.writeToReflect.p95DetectMs > 0,
        },
      ],
    ),
  ];

  return {
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
    profile: refresh.profile,
    target: refresh.target,
    invocation: refresh.invocation,
    dataset: refresh.dataset,
    environment: {
      node: refresh.node,
      host: refresh.host,
      cpuCount: os.cpus().length,
      loadAverage: os.loadavg().slice(0, 3) as [number, number, number],
      loadPerCore1m: round1((os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length)),
    },
    samples: {
      refresh: refresh.samples,
      writeToReflect: refresh.writeToReflect.reflectMs.length,
      syncInFlight: syncInFlight.samples,
    },
    acs,
    ok: acs.every((entry) => entry.status === 'met'),
    budget: {
      enforced: ac.enforced,
      acTargets: ac,
      evaluation: evaluateLargeDbBudget(refresh, budget),
    },
    evidence: {
      refresh,
      syncInFlight,
      spawnCap,
      expand,
      openBudgetViolations: openViolations,
      spawnCapViolations: spawnCap.violations,
    },
  };
}

/**
 * Run every scenario and aggregate the end-to-end parent AC report.
 *
 * Scenarios run sequentially (each owns a throwaway fixture and restores the
 * global seams it touches) so their measurements cannot interfere.
 */
export async function runAcReport(
  options: LargeDbAcReportOptions = {},
): Promise<LargeDbAcReport> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const profile = options.profile ?? 'full';
  const samples = options.samples ?? (profile === 'full' ? 5 : 3);
  const writeSamples = options.writeSamples ?? (profile === 'full' ? 5 : 3);
  const shared = {
    profile,
    scale: options.scale,
    target: options.target,
    repoRoot,
    keep: options.keep,
  } as const;

  const refresh = await runLargeDbHarness({ ...shared, samples, writeSamples });
  const syncInFlight = await runSyncInFlightScenario({
    ...shared,
    samples,
    syncDurationMs: options.syncDurationMs,
  });
  const spawnCap = await runSpawnConcurrencyScenario({ ...shared, burst: options.burst });
  const expand = await runExpandReadProfile(shared);

  return buildAcReport({
    refresh,
    syncInFlight,
    spawnCap,
    expand,
    budget: readLargeDbBudget(repoRoot),
  });
}

/** Render the end-to-end AC report as human-readable text. */
export function formatAcReport(report: LargeDbAcReport): string {
  const unmet = report.acs.filter((entry) => entry.status === 'unmet').length;
  const renderValue = (value: number | string | boolean | null): string =>
    value === null ? 'n/a' : String(value);
  const lines = [
    '',
    '================================================',
    '  Herdr large-DB — end-to-end parent AC report (F7)',
    '================================================',
    '',
    `  profile:            ${report.profile} (${report.target} CLI target)`,
    `  dataset:            ${report.dataset.items} items, ${report.dataset.dbSizeMb} MB db, ` +
      `${report.dataset.dependencyEdges} dependency edges, ${report.dataset.parentGroups} parents ` +
      `(${report.dataset.expandedParents} expanded)`,
    `  environment:        ${report.environment.host} (${report.environment.node}, ` +
      `${report.environment.cpuCount} CPUs, load ${report.environment.loadPerCore1m}/core 1m)`,
    `  samples:            ${report.samples.refresh} refresh, ` +
      `${report.samples.writeToReflect} write -> reflect, ` +
      `${report.samples.syncInFlight} sync-in-flight`,
    `  budget ratchet:     ${report.budget.evaluation.ok ? 'PASS' : 'FAIL'} ` +
      `(parent AC targets enforced: ${report.budget.enforced})`,
    `  verdict:            ${report.ok ? 'ALL 6 PARENT ACs MET' : `${unmet} UNMET`}`,
    '',
  ];
  for (const entry of report.acs) {
    lines.push(`  ${entry.id}  ${entry.status.toUpperCase().padEnd(5)}  ${entry.criterion}`);
    lines.push(`         evidence: ${entry.evidence}`);
    for (const measurement of entry.measurements) {
      lines.push(
        `         - ${measurement.metric}: ${renderValue(measurement.measured)} ` +
          `(target ${renderValue(measurement.target)}) ` +
          `${measurement.ok ? 'OK' : 'MISS'}` +
          (measurement.note ? ` — ${measurement.note}` : ''),
      );
    }
    lines.push('');
  }
  lines.push(
    `  evidence:           F1 refresh ${report.evidence.refresh.samples} samples, ` +
      `F3 sync-in-flight ${report.evidence.syncInFlight.samples} samples, ` +
      `F4 expand ${report.evidence.expand.expandSpawns} spawns, ` +
      `F5 spawn burst ${report.evidence.spawnCap.capped.burst} reads, ` +
      `F6 open violations ${report.evidence.openBudgetViolations.length}`,
  );
  if (report.evidence.openBudgetViolations.length > 0) {
    for (const violation of report.evidence.openBudgetViolations) {
      lines.push(`    - F6: ${violation}`);
    }
  }
  if (report.evidence.spawnCapViolations.length > 0) {
    for (const violation of report.evidence.spawnCapViolations) {
      lines.push(`    - F5: ${violation}`);
    }
  }
  if (!report.budget.evaluation.ok) {
    for (const violation of report.budget.evaluation.violations) {
      lines.push(`    - ratchet: ${violation}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ── Stage profile (F2 — WL-0MVJV2NNG00771C6) ─────────────────────────
//
// F1 measures the refresh AGGREGATE. F2 needs to know WHICH driver the wall
// time and CPU belong to, so the parent epic can decide what is fixed in
// scope (F3–F6) versus deferred to a separate work item. This profile runs
// each stage of one default-view refresh on its own at full scale, using the
// same instrumentation F1 already relies on:
//
//   - spawned `wl` processes are measured through the existing spawn records
//     (`WL_SPAWN_COUNT_FILE`, WL-0MVFRR98A008MM19): wall time, the child's own
//     CPU and its peak RSS;
//   - in-process stages go through the REAL refresh scope
//     (`createInProcessRefreshScope`) and the real fetcher helpers, so the
//     numbers describe the plugin's code path rather than a reimplementation;
//   - render is measured on the real row model (`WorkItemListState` +
//     `formatItemLine`), i.e. the work the TUI does for the visible window.
//
// No production instrumentation is added: every probe point already exists.
//
// Run it with:
//
//     npm run test:perf:large -- --stages --json
//     npx tsx packages/herdr/test/perf/large-db-harness.ts --profile full --stages

/** One measured refresh stage. */
export type StageName =
  | 'cli-startup'
  | 'worklist-cold'
  | 'worklist-warm'
  | 'json-parse'
  | 'sqlite-open'
  | 'sqlite-full-read'
  | 'subset-queries'
  | 'children-inprocess-cold'
  | 'children-inprocess-warm'
  | 'children-cli-per-parent'
  | 'actionable-count'
  | 'hydrator-dep-list'
  | 'render';

/** Where a measured cost should be fixed. */
export type StageAction = 'fix-in-scope' | 'separate-item' | 'no-op';

/** A single measured stage (median of its samples unless noted). */
export interface StageSample {
  stage: StageName;
  /** Human-readable description of what was measured. */
  label: string;
  /** Samples taken (median reported). */
  samples: number;
  /** Median wall time (ms). */
  wallMs: number;
  /** Median CPU time (ms) — parent CPU plus the spawned child's own CPU. */
  cpuMs: number;
  /** `wl` processes spawned per sample. */
  spawns: number;
  /** Peak RSS of the spawned process (MB), when a spawn was involved. */
  peakRssMb: number | null;
  /** Bytes of CLI stdout, when the stage produced a payload. */
  payloadBytes: number | null;
  /** Spawn-record kind observed (`read-work` / `cache-hit` / `version`). */
  spawnKind: string | null;
  /** Recommended action for this driver. */
  action: StageAction;
  /** Why the action was chosen / what bounds this cost. */
  note: string;
}

/** A cost row of the one-refresh attribution table. */
export interface StageAttribution {
  row: string;
  wallMs: number;
  cpuMs: number;
  /** Share of the serialised one-refresh baseline (%). */
  pct: number;
  action: StageAction;
  note: string;
}

/** RSS breakdown of a `wl worklist` spawn. */
export interface RssBreakdownRow {
  component: string;
  peakRssMb: number;
  deltaMb: number | null;
  note: string;
}

/** Whole stage-profile report. */
export interface StageProfileReport {
  profile: LargeDbProfileName;
  target: LargeDbTarget;
  invocation: string;
  node: string;
  host: string;
  capturedAt: string;
  dataset: LargeDbReport['dataset'];
  stages: StageSample[];
  /** Serialised-sum attribution across the stages of one cold refresh. */
  refreshAttribution: {
    /** Serialised sum of the component stages (upper bound; live is concurrent). */
    serialisedBaselineMs: number;
    rows: StageAttribution[];
  };
  /** Whether the `wl worklist` payload can be trimmed without a contract change. */
  payload: {
    bytes: number;
    items: number;
    /** Documented `wl worklist` payload contract: full `WorkItem[]` per subset. */
    contract: string;
    trimmableWithoutContractChange: boolean;
    note: string;
  };
  rss: {
    rows: RssBreakdownRow[];
    worklistSpawnPeakMb: number | null;
    startupPeakMb: number | null;
    singleItemReadPeakMb: number | null;
    payloadBytes: number;
  };
}

/** Options accepted by {@link runStageProfile}. */
export interface StageProfileOptions {
  profile?: LargeDbProfileName;
  scale?: Partial<LargeDbScale>;
  /** Samples per stage (default 3 for spawns, 5 for in-process probes). */
  samples?: number;
  target?: 'auto' | LargeDbTarget;
  repoRoot?: string;
  /** Pre-generated fixture (skips generation; the caller owns cleanup). */
  fixture?: LargeDbFixture;
  /** Keep the generated fixture on disk for inspection. */
  keep?: boolean;
}

/** Median of a numeric sample list (`0` for an empty list). */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round1((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

/** One spawned CLI run, measured with the F1 spawn instrumentation. */
interface SpawnMeasurement {
  wallMs: number;
  cpuMs: number;
  spawns: number;
  peakRssMb: number | null;
  payloadBytes: number;
  spawnKind: string | null;
  stdout: string;
}

/**
 * GNU `time` binary, used only when it is available.
 *
 * The F1 spawn records are written by the CLI itself and only exist for the
 * cacheable reads (`list`/`next`/`show`/`search`/`status`/`worklist`), spawn
 * cache hits and `--version`. Other spawns the refresh pays for — notably the
 * hydrator's `wl dep list <id>` — are invisible to that instrumentation, so
 * their CPU and peak RSS are read from GNU `time` instead (which `exec`s the
 * CLI, so no extra process is introduced). When the binary is absent
 * (macOS/BSD `time` has a different interface) those fields stay `null` and
 * only wall time is reported.
 */
const GNU_TIME_BIN = ((): string | null => {
  if (process.platform !== 'linux') return null;
  for (const candidate of ['/usr/bin/time', '/bin/time']) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore: fall through to the next candidate
    }
  }
  return null;
})();

/** Marker line GNU `time` writes to stderr (parsed out of the child's stderr). */
const GNU_TIME_MARKER = '__WL_SPAWN_METRICS__';

/**
 * Run one `wl` invocation and measure it exactly like F1 measures a refresh
 * spawn: wall time from the parent, CPU/peak RSS from the child's own
 * `WL_SPAWN_COUNT_FILE` record (GNU `time` supplies them for spawns the CLI
 * does not instrument). The spawn file is cleared first so only this
 * invocation's record is read.
 */
async function measureSpawn(
  invocation: LargeDbCliInvocation,
  argv: string[],
  spawnFile: string,
): Promise<SpawnMeasurement> {
  fs.rmSync(spawnFile, { force: true });
  const fullArgs = buildWlArgs(argv);
  const command = GNU_TIME_BIN
    ? [
        GNU_TIME_BIN,
        '-f',
        `${GNU_TIME_MARKER} wall=%e user=%U sys=%S maxrss=%M`,
        ...invocation.command,
      ]
    : invocation.command;

  const cpuStart = process.cpuUsage();
  const startedAt = performance.now();
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        command[0],
        [...command.slice(1), ...fullArgs],
        { maxBuffer: 256 * 1024 * 1024, timeout: 300_000 },
        (error, childStdout, childStderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: childStdout, stderr: childStderr });
        },
      );
    },
  );
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);

  // `time` reports seconds; maxrss is KiB (the same unit as a spawn record).
  let externalCpuMs: number | null = null;
  let externalPeakRssKb: number | null = null;
  for (const line of stderr.split('\n')) {
    const index = line.indexOf(GNU_TIME_MARKER);
    if (index === -1) continue;
    const fields = new Map(
      line
        .slice(index + GNU_TIME_MARKER.length)
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split('=') as [string, string]),
    );
    const user = Number(fields.get('user'));
    const sys = Number(fields.get('sys'));
    const maxrss = Number(fields.get('maxrss'));
    if (Number.isFinite(user) && Number.isFinite(sys)) externalCpuMs = (user + sys) * 1000;
    if (Number.isFinite(maxrss) && maxrss > 0) externalPeakRssKb = maxrss;
  }

  const records = readSpawnRecords(spawnFile);
  const recordedCpuMs = records.reduce((total, record) => total + (record.cpuMs ?? 0), 0);
  const recordedPeakRssKb = records.reduce<number>(
    (peak, record) => (record.maxRssKb === null ? peak : Math.max(peak, record.maxRssKb)),
    0,
  );
  // Prefer GNU `time` (the FULL process: module load + DB work + serialisation)
  // over the spawn record, which the CLI writes at the cache lookup point —
  // BEFORE the work a `read-work` record exists to measure. The record remains
  // the fallback for platforms without GNU `time`, and always supplies the
  // spawn kind.
  const childCpuMs = externalCpuMs ?? recordedCpuMs;
  const peakRssKb = externalPeakRssKb ?? recordedPeakRssKb;

  return {
    wallMs: round1(wallMs),
    cpuMs: round1((cpu.user + cpu.system) / 1000 + childCpuMs),
    // Exactly one CLI process runs per measurement, even when the CLI does not
    // record itself (e.g. a non-cacheable read such as `dep list`).
    spawns: 1,
    peakRssMb: peakRssKb > 0 ? round1(peakRssKb / 1024) : null,
    payloadBytes: Buffer.byteLength(stdout),
    spawnKind: records[0]?.kind ?? null,
    stdout,
  };
}

/** Accumulate repeated measurements of one stage into a {@link StageSample}. */
class StageCollector {
  private readonly wall: number[] = [];
  private readonly cpu: number[] = [];
  private spawns = 0;
  private peakRssMb: number | null = null;
  private payloadBytes: number | null = null;
  private spawnKind: string | null = null;

  constructor(
    private readonly stage: StageName,
    private readonly label: string,
    private readonly action: StageAction,
    private readonly note: string,
  ) {}

  pushSpawn(measurement: SpawnMeasurement): void {
    this.wall.push(measurement.wallMs);
    this.cpu.push(measurement.cpuMs);
    this.spawns = Math.max(this.spawns, measurement.spawns);
    if (measurement.peakRssMb !== null) {
      this.peakRssMb = Math.max(this.peakRssMb ?? 0, measurement.peakRssMb);
    }
    this.payloadBytes = Math.max(this.payloadBytes ?? 0, measurement.payloadBytes);
    this.spawnKind = measurement.spawnKind ?? this.spawnKind;
  }

  pushTiming(timing: { wallMs: number; cpuMs: number }, payloadBytes?: number): void {
    this.wall.push(timing.wallMs);
    this.cpu.push(timing.cpuMs);
    if (payloadBytes !== undefined) {
      this.payloadBytes = Math.max(this.payloadBytes ?? 0, payloadBytes);
    }
  }

  sample(): StageSample {
    return {
      stage: this.stage,
      label: this.label,
      samples: this.wall.length,
      wallMs: medianOf(this.wall),
      cpuMs: medianOf(this.cpu),
      spawns: this.spawns,
      peakRssMb: this.peakRssMb,
      payloadBytes: this.payloadBytes,
      spawnKind: this.spawnKind,
      action: this.action,
      note: this.note,
    };
  }
}

/** Time an async in-process call (parent CPU only). */
async function timeAsync<T>(
  fn: () => Promise<T>,
): Promise<{ wallMs: number; cpuMs: number; value: T }> {
  const cpuStart = process.cpuUsage();
  const startedAt = performance.now();
  const value = await fn();
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  return { wallMs: round1(wallMs), cpuMs: round1((cpu.user + cpu.system) / 1000), value };
}

/** Time a synchronous in-process call. */
function timeSync<T>(fn: () => T): { wallMs: number; cpuMs: number; value: T } {
  const cpuStart = process.cpuUsage();
  const startedAt = performance.now();
  const value = fn();
  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  return { wallMs: round1(wallMs), cpuMs: round1((cpu.user + cpu.system) / 1000), value };
}

/**
 * Build the serialised one-refresh attribution table from measured stages.
 *
 * The live refresh runs its stages CONCURRENTLY (`Promise.all` in
 * `doRefresh`), so the serialised sum is an upper bound used only to rank the
 * drivers — the wall time of each stage is the number to compare with.
 */
export function attributeStages(stages: StageSample[]): {
  serialisedBaselineMs: number;
  rows: StageAttribution[];
} {
  const byStage = new Map(stages.map((stage) => [stage.stage, stage]));
  const rows: StageAttribution[] = [];

  // Derived: everything `wl worklist` does after Node start-up — DB open, the
  // five subset queries, selection, serialisation and stdout write.
  const cold = byStage.get('worklist-cold');
  const startup = byStage.get('cli-startup');
  if (cold && startup) {
    rows.push({
      row: 'worklist payload build (cold spawn minus CLI startup)',
      wallMs: round1(Math.max(0, cold.wallMs - startup.wallMs)),
      cpuMs: round1(Math.max(0, cold.cpuMs - startup.cpuMs)),
      pct: 0,
      action: 'fix-in-scope',
      note: 'DB open + subset queries + browse selection + JSON serialisation inside one `wl worklist` spawn',
    });
  }

  const refreshStages: StageName[] = [
    'worklist-cold',
    'json-parse',
    'children-inprocess-cold',
    'actionable-count',
    'render',
  ];
  const baseline = refreshStages.reduce(
    (total, name) => total + (byStage.get(name)?.wallMs ?? 0),
    0,
  );

  const order: StageName[] = [
    'cli-startup',
    'worklist-cold',
    'worklist-warm',
    'json-parse',
    'sqlite-open',
    'sqlite-full-read',
    'subset-queries',
    'children-inprocess-cold',
    'children-inprocess-warm',
    'children-cli-per-parent',
    'actionable-count',
    'hydrator-dep-list',
    'render',
  ];
  for (const name of order) {
    const stage = byStage.get(name);
    if (!stage) continue;
    rows.push({
      row: stage.label,
      wallMs: stage.wallMs,
      cpuMs: stage.cpuMs,
      pct: baseline > 0 ? Math.round((stage.wallMs / baseline) * 1000) / 10 : 0,
      action: stage.action,
      note: stage.note,
    });
  }
  const derivedRow = rows.find((row) => row.row.startsWith('worklist payload build'));
  if (derivedRow && baseline > 0) {
    derivedRow.pct = Math.round((derivedRow.wallMs / baseline) * 1000) / 10;
  }
  return { serialisedBaselineMs: round1(baseline), rows };
}

/**
 * Run the per-stage profile at the requested fixture scale.
 *
 * Every stage is measured on its own so the parent epic can attribute a
 * refresh's cost; the concurrency the live refresh benefits from is therefore
 * deliberately absent here (the F1 harness measures that aggregate).
 */
export async function runStageProfile(
  options: StageProfileOptions = {},
): Promise<StageProfileReport> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const profileName: LargeDbProfileName = options.profile ?? 'default';
  const scale: LargeDbScale = { ...LARGE_DB_PROFILES[profileName], ...options.scale };
  const spawnSamples = Math.max(1, options.samples ?? 3);
  const inProcessSamples = Math.max(1, options.samples ?? 5);
  const invocation = resolveCliInvocation(options.target ?? 'auto', repoRoot);
  const fixture = options.fixture ?? generateLargeWorklog(scale);
  const cacheDir = path.join(fixture.rootDir, 'cache');
  const spawnFile = path.join(fixture.rootDir, 'spawns.log');

  const savedCacheDir = process.env.WL_CACHE_DIR;
  const savedSpawnFile = process.env.WL_SPAWN_COUNT_FILE;

  const stages: StageSample[] = [];

  const startup = new StageCollector(
    'cli-startup',
    'Node + CLI module load (`wl --version`)',
    'no-op',
    'Fixed per-spawn start-up cost: only fewer spawns (F3/F5) reduce the refresh bill.',
  );
  const worklistCold = new StageCollector(
    'worklist-cold',
    '`wl worklist -n 30 --json` cold (read-cache miss)',
    'fix-in-scope',
    'Dominant data-load spawn: DB open + full-table read + serialisation of every mandatory subset.',
  );
  const worklistWarm = new StageCollector(
    'worklist-warm',
    '`wl worklist -n 30 --json` warm (read-cache hit)',
    'no-op',
    'Cache-hit path already skips all DB work; the remaining cost is CLI start-up.',
  );
  const jsonParse = new StageCollector(
    'json-parse',
    'Primary-side payload parse (`JSON.parse` + `extractItems`)',
    'fix-in-scope',
    'Grows with payload size — trimming the payload (F5) removes this too.',
  );
  const sqliteOpen = new StageCollector(
    'sqlite-open',
    'In-process SQLite open (pragma + schema + FTS DDL)',
    'fix-in-scope',
    'Blocking work on the TUI event loop; one open per refresh bounds it (F6).',
  );
  const sqliteFullRead = new StageCollector(
    'sqlite-full-read',
    'In-process full-table read (`db.list({})`, all items materialised)',
    'fix-in-scope',
    'Every in-process reader starts from the whole item table; SQL-side subset queries avoid it (F5/F6).',
  );
  const subsetQueries = new StageCollector(
    'subset-queries',
    'Four default-view subset queries (in-memory cache warm)',
    'no-op',
    'Cheap once the table is materialised; not a driver on its own.',
  );
  const childrenCold = new StageCollector(
    'children-inprocess-cold',
    'Expanded-children read, first use in a fresh refresh scope',
    'fix-in-scope',
    'Pays one open plus the full-table read; the shared refresh scope already amortises it (F4/F6).',
  );
  const childrenWarm = new StageCollector(
    'children-inprocess-warm',
    'Expanded-children read, same scope (in-memory cache)',
    'no-op',
    'Confirms the shared scope turns repeat reads into in-memory work.',
  );
  const childrenCli = new StageCollector(
    'children-cli-per-parent',
    '`wl list --parent <id>` spawn (per expanded parent, fallback path)',
    'fix-in-scope',
    'Per-parent spawns are what the in-process batch read replaced; multiply by expanded parents (F4).',
  );
  const actionableCount = new StageCollector(
    'actionable-count',
    'Actionable count (in-process, same refresh scope)',
    'no-op',
    'Cheap in-process count; not a driver.',
  );
  const hydratorDepList = new StageCollector(
    'hydrator-dep-list',
    '`wl dep list <id>` spawn (hydrator, per candidate)',
    'fix-in-scope',
    'One spawn per pending-claim candidate per hydrate tick; a batched in-process outbound-dep read removes it (F4).',
  );
  const render = new StageCollector(
    'render',
    'Default-view row build + line formatting',
    'no-op',
    'Bounded by the visible window, not by DB size.',
  );

  try {
    process.env.WL_CACHE_DIR = cacheDir;
    process.env.WL_SPAWN_COUNT_FILE = spawnFile;
    setWorklogDir(fixture.worklogDir);
    setExecFileAsync((async (file: unknown, args: unknown, execOptions: unknown) => {
      const argv = (args as string[]) ?? [];
      void file;
      return runCliTarget(invocation, argv, execOptions);
    }) as Parameters<typeof setExecFileAsync>[0]);

    // ── Spawned stages ────────────────────────────────────────────
    for (let index = 0; index < spawnSamples; index += 1) {
      startup.pushSpawn(await measureSpawn(invocation, ['--version'], spawnFile));
    }

    // Cold: drop the read cache so `wl worklist` performs the real DB work.
    // Warm: the immediately following run is a cache hit — the split shows
    // what the read cache already saves and what it cannot.
    let payloadStdout = '';
    for (let index = 0; index < spawnSamples; index += 1) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      const cold = await measureSpawn(
        invocation,
        ['worklist', '-n', String(scale.browseCount), '--json'],
        spawnFile,
      );
      worklistCold.pushSpawn(cold);
      payloadStdout = cold.stdout;
      worklistWarm.pushSpawn(
        await measureSpawn(
          invocation,
          ['worklist', '-n', String(scale.browseCount), '--json'],
          spawnFile,
        ),
      );
    }

    // ── Primary-side payload parse ────────────────────────────────
    // `extractItems` is the fetcher's own normalisation, so this mirrors the
    // exact work `parseWorklistBundle` does with the payload after
    // `JSON.parse` (each subset is normalised, browse entries unwrapped).
    const parsePayload = (): {
      browse: WorkItem[];
      critical: WorkItem[];
      reviewQueue: WorkItem[];
      inProgressRoots: WorkItem[];
      blockedRoots: WorkItem[];
    } => {
      const payload = JSON.parse(payloadStdout) as {
        subsets?: Record<string, unknown>;
      };
      const subsets = payload.subsets ?? {};
      const list = (key: string): WorkItem[] =>
        Array.isArray(subsets[key]) ? extractItems(subsets[key]) : [];
      const browseRaw = Array.isArray(subsets.browse) ? (subsets.browse as unknown[]) : [];
      return {
        browse: browseRaw.length > 0 ? extractItems({ results: browseRaw }) : [],
        critical: list('critical'),
        reviewQueue: list('reviewQueue'),
        inProgressRoots: list('inProgressRoots'),
        blockedRoots: list('blockedRoots'),
      };
    };
    for (let index = 0; index < inProcessSamples; index += 1) {
      const timing = timeSync(parsePayload);
      jsonParse.pushTiming(timing, Buffer.byteLength(payloadStdout));
    }

    // ── In-process SQLite stages ──────────────────────────────────
    const expandedParentIds = fixture.expandedParentIds.slice(0, scale.expandedParents);
    let childrenByParent = new Map<string, WorkItem[]>();
    for (let index = 0; index < inProcessSamples; index += 1) {
      // Scope A: the open + query costs on their own.
      const queryScope = createInProcessRefreshScope();
      try {
        sqliteOpen.pushTiming(await timeAsync(() => queryScope.read(() => 0)));
        sqliteFullRead.pushTiming(
          await timeAsync(() => queryScope.read((db) => db.list({}).length)),
        );
        subsetQueries.pushTiming(
          await timeAsync(() =>
            queryScope.read((db) => [
              db.list({ priority: 'critical', status: ['open', 'in-progress', 'blocked', 'completed'] })
                .length,
              db.list({ status: ['completed', 'in-progress'], stage: 'in_review', rootOnly: true })
                .length,
              db.list({ status: ['in-progress'], rootOnly: true }).length,
              db.list({ status: ['blocked'], rootOnly: true }).length,
            ]),
          ),
        );
      } finally {
        queryScope.close();
      }

      // Scope B: a real refresh scope — the expanded-children read runs FIRST
      // (as it does when the children read wins the concurrent refresh race),
      // so it pays the open and the table read; the repeats on the same scope
      // show what the shared connection saves.
      const refreshScope = createInProcessRefreshScope();
      try {
        childrenCold.pushTiming(
          await timeAsync(async () => {
            const result = await fetchChildrenForItems(expandedParentIds, undefined, refreshScope);
            childrenByParent = result;
            return result;
          }),
        );
        childrenWarm.pushTiming(
          await timeAsync(() => fetchChildrenForItems(expandedParentIds, undefined, refreshScope)),
        );
        actionableCount.pushTiming(await timeAsync(() => fetchActionableCount(refreshScope)));
      } finally {
        refreshScope.close();
      }
    }

    // ── Per-parent CLI fallback and hydrator spawns ───────────────
    const sampleParent = expandedParentIds[0] ?? fixture.parentIds[0];
    if (sampleParent) {
      for (let index = 0; index < spawnSamples; index += 1) {
        // Clear the read cache first: the per-parent `wl list` fallback runs
        // when the in-process path is unavailable, and a cold read is the
        // worst case it can pay.
        fs.rmSync(cacheDir, { recursive: true, force: true });
        childrenCli.pushSpawn(
          await measureSpawn(invocation, ['list', '--parent', sampleParent, '--json'], spawnFile),
        );
        hydratorDepList.pushSpawn(
          await measureSpawn(invocation, ['dep', 'list', sampleParent, '--json'], spawnFile),
        );
      }
    }

    // ── Render ────────────────────────────────────────────────────
    const parsedPayload = parsePayload();
    const payloadItems =
      parsedPayload.browse.length +
      parsedPayload.critical.length +
      parsedPayload.reviewQueue.length +
      parsedPayload.inProgressRoots.length +
      parsedPayload.blockedRoots.length;
    // The default view shows the browse window plus the mandatory subsets, in
    // the display shape `formatItemLine` consumes.
    const displayItems = parsedPayload.browse.slice(0, Math.max(scale.browseCount, 1));
    for (let index = 0; index < inProcessSamples; index += 1) {
      render.pushTiming(
        timeSync(() => {
          const state = new WorkItemListState(displayItems, { rows: 45, cols: 160 });
          for (const [parentId, children] of childrenByParent) {
            state.attachChildren(parentId, children);
            state.toggleExpand(parentId);
          }
          const rows = state.getDisplayRows();
          let collected = 0;
          for (const row of rows) {
            if (row.kind !== 'item') continue;
            collected += formatItemLine(row.item, 160, false, false).length;
          }
          return { rows: rows.length, chars: collected };
        }),
      );
    }

    stages.push(
      startup.sample(),
      worklistCold.sample(),
      worklistWarm.sample(),
      jsonParse.sample(),
      sqliteOpen.sample(),
      sqliteFullRead.sample(),
      subsetQueries.sample(),
      childrenCold.sample(),
      childrenWarm.sample(),
      childrenCli.sample(),
      actionableCount.sample(),
      hydratorDepList.sample(),
      render.sample(),
    );

    // ── RSS breakdown of the `wl worklist` spawn ──────────────────
    // Peak RSS of the full worklist spawn decomposed by what each stage has
    // to hold in memory: Node + CLI modules (`--version`), one item read
    // (`show`), and the full materialisation + payload. The in-process heap
    // deltas attribute the materialisation term to the plugin's own reads.
    const startupRss = startup.sample().peakRssMb;
    const worklistRss = worklistCold.sample().peakRssMb;
    let singleItemRss: number | null = null;
    let heapBaselineMb = 0;
    let heapAfterFullReadMb = 0;
    let heapAfterParseMb = 0;
    if (sampleParent) {
      const showSample = await measureSpawn(
        invocation,
        ['show', sampleParent, '--json'],
        spawnFile,
      );
      singleItemRss = showSample.peakRssMb;
    }
    {
      const heapMb = (): number => Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10;
      heapBaselineMb = heapMb();
      const scope = createInProcessRefreshScope();
      try {
        await scope.read((db) => {
          db.list({});
          heapAfterFullReadMb = heapMb();
          return 0;
        });
      } finally {
        scope.close();
      }
      // The parent pays the payload twice: the 3.1 MB stdout buffer from
      // `execFile` and the parsed object graph. Measured on the REAL captured
      // payload so the term is not a synthetic slice.
      const parsed = JSON.parse(payloadStdout);
      heapAfterParseMb = heapMb();
      void parsed;
    }

    const heapMaterialisationMb = Math.round((heapAfterFullReadMb - heapBaselineMb) * 10) / 10;
    const heapParseMb = Math.round((heapAfterParseMb - heapAfterFullReadMb) * 10) / 10;
    const payloadBytesForRss = worklistCold.sample().payloadBytes ?? 0;
    const payloadMb = Math.round((payloadBytesForRss / 1048576) * 10) / 10;

    const rssRows: RssBreakdownRow[] = [
      {
        component: 'Node + CLI module graph (`wl --version`)',
        peakRssMb: startupRss ?? 0,
        deltaMb: null,
        note: 'Fixed start-up floor every spawn pays before any worklog data is touched.',
      },
      {
        component: 'SQLite open + single-item read (`wl show <id>`)',
        peakRssMb: singleItemRss ?? 0,
        deltaMb:
          startupRss !== null && singleItemRss !== null
            ? round1(singleItemRss - startupRss)
            : null,
        note: 'Store open, pragmas, schema/FTS DDL and one item (small payload).',
      },
      {
        component: 'Whole-item-table materialisation (in-process `db.list({})`)',
        peakRssMb: worklistRss ?? 0,
        deltaMb: heapMaterialisationMb,
        note:
          `v8 heap for every item (+${heapMaterialisationMb} MB). The rest of the ` +
          `+${singleItemRss !== null && worklistRss !== null ? round1(worklistRss - singleItemRss) : 0} MB ` +
          'growth from the single-item read to the full worklist spawn is SQLite page cache, the ' +
          'serialised payload string and V8 heap growth.',
      },
      {
        component: `Serialised payload string (${payloadMb} MB stdout)`,
        peakRssMb: worklistRss ?? 0,
        deltaMb: payloadMb,
        note:
          'Held by the CLI while serialising and by the parent as the `execFile` stdout buffer ' +
          `(the fetcher caps it at 5 MB, so a ${payloadMb} MB payload is close to that ceiling).`,
      },
      {
        component: 'Parsed payload object graph (parent side)',
        peakRssMb: worklistRss ?? 0,
        deltaMb: heapParseMb,
        note: `What the plugin holds after parsing the real payload (+${heapParseMb} MB heap).`,
      },
    ];

    const payloadBytes = payloadBytesForRss;

    return {
      profile: profileName,
      target: invocation.target,
      invocation: invocation.method,
      node: process.version,
      host: os.hostname(),
      capturedAt: new Date().toISOString(),
      dataset: {
        items: fixture.itemCount,
        descriptionChars: scale.descriptionChars,
        parentGroups: fixture.parentIds.length,
        expandedParents: expandedParentIds.length,
        dependencyEdges: fixture.dependencyEdges,
        dbSizeMb: fixture.dbSizeMb,
        diskSizeMb: fixture.diskSizeMb,
        generationMs: fixture.generationMs,
      },
      stages,
      refreshAttribution: attributeStages(stages),
      payload: {
        bytes: payloadBytes,
        items: payloadItems,
        contract:
          '`wl worklist --json` returns full `WorkItem[]` per subset (see the payload contract in ' +
          '`src/commands/worklist.ts` and `CLI.md`).',
        trimmableWithoutContractChange: false,
        note:
          'The payload cannot be trimmed inside the documented contract: every subset is a full ' +
          'WorkItem[] including `description`. The cheaper levers are not materialising the whole ' +
          'item table (F6) and a documented opt-in field selection (F5 decision, contract change).',
      },
      rss: {
        rows: rssRows,
        worklistSpawnPeakMb: worklistRss,
        startupPeakMb: startupRss,
        singleItemReadPeakMb: singleItemRss,
        payloadBytes,
      },
    };
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

/** Render a {@link StageProfileReport} as a human-readable table. */
export function formatStageProfile(report: StageProfileReport): string {
  const mb = (value: number | null): string => (value === null ? 'n/a' : `${value} MB`);
  const lines = [
    '',
    '================================================',
    '  Herdr large-DB refresh STAGE profile (F2)',
    '================================================',
    '',
    `  profile:   ${report.profile} (${report.target} CLI target)`,
    `  dataset:   ${report.dataset.items} items, ${report.dataset.dbSizeMb} MB db, ` +
      `${report.dataset.expandedParents} expanded parents`,
    `  captured:  ${report.capturedAt} on ${report.host} (${report.node})`,
    '',
    '  stage                                        wall      cpu  spawns    peak RSS  payload',
    '  -------------------------------------------  ------  ------  ------  ----------  --------',
  ];
  for (const stage of report.stages) {
    lines.push(
      `  ${stage.stage.padEnd(28)} ${String(stage.wallMs).padStart(8)} ms ` +
        `${String(stage.cpuMs).padStart(6)} ms ${String(stage.spawns).padStart(6)}  ` +
        `${mb(stage.peakRssMb).padStart(10)}  ${stage.payloadBytes === null ? '-' : `${Math.round(stage.payloadBytes / 1024)} KB`}`,
    );
  }
  lines.push(
    '',
    `  one-refresh serialised baseline: ${report.refreshAttribution.serialisedBaselineMs} ms ` +
      '(upper bound — the live refresh runs these concurrently)',
    '',
  );
  for (const row of report.refreshAttribution.rows) {
    lines.push(
      `  ${String(row.pct).padStart(5)}%  ${row.row} — ${row.action}`,
    );
  }
  lines.push('', '  RSS breakdown (wl worklist spawn):', '');
  for (const row of report.rss.rows) {
    lines.push(
      `  - ${row.component}: ${row.peakRssMb} MB` +
        (row.deltaMb === null ? '' : ` (delta ${row.deltaMb} MB)`),
    );
  }
  lines.push(
    '',
    `  payload: ${Math.round(report.payload.bytes / 1024)} KB / ${report.payload.items} items — ` +
      (report.payload.trimmableWithoutContractChange
        ? 'trimmable within the documented contract'
        : 'NOT trimmable within the documented contract'),
    '',
  );
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────

interface CliOptions extends LargeDbHarnessOptions {
  json: boolean;
  updateBudget: boolean;
  stages: boolean;
  /** F4: measure the single-parent expand + batched hydrator dep reads. */
  expand: boolean;
  /** F3: measure a concurrent refresh while a long sync is in flight. */
  syncInFlight: boolean;
  /** F3: measure a concurrent refresh while the sync holds its locks. */
  lockContention: boolean;
  /** F3: simulated sync duration for `--sync-in-flight` (ms). */
  syncDurationMs?: number;
  /** F5: run the bounded-spawn burst scenario with this many concurrent reads. */
  spawnBurst?: number;
  /**
   * F6: assert the single-cheap-open invariants (≤ 1 in-process open per
   * refresh, open cost inside the documented budget) and exit non-zero on a
   * violation. Used by the on-demand full-scale verification.
   */
  assertOpen: boolean;
  /** F7: aggregate every scenario into the end-to-end parent AC report. */
  acReport: boolean;
}

/** Parse CLI arguments (exported for the contract tests). */
export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    updateBudget: false,
    stages: false,
    expand: false,
    syncInFlight: false,
    lockContention: false,
    assertOpen: false,
    acReport: false,
  };
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
      case '--stages':
        options.stages = true;
        break;
      case '--expand':
        options.expand = true;
        break;
      case '--assert-open':
        options.assertOpen = true;
        break;
      case '--sync-in-flight':
        options.syncInFlight = true;
        break;
      case '--lock-contention':
        options.lockContention = true;
        break;
      case '--ac-report':
        options.acReport = true;
        break;
      case '--spawn-burst': {
        const value = readValue();
        if (value === undefined) {
          throw new Error('--spawn-burst requires a number of concurrent reads (e.g. --spawn-burst 12)');
        }
        if (!Number.isFinite(Number(value)) || Number(value) < 2) {
          throw new Error('--spawn-burst requires an integer ≥ 2');
        }
        options.spawnBurst = Number(value);
        break;
      }
      case '--sync-duration': {
        const value = readValue();
        if (!value || !Number.isFinite(Number(value)) || Number(value) <= 0) {
          throw new Error('--sync-duration requires a positive number of milliseconds');
        }
        options.syncDurationMs = Number(value);
        break;
      }
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

/** p95 of the given samples (0 when empty) — the scenario report summary. */
function p95Of(values: number[]): number {
  return percentile(values, 0.95) ?? 0;
}

/** Render the F3 isolation-scenario report as human-readable text. */
export function formatSyncIsolationReport(
  report: SyncInFlightReport | SyncLockContentionReport,
): string {
  if ('withSync' in report) {
    const inFlight = report as SyncInFlightReport;
    const wallBase = p95Of(inFlight.baseline.map((s) => s.wallMs));
    const wallWith = p95Of(inFlight.withSync.map((s) => s.wallMs));
    const blBase = p95Of(inFlight.baseline.map((s) => s.eventLoopBlockedMs));
    const blWith = p95Of(inFlight.withSync.map((s) => s.eventLoopBlockedMs));
    return [
      '',
      '================================================',
      '  Auto-sync isolation — refresh under a long sync (F3)',
      '================================================',
      '',
      `  profile:                ${inFlight.profile} (${inFlight.target} CLI target)`,
      `  sync in flight:         ${inFlight.syncDurationMs} ms simulated, ` +
        `state ${inFlight.syncStateAtSpawn}, pid ${inFlight.syncPid}`, 
      `  spawn event-loop cost:  ${inFlight.spawnBlockingMs} ms (off-loop check)`,
      `  pane notice in flight:  ${inFlight.noticeWhileInFlight || '(none)'}`,
      '',
      `  refresh wall p95:       baseline ${Math.round(wallBase)} ms -> with sync ${Math.round(wallWith)} ms`,
      `  event-loop blocked p95: baseline ${Math.round(blBase)} ms -> with sync ${Math.round(blWith)} ms`,
      `  spawns per refresh:     baseline ${inFlight.baseline[0]?.spawns ?? '?'} / ` +
        `with sync ${inFlight.withSync[0]?.spawns ?? '?'} (sync adds none)`,
      `  no wait gap:            ${inFlight.noWaitGap} ` +
        `(min sync remaining at refresh end ${inFlight.minRemainingAtEndMs} ms)`,
      `  settled:                ${inFlight.settledState} ` +
        `(last success ${inFlight.lastOutcomeSuccess})`,
      ...describeHostConditions(inFlight.hostConditions),
      '',
    ].join('\n');
  }
  const lock = report as SyncLockContentionReport;
  const wallBase = p95Of(lock.baseline.map((s) => s.wallMs));
  const wallUnder = p95Of(lock.underWriterLock.map((s) => s.wallMs));
  return [
    '',
    '================================================',
    '  Auto-sync isolation — refresh under sync locks (F3 AC3)',
    '================================================',
    '',
    `  profile:                ${lock.profile} (${lock.target} CLI target)`,
    `  sync file lock held:    ${lock.syncFileLockHeld}`,
    `  writer transaction:     ${lock.writerTransactionOpen} (${lock.dbItemCount} items)`,
    `  refresh wall p95:       baseline ${Math.round(wallBase)} ms -> under locks ${Math.round(wallUnder)} ms`,
    ...describeHostConditions(lock.hostConditions),
    '',
  ].join('\n');
}

/** Render the host conditions measured across a scenario window. */
function describeHostConditions(conditions: HostConditions | undefined): string[] {
  if (conditions === undefined) return [];
  const load = conditions.loadPerCore;
  const cpu =
    typeof conditions.cpuPercent === 'number' && Number.isFinite(conditions.cpuPercent)
      ? `${Math.round(conditions.cpuPercent)}% (${conditions.cpuSource})`
      : 'n/a';
  return [
    `  host load/core:         ${load.start.toFixed(2)} -> ${load.max.toFixed(2)} max -> ` +
      `${load.end.toFixed(2)} (${load.samples} samples)`,
    `  host CPU utilisation:   ${cpu}`,
    `  idle-loop canary:       ${conditions.idleNoise.blockedMs} ms / ` +
      `${conditions.idleNoise.durationMs} ms idle window ` +
      `(max stall ${conditions.idleNoise.maxBlockedMs} ms)`,
    `  contended for timing:   ${hostContendedForAbsoluteTiming(conditions)}`,
  ];
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
    `  in-process opens:   ${report.refresh.inProcessOpensPerRefresh} per refresh ` +
      `(open cost p95 ${report.refresh.inProcessOpenMsP95} ms, ` +
      `budget ${IN_PROCESS_OPEN_BUDGET_MS} ms)`,
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

  // `--ac-report` (F7) runs every scenario and aggregates the parent epic's
  // six acceptance criteria into ONE JSON report plus a human summary. This is
  // the full-scale evidence run:
  //   npm run build && npm run test:perf:large -- --ac-report --json --target dist
  if (options.acReport) {
    const report = await runAcReport({
      profile,
      scale: options.scale,
      samples: options.samples,
      writeSamples: options.writeSamples,
      target: options.target,
      keep: options.keep,
      syncDurationMs: options.syncDurationMs,
      burst: options.spawnBurst,
    });
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatAcReport(report)}\n`,
    );
    if (!report.ok) process.exitCode = 1;
    return;
  }

  // F3 isolation scenarios: a concurrent refresh while a long sync is in
  // flight (`--sync-in-flight`) or while it holds its file lock + a writer
  // transaction (`--lock-contention`). Neither mutates the budget file.
  if (options.syncInFlight || options.lockContention) {
    const samples = options.samples ?? (profile === 'full' ? 5 : 3);
    const report = options.lockContention
      ? await runSyncLockContentionScenario({
          profile,
          samples,
          target: options.target,
          keep: options.keep,
        })
      : await runSyncInFlightScenario({
          profile,
          samples,
          target: options.target,
          syncDurationMs: options.syncDurationMs,
          keep: options.keep,
        });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatSyncIsolationReport(report)}\n`,
    );
    return;
  }

  // `--spawn-burst` (F5) measures the bounded `wl` spawn concurrency: a burst
  // of distinct cold single-item reads with the documented cap in effect and
  // an uncapped reference of the same burst. Run at operator scale with:
  //   npx tsx packages/herdr/test/perf/large-db-harness.ts --profile full --spawn-burst 12
  if (options.spawnBurst !== undefined) {
    const report = await runSpawnConcurrencyScenario({
      profile,
      target: options.target,
      burst: options.spawnBurst,
      samples: options.samples,
      keep: options.keep,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatSpawnCapReport(report)}\n`,
    );
    if (!report.ok) process.exitCode = 1;
    return;
  }

  // `--stages` measures each refresh driver on its own (F2) instead of the
  // aggregate refresh budget F1 records.
  if (options.stages) {
    const stageReport = await runStageProfile({
      profile,
      scale: options.scale,
      samples: options.samples,
      target: options.target,
      keep: options.keep,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(stageReport, null, 2)}\n`
        : `${formatStageProfile(stageReport)}\n`,
    );
    return;
  }

  // `--expand` (F4) measures the single-parent expand read and the batched
  // hydrator dependency read: zero spawns on the in-process path plus exact
  // parity with the CLI rows. Run at operator scale with:
  //   npx tsx packages/herdr/test/perf/large-db-harness.ts --profile full --expand
  if (options.expand) {
    const metrics = await runExpandReadProfile({ profile, target: options.target });
    const ok =
      metrics.expandSpawns === 0 &&
      metrics.hydratorDepSpawns === 0 &&
      metrics.childrenMatchCli &&
      metrics.dependencyRowsMatchCli;
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ metrics, ok }, null, 2)}\n`
        : [
            '',
            `  expand / hydrator-dep read profile (${metrics.profile}, ${metrics.datasetItems} items)`,
            `  - single-parent expand: ${metrics.expandSpawns} spawn(s), ${metrics.expandWallMs} ms, ` +
              `${metrics.expandChildren} children, CLI parity: ${metrics.childrenMatchCli ? 'PASS' : 'FAIL'}`,
            `  - hydrator dep read: ${metrics.hydratorDepSpawns} spawn(s), ${metrics.hydratorDepWallMs} ms, ` +
              `${metrics.hydratorDepItems} items, CLI parity: ${metrics.dependencyRowsMatchCli ? 'PASS' : 'FAIL'}`,
            `  zero-spawn + parity: ${ok ? 'PASS' : 'FAIL'}`,
            '',
          ].join('\n'),
    );
    if (!ok) process.exitCode = 1;
    return;
  }

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
  const openViolations = options.assertOpen ? assertOpenBudget(report) : null;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          report,
          evaluation,
          acTargets: withinAcTargets(report, readLargeDbBudget(REPO_ROOT)),
          ...(openViolations === null
            ? {}
            : { openBudget: { ok: openViolations.length === 0, violations: openViolations } }),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${formatReport(report, readLargeDbBudget(REPO_ROOT), evaluation)}\n`);
    if (openViolations !== null) {
      if (openViolations.length === 0) {
        process.stdout.write(
          `  single cheap open:  PASS (≤ 1 in-process open/refresh, open ≤ ${IN_PROCESS_OPEN_BUDGET_MS} ms p95)\n`,
        );
      } else {
        process.stdout.write(`  single cheap open:  FAIL\n`);
        for (const violation of openViolations) {
          process.stdout.write(`    - ${violation}\n`);
        }
      }
    }
  }

  if (!evaluation.ok) process.exitCode = 1;
  if (openViolations !== null && openViolations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`large-db harness failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
