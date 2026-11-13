/**
 * Leader tick cost benchmark — tier-aware offers (parent WL-0MWDDHQON0015T3P
 * AC10; child WL-0MWDVN3N1004MBA9).
 *
 * The v2 coordination protocol advertises up to THREE nominees per instance
 * (one per dispatch bucket: `implement` / `audit` / `prep`). The leader must
 * re-validate EVERY offered item at dispatch time (`fetchItem` +
 * `classifyItemForDispatch`), so the added leader cost is **one `fetchItem`
 * per offered item per tick** — up to 3× the pre-v2 single-offer cost.
 *
 * This harness measures that cost at a configurable fleet size (default the
 * AC10 seven instances). It drives the production leader entry point
 * (`dispatchFromCoordination`) with a stub `fetchItem` whose latency models a
 * real `wl show` spawn, so the wall-clock tick duration includes the per-offer
 * re-validation. It reports:
 *
 *  - `fetchCalls` — `fetchItem` invocations per tick (the added cost);
 *  - `baselineFetchCalls` — the same fleet with one offer per instance;
 *  - `fetchMultiplier` — `fetchCalls / baselineFetchCalls` (the "up to 3×");
 *  - `logicTickMs` — tick duration with a 0 ms fetch stub (leader overhead);
 *  - `simulatedTickMs` — tick duration with the per-fetch latency applied;
 *  - `pollIntervalMs` — the dispatcher poll interval floor (10 s);
 *  - `withinPollInterval` — whether `simulatedTickMs < pollIntervalMs`
 *    (AC10's merge gate: if the tick exceeds the poll interval, the number of
 *    buckets or the validation order must be revised before merge).
 *
 * The per-fetch latency defaults to a live measurement of `wl show` on this
 * host (median of `--wl-samples` runs); it can be pinned with
 * `--fetch-latency-ms`. Every offer is a non-dispatchable `in_progress` item,
 * so the leader walks the whole offer list (worst-case validation) and never
 * dispatches mid-scan — the cost the benchmark reports is the pure
 * "validate every offer" cost.
 *
 * Usage:
 *
 *   npm run benchmark:leader-tick-cost -- --json
 *   npm run benchmark:leader-tick-cost -- --instances 7 --offers 3 --json
 *   npm run benchmark:leader-tick-cost -- --fetch-latency-ms 200
 *
 * The benchmark is read-only against the real worklog: it sets
 * `HERDR_COORDINATION_DIR` to a temp dir and never touches a live machine
 * coordination file or ledger.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  dispatchFromCoordination,
  type DowntimeItemInfo,
  type DowntimeItemResult,
  type DowntimeWorkerDeps,
} from '../packages/herdr/src/downtime-worker.js';
import {
  writeCoordinationFile,
  type CoordinationEntry,
  type CoordinationOffer,
} from '../packages/herdr/src/coordination.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The poll-interval floor (DOWNTIME_POLL_INTERVAL_FLOOR_MS). Duplicated here
// deliberately: the benchmark must state the budget it measures against
// without importing the whole constants module, and a change to that floor is
// exactly the kind of drift this harness is meant to surface.
const POLL_INTERVAL_FLOOR_MS = 10_000;

interface Options {
  instances: number;
  offers: number;
  runs: number;
  fetchLatencyMs: number | null;
  wlSamples: number;
  wlItem: string | null;
  json: boolean;
}

interface LatencyStats {
  medianMs: number;
  minMs: number;
  maxMs: number;
}

interface TickSample {
  fetchCalls: number;
  durationMs: number;
  reason: string | null;
}

interface Scenario {
  offers: number;
  runs: TickSample[];
  medianMs: number;
  p95Ms: number;
  medianFetchCalls: number;
}

const USAGE = `Usage: tsx bench/leader-tick-cost.ts [options]

  --instances <n>          Fleet size to measure (default 7 — AC10).
  --offers <n>             Offers per instance, 1–3 (default 3).
  --runs <n>               Tick runs per scenario (default 5; median reported).
  --fetch-latency-ms <n>   Pin the stub fetchItem latency. Default: measure a
                           live \`wl show\` on this host (median of --wl-samples).
  --wl-samples <n>         Live \`wl show\` samples used to derive latency (default 5).
  --wl-item <id>           Item id for the live \`wl show\` probe.
  --json                   Emit machine-readable JSON only.
  --help                   Show this message.`;

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    instances: 7,
    offers: 3,
    runs: 5,
    fetchLatencyMs: null,
    wlSamples: 5,
    wlItem: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--instances':
        opts.instances = parsePositiveInt(next(), arg);
        break;
      case '--offers':
        opts.offers = parsePositiveInt(next(), arg);
        if (opts.offers < 1 || opts.offers > 3) {
          throw new Error('--offers must be between 1 and 3 (the v2 bucket bound)');
        }
        break;
      case '--runs':
        opts.runs = parsePositiveInt(next(), arg);
        break;
      case '--fetch-latency-ms':
        opts.fetchLatencyMs = parseNonNegativeInt(next(), arg);
        break;
      case '--wl-samples':
        opts.wlSamples = parsePositiveInt(next(), arg);
        break;
      case '--wl-item':
        opts.wlItem = next();
        break;
      case '--json':
        opts.json = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function parseNonNegativeInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

/** Median of a numeric list (does not mutate the input). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Nearest-rank p95 (small sample sizes). */
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

