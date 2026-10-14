/**
 * tests/unit/downtime-worker-soft-delete.test.ts — the downtime dispatcher
 * must never dispatch a soft-deleted work item.
 *
 * A soft delete (`wl delete`) sets `deletedBy` (and `deleteReason`) and may
 * leave the item's status untouched, so a `wl next`/`wl list` query can still
 * return it. Before this guard the candidate-selection stage filtered only on
 * `status`, so a soft-deleted item was re-selected and worked a second time
 * (SA-0MUJBLZC60085DI9). The guard treats a non-empty `deletedBy` as the
 * authoritative deletion marker at every selection path: the tier `select*`
 * functions, the Herdr-head `classifyItemForDispatch`, and the parse helpers
 * that carry the field to those filters.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyItemForDispatch,
  dispatchDowntimeWork,
  isSoftDeleted,
  parseAuditCandidatesOutput,
  parseCriticalCandidatesOutput,
  parseImplementCandidatesOutput,
  parseNextCandidatesOutput,
  selectAuditCandidate,
  selectCriticalCandidate,
  selectImplementCandidate,
  selectNextCandidate,
  type AuditCandidate,
  type CriticalCandidate,
  type DowntimeCandidate,
  type DowntimeHerdrItem,
  type ImplementCandidate,
} from '../../packages/herdr/src/downtime-worker.js';
import { makeDeps } from '../../packages/herdr/src/downtime-worker.fixtures.js';

const DELETED_BY = 'deleter@example.com';

describe('isSoftDeleted', () => {
  it('treats a non-empty deletedBy as deleted', () => {
    expect(isSoftDeleted({ deletedBy: DELETED_BY })).toBe(true);
  });

  it('treats empty/whitespace/absent deletedBy as live', () => {
    expect(isSoftDeleted({ deletedBy: '' })).toBe(false);
    expect(isSoftDeleted({ deletedBy: '   ' })).toBe(false);
    expect(isSoftDeleted({})).toBe(false);
    expect(isSoftDeleted(undefined)).toBe(false);
    expect(isSoftDeleted(null)).toBe(false);
  });
});

describe('soft-delete exclusion at candidate selection (SA-0MUJBLZC60085DI9 AC3)', () => {
  const audit = (overrides: Partial<AuditCandidate> = {}): AuditCandidate => ({
    id: 'AUD-1',
    title: 'Audit',
    updatedAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  });
  const implement = (overrides: Partial<ImplementCandidate> = {}): ImplementCandidate => ({
    id: 'IMP-1',
    title: 'Implement',
    status: 'open',
    risk: 'low',
    effort: 'small',
    sortIndex: 1,
    ...overrides,
  });
  const next = (overrides: Partial<DowntimeCandidate> = {}): DowntimeCandidate => ({
    id: 'NEXT-1',
    title: 'Next',
    stage: 'intake_complete',
    status: 'open',
    sortIndex: 1,
    ...overrides,
  });
  const critical = (overrides: Partial<CriticalCandidate> = {}): CriticalCandidate => ({
    id: 'CRIT-1',
    title: 'Critical',
    status: 'open',
    stage: 'idea',
    sortIndex: 1,
    ...overrides,
  });

  it('selectAuditCandidate skips a soft-deleted candidate', () => {
    const deleted = audit({ id: 'AUD-DEL', deletedBy: DELETED_BY, sortIndex: 1 });
    const live = audit({ id: 'AUD-LIVE', sortIndex: 10 });
    expect(selectAuditCandidate([deleted, live])?.id).toBe('AUD-LIVE');
    expect(selectAuditCandidate([deleted])).toBeNull();
  });

  it('selectImplementCandidate skips a soft-deleted candidate', () => {
    const deleted = implement({ id: 'IMP-DEL', deletedBy: DELETED_BY, sortIndex: 1 });
    const live = implement({ id: 'IMP-LIVE', sortIndex: 10 });
    expect(selectImplementCandidate([deleted, live])?.id).toBe('IMP-LIVE');
    expect(selectImplementCandidate([deleted])).toBeNull();
  });

  it('selectNextCandidate skips a soft-deleted candidate', () => {
    const deleted = next({ id: 'NEXT-DEL', deletedBy: DELETED_BY, sortIndex: 1 });
    const live = next({ id: 'NEXT-LIVE', sortIndex: 10 });
    expect(selectNextCandidate([deleted, live])?.id).toBe('NEXT-LIVE');
    expect(selectNextCandidate([deleted])).toBeNull();
  });

  it('selectCriticalCandidate skips a soft-deleted candidate', () => {
    const deleted = critical({ id: 'CRIT-DEL', deletedBy: DELETED_BY, sortIndex: 1 });
    const live = critical({ id: 'CRIT-LIVE', sortIndex: 10 });
    expect(selectCriticalCandidate([deleted, live])?.id).toBe('CRIT-LIVE');
    expect(selectCriticalCandidate([deleted])).toBeNull();
  });

  it('classifyItemForDispatch returns null for a soft-deleted item', () => {
    expect(
      classifyItemForDispatch({ id: 'X', status: 'open', stage: 'idea', deletedBy: DELETED_BY }),
    ).toBeNull();
    // The same item without the deletion marker is dispatchable.
    expect(classifyItemForDispatch({ id: 'X', status: 'open', stage: 'idea' })).toBe('intake');
  });
});

describe('soft-delete excluded from parsed output (SA-0MUJBLZC60085DI9 AC3)', () => {
  it('parseNextCandidatesOutput carries deletedBy and the selector skips it', () => {
    const stdout = JSON.stringify({
      workItems: [
        { workItem: { id: 'N1', title: 'deleted', status: 'open', stage: 'intake_complete', deletedBy: DELETED_BY } },
        { workItem: { id: 'N2', title: 'live', status: 'open', stage: 'intake_complete' } },
      ],
    });
    const candidates = parseNextCandidatesOutput(stdout, 'intake_complete')!;
    expect(candidates).not.toBeNull();
    expect(selectNextCandidate(candidates)?.id).toBe('N2');
  });

  it('parseImplementCandidatesOutput carries deletedBy and the selector skips it', () => {
    const stdout = JSON.stringify({
      workItems: [
        { workItem: { id: 'I1', title: 'deleted', status: 'open', risk: 'low', effort: 'small', deletedBy: DELETED_BY } },
        { workItem: { id: 'I2', title: 'live', status: 'open', risk: 'low', effort: 'small' } },
      ],
    });
    const candidates = parseImplementCandidatesOutput(stdout)!;
    expect(candidates).not.toBeNull();
    expect(selectImplementCandidate(candidates)?.id).toBe('I2');
  });

  it('parseCriticalCandidatesOutput carries deletedBy and the selector skips it', () => {
    const stdout = JSON.stringify({
      workItems: [
        { id: 'C1', title: 'deleted', status: 'open', stage: 'idea', deletedBy: DELETED_BY },
        { id: 'C2', title: 'live', status: 'open', stage: 'idea' },
      ],
    });
    const candidates = parseCriticalCandidatesOutput(stdout)!;
    expect(candidates).not.toBeNull();
    expect(selectCriticalCandidate(candidates as never)?.id).toBe('C2');
  });

  it('parseAuditCandidatesOutput carries deletedBy and the selector skips it', () => {
    const stdout = JSON.stringify({
      workItems: [
        { id: 'A1', title: 'deleted', deletedBy: DELETED_BY },
        { id: 'A2', title: 'live' },
      ],
    });
    const candidates = parseAuditCandidatesOutput(stdout)!;
    expect(candidates).not.toBeNull();
    expect(selectAuditCandidate(candidates)?.id).toBe('A2');
  });
});

describe('Herdr-head dispatch never dispatches a soft-deleted item (AC3)', () => {
  const deletedCritical: DowntimeHerdrItem = {
    id: 'CRIT-DELETED',
    title: 'Soft-deleted critical idea',
    status: 'open',
    stage: 'idea',
    priority: 'critical',
    sortIndex: 1,
    deletedBy: DELETED_BY,
  };
  const liveImplement: DowntimeHerdrItem = {
    id: 'IMP-LIVE',
    title: 'Live implement item',
    status: 'open',
    stage: 'plan_complete',
    priority: 'medium',
    risk: 'Low',
    effort: 'S',
    sortIndex: 100,
  };

  it('skips the soft-deleted head item and dispatches the next live item', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [deletedCritical, liveImplement] }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('IMP-LIVE');
    expect(outcome.candidate?.id).not.toBe('CRIT-DELETED');
    expect(deps.claimItem).not.toHaveBeenCalledWith(
      'CRIT-DELETED', expect.anything(), expect.anything(),
    );
  });

  it('does not dispatch when the head contains only a soft-deleted item', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [deletedCritical] }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(deps.claimItem).not.toHaveBeenCalled();
  });
});
