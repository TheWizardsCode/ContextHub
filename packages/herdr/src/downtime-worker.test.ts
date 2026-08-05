/**
 * Unit tests for downtime-worker.ts — Local-LLM downtime worker contract
 *
 * Test-first contract for the herdr downtime worker (WL-0MSG7ZTC000163FL,
 * parent WL-0MSF49FMW009M06K). Follows the repo convention of a dedicated
 * test-suite feature created before the implementation features
 * (cf. WL-0MQD1N3JD007B0FZ).
 *
 * Green suites test the parts implemented so far (idle detection,
 * blocked-questions prompt, settings clamps, fixture coherence, the poller
 * and fail-closed parsing from WL-0MSG80254005ZNE9, and the idle tracker,
 * dispatch orchestration, pane spawn and worker orchestrator from
 * WL-0MSG80AG700429M8).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isIdleStatus,
  evaluateIdle,
  parseLlamaStatus,
  fetchLocalStatus,
  createDowntimePoller,
  createIdleTracker,
  dispatchDowntimeWork,
  createDowntimeWorker,
  buildDowntimePrompt,
  buildDowntimePaneArgs,
  spawnDowntimePane,
  buildDowntimeSpawnOptions,
  BLOCKED_QUESTIONS_INSTRUCTION,
  parseNextItemOutput,
  skillKindFromPrompt,
  clampDowntimePollInterval,
  clampDowntimeIdleThresholdMs,
  clampDowntimeRequiredFreeSlots,
  DOWNTIME_POLL_INTERVAL_FLOOR_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  type LlamaStatus,
  type LlamaStatusFetcher,
  type DowntimeCandidate,
  type DowntimeWorkerDeps,
  type DowntimeSpawn,
} from './downtime-worker.js';
import {
  statusFixtures,
  ambiguousMissingFieldsRaw,
  idleAllSlotsFree,
  networkErrorFixture,
  timeoutErrorFixture,
  httpErrorResponseFixture,
  jsonResponseFixture,
  type LlamaStatusHttpResponse,
} from './downtime-worker.fixtures.js';

/** Shared deps mock for dispatch tests. */
function makeDeps(overrides: Partial<DowntimeWorkerDeps> = {}): DowntimeWorkerDeps {
  return {
    getNextItem: vi.fn().mockResolvedValue(null),
    claimItem: vi.fn().mockResolvedValue(undefined),
    spawnAgentPane: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Fixture coherence (AC1) ───────────────────────────────────────────

describe('downtime worker fixtures', () => {
  it.each(statusFixtures)(
    '$name is classified idle=$expectedIdle by isIdleStatus (N=0)',
    (fixture) => {
      expect(isIdleStatus(fixture.status, 0)).toBe(fixture.expectedIdle);
    },
  );

  it('a raw payload with missing slot fields is treated as busy (fail-closed)', () => {
    const partial = ambiguousMissingFieldsRaw as unknown as LlamaStatus;
    expect(isIdleStatus(partial, 0)).toBe(false);
  });
});

// ── Idle detection (AC2) ──────────────────────────────────────────────

describe('idle detection (isIdleStatus)', () => {
  const idle: LlamaStatus = {
    llama_server_running: true,
    active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 4,
    total_slots: 4,
  };

  it('is idle when the server is up, nothing active, and all slots free', () => {
    expect(isIdleStatus(idle, 0)).toBe(true);
  });

  it('is busy when llama-server is not running', () => {
    expect(isIdleStatus({ ...idle, llama_server_running: false }, 0)).toBe(false);
  });

  it('is busy while a query is active', () => {
    expect(isIdleStatus({ ...idle, active_query: true }, 0)).toBe(false);
  });

  it('is busy while a model switch is in progress', () => {
    expect(isIdleStatus({ ...idle, model_switch_in_progress: true }, 0)).toBe(false);
  });

  it('is busy while a local lease is active', () => {
    expect(isIdleStatus({ ...idle, local_lease_active: true }, 0)).toBe(false);
  });

  it('N=0 (default) requires ALL slots free', () => {
    expect(isIdleStatus({ ...idle, available_slots: 3 }, 0)).toBe(false);
    expect(isIdleStatus({ ...idle, available_slots: 4 }, 0)).toBe(true);
  });

  it('a positive N requires at least N slots free', () => {
    expect(isIdleStatus({ ...idle, available_slots: 2 }, 2)).toBe(true);
    expect(isIdleStatus({ ...idle, available_slots: 1 }, 2)).toBe(false);
  });

  it('N > total_slots can never be idle (never dispatches)', () => {
    expect(isIdleStatus({ ...idle, available_slots: 4 }, 5)).toBe(false);
  });

  it('ambiguous responses (total_slots 0 or missing fields) are busy', () => {
    expect(isIdleStatus({ ...idle, total_slots: 0, available_slots: 0 }, 0)).toBe(false);
    expect(isIdleStatus({ llama_server_running: true } as LlamaStatus, 0)).toBe(false);
  });

  it('non-finite or negative slot counts are busy', () => {
    expect(isIdleStatus({ ...idle, total_slots: Number.NaN }, 0)).toBe(false);
    expect(isIdleStatus({ ...idle, available_slots: -1 }, 0)).toBe(false);
  });
});

// ── Threshold timing (AC1/AC3) ────────────────────────────────────────

describe('threshold timing (idle-duration tracker)', () => {
  const thresholdMs = 240_000;

  it('dispatches only after idle has lasted the full threshold continuously', () => {
    const tracker = createIdleTracker();
    const start = 1_000_000;

    tracker.record(true, start);
    expect(tracker.idleSince).toBe(start);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs - 1)).toBe(false);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs)).toBe(true);
  });

  it('any busy poll resets the idle-since timestamp', () => {
    const tracker = createIdleTracker();
    const start = 1_000_000;

    tracker.record(true, start);
    tracker.record(false, start + 120_000);
    expect(tracker.idleSince).toBeNull();
    expect(tracker.isThresholdMet(thresholdMs, start + 360_000)).toBe(false);
  });

  it('keeps the idle run start fixed across consecutive idle polls', () => {
    const tracker = createIdleTracker();
    const start = 1_000_000;
    tracker.record(true, start);
    tracker.record(true, start + 30_000);
    tracker.record(true, start + 60_000);
    expect(tracker.idleSince).toBe(start);
    expect(tracker.isThresholdMet(thresholdMs, start + 60_000)).toBe(false);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs)).toBe(true);
  });
});

