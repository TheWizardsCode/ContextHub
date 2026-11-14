/**
 * F4 cross-root offer-list dispatch proof (WL-0MTII45EP002DWK6 +
 * WL-0MTK1ILM2009QYB2): the leader dispatches OFFERS in ROUND-ROBIN order
 * across worklogRoots (least-recently-served root selected first).
 * WL-0MWFIZ8H5005FVNN: selection is a PURE READ — the cursor is charged when a
 * dispatching root's offer is consumed, not at selection time. Specs that need
 * a cursor change across ticks apply it explicitly via `advanceRoot`.
 * Each offer is its root's Herdr list head at the owner's check-in. The
 * cross-root tier priority / critical override ordering is retired: no
 * second ranking on the dispatch path. Spawns the pane in the entry's
 * worklogRoot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchFromCoordination, type DowntimeWorkerDeps, type DowntimeItemInfo, type HerdrPaneRecord } from './downtime-worker.js';
import type { CoordinationEntry } from './coordination.js';
import { advanceRoot, saveRoundRobinCursor } from './downtime-round-robin-by-root.js';
import {
  scanStalledPanes,
  resumeStalledPane,
  _resetStalledResumeInFlight,
  type StalledScanDeps,
  type ResumeStalledPaneDeps,
} from './stalled-work.js';
import type { DowntimeLogEntry } from './downtime-log.js';

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
    // Leaf-vs-parent audit scope (WL-0MVV1EZ8G006PSBE, C2): the neutral
    // `parent` default keeps today's all-slots-style audit gate.
    getAuditCandidateScope: vi.fn().mockResolvedValue({ ok: true, scope: 'parent' }),
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
    // Review-queue depth gate (WL-0MTTSWC1X005P4VD): shallow default so
    // implement offers dispatch unchanged.
    getReviewQueueCount: vi.fn().mockResolvedValue(0),
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

  // ── Stalled-work cross-root resume (WL-0MUYMBUAK007H10J) ────────────
  // End-to-end through the LEADER path: the real `scanStalledPanes` +
  // `resumeStalledPane` orchestrators are wired as the dispatcher deps, so a
  // stalled pane for an item in a FOREIGN worklog root is resumed against
  // that root (never the leader's) and an unresolvable root fails closed and
  // falls through to the normal offer dispatch.

  const STALE = () => new Date(Date.now() - 10 * 60 * 1000).toISOString();

  function stalledPane(overrides: Partial<HerdrPaneRecord> = {}): HerdrPaneRecord {
    return {
      paneId: 'pane-foreign',
      label: 'Downtime triggered implement Foreign item - WL-FOREIGN',
      agent: 'pi',
      agentStatus: 'idle',
      cwd: '/foreign/repo',
      ...overrides,
    };
  }

  function foreignItem(id = 'WL-FOREIGN'): DowntimeItemInfo {
    return { id, title: 'Foreign item', status: 'open', stage: 'plan_complete', updatedAt: STALE() } as DowntimeItemInfo;
  }

  function wireRealScanResume(
    scanDeps: StalledScanDeps,
    resumeDeps: ResumeStalledPaneDeps,
  ): Pick<DowntimeWorkerDeps, 'scanStalledPanes' | 'resumeStalledPane'> {
    return {
      scanStalledPanes: (cwd, opts) => scanStalledPanes(scanDeps, cwd, opts),
      resumeStalledPane: (cand, opts) =>
        resumeStalledPane(
          {
            pane: cand.pane,
            item: cand.item,
            cwd: cand.cwd,
            kind: cand.kind,
            nonTerminalCooldownMs: opts.nonTerminalCooldownMs,
            thresholdMs: opts.thresholdMs,
          },
          resumeDeps,
        ),
    };
  }

  beforeEach(() => {
    _resetStalledResumeInFlight();
  });

  it('resumes a foreign-root stalled pane against ITS OWN root, not the leader\u2019s', withShared(async () => {
    const leaderRoot = '/leader/repo';
    const foreignRoot = '/foreign/repo';
    const prompted: Array<[string, string]> = [];
    const fetched: Array<[string, string]> = [];
    const recorded: DowntimeLogEntry[] = [];

    const scanDeps: StalledScanDeps = {
      listPanes: async () => [stalledPane({ cwd: foreignRoot })],
      fetchItem: async (id, cwd) => {
        fetched.push([id, cwd]);
        return { ok: true, info: foreignItem(id) };
      },
      readEntries: async () => [],
      resolveRoot: (pane) => (pane.cwd === foreignRoot ? foreignRoot : null),
    };
    const resumeDeps: ResumeStalledPaneDeps = {
      promptAgent: async (paneId, text) => {
        prompted.push([paneId, text]);
        return { ok: true };
      },
      startAgent: async () => ({ ok: true }),
      readEntries: async () => [],
      recordAttempt: async (cwd, entry) => {
        recorded.push({ ...entry, cwd } as DowntimeLogEntry);
      },
      markNeedsProducerReview: async () => true,
      maxAttempts: 3,
      now: () => Date.now(),
    };

    const d = deps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: info({ id: 'WL-OFFER', status: 'open', stage: 'idea' }) }),
      ...wireRealScanResume(scanDeps, resumeDeps),
    });

    const out = await dispatchFromCoordination(
      d,
      [entry('inst-leader', 'WL-OFFER', leaderRoot)],
      { model: 'plan', cwd: leaderRoot, coordinationDir: shared, freeSlots: 2 },
    );

    // A successful resume short-circuits new-item dispatch for the cycle.
    expect(out).toEqual({ dispatched: false, reason: 'stalled-resume' });
    // The item was fetched against the PANE'S root, never the leader's.
    expect(fetched).toEqual([['WL-FOREIGN', foreignRoot]]);
    expect(prompted).toEqual([['pane-foreign', 'continue']]);
    // The dispatch attempt was recorded on the FOREIGN root.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ itemId: 'WL-FOREIGN', kind: 'implement', cwd: foreignRoot });
    // No pane was spawned in the leader's root and the offer was never fetched.
    expect(d.spawnAgentPane).not.toHaveBeenCalled();
    const offerFetch = (d.fetchItem as ReturnType<typeof vi.fn>).mock.calls;
    expect(offerFetch).toHaveLength(0);
  }));

  it('fails closed when the pane root is unresolvable and dispatches the offer normally (no wrong-root resume)', withShared(async () => {
    const leaderRoot = '/leader/repo';
    const prompted: string[] = [];
    const fetchedRoots: string[] = [];

    const scanDeps: StalledScanDeps = {
      listPanes: async () => [stalledPane({ cwd: '/definitely/not/a/worklog' })],
      fetchItem: async (id, cwd) => {
        fetchedRoots.push(cwd);
        return { ok: true, info: foreignItem(id) };
      },
      readEntries: async () => [],
      // The cwd/session cannot be resolved to an unambiguous worklog root.
      resolveRoot: () => null,
    };
    const resumeDeps: ResumeStalledPaneDeps = {
      promptAgent: async (paneId) => {
        prompted.push(paneId);
        return { ok: true };
      },
      startAgent: async () => ({ ok: true }),
      readEntries: async () => [],
      recordAttempt: async () => undefined,
      markNeedsProducerReview: async () => true,
      maxAttempts: 3,
    };

    const d = deps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: info({ id: 'WL-OFFER', status: 'open', stage: 'idea' }) }),
      ...wireRealScanResume(scanDeps, resumeDeps),
    });

    const out = await dispatchFromCoordination(
      d,
      [entry('inst-leader', 'WL-OFFER', leaderRoot)],
      { model: 'plan', cwd: leaderRoot, coordinationDir: shared, freeSlots: 2 },
    );

    // Fail closed: no resume, no wrong-root fetch, and normal offer dispatch.
    expect(prompted).toEqual([]);
    expect(fetchedRoots).toEqual([]);
    expect(out.dispatched).toBe(true);
    expect((d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1].cwd).toBe(leaderRoot);
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

// ---------------------------------------------------------------------------
// Registered-root registry — fail-safe candidate universe (test-first
// WL-0MW4ZNYSV002LJDZ, parent WL-0MVR8GDJ3008WY3Y AC6)
//
// `downtimeWorklogRoots` lets the leader sweep EXTRA roots. It is strictly
// additive: with an absent/empty (or wholly unresolvable) registry the
// candidate universe must stay exactly `offerList ∪ ownBacklog(opts.cwd)`.
//
// These two specs are GREEN today (the leader ignores the unknown opt) and
// must stay green after the sweep lands (WL-0MW4ZOSD6004SAVD): they pin that
// an empty registry adds NO root reads and NO second ranking. They are the
// regression guard for the fail-safe leg of the contract.
// ---------------------------------------------------------------------------

describe('registered-root registry fail-safe (parent AC6)', () => {
  /** Opts carrying the (future) registered-root registry. */
  type RegistryOpts = Parameters<typeof dispatchFromCoordination>[2] & {
    registeredRoots?: readonly string[];
  };

  it('an empty registry reads ONLY the leader\u2019s own backlog root', withShared(async () => {
    const leaderRoot = '/leader/repo';
    const headCalls: string[] = [];
    const d = deps({
      getHerdrListHead: vi.fn(async (cwd: string) => {
        headCalls.push(cwd);
        return { ok: true, items: [] };
      }),
    });

    const opts: RegistryOpts = {
      model: 'plan',
      cwd: leaderRoot,
      coordinationDir: shared,
      registeredRoots: [],
    };
    const out = await dispatchFromCoordination(d, [], opts);

    expect(out.dispatched).toBe(false);
    // No sweep: every canonical-ranking read is the leader's own root.
    expect(headCalls.length).toBeGreaterThan(0);
    expect([...new Set(headCalls)]).toEqual([leaderRoot]);
  }));

  it('an absent registry adds no root beyond the offers and the own backlog', withShared(async () => {
    const leaderRoot = '/leader/repo';
    const offerRoot = '/peer/repo';
    const headCalls: string[] = [];
    const d = deps({
      getHerdrListHead: vi.fn(async (cwd: string) => {
        headCalls.push(cwd);
        return { ok: true, items: [] };
      }),
      fetchItem: vi.fn().mockResolvedValue({
        ok: true,
        info: info({ id: 'WL-OFFER', status: 'open', stage: 'idea' }),
      }),
    });

    const out = await dispatchFromCoordination(d, [entry('peer-1', 'WL-OFFER', offerRoot)], {
      model: 'plan',
      cwd: leaderRoot,
      coordinationDir: shared,
    });

    // The offer dispatches from its own root (today's behaviour) ...
    expect(out.dispatched).toBe(true);
    const spawn = (d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(spawn[1].cwd).toBe(offerRoot);
    // ... and no registered-root sweep read any root as a canonical-ranking
    // head: with an absent registry the only possible head read is the
    // leader's own backlog (never reached here — the offer dispatched).
    expect(headCalls).not.toContain(offerRoot);
    expect(headCalls.filter((cwd) => cwd !== leaderRoot)).toEqual([]);
  }));
});

