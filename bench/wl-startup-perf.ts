/**
 * Startup import-budget benchmark (F2 — WL-0MVFRRAXD001E7AN).
 *
 * Measures the cost of the `wl` fast path on this host so the parent epic's
 * AC1 (WL-0MVFNMSRW002FI6B: warm cache-hit `wl next --json` /
 * `wl list --status open --json` and `wl --version` at p95 <= 0.5 s wall and
 * peak RSS <= 60 MB) can be quoted, tracked and re-measured after every
 * slimming change (F4/F6/F7).
 *
 * Measurements per invocation:
 *   - wall time, measured around the spawned process;
 *   - CPU time (user+system) and peak RSS, read from the F1 spawn
 *     instrumentation (`WL_SPAWN_COUNT_FILE`, `process.resourceUsage()` in
 *     the child) because those are load-independent on a shared host;
 *   - the spawn-record kind, which proves the sample was a genuine fast-path
 *     invocation (`cache-hit`, or `version` for `--version`).
 *
 * The bare-node floor doubles as the host-load reference: `evaluateStartupBudget`
 * normalises the wall budget by how much slower/faster this run's control
 * measured against the recorded floor, so a saturated host does not flake the
 * ratchet (see `bench/startup-budget.ts`).
 *
 * The read scenarios are warmed until the first cache hit before sampling, so
 * the numbers describe the served-cache fast path rather than a first-query
 * DB read. A bare `node -e` floor is measured with the same method as the
 * reference against which the budget heads.
 *
 * Usage:
 *   npm run benchmark:wl-startup                       # text report
 *   npm run benchmark:wl-startup -- --json             # machine-readable
 *   npm run benchmark:wl-startup -- --target dist --runs 12
 *   npm run benchmark:wl-startup -- --target dist --update-budget
 *
 * Options:
 *   --target src|dist|auto   Invocation target (default `src`; `dist` is what
 *                            /usr/local/bin/wl runs and must be built first).
 *   --runs N                 Measured runs per scenario (default 12, minimum 10).
 *   --warmup N               Maximum warmup attempts per scenario (default 4).
 *   --bare-node-runs N       Bare-node floor samples (default 5).
 *   --worklog-root <dir>     Directory containing `.worklog` to benchmark
 *                            against (default: a throwaway 3-item fixture).
 *   --update-budget          Rewrite bench/startup-import-budget.json with the
 *                            current import graph and these measurements.
 *   --json                   Machine-readable output.
 *   --keep                   Keep the temporary fixture/cache directory.
 *
 * Typical re-run after F7 (quoted in the work item):
 *   npx tsc && npm run benchmark:wl-startup -- --target dist --runs 12 --json
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readSpawnRecords, type SpawnRecord } from '../src/spawn-counter.js';
import {
  walkStaticImportGraph,
  walkFastPathRuntimeGraph,
  CLI_ENTRY,
  type ImportGraph,
} from './startup-import-graph.js';
import {
  BUDGET_RELATIVE_PATH,
  budgetFilePath,
  defaultStartupBudget,
  evaluateStartupBudget,
  readStartupBudget,
  writeStartupBudget,
  type BareNodeFloor,
  type BudgetEvaluation,
  type StartupBaseline,
  type StartupBudget,
} from './startup-budget.js';

/** Invocation targets the harness understands. */
export type StartupTarget = 'src' | 'dist';

/** One scenario the startup budget measures. */
export interface StartupScenario {
  /** Stable budget key (`next-json`, `list-open-json`, `version`). */
  name: string;
  label: string;
  argv: string[];
  /** Spawn-record kind every measured sample must report. */
  expectedKind: string;
}

/** The three AC1 scenarios, in the order they are reported. */
export const STARTUP_SCENARIOS: StartupScenario[] = [
  {
    name: 'next-json',
    label: 'wl next --json (warm cache hit)',
    argv: ['next', '--json'],
    expectedKind: 'cache-hit',
  },
  {
    name: 'list-open-json',
    label: 'wl list --status open --json (warm cache hit)',
    argv: ['list', '--status', 'open', '--json'],
    expectedKind: 'cache-hit',
  },
  {
    name: 'version',
    label: 'wl --version',
    argv: ['--version'],
    expectedKind: 'version',
  },
];

