/**
 * Bounded JSONL audit log for herdr downtime dispatches
 * (WL-0MSGPI4AR000YOK8, parent WL-0MSF49FMW009M06K).
 *
 * The log lives at `<cwd>/.worklog/downtime-dispatches.log` (the `.worklog`
 * directory is gitignored, so the file is a local artifact; the worklog
 * comment added alongside it is the durable cross-machine trail). F6
 * WL-0MTII4CWT00452HU decision: dispatch/coordination logs stay per-root
 * (retained location) for per-project observability; the single
 * machine-wide coordination file/lease is authoritative for dispatch
 * decisions, but logs are not migrated — stale per-worklog coordination
 * files do not imply log migration. The file is bounded — only the most recent DOWNTIME_LOG_MAX_ENTRIES entries are
 * kept — so it rolls instead of growing unbounded over a long-lived plugin
 * pane. Callers must treat failures as fail-closed (never crash the worker).
 *
 * The log doubles as the dispatched-marker source for the audit tier
 * (WL-0MSLIY8ZR004QUSY): `readDowntimeLogEntries` + `auditDispatchedItemIds`
 * let the audit-tier selection exclude items the downtime worker has already
 * dispatched for `/skill:audit`, closing the re-selection loop where a
 * dispatched run reverts the item to completed/in_review without a fresh
 * audit.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** File name of the downtime dispatch audit log inside `.worklog/`. */
export const DOWNTIME_LOG_FILE = 'downtime-dispatches.log';

/**
 * File name of the coordination ops log inside `.worklog/` — a separate
 * rolling log for leader-election / coordination-file operations
 * (WL-0MSXHAE290067VAL, parent WL-0MST3OJ8S0001ROL): check-ins,
 * elections/re-elections, and stale-entry pruning. Kept SEPARATE from the
 * dispatch log so the dispatch-marker readers (which scan
 * `downtime-dispatches.log` by kind) never see coordination entries.
 */
export const COORDINATION_LOG_FILE = 'downtime-coordination.log';

/**
 * One parsed coordination-log entry: a `kind: 'coordination'` record of a
 * check-in (`operation: 'checkin'`), an election win / leadership takeover
 * (`operation: 'election'`), or stale-entry pruning (`operation: 'prune'`).
 * All fields optional so malformed or foreign lines never break parsing.
 */
export interface CoordinationLogEntry {
  kind?: string;
  operation?: string;
  instanceId?: string;
  /** Work item id offered at a check-in (or null/absent when emptied). */
  workItemId?: string | null;
  /** Number of entries removed by a prune operation. */
  prunedCount?: number;
  at?: string;
}

/**
 * Append one coordination operation to `.worklog/downtime-coordination.log`
 * (same bounded-rolling behavior as the dispatch log — most recent
 * DOWNTIME_LOG_MAX_ENTRIES). Fail-closed: never throws; a write failure
 * is swallowed (audit logging must never crash the worker).
 */
export async function appendCoordinationLogEntry(
  cwd: string,
  entry: CoordinationLogEntry,
): Promise<void> {
  try {
    // Reuse the bounded JSONL append machinery with a different filename.
    await appendRollingJsonl(cwd, COORDINATION_LOG_FILE, JSON.stringify(entry));
  } catch {
    // fail-closed: coordination logging must never crash the worker
  }
}

/** Rolling bound: keep at most this many entries in the log file. */
export const DOWNTIME_LOG_MAX_ENTRIES = 100;

/**
 * One parsed line of the downtime dispatch log: either a dispatch event
 * (itemId/kind/dispatchedAt/title), a spawn-failure trace
 * (itemId/kind/stage + outcome:'spawn-failed' with error/exitCode —
 * WL-0MSLWJ3I70031Z8U), or a persistent-error event (cwd/at/message,
 * three-strike trail). All fields optional so malformed or foreign lines
 * never break parsing.
 */
