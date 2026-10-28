/**
 * packages/herdr/src/dispatch-window-hold.test.ts — pins the operator surface
 * for a dispatch window held entirely by the `assignee` scheduling hold
 * (WL-0MVR8FN1D002SCIR AC5).
 *
 * Every test asserts OBSERVABLE behaviour of the public helpers: which bucket
 * an item lands in, exactly when the warning fires (and the three cases where
 * it must not), what the banner/header copy names, and that the whole
 * computation is strictly read-only (no item is mutated, no dispatch decision
 * changes) — AC4.
 */

import { describe, expect, it } from 'vitest';
import {
  assigneeHoldBannerText,
  assigneeHoldStatusText,
  summariseDispatchWindowHold,
} from './dispatch-window-hold.js';
import { classifyItemForDispatch } from './downtime-worker.gates.js';
import type { DowntimeItemInfo } from './downtime-worker.types.js';

/** A plan_complete item the dispatcher would dispatch as `implement`. */
function dispatchable(id: string, overrides: Partial<DowntimeItemInfo> = {}): DowntimeItemInfo {
  return {
    id,
    title: id,
    status: 'open',
    stage: 'plan_complete',
    risk: 'Low',
    effort: 'S',
    ...overrides,
  };
}

/** The same item, parked by the producer sentinel. */
function held(id: string, assignee = 'Map'): DowntimeItemInfo {
  return dispatchable(id, { assignee });
}

/** A plan_complete item refused by a gate OTHER than the assignee hold. */
function gated(id: string): DowntimeItemInfo {
  return dispatchable(id, { needsProducerReview: true });
}

/** The AI_Hell shape: a 30-item window, every item held by `Map`. */
function allHeldWindow(count = 30): DowntimeItemInfo[] {
  return Array.from({ length: count }, (_, i) => held(`AH-${i}`));
}

describe('summariseDispatchWindowHold — bucket classification (AC1/AC5)', () => {
  it('classifies dispatchable, assignee-held and otherwise-gated items', () => {
    const summary = summariseDispatchWindowHold(
      [dispatchable('A'), held('B'), gated('C')],
      { windowSize: 3 },
    );
    expect(summary).toEqual({
      windowSize: 3,
      dispatchableCount: 1,
      heldCount: 1,
      gatedCount: 1,
      heldAssignees: ['Map'],
      wouldDispatchIfReleased: 1,
      allHeld: false,
    });
  });

  it('names every distinct sentinel value, sorted and deduplicated', () => {
    const summary = summariseDispatchWindowHold(
      [held('A', 'Map'), held('B', 'producer'), held('C', 'Map')],
      { windowSize: 3 },
    );
    expect(summary.heldCount).toBe(3);
    expect(summary.heldAssignees).toEqual(['Map', 'producer']);
  });

  it('reports a completely held window as allHeld with the count and sentinel', () => {
    const summary = summariseDispatchWindowHold(allHeldWindow(30), { windowSize: 30 });
    expect(summary.windowSize).toBe(30);
    expect(summary.heldCount).toBe(30);
    expect(summary.dispatchableCount).toBe(0);
    expect(summary.gatedCount).toBe(0);
    expect(summary.wouldDispatchIfReleased).toBe(30);
    expect(summary.allHeld).toBe(true);
  });

  it('inspects only the head of the canonical sprint-view window', () => {
    // Default window is 20 items: a held 21st item is outside the window the
    // dispatcher ranks over, so it must not change the verdict.
    const items = [...allHeldWindow(20), dispatchable('OUTSIDE')];
    const summary = summariseDispatchWindowHold(items);
    expect(summary.windowSize).toBe(20);
    expect(summary.dispatchableCount).toBe(0);
    expect(summary.allHeld).toBe(true);
  });
});

