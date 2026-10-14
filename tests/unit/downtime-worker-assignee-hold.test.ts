/**
 * tests/unit/downtime-worker-assignee-hold.test.ts — the downtime dispatcher
 * must never dispatch an item held by a non-empty assignee.
 *
 * An assignee (human or agent) means the item is already being worked, so it
 * must not be auto-dispatched at any tier (WL-0MV85WCJJ0087VMP). The
 * audit-tier claim additionally CASes on the empty assignee
 * (`--if-assignee ""`), so a held item would fail stale there; this guard
 * excludes it up front at every selection path: the tier `select*` functions,
 * the Herdr-head `classifyItemForDispatch`, and the parse helpers that carry
 * the field to those filters. Assigning an item to the producer therefore
 * makes it non-dispatchable everywhere.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyItemForDispatch,
  dispatchDowntimeWork,
  isAssigneeHeld,
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

const HELD_BY = 'producer';

describe('isAssigneeHeld', () => {
  it('treats a non-empty assignee as held', () => {
    expect(isAssigneeHeld({ assignee: HELD_BY })).toBe(true);
  });

  it('treats empty/whitespace/absent assignee as free', () => {
    expect(isAssigneeHeld({ assignee: '' })).toBe(false);
    expect(isAssigneeHeld({ assignee: '   ' })).toBe(false);
    expect(isAssigneeHeld({})).toBe(false);
    expect(isAssigneeHeld(undefined)).toBe(false);
    expect(isAssigneeHeld(null)).toBe(false);
  });
});

describe('assignee-hold exclusion at candidate selection (WL-0MV85WCJJ0087VMP)', () => {
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

  it('selectAuditCandidate skips an assignee-held candidate', () => {
    const held = audit({ id: 'AUD-HELD', assignee: HELD_BY, sortIndex: 1 });
    const free = audit({ id: 'AUD-FREE', sortIndex: 10 });
    expect(selectAuditCandidate([held, free])?.id).toBe('AUD-FREE');
    expect(selectAuditCandidate([held])).toBeNull();
  });

  it('selectImplementCandidate skips an assignee-held candidate', () => {
    const held = implement({ id: 'IMP-HELD', assignee: HELD_BY, sortIndex: 1 });
    const free = implement({ id: 'IMP-FREE', sortIndex: 10 });
    expect(selectImplementCandidate([held, free])?.id).toBe('IMP-FREE');
    expect(selectImplementCandidate([held])).toBeNull();
  });

  it('selectNextCandidate skips an assignee-held candidate', () => {
    const held = next({ id: 'NEXT-HELD', assignee: HELD_BY, sortIndex: 1 });
    const free = next({ id: 'NEXT-FREE', sortIndex: 10 });
    expect(selectNextCandidate([held, free])?.id).toBe('NEXT-FREE');
    expect(selectNextCandidate([held])).toBeNull();
  });

  it('selectCriticalCandidate skips an assignee-held candidate', () => {
    const held = critical({ id: 'CRIT-HELD', assignee: HELD_BY, sortIndex: 1 });
    const free = critical({ id: 'CRIT-FREE', sortIndex: 10 });
    expect(selectCriticalCandidate([held, free])?.id).toBe('CRIT-FREE');
    expect(selectCriticalCandidate([held])).toBeNull();
  });

  it('classifyItemForDispatch returns null for an assignee-held item', () => {
    expect(
      classifyItemForDispatch({ id: 'X', status: 'open', stage: 'idea', assignee: HELD_BY }),
    ).toBeNull();
    // The same item without the assignee hold is dispatchable.
    expect(classifyItemForDispatch({ id: 'X', status: 'open', stage: 'idea' })).toBe('intake');
  });

  it('classifyItemForDispatch returns null for an assignee-held audit item', () => {
    const held: Parameters<typeof classifyItemForDispatch>[0] = {
      id: 'AUD-X',
      status: 'completed',
      stage: 'in_review',
      updatedAt: new Date().toISOString(),
      assignee: HELD_BY,
    };
    expect(classifyItemForDispatch(held)).toBeNull();
    // Unassigned, the same item classifies as an audit candidate.
    expect(classifyItemForDispatch({ ...held, assignee: '' })).toBe('audit');
  });
});

describe('assignee hold carried by parsed output (WL-0MV85WCJJ0087VMP)', () => {
  it('parseNextCandidatesOutput carries assignee and the selector skips it', () => {
    const stdout = JSON.stringify({
      workItems: [
        { workItem: { id: 'N1', title: 'held', status: 'open', stage: 'intake_complete', assignee: HELD_BY } },
        { workItem: { id: 'N2', title: 'free', status: 'open', stage: 'intake_complete' } },
      ],
    });
    const candidates = parseNextCandidatesOutput(stdout, 'intake_complete')!;
    expect(candidates).not.toBeNull();
    expect(candidates[0].assignee).toBe(HELD_BY);
    expect(selectNextCandidate(candidates)?.id).toBe('N2');
  });

  it('parseImplementCandidatesOutput carries assignee and the selector skips it', () => {
    const stdout = JSON.stringify({
      workItems: [
        { workItem: { id: 'I1', title: 'held', status: 'open', risk: 'low', effort: 'small', assignee: HELD_BY } },
        { workItem: { id: 'I2', title: 'free', status: 'open', risk: 'low', effort: 'small' } },
      ],
    });
    const candidates = parseImplementCandidatesOutput(stdout)!;
    expect(candidates).not.toBeNull();
    expect(candidates[0].assignee).toBe(HELD_BY);
    expect(selectImplementCandidate(candidates)?.id).toBe('I2');
  });

  it('parseCriticalCandidatesOutput carries assignee and the selector skips it', () => {
    const stdout = JSON.stringify({
      workItems: [
        { id: 'C1', title: 'held', status: 'open', stage: 'idea', assignee: HELD_BY },
        { id: 'C2', title: 'free', status: 'open', stage: 'idea' },
      ],
    });
    const candidates = parseCriticalCandidatesOutput(stdout)!;
    expect(candidates).not.toBeNull();
    expect(candidates[0].assignee).toBe(HELD_BY);
    expect(selectCriticalCandidate(candidates as never)?.id).toBe('C2');
  });

  it('parseAuditCandidatesOutput carries assignee and the selector skips it', () => {
    const stdout = JSON.stringify({
      workItems: [
        { id: 'A1', title: 'held', assignee: HELD_BY },
        { id: 'A2', title: 'free' },
      ],
    });
    const candidates = parseAuditCandidatesOutput(stdout)!;
    expect(candidates).not.toBeNull();
    expect(candidates[0].assignee).toBe(HELD_BY);
    expect(selectAuditCandidate(candidates)?.id).toBe('A2');
  });
});

describe('Herdr-head dispatch never dispatches an assignee-held item (WL-0MV85WCJJ0087VMP)', () => {
  const heldCritical: DowntimeHerdrItem = {
    id: 'CRIT-HELD',
    title: 'Assignee-held critical idea',
    status: 'open',
    stage: 'idea',
    priority: 'critical',
    sortIndex: 1,
    assignee: HELD_BY,
  };
  const freeImplement: DowntimeHerdrItem = {
    id: 'IMP-FREE',
    title: 'Free implement item',
    status: 'open',
    stage: 'plan_complete',
    priority: 'medium',
    risk: 'Low',
    effort: 'S',
    sortIndex: 100,
  };

  it('skips the assignee-held head item and dispatches the next free item', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [heldCritical, freeImplement] }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('IMP-FREE');
    expect(outcome.candidate?.id).not.toBe('CRIT-HELD');
    expect(deps.claimItem).not.toHaveBeenCalledWith(
      'CRIT-HELD', expect.anything(), expect.anything(),
    );
  });

  it('does not dispatch when the head contains only an assignee-held item', async () => {
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [heldCritical] }),
      claimItem: vi.fn().mockResolvedValue({ ok: true }),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
      recordDispatch: vi.fn().mockResolvedValue(true),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(deps.claimItem).not.toHaveBeenCalled();
  });
});
