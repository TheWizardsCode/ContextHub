/**
 * packages/herdr/src/host-dispatch-budget.repair.ts — explicit, complete repair
 * of the dispatch-budget ledger from the live pane list
 * (WL-0MWFJD8ZO000J1R8, parent WL-0MWFJD1RV008FCCR).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE, OPERATOR-INITIATED PATH
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `readBudgetAt` treats the ledger as untrusted if ANY single entry is invalid,
 * and admission used to respond by rewriting the WHOLE document from the live
 * pane list. Reconstruction only kept panes whose title started with
 * `Downtime`, so it silently dropped:
 *
 *  - panes decorated by herdr's UI (`⚠️ Downtime triggered …`,
 *    `🚫 Downtime triggered …`), and
 *  - `Manually triggered …` panes,
 *
 * which on 2026-11-13 was 6 of the 10 live implement panes. One malformed
 * entry could therefore delete most confirmed entries — and nothing recorded
 * it. Admission no longer repairs anything; a damaged ledger fails closed with
 * `host-budget-corrupt`, and repair is this deliberate, reported action.
 *
 * ## The three guarantees
 *
 *  1. **Every dispatcher label form is understood.** {@link decodeBudgetPaneLabel}
 *     strips leading decoration (emoji/status markers and surrounding
 *     whitespace) and then accepts `Downtime triggered …`,
 *     `Downtime <kind> …` and `Manually triggered …`, deriving the tier from
 *     the token after the prefix. An unreadable tier is counted against
 *     `implement` — over-counting refuses a dispatch, under-counting admits
 *     work the operator capped.
 *  2. **A repair is all-or-nothing.** {@link planBudgetRepair} reports every
 *     live dispatcher pane it could NOT account for (no work-item id in the
 *     label), and {@link repairBudgetLedgerFromPanes} refuses to write while
 *     any remains: a partial reconstruction is exactly the silent loss this
 *     replaces.
 *  3. **The reconstructed set is reported.** The result carries the entries it
 *     wrote and the pane ids it accounted for, so an operator can diff the
 *     repair against `herdr pane list`.
 *
 * Layering: the pure label decode and plan touch no filesystem; only
 * {@link repairBudgetLedgerFromPanes} writes, through the ledger's existing
 * locked `replaceBudget`.
 */

import {
  replaceBudget,
  type HostBudgetEntry,
  type HostBudgetKind,
  type HostBudgetLivePane,
  type HostBudgetOptions,
} from './host-dispatch-budget.js';

/** Label form a pane title matched. */
export type BudgetPaneLabelForm = 'downtime' | 'manual' | 'other';

/** The decoded identity of one herdr pane label. */
export interface DecodedBudgetPaneLabel {
  /** Which dispatcher label form the title matched. */
  form: BudgetPaneLabelForm;
  /**
   * The budgeted tier the label names, or `null` when the pane is not a
   * budgeted dispatch at all (a plan/intake/risk-effort/prompt pane, or a
   * non-downtime pane).
   */
  kind: HostBudgetKind | null;
  /**
   * False when the tier token was not recognised and {@link kind} fell back to
   * the conservative `implement` (AC3: over-count, never under-count).
   */
  kindKnown: boolean;
  /** Work-item id from the label's ` - <id>` suffix, or `null`. */
  itemId: string | null;
  /** The label after decoration stripping (the form actually parsed). */
  normalised: string;
}

/**
 * Leading decoration herdr's UI can put in front of a pane label: emoji and
 * status markers (`⚠️`, `🚫`, `●`, …) plus any surrounding whitespace. Only
 * NON-letter characters are stripped, so a legitimate label is never damaged.
 */
const LEADING_DECORATION = /^[^\p{L}]+/u;

/** Tier tokens the dispatcher knows are NOT budgeted. */
const UNBUDGETED_TIER_TOKENS = new Set(['plan', 'intake', 'risk-effort', 'prompt', 'audit-skill']);

