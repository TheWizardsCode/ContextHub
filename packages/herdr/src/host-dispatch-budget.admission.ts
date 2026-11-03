/**
 * packages/herdr/src/host-dispatch-budget.admission.ts — the dispatcher's
 * host-wide admission read for the implement and audit tiers
 * (WL-0MVXY0YG7009JMHI F3, WL-0MVXY0XPF006YUHA F2, parent WL-0MVXWQFGV000D2AB).
 *
 * Single responsibility: turn the machine-scoped ledger (F1,
 * `host-dispatch-budget.ts`) plus the live pane list into exactly ONE
 * admission decision for a dispatch — admit (and reserve), refuse because the
 * tier is at/over its cap, or refuse because the ledger cannot be trusted
 * (fail closed + repair from live state). The ledger contract itself
 * (read/reserve/release/reap, configuration, liveness table) lives in
 * `host-dispatch-budget.ts` and is not restated here.
 *
 * ## Per-tier counting (deliberate asymmetry)
 *
 *  - **implement** counts fresh entries whose pane is in the live pane list
 *    (`liveCount`). A reserved-but-unspawned entry is invisible until its pane
 *    id is confirmed.
 *  - **audit** counts fresh entries with NO live-pane requirement
 *    (`freshCount`), which is exactly the semantics of the retired host-wide
 *    `active-audit` marker: the slot is held from the reservation until a
 *    release point fires (audit pane close, dispatch/spawn failure, claim
 *    rollback) and is released by the 2 h staleness window. That is what makes
 *    `maxAudit: 1` indistinguishable from the marker it replaces. A non-stale
 *    legacy marker file is counted as one synthetic entry on read.
 *
 * ## Fail directions (deliberate, parent AC9)
 *
 *  - **Unresolvable coordination dir** (`no-coordination-dir`): ADMIT. With no
 *    machine dir there is no ledger and no new failure mode — behaviour
 *    degrades exactly as before the budget existed (parent AC11).
 *  - **Ledger exists but cannot be trusted** (`unknown: true` — corrupt bytes,
 *    an invalid document, an unreadable file): REFUSE with
 *    `host-budget-unknown`, and rewrite the ledger from the live pane list so
 *    the NEXT tick can make a real decision (AC6). A dropped/ignored unknown
 *    read would under-count and admit work the operator capped.
 *  - **Lock contention / I/O failure while reserving**: REFUSE with
 *    `host-budget-unknown`. The reservation could not be recorded, so the
 *    dispatcher cannot prove the host is within budget — the fail-closed arm.
 *
 * ## Reserve, confirm, release
 *
 * `admitHostDispatch` is the ONLY admission reader, so both dispatcher paths
 * (`dispatchDowntimeWork` and `dispatchFromCoordination`) funnel through it
 * exactly once per dispatch attempt via the claim→marker→spawn choke point
 * (`dispatchClaimedTier`, AC1). The entry is reserved immediately after the
 * CAS claim succeeds (AC3), confirmed with the pane id once the pane exists,
 * and released (idempotently) on every abort path and on pane close; stale
 * entries are reaped by the ledger's own `liveCount` read (AC8).
 *
 * scope: both tiers enforce here — the implement tier (F3) and the audit tier
 * (F2). The audit tier's pre-check (`readAuditBudgetState`, consumed by
 * `getActiveAudit`) is a READ, never a reservation: the authoritative
 * reservation still happens once, in the claim→marker→spawn choke point, so a
 * refusal before selection and a refusal at admission agree.
 *
 * Layering: the decision is a thin orchestration over F1's pure helpers and
 * fs-backed ledger API; all arithmetic (caps, staleness, counting) stays in
 * `host-dispatch-budget.ts`.
 */

import {
  freshCount,
  liveCount,
  readBudgetConfig,
  release,
  replaceBudget,
  reserve,
  type HostBudgetEntry,
  type HostBudgetKind,
  type HostBudgetLivePane,
  type HostBudgetOptions,
} from './host-dispatch-budget.js';
import { DOWNTIME_PANE_LABEL_PREFIX, paneLabelItemId } from './downtime-worker.pane.js';
import {
  HOST_BUDGET_AUDIT_REASON,
  HOST_BUDGET_IMPLEMENT_REASON,
  HOST_BUDGET_UNKNOWN_REASON,
} from './downtime-log.js';

