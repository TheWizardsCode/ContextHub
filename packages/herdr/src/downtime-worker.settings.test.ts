/**
 * packages/herdr/src/downtime-worker.settings.test.ts — settings, enable/
 * disable state, poller-failure, and configuration tests
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4VEQOZ005XH34) to keep each test file focused
 * on one concern.
 *
 * Covers the settings/configuration surface and the worker enable/disable
 * state contract:
 *   - endpoint failures and the poller (`createDowntimePoller`),
 *   - `parseLlamaStatus` local_active_query parsing,
 *   - the blocked-questions prompt instruction,
 *   - the downtime settings clamps,
 *   - `parseNextItemOutput` and `skillKindFromPrompt` wiring helpers,
 *   - the worker enabled state and per-instance toggle override,
 *   - the persisted `.herdr-downtime-disabled` marker.
 *
 * Shared scaffolding (`makeDeps`, status fixtures, etc.) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseLlamaStatus,
  evaluateIdle,
  createDowntimePoller,
  createDowntimeWorker,
  buildDowntimePrompt,
  parseNextItemOutput,
  skillKindFromPrompt,
  clampDowntimePollInterval,
  clampDowntimeIdleThresholdMs,
  clampDowntimeRequiredFreeSlots,
  clampDowntimeNoCandidateCooldownMs,
  clampDowntimeNonTerminalCooldownMs,
  BLOCKED_QUESTIONS_INSTRUCTION,
  DOWNTIME_POLL_INTERVAL_FLOOR_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
  DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DOWNTIME_NON_TERMINAL_COOLDOWN_FLOOR_MS,
  DOWNTIME_NON_TERMINAL_COOLDOWN_MAX_MS,
  DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
  // Audit-batch setting (WL-0MVFE0T0M009ZCPM — test-first specs for parent
  // WL-0MVEDM8OT007WDRS AC1/AC5). These symbols do not exist yet: the
  // implementation child is WL-0MVFE1AB0002PEPN.
  clampDowntimeAuditBatchMax,
  DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  DOWNTIME_AUDIT_BATCH_MAX_MIN,
  DOWNTIME_AUDIT_BATCH_MAX_MAX,
  type DowntimeCandidate,
} from './downtime-worker.js';
import { loadSettings, defaultSettings } from './settings.js';
import {
  DOWNTIME_DISABLE_MARKER_FILE,
  writeDisableMarker,
} from './downtime-disable-marker.js';
import {
  idleAllSlotsFree,
  ambiguousMissingFieldsRaw,
  networkErrorFixture,
  timeoutErrorFixture,
  httpErrorResponseFixture,
  jsonResponseFixture,
  makeDeps,
  type LlamaStatusHttpResponse,
} from './downtime-worker.fixtures.js';

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
    // Observable contract: fetcher injected boundary adapter — URL arg is the sole observable channel for URL construction (producer plan-A)
    expect(fetcher).toHaveBeenCalledWith('http://proxy:8000/llama/local/status', expect.anything());
  });

  it('normalises a trailing slash on the proxy URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000/', fetcher);
    await poller.poll();
    // Observable contract: fetcher injected boundary adapter — URL arg is the sole observable channel for URL construction (producer plan-A)
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

// ── local_active_query parsing (WL-0MSL2ZQIF006QB4Q) ──────────────────

describe('parseLlamaStatus local_active_query', () => {
  const base = {
    llama_server_running: true,
    model_switch_in_progress: false,
    available_slots: 4,
    total_slots: 4,
  };

  it('exposes local_active_query=false when the proxy serves it', () => {
    const status = parseLlamaStatus({ ...base, local_active_query: false });
    expect(status).not.toBeNull();
    expect(status!.local_active_query).toBe(false);
  });

  it('exposes local_active_query=true when the proxy serves it', () => {
    const status = parseLlamaStatus({ ...base, local_active_query: true });
    expect(status).not.toBeNull();
    expect(status!.local_active_query).toBe(true);
  });

  it('leaves local_active_query undefined when absent (pre-fix proxy, backward compatible)', () => {
    const status = parseLlamaStatus(base);
    expect(status).not.toBeNull();
    expect(status!.local_active_query).toBeUndefined();
  });

  it('treats a malformed (non-boolean) local_active_query as ambiguous → busy', () => {
    expect(parseLlamaStatus({ ...base, local_active_query: 'yes' })).toBeNull();
  });
});

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

  it('BLOCKED_QUESTIONS_INSTRUCTION includes the final-summary directive', () => {
    expect(BLOCKED_QUESTIONS_INSTRUCTION).toContain('repeat the questions in your final summary');
  });

  it('buildDowntimePrompt output includes the final-summary directive', () => {
    const prompt = buildDowntimePrompt('implement', candidate);
    expect(prompt).toContain('repeat the questions in your final summary');
  });

  // risk-effort prompt (WL-0MTTSWCJR003OMN7)
  it('the risk-effort prompt runs /skill:effort-and-risk on the item id', () => {
    const prompt = buildDowntimePrompt('risk-effort', candidate);
    expect(prompt).toContain('/skill:effort-and-risk WL-ABC');
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
    expect(clampDowntimeIdleThresholdMs(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS)).toBe(DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS);
    expect(clampDowntimeIdleThresholdMs(0)).toBe(1_000);
  });

  it('clampDowntimeRequiredFreeSlots maps negative/non-finite to the default N=2 and rounds', () => {
    // Spare-capacity default (parent WL-0MT32F90V008UAD2): negative/non-
    // finite input falls back to DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS (2)
    // — the out-of-the-box spare-capacity default, still fail-closed safe.
    expect(clampDowntimeRequiredFreeSlots(-3)).toBe(DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS);
    expect(clampDowntimeRequiredFreeSlots(Number.NaN)).toBe(DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS);
    expect(clampDowntimeRequiredFreeSlots(2.7)).toBe(3);
    expect(clampDowntimeRequiredFreeSlots(2)).toBe(2);
  });

  it('clampDowntimeNoCandidateCooldownMs keeps valid values and floors at 60s', () => {
    expect(clampDowntimeNoCandidateCooldownMs(3_600_000)).toBe(3_600_000);
    expect(clampDowntimeNoCandidateCooldownMs(1_000)).toBe(DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS);
    expect(clampDowntimeNoCandidateCooldownMs(60_000)).toBe(60_000);
  });

  it('clampDowntimeNoCandidateCooldownMs rejects negative and non-finite values', () => {
    expect(clampDowntimeNoCandidateCooldownMs(-1)).toBe(DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS);
    expect(clampDowntimeNoCandidateCooldownMs(Number.NaN)).toBe(DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS);
    expect(clampDowntimeNoCandidateCooldownMs(Infinity)).toBe(DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS);
  });

  it('clampDowntimeNonTerminalCooldownMs keeps valid values and clamps to [60s, 24h]', () => {
    expect(clampDowntimeNonTerminalCooldownMs(DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS)).toBe(
      DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
    );
    // Below the 60s floor → clamped up (no immediate retry).
    expect(clampDowntimeNonTerminalCooldownMs(1_000)).toBe(DOWNTIME_NON_TERMINAL_COOLDOWN_FLOOR_MS);
    expect(clampDowntimeNonTerminalCooldownMs(60_000)).toBe(60_000);
    // Above the 24h ceiling → clamped down (cannot strand indefinitely).
    expect(clampDowntimeNonTerminalCooldownMs(48 * 60 * 60 * 1000)).toBe(
      DOWNTIME_NON_TERMINAL_COOLDOWN_MAX_MS,
    );
  });

  it('clampDowntimeNonTerminalCooldownMs rejects negative and non-finite values', () => {
    expect(clampDowntimeNonTerminalCooldownMs(-1)).toBe(DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS);
    expect(clampDowntimeNonTerminalCooldownMs(Number.NaN)).toBe(DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS);
    expect(clampDowntimeNonTerminalCooldownMs(Infinity)).toBe(DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS);
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
        thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd: '/repo',
        noCandidateCooldownMs: 3_600_000,
      }),
    });
    expect(worker.enabled).toBe(true);
    cfg.enabled = false;
    expect(worker.enabled).toBe(false);
  });
});

// ── Per-instance toggle override (parent WL-0MSZ4NSOE007AQEF) ─────────

describe('downtime worker per-instance override', () => {
  function makeWorker(
    override: boolean | null = null,
    globalEnabled: boolean = true,
  ) {
    const cfg = {
      enabled: globalEnabled,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
    };
    const worker = createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      config: () => ({ ...cfg }),
      override,
    });
    return { worker, cfg };
  }

  it('defaults to null (follows global settings)', () => {
    const { worker } = makeWorker();
    expect(worker.override).toBe(null);
    expect(worker.enabled).toBe(true);
  });

  it('toggle() cycles null → false → null (no force-enable)', () => {
    const { worker } = makeWorker();
    // null → false (first press disables)
    expect(worker.override).toBe(null);
    worker.toggle();
    expect(worker.override).toBe(false);
    // false → null (second press returns to follow settings)
    worker.toggle();
    expect(worker.override).toBe(null);
  });

  it('two consecutive toggles return to follow-settings (null→false→null)', () => {
    const { worker, cfg } = makeWorker();
    // First press: disable
    worker.toggle();
    expect(worker.override).toBe(false);
    expect(worker.enabled).toBe(false);
    // Second press: back to follow settings
    worker.toggle();
    expect(worker.override).toBe(null);
    expect(worker.enabled).toBe(cfg.enabled); // follows global
  });

  it('three presses cycle null → false → null → false', () => {
    const { worker } = makeWorker();
    expect(worker.override).toBe(null);
    worker.toggle(); // → false
    expect(worker.override).toBe(false);
    worker.toggle(); // → null
    expect(worker.override).toBe(null);
    worker.toggle(); // → false again (not true)
    expect(worker.override).toBe(false);
  });

  it('tick() short-circuits after disable (override=false)', async () => {
    const { worker } = makeWorker();
    worker.toggle(); // → false
    const result = await worker.tick();
    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
  });

  it('tick() follows global setting after second press (null → false → null)', async () => {
    vi.useFakeTimers();
    try {
      const { worker, cfg } = makeWorker(null, true);
      // First press: disable
      worker.toggle();
      expect(worker.override).toBe(false);
      let result = await worker.tick();
      expect(result).toEqual({ polled: false, dispatched: false, idle: false });

      // Second press: back to follow settings
      worker.toggle();
      expect(worker.override).toBe(null);
      result = await worker.tick();
      expect(result.idle).toBe(false); // normal behavior (global busy)
    } finally {
      vi.useRealTimers();
    }
  });

  it('enabled returns override ?? cfg.enabled (null)', () => {
    const { worker, cfg } = makeWorker();
    // null override → follows global
    expect(worker.enabled).toBe(true);
    cfg.enabled = false;
    expect(worker.enabled).toBe(false);
    cfg.enabled = true;
    // toggle: null → false
    worker.toggle();
    expect(worker.override).toBe(false);
    expect(worker.enabled).toBe(false);
    // toggle: false → null
    worker.toggle();
    expect(worker.override).toBe(null);
    expect(worker.enabled).toBe(cfg.enabled); // follows global
  });

  it('tick() short-circuits when override is false (even if global is true)', async () => {
    const { worker } = makeWorker(false, true);
    const result = await worker.tick();
    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
  });

  it('tick() behaves normally when override is null (follows global)', async () => {
    vi.useFakeTimers();
    try {
      const { worker } = makeWorker(null, true);
      // Busy global → still busy
      const result = await worker.tick();
      expect(result.idle).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('two workers with independent overrides toggle independently', () => {
    const { worker: w1 } = makeWorker();
    const { worker: w2 } = makeWorker();
    w1.toggle();
    expect(w1.override).toBe(false);
    expect(w2.override).toBe(null);
    expect(w1.enabled).toBe(false);
    expect(w2.enabled).toBe(true);
    w2.toggle(); // → false
    expect(w2.override).toBe(false);
    w2.toggle(); // → null
    expect(w2.override).toBe(null);
    expect(w2.enabled).toBe(true); // follows global
  });

  it('override forces dispatch on when global setting is false', () => {
    const { worker } = makeWorker(true, false);
    expect(worker.override).toBe(true);
    expect(worker.enabled).toBe(true); // override takes precedence
    expect(worker.tick).toBeDefined();
  });

  it('override set via config is respected (pre-toggled worker)', () => {
    const { worker } = makeWorker(false, true);
    expect(worker.override).toBe(false);
    expect(worker.enabled).toBe(false);
  });
});

// ── Persisted disable marker (WL-0MT5SFP990001FNW) ───────────────────

describe('persisted downtime disable marker (.herdr-downtime-disabled)', () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'herdr-dt-marker-'));
    cwd = join(root, 'worklog-root');
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function markerPath(): string {
    return join(cwd, DOWNTIME_DISABLE_MARKER_FILE);
  }

  function makeWorkerWithCwd(
    extra: Partial<Parameters<typeof createDowntimeWorker>[0]> = {},
  ) {
    const cfg = {
      enabled: true,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd,
      noCandidateCooldownMs: DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
    };
    const merged = {
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      config: () => ({ ...cfg }),
      ...extra,
    };
    const worker = createDowntimeWorker(merged);
    return { worker, cfg };
  }

  it('creates the marker file when toggle() disables (AC1)', () => {
    const { worker } = makeWorkerWithCwd();
    expect(existsSync(markerPath())).toBe(false);
    worker.toggle(); // disable
    expect(worker.override).toBe(false);
    expect(existsSync(markerPath())).toBe(true);
  });

  it('does not rewrite an existing marker (no write when already present, AC1)', () => {
    writeFileSync(markerPath(), 'existing', 'utf8');
    // Direct helper-level check (a worker constructed with a marker present
    // restores override=false, so toggle() would remove it — the no-rewrite
    // guarantee of AC1 belongs to the write helper itself).
    writeDisableMarker(cwd);
    expect(readFileSync(markerPath(), 'utf8')).toBe('existing');
  });

  it('removes the marker when toggle() returns to follow-settings (AC2)', () => {
    const { worker } = makeWorkerWithCwd();
    worker.toggle(); // → false, marker written
    expect(existsSync(markerPath())).toBe(true);
    worker.toggle(); // → null, marker removed
    expect(worker.override).toBe(null);
    expect(existsSync(markerPath())).toBe(false);
  });

  it('removing an absent marker is a no-op (AC2)', () => {
    const { worker } = makeWorkerWithCwd({ override: false });
    worker.toggle(); // → null → remove absent marker
    expect(worker.override).toBe(null);
    expect(existsSync(markerPath())).toBe(false);
  });

  it('restores override=false at init when the marker exists (AC3)', () => {
    writeFileSync(markerPath(), '', 'utf8');
    const { worker } = makeWorkerWithCwd();
    expect(worker.override).toBe(false);
    expect(worker.enabled).toBe(false);
  });

  it('explicit opts.override wins over the marker (AC3)', () => {
    writeFileSync(markerPath(), '', 'utf8');
    const { worker } = makeWorkerWithCwd({ override: true });
    expect(worker.override).toBe(true);
    expect(worker.enabled).toBe(true);
  });

  it('with no marker, override starts null and follows settings (AC4)', () => {
    const { worker } = makeWorkerWithCwd();
    expect(worker.override).toBe(null);
    expect(worker.enabled).toBe(true);
  });

  it('the marker is scoped to the worklog root (AC5)', () => {
    const otherRoot = join(root, 'other-root');
    mkdirSync(otherRoot, { recursive: true });
    writeFileSync(markerPath(), '', 'utf8'); // marker in cwd only
    const { worker: a } = makeWorkerWithCwd();
    const cfgB = {
      enabled: true,
      thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: otherRoot,
      noCandidateCooldownMs: DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
    };
    const b = createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps: makeDeps(),
      config: () => ({ ...cfgB }),
    });
    expect(a.override).toBe(false);
    expect(b.override).toBe(null);
    expect(b.enabled).toBe(true);
  });

  it('marker-restored disable yields zero dispatch across idle + cooldown windows (AC1/AC6)', async () => {
    writeFileSync(markerPath(), '', 'utf8');
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });
    const worker = createDowntimeWorker({
      poller: createDowntimePoller('http://proxy:8000'),
      deps,
      config: () => ({
        enabled: true,
        thresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
        requiredFreeSlots: 0,
        model: 'plan',
        cwd,
        noCandidateCooldownMs: DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
      }),
    });
    expect(worker.override).toBe(false); // restored from marker
    vi.useFakeTimers();
    try {
      // Advance well past the idle threshold and the no-candidate cooldown:
      // a disabled worker must short-circuit on EVERY tick (zero polls,
      // zero dispatch, zero pane spawns) regardless of elapsed time.
      vi.setSystemTime(Date.now() + DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS + 60_000);
      const r1 = await worker.tick();
      expect(r1).toEqual({ polled: false, dispatched: false, idle: false });
      const r2 = await worker.tick();
      expect(r2).toEqual({ polled: false, dispatched: false, idle: false });
      expect(deps.getNextItem).not.toHaveBeenCalled();
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Audit-batch setting: downtimeAuditBatchMax (WL-0MVFE0T0M009ZCPM) ───
//
// Test-first specs for the depth-aware audit-batch setting (parent
// WL-0MVEDM8OT007WDRS AC1/AC5, constraints). The setting bounds how many
// SEQUENTIAL audit dispatches one continuous idle window may issue when the
// audit-eligible backlog depth reaches `browseItemCount`:
//
//  - `DOWNTIME_AUDIT_BATCH_MAX` (settings key `downtimeAuditBatchMax`),
//  - default `2` (batching on, conservative), clamped to `[1, 5]`,
//    rounded to an integer,
//  - non-finite input (NaN/±Infinity) falls back to the default `2`,
//  - `1` disables batching and restores legacy single-dispatch behaviour.
//
// RED WITNESS. Neither `clampDowntimeAuditBatchMax` nor the settings key
// exists yet, so every body below asserts post-implementation behaviour and
// is committed with `it.fails` (the repo's documented TDD pattern — see
// `docs/dev/downtime-dispatcher-post-fix-verification.md`). The suite stays
// GREEN while the assertions are RED. Implementation child
// WL-0MVFE1AB0002PEPN flips each `it.fails` to `it` once the setting lands.
describe('downtime audit-batch setting (downtimeAuditBatchMax)', () => {
  function writeConfig(body: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-audit-batch-settings-'));
    const path = join(dir, 'worklog-plugin.json');
    writeFileSync(path, JSON.stringify(body), 'utf8');
    return path;
  }

  it.fails('clamps downtimeAuditBatchMax to the safe [1, 5] integer range', () => {
    expect(DOWNTIME_AUDIT_BATCH_MAX_MIN).toBe(1);
    expect(DOWNTIME_AUDIT_BATCH_MAX_MAX).toBe(5);
    // Below the floor → clamped UP to 1 (legacy/off, never negative).
    expect(clampDowntimeAuditBatchMax(0)).toBe(1);
    expect(clampDowntimeAuditBatchMax(-7)).toBe(1);
    // In range → preserved, rounded to an integer.
    expect(clampDowntimeAuditBatchMax(1)).toBe(1);
    expect(clampDowntimeAuditBatchMax(3)).toBe(3);
    expect(clampDowntimeAuditBatchMax(2.7)).toBe(3);
    expect(clampDowntimeAuditBatchMax(5)).toBe(5);
    // Above the ceiling → clamped DOWN to 5 (bounded per-window LLM load).
    expect(clampDowntimeAuditBatchMax(99)).toBe(5);
  });

  it.fails('falls back to the default (2) for non-finite values', () => {
    expect(DEFAULT_DOWNTIME_AUDIT_BATCH_MAX).toBe(2);
    expect(clampDowntimeAuditBatchMax(Number.NaN)).toBe(DEFAULT_DOWNTIME_AUDIT_BATCH_MAX);
    expect(clampDowntimeAuditBatchMax(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
    );
    expect(clampDowntimeAuditBatchMax(Number.NEGATIVE_INFINITY)).toBe(
      DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
    );
  });

  it.fails('defaults to 2 in defaultSettings', () => {
    expect(defaultSettings.downtimeAuditBatchMax).toBe(DEFAULT_DOWNTIME_AUDIT_BATCH_MAX);
    expect(defaultSettings.downtimeAuditBatchMax).toBe(2);
  });

  it.fails('loadSettings parses a valid downtimeAuditBatchMax value', () => {
    const path = writeConfig({ downtimeAuditBatchMax: 3 });
    try {
      expect(loadSettings(path).downtimeAuditBatchMax).toBe(3);
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  it.fails('loadSettings clamps an out-of-range downtimeAuditBatchMax (never trusts the file)', () => {
    const low = writeConfig({ downtimeAuditBatchMax: 0 });
    const high = writeConfig({ downtimeAuditBatchMax: 42 });
    try {
      expect(loadSettings(low).downtimeAuditBatchMax).toBe(1); // 1 = legacy/off
      expect(loadSettings(high).downtimeAuditBatchMax).toBe(5);
    } finally {
      rmSync(join(low, '..'), { recursive: true, force: true });
      rmSync(join(high, '..'), { recursive: true, force: true });
    }
  });

  it.fails('loadSettings falls back to the default when downtimeAuditBatchMax is missing or invalid', () => {
    const missing = writeConfig({ browseItemCount: 12 });
    const invalid = writeConfig({ downtimeAuditBatchMax: 'two' });
    try {
      expect(loadSettings(missing).downtimeAuditBatchMax).toBe(2);
      expect(loadSettings(invalid).downtimeAuditBatchMax).toBe(2);
    } finally {
      rmSync(join(missing, '..'), { recursive: true, force: true });
      rmSync(join(invalid, '..'), { recursive: true, force: true });
    }
  });
});