/**
 * Decode one pane label into its budget identity (pure, total).
 *
 * Accepted forms, after decoration stripping:
 *
 *  - `Downtime triggered <tier> <title> - <ITEM>`
 *  - `Downtime <tier> … - <ITEM>` (the short form)
 *  - `Manually triggered <tier> <title> - <ITEM>` (operator-fired dispatch)
 *
 * Anything else is `form: 'other'` with `kind: null` — never evidence of a
 * budgeted dispatch.
 */
export function decodeBudgetPaneLabel(label: string | undefined): DecodedBudgetPaneLabel {
  const empty: DecodedBudgetPaneLabel = {
    form: 'other',
    kind: null,
    kindKnown: true,
    itemId: null,
    normalised: '',
  };
  if (typeof label !== 'string') return empty;
  const normalised = label.replace(LEADING_DECORATION, '').trim();
  if (normalised === '') return { ...empty, normalised };

  let form: BudgetPaneLabelForm = 'other';
  let rest = '';
  const manual = /^Manually triggered\s+(.*)$/i.exec(normalised);
  const downtime = /^Downtime\s+(?:triggered\s+)?(.*)$/i.exec(normalised);
  if (manual !== null) {
    form = 'manual';
    rest = manual[1];
  } else if (downtime !== null) {
    form = 'downtime';
    rest = downtime[1];
  } else {
    return { ...empty, normalised };
  }

  const token = (rest.trim().split(/\s+/)[0] ?? '').toLowerCase();
  const itemId = paneLabelItemId(normalised);
  if (token === 'implement' || token === 'audit') {
    return { form, kind: token, kindKnown: true, itemId, normalised };
  }
  if (UNBUDGETED_TIER_TOKENS.has(token)) {
    return { form, kind: null, kindKnown: true, itemId, normalised };
  }
  // Conservative fallback (AC3): an unrecognised token in a dispatcher label is
  // counted against the implement tier. Over-counting refuses a dispatch;
  // guessing `audit` (or skipping the pane) could over-admit implement work.
  return { form, kind: 'implement', kindKnown: false, itemId, normalised };
}

/**
 * Work-item id of a label: the token after the last ` - ` (the dispatcher
 * preserves the id as a suffix).
 *
 * Duplicated deliberately as a local pure helper rather than importing the
 * pane module: this file is the budget's own decode contract, and the budget
 * must not depend on the dispatcher's pane-label module for a two-line parse.
 */
function paneLabelItemId(label: string): string | null {
  const idx = label.lastIndexOf(' - ');
  if (idx < 0) return null;
  const id = label.slice(idx + 3).trim();
  return id === '' ? null : id;
}

/** A live pane the repair could not turn into an entry. */
export interface BudgetRepairUnaccountedPane {
  paneId: string;
  label?: string;
  /** `no-work-item-id` — a dispatcher pane whose label carries no item id. */
  reason: 'no-work-item-id';
}

/** The pure plan for one repair. */
export interface BudgetRepairPlan {
  /** The entries the repair would write (one per accounted dispatcher pane). */
  entries: HostBudgetEntry[];
  /** Panes the plan turned into entries. */
  accountedPaneIds: string[];
  /** Dispatcher panes that CANNOT be reconstructed — refuses the write. */
  unaccounted: BudgetRepairUnaccountedPane[];
  /** True when every dispatcher pane is accounted for. */
  complete: boolean;
}

/**
 * Build the repair plan from the machine-wide live pane list (pure).
 *
 * Only panes that decode to a BUDGETED tier (`implement`/`audit`, including the
 * conservative unknown-tier fallback) are dispatch evidence; a plan/intake/
 * prompt pane or a non-downtime pane is ignored. A budgeted pane with no
 * work-item id is `unaccounted` — an entry has no key without it, so writing
 * would silently drop a running dispatch (AC4).
 */
