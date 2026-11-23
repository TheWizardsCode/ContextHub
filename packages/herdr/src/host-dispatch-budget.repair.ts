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
 *  1. **Every dispatcher label form is understood.** {@link kindOf} (via
 *     {@link decodeBudgetPaneLabel}) strips leading decoration (emoji/status
 *     markers and surrounding whitespace) and then accepts
 *     `Downtime triggered …`, `Downtime <kind> …` and `Manually triggered …`,
 *     deriving the kind from the token after the prefix for EVERY budget kind
 *     (implement, audit, plan, intake, risk-effort — WL-0MWF34932000SNTX F2).
 *     An unreadable tier is counted against `implement` — over-counting
 *     refuses a dispatch, under-counting admits work the operator capped.
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
  isHostBudgetKind,
  replaceBudget,
  type HostBudgetEntry,
  type HostBudgetKind,
  type HostBudgetLivePane,
  type HostBudgetOptions,
} from './host-dispatch-budget.js';
import { paneItemIdFromLabel } from './pane-label.js';

/** Label form a pane title matched. */
export type BudgetPaneLabelForm = 'downtime' | 'manual' | 'other';

/** The decoded identity of one herdr pane label. */
export interface DecodedBudgetPaneLabel {
  /** Which dispatcher label form the title matched. */
  form: BudgetPaneLabelForm;
  /**
   * The budgeted tier the label names, or `null` when the pane is not a
   * capped dispatch kind at all (a scheduled/prompt pane, or a non-downtime
   * pane). Every `HostBudgetKind` (implement, audit, plan, intake, risk-effort)
   * is decodeable since WL-0MWF34932000SNTX F2.
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

/**
 * Tier tokens the dispatcher knows are NOT budget kinds (`scheduled` prompts
 * are not a work-item kind and stay outside the budget). Recognised so they are
 * never mistaken for the conservative `implement` fallback.
 */
const UNBUDGETED_TIER_TOKENS = new Set(['prompt', 'audit-skill', 'scheduled']);

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
  const itemId = toBudgetItemId(paneItemIdFromLabel(normalised));
  // Every `HostBudgetKind` is decodable (WL-0MWF34932000SNTX F2): the repair
  // path and the union live count must see a plan/intake/risk-effort pane as
  // its own kind, not as "unbudgeted" or as a conservative implement.
  if (isHostBudgetKind(token)) {
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
 * Adapt the canonical item-id parse (`pane-label.ts::paneItemIdFromLabel`)
 * to this module's `string | null` decode contract: the canonical parser
 * returns `''` for "no id" (the settled single convention,
 * WL-0MWHWH1HV009C46C AC2), and the budget decode distinguishes
 * `null` (no id) from a present id for its `no-work-item-id` accounting.
 */
function toBudgetItemId(itemId: string): string | null {
  return itemId === '' ? null : itemId;
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
 * The budget kind a pane label names, or `null` when the pane is not a capped
 * dispatch kind (WL-0MWF34932000SNTX F2 — the named helper the repair and the
 * union live count share). Pure and total.
 */
export function kindOf(label: string | undefined): HostBudgetKind | null {
  return decodeBudgetPaneLabel(label).kind;
}

/** One reconstructed entry plus the panes it accounts for. */
export interface LivePaneEntries {
  /** The entries reconstructed (one per `(kind, itemId)`). */
  entries: HostBudgetEntry[];
  /** Every pane id the reconstruction accounted for (incl. duplicates). */
  accountedPaneIds: string[];
  /** Budgeted panes that cannot become an entry (no work-item id). */
  unaccounted: BudgetRepairUnaccountedPane[];
}

/**
 * Reconstruct one ledger entry per capped dispatch pane (WL-0MWF34932000SNTX
 * F2 — generalised from the implement/audit-only reconstruction).
 *
 * Only panes whose label decodes to a `HostBudgetKind` (via {@link kindOf}) are
 * dispatch evidence; a scheduled/prompt pane or a non-downtime pane is ignored.
 * A budgeted pane with no work-item id is reported as `unaccounted` — an entry
 * has no key without it, so writing would silently drop a running dispatch
 * (AC4). Pure: no filesystem access.
 */
export function entriesFromLivePanes(
  livePanes: readonly HostBudgetLivePane[],
  input: { instanceId: string; root: string; now?: number },
): LivePaneEntries {
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
      // The same (kind, item) twice: one entry is the ledger's contract. Both
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

  return { entries, accountedPaneIds, unaccounted };
}

/**
 * Build the repair plan from the machine-wide live pane list (pure).
 *
 * Only panes that decode to a `HostBudgetKind` (any capped kind, including the
 * conservative unknown-tier fallback) are dispatch evidence; a scheduled/prompt
 * pane or a non-downtime pane is ignored. A budgeted pane with no work-item id
 * is `unaccounted` — an entry has no key without it, so writing would silently
 * drop a running dispatch (AC4).
 */
export function planBudgetRepair(
  livePanes: readonly HostBudgetLivePane[],
  input: { instanceId: string; root: string; now?: number },
): BudgetRepairPlan {
  const reconstructed = entriesFromLivePanes(livePanes, input);
  return {
    entries: reconstructed.entries,
    accountedPaneIds: reconstructed.accountedPaneIds,
    unaccounted: reconstructed.unaccounted,
    complete: reconstructed.unaccounted.length === 0,
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
