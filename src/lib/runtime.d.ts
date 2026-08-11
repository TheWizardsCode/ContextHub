/**
 * WorklogRuntime — Background task runtime for non-blocking operations.
 *
 * Provides a fire-and-forget task launcher with single-flight guards so that
 * identical tasks (same label) don't pile up.  Designed to integrate with the
 * CLI and API-server shutdown lifecycle so pending work completes before the
 * process exits.
 *
 * Usage:
 *
 *   import { getRuntime, initializeRuntime, shutdownRuntime } from './lib/runtime.js';
 *
 *   // At session start:
 *   initializeRuntime();
 *
 *   // Launch background tasks:
 *   getRuntime().launchTask('auto-sync', () => syncWorklog());
 *
 *   // At session end:
 *   await shutdownRuntime();
 *
 * Inspired by the @zosmaai/pi-llm-wiki background task runtime.
 */
export interface RuntimeOptions {
    /** If true, suppress log messages (default: false). */
    silent?: boolean;
}
export declare class WorklogRuntime {
    /** Map of label → currently-in-flight promise. */
    private inFlight;
    /**
     * Launch a background task.
     *
     * If a task with the same `label` is already running it is silently skipped
     * (single-flight guard).  The task function is invoked immediately and its
     * promise is tracked internally.  Errors thrown by the task are caught and
     * logged to stderr so they never bubble up to the caller.
     *
     * @param label  Unique label for this task (used for single-flight dedup).
     * @param work   Async function to run in the background.
     */
    launchTask(label: string, work: () => Promise<void>): void;
    /**
     * Check whether a task with the given label is currently in-flight.
     */
    isInFlight(label: string): boolean;
    /**
     * Wait for all currently in-flight tasks to complete.
     *
     * Tasks launched **after** calling this method will not be awaited unless
     * `awaitAll()` is called again.
     *
     * Errors from individual tasks are swallowed (they are already logged via
     * `launchTask`).  This method always resolves successfully.
     */
    awaitAll(): Promise<void>;
}
/**
 * Return the global WorklogRuntime singleton.
 *
 * Creates one lazily if it doesn't exist yet.
 */
export declare function getRuntime(): WorklogRuntime;
/**
 * Initialize the background task runtime and install process signal handlers.
 *
 * Call this once at session start (e.g. in the CLI entry point or API server).
 *
 * The signal handlers (`SIGINT`, `SIGTERM`, `beforeExit`) will await all
 * pending background tasks before allowing the process to exit.
 *
 * @param options  Optional configuration.
 * @returns The global WorklogRuntime instance.
 */
export declare function initializeRuntime(options?: RuntimeOptions): WorklogRuntime;
/**
 * Shut down the background task runtime.
 *
 * Awaits all pending tasks and removes any installed signal handlers.
 * Safe to call multiple times.
 */
export declare function shutdownRuntime(): Promise<void>;
//# sourceMappingURL=runtime.d.ts.map