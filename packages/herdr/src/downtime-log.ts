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
 * pane. The COORDINATION log (`.worklog/downtime-coordination.log`) instead
 * rotates size-based with N kept (WL-0MVKNC28B003UOLX): it holds 24 h of
 * decision history with bounded disk — see `COORDINATION_LOG_MAX_ENTRIES` /
 * `COORDINATION_LOG_MAX_ROTATED_FILES`. Callers must treat failures as fail-closed (never crash the worker).
 *
 * The log doubles as the dispatched-marker source for the audit tier
 * (WL-0MSLIY8ZR004QUSY): `readDowntimeLogEntries` + `auditDispatchedItemIds`
 * let the audit-tier selection exclude items the downtime worker has already
 * dispatched for `/skill:audit`, closing the re-selection loop where a
 * dispatched run reverts the item to completed/in_review without a fresh
 * audit.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { CloseReasonSnapshot } from './pane-close.js';

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
  /**
   * No-dispatch decision fields (WL-0MU8808ZY0091JIA): recorded on a
   * `kind: 'decision'` / `operation: 'no-dispatch'` entry so the reason a
   * tick refused to dispatch is observable from the log alone. All optional
   * so coordination check-in/election entries are unchanged (additive
   * schema).
   */
  reason?: string;
  freeSlots?: number;
  totalSlots?: number;
  ownerPresent?: boolean;
  runningPanes?: number | null;
  contentionDepth?: number;
  /**
   * Schema-v2 truthful-capacity evidence (LP-0MVGDUVGE0024YAI): the pool
   * summary, payload version and per-slot lease/phase/ETA detail observed at
   * the poll. All optional so earlier entry shapes are unchanged.
   */
  capacityHint?: string;
  statusSchemaVersion?: number;
  idleLeasedSlots?: number;
  generatingSlots?: number;
  slotPhases?: Record<string, string>;
  slotPrefillEtaSeconds?: Record<string, number>;
  /**
   * Proxy-authoritative local idle-age evidence (LP-0MVGD9Z8Z0055Y5J,
   * WL-0MVHSZR9C0012NQY): the idle age in seconds the proxy reported for the
   * backend, and the source of its last activity (`dispatch` / `chunk` /
   * `finish` / startup …). Recorded on every polled decision so an operator
   * can see WHY a tick was admitted or deferred. Absent on pre-feature
   * proxies; never a gate. Additive/optional → earlier entry shapes are
   * unchanged.
   */
  localIdleSeconds?: number;
  localLastActivitySource?: string;
  /**
   * Depth-aware audit-batch decision metadata (parent WL-0MVEDM8OT007WDRS
   * AC5): recorded on an `audit-batch-continue` decision so each
   * continuation is diagnosable (depth, cap and remaining budget). All
   * optional so every existing entry shape is unchanged (additive schema).
   */
  auditBatchDepth?: number;
  auditBatchCap?: number;
  auditBatchRemaining?: number;
  /**
   * Why an armed batch ended (parent WL-0MVEDM8OT007WDRS AC5): `cap` (the
   * continuation budget was consumed) or `depth` (the audit-eligible depth
   * dropped below `browseItemCount`). Present only on `audit-batch-end`
   * decisions.
   */
  auditBatchEndReason?: string;
  /**
   * Continuous capacity-starvation signal (WL-0MVKNC2N50025HXE AC3): recorded
   * on a `reason: 'capacity-starved'` observation when the dispatcher has
   * refused a continuous run of capacity-flagged ticks for at least the
   * configured window. `capacity-starved` is an OBSERVATION, not a refusal: it
   * never sets the header blocking token and never replaces the underlying
   * refusal reason.
   */
  starvedSince?: string;
  /** Length of the starvation episode at the moment the signal was written (ms). */
  starvedMs?: number;
  /** Capacity refusals observed in the episode (includes rate-limited ticks). */
  consecutiveCapacityRefusals?: number;
  /** The most recent capacity-refusal reason in the episode. */
  lastCapacityReason?: string;
  /**
   * Empty-offer attribution (WL-0MVR8FKMU009XTED AC1): recorded on an
   * emptied `operation: 'checkin'` entry so a starved root is
   * self-diagnosing. `reason` names the empty-offer reason (`empty-window`,
   * `all-window-items-held`, `all-window-items-gated`, `code-freeze`,
   * `review-queue-hold`, `attempt-budget-exhausted`, `in-flight-hold`,
   * `non-terminal-cooldown`, `stalled-resume`, `wl-error`), `heldAssignees`
   * carries the observed scheduling-hold sentinels (`Map`, …) when the whole
   * window is held, and `dominantGate`/`gateCounts` name the gate that
   * rejected the most candidates. Additive and optional: every earlier entry
   * shape is unchanged.
   */
  windowSize?: number;
  heldAssignees?: string[];
  dominantGate?: string;
  gateCounts?: Record<string, number>;
  /**
   * Per-offer dispatch-time rejections (WL-0MVR8FKMU009XTED AC2): recorded on
   * the terminal decision entry so every coordination entry the leader
   * rejected names its work item, worklog root and the gate that rejected it
   * instead of collapsing into a bare `no-candidate`.
   */
  offerRejections?: Array<{
    workItemId: string;
    worklogRoot: string;
    gate: string;
    assignee?: string;
  }>;
  /** The wl/CLI error that caused an entry-kept check-in (`reason: 'wl-error'`). */
  error?: string;
  /**
   * Panes the long-running detector flagged when the starvation signal fired
   * (WL-0MVKNC2N50025HXE AC2/AC3): each entry names the pane, item, kind and
   * how long the item has gone without progress. Bounded; absent when the
   * scan is unwired or found nothing.
   */
  longRunningPanes?: Array<{
    paneId: string;
    itemId: string;
    cwd: string;
    kind: string;
    stalledForMs: number;
    agentStatus: string;
    stage: string;
  }>;
  at?: string;
}

/**
 * Append one coordination operation to `.worklog/downtime-coordination.log`
 * (WL-0MVKNC28B003UOLX retention: size-based rotation with N kept — the
 * current file holds up to `maxEntries`; when that would be exceeded the
 * whole current file rotates to `.1` and a fresh current file starts, so the
 * entry that triggers the rotation is never lost). `policy` is optional and
 * defaults to `COORDINATION_LOG_MAX_ENTRIES` ×
 * `COORDINATION_LOG_MAX_ROTATED_FILES` (documented default ≈ ≥ 24 h at the
 * observed ≥ 60 decisions/hour). Fail-closed: never throws; a write failure
 * is swallowed (audit logging must never crash the worker).
 */
