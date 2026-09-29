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
 * marked with `isLogDerived: true` so the renderer can annotate the dispatch
 * kind/outcome. When the work item still exists in `wl` the row is instead
 * built by {@link mergeDispatchRow}, which renders the LIVE item (so status/
 * stage/audit/review/priority icons are byte-for-byte the same as every other
 * view) and only adds the dispatch annotations; {@link buildDispatchWorkItem}
 * is the fallback for an item that is now closed/deleted (WL-0MUGLL9SS002E1D2
 * audit fix).
 */

import type { WorkItem } from './fetcher.js';
import type { RecentDispatchRow } from './downtime-log.js';

/**
 * Build a synthetic {@link WorkItem} from one projection row. Used ONLY when
 * the item is absent from `wl` (closed/deleted): the id and title come from the
 * log so the item still appears, and live-only fields (priority, risk, effort,
 * audit state, parent, timestamps) are left unset — the renderer degrades them
 * to `—` because `isLogOnly` is set. When the item still exists,
 * {@link mergeDispatchRow} is preferred so the row renders exactly like every
 * other view.
 *
 * The dispatch metadata is carried on `dispatchKind`/`dispatchOutcome`/
 * `dispatchedAt` for the renderer and metadata panel, and mirrored into the
 * description so the detail fallback has something to show even when the item
 * no longer exists in `wl` (parent AC5).
 */
export function buildDispatchWorkItem(row: RecentDispatchRow): WorkItem {
  const outcome = row.latestOutcome;
  // Derive a human-meaningful status from the pane-close outcome: flagged
  // panes read as blocked, clean terminal closes as completed, and a dispatch
  // with no close event yet as still in progress.
  const status =
    outcome === 'requires-attention' ? 'blocked' : outcome ? 'completed' : 'in_progress';

  // Render the SAME stage/audit icons as a live row (WL-0MUGLL9SS002E1D2 audit
  // fix): carry the log-derived stage so the list prefix and metadata Stage row
  // show a real stage glyph (📥/📋/🔍/…) instead of the ❓ unknown fallback.
  // For an audit outcome, the pane-close timestamp is both the audited-at and
  // the last-content-change time (nothing later in the log), so the shared
  // `stageDisplayIcon` resolves a fresh ✅/❌ verdict exactly as a freshly
  // audited `in_review` live row would.
  const auditTimestamps =
    row.auditResult !== undefined && row.latestTimestamp !== undefined
      ? { auditedAt: row.latestTimestamp, updatedAt: row.latestTimestamp }
      : {};

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
    stage: row.stage,
    auditResult: row.auditResult,
    ...auditTimestamps,
    isLogDerived: true,
    // No live item available — the renderer shows `—` for absent fields.
    isLogOnly: true,
    dispatchKind: row.kind,
    dispatchOutcome: outcome,
    dispatchedAt: row.latestTimestamp,
    description,
  };
}

/**
 * A log-derived row for a work item that STILL EXISTS in `wl`, rendered from
 * the LIVE item so the list row and metadata panel show the exact same status/
 * stage/audit/review/priority icons as every other view (WL-0MUGLL9SS002E1D2
 * audit fix). Only the dispatch provenance (`dispatchKind`/`dispatchOutcome`/
 * `dispatchedAt` + `isLogDerived`) is overlaid. `isLogOnly` is deliberately
 * NOT set, so {@link buildMetaRows} renders the live fields normally rather
 * than degrading them to `—`.
 */
export function mergeDispatchRow(live: WorkItem, row: RecentDispatchRow): WorkItem {
  const merged: WorkItem = { ...live };
  // Strip the live browse list's grouping so the dispatches view stays a flat,
  // newest-first list in log order; interleaving live groups would repeat
  // headings (getDisplayRows emits one whenever `group` changes).
  delete merged.group;
  delete merged.groupLabel;
  merged.isLogDerived = true;
  merged.dispatchKind = row.kind;
  merged.dispatchOutcome = row.latestOutcome;
  merged.dispatchedAt = row.latestTimestamp;
  return merged;
}
