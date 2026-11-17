/**
 * packages/herdr/src/downtime-worker.offer-selection.test.ts — the leader's
 * drain-aware tie-break over ONE entry's admissible offers.
 *
 * Parent: WL-0MWDDHQON0015T3P AC5/AC8. Work item: WL-0MWDVN2HN004CQ1O.
 *
 * The integrated leader behaviour (filter chain → tie-break → partial removal)
 * is pinned in `coordination-dispatch.test.ts`; this suite pins the SELECTION
 * contract itself, which the dispatch pairs cannot show: the total order over
 * all three buckets, the stability that preserves the owner's file order inside
 * a bucket, and the byte-identical single-offer path (no copy, no extra gate
 * read — the pre-v2 behaviour).
 */

import { describe, it, expect } from 'vitest';
import type { CoordinationEntry } from './coordination.js';
import type { ReviewQueueGateResult } from './downtime-worker.gates.js';
import {
  drainAwareRank,
  entryOffers,
  orderAdmissibleOffers,
} from './downtime-worker.offer-selection.js';
import type { DowntimeSkillKind } from './downtime-worker.types.js';

/** A v2 entry (offers payload, no reliance on the mirrored `workItemId`). */
function v2Entry(offers: Array<{ kind: 'implement' | 'audit' | 'prep'; workItemId: string }>): CoordinationEntry {
  return {
    instanceId: 'inst-1',
    workItemId: offers[0]!.workItemId,
    directory: '/roots/a',
    worklogRoot: '/roots/a',
    assignedAt: '2026-11-12T00:00:00.000Z',
    lastUpdated: '2026-11-12T00:00:00.000Z',
    offers,
  };
}

/** An admissible offer as the leader hands it over (classifier kind + payload). */
function admissible(kind: DowntimeSkillKind, id: string): { kind: DowntimeSkillKind; workItemId: string } {
  return { kind, workItemId: id };
}

function gate(deep: boolean): ReviewQueueGateResult {
  return { deep, count: deep ? 5 : 0, threshold: 5 };
}

describe('entryOffers — what ONE entry advertises (parent AC1/AC9)', () => {
  it('returns a v2 offers payload in file order, unchanged', () => {
    const entry = v2Entry([
      { kind: 'implement', workItemId: 'WL-IMP' },
      { kind: 'prep', workItemId: 'WL-PREP' },
    ]);
    expect(entryOffers(entry)).toEqual([
      { kind: 'implement', workItemId: 'WL-IMP' },
      { kind: 'prep', workItemId: 'WL-PREP' },
    ]);
  });

  it('synthesises the single offer of a legacy v1 entry from its workItemId', () => {
    const entry: CoordinationEntry = {
      instanceId: 'inst-legacy',
      workItemId: 'WL-LEGACY',
      directory: '/roots/legacy',
      worklogRoot: '/roots/legacy',
      assignedAt: '2026-11-12T00:00:00.000Z',
      lastUpdated: '2026-11-12T00:00:00.000Z',
    };
    expect(entryOffers(entry)).toEqual([{ kind: 'implement', workItemId: 'WL-LEGACY' }]);
  });

  it('advertises nothing when the entry has neither payload', () => {
    const entry = {
      instanceId: 'inst-empty',
      workItemId: '',
      directory: '/roots/a',
      worklogRoot: '/roots/a',
      assignedAt: '2026-11-12T00:00:00.000Z',
      lastUpdated: '2026-11-12T00:00:00.000Z',
    } as CoordinationEntry;
    expect(entryOffers(entry)).toEqual([]);
  });
});

describe('drainAwareRank — the recorded tie-break (parent AC5)', () => {
  it('puts audit first while the root review queue is at/over browseItemCount, else prep first', () => {
    // Drain armed: audit → prep → implement.
    expect(drainAwareRank('audit', true)).toBeLessThan(drainAwareRank('plan', true));
    expect(drainAwareRank('plan', true)).toBeLessThan(drainAwareRank('implement', true));
    // Drain at rest: prep → implement → audit. Never a fixed implement-first
    // ladder (precedent WL-0MW9X7EJ6009EL6E), and never a fixed audit-first one.
    expect(drainAwareRank('intake', false)).toBeLessThan(drainAwareRank('implement', false));
    expect(drainAwareRank('implement', false)).toBeLessThan(drainAwareRank('audit', false));
  });

  it('buckets every prep kind together and ranks an unknown kind last', () => {
    for (const kind of ['plan', 'intake', 'risk-effort'] as const) {
      expect(drainAwareRank(kind, false)).toBe(drainAwareRank('plan', false));
    }
    // An unknown kind (defensive: the classifier never yields one for an
    // admissible offer) falls to the last rung rather than ahead of work.
    expect(drainAwareRank(null, false)).toBeGreaterThan(drainAwareRank('implement', false));
  });
});

describe('orderAdmissibleOffers — stable, per-entry ordering (parent AC5/AC8)', () => {
  it('orders the full bucket set audit → prep → implement while the drain is armed', () => {
    const offers = [
      admissible('implement', 'WL-IMP'),
      admissible('plan', 'WL-PREP'),
      admissible('audit', 'WL-AUD'),
    ];
    expect(orderAdmissibleOffers(offers, gate(true)).map((o) => o.workItemId)).toEqual([
      'WL-AUD',
      'WL-PREP',
      'WL-IMP',
    ]);
  });

  it('orders prep → implement → audit while the queue is shallow', () => {
    const offers = [
      admissible('audit', 'WL-AUD'),
      admissible('implement', 'WL-IMP'),
      admissible('intake', 'WL-PREP'),
    ];
    expect(orderAdmissibleOffers(offers, gate(false)).map((o) => o.workItemId)).toEqual([
      'WL-PREP',
      'WL-IMP',
      'WL-AUD',
    ]);
  });

  it('treats an unreadable queue as not armed rather than inventing a drain', () => {
    const offers = [admissible('implement', 'WL-IMP'), admissible('plan', 'WL-PREP')];
    expect(orderAdmissibleOffers(offers, null).map((o) => o.workItemId)).toEqual([
      'WL-PREP',
      'WL-IMP',
    ]);
  });

  it('is stable: the owner’s file order survives inside one bucket', () => {
    // Two prep offers can never come from one v2 entry (one nominee per
    // bucket), but stability is the contract the sort rests on — a legacy
    // entry and a defensive over-bounds payload must still be deterministic.
    const offers = [
      admissible('plan', 'WL-PREP-1'),
      admissible('intake', 'WL-PREP-2'),
      admissible('implement', 'WL-IMP'),
    ];
    const first = orderAdmissibleOffers(offers, gate(false)).map((o) => o.workItemId);
    expect(first).toEqual(['WL-PREP-1', 'WL-PREP-2', 'WL-IMP']);
    expect(orderAdmissibleOffers(offers, gate(false)).map((o) => o.workItemId)).toEqual(first);
  });

  it('returns a single admissible offer untouched (the pre-v2 path, no extra read)', () => {
    const offers = [admissible('implement', 'WL-IMP')];
    const ordered = orderAdmissibleOffers(offers, null);
    // Same array instance: the single-offer dispatch path allocates and reads
    // nothing extra, so its behaviour stays byte-identical to pre-v2.
    expect(ordered).toBe(offers);
  });
});
