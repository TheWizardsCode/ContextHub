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
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorklogDir } from './worklog-paths.js';
import type { WorkItem } from './types.js';

export const OPENBRAIN_QUEUE_FILE = 'openbrain-queue.jsonl';

export interface OpenBrainQueueEntry {
  workItemId: string;
  title: string;
  summary: string;
  enqueuedAt: string;
  reason?: string;
}

/**
 * Detect whether verbose logging was requested. Honor WL_VERBOSE env var
 * (true/1/yes) or the presence of a global --verbose flag on process.argv.
 */
function isVerbose(): boolean {
  try {
    const ev = process.env.WL_VERBOSE;
    if (ev && String(ev).trim() !== '') {
      const v = String(ev).toLowerCase();
      return v === '1' || v === 'true' || v === 'yes';
    }
    return Array.isArray(process.argv) && process.argv.includes('--verbose');
  } catch {
    return false;
  }
}

/**
 * Build a concise markdown summary for a completed work item.
 */
export function buildOpenBrainSummary(item: WorkItem): string {
  const lines: string[] = [];
  lines.push(`# ${item.title}`);
  lines.push('');
  lines.push(`**Work item:** ${item.id}`);
  if (item.issueType) lines.push(`**Type:** ${item.issueType}`);
  if (item.assignee) lines.push(`**Assignee:** ${item.assignee}`);
  lines.push(`**Completed at:** ${item.updatedAt}`);
  lines.push('');

  if (item.description && item.description.trim() !== '') {
    lines.push('## Objective');
    lines.push('');
    lines.push(item.description.trim());
    lines.push('');
  }

  if (item.audit?.text && item.audit.text.trim() !== '') {
    lines.push('## What was done');
    lines.push('');
    lines.push(item.audit.text.trim());
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Append a failed submission to the local retry queue.
 */
export function appendToQueue(entry: OpenBrainQueueEntry, queueDir?: string): void {
  try {
    const dir = queueDir ?? resolveWorklogDir();
    const queuePath = path.join(dir, OPENBRAIN_QUEUE_FILE);
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(queuePath, line, 'utf-8');
    if (isVerbose()) {
      try { console.error(`[openbrain] queued submission to ${queuePath}: ${JSON.stringify(entry)}`); } catch (_) { /* ignore */ }
    }
  } catch (err) {
    // Best-effort — if we cannot write the queue, log in verbose mode but
    // never throw to avoid interfering with user flows.
    if (isVerbose()) {
      try { console.error(`[openbrain] failed to append to queue: ${(err as Error).message}`); } catch (_) { /* ignore */ }
    }
  }
}

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
export async function submitToOpenBrain(
  item: WorkItem,
  options: SubmitToOpenBrainOptions = {}
): Promise<void> {
  const obBin = options.obBin ?? resolveObBinary();
  const spawnImpl = options.spawnImpl ?? spawn;
  const summary = buildOpenBrainSummary(item);

  const verbose = isVerbose();
  if (verbose) {
    try { console.error(`[openbrain] submitToOpenBrain: obBin=${obBin} title=${JSON.stringify(item.title)} wait=${Boolean(options.waitForCompletion)}`); } catch (_) { /* ignore */ }
  }

  const run = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        const args = ['add', '--stdin', '--title', item.title];
        const spawnOpts: SpawnOptions = { stdio: ['pipe', 'ignore', 'pipe'], detached: !options.waitForCompletion };
        if (verbose) {
          try { console.error(`[openbrain] spawning: ${obBin} ${args.join(' ')} opts=${JSON.stringify(spawnOpts)}`); } catch (_) { /* ignore */ }
        }
        child = spawnImpl(obBin, args, spawnOpts);
        if (verbose && child && (child as any).pid) {
          try { console.error(`[openbrain] spawned child pid=${(child as any).pid}`); } catch (_) { /* ignore */ }
        }
      } catch (spawnErr) {
        const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
        console.error(`[openbrain] Failed to spawn ob: ${msg}`);
        if (verbose && spawnErr instanceof Error && (spawnErr as any).stack) {
          try { console.error(`[openbrain] spawn stack: ${(spawnErr as any).stack}`); } catch (_) { /* ignore */ }
        }
        appendToQueue(
          { workItemId: item.id, title: item.title, summary, enqueuedAt: new Date().toISOString(), reason: msg },
          options.queueDir
        );
        resolve();
        return;
      }

      // Write the markdown summary to the child's stdin.
      try {
        child.stdin?.write(summary, 'utf-8');
        child.stdin?.end();
        if (verbose) try { console.error(`[openbrain] wrote ${String(summary.length)} bytes to child stdin`); } catch (_) { /* ignore */ }
      } catch {
        // Ignore write errors — we'll capture them on close.
      }

      const stderrLines: string[] = [];
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const s = chunk.toString();
        stderrLines.push(s);
        if (verbose) try { console.error(`[openbrain] child stderr chunk: ${s.trim()}`); } catch (_) { /* ignore */ }
      });

      child.once('error', (err) => {
        const msg = err.message;
        console.error(`[openbrain] ob add error: ${msg}`);
        if (verbose && (err as any).stack) try { console.error(`[openbrain] ob add error stack: ${(err as any).stack}`); } catch (_) { /* ignore */ }
        appendToQueue(
          { workItemId: item.id, title: item.title, summary, enqueuedAt: new Date().toISOString(), reason: msg },
          options.queueDir
        );
        resolve();
      });

      child.once('close', (code) => {
        const stderr = stderrLines.join('').trim();
        if (code !== 0) {
          const reason = stderr || `ob add exited with code ${code}`;
          console.error(`[openbrain] ob add failed (exit ${code}): ${reason}`);
          if (verbose) try { console.error(`[openbrain] full stderr: ${stderr || '<empty>'}`); } catch (_) { /* ignore */ }
          appendToQueue(
            { workItemId: item.id, title: item.title, summary, enqueuedAt: new Date().toISOString(), reason },
            options.queueDir
          );
        } else {
          if (verbose) try { console.error(`[openbrain] ob add exited 0 (success) for ${item.id}`); } catch (_) { /* ignore */ }
        }
        if (verbose) try { console.error(`[openbrain] child close code=${code} for ${item.id}`); } catch (_) { /* ignore */ }
        resolve();
      });

      // For non-waiting mode, detach from the event loop immediately after
      // attaching handlers so the parent process can exit without waiting.
      if (!options.waitForCompletion) {
        try { child.unref(); } catch { /* ignore */ }
        resolve();
      }
    });

  return run();
}

/**
 * Resolve the `ob` binary path, respecting the WL_OB_BIN environment variable.
 */
export function resolveObBinary(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit.trim();
  if (process.env.WL_OB_BIN && process.env.WL_OB_BIN.trim() !== '') {
    return process.env.WL_OB_BIN.trim();
  }
  return 'ob';
}
