/**
 * Unit tests for the TTL-bounded monotonic claim-hold guard
 * (SA-0MVE34D9B005TUYJ → SA-0MVKWV2V2006JC8E).
 *
 * These pin the pure decision rules; the end-to-end behaviour (a parked sync,
 * a stale second store) is covered by `tests/cli/sync-claim-revert.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLAIM_HOLD_TTL_HOURS,
  applyClaimHold,
  isHeldClaim,
  resolveClaimHoldTtlHours,
  type ClaimHoldPolicy,
} from '../../src/claim-hold.js';
import type { WorkItem } from '../../src/types.js';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const policy: ClaimHoldPolicy = { ttlHours: 24, nowMs: NOW };

/** Minimal work item with the fields the guard reads. */
function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'CRV-1',
    title: 'Claim target',
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-23T11:00:00.000Z',
    activityAt: '2026-10-23T11:00:00.000Z',
    tags: [],
    assignee: '',
    stage: 'intake_complete',
    ...overrides,
  } as WorkItem;
}

describe('isHeldClaim', () => {
  it('treats an in-progress item within the TTL as a held claim', () => {
    expect(isHeldClaim(item({ status: 'in-progress' }), policy)).toBe(true);
    expect(isHeldClaim(item({ status: 'in_progress' }), policy)).toBe(true);
  });

  it('treats a non-empty assignee on a live item as a held claim (audit-tier hold)', () => {
    expect(isHeldClaim(item({ status: 'open', assignee: 'Map' }), policy)).toBe(true);
    expect(isHeldClaim(item({ status: 'open', assignee: '  ' }), policy)).toBe(false);
  });

  it('never treats terminal or stage-only states as claims', () => {
    expect(isHeldClaim(item({ status: 'completed', stage: 'in_review', assignee: 'Map' }), policy)).toBe(false);
    expect(isHeldClaim(item({ status: 'deleted', assignee: 'Map' }), policy)).toBe(false);
    expect(isHeldClaim(item({ status: 'open', stage: 'in_progress' }), policy)).toBe(false);
  });

  it('releases a claim older than the TTL', () => {
    const stale = item({
      status: 'in-progress',
      activityAt: '2026-10-21T11:00:00.000Z', // 25 h before NOW
      updatedAt: '2026-10-21T11:00:00.000Z',
    });
    expect(isHeldClaim(stale, policy)).toBe(false);
    expect(isHeldClaim(stale, { ...policy, ttlHours: 72 })).toBe(true);
  });

  it('is disabled when the TTL is 0', () => {
    expect(isHeldClaim(item({ status: 'in-progress' }), { ...policy, ttlHours: 0 })).toBe(false);
  });

  it('prefers activityAt over updatedAt when measuring claim age', () => {
    const recentlyTouched = item({
      status: 'in-progress',
      updatedAt: '2026-10-21T11:00:00.000Z', // 25 h old
      activityAt: '2026-10-23T11:58:00.000Z', // 2 min old (a comment)
    });
    expect(isHeldClaim(recentlyTouched, policy)).toBe(true);
  });
});

