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
 *    directory (alias), assignedAt, lastUpdated}`. Since v2
 *    (WL-0MWDDHQON0015T3P AC1) the offer payload is a bounded `offers` array
 *    (at most one nominee per bucket, at most three total; duplicate
 *    `(kind, workItemId)` pairs collapse) and `workItemId` mirrors the FIRST
 *    offer so a v1-era leader keeps reading the first offer and ignoring the
 *    rest (parent AC9 backward compatibility).
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
import { DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS } from './downtime-worker.constants.js';

// ── Constants ──────────────────────────────────────────────────────────

/** Coordination file name (inside `.worklog/`). */
export const COORDINATION_FILE = 'downtime-coordination.json';

/** Exclusive lock file name used to serialize read-modify-write cycles. */
export const COORDINATION_LOCK_FILE = 'downtime-coordination.lock';

/**
 * Current coordination file format version.
 *
 * v2 (WL-0MWDDHQON0015T3P AC1): the offer payload is the tier-aware bounded
 * `offers` array (`implement` / `audit` / `prep` buckets). A v1 file (single
 * top-level `workItemId`, no `offers`) is migration-read as a one-offer entry
 * and rewritten as v2 on the next check-in; no v1 file is ever dropped by the
 * upgrade (AC1).
 */
export const COORDINATION_FILE_VERSION = 2;

/** Leader lock file name (mirrors `leader-election.ts`). */
export const LEADER_LEASE_FILE = 'downtime-leader-lease.json';

/**
 * How long a leader block stays believable (WL-0MW1VINII003IL7R).
 *
 * Two lease generations (the lease TTL is 300 s and the leader refreshes its
 * block on every leader check-in — 240 s). That tolerates one missed check-in
 * while a dead leader can never masquerade as live for more than two
 * generations. Read rule only: the block is written every check-in regardless.
 */
export const DEFAULT_LEADER_BLOCK_STALE_MS = 600_000;

// ── Types ──────────────────────────────────────────────────────────────

/**
 * One instance's contribution to the shared coordination list.
 *
 * - `instanceId` — unique herdr instance identifier.
 * - `workItemId` — the instance's most-important work item id. Since v2 it
 *   mirrors the FIRST `offers` entry (backward compat: a v1-era leader reads
 *   the first offer and ignores the rest — parent AC9).
 * - `offers` — v2 tier-aware offer payload (bounded: one nominee per bucket,
 *   at most three total; duplicate `(kind, workItemId)` pairs collapse).
 *   OPTIONAL so a legacy v1 shape (no `offers`) stays a valid entry and old
 *   writers/readers interoperate (parent AC1/AC9).
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
  /** v2 tier-aware offer payload (optional for legacy v1-shape entries). */
  offers?: CoordinationOffer[];
}

/**
 * The v2 offer buckets (parent WL-0MWDDHQON0015T3P AC1): the classifier
 * outputs with `plan` / `intake` / `risk-effort` unioning to `prep`. At most
 * one nominee per bucket, so at most three offers per entry.
 */
export type CoordinationOfferKind = 'implement' | 'audit' | 'prep';

/** The v2 per-bucket offer payload (one nominee per bucket, bounded total). */
export interface CoordinationOffer {
  kind: CoordinationOfferKind;
  workItemId: string;
}

/** Canonical bucket order used by the bounded-offers normalisation. */
export const COORDINATION_OFFER_BUCKETS: readonly CoordinationOfferKind[] = [
  'implement',
  'audit',
  'prep',
];

/**
 * Map a classifier skill kind — or an already-bucketed kind — to its v2
 * offer bucket (parent AC1): `implement`/`audit` stay; `prep` stays
 * (write paths feed bucket kinds directly); `plan`/`intake`/`risk-effort`
 * union to `prep`; anything else (null / unknown) maps to null (no offer).
 */
export function toOfferBucket(
  kind: string | null | undefined,
): CoordinationOfferKind | null {
  if (kind === 'implement' || kind === 'audit' || kind === 'prep') return kind;
  if (kind === 'plan' || kind === 'intake' || kind === 'risk-effort') return 'prep';
  return null;
}

/**
 * The elected leader's identity and health, recorded in the shared file
 * alongside (but never inside) the offer list (WL-0MW1VINII003IL7R).
 *
 * Why it exists: the leader removes its OWN entry whenever its window is empty
 * ("no dead offers"), so the one instance permitted to dispatch could be
 * absent from `entries` entirely. During the 2026-11-04 outage the file showed
 * five healthy offers while nothing dispatched anywhere for eight hours, and
 * the refusals lived only in one project's per-root log. This block makes the
 * dispatcher and its latest outcome readable from the shared state.
 *
 * It is EVIDENCE, never an offer: no dispatch path may read it as work.
 */
export interface CoordinationLeader {
  /** Instance id of the lease holder. */
  instanceId: string;
  /** Worklog root the leader dispatches for (its own cwd). */
  worklogRoot: string;
  /**
   * The leader's most recent recorded dispatch DECISION token (e.g.
   * `slots-unavailable`, `capacity-saturated`, `no-candidate`), or null when it
   * has recorded none. Observational: it is the standing refusal signal an
   * operator needs when nothing is being dispatched.
   */
  lastDecisionReason: string | null;
  /** ISO-8601 UTC time of that decision, or null. */
  lastDecisionAt: string | null;
  /** ISO-8601 UTC heartbeat — refreshed on every leader check-in. */
  lastUpdated: string;
}

/** Full coordination file shape. */
export interface CoordinationData {
  version: number;
  entries: CoordinationEntry[];
  /**
   * The elected leader (WL-0MW1VINII003IL7R). OPTIONAL so a legacy file parses
   * unchanged and a pre-feature reader simply ignores the key.
   */
  leader?: CoordinationLeader;
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
 *
 * v2 (WL-0MWDDHQON0015T3P AC1): a v2 entry's `offers` payload is parsed
 * (re-bounded fail-safe) and `workItemId` mirrors the first offer; a v1 file
 * (declared version < {@link COORDINATION_FILE_VERSION}) is migration-read as
 * a one-offer entry per instance — the v1 single `workItemId` becomes one
 * offer whose kind is the `implement` bucket default (see
 * {@link migratedV1Offer}) — so no v1 file is ever dropped by the upgrade.
 */
export function readCoordinationFile(worklogDir: string): CoordinationData | null {
  try {
    const content = fs.readFileSync(coordinationPath(worklogDir), 'utf-8');
    if (!content.trim()) return null;
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const data = parsed as Partial<CoordinationData>;
    if (!Array.isArray(data.entries)) return null;
    const fileVersion = typeof data.version === 'number' ? data.version : COORDINATION_FILE_VERSION;
    // A v1 file carries one top-level `workItemId` and NO `offers` payload;
    // migration-read it as a one-offer entry (parent AC1). v2 files are
    // parsed as-is; a v2 entry without `offers` is kept as its legacy shape
    // (fail-safe) so round-trips and old writers never surprise a reader.
    const migrateV1 = fileVersion < COORDINATION_FILE_VERSION;
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
      const rawWorkItemId = typeof entry.workItemId === 'string' ? entry.workItemId : '';
      const base = {
        instanceId: entry.instanceId,
        workItemId: rawWorkItemId,
        directory: rawRoot,
        worklogRoot: rawRoot,
        assignedAt: typeof entry.assignedAt === 'string' ? entry.assignedAt : new Date(0).toISOString(),
        lastUpdated: typeof entry.lastUpdated === 'string' ? entry.lastUpdated : new Date(0).toISOString(),
      } as CoordinationEntry;
      if (Array.isArray(entry.offers) && entry.offers.length > 0) {
        // v2: parse the bounded offer payload (re-bounded fail-safe) and
        // mirror the first offer into `workItemId` for v1-era readers.
        const offers = boundOffers(entry.offers);
        entries.push({
          ...base,
          offers,
          workItemId: offers.length > 0 ? offers[0].workItemId : rawWorkItemId,
        });
      } else if (migrateV1 && rawWorkItemId.length > 0) {
        // v1 migration-read: the single top-level `workItemId` becomes a
        // one-offer entry — never dropped by the upgrade (parent AC1).
        entries.push({ ...base, offers: [migratedV1Offer(rawWorkItemId)] });
      } else {
        entries.push(base);
      }
    }
    return {
      version: fileVersion,
      entries,
      ...parseLeader(data.leader),
    };
  } catch {
    return null; // missing / unreadable / corrupt → fail-safe
  }
}

/**
 * The v1 migration-read offer (parent AC1): a legacy single `workItemId`
 * becomes ONE offer carrying that item. The bucket defaults to `implement`
 * because the v1 head was `computeMostImportantItem`'s single most-important
 * offer, which resolved to the implement tier in the overwhelming majority of
 * cases (open / plan_complete with populated risk+effort — exactly the
 * LEGACY_V1_ITEM fixture). The classifier remains the single source of bucket
 * truth (parent AC4) and re-resolves the kind at dispatch time (the leader
 * re-fetches + classifies every offer) and at the owner's next check-in (the
 * entry is rewritten as v2, AC1), so the read-time default is never the
 * dispatch decision.
 */
function migratedV1Offer(workItemId: string): CoordinationOffer {
  return { kind: 'implement', workItemId };
}

/**
 * Bound an offers payload (parent AC1): at most one nominee per bucket
 * (first in array order — the array is already the bucket's canonical
 * ranking, no second ranking), at most three total, and duplicate
 * `(kind, workItemId)` pairs collapse. Malformed offers (empty id, unknown
 * kind) are dropped fail-safe. Used on both the write seam (so an
 * over-bounds array is never persisted) and the read seam (fail-safe).
 */
function boundOffers(raw: readonly unknown[]): CoordinationOffer[] {
  const seenKinds = new Set<CoordinationOfferKind>();
  const seenPairs = new Set<string>();
  const out: CoordinationOffer[] = [];
  for (const o of raw) {
    if (typeof o !== 'object' || o === null) continue;
    const offer = o as Partial<CoordinationOffer>;
    if (typeof offer.workItemId !== 'string' || offer.workItemId.length === 0) continue;
    const kind = toOfferBucket(offer.kind);
    if (kind === null) continue;
    const pairKey = `${kind}\u0000${offer.workItemId}`;
    if (seenPairs.has(pairKey)) continue; // duplicate (kind, workItemId) → collapse
    seenPairs.add(pairKey);
    if (seenKinds.has(kind)) continue; // already one nominee for this bucket
    seenKinds.add(kind);
    out.push({ kind, workItemId: offer.workItemId });
    if (out.length >= COORDINATION_OFFER_BUCKETS.length) break; // at most three total
  }
  return out;
}

/**
 * Validate a leader block read from disk (WL-0MW1VINII003IL7R). A malformed
 * block is DROPPED, never fatal: a bad leader record must not cost a reader its
 * offer list. Returns `{}` when absent/invalid, `{ leader }` when usable.
 */
function parseLeader(raw: unknown): { leader?: CoordinationLeader } {
  if (typeof raw !== 'object' || raw === null) return {};
  const o = raw as Partial<CoordinationLeader>;
  if (typeof o.instanceId !== 'string' || o.instanceId.length === 0) return {};
  return {
    leader: {
      instanceId: o.instanceId,
      worklogRoot: typeof o.worklogRoot === 'string' ? o.worklogRoot : '',
      lastDecisionReason:
        typeof o.lastDecisionReason === 'string' && o.lastDecisionReason.length > 0
          ? o.lastDecisionReason
          : null,
      lastDecisionAt:
        typeof o.lastDecisionAt === 'string' && o.lastDecisionAt.length > 0 ? o.lastDecisionAt : null,
      lastUpdated: typeof o.lastUpdated === 'string' ? o.lastUpdated : '',
    },
  };
}

/** Normalize an entry so `directory`/`worklogRoot` and the v2 offer payload are consistent (compat). */
function normalizeEntry(entry: CoordinationEntry): CoordinationEntry {
  const root = typeof entry.worklogRoot === 'string' && entry.worklogRoot.length > 0
    ? entry.worklogRoot
    : entry.directory;
  const base = { ...entry, directory: root, worklogRoot: root };
  if (!Array.isArray(entry.offers) || entry.offers.length === 0) {
    // Legacy v1-shape entry — keep the single `workItemId` as-is; there is
    // no offers payload to bound (old writers/readers interoperate, AC9).
    return base;
  }
  // v2: bound (one per bucket, max three, duplicates collapse) and mirror
  // the FIRST offer into `workItemId` so a v1-era leader keeps reading the
  // first offer and ignores the rest (parent AC9).
  const offers = boundOffers(entry.offers);
  return {
    ...base,
    offers,
    workItemId: offers.length > 0 ? offers[0].workItemId : '',
  };
}

/**
 * Atomically write the coordination file (tmp + rename). A concurrent
 * writer can never observe a partially-written JSON, and a crash between
 * the tmp write and the rename leaves the previous file intact.
 * Returns false on I/O failure (fail-safe, never throws).
 *
 * The persisted version is ALWAYS the current format
 * {@link COORDINATION_FILE_VERSION} — the write path never echoes a legacy
 * version read back from disk (parent AC1: a v1 file is rewritten as v2 on
 * the next check-in).
 */
export function writeCoordinationFile(worklogDir: string, data: CoordinationData): boolean {
  try {
    const fp = coordinationPath(worklogDir);
    const tmpPath = `${fp}.tmp`;
    const effDir = resolveEffectiveDir(worklogDir) ?? worklogDir;
    fs.mkdirSync(effDir, { recursive: true });
    // Normalize entries so both `directory` (legacy) and `worklogRoot`
    // (machine-wide) are persisted — old and new readers interoperate —
    // and the v2 offer payload is bounded (one per bucket, max three,
    // duplicates collapse).
    const normalized: CoordinationData = {
      ...data,
      version: COORDINATION_FILE_VERSION,
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
    // Ensure the coordination dir exists FIRST (same provisioning as
    // writeLockFile / writeLeaseFile / writeCoordinationFile): an
    // offer-only instance (WL-0MWDDHOK6009GJCC) checks in on a fresh dir
    // before ANY election could provision it, and without the mkdir the
    // O_EXCL open below fails with ENOENT + the lock is never taken, so
    // the instance's first check-in write silently no-ops.
    const effDir = resolveEffectiveDir(worklogDir) ?? worklogDir;
    fs.mkdirSync(effDir, { recursive: true });
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
 * Remove ONE offer from an instance's v2 entry (parent WL-0MWDDHQON0015T3P
 * AC6, "remove only what dispatched"): the entry keeps its remaining offers
 * and its `lastUpdated`/`assignedAt` metadata untouched, so a second tier can
 * be dispatched on the next tick without waiting for the owner's check-in
 * cadence. When the removed offer was the entry's LAST one — and for every
 * legacy v1-shaped entry, where the single `workItemId` IS the entry — the
 * whole entry is dropped, exactly as `removeEntry` did before v2 (AC9).
 *
 * Returns what actually happened; `{false, false}` means the instance/offer
 * was not present or the write failed (lock contention, I/O error —
 * fail-safe, never throws).
 */
export function removeOffer(
  worklogDir: string,
  instanceId: string,
  workItemId: string,
): { offerRemoved: boolean; entryRemoved: boolean } {
  const missed = { offerRemoved: false, entryRemoved: false };
  const result = withCoordLock(worklogDir, () => {
    const data = readCoordinationFile(worklogDir);
    if (data === null) return missed;
    const entry = data.entries.find((e) => e.instanceId === instanceId);
    if (entry === undefined) return missed;
    const offers = Array.isArray(entry.offers) ? entry.offers : [];
    // Legacy v1-shaped entry: no payload, so the single `workItemId` is the
    // offer AND the entry — drop the entry (v1 semantics preserved).
    if (offers.length === 0) {
      if (entry.workItemId !== workItemId) return missed;
      const next = data.entries.filter((e) => e.instanceId !== instanceId);
      return writeCoordinationFile(worklogDir, { ...data, entries: next })
        ? { offerRemoved: true, entryRemoved: true }
        : missed;
    }
    const remaining = offers.filter((o) => o.workItemId !== workItemId);
    if (remaining.length === offers.length) return missed;
    const entries =
      remaining.length === 0
        ? data.entries.filter((e) => e.instanceId !== instanceId)
        : data.entries.map((e) =>
            e.instanceId === instanceId
              ? { ...e, offers: remaining, workItemId: remaining[0].workItemId }
              : e,
          );
    if (!writeCoordinationFile(worklogDir, { ...data, entries })) return missed;
    return { offerRemoved: true, entryRemoved: remaining.length === 0 };
  });
  return result ?? missed;
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

// ── Leader block (WL-0MW1VINII003IL7R) ────────────────────────────────

/**
 * Record or refresh the elected leader's identity + latest decision outcome.
 *
 * Written by the lease holder on every leader check-in (and on election), so
 * the shared state always names the dispatcher even when its own offer was
 * removed. `entries` is left EXACTLY as it is — this never creates or
 * resurrects an offer.
 *
 * Fail-safe: returns false on lock contention or I/O failure; never throws.
 */
export function upsertLeader(
  worklogDir: string,
  leader: CoordinationLeader,
): boolean {
  if (leader.instanceId.length === 0) return false;
  const normalized: CoordinationLeader = {
    instanceId: leader.instanceId,
    worklogRoot: leader.worklogRoot,
    lastDecisionReason: leader.lastDecisionReason ?? null,
    lastDecisionAt: leader.lastDecisionAt ?? null,
    lastUpdated:
      typeof leader.lastUpdated === 'string' && leader.lastUpdated.length > 0
        ? leader.lastUpdated
        : new Date().toISOString(),
  };
  return withCoordLock(worklogDir, () => {
    const data: CoordinationData = readCoordinationFile(worklogDir) ?? {
      version: COORDINATION_FILE_VERSION,
      entries: [],
    };
    return writeCoordinationFile(worklogDir, { ...data, leader: normalized });
  }) ?? false;
}

/**
 * Read the leader block, applying the freshness rule.
 *
 * Returns null when absent, malformed, or STALE (older than `staleMs`, default
 * {@link DEFAULT_LEADER_BLOCK_STALE_MS}): a crashed leader must never read as a
 * live one. Fail-safe: a missing/corrupt file also yields null.
 */
export function getLeader(
  worklogDir: string,
  opts: { nowMs?: number; staleMs?: number } = {},
): CoordinationLeader | null {
  const data = readCoordinationFile(worklogDir);
  const leader = data?.leader;
  if (leader === undefined) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const staleMs = opts.staleMs ?? DEFAULT_LEADER_BLOCK_STALE_MS;
  const updatedMs = Date.parse(leader.lastUpdated);
  if (!Number.isFinite(updatedMs)) return null; // unparseable → not live
  if (nowMs - updatedMs > staleMs) return null; // stale → not live
  return leader;
}

/**
 * Remove the leader block (lease release / leadership hand-off).
 * Returns true when a block was removed, false when none was present or the
 * operation failed (fail-safe).
 */
export function removeLeader(worklogDir: string): boolean {
  return withCoordLock(worklogDir, () => {
    const data = readCoordinationFile(worklogDir);
    if (data === null || data.leader === undefined) return false;
    const { leader: _dropped, ...rest } = data;
    return writeCoordinationFile(worklogDir, rest);
  }) ?? false;
}

/**
 * True when the offer list holds a PEER's entry with a stated offer.
 *
 * The `no-candidate` cooldown exists to stop the worker burning the proxy
 * when there is genuinely nothing to do. It is a FULL STOP: while it holds,
 * the offer list is not polled at all, so an offer sitting in the file is
 * starved for the whole pause (parent WL-0MVP7QHUB003ZA2A AC2/AC3). A peer
 * entry with a non-empty `workItemId` means the backlog is NOT empty — it is
 * just somebody else's root — so the pause must not arm (and a live pause
 * must be cancelled at the next leader check-in).
 *
 * Liveness-aware (WL-0MVR8GDJ3008WY3Y AC7): entries whose `lastUpdated`
 * exceeds `staleWindowMs` (default `DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS`,
 * 24 h) are treated as absent.  Stale entries are silently ignored — the
 * instance's OWN entry and the leader block never count as a peer (inherited
 * from the pre-liveness contract).
 *
 * Conservative rationale: stale = absent peer makes the leader *more* willing
 * to sweep (it sees no peer and arms the cooldown probe), never less.  This is
 * safer than treating stale = present and starving offers behind a
 * no-candidate cooldown (parent WL-0MVP7QHUB003ZA2A).  The decision is
 * deliberately conservative: the worst that can happen is one extra idle tick
 * polling the offer list, never starvation.
 *
 * Entry expiry remains a deliberate no-op (`pruneStaleEntries` returns 0 and
 * never mutates the file, WL-0MTMPIQBE001J41P) — liveness lives ONLY in this
 * read predicate, so the coordination file keeps its non-expiring contract.
 *
 * Deliberately cheap and fail-open: it is a pure in-memory scan of entries
 * the caller has already read (the dispatch attempt reads them once), so no
 * second worklog CLI probe is issued.  Callers that omit `opts` keep the
 * default 24 h window — the signature change is purely additive.
 *
 * An instance's OWN entry never counts (that is what the empty-own-root
 * probe is for), and an entry without a `workItemId` is not an offer.
 */
export function hasPeerOffer(
  entries: readonly CoordinationEntry[],
  instanceId: string,
  opts?: { nowMs?: number; staleWindowMs?: number },
): boolean {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleWindowMs = opts?.staleWindowMs ?? DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS;
  return entries.some((entry) => {
    // Own entry never counts (inherited from pre-liveness contract).
    if (entry.instanceId === instanceId) return false;
    // Entry must have a stated offer.
    if (entry.workItemId.length === 0) return false;
    // Liveness gate: entry older than the stale window is treated as absent.
    const updatedMs = Date.parse(entry.lastUpdated);
    if (!Number.isFinite(updatedMs)) return false; // unparseable → not live
    if (nowMs - updatedMs > staleWindowMs) return false; // stale → not live
    return true;
  });
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
 * entries refreshed in one cycle. Returns the number of entries in the
 * UPSERTED BATCH (the caller's entries), not the file's total — the batch
 * size is the meaningful "written" count for a caller who knows what it
 * asked to write (parent AC1 duplicate-collapse tests pin this).
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
    return writeCoordinationFile(worklogDir, { ...data, entries: next }) ? normalized.length : 0;
  }) ?? 0;
}