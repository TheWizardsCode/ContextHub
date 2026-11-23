/**
 * packages/herdr/src/dispatch-window-start.ts — read-only operator surface for
 * a dispatch window whose items are NOT YET STARTED (`startOn` in the future).
 *
 * Work item: WL-0MWMGEWH7004VUFI (parent WL-0MWM0FDZK007BAD0).
 *
 * ## Why this module exists
 *
 * The `startOn` scheduling field (`startOn ?? createdAt`) is enforced by the
 * CLI's default search filter and by the dispatcher's
 * `startOnNotReached` gate, so a future item is never dispatched or claimed.
 * But an operator who sees an empty or idle dispatch window deserves to know
 * *why*: "nothing is dispatchable" and "everything is scheduled for later"
 * look identical otherwise. This module turns the already-fetched dispatch
 * window into
 *
 *  - a read-only {@link DispatchWindowStartSummary} (counts plus the earliest
 *    start instant), surfaced in the worklist header (AC: `[not started: N]`),
 *  - a warning banner when the window has **zero** already-started items
 *    (AC: `Not started — all N of M …`), and
 *  - a per-row marker `[not started until <date>]` so individual rows read
 *    differently from already-started ones.
 *
 * ## Strictly read-only
 *
 * Nothing here mutates an item, changes a `startOn`, claims work or alters a
 * dispatch decision: the account is derived from items the worklist has
 * ALREADY fetched — no new `wl` subprocess spawn, and no second ranking path
 * (mirroring `dispatch-window-hold.ts`, WL-0MVR8FN1D002SCIR).
 *
 * ## One definition of "not yet started"
 *
 * The classification delegates to the shared `isNotStarted` predicate
 * (`@worklog/shared/predicates`) — the single definition every CLI surface and
 * the dispatcher's gate use — and takes `now` as an explicit, injectable
 * parameter so tests can freeze the clock.
 */

import { effectiveStartOn, isNotStarted } from '@worklog/shared/predicates';
import type { StartOnFields } from '@worklog/shared/predicates';
import { resolveSprintViewWindow } from './browse-window.js';

/**
 * The temporal fields the marker reads — the shared predicate's own structural
 * shape (WL-0MWMGEL5R003IH71), so this surface and the dispatch gate can never
 * disagree about what "not yet started" means. Structural, so tests can pass
 * plain literals.
 */
export type StartOnItemLike = StartOnFields;

/**
 * Read-only account of one dispatch window's not-yet-started items.
 *
 * `windowSize === startedCount + notStartedCount`, so the two buckets cover
 * the whole window.
 */
export interface DispatchWindowStartSummary {
  /** Items inspected (the canonical sprint-view window, head-first). */
  windowSize: number;
  /** Items whose effective start instant is still in the future. */
  notStartedCount: number;
  /** Items that have already started (or whose instant is unreadable — fail open). */
  startedCount: number;
  /**
   * Canonical UTC ISO-8601 of the EARLIEST effective start among the
   * not-yet-started items, or `null` when the bucket is empty.
   */
  earliestStartOn: string | null;
  /**
   * The banner condition: a non-empty window with NO already-started item —
   * every item starts in the future, so no downtime dispatch is possible.
   */
  allNotStarted: boolean;
}

/** An all-zero summary (empty window) — the shape callers can safely render. */
const EMPTY_SUMMARY: DispatchWindowStartSummary = {
  windowSize: 0,
  notStartedCount: 0,
  startedCount: 0,
  earliestStartOn: null,
  allNotStarted: false,
};

/** Canonical epoch-ms form of a parseable instant, else `null`. */
function instantMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Summarise the not-yet-started items in a dispatch window.
 *
 * `items` must be the ALREADY-FETCHED window (the worklist's own rows): the
 * helper performs no I/O and never mutates its input. The window is the
 * canonical sprint view — `resolveSprintViewWindow(browseItemCount)` head
 * items — unless the caller passes an explicit `windowSize` for a
 * differently-sized window (tests, other surfaces).
 *
 * `now` is an explicit, injectable instant (epoch ms) so the accounting is
 * deterministic under a frozen clock. The shared `isNotStarted` predicate
 * fails OPEN (reads as started) when an item's instant is unreadable, so a
 * corrupt scheduling hint can never make an item look scheduled.
 */
export function summariseDispatchWindowStart(
  items: ReadonlyArray<StartOnItemLike>,
  opts: { windowSize?: number; now?: number } = {},
): DispatchWindowStartSummary {
  const now = opts.now ?? Date.now();
  const windowSize = Math.max(
    0,
    Math.trunc(opts.windowSize ?? resolveSprintViewWindow()),
  );
  const window = items.slice(0, windowSize);
  if (window.length === 0) return { ...EMPTY_SUMMARY };

  let notStartedCount = 0;
  let earliestMs: number | null = null;

  for (const item of window) {
    if (!isNotStarted(item, now)) continue;
    notStartedCount += 1;
    const ms = instantMs(effectiveStartOn(item.startOn, item.createdAt));
    if (ms !== null && (earliestMs === null || ms < earliestMs)) {
      earliestMs = ms;
    }
  }

  return {
    windowSize: window.length,
    notStartedCount,
    startedCount: window.length - notStartedCount,
    earliestStartOn: earliestMs === null ? null : new Date(earliestMs).toISOString(),
    allNotStarted: window.length > 0 && notStartedCount === window.length,
  };
}

/**
 * Header indicator naming how many window items are not yet started:
 * `[not started: N]`. `null` when nothing is scheduled, so no chrome row or
 * header segment is added for the overwhelmingly common case.
 */
export function notStartedStatusText(
  summary: DispatchWindowStartSummary | null | undefined,
): string | null {
  if (summary === null || summary === undefined || summary.notStartedCount === 0) return null;
  return `[not started: ${summary.notStartedCount}]`;
}

/**
 * Banner copy for a window where EVERY item is not yet started, or `null`
 * when the banner must not render (at least one item already started, or an
 * empty window). The copy names the count and the earliest start instant so
 * the operator can tell "this work is scheduled" from "the dispatcher is
 * broken" without reading the dispatcher's source.
 */
export function notStartedBannerText(
  summary: DispatchWindowStartSummary | null | undefined,
): string | null {
  if (summary === null || summary === undefined || !summary.allNotStarted) return null;
  const earliest = summary.earliestStartOn ?? 'a future instant';
  return `Not started — all ${summary.notStartedCount} of ${summary.windowSize} dispatch-window item(s) start after ${earliest}; no downtime dispatch possible`;
}

/**
 * Per-row marker for a not-yet-started item, e.g.
 * `[not started until 2026-11-19T10:25:00.000Z]`, or `null` when the item has
 * started (or its instant is unreadable — fail open, never a bogus marker).
 *
 * The bracketed shape mirrors the existing `[held: N by Map]` marker
 * (WL-0MVR8FN1D002SCIR) so operators read one visual grammar. `now` is
 * injectable for deterministic tests.
 */
export function notStartedRowMarker(
  item: StartOnItemLike,
  now: number = Date.now(),
): string | null {
  if (!isNotStarted(item, now)) return null;
  const iso = effectiveStartOn(item.startOn, item.createdAt);
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return `[not started until ${new Date(ms).toISOString()}]`;
}
