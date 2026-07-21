/**
 * src/process-lifecycle.ts — Process Lifecycle Management
 *
 * Singleton module that tracks spawned PIDs against worktree paths and
 * provides cleanup functions to kill tracked processes, using POSIX
 * process groups where supported.
 *
 * Features:
 * - Register a PID under a worktree path
 * - Kill all PIDs for a specific worktree (with process-group fallback)
 * - Kill all tracked PIDs (global session cleanup)
 * - Watchdog timer that automatically kills stale PIDs after a configurable
 *   timeout (default ≥10 minutes)
 *
 * All functions handle edge cases gracefully: ESRCH (already dead),
 * EPERM (no permission), missing worktrees.
 *
 * Uses only Node.js built-in modules — no npm dependencies.
 */

// ── Types ───────────────────────────────────────────────────────────

import { exec as cpExec } from 'child_process';

/** Metadata stored for each registered PID */
export interface ProcessMeta {
  readonly pid: number;
  readonly worktreePath: string;
  readonly registeredAt: number; // Date.now() when registered
}

/** Public read-only view of the registry */
export type ProcessRegistry = Record<string, number[]>;

// ── Module-level state (singleton) ──────────────────────────────────

/** Map: worktreePath → Set of PIDs */
const registry = new Map<string, Set<number>>();

/** Map: PID → metadata (worktree, timestamp) */
const pidMeta = new Map<number, ProcessMeta>();

/** Watchdog timer handle, null when stopped */
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** Interval between watchdog checks (ms) */
let watchdogCheckIntervalMs: number = 60_000; // 1 minute default check interval

/** Age threshold after which a process is considered stale (ms) */
let watchdogTimeoutMs: number = 10 * 60 * 1000; // 10 minutes default

// ── Validation helpers ──────────────────────────────────────────────

