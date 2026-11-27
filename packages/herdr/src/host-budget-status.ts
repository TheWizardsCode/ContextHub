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
 * observability surfaces of parent AC10 — the worklist counter, one
 * `<kind> n/max` segment per CONFIGURED (capped) kind (AC4 for implement/audit,
 * generalised to every kind by WL-0MWF351XL002WVL2 F5) and the
 * `Downtime … tier skipped: <reason>` stderr line with the live count and the
 * cap (AC3) — and the pure pairing helper (`summariseHostBudget`) they share.
 * A kind the operator has not capped is unlimited: it is never counted and
 * never gains a segment, so an uncapped kind cannot appear on any surface.
 *
 * ## One reader, read-only (AC5)
 *
 * `readHostBudgetStatus` is the ONLY counting entry point for the display
 * surfaces, and it does not count anything itself: it pairs the counts of the
 * SAME pure reductions the dispatcher's admission compares with the caps
 * (`reduceLedgerCounts` for the non-audit live-pane rule
 * — WL-0MW9VQ08W000SN63: a confirmed dispatch with a live pane counts
 * regardless of heartbeat age —,
 * `reduceAuditDisplayCounts` for the audit tier's pane-aware DISPLAY rule, or
 * the freshness-only `reduceFreshCounts` when no live pane list is
 * supplied). There is therefore no second
 * counting or ranking path: the decision log's `budget` evidence, the header
 * token, the stderr line and the worklist counter are all quoting the ledger
 * through one set of rules.
 *
 * ## Audit display vs admission (WL-0MW8D4UQH002TWJV)
 *
 * Admission keeps the retired marker's semantics on purpose: an audit slot is
 * held from dispatch until an explicit release point or the 2 h staleness
 * window, so a reservation with no confirmed pane is still counted. The
 * DISPLAY is deliberately stricter: a confirmed entry whose `paneId` is absent
 * from the trusted live pane list has already closed, so the header must not
 * claim it is in flight. Only the pane-aware exclusion differs; the live-pane
 * list is required for it, and a caller that cannot supply one falls back to
 * the freshness rule rather than inventing a zero.
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
  HOST_BUDGET_KINDS,
  HOST_BUDGET_STALE_WINDOW_MS,
  auditDisplayCount,
  budgetLedgerPath,
  emptyHostBudgetCounts,
  livePaneIdSet,
  readBudget,
  readBudgetConfig,
  type HostBudgetConfig,
  type HostBudgetCounts,
  type HostBudgetKind,
  type HostBudgetLivePane,
  type HostBudgetOptions,
} from './host-dispatch-budget.js';
import { countLiveWork } from './host-dispatch-budget.counting.js';
import {
  resolveEffectiveHostBudgetCap,
  resolveModelBlockedPanes,
} from './host-budget-relief.js';
import type { ModelCooldownEntry } from '@worklog/shared/model-cooldown';
import { getMachineCoordinationDir } from './machine-coordination.js';
import {
  HOST_BUDGET_AUDIT_REASON,
  HOST_BUDGET_IMPLEMENT_REASON,
  HOST_BUDGET_CORRUPT_REASON,
  HOST_BUDGET_UNKNOWN_REASON,
  isHostBudgetDecisionReason,
  type HostBudgetDecisionReason,
  type HostBudgetEvidence,
} from './downtime-log.js';
import {
  BUDGET_RELIEF_DECISION_TOKEN,
  HOST_BUDGET_INTAKE_REASON,
  HOST_BUDGET_PLAN_REASON,
  HOST_BUDGET_RISK_EFFORT_REASON,
} from './downtime-log-budget.js';

/**
 * One tier's observed in-flight count and cap.
 *
 * `max` is the EFFECTIVE cap: the configured cap, or 2x it while a
 * model-blocked pane of that kind exists (WL-0MWTAD9NV000IVK5 AC9). `relief`
 * marks a kind whose cap was relief-raised so the header can name the
 * `budget-relief` token rather than silently showing a larger number.
 */
export type HostBudgetTierStatus = HostBudgetEvidence & {
  /** True when `max` is a relief-raised cap (2x the configured cap). */
  relief?: true;
};

/**
 * One entry per CONFIGURED (capped) kind, as every observability surface
 * quotes it. A kind absent from the budget config is unlimited, so it has no
 * live/max pair to show and is simply not present here — an uncapped kind can
 * never produce a counter segment.
 */
