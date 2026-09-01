/**
 * F5 global slot budget proof (WL-0MTII48OV008P2QU, parent AC4):
 * single machine-wide budget — 3 proxy slots, 2 projects offering work,
 * total concurrently dispatched never exceeds the shared budget; per-tier
 * minimums (audit 2, single-pane 1) + idle gate shared via one leader snapshot.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchFromCoordination, type DowntimeWorkerDeps, type DowntimeItemInfo } from './downtime-worker.js';
import type { CoordinationEntry } from './coordination.js';

function entry(id: string, item: string, root: string): CoordinationEntry {
  const now = new Date().toISOString();
  return { instanceId: id, workItemId: item, directory: root, worklogRoot: root, assignedAt: now, lastUpdated: now };
}
function info(o: Partial<DowntimeItemInfo> & { id: string }): DowntimeItemInfo {
  return { id: o.id, title: o.id, status: o.status ?? 'open', stage: o.stage ?? 'idea', priority: o.priority, risk: o.risk, effort: o.effort, updatedAt: o.updatedAt, auditedAt: o.auditedAt } as DowntimeItemInfo;
}
function deps(o: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
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
    ...o,
  } as DowntimeWorkerDeps;
}
let shared: string;
function withShared(fn: () => Promise<void>) { return async () => { shared = mkdtempSync(join(tmpdir(), 'herdr-f5-')); try { await fn(); } finally { rmSync(shared, { recursive: true, force: true }); } }; }

describe('F5 global slot budget', () => {
  const A = '/repo/a', B = '/repo/b';

  it('AC4 headless: 3 slots, 2 offers — single dispatch per leader tick never exceeds shared budget', withShared(async () => {
    // Two entries across roots, both implement-tier; each dispatches exactly
    // one pane (≥1 slot). The leader makes ONE dispatch decision per keep-
    // open cycle (caller enforces one-at-a-time; freeSlots from the single
    // status snapshot caps the dispatch). Proven: with 3 slots the leader
    // dispatches once (consuming 1 → 2 remain), not twice in one tick.
    const entries = [entry('i-a', 'WL-A', A), entry('i-b', 'WL-B', B)];
    const d = deps({
      fetchItem: vi.fn().mockImplementation(async (id: string) => ({
        ok: true,
        info: info({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }),
      })),
    });
    const out = await dispatchFromCoordination(d, entries, { model: 'plan', cwd: '/repo', coordinationDir: shared, freeSlots: 3 });
    expect(out.dispatched).toBe(true);
    expect((d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // The second offer remains queued (owner re-offers next check-in).
  }));

  it('audit tier requires >=2 free slots (single budget)', withShared(async () => {
    const d = deps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: info({ id: 'WL-AUD', status: 'completed', stage: 'in_review', updatedAt: new Date(Date.now() - 60_000).toISOString() }) }),
    });
    const entries = [entry('i-a', 'WL-AUD', A)];
    const one = await dispatchFromCoordination(d, entries, { model: 'plan', cwd: '/repo', coordinationDir: shared, freeSlots: 1 });
    expect(one.dispatched).toBe(false);
    const two = await dispatchFromCoordination(d, entries, { model: 'plan', cwd: '/repo', coordinationDir: shared, freeSlots: 2 });
    expect(two.dispatched).toBe(true);
    expect(two.kind).toBe('audit');
  }));

  it('single-pane tiers require >=1 free slot (0 free → no dispatch)', withShared(async () => {
    const d = deps({ fetchItem: vi.fn().mockResolvedValue({ ok: true, info: info({ id: 'WL-A', status: 'open', stage: 'idea' }) }) });
    const out = await dispatchFromCoordination(d, [entry('i-a', 'WL-A', A)], { model: 'plan', cwd: '/repo', coordinationDir: shared, freeSlots: 0 });
    expect(out.dispatched).toBe(false);
  }));

  it('freeSlots undefined (direct caller) skips gating — single budget enforced by caller snapshot', withShared(async () => {
    const d = deps({ fetchItem: vi.fn().mockResolvedValue({ ok: true, info: info({ id: 'WL-A', status: 'open', stage: 'idea' }) }) });
    const out = await dispatchFromCoordination(d, [entry('i-a', 'WL-A', A)], { model: 'plan', cwd: '/repo', coordinationDir: shared });
    expect(out.dispatched).toBe(true);
  }));
});
