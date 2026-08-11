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
const DEFAULT_TIMEOUT_MS = 180_000;
const FORCE_KILL_AFTER_MS = 1_500;
/**
 * Resolve the wl binary path.
 */
export function resolveWlBinary(explicit) {
    if (explicit && explicit.trim() !== '')
        return explicit.trim();
    if (process.env.WL_BIN && process.env.WL_BIN.trim() !== '') {
        return process.env.WL_BIN.trim();
    }
    return 'wl';
}
/**
 * Fetch a work item by ID using the wl CLI.
 */
async function fetchWorkItem(id, cwd, spawnImpl) {
    const wlBin = resolveWlBinary();
    const spawnFn = spawnImpl ?? spawn;
    return new Promise((resolve, reject) => {
        const child = spawnFn(wlBin, ["show", id, "--json"], {
            cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`wl show failed with exit code ${code}: ${stderr.trim()}`));
                return;
            }
            try {
                const data = JSON.parse(stdout);
                resolve(data);
            }
            catch (e) {
                reject(new Error(`Failed to parse wl show output: ${e instanceof Error ? e.message : String(e)}`));
            }
        });
        child.on("error", (err) => {
            reject(new Error(`Failed to start wl command: ${err.message}`));
        });
    });
}
/**
 * Generate an audit report for a work item.
 * This uses the wl CLI to fetch the work item and generates
 * a structured audit report.
 */
function generateAuditReport(item, id) {
    const title = item.title || "Untitled";
    const status = item.status || "unknown";
    const priority = item.priority || "medium";
    const type = item.issueType || "task";
    const stage = item.stage || "unknown";
    const assignee = item.assignee || "unassigned";
    const description = item.description || "No description";
    const children = item.children || [];
    const comments = item.comments || [];
    const lines = [
        `Audit Report for ${id}`,
        `=====================`,
        ``,
        `Title: ${title}`,
        `Status: ${status}`,
        `Priority: ${priority}`,
        `Type: ${type}`,
        `Stage: ${stage}`,
        `Assignee: ${assignee}`,
        ``,
        `Description:`,
        description.split("\n").slice(0, 10).map((l) => `  ${l}`).join("\n"),
        ``,
        `Children (${children.length}):`,
        children.length > 0
            ? children
                .map((c) => `  ${c.id}: ${c.title} [${c.status}] - ${c.stage || "no stage"}`)
                .join("\n")
            : "  None",
        ``,
        `Comments (${comments.length}):`,
        comments.length > 0
            ? comments
                .map((c, i) => `  C${i + 1}: ${c.author} - ${c.comment?.substring(0, 200) || "(no comment)"}`)
                .join("\n")
            : "  None",
        ``,
    ];
    return lines.join("\n");
}
/**
 * Run a Pi-based audit for a work item.
 * Replaces the opencode audit with a wl CLI-based audit.
 */
export async function runPiAudit(options) {
    const workItemId = options.workItemId?.trim();
    if (!workItemId) {
        throw new Error("workItemId is required for audit execution.");
    }
    const cwd = options.cwd;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const spawnImpl = options.spawnImpl ?? spawn;
    options.onStdoutLine?.(`Starting audit for ${workItemId}...`);
    // Run with timeout
    let timeoutTimer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => {
            reject(new Error(`Timed out after ${timeoutMs}ms while running audit.`));
        }, timeoutMs);
    });
    try {
        // Race between timeout and actual work
        const item = await Promise.race([
            fetchWorkItem(workItemId, cwd, spawnImpl),
            timeoutPromise,
        ]);
        if (timeoutTimer)
            clearTimeout(timeoutTimer);
        options.onStdoutLine?.(`Audit data fetched for ${workItemId}`);
        const auditText = generateAuditReport(item, workItemId);
        return {
            auditText,
            terminatedOnWait: false,
            exitCode: 0,
        };
    }
    catch (error) {
        if (timeoutTimer)
            clearTimeout(timeoutTimer);
        throw error;
    }
}
/**
 * Check if an event indicates waiting for input.
 * Kept for compatibility with the old API.
 */
export function isWaitingForInputEvent(_event) {
    // Not applicable for Pi-based audit (no SSE streaming)
    return false;
}
/**
 * Resolve the opencode binary - now resolves to wl for Pi-based audit.
 */
export function resolveOpencodeBinary(explicit) {
    return resolveWlBinary(explicit);
}
/**
 * Main audit entry point - provides a drop-in replacement for runOpencodeAudit.
 */
export async function runAudit(options) {
    return runPiAudit(options);
}
//# sourceMappingURL=pi-audit.js.map