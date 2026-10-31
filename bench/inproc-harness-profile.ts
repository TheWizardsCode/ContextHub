/**
 * In-process CLI harness per-call cost profiler (WL-0MVVXFXM6007QZ2L).
 *
 * Measures ONE `runInProcess()` call (the harness behind `execAsync` in
 * `tests/cli/cli-helpers.ts`) and attributes its wall-clock cost to named
 * phases, so the reuse work in the parent epic (WL-0MVHVZMCH0092JCY) targets
 * the phase that actually dominates instead of guessing.
 *
 * The phase marks come from the opt-in instrumentation in the harness itself
 * (`WL_INPROC_PROFILE=1`, default off). This script switches it on for its own
 * runs only; nothing else in the suite is affected, and with the switch off the
 * harness performs no timing calls at all.
 *
 * Scenarios (one per AC1 case):
 *
 *   - `help`      `wl --help` (no data access)
 *   - `list-json` `wl list --json`
 *   - `create`    `wl create -t <fixture item> --json`
 *   - `status`    `wl status --json`
 *
 * Each scenario reports the **median of >= 3 runs** (default 5) on this host,
 * with the load average recorded alongside the numbers. Every measured run
 * uses a **fresh temporary worklog store**, so `db_open` covers the first-open
 * path — schema creation and migrations — which is the shape of a per-test
 * `beforeEach` fixture. The repository's `.worklog/` is never touched and the
 * temp tree is removed on exit.
 *
 * Usage:
 *   npm run benchmark:inproc-harness                  # text report
 *   npm run benchmark:inproc-harness -- --json        # machine-readable
 *   npm run benchmark:inproc-harness -- --runs 7
 *   npx tsx bench/inproc-harness-profile.ts --no-write --json
 *
 * Options:
 *   --runs N        Measured runs per scenario (default 5, minimum 3).
 *   --no-warmup     Skip the discarded warmup run per scenario.
 *   --scenarios a,b Profile only the named scenarios (help, list-json, create, status).
 *   --store <dir>   Copy this worklog store per run and profile against the copy
 *                   (for a production-sized store; the source is never opened).
 *   --out <path>    Artefact path (default `bench/inproc-harness-profile.json`).
 *   --no-write      Do not write the artefact (stdout only).
 *   --json          Machine-readable output on stdout.
 *   --keep          Keep the temporary stores for inspection.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  clearInprocProfileRecords,
  drainInprocProfileRecords,
  runInProcess,
  type InprocProfilePhase,
  type InprocProfileRecord,
} from '../tests/cli/cli-inproc.js';

// ── Scenarios ────────────────────────────────────────────────────────

/** One profiled invocation. */
export interface InprocProfileScenario {
  /** Stable identifier used in the JSON artefact and the table. */
  name: string;
  /** Human label for the text report. */
  label: string;
  /** CLI argv (the script path and `--worklog-dir` are added by the profiler). */
  argv: string[];
}

/** The four AC1 scenarios, in reporting order. */
export const INPROC_PROFILE_SCENARIOS: readonly InprocProfileScenario[] = Object.freeze([
  Object.freeze({ name: 'help', label: 'wl --help (no data access)', argv: Object.freeze(['--help']) as string[] }),
  Object.freeze({ name: 'list-json', label: 'wl list --json', argv: Object.freeze(['list', '--json']) as string[] }),
  Object.freeze({
    name: 'create',
    label: 'wl create -t <fixture item> --json',
    argv: Object.freeze(['create', '-t', 'In-process profile fixture item', '--json']) as string[],
  }),
  Object.freeze({ name: 'status', label: 'wl status --json', argv: Object.freeze(['status', '--json']) as string[] }),
]);

/**
 * The scenario that represents the parent item's ~196–257 ms path, and whose
 * attribution the published decision-gate verdict is derived from.
 */
export const DECISION_GATE_SCENARIO = 'list-json';

// ── Phase model ──────────────────────────────────────────────────────

/**
 * Phases that are sequential and non-overlapping across the whole call. Their
 * sum is directly comparable with the measured call total.
 */
export const TOP_LEVEL_PHASES = Object.freeze([
  'argv',
  'harness_patch',
  'worklog_dir_override',
  'command_construction',
  'plugin_context',
  'register_commands',
  'command_action',
  'throttler_drain',
  'db_close',
  'harness_restore',
] as const satisfies readonly InprocProfilePhase[]);

/** Phases recorded inside the `command_action` window (never added again). */
export const NESTED_PHASES = Object.freeze([
  'config_load',
  'db_open',
] as const satisfies readonly InprocProfilePhase[]);