export async function appendCoordinationLogEntry(
  cwd: string,
  entry: CoordinationLogEntry,
  policy?: CoordinationLogPolicyInput,
): Promise<void> {
  try {
    // Reuse the bounded JSONL append machinery with a different filename.
    await appendRollingJsonl(
      cwd,
      COORDINATION_LOG_FILE,
      JSON.stringify(entry),
      resolveCoordinationLogPolicy(policy),
    );
  } catch {
    // fail-closed: coordination logging must never crash the worker
  }
}

/** Rolling bound for the DISPATCH log only: keep at most this many entries. */
export const DOWNTIME_LOG_MAX_ENTRIES = 100;

/**
 * Per-file entry cap for the COORDINATION log before it rotates to a
 * numbered sibling (WL-0MVKNC28B003UOLX AC2). The dispatch log keeps its
 * smaller single-file bound (`DOWNTIME_LOG_MAX_ENTRIES`); only the
 * coordination/decision log carries the 24 h retention. Default: 500
 * entries per file.
 */
export const COORDINATION_LOG_MAX_ENTRIES = 500;

/**
 * Number of rotated coordination-log siblings kept (WL-0MVKNC28B003UOLX
 * AC2). Together with `COORDINATION_LOG_MAX_ENTRIES` the retained window is
 * bounded by `maxEntries × (1 + maxRotatedFiles)` entries and never falls
 * below `maxEntries × maxRotatedFiles + 1` — the documented default (500
 * per file, 3 rotated) therefore always holds 1,501–2,000 entries, covering
 * ≥ 25 h at the observed ≥ 60 decision entries/hour (a full overnight
 * post-mortem window) while bounding disk use to ~2,000 JSONL lines.
 */
export const COORDINATION_LOG_MAX_ROTATED_FILES = 3;

/** Floor for the per-file coordination-log cap (clamped, AC2). */
export const COORDINATION_LOG_MIN_ENTRIES = 10;
/** Ceiling for the per-file coordination-log cap (bounded disk, AC2). */
export const COORDINATION_LOG_MAX_ENTRIES_CEILING = 10_000;
/** Ceiling for rotated coordination-log siblings (bounded disk, AC2). */
export const COORDINATION_LOG_MAX_ROTATED_FILES_CEILING = 20;

/**
 * Resolved coordination-log retention/rotation policy
 * (WL-0MVKNC28B003UOLX AC2) — see {@link resolveCoordinationLogPolicy}.
 */
export interface CoordinationLogPolicy {
  /** Per-file entry cap before rotation; clamped to [10, 10 000]. */
  maxEntries: number;
  /**
   * Rotated siblings kept; `0` disables rotation (single-file trim at the
   * cap). Clamped to [0, 20].
   */
  maxRotatedFiles: number;
}

/** Unresolved (partial) coordination-log policy; missing fields take the documented defaults. */
export interface CoordinationLogPolicyInput {
  maxEntries?: number;
  maxRotatedFiles?: number;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Resolve a (partial) coordination-log retention policy to its clamped,
 * defaulted form (WL-0MVKNC28B003UOLX AC2). Missing fields fall back to
 * `COORDINATION_LOG_MAX_ENTRIES` / `COORDINATION_LOG_MAX_ROTATED_FILES`;
 * out-of-range values are clamped to `[COORDINATION_LOG_MIN_ENTRIES,
 * COORDINATION_LOG_MAX_ENTRIES_CEILING]` / `[0,
 * COORDINATION_LOG_MAX_ROTATED_FILES_CEILING]` so disk growth stays bounded.
 * Pure and total: never throws.
 */
export function resolveCoordinationLogPolicy(
  input?: CoordinationLogPolicyInput,
): CoordinationLogPolicy {
  return {
    maxEntries: clampInt(
      input?.maxEntries ?? COORDINATION_LOG_MAX_ENTRIES,
      COORDINATION_LOG_MIN_ENTRIES,
      COORDINATION_LOG_MAX_ENTRIES_CEILING,
    ),
    maxRotatedFiles: clampInt(
      input?.maxRotatedFiles ?? COORDINATION_LOG_MAX_ROTATED_FILES,
      0,
      COORDINATION_LOG_MAX_ROTATED_FILES_CEILING,
    ),
  };
}

/**
 * Resolve the coordination-log retention policy from the worker's live
 * config slice (WL-0MVKNC28B003UOLX AC2): `coordinationLogMaxEntries` /
 * `coordinationLogMaxRotatedFiles` from `DowntimeWorkerConfig.config()`,
 * falling back to (and clamped like) {@link resolveCoordinationLogPolicy}.
 */
export function coordinationLogPolicyFromConfig(cfg: {
  coordinationLogMaxEntries?: number;
  coordinationLogMaxRotatedFiles?: number;
}): CoordinationLogPolicy {
  return resolveCoordinationLogPolicy({
    maxEntries: cfg.coordinationLogMaxEntries,
    maxRotatedFiles: cfg.coordinationLogMaxRotatedFiles,
  });
}

/**
 * Hours per recent-dispatch time block (WL-0MUMM9NED009TLL3). The recent
 * dispatches view groups items into 4-hour UTC blocks per day, labelled
 * `HH:00–HH:00` (00:00–04:00, 04:00–08:00, …, 20:00–24:00).
 */
export const DISPATCH_TIME_BLOCK_HOURS = 4;

/** Heading label for recent-dispatch rows with no parseable timestamp. */
export const UNKNOWN_TIME_BLOCK_LABEL = 'Unknown time';

/** Placeholder title for a log-derived row whose entry carried no title. */
export const UNKNOWN_DISPATCH_TITLE = '[unknown]';

// ── Pane-close lifecycle entries (WL-0MU308WSF0002JWN) ─────────────────

/**
 * Outcome for a pane-lifecycle close event, capturing WHY the pane was
 * closed (or, for `requires-attention`, why it was flagged).
 */
export type PaneLifecycleOutcome =
  | 'closed-as-intake-complete'
  | 'closed-as-plan-complete'
  | 'audit-passed'
  | 'audit-failed'
  | 'requires-attention';

/**
 * The dispatch kind that spawned the pane (plan / intake / audit /
 * risk-effort / implement). Re-exports the worker's `DowntimeSkillKind`
 * for the pane-lifecycle module so the worker and log share the same set.
 */
export type PaneLifecycleKind = 'plan' | 'intake' | 'audit' | 'risk-effort' | 'implement';

/**
 * A pane-close lifecycle event recorded in the rolling dispatch log
 * (WL-0MU308WSF0002JWN). These entries are keyed by pane id + outcome so
 * the lifecycle collector can track which outcomes have already been
 * logged and avoid duplicate entries.
 *
 * This entry type uses `entryType: 'pane-close'` as a discriminator so
 * dispatched-marker readers (which filter by `kind === <tier>`) ignore
 * pane-close entries entirely.
 */
export interface PaneCloseLogEntry {
  /** Discriminator — ensures dispatched-marker readers ignore this entry. */
  entryType: 'pane-close';
  /** ISO-8601 UTC timestamp of the pane-close/log event. */
  timestamp: string;
  /** Work item id of the dispatched item. */
  itemId: string;
  /** Work item title at the time the pane was closed. */
  itemTitle: string;
  /** Pane id (unique per pane, e.g. "w2T:p3"). */
  paneId: string;
  /** The dispatch kind that spawned this pane. */
  kind: PaneLifecycleKind;
  /** Why the pane was closed (or flagged). */
  outcome: PaneLifecycleOutcome;
  /** Human-readable reason (required for `requires-attention`). */
  reason?: string;
  /**
   * Stable machine-readable reason code (part of the monitor's idempotency
   * key — see `pane-lifecycle.ts`). `'none'` for clean terminal outcomes.
   */
  reasonCode?: string;
  /**
   * Worklog stage the item was at when the pane was closed
   * (WL-0MUKYERLZ006ELL5), recorded from the dispatched-at marker stage. Lets
   * the non-terminal cooldown be released when the item has since advanced
   * past that stage (parent AC4). Optional for legacy entries.
   */
  stage?: string;
  /** Whether the pane was actually closed (false for informational log-only). */
  closed: boolean;
  /**
   * Optional full close-decision state snapshot (parent AC6 /
   * WL-0MUMM5M22006HDPY AC4.1). Absent on legacy entries — readers ignore
   * unknown/absent fields.
   */
  reasonSnapshot?: CloseReasonSnapshot;
}

/**
 * Append one pane-close lifecycle entry to the rolling dispatch log.
 * Fail-closed: never throws — the lifecycle logger must never crash the
 * worker.
 */
export async function appendPaneCloseLogEntry(
  cwd: string,
  entry: PaneCloseLogEntry,
): Promise<void> {
  try {
    await appendRollingJsonl(cwd, DOWNTIME_LOG_FILE, JSON.stringify(entry));
  } catch {
    // fail-closed: pane-close logging must never crash the worker
  }
}

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
  /**
   * Entry-type discriminator (WL-0MU308WSF0002JWN): `'pane-close'` marks a
   * pane-lifecycle close event. Absent on dispatch markers, spawn-failure
   * traces, and error entries (backward compatible — marker readers ignore
   * unknown fields).
   */
  entryType?: string;
  /**
   * Resolved pane id for a dispatch (post-spawn enrichment entry,
   * WL-0MUBVL251006JAQ0) or the pane id a pane-close entry refers to. Absent
   * when the pane could not be resolved (backward compatible).
   */
  paneId?: string | null;
  /** Discriminator for a post-spawn enrichment entry. */
  enrichment?: boolean;
  /**
   * Stable machine-readable reason code for a pane-close entry
   * (WL-0MU308WSF0002JWN) — part of the monitor's idempotency key. Absent on
   * legacy/other entries.
   */
  reasonCode?: string;
  /**
   * Optional full close-decision state snapshot on a pane-close entry
   * (parent AC6 / WL-0MUMM5M22006HDPY AC4.1). Absent on legacy/other entries.
   */
  reasonSnapshot?: CloseReasonSnapshot;
  /**
   * ISO-8601 timestamp of a pane-close entry (WL-0MU308WSF0002JWN). Absent on
   * dispatch markers (which carry `dispatchedAt` instead) and legacy entries.
   */
  timestamp?: string;
  /**
   * Item title captured on a pane-close entry (WL-0MU308WSF0002JWN); parallels
   * the dispatch marker's `title`. Absent on dispatch markers and legacy
   * entries.
   */
  itemTitle?: string;
}