export function planBudgetRepair(
  livePanes: readonly HostBudgetLivePane[],
  input: { instanceId: string; root: string; now?: number },
): BudgetRepairPlan {
  const at = new Date(input.now ?? Date.now()).toISOString();
  const entries: HostBudgetEntry[] = [];
  const accountedPaneIds: string[] = [];
  const unaccounted: BudgetRepairUnaccountedPane[] = [];
  const seen = new Set<string>();

  for (const pane of livePanes) {
    if (typeof pane.paneId !== 'string' || pane.paneId.length === 0) continue;
    const decoded = decodeBudgetPaneLabel(pane.title);
    if (decoded.kind === null) continue;
    if (decoded.itemId === null) {
      unaccounted.push({
        paneId: pane.paneId,
        ...(typeof pane.title === 'string' ? { label: pane.title } : {}),
        reason: 'no-work-item-id',
      });
      continue;
    }
    const key = `${decoded.kind}:${decoded.itemId}`;
    if (seen.has(key)) {
      // The same (tier, item) twice: one entry is the ledger's contract. Both
      // panes are still accounted for (nothing is dropped silently).
      accountedPaneIds.push(pane.paneId);
      continue;
    }
    seen.add(key);
    entries.push({
      kind: decoded.kind,
      itemId: decoded.itemId,
      instanceId: input.instanceId,
      paneId: pane.paneId,
      root: input.root,
      startedAt: at,
      heartbeatAt: at,
    });
    accountedPaneIds.push(pane.paneId);
  }

  return {
    entries,
    accountedPaneIds,
    unaccounted,
    complete: unaccounted.length === 0,
  };
}

/** Why a repair did not happen. */
export type BudgetRepairFailureReason =
  | 'incomplete'
  | 'write-failed'
  | 'no-coordination-dir';

/** Result of {@link repairBudgetLedgerFromPanes}. */
export type BudgetRepairResult =
  | {
      ok: true;
      /** Entries written (one per accounted dispatcher pane). */
      entries: HostBudgetEntry[];
      /** Pane ids the repair accounted for. */
      accountedPaneIds: string[];
      /** Total ledger size after the write. */
      count: number;
    }
  | {
      ok: false;
      reason: BudgetRepairFailureReason;
      /** Why it refused / failed — always reported, never silent. */
      message: string;
      /** Present on `incomplete`: the panes that blocked the write. */
      unaccounted?: BudgetRepairUnaccountedPane[];
    };

/**
 * Repair the ledger from the live pane list — an EXPLICIT operator action.
 *
 * Never called from an admission read: a damaged ledger fails closed in the
 * dispatcher, and this is what an operator runs to recover. The write goes
 * through the ledger's locked `replaceBudget`, so it is atomic and cannot
 * clobber a concurrent writer. It refuses (`incomplete`) rather than writing a
 * partial reconstruction, and it never throws.
 */
export function repairBudgetLedgerFromPanes(
  livePanes: readonly HostBudgetLivePane[],
  input: { instanceId: string; root: string; now?: number },
  opts: HostBudgetOptions = {},
): BudgetRepairResult {
  const plan = planBudgetRepair(livePanes, input);
  if (!plan.complete) {
    return {
      ok: false,
      reason: 'incomplete',
      message:
        `Refusing to repair: ${plan.unaccounted.length} live dispatcher pane(s) have no ` +
        'work-item id in their label, so the reconstruction would silently drop them. ' +
        'Close those panes or rename them, then re-run.',
      unaccounted: plan.unaccounted,
    };
  }
  const replaced = replaceBudget(plan.entries, {
    ...opts,
    reason: opts.reason ?? 'repair-from-live-panes',
  });
  if (!replaced.ok) {
    return {
      ok: false,
      reason: replaced.reason === 'no-coordination-dir' ? 'no-coordination-dir' : 'write-failed',
      message: `Ledger repair could not write (${replaced.reason}).`,
    };
  }
  return {
    ok: true,
    entries: plan.entries,
    accountedPaneIds: plan.accountedPaneIds,
    count: replaced.count,
  };
}