/** Buckets the AC asks for, plus the harness bookkeeping split. */
export type AttributionBucket =
  | 'argvAndOverride'
  | 'commanderRegistration'
  | 'pluginContext'
  | 'configLoad'
  | 'dbOpen'
  | 'dbClose'
  | 'commandAction'
  | 'harnessBookkeeping';

/** Every bucket, in table order. */
export const ATTRIBUTION_BUCKETS = Object.freeze([
  'argvAndOverride',
  'commanderRegistration',
  'pluginContext',
  'configLoad',
  'dbOpen',
  'dbClose',
  'commandAction',
  'harnessBookkeeping',
] as const satisfies readonly AttributionBucket[]);

/**
 * Whether a bucket's cost can be removed test-side (harness-side), needs a
 * `src/` change (production startup), or is the command's own work.
 *
 * `commanderRegistration` and `pluginContext` are production *code*, but the
 * harness re-executes what the real CLI does once per process — reusing them
 * across calls is a test-only change, so they are classified harness-side.
 */
export type CostCategory = 'harness-side' | 'production-startup' | 'command-work';

/** Bucket → cost category. */
export const BUCKET_CATEGORY: Readonly<Record<AttributionBucket, CostCategory>> = Object.freeze({
  argvAndOverride: 'harness-side',
  commanderRegistration: 'harness-side',
  pluginContext: 'harness-side',
  harnessBookkeeping: 'harness-side',
  configLoad: 'production-startup',
  dbOpen: 'production-startup',
  dbClose: 'production-startup',
  commandAction: 'command-work',
});

/** Human description of each bucket, used in the text report and the docs. */
export const BUCKET_LABELS: Readonly<Record<AttributionBucket, string>> = Object.freeze({
  argvAndOverride: 'argv split/normalise + --worklog-dir override',
  commanderRegistration: 'Command construction + built-in registration',
  pluginContext: 'createPluginContext',
  configLoad: 'config load (YAML parse, via ctx.utils.getConfig)',
  dbOpen: 'database open incl. schema/migrations',
  dbClose: 'database close',
  commandAction: 'command action (incl. config load + DB open)',
  harnessBookkeeping: 'harness bookkeeping (stream/console patch + restore + throttler drain)',
});

/** A per-phase measurement: total milliseconds and mark count. */
export interface PhaseTotal {
  ms: number;
  count: number;
}

/**
 * Maximum share of a call that may be left unattributed for the attribution to
 * count as reconciled (AC: >= 90 % attributed).
 */
export const MAX_RESIDUAL_SHARE_PCT = 10;

function emptyPhaseTotals(): Record<InprocProfilePhase, PhaseTotal> {
  const totals = {} as Record<InprocProfilePhase, PhaseTotal>;
  for (const phase of [...TOP_LEVEL_PHASES, ...NESTED_PHASES]) {
    totals[phase] = { ms: 0, count: 0 };
  }
  return totals;
}

