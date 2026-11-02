import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Increase default timeout to reduce intermittent test timeouts in CI.
    // Tests that spawn tsx subprocesses should set explicit per-test timeouts
    // (45-60s) since subprocess startup is slow under concurrent load.
    // (e.g. tests/scripts/install-herdr.test.ts -> 60s via its itScript
    // helper, plus hermetic npm/node stubs — WL-0MVWL88MO002SQ2B.)
    testTimeout: 30000,
    // Hook timeout must match the test budget. Several suites set up real git
    // remotes and bare repositories in `beforeEach` (sync-concurrent,
    // sync-vs-mutation, the delta-sync family); on a loaded host those setup
    // commands alone can exceed vitest's 10 s default and fail as
    // "Hook timed out" — a load-induced flake with nothing wrong with the
    // code under test (WL-0MVF9JJUH0077OB8 AC6).
    hookTimeout: 60000,
    // Run setup to inject mock git into PATH for spawn-based calls
    setupFiles: ['./tests/setup-tests.ts'],
    // Parallelism — maxWorkers: 6 (WL-0MVHVZTYA003TNN0).
    // Measured 2026-11-01 on this 16-core shared dev host (load avg 16–22,
    // medians of ≥3 green runs; canonical tests/cli + tests/unit, 165 files).
    // The previous cap of 4 under-utilised the 16-core host: with 165 files
    // and a long right tail (sync-vs-mutation ~151 s, close-recursive ~121 s,
    // issue-management ~88 s), the long files serialised behind 4 slots.
    //
    //   maxWorkers | median wall (s) | median aggregate test time (s)
    //   -----------|-----------------|-------------------------------
    //   4 (old)    | 230.4           | ~814
    //   6 (now)    | ~130–142        | ~707      (−38–44 % wall)
    //   8 (tried)  | ~132            | ~890      (aggregate rises — no win)
    //
    // 6 workers ≈ 1 GB peak RSS (1.3–1.8 GB at 8) on the 29 GB host — ample
    // headroom; 3 consecutive green canonical runs confirmed determinism
    // (no intermittent test/hook timeouts). 8 adds no wall-clock win and
    // raises aggregate test time under host contention, so it is deliberately
    // not the default. CI (GitHub ubuntu-latest, 4 vCPU) runs the same fixed
    // 6: mild oversubscription on a fork pool is benign for this mostly
    // subprocess/IO-bound suite; revisit if CI ever moves to a smaller runner.
    //
    // Use 'forks' pool (child_process) instead of 'threads' (worker_threads)
    // because many tests use process.chdir() which is not supported in workers.
    pool: 'forks',
    // File-level isolation — each test file gets its own worker process.
    // Prevents module cache leaking across test files. Multiple test files
    // mock `child_process` with different factories; without isolation,
    // vitest reuses workers and cached mock state from one file can break
    // another (flaky failures in github-*.test.ts).
    isolate: true,
    // singleFork is ignored by vitest 4 (no such top-level option); per-file
    // isolation is enforced by isolate: true above. Key removal is tracked in
    // WL-0MVHVZDPT005KDQK.
    singleFork: true,
    maxWorkers: 6,
    // Exclude worktree test files from discovery — worktrees share the
    // same git objects but have separate working directories, so vitest
    // would otherwise pick up duplicate copies of test files.
    exclude: [
      '**/node_modules/**',
      '**/__snapshots__/**',
      '**/{dist,build,.cache}/**',
      '**/.worklog/worktrees/**',
    ],
  },
})
