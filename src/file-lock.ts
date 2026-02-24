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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

export interface FileLockInfo {
  pid: number;
  hostname: string;
  acquiredAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LOCK_AGE_MS = 300_000; // 5 minutes
const DEFAULT_MAX_RETRY_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emit a debug log line to stderr when `WL_DEBUG` is set.
 * All messages are prefixed with `[wl:lock]` for easy filtering.
 * When `WL_DEBUG` is not set, this is a no-op with negligible overhead.
 */
function debugLog(...args: unknown[]): void {
  if (process.env.WL_DEBUG) {
    process.stderr.write(`[wl:lock] ${args.map(String).join(' ')}\n`);
  }
}

/**
 * Derive the lock file path for a given JSONL data file path.
 *
 * Example: `/path/to/.worklog/worklog-data.jsonl` → `/path/to/.worklog/worklog-data.jsonl.lock`
 */
export function getLockPathForJsonl(jsonlPath: string): string {
  return `${jsonlPath}.lock`;
}

/**
 * Check whether a process with the given PID is still running.
 * Uses `process.kill(pid, 0)` which sends signal 0 (no-op) — it
 * throws ESRCH if the process does not exist, and EPERM if we
 * lack permission (but the process *does* exist).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // signal sent successfully — process is alive
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      return false; // no such process
    }
    // EPERM means the process exists but we can't signal it — treat as alive
    return true;
  }
}

/**
 * Try to read and parse lock file contents.  Returns null if the file
 * does not exist or cannot be parsed.
 */
export function readLockInfo(lockPath: string): FileLockInfo | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8');
    const info = JSON.parse(content) as FileLockInfo;
    if (typeof info.pid === 'number' && typeof info.hostname === 'string') {
      return info;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Synchronous sleep using `Atomics.wait`.  Blocks the calling thread
 * for the requested number of milliseconds **without** busy-waiting,
 * so CPU usage during the sleep is negligible.
 *
 * Note: `Atomics.wait` is supported in Node.js on all platforms
 * (Linux, macOS, Windows / WSL2).  It throws in browser main threads,
 * but this is a Node.js CLI tool so that is not a concern.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Format a lock's `acquiredAt` timestamp into a human-readable relative
 * age string such as "12 minutes ago" or "3 seconds ago".
 *
 * Exported so that the `wl unlock` command can reuse it.
 */
export function formatLockAge(acquiredAt: string): string {
  const ageMs = Date.now() - new Date(acquiredAt).getTime();
  if (ageMs <= 0) {
    return 'just now';
  }
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) {
    return `${seconds} ${seconds === 1 ? 'second' : 'seconds'} ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
}

/**
 * Build an enriched error message for lock acquisition failure.
 * Includes lock file path, holder metadata, computed age, and recovery guidance.
 */
function buildLockErrorMessage(
  lockPath: string,
  reason: string,
  lockInfo: FileLockInfo | null,
): string {
  const lines: string[] = [`Failed to acquire file lock at ${lockPath} (${reason})`];

  if (lockInfo) {
    const age = formatLockAge(lockInfo.acquiredAt);
    lines.push(`  Held by PID ${lockInfo.pid} on ${lockInfo.hostname} since ${lockInfo.acquiredAt} (${age})`);
  } else {
    lines.push('  Lock file appears corrupted (corrupted lock file)');
  }

  lines.push("  Run 'wl unlock' to remove the stale lock.");

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Reentrancy tracking
// ---------------------------------------------------------------------------

/**
 * Per-path counter tracking how many times the current process has acquired
 * a lock via `withFileLock`.  When the counter is > 0 for a given path the
 * process already owns the lock and nested calls to `withFileLock` become
 * transparent pass-throughs (no acquire / release).
 *
 * This is safe because Node.js is single-threaded — the map is only accessed
 * from the same event-loop turn that called `withFileLock`.
 */
const heldLocks: Map<string, number> = new Map();

/**
 * Resolve a lock path to its canonical (absolute, real) form so that
 * different relative references to the same file share one counter.
 */
function canonicalLockPath(lockPath: string): string {
  return path.resolve(lockPath);
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire a file lock at `lockPath`.
 *
 * On success the lock file is created (atomically via `O_EXCL`) and
 * populated with the current process's PID, hostname, and timestamp.
 *
 * On failure (lock already held by a live process and retries exhausted)
 * an error is thrown.
 */
export function acquireFileLock(lockPath: string, options?: FileLockOptions): void {
  const retryDelay = options?.retryDelay ?? DEFAULT_RETRY_DELAY_MS;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;
  const staleLockCleanup = options?.staleLockCleanup ?? true;
  const maxLockAge = options?.maxLockAge ?? DEFAULT_MAX_LOCK_AGE_MS;
  const maxRetryDelay = options?.maxRetryDelay ?? DEFAULT_MAX_RETRY_DELAY_MS;

  const deadline = Date.now() + timeout;

  const lockInfo: FileLockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  const lockContent = JSON.stringify(lockInfo);

  // Ensure the parent directory exists
  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  let currentDelay = retryDelay;
  let attempt = 0;

  while (true) {
    // Check timeout
    if (Date.now() > deadline) {
      const existingInfo = readLockInfo(lockPath);
      debugLog(`Timeout after ${timeout}ms waiting for lock at ${lockPath}`);
      throw new Error(
        buildLockErrorMessage(lockPath, `${timeout}ms timeout`, existingInfo)
      );
    }

    try {
      // O_CREAT | O_EXCL | O_WRONLY — atomic create-if-not-exists
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, lockContent);
      fs.closeSync(fd);
      debugLog(`Lock acquired at ${lockPath} (PID ${process.pid}, attempt ${attempt + 1})`);
      return; // lock acquired
    } catch (err: any) {
      if (err.code !== 'EEXIST') {
        // Unexpected error (permissions, disk full, etc.)
        throw new Error(`Failed to create lock file at ${lockPath}: ${err.message}`);
      }

      // Lock file already exists — check for stale lock
      if (staleLockCleanup) {
        const existing = readLockInfo(lockPath);
        if (existing) {
          const sameHost = existing.hostname === os.hostname();
          if (sameHost && !isProcessAlive(existing.pid)) {
            // Stale lock from a dead process on this host — remove it
            debugLog(`Stale lock detected: PID ${existing.pid} is dead, removing ${lockPath}`);
            try {
              fs.unlinkSync(lockPath);
              // Don't increment attempt counter; retry immediately
              continue;
            } catch {
              // Another process may have removed it; retry
              continue;
            }
          }

          // Age-based expiry: if the lock is older than maxLockAge,
          // treat it as stale regardless of PID status.  This handles
          // PID recycling and environments where PID checks are unreliable.
          // Guard against clock skew: only expire if age is positive.
          const lockAge = Date.now() - new Date(existing.acquiredAt).getTime();
          if (lockAge > 0 && lockAge > maxLockAge) {
            debugLog(`Stale lock detected: age-expired (${lockAge}ms > ${maxLockAge}ms), removing ${lockPath}`);
            try {
              fs.unlinkSync(lockPath);
              continue;
            } catch {
              // Another process may have removed it; retry
              continue;
            }
          }
        } else if (fs.existsSync(lockPath)) {
          // Lock file exists but could not be parsed (corrupted, empty,
          // or missing required fields).  Treat as stale and remove it
          // so acquisition can be retried.
          debugLog(`Stale lock detected: corrupted lock file, removing ${lockPath}`);
          try {
            fs.unlinkSync(lockPath);
            continue;
          } catch {
            // Another process may have removed it; retry
            continue;
          }
        }
      }

      // Lock is held by a live process (or on another host) — wait and retry
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Will be caught by the timeout check at the top of the loop
        continue;
      }

      // Exponential backoff with jitter
      const jitter = Math.random() * currentDelay * 0.25;
      const sleepMs = Math.min(currentDelay + jitter, remaining);
      debugLog(`Retry attempt ${attempt + 1}: sleeping ${Math.round(sleepMs)}ms (base delay ${Math.round(currentDelay)}ms)`);
      sleepSync(sleepMs);

      // Grow delay for next iteration (1.5x multiplier, capped)
      currentDelay = Math.min(currentDelay * 1.5, maxRetryDelay);
      attempt++;
    }
  }
}

/**
 * Release a previously acquired file lock by removing the lock file.
 * It is safe to call this even if the lock file does not exist (no-op).
 */
export function releaseFileLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
    debugLog(`Lock released at ${lockPath} (PID ${process.pid})`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      // If the file doesn't exist, that's fine — lock was already released.
      // Any other error is unexpected.
      throw new Error(`Failed to release file lock at ${lockPath}: ${err.message}`);
    }
  }
}

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
export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  options?: FileLockOptions
): T {
  const canonical = canonicalLockPath(lockPath);
  const depth = heldLocks.get(canonical) ?? 0;

  if (depth > 0) {
    // Already holding this lock — reentrant call, just run fn.
    heldLocks.set(canonical, depth + 1);
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            heldLocks.set(canonical, (heldLocks.get(canonical) ?? 1) - 1);
            return value;
          },
          (err) => {
            heldLocks.set(canonical, (heldLocks.get(canonical) ?? 1) - 1);
            throw err;
          }
        ) as T;
      }
      heldLocks.set(canonical, depth);
      return result;
    } catch (err) {
      heldLocks.set(canonical, depth);
      throw err;
    }
  }

  // First acquisition — acquire the file lock.
  acquireFileLock(lockPath, options);
  heldLocks.set(canonical, 1);
  try {
    const result = fn();
    // If fn returns a promise, chain the release onto it
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          heldLocks.delete(canonical);
          releaseFileLock(lockPath);
          return value;
        },
        (err) => {
          heldLocks.delete(canonical);
          releaseFileLock(lockPath);
          throw err;
        }
      ) as T;
    }
    heldLocks.delete(canonical);
    releaseFileLock(lockPath);
    return result;
  } catch (err) {
    heldLocks.delete(canonical);
    releaseFileLock(lockPath);
    throw err;
  }
}

/**
 * Check whether the current process holds the file lock at `lockPath`.
 * Useful for testing and diagnostics.
 */
export function isFileLockHeld(lockPath: string): boolean {
  return (heldLocks.get(canonicalLockPath(lockPath)) ?? 0) > 0;
}

/**
 * Reset reentrancy tracking (for use in tests only).
 */
export function _resetLockState(): void {
  heldLocks.clear();
}