export type HostBudgetStatus = Partial<Record<HostBudgetKind, HostBudgetTierStatus>>;

/** Options for {@link readHostBudgetStatus} (ledger seams + the live pane list). */
export interface HostBudgetStatusOptions extends HostBudgetOptions {
  /**
   * The machine-wide live pane list, when the pane read SUCCEEDED — an
   * authoritative list is consulted for every non-audit kind's live-pane rule
   * and for the audit kind's pane-aware display rule. `undefined` means pane
   * liveness is UNKNOWN (a failed/unparseable read, WL-0MW9VQX5T001GCUP) and
   * every figure falls back to the freshness rule (fresh entries count, no pane
   * requirement) — an unknown read must not report a false zero. An empty
   * AUTHORITATIVE list (`[]`) still reads as zero in-flight for every counted
   * kind (empty ≠ unknown). The read is non-mutating in every case.
   */
  livePanes?: readonly HostBudgetLivePane[];
  /**
   * Active machine-wide model cooldowns (WL-0MWTAD9NV000IVK5). When a kind is
   * model-blocked the counter shows `n/effectiveCap` (2x) instead of
   * `n/configuredCap`, so the header agrees with admission. `null` = the signal
   * is unreadable/corrupt (no relief — fail closed).
   */
  modelCooldowns?: readonly ModelCooldownEntry[] | null;
  /** Relay kill switch (`downtimeBudgetReliefEnabled`, default true). */
  budgetReliefEnabled?: boolean;
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
  /** Kinds whose `max` is a relief-raised (2x) cap (WL-0MWTAD9NV000IVK5 AC9). */
  relieved?: ReadonlySet<HostBudgetKind>,
): HostBudgetStatus | null {
  if (counts === null || counts === undefined) return null;
  if (config === null || config === undefined) return null;
  // Only configured kinds get a live/max pair: an absent cap means unlimited,
  // and an unlimited kind is never counted against anything (AC "absent =
  // unlimited") nor listed on any surface.
  const status: HostBudgetStatus = {};
  for (const kind of HOST_BUDGET_KINDS) {
    const max = config[kind];
    if (max === undefined) continue;
    status[kind] = {
      live: counts[kind] ?? 0,
      max,
      ...(relieved?.has(kind) === true ? { relief: true as const } : {}),
    };
  }
  return status;
}

/**
 * Header segment for the worklist (AC4): one `kind n/max` segment per
 * configured kind, in the canonical {@link HOST_BUDGET_KINDS} order —
 * `[budget: implement 1/2 · audit 0/1]`, extended as
 * `[budget: implement 1/2 · audit 0/1 · plan 0/3]` when more kinds are capped.
 *
 * `null` when the budget is unavailable or no kind is capped, so no segment
 * (and no extra chrome row) is added. Display-only: it is a string, never a
 * gate.
 */
export function hostBudgetStatusText(
  status: HostBudgetStatus | null | undefined,
): string | null {
  if (status === null || status === undefined) return null;
  const segments: string[] = [];
  for (const kind of HOST_BUDGET_KINDS) {
    const tier = status[kind];
    if (tier === undefined) continue;
    // A relief-raised cap is marked with the `budget-relief` vocabulary token
    // so `implement 1/4 (budget-relief)` cannot be mistaken for a configured
    // cap of 4 (WL-0MWTAD9NV000IVK5 AC9).
    const marker = tier.relief === true ? ` (${BUDGET_RELIEF_DECISION_TOKEN})` : '';
    segments.push(`${kind} ${tier.live}/${tier.max}${marker}`);
  }
  if (segments.length === 0) return null;
  return `[budget: ${segments.join(' · ')}]`;
}