/**
 * Tolerantly parse the JSONL lines of a raw log file content into objects:
 * malformed lines are skipped, an empty/whitespace-only file yields `[]`,
 * and non-object JSON values are ignored. Used by every rolling-log reader
 * (fail-safe, never throws).
 */
function parseJsonlLines(raw: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        entries.push(parsed as Record<string, unknown>);
      }
    } catch {
      // malformed line → skip (fail-safe)
    }
  }
  return entries;
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
  return parseJsonlLines(raw) as DowntimeLogEntry[];
}

/**
 * Read the bounded rolling coordination log at
 * `<cwd>/.worklog/downtime-coordination.log` (WL-0MU8808ZY0091JIA). Same
 * FAIL-SAFE contract as `readDowntimeLogEntries`: a missing or unreadable
 * log yields `[]`, malformed JSONL lines are skipped, and the function never
 * throws. Used by the decision-log tests and any observer that wants the
 * dispatcher's refusal reasons without parsing the file by hand.
 */
export async function readCoordinationLogEntries(cwd: string): Promise<CoordinationLogEntry[]> {
  const file = join(cwd, '.worklog', COORDINATION_LOG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return []; // missing or unreadable → empty (fail-safe)
  }
  return parseJsonlLines(raw) as CoordinationLogEntry[];
}

/**
 * Read the FULL coordination-log history — the current file plus every
 * rotated sibling (WL-0MVKNC28B003UOLX AC1/AC3/AC4). Chronological order:
 * the oldest rotated file first (`.<N>`), then `.1`, then the current
 * (newest) file — so the returned array is the decision history in append
 * order and an operator's per-hour summary (see {@link hourlyReasonTally})
 * reads naturally. Same FAIL-SAFE contract as `readCoordinationLogEntries`:
 * a missing/unreadable `.worklog` yields `[]`, malformed lines are skipped,
 * foreign/temp files (e.g. `.downtime-coordination.log.<pid>.<rand>.tmp`)
 * are never picked up, and the function never throws.
 */
export async function readCoordinationLogAllEntries(cwd: string): Promise<CoordinationLogEntry[]> {
  const dir = join(cwd, '.worklog');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // missing/unreadable .worklog → empty (fail-safe)
  }
  // Rotated siblings are `<file>.N` with an integer N; `.1` is the NEWEST
  // rotated file, so chronological order is highest N first, then the
  // current file. A suffix that is not a pure integer (temp files, `.json`,
  // anything foreign) is never treated as a rotated sibling.
  const suffixNumbers = names
    .filter((name) => name.startsWith(COORDINATION_LOG_FILE + '.'))
    .map((name) => name.slice(COORDINATION_LOG_FILE.length + 1))
    .filter((suffix) => /^\d+$/.test(suffix))
    .map(Number);
  suffixNumbers.sort((a, b) => b - a); // oldest rotated first (highest N)

  const raws: string[] = [];
  for (const n of suffixNumbers) {
    try {
      raws.push(await readFile(join(dir, `${COORDINATION_LOG_FILE}.${n}`), 'utf8'));
    } catch {
      // rotated away concurrently → skip (fail-safe)
    }
  }
  try {
    raws.push(await readFile(join(dir, COORDINATION_LOG_FILE), 'utf8'));
  } catch {
    // no current file → the rotated siblings alone are the history
  }
  return parseJsonlLines(raws.join('\n')) as CoordinationLogEntry[];
}

