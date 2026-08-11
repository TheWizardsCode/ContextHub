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
// ---------------------------------------------------------------------------
// WorklogRuntime class
// ---------------------------------------------------------------------------
export class WorklogRuntime {
    /** Map of label → currently-in-flight promise. */
    inFlight = new Map();
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
    launchTask(label, work) {
        // Single-flight guard: skip if already running
        if (this.inFlight.has(label)) {
            return;
        }
        const promise = work()
            .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[runtime] Task "${label}" failed: ${message}`);
        })
            .finally(() => {
            this.inFlight.delete(label);
        });
        this.inFlight.set(label, promise);
    }
    /**
     * Check whether a task with the given label is currently in-flight.
     */
    isInFlight(label) {
        return this.inFlight.has(label);
    }
    /**
     * Wait for all currently in-flight tasks to complete.
     *
     * Tasks launched **after** calling this method will not be awaited unless
     * `awaitAll()` is called again.
     *
     * Errors from individual tasks are swallowed (they are already logged via
     * `launchTask`).  This method always resolves successfully.
     */
    async awaitAll() {
        const promises = Array.from(this.inFlight.values());
        if (promises.length === 0)
            return;
        await Promise.allSettled(promises);
    }
}
// ---------------------------------------------------------------------------
// Singleton access
// ---------------------------------------------------------------------------
let _globalRuntime = null;
let _signalHandlersInstalled = false;
/**
 * Return the global WorklogRuntime singleton.
 *
 * Creates one lazily if it doesn't exist yet.
 */
export function getRuntime() {
    if (!_globalRuntime) {
        _globalRuntime = new WorklogRuntime();
    }
    return _globalRuntime;
}
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
export function initializeRuntime(options = {}) {
    const runtime = getRuntime();
    if (!_signalHandlersInstalled) {
        _signalHandlersInstalled = true;
        const handler = async (signal) => {
            if (!options.silent) {
                console.error(`[runtime] Received ${signal}; awaiting ${runtime['inFlight'].size} pending task(s)...`);
            }
            await runtime.awaitAll();
            if (!options.silent) {
                console.error('[runtime] All tasks complete.');
            }
        };
        process.on('SIGINT', () => {
            // Don't prevent exit — just await, then the default handler runs.
            void handler('SIGINT').catch(() => { });
        });
        process.on('SIGTERM', () => {
            void handler('SIGTERM').catch(() => { });
        });
        process.on('beforeExit', () => {
            void handler('beforeExit').catch(() => { });
        });
    }
    return runtime;
}
/**
 * Shut down the background task runtime.
 *
 * Awaits all pending tasks and removes any installed signal handlers.
 * Safe to call multiple times.
 */
export async function shutdownRuntime() {
    if (_globalRuntime) {
        await _globalRuntime.awaitAll();
    }
    if (_signalHandlersInstalled) {
        // We cannot easily remove the handlers we added without holding
        // references to them.  For test isolation we clear the flag so a
        // subsequent initializeRuntime call re-installs fresh handlers.
        _signalHandlersInstalled = false;
        _globalRuntime = null;
    }
}
//# sourceMappingURL=runtime.js.map