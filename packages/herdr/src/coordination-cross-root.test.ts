/**
 * F4 cross-root offer-list dispatch proof (WL-0MTII45EP002DWK6 +
 * WL-0MTK1ILM2009QYB2): the leader dispatches OFFERS in ROUND-ROBIN order
 * across worklogRoots (least-recently-served root selected first; cursor
 * advances atomically via selectLeastRecentlyServed — WL-0MTQ2FGSK004CBRK).
 * Each offer is its root's Herdr list head at the owner's check-in. The
 * cross-root tier priority / critical override ordering is retired: no
 * second ranking on the dispatch path. Spawns the pane in the entry's
 * worklogRoot.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchFromCoordination, type DowntimeWorkerDeps, type DowntimeItemInfo } from './downtime-worker.js';
import type { CoordinationEntry } from './coordination.js';

let shared: string;
function withShared(fn: () => Promise<void> | void) {
  return async () => {
    shared = mkdtempSync(join(tmpdir(), 'herdr-f4-'));
    try { await fn(); } finally { rmSync(shared, { recursive: true, force: true }); }
  };
}

function entry(instanceId: string, workItemId: string, worklogRoot: string): CoordinationEntry {
  const now = new Date().toISOString();
  return { instanceId, workItemId, directory: worklogRoot, worklogRoot, assignedAt: now, lastUpdated: now };
}
function info(overrides: Partial<DowntimeItemInfo> & { id: string }): DowntimeItemInfo {
  return { id: overrides.id, title: overrides.title ?? overrides.id, status: overrides.status ?? 'open', stage: overrides.stage ?? 'idea', priority: overrides.priority, risk: overrides.risk, effort: overrides.effort, updatedAt: overrides.updatedAt, auditedAt: overrides.auditedAt } as DowntimeItemInfo;
}
function deps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(null),
    getNextCriticalCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
    recordDispatchFailure: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
    getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
    recordScheduledPromptTrigger: vi.fn().mockResolvedValue(true),
    readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
    fetchItem: vi.fn().mockResolvedValue({ ok: true, info: info({ id: 'WL-X', stage: 'idea' }) }),
    ...overrides,
  } as DowntimeWorkerDeps;
}

describe('F4 cross-root offer-list dispatch', () => {
  it('round-robin cursor rotates: when rootA is cursor-older, rootA is dispatched first', withShared(async () => {
    const rootA = '/repo/a'; const rootB = '/repo/b';
    const { saveRoundRobinCursor } = await import('./downtime-round-robin-by-root.js');
    // rootA has older cursor — it should be dispatched first
    saveRoundRobinCursor(shared, {
      [rootA]: '2026-01-01T00:00:00.000Z',
      [rootB]: '2026-12-31T23:59:59.999Z',
    });
    const entries = [entry('inst-b', 'WL-B', rootB), entry('inst-a', 'WL-A', rootA)];
    const d = deps({
      fetchItem: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'WL-A') return { ok: true, info: info({ id, status: 'open', stage: 'idea' }) };
        return { ok: true, info: info({ id, status: 'open', stage: 'idea' }) };
      }),
    });
    const out = await dispatchFromCoordination(d, entries, { model: 'plan', cwd: '/repo', coordinationDir: shared });
    expect(out.dispatched).toBe(true);
    const spawn = (d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(spawn[1].cwd).toBe(rootA);
    expect(String(spawn[0])).toContain('WL-A');
  }));

  it('dispatches the least-recently-served root first (round-robin cursor; unknown roots sorted alphabetically)', withShared(async () => {
    const rootA = '/repo/a'; const rootB = '/repo/b';
    const entries = [entry('inst-a', 'WL-IMPL', rootA), entry('inst-b', 'WL-AUD', rootB)];
    const d = deps({
      fetchItem: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'WL-IMPL') return { ok: true, info: info({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) };
        return { ok: true, info: info({ id, status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() }) };
      }),
    });
    const out = await dispatchFromCoordination(d, entries, { model: 'plan', cwd: '/repo', coordinationDir: shared });
    expect(out.dispatched).toBe(true);
    expect(out.kind).toBe('implement');
    const spawn = (d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(spawn[1].cwd).toBe(rootA);
    expect(String(spawn[0])).toContain('WL-IMPL');
  }));

  it('a later critical offer in another root does not jump an earlier eligible offer (round-robin cursor, unknown roots alphabetical)', withShared(async () => {
    const rootA = '/repo/a'; const rootC = '/repo/c';
    const entries = [entry('inst-a', 'WL-IMPL', rootA), entry('inst-c', 'WL-CRIT', rootC)];
    const d = deps({
      fetchItem: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'WL-IMPL') return { ok: true, info: info({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) };
        return { ok: true, info: info({ id, status: 'open', stage: 'idea', priority: 'critical' }) };
      }),
    });
    const out = await dispatchFromCoordination(d, entries, { model: 'plan', cwd: '/repo', coordinationDir: shared });
    expect(out.kind).toBe('implement');
    const spawn = (d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(spawn[1].cwd).toBe(rootA);
    expect(String(spawn[0])).toContain('WL-IMPL');
  }));

  it('worklogRoot preferred over directory (compat) and fetchItem receives worklogRoot', withShared(async () => {
    const root = '/repo/b';
    const e: CoordinationEntry = { instanceId: 'inst', workItemId: 'WL-1', directory: '/legacy', worklogRoot: root, assignedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() };
    const d = deps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: info({ id: 'WL-1', status: 'open', stage: 'idea' }) }),
    });
    await dispatchFromCoordination(d, [e], { model: 'plan', cwd: '/repo', coordinationDir: shared });
    expect((d.fetchItem as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(root);
    expect((d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1].cwd).toBe(root);
  }));
});
