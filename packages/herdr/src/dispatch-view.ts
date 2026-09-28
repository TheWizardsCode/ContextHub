/**
 * Synthetic "recent dispatch" rows for the Herdr worklist
 * (WL-0MUL2IY8L009S3PQ, parent WL-0MUGLL9SS002E1D2).
 *
 * The downtime worker now auto-closes panes whose dispatched work reached a
 * clean terminal state, so completed work disappears from the active
 * worklist. The `recentDispatchedItems` projection in `downtime-log.ts`
 * recovers the raw log data; this module converts each projected row into a
 * synthetic {@link WorkItem} so it can render through the existing list line
 * formatter and metadata panel without any live `wl` fetch.
 *
 * Synthetic rows are DISPLAY-ONLY: they are never written back to `wl` and are
 * marked with `isLogDerived: true` so the renderer can show `—` for absent
 * live fields (priority/risk/effort/audit state) and annotate the dispatch
 * kind/outcome instead of pretending to have full work-item metadata.
 */

import type { WorkItem } from './fetcher.js';
import type { RecentDispatchRow } from './downtime-log.js';

/**
 * Build a synthetic {@link WorkItem} from one projection row. The id and
 * title come from the log (never from `wl list`), so an item that has since
 * been closed or deleted still appears. Live-only fields (priority, risk,
 * effort, audit state, parent, timestamps) are deliberately left unset — the
 * renderer degrades them to `—` for log-derived rows.
 *
 * The dispatch metadata is carried on `dispatchKind`/`dispatchOutcome`/
 * `dispatchedAt` for the renderer and metadata panel, and mirrored into the
 * description so the detail fallback has something to show even when the item
 * no longer exists in `wl` (parent AC5; wired in a later slice).
 */
export function buildDispatchWorkItem(row: RecentDispatchRow): WorkItem {
  const outcome = row.latestOutcome;
  // Derive a human-meaningful status from the pane-close outcome: flagged
  // panes read as blocked, clean terminal closes as completed, and a dispatch
  // with no close event yet as still in progress.
  const status =
    outcome === 'requires-attention' ? 'blocked' : outcome ? 'completed' : 'in_progress';

  const description = [
    'Log-derived dispatch row — projected from `.worklog/downtime-dispatches.log`, not a live work item.',
    '',
    `- Dispatch kind: ${row.kind ?? '—'}`,
    `- Latest outcome: ${outcome ?? '—'}`,
    `- Latest activity: ${row.latestTimestamp ?? '—'}`,
  ].join('\n');

  return {
    id: row.itemId,
    title: row.title,
    status,
    isLogDerived: true,
    dispatchKind: row.kind,
    dispatchOutcome: outcome,
    dispatchedAt: row.latestTimestamp,
    description,
  };
}