export type { HostBudgetLivePane } from './host-dispatch-budget.js';

/**
 * Refusal reason: the tier is at/over its machine-wide cap.
 *
 * The three budget tokens are defined by the decision log's vocabulary of
 * record (`downtime-log.ts`, WL-0MVXY0ZYW009NEJD F5) and re-exported here under
 * the names admission has always used — one spelling, so the decision entry,
 * the header token and the stderr skip line can never drift.
 */
export const HOST_BUDGET_IMPLEMENT_REFUSAL = HOST_BUDGET_IMPLEMENT_REASON;

/** Refusal reason: the tier is at/over its machine-wide cap (audit tier). */
export const HOST_BUDGET_AUDIT_REFUSAL = HOST_BUDGET_AUDIT_REASON;

/**
 * Refusal reason: the AUDIT tier is at its cap with `maxAudit: 1`
 * (WL-0MVXY0XPF006YUHA F2 AC1). The legacy marker produced this token, so the
 * default single-flight case stays byte-identical in the decision log and
 * every existing consumer of `audit-host-saturated` keeps working; the audit
 * tier uses `host-budget-audit` at every other cap.
 */
export const HOST_BUDGET_AUDIT_SATURATED_REFUSAL = 'audit-host-saturated';

/** Refusal reason: the ledger could not be trusted (fail closed + repair). */
export const HOST_BUDGET_UNKNOWN_REFUSAL = HOST_BUDGET_UNKNOWN_REASON;

/** The refusal tokens this module can return. */
export type HostBudgetRefusalReason =
  | typeof HOST_BUDGET_IMPLEMENT_REFUSAL
  | typeof HOST_BUDGET_AUDIT_REFUSAL
  | typeof HOST_BUDGET_AUDIT_SATURATED_REFUSAL
  | typeof HOST_BUDGET_UNKNOWN_REFUSAL;

/** The refusal tokens the AUDIT tier can report (never `host-budget-implement`). */
export type HostBudgetAuditRefusalReason =
  | typeof HOST_BUDGET_AUDIT_REFUSAL
  | typeof HOST_BUDGET_AUDIT_SATURATED_REFUSAL
  | typeof HOST_BUDGET_UNKNOWN_REFUSAL;

/** One dispatch asking the host for a slot. */
export interface HostBudgetAdmissionInput {
  kind: HostBudgetKind;
  itemId: string;
  /** Instance identity recorded on the entry (diagnostics only). */
  instanceId: string;
  /** Absolute worklog root the dispatch operates on. */
  root: string;
  /** Pane id when one already exists (absent at admission time). */
  paneId?: string;
}

/** Admission options: the machine-dir/clock seams plus the live pane list. */
export interface HostBudgetAdmissionOptions extends HostBudgetOptions {
  /**
   * The caller's live pane list. Only panes whose `paneId` appears here make a
   * reserved implement entry count (the F1 liveness table), so the caller must
   * pass the machine-wide downtime pane list, not a per-root subset. The audit
   * tier uses the same list only to REPAIR an unreadable ledger (AC6).
   */
  livePanes: readonly HostBudgetLivePane[];
  /**
   * Instance identity recorded on entries reconstructed by a repair
   * (diagnostics only). Defaults to this plugin process.
   */
  instanceId?: string;
  /** Worklog root recorded on entries reconstructed by a repair. */
  root?: string;
}

/** The admission verdict. `live`/`max` are the evidence the caller reports. */
export interface HostBudgetAdmission {
  admitted: boolean;
  /** Live dispatches of this kind (before this dispatch starts). */
  live: number;
  /** The tier's configured cap. */
  max: number;
  /** Present only on a refusal. */
  reason?: HostBudgetRefusalReason;
  /** True when an unreadable ledger was rewritten from live state (AC6). */
  repaired?: boolean;
}

function refuseReason(kind: HostBudgetKind): HostBudgetRefusalReason {
  return kind === 'audit' ? HOST_BUDGET_AUDIT_REFUSAL : HOST_BUDGET_IMPLEMENT_REFUSAL;
}

