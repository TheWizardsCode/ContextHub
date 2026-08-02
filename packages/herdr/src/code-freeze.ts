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
