/**
 * packages/herdr/src/downtime-worker.starton-gate.test.ts — the
 * `startOnNotReached` dispatch gate (WL-0MWMGEWH7004VUFI).
 *
 * A not-yet-started item must never be selected for ANY dispatch tier, even
 * when a caller bypassed the CLI's default search filter. The gate is
 * clock-injectable, so every comparison here runs against the shared frozen
 * clock and is fully deterministic.
 */

import { describe, expect, it } from 'vitest';
import { classifyItemForDispatch } from './downtime-worker.gates.js';
import { selectCriticalFirstCandidates } from './downtime-worker.dispatch-filter.js';
import { classifyItemForDispatchDetail } from './downtime-worker.gates.js';
import type { DowntimeHerdrItem, DowntimeItemInfo } from './downtime-worker.types.js';
import { createFrozenClock } from '../../../tests/helpers/frozen-clock.js';

const clock = createFrozenClock('2026-06-01T12:00:00.000Z');

/** One representative item per dispatch tier. */
const TIER_ITEMS: Array<{ tier: string; item: DowntimeItemInfo }> = [
  {
    tier: 'intake',
    item: { id: 'I', status: 'open', stage: 'idea' },
  },
  {
    tier: 'plan',
    item: { id: 'P', status: 'open', stage: 'intake_complete' },
  },
  {
    tier: 'risk-effort',
    item: { id: 'R', status: 'open', stage: 'plan_complete' },
  },
  {
    tier: 'implement',
    item: { id: 'M', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' },
  },
  {
    tier: 'audit',
    item: {
      id: 'A',
      status: 'completed',
      stage: 'in_review',
      updatedAt: clock.nowIso(),
    },
  },
];

/** The same item with a start instant at `offsetMs` from the frozen clock. */
function at(item: DowntimeItemInfo, offsetMs: number): DowntimeItemInfo {
  return { ...item, createdAt: clock.isoAt(-86_400_000), startOn: clock.isoAt(offsetMs) };
}

describe('classifyItemForDispatchDetail — startOnNotReached refuses every tier', () => {
  it('refuses a future item at intake, plan, risk-effort, implement AND audit', () => {
    for (const { tier, item } of TIER_ITEMS) {
      const detail = classifyItemForDispatchDetail(at(item, 60_000), clock.now());
      expect(detail, `tier ${tier}`).toEqual({ kind: null, gate: 'startOnNotReached' });
      expect(classifyItemForDispatch(at(item, 60_000), clock.now()), `tier ${tier}`).toBeNull();
    }
  });

  it('dispatches the same items once their start instant is reached (or past)', () => {
    const expected: Record<string, string> = {
      intake: 'intake',
      plan: 'plan',
      'risk-effort': 'risk-effort',
      implement: 'implement',
      audit: 'audit',
    };
    for (const { tier, item } of TIER_ITEMS) {
      // `now - 1` is in the past: started.
      expect(classifyItemForDispatch(at(item, -1), clock.now()), `tier ${tier}`).toBe(expected[tier]);
    }
  });

  it('treats an instant equal to `now` as started (inclusive boundary)', () => {
    for (const { tier, item } of TIER_ITEMS) {
      expect(
        classifyItemForDispatch({ ...item, startOn: clock.nowIso() }, clock.now()),
        `tier ${tier}`,
      ).not.toBeNull();
    }
  });

  it('defaults the start instant to createdAt', () => {
    const planItem: DowntimeItemInfo = { status: 'open', stage: 'intake_complete' };
    // Future createdAt → not started.
    expect(
      classifyItemForDispatchDetail(
        { ...planItem, id: 'X', createdAt: clock.isoAt(60_000) },
        clock.now(),
      ),
    ).toEqual({ kind: null, gate: 'startOnNotReached' });
    // Past createdAt → started.
    expect(
      classifyItemForDispatch(
        { ...planItem, id: 'Y', createdAt: clock.isoAt(-60_000) },
        clock.now(),
      ),
    ).toBe('plan');
  });

  it('fails open when neither instant is readable (back-compat, never hidden)', () => {
    const planItem: DowntimeItemInfo = { id: 'Z', status: 'open', stage: 'intake_complete' };
    expect(classifyItemForDispatch(planItem, clock.now())).toBe('plan');
    expect(classifyItemForDispatch({ ...planItem, startOn: 'nonsense' }, clock.now())).toBe('plan');
  });

  it('advances with the injected clock past the scheduling boundary', () => {
    const item = at({ id: 'F', status: 'open', stage: 'intake_complete' }, 60_000);
    // Frozen at `now`: refused.
    expect(classifyItemForDispatch(item, clock.now())).toBeNull();
    // Same item, clock advanced by exactly one minute: the boundary is
    // inclusive, so it is now started.
    expect(classifyItemForDispatch(item, clock.now() + 60_000)).toBe('plan');
  });
});

describe('selectCriticalFirstCandidates — the list-head pipeline filters future items', () => {
  function critical(id: string, offsetMs: number): DowntimeHerdrItem {
    return {
      id,
      title: id,
      status: 'open',
      stage: 'plan_complete',
      priority: 'critical',
      risk: 'Low',
      effort: 'S',
      createdAt: clock.isoAt(-86_400_000),
      startOn: clock.isoAt(offsetMs),
    };
  }

  it('drops a future critical item from the candidate set', () => {
    expect(selectCriticalFirstCandidates([critical('C', 60_000)], clock.now())).toEqual([]);
  });

  it('keeps a started critical item in the candidate set', () => {
    const selected = selectCriticalFirstCandidates([critical('C', -60_000)], clock.now());
    expect(selected.map((c) => c.item.id)).toEqual(['C']);
    expect(selected[0].kind).toBe('implement');
  });

  it('selects the started item and never the future one from a mixed head', () => {
    const selected = selectCriticalFirstCandidates(
      [critical('FUTURE', 60_000), critical('STARTED', -60_000)],
      clock.now(),
    );
    expect(selected.map((c) => c.item.id)).toEqual(['STARTED']);
  });
});

describe('startOnNotReached gate — no mutation', () => {
  it('classifying a future item never changes it', () => {
    const item = at({ id: 'N', status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }, 60_000);
    const before = structuredClone(item);
    classifyItemForDispatchDetail(item, clock.now());
    expect(item).toEqual(before);
  });
});