function kindOf(pane: HostBudgetLivePane): HostBudgetKind {
  const title = pane.title;
  if (typeof title === 'string') {
    const match = /^Downtime (?:triggered )?(implement|audit)\b/.exec(title);
    if (match !== null) return match[1] as HostBudgetKind;
  }
  // Conservative default: a live downtime pane whose kind cannot be read is
  // counted against the implement tier. Over-counting refuses a dispatch
  // (fail-closed); guessing `audit` could over-admit implement work.
  return 'implement';
}

function entriesFromLivePanes(
  livePanes: readonly HostBudgetLivePane[],
  input: HostBudgetAdmissionInput,
  now: number,
): HostBudgetEntry[] {
  const at = new Date(now).toISOString();
  const entries: HostBudgetEntry[] = [];
  const seen = new Set<string>();
  for (const pane of livePanes) {
    // Only dispatcher-created panes can be reconstructed: their title carries
    // the downtime prefix and the work-item id suffix. Any other live pane is
    // not evidence of a dispatch (and must never be counted as one).
    if (typeof pane.title !== 'string' || !pane.title.startsWith(DOWNTIME_PANE_LABEL_PREFIX)) {
      continue;
    }
    const itemId = paneLabelItemId(pane.title);
    if (itemId === null || seen.has(itemId)) continue;
    seen.add(itemId);
    entries.push({
      kind: kindOf(pane),
      itemId,
      instanceId: input.instanceId,
      paneId: pane.paneId,
      root: input.root,
      startedAt: at,
      heartbeatAt: at,
    });
  }
  return entries;
}

/**
 * Rewrite an unreadable ledger from the live pane list (AC6).
 *
 * Only live downtime panes whose label carries a work-item id can be
 * reconstructed (`paneLabelItemId` — the dispatcher's own pane-title
 * convention); a pane with no id is skipped because there is no entry key to
 * write. Best-effort: returns false when the write fails, which does NOT
 * change the refusal (the tick is skipped either way).
 */
export function repairLedgerFromLivePanes(
  livePanes: readonly HostBudgetLivePane[],
  input: HostBudgetAdmissionInput,
  opts: HostBudgetOptions = {},
): boolean {
  const entries = entriesFromLivePanes(livePanes, input, opts.now ?? Date.now());
  return replaceBudget(entries, opts).ok;
}

/**
 * Options for the audit tier's admission pre-check ({@link readAuditBudgetState}).
 *
 * `livePanes` is OPTIONAL and only consulted when the ledger cannot be read
 * (AC6): the dispatch loop calls this pre-check once per audit candidate, so an
 * eager pane-list subprocess would add a `herdr pane list` per candidate. Absent
 * panes means "cannot repair now" — the tick still fails closed, and the next
 * call that can supply panes repairs the ledger.
 */
export interface HostBudgetAuditStateOptions extends HostBudgetOptions {
  /** Live pane list used ONLY to repair an unreadable ledger (AC6). */
  livePanes?: readonly HostBudgetLivePane[];
  /** Instance identity recorded on repaired entries (diagnostics only). */
  instanceId?: string;
  /** Worklog root recorded on repaired entries. */
  root?: string;
}

/**
 * The audit tier's budget state (WL-0MVXY0XPF006YUHA F2).
 *
 * `atCap` is the single admission answer: `true` means the audit tier admits no
 * further dispatch this tick. `reason` is the token the dispatcher reports —
 * `audit-host-saturated` at `maxAudit: 1` (the legacy marker token, AC1),
 * `host-budget-audit` for every other cap (AC3) and `host-budget-unknown` for a
 * fail-closed unreadable ledger (AC6). `live`/`max` are the reported evidence
 * (`0/0` for a disabled tier).
 */
export interface HostBudgetAuditState {
  atCap: boolean;
  live: number;
  max: number;
  reason?: HostBudgetAuditRefusalReason;
  /** True when an unreadable ledger was rewritten from live state (AC6). */
  repaired?: boolean;
}