/** One measured sample. */
export interface StartupSample {
  wallMs: number;
  cpuMs: number | null;
  rssMb: number | null;
}

/** Aggregated measurement of one scenario. */
export interface StartupScenarioMeasurement {
  name: string;
  label: string;
  argv: string[];
  expectedKind: string;
  runs: number;
  /** Spawn-record kinds observed across the measured runs. */
  kinds: Record<string, number>;
  p50WallMs: number;
  p95WallMs: number;
  p95CpuMs: number | null;
  p95RssMb: number | null;
  maxRssMb: number | null;
  samples: StartupSample[];
}

/** Full benchmark result (also the `--json` payload basis). */
export interface StartupBenchmarkResult {
  target: StartupTarget;
  entry: string;
  node: string;
  host: string;
  repoRoot: string;
  worklogRoot: string;
  fixture: boolean;
  runs: number;
  capturedAt: string;
  /** Exact invocation used (for reproduction and the budget `method` field). */
  invocation: string;
  scenarios: StartupScenarioMeasurement[];
  bareNode: BareNodeFloor & { runs: number };
  importGraph: ImportGraph;
}

export interface StartupBenchmarkOptions {
  repoRoot?: string;
  target?: 'auto' | 'src' | 'dist';
  runs?: number;
  warmupRuns?: number;
  bareNodeRuns?: number;
  worklogRoot?: string;
  keep?: boolean;
}

/** Repository root of this checkout (bench/ lives directly under it). */
export function defaultRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Sorted-sample percentile; `null` for an empty sample set. */
export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

/**
 * Source files the build regenerates or emits itself, excluded from the
 * freshness comparison.
 *
 * `scripts/generate-version.cjs` rewrites `src/version.ts` *after* tsc, and
 * declaration files are compiler output — comparing against either would make
 * a freshly built `dist/cli.js` look stale.
 */
function isGeneratedSource(fullPath: string): boolean {
  return path.basename(fullPath) === 'version.ts' || fullPath.endsWith('.d.ts');
}

/**
 * Newest modification time under `dir` (recursive), or `null` when absent.
 *
 * An optional `filterFn` can exclude files from the comparison
 * (e.g. generated source files that are rewritten during the build).
 */
function newestMtimeMs(dir: string, filterFn?: (fullPath: string) => boolean): number | null {
  let newest: number | null = null;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (filterFn && !filterFn(full)) continue;
      try {
        const stat = fs.statSync(full);
        if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        // Ignore unreadable entries.
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Is the built `dist/cli.js` at least as new as every file under `src/`?
 *
 * A stale build silently makes the suite test *old* code: `entry-point-split`
 * asserts the `--version` spawn record added to `src/cli.ts`, which a build
 * predating that change does not emit — the test then fails intermittently
 * depending on whether the checkout happens to have been rebuilt. Detecting
 * staleness lets `auto` fall back to `src` instead of asserting against a
 * build that does not reflect the tree. A checkout with no `src/` (e.g. the
 * resolution fixtures) is treated as fresh.
 *
 * Generated sources (`src/version.ts`) are excluded: `generate-version.cjs`
 * rewrites them after tsc, so including them would make *every* fresh build
 * look stale and `auto` would silently stop covering the built `dist/`.
 */
export function isDistFresh(repoRoot: string): boolean {
  const distEntry = path.join(repoRoot, 'dist', 'cli.js');
  let distStat: fs.Stats;
  try {
    distStat = fs.statSync(distEntry);
  } catch {
    return false;
  }
  const srcNewest = newestMtimeMs(path.join(repoRoot, 'src'), (fullPath) => !isGeneratedSource(fullPath));
  if (srcNewest === null) return true;
  return distStat.mtimeMs >= srcNewest;
}

/**
 * Resolve the invocation target: `dist` requires a build (that is what
 * `/usr/local/bin/wl` executes); `auto` prefers a *fresh* built tree and
 * otherwise falls back to `src`.
 */
export function resolveStartupTarget(
  target: 'auto' | 'src' | 'dist',
  repoRoot: string
): StartupTarget {
  const distEntry = path.join(repoRoot, 'dist', 'cli.js');
  if (target === 'dist') {
    if (!fs.existsSync(distEntry)) {
      throw new Error(
        `startup benchmark: ${path.relative(repoRoot, distEntry)} is missing — ` +
          'build the CLI first (`npm run build`, or `npx tsc` for the benchmark only)'
      );
    }
    return 'dist';
  }
  if (target === 'auto') {
    // Only use the build when it is newer than every source file — otherwise
    // the suite would assert against code that no longer exists in `src/`.
    return isDistFresh(repoRoot) ? 'dist' : 'src';
  }
  return 'src';
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
        `startup benchmark: tsx not found walking up from ${startDir} — install dependencies ` +
          'or benchmark the built target with `--target dist`'
      );
    }
    dir = parent;
  }
}

