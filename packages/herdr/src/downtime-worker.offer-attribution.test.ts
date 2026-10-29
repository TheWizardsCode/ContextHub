/**
 * packages/herdr/src/downtime-worker.offer-attribution.test.ts — pins the
 * stable empty-offer / gate vocabulary (WL-0MVR8FKMU009XTED AC5).
 *
 * Every test asserts the OBSERVABLE aggregation the coordination log and the
 * worklist surface consume: which tokens exist, what an all-held window names,
 * and how a dominated gate is reported. The tokens themselves are the contract
 * (operators and tests read them), so they are asserted verbatim.
 */

import { describe, expect, it } from 'vitest';
import {
  dominantGateOf,
  isWindowFullyHeld,
  summariseEmptyOffer,
  withOfferRejections,
  type OfferRejection,
} from './downtime-worker.offer-attribution.js';
// The shared window-hold classifier lives next to its only primitive
// (`isAssigneeHeld`) in the selection module (split-family import-cycle
// gate); it is the helper the Herdr worklist consumes (WL-0MVR8FN1D002SCIR).
import { classifyWindowHold, heldAssigneesOf } from './downtime-worker.selection.js';

describe('summariseEmptyOffer (WL-0MVR8FKMU009XTED AC1/AC5)', () => {
  it('reports empty-window when the head lookup returned nothing', () => {
    expect(summariseEmptyOffer({ windowSize: 0, rejections: [] })).toEqual({
      reason: 'empty-window',
      windowSize: 0,
    });
  });

  it('reports all-window-items-held with every observed sentinel', () => {
    const rejections: OfferRejection[] = [
      { itemId: 'WL-1', gate: 'assignee-hold', assignee: 'Map' },
      { itemId: 'WL-2', gate: 'assignee-hold', assignee: 'Map' },
      { itemId: 'WL-3', gate: 'assignee-hold', assignee: 'producer' },
    ];
    const summary = summariseEmptyOffer({ windowSize: 3, rejections });
    expect(summary).toEqual({
      reason: 'all-window-items-held',
      windowSize: 3,
      heldAssignees: ['Map', 'producer'],
      dominantGate: 'assignee-hold',
      gateCounts: { 'assignee-hold': 3 },
    });
  });

  it('does NOT report all-held when one item was rejected by another gate', () => {
    const rejections: OfferRejection[] = [
      { itemId: 'WL-1', gate: 'assignee-hold', assignee: 'Map' },
      { itemId: 'WL-2', gate: 'producer-review' },
      { itemId: 'WL-3', gate: 'assignee-hold', assignee: 'Map' },
    ];
    const summary = summariseEmptyOffer({ windowSize: 3, rejections });
    expect(summary.reason).toBe('all-window-items-gated');
    expect(summary.heldAssignees).toBeUndefined();
    expect(summary.dominantGate).toBe('assignee-hold');
    expect(summary.gateCounts).toEqual({ 'assignee-hold': 2, 'producer-review': 1 });
  });

  it('reports all-window-items-gated with the gate that rejected the most items', () => {
    const rejections: OfferRejection[] = [
      { itemId: 'WL-1', gate: 'producer-review' },
      { itemId: 'WL-2', gate: 'effort-cap' },
      { itemId: 'WL-3', gate: 'effort-cap' },
    ];
    expect(summariseEmptyOffer({ windowSize: 3, rejections })).toMatchObject({
      reason: 'all-window-items-gated',
      dominantGate: 'effort-cap',
    });
  });

  it('breaks a dominant-gate tie deterministically (first gate seen wins)', () => {
    const rejections: OfferRejection[] = [
      { itemId: 'WL-1', gate: 'not-dispatchable' },
      { itemId: 'WL-2', gate: 'audit-recency' },
    ];
    expect(dominantGateOf(rejections)).toBe('not-dispatchable');
  });

  it('promotes a sole dedicated gate to its own reason token', () => {
    expect(
      summariseEmptyOffer({
        windowSize: 2,
        rejections: [
          { itemId: 'WL-1', gate: 'code-freeze' },
          { itemId: 'WL-2', gate: 'code-freeze' },
        ],
      }).reason,
    ).toBe('code-freeze');
    expect(
      summariseEmptyOffer({
        windowSize: 1,
        rejections: [{ itemId: 'WL-1', gate: 'in-flight-pane' }],
      }).reason,
    ).toBe('in-flight-hold');
    expect(
      summariseEmptyOffer({
        windowSize: 1,
        rejections: [{ itemId: 'WL-1', gate: 'non-terminal-cooldown' }],
      }).reason,
    ).toBe('non-terminal-cooldown');
  });

  it('keeps a sole non-dedicated gate under all-window-items-gated', () => {
    // A dispatched marker is not a "hold" with its own whole-window token.
    expect(
      summariseEmptyOffer({
        windowSize: 1,
        rejections: [{ itemId: 'WL-1', gate: 'dispatched-marker' }],
      }),
    ).toMatchObject({ reason: 'all-window-items-gated', dominantGate: 'dispatched-marker' });
  });
});

describe('classifyWindowHold — the shared all-held classifier (child 3 reuses it)', () => {
  it('reports a fully held window and the sentinels it observed', () => {
    expect(
      classifyWindowHold([
        { assignee: 'Map' },
        { assignee: ' Map ' },
        { assignee: 'producer' },
      ]),
    ).toEqual({ allHeld: true, heldAssignees: ['Map', 'producer'], count: 3 });
  });

  it('does not call an empty window fully held (that is empty-window)', () => {
    expect(classifyWindowHold([])).toEqual({ allHeld: false, heldAssignees: [], count: 0 });
  });

  it('does not call a partly held window fully held', () => {
    expect(classifyWindowHold([{ assignee: 'Map' }, { assignee: '' }])).toMatchObject({
      allHeld: false,
      heldAssignees: ['Map'],
    });
  });

  it('exposes the same predicate the aggregation uses', () => {
    expect(isWindowFullyHeld([{ gate: 'assignee-hold' }])).toBe(true);
    expect(isWindowFullyHeld([])).toBe(false);
    expect(isWindowFullyHeld([{ gate: 'assignee-hold' }, { gate: 'code-freeze' }])).toBe(false);
  });

  it('deduplicates and sorts the sentinels of the given items', () => {
    expect(heldAssigneesOf([{ assignee: 'b' }, { assignee: 'a' }, { assignee: 'b' }])).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('withOfferRejections (additive-only outcome enrichment)', () => {
  it('returns the outcome untouched when nothing was rejected', () => {
    const outcome = { dispatched: false, reason: 'no-candidate' };
    expect(withOfferRejections(outcome, [])).toBe(outcome);
  });

  it('attaches the rejections without changing the existing fields', () => {
    const outcome = { dispatched: false, reason: 'no-candidate' };
    expect(
      withOfferRejections(outcome, [
        { workItemId: 'WL-1', worklogRoot: '/root', gate: 'assignee-hold' },
      ]),
    ).toEqual({
      dispatched: false,
      reason: 'no-candidate',
      offerRejections: [{ workItemId: 'WL-1', worklogRoot: '/root', gate: 'assignee-hold' }],
    });
  });
});
