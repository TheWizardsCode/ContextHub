/**
 * File-based mutex for serializing access to the JSONL data file.
 *
 * Uses an advisory lock file created with O_CREAT | O_EXCL (atomic
 * create-if-not-exists) to ensure only one process at a time can
 * perform read-merge-write operations on the shared data file.
 *
 * The lock file contains the holder's PID, hostname, and acquisition
 * timestamp so that stale locks left behind by crashed processes can
 * be detected and cleaned up automatically.
 */
export interface FileLockOptions {
    /** Delay in milliseconds between retry attempts (default 100). This is the initial delay; with exponential backoff it increases on each attempt. */
    retryDelay?: number;
    /** Overall timeout in milliseconds (default 30 000). The retry loop runs until this deadline is reached. */
    timeout?: number;
    /** If true, stale locks from dead processes are automatically removed (default true). */
    staleLockCleanup?: boolean;
    /** Maximum age of a lock file in milliseconds before it is treated as stale regardless of PID status (default 300 000 = 5 minutes). */
    maxLockAge?: number;
    /** Maximum delay in milliseconds between retry attempts after exponential growth (default 2 000). */
    maxRetryDelay?: number;
    /** If true and the lock is currently held by a live process, fail fast with a `LockBusyError` instead of retrying until the timeout. Stale/age-expired locks are still cleaned up first. Used by `wl sync --if-idle` so auto-sync spawners skip instead of queueing (lock-storm prevention). */
    skipIfLocked?: boolean;
}
/**
 * Thrown when `skipIfLocked` is set and the file lock is currently held by
 * a live process. Callers (e.g. `wl sync --if-idle`) treat this as "skip —
 * another sync is already running" rather than an error.
 */
export declare class LockBusyError extends Error {
    constructor(lockPath: string);
}
export interface FileLockInfo {
    pid: number;
    hostname: string;
    acquiredAt: string;
}
/**
 * Derive the lock file path for a given JSONL data file path.
 *
 * Example: `/path/to/.worklog/worklog-data.jsonl` → `/path/to/.worklog/worklog-data.jsonl.lock`
 */
export declare function getLockPathForJsonl(jsonlPath: string): string;
/**
 * Check whether a process with the given PID is still running.
 * Uses `process.kill(pid, 0)` which sends signal 0 (no-op) — it
 * throws ESRCH if the process does not exist, and EPERM if we
 * lack permission (but the process *does* exist).
 */
export declare function isProcessAlive(pid: number): boolean;
/**
 * Try to read and parse lock file contents.  Returns null if the file
 * does not exist or cannot be parsed.
 */
export declare function readLockInfo(lockPath: string): FileLockInfo | null;
/**
 * Read the raw lock file and indicate whether it parsed and whether
 * required fields are present. This lets callers distinguish between
 * "unparseable/garbage" (apply grace window) and "valid JSON but
 * missing required fields" (treat as immediately corrupted/stale).
 */
export declare function readRawLock(lockPath: string): {
    parsed: boolean;
    info?: FileLockInfo;
    missingFields?: boolean;
};
/**
 * Synchronous sleep using `Atomics.wait`.  Blocks the calling thread
 * for the requested number of milliseconds **without** busy-waiting,
 * so CPU usage during the sleep is negligible.
 *
 * Note: `Atomics.wait` is supported in Node.js on all platforms
 * (Linux, macOS, Windows / WSL2).  It throws in browser main threads,
 * but this is a Node.js CLI tool so that is not a concern.
 */
export declare function sleepSync(ms: number): void;
/**
 * Format a lock's `acquiredAt` timestamp into a human-readable relative
 * age string such as "12 minutes ago" or "3 seconds ago".
 *
 * Exported so that the `wl unlock` command can reuse it.
 */
export declare function formatLockAge(acquiredAt: string): string;
/**
 * Attempt to acquire a file lock at `lockPath`.
 *
 * On success the lock file is created (atomically via `O_EXCL`) and
 * populated with the current process's PID, hostname, and timestamp.
 *
 * On failure (lock already held by a live process and retries exhausted)
 * an error is thrown.
 */
export declare function acquireFileLock(lockPath: string, options?: FileLockOptions): void;
/**
 * Release a previously acquired file lock by removing the lock file.
 * It is safe to call this even if the lock file does not exist (no-op).
 */
export declare function releaseFileLock(lockPath: string): void;
/**
 * Execute `fn` while holding the file lock at `lockPath`.
 *
 * The lock is acquired before `fn` is called and released in a
 * `finally` block — even if `fn` throws.  Supports both synchronous
 * and asynchronous callbacks.
 *
 * **Reentrancy:** If the current process already holds the lock for
 * `lockPath` (via a surrounding `withFileLock` call), the nested
 * invocation is a transparent pass-through — `fn` runs immediately
 * without touching the lock file.
 */
export declare function withFileLock<T>(lockPath: string, fn: () => T, options?: FileLockOptions): T;
/**
 * Check whether the current process holds the file lock at `lockPath`.
 * Useful for testing and diagnostics.
 */
export declare function isFileLockHeld(lockPath: string): boolean;
/**
 * Reset reentrancy tracking (for use in tests only).
 */
export declare function _resetLockState(): void;
//# sourceMappingURL=file-lock.d.ts.map