export interface DowntimeLogEntry {
  itemId?: string;
  kind?: string;
  dispatchedAt?: string;
  cwd?: string;
  title?: string;
  /**
   * Worklog stage of the item AT dispatch (set on plan/intake markers,
   * RCA WL-0MSRBFFLN005W3VT design point 3). Powers the change-guard: a
   * candidate is excluded while it is still at its dispatched-at stage; a
   * stage advancement releases it. Absent on legacy entries (backward
   * compatible — a missing stage never suppresses selection).
   */
  stage?: string;
  at?: string;
  message?: string;
  /**
   * Dispatch outcome of a failed pane spawn ('spawn-failed'): the rolling
   * log distinguishes "attempted" from "opened" (WL-0MSLWJ3I70031Z8U AC2).
   * Absent on success markers and legacy entries (backward compatible —
   * marker readers ignore it).
   */
  outcome?: string;
  /** Spawn-level error message (spawn-failed trace, e.g. ENOENT). */
  error?: string;
  /** send-to-pi.sh exit code (non-zero spawn-failed trace; null = signal). */
  exitCode?: number | null;
}

/**
 * Read the bounded rolling dispatch log at `<cwd>/.worklog/downtime-dispatches.log`.
 *
 * FAIL-SAFE by contract (WL-0MSLIY8ZR004QUSY): a missing or unreadable log
 * yields `[]` (a missing log is the normal first-run state — treating it as
 * empty keeps audit-tier dispatch working on a fresh worklog, and a
 * corrupted log must not silently disable the audit tier either), and
 * malformed JSONL lines are skipped without throwing. This function never
 * throws.
 */
export async function readDowntimeLogEntries(cwd: string): Promise<DowntimeLogEntry[]> {
  const file = join(cwd, '.worklog', DOWNTIME_LOG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return []; // missing or unreadable → empty (fail-safe)
  }
  const entries: DowntimeLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        entries.push(parsed as DowntimeLogEntry);
      }
    } catch {
      // malformed line → skip (fail-safe)
    }
  }
  return entries;
}

/**
 * Build the set of itemIds the downtime worker has already dispatched for
 * the given kind (kind-scoped). Entries without an itemId (e.g.
 * persistent-error events) are ignored. Shared by the audit/implement/plan/
 * intake marker readers so every tier's scope guard stays identical.
 */
function dispatchedItemIds(entries: DowntimeLogEntry[], kind: string): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.kind === kind && typeof e.itemId === 'string' && e.itemId.length > 0) {
      ids.add(e.itemId);
    }
  }
  return ids;
}

/**
 * Build the set of itemIds the downtime worker has already dispatched for
 * `/skill:audit` (`kind === 'audit'` entries only). Plan/intake markers are
 * scoped to their own tiers and must NOT suppress audit-tier selection
 * (audit-tier-only scope guard, WL-0MSLIY8ZR004QUSY). Entries without an
 * itemId (e.g. persistent-error events) are ignored.
 */
export function auditDispatchedItemIds(entries: DowntimeLogEntry[]): Set<string> {
  return dispatchedItemIds(entries, 'audit');
}

/**
 * Build the set of itemIds with a `kind` marker whose `dispatchedAt` falls
 * within `windowMs` of `now` (fresh markers only, WL-0MT3PHW4I002SNOV).
 * Powers the active-audit single-flight check: an audit dispatch marker
 * older than the stale window (`DOWNTIME_AUDIT_STALE_WINDOW_MS`, 2h) is
 * treated as stale — the audit pane may have crashed without updating the
 * work item — and ignored, so a NEW audit dispatch can proceed. Entries
 * without an itemId, without a parseable `dispatchedAt`, or of another
 * kind are ignored (fail-closed: missing evidence never claims an active
 * audit).
 */
export function recentDispatchedItemIds(
  entries: DowntimeLogEntry[],
  kind: string,
  windowMs: number,
  now: number = Date.now(),
): Set<string> {
  const cutoff = now - windowMs;
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.kind !== kind || typeof e.itemId !== 'string' || e.itemId.length === 0) continue;
    if (typeof e.dispatchedAt !== 'string') continue; // unrecognized timestamp → no active evidence
    const t = Date.parse(e.dispatchedAt);
    if (Number.isNaN(t) || t < cutoff) continue; // unparseable or stale
    ids.add(e.itemId);
  }
  return ids;
}

/**
 * Build the set of itemIds with a NON-STALE audit dispatch marker
 * (`kind === 'audit'`, dispatched within `windowMs` of `now`). Plan/intake/
 * implement markers are scoped out (audit-tier-only, WL-0MT3PHW4I002SNOV).
 */
