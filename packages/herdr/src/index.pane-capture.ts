/**
 * packages/herdr/src/index.pane-capture.ts — pane-ID capture and work-item
 * extraction for the Herdr Worklog plugin.
 *
 * Polls the pane-ID file written by send-to-pi.sh/run-in-pane.sh after a
 * split and records the work-item ↔ pane association
 * (`capturePaneIdFromFile`), and extracts the work-item ID from an agent
 * command (`extractWorkItemId`, with the module-private
 * `WORK_ITEM_ID_PATTERN`). Extracted verbatim from
 * `packages/herdr/src/index.ts` (move-only, WL-0MVOA0MBH004KKL0, parent
 * WL-0MVGKGFFN009UCM6); the barrel re-exports the consumed symbols
 * (`CAPTURE_TIMEOUT_MS`, `capturePaneIdFromFile`, `extractWorkItemId`),
 * while `CAPTURE_POLL_INTERVAL_MS` and `PaneIdFileDeps` stay internal.
 * `AGENT_ASSIGNEE` moved with the claim section (phase 5,
 * `index.claim.ts`), which imports `extractWorkItemId` from this module.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { parsePaneIdFile } from './index.commands.js';

// ── Pane-ID capture (WL-0MSBQUJQX005RAT9) ─────────────────────────────

/** Poll interval for the pane-ID file capture loop. */
export const CAPTURE_POLL_INTERVAL_MS = 200;
/** Total time budget for the pane-ID file capture loop. */
export const CAPTURE_TIMEOUT_MS = 5000;

/**
 * Injectable filesystem/timer dependencies for {@link capturePaneIdFromFile}
 * (tests replace these so no real polling or temp files are needed).
 */
export interface PaneIdFileDeps {
  existsSync?: (p: string) => boolean;
  readFile?: (p: string) => string;
  unlink?: (p: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll for the pane-ID file written by send-to-pi.sh, record the
 * work-item ↔ pane association, and clean up the temp file.
 *
 * Fire-and-forget (never awaited by the TUI): the loop polls briefly for
 * the file so pane-ID capture never blocks the TUI event loop or changes
 * spawn behavior. A missing file (split failed) is a no-op — no entry is
 * recorded. All failures are swallowed (fail-open).
 *
 * @param workItemId - Work item the agent command was dispatched for.
 * @param paneIdFile - Path passed to send-to-pi.sh via `--pane-id-file`.
 * @param record - Records the association (typically
 *                 `tracker.recordAgentForWorkItem`).
 * @param deps - Injectable fs/timer dependencies (tests).
 * @returns The captured pane ID, or undefined on timeout.
 */
export async function capturePaneIdFromFile(
  workItemId: string,
  paneIdFile: string,
  record: (workItemId: string, paneId: string) => void | Promise<void>,
  deps: PaneIdFileDeps = {},
): Promise<string | undefined> {
  const existsSyncFn = deps.existsSync ?? ((p: string) => existsSync(p));
  const readFileFn = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const unlinkFn = deps.unlink ?? ((p: string) => { try { unlinkSync(p); } catch { /* ignore */ } });
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + CAPTURE_TIMEOUT_MS;

  while (now() < deadline) {
    if (existsSyncFn(paneIdFile)) {
      let raw: string | null = null;
      try {
        raw = readFileFn(paneIdFile);
      } catch {
        raw = null; // file mid-write — keep polling
      }
      const paneId = raw !== null ? parsePaneIdFile(raw) : undefined;
      if (paneId) {
        try {
          await record(workItemId, paneId);
        } catch {
          // Recording must never break dispatch; the temp file is still
          // cleaned up below.
        }
        unlinkFn(paneIdFile);
        return paneId;
      }
    }
    await sleep(CAPTURE_POLL_INTERVAL_MS);
  }
  // Timed out — the split may have failed or the file never appeared.
  return undefined;
}

/**
 * Work-item ID format: a prefix (e.g. `WL`, `SA`) followed by a hash,
 * e.g. `WL-0MS9NPHQU005Y3VE`.
 */
const WORK_ITEM_ID_PATTERN = /^[A-Z]+-\w+$/;

/**
 * Extract the work-item ID from an agent command string.
 *
 * Agent commands are typically `/intake <id>`, `/plan <id>`, or
 * `/skill:<name> <id>` with the ID as the last argument. All tokens are
 * scanned for the work-item ID pattern and the last match is returned.
 * Commands without an ID (e.g. `/intake` alone) return `undefined` and
 * skip the status update gracefully.
 */
export function extractWorkItemId(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (WORK_ITEM_ID_PATTERN.test(tokens[i])) {
      return tokens[i];
    }
  }
  return undefined;
}