/** Attribution of one measured call. */
export interface InprocAttribution {
  /** Measured wall time of the whole `runInProcess()` call. */
  totalMs: number;
  /** Milliseconds and mark counts per phase (nested phases included). */
  phases: Record<InprocProfilePhase, PhaseTotal>;
  /** Milliseconds per AC bucket (nested time counted once, in its own bucket). */
  buckets: Record<AttributionBucket, number>;
  /** Sum of the top-level phases. */
  attributedMs: number;
  /** `totalMs - attributedMs`: timers, promise scheduling, GC, clock calls. */
  residualMs: number;
  /** `residualMs` as a percentage of `totalMs`. */
  residualSharePct: number;
  /** True when at least 90 % of the call is attributed. */
  reconciled: boolean;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sharePct(part: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return round((part / total) * 100, 1);
}

/** Attribute one profiler record to phases and AC buckets. */
export function attributeRecord(record: InprocProfileRecord): InprocAttribution {
  const phases = emptyPhaseTotals();
  for (const mark of record.marks) {
    const entry = phases[mark.phase];
    if (!entry) continue;
    entry.ms += mark.ms;
    entry.count += 1;
  }

  const buckets: Record<AttributionBucket, number> = {
    argvAndOverride: phases.argv.ms + phases.worklog_dir_override.ms,
    commanderRegistration: phases.command_construction.ms + phases.register_commands.ms,
    pluginContext: phases.plugin_context.ms,
    configLoad: phases.config_load.ms,
    dbOpen: phases.db_open.ms,
    dbClose: phases.db_close.ms,
    // The action bucket excludes its nested phases so the buckets sum to the
    // top-level attribution instead of double counting config load / DB open.
    commandAction: Math.max(
      0,
      phases.command_action.ms - phases.config_load.ms - phases.db_open.ms,
    ),
    harnessBookkeeping: phases.harness_patch.ms + phases.harness_restore.ms + phases.throttler_drain.ms,
  };

  const attributedMs = TOP_LEVEL_PHASES.reduce((sum, phase) => sum + phases[phase].ms, 0);
  const totalMs = record.totalMs;
  const residualMs = Math.max(0, totalMs - attributedMs);
  const residualShare = sharePct(residualMs, totalMs);

  return {
    totalMs,
    phases,
    buckets,
    attributedMs,
    residualMs,
    residualSharePct: residualShare,
    reconciled: residualShare <= MAX_RESIDUAL_SHARE_PCT,
  };
}

/** Median of a numeric sample (empty → 0). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// ── Dominant phase / decision gate ───────────────────────────────────

/** The dominant bucket of a measured call, with the parent's verdict. */
export interface DominantCostVerdict {
  bucket: AttributionBucket;
  category: CostCategory;
  ms: number;
  sharePct: number;
  /**
   * The parent's binary classification of the *fixable* cost: `harness-side`
   * when the harness-side buckets outweigh production-startup ones, otherwise
   * `production-startup`.
   */
  classification: 'harness-side' | 'production-startup';
  /** One-sentence, quotable verdict naming the dominant phase and its share. */
  verdict: string;
}

/**
 * Classify the cost of one measured call.
 *
 * The dominant bucket is named with its millisecond and percentage share, and
 * the fixable remainder is classified as harness-side or production startup —
 * the decision the parent epic's AC 3 turns on.
 */
export function classifyDominantCost(
  buckets: Readonly<Record<AttributionBucket, number>>,
  totalMs: number,
  scenarioLabel = 'the measured call',
): DominantCostVerdict {
  let dominant: AttributionBucket = ATTRIBUTION_BUCKETS[0];
  for (const bucket of ATTRIBUTION_BUCKETS) {
    if (buckets[bucket] > buckets[dominant]) dominant = bucket;
  }
  const category = BUCKET_CATEGORY[dominant];
  const ms = round(buckets[dominant], 1);
  const share = sharePct(buckets[dominant], totalMs);
  const categoryTotals: Record<CostCategory, number> = { 'harness-side': 0, 'production-startup': 0, 'command-work': 0 };
  for (const bucket of ATTRIBUTION_BUCKETS) categoryTotals[BUCKET_CATEGORY[bucket]] += buckets[bucket];
  const classification: 'harness-side' | 'production-startup' =
    categoryTotals['harness-side'] >= categoryTotals['production-startup'] ? 'harness-side' : 'production-startup';

  const closing =
    category === 'command-work'
      ? // The call is dominated by the command's own production work (what the
        // test asserts). Neither test-side reuse nor a src/ startup change
        // removes it, so name the remainder explicitly instead of implying the
        // dominant phase is fixable.
        'the call is dominated by the command’s own production work (the behaviour the test asserts), ' +
        `so no test-side reuse can remove it — the fixable remainder is ${classification} ` +
        `(harness-side ${round(categoryTotals['harness-side'], 1)} ms, ` +
        `${sharePct(categoryTotals['harness-side'], totalMs)} %; production startup ` +
        `${round(categoryTotals['production-startup'], 1)} ms, ` +
        `${sharePct(categoryTotals['production-startup'], totalMs)} %)`
      : classification === 'harness-side'
        ? 'so the fixable cost is harness-side (removable by reusing state across calls in the test harness)'
        : 'so the fixable cost is production startup (a src/ change, not a test-only fix)';

  return {
    bucket: dominant,
    category,
    ms,
    sharePct: share,
    classification,
    verdict:
      `${scenarioLabel}: dominant phase is ${BUCKET_LABELS[dominant]} — ` +
      `${ms} ms, ${share} % of the ${round(totalMs, 1)} ms call; ${closing}.`,
  };
}

// ── Measurement ──────────────────────────────────────────────────────

/** Median attribution across a scenario's measured runs. */
export interface InprocMedians {
  totalMs: number;
  phases: Record<InprocProfilePhase, number>;
  buckets: Record<AttributionBucket, number>;
  attributedMs: number;
  residualMs: number;
  residualSharePct: number;
}

/** One scenario's measurements. */
export interface InprocScenarioMeasurement {
  name: string;
  label: string;
  /** Exact command line recorded for reproduction (`<store>` = temp worklog). */
  command: string;
  argv: string[];
  /** Measured runs (the median below is taken over these). */
  runs: InprocAttribution[];
  runCount: number;
  median: InprocMedians;
  /** True when the median residual is within `MAX_RESIDUAL_SHARE_PCT`. */
  reconciled: boolean;
  /** Worst per-run residual share, reported for transparency. */
  worstResidualSharePct: number;
  dominant: DominantCostVerdict;
  /** Milliseconds per cost category (sum of the median buckets). */
  categoryMs: Record<CostCategory, number>;
  /** Percent of the median call per cost category. */
  categorySharePct: Record<CostCategory, number>;
}

/** The profiler's decision-gate answer for the ~196–257 ms path. */
export interface InprocDecisionGate {
  scenario: string;
  label: string;
  totalMs: number;
  dominantBucket: AttributionBucket;
  dominantCategory: CostCategory;
  dominantMs: number;
  dominantSharePct: number;
  classification: 'harness-side' | 'production-startup';
  harnessSideMs: number;
  harnessSideSharePct: number;
  productionStartupMs: number;
  productionStartupSharePct: number;
  commandWorkMs: number;
  commandWorkSharePct: number;
  verdict: string;
}

/** Host context recorded with the numbers (absolute values are load sensitive). */
export interface InprocProfileHost {
  hostname: string;
  platform: string;
  release: string;
  cpuCount: number;
  cpuModel: string;
  totalMemoryMb: number;
  node: string;
  /** 1/5/15-minute load averages at capture time. */
  loadAverage: number[];
}

/** Full profiling result (also the `--json` payload and the artefact body). */
export interface InprocProfileResult {
  schemaVersion: number;
  workItem: string;
  capturedAt: string;
  host: InprocProfileHost;
  runs: number;
  warmupRuns: number;
  /** How each measured run's worklog store was created. */
  store: string;
  /** `fresh` = throwaway store per run; `copy` = a copy of `--store`. */
  storeRegime: 'fresh' | 'copy';
  /** Source of the profiled store when `storeRegime` is `copy`. */
  sourceStore: string | null;
  /** The exact invocation that produced the numbers. */
  invocation: string;
  repoRoot: string;
  /**
   * Wall time of the whole process, measured from process start to the end of
   * the run (proves the < 60 s bound). Most of it is the one-off tsx compile of
   * the CLI import graph, exactly as a suite worker pays it once.
   */
  processWallMs: number;
  /** Wall time of the measurement section only (excludes process/tsx start-up). */
  profilingWallMs: number;
  /**
   * The first in-process call in this process: it additionally pays the module
   * graph and JIT warm-up, so it is recorded separately instead of being
   * averaged into the warm per-call numbers.
   */
  coldStart: InprocColdStart | null;
  scenarios: InprocScenarioMeasurement[];
  decisionGate: InprocDecisionGate;
}

/** The first, cold in-process call of the profiling process. */
export interface InprocColdStart {
  scenario: string;
  label: string;
  totalMs: number;
  buckets: Record<AttributionBucket, number>;
  /** Share of the cold call per AC bucket. */
  sharePct: Record<AttributionBucket, number>;
  note: string;
}

/** Options for {@link runInprocHarnessProfile}. */
export interface InprocProfileOptions {
  repoRoot?: string;
  /** Measured runs per scenario (minimum 3 — the AC requires a median of >= 3). */
  runs?: number;
  /** Discarded warmup runs per scenario (default 1). */
  warmupRuns?: number;
  /** Keep the temporary stores (default false). */
  keep?: boolean;
  /** Scenarios to measure (default {@link INPROC_PROFILE_SCENARIOS}). */
  scenarios?: readonly InprocProfileScenario[];
  /**
   * Optional existing worklog store to profile against. It is **copied** into
   * the temporary tree for every measured run and never opened in place, so a
   * production-sized store (e.g. the repository's own `.worklog`) can be
   * measured without risk to it.
   */
  store?: string;
}

/** Repository root of this checkout (`bench/` lives directly under it). */
export function defaultRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Artefact path relative to the repository root. */
export const PROFILE_ARTEFACT_RELATIVE_PATH = 'bench/inproc-harness-profile.json';

/** Minimum measured runs per scenario (median of >= 3 is an AC). */
export const MIN_RUNS = 3;

/**
 * Create a throwaway worklog store: the two files every `wl` command needs to
 * run unattended. A fresh store per run makes `db_open` include schema
 * creation and migrations, matching a per-test `beforeEach` fixture.
 */
function createFixtureStore(root: string, version: string): string {
  const worklogDir = path.join(root, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });
  fs.writeFileSync(
    path.join(worklogDir, 'initialized'),
    JSON.stringify({ version, initializedAt: new Date().toISOString() }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(worklogDir, 'config.yaml'),
    [
      'projectName: In-process Harness Profile',
      'prefix: IPP',
      'statuses:',
      '  - value: open',
      '    label: Open',
      '  - value: in-progress',
      '    label: In Progress',
      '  - value: blocked',
      '    label: Blocked',
      '  - value: completed',
      '    label: Completed',
      '  - value: deleted',
      '    label: Deleted',
      'stages:',
      '  - value: ""',
      '    label: Undefined',
      '  - value: in_progress',
      '    label: In Progress',
      '  - value: in_review',
      '    label: In Review',
      '',
    ].join('\n'),
    'utf-8',
  );
  return worklogDir;
}

/**
 * Read the CLI's own version so the fixture's `initialized` marker matches it
 * (a version mismatch would add upgrade-notice work that the profile should
 * not charge to the harness).
 */
function resolveCliVersion(repoRoot: string): string {
  try {
    const versionFile = path.join(repoRoot, 'src', 'version.ts');
    const contents = fs.readFileSync(versionFile, 'utf-8');
    const match = /WORKLOG_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(contents);
    if (match) return match[1];
  } catch {
    // Fall through to the package version.
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    // Fall through to the placeholder.
  }
  return '0.0.0-benchmark';
}

function hostContext(): InprocProfileHost {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    node: process.version,
    loadAverage: os.loadavg().map((value) => round(value, 2)),
  };
}