/**
 * One per-hour reason tally row (WL-0MVKNC28B003UOLX AC3): the number of
 * no-dispatch decision entries in a UTC hour (`YYYY-MM-DDTHH`) carrying a
 * given `reason`.
 */
export interface HourlyReasonCount {
  /** UTC hour covered, as an `at` prefix, e.g. `2026-10-23T21`. */
  hour: string;
  /** The no-dispatch decision reason, e.g. `capacity-saturated`. */
  reason: string;
  /** Number of matching decision entries in that hour. */
  count: number;
}

/**
 * Operator-facing hourly reason tally for a time range (WL-0MVKNC28B003UOLX
 * AC3): count `kind: 'decision'` entries (no-dispatch decisions and
 * observations) by UTC hour and `reason`. `range.from` is inclusive,
 * `range.to` exclusive; an absent range covers the whole input. Pure and
 * total: entries without a parseable `at`, without a string `reason`, or of
 * another kind are ignored; unparseable range bounds fall open; an empty
 * input yields `[]`; never throws. Rows sort by hour, then reason.
 */
export function hourlyReasonTally(
  entries: readonly CoordinationLogEntry[],
  range?: { from?: string; to?: string },
): HourlyReasonCount[] {
  const counts = new Map<string, { hour: string; reason: string; count: number }>();
  const fromT = range?.from !== undefined ? Date.parse(range.from) : Number.NaN;
  const toT = range?.to !== undefined ? Date.parse(range.to) : Number.NaN;
  for (const e of entries) {
    if (e.kind !== 'decision') continue;
    if (typeof e.reason !== 'string' || e.reason.length === 0) continue;
    if (typeof e.at !== 'string') continue;
    const t = Date.parse(e.at);
    if (Number.isNaN(t)) continue;
    if (!Number.isNaN(fromT) && t < fromT) continue;
    if (!Number.isNaN(toT) && t >= toT) continue; // `to` exclusive
    const hour = e.at.slice(0, 13); // 'YYYY-MM-DDTHH' of the ISO `at`
    const key = `${hour}\u0000${e.reason}`;
    const row = counts.get(key);
    if (row === undefined) {
      counts.set(key, { hour, reason: e.reason, count: 1 });
    } else {
      row.count += 1;
    }
  }
  return [...counts.values()].sort(
    (a, b) => (a.hour === b.hour ? a.reason.localeCompare(b.reason) : a.hour.localeCompare(b.hour)),
  );
}

/**
 * True for a rolling-log line that participates in the dispatched-marker
 * readers. Pane-lifecycle close entries (`entryType: 'pane-close'`,
 * WL-0MU308WSF0002JWN) reuse `itemId`/`kind` but are NOT dispatch markers —
 * without this guard their missing `stage`/`dispatchedAt` would clobber a
 * standing marker (last-entry-wins). Any future typed entry is likewise
 * excluded; dispatch markers and enrichment entries (no `entryType`) pass.
 */
function isDispatchMarkerEntry(e: DowntimeLogEntry): boolean {
  return e.entryType === undefined;
}

/**
 * One synthetic work-item row projected from the rolling dispatch log for the
 * Herdr "recent dispatches" view (WL-0MUL2IX6H001YHDO, parent
 * WL-0MUGLL9SS002E1D2). Rows are derived from the LOCAL log only — never from
 * `wl list` — so an item that has since been auto-closed or deleted still
 * appears with its id/title.
 */
export interface RecentDispatchRow {
  /** Work item id the log entries refer to. */
  itemId: string;
  /** Title from the log; `[unknown]` when the log carried none. */
  title: string;
  /** Dispatch kind (plan/intake/audit/risk-effort/implement) when present. */
  kind?: string;
  /**
   * Worklog stage the item reached, derived from the log: the dispatch
   * marker's dispatched-at `stage`, overridden by a stage-advancing
   * pane-close outcome (see `PANE_CLOSE_OUTCOME_STAGE`). Rendered through the
   * same stage/audit icon logic as a live row so the dispatches view shows the
   * SAME icons as every other view (WL-0MUGLL9SS002E1D2 audit fix). Unset when
   * the log carried no usable stage.
   */
  stage?: string;
  /**
   * Audit verdict implied by an audit pane-close outcome
   * (`audit-passed` → `true`, `audit-failed` → `false`). Unset for non-audit
   * outcomes.
   */
  auditResult?: boolean;
  /** Latest pane-close outcome, when a pane-close entry exists for the item. */
  latestOutcome?: string;
  /**
   * ISO-8601 timestamp of the item's most recent log entry (dispatch marker
   * `dispatchedAt`, or pane-close `timestamp`). `undefined` when no entry
   * carried a parseable timestamp.
   */
  latestTimestamp?: string;
}

/**
 * Stage a pane-close outcome indicates the item reached
 * (WL-0MUGLL9SS002E1D2 audit fix). Outcomes that do not imply a canonical
 * stage (`requires-attention`) are absent so the row keeps the marker's
 * dispatched-at stage. `audit-passed`/`audit-failed` are audit-tier closes on
 * `in_review` items, so they map to `in_review`.
 */
const PANE_CLOSE_OUTCOME_STAGE: Record<string, string> = {
  'closed-as-intake-complete': 'intake_complete',
  'closed-as-plan-complete': 'plan_complete',
  'audit-passed': 'in_review',
  'audit-failed': 'in_review',
};

/**
 * Audit verdict implied by an audit pane-close outcome, or `undefined` for a
 * non-audit outcome. Drives the audit-aware `in_review` icon so a log-derived
 * audit row renders ✅/❌ exactly like a freshly audited live row.
 */
function paneCloseAuditResult(outcome: string | undefined): boolean | undefined {
  if (outcome === 'audit-passed') return true;
  if (outcome === 'audit-failed') return false;
  return undefined;
}

