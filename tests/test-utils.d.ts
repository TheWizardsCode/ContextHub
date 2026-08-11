/**
 * Test utilities and helpers
 */
/**
 * Resolve the `tsx` CLI binary path.
 *
 * Worktrees have an empty local `node_modules` (deps resolve upward to the
 * main checkout), so a plain `<repoRoot>/node_modules/.bin/tsx` path breaks
 * for tests that spawn tsx as a subprocess from a worktree. Walk up parent
 * directories until a real `node_modules/.bin/tsx` is found.
 */
export declare function resolveTsxBin(fromDir: string): string;
/**
 * Create a temporary directory for test files
 */
export declare function createTempDir(): string;
/**
 * Clean up a temporary directory.
 * On Windows, SQLite may hold file locks briefly after the connection
 * object goes out of scope; retry a few times to handle EPERM.
 */
export declare function cleanupTempDir(dir: string): void;
/**
 * Create a temporary JSONL file path in a temp directory
 */
export declare function createTempJsonlPath(dir: string): string;
/**
 * Create a temporary database path in a temp directory
 */
export declare function createTempDbPath(dir: string): string;
/**
 * Wait for a specified number of milliseconds
 */
export declare function wait(ms: number): Promise<void>;
/**
 * Create a minimal TUI test context used by a few TUI-focused tests.
 * This provides a lightweight in-memory database, toast collector, and a
 * `createLayout` factory so tests can instantiate `TuiController` without
 * depending on the real terminal environment.
 */
/**
 * TuiController test API
 *
 * TuiController exposes a minimal test-only API on controller._test with the
 * following helpers which are intended for tests and internal use only:
 *
 * - openCreateDialog()
 * - closeCreateDialog()
 * - submitCreateDialog()
 * - openUpdateDialog()
 * - closeUpdateDialog()
 * - submitUpdateDialog()
 *
 * These are thin wrappers around the controller's internal dialog helpers
 * and provide a stable surface so tests do not need to inspect or modify
 * private widget internals (for example, `__agent_*` properties).
 *
 * Example usage:
 *   const controller = new TuiController(ctx, { blessed: ctx.blessed });
 *   await controller.start({});
 *   (controller as any)._test.openCreateDialog();
 *   (controller as any)._test.submitCreateDialog();
 */
export declare function createTuiTestContext(options?: {
    prefix?: string;
}): any;
export declare const createTestContext: typeof createTuiTestContext;
export declare const RUN_LONG: boolean;
/**
 * Describe wrapper for long-running tests. Skips the suite unless
 * WL_RUN_LONG_TESTS=true in the environment.
 */
export declare function describeLong(name: string, fn: () => void): any;
/**
 * Test wrapper for individual long-running tests. Skips the test unless
 * WL_RUN_LONG_TESTS=true in the environment.
 */
export declare function itLong(name: string, fn: (done?: any) => any): any;
//# sourceMappingURL=test-utils.d.ts.map