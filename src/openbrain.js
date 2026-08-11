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
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorklogDir } from './worklog-paths.js';
export const OPENBRAIN_QUEUE_FILE = 'openbrain-queue.jsonl';
/**
 * Detect whether verbose logging was requested. Honor WL_VERBOSE env var
 * (true/1/yes) or the presence of a global --verbose flag on process.argv.
 */
function isVerbose() {
    try {
        const ev = process.env.WL_VERBOSE;
        if (ev && String(ev).trim() !== '') {
            const v = String(ev).toLowerCase();
            return v === '1' || v === 'true' || v === 'yes';
        }
        return Array.isArray(process.argv) && process.argv.includes('--verbose');
    }
    catch {
        return false;
    }
}
/**
 * Build a concise markdown summary for a completed work item.
 */
export function buildOpenBrainSummary(item, auditResult) {
    const lines = [];
    lines.push(`# ${item.title}`);
    lines.push('');
    lines.push(`**Work item:** ${item.id}`);
    if (item.issueType)
        lines.push(`**Type:** ${item.issueType}`);
    if (item.assignee)
        lines.push(`**Assignee:** ${item.assignee}`);
    lines.push(`**Completed at:** ${item.updatedAt}`);
    lines.push('');
    if (item.description && item.description.trim() !== '') {
        lines.push('## Objective');
        lines.push('');
        lines.push(item.description.trim());
        lines.push('');
    }
    if (auditResult?.summary && auditResult.summary.trim() !== '') {
        lines.push('## What was done');
        lines.push('');
        lines.push(auditResult.summary.trim());
        lines.push('');
    }
    return lines.join('\n');
}
/**
 * Append a failed submission to the local retry queue.
 */
export function appendToQueue(entry, queueDir) {
    try {
        const dir = queueDir ?? resolveWorklogDir();
        const queuePath = path.join(dir, OPENBRAIN_QUEUE_FILE);
        const line = JSON.stringify(entry) + '\n';
        fs.appendFileSync(queuePath, line, 'utf-8');
        if (isVerbose()) {
            try {
                console.error(`[openbrain] queued submission to ${queuePath}: ${JSON.stringify(entry)}`);
            }
            catch (_) { /* ignore */ }
        }
    }
    catch (err) {
        // Best-effort — if we cannot write the queue, log in verbose mode but
        // never throw to avoid interfering with user flows.
        if (isVerbose()) {
            try {
                console.error(`[openbrain] failed to append to queue: ${err.message}`);
            }
            catch (_) { /* ignore */ }
        }
    }
}
/**
 * Submit a completed work item summary to OpenBrain asynchronously.
 *
 * Returns a Promise that resolves once the background process has been spawned
 * (not waited on) unless `waitForCompletion` is set to true.  Errors are
 * logged to stderr and, if the submission fails, the entry is written to the
 * local retry queue.
 */
