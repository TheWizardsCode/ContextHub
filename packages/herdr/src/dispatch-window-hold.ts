/**
 * packages/herdr/src/dispatch-window-hold.ts — operator surface for a dispatch
 * window that is held ENTIRELY by the `assignee` scheduling hold.
 *
 * Work item: WL-0MVR8FN1D002SCIR (parent WL-0MVR8EXR6009F05V).
 *
 * ## Why this module exists
 *
 * `assignee` doubles as the producer's scheduling hold (`AGENTS.md`: the
 * producer parks work with `wl update <id> --assignee Map` and clears it with
 * `--assignee ""`). `classifyItemForDispatch` correctly refuses to dispatch
 * held items at every tier (WL-0MV85WCJJ0087VMP) — but the refusal is
 * indistinguishable from an empty or broken backlog: on 2026-10-27T21:55Z the
 * `AI_Hell` root offered nothing for hours with 30/30 window items held by
 * `assignee=Map`, and nothing anywhere told the operator that a blanket hold
 * was the reason.
 *
 * This module turns the already-fetched dispatch window into
 *
 *  - a read-only {@link DispatchWindowHoldSummary} (counts per bucket plus the
 *    distinct sentinel values), surfaced in the worklist header (AC1), and
 *  - a warning banner when the window has **zero** dispatchable items
 *    *solely* because of assignee holds (AC2), which names the sentinel
 *    value(s) and the count.
 *
 * ## Strictly read-only (AC4)
 *
 * Nothing here mutates an item, clears a hold, or changes a dispatch decision:
 * the classification reuses the dispatcher's own
 * `classifyItemForDispatch` and the shared `classifyWindowHold` helper that
 * produces the coordination log's `all-window-items-held` token
 * (WL-0MVR8FKMU009XTED AC1), so the TUI and the log can never diverge. The
 * account is derived from items the worklist has ALREADY fetched — no new
 * `wl` subprocess spawn, and no second ranking path
 * (WL-0MTK1ILM2009QYB2).
 */

import { resolveSprintViewWindow } from './browse-window.js';
import { classifyItemForDispatch } from './downtime-worker.gates.js';
import { classifyWindowHold } from './downtime-worker.selection.js';
import type { DowntimeItemInfo } from './downtime-worker.types.js';

/**
 * Read-only account of one dispatch window's `assignee` holds.
 *
 * Buckets are mutually exclusive and cover the whole window:
 *  - `dispatchableCount` — the dispatcher would dispatch it as-is;
 *  - `heldCount` — refused by the `assignee` scheduling hold;
 *  - `gatedCount` — refused by some OTHER gate (producer review, freshness,
 *    soft delete, effort cap, …) — that case belongs to
 *    `WL-0MVR8FKMU009XTED`'s empty-offer attribution, not to this warning.
 */
export interface DispatchWindowHoldSummary {
  /** Items inspected (the canonical sprint-view window, head-first). */
  windowSize: number;
  /** Items the dispatcher would dispatch as-is. */
  dispatchableCount: number;
  /** Items refused solely by a non-empty `assignee`. */
  heldCount: number;
  /** Items refused by a gate other than the assignee hold. */
  gatedCount: number;
  /** Distinct non-empty assignees observed (the sentinels), sorted. */
  heldAssignees: string[];
  /**
   * Held items that WOULD be dispatchable if their `assignee` were empty.
   * Zero means "the hold is not the sole reason" — some other gate would
   * still refuse them, so no all-held warning must fire (AC2/AC3).
   */
  wouldDispatchIfReleased: number;
  /**
   * The AC2 warning condition: a non-empty window with NO dispatchable item,
   * EVERY item held by `assignee`, and at least one hold that actually
   * matters (`wouldDispatchIfReleased > 0`).
   */
  allHeld: boolean;
}

/** An all-zero summary (empty window) — the shape callers can safely render. */
const EMPTY_SUMMARY: DispatchWindowHoldSummary = {
  windowSize: 0,
  dispatchableCount: 0,
  heldCount: 0,
  gatedCount: 0,
  heldAssignees: [],
  wouldDispatchIfReleased: 0,
  allHeld: false,
};

