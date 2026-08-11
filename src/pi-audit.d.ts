/**
 * Pi-based audit module.
 *
 * Replaces the opencode audit implementation with one that uses the
 * Pi framework and wl CLI for audit execution.
 *
 * This module runs an audit for a given work item by:
 * 1. Fetching the work item via `wl show --json`
 * 2. Generating a structured audit report
 * 3. Returning the audit text for display
 */
import { spawn } from "child_process";
type SpawnFn = typeof spawn;
export interface RunPiAuditOptions {
    workItemId: string;
    cwd?: string;
    timeoutMs?: number;
    wlBin?: string;
    spawnImpl?: SpawnFn;
    signal?: AbortSignal;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
}
export interface RunPiAuditResult {
    auditText: string;
    terminatedOnWait: boolean;
    exitCode: number;
    selectedMessageParts?: Array<{
        text: string;
        type?: string;
    }>;
}
/**
 * Resolve the wl binary path.
 */
export declare function resolveWlBinary(explicit?: string): string;
/**
 * Run a Pi-based audit for a work item.
 * Replaces the opencode audit with a wl CLI-based audit.
 */
export declare function runPiAudit(options: RunPiAuditOptions): Promise<RunPiAuditResult>;
/**
 * Check if an event indicates waiting for input.
 * Kept for compatibility with the old API.
 */
export declare function isWaitingForInputEvent(_event: unknown): boolean;
/**
 * Resolve the opencode binary - now resolves to wl for Pi-based audit.
 */
export declare function resolveOpencodeBinary(explicit?: string): string;
/**
 * Main audit entry point - provides a drop-in replacement for runOpencodeAudit.
 */
export declare function runAudit(options: RunPiAuditOptions): Promise<RunPiAuditResult>;
export {};
//# sourceMappingURL=pi-audit.d.ts.map