export async function submitToOpenBrain(item, options = {}) {
    const obBin = options.obBin ?? resolveObBinary();
    const spawnImpl = options.spawnImpl ?? spawn;
    const summary = buildOpenBrainSummary(item); // auditResult intentionally omitted here; callers may pass it separately
    const verbose = options.verbose !== undefined ? Boolean(options.verbose) : isVerbose();
    if (verbose) {
        try {
            console.error(`[openbrain] submitToOpenBrain: obBin=${obBin} title=${JSON.stringify(item.title)} wait=${Boolean(options.waitForCompletion)}`);
        }
        catch (_) { /* ignore */ }
    }
    const run = () => new Promise((resolve) => {
        const args = ['add', '--stdin', '--title', item.title];
        // Non-blocking mode (default): spawn fully detached with stdout/stderr ignored,
        // write stdin, and return immediately without waiting for close.
        // This prevents `wl close` from being delayed by OpenBrain process lifetime.
        if (!options.waitForCompletion) {
            let child;
            try {
                const spawnOpts = { stdio: ['pipe', 'ignore', 'ignore'], detached: true };
                if (verbose) {
                    try {
                        console.error(`[openbrain] spawning (non-blocking): ${obBin} ${args.join(' ')} opts=${JSON.stringify(spawnOpts)}`);
                    }
                    catch (_) { /* ignore */ }
                }
                child = spawnImpl(obBin, args, spawnOpts);
            }
            catch (spawnErr) {
                const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
                console.error(`[openbrain] Failed to spawn ob: ${msg}`);
                appendToQueue({ workItemId: item.id, title: item.title, summary, enqueuedAt: new Date().toISOString(), reason: msg }, options.queueDir);
                resolve();
                return;
            }
            child.once('error', (err) => {
                const msg = err.message;
                console.error(`[openbrain] ob add error: ${msg}`);
                appendToQueue({ workItemId: item.id, title: item.title, summary, enqueuedAt: new Date().toISOString(), reason: msg }, options.queueDir);
            });
            const childStdin = child.stdin;
            if (childStdin) {
                childStdin.on('error', (err) => {
                    if (verbose) {
                        const code = err?.code ? ` code=${String(err.code)}` : '';
                        try {
                            console.error(`[openbrain] stdin write error:${code} ${err.message}`);
                        }
                        catch (_) { /* ignore */ }
                    }
                });
                try {
                    childStdin.write(summary, 'utf-8');
                    childStdin.end();
                }
                catch {
                    // Best-effort in non-blocking mode.
                }
            }
            try {
                child.unref();
            }
            catch { /* ignore */ }
            resolve();
            return;
        }
        // Wait mode (tests/explicit callers): preserve full close/error handling.
        let child;
        let alreadyQueued = false;
        let finished = false;
        const safeResolve = () => { if (!finished) {
            finished = true;
            resolve();
        } };
        try {
            const spawnOpts = { stdio: ['pipe', verbose ? 'pipe' : 'ignore', 'pipe'], detached: false };
            if (verbose) {
                try {
                    console.error(`[openbrain] spawning: ${obBin} ${args.join(' ')} opts=${JSON.stringify(spawnOpts)}`);
                }
                catch (_) { /* ignore */ }
            }
            child = spawnImpl(obBin, args, spawnOpts);
            if (verbose && child && child.pid) {
                try {
                    console.error(`[openbrain] spawned child pid=${child.pid}`);
                }
                catch (_) { /* ignore */ }
            }
        }
        catch (spawnErr) {
            const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
            console.error(`[openbrain] Failed to spawn ob: ${msg}`);
            if (verbose && spawnErr instanceof Error && spawnErr.stack) {
                try {
                    console.error(`[openbrain] spawn stack: ${spawnErr.stack}`);
                }
                catch (_) { /* ignore */ }
            }
            appendToQueue({ workItemId: item.id, title: item.title, summary, enqueuedAt: new Date().toISOString(), reason: msg }, options.queueDir);
            safeResolve();
            return;
        }
        const childStdin = child.stdin;
        if (childStdin) {
            childStdin.on('error', (err) => {
                if (verbose) {
                    const code = err?.code ? ` code=${String(err.code)}` : '';
                    try {
                        console.error(`[openbrain] stdin write error:${code} ${err.message}`);
                    }
                    catch (_) { /* ignore */ }
                }
            });
            try {
                childStdin.write(summary, 'utf-8');
                childStdin.end();
                if (verbose)
                    try {
                        console.error(`[openbrain] wrote ${String(summary.length)} bytes to child stdin`);
                    }
                    catch (_) { /* ignore */ }
            }
            catch {
                // Ignore synchronous write errors — we'll capture process outcome on close.
            }
        }
        const stderrLines = [];
        const stdoutLines = [];
        child.stderr?.on('data', (chunk) => {
            const s = chunk.toString();
            stderrLines.push(s);
            if (verbose)
                try {
                    console.error(`[openbrain] child stderr chunk: ${s.trim()}`);
                }
                catch (_) { /* ignore */ }
        });
        child.stdout?.on('data', (chunk) => {
            const s = chunk.toString();
            stdoutLines.push(s);
            if (verbose)
                try {
                    console.error(`[openbrain] child stdout chunk: ${s.trim()}`);
                }
                catch (_) { /* ignore */ }
        });
        child.once('error', (err) => {
            const msg = err.message;
            console.error(`[openbrain] ob add error: ${msg}`);
            if (verbose && err.stack)
                try {
                    console.error(`[openbrain] ob add error stack: ${err.stack}`);
                }
                catch (_) { /* ignore */ }
            alreadyQueued = true;
            appendToQueue({ workItemId: item.id, title: item.title, summary, enqueuedAt: new Date().toISOString(), reason: msg }, options.queueDir);
            safeResolve();
        });
        child.once('close', (code) => {
            const stderr = stderrLines.join('').trim();
            const stdout = stdoutLines.join('').trim();
            if (code !== 0) {
                if (!alreadyQueued) {
                    const reason = stderr || `ob add exited with code ${code}`;
                    console.error(`[openbrain] ob add failed (exit ${code}): ${reason}`);
                    if (verbose)
                        try {
                            console.error(`[openbrain] full stderr: ${stderr || '<empty>'}`);
                        }
                        catch (_) { /* ignore */ }
                    appendToQueue({ workItemId: item.id, title: item.title, summary, enqueuedAt: new Date().toISOString(), reason }, options.queueDir);
                }
                else if (verbose) {
                    try {
                        console.error(`[openbrain] close after error, already queued; code=${code}`);
                    }
                    catch (_) { /* ignore */ }
                }
            }
            else {
                if (verbose)
                    try {
                        console.error(`[openbrain] ob add exited 0 (success) for ${item.id}`);
                    }
                    catch (_) { /* ignore */ }
                if (verbose && stdout)
                    try {
                        console.error(`[openbrain] ob add stdout: ${stdout}`);
                    }
                    catch (_) { /* ignore */ }
            }
            if (verbose)
                try {
                    console.error(`[openbrain] child close code=${code} for ${item.id}`);
                }
                catch (_) { /* ignore */ }
            safeResolve();
        });
    });
    return run();
}
/**
 * Resolve the `ob` binary path, respecting the WL_OB_BIN environment variable.
 */
export function resolveObBinary(explicit) {
    if (explicit && explicit.trim() !== '')
        return explicit.trim();
    if (process.env.WL_OB_BIN && process.env.WL_OB_BIN.trim() !== '') {
        return process.env.WL_OB_BIN.trim();
    }
    return 'ob';
}
//# sourceMappingURL=openbrain.js.map