/** Numeric sort key for a row timestamp; missing/unparseable sorts oldest. */
function dispatchTimestampValue(ts: string | undefined): number {
  if (ts === undefined) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Project the rolling dispatch log into recent dispatched work items
 * (WL-0MUL2IX6H001YHDO). Reads the LOCAL log via the fail-safe
 * `readDowntimeLogEntries(cwd)` — a missing/unreadable/empty/malformed log
 * yields `[]` and this function never throws.
 *
 * Rows are deduplicated by work item id (one row per id), using that item's
 * most recent log entry for ordering and metadata; pane-close lifecycle
 * entries annotate an existing row's `latestOutcome`/timestamp (a pane-close
 * for an item that was never dispatched does not create a row). Rows are
 * ordered newest-first by their latest timestamp. There is no result cap
 * (WL-0MUMM9NED009TLL3): the log itself is bounded to
 * `DOWNTIME_LOG_MAX_ENTRIES`, so every item retained in the log is shown.
 * The projection is read-only.
 */
export async function recentDispatchedItems(cwd: string): Promise<RecentDispatchRow[]> {
  const entries = await readDowntimeLogEntries(cwd);
  const rows = new Map<string, RecentDispatchRow>();

  for (const e of entries) {
    if (typeof e.itemId !== 'string' || e.itemId.length === 0) continue;

    if (e.entryType === 'pane-close') {
      // Pane-close entries annotate an EXISTING dispatched row; they never
      // introduce a row of their own (an item that was never dispatched is
      // not a recent dispatch).
      const row = rows.get(e.itemId);
      if (row === undefined) continue;
      if (typeof e.outcome === 'string' && e.outcome.length > 0) {
        row.latestOutcome = e.outcome;
        // A stage-advancing close overrides the dispatched-at stage so the
        // row's stage icon reflects where the item ended up, not where it
        // started (WL-0MUGLL9SS002E1D2 audit fix).
        const reachedStage = PANE_CLOSE_OUTCOME_STAGE[e.outcome];
        if (reachedStage !== undefined) {
          row.stage = reachedStage;
        }
        const auditResult = paneCloseAuditResult(e.outcome);
        if (auditResult !== undefined) {
          row.auditResult = auditResult;
        }
      }
      if (typeof e.timestamp === 'string' && e.timestamp.length > 0) {
        row.latestTimestamp = e.timestamp;
      }
      // Backfill a placeholder title from the pane-close itemTitle.
      if (
        row.title === UNKNOWN_DISPATCH_TITLE &&
        typeof e.itemTitle === 'string' &&
        e.itemTitle.length > 0
      ) {
        row.title = e.itemTitle;
      }
      continue;
    }

    if (!isDispatchMarkerEntry(e)) continue; // future typed entries are not dispatch markers

    const existing = rows.get(e.itemId);
    const title =
      typeof e.title === 'string' && e.title.length > 0
        ? e.title
        : existing?.title ?? UNKNOWN_DISPATCH_TITLE;
    const kind = typeof e.kind === 'string' ? e.kind : existing?.kind;
    const stage =
      (typeof e.stage === 'string' && e.stage.length > 0 ? e.stage : undefined) ?? existing?.stage;
    const latestTimestamp =
      (typeof e.dispatchedAt === 'string' ? e.dispatchedAt : undefined) ?? existing?.latestTimestamp;

    rows.set(e.itemId, {
      itemId: e.itemId,
      title,
      kind,
      stage,
      auditResult: existing?.auditResult,
      latestOutcome: existing?.latestOutcome,
      latestTimestamp,
    });
  }

  const list = [...rows.values()];
  list.sort(
    (a, b) => dispatchTimestampValue(b.latestTimestamp) - dispatchTimestampValue(a.latestTimestamp),
  );
  return list;
}

/**
 * One 4-hour UTC time block of recent-dispatch rows
 * (WL-0MUMM9NED009TLL3). Blocks are produced by
 * `groupRecentDispatchesByTimeBlock`, ordered newest-first (most recent block
 * first) with the synthetic "Unknown time" block always last
 * (WL-0MVLEM606008UAL1).
 */
export interface DispatchTimeBlock {
  /**
   * UTC start of the block as ms since epoch (e.g. 00:00/04:00/…/20:00 UTC),
   * used for newest-first ordering (WL-0MVLEM606008UAL1).
   * `Number.NEGATIVE_INFINITY` for the unknown-time block so it never sorts
   * ahead of a real block.
   */
  startMs: number;
  /** True for the trailing block holding rows without a parseable timestamp. */
  unknownTime: boolean;
  /** Heading label, e.g. `29 Sep 2026, 00:00–04:00` or `Unknown time`. */
  label: string;
  /** Rows in the block, preserving the projection's newest-first ordering. */
  rows: RecentDispatchRow[];
}

/** UTC month abbreviations for the time-block heading (day month year). */
const TIME_BLOCK_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Two-digit zero-pad for a block boundary hour. */
function padHour(hour: number): string {
  return String(hour).padStart(2, '0');
}

/**
 * Heading label for the 4-hour UTC block a timestamp belongs to
 * (WL-0MUMM9NED009TLL3), e.g. `29 Sep 2026, 00:00–04:00`. The end of the
 * day's last block renders as `20:00–24:00`. A missing or unparseable
 * timestamp maps to {@link UNKNOWN_TIME_BLOCK_LABEL}.
 */
export function dispatchTimeBlockLabel(ts: string | undefined): string {
  if (ts === undefined) return UNKNOWN_TIME_BLOCK_LABEL;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return UNKNOWN_TIME_BLOCK_LABEL;
  const d = new Date(t);
  const startHour =
    Math.floor(d.getUTCHours() / DISPATCH_TIME_BLOCK_HOURS) * DISPATCH_TIME_BLOCK_HOURS;
  const endHour = startHour + DISPATCH_TIME_BLOCK_HOURS;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = TIME_BLOCK_MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}, ${padHour(startHour)}:00–${padHour(endHour)}:00`;
}

/**
 * Group projected recent-dispatch rows into 4-hour UTC time blocks
 * (WL-0MUMM9NED009TLL3). Each row is classified by its `latestTimestamp`
 * into the block that starts on the hour boundary (`00:00`, `04:00`, …,
 * `20:00` UTC) on the row's UTC calendar day, so blocks never merge across
 * midnight. Blocks are returned newest-first (most recent block first,
 * WL-0MVLEM606008UAL1); rows within a block keep the projection's
 * newest-first order. Rows with a missing or unparseable timestamp are
 * collected into a single trailing `Unknown time` block.
 *
 * Pure and total: an empty input yields `[]` and the function never throws.
 */
export function groupRecentDispatchesByTimeBlock(rows: RecentDispatchRow[]): DispatchTimeBlock[] {
  const known = new Map<number, DispatchTimeBlock>();
  const unknown: DispatchTimeBlock = {
    startMs: Number.NEGATIVE_INFINITY,
    unknownTime: true,
    label: UNKNOWN_TIME_BLOCK_LABEL,
    rows: [],
  };

  for (const row of rows) {
    const ts = row.latestTimestamp;
    const t = ts === undefined ? NaN : Date.parse(ts);
    if (Number.isNaN(t)) {
      unknown.rows.push(row);
      continue;
    }
    const d = new Date(t);
    const startHour =
      Math.floor(d.getUTCHours() / DISPATCH_TIME_BLOCK_HOURS) * DISPATCH_TIME_BLOCK_HOURS;
    const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), startHour);
    let block = known.get(startMs);
    if (block === undefined) {
      block = {
        startMs,
        unknownTime: false,
        label: dispatchTimeBlockLabel(ts),
        rows: [],
      };
      known.set(startMs, block);
    }
    block.rows.push(row);
  }

  // Newest block first (WL-0MVLEM606008UAL1): a "recent dispatches" view must
  // show the most recent activity at the top. The synthetic unknown-time block
  // has no date to sort by, so it stays last regardless of this sort.
  const blocks = [...known.values()].sort((a, b) => b.startMs - a.startMs);
  if (unknown.rows.length > 0) blocks.push(unknown);
  return blocks;
}

/**
 * Build the set of itemIds the downtime worker has already dispatched for
 * the given kind (kind-scoped). Entries without an itemId (e.g.
 * persistent-error events) are ignored. Entries with `outcome: 'spawn-failed'
 * are excluded (WL-0MT32F908002YFFA AC2): a spawn-failed dispatch is NOT
 * a success — the item should be re-eligible for selection on the next idle
 * period. Shared by the audit/implement/plan/intake marker readers so every
 * tier's scope guard stays identical.
 */
