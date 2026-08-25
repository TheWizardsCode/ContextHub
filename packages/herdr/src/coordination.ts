/**
 * packages/herdr/src/coordination.ts — Shared downtime coordination file
 *
 * Parent: WL-0MSXH9UT6008151F (Coordination File Module),
 * parent of WL-0MST3OJ8S0001ROL (Refactor Downtime Dispatcher).
 *
 * Manages the shared coordination JSON file at
 * `<worklog-root>/.worklog/downtime-coordination.json`:
 *
 *  - One entry per herdr instance: `{instanceId, workItemId, directory,
 *    assignedAt, lastUpdated}`.
 *  - Safe concurrent access: writes happen under an exclusive lock file
 *    (`O_CREAT|O_EXCL` — the POSIX atomic create, equivalent to flock for
 *    the single-machine v1 scope) followed by an atomic tmp+rename write,
 *    so two instances updating simultaneously never corrupt the file and a
 *    crash never leaves a half-written JSON.
 *  - The leader prunes stale entries (lastUpdated older than the 5-minute
 *    lease) on each dispatch cycle so crashed instances' items do not
 *    starve the queue.
 *
 * Fail-safe by contract (parent constraint): a missing or unreadable
 * coordination file, or a failed lock acquisition, degrades to the
 * pre-refactor behavior — the operation is skipped for that cycle, never
 * throwing and never removing another instance's entry.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Constants ──────────────────────────────────────────────────────────

/** Coordination file name (inside `.worklog/`). */
export const COORDINATION_FILE = 'downtime-coordination.json';

/** Exclusive lock file name used to serialize read-modify-write cycles. */
export const COORDINATION_LOCK_FILE = 'downtime-coordination.lock';

/** Current coordination file format version. */
export const COORDINATION_FILE_VERSION = 1;

// ── Types ──────────────────────────────────────────────────────────────

/**
 * One instance's contribution to the shared coordination list.
 *
 * - `instanceId` — unique herdr instance identifier.
 * - `workItemId` — the instance's most-important work item id.
 * - `directory` — the worklog ROOT (parent of `.worklog`) this instance
 *   operates on; the leader dispatches work in that directory.
 * - `assignedAt` / `lastUpdated` — ISO-8601 UTC timestamps (created at /
 *   last verified at).
 */
export interface CoordinationEntry {
  instanceId: string;
  workItemId: string;
  directory: string;
  assignedAt: string;
  lastUpdated: string;
}

/** Full coordination file shape. */
export interface CoordinationData {
  version: number;
  entries: CoordinationEntry[];
}

// ── Low-level read/write (lockless, atomic) ───────────────────────────

/** Resolve the coordination file path. */
function coordinationPath(worklogDir: string): string {
  return path.join(worklogDir, COORDINATION_FILE);
}

/** Resolve the coordination lock file path. */
function lockFilePath(worklogDir: string): string {
  return path.join(worklogDir, COORDINATION_LOCK_FILE);
}

/**
 * Read and parse the coordination file.
 *
 * FAIL-SAFE: a missing file returns `null` (the first-run state — the
 * caller creates it on the next write); an unreadable or corrupt file also
 * returns `null` so a broken coordination file can never crash an instance
 * or silently mislead a reader. Never throws.
 */
export function readCoordinationFile(worklogDir: string): CoordinationData | null {
  try {
    const content = fs.readFileSync(coordinationPath(worklogDir), 'utf-8');
    if (!content.trim()) return null;
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const data = parsed as Partial<CoordinationData>;
    if (!Array.isArray(data.entries)) return null;
    // Validate each entry minimally: it must be an object carrying an
    // instanceId string. Malformed entries are dropped (fail-safe).
    const entries: CoordinationEntry[] = [];
    for (const e of data.entries) {
      if (typeof e !== 'object' || e === null) continue;
      const entry = e as Partial<CoordinationEntry>;
      if (typeof entry.instanceId !== 'string' || entry.instanceId.length === 0) continue;
      entries.push({
        instanceId: entry.instanceId,
        workItemId: typeof entry.workItemId === 'string' ? entry.workItemId : '',
        directory: typeof entry.directory === 'string' ? entry.directory : '',
        assignedAt: typeof entry.assignedAt === 'string' ? entry.assignedAt : new Date(0).toISOString(),
        lastUpdated: typeof entry.lastUpdated === 'string' ? entry.lastUpdated : new Date(0).toISOString(),
      });
    }
    return { version: typeof data.version === 'number' ? data.version : COORDINATION_FILE_VERSION, entries };
  } catch {
    return null; // missing / unreadable / corrupt → fail-safe
  }
}

/**
 * Atomically write the coordination file (tmp + rename). A concurrent
 * writer can never observe a partially-written JSON, and a crash between
 * the tmp write and the rename leaves the previous file intact.
 * Returns false on I/O failure (fail-safe, never throws).
 */
export function writeCoordinationFile(worklogDir: string, data: CoordinationData): boolean {
  try {
    const fp = coordinationPath(worklogDir);
    const tmpPath = `${fp}.tmp`;
    fs.mkdirSync(worklogDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmpPath, fp);
    return true;
  } catch {
    return false;
  }
}

// ── Exclusive lock (flock-equivalent for v1) ──────────────────────────

