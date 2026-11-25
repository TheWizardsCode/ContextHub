/**
 * packages/herdr/src/worklist-starton-marker.test.ts — the read-only
 * not-yet-started surface in the worklist (WL-0MWMGEWH7004VUFI).
 *
 * Pins three observable behaviours:
 *  - the per-row `[not started until <date>]` marker distinguishes a scheduled
 *    row from an already-started one;
 *  - the header count `[Future items: N]` and the all-not-started banner render
 *    from the display items;
 *  - rendering never mutates the item or its scheduling fields.
 */

import { describe, expect, it } from 'vitest';
import { createListRenderer, formatItemLine } from './worklist.js';
import {
  notStartedBannerText,
  notStartedStatusText,
  summariseDispatchWindowStart,
} from './dispatch-window-start.js';
import {
  assigneeHoldBannerText,
  assigneeHoldStatusText,
  summariseDispatchWindowHold,
} from './dispatch-window-hold.js';
import type { WorkItem } from './fetcher.js';
import type { DowntimeItemInfo } from './downtime-worker.types.js';
import { createFrozenClock } from '../../../tests/helpers/frozen-clock.js';

const clock = createFrozenClock('2026-06-01T12:00:00.000Z');
// Wide enough that the (long) banner copy is never truncated.
const TERM = { rows: 24, cols: 400 };

function item(id: string, offsetMs: number): WorkItem {
  return {
    id,
    title: `Item ${id}`,
    status: 'open',
    stage: 'plan_complete',
    createdAt: clock.isoAt(-86_400_000),
    startOn: clock.isoAt(offsetMs),
  };
}

/**
 * Invoke the positional `createListRenderer` with the two trailing
 * not-started arguments set (everything else left undefined/default).
 */
function renderWithNotStarted(
  items: WorkItem[],
  status: string | null,
  notice: string | null,
): string {
  const args: unknown[] = new Array(38).fill(undefined);
  args[0] = items;
  args[1] = 0;
  args[2] = 0;
  args[3] = TERM;
  args[4] = null;
  args[5] = 'list';
  args[6] = null;
  args[36] = status;
  args[37] = notice;
  return (createListRenderer(undefined) as (...a: unknown[]) => string)(...args);
}

describe('per-row not-started marker', () => {
  it('marks a future row with its canonical start instant', () => {
    const line = formatItemLine(item('FUTURE', 60_000), 120, false, false, clock.now());
    expect(line).toContain(`[not started until ${clock.isoAt(60_000)}]`);
  });

  it('renders no marker on an already-started row', () => {
    const line = formatItemLine(item('STARTED', -60_000), 120, false, false, clock.now());
    expect(line).not.toContain('not started');
  });

  it('never mutates the item while rendering its row', () => {
    const future = item('FUTURE', 60_000);
    const before = structuredClone(future);
    formatItemLine(future, 120, false, false, clock.now());
    expect(future).toEqual(before);
  });
});

describe('header count and all-not-started banner', () => {
  it('surfaces the count and the banner for a fully scheduled window', () => {
    const items = [item('A', 60_000), item('B', 120_000)];
    const summary = summariseDispatchWindowStart(items, {
      windowSize: 2,
      now: clock.now(),
    });
    const output = renderWithNotStarted(
      items,
      notStartedStatusText(summary),
      notStartedBannerText(summary),
    );
    expect(output).toContain('[Future items: 2]');
    expect(output).toContain(
      `Not started — all 2 of 2 dispatch-window item(s) start after ${clock.isoAt(60_000)}; no downtime dispatch possible`,
    );
  });

  it('renders no banner when at least one row has started', () => {
    const items = [item('A', 60_000), item('B', -60_000)];
    const summary = summariseDispatchWindowStart(items, {
      windowSize: 2,
      now: clock.now(),
    });
    const output = renderWithNotStarted(
      items,
      notStartedStatusText(summary),
      notStartedBannerText(summary),
    );
    // Header count still reports the scheduled row ...
    expect(output).toContain('[Future items: 1]');
    // ... but no warning banner.
    expect(output).not.toContain('no downtime dispatch possible');
  });

  it('renders no chrome for the common all-started window', () => {
    const items = [item('A', -60_000), item('B', -120_000)];
    const summary = summariseDispatchWindowStart(items, {
      windowSize: 2,
      now: clock.now(),
    });
    expect(summary.notStartedCount).toBe(0);
    const output = renderWithNotStarted(items, null, null);
    expect(output).not.toContain('[Future items:');
    expect(output).not.toContain('no downtime dispatch possible');
  });

  it('renders a scheduled row read-only, with dispatchability unchanged', () => {
    // A future item is still shown (read-only) — the view never claims it,
    // and the row marker is the only change.
    const items = [item('A', 60_000)];
    const before = structuredClone(items);
    renderWithNotStarted(items, '[Future items: 1]', null);
    expect(items).toEqual(before);
  });
});

describe('held-item semantics are unchanged alongside the schedule marker', () => {
  /** A dispatchable-at-the-time item for the hold accounting (not a WorkItem). */
  function info(
    id: string,
    overrides: Partial<DowntimeItemInfo> = {},
  ): DowntimeItemInfo {
    return {
      id,
      status: 'open',
      stage: 'plan_complete',
      risk: 'Low',
      effort: 'S',
      createdAt: clock.isoAt(-86_400_000),
      ...overrides,
    };
  }

  it('reports a held-and-scheduled item in BOTH headers without a false banner', () => {
    // One held item that is also scheduled for later, one started item: both
    // conditions are real, but neither is the sole reason the window is idle,
    // so neither warning banner may fire.
    const window = [
      info('HELD-FUTURE', { assignee: 'Map', startOn: clock.isoAt(60_000) }),
      info('STARTED', { startOn: clock.isoAt(-60_000) }),
    ];
    const hold = summariseDispatchWindowHold(window, { windowSize: 2, now: clock.now() });
    const start = summariseDispatchWindowStart(window, { windowSize: 2, now: clock.now() });

    // The hold bucket still reports the held item, and does NOT mis-attribute
    // the scheduled item's refusal to the hold ...
    expect(hold.heldCount).toBe(1);
    expect(hold.heldAssignees).toEqual(['Map']);
    expect(hold.gatedCount).toBe(0);
    expect(hold.allHeld).toBe(false);
    expect(assigneeHoldStatusText(hold)).toBe('[held: 1 by Map]');
    expect(assigneeHoldBannerText(hold)).toBeNull();

    // ... and the schedule bucket still reports the scheduled item.
    expect(start.notStartedCount).toBe(1);
    expect(start.allNotStarted).toBe(false);
    expect(notStartedStatusText(start)).toBe('[Future items: 1]');
    expect(notStartedBannerText(start)).toBeNull();
  });

  it('still fires the assignee-hold banner for an all-held, already-started window', () => {
    const window = [
      info('A', { assignee: 'Map', startOn: clock.isoAt(-60_000) }),
      info('B', { assignee: 'Map', startOn: clock.isoAt(-60_000) }),
    ];
    const hold = summariseDispatchWindowHold(window, { windowSize: 2, now: clock.now() });
    expect(hold.allHeld).toBe(true);
    expect(assigneeHoldBannerText(hold)).toContain('Assignee hold — all 2 of 2');
    expect(notStartedStatusText(summariseDispatchWindowStart(window, {
      windowSize: 2,
      now: clock.now(),
    }))).toBeNull();
  });
});