/**
 * The audit tier's admission read — the pre-check the dispatcher's
 * `getActiveAudit` consults where the retired `active-audit` marker was read.
 *
 * Never throws and never reserves. The order is significant:
 *
 *  1. resolve the effective cap (`budget.json` + env, default `maxAudit: 1`);
 *  2. `max === 0` ⇒ at cap with `live`/`max` `0/0` and `host-budget-audit`
 *     (AC3 — a disabled tier is refused whatever the ledger holds);
 *  3. count fresh audit entries (no live-pane requirement, plus a non-stale
 *     legacy marker as one synthetic entry);
 *  4. unreadable ledger ⇒ repair from the live pane list and report
 *     `host-budget-unknown` (AC6 — fail closed, self-heal for the next tick);
 *  5. unresolvable coordination dir ⇒ not at cap: with no machine dir there is
 *     no ledger and no new failure mode (parent AC11);
 *  6. at/over cap ⇒ `audit-host-saturated` when `max === 1`, otherwise
 *     `host-budget-audit` (AC1/AC3).
 */
export function readAuditBudgetState(
  opts: HostBudgetAuditStateOptions,
): HostBudgetAuditState {
  const ledgerOptions: HostBudgetOptions = {
    dir: opts.dir,
    now: opts.now,
    staleWindowMs: opts.staleWindowMs,
    env: opts.env,
  };
  const { config } = readBudgetConfig(ledgerOptions);
  const max = config.maxAudit;
  if (max === 0) {
    // AC3: disabled tier — refused host-wide with the documented 0/0 evidence.
    return { atCap: true, live: 0, max: 0, reason: HOST_BUDGET_AUDIT_REFUSAL };
  }

  const count = freshCount('audit', ledgerOptions);
  if (!count.ok) {
    if (!count.unknown && count.reason === 'no-coordination-dir') {
      // Parent AC11: no machine dir ⇒ no ledger, no new failure mode.
      return { atCap: false, live: 0, max };
    }
    // Repair from observed live state only when the caller could supply a pane
    // list; a caller that cannot (the per-candidate pre-check) still fails
    // closed, and the next pane-carrying call self-heals the ledger.
    const repaired =
      opts.livePanes === undefined
        ? false
        : repairLedgerFromLivePanes(
            opts.livePanes,
            {
              kind: 'audit',
              // The synthetic entry key is never written by a repair:
              // reconstructed entries take their own item ids from the pane
              // labels.
              itemId: '',
              instanceId: opts.instanceId ?? `herdr:${process.pid}`,
              root: opts.root ?? '',
            },
            ledgerOptions,
          );
    return { atCap: true, live: 0, max, reason: HOST_BUDGET_UNKNOWN_REFUSAL, repaired };
  }

  if (count.count >= max) {
    return {
      atCap: true,
      live: count.count,
      max,
      // AC1: the single-flight default keeps the marker's reason token; any
      // other cap reports the budget's own token (AC3).
      reason:
        max === 1 ? HOST_BUDGET_AUDIT_SATURATED_REFUSAL : HOST_BUDGET_AUDIT_REFUSAL,
    };
  }
  return { atCap: false, live: count.count, max };
}

/**
 * One admission decision for one dispatch attempt.
 *
 * Never throws; every outcome is expressed as `admitted` plus the `live`/`max`
 * evidence. The implement tier follows the original order:
 *
 *  1. resolve the effective cap (config + env, defaults absent a file);
 *  2. `max === 0` ⇒ refuse immediately with `live`/`max` `0/0` (AC4 — a
 *     disabled tier is refused regardless of what the ledger holds);
 *  3. count live dispatches (reaping stale, pane-less entries on read);
 *  4. unreadable ledger ⇒ repair from live panes and refuse (`unknown`);
 *  5. at/over cap ⇒ refuse with the observed `live`/`max` (AC2);
 *  6. otherwise reserve the slot and admit.
 *
 * The audit tier delegates its count/cap decision to
 * {@link readAuditBudgetState} (so the pre-check and admission can never
 * disagree) and reserves only when that state admits.
 */
