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
/** Metadata stored for each registered PID */
export interface ProcessMeta {
    readonly pid: number;
    readonly worktreePath: string;
    readonly registeredAt: number;
}
/** Public read-only view of the registry */
export type ProcessRegistry = Record<string, number[]>;
/**
 * Register a process PID under a worktree path.
 *
 * If the same PID is already registered for the same worktree, this is a
 * no-op. The same PID can be registered under different worktrees.
 *
 * @param pid - The process ID to track
 * @param worktreePath - The worktree path to associate with this PID
 */
export declare function registerProcess(pid: number, worktreePath: string): void;
/**
 * Kill all tracked PIDs for a specific worktree path.
 *
 * After killing, the PIDs and their metadata are removed from the registry.
 * If the worktree path is unknown, this is a no-op.
 *
 * @param worktreePath - The worktree path whose PIDs should be killed
 * @param signal - The signal to send (default: 'SIGTERM')
 */
export declare function killProcessesForWorktree(worktreePath: string, signal?: string): void;
/**
 * Kill all tracked PIDs across all worktrees.
 *
 * After killing, the entire registry is cleared.
 *
 * @param signal - The signal to send (default: 'SIGTERM')
 */
export declare function killAllTracked(signal?: string): void;
/**
 * Get a read-only snapshot of the process registry.
 *
 * Returns an object mapping worktree paths to arrays of PIDs.
 */
export declare function getTrackedProcesses(): ProcessRegistry;
/**
 * Get metadata for a specific PID.
 *
 * @returns The ProcessMeta object, or null if the PID is not tracked
 */
export declare function getProcessMeta(pid: number): ProcessMeta | null;
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
export declare function startWatchdog(checkIntervalMs?: number, timeoutMs?: number): void;
/**
 * Get the current watchdog check interval in milliseconds.
 */
export declare function getWatchdogInterval(): number;
/**
 * Get the current watchdog timeout threshold in milliseconds.
 */
export declare function getWatchdogTimeout(): number;
/**
 * Check whether the watchdog timer is currently running.
 */
export declare function isWatchdogRunning(): boolean;
/**
 * Shut down the process lifecycle module.
 *
 * - Stops the watchdog timer
 * - Clears all tracked PIDs (they are NOT killed — use killAllTracked()
 *   first if you want to kill them)
 *
 * This is intended for graceful shutdown of the module itself.
 */
export declare function shutdown(): void;
/**
 * Detect whether the given directory (or CWD) is inside a git worktree
 * managed by ContextHub (i.e., under `.worklog/worktrees/`).
 *
 * @param cwd - The directory to check (default: process.cwd())
 * @returns The worktree root path if inside one, or `null` otherwise
 */
export declare function detectWorktreeFromCwd(cwd?: string): string | null;
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
export declare function createTrackedExec(worktreePath: string | null): (command: string, options?: any) => Promise<TrackedExecResult>;
/**
 * Register the current Node.js process PID with the lifecycle module.
 * Intended for use by CLI entry points to self-register.
 *
 * @param worktreePath - The worktree path this process is operating in
 */
export declare function registerCurrentProcess(worktreePath: string): void;
/**
 * Set the current worktree context for subsequent `contextExec` calls.
 *
 * Returns a restore function that reverts to the previous context
 * (or clears it if no prior context).
 *
 * @param worktreePath - The worktree path to set as current context
 * @returns A function to restore the previous context
 */
export declare function withinWorktreeContext(worktreePath: string): () => void;
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
export declare function contextExec(command: string, options?: any): Promise<TrackedExecResult>;
//# sourceMappingURL=process-lifecycle.d.ts.map