/** The base command (without scenario argv) used to invoke the CLI. */
export function buildStartupInvocation(target: StartupTarget, repoRoot: string): string[] {
  if (target === 'dist') {
    return [process.execPath, path.join(repoRoot, 'dist', 'cli.js')];
  }
  return [process.execPath, resolveTsxBin(repoRoot), path.join(repoRoot, 'src', 'cli.ts')];
}

/** Fixture worklog: the two files every `wl` command needs to run unattended. */
function createFixture(worklogRoot: string): void {
  const worklogDir = path.join(worklogRoot, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });
  fs.writeFileSync(
    path.join(worklogDir, 'initialized'),
    JSON.stringify({ version: '0.0.0-benchmark', initializedAt: new Date().toISOString() }),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(worklogDir, 'config.yaml'),
    'projectName: Startup Budget Benchmark\nprefix: SB\n',
    'utf-8'
  );
}

/** One spawn of the CLI, with its spawn-record file read back. */
interface SingleRun {
  wallMs: number;
  status: number | null;
  stderr: string;
  records: SpawnRecord[];
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Run the CLI once and collect wall time plus the F1 spawn records. */
function runOnce(
  invocation: string[],
  scenarioArgv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  spawnFile: string
): SingleRun {
  fs.rmSync(spawnFile, { force: true });
  const wallStart = performance.now();
  const result = spawnSync(invocation[0], [...invocation.slice(1), ...scenarioArgv], {
    cwd,
    env: { ...env, WL_SPAWN_COUNT_FILE: spawnFile },
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const wallMs = performance.now() - wallStart;
  const records = fs.existsSync(spawnFile) ? readSpawnRecords(spawnFile) : [];
  return { wallMs, status: result.status, stderr: result.stderr ?? '', records };
}

/** Measure one scenario: warm up to the fast path, then sample it. */
function measureScenario(options: {
  scenario: StartupScenario;
  invocation: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnDir: string;
  runs: number;
  warmupRuns: number;
}): StartupScenarioMeasurement {
  const { scenario, invocation, cwd, env, spawnDir, runs, warmupRuns } = options;

  const run = (label: string): SingleRun =>
    runOnce(invocation, scenario.argv, cwd, env, path.join(spawnDir, `spawn-${scenario.name}-${label}.log`));

  const assertOk = (single: SingleRun, phase: string): void => {
    if (single.status !== 0) {
      throw new Error(
        `startup benchmark: \`wl ${scenario.argv.join(' ')}\` failed during ${phase} ` +
          `(exit ${String(single.status)}):\n${single.stderr}`
      );
    }
  };

  // Warmup: `next`'s auto re-sort is a write byproduct that invalidates the
  // cache once, so a scenario may need two warmup runs to reach a cache hit.
  let warmed = false;
  for (let attempt = 1; attempt <= Math.max(1, warmupRuns); attempt += 1) {
    const warm = run(`warmup-${attempt}`);
    assertOk(warm, 'warmup');
    if (warm.records.some((record) => record.kind === scenario.expectedKind)) {
      warmed = true;
      break;
    }
  }

  const kinds: Record<string, number> = {};
  const samples: StartupSample[] = [];
  // The read-cache TTL safety net is 30 s: a slow sample loop (the tsx target
  // takes several seconds per run) can expire the entry mid-measurement. A
  // retried sample is re-warmed and replaces the miss, so every counted
  // sample is a genuine fast-path invocation.
  const maxSampleAttempts = 3;
  for (let i = 1; i <= runs; i += 1) {
    let measured: SingleRun | null = null;
    let matching: SpawnRecord | undefined;
    for (let attempt = 1; attempt <= maxSampleAttempts; attempt += 1) {
      measured = run(`run-${i}-${attempt}`);
      assertOk(measured, 'measurement');
      for (const record of measured.records) {
        kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
      }
      matching = measured.records.find((record) => record.kind === scenario.expectedKind);
      if (matching) break;
    }
    samples.push({
      wallMs: round((measured as SingleRun).wallMs),
      cpuMs: matching?.cpuMs ?? null,
      rssMb: matching?.maxRssKb == null ? null : round(matching.maxRssKb / 1024),
    });
    if (matching) warmed = true;
  }

  if (!warmed) {
    throw new Error(
      `startup benchmark: \`wl ${scenario.argv.join(' ')}\` never produced a ` +
        `'${scenario.expectedKind}' spawn record (observed: ${JSON.stringify(kinds)}) — the ` +
        'measurement would not describe the fast path. Check WL_CACHE_DISABLED / cache state.'
    );
  }

  const wall = samples.map((sample) => sample.wallMs);
  const cpu = samples.map((sample) => sample.cpuMs).filter((v): v is number => v !== null);
  const rss = samples.map((sample) => sample.rssMb).filter((v): v is number => v !== null);

  return {
    name: scenario.name,
    label: scenario.label,
    argv: scenario.argv,
    expectedKind: scenario.expectedKind,
    runs,
    kinds,
    p50WallMs: percentile(wall, 0.5) ?? 0,
    p95WallMs: percentile(wall, 0.95) ?? 0,
    p95CpuMs: percentile(cpu, 0.95),
    p95RssMb: percentile(rss, 0.95),
    maxRssMb: rss.length > 0 ? Math.max(...rss) : null,
    samples,
  };
}

/** Bare-node floor: same measurement method, no application code. */
function measureBareNode(runs: number): BareNodeFloor & { runs: number } {
  const wall: number[] = [];
  const cpu: number[] = [];
  const rss: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const result = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.resourceUsage()))'],
      { encoding: 'utf-8', timeout: 30_000 }
    );
    wall.push(performance.now() - start);
    if (result.status === 0) {
      const usage = JSON.parse(result.stdout) as { userCPUTime: number; systemCPUTime: number; maxRSS: number };
      cpu.push((usage.userCPUTime + usage.systemCPUTime) / 1000);
      rss.push(usage.maxRSS / 1024);
    }
  }
  return {
    runs,
    p95WallMs: percentile(wall, 0.95) === null ? 0 : round(percentile(wall, 0.95) as number),
    p95CpuMs: percentile(cpu, 0.95) === null ? null : round(percentile(cpu, 0.95) as number),
    p95RssMb: percentile(rss, 0.95) === null ? null : round(percentile(rss, 0.95) as number),
  };
}

