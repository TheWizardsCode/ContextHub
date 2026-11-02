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

interface ParallelismConfig {
  maxWorkers?: number | string
  pool?: string
  isolate?: boolean
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
