/**
 * packages/herdr/src/dispatch-window-start.test.ts — pins the read-only
 * operator surface for a dispatch window of NOT-YET-STARTED items
 * (WL-0MWMGEWH7004VUFI).
 *
 * Every test asserts OBSERVABLE behaviour of the public helpers: which bucket
 * an item lands in, exactly when the warning fires (and when it must not),
 * what the banner/header/row copy says, and that the whole computation is
 * strictly read-only (no item, `startOn` or dispatch decision changes).
 */

import { describe, expect, it } from 'vitest';
import {
  notStartedBannerText,
  notStartedRowMarker,
  notStartedStatusText,
  summariseDispatchWindowStart,
} from './dispatch-window-start.js';
import { classifyItemForDispatch } from './downtime-worker.gates.js';
import type { DowntimeItemInfo } from './downtime-worker.types.js';
import { createFrozenClock } from '../../../tests/helpers/frozen-clock.js';

const clock = createFrozenClock('2026-06-01T12:00:00.000Z');

/** A plan_complete item the dispatcher would dispatch as `implement`. */
function dispatchable(
  id: string,
  overrides: Partial<DowntimeItemInfo> = {},
): DowntimeItemInfo {
  return {
    id,
    title: id,
    status: 'open',
    stage: 'plan_complete',
    risk: 'Low',
    effort: 'S',
    createdAt: clock.isoAt(-86_400_000),
    ...overrides,
  };
}

/** An item scheduled at `offsetMs` from the frozen clock. */
function scheduled(id: string, offsetMs: number, overrides: Partial<DowntimeItemInfo> = {}): DowntimeItemInfo {
  return dispatchable(id, { startOn: clock.isoAt(offsetMs), ...overrides });
}

describe('summariseDispatchWindowStart — bucket classification', () => {
  it('splits the window into started and not-yet-started buckets', () => {
    const summary = summariseDispatchWindowStart(
      [scheduled('A', 60_000), scheduled('B', -60_000), dispatchable('C')],
      { windowSize: 3, now: clock.now() },
    );
    expect(summary).toEqual({
      windowSize: 3,
      notStartedCount: 1,
      startedCount: 2,
      earliestStartOn: clock.isoAt(60_000),
      allNotStarted: false,
    });
  });

  it('defaults the start instant to createdAt', () => {
    const futureCreated = dispatchable('A', { createdAt: clock.isoAt(60_000), startOn: undefined });
    const pastCreated = dispatchable('B', { createdAt: clock.isoAt(-60_000), startOn: undefined });
    const summary = summariseDispatchWindowStart([futureCreated, pastCreated], {
      windowSize: 2,
      now: clock.now(),
    });
    expect(summary.notStartedCount).toBe(1);
    expect(summary.startedCount).toBe(1);
  });

  it('treats an instant equal to `now` as started (inclusive boundary)', () => {
    const atBoundary = dispatchable('A', { startOn: clock.nowIso() });
    const summary = summariseDispatchWindowStart([atBoundary], {
      windowSize: 1,
      now: clock.now(),
    });
    expect(summary.notStartedCount).toBe(0);
    expect(summary.allNotStarted).toBe(false);
  });

  it('fails open on an unreadable start instant (never reads as scheduled)', () => {
    const corrupt = dispatchable('A', { startOn: 'not-a-date' });
    const summary = summariseDispatchWindowStart([corrupt], {
      windowSize: 1,
      now: clock.now(),
    });
    expect(summary.notStartedCount).toBe(0);
    expect(summary.startedCount).toBe(1);
    expect(summary.allNotStarted).toBe(false);
  });

  it('reports the earliest start instant of the not-started bucket', () => {
    const summary = summariseDispatchWindowStart(
      [scheduled('A', 120_000), scheduled('B', 60_000), scheduled('C', 300_000)],
      { windowSize: 3, now: clock.now() },
    );
    expect(summary.earliestStartOn).toBe(clock.isoAt(60_000));
    expect(summary.allNotStarted).toBe(true);
  });

  it('inspects only the head of the canonical sprint-view window', () => {
    // Default window is 20 items: a not-started 21st item is outside the
    // window the dispatcher ranks over, so it must not change the verdict.
    const started = Array.from({ length: 20 }, (_, i) => dispatchable(`S${i}`));
    const summary = summariseDispatchWindowStart([...started, scheduled('OUTSIDE', 60_000)]);
    expect(summary.windowSize).toBe(20);
    expect(summary.notStartedCount).toBe(0);
    expect(summary.allNotStarted).toBe(false);
  });

  it('returns an all-zero summary for an empty window', () => {
    const summary = summariseDispatchWindowStart([], { windowSize: 0, now: clock.now() });
    expect(summary).toEqual({
      windowSize: 0,
      notStartedCount: 0,
      startedCount: 0,
      earliestStartOn: null,
      allNotStarted: false,
    });
    expect(notStartedBannerText(summary)).toBeNull();
    expect(notStartedStatusText(summary)).toBeNull();
  });
});

