/**
 * packages/herdr/src/downtime-log-coordination.ts — the downtime
 * coordination / decision log (WL-0MVGKHFT4003X6JW, split out of
 * `downtime-log.ts`).
 *
 * Single responsibility: the coordination-log **entry shape**
 * (`CoordinationLogEntry`), its fail-closed append, the tolerant readers
 * (current file and the full rotated history) and the operator-facing
 * per-hour reason tally. Storage mechanics — file name, retention policy,
 * atomic write, rotation — belong to `downtime-log-storage.ts`.
 *
 * Every log lives at `<cwd>/.worklog/downtime-coordination.log` (the
 * `.worklog` directory is gitignored, so the file is a local artifact; the
 * deferred F6 WL-0MTII4CWT00452HU decision keeps dispatch/coordination logs
 * per-root rather than machine-wide).
 *
 * Extracted verbatim from `downtime-log.ts`; behaviour is unchanged.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuditBudgetDivergence, HostBudgetEvidence } from './downtime-log-budget.js';
import {
  COORDINATION_LOG_FILE,
  appendRollingJsonl,
  parseJsonlLines,
  resolveCoordinationLogPolicy,
  type CoordinationLogPolicyInput,
} from './downtime-log-storage.js';

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
  /**
   * Number of entries removed by a prune operation: `1` on each PER-ENTRY
   * prune record (a tick's tally is its number of `prune` records — one
   * record per pruned entry, never one per tick).
   */
  prunedCount?: number;
  /**
   * Dead-entry prune attribution (WL-0MWFJTKGM006BHLQ): the pruned entry's
   * worklog root — recorded so the log names the dead instance's root.
   * Additive/optional: every earlier entry shape is unchanged.
   */
  worklogRoot?: string;
  /**
   * Dead-entry prune attribution (WL-0MWFJTKGM006BHLQ): the pruned entry's
   * last-seen ISO timestamp (its `lastUpdated` at prune time). Additive/
   * optional: every earlier entry shape is unchanged.
   */
  lastSeen?: string;
  /**
   * Dead-entry prune attribution (WL-0MWFJTKGM006BHLQ): the staleness
   * window (ms) the leader applied when it pruned the entries. Additive/
   * optional: every earlier entry shape is unchanged.
   */
  staleWindowMs?: number;
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
  /**
   * Host-wide dispatch-budget evidence (WL-0MVXY0ZYW009NEJD F5 AC1): recorded
   * on a decision entry whose `reason` is one of
   * {@link HOST_BUDGET_DECISION_REASONS}, carrying the tier's observed
   * in-flight count and cap. Additive and optional — every earlier entry shape
   * is unchanged (an absent figure is honestly "no budget evidence", never a
   * fabricated 0/0).
   */
  budget?: HostBudgetEvidence;
  /**
   * Failing exchange on a fail-closed AUDIT-budget refusal
   * (WL-0MWDDHVF2004PTYX AC3): `http-404` (endpoint-absent), `timeout` /
   * `network` / `http-<status>` (unreachable), `bad-body` (unparsable) or
   * `seam-absent` (no client wired), copied from the dispatch outcome so the
   * decision entry names the broken proxy contract without reading code.
   * Absent on every other entry (additive/optional schema).
   */
  detail?: string;
  /**
   * Proxy/local audit-budget divergence evidence (WL-0MWAMSK9H005BOHD, parent
   * AC2): recorded on a `kind: 'decision'` entry whose `reason` is
   * `audit-budget-divergence`, carrying both the proxy's verdict/figures and
   * the local ledger's figures. Additive and optional — every earlier entry
   * shape is unchanged.
   */
  auditBudget?: AuditBudgetDivergence;
  /** The wl/CLI error that caused an entry-kept check-in (`reason: 'wl-error'`). */
  error?: string;
  /**
   * Per-bucket widening signal (WL-0MWFJ8R1P005G1H1): recorded on a
   * successful `operation: 'checkin'` entry whose computation filled at
   * least one bucket from beyond the visible window. `buckets` names those
   * buckets (canonical `COORDINATION_OFFER_BUCKETS` order) and `itemsRead`
   * counts the extra ranked items read to fill them, so an operator can see
   * a root being reached past its visible list. Absent on window-only
   * check-ins (additive/optional schema — every earlier entry is unchanged).
   */
  filledBeyondWindow?: {
    buckets: Array<'implement' | 'audit' | 'prep'>;
    itemsRead: number;
  };
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

/**
 * Append one `operation: 'prune'` coordination-log record PER pruned entry
 * (WL-0MWFJTKGM006BHLQ), in order, through the configured rolling policy —
 * the prune AND its log complete before the leader's own check-in append
 * starts, so no read-modify-write race loses a record. The caller composes
 * this with {@link pruneDeadEntries} (the purely-logging split keeps the
 * log module free of a coordination runtime import cycle). Fail-open
 * end-to-end: an append failure never throws and never blocks a dispatch.
 */
export async function logPrunedEntries(
  cwd: string,
  pruned: readonly { instanceId: string; worklogRoot: string; lastSeen: string }[],
  staleWindowMs: number,
  at: string,
  policy?: CoordinationLogPolicyInput,
): Promise<void> {
  for (const removed of pruned) {
    // One record PER pruned entry (never one per tick) — a tick's tally is
    // its number of prune records, so the coordination log stays bounded.
    await appendCoordinationLogEntry(
      cwd,
      {
        kind: 'coordination',
        operation: 'prune',
        instanceId: removed.instanceId,
        worklogRoot: removed.worklogRoot,
        lastSeen: removed.lastSeen,
        prunedCount: 1,
        reason: 'staleness-window',
        staleWindowMs,
        at,
      },
      policy,
    );
  }
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