/** Seed the throwaway fixture with a few items so `next` has a work item. */
function seedFixture(invocation: string[], fixtureRoot: string, env: NodeJS.ProcessEnv): void {
  const titles = ['Startup fixture alpha', 'Startup fixture beta', 'Startup fixture gamma'];
  for (const title of titles) {
    const result = spawnSync(invocation[0], [...invocation.slice(1), 'create', '-t', title, '--json'], {
      cwd: fixtureRoot,
      env,
      encoding: 'utf-8',
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(
        `startup benchmark: could not seed the fixture worklog (exit ${String(result.status)}):\n` +
          `${result.stderr ?? ''}`
      );
    }
  }
}

/**
 * Run the startup benchmark and return every measurement.
 *
 * When `worklogRoot` is omitted a throwaway 3-item fixture is created (and
 * removed unless `keep`), so the numbers are deterministic and independent of
 * the operator's live worklog. `WL_CACHE_DIR` always points into that
 * throwaway directory, so the run warms its own cache from scratch.
 */
export function runStartupBenchmark(options: StartupBenchmarkOptions = {}): StartupBenchmarkResult {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot());
  const target = resolveStartupTarget(options.target ?? 'src', repoRoot);
  const runs = Math.max(1, options.runs ?? 12);
  const warmupRuns = Math.max(1, options.warmupRuns ?? 4);
  const bareNodeRuns = Math.max(1, options.bareNodeRuns ?? 5);
  const invocation = buildStartupInvocation(target, repoRoot);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-startup-bench-'));
  const cacheDir = path.join(tempDir, 'cache');
  const spawnDir = path.join(tempDir, 'spawns');
  fs.mkdirSync(spawnDir, { recursive: true });

  const fixtureRoot = path.join(tempDir, 'fixture');
  const fixture = options.worklogRoot === undefined;
  const worklogRoot = path.resolve(options.worklogRoot ?? fixtureRoot);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WL_CACHE_DIR: cacheDir,
    WL_TUI_MODE: '1',
  };
  delete env.WL_CACHE_DISABLED;
  delete env.WL_SPAWN_COUNT;
  delete env.WL_SPAWN_COUNT_FILE;

  try {
    if (fixture) {
      createFixture(worklogRoot);
      seedFixture(invocation, worklogRoot, env);
    }

    const scenarios = STARTUP_SCENARIOS.map((scenario) =>
      measureScenario({
        scenario,
        invocation,
        cwd: worklogRoot,
        env,
        spawnDir,
        runs,
        warmupRuns,
      })
    );

    const importGraph = walkStaticImportGraph({ repoRoot, entry: CLI_ENTRY });

    return {
      target,
      entry: importGraph.entry,
      node: process.version,
      host: os.hostname(),
      repoRoot,
      worklogRoot: fixture ? 'temporary 3-item fixture' : worklogRoot,
      fixture,
      runs,
      capturedAt: new Date().toISOString(),
      invocation: invocation
        .map((part) =>
          part.startsWith(`${repoRoot}${path.sep}`) ? path.relative(repoRoot, part) : part
        )
        .join(' '),
      scenarios,
      bareNode: measureBareNode(bareNodeRuns),
      importGraph,
    };
  } finally {
    if (!fixture || options.keep !== true) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

/** Fold a measurement into the budget (creating the baseline for its target). */
export function applyStartupResultToBudget(
  budget: StartupBudget,
  result: StartupBenchmarkResult
): StartupBudget {
  const scenarios: StartupBaseline['scenarios'] = {};
  for (const scenario of result.scenarios) {
    scenarios[scenario.name] = {
      expectedKind: scenario.expectedKind,
      p50WallMs: round(scenario.p50WallMs),
      p95WallMs: round(scenario.p95WallMs),
      p95CpuMs: scenario.p95CpuMs === null ? null : Math.round(scenario.p95CpuMs),
      p95RssMb: scenario.p95RssMb === null ? null : round(scenario.p95RssMb),
      maxRssMb: scenario.maxRssMb === null ? null : round(scenario.maxRssMb),
    };
  }

  const fastPath = walkFastPathRuntimeGraph({ repoRoot: result.repoRoot, entry: CLI_ENTRY });

  return {
    ...budget,
    entry: result.entry,
    importGraph: {
      moduleCount: result.importGraph.modules.length,
      modules: result.importGraph.modules,
      external: result.importGraph.external,
    },
    // Fast path only (static boot graph + its dynamic imports); these fields
    // are refreshed from the same walk so the ratchet cannot be sidestepped by
    // moving an import behind `await import()` (F7 — WL-0MVFRROLM002K98B).
    ...(fastPath
      ? {
          fastPathDynamicImports: fastPath.dynamicEntries,
          fastPathRuntimeModules: fastPath.graph.modules,
        }
      : {}),
    baselines: {
      ...budget.baselines,
      [result.target]: {
        capturedAt: result.capturedAt,
        node: result.node,
        host: result.host,
        runs: result.runs,
        target: result.target,
        method:
          `${result.invocation} <scenario argv> — warm runs after a cold-start warmup; ` +
          'CPU/RSS from the F1 spawn records (WL_SPAWN_COUNT_FILE)',
        scenarios,
        bareNode: {
          p95WallMs: result.bareNode.p95WallMs,
          p95CpuMs: result.bareNode.p95CpuMs,
          p95RssMb: result.bareNode.p95RssMb,
        },
      },
    },
  };
}

/** Format one row of the text report. */
function scenarioRow(scenario: StartupScenarioMeasurement): string {
  const pad = (value: string, width: number): string => value.padStart(width);
  const num = (value: number | null, digits = 0): string =>
    value === null ? '-' : value.toFixed(digits);
  return [
    scenario.name.padEnd(16),
    pad(num(scenario.p50WallMs), 9),
    pad(num(scenario.p95WallMs), 9),
    pad(num(scenario.p95CpuMs), 8),
    pad(num(scenario.p95RssMb, 1), 8),
    pad(num(scenario.maxRssMb, 1), 8),
    `  ${JSON.stringify(scenario.kinds)}`,
  ].join('');
}

interface BenchCliOptions extends StartupBenchmarkOptions {
  json: boolean;
  updateBudget: boolean;
}

function parseBenchArgs(argv: string[]): BenchCliOptions {
  const options: BenchCliOptions = { json: false, updateBudget: false };
  const readValue = (index: number): string | undefined => {
    const value = argv[index + 1];
    return !value || value.startsWith('--') ? undefined : value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--target': {
        const value = readValue(i);
        if (value === 'src' || value === 'dist' || value === 'auto') options.target = value;
        break;
      }
      case '--runs': {
        const value = readValue(i);
        if (value) options.runs = Number(value);
        break;
      }
      case '--warmup': {
        const value = readValue(i);
        if (value) options.warmupRuns = Number(value);
        break;
      }
      case '--bare-node-runs': {
        const value = readValue(i);
        if (value) options.bareNodeRuns = Number(value);
        break;
      }
      case '--worklog-root': {
        const value = readValue(i);
        if (value) options.worklogRoot = value;
        break;
      }
      case '--repo-root': {
        const value = readValue(i);
        if (value) options.repoRoot = value;
        break;
      }
      case '--update-budget':
        options.updateBudget = true;
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

async function main(): Promise<void> {
  const options = parseBenchArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot());
  const result = runStartupBenchmark({ ...options, repoRoot });

  let evaluation: BudgetEvaluation;
  let budgetPath: string | null = null;
  if (options.updateBudget) {
    const existing = fs.existsSync(budgetFilePath(repoRoot))
      ? readStartupBudget(repoRoot)
      : defaultStartupBudget();
    const updated = applyStartupResultToBudget(existing, result);
    budgetPath = writeStartupBudget(repoRoot, updated);
    evaluation = evaluateStartupBudget(result, updated);
  } else {
    evaluation = evaluateStartupBudget(result, readStartupBudget(repoRoot));
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: evaluation.ok,
          result,
          budget: { path: BUDGET_RELATIVE_PATH, updated: options.updateBudget, file: budgetPath },
          evaluation,
        },
        null,
        2
      )
    );
  } else {
    console.log('wl startup import-budget benchmark');
    console.log(`- target: ${result.target} (${result.invocation})`);
    console.log(`- node: ${result.node}  host: ${result.host}`);
    console.log(`- worklog: ${result.worklogRoot}`);
    console.log(`- runs: ${result.runs} per scenario (cold-start warmup discarded)`);
    console.log(`- static import graph: ${result.importGraph.modules.length} modules, ` +
      `${result.importGraph.external.length} external specifiers from ${result.entry}`);
    console.log('');
    console.log('scenario          p50 wall   p95 wall  p95 cpu  p95 rss  max rss  kinds');
    for (const scenario of result.scenarios) {
      console.log(scenarioRow(scenario));
    }
    console.log(
      `bare node floor   ${result.bareNode.p95WallMs.toFixed(0).padStart(9)} ms ` +
        `${(result.bareNode.p95CpuMs ?? 0).toFixed(0).padStart(8)} ms ` +
        `${(result.bareNode.p95RssMb ?? 0).toFixed(1).padStart(8)} MiB`
    );
    console.log('');
    if (options.updateBudget) {
      console.log(`budget: ${BUDGET_RELATIVE_PATH} updated (baseline '${result.target}')`);
    }
    if (evaluation.ok) {
      console.log('budget: PASS — within the recorded budget plus documented headroom');
    } else {
      console.log('budget: FAIL');
      for (const violation of evaluation.violations) console.log(`  - ${violation}`);
    }
  }

  process.exitCode = evaluation.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('startup benchmark failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