export function recentAuditDispatchedItemIds(
  entries: DowntimeLogEntry[],
  windowMs: number,
  now: number = Date.now(),
): Set<string> {
  return recentDispatchedItemIds(entries, 'audit', windowMs, now);
}

/**
 * Build the set of itemIds the downtime worker has already dispatched for
 * `/skill:implement` (`kind === 'implement'` entries only). Audit/plan/
 * intake markers are scoped to their own tiers and must NOT suppress
 * implement-tier selection (implement-tier-only scope guard,
 * WL-0MSMAYPQP001FLR6 AC6). Entries without an itemId (e.g. persistent-error
 * events) are ignored.
 */
export function implementDispatchedItemIds(entries: DowntimeLogEntry[]): Set<string> {
  return dispatchedItemIds(entries, 'implement');
}

/**
 * Build the kind-scoped id → dispatched-at-stage map used by the plan/intake
 * change-guard (RCA WL-0MSRBFFLN005W3VT design point 3): entries of the
 * given kind map itemId to the worklog stage the item had when it was
 * dispatched. Selection excludes a candidate while it is still at its
 * dispatched-at stage; a stage advancement (or any stage differing from the
 * recorded one) releases it. Entries without a recorded stage map to '' — a
 * missing stage never suppresses selection (legacy pre-fix entries stay
 * valid and do not freeze an item).
 */
export function dispatchedItemStages(entries: DowntimeLogEntry[], kind: string): Map<string, string> {
  const stages = new Map<string, string>();
  for (const e of entries) {
    if (e.kind === kind && typeof e.itemId === 'string' && e.itemId.length > 0) {
      stages.set(e.itemId, typeof e.stage === 'string' ? e.stage : '');
    }
  }
  return stages;
}

/**
 * Plan-tier marker map (`kind === 'plan'` entries only): itemId → stage at
 * dispatch. A plan candidate (`intake_complete`) is excluded while a plan
 * marker records the same stage; advancing the item releases it.
 */
export function planDispatchedItemStages(entries: DowntimeLogEntry[]): Map<string, string> {
  return dispatchedItemStages(entries, 'plan');
}

/**
 * Intake-tier marker map (`kind === 'intake'` entries only): itemId → stage
 * at dispatch. An intake candidate (`idea`) is excluded while an intake
 * marker records the same stage; advancing the item releases it.
 */
export function intakeDispatchedItemStages(entries: DowntimeLogEntry[]): Map<string, string> {
  return dispatchedItemStages(entries, 'intake');
}

/**
 * Append one entry (a JSONL line) to `<cwd>/.worklog/downtime-dispatches.log`,
 * creating the `.worklog` directory if needed and trimming the file back to
 * the most recent DOWNTIME_LOG_MAX_ENTRIES entries. Throws on I/O failure —
 * callers must catch (fail-closed).
 */
export async function appendDowntimeLogEntry(cwd: string, entry: string): Promise<void> {
  await appendRollingJsonl(cwd, DOWNTIME_LOG_FILE, entry);
}

/**
 * Bounded JSONL append shared by the dispatch and coordination logs:
 * write `line` to `<cwd>/.worklog/<file>`, creating `.worklog` if needed
 * and trimming to the most recent DOWNTIME_LOG_MAX_ENTRIES lines. Throws
 * on I/O failure — callers must catch (fail-closed).
 */
async function appendRollingJsonl(cwd: string, file: string, line: string): Promise<void> {
  const dir = join(cwd, '.worklog');
  const filePath = join(dir, file);
  await mkdir(dir, { recursive: true });

  let lines: string[] = [];
  try {
    const existing = await readFile(filePath, 'utf8');
    lines = existing.split('\n').filter((ln) => ln.trim() !== '');
  } catch {
    lines = []; // first entry or unreadable file → start fresh
  }

  lines.push(line);
  if (lines.length > DOWNTIME_LOG_MAX_ENTRIES) {
    lines = lines.slice(lines.length - DOWNTIME_LOG_MAX_ENTRIES);
  }
  await writeFile(filePath, lines.join('\n') + '\n', 'utf8');
}