function validatePid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid PID: ${pid}. Must be a positive integer.`);
  }
}

function validateWorktreePath(path: string): void {
  if (!path || path.trim().length === 0) {
    throw new Error('Worktree path must be a non-empty string.');
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Register a process PID under a worktree path.
 *
 * If the same PID is already registered for the same worktree, this is a
 * no-op. The same PID can be registered under different worktrees.
 *
 * @param pid - The process ID to track
 * @param worktreePath - The worktree path to associate with this PID
 */
export function registerProcess(pid: number, worktreePath: string): void {
  validatePid(pid);
  validateWorktreePath(worktreePath);

  // If already tracked for this worktree, no-op
  if (pidMeta.has(pid)) {
    const existing = pidMeta.get(pid)!;
    if (existing.worktreePath === worktreePath) return;
    // Same PID registered for different worktree — allow it (edge case)
  }

  // Get or create the PID set for this worktree
  let pids = registry.get(worktreePath);
  if (!pids) {
    pids = new Set<number>();
    registry.set(worktreePath, pids);
  }

  pids.add(pid);

  // Store metadata
  pidMeta.set(pid, {
    pid,
    worktreePath,
    registeredAt: Date.now(),
  });
}

/**
 * Attempt to kill a single PID, with process group fallback.
 *
 * Tries `process.kill(-pid, signal)` first (process group kill on POSIX).
 * If that fails with EPERM or ESRCH (no process group or permission denied),
 * falls back to `process.kill(pid, signal)` (individual process kill).
 *
 * Errors from the final kill call are silently ignored — ESRCH means the
 * process is already dead, EPERM means we don't have permission.
 *
 * @returns true if the kill was attempted (even if the process was already dead)
 */
function tryKillOne(pid: number, signal: string): boolean {
  // First attempt: process group kill
  try {
    process.kill(-pid, signal as any);
    return true;
  } catch (err: any) {
    // If process group kill fails with EPERM or ESRCH, fall back to
    // individual PID kill
    if (err.code === 'EPERM' || err.code === 'ESRCH') {
      // Fall back to individual kill
      try {
        process.kill(pid, signal as any);
        return true;
      } catch (innerErr: any) {
        // Silently ignore ESRCH (already dead) and EPERM (no permission)
        if (innerErr.code !== 'ESRCH' && innerErr.code !== 'EPERM') {
          throw innerErr;
        }
        return false;
      }
    }
    // Re-throw unexpected errors
    throw err;
  }
}

/**
 * Kill all tracked PIDs for a specific worktree path.
 *
 * After killing, the PIDs and their metadata are removed from the registry.
 * If the worktree path is unknown, this is a no-op.
 *
 * @param worktreePath - The worktree path whose PIDs should be killed
 * @param signal - The signal to send (default: 'SIGTERM')
 */
export function killProcessesForWorktree(
  worktreePath: string,
  signal: string = 'SIGTERM'
): void {
  const pids = registry.get(worktreePath);
  if (!pids || pids.size === 0) return;

  for (const pid of pids) {
    tryKillOne(pid, signal);
  }

  // Clean up registry
  registry.delete(worktreePath);

  // Clean up metadata
  for (const pid of pids) {
    pidMeta.delete(pid);
  }
}

/**
 * Kill all tracked PIDs across all worktrees.
 *
 * After killing, the entire registry is cleared.
 *
 * @param signal - The signal to send (default: 'SIGTERM')
 */
export function killAllTracked(signal: string = 'SIGTERM'): void {
  // Collect all PIDs to kill (iterate over a copy since we're modifying)
  const allPids = new Set<number>();
  for (const pids of registry.values()) {
    for (const pid of pids) {
      allPids.add(pid);
    }
  }

  if (allPids.size === 0) return;

  // Kill each PID
  for (const pid of allPids) {
    tryKillOne(pid, signal);
  }

  // Clear everything
  registry.clear();
  pidMeta.clear();
}

/**
 * Get a read-only snapshot of the process registry.
 *
 * Returns an object mapping worktree paths to arrays of PIDs.
 */
export function getTrackedProcesses(): ProcessRegistry {
  const result: ProcessRegistry = {};
  for (const [worktreePath, pids] of registry.entries()) {
    result[worktreePath] = Array.from(pids);
  }
  return result;
}

/**
 * Get metadata for a specific PID.
 *
 * @returns The ProcessMeta object, or null if the PID is not tracked
 */
export function getProcessMeta(pid: number): ProcessMeta | null {
  return pidMeta.get(pid) ?? null;
}

// ── Watchdog ────────────────────────────────────────────────────────

/**
 * Start (or restart) the watchdog timer.
 *
 * The watchdog periodically checks all tracked PIDs and kills any that
 * have been running longer than `timeoutMs`. If a watchdog is already
 * running, it is stopped before starting the new one.
 *
 * @param checkIntervalMs - How often to check for stale PIDs (default: 60s)
 * @param timeoutMs - Age threshold for killing a PID (default: 10 min)
 */
export function startWatchdog(
  checkIntervalMs: number = 60_000,
  timeoutMs: number = 10 * 60 * 1000
): void {
  // Stop existing watchdog if running
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  watchdogCheckIntervalMs = checkIntervalMs;
  watchdogTimeoutMs = timeoutMs;

  watchdogTimer = setInterval(() => {
    const now = Date.now();

    // Collect expired PIDs (iterate over a snapshot to avoid
    // modification-during-iteration issues)
    const expiredPids: number[] = [];
    for (const [pid, meta] of pidMeta.entries()) {
      if (now - meta.registeredAt >= watchdogTimeoutMs) {
        expiredPids.push(pid);
      }
    }

    // Kill expired PIDs
    for (const pid of expiredPids) {
      // Re-check that PID is still tracked (might have been killed by
      // another path)
      if (!pidMeta.has(pid)) continue;
      const meta = pidMeta.get(pid)!;

      tryKillOne(pid, 'SIGTERM');

      // Remove from registry
      pidMeta.delete(pid);
      const pids = registry.get(meta.worktreePath);
      if (pids) {
        pids.delete(pid);
        if (pids.size === 0) {
          registry.delete(meta.worktreePath);
        }
      }
    }
  }, watchdogCheckIntervalMs);

  // Allow the process to exit even if the watchdog timer is active
  if (watchdogTimer && typeof watchdogTimer === 'object' && 'unref' in watchdogTimer) {
    watchdogTimer.unref();
  }
}

/**
 * Get the current watchdog check interval in milliseconds.
 */
export function getWatchdogInterval(): number {
  return watchdogCheckIntervalMs;
}

/**
 * Get the current watchdog timeout threshold in milliseconds.
 */
export function getWatchdogTimeout(): number {
  return watchdogTimeoutMs;
}

/**
 * Check whether the watchdog timer is currently running.
 */
export function isWatchdogRunning(): boolean {
  return watchdogTimer !== null;
}

/**
 * Shut down the process lifecycle module.
 *
 * - Stops the watchdog timer
 * - Clears all tracked PIDs (they are NOT killed — use killAllTracked()
 *   first if you want to kill them)
 *
 * This is intended for graceful shutdown of the module itself.
 */
export function shutdown(): void {
  // Stop watchdog
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  // Clear tracking data
  registry.clear();
  pidMeta.clear();
}

// ── Auto-registration ───────────────────────────────────────────────

/**
 * Detect whether the given directory (or CWD) is inside a git worktree
 * managed by ContextHub (i.e., under `.worklog/worktrees/`).
 *
 * @param cwd - The directory to check (default: process.cwd())
 * @returns The worktree root path if inside one, or `null` otherwise
 */
export function detectWorktreeFromCwd(cwd?: string): string | null {
  const dir = cwd ?? process.cwd();
  const idx = dir.indexOf('.worklog/worktrees/');
  if (idx === -1) return null;

  const prefix = dir.slice(0, idx);
  const rest = dir.slice(idx + '.worklog/worktrees/'.length);
  const slashIdx = rest.indexOf('/');
  const worktreeName = slashIdx === -1 ? rest : rest.slice(0, slashIdx);

  return prefix + '.worklog/worktrees/' + worktreeName;
}

/** Result of a tracked exec call */
export interface TrackedExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Create a tracked version of `child_process.exec` (promisified) that
 * automatically registers the spawned child PID with the lifecycle module.
 *
 * The returned function has the same signature as a promisified exec:
 * `(command: string, options?: ExecOptions) => Promise<TrackedExecResult>`
 *
 * @param worktreePath - The worktree path to associate spawned PIDs with.
 *                       Pass `null` to skip registration (safe default).
 * @returns A tracked exec function
 */
export function createTrackedExec(
  worktreePath: string | null
): (command: string, options?: any) => Promise<TrackedExecResult> {
  return function trackedExec(
    command: string,
    options?: any
  ): Promise<TrackedExecResult> {
    return new Promise((resolve, reject) => {
      const child = cpExec(command, options || {});

      // Register the child PID if we have a worktree path
      if (child.pid && worktreePath) {
        registerProcess(child.pid, worktreePath);
      }

      let stdout = '';
      let stderr = '';

      if (child.stdout) {
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      }
      if (child.stderr) {
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      }

      child.on('close', (code: number | null) => {
        const result: TrackedExecResult = {
          stdout,
          stderr,
          exitCode: code ?? -1,
        };
        if (code === 0) {
          resolve(result);
        } else {
          const err = new Error(
            `Command failed with exit code ${code}: ${command}\n${stderr}`
          ) as any;
          err.stdout = stdout;
          err.stderr = stderr;
          err.code = code;
          reject(err);
        }
      });

      child.on('error', (err: Error) => {
        reject(err);
      });
    });
  };
}

/**
 * Register the current Node.js process PID with the lifecycle module.
 * Intended for use by CLI entry points to self-register.
 *
 * @param worktreePath - The worktree path this process is operating in
 */
export function registerCurrentProcess(worktreePath: string): void {
  registerProcess(process.pid, worktreePath);
}

// ── Context-based exec ─────────────────────────────────────────────

/**
 * Stack of worktree contexts. When a context is active, `contextExec`
 * uses the innermost context to register PIDs automatically.
 */
const contextStack: string[] = [];

/**
 * Set the current worktree context for subsequent `contextExec` calls.
 *
 * Returns a restore function that reverts to the previous context
 * (or clears it if no prior context).
 *
 * @param worktreePath - The worktree path to set as current context
 * @returns A function to restore the previous context
 */
export function withinWorktreeContext(worktreePath: string): () => void {
  contextStack.push(worktreePath);
  return function restore(): void {
    if (contextStack.length > 0) {
      contextStack.pop();
    }
  };
}

/**
 * Execute a command using the current worktree context (set via
 * `withinWorktreeContext`). The spawned PID is automatically
 * registered with the lifecycle module.
 *
 * If no context is active, the command runs without PID registration.
 *
 * @param command - The shell command to execute
 * @param options - Optional exec options
 */
export async function contextExec(
  command: string,
  options?: any
): Promise<TrackedExecResult> {
  const worktreePath =
    contextStack.length > 0
      ? contextStack[contextStack.length - 1]
      : null;
  const trackedExec = createTrackedExec(worktreePath);
  return trackedExec(command, options);
}

// ── Auto-start watchdog ─────────────────────────────────────────────
// Start the watchdog with defaults when the module is first imported.
startWatchdog();
