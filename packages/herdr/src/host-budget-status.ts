/**
 * packages/herdr/src/host-budget-status.ts — read-only host-budget summary and
 * refusal copy for the operator surfaces (WL-0MVXY0ZYW009NEJD F5, parent
 * WL-0MVXWQFGV000D2AB).
 *
 * ## Why this module exists
 *
 * The machine-scoped budget (F1 `host-dispatch-budget.ts`, admission F3/F2) is
 * enforced, but until F5 its numbers were only visible as a per-tick refusal
 * reason: the worklist had no way to say "this host is running 1 of 2
 * implements and 0 of 1 audits". This module supplies the two remaining
 * observability surfaces of parent AC10 — the worklist `implement n/max ·
 * audit n/max` counter (AC4) and the `Downtime … tier skipped: <reason>`
 * stderr line with the live count and the cap (AC3) — and the pure pairing
 * helper (`summariseHostBudget`) they share.
 *
 * ## One reader, read-only (AC5)
 *
 * `readHostBudgetStatus` is the ONLY counting entry point for the display
 * surfaces, and it does not count anything itself: it pairs the counts of the
 * SAME pure reductions the dispatcher's admission compares with the caps
 * (`reduceLedgerCounts` for the implement tier's live-pane rule,
 * `reduceMarkerCounts` + `legacyActiveAuditCount` for the audit tier's
 * marker-compatible rule). There is therefore no second counting or ranking
 * path: the decision log's `budget` evidence, the header token, the stderr
 * line and the worklist counter are all quoting the ledger through one set of
 * rules.
 *
 * It also never writes: unlike `liveCount`/`freshCount` (which reap stale
 * entries on read because admission wants the cleanup), a DISPLAY read must
 * leave the ledger byte-identical — a TUI render must never mutate machine
 * state. Stale entries are therefore excluded from the count but not reaped.
 *
 * ## Rendering nothing when the budget is unavailable (AC4)
 *
 * `readHostBudgetStatus` returns `null` — and `hostBudgetStatusText` renders
 * nothing — when the machine coordination dir cannot be resolved, no ledger
 * file exists yet (the budget is simply not in use on this host) or the ledger
 * cannot be trusted. The header therefore gains no chrome in the common and
 * degraded cases, exactly like the `dispatch-window-hold.ts` pattern this
 * follows (WL-0MVR8FN1D002SCIR).
 */

import * as fs from 'node:fs';

import {
  HOST_BUDGET_STALE_WINDOW_MS,
  budgetLedgerPath,
  legacyActiveAuditCount,
  livePaneIdSet,
  readBudget,
  readBudgetConfig,
  reduceLedgerCounts,
  reduceMarkerCounts,
  type HostBudgetConfig,
  type HostBudgetCounts,
  type HostBudgetLivePane,
  type HostBudgetOptions,
} from './host-dispatch-budget.js';
import { getMachineCoordinationDir } from './machine-coordination.js';
import {
  HOST_BUDGET_AUDIT_REASON,
  HOST_BUDGET_IMPLEMENT_REASON,
  HOST_BUDGET_UNKNOWN_REASON,
  isHostBudgetDecisionReason,
  type HostBudgetDecisionReason,
  type HostBudgetEvidence,
} from './downtime-log.js';

/** One tier's observed in-flight count and configured cap. */
export type HostBudgetTierStatus = HostBudgetEvidence;

/** Both budgeted tiers, as every observability surface quotes them. */
export interface HostBudgetStatus {
  implement: HostBudgetTierStatus;
  audit: HostBudgetTierStatus;
}

/** Options for {@link readHostBudgetStatus} (ledger seams + the live pane list). */
export interface HostBudgetStatusOptions extends HostBudgetOptions {
  /**
   * The machine-wide live pane list. Only consulted for the implement tier's
   * live-pane rule; absent means "no observed pane", which under-counts (the
   * display is read-only, never an admission decision).
   */
  livePanes?: readonly HostBudgetLivePane[];
}

/**
 * Pair the observed per-tier counts with the resolved caps (pure).
 *
 * `null` when either half is unavailable, so a caller renders nothing rather
 * than inventing a zero: an absent ledger is not the same fact as "0 in
 * flight".
 */
