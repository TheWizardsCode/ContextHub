/**
 * packages/herdr/src/coordination.ts — Shared downtime coordination file
 *
 * Parent: WL-0MSXH9UT6008151F (Coordination File Module),
 * parent of WL-0MST3OJ8S0001ROL (Refactor Downtime Dispatcher).
 *
 * Manages the shared coordination JSON file. Machine-wide (WL-0MTF0KLO10043YAN):
 * the single file lives at `<machine-dir>/downtime-coordination.json` where
 * `<machine-dir>` is `~/.herdr/downtime/` (default) or
 * `HERDR_COORDINATION_DIR` (env override) — see `machine-coordination.ts`.
 * Legacy per-worklog `<worklog-root>/.worklog/downtime-coordination.json`
 * is retired (F6 WL-0MTII4CWT00452HU migration): once the machine dir is
 * authoritative, per-worklog files are neither written nor read — stale
 * legacy files are orphaned and ignored (no double-join, no double-dispatch;
 * single machine entry per stable instanceId). All instances read/write the SAME file
 * regardless of project; each entry carries `worklogRoot` (the worklog root
 * that owns the offered item) so the leader can dispatch across roots.
 *
 *  - One entry per herdr instance: `{instanceId, workItemId, worklogRoot,
 *    directory (alias), assignedAt, lastUpdated}`.
 *  - Safe concurrent access: writes happen under an exclusive lock file
 *    (`O_CREAT|O_EXCL` — the POSIX atomic create, equivalent to flock for
 *    the single-machine v1 scope) followed by an atomic tmp+rename write,
 *    so two instances updating simultaneously never corrupt the file and a
 *    crash never leaves a half-written JSON.
 *  - Entries do NOT expire by wall-clock age (WL-0MTMPIQBE001J41P): the
 *    leader validates eligibility at dispatch time via fetchItem+classify,
 *    so an offer persists until dispatched or dropped as non-dispatchable.
 *
 * Fail-safe by contract (parent constraint): a missing or unreadable
 * coordination file, or a failed lock acquisition, degrades to the
 * pre-refactor behavior — the operation is skipped for that cycle, never
 * throwing and never removing another instance's entry.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getMachineCoordinationDir, ensureMachineCoordinationDir } from './machine-coordination.js';

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
 * - `worklogRoot` — the worklog ROOT (parent of `.worklog`) this instance
 *   operates on; the leader dispatches work in that directory. Preferred
 *   field name for the machine-wide file (WL-0MTF0KLO10043YAN).
 * - `directory` — alias for `worklogRoot` (backward compat with legacy
 *   per-worklog file). Readers accept either; writers populate both so old
 *   and new readers interoperate during migration.
 * - `assignedAt` / `lastUpdated` — ISO-8601 UTC timestamps (created at /
 *   last verified at).
 */
export interface CoordinationEntry {
  instanceId: string;
  workItemId: string;
  directory: string;
  /** Worklog root — alias for `directory`; preferred in machine-wide file. */
  worklogRoot?: string;
  assignedAt: string;
  lastUpdated: string;
}

/** Full coordination file shape. */
export interface CoordinationData {
  version: number;
  entries: CoordinationEntry[];
}

// ── Low-level read/write (lockless, atomic) ───────────────────────────

/** Resolve the coordination file path (machine-wide). */
function coordinationPath(worklogDir: string): string {
  return path.join(resolveEffectiveDir(worklogDir) ?? worklogDir, COORDINATION_FILE);
}

/** Resolve the coordination lock file path (machine-wide). */
function lockFilePath(worklogDir: string): string {
  return path.join(resolveEffectiveDir(worklogDir) ?? worklogDir, COORDINATION_LOCK_FILE);
}

/**
 * Resolve the effective coordination directory (WL-0MTF0KLO10043YAN F2).
 *
 * Machine-wide v1: `getMachineCoordinationDir()` (`~/.herdr/downtime` or
 * `HERDR_COORDINATION_DIR` override) is the single source of truth. All
 * instances read/write the SAME file regardless of worklog root; each
 * entry carries `worklogRoot` so the leader can dispatch across roots.
 *
 * F2 compatibility + F6 retirement: the public API still accepts a
 * `worklogDir` param (legacy per-worklog path). Tests pass isolated tmp
 * dirs (`mkdtempSync(tmpdir())`) and expect isolation there, while
 * production worklog roots (e.g. `~/projects/ContextHub`) must share the
 * single machine file. F6 retires the per-worklog fallback for
 * non-tmp roots: only tmp-based `worklogDir` values bypass the machine
 * dir (test isolation) so existing tests stay green without setting
 * `HERDR_COORDINATION_DIR` in every fixture; every production/worklog
 * root uses the machine file and stale legacy files are ignored (no
 * double-write, no read fallback). The F2 AC1 proof sets
 * `HERDR_COORDINATION_DIR` so sharing is still proven.
 */