function dispatchedItemIds(entries: DowntimeLogEntry[], kind: string): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (!isDispatchMarkerEntry(e)) continue; // pane-close/lifecycle entries are not markers
    // Spawn-failed entries are non-excluding (WL-0MT32F908002YFFA AC2).
    if (e.outcome === 'spawn-failed') continue;
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
 * audit). Spawn-failed entries are ignored too (WL-0MT32F908002YFFA AC2):
 * a failed spawn is not an active run.
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
    if (!isDispatchMarkerEntry(e)) continue; // pane-close/lifecycle entries are not markers
    // Spawn-failed entries are non-excluding (WL-0MT32F908002YFFA AC2): a
    // failed spawn is NOT an active run — the pane never appeared, so a new
    // dispatch must not be blocked by it.
    if (e.outcome === 'spawn-failed') continue;
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
 * One success marker's lifetime data (WL-0MU6UL0RJ008IHGT): the worklog
 * stage the item was at when dispatched, plus the dispatch timestamp that
 * powers the staleness window. `stage` defaults to `''` for legacy entries
 * and `dispatchedAt` is `undefined` when missing/unparseable, so
 * malformed/foreign lines never break parsing (callers fail closed).
 */
export interface DispatchMarker {
  /** Worklog stage at dispatch; `''` when absent (legacy entry). */
  stage: string;
  /** ISO-8601 dispatch timestamp; `undefined` when missing/unparseable. */
  dispatchedAt?: string;
}

/**
 * Tier semantics for a legacy marker without a recorded stage (see
 * `markerStillExcludes`).
 *
 * - `'stage-guard'` (plan/intake/risk-effort tiers): a missing
 *   dispatched-at stage NEVER suppressed selection — the historical
 *   change-guard semantics (a legacy entry must not freeze an item).
 * - `'id-guard'` (audit/implement tiers): the historical id-set readers
 *   excluded on the id alone; an unknown stage must not weaken duplicate-
 *   dispatch protection for a possibly in-flight marker, so a legacy
 *   marker keeps excluding while fresh — only the age TTL releases it.
 */
export type MarkerStageGuardMode = 'stage-guard' | 'id-guard';

/**
 * Kind-scoped, staleness-aware success-marker map: itemId → the marker's
 * lifetime data (dispatched-at stage + dispatch timestamp) for the
 * dispatched-marker change-guard (WL-0MU6UL0RJ008IHGT). This is the
 * canonical reader for the success-marker staleness window: a marker
 * excludes its item only while the item is STILL at the marker's stage AND
 * the marker is fresh (age ≤ the configured staleness window). Spawn-failed
 * entries are excluded (WL-0MT32F908002YFFA AC2: a failed spawn is NOT a
 * success — the pane never appeared).
 *
 * Missing `stage` maps to `''` (legacy pre-stage entries, backward
 * compatible — see `markerStillExcludes` for how each tier mode treats
 * them); missing `dispatchedAt` maps to `undefined` (fail-closed — the
 * decision helper keeps excluding). When an itemId appears more than once,
 * the LAST entry wins (the most recent dispatch is the authoritative
 * marker: if it is fresh the item is in-flight; if it is stale every
 * earlier, older marker is staler).
 */
export function dispatchedItemMarkers(
  entries: DowntimeLogEntry[],
  kind: string,
): Map<string, DispatchMarker> {
  const markers = new Map<string, DispatchMarker>();
  for (const e of entries) {
    if (!isDispatchMarkerEntry(e)) continue; // pane-close/lifecycle entries are not markers
    // Spawn-failed entries are non-excluding (WL-0MT32F908002YFFA AC2).
    if (e.outcome === 'spawn-failed') continue;
    if (e.kind !== kind || typeof e.itemId !== 'string' || e.itemId.length === 0) continue;
    markers.set(e.itemId, {
      stage: typeof e.stage === 'string' ? e.stage : '',
      dispatchedAt: typeof e.dispatchedAt === 'string' ? e.dispatchedAt : undefined,
    });
  }
  return markers;
}

/**
 * Decide whether a dispatched SUCCESS marker still excludes its item from
 * re-dispatch (WL-0MU6UL0RJ008IHGT AC1/AC2/AC5).
 *
 * A marker keeps excluding ONLY while BOTH hold:
 *  1. the item has NOT advanced past the marker's dispatched-at stage
 *     (`itemStage === marker.stage`), and
 *  2. the marker is still fresh — its age is ≤ `stalenessWindowMs`.
 *
 * Fail-closed (AC5): a MISSING or UNPARSEABLE `dispatchedAt` keeps
 * excluding — the staleness window cannot be proven, so the item stays
 * protected against double dispatch. At exactly `stalenessWindowMs` the
 * marker still excludes; one ms past the window it releases ("exceeds"
 * the window per AC1).
 *
 * A stage advancement releases the marker exactly as the historical
 * change-guard did (AC2 — no behaviour change for healthy flow). Legacy
 * markers without a recorded stage follow `mode` (see
 * `MarkerStageGuardMode`).
 */
