/**
 * packages/herdr/src/code-freeze.ts — Code Freeze marker detection
 *
 * The project is in "Code Freeze" while a ship-it (dev→main release) process
 * is running. The ship skill writes a marker file so that consumers (the
 * herdr worklist, the implement skill) can refuse to start implementation
 * work until the release completes.
 *
 * Cross-repo marker contract (shared with the SorraAgents ship/implement
 * skills — see SA-0MSBU4OBU005WJNB):
 *
 *   Path:  <worklog-dir>/code-freeze.json
 *   Shape: { "active": true, "reason": "...", "startedAt": "<ISO>", "pid": <pid> }
 *
 * Semantics:
 *   - Marker present with `active: true`  → project is FROZEN
 *   - Marker absent                       → not frozen
 *   - Marker present with `active: false` → not frozen
 *   - Corrupt/unreadable marker           → not frozen (fail open)
 *
 * The plugin only READS the marker; writing/clearing it is the ship skill's
 * job (tracked in SorraAgents). Fail-open is deliberate: a broken or missing
 * marker must never block browsing the worklist.
 *
 * For fail-closed consumers (the downtime dispatcher, the ambiguous-marker
 * banner — WL-0MSQ0RPQP00636JY) the module also exposes a tri-state read
 * (`readCodeFreezeStatus`): frozen / not-frozen / ambiguous. A marker that
 * cannot be trusted (unreadable, corrupt, wrong shape) is 'ambiguous', which
 * the dispatcher treats as frozen — never dispatch implement/audit work
 * during a release just because the marker cannot be parsed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getWorklogDir } from './fetcher.js';

/** Filename of the code-freeze marker inside the worklog directory. */
export const CODE_FREEZE_MARKER_FILENAME = 'code-freeze.json';

/**
 * Parsed state of the code-freeze marker.
 */
export interface CodeFreezeState {
  /** Whether the project is currently frozen. */
  active: boolean;
  /** Optional human-readable reason (e.g. "ship release in progress"). */
  reason?: string;
  /** ISO-8601 timestamp of when the freeze started. */
  startedAt?: string;
  /** PID of the process that started the freeze (the ship release). */
  pid?: number;
}

/**
 * Resolve the marker file path for a worklog directory.
 *
 * When `worklogDir` is omitted, the currently configured worklog directory
 * (see `setWorklogDir` in fetcher.ts) is used — the same directory the
 * plugin passes to `wl --worklog-dir`. Returns an empty string when no
 * worklog directory is known (callers treat that as "not frozen").
 *
 * @param worklogDir - Optional explicit worklog directory (e.g. for tests).
 * @returns Absolute path to the marker file, or '' when unresolved.
 */
export function codeFreezeMarkerPath(worklogDir?: string): string {
  const dir = worklogDir ?? getWorklogDir();
  return dir ? join(dir, CODE_FREEZE_MARKER_FILENAME) : '';
}

/**
 * Read and parse the code-freeze marker.
 *
 * Fail-open: any error (missing file, unreadable file, invalid JSON, wrong
 * shape) yields `{ active: false }` — a broken marker never blocks work.
 *
 * @param worklogDir - Optional explicit worklog directory (defaults to the
 *                     configured worklog dir).
 * @returns The parsed marker state.
 */
export function readCodeFreezeState(worklogDir?: string): CodeFreezeState {
  const markerPath = codeFreezeMarkerPath(worklogDir);
  if (!markerPath) {
    return { active: false };
  }

  let raw: string;
  try {
    if (!existsSync(markerPath)) {
      return { active: false };
    }
    raw = readFileSync(markerPath, 'utf8');
  } catch {
    return { active: false };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      active: parsed.active === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
    };
  } catch {
    return { active: false };
  }
}

/**
 * Convenience check: is the project currently in Code Freeze?
 *
 * @param worklogDir - Optional explicit worklog directory.
 * @returns true when an active marker is present, false otherwise (fail open).
 */
export function isCodeFreezeActive(worklogDir?: string): boolean {
  return readCodeFreezeState(worklogDir).active;
}

// ── Tri-state read (WL-0MSQ0RPQP00636JY) ─────────────────────────────

/**
 * Tri-state interpretation of the code-freeze marker:
 *
 *  - `'frozen'`     — marker present with `active: true` (project frozen).
 *  - `'not-frozen'` — marker absent, or present with `active: false`.
 *  - `'ambiguous'`  — marker present but cannot be trusted: unreadable
 *                     file, corrupt JSON, or wrong shape (non-object, or
 *                     missing/non-boolean `active`). Callers that must fail
 *                     closed (the downtime dispatcher, the ambiguous-marker
 *                     banner) treat this as frozen.
 */
export type CodeFreezeStatus = 'frozen' | 'not-frozen' | 'ambiguous';

/**
 * Read the code-freeze marker as a tri-state status.
 *
 * `readCodeFreezeState` / `isCodeFreezeActive` keep their fail-open
 * semantics (everything not provably frozen reads as not-frozen) for
 * worklist browsing and shortcut blocking — this read ADDS the ability to
 * distinguish "not frozen" from "cannot tell", so fail-closed consumers
 * (the downtime dispatcher, the ambiguous-marker banner) can act on
 * ambiguity without changing any existing caller's behavior.
 *
 * @param worklogDir - Optional explicit worklog directory (defaults to the
 *                     configured worklog dir).
 * @returns 'frozen' when the marker is active, 'not-frozen' when it is
 *          absent or inactive, 'ambiguous' when it cannot be parsed.
 */
export function readCodeFreezeStatus(worklogDir?: string): CodeFreezeStatus {
  const markerPath = codeFreezeMarkerPath(worklogDir);
  if (!markerPath) {
    return 'not-frozen';
  }

  let raw: string;
  try {
    if (!existsSync(markerPath)) {
      return 'not-frozen';
    }
    raw = readFileSync(markerPath, 'utf8');
  } catch {
    // Unreadable file → cannot tell → ambiguous (fail-closed for dispatch).
    return 'ambiguous';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'ambiguous'; // corrupt JSON
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return 'ambiguous'; // wrong shape: array, string, number, null...
  }
  const active = (parsed as Record<string, unknown>).active;
  if (typeof active !== 'boolean') {
    return 'ambiguous'; // wrong shape: `active` missing or not a boolean
  }
  return active ? 'frozen' : 'not-frozen';
}

/**
 * Read the code-freeze tri-state for a worklog ROOT directory (the project
 * root that contains `.worklog/`) — e.g. the downtime worker's `cwd`. The
 * marker lives at `<root>/.worklog/code-freeze.json`.
 *
 * @param root - Worklog root directory (contains `.worklog/`).
 * @returns The tri-state freeze status for the root's marker.
 */
export function readCodeFreezeStatusForRoot(root: string): CodeFreezeStatus {
  return readCodeFreezeStatus(join(root, '.worklog'));
}