/**
 * Discover a real item id to probe with `wl show`. Returns null when `wl`
 * cannot run or the store has no item (the caller then falls back).
 */
function discoverWlItemId(): string | null {
  const result = spawnSync('wl', ['next', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { workItem?: { id?: unknown } };
    const id = parsed.workItem?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Measure a live `wl show` spawn (the command the leader's `fetchItem` runs).
 * Returns null when `wl` cannot run (the benchmark then falls back to a
 * zero-latency stub and reports the limitation instead of inventing a number).
 *
 * `wl show` is the representative probe — NOT `wl next`, which does a full
 * ranked selection and would overstate the per-offer re-validation cost.
 */
function measureWlShowLatency(samples: number, item: string | null): LatencyStats | null {
  const probeId = item ?? discoverWlItemId();
  if (probeId === null) return null;
  const args = ['show', probeId, '--json'];
  const durations: number[] = [];
  let anyOk = false;
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    const result = spawnSync('wl', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15_000,
      // The benchmark only needs the wall time; cap the captured output.
      maxBuffer: 8 * 1024 * 1024,
    });
    const elapsed = performance.now() - started;
    if (result.error === undefined && result.status === 0) anyOk = true;
    // A failed probe still costs a spawn; keep it only when nothing succeeded
    // so the measurement reflects a real invocation, not a missing binary.
    durations.push(elapsed);
  }
  if (!anyOk) {
    return null;
  }
  return {
    medianMs: median(durations),
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
  };
}

function itemInfo(id: string): DowntimeItemInfo {
  // Non-dispatchable (`in_progress`): the leader validates then drops each
  // offer, walking the whole list. A dispatchable item would short-circuit at
  // the first offer and understate the full-validation cost.
  return { id, title: `Bench item ${id}`, status: 'in_progress', stage: 'in_progress' };
}

/**
 * Build a deps stub with a `fetchItem` that sleeps `fetchLatencyMs` (simulating
 * the `wl show` spawn) and counts its invocations.
 */
function makeDeps(fetchLatencyMs: number, counter: { fetchCalls: number }): DowntimeWorkerDeps {
  const sleep = (ms: number) =>
    ms > 0 ? new Promise<void>((done) => setTimeout(done, ms)) : Promise.resolve();
  const fetchItem = async (itemId: string, _cwd: string): Promise<DowntimeItemResult> => {
    counter.fetchCalls += 1;
    await sleep(fetchLatencyMs);
    return { ok: true, info: itemInfo(itemId) };
  };
  return {
    getNextItem: async () => ({ ok: true, candidate: null }),
    getNextAuditCandidate: async () => ({ ok: true, candidate: null }),
    getAuditCandidateScope: async () => ({ ok: true, scope: 'parent' }),
    getNextImplementCandidate: async () => null,
    getNextCriticalCandidate: async () => ({ ok: true, candidate: null }),
    getHerdrListHead: async () => ({ ok: true, items: [] }),
    claimItem: async () => ({ ok: true }),
    spawnAgentPane: async () => ({ ok: true }),
    recordDispatch: async () => true,
    recordDispatchFailure: async () => undefined,
    rollbackClaim: async () => true,
    recordError: async () => undefined,
    getDueScheduledPrompt: async () => null,
    recordScheduledPromptTrigger: async () => true,
    readCodeFreezeStatus: () => 'not-frozen',
    fetchItem,
    getActiveAudit: async () => ({ ok: true, active: false }),
    getReviewQueueCount: async () => 0,
    getRunningDowntimePanes: async () => ({ ok: true, count: 0, paneIds: [], records: [] }),
  } as unknown as DowntimeWorkerDeps;
}

const BUCKETS: CoordinationOffer['kind'][] = ['implement', 'audit', 'prep'];

function makeEntries(instances: number, offers: number): CoordinationEntry[] {
  const now = new Date().toISOString();
  return Array.from({ length: instances }, (_, i) => {
    const root = `/bench/worklog-${i}`;
    const offerList: CoordinationOffer[] = BUCKETS.slice(0, offers).map((kind) => ({
      kind,
      workItemId: `WL-BENCH${i}${kind.toUpperCase()}`,
    }));
    return {
      instanceId: `bench-instance-${i}`,
      workItemId: offerList[0].workItemId,
      directory: root,
      worklogRoot: root,
      assignedAt: now,
      lastUpdated: now,
      offers: offerList,
    };
  });
}

/** Seed a temp coordination dir with the benchmark's entries. */
function seedCoordinationFile(dir: string, entries: CoordinationEntry[]): void {
  writeCoordinationFile(dir, { version: 2, entries });
}

/**
 * Run one leader tick against a fresh copy of `entries`. The leader mutates its
 * input (round-robin splice) and removes offers from the coordination file on
 * the in-memory array, so each run gets its own temp dir and a deep copy.
 */
async function runTick(
  coordinationDir: string,
  entries: CoordinationEntry[],
  fetchLatencyMs: number,
): Promise<TickSample> {
  const counter = { fetchCalls: 0 };
  const deps = makeDeps(fetchLatencyMs, counter);
  const copy: CoordinationEntry[] = structuredClone(entries);
  seedCoordinationFile(coordinationDir, copy);
  const started = performance.now();
  const outcome = await dispatchFromCoordination(deps, copy, {
    model: 'bench',
    cwd: '/bench/leader-root',
    coordinationDir,
    // Whole-tick budget permissive so a gate never short-circuits the fetch
    // walk: the benchmark measures validation cost, not admission.
    freeSlots: 8,
    effectiveFreeSlots: 8,
    stallScanEnabled: false,
  });
  const durationMs = performance.now() - started;
  return {
    fetchCalls: counter.fetchCalls,
    durationMs,
    reason: outcome.dispatched ? 'dispatched' : outcome.reason ?? null,
  };
}

async function measureScenario(
  opts: Options,
  offers: number,
  fetchLatencyMs: number,
): Promise<Scenario> {
  const runs: TickSample[] = [];
  // A temp base dir per scenario keeps the coordination cursor/file isolated
  // and lets each run start from the same seeded state.
  for (let r = 0; r < opts.runs; r += 1) {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-leader-tick-bench-'));
    const previous = process.env.HERDR_COORDINATION_DIR;
    process.env.HERDR_COORDINATION_DIR = dir;
    try {
      const entries = makeEntries(opts.instances, offers);
      runs.push(await runTick(dir, entries, fetchLatencyMs));
    } finally {
      if (previous === undefined) delete process.env.HERDR_COORDINATION_DIR;
      else process.env.HERDR_COORDINATION_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    offers,
    runs,
    medianMs: median(runs.map((r) => r.durationMs)),
    p95Ms: p95(runs.map((r) => r.durationMs)),
    medianFetchCalls: median(runs.map((r) => r.fetchCalls)),
  };
}

function formatMs(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

async function main(): Promise<void> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exit(2);
    return;
  }

  // Derive the per-fetch latency: explicit pin > live `wl show` median > 0 ms
  // stub (clearly reported so a zero-latency figure is never mistaken for an
  // end-to-end one).
  let measuredWlShow: LatencyStats | null = null;
  let fetchLatencyMs: number;
  let latencySource: 'flag' | 'measured' | 'fallback';
  if (opts.fetchLatencyMs !== null) {
    fetchLatencyMs = opts.fetchLatencyMs;
    latencySource = 'flag';
  } else {
    measuredWlShow = measureWlShowLatency(opts.wlSamples, opts.wlItem);
    if (measuredWlShow !== null) {
      fetchLatencyMs = Math.round(measuredWlShow.medianMs);
      latencySource = 'measured';
    } else {
      fetchLatencyMs = 0;
      latencySource = 'fallback';
    }
  }

  // Logic-only scenario (0 ms fetch) isolates leader overhead from the cost of
  // the fetch spawns; the simulated scenario applies the real per-fetch latency.
  const baseline = await measureScenario(opts, 1, fetchLatencyMs);
  const full = await measureScenario(opts, opts.offers, fetchLatencyMs);
  const logicOnly = await measureScenario(opts, opts.offers, 0);

  const fetchMultiplier = full.medianFetchCalls / Math.max(1, baseline.medianFetchCalls);
  const withinPollInterval = full.medianMs < POLL_INTERVAL_FLOOR_MS;
  // The per-fetch latency at which the full tick would consume the whole poll
  // interval — the AC10 revision trigger. Above this, buckets/order must
  // change before merge; the margin below is how far the measured host is
  // from it.
  const breakEvenFetchLatencyMs =
    full.medianFetchCalls > 0 ? POLL_INTERVAL_FLOOR_MS / full.medianFetchCalls : null;

  const report = {
    instances: opts.instances,
    offersPerInstance: opts.offers,
    runs: opts.runs,
    fetchLatencyMs,
    fetchLatencySource: latencySource,
    measuredWlShowMedianMs: measuredWlShow?.medianMs ?? null,
    measuredWlShowMinMs: measuredWlShow?.minMs ?? null,
    measuredWlShowMaxMs: measuredWlShow?.maxMs ?? null,
    pollIntervalMs: POLL_INTERVAL_FLOOR_MS,
    full: {
      fetchCalls: full.medianFetchCalls,
      tickMs: full.medianMs,
      tickP95Ms: full.p95Ms,
      outcome: full.runs[0]?.reason ?? null,
    },
    baseline: {
      offersPerInstance: 1,
      fetchCalls: baseline.medianFetchCalls,
      tickMs: baseline.medianMs,
      tickP95Ms: baseline.p95Ms,
    },
    logicOnly: {
      fetchCalls: logicOnly.medianFetchCalls,
      tickMs: logicOnly.medianMs,
      tickP95Ms: logicOnly.p95Ms,
    },
    fetchMultiplier,
    headroomMs: POLL_INTERVAL_FLOOR_MS - full.medianMs,
    breakEvenFetchLatencyMs,
    withinPollInterval,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('');
  console.log(`Leader tick cost — ${opts.instances} instances, ${opts.offers} offers/instance`);
  console.log('');
  console.log(
    `  fetchItem per offered item:  ${full.medianFetchCalls} calls ` +
      `(baseline ${baseline.medianFetchCalls}, ${fetchMultiplier.toFixed(2)}×)`,
  );
  console.log(
    `  per-fetch latency:           ${formatMs(fetchLatencyMs)} ` +
      `(${latencySource === 'measured' ? 'measured wl show median' : latencySource === 'flag' ? 'pinned via flag' : 'fallback — live wl unavailable'})`,
  );
  if (measuredWlShow !== null) {
    console.log(
      `  measured wl show range:      ${formatMs(measuredWlShow.minMs)} – ${formatMs(measuredWlShow.maxMs)} ` +
        `(${opts.wlSamples} samples)`,
    );
  }
  console.log(`  logic-only tick:             ${formatMs(logicOnly.medianMs)} (p95 ${formatMs(logicOnly.p95Ms)})`);
  console.log(`  simulated tick:              ${formatMs(full.medianMs)} (p95 ${formatMs(full.p95Ms)})`);
  console.log(`  poll interval floor:         ${formatMs(POLL_INTERVAL_FLOOR_MS)}`);
  console.log(
    `  headroom:                    ${formatMs(POLL_INTERVAL_FLOOR_MS - full.medianMs)} ` +
      `(${((1 - full.medianMs / POLL_INTERVAL_FLOOR_MS) * 100).toFixed(1)}%)`,
  );
  if (breakEvenFetchLatencyMs !== null) {
    console.log(
      `  break-even per-fetch latency: ${formatMs(breakEvenFetchLatencyMs)} ` +
        `(${(breakEvenFetchLatencyMs / Math.max(1, fetchLatencyMs)).toFixed(1)}× the measured fetch)`,
    );
  }
  console.log(`  within poll interval:        ${withinPollInterval ? 'yes' : 'NO — revise buckets/order before merge'}`);
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
