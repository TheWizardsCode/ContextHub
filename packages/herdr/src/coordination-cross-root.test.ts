/**
 * F4 cross-directory tier dispatch proof (WL-0MTII45EP002DWK6).
 *
 * Leader orders offers by existing tier priority (audit → critical →
 * implement → plan → intake) across worklogRoots and spawns the pane in
 * the entry's worklogRoot.
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

describe('F4 cross-root tier dispatch', () => {
  it('audit in root B outranks implement in root A (cross-root tier order)', withShared(async () => {
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
    expect(out.kind).toBe('audit');
    const spawn = (d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(spawn[1].cwd).toBe(rootB);
    expect(String(spawn[0])).toContain('WL-AUD');
  }));

  it('critical in root C outranks non-critical implement in root A', withShared(async () => {
    const rootA = '/repo/a'; const rootC = '/repo/c';
    const entries = [entry('inst-a', 'WL-IMPL', rootA), entry('inst-c', 'WL-CRIT', rootC)];
    const d = deps({
      fetchItem: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'WL-IMPL') return { ok: true, info: info({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) };
        return { ok: true, info: info({ id, status: 'open', stage: 'idea', priority: 'critical' }) };
      }),
    });
    const out = await dispatchFromCoordination(d, entries, { model: 'plan', cwd: '/repo', coordinationDir: shared });
    expect(out.kind).toBe('intake');
    const spawn = (d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(spawn[1].cwd).toBe(rootC);
    expect(String(spawn[0])).toContain('WL-CRIT');
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
