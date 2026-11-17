/**
 * packages/herdr/src/host-dispatch-budget.counting.ts — the ONE in-flight
 * counting rule for the implement tier (WL-0MWFJDD8R005F5BV, parent
 * WL-0MWFJD1RV008FCCR).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Both operator-facing surfaces derived "how many dispatches are in flight"
 * from the ledger ALONE (`readHostBudgetStatus` for the worklist header,
 * `admitHostDispatch` / `prepareInteractiveAgentDispatch` for the cap
 * decision). A live implement pane whose ledger entry was never written — or
 * was lost — was invisible to both: on 2026-11-13 that hid 6 of 10 running
 * dispatches and let the host run 10 implements against `maxImplement: 6`
 * without a single `host-budget-implement` refusal.
 *
 * The ledger is a side-effect ledger (best-effort reserve/confirm/release), so
 * it can never be the sole source of truth for "what is running". The pane
 * list already carries the evidence: every dispatcher pane label ends in
 * ` - <work-item-id>`.
 *
 * ## The rule
 *
 *     live = (entries the ledger counts for the tier)
 *          + (live dispatcher panes of that tier that NO entry accounts for)
 *
 *  - The ledger half is the existing pure reduction (`reduceLedgerCounts`), so
 *    dead-but-present entries stay excluded and a stale-but-live implement
 *    entry still counts (WL-0MW9VQ08W000SN63).
 *  - The pane half is a live pane whose label decodes to this tier and whose
 *    `(tier, itemId)` no retained entry names — counted ONCE, so a pane that
 *    owns an entry is never double counted.
 *  - An UNKNOWN pane read (`livePanes: undefined`) contributes NOTHING: the
 *    figure falls back to the freshness rule and never invents panes or a
 *    zero (WL-0MW9VQX5T001GCUP).
 *
 * Every consumer calls one of the two exports here — the pure
 * {@link countLiveWork} (the display surfaces, which must not write) or the
 * fs-backed {@link readHostBudgetLiveWork} (admission and the interactive
 * gate, which also reap) — so the header and the cap decision cannot drift.
 */

import {
  livePaneIdSet,
  reduceLedgerCounts,
  reap,
  readBudget,
  HOST_BUDGET_STALE_WINDOW_MS,
  type HostBudgetCounts,
  type HostBudgetEntry,
  type HostBudgetFailure,
  type HostBudgetKind,
  type HostBudgetLivePane,
  type HostBudgetOptions,
} from './host-dispatch-budget.js';
import { decodeBudgetPaneLabel } from './host-dispatch-budget.repair.js';

/** The union figure for one tier, with the evidence behind it. */
export interface HostBudgetLiveWork {
  kind: HostBudgetKind;
  /** The ledger's own count for the tier (unchanged semantics). */
  reserved: number;
  /**
   * Pane ids of live dispatcher panes of this tier that NO entry accounts for.
   * Surface-only detail (the budget dialog); never a gate.
   */
  unreservedPaneIds: string[];
  /** The ONE figure both the header and admission use: `reserved + unreserved`. */
  live: number;
  /** Per-tier ledger counts (unchanged semantics, both tiers). */
  counts: HostBudgetCounts;
  /** Entries the rule excluded as dead (reaped on the fs-backed read). */
  reaped: number;
}

/** Result of the fs-backed read. */
export type HostBudgetLiveWorkResult = ({ ok: true } & HostBudgetLiveWork) | HostBudgetFailure;

/**
 * The union counting rule (pure, non-mutating).
 *
 * `livePanes` of `undefined` means pane liveness is UNKNOWN: the pane half
 * contributes nothing and the figure is the freshness-rule ledger count, so a
 * failed herdr read can neither invent work nor report a false zero.
 */
export function countLiveWork(
  entries: readonly HostBudgetEntry[],
  livePanes: readonly HostBudgetLivePane[] | undefined,
  kind: HostBudgetKind,
  now: number,
  staleWindowMs: number = HOST_BUDGET_STALE_WINDOW_MS,
): HostBudgetLiveWork {
  const livePaneIds = livePanes === undefined ? undefined : livePaneIdSet(livePanes);
  const reduction = reduceLedgerCounts(entries, livePaneIds, now, staleWindowMs);
  const reserved = reduction.counts[kind];

  const unreservedPaneIds: string[] = [];
  if (livePanes !== undefined) {
    // Retained entries are the post-sweep set: a reaped (dead, pane-less)
    // entry cannot "own" a live pane, and a stale-but-live implement entry is
    // retained precisely because its pane is alive.
    const owned = new Set<string>();
    for (const entry of reduction.retained) {
      if (entry.kind !== kind) continue;
      owned.add(entry.itemId);
      if (entry.paneId !== undefined) owned.add(`pane:${entry.paneId}`);
    }
    const seen = new Set<string>();
    for (const pane of livePanes) {
      if (typeof pane.paneId !== 'string' || pane.paneId === '') continue;
      const decoded = decodeBudgetPaneLabel(pane.title);
      if (decoded.kind !== kind) continue;
      // No work-item id ⇒ the pane cannot be attributed to an entry NOR
      // attributed as a distinct unreserved dispatch; skip it rather than
      // counting an unattributable pane twice.
      if (decoded.itemId === null) continue;
      if (owned.has(decoded.itemId) || owned.has(`pane:${pane.paneId}`)) continue;
      if (seen.has(decoded.itemId)) continue;
      seen.add(decoded.itemId);
      unreservedPaneIds.push(pane.paneId);
    }
  }

  return {
    kind,
    reserved,
    unreservedPaneIds,
    live: reserved + unreservedPaneIds.length,
    counts: reduction.counts,
    reaped: reduction.reaped.length,
  };
}

/**
 * Read the ledger and return the union figure for one tier.
 *
 * Mirrors `liveCount`'s side effects exactly — a stale, pane-less entry is
 * reaped best-effort on read so a crashed leader cannot wedge the host, and
 * NOTHING is reaped on an unknown pane read — while counting by the shared
 * union rule above. The returned figure already excludes the reaped entries
 * (the reduction excludes them before the write), so lock contention only
 * defers the cleanup.
 */
export function readHostBudgetLiveWork(
  kind: HostBudgetKind,
  livePanes: readonly HostBudgetLivePane[] | undefined,
  opts: HostBudgetOptions = {},
): HostBudgetLiveWorkResult {
  const read = readBudget(opts);
  if (!read.ok) return read;
  const now = opts.now ?? Date.now();
  const windowMs = opts.staleWindowMs ?? HOST_BUDGET_STALE_WINDOW_MS;
  const work = countLiveWork(read.ledger.entries, livePanes, kind, now, windowMs);
  if (work.reaped > 0) {
    // Best-effort cleanup of exactly the entries the rule already excluded; the
    // count is unaffected, so a failure (lock contention) only defers it.
    reap(livePanes, { ...opts, now, staleWindowMs: windowMs });
  }
  return { ok: true, ...work };
}
