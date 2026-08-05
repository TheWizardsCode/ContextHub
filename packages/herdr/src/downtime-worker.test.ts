/**
 * Unit tests for downtime-worker.ts — Local-LLM downtime worker contract
 *
 * Test-first contract for the herdr downtime worker (WL-0MSG7ZTC000163FL,
 * parent WL-0MSF49FMW009M06K). Follows the repo convention of a dedicated
 * test-suite feature created before the implementation features
 * (cf. WL-0MQD1N3JD007B0FZ).
 *
 * Green suites test the parts implemented so far (idle detection,
 * blocked-questions prompt, settings clamps, fixture coherence, and — since
 * WL-0MSG80254005ZNE9 — the poller, fail-closed parsing and runtime idle
 * evaluation). The `describe.skip` blocks define the remaining contract
 * matrix; the owning implementation feature flips them back on:
 *
 *  - threshold timing / dispatch / single-flight → WL-0MSG80AG700429M8 (F3)
 *
 * The remaining stubs are fail-closed (never dispatch, never throw), which
 * is the safe default until the full worker lands.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isIdleStatus,
  evaluateIdle,
  parseLlamaStatus,
  fetchLocalStatus,
  createDowntimePoller,
  buildDowntimePrompt,
  BLOCKED_QUESTIONS_INSTRUCTION,
  clampDowntimePollInterval,
  clampDowntimeIdleThresholdMs,
  clampDowntimeRequiredFreeSlots,
  DOWNTIME_POLL_INTERVAL_FLOOR_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  createIdleTracker,
  dispatchDowntimeWork,
  type LlamaStatus,
  type LlamaStatusFetcher,
  type DowntimeCandidate,
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

// ── Threshold timing (AC3) — implemented in F3 (WL-0MSG80AG700429M8) ──

describe.skip('threshold timing (idle-duration tracker)', () => {
  const thresholdMs = 240_000;

  it('dispatches only after idle has lasted the full threshold continuously', () => {
    vi.useFakeTimers();
    const tracker = createIdleTracker();
    const start = Date.now();

    tracker.record(true, start);
    expect(tracker.idleSince).toBe(start);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs - 1)).toBe(false);
    expect(tracker.isThresholdMet(thresholdMs, start + thresholdMs)).toBe(true);

    vi.useRealTimers();
  });

  it('any busy poll resets the idle-since timestamp', () => {
    vi.useFakeTimers();
    const tracker = createIdleTracker();
    const start = Date.now();

    tracker.record(true, start);
    tracker.record(false, start + 120_000);
    expect(tracker.idleSince).toBeNull();
    expect(tracker.isThresholdMet(thresholdMs, start + 360_000)).toBe(false);

    vi.useRealTimers();
  });
});

// ── Dispatch selection (AC4) — implemented in F3 (WL-0MSG80AG700429M8) ─

describe.skip('dispatch selection', () => {
  it('runs /skill:plan on the next intake_complete item', async () => {
    const getNextItem = vi.fn().mockResolvedValue({
      id: 'WL-ABC',
      title: 'Some task',
      stage: 'intake_complete',
    });
    const spawnAgentPane = vi.fn().mockResolvedValue(undefined);

    const outcome = await dispatchDowntimeWork(
      { getNextItem, spawnAgentPane },
      { model: 'plan', cwd: '/repo' },
    );

    expect(getNextItem).toHaveBeenCalledWith('intake_complete');
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-ABC'),
      { model: 'plan', cwd: '/repo' },
    );
  });

  it('falls back to /skill:intake on the next idea item when none is intake_complete', async () => {
    const getNextItem = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'WL-DEF', title: 'An idea', stage: 'idea' });
    const spawnAgentPane = vi.fn().mockResolvedValue(undefined);

    const outcome = await dispatchDowntimeWork(
      { getNextItem, spawnAgentPane },
      { model: 'plan', cwd: '/repo' },
    );

    expect(getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete');
    expect(getNextItem).toHaveBeenNthCalledWith(2, 'idea');
    expect(outcome.kind).toBe('intake');
    expect(spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-DEF'),
      expect.anything(),
    );
  });

  it('does not dispatch when no item exists in either stage', async () => {
    const getNextItem = vi.fn().mockResolvedValue(null);
    const spawnAgentPane = vi.fn().mockResolvedValue(undefined);

    const outcome = await dispatchDowntimeWork(
      { getNextItem, spawnAgentPane },
      { model: 'plan', cwd: '/repo' },
    );

    expect(outcome.dispatched).toBe(false);
    expect(spawnAgentPane).not.toHaveBeenCalled();
  });
});

// ── Single-flight (AC5) — implemented in F3 (WL-0MSG80AG700429M8) ─────

describe.skip('single-flight dispatch guard', () => {
  it('does not dispatch a second time while one dispatch is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getNextItem = vi.fn().mockResolvedValue({
      id: 'WL-ABC',
      title: 'Some task',
      stage: 'intake_complete',
    });
    const spawnAgentPane = vi.fn().mockImplementation(() => gate);

    const first = dispatchDowntimeWork(
      { getNextItem, spawnAgentPane },
      { model: 'plan', cwd: '/repo' },
    );
    const second = dispatchDowntimeWork(
      { getNextItem, spawnAgentPane },
      { model: 'plan', cwd: '/repo' },
    );
    release();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(firstOutcome.dispatched).toBe(true);
    expect(secondOutcome.dispatched).toBe(false);
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