/**
 * Try to acquire the coordination lock (atomic `O_CREAT|O_EXCL`).
 * Returns a release function, or null when another writer holds the lock.
 * The lock is a placeholder file; it never carries coordination data.
 */
export function tryAcquireCoordLock(worklogDir: string): (() => void) | null {
  try {
    const fp = lockFilePath(worklogDir);
    // Atomic exclusive create — fails (EEXIST) while another holder owns it.
    const fd = fs.openSync(fp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
    fs.closeSync(fd);
    return () => {
      try {
        fs.unlinkSync(fp);
      } catch {
        // already gone — ignore
      }
    };
  } catch {
    return null;
  }
}

/**
 * Run `fn` under the coordination lock. Reads and writes are serialized:
 * whichever instance acquires the lock first completes its read-modify-write
 * before the next instance proceeds. When the lock is held elsewhere
 * (concurrent update), the operation fails open — `fn` is never invoked and
 * `null` is returned (the caller skips this cycle).
 */
export function withCoordLock<T>(
  worklogDir: string,
  fn: () => T,
): T | null {
  const release = tryAcquireCoordLock(worklogDir);
  if (release === null) return null;
  try {
    return fn();
  } finally {
    release();
  }
}

// ── Entry management ──────────────────────────────────────────────────

/**
 * Add or update one instance's entry (read-modify-write under the lock).
 * When the entry already exists it is replaced with the new values
 * (the callers pass the fresh `workItemId`/`directory`/timestamps), so a
 * changed most-important item updates in place.
 *
 * Returns true when the entry was persisted, false on lock contention or
 * I/O failure (fail-safe — the instance retries at its next check-in).
 */
export function upsertEntry(
  worklogDir: string,
  entry: CoordinationEntry,
): boolean {
  if (entry.instanceId.length === 0) return false;
  return withCoordLock(worklogDir, () => {
    const data: CoordinationData = readCoordinationFile(worklogDir) ?? {
      version: COORDINATION_FILE_VERSION,
      entries: [],
    };
    const next = data.entries.filter((e) => e.instanceId !== entry.instanceId);
    next.push(entry);
    return writeCoordinationFile(worklogDir, { ...data, entries: next });
  }) ?? false;
}

/**
 * Remove one instance's entry (after the leader dispatched its item).
 * Returns the removed entry, or null when it was not present / the
 * operation failed (lock contention, I/O error — fail-safe).
 */
export function removeEntry(
  worklogDir: string,
  instanceId: string,
): CoordinationEntry | null {
  return withCoordLock(worklogDir, () => {
    const data = readCoordinationFile(worklogDir);
    if (data === null) return null;
    let removed: CoordinationEntry | null = null;
    const next = data.entries.filter((e) => {
      if (e.instanceId === instanceId) {
        removed = e;
        return false;
      }
      return true;
    });
    if (removed === null) return null;
    if (!writeCoordinationFile(worklogDir, { ...data, entries: next })) return null;
    return removed;
  }) ?? null;
}

/**
 * Read one instance's entry. Returns null when absent.
 * Fail-safe: missing/corrupt file → null.
 */
export function getEntry(
  worklogDir: string,
  instanceId: string,
): CoordinationEntry | null {
  const data = readCoordinationFile(worklogDir);
  if (data === null) return null;
  return data.entries.find((e) => e.instanceId === instanceId) ?? null;
}

/**
 * Prune entries whose `lastUpdated` is older than `maxAgeMs` (the leader
 * runs this on each dispatch cycle — the 5-minute lease bound). Crashed or
 * idle instances' stale items stop blocking the queue; their owners
 * re-add on their next check-in. Returns the number of entries removed.
 * Fail-safe: lock contention or I/O failure → 0 removed, never throws.
 */
export function pruneStaleEntries(
  worklogDir: string,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): number {
  return withCoordLock(worklogDir, () => {
    const data = readCoordinationFile(worklogDir);
    if (data === null) return 0;
    const before = data.entries.length;
    const next = data.entries.filter((e) => {
      const updated = new Date(e.lastUpdated).getTime();
      return Number.isFinite(updated) && nowMs - updated < maxAgeMs;
    });
    if (next.length === before) return 0;
    if (!writeCoordinationFile(worklogDir, { ...data, entries: next })) return 0;
    return before - next.length;
  }) ?? 0;
}

/**
 * Merge a set of instance entries into the file (batch upsert). Used at
 * startup / scheduled check-ins when multiple instances may need their
 * entries refreshed in one cycle. Returns the number of entries written.
 * Fail-safe: lock contention or I/O failure → 0.
 */
export function mergeEntries(
  worklogDir: string,
  entries: CoordinationEntry[],
): number {
  if (entries.length === 0) return 0;
  return withCoordLock(worklogDir, () => {
    const data: CoordinationData = readCoordinationFile(worklogDir) ?? {
      version: COORDINATION_FILE_VERSION,
      entries: [],
    };
    const byId = new Map(data.entries.map((e) => [e.instanceId, e]));
    for (const entry of entries) {
      byId.set(entry.instanceId, entry);
    }
    const next = Array.from(byId.values());
    return writeCoordinationFile(worklogDir, { ...data, entries: next }) ? next.length : 0;
  }) ?? 0;
}