/**
 * packages/herdr/src/downtime-round-robin-by-root.ts — Global per-`worklogRoot`
 * round-robin cursor for fair multi-project dispatch.
 *
 * Parent: WL-0MTJ7IEI80055V2V (Fair round-robin work scheduling with priority
 * override).
 *
 * Provides a durable, fail-open cursor that tracks the last-dispatched
 * `worklogRoot` (project) so that `dispatchFromCoordination` can select the
 * least-recently-served project in global cross-project round-robin order.
 *
 * File format (JSON): `{ "<worklogRoot>": <ISO-8601 timestamp>, ... }`
 *
 * - Each entry maps a `worklogRoot` to the UTC timestamp of its last dispatch.
 * - New / unknown roots sort first (never penalised).
 * - Missing file, empty file, or corrupt JSON → empty state (fail-open).
 * - Writes use atomic tmp+rename (same pattern as `coordination.ts`).
 * - Read-modify-write is guarded by the same coordination-lock mechanism
 *   (`tryAcquireCoordLock`) used for the coordination file — concurrent
 *   leaders do not corrupt the cursor.
 *
 * Fail-open by contract: a missing or unreadable cursor file degrades to
 * "no history" — entries are ordered in the original file order, which is the
 * pre-refactor behaviour. The cursor never blocks dispatch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryAcquireCoordLock } from './coordination.js';

// ── Constants ───────────────────────────────────────────────────────────

/** Round-robin cursor file name (inside the coordination directory). */
export const ROUND_ROBIN_BY_ROOT_FILE_NAME = 'downtime-round-robin-by-root.json';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Shape of the round-robin cursor file: `{ worklogRoot → ISO-8601 timestamp }`.
 * Absence of a key means that root has never been dispatched (new/unknown
 * roots sort first).
 */
export interface RoundRobinByRootData {
  [worklogRoot: string]: string;
}

// ── Path resolution ────────────────────────────────────────────────────

/** Resolve the cursor file path inside the coordination directory. */
function cursorFilePath(coordinationDir: string): string {
  return path.join(coordinationDir, ROUND_ROBIN_BY_ROOT_FILE_NAME);
}

// ── Load / Save ────────────────────────────────────────────────────────

/**
 * Load the round-robin cursor state from disk.
 *
 * **Fail-open:** missing file, empty file, or corrupt JSON → returns an
 * empty object (no history). The caller treats this as "all roots equally
 * recent" and falls back to file-order selection.
 *
 * @param coordinationDir — The coordination directory (machine dir).
 * @returns The parsed cursor data, or `{}` on any failure.
 */
export function loadRoundRobinCursor(coordinationDir: string): RoundRobinByRootData {
  try {
    const fp = cursorFilePath(coordinationDir);
    const content = fs.readFileSync(fp, 'utf-8');
    if (!content.trim()) return {};
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    // Validate: every key must be a string, every value an ISO-8601 string.
    const data = parsed as Record<string, unknown>;
    const result: RoundRobinByRootData = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'string') {
        // Basic ISO-8601 validation: must parse to a finite date.
        const ts = new Date(value).getTime();
        if (Number.isFinite(ts)) {
          result[key] = value;
        }
      }
    }
    return result;
  } catch {
    // Missing, unreadable, corrupt → fail-open: no history.
    return {};
  }
}

/**
 * Atomically write the round-robin cursor state to disk.
 *
 * Uses tmp+rename for atomicity (same pattern as `coordination.ts`): a
 * concurrent write can never observe a partially-written JSON, and a crash
 * between the tmp write and the rename leaves the previous file intact.
 *
 * **Fail-open:** I/O failure is silently tolerated — the cursor state is
 * lost for this cycle but dispatch is not blocked.
 *
 * @param coordinationDir — The coordination directory.
 * @param data — The cursor state to persist.
 */
export function saveRoundRobinCursor(
  coordinationDir: string,
  data: RoundRobinByRootData,
): void {
  try {
    const fp = cursorFilePath(coordinationDir);
    const tmpPath = `${fp}.tmp`;
    fs.mkdirSync(coordinationDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmpPath, fp);
  } catch {
    // I/O failure — fail-open, dispatch continues.
  }
}

// ── Locking ────────────────────────────────────────────────────────────