describe('summariseDispatchWindowHold — warning threshold and negatives (AC2/AC3/AC5)', () => {
  it('AC2: zero dispatchable AND every item held solely by assignee → warn', () => {
    expect(summariseDispatchWindowHold(allHeldWindow(30), { windowSize: 30 }).allHeld).toBe(true);
  });

  it('AC3: does NOT warn when at least one item is dispatchable', () => {
    const summary = summariseDispatchWindowHold(
      [...allHeldWindow(29), dispatchable('FREE')],
      { windowSize: 30 },
    );
    expect(summary.dispatchableCount).toBe(1);
    expect(summary.allHeld).toBe(false);
    // AC1 still reports the holds, so the operator sees them in the header.
    expect(summary.heldCount).toBe(29);
    expect(summary.heldAssignees).toEqual(['Map']);
  });

  it('AC3: does NOT warn for an empty window', () => {
    const summary = summariseDispatchWindowHold([], { windowSize: 0 });
    expect(summary).toEqual({
      windowSize: 0,
      dispatchableCount: 0,
      heldCount: 0,
      gatedCount: 0,
      heldAssignees: [],
      wouldDispatchIfReleased: 0,
      allHeld: false,
    });
    expect(assigneeHoldBannerText(summary)).toBeNull();
  });

  it('AC3: does NOT warn when a non-assignee gate also rejects an item', () => {
    const summary = summariseDispatchWindowHold([...allHeldWindow(29), gated('G')], {
      windowSize: 30,
    });
    expect(summary.gatedCount).toBe(1);
    expect(summary.allHeld).toBe(false);
  });

  it('AC3: does NOT warn when the holds are not the sole reason (released item is still refused)', () => {
    // Non-dispatchable even with an empty assignee: the hold is not why the
    // window is idle, so this is NOT an assignee-hold story.
    const stranded: DowntimeItemInfo = {
      id: 'S1',
      status: 'completed',
      stage: 'idea',
      assignee: 'Map',
    };
    const summary = summariseDispatchWindowHold([stranded], { windowSize: 1 });
    expect(summary.heldCount).toBe(1);
    expect(summary.wouldDispatchIfReleased).toBe(0);
    expect(summary.allHeld).toBe(false);
  });
});

describe('assigneeHoldBannerText / assigneeHoldStatusText — copy (AC1/AC2)', () => {
  const held30 = summariseDispatchWindowHold(allHeldWindow(30), { windowSize: 30 });

  it('names the sentinel count and the count of held items in the banner', () => {
    expect(assigneeHoldBannerText(held30)).toBe(
      'Assignee hold — all 30 of 30 dispatch-window item(s) held by Map; no downtime dispatch possible',
    );
  });

  it('renders no banner unless the window is held solely by assignee', () => {
    expect(
      assigneeHoldBannerText(
        summariseDispatchWindowHold([held('A'), dispatchable('B')], { windowSize: 2 }),
      ),
    ).toBeNull();
    expect(assigneeHoldBannerText(null)).toBeNull();
    expect(assigneeHoldBannerText(undefined)).toBeNull();
  });

  it('reports the held count and sentinels in the header status (AC1)', () => {
    expect(
      assigneeHoldStatusText(
        summariseDispatchWindowHold([held('A'), dispatchable('B')], { windowSize: 2 }),
      ),
    ).toBe('[held: 1 by Map]');
    expect(
      assigneeHoldStatusText(
        summariseDispatchWindowHold([held('A', 'producer'), held('B', 'Map')], { windowSize: 2 }),
      ),
    ).toBe('[held: 2 by Map, producer]');
  });

  it('renders no header status when nothing is held', () => {
    expect(
      assigneeHoldStatusText(summariseDispatchWindowHold([dispatchable('A')], { windowSize: 1 })),
    ).toBeNull();
    expect(assigneeHoldStatusText(null)).toBeNull();
  });
});

describe('summariseDispatchWindowHold — strictly read-only (AC4)', () => {
  it('mutates neither the items nor their dispatchability', () => {
    const items = [...allHeldWindow(3), dispatchable('FREE')];
    const before = structuredClone(items);
    const beforeKinds = items.map((item) => classifyItemForDispatch(item));

    summariseDispatchWindowHold(items, { windowSize: items.length });

    // Byte-identical input (nothing cleared, demoted or re-assigned) ...
    expect(items).toEqual(before);
    // ... and an identical dispatch decision set: the warning surface can
    // never change what the dispatcher does.
    expect(items.map((item) => classifyItemForDispatch(item))).toEqual(beforeKinds);
  });
});