function commandLineFor(scenario: InprocProfileScenario, worklogDir: string): string {
  return ['node', 'src/cli.ts', '--worklog-dir', worklogDir, ...scenario.argv].join(' ');
}

/** Files that make up a worklog store (everything else in `.worklog/` is not). */
export const STORE_FILES = Object.freeze([
  'worklog.db',
  'worklog.db-wal',
  'worklog.db-shm',
  'config.yaml',
  'config.defaults.yaml',
  'initialized',
]);

/** Run one scenario once against a fresh store and return its attribution. */
async function measureOnce(
  scenario: InprocProfileScenario,
  storeRoot: string,
  version: string,
  sourceStore: string | null,
): Promise<InprocAttribution> {
  let worklogDir: string;
  if (sourceStore) {
    // Copy the store's own files per run: the original is only ever read, each
    // run starts from an identical store (important for the write scenarios),
    // and the rest of the source directory (backups/, cache/, worktrees/) is
    // never copied — a `.worklog/` tree can contain linked worktrees.
    worklogDir = path.join(storeRoot, '.worklog');
    fs.mkdirSync(worklogDir, { recursive: true });
    for (const file of STORE_FILES) {
      const from = path.join(sourceStore, file);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(worklogDir, file));
    }
    if (!fs.existsSync(path.join(worklogDir, 'worklog.db')) && !fs.existsSync(path.join(worklogDir, 'config.yaml'))) {
      throw new Error(
        `in-process profile: ${sourceStore} does not look like a worklog store ` +
          `(expected worklog.db or config.yaml; looked for ${STORE_FILES.join(', ')})`,
      );
    }
  } else {
    worklogDir = createFixtureStore(storeRoot, version);
  }
  process.chdir(storeRoot);
  const command = commandLineFor(scenario, worklogDir);
  clearInprocProfileRecords();
  const result = await runInProcess(command, 30_000);
  const records = drainInprocProfileRecords();
  const record = records[records.length - 1];
  if (!record) {
    throw new Error(
      `in-process profile: no profile record was produced for \`${command}\` — is WL_INPROC_PROFILE set?`,
    );
  }
  if (result.exitCode !== 0 && result.exitCode !== null) {
    throw new Error(
      `in-process profile: \`${command}\` exited ${result.exitCode}:\n` +
        `${result.stderr.slice(0, 2000)}`,
    );
  }
  return attributeRecord(record);
}

