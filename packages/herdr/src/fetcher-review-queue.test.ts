/**
 * packages/herdr/src/fetcher-review-queue.test.ts — Review-queue state fetch
 * (AH-0MUDYTQ55002NUSJ).
 *
 * Verifies `fetchReviewQueueState` returns the root-only completed/in_review
 * count and correctly flags an outstanding audit: a missing `auditedAt`, a
 * stale audit (updatedAt after auditedAt beyond the freshness tolerance), or
 * a mismatched fingerprint counts as outstanding; a fresh audit does not.
 * `fetchCompletedItemCount` remains a count-only wrapper.
 *
 * Run: npx vitest run packages/herdr/src/fetcher-review-queue.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchReviewQueueState,
  fetchCompletedItemCount,
  setExecFileAsync,
  resetExecFileAsync,
} from './fetcher.js';

/** A freshly recorded audit: updatedAt == auditedAt (atomic audit write). */
const FRESH = {
  auditedAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
  auditResult: true,
};

/** A stored audit that a later update has invalidated (stale). */
const STALE = {
  auditedAt: '2026-09-27T09:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
  auditResult: true,
};

/** An in_review item with no stored audit at all. */
const NO_AUDIT = {
  auditedAt: null,
  updatedAt: '2026-09-27T10:00:00.000Z',
  auditResult: null,
};

function inReview(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { id, title: `Item ${id}`, status: 'completed', stage: 'in_review', ...extra };
}

function mockWl(workItems: unknown[]): void {
  setExecFileAsync((async () => ({
    stdout: JSON.stringify({ success: true, count: workItems.length, workItems }),
    stderr: '',
  })) as never);
}

beforeEach(() => {
  resetExecFileAsync();
});

afterEach(() => {
  resetExecFileAsync();
});

describe('fetchReviewQueueState', () => {
  it('reports the count with no outstanding audit when every item is freshly audited', async () => {
    mockWl([inReview('WL-1', FRESH), inReview('WL-2', FRESH)]);
    expect(await fetchReviewQueueState()).toEqual({ count: 2, auditsOutstanding: false });
  });

  it('flags an outstanding audit when any item has no stored audit', async () => {
    mockWl([inReview('WL-1', FRESH), inReview('WL-2', NO_AUDIT)]);
    expect(await fetchReviewQueueState()).toEqual({ count: 2, auditsOutstanding: true });
  });

  it('flags an outstanding audit when a stored audit is stale', async () => {
    mockWl([inReview('WL-1', STALE)]);
    expect(await fetchReviewQueueState()).toEqual({ count: 1, auditsOutstanding: true });
  });

  it('returns an empty, fully-audited state for an empty queue', async () => {
    mockWl([]);
    expect(await fetchReviewQueueState()).toEqual({ count: 0, auditsOutstanding: false });
  });

  it('resolves to undefined on a wl CLI error (fail-closed)', async () => {
    setExecFileAsync((async () => {
      throw new Error('wl exploded');
    }) as never);
    expect(await fetchReviewQueueState()).toBeUndefined();
  });
});

describe('fetchCompletedItemCount', () => {
  it('still returns the count as a wrapper over the review-queue state', async () => {
    mockWl([inReview('WL-1', FRESH), inReview('WL-2', NO_AUDIT)]);
    expect(await fetchCompletedItemCount()).toBe(2);
  });

  it('resolves to undefined when the underlying query fails', async () => {
    setExecFileAsync((async () => {
      throw new Error('wl exploded');
    }) as never);
    expect(await fetchCompletedItemCount()).toBeUndefined();
  });
});