// ── Dispatch selection (AC2) ──────────────────────────────────────────

describe('dispatch selection', () => {
  it('runs /skill:plan on the next intake_complete item', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        id: 'WL-ABC',
        title: 'Some task',
        stage: 'intake_complete',
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenCalledWith('intake_complete');
    expect(deps.getNextItem).toHaveBeenCalledTimes(1);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-ABC');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-ABC'),
      { model: 'plan', cwd: '/repo' },
    );
  });

  it('claims the item BEFORE the pane spawns', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        id: 'WL-ABC',
        title: 'Some task',
        stage: 'intake_complete',
      }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.claimItem).toHaveBeenCalledWith('WL-ABC');
    const claimOrder = (deps.claimItem as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const spawnOrder = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(spawnOrder);
  });

  it('falls back to /skill:intake on the next idea item when none is intake_complete', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'WL-DEF', title: 'An idea', stage: 'idea' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea');
    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('WL-DEF');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-DEF');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-DEF'),
      expect.anything(),
    );
  });

  it('does not dispatch when no item exists in either stage', async () => {
    const deps = makeDeps();

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});

// ── Single-flight (AC5) ───────────────────────────────────────────────

describe('single-flight dispatch guard', () => {
  it('does not dispatch a second time while one dispatch is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        id: 'WL-ABC',
        title: 'Some task',
        stage: 'intake_complete',
      }),
      spawnAgentPane: vi.fn().mockImplementation(() => gate),
    });

    const first = dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    const second = dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    release();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(firstOutcome.dispatched).toBe(true);
    expect(secondOutcome.dispatched).toBe(false);
    expect(secondOutcome.reason).toBe('dispatch-in-flight');
  });

  it('allows a new dispatch once the previous one has completed', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        id: 'WL-ABC',
        title: 'Some task',
        stage: 'intake_complete',
      }),
    });

    const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(2);
  });
});

// ── Endpoint failures & poller (AC6) — implemented in F2 ──────────────