function roundBuckets(
  buckets: Readonly<Record<AttributionBucket, number>>,
): Record<AttributionBucket, number> {
  const rounded = {} as Record<AttributionBucket, number>;
  for (const bucket of ATTRIBUTION_BUCKETS) rounded[bucket] = round(buckets[bucket]);
  return rounded;
}

/** Record shares for a bucket map (used by the cold-start entry). */
function bucketShares(
  buckets: Readonly<Record<AttributionBucket, number>>,
  totalMs: number,
): Record<AttributionBucket, number> {
  const shares = {} as Record<AttributionBucket, number>;
  for (const bucket of ATTRIBUTION_BUCKETS) shares[bucket] = sharePct(buckets[bucket], totalMs);
  return shares;
}

function medianAttribution(runs: InprocAttribution[]): InprocMedians {
  const phases = {} as Record<InprocProfilePhase, number>;
  for (const phase of [...TOP_LEVEL_PHASES, ...NESTED_PHASES]) {
    phases[phase] = round(median(runs.map((run) => run.phases[phase].ms)));
  }
  const buckets = {} as Record<AttributionBucket, number>;
  for (const bucket of ATTRIBUTION_BUCKETS) {
    buckets[bucket] = round(median(runs.map((run) => run.buckets[bucket])));
  }
  const totalMs = round(median(runs.map((run) => run.totalMs)));
  const attributedMs = round(median(runs.map((run) => run.attributedMs)));
  const residualMs = Math.max(0, round(totalMs - attributedMs));
  return {
    totalMs,
    phases,
    buckets,
    attributedMs,
    residualMs,
    residualSharePct: sharePct(residualMs, totalMs),
  };
}

