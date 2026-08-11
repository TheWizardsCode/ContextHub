import * as childProcess from 'child_process';
import type { WorkItem, Comment, WorkItemPriority, WorkItemStatus } from '../../src/types.js';
/** Set of tracked child process PIDs */
export declare const pidTrackingSet: Set<number>;
/**
 * Kill a PID and all its descendants (process tree).
 *
 * On POSIX systems children spawned via `child_process.spawn`/`exec` with a
 * shell share the shell's process group. Killing the shell PID alone leaves
 * the actual command (e.g. `tsx src/cli.ts --json create`) and its own
 * children (e.g. the node CLI process) orphaned with ppid=1 — exactly the
 * leak seen in WL-0MSB447TJ000R3N8. We therefore kill the process group
 * (`-pid`) first, which terminates every member of the tree, and fall back
 * to a plain PID kill when no process group exists.
 */
export declare function killProcessTree(pid: number, signal?: NodeJS.Signals): void;
/**
 * Send SIGTERM to all tracked process trees and clear the tracking set.
 * Safe to call multiple times; already-exited PIDs are silently ignored.
 */
export declare function killTrackedProcesses(): void;
export declare function execAsync(command: string, options?: childProcess.ExecOptions & {
    timeout?: number;
}): Promise<{
    stdout: string;
    stderr: string;
}>;
export declare const cliPath: string;
export declare function execWithInput(command: string, input: string, options?: childProcess.ExecOptions): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
}>;
export declare function enterTempDir(): {
    tempDir: string;
    originalCwd: string;
};
export declare function leaveTempDir(state: {
    tempDir: string;
    originalCwd: string;
}): void;
/**
 * Kill any stale `wl`/`worklog` CLI processes whose command line matches a
 * substring (e.g. a test worktree slug like `init-pre-push-guards`).
 *
 * Test-spawned `wl create` processes can outlive the test worker when the
 * worker is killed with SIGKILL (vitest timeout / worktree cleanup): the
 * `tsx`/`node` grandchildren are reparented to init (ppid=1) with a deleted
 * cwd and hang forever. This helper provides a belt-and-suspenders sweep for
 * CI teardown and for manual cleanup of known test worktrees.
 *
 * @param match - Substring to match against the process command line.
 * @param signal - Signal to send (default SIGKILL — hung processes may not
 *                 handle SIGTERM; the CLI is stateless so SIGKILL is safe).
 * @returns The number of processes killed.
 */
export declare function killStaleWlProcesses(match: string, signal?: NodeJS.Signals): number;
export declare function writeConfig(dir: string, projectName?: string, prefix?: string): void;
export declare function writeInitSemaphore(dir: string, version?: string, initializedAt?: string): void;
/**
 * Read the package.json version from the project root so tests use the
 * same single source of truth as the application.
 */
export declare function getPackageVersion(): string;
export declare function seedWorkItems(dir: string, items: Array<{
    id?: string;
    title: string;
    description?: string;
    status?: WorkItemStatus;
    priority?: WorkItemPriority;
    parentId?: string | null;
    tags?: string[];
    assignee?: string;
    stage?: string;
    needsProducerReview?: boolean;
    githubIssueNumber?: number;
    githubIssueId?: number;
    githubIssueUpdatedAt?: string;
    audit?: {
        time: string;
        author: string;
        text: string;
    };
}>, comments?: Comment[], auditResults?: Array<{
    workItemId: string;
    readyToClose: boolean;
    auditedAt: string;
    summary?: string | null;
    rawOutput?: string | null;
    author?: string | null;
}>): WorkItem[];
//# sourceMappingURL=cli-helpers.d.ts.map