// ── Cross-root round-robin governs ROOT order (parent WL-0MWDDHQON0015T3P AC8) ──
//
// Tier choice (audit-drain → prep → implement) happens ONLY inside an entry.
// Across entries, `selectLeastRecentlyServed` alone decides root order, so a
// root offering more buckets (or a "higher" tier) gains no root-level share.
// GREEN (v1 single-offer entries, and unchanged by F3 WL-0MWDVN2HN004CQ1O's
// per-offer iteration) — they are the regression guard for the "no second
// ranking on the dispatch path" contract. The v2 spec below (a multi-bucket
// root gaining no root-level share) landed with F1
// (WL-0MWDVMVX50012RSU) + F3.
describe('round-robin still governs root order (parent AC8)', () => {
  it('a PREP offer in the cursor-oldest root dispatches before an IMPLEMENT offer in a newer root (tier choice never crosses roots)', withShared(async () => {
    const rootA = '/repo/a'; const rootB = '/repo/b';
    // rootA was served most recently; rootB is the least-recently-served.
    saveRoundRobinCursor(shared, {
      [rootA]: '2026-12-31T23:59:59.999Z',
      [rootB]: '2026-01-01T00:00:00.000Z',
    });
    const d = deps({
      fetchItem: vi.fn().mockImplementation(async (id: string) => {
        if (id === 'WL-IMPL') return { ok: true, info: info({ id, status: 'open', stage: 'plan_complete', risk: 'Low', effort: 'S' }) };
        return { ok: true, info: info({ id, status: 'open', stage: 'intake_complete' }) };
      }),
    });
    const out = await dispatchFromCoordination(
      d,
      [entry('inst-a', 'WL-IMPL', rootA), entry('inst-b', 'WL-PREP', rootB)],
      { model: 'plan', cwd: '/repo', coordinationDir: shared },
    );
    expect(out.dispatched).toBe(true);
    expect(out.kind).toBe('plan'); // rootB's prep, NOT rootA's implement
    const spawn = (d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(spawn[1].cwd).toBe(rootB);
    expect(String(spawn[0])).toContain('WL-PREP');
  }));

  it('rotates across successive ticks when the dispatching root is charged (WL-0MWFIZ8H5005FVNN)', withShared(async () => {
    const rootA = '/repo/a'; const rootB = '/repo/b';
    // Seed BOTH roots as known, rootB strictly older → tick 1 selects rootB.
    // Rewritten for WL-0MWFIZ8H5005FVNN (post-dispatch charge): selection no
    // longer advances the cursor, so the charge is applied EXPLICITLY here via
    // `advanceRoot` (standing in for the consumed-offer charge). This keeps the
    // spec pinning cursor-driven rotation independently of WHERE the production
    // charge lands; the charge point itself is pinned by the charge-table specs
    // in coordination-dispatch.test.ts.
    saveRoundRobinCursor(shared, {
      [rootA]: '2026-06-01T00:00:00.000Z',
      [rootB]: '2026-01-01T00:00:00.000Z',
    });
    const d = deps({
      fetchItem: vi.fn().mockImplementation(async (id: string) =>
        ({ ok: true, info: info({ id, status: 'open', stage: 'intake_complete' }) }),
      ),
    });
    // Tick 1: rootB is cursor-oldest → rootB's offer dispatches.
    const first = await dispatchFromCoordination(
      d,
      [entry('inst-a', 'WL-A', rootA), entry('inst-b', 'WL-B', rootB)],
      { model: 'plan', cwd: '/repo', coordinationDir: shared },
    );
    expect(first.dispatched).toBe(true);
    expect((d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0][1].cwd).toBe(rootB);
    // The dispatch charge (new contract) — explicit so this spec is independent
    // of the charge point.
    advanceRoot(shared, rootB, Date.now());
    // Tick 2 (same two roots, fresh file not needed — the cursor is the
    // shared state): rootB was just served, so rootA is now least-recently-served.
    const second = await dispatchFromCoordination(
      d,
      [entry('inst-a', 'WL-A', rootA), entry('inst-b', 'WL-B', rootB)],
      { model: 'plan', cwd: '/repo', coordinationDir: shared },
    );
    expect(second.dispatched).toBe(true);
    expect((d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[1][1].cwd).toBe(rootA);
  }));

  it('a root offering the FULL v2 bucket set gains no root-level priority: a cursor-older peer single-offer root still dispatches first', withShared(async () => {
    const rootA = '/repo/a'; const rootB = '/repo/b';
    // rootA advertises all three buckets (v2 offers payload, no top-level
    // workItemId); rootB — cursor-oldest — one v1-style offer.
    const v2 = {
      instanceId: 'inst-a',
      worklogRoot: rootA,
      directory: rootA,
      assignedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      offers: [
        { kind: 'implement', workItemId: 'WL-IMP' },
        { kind: 'audit', workItemId: 'WL-AUD' },
        { kind: 'prep', workItemId: 'WL-PREP' },
      ],
    } as unknown as CoordinationEntry;
    saveRoundRobinCursor(shared, {
      [rootA]: '2026-12-31T23:59:59.999Z',
      [rootB]: '2026-01-01T00:00:00.000Z',
    });
    const d = deps({
      fetchItem: vi.fn().mockResolvedValue({ ok: true, info: info({ id: 'WL-B', status: 'open', stage: 'intake_complete' }) }),
    });
    const out = await dispatchFromCoordination(
      d,
      [v2, entry('inst-b', 'WL-B', rootB)],
      { model: 'plan', cwd: '/repo', coordinationDir: shared },
    );
    // Round-robin still selects rootB (cursor-oldest): the multi-bucket root
    // gains no root-level share — tier choice stays inside the entry.
    expect(out.dispatched).toBe(true);
    const spawn = (d.spawnAgentPane as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
    expect(spawn[1].cwd).toBe(rootB);
    expect(String(spawn[0])).toContain('WL-B');
  }));
});