function categoryTotals(buckets: Readonly<Record<AttributionBucket, number>>): Record<CostCategory, number> {
  const totals: Record<CostCategory, number> = { 'harness-side': 0, 'production-startup': 0, 'command-work': 0 };
  for (const bucket of ATTRIBUTION_BUCKETS) totals[BUCKET_CATEGORY[bucket]] += buckets[bucket];
  return totals;
}

/**
 * Profile every scenario and return the attributed medians.
 *
 * The harness instrumentation is switched on for the duration of the run and
 * the previous environment/cwd is restored afterwards, so an embedding test
 * observes no leaked state.
 */
export async function runInprocHarnessProfile(options: InprocProfileOptions = {}): Promise<InprocProfileResult> {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot());
  const runs = Math.max(MIN_RUNS, options.runs ?? 5);
  const warmupRuns = Math.max(0, options.warmupRuns ?? 1);
  const scenarios = options.scenarios ?? INPROC_PROFILE_SCENARIOS;
  const version = resolveCliVersion(repoRoot);
  const sourceStore = options.store ? path.resolve(options.store) : null;
  if (sourceStore && !fs.existsSync(sourceStore)) {
    throw new Error(`in-process profile: --store ${sourceStore} does not exist`);
  }
  const profileStartedAt = performance.now();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-inproc-profile-'));
  const previousCwd = process.cwd();
  const previousProfile = process.env.WL_INPROC_PROFILE;
  const previousCacheDir = process.env.WL_CACHE_DIR;
  process.env.WL_INPROC_PROFILE = '1';
  process.env.WL_CACHE_DIR = path.join(tempRoot, 'cache');

  try {
    // The first call in this process pays module-graph + JIT warm-up on top of
    // the per-call work, so it is recorded separately rather than averaged in.
    const coldScenario = scenarios[0];
    const coldAttribution = await measureOnce(
      coldScenario,
      path.join(tempRoot, 'cold-start'),
      version,
      sourceStore,
    );
    const coldStart: InprocColdStart = {
      scenario: coldScenario.name,
      label: coldScenario.label,
      totalMs: round(coldAttribution.totalMs),
      buckets: roundBuckets(coldAttribution.buckets),
      sharePct: bucketShares(coldAttribution.buckets, coldAttribution.totalMs),
      note:
        'first in-process call in this process: also pays module-graph and JIT warm-up; ' +
        'warm per-call numbers exclude it',
    };

    const measurements: InprocScenarioMeasurement[] = [];
    for (const scenario of scenarios) {
      const scenarioRoot = path.join(tempRoot, scenario.name);
      for (let warmup = 0; warmup < warmupRuns; warmup += 1) {
        await measureOnce(scenario, path.join(scenarioRoot, `warmup-${warmup + 1}`), version, sourceStore);
      }
      const measured: InprocAttribution[] = [];
      for (let run = 1; run <= runs; run += 1) {
        measured.push(await measureOnce(scenario, path.join(scenarioRoot, `run-${run}`), version, sourceStore));
      }
      const medians = medianAttribution(measured);
      const categories = categoryTotals(medians.buckets);
      measurements.push({
        name: scenario.name,
        label: scenario.label,
        command: commandLineFor(scenario, `<temp-store>/.worklog`),
        argv: [...scenario.argv],
        runs: measured,
        runCount: measured.length,
        median: medians,
        reconciled: medians.residualSharePct <= MAX_RESIDUAL_SHARE_PCT,
        worstResidualSharePct: Math.max(...measured.map((run) => run.residualSharePct)),
        dominant: classifyDominantCost(medians.buckets, medians.totalMs, scenario.label),
        categoryMs: {
          'harness-side': round(categories['harness-side']),
          'production-startup': round(categories['production-startup']),
          'command-work': round(categories['command-work']),
        },
        categorySharePct: {
          'harness-side': sharePct(categories['harness-side'], medians.totalMs),
          'production-startup': sharePct(categories['production-startup'], medians.totalMs),
          'command-work': sharePct(categories['command-work'], medians.totalMs),
        },
      });
    }

    const gateMeasurement =
      measurements.find((measurement) => measurement.name === DECISION_GATE_SCENARIO) ?? measurements[0];
    const gateCategories = categoryTotals(gateMeasurement.median.buckets);
    const decisionGate: InprocDecisionGate = {
      scenario: gateMeasurement.name,
      label: gateMeasurement.label,
      totalMs: gateMeasurement.median.totalMs,
      dominantBucket: gateMeasurement.dominant.bucket,
      dominantCategory: gateMeasurement.dominant.category,
      dominantMs: gateMeasurement.dominant.ms,
      dominantSharePct: gateMeasurement.dominant.sharePct,
      classification: gateMeasurement.dominant.classification,
      harnessSideMs: round(gateCategories['harness-side']),
      harnessSideSharePct: sharePct(gateCategories['harness-side'], gateMeasurement.median.totalMs),
      productionStartupMs: round(gateCategories['production-startup']),
      productionStartupSharePct: sharePct(gateCategories['production-startup'], gateMeasurement.median.totalMs),
      commandWorkMs: round(gateCategories['command-work']),
      commandWorkSharePct: sharePct(gateCategories['command-work'], gateMeasurement.median.totalMs),
      verdict: gateMeasurement.dominant.verdict,
    };

    return {
      schemaVersion: 1,
      workItem: 'WL-0MVVXFXM6007QZ2L',
      capturedAt: new Date().toISOString(),
      host: hostContext(),
      runs,
      warmupRuns,
      store: sourceStore
        ? 'copy of the given store per measured run (the source store is never opened)'
        : 'fresh temporary worklog store per measured run (first-open schema + migrations included)',
      storeRegime: sourceStore ? 'copy' : 'fresh',
      sourceStore,
      invocation:
        `npx tsx bench/inproc-harness-profile.ts --runs ${runs}` +
        (sourceStore ? ' --store <copied store>' : ''),
      repoRoot,
      processWallMs: round(performance.now(), 1),
      profilingWallMs: round(performance.now() - profileStartedAt, 1),
      coldStart,
      scenarios: measurements,
      decisionGate,
    };
  } finally {
    process.chdir(previousCwd);
    if (previousProfile === undefined) delete process.env.WL_INPROC_PROFILE;
    else process.env.WL_INPROC_PROFILE = previousProfile;
    if (previousCacheDir === undefined) delete process.env.WL_CACHE_DIR;
    else process.env.WL_CACHE_DIR = previousCacheDir;
    if (options.keep !== true) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

// ── Reporting ────────────────────────────────────────────────────────

/** Render the attribution table (one row per scenario, one column per bucket). */
export function renderAttributionTable(result: InprocProfileResult): string {
  const header = [
    'scenario'.padEnd(10),
    'total'.padStart(8),
    ...ATTRIBUTION_BUCKETS.map((bucket) => bucket.slice(0, 9).padStart(10)),
    'residual'.padStart(9),
  ].join(' ');
  const rows = result.scenarios.map((scenario) => {
    return [
      scenario.name.padEnd(10),
      scenario.median.totalMs.toFixed(1).padStart(8),
      ...ATTRIBUTION_BUCKETS.map((bucket) => scenario.median.buckets[bucket].toFixed(1).padStart(10)),
      scenario.median.residualMs.toFixed(1).padStart(9),
    ].join(' ');
  });
  return [header, ...rows].join('\n');
}

/** Render the share table (percent of each call per bucket). */
export function renderShareTable(result: InprocProfileResult): string {
  const header = [
    'scenario'.padEnd(10),
    ...ATTRIBUTION_BUCKETS.map((bucket) => bucket.slice(0, 9).padStart(10)),
    'atomic'.padStart(9),
  ].join(' ');
  const rows = result.scenarios.map((scenario) => {
    return [
      scenario.name.padEnd(10),
      ...ATTRIBUTION_BUCKETS.map((bucket) =>
        sharePct(scenario.median.buckets[bucket], scenario.median.totalMs).toFixed(1).padStart(10),
      ),
      `${(100 - scenario.median.residualSharePct).toFixed(1)} %`.padStart(9),
    ].join(' ');
  });
  return [header, ...rows].join('\n');
}

function renderTextReport(result: InprocProfileResult, artefactPath: string | null, written: boolean): string {
  const lines: string[] = [];
  lines.push('In-process CLI harness per-call cost (WL-0MVVXFXM6007QZ2L)');
  lines.push(`- host: ${result.host.hostname} (${result.host.cpuCount} x ${result.host.cpuModel})`);
  lines.push(`- node: ${result.host.node}  platform: ${result.host.platform} ${result.host.release}`);
  lines.push(
    `- load average (1/5/15 min): ${result.host.loadAverage.map((value) => value.toFixed(2)).join(' / ')}`,
  );
  lines.push(`- runs: ${result.runs} per scenario (median reported), ${result.warmupRuns} discarded warmup run(s)`);
  lines.push(`- store: ${result.store}`);
  lines.push(
    `- profiler wall time: ${result.profilingWallMs} ms of measurement; ` +
      `${result.processWallMs} ms process wall (bound: 60 s)`,
  );
  lines.push(`- invocation: ${result.invocation}`);
  lines.push('');
  if (result.coldStart) {
    lines.push(
      `cold start (${result.coldStart.label}): ${result.coldStart.totalMs} ms ` +
        `(commander registration ${result.coldStart.buckets.commanderRegistration} ms, ` +
        `plugin context ${result.coldStart.buckets.pluginContext} ms, ` +
        `command action ${result.coldStart.buckets.commandAction} ms) — ${result.coldStart.note}`,
    );
    lines.push('');
  }
  lines.push('milliseconds (median per scenario)');
  lines.push(renderAttributionTable(result));
  lines.push('');
  lines.push('share of the call (%)');
  lines.push(renderShareTable(result));
  lines.push('');
  for (const scenario of result.scenarios) {
    lines.push(`- ${scenario.dominant.verdict}`);
    lines.push(
      `    harness-side ${scenario.categoryMs['harness-side']} ms ` +
        `(${scenario.categorySharePct['harness-side']} %), ` +
        `production startup ${scenario.categoryMs['production-startup']} ms ` +
        `(${scenario.categorySharePct['production-startup']} %), ` +
        `command work ${scenario.categoryMs['command-work']} ms ` +
        `(${scenario.categorySharePct['command-work']} %)`,
    );
    lines.push(
      `    residual ${scenario.median.residualMs} ms ` +
        `(${scenario.median.residualSharePct} %, worst run ${scenario.worstResidualSharePct} %) — ` +
        `${scenario.reconciled ? 'reconciled' : 'NOT reconciled'}`,
    );
  }
  lines.push('');
  lines.push(`decision gate (${result.decisionGate.scenario}): ${result.decisionGate.classification}`);
  if (artefactPath) {
    lines.push(`artefact: ${artefactPath}${written ? '' : ' (not written)'}`);
  }
  return lines.join('\n');
}

interface CliOptions extends InprocProfileOptions {
  json: boolean;
  write: boolean;
  out: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    write: true,
    out: PROFILE_ARTEFACT_RELATIVE_PATH,
  };
  const readValue = (index: number): string | undefined => {
    const value = argv[index + 1];
    return !value || value.startsWith('--') ? undefined : value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--runs': {
        const value = readValue(i);
        if (value) options.runs = Number(value);
        break;
      }
      case '--no-warmup':
        options.warmupRuns = 0;
        break;
      case '--store': {
        const value = readValue(i);
        if (value) options.store = value;
        break;
      }
      case '--scenarios': {
        const value = readValue(i);
        if (value) {
          const selected = selectScenarios(value.split(',').map((name) => name.trim()).filter(Boolean));
          options.scenarios = selected;
        }
        break;
      }
      case '--out': {
        const value = readValue(i);
        if (value) options.out = value;
        break;
      }
      case '--no-write':
        options.write = false;
        break;
      case '--json':
        options.json = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      default:
        break;
    }
  }
  return options;
}