// Re-export for external callers that guard cursor R-M-W externally.
export { tryAcquireCoordLock };

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Get the next entry to dispatch, ordered by least-recently-served first.
 *
 * Among the provided roots:
 *  1. **Unknown / new roots** (not in the cursor) sort first — they are
 *     never penalised for not having dispatch history.
 *  2. Among known roots, the one with the **oldest** last-served timestamp
 *     is selected first (global cross-project round-robin).
 *  3. Ties among known roots are broken by alphabetical root name (deterministic).
 *
 * After selection, the cursor is advanced: the chosen root's timestamp is
 * updated to `now` (its last-served time) and persisted atomically.
 *
 * **Fail-open:** if the cursor file is missing/corrupt or the lock cannot
 * be acquired, returns the first root from the input array (original file
 * order) — the pre-refactor behaviour.
 *
 * @param coordinationDir — The coordination directory.
 * @param roots — The candidate `worklogRoot` values.
 * @param now — Current timestamp (ISO-8601 or `Date.now()`).
 * @returns The selected root, or `null` when no roots are provided.
 */
export function selectLeastRecentlyServed(
  coordinationDir: string,
  roots: string[],
  now: number = Date.now(),
): string | null {
  if (roots.length === 0) return null;

  // Acquire coordination lock to protect cursor R-M-W.
  const release = tryAcquireCoordLock(coordinationDir);
  if (release === null) {
    // Lock contention — fail-open to original file order.
    return roots[0];
  }

  try {
    return selectLeastRecentlyServedLocked(coordinationDir, roots, now);
  } finally {
    release();
  }
}

/**
 * Internal: cursor selection under lock.
 *
 * 1. Load cursor state (fail-open → `{}`).
 * 2. Partition roots into known (in cursor) and unknown (new).
 * 3. Unknown roots sort first — pick the first unknown.
 * 4. Among known roots, pick the one with the oldest timestamp.
 * 5. Advance the cursor: update the selected root's timestamp to `now`.
 * 6. Persist the updated cursor atomically.
 * 7. Return the selected root.
 */
function selectLeastRecentlyServedLocked(
  coordinationDir: string,
  roots: string[],
  nowMs: number,
): string {
  const data = loadRoundRobinCursor(coordinationDir);
  const isoNow = new Date(nowMs).toISOString();

  // Partition into unknown (new) and known.
  const unknownRoots: string[] = [];
  const knownRoots: { root: string; timestamp: string }[] = [];

  for (const root of roots) {
    if (root in data) {
      knownRoots.push({ root, timestamp: data[root] });
    } else {
      unknownRoots.push(root);
    }
  }

  let selected: string;

  // Unknown roots sort first (never penalised).
  if (unknownRoots.length > 0) {
    // Pick the first unknown root (alphabetical for determinism).
    unknownRoots.sort();
    selected = unknownRoots[0];
  } else {
    // Among known roots, pick the one with the oldest timestamp.
    // Ties broken by alphabetical root name.
    knownRoots.sort((a, b) => {
      const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.root < b.root ? -1 : a.root > b.root ? 1 : 0;
    });
    selected = knownRoots[0].root;
  }

  // Advance: update the selected root's timestamp.
  data[selected] = isoNow;
  saveRoundRobinCursor(coordinationDir, data);

  return selected;
}

/**
 * Advance the cursor for a single root without selecting.
 *
 * Records that the given root was just dispatched, updating its last-served
 * timestamp. This is called after a dispatch (or spawn-failed / marker-write-
 * failed claim that still consumes the entry).
 *
 * **Fail-open:** if the lock cannot be acquired, the cursor state is lost
 * for this cycle but dispatch is not blocked.
 *
 * @param coordinationDir — The coordination directory.
 * @param root — The `worklogRoot` that was just dispatched.
 * @param now — Current timestamp.
 */
export function advanceRoot(
  coordinationDir: string,
  root: string,
  now: number = Date.now(),
): void {
  if (root.length === 0) return;

  const release = tryAcquireCoordLock(coordinationDir);
  if (release === null) {
    // Lock contention — fail-open, cursor state lost for this cycle.
    return;
  }

  try {
    const data = loadRoundRobinCursor(coordinationDir);
    data[root] = new Date(now).toISOString();
    saveRoundRobinCursor(coordinationDir, data);
  } finally {
    release();
  }
}