describe('endpoint failures and poller', () => {
  it('network errors are treated as busy and never throw', async () => {
    const fetcher = vi.fn().mockRejectedValue(networkErrorFixture);
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('timeouts are treated as busy and never throw', async () => {
    const fetcher = vi.fn().mockRejectedValue(timeoutErrorFixture);
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('HTTP error statuses are treated as busy', async () => {
    const fetcher = vi.fn().mockResolvedValue(httpErrorResponseFixture);
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('polls GET {proxyUrl}/llama/local/status', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await poller.poll();
    expect(fetcher).toHaveBeenCalledWith('http://proxy:8000/llama/local/status', expect.anything());
  });

  it('normalises a trailing slash on the proxy URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000/', fetcher);
    await poller.poll();
    expect(fetcher).toHaveBeenCalledWith('http://proxy:8000/llama/local/status', expect.anything());
  });

  it('returns the parsed status on a successful poll', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toEqual(idleAllSlotsFree);
  });

  it('treats invalid JSON as busy', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('treats payloads with missing required fields as busy', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(ambiguousMissingFieldsRaw));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    await expect(poller.poll()).resolves.toBeNull();
  });

  it('derives local_lease_active from the lease fields when the boolean is absent', async () => {
    const status = parseLlamaStatus({
      llama_server_running: true,
      active_query: false,
      model_switch_in_progress: false,
      available_slots: 4,
      total_slots: 4,
      local_owner_session_id: 'session-1',
      local_owner_lease_remaining_seconds: 120,
    });
    expect(status).not.toBeNull();
    expect(status!.local_lease_active).toBe(true);
    expect(evaluateIdle(status!, 0)).toBe(false);
  });

  it('coalesces overlapping polls (single-flight, no overlapping fetches)', async () => {
    let release!: () => void;
    const gate = new Promise<LlamaStatusHttpResponse>((resolve) => {
      release = () => resolve(jsonResponseFixture(idleAllSlotsFree));
    });
    const fetcher = vi.fn().mockImplementation(() => gate);
    const poller = createDowntimePoller('http://proxy:8000', fetcher);

    const first = poller.poll();
    expect(poller.isPolling()).toBe(true);
    const second = poller.poll();
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(idleAllSlotsFree);
    expect(secondResult).toBe(firstResult); // same coalesced result
    expect(poller.isPolling()).toBe(false);
  });

  it('aborts the request after the per-poll timeout (fail closed)', async () => {
    vi.useFakeTimers();
    let receivedSignal: unknown;
    const fetcher = vi.fn((_url: string, init?: { signal?: unknown }) => {
      receivedSignal = init?.signal;
      return new Promise<LlamaStatusHttpResponse>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const poller = createDowntimePoller('http://proxy:8000', fetcher, 5_000);
    const pollPromise = poller.poll();
    expect(receivedSignal).toBeDefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pollPromise).resolves.toBeNull();
    expect(poller.isPolling()).toBe(false);
    vi.useRealTimers();
  });
});

// ── Runtime idle evaluation (F2, AC5) ─────────────────────────────────

describe('runtime idle evaluation (evaluateIdle)', () => {
  const idle: LlamaStatus = {
    llama_server_running: true,
    active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 4,
    total_slots: 4,
  };

  it('N=0 (default) requires all slots free', () => {
    expect(evaluateIdle(idle, 0)).toBe(true);
    expect(evaluateIdle({ ...idle, available_slots: 3 }, 0)).toBe(false);
  });

  it('degrades 0 < N < total slots to ALL slots free (fail-closed, no per-slot data)', () => {
    // Without per-slot identity (LP-0MSG5TA7Y002GN39), N=2 with 4 slots
    // must NOT dispatch on "any 2 free" — it requires all 4 free.
    expect(evaluateIdle({ ...idle, available_slots: 2 }, 2)).toBe(false);
    expect(evaluateIdle({ ...idle, available_slots: 4 }, 2)).toBe(true);
  });

  it('N == total slots behaves like all slots free', () => {
    expect(evaluateIdle({ ...idle, available_slots: 4 }, 4)).toBe(true);
    expect(evaluateIdle({ ...idle, available_slots: 3 }, 4)).toBe(false);
  });

  it('N > total slots can never be idle (never dispatches)', () => {
    expect(evaluateIdle({ ...idle, available_slots: 4 }, 5)).toBe(false);
  });

  it('ambiguous responses (total_slots 0) are busy', () => {
    expect(evaluateIdle({ ...idle, total_slots: 0, available_slots: 0 }, 0)).toBe(false);
  });
});

// ── Blocked-questions prompt (AC7) ────────────────────────────────────

describe('blocked-questions prompt instruction', () => {
  const candidate: DowntimeCandidate = {
    id: 'WL-ABC',
    title: 'Some task',
    stage: 'intake_complete',
  };

  it('the plan prompt runs /skill:plan on the item id', () => {
    const prompt = buildDowntimePrompt('plan', candidate);
    expect(prompt).toContain('/skill:plan WL-ABC');
  });

  it('the intake prompt runs /skill:intake on the item id', () => {
    const prompt = buildDowntimePrompt('intake', { ...candidate, stage: 'idea' });
    expect(prompt).toContain('/skill:intake WL-ABC');
  });

  it('instructs recording questions in a comment, flagging needs-producer-review, and stopping', () => {
    const prompt = buildDowntimePrompt('plan', candidate);
    expect(prompt).toContain('comment');
    expect(prompt).toContain('--needs-producer-review true');
    expect(prompt).toContain('stop');
    expect(BLOCKED_QUESTIONS_INSTRUCTION).toContain('wl comment add');
    expect(BLOCKED_QUESTIONS_INSTRUCTION).toContain('wl update <id> --needs-producer-review true');
  });
});

// ── Settings clamps (AC8) ─────────────────────────────────────────────

describe('downtime settings clamps', () => {
  it('clampDowntimePollInterval enforces the 10s floor and keeps valid values', () => {
    expect(clampDowntimePollInterval(5_000)).toBe(DOWNTIME_POLL_INTERVAL_FLOOR_MS);
    expect(clampDowntimePollInterval(10_000)).toBe(10_000);
    expect(clampDowntimePollInterval(45_000)).toBe(45_000);
  });

  it('clampDowntimePollInterval falls back to the 30s default for non-finite values', () => {
    expect(clampDowntimePollInterval(Number.NaN)).toBe(DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
    expect(clampDowntimePollInterval(Infinity)).toBe(DEFAULT_DOWNTIME_POLL_INTERVAL_MS);
  });

  it('clampDowntimeIdleThresholdMs rejects negative and non-finite values', () => {
    expect(clampDowntimeIdleThresholdMs(-1)).toBe(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    expect(clampDowntimeIdleThresholdMs(Number.NaN)).toBe(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
  });

  it('clampDowntimeIdleThresholdMs keeps valid values and floors at 1s', () => {
    expect(clampDowntimeIdleThresholdMs(240_000)).toBe(240_000);
    expect(clampDowntimeIdleThresholdMs(0)).toBe(1_000);
  });

  it('clampDowntimeRequiredFreeSlots maps negative/non-finite to 0 (all slots) and rounds', () => {
    expect(clampDowntimeRequiredFreeSlots(-3)).toBe(0);
    expect(clampDowntimeRequiredFreeSlots(Number.NaN)).toBe(0);
    expect(clampDowntimeRequiredFreeSlots(2.7)).toBe(3);
    expect(clampDowntimeRequiredFreeSlots(2)).toBe(2);
  });
});

// ── Wiring helpers (F4) ───────────────────────────────────────────────

describe('parseNextItemOutput', () => {
  it('parses the workItem from `wl next --stage <stage> --json`', () => {
    const stdout = JSON.stringify({ success: true, workItem: { id: 'WL-ABC', title: 'Some task' } });
    expect(parseNextItemOutput(stdout, 'intake_complete')).toEqual({
      id: 'WL-ABC',
      title: 'Some task',
      stage: 'intake_complete',
    });
  });

  it('returns null when wl next reports no item (workItem null)', () => {
    const stdout = JSON.stringify({ success: false, workItem: null, reason: 'no items' });
    expect(parseNextItemOutput(stdout, 'idea')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseNextItemOutput('not json', 'idea')).toBeNull();
  });

  it('returns null when the workItem lacks an id', () => {
    const stdout = JSON.stringify({ success: true, workItem: { title: 'no id' } });
    expect(parseNextItemOutput(stdout, 'idea')).toBeNull();
  });
});

describe('skillKindFromPrompt', () => {
  it('derives plan from a /skill:plan prompt and intake otherwise', () => {
    expect(skillKindFromPrompt('Run /skill:plan WL-ABC — Task.')).toBe('plan');
    expect(skillKindFromPrompt('Run /skill:intake WL-DEF — Idea.')).toBe('intake');
  });
});

describe('downtime worker enabled state', () => {
  it('exposes the enabled flag from the per-tick config', async () => {
    const cfg = { enabled: true };
    const worker = createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      config: () => ({
        enabled: cfg.enabled,
        thresholdMs: 240_000,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
      }),
    });
    expect(worker.enabled).toBe(true);
    cfg.enabled = false;
    expect(worker.enabled).toBe(false);
  });
});

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

  it('spawns via the injectable spawn and unrefs the child', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() })) as unknown as DowntimeSpawn;

    spawnDowntimePane('/path/to/send-to-pi.sh', ['--no-focus', 'prompt'], { cwd: '/repo' }, spawnFn);

    expect(spawnFn).toHaveBeenCalledWith('/path/to/send-to-pi.sh', ['--no-focus', 'prompt'], {
      cwd: '/repo',
    });
    const handle = (spawnFn as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(handle.unref).toHaveBeenCalled();
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
});