/**
 * Resolve a `--scenarios` selection (comma-separated names) against
 * {@link INPROC_PROFILE_SCENARIOS}, preserving the declared order. An unknown
 * name fails loudly with the valid names instead of silently profiling
 * nothing.
 */
export function selectScenarios(names: readonly string[]): readonly InprocProfileScenario[] {
  if (names.length === 0) return INPROC_PROFILE_SCENARIOS;
  const known = new Set(INPROC_PROFILE_SCENARIOS.map((scenario) => scenario.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `in-process profile: unknown scenario(s) ${unknown.join(', ')}; ` +
        `valid names: ${[...known].join(', ')}`,
    );
  }
  return INPROC_PROFILE_SCENARIOS.filter((scenario) => names.includes(scenario.name));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = defaultRepoRoot();
  const result = await runInprocHarnessProfile({ ...options, repoRoot });

  let artefactPath: string | null = null;
  let written = false;
  if (options.write) {
    artefactPath = path.isAbsolute(options.out) ? options.out : path.join(repoRoot, options.out);
    fs.mkdirSync(path.dirname(artefactPath), { recursive: true });
    fs.writeFileSync(artefactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
    written = true;
  }

  if (options.json) {
    console.log(JSON.stringify({ success: true, artefact: artefactPath, written, result }, null, 2));
  } else {
    console.log(renderTextReport(result, artefactPath, written));
  }

  const unreconciled = result.scenarios.filter((scenario) => !scenario.reconciled);
  if (unreconciled.length > 0) {
    console.error(
      `in-process profile: attribution did not reconcile to ${100 - MAX_RESIDUAL_SHARE_PCT} % for ` +
        unreconciled.map((scenario) => `${scenario.name} (${scenario.median.residualSharePct} % residual)`).join(', '),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('in-process harness profile failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
