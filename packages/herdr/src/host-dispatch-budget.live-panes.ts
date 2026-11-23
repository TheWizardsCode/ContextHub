/**
 * packages/herdr/src/host-dispatch-budget.live-panes.ts — the LIVE-pane
 * projection the dispatch budget counts against (WL-0MWJVY6NR001E0FS).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The machine-wide pane read (`getRunningDowntimePanes` →
 * `RunningPanesResult.records`) deliberately carries the FULL parsed pane set:
 * the in-flight guard and the pane-close paths need the label suffix of every
 * pane, whether or not its agent is still alive. The dispatch-budget counting
 * rule (`host-dispatch-budget.counting.ts`) is a different question: it asks
 * "how much work is in flight?", and a pane whose agent session has ENDED is
 * not in flight.
 *
 * The budget surfaces used to feed every record straight into the union count,
 * so a finished session whose pane stayed OPEN — an `implement` pane is never
 * auto-closed, and a terminal `audit` pane is caught by the dead-agent guard —
 * kept its tier slot occupied for the whole 2 h staleness window even after
 * the reaper had released its ledger entry. The pane half of the union rule
 * still counted it, so the header and admission stayed at the cap while idle,
 * finished panes sat open.
 *
 * The union rule's own vocabulary is already "LIVE dispatcher panes", so this
 * module makes the feed say what the rule means: a pane whose herdr agent
 * status is TERMINAL (`done`/`exited` — the shared
 * {@link isTerminalAgentStatus} vocabulary) has ended its session and is
 * excluded.
 *
 * A terminal status is the ONE signal the pane list already carries for "the
 * session has ended" (the `</end_session>` marker is handled by the reaper's
 * own release path, which *removes* the ledger entry; once the entry is gone
 * the pane is counted only through this projection, so excluding it here is
 * what actually drops the figure). Every other status — `working`, `idle`, an
 * empty/unknown value, or a record with no status at all — stays counted
 * (fail-open), so a herdr quirk can never over-admit and the pre-existing
 * "count the pane unless we know it finished" behaviour is preserved.
 */

import type { HostBudgetLivePane } from './host-dispatch-budget.js';
import { isTerminalAgentStatus, type HerdrPaneRecord } from './pane-discovery.js';

/**
 * Project the full pane-record set onto the budget's LIVE-pane list.
 *
 * A record is included unless its agent status is terminal
 * ({@link isTerminalAgentStatus}): a `done`/`exited` agent is a finished
 * session and must not hold a dispatch-budget slot. The `label` is forwarded as
 * the pane `title` so the ledger's repair/adoption path can still decode the
 * `(kind, itemId)` suffix.
 *
 * Pure and order-preserving; safe to call on every admission/display read.
 */
export function liveBudgetPanesFromRecords(
  records: readonly HerdrPaneRecord[],
): HostBudgetLivePane[] {
  const panes: HostBudgetLivePane[] = [];
  for (const record of records) {
    if (isTerminalAgentStatus(record.agentStatus)) continue;
    panes.push({
      paneId: record.paneId,
      ...(typeof record.label === 'string' ? { title: record.label } : {}),
    });
  }
  return panes;
}