export function admitHostDispatch(
  input: HostBudgetAdmissionInput,
  opts: HostBudgetAdmissionOptions,
): HostBudgetAdmission {
  const ledgerOptions: HostBudgetOptions = {
    dir: opts.dir,
    now: opts.now,
    staleWindowMs: opts.staleWindowMs,
    env: opts.env,
  };
  if (input.kind === 'audit') {
    const state = readAuditBudgetState(opts);
    if (state.atCap) {
      return {
        admitted: false,
        live: state.live,
        max: state.max,
        reason: state.reason ?? HOST_BUDGET_AUDIT_REFUSAL,
        ...(state.repaired === true ? { repaired: true } : {}),
      };
    }
    const reserved = reserve(
      {
        kind: input.kind,
        itemId: input.itemId,
        instanceId: input.instanceId,
        root: input.root,
        ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
      },
      ledgerOptions,
    );
    if (!reserved.ok) {
      if (!reserved.unknown && reserved.reason === 'no-coordination-dir') {
        // Parent AC11 (WL-0MVXY11IL0032S07): an unresolvable machine dir means
        // there is no ledger and no new failure mode — exactly as before the
        // budget existed. The audit tier must therefore admit without a
        // reservation (mirroring the implement tier's early no-dir return).
        return { admitted: true, live: state.live, max: state.max };
      }
      // The reservation could not be recorded — the host's in-flight audits can
      // no longer be proven within budget, so fail closed.
      return {
        admitted: false,
        live: state.live,
        max: state.max,
        reason: HOST_BUDGET_UNKNOWN_REFUSAL,
      };
    }
    return { admitted: true, live: state.live, max: state.max };
  }

  const { config } = readBudgetConfig(ledgerOptions);
  const max = config.maxImplement;
  if (max === 0) {
    // AC4: disabled tier — refused host-wide with the documented 0/0 evidence.
    return { admitted: false, live: 0, max: 0, reason: refuseReason(input.kind) };
  }

  const count = liveCount(input.kind, opts.livePanes, ledgerOptions);
  if (!count.ok) {
    if (!count.unknown && count.reason === 'no-coordination-dir') {
      // Parent AC11: no machine dir ⇒ no ledger, no new failure mode.
      return { admitted: true, live: 0, max };
    }
    const repaired = repairLedgerFromLivePanes(opts.livePanes, input, ledgerOptions);
    return {
      admitted: false,
      live: 0,
      max,
      reason: HOST_BUDGET_UNKNOWN_REFUSAL,
      repaired,
    };
  }

  if (count.count >= max) {
    return {
      admitted: false,
      live: count.count,
      max,
      reason: refuseReason(input.kind),
    };
  }

  const reserved = reserve(
    {
      kind: input.kind,
      itemId: input.itemId,
      instanceId: input.instanceId,
      root: input.root,
      ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
    },
    ledgerOptions,
  );
  if (!reserved.ok) {
    // The reservation could not be recorded — the host's in-flight work can no
    // longer be proven within budget, so fail closed.
    return {
      admitted: false,
      live: count.count,
      max,
      reason: HOST_BUDGET_UNKNOWN_REFUSAL,
    };
  }
  return { admitted: true, live: count.count, max };
}

/**
 * Confirm a reserved entry with the spawned pane's id.
 *
 * For the implement tier, counted = fresh heartbeat AND a pane id in the live
 * pane list, so the entry is invisible to admission until the pane id is known.
 * The audit tier counts a fresh entry regardless (the marker semantics), so the
 * confirmation only records the pane id for observability. Best-effort: a
 * failing seam never affects the dispatch, and the release-by-item-id on pane
 * close (or the stale reap) remains the backstop.
 */
export function confirmHostDispatch(
  input: HostBudgetAdmissionInput,
  opts: HostBudgetOptions = {},
): boolean {
  return reserve(
    {
      kind: input.kind,
      itemId: input.itemId,
      instanceId: input.instanceId,
      root: input.root,
      ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
    },
    opts,
  ).ok;
}

/**
 * Release a dispatch's reservation (pane close, abort path, failed claim
 * rollback). Idempotent and best-effort: never throws, and a missing entry is
 * a successful no-op, so every release path may call it unconditionally.
 */
export function releaseHostDispatch(
  itemId: string,
  opts: HostBudgetOptions = {},
): boolean {
  try {
    return release(itemId, opts).ok;
  } catch {
    return false;
  }
}
