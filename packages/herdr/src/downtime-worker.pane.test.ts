/**
 * packages/herdr/src/downtime-worker.pane.test.ts — pane spawn, pane-record
 * helpers and pane-lifecycle tests
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4VHFM3003IP1Y) to keep each test file focused
 * on one concern.
 *
 * Covers the pane-related surface:
 *   - `downtime pane spawn (send-to-pi.sh)` — pane arg/option building and
 *     the injectable spawn boundary,
 *   - `parseHerdrPaneListOutput / countRunningDowntimePanes (AC1)` — pane-list
 *     parsing,
 *   - `paneLabelItemId / runningDowntimePaneItemIds / evaluateCriticalFirstGuard`
 *     — item-scoped in-flight guard helpers,
 *   - `dispatchDowntimeWork: running-pane / owner / contention gates`,
 *   - `worker tick: the LLM idle check is the sole concurrency limiter` —
 *     including the `onProxyIdle` callback,
 *   - `pane-lifecycle monitor (WL-0MU308WSF0002JWN) [disabled behaviour]`, and
 *   - `worker tick pane-lifecycle integration (WL-0MU4US5MP001JFEN) [disabled]`.
 *
 * Shared scaffolding (`makeDeps`, temp-dir trackers, status fixtures) is
 * imported from `downtime-worker.fixtures.ts`; no setup logic is
 * re-implemented here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildDowntimePaneArgs,
  spawnDowntimePane,
  buildDowntimeSpawnOptions,
  scrubRepositoryOverrides,
  REPOSITORY_OVERRIDE_ENV_VARS,
  parseHerdrPaneListOutput,
  countRunningDowntimePanes,
  paneLabelItemId,
  isSafeDowntimePaneToClose,
  runningDowntimePaneItemIds,
  evaluateCriticalFirstGuard,
  resolveInFlightPanes,
  monitorDispatchedPanes,
  dispatchDowntimeWork,
  createDowntimePoller,
  createDowntimeWorker,
  DOWNTIME_PANE_LABEL_PREFIX,
  type LlamaStatus,
  type DowntimeWorkerDeps,
  type DowntimeSpawn,
  type HerdrPaneRecord,
  type InFlightPanes,
} from './downtime-worker.js';
import {
  appendDowntimeLogEntry,
  appendPaneCloseLogEntry,
  readDowntimeLogEntries,
} from './downtime-log.js';
import {
  herdrPaneListRaw,
  idleAllSlotsFree,
  busyActiveQuery,
  idleWithContention,
  idleWithCumulativeContention,
  perSlotThreeOfFourFree,
  jsonResponseFixture,
  makeDeps,
  createTempDirTracker,
} from './downtime-worker.fixtures.js';

// ── Pane spawn (AC4) ──────────────────────────────────────────────────

describe('downtime pane spawn (send-to-pi.sh)', () => {
  it('builds --pane-name / --no-focus / --cwd / --model args for a plan dispatch', () => {
    const args = buildDowntimePaneArgs('plan', 'Run /skill:plan WL-ABC — Some task.', {
      model: 'plan',
      cwd: '/repo',
    });
    expect(args).toEqual([
      '--pane-name',
      'Downtime plan',
      '--no-focus',
      '--cwd',
      '/repo',
      '--model',
      'plan',
      'Run /skill:plan WL-ABC — Some task.',
    ]);
  });

  it('uses the intake pane name and forwards the configured model', () => {
    const args = buildDowntimePaneArgs('intake', 'Run /skill:intake WL-DEF', {
      model: 'code',
      cwd: '/repo',
    });
    expect(args).toContain('Downtime intake');
    expect(args).toContain('code');
    expect(args).not.toContain('Downtime plan');
  });

  it('spawns via the injectable spawn and unrefs the child', async () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn(), once: vi.fn() })) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/send-to-pi.sh', ['--no-focus', 'prompt'], { cwd: '/repo' }, spawnFn);

    expect(spawnFn).toHaveBeenCalledWith('/path/to/send-to-pi.sh', ['--no-focus', 'prompt'], {
      cwd: '/repo',
    });
    const handle = (spawnFn as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(handle.unref).toHaveBeenCalled();
    expect(handle.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(handle.once).toHaveBeenCalledWith('exit', expect.any(Function));
    // No error/exit within the probe window → the pane is assumed opened.
    expect(spawned).toEqual({ ok: true });
  });

  it('resolves {ok:false} with the error trace on a handled spawn error (no unhandled-exception crash)', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'error') listener(new Error('ENOENT: send-to-pi.sh'));
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/missing.sh', [], { cwd: '/repo' }, spawnFn);

    expect(spawned).toEqual({ ok: false, error: 'ENOENT: send-to-pi.sh' });
    expect(handle.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(handle.once).toHaveBeenCalledWith('exit', expect.any(Function));
  });

  it('resolves {ok:false} with the exit trace on a non-zero script exit within the probe window', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'exit') listener(1);
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/send-to-pi.sh', [], { cwd: '/repo' }, spawnFn);

    expect(spawned).toEqual({ ok: false, exitCode: 1 });
  });

  it('treats a signal-killed child (exit code null) as a failure', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'exit') listener(null);
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/send-to-pi.sh', [], { cwd: '/repo' }, spawnFn);

    expect(spawned).toEqual({ ok: false, exitCode: null });
  });

  it('resolves {ok:true} when the script exits 0 (pane opened — success path unchanged)', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'exit') listener(0);
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;

    const spawned = await spawnDowntimePane('/path/to/send-to-pi.sh', [], { cwd: '/repo' }, spawnFn);

    expect(spawned).toEqual({ ok: true });
  });

  it('buildDowntimeSpawnOptions uses detached/ignore options with the resolved cwd', () => {
    const options = buildDowntimeSpawnOptions('/repo');
    expect(options).toEqual({
      detached: true,
      stdio: 'ignore',
      cwd: '/repo',
      env: expect.objectContaining({ HERDR_RESOLVED_CWD: '/repo' }),
    });
  });

  it('buildDowntimeSpawnOptions bounds the dispatched audit fan-out (AUDIT_PHASE2_PARALLELISM=1)', () => {
    const options = buildDowntimeSpawnOptions('/repo');
    // Parent audit + at most one sequential child deep-analysis call fits
    // cheap mode's 2 local slots (WL-0MSORQ1RG005DGUS).
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it('buildDowntimeSpawnOptions scrubs repository-override git vars (WL-0MV0TZEWZ003ZXEB)', () => {
    const saved = new Map<string, string | undefined>();
    for (const key of REPOSITORY_OVERRIDE_ENV_VARS) {
      saved.set(key, process.env[key]);
      process.env[key] = `/tmp/leaked/${key}`;
    }
    try {
      const options = buildDowntimeSpawnOptions('/repo');
      for (const key of REPOSITORY_OVERRIDE_ENV_VARS) {
        expect(options.env[key]).toBeUndefined();
      }
      // The scrub must not discard unrelated forwarding.
      expect(options.env.HERDR_RESOLVED_CWD).toBe('/repo');
    } finally {
      for (const key of REPOSITORY_OVERRIDE_ENV_VARS) {
        const previous = saved.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  });

  it('scrubRepositoryOverrides removes only override vars and never mutates its input', () => {
    const input = {
      PATH: '/usr/bin',
      GIT_DIR: '/leak/.git',
      GIT_WORK_TREE: '/leak',
      HERDR_ENV: '1',
    };

    const cleaned = scrubRepositoryOverrides(input);

    expect(cleaned).toEqual({ PATH: '/usr/bin', HERDR_ENV: '1' });
    // Input mapping is untouched.
    expect(input.GIT_DIR).toBe('/leak/.git');
    expect(input.GIT_WORK_TREE).toBe('/leak');
  });

  // ── Mode-aware PARALLELISM (WL-0MT50S9JW001DHME) ──────────────────

  it('buildDowntimeSpawnOptions defaults to PARALLELISM=1 when config is absent', () => {
    // Backward compatibility: no config → '1'
    const options = buildDowntimeSpawnOptions('/repo');
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');

    const optionsWithEmptyConfig = buildDowntimeSpawnOptions('/repo', { config: undefined });
    expect(optionsWithEmptyConfig.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it('buildDowntimeSpawnOptions returns PARALLELISM=1 in fast mode even with free slots', () => {
    const options = buildDowntimeSpawnOptions('/repo', {
      config: { mode: 'fast', slotBudget: 3, freeSlots: 3, concurrentDispatchCap: 1 },
    });
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it('buildDowntimeSpawnOptions returns PARALLELISM=2 for cheap mode with a genuinely free second slot (single-flight)', () => {
    // Cheap mode, 2 slots, both genuinely free, single dispatch at a time →
    // 2 children = 2 streams total, fitting the 2-slot pool.
    const options = buildDowntimeSpawnOptions('/repo', {
      config: { mode: 'cheap', slotBudget: 2, freeSlots: 2, concurrentDispatchCap: 1 },
    });
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('2');
  });

  it('buildDowntimeSpawnOptions returns PARALLELISM=1 when the second slot is NOT genuinely free', () => {
    // The operative signal is freeSlots, never the total slotBudget: a 2-slot
    // pool with only 1 free slot cannot run 2 children.
    const options = buildDowntimeSpawnOptions('/repo', {
      config: { mode: 'cheap', slotBudget: 2, freeSlots: 1, concurrentDispatchCap: 1 },
    });
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it('buildDowntimeSpawnOptions returns PARALLELISM=1 when the dispatch budget is unbounded (cap 0)', () => {
    // 0 = unbounded → a second audit could run → 2 audits × 2 children would
    // exceed the 2-slot cheap pool. Only cap === 1 is single-flight-safe.
    const options = buildDowntimeSpawnOptions('/repo', {
      config: { mode: 'cheap', slotBudget: 2, freeSlots: 2, concurrentDispatchCap: 0 },
    });
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it('buildDowntimeSpawnOptions returns PARALLELISM=1 when concurrent dispatch budget would exceed slot capacity', () => {
    // 2+ concurrent dispatches × 2 children each = 4 streams, exceeds 2-slot budget
    const options = buildDowntimeSpawnOptions('/repo', {
      config: { mode: 'cheap', slotBudget: 2, freeSlots: 2, concurrentDispatchCap: 2 },
    });
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it('buildDowntimeSpawnOptions returns PARALLELISM=1 when cheap mode slot budget is insufficient', () => {
    // Only 1 slot in the pool — cannot run 2 children
    const options = buildDowntimeSpawnOptions('/repo', {
      config: { mode: 'cheap', slotBudget: 1, freeSlots: 1, concurrentDispatchCap: 1 },
    });
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it('buildDowntimeSpawnOptions returns PARALLELISM=1 for cheap mode with high dispatch cap', () => {
    // 3+ concurrent dispatches × 2 children = 6 streams, far exceeds budget
    const options = buildDowntimeSpawnOptions('/repo', {
      config: { mode: 'cheap', slotBudget: 2, freeSlots: 2, concurrentDispatchCap: 3 },
    });
    expect(options.env.AUDIT_PHASE2_PARALLELISM).toBe('1');
  });

  it('spawnDowntimePane forwards the spawn config to the spawn boundary (WL-0MT50S9JW001DHME)', async () => {
    const handle = {
      unref: vi.fn(),
      once: vi.fn((event: string, listener: (arg: unknown) => void) => {
        if (event === 'exit') listener(0);
      }),
    };
    const spawnFn = vi.fn(() => handle) as unknown as DowntimeSpawn;
    const config = {
      mode: 'cheap' as const,
      slotBudget: 2,
      freeSlots: 2,
      concurrentDispatchCap: 1,
    };

    await spawnDowntimePane('/path/to/send-to-pi.sh', [], { cwd: '/repo', config }, spawnFn);

    expect(spawnFn).toHaveBeenCalledWith('/path/to/send-to-pi.sh', [], { cwd: '/repo', config });
  });
});

describe('parseHerdrPaneListOutput / countRunningDowntimePanes (AC1)', () => {
  it('parses the herdr pane list envelope', () => {
    const panes = parseHerdrPaneListOutput(herdrPaneListRaw);
    expect(panes).not.toBeNull();
    expect(panes!.length).toBe(5);
    expect(panes![0].paneId).toBe('w1:p1');
    expect(panes![0].label).toContain('Downtime triggered');
  });

  it('counts only live downtime panes (excludes manual panes and done agents)', () => {
    const panes = parseHerdrPaneListOutput(herdrPaneListRaw)!;
    const running = countRunningDowntimePanes(panes);
    expect(running).toEqual(['w1:p1', 'w1:p2']);
    expect(DOWNTIME_PANE_LABEL_PREFIX).toBe('Downtime');
  });

  it('returns null for unparseable output (an unparseable probe is no longer a dispatch gate)', () => {
    expect(parseHerdrPaneListOutput('not json at all')).toBeNull();
  });

  it('tolerates log lines before the JSON envelope', () => {
    const panes = parseHerdrPaneListOutput(`[herdr] starting\n${herdrPaneListRaw}`);
    expect(panes).not.toBeNull();
    expect(countRunningDowntimePanes(panes!)).toHaveLength(2);
  });

  it('exposes cwd and agent_session on parsed records (WL-0MUYMBMCG000Z4WP AC1)', () => {
    const raw = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: 'w2Y:p87',
            label: 'Manually triggered intake - WL-ABC',
            agent: 'pi',
            agent_status: 'working',
            cwd: '/home/u/projects/OtherRoot',
            agent_session: { kind: 'path', value: '/tmp/s.jsonl' },
          },
        ],
      },
    });
    const panes = parseHerdrPaneListOutput(raw)!;
    expect(panes[0].cwd).toBe('/home/u/projects/OtherRoot');
    expect(panes[0].agentSession).toEqual({ kind: 'path', value: '/tmp/s.jsonl' });
  });

  it('omits cwd / agent_session on missing or malformed fields, without throwing (WL-0MUYMBMCG000Z4WP AC3)', () => {
    const raw = JSON.stringify({
      panes: [
        { pane_id: 'p1', cwd: 7, agent_session: ['x'] },
        { pane_id: 'p2' },
      ],
    });
    const panes = parseHerdrPaneListOutput(raw)!;
    expect(panes).toHaveLength(2);
    expect(panes[0].cwd).toBeUndefined();
    expect(panes[0].agentSession).toBeUndefined();
    expect(panes[1].cwd).toBeUndefined();
    expect(panes[1].agentSession).toBeUndefined();
  });

  it('shares one parse contract: bare arrays and bracketed log prefixes parse (WL-0MUYMBMCG000Z4WP AC3)', () => {
    const bare = JSON.stringify([{ pane_id: 'p1', cwd: '/r' }]);
    expect(parseHerdrPaneListOutput(bare)![0].cwd).toBe('/r');
    const prefixed = '[herdr] starting\n' + JSON.stringify({ panes: [{ pane_id: 'p1' }] });
    expect(parseHerdrPaneListOutput(prefixed)![0].paneId).toBe('p1');
  });
});

// ── Item-scoped in-flight guard helpers (F3 WL-0MUBVKXQJ000L8EO) ────────
// The guard must be ITEM-SCOPED (never a global running-pane count, which
// would reintroduce the WL-0MU2EP6JL006A1U3 stall) and must only treat a
// `working` agent as in-flight (terminal/idle panes must not deadlock the
// item's next tier).

describe('paneLabelItemId / runningDowntimePaneItemIds / evaluateCriticalFirstGuard (WL-0MUBEZ6PE002WLP4)', () => {
  const pane = (overrides: Partial<HerdrPaneRecord> & { paneId: string }): HerdrPaneRecord => ({
    label: 'Downtime triggered implement Some item - WL-ABC',
    agent: 'pi',
    agentStatus: 'working',
    ...overrides,
  });

  it('paneLabelItemId extracts the trailing work-item id (buildDowntimePaneTitle suffix contract)', () => {
    expect(paneLabelItemId('Downtime triggered implement Some item - WL-ABC')).toBe('WL-ABC');
    // A title containing ` - ` earlier still yields the LAST segment.
    expect(paneLabelItemId('Downtime triggered plan A - B - WL-XYZ')).toBe('WL-XYZ');
    // No suffix → null (manual pane).
    expect(paneLabelItemId('Downtime intake')).toBeNull();
    expect(paneLabelItemId(undefined)).toBeNull();
  });

  it('isSafeDowntimePaneToClose only accepts the downtime pane for the SAME item (AC7)', () => {
    const live = [
      pane({ paneId: 'w1:p1', label: 'Downtime triggered implement Some item - WL-ABC' }),
      pane({ paneId: 'w1:p2', label: 'pi - my operator session' }),
    ];
    // Matching downtime pane for the item → safe.
    expect(isSafeDowntimePaneToClose(live, 'w1:p1', 'WL-ABC')).toBe(true);
    // A different item's downtime pane (id collision) → NOT safe.
    expect(isSafeDowntimePaneToClose(live, 'w1:p1', 'WL-OTHER')).toBe(false);
    // A non-downtime (operator) pane → NOT safe.
    expect(isSafeDowntimePaneToClose(live, 'w1:p2', 'WL-ABC')).toBe(false);
    // The pane is already gone → NOT safe (nothing to close).
    expect(isSafeDowntimePaneToClose(live, 'w1:p9', 'WL-ABC')).toBe(false);
  });

  it('runningDowntimePaneItemIds returns only WORKING downtime panes, keyed by item id', () => {
    const ids = runningDowntimePaneItemIds([
      pane({ paneId: 'w1:p1', label: 'Downtime triggered implement A - WL-A', agentStatus: 'working' }),
      // terminal → excluded
      pane({ paneId: 'w1:p2', label: 'Downtime triggered implement B - WL-B', agentStatus: 'done' }),
      pane({ paneId: 'w1:p3', label: 'Downtime triggered implement C - WL-C', agentStatus: 'exited' }),
      // idle/unknown → NOT working → excluded (no deadlock)
      pane({ paneId: 'w1:p4', label: 'Downtime triggered implement D - WL-D', agentStatus: 'idle' }),
      // manual pane (no downtime prefix) → excluded
      pane({ paneId: 'w1:p5', label: 'Work Items', agentStatus: 'working' }),
      // downtime pane with no agent → excluded
      pane({ paneId: 'w1:p6', label: 'Downtime plan E - WL-E', agent: undefined, agentStatus: 'working' }),
    ]);
    expect([...ids]).toEqual(['WL-A']);
  });

  it('evaluateCriticalFirstGuard: live working pane → skip (in-flight-pane), regardless of marker freshness', () => {
    const inFlight: InFlightPanes = { available: true, itemIds: new Set(['WL-ABC']) };
    const d = evaluateCriticalFirstGuard('WL-ABC', inFlight, new Date().toISOString(), Date.now(), 3_600_000);
    expect(d).toEqual({ escalate: false, reason: 'in-flight-pane' });
  });

  it('evaluateCriticalFirstGuard: query succeeded and found no pane → escalate (no-live-pane), even with a fresh marker', () => {
    const inFlight: InFlightPanes = { available: true, itemIds: new Set() };
    const d = evaluateCriticalFirstGuard('WL-ABC', inFlight, new Date().toISOString(), Date.now(), 3_600_000);
    expect(d).toEqual({ escalate: true, reason: 'no-live-pane' });
  });

  it('evaluateCriticalFirstGuard: query unavailable + fresh marker → skip (in-flight-unverified)', () => {
    const inFlight: InFlightPanes = { available: false, itemIds: new Set() };
    const d = evaluateCriticalFirstGuard('WL-ABC', inFlight, new Date().toISOString(), Date.now(), 3_600_000);
    expect(d).toEqual({ escalate: false, reason: 'in-flight-unverified' });
  });

  it('evaluateCriticalFirstGuard: query unavailable + stale/absent marker → escalate (bounded, never starved)', () => {
    const inFlight: InFlightPanes = { available: false, itemIds: new Set() };
    const now = Date.now();
    expect(evaluateCriticalFirstGuard('WL-ABC', inFlight, new Date(now - 2 * 3_600_000).toISOString(), now, 3_600_000))
      .toEqual({ escalate: true, reason: 'marker-stale-escalation' });
    expect(evaluateCriticalFirstGuard('WL-ABC', inFlight, undefined, now, 3_600_000))
      .toEqual({ escalate: true, reason: 'marker-stale-escalation' });
  });

  it('resolveInFlightPanes: unavailable dep / thrown resolver / no records all resolve unavailable (never throws)', async () => {
    expect(await resolveInFlightPanes({}, '/repo')).toEqual({ available: false, itemIds: new Set() });
    expect(await resolveInFlightPanes(
      { getRunningDowntimePanes: vi.fn().mockRejectedValue(new Error('boom')) },
      '/repo',
    )).toEqual({ available: false, itemIds: new Set() });
    expect(await resolveInFlightPanes(
      { getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: false, error: 'down' }) },
      '/repo',
    )).toEqual({ available: false, itemIds: new Set() });
    // Legacy result with only count/paneIds → unavailable (a bare count must
    // never be used as an item-scoped signal).
    expect(await resolveInFlightPanes(
      { getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 2, paneIds: ['a', 'b'] }) },
      '/repo',
    )).toEqual({ available: false, itemIds: new Set() });
  });

  it('resolveInFlightPanes: an available query with records resolves the working item ids', async () => {
    const result = await resolveInFlightPanes(
      {
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true, count: 1, paneIds: ['w1:p1'],
          records: [pane({ paneId: 'w1:p1', label: 'Downtime triggered implement A - WL-A', agentStatus: 'working' })],
        }),
      },
      '/repo',
    );
    expect(result.available).toBe(true);
    expect([...result.itemIds]).toEqual(['WL-A']);
  });
});

describe('dispatchDowntimeWork: running-pane / owner / contention gates', () => {
  function dispatchableDeps() {
    return makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });
  }

  it('dispatches without consulting any live-pane count (WL-0MU2EP6JL006A1U3)', async () => {
    // Regression: panes deliberately stay open until an operator closes them,
    // so the number of live panes must never gate dispatch.
    const deps = dispatchableDeps();
    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
    });
    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('refuses an owned slot (slot-owned)', async () => {
    const deps = dispatchableDeps();
    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      slotOwned: true,
    });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('slot-owned');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('backs off while the proxy reports contention (proxy-contention)', async () => {
    const deps = dispatchableDeps();
    const outcome = await dispatchDowntimeWork(deps, {
      model: 'plan',
      cwd: '/repo',
      contentionQueueDepth: 3,
    });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('proxy-contention');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

});

describe('worker tick: the LLM idle check is the sole concurrency limiter (WL-0MU2EP6JL006A1U3)', () => {
  function makeSingleSlotWorker(opts: {
    status: LlamaStatus;
    runningPanes: () => { ok: true; count: number } | { ok: false; error?: string };
    requiredFreeSlots?: number;
  }) {
    const cfg = {
      enabled: true,
      thresholdMs: 1_000,
      requiredFreeSlots: opts.requiredFreeSlots ?? 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
    };
    const poller = createDowntimePoller(
      'http://proxy:8000',
      vi.fn().mockResolvedValue(jsonResponseFixture(opts.status)),
    );
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      getRunningDowntimePanes: vi.fn().mockImplementation(async () => opts.runningPanes()),
    });
    const worker = createDowntimeWorker({ poller, deps, config: () => ({ ...cfg }) });
    return { worker, deps };
  }

  it('live dispatch panes do not block dispatch while the LLM is idle (WL-0MU2EP6JL006A1U3)', async () => {
    vi.useFakeTimers();
    try {
      // Regression for the overnight stall: previously dispatched panes stay
      // OPEN until an operator closes them, so a live-pane count must never be
      // a dispatch gate. The LLM is idle and several panes are open → the next
      // item still dispatches.
      const { worker, deps } = makeSingleSlotWorker({
        status: idleAllSlotsFree,
        runningPanes: () => ({ ok: true, count: 3 }),
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed liveness query does not stall dispatch (WL-0MU2EP6JL006A1U3)', async () => {
    vi.useFakeTimers();
    try {
      // The pane-liveness probe now only feeds the owner-lease qualifier, so a
      // `herdr pane list` failure must not silently stop the dispatcher. The
      // proxy's own lease signal still gates slot capacity.
      const { worker, deps } = makeSingleSlotWorker({
        status: idleAllSlotsFree,
        runningPanes: () => ({ ok: false, error: 'herdr down' }),
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const outcome = await worker.tick();
      expect(outcome.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an idle-but-owned slot prevents dispatch (AC2/AC3)', async () => {
    vi.useFakeTimers();
    try {
      // Single slot, idle by is_processing, but a live lease is held AND the
      // slot is owned by a live pane → the owner gate refuses the dispatch.
      const { worker, deps } = makeSingleSlotWorker({
        status: {
          ...idleAllSlotsFree,
          available_slots: 1,
          total_slots: 1,
          local_lease_active: true,
          local_owner_session_id: 'session-live',
          local_owner_lease_remaining_seconds: 120,
          slots: [
            { slot_id: 'slot-1', is_processing: false, owner_session_id: 'session-live' },
          ],
        },
        runningPanes: () => ({ ok: true, count: 1 }),
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const blocked = await worker.tick();
      expect(blocked.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off while the proxy reports contention (AC6)', async () => {
    vi.useFakeTimers();
    try {
      const { worker, deps } = makeSingleSlotWorker({
        status: idleWithContention,
        runningPanes: () => ({ ok: true, count: 0 }),
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const blocked = await worker.tick();
      expect(blocked.dispatched).toBe(false);
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches when only the cumulative contention counter is non-zero (depth 0, WL-0MU1DWXO600153OI)', async () => {
    vi.useFakeTimers();
    try {
      // Regression: `contention_queued_count` is cumulative and stays > 0
      // after any past queue event; it must never gate dispatch. With the
      // live depth at 0 the worker dispatches.
      const { worker, deps } = makeSingleSlotWorker({
        status: idleWithCumulativeContention,
        runningPanes: () => ({ ok: true, count: 0 }),
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const result = await worker.tick();
      expect(result.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not block operator spare-capacity dispatch when no dispatch pane is running', async () => {
    vi.useFakeTimers();
    try {
      // Operator holds a lease on a 3-slot setup (one slot processing) while
      // the worker has NO running pane → spare-capacity dispatch still fires
      // into the free slots.
      const { worker, deps } = makeSingleSlotWorker({
        status: perSlotThreeOfFourFree,
        runningPanes: () => ({ ok: true, count: 0 }),
        requiredFreeSlots: 2,
      });
      const start = 1_000_000;
      vi.setSystemTime(start);
      await worker.tick();
      vi.setSystemTime(start + 5_000);
      const result = await worker.tick();
      expect(result.dispatched).toBe(true);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── onProxyIdle callback (WL-0MU4MKVR4005WPBJ) ────────────────────────

  describe('onProxyIdle callback', () => {
    it('calls the callback with the proxy status when the proxy is idle', async () => {
      vi.useFakeTimers();
      try {
        const callback = vi.fn().mockResolvedValue(undefined);
        const poller = createDowntimePoller(
          'http://proxy:8000',
          async () => ({
            ok: true,
            status: 200,
            json: async () => idleAllSlotsFree,
          }),
        );
        const worker = createDowntimeWorker({
          poller,
          deps: makeDeps(),
          config: () => ({
            enabled: true,
            thresholdMs: 0, // instant dispatch
            requiredFreeSlots: 0,
            model: 'plan',
            cwd: '/repo',
            noCandidateCooldownMs: 3_600_000,
            browseItemCount: 20,
          }),
          onProxyIdle: callback,
        });
        vi.setSystemTime(1_000_000);
        const result = await worker.tick();
        expect(result.idle).toBe(true);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(idleAllSlotsFree);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not call the callback when the proxy is busy', async () => {
      vi.useFakeTimers();
      try {
        const callback = vi.fn().mockResolvedValue(undefined);
        const poller = createDowntimePoller(
          'http://proxy:8000',
          async () => ({
            ok: true,
            status: 200,
            json: async () => busyActiveQuery,
          }),
        );
        const worker = createDowntimeWorker({
          poller,
          deps: makeDeps(),
          config: () => ({
            enabled: true,
            thresholdMs: 0,
            requiredFreeSlots: 0,
            model: 'plan',
            cwd: '/repo',
            noCandidateCooldownMs: 3_600_000,
            browseItemCount: 20,
          }),
          onProxyIdle: callback,
        });
        vi.setSystemTime(1_000_000);
        const result = await worker.tick();
        expect(result.dispatched).toBe(false);
        expect(result.idle).toBe(false);
        expect(callback).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('calls the callback when the proxy is idle but threshold not met', async () => {
      vi.useFakeTimers();
      try {
        const callback = vi.fn().mockResolvedValue(undefined);
        const poller = createDowntimePoller(
          'http://proxy:8000',
          async () => ({
            ok: true,
            status: 200,
            json: async () => idleAllSlotsFree,
          }),
        );
        const worker = createDowntimeWorker({
          poller,
          deps: makeDeps(),
          config: () => ({
            enabled: true,
            thresholdMs: 60_000, // 60 s threshold — not yet met
            requiredFreeSlots: 0,
            model: 'plan',
            cwd: '/repo',
            noCandidateCooldownMs: 3_600_000,
            browseItemCount: 20,
          }),
          onProxyIdle: callback,
        });
        vi.setSystemTime(1_000_000);
        const result = await worker.tick();
        expect(result.dispatched).toBe(false);
        expect(result.idle).toBe(true); // proxy is idle, just threshold not met
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(idleAllSlotsFree);
      } finally {
        vi.useRealTimers();
      }
    });

    it('fires the callback BEFORE dispatching the next item (ordering)', async () => {
      vi.useFakeTimers();
      try {
        // The operator requirement (WL-0MU4MKVR4005WPBJ): the mode-switch
        // check must run before a new item is sent, so the item is served by
        // the (possibly newly) cheap pool. Record the invocation order.
        const order: string[] = [];
        const callback = vi.fn().mockImplementation(async () => {
          order.push('onProxyIdle');
        });
        const deps = makeDeps({
          getNextItem: vi.fn().mockResolvedValue({
            ok: true,
            candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
          }),
          spawnAgentPane: vi.fn().mockImplementation(async () => {
            order.push('spawn');
            return { ok: true };
          }),
          getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
        });
        const poller = createDowntimePoller(
          'http://proxy:8000',
          vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree)),
        );
        const worker = createDowntimeWorker({
          poller,
          deps,
          config: () => ({
            enabled: true,
            thresholdMs: 1_000,
            requiredFreeSlots: 0,
            model: 'plan',
            cwd: '/repo',
            noCandidateCooldownMs: 3_600_000,
            browseItemCount: 20,
          }),
          onProxyIdle: callback,
        });
        const start = 1_000_000;
        vi.setSystemTime(start);
        await worker.tick(); // starts the idle run
        vi.setSystemTime(start + 5_000);
        const outcome = await worker.tick(); // idle + ready → dispatch
        expect(outcome.dispatched).toBe(true);
        // The callback fires on EVERY idle poll (the mode-switch worker has
        // its own operator-idle window), so both ticks trigger it.
        expect(callback).toHaveBeenCalledTimes(2);
        // The check fires before the item is dispatched.
        expect(order).toEqual(['onProxyIdle', 'onProxyIdle', 'spawn']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not crash when the callback throws', async () => {
      vi.useFakeTimers();
      try {
        const callback = vi.fn().mockRejectedValue(new Error('callback failed'));
        const poller = createDowntimePoller(
          'http://proxy:8000',
          async () => ({
            ok: true,
            status: 200,
            json: async () => idleAllSlotsFree,
          }),
        );
        const worker = createDowntimeWorker({
          poller,
          deps: makeDeps(),
          config: () => ({
            enabled: true,
            thresholdMs: 0,
            requiredFreeSlots: 0,
            model: 'plan',
            cwd: '/repo',
            noCandidateCooldownMs: 3_600_000,
            browseItemCount: 20,
          }),
          onProxyIdle: callback,
        });
        vi.setSystemTime(1_000_000);
        const result = await worker.tick();
        // Callback rejected but the worker did not crash or block
        expect(result.idle).toBe(true);
        expect(callback).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ── Pane-lifecycle monitor (WL-0MU308WSF0002JWN) — DISABLED ─────────
//
// Mechanism B is switched off in the worker (WL-0MUMEKDK0008LKH8):
// `PANE_LIFECYCLE_MONITOR_ENABLED` is false, so the tick never calls
// `monitorDispatchedPanes` (pinned by the tick integration suite below).
// These unit tests are RETAINED to pin the pure classifier contract — what
// the monitor WOULD do if re-enabled: it inspects every dispatched pane
// recorded in the rolling log (marker + post-spawn enrichment), classifies
// its lifecycle outcome, logs a pane-close entry, and closes the pane —
// EXCEPT `implement` panes, which are never auto-closed (AC6). Every boundary
// is fail-closed (AC7).
describe('pane-lifecycle monitor (WL-0MU308WSF0002JWN) [disabled behaviour]', () => {
  const roots = createTempDirTracker();

  function makeRoot(): string {
    return roots.make('pane-lifecycle-');
  }

  afterEach(() => {
    roots.cleanup();
  });

  /** Seed a dispatch marker + its post-spawn enrichment (paneId) entry. */
  async function seedDispatch(
    root: string,
    opts: { itemId: string; kind: string; paneId: string; stage?: string; title?: string },
  ): Promise<void> {
    const marker = {
      itemId: opts.itemId,
      kind: opts.kind,
      dispatchedAt: '2026-01-01T00:00:00.000Z',
      cwd: root,
      title: opts.title ?? opts.itemId,
      stage: opts.stage ?? 'idea',
    };
    await appendDowntimeLogEntry(root, JSON.stringify(marker));
    await appendDowntimeLogEntry(root, JSON.stringify({ ...marker, paneId: opts.paneId, enrichment: true }));
  }

  /** Deps with a real (rolling-log-appending) recordPaneClose so idempotency works. */
  function monitorDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
    return makeDeps({
      recordPaneClose: vi.fn(async (entry, cwd) => {
        await appendPaneCloseLogEntry(cwd, entry);
      }),
      ...overrides,
    });
  }

  async function paneCloseEntries(root: string) {
    return (await readDowntimeLogEntries(root)).filter((e) => e.entryType === 'pane-close');
  }

  it('closes an intake pane and logs closed-as-intake-complete when the item reaches intake_complete', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-1', kind: 'intake', paneId: 'w1:p1', stage: 'idea', title: 'Intake me' });
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-1', title: 'Intake me', stage: 'intake_complete' }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 1, records: [{ paneId: 'w1:p1' }] }),
      closePane,
    });

    const res = await monitorDispatchedPanes(deps, root);

    expect(res).toMatchObject({ checked: 1, logged: 1, closed: 1, errors: 0 });
    expect(closePane).toHaveBeenCalledWith('w1:p1', root, { itemId: 'WL-1', kind: 'intake' });
    const pc = await paneCloseEntries(root);
    expect(pc).toHaveLength(1);
    expect(pc[0]).toMatchObject({
      entryType: 'pane-close',
      itemId: 'WL-1',
      itemTitle: 'Intake me',
      paneId: 'w1:p1',
      kind: 'intake',
      outcome: 'closed-as-intake-complete',
      closed: true,
    });
  });

  it('closes a plan pane and logs closed-as-plan-complete when the item reaches plan_complete', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-2', kind: 'plan', paneId: 'w1:p2', stage: 'intake_complete' });
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-2', stage: 'plan_complete' }),
      closePane,
    });

    const res = await monitorDispatchedPanes(deps, root);

    expect(res).toMatchObject({ logged: 1, closed: 1 });
    expect(closePane).toHaveBeenCalledWith('w1:p2', root, { itemId: 'WL-2', kind: 'plan' });
    expect((await paneCloseEntries(root))[0]).toMatchObject({ outcome: 'closed-as-plan-complete', closed: true });
  });

  it('closes an audit pane and records the pass/fail verdict (AC5)', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-3', kind: 'audit', paneId: 'w1:p3', stage: 'in_review' });
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockResolvedValue({
        id: 'WL-3', stage: 'in_review', auditedAt: '2026-01-02T00:00:00.000Z', auditResult: false,
      }),
      closePane,
    });

    const res = await monitorDispatchedPanes(deps, root);

    expect(res).toMatchObject({ logged: 1, closed: 1 });
    expect(closePane).toHaveBeenCalledWith('w1:p3', root, { itemId: 'WL-3', kind: 'audit' });
    expect((await paneCloseEntries(root))[0]).toMatchObject({ outcome: 'audit-failed', closed: true });
  });

  it('NEVER closes an implement pane but still logs its in_review completion (AC4/AC6)', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-4', kind: 'implement', paneId: 'w1:p4', stage: 'plan_complete' });
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-4', stage: 'in_review' }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 1, records: [{ paneId: 'w1:p4' }] }),
      closePane,
    });

    const res = await monitorDispatchedPanes(deps, root);

    expect(res).toMatchObject({ logged: 1, closed: 0 });
    expect(closePane).not.toHaveBeenCalled();
    expect((await paneCloseEntries(root))[0]).toMatchObject({
      outcome: 'requires-attention',
      reasonCode: 'reached-in-review',
      closed: false,
    });
  });

  it('is idempotent: a second pass with no state change writes no duplicate entry', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-5', kind: 'plan', paneId: 'w1:p5', stage: 'intake_complete' });
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-5', stage: 'plan_complete' }),
      closePane,
    });

    const first = await monitorDispatchedPanes(deps, root);
    const second = await monitorDispatchedPanes(deps, root);

    expect(first).toMatchObject({ logged: 1, closed: 1 });
    expect(second).toMatchObject({ logged: 0, closed: 0 });
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(await paneCloseEntries(root)).toHaveLength(1);
  });

  it('logs a NEW entry when the item changes state again (agent-ended → plan_complete)', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-6', kind: 'plan', paneId: 'w1:p6', stage: 'intake_complete' });
    const noLivePanes = vi.fn().mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] });
    // First pass: the agent session has ended but the item is NOT terminal.
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-6', stage: 'intake_complete' }),
      getRunningDowntimePanes: noLivePanes,
      closePane: vi.fn().mockResolvedValue(true),
    });
    await monitorDispatchedPanes(deps, root);

    // The item then advances — a second outcome must be recorded.
    deps.getItemLifecycleState = vi.fn().mockResolvedValue({ id: 'WL-6', stage: 'plan_complete' });
    await monitorDispatchedPanes(deps, root);

    const outcomes = (await paneCloseEntries(root)).map((e) => e.outcome);
    expect(outcomes).toEqual(['requires-attention', 'closed-as-plan-complete']);
  });

  it('does NOT act on unknown liveness when the item has not reached a terminal (fail-open)', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-7', kind: 'plan', paneId: 'w1:p7', stage: 'intake_complete' });
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-7', stage: 'intake_complete' }),
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: false, error: 'herdr down' }),
      closePane,
    });

    const res = await monitorDispatchedPanes(deps, root);

    expect(res).toMatchObject({ checked: 1, logged: 0, closed: 0, errors: 0 });
    expect(closePane).not.toHaveBeenCalled();
    expect(await paneCloseEntries(root)).toEqual([]);
  });

  it('is fail-closed: a throwing closePane still logs the outcome (closed:false) and never throws (AC7)', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-8', kind: 'intake', paneId: 'w1:p8', stage: 'idea' });
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-8', stage: 'intake_complete' }),
      closePane: vi.fn().mockRejectedValue(new Error('herdr: pane not found')),
    });

    const res = await monitorDispatchedPanes(deps, root);

    expect(res).toMatchObject({ checked: 1, logged: 1, closed: 0, errors: 0 });
    expect((await paneCloseEntries(root))[0]).toMatchObject({ closed: false });
  });

  it('is fail-closed: a throwing item lookup counts an error and never throws (AC7)', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-9', kind: 'plan', paneId: 'w1:p9' });
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockRejectedValue(new Error('wl exploded')),
      closePane: vi.fn().mockResolvedValue(true),
    });

    const res = await monitorDispatchedPanes(deps, root);

    expect(res).toMatchObject({ checked: 1, logged: 0, errors: 1 });
  });

  it('continues past a bad pane so later panes still process (AC7)', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-BAD', kind: 'plan', paneId: 'w1:pA' });
    await seedDispatch(root, { itemId: 'WL-GOOD', kind: 'intake', paneId: 'w1:pB' });
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn(async (itemId: string) => {
        if (itemId === 'WL-BAD') throw new Error('wl exploded');
        return { id: itemId, stage: 'intake_complete' };
      }),
      closePane,
    });

    const res = await monitorDispatchedPanes(deps, root);

    expect(res).toMatchObject({ checked: 2, logged: 1, closed: 1, errors: 1 });
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith('w1:pB', root, { itemId: 'WL-GOOD', kind: 'intake' });
  });

  it('is a no-op when the item-state dep is absent (legacy callers)', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-10', kind: 'plan', paneId: 'w1:p10', stage: 'intake_complete' });
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({ closePane });

    const res = await monitorDispatchedPanes(deps, root);

    expect(res).toMatchObject({ checked: 0, logged: 0, closed: 0, errors: 0 });
    expect(closePane).not.toHaveBeenCalled();
  });

  it('logs requires-attention for an item awaiting producer review (AC3)', async () => {
    const root = makeRoot();
    await seedDispatch(root, { itemId: 'WL-11', kind: 'plan', paneId: 'w1:p11', stage: 'intake_complete' });
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = monitorDeps({
      getItemLifecycleState: vi.fn().mockResolvedValue({
        id: 'WL-11', stage: 'intake_complete', needsProducerReview: true,
      }),
      closePane,
    });

    await monitorDispatchedPanes(deps, root);

    expect(closePane).toHaveBeenCalledWith('w1:p11', root, { itemId: 'WL-11', kind: 'plan' });
    expect((await paneCloseEntries(root))[0]).toMatchObject({
      outcome: 'requires-attention',
      reasonCode: 'producer-review',
      closed: true,
    });
  });

  // ── Warn-level observability (WL-0MU4USJ07009JYL8 AC2/AC6) ──────────
  // Every fail-closed catch must emit a stderr warn (never silent) so a
  // production failure is diagnosable without a debugger.
  function stderrMessages(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.map((c) => String(c[0])).join('\n');
  }

  it('warns on a failed pane close (AC2)', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const root = makeRoot();
      await seedDispatch(root, { itemId: 'WL-W1', kind: 'intake', paneId: 'w1:pW1' });
      const deps = monitorDeps({
        getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-W1', stage: 'intake_complete' }),
        closePane: vi.fn().mockRejectedValue(new Error('herdr: boom')),
      });
      await monitorDispatchedPanes(deps, root);
      expect(stderrMessages(spy)).toContain('pane close failed for w1:pW1');
    } finally {
      spy.mockRestore();
    }
  });

  it('warns on a failed item lookup (AC2)', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const root = makeRoot();
      await seedDispatch(root, { itemId: 'WL-W2', kind: 'plan', paneId: 'w1:pW2' });
      const deps = monitorDeps({
        getItemLifecycleState: vi.fn().mockRejectedValue(new Error('wl exploded')),
      });
      await monitorDispatchedPanes(deps, root);
      expect(stderrMessages(spy)).toContain('item lookup failed for WL-W2');
    } finally {
      spy.mockRestore();
    }
  });

  it('warns on a failed pane-close log write (AC2)', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const root = makeRoot();
      await seedDispatch(root, { itemId: 'WL-W3', kind: 'plan', paneId: 'w1:pW3' });
      const deps = monitorDeps({
        getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-W3', stage: 'plan_complete' }),
        closePane: vi.fn().mockResolvedValue(true),
        recordPaneClose: vi.fn().mockRejectedValue(new Error('disk full')),
      });
      const res = await monitorDispatchedPanes(deps, root);
      expect(res).toMatchObject({ logged: 0, errors: 1 });
      expect(stderrMessages(spy)).toContain('pane-close log write failed for w1:pW3');
    } finally {
      spy.mockRestore();
    }
  });

  it('warns when the live-pane query fails (AC2) and still fails open', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const root = makeRoot();
      await seedDispatch(root, { itemId: 'WL-W4', kind: 'plan', paneId: 'w1:pW4' });
      const closePane = vi.fn().mockResolvedValue(true);
      const deps = monitorDeps({
        getItemLifecycleState: vi.fn().mockResolvedValue({ id: 'WL-W4', stage: 'plan_complete' }),
        getRunningDowntimePanes: vi.fn().mockRejectedValue(new Error('herdr down')),
        closePane,
      });
      const res = await monitorDispatchedPanes(deps, root);
      // The terminal-stage close still happens (liveness is only needed for
      // agent-done detection) — fail-open, not fail-closed, on liveness.
      expect(res).toMatchObject({ logged: 1, closed: 1 });
      expect(stderrMessages(spy)).toContain('live-pane query threw');
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Worker tick ↔ pane-lifecycle integration (WL-0MU4US5MP001JFEN) ────
//
// Mechanism B is DISABLED (WL-0MUMEKDK0008LKH8): the worker tick must NOT
// invoke the dispatch monitor, so the scheduled reaper (Mechanism A) is the
// only active auto-close path. These tests pin that disabled behaviour and
// that Mechanism A still runs from the tick.
describe('worker tick pane-lifecycle integration (WL-0MU4US5MP001JFEN) [disabled]', () => {
  const roots = createTempDirTracker();

  afterEach(() => {
    roots.cleanup();
  });

  function makeRoot(): string {
    return roots.make('pane-monitor-tick-');
  }

  async function seedDispatch(root: string, itemId: string, kind: string, paneId: string): Promise<void> {
    const marker = {
      itemId, kind, dispatchedAt: new Date().toISOString(), cwd: root, title: itemId, stage: 'intake_complete',
    };
    await appendDowntimeLogEntry(root, JSON.stringify(marker));
    await appendDowntimeLogEntry(root, JSON.stringify({ ...marker, paneId, enrichment: true }));
  }

  function makeMonitorWorker(
    root: string,
    deps: Partial<DowntimeWorkerDeps>,
    paneClose?: { enabled: boolean; idleThresholdMinutes: number },
  ) {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const worker = createDowntimeWorker({
      poller,
      deps: makeDeps({ getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }), ...deps }),
      config: () => ({
        enabled: true,
        thresholdMs: 1,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: root,
        noCandidateCooldownMs: 3_600_000,
        paneLifecycleIntervalMs: 0,
        ...(paneClose ? { paneClose } : {}),
      }),
    });
    return worker;
  }

  it('does NOT invoke the dispatch monitor from the worker tick (Mechanism B disabled, WL-0MUMEKDK0008LKH8)', async () => {
    const root = makeRoot();
    await seedDispatch(root, 'WL-TICK', 'plan', 'w9:p1');
    const closePane = vi.fn().mockResolvedValue(true);
    const getItemLifecycleState = vi.fn().mockResolvedValue({ id: 'WL-TICK', stage: 'plan_complete' });
    const worker = makeMonitorWorker(root, {
      getItemLifecycleState,
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: true, count: 1, records: [{ paneId: 'w9:p1' }] }),
      closePane,
    });

    await worker.tick();
    // Give a hypothetically-enabled (fire-and-forget) monitor time to act
    // before asserting the negative, so the assertion is meaningful.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(getItemLifecycleState).not.toHaveBeenCalled();
    expect(closePane).not.toHaveBeenCalled();
    const pc = (await readDowntimeLogEntries(root)).filter((e) => e.entryType === 'pane-close');
    expect(pc).toHaveLength(0);
  });

  it('still runs the scheduled reaper (Mechanism A) from the worker tick', async () => {
    const root = makeRoot();
    const getItemLifecycleState = vi.fn().mockResolvedValue({ id: 'WL-TICK', stage: 'plan_complete' });
    const runPaneCloseReaper = vi.fn().mockResolvedValue(undefined);
    const worker = makeMonitorWorker(
      root,
      { getItemLifecycleState, runPaneCloseReaper },
      { enabled: true, idleThresholdMinutes: 30 },
    );

    await worker.tick();

    await vi.waitFor(() => expect(runPaneCloseReaper).toHaveBeenCalledWith(
      root,
      { idleThresholdMinutes: 30, ledgerPath: undefined },
    ));
    // Mechanism B remains off — the reaper is the only active auto-close path.
    expect(getItemLifecycleState).not.toHaveBeenCalled();
  });
});