/** The tier word used in the stderr skip line for each budget token. */
const TIER_LABEL_BY_REASON: Readonly<Record<HostBudgetDecisionReason, string>> = {
  [HOST_BUDGET_IMPLEMENT_REASON]: 'implement',
  [HOST_BUDGET_AUDIT_REASON]: 'audit',
  [HOST_BUDGET_PLAN_REASON]: 'plan',
  [HOST_BUDGET_INTAKE_REASON]: 'intake',
  [HOST_BUDGET_RISK_EFFORT_REASON]: 'risk-effort',
  // `host-budget-unknown` can come from either tier (the ledger could not be
  // trusted), so the line names the budget itself rather than guessing a tier.
  [HOST_BUDGET_UNKNOWN_REASON]: 'budget',
  // A corrupt ledger is a whole-budget failure: the line names the budget, not
  // a tier (WL-0MWFJD8ZO000J1R8).
  [HOST_BUDGET_CORRUPT_REASON]: 'budget',
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
  // Per-kind counting, one rule each, over the CONFIGURED kinds only:
  //
  //  - every non-audit kind uses the ONE in-flight rule (WL-0MWFJDD8R005F5BV):
  //    the ledger's own live count PLUS live dispatcher panes no entry
  //    accounts for, so the header and the admission decision always quote the
  //    same figure. `undefined` live panes = pane liveness UNKNOWN
  //    (WL-0MW9VQX5T001GCUP): the figure drops the pane requirement and falls
  //    back to the freshness rule (fresh entries count) instead of folding
  //    unknown into an empty set and reporting zero. An authoritative empty
  //    list still reads as zero.
  //  - `audit` keeps the pane-aware DISPLAY rule (WL-0MW8D4UQH002TWJV), shared
  //    with the interactive over-quota dialog so the two surfaces cannot
  //    disagree (WL-0MW8IQNY7003JIOL). A confirmed entry whose pane is gone is
  //    a dead audit and must not render as in flight; `undefined` live panes
  //    fall back to freshness rather than inventing a zero.
  //
  // Uncapped kinds are skipped entirely: no count, no segment, and a render
  // never reaps or rewrites the ledger.
  const config = readBudgetConfig(ledgerOptions).config;
  const livePaneIds =
    opts.livePanes === undefined ? undefined : livePaneIdSet(opts.livePanes);
  const counts = emptyHostBudgetCounts();
  for (const kind of HOST_BUDGET_KINDS) {
    const max = config[kind];
    if (max === undefined) continue;
    // A disabled kind (`0`) admits nothing, so its live figure is 0 — the same
    // documented `0/0` evidence the interactive over-quota gate quotes
    // (`readTierCount`), so the two surfaces cannot disagree.
    if (max === 0) continue;
    counts[kind] =
      kind === 'audit'
        ? auditDisplayCount(read.ledger.entries, livePaneIds, now, windowMs)
        : countLiveWork(read.ledger.entries, opts.livePanes, kind, now, windowMs).live;
  }
  const effective = effectiveConfig(config, opts, now);
  // Mark the kinds whose cap relief raised, so the header names the
  // `budget-relief` token explicitly (WL-0MWTAD9NV000IVK5 AC9).
  const relieved = new Set<HostBudgetKind>();
  for (const kind of HOST_BUDGET_KINDS) {
    if (effective[kind] !== undefined && effective[kind] !== config[kind]) {
      relieved.add(kind);
    }
  }
  return summariseHostBudget(counts, effective, relieved);
}

/**
 * Apply budget relief to the configured caps for the display counter
 * (WL-0MWTAD9NV000IVK5 AC9: the worklist shows `n/effectiveCap`). Pure: the
 * predicate and arithmetic are `host-budget-relief.ts`'s. A disabled/uncapped
 * kind is never relieved, and an unreadable/absent signal leaves the cap as
 * configured (relief is fail-closed).
 */
function effectiveConfig(
  config: HostBudgetConfig,
  opts: HostBudgetStatusOptions,
  now: number,
): HostBudgetConfig {
  if (opts.modelCooldowns === undefined && opts.budgetReliefEnabled !== false) {
    // No signal supplied by this caller (e.g. a test that only asserts the
    // configured cap): keep the historical shape.
    return config;
  }
  const blocked = resolveModelBlockedPanes({
    cooldowns: opts.modelCooldowns,
    panes: opts.livePanes ?? [],
    now,
  });
  const effective: HostBudgetConfig = { ...config };
  for (const kind of HOST_BUDGET_KINDS) {
    const baseCap = config[kind];
    if (baseCap === undefined) continue;
    const cap = resolveEffectiveHostBudgetCap({
      kind,
      baseCap,
      blockedPanes:
        kind === 'implement' ? blocked.implement : kind === 'audit' ? blocked.audit : [],
      ...(opts.budgetReliefEnabled === false ? { reliefEnabled: false } : {}),
    });
    if (cap.effectiveCap !== baseCap) effective[kind] = cap.effectiveCap;
  }
  return effective;
}