export function markerStillExcludes(
  marker: DispatchMarker,
  itemStage: string | undefined,
  now: number,
  stalenessWindowMs: number,
  mode: MarkerStageGuardMode = 'id-guard',
): boolean {
  if (marker.stage === '') {
    // Legacy marker without a recorded stage. Stage-guard tiers release it
    // (historical semantics); id-guard tiers keep excluding while fresh so
    // a possibly-in-flight marker is never double-dispatched, and the age
    // TTL below still releases it once stale.
    if (mode === 'stage-guard') return false;
  } else if (marker.stage !== (itemStage ?? '')) {
    // The item advanced past its dispatched-at stage → released (AC2).
    return false;
  }
  // Flowing through here: same stage (or unknown stage under id-guard) —
  // the marker's age decides, fail-closed on unproven freshness.
  if (marker.dispatchedAt === undefined) return true;
  const t = Date.parse(marker.dispatchedAt);
  if (Number.isNaN(t)) return true; // unparseable → fail-closed: keep excluding
  return now - t <= stalenessWindowMs;
}

// ── Per-item/per-kind dispatch-attempt budget (WL-0MUKYEXMK0033MFK) ───

/**
 * Count dispatch ATTEMPTS for one `(itemId, kind)` pair at the item's
 * CURRENT stage (WL-0MUKYEXMK0033MFK AC1).
 *
 * An "attempt" is a dispatch-marker entry for the kind — the same predicate
 * the success-marker readers use (`isDispatchMarkerEntry`), so pane-close
 * lifecycle entries are not counted on their own: each non-terminal close
 * still counts exactly once, via the dispatch marker that opened its pane.
 * Two entry kinds are excluded from the count because they do not represent
 * an opened pane:
 *
 *  - `outcome: 'spawn-failed'` traces — the pane never appeared (same
 *    non-excluding convention as the marker readers, WL-0MT32F908002YFFA);
 *  - `enrichment: true` entries — the best-effort post-spawn enrichment
 *    copies the marker verbatim and would otherwise double-count a single
 *    dispatch (WL-0MUBVL251006JAQ0).
 *
 * BUDGET RESET ON STAGE ADVANCEMENT (AC4): only markers whose dispatched-at
 * `stage` equals the item's current stage count. A marker written before an
 * advancement carries the old stage and no longer counts, giving the item a
 * fresh budget at its new stage. Legacy markers without a recorded stage
 * are treated as `''` and never match a real stage, so a partial/legacy log
 * under-counts (fail-open) rather than over-counting.
 *
 * FAIL-OPEN (AC7e): a missing/unreadable/corrupt log yields no entries (see
 * `readDowntimeLogEntries`) and therefore a count of 0 — a bad log can never
 * block all dispatch. Never throws.
 */
export function countAttempts(
  entries: DowntimeLogEntry[],
  itemId: string,
  kind: string,
  itemStage: string | undefined,
): number {
  const stage = itemStage ?? '';
  let count = 0;
  for (const e of entries) {
    if (!isDispatchMarkerEntry(e)) continue;
    if (e.outcome === 'spawn-failed') continue;
    if (e.enrichment === true) continue;
    if (e.kind !== kind || e.itemId !== itemId) continue;
    const entryStage = typeof e.stage === 'string' ? e.stage : '';
    if (entryStage !== stage) continue;
    count += 1;
  }
  return count;
}

// ── Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5) ────────────

/**
 * Worklog stage rank used by the non-terminal pane-close cooldown to detect
 * stage advancement (WL-0MUKYERLZ006ELL5). Higher means further through the
 * lifecycle; an unknown stage ranks -1 so it never looks "advanced".
 */
const NON_TERMINAL_COOLDOWN_STAGE_RANK: Record<string, number> = {
  idea: 0,
  intake_complete: 1,
  plan_complete: 2,
  in_review: 3,
};

/**
 * Reason codes on a pane-close entry that represent a TERMINAL close — the
 * item genuinely reached a terminal stage or the pane finished cleanly.
 * `'none'` covers `closed-as-intake-complete` / `closed-as-plan-complete` /
 * `audit-passed` / `audit-failed`; `'reached-in-review'` is the implement-pane
 * success close (parent AC5). Any OTHER code — including future/unknown or
 * absent ones — is treated as NON-terminal (fail-closed).
 */
const TERMINAL_PANE_CLOSE_REASON_CODES: ReadonlySet<string> = new Set([
  'none',
  'reached-in-review',
]);

function cooldownStageRank(stage: string | undefined): number {
  if (typeof stage !== 'string') return -1;
  return NON_TERMINAL_COOLDOWN_STAGE_RANK[stage] ?? -1;
}

/**
 * Decide whether a MINIMUM COOLDOWN still excludes an item from re-dispatch
 * after a NON-TERMINAL pane close (WL-0MUKYERLZ006ELL5). Neutral sequential
 * filter (never a strike, never a `no-candidate`): it consults the most recent
 * `entryType: 'pane-close'` entry for the `(itemId, kind)` pair and returns
 * true (skip) while that close:
 *
 *  1. is NON-terminal — its `reasonCode` is not in
 *     {@link TERMINAL_PANE_CLOSE_REASON_CODES} (fail-closed: unknown/absent
 *     codes are non-terminal), AND
 *  2. the item has NOT advanced past the close's dispatched-at `stage`
 *     (parent AC4; a genuinely progressed item is released immediately), AND
 *  3. is younger than `cooldownMs` (`now - closeTime < cooldownMs`).
 *
 * Returns false when there is no close record, the close was terminal, the item
 * advanced, or the cooldown has elapsed. FAIL-CLOSED: a missing or unparseable
 * close timestamp returns true (safe no-dispatch), bounded by the
 * stage-advancement release. The most recent close wins — a later terminal
 * close supersedes an earlier failure, and a later failure re-arms.
 */