// ── Worker orchestrator (AC1/AC5) ─────────────────────────────────────

describe('downtime worker orchestrator (createDowntimeWorker)', () => {
  function makeWorker(overrides: {
    enabled?: boolean;
    thresholdMs?: number;
    status?: unknown;
    deps?: Partial<DowntimeWorkerDeps>;
  } = {}) {
    const cfg = {
      enabled: overrides.enabled ?? true,
      thresholdMs: overrides.thresholdMs ?? 240_000,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponseFixture(overrides.status ?? idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        id: 'WL-ABC',
        title: 'Some task',
        stage: 'intake_complete',
      }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing (no poll, no dispatch) when disabled', async () => {
    const { worker, deps, fetcher } = makeWorker({ enabled: false });
    const result = await worker.tick();
    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('treats a busy status as busy and never dispatches', async () => {
    const { worker, deps } = makeWorker({ status: { ...idleAllSlotsFree, active_query: true } });
    const result = await worker.tick();
    expect(result.idle).toBe(false);
    expect(worker.idleSince).toBeNull();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('does not dispatch until the idle duration reaches the threshold (AC1)', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    expect(worker.idleSince).toBe(start);

    vi.setSystemTime(start + cfg.thresholdMs - 1);
    const before = await worker.tick();
    expect(before.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    vi.setSystemTime(start + cfg.thresholdMs);
    const at = await worker.tick();
    expect(at.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(worker.lastDispatchAt).toBe(start + cfg.thresholdMs);
  });

  it('requires a fresh full idle period after a dispatch (AC5)', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + cfg.thresholdMs);
    await worker.tick();
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // Still idle at the next tick: the tracker was reset after dispatch, so
    // no second dispatch until another full idle period has elapsed.
    vi.setSystemTime(start + cfg.thresholdMs + 30_000);
    const next = await worker.tick();
    expect(next.dispatched).toBe(false);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(worker.idleSince).toBe(start + cfg.thresholdMs + 30_000);

    vi.setSystemTime(start + cfg.thresholdMs + 30_000 + cfg.thresholdMs);
    const after = await worker.tick();
    expect(after.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(2);
  });

  it('a busy poll (proxy busy after dispatch) resets the idle run', async () => {
    const { worker, deps, cfg, fetcher } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + cfg.thresholdMs);
    await worker.tick();
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    fetcher.mockResolvedValueOnce(jsonResponseFixture({ ...idleAllSlotsFree, active_query: true }));
    vi.setSystemTime(start + cfg.thresholdMs + 30_000);
    const busy = await worker.tick();
    expect(busy.idle).toBe(false);
    expect(worker.idleSince).toBeNull();

    // Back to idle: a full new run is required before the next dispatch.
    vi.setSystemTime(start + cfg.thresholdMs + 60_000);
    const reIdle = await worker.tick();
    expect(reIdle.idle).toBe(true);
    expect(reIdle.dispatched).toBe(false);
    vi.setSystemTime(start + cfg.thresholdMs + 60_000 + cfg.thresholdMs);
    const reDispatch = await worker.tick();
    expect(reDispatch.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(2);
  });

  it('re-reads settings each tick so changes apply without a restart', async () => {
    const { worker, deps, cfg } = makeWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();

    cfg.thresholdMs = 60_000; // operator changes the setting live
    vi.setSystemTime(start + 60_000);
    const result = await worker.tick();
    expect(result.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('does not start a second dispatch while one is in flight (worker single-flight)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { worker, deps } = makeWorker({
      deps: { spawnAgentPane: vi.fn().mockImplementation(() => gate) },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    const first = worker.tick();
    const second = await worker.tick();
    expect(second.dispatched).toBe(false);

    release();
    const firstResult = await first;
    expect(firstResult.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });
});