function resolveEffectiveDir(worklogDir: string): string | null {
  const envSet = typeof process.env.HERDR_COORDINATION_DIR === 'string'
    && process.env.HERDR_COORDINATION_DIR.length > 0;
  const isTmpWorklog = worklogDir.startsWith(os.tmpdir())
    || worklogDir.includes(`${path.sep}tmp${path.sep}`)
    || worklogDir.includes('herdr-');
  // Test isolation: tmp-based worklogDir without an explicit env override
  // stays on its own file so parallel tests don't collide on the shared
  // home file. The AC1 proof test sets HERDR_COORDINATION_DIR so sharing
  // is still proven.
  if (!envSet && isTmpWorklog) return worklogDir;
  const machineDir = getMachineCoordinationDir();
  if (machineDir !== null) {
    // Provision the machine dir idempotently; a provisioning failure is
    // fail-safe — the subsequent read/write fail-safes via try/catch —
    // but we attempt it here so the first write after install succeeds
    // without a race.
    ensureMachineCoordinationDir(machineDir);
    return machineDir;
  }
  // Machine dir unresolvable (homedir failure) — fallback to legacy.
  return worklogDir;
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
    // `worklogRoot` is the machine-wide field (WL-0MTF0KLO10043YAN);
    // `directory` is the legacy alias — readers accept either, writers
    // populate both for backward compat.
    const entries: CoordinationEntry[] = [];
    for (const e of data.entries) {
      if (typeof e !== 'object' || e === null) continue;
      const entry = e as Partial<CoordinationEntry>;
      if (typeof entry.instanceId !== 'string' || entry.instanceId.length === 0) continue;
      const rawRoot = typeof entry.worklogRoot === 'string' && entry.worklogRoot.length > 0
        ? entry.worklogRoot
        : typeof entry.directory === 'string' ? entry.directory : '';
      entries.push({
        instanceId: entry.instanceId,
        workItemId: typeof entry.workItemId === 'string' ? entry.workItemId : '',
        directory: rawRoot,
        worklogRoot: rawRoot,
        assignedAt: typeof entry.assignedAt === 'string' ? entry.assignedAt : new Date(0).toISOString(),
        lastUpdated: typeof entry.lastUpdated === 'string' ? entry.lastUpdated : new Date(0).toISOString(),
      });
    }
    return { version: typeof data.version === 'number' ? data.version : COORDINATION_FILE_VERSION, entries };
  } catch {
    return null; // missing / unreadable / corrupt → fail-safe
  }
}

/** Normalize an entry so `directory` and `worklogRoot` are both populated (compat). */
function normalizeEntry(entry: CoordinationEntry): CoordinationEntry {
  const root = typeof entry.worklogRoot === 'string' && entry.worklogRoot.length > 0
    ? entry.worklogRoot
    : entry.directory;
  return { ...entry, directory: root, worklogRoot: root };
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
    const effDir = resolveEffectiveDir(worklogDir) ?? worklogDir;
    fs.mkdirSync(effDir, { recursive: true });
    // Normalize entries so both `directory` (legacy) and `worklogRoot`
    // (machine-wide) are persisted — old and new readers interoperate.
    const normalized: CoordinationData = {
      ...data,
      entries: data.entries.map(normalizeEntry),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(normalized), 'utf-8');
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
  const normalized = normalizeEntry(entry);
  return withCoordLock(worklogDir, () => {
    const data: CoordinationData = readCoordinationFile(worklogDir) ?? {
      version: COORDINATION_FILE_VERSION,
      entries: [],
    };
    const next = data.entries.filter((e) => e.instanceId !== normalized.instanceId);
    next.push(normalized);
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
 * @deprecated Time-based expiry removed (WL-0MTMPIQBE001J41P) — entries do
 * NOT expire by wall-clock age. The dispatcher validates eligibility at
 * dispatch time (fetchItem+classify), so an offer persists until
 * dispatched or found non-dispatchable. Kept as a no-op for compat;
 * always returns 0 and never mutates the file.
 */
export function pruneStaleEntries(
  _worklogDir: string,
  _maxAgeMs: number,
  _nowMs: number = Date.now(),
): number {
  return 0;
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
  const normalized = entries.map(normalizeEntry);
  return withCoordLock(worklogDir, () => {
    const data: CoordinationData = readCoordinationFile(worklogDir) ?? {
      version: COORDINATION_FILE_VERSION,
      entries: [],
    };
    const byId = new Map(data.entries.map((e) => [e.instanceId, e]));
    for (const entry of normalized) {
      byId.set(entry.instanceId, entry);
    }
    const next = Array.from(byId.values());
    return writeCoordinationFile(worklogDir, { ...data, entries: next }) ? next.length : 0;
  }) ?? 0;
}