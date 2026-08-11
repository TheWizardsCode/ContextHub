/**
 * OpenBrain integration — asynchronous submission of completed work-item summaries.
 *
 * When a work item transitions to a completed/done state this module fires a
 * background process (`ob add`) that saves a concise markdown summary to the
 * OpenBrain knowledge-base.  The call is intentionally non-blocking: errors are
 * logged to stderr but never surfaced to the user flow that marked the item
 * complete.
 *
 * Fallback behaviour:
 *   - If `ob` is not on PATH the error is logged and silently swallowed.
 *   - If the submission fails for any reason a log entry is written to the
 *     OpenBrain queue file (.worklog/openbrain-queue.jsonl) so the entry can
 *     be retried later.
 */
import { spawn, type SpawnOptions } from 'child_process';
import type { WorkItem } from './types.js';
export declare const OPENBRAIN_QUEUE_FILE = "openbrain-queue.jsonl";
export interface OpenBrainQueueEntry {
    workItemId: string;
    title: string;
    summary: string;
    enqueuedAt: string;
    reason?: string;
}
/**
 * Build a concise markdown summary for a completed work item.
 */
export declare function buildOpenBrainSummary(item: WorkItem, auditResult?: {
    summary: string | null;
    readyToClose: boolean;
} | null): string;
/**
 * Append a failed submission to the local retry queue.
 */
export declare function appendToQueue(entry: OpenBrainQueueEntry, queueDir?: string): void;
export interface SubmitToOpenBrainOptions {
    /** Override the `ob` binary path (useful in tests). */
    obBin?: string;
    /** Override spawn implementation (useful in tests). */
    spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ReturnType<typeof spawn>;
    /** Override the queue directory (useful in tests). */
    queueDir?: string;
    /** When true, await completion before returning (useful in tests). */
    waitForCompletion?: boolean;
    /** When provided, force verbose logging on or off for this invocation. */
    verbose?: boolean;
}
/**
 * Submit a completed work item summary to OpenBrain asynchronously.
 *
 * Returns a Promise that resolves once the background process has been spawned
 * (not waited on) unless `waitForCompletion` is set to true.  Errors are
 * logged to stderr and, if the submission fails, the entry is written to the
 * local retry queue.
 */
export declare function submitToOpenBrain(item: WorkItem, options?: SubmitToOpenBrainOptions): Promise<void>;
/**
 * Resolve the `ob` binary path, respecting the WL_OB_BIN environment variable.
 */
export declare function resolveObBinary(explicit?: string): string;
//# sourceMappingURL=openbrain.d.ts.map