export function isNonTerminalCooldownActive(
  entries: DowntimeLogEntry[],
  itemId: string,
  kind: string,
  itemStage: string | undefined,
  cooldownMs: number,
  now: number = Date.now(),
): boolean {
  // Most-recent close for this (itemId, kind) wins (append order).
  let latest: DowntimeLogEntry | undefined;
  for (const e of entries) {
    if (e.entryType !== 'pane-close') continue;
    if (e.itemId !== itemId || e.kind !== kind) continue;
    latest = e;
  }
  if (latest === undefined) return false;

  // Terminal close → no cooldown (parent AC5). Fail-closed: unknown/absent
  // codes are non-terminal.
  const reasonCode = typeof latest.reasonCode === 'string' ? latest.reasonCode : '';
  if (TERMINAL_PANE_CLOSE_REASON_CODES.has(reasonCode)) return false;

  // Stage advancement releases (parent AC4). Only release when the
  // dispatched-at stage is KNOWN and the current stage is strictly higher —
  // a close without a recorded stage cannot prove progress, so it stays held
  // (fail-closed; the age check below still bounds it).
  const dispatchedRank = cooldownStageRank(latest.stage);
  const currentRank = cooldownStageRank(itemStage);
  if (dispatchedRank >= 0 && currentRank > dispatchedRank) return false;

  // Age check. Missing/unparseable timestamp → fail-closed skip.
  if (typeof latest.timestamp !== 'string') return true;
  const t = Date.parse(latest.timestamp);
  if (Number.isNaN(t)) return true;
  return now - t < cooldownMs;
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
 * Build the set of itemIds the downtime worker has already dispatched for
 * risk-effort evaluation (`kind === 'risk-effort'` entries only). Entries
 * without an itemId are ignored. A risk-effort marker prevents re-dispatching
 * the evaluation until the item advances past plan_complete (WL-0MTTSWCJR003OMN7).
 */
export function riskEffortDispatchedItemIds(entries: DowntimeLogEntry[]): Set<string> {
  return dispatchedItemIds(entries, 'risk-effort');
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
    if (!isDispatchMarkerEntry(e)) continue; // pane-close/lifecycle entries are not markers
    // Spawn-failed entries are non-excluding (WL-0MT32F908002YFFA AC2).
    if (e.outcome === 'spawn-failed') continue;
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
 * Bounded JSONL append shared by the dispatch and coordination logs.
 *
 * DISPATCH log (no `rotate` policy, `appendDowntimeLogEntry`/
 * `appendPaneCloseLogEntry`): write `line` to `<cwd>/.worklog/<file>`, creating
 * `.worklog` if needed and trimming to the most recent DOWNTIME_LOG_MAX_ENTRIES
 * lines (unchanged behaviour — the dispatched-marker readers depend on it).
 *
 * COORDINATION log (a `rotate` policy, `appendCoordinationLogEntry`):
 * size-based rotation with N kept (WL-0MVKNC28B003UOLX AC2). The current file
 * holds up to `rotate.maxEntries`; when the next append would exceed it the
 * whole current file rotates to `.1` (older siblings shift down; the oldest
 * beyond `rotate.maxRotatedFiles` is dropped) and a fresh current file — with
 * just the new line — starts, so the entry that triggers the rotation is
 * never lost (AC4). A pre-existing oversized current file (e.g. from the old
 * 100-entry era) is healed on the next append: it rotates wholesale before
 * the new line lands, so nothing is discarded.
 *
 * ATOMIC (WL-0MUBVL1FI0071WN3 / F5): every file write — current AND rotated
 * siblings — goes to a temporary sibling file and is `rename`d over the
 * target, so a concurrent reader can never observe a truncated, empty, or
 * partially written file. Rotation orders the writes so the CURRENT path
 * always exists with a complete snapshot: the full old content is written to
 * `.1` BEFORE the current file is replaced with the fresh single-line file.
 * `rename(2)` is atomic within a filesystem, so the temp file is created in
 * the SAME directory as the target. The temp file is removed on failure
 * before the error is rethrown (and the target is left untouched). Throws on
 * I/O failure — callers must catch (fail-closed).
 */
async function appendRollingJsonl(
  cwd: string,
  file: string,
  line: string,
  rotate?: CoordinationLogPolicy,
): Promise<void> {
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

  if (rotate === undefined) {
    // Dispatch log: legacy single-file rolling bound (unchanged).
    lines.push(line);
    if (lines.length > DOWNTIME_LOG_MAX_ENTRIES) {
      lines = lines.slice(lines.length - DOWNTIME_LOG_MAX_ENTRIES);
    }
    await atomicWriteJsonl(dir, file, lines);
    return;
  }

  if (rotate.maxRotatedFiles === 0) {
    // Rotation disabled: single-file trim at the configured per-file cap.
    lines.push(line);
    if (lines.length > rotate.maxEntries) {
      lines = lines.slice(lines.length - rotate.maxEntries);
    }
    await atomicWriteJsonl(dir, file, lines);
    return;
  }

  if (lines.length >= rotate.maxEntries) {
    // Current file is full: rotate it aside BEFORE appending, so the entry
    // that triggers the rotation is never lost (AC4).
    await rotateCoordinationFile(dir, file, rotate, lines);
    await atomicWriteJsonl(dir, file, [line]);
  } else {
    lines.push(line);
    await atomicWriteJsonl(dir, file, lines);
  }
}

/**
 * Rotate the full current coordination-log content to `.1`, shifting the
 * existing siblings down so `.1` is always the NEWEST rotated file and the
 * oldest beyond `policy.maxRotatedFiles` is dropped. Every shift uses
 * `rename(2)` (atomic, overwrites the destination); `.1` is written with an
 * atomic tmp+rename so the current file is only ever replaced afterwards by
 * the caller (no empty/partial current snapshot). Best-effort: a missing
 * sibling at a level is simply skipped. Throws on I/O failure — callers must
 * catch (fail-closed).
 */
async function rotateCoordinationFile(
  dir: string,
  file: string,
  policy: CoordinationLogPolicy,
  currentLines: string[],
): Promise<void> {
  // Shift `.k` → `.k+1` for the retained siblings, oldest first: the last
  // shift overwrites (drops) the sibling beyond `maxRotatedFiles`.
  for (let k = policy.maxRotatedFiles - 1; k >= 1; k--) {
    try {
      await rename(join(dir, `${file}.${k}`), join(dir, `${file}.${k + 1}`));
    } catch {
      // ENOENT: no sibling at this level yet (early rotations) — nothing to shift.
    }
  }
  // The full old current content lands in `.1` (newest rotated file).
  await atomicWriteJsonl(dir, `${file}.1`, currentLines);
}

/**
 * Atomic JSONL file write (WL-0MUBVL1FI0071WN3 / F5): write `lines` to a
 * temporary sibling file (`.<file>.<pid>.<random>.tmp` in the same directory,
 * so the rename stays on one filesystem) and `rename` it over the target. A
 * concurrent reader sees either the whole previous file or the whole new one.
 * The temp name carries pid + a random suffix so two concurrent writers never
 * collide on the same temp path. The temp file is removed on failure before
 * the error is rethrown and the target is left untouched. Throws on I/O
 * failure — callers must catch.
 */
async function atomicWriteJsonl(dir: string, file: string, lines: string[]): Promise<void> {
  const filePath = join(dir, file);
  const tmpPath = join(dir, `.${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
    await rename(tmpPath, filePath);
  } catch (err) {
    // Clean up the temp file (best-effort) and leave the target untouched.
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
