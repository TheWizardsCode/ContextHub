import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Increase default timeout to reduce intermittent test timeouts in CI.
    // Tests that spawn tsx subprocesses should set explicit per-test timeouts
    // (45-60s) since subprocess startup is slow under concurrent load.
    testTimeout: 30000,
    // Run setup to inject mock git into PATH for spawn-based calls
    setupFiles: ['./tests/setup-tests.ts'],
    // Memory guardrails: limit worker count and enable OOM detection.
    // Some test files can consume significant memory during module
    // initialization.  These settings
    // prevent unbounded memory growth and ensure OOM failures are caught
    // early rather than hanging the test runner.
    // Use 'forks' pool (child_process) instead of 'threads' (worker_threads)
    // because many tests use process.chdir() which is not supported in workers.
    pool: 'forks',
    // File-level isolation — each test file gets its own worker process.
    // Prevents module cache leaking across test files. Multiple test files
    // mock `child_process` with different factories; without isolation,
    // vitest reuses workers and cached mock state from one file can break
    // another (flaky failures in github-*.test.ts).
    isolate: true,
    // Force per-file isolation by limiting to 1 active worker per file sequence.
    singleFork: true,
    maxWorkers: 4,
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