describe('notStartedStatusText / notStartedBannerText — copy', () => {
  const allFuture = summariseDispatchWindowStart(
    [scheduled('A', 60_000), scheduled('B', 120_000)],
    { windowSize: 2, now: clock.now() },
  );

  it('reports the not-started count in the header status, null when zero', () => {
    expect(notStartedStatusText(allFuture)).toBe('[not started: 2]');
    expect(
      notStartedStatusText(
        summariseDispatchWindowStart([dispatchable('A')], { windowSize: 1, now: clock.now() }),
      ),
    ).toBeNull();
    expect(notStartedStatusText(null)).toBeNull();
    expect(notStartedStatusText(undefined)).toBeNull();
  });

  it('renders the all-not-started banner with the count and earliest instant', () => {
    expect(notStartedBannerText(allFuture)).toBe(
      `Not started — all 2 of 2 dispatch-window item(s) start after ${clock.isoAt(60_000)}; no downtime dispatch possible`,
    );
  });

  it('renders no banner when at least one item has already started', () => {
    const mixed = summariseDispatchWindowStart(
      [scheduled('A', 60_000), dispatchable('B')],
      { windowSize: 2, now: clock.now() },
    );
    expect(notStartedBannerText(mixed)).toBeNull();
    // The header still reports the scheduled count.
    expect(notStartedStatusText(mixed)).toBe('[not started: 1]');
  });
});

describe('notStartedRowMarker', () => {
  it('marks a future item with its canonical start instant', () => {
    expect(
      notStartedRowMarker(dispatchable('A', { startOn: clock.isoAt(60_000) }), clock.now()),
    ).toBe(`[not started until ${clock.isoAt(60_000)}]`);
  });

  it('renders no marker for an already-started (or unreadable) item', () => {
    expect(notStartedRowMarker(dispatchable('A', { startOn: clock.isoAt(-60_000) }), clock.now())).toBeNull();
    expect(notStartedRowMarker(dispatchable('A', { startOn: 'nonsense' }), clock.now())).toBeNull();
  });
});

describe('summariseDispatchWindowStart — strictly read-only', () => {
  it('mutates neither the items nor their dispatchability', () => {
    const items = [scheduled('A', 60_000), dispatchable('B'),
      dispatchable('C', { assignee: 'Map' })];
    const before = structuredClone(items);
    const beforeKinds = items.map((item) => classifyItemForDispatch(item, clock.now()));

    summariseDispatchWindowStart(items, { windowSize: items.length, now: clock.now() });

    // Byte-identical input: nothing claimed, cleared or re-scheduled ...
    expect(items).toEqual(before);
    // ... and an identical dispatch decision set (the surface never changes
    // what the dispatcher does).
    expect(items.map((item) => classifyItemForDispatch(item, clock.now()))).toEqual(beforeKinds);
  });
});