/**
 * Summarise the `assignee` holds in a dispatch window.
 *
 * `items` must be the ALREADY-FETCHED window (the worklist's own rows): the
 * helper performs no I/O and never mutates its input. The window is the
 * canonical sprint view — `resolveSprintViewWindow(browseItemCount)` head
 * items, exactly the slice the downtime dispatcher ranks over
 * (WL-0MUNS8X97007C9H9) — unless the caller passes an explicit `windowSize`
 * for a differently-sized window (tests, other surfaces).
 *
 * Classification is delegated to the dispatcher's own gates, so the buckets
 * cannot drift from the dispatch decision itself.
 */
export function summariseDispatchWindowHold(
  items: ReadonlyArray<DowntimeItemInfo>,
  opts: { windowSize?: number; now?: number } = {},
): DispatchWindowHoldSummary {
  const now = opts.now ?? Date.now();
  const windowSize = Math.max(
    0,
    Math.trunc(opts.windowSize ?? resolveSprintViewWindow()),
  );
  const window = items.slice(0, windowSize);
  if (window.length === 0) return { ...EMPTY_SUMMARY };

  const hold = classifyWindowHold(window);
  let dispatchableCount = 0;
  let heldCount = 0;
  let gatedCount = 0;
  let wouldDispatchIfReleased = 0;

  for (const item of window) {
    if (classifyItemForDispatch(item, now) !== null) {
      dispatchableCount += 1;
      continue;
    }
    // Refused. Decide whether the assignee hold is the gate that refused it
    // by re-classifying with the hold released — no mutation of the caller's
    // item (a copy is classified, the item itself is untouched).
    const released = classifyItemForDispatch({ ...item, assignee: '' }, now) !== null;
    const held = typeof item.assignee === 'string' && item.assignee.trim().length > 0;
    if (held) {
      heldCount += 1;
      if (released) wouldDispatchIfReleased += 1;
    } else {
      gatedCount += 1;
    }
  }

  const allHeld =
    window.length > 0 &&
    dispatchableCount === 0 &&
    gatedCount === 0 &&
    heldCount === window.length &&
    wouldDispatchIfReleased > 0;

  return {
    windowSize: window.length,
    dispatchableCount,
    heldCount,
    gatedCount,
    heldAssignees: hold.heldAssignees,
    wouldDispatchIfReleased,
    allHeld,
  };
}

/** `Map` / `Map, Producer` — the sentinel list rendered for the operator. */
function sentinelList(summary: DispatchWindowHoldSummary): string {
  return summary.heldAssignees.length > 0 ? summary.heldAssignees.join(', ') : 'assignee';
}

/**
 * Header indicator naming how many window items are held by an `assignee`
 * (AC1): `[held: 30 by Map]`. `null` when nothing is held, so no chrome row
 * or header segment is added for the overwhelmingly common case.
 */
export function assigneeHoldStatusText(
  summary: DispatchWindowHoldSummary | null | undefined,
): string | null {
  if (summary === null || summary === undefined || summary.heldCount === 0) return null;
  return `[held: ${summary.heldCount} by ${sentinelList(summary)}]`;
}

/**
 * Banner copy for a window held entirely by `assignee` (AC2), or `null` when
 * the banner must not render (AC3: at least one dispatchable item, an empty
 * window, or a window with non-assignee rejections).
 *
 * The copy names the sentinel value(s) and the count so the operator can tell
 * "I parked this work on purpose" from "the dispatcher is broken" without
 * reading the dispatcher's source.
 */
export function assigneeHoldBannerText(
  summary: DispatchWindowHoldSummary | null | undefined,
): string | null {
  if (summary === null || summary === undefined || !summary.allHeld) return null;
  return `Assignee hold — all ${summary.heldCount} of ${summary.windowSize} dispatch-window item(s) held by ${sentinelList(summary)}; no downtime dispatch possible`;
}
