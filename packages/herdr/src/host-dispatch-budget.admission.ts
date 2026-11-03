/**
 * packages/herdr/src/host-dispatch-budget.admission.ts — the dispatcher's
 * host-wide admission read for the implement tier (WL-0MVXY0YG7009JMHI,
 * parent WL-0MVXWQFGV000D2AB).
 *
 * Single responsibility: turn the machine-scoped ledger (F1,
 * `host-dispatch-budget.ts`) plus the live pane list into exactly ONE
 * admission decision for a dispatch — admit (and reserve), refuse because the
 * tier is at/over its cap, or refuse because the ledger cannot be trusted
 * (fail closed + repair from live state). The ledger contract itself
 * (read/reserve/release/reap, configuration, liveness table) lives in
 * `host-dispatch-budget.ts` and is not restated here.
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
 * Scope: this slice enforces the **implement** tier only (the ledger records
 * `kind`, so the audit tier joins through the same seam when F2 lands).
 *
 * Layering: the decision is a thin orchestration over F1's pure helpers and
 * fs-backed ledger API; all arithmetic (caps, staleness, counting) stays in
 * `host-dispatch-budget.ts`.
 */

import {
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

export type { HostBudgetLivePane } from './host-dispatch-budget.js';

/** Refusal reason: the tier is at/over its machine-wide cap. */
export const HOST_BUDGET_IMPLEMENT_REFUSAL = 'host-budget-implement';

/** Refusal reason: the tier is at/over its machine-wide cap (audit tier). */
export const HOST_BUDGET_AUDIT_REFUSAL = 'host-budget-audit';

/** Refusal reason: the ledger could not be trusted (fail closed + repair). */
export const HOST_BUDGET_UNKNOWN_REFUSAL = 'host-budget-unknown';

/** The refusal tokens this module can return. */
export type HostBudgetRefusalReason =
  | typeof HOST_BUDGET_IMPLEMENT_REFUSAL
  | typeof HOST_BUDGET_AUDIT_REFUSAL
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
   * reserved entry count (the F1 liveness table), so the caller must pass the
   * machine-wide downtime pane list, not a per-root subset.
   */
  livePanes: readonly HostBudgetLivePane[];
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
 * One admission decision for one dispatch attempt.
 *
 * Never throws; every outcome is expressed as `admitted` plus the `live`/`max`
 * evidence. The order is significant:
 *
 *  1. resolve the effective cap (config + env, defaults absent a file);
 *  2. `max === 0` ⇒ refuse immediately with `live`/`max` `0/0` (AC4 — a
 *     disabled tier is refused regardless of what the ledger holds);
 *  3. count live dispatches (reaping stale, pane-less entries on read);
 *  4. unreadable ledger ⇒ repair from live panes and refuse (`unknown`);
 *  5. at/over cap ⇒ refuse with the observed `live`/`max` (AC2);
 *  6. otherwise reserve the slot and admit.
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
  const { config } = readBudgetConfig(ledgerOptions);
  const max = input.kind === 'audit' ? config.maxAudit : config.maxImplement;
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
 * Counted = fresh heartbeat AND a pane id in the live pane list, so the entry
 * is invisible to admission until the pane id is known. Best-effort: an
 * unresolved pane id leaves the entry countable only once the pane close
 * releases it (never a permanent leak — the release is by item id).
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