export function summariseHostBudget(
  counts: HostBudgetCounts | null | undefined,
  config: HostBudgetConfig | null | undefined,
): HostBudgetStatus | null {
  if (counts === null || counts === undefined) return null;
  if (config === null || config === undefined) return null;
  return {
    implement: { live: counts.implement, max: config.maxImplement },
    audit: { live: counts.audit, max: config.maxAudit },
  };
}

/**
 * Header segment for the worklist (AC4): `[budget: implement 1/2 · audit 0/1]`.
 *
 * `null` when the budget is unavailable, so no segment (and no extra chrome
 * row) is added. Display-only: it is a string, never a gate.
 */
export function hostBudgetStatusText(
  status: HostBudgetStatus | null | undefined,
): string | null {
  if (status === null || status === undefined) return null;
  const implement = `${status.implement.live}/${status.implement.max}`;
  const audit = `${status.audit.live}/${status.audit.max}`;
  return `[budget: implement ${implement} · audit ${audit}]`;
}

/** The tier word used in the stderr skip line for each budget token. */
const TIER_LABEL_BY_REASON: Readonly<Record<HostBudgetDecisionReason, string>> = {
  [HOST_BUDGET_IMPLEMENT_REASON]: 'implement',
  [HOST_BUDGET_AUDIT_REASON]: 'audit',
  // `host-budget-unknown` can come from either tier (the ledger could not be
  // trusted), so the line names the budget itself rather than guessing a tier.
  [HOST_BUDGET_UNKNOWN_REASON]: 'budget',
};

/**
 * The existing `Downtime … tier skipped: <reason>` stderr line for a
 * host-budget refusal (AC3), including the live count and the cap:
 *
 *     [worklog-plugin] Downtime implement tier skipped: host-budget-implement (live=2, max=2)
 *
 * `null` for any reason that is not a budget token (every other refusal keeps
 * its existing stderr behaviour). Pure copy: the caller owns the write, in a
 * fail-closed `try` block — logging must never crash the worker.
 */
export function hostBudgetSkipLine(
  reason: string,
  budget?: HostBudgetEvidence,
): string | null {
  if (!isHostBudgetDecisionReason(reason)) return null;
  const tier = TIER_LABEL_BY_REASON[reason];
  const figures =
    budget === undefined
      ? ' (live=unknown, max=unknown)'
      : ` (live=${budget.live}, max=${budget.max})`;
  return `[worklog-plugin] Downtime ${tier} tier skipped: ${reason}${figures}`;
}

/**
 * Read the host-budget status for the display surfaces — ONE read-only reader
 * (AC5), returning `null` when the budget/ledger is unavailable (AC4).
 *
 * Never writes, never reaps, never throws. The counting rules are the ledger
 * module's pure reductions, so the numbers agree with what admission compares
 * with the same caps.
 */
export function readHostBudgetStatus(
  opts: HostBudgetStatusOptions = {},
): HostBudgetStatus | null {
  const dir = opts.dir !== undefined ? opts.dir : getMachineCoordinationDir();
  if (dir === null) return null;
  try {
    // No ledger file yet ⇒ this host is not using the budget: render nothing
    // rather than a permanent 0/max segment (AC4 — no chrome noise).
    if (!fs.existsSync(budgetLedgerPath(dir))) return null;
  } catch {
    return null; // fail-open on the display path
  }

  const ledgerOptions: HostBudgetOptions = {
    dir,
    now: opts.now,
    staleWindowMs: opts.staleWindowMs,
    env: opts.env,
  };
  const read = readBudget(ledgerOptions);
  // Corrupt/unreadable (or a lost lock) ⇒ unavailable, never a fabricated
  // count: the operator sees no counter instead of a wrong one.
  if (!read.ok) return null;

  const now = opts.now ?? Date.now();
  const windowMs = opts.staleWindowMs ?? HOST_BUDGET_STALE_WINDOW_MS;
  const implement = reduceLedgerCounts(
    read.ledger.entries,
    livePaneIdSet(opts.livePanes ?? []),
    now,
    windowMs,
  );
  const audit = reduceMarkerCounts(read.ledger.entries, now, windowMs);
  const legacy = legacyActiveAuditCount(dir, now, windowMs);
  const { config } = readBudgetConfig(ledgerOptions);
  return summariseHostBudget(
    { implement: implement.counts.implement, audit: audit.counts.audit + legacy },
    config,
  );
}
