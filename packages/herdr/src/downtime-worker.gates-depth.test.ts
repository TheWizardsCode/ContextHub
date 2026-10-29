/**
 * packages/herdr/src/downtime-worker.gates-depth.test.ts — characterisation
 * tests for the review-queue depth gate and the audit-batch depth arithmetic
 * that previously lived inside `downtime-worker.ts` with no direct coverage.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Work item: WL-0MVLIHZZI004D7EK (dispatch-gates extraction; additive test —
 * no existing suite is modified).
 *
 * The functions under test moved verbatim into `downtime-worker.gates.ts`;
 * these tests pin the fail-closed defaults and the depth/cap/budget
 * arithmetic the dispatcher relies on (review-queue hold threshold,
 * audit-batch activation and remaining-budget semantics), so a future gate
 * change cannot silently drift.
 */

import { describe, it, expect } from 'vitest';
import {
  computeAuditEligibleDepth,
  finalizeAuditBatchOutcome,
  readReviewQueueGate,
  resolveAuditBatchStatus,
  type AuditBatchOutcomeShape,
  type DowntimeGateDeps,
  type DowntimeHerdrItem,
} from './downtime-worker.js';

function herdrItem(over: Partial<DowntimeHerdrItem> & { id: string }): DowntimeHerdrItem {
  return {
    title: 'T',
    status: 'completed',
    stage: 'in_review',
    priority: 'medium',
    ...over,
  };
}

// ── readReviewQueueGate ───────────────────────────────────────────────

/** Minimal gates-facing deps: only the review-queue read is exercised here. */
function gateDeps(getReviewQueueCount: () => Promise<number | null>): DowntimeGateDeps {
  return {
    getHerdrListHead: async () => ({ ok: true, items: [] }),
    getReviewQueueCount,
    markNeedsProducerReview: async () => true,
  };
}

describe('readReviewQueueGate — bounded review-queue depth read', () => {
  it('resolves deep when the root-only count is at/over the threshold', async () => {
    const deps = gateDeps(async () => 3);
    expect(await readReviewQueueGate(deps, '/repo', 3)).toEqual({
      deep: true,
      count: 3,
      threshold: 3,
    });
  });

  it('resolves not deep below the threshold', async () => {
    const deps = gateDeps(async () => 2);
    expect(await readReviewQueueGate(deps, '/repo', 3)).toEqual({
      deep: false,
      count: 2,
      threshold: 3,
    });
  });

  it('fails closed (deep, count null) on a query failure — gate active', async () => {
    const deps = gateDeps(async () => {
      throw new Error('wl list failed');
    });
    expect(await readReviewQueueGate(deps, '/repo', 3)).toEqual({
      deep: true,
      count: null,
      threshold: 3,
    });
  });

  it('fails closed (deep, count null) on a null count — same convention as code-freeze', async () => {
    const deps = gateDeps(async () => null);
    expect(await readReviewQueueGate(deps, '/repo', 3)).toEqual({
      deep: true,
      count: null,
      threshold: 3,
    });
  });
});

// ── computeAuditEligibleDepth ─────────────────────────────────────────

describe('computeAuditEligibleDepth — depth from an already-fetched Herdr head', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const withinWindow = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
  const beyondWindow = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago

  it('counts only audit-eligible completed/in_review items (no fresh audit, within recency)', () => {
    const items = [
      herdrItem({ id: 'A1', auditedAt: null, updatedAt: withinWindow }),
      herdrItem({ id: 'A2' }), // auditedAt absent → audit-eligible
      herdrItem({ id: 'A3', status: 'open', stage: 'plan_complete', priority: 'critical' }),
    ];
    expect(computeAuditEligibleDepth(items, now)).toBe(2);
  });

  it('excludes fresh-audited, soft-deleted, assignee-held and producer-review items', () => {
    const items = [
      herdrItem({ id: 'F', auditedAt: withinWindow, updatedAt: withinWindow }), // fresh audit
      herdrItem({ id: 'D', deletedBy: 'someone' }), // soft-deleted
      herdrItem({ id: 'H', assignee: 'producer' }), // assignee hold
      herdrItem({ id: 'P', needsProducerReview: true }), // producer-review hold
      herdrItem({ id: 'OK', updatedAt: withinWindow }), // eligible
    ];
    expect(computeAuditEligibleDepth(items, now)).toBe(1);
  });

  it('excludes items beyond the audit recency window', () => {
    expect(computeAuditEligibleDepth([herdrItem({ id: 'OLD', updatedAt: beyondWindow })], now)).toBe(0);
  });
});

// ── resolveAuditBatchStatus / finalizeAuditBatchOutcome ───────────────

describe('resolveAuditBatchStatus — depth-aware batch arithmetic', () => {
  it('is active only while cap > 1, depth >= threshold and budget remains', () => {
    // cap 1 = legacy/off → inactive, remaining 0.
    expect(resolveAuditBatchStatus(1, 5, 3, 4)).toEqual({ active: false, depth: 5, cap: 1, remaining: 0 });
    // depth below threshold → inactive.
    expect(resolveAuditBatchStatus(4, 2, 3, 4)).toEqual({ active: false, depth: 2, cap: 4, remaining: 0 });
    // budget exhausted before this dispatch → inactive.
    expect(resolveAuditBatchStatus(4, 5, 3, 0)).toEqual({ active: false, depth: 5, cap: 4, remaining: 0 });
    // engaged → consumes one continuation slot, floored at 0.
    expect(resolveAuditBatchStatus(4, 5, 3, 4)).toEqual({ active: true, depth: 5, cap: 4, remaining: 3 });
    expect(resolveAuditBatchStatus(4, 5, 3, 1)).toEqual({ active: true, depth: 5, cap: 4, remaining: 0 });
  });
});

describe('finalizeAuditBatchOutcome — attaches the batch surface once', () => {
  const ctx = { depth: 5, cap: 4, threshold: 3, remainingBefore: 2 };

  it('attaches a resolved status to a dispatched audit outcome', () => {
    const out = finalizeAuditBatchOutcome({ dispatched: true, kind: 'audit' }, ctx);
    expect(out).toEqual({
      dispatched: true,
      kind: 'audit',
      auditBatch: { active: true, depth: 5, cap: 4, remaining: 1 },
    });
  });

  it('never attaches a batch to a dispatched non-audit outcome', () => {
    const out = finalizeAuditBatchOutcome({ dispatched: true, kind: 'implement' }, ctx);
    expect(out).toEqual({ dispatched: true, kind: 'implement' });
  });

  it('keeps hard-failure outcomes unchanged (no auditBatch surface)', () => {
    const out = finalizeAuditBatchOutcome(
      { dispatched: false, reason: 'spawn-failed', error: 'ENOENT' },
      ctx,
    );
    expect(out).toEqual({ dispatched: false, reason: 'spawn-failed', error: 'ENOENT' });
  });

  it('reports an explicit inactive batch for other non-dispatched refusals', () => {
    const out = finalizeAuditBatchOutcome({ dispatched: false, reason: 'review-queue-hold' }, ctx);
    expect(out).toEqual({
      dispatched: false,
      reason: 'review-queue-hold',
      auditBatch: { active: false, depth: 5, cap: 4, remaining: 0 },
    });
  });

  it('never overwrites an already-attached batch surface', () => {
    const prior: AuditBatchOutcomeShape = {
      dispatched: false,
      reason: 'no-candidate',
      auditBatch: { active: false, depth: 1, cap: 2, remaining: 0 },
    };
    expect(finalizeAuditBatchOutcome(prior, ctx)).toBe(prior);
  });
});