describe('applyClaimHold', () => {
  it('refuses a status downgrade and preserves the claim timestamps', () => {
    const current = item({ status: 'in-progress', stage: 'plan_complete' });
    const incoming = item({ status: 'open', stage: 'plan_complete', updatedAt: '2026-10-23T11:59:00.000Z' });

    const result = applyClaimHold([current], [incoming], policy);

    expect(result.items[0].status).toBe('in-progress');
    expect(result.items[0].stage).toBe('plan_complete');
    expect(result.items[0].updatedAt).toBe(current.updatedAt);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].fields).toEqual(['status']);
    expect(result.decisions[0].workItemId).toBe('CRV-1');
    expect(result.decisions[0].ttlHours).toBe(24);
  });

  it('refuses a stage downgrade even when the incoming row is newer', () => {
    const current = item({ status: 'in-progress', stage: 'plan_complete' });
    const incoming = item({
      status: 'in-progress',
      stage: 'intake_complete',
      updatedAt: '2026-10-23T11:59:00.000Z',
    });

    const result = applyClaimHold([current], [incoming], policy);

    expect(result.items[0].stage).toBe('plan_complete');
    expect(result.decisions[0].fields).toEqual(['stage']);
  });

  it('pins the claimed pair together when both fields would regress', () => {
    const current = item({ status: 'in-progress', stage: 'plan_complete' });
    const incoming = item({ status: 'open', stage: 'intake_complete' });

    const result = applyClaimHold([current], [incoming], policy);

    expect(result.items[0].status).toBe('in-progress');
    expect(result.items[0].stage).toBe('plan_complete');
    expect(result.decisions[0].fields).toEqual(['status', 'stage']);
  });

  it('still lets a newer, more active transition through (close / in_review)', () => {
    const current = item({ status: 'in-progress', stage: 'plan_complete' });
    const incoming = item({
      status: 'completed',
      stage: 'in_review',
      updatedAt: '2026-10-23T11:59:00.000Z',
    });

    const result = applyClaimHold([current], [incoming], policy);

    expect(result.items[0].status).toBe('completed');
    expect(result.items[0].stage).toBe('in_review');
    expect(result.decisions).toEqual([]);
  });

  it('does not freeze other fields while the claim is pinned', () => {
    const current = item({ status: 'in-progress', stage: 'plan_complete' });
    const incoming = item({
      status: 'open',
      stage: 'intake_complete',
      title: 'Renamed elsewhere',
      priority: 'high',
      updatedAt: '2026-10-23T11:59:00.000Z',
    });

    const result = applyClaimHold([current], [incoming], policy);

    expect(result.items[0].status).toBe('in-progress');
    expect(result.items[0].title).toBe('Renamed elsewhere');
    expect(result.items[0].priority).toBe('high');
  });

  it('never blocks an attributed delete', () => {
    const current = item({ status: 'in-progress', stage: 'plan_complete' });
    const incoming = item({
      status: 'deleted',
      stage: 'plan_complete',
      deletedBy: 'operator',
      deleteReason: 'superseded',
    });

    const result = applyClaimHold([current], [incoming], policy);

    expect(result.items[0].status).toBe('deleted');
    expect(result.decisions).toEqual([]);
  });

  it('releases an expired claim (TTL-bounded protection)', () => {
    const current = item({
      status: 'in-progress',
      stage: 'plan_complete',
      activityAt: '2026-10-21T11:00:00.000Z', // 25 h old
      updatedAt: '2026-10-21T11:00:00.000Z',
    });
    const incoming = item({
      status: 'open',
      stage: 'intake_complete',
      updatedAt: '2026-10-23T11:59:00.000Z',
    });

    const result = applyClaimHold([current], [incoming], policy);

    expect(result.items[0].status).toBe('open');
    expect(result.items[0].stage).toBe('intake_complete');
    expect(result.decisions).toEqual([]);
  });

  it('passes items with no held claim through unchanged', () => {
    const current = item({ status: 'completed', stage: 'in_review' });
    const incoming = item({ status: 'open', stage: 'plan_complete' });

    const result = applyClaimHold([current], [incoming], policy);

    expect(result.items[0]).toBe(incoming);
    expect(result.decisions).toEqual([]);
  });

  it('is a no-op when the policy disables protection', () => {
    const current = item({ status: 'in-progress', stage: 'plan_complete' });
    const incoming = item({ status: 'open', stage: 'intake_complete' });

    const result = applyClaimHold([current], [incoming], { ttlHours: 0 });

    expect(result.items[0].status).toBe('open');
    expect(result.decisions).toEqual([]);
  });
});

describe('resolveClaimHoldTtlHours', () => {
  it('defaults to 24 h when config is absent or unset', () => {
    expect(DEFAULT_CLAIM_HOLD_TTL_HOURS).toBe(24);
    expect(resolveClaimHoldTtlHours(null)).toBe(24);
    expect(resolveClaimHoldTtlHours({})).toBe(24);
    expect(resolveClaimHoldTtlHours({ syncClaimHoldTtlHours: undefined })).toBe(24);
  });

  it('accepts the nested sync.claimHoldTtlHours spelling', () => {
    expect(resolveClaimHoldTtlHours({ sync: { claimHoldTtlHours: 8 } })).toBe(8);
  });

  it('accepts the flat syncClaimHoldTtlHours spelling', () => {
    expect(resolveClaimHoldTtlHours({ syncClaimHoldTtlHours: 2.5 })).toBe(2.5);
  });

  it('treats 0 as "disabled"', () => {
    expect(resolveClaimHoldTtlHours({ syncClaimHoldTtlHours: 0 })).toBe(0);
  });

  it('falls back to the default for invalid values', () => {
    expect(resolveClaimHoldTtlHours({ syncClaimHoldTtlHours: 'soon' })).toBe(24);
    expect(resolveClaimHoldTtlHours({ syncClaimHoldTtlHours: -1 })).toBe(24);
  });
});
