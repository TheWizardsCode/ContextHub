import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Regression guard for the measured parallelism contract
// (WL-0MVHVZTYA003TNN0). The wall-clock / aggregate-test-time / memory
// evidence and the 3-consecutive-green determinism gate are recorded in
// docs/dev/test-suite-baseline.md ("Test-suite parallelism: maxWorkers 4 → 6").
// This guard pins the declared config values so a future edit cannot silently
// regress the measured choice.
//
// Two deliberate choices:
//
// 1. Repo root comes from THIS file's location, never `process.cwd()`: 27
//    suite files call `process.chdir()` for temp-dir fixtures, and a worker
//    may run this file after one of them, leaving cwd elsewhere.
// 2. The values are read from the config module itself, not from
//    `vitest/node`'s `resolveConfig()`. Inside a full-suite run that helper
//    re-resolves the config with the *ambient* test-run state and returns the
//    main checkout's value (measured: 4) even though `configFile` correctly
//    points at this worktree's file — a vitest-internal quirk this guard does
//    not depend on. The imported module is the same object `defineConfig`
//    exports and is what the suite is declared with.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CONFIG_PATH = path.join(REPO_ROOT, 'vitest.config.ts')

interface ProjectTestConfig extends ParallelismConfig {
  name?: string
  include?: string[]
  exclude?: string[]
  sequence?: { groupOrder?: number }
}

interface ParallelismConfig {
  maxWorkers?: number | string
  pool?: string
  isolate?: boolean
  projects?: Array<{ test?: ProjectTestConfig }>
}

async function declaredTestConfig(): Promise<ParallelismConfig> {
  const mod: { default?: { test?: ParallelismConfig } } = await import(CONFIG_PATH)
  const test = mod.default?.test
  if (!test) throw new Error(`vitest.config.ts has no \`test\` block (${CONFIG_PATH})`)
  return test
}

describe('vitest declared parallelism config', () => {
  it('declares the measured optimum of 6 maxWorkers', async () => {
    const test = await declaredTestConfig()
    expect(test.maxWorkers).toBe(6)
  })

  it('keeps the forks pool and per-file isolation', async () => {
    const test = await declaredTestConfig()
    // process.chdir() usage in the suite is incompatible with worker_threads.
    expect(test.pool).toBe('forks')
    // Per-file isolation prevents module-cache/mock leakage across files
    // (github-*.test.ts mock `child_process` with differing factories).
    expect(test.isolate).toBe(true)
  })
})

// The measured startup-cost suite spawns real `wl` processes and compares their
// peak RSS against a 25 % budget, so it must not share the host with the rest of
// the parallel run: in-suite fork contention inflated that child RSS by ~25 % and
// failed the dev-push gate on an unchanged tree (WL-0MWIF616V008380O,
// WL-0MWIGCK0E009GGLG). The isolation is declared in `vitest.config.ts`, so this
// guard pins it against a future edit that silently removes it.
const MEASURED_STARTUP_SUITE = 'tests/cli/startup-import-budget.test.ts'

describe('vitest measured-suite isolation (WL-0MWIGCK0E009GGLG)', () => {
  const projectIncluding = async (file: string): Promise<ProjectTestConfig> => {
    const test = await declaredTestConfig()
    const project = (test.projects ?? [])
      .map((entry) => entry.test)
      .find((candidate) => candidate?.include?.includes(file))
    if (!project) {
      throw new Error(
        `vitest.config.ts has no project whose include lists ${file} — the measured ` +
          'startup suite must run in its own serialised project'
      )
    }
    return project
  }

  it('runs the measured startup suite in its own single-worker project', async () => {
    const root = await declaredTestConfig()
    const project = await projectIncluding(MEASURED_STARTUP_SUITE)

    expect(project.name).toBe('startup-budget-measured')
    expect(project.maxWorkers).toBe(1)
    // The project extends the root config, which keeps `isolate: true`; either
    // source is fine, a missing value on both would not be.
    expect(project.isolate ?? root.isolate).toBe(true)
  })

  it('runs the measured project after every other project has finished', async () => {
    const project = await projectIncluding(MEASURED_STARTUP_SUITE)

    // Groups run lowest → highest; the main suite stays on the default 0.
    expect(project.sequence?.groupOrder ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('keeps the measured suite out of the main parallel project', async () => {
    const test = await declaredTestConfig()
    const main = (test.projects ?? [])
      .map((entry) => entry.test)
      .find((candidate) => candidate?.name === 'suite')
    if (!main) throw new Error('vitest.config.ts has no `suite` project')

    // Else it would also run inside the contended group, defeating the isolation
    // while still passing if the isolated run is the one that reports.
    expect(main.exclude ?? []).toContain(MEASURED_STARTUP_SUITE)
  })
})
