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
  parseAuditCandidatesOutput,
  selectAuditCandidate,
  toDowntimeCandidate,
  skillKindFromPrompt,
  buildDowntimeDispatchComment,
  clampDowntimePollInterval,
  clampDowntimeIdleThresholdMs,
  clampDowntimeRequiredFreeSlots,
  clampDowntimeNoCandidateCooldownMs,
  DOWNTIME_POLL_INTERVAL_FLOOR_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
  DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS,
  type LlamaStatus,
  type LlamaStatusFetcher,
  type DowntimeCandidate,
  type DowntimeWorkerDeps,
  type DowntimeSpawn,
  type AuditCandidate,
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
    getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    getNextAuditCandidate: vi.fn().mockResolvedValue(null),
    claimItem: vi.fn().mockResolvedValue(undefined),
    spawnAgentPane: vi.fn().mockResolvedValue(undefined),
    recordDispatch: vi.fn().mockResolvedValue(undefined),
    recordError: vi.fn().mockResolvedValue(undefined),
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
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
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
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
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
        .mockResolvedValueOnce({ ok: true, candidate: null })
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-DEF', title: 'An idea', stage: 'idea' } }),
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
  it('fails closed to wl-error when the intake_complete lookup errors AND the idea lookup errors', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: false }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Tier 2 error does NOT short-circuit: tier 3 is still attempted.
    expect(deps.getNextItem).toHaveBeenCalledTimes(2);
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('still checks the idea tier after an intake_complete error and dispatches its candidate', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-IDE', title: 'An idea', stage: 'idea' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('WL-IDE');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-IDE');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-IDE'),
      expect.anything(),
    );
  });

  it('fails closed to wl-error when the intake_complete lookup errors and idea answers empty', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    // Backlog is not provably empty (intake_complete state unknown) → the
    // worker must NOT treat this as a genuine no-candidate (no cooldown).
    expect(outcome.reason).toBe('wl-error');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('fails closed to wl-error when the idea lookup errors after an empty intake_complete stage', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null })
        .mockResolvedValueOnce({ ok: false }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});

// ── Audit-tier dispatch (WL-0MSI8H3HP000K0RG) ─────────────────────────

describe('dispatch audit tier', () => {
  const staleCandidate: DowntimeCandidate = {
    id: 'WL-AUD',
    title: 'Audit me',
    stage: 'audit',
  };

  it('dispatches /skill:audit on the audit candidate as the first tier', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue(staleCandidate),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(outcome.candidate?.id).toBe('WL-AUD');
    expect(deps.getNextItem).not.toHaveBeenCalled();
    expect(deps.claimItem).toHaveBeenCalledWith('WL-AUD');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:audit WL-AUD'),
      { model: 'plan', cwd: '/repo' },
    );
  });

  it('records the audit dispatch with kind audit', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue(staleCandidate),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.itemId).toBe('WL-AUD');
    expect(event.kind).toBe('audit');
    expect(event.cwd).toBe('/repo');
  });

  it('when no audit candidate, falls back to audit → plan → intake in order', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue(null),
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null }) // intake_complete empty
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-IDE', title: 'An idea', stage: 'idea' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('WL-IDE');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea');
  });

  it('fails closed to no-candidate when getNextAuditCandidate returns null and no plan/intake candidate exists', async () => {
    // getNextAuditCandidate is fail-closed at the deps boundary: a wl failure
    // yields null (no candidate), and the dispatcher falls through to the
    // plan/intake tiers. All empty -> no dispatch.
    const deps = makeDeps(); // all three tiers empty

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});

describe('audit selection (selectAuditCandidate)', () => {
  // Fixed clock so the 7-day recency filter is deterministic (all fixture
  // dates fall within the window).
  const NOW = new Date('2026-01-01T00:05:00.000Z').getTime();
  const fresh: AuditCandidate = {
    id: 'FRESH',
    title: 'fresh',
    auditedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:30.000Z',
    sortIndex: 200,
  };
  const stale: AuditCandidate = {
    id: 'STALE',
    title: 'stale',
    auditedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z', // >60s later -> stale
    sortIndex: 300,
  };
  const unaudited: AuditCandidate = { id: 'NOAUDIT', title: 'no audit', sortIndex: 100 };

  it('selects an item with a missing audit', () => {
    expect(selectAuditCandidate([fresh, unaudited], NOW)?.id).toBe('NOAUDIT');
  });

  it('does not select an item with a fresh audit', () => {
    expect(selectAuditCandidate([fresh], NOW)).toBeNull();
  });

  it('selects a stale item (audit older than the 60s buffer)', () => {
    expect(selectAuditCandidate([fresh, stale], NOW)).toEqual(stale);
  });

  it('sorts ascending by sortIndex and returns the first', () => {
    expect(selectAuditCandidate([stale, unaudited], NOW)?.id).toBe('NOAUDIT');
    expect(selectAuditCandidate([{ ...unaudited, sortIndex: 500 }, stale], NOW)?.id).toBe('STALE');
  });

  it('returns null on an empty list', () => {
    expect(selectAuditCandidate([], NOW)).toBeNull();
  });

  it('classifies the 60s freshness boundary correctly', () => {
    // auditedAt exactly 60s before updatedAt -> stale (selected)
    const boundaryStale: AuditCandidate = {
      id: 'B1',
      auditedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    // auditedAt just under 60s before updatedAt -> fresh (not selected)
    const boundaryFresh: AuditCandidate = {
      id: 'B2',
      auditedAt: '2026-01-01T00:00:30.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    expect(selectAuditCandidate([boundaryStale], NOW)?.id).toBe('B1');
    expect(selectAuditCandidate([boundaryFresh], NOW)).toBeNull();
  });
});

describe('audit selection 7-day recency (selectAuditCandidate)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-01-01T12:00:00.000Z').getTime();
  const recentStale: AuditCandidate = {
    id: 'RECENT',
    title: 'modified 6 days ago',
    // audited >60s before updatedAt -> stale audit (selected by freshness)
    auditedAt: new Date(NOW - 6 * DAY_MS - 120_000).toISOString(),
    updatedAt: new Date(NOW - 6 * DAY_MS).toISOString(),
    sortIndex: 100,
  };
  const ancientStale: AuditCandidate = {
    id: 'ANCIENT',
    title: 'modified 8 days ago',
    auditedAt: new Date(NOW - 8 * DAY_MS - 120_000).toISOString(),
    updatedAt: new Date(NOW - 8 * DAY_MS).toISOString(),
    sortIndex: 100,
  };

  it('selects a stale-audit item modified within the last 7 days', () => {
    expect(selectAuditCandidate([ancientStale, recentStale], NOW)?.id).toBe('RECENT');
  });

  it('excludes stale-audit items not modified within the last 7 days', () => {
    expect(selectAuditCandidate([ancientStale], NOW)).toBeNull();
  });

  it('includes a candidate with a missing updatedAt (recency cannot be verified)', () => {
    const missing: AuditCandidate = { id: 'MISSING', title: 'no updatedAt', sortIndex: 100 };
    expect(selectAuditCandidate([missing], NOW)?.id).toBe('MISSING');
  });

  it('excludes a candidate with an unparseable updatedAt (fail-closed)', () => {
    const garbage: AuditCandidate = {
      id: 'GARBAGE',
      title: 'bad date',
      updatedAt: 'not-a-date',
      sortIndex: 100,
    };
    expect(selectAuditCandidate([garbage], NOW)).toBeNull();
  });

  it('includes a candidate modified exactly 7 days ago (boundary inclusive)', () => {
    const boundary: AuditCandidate = {
      id: 'EDGE',
      title: 'exactly 7 days',
      auditedAt: new Date(NOW - 7 * DAY_MS - 120_000).toISOString(),
      updatedAt: new Date(NOW - 7 * DAY_MS).toISOString(),
      sortIndex: 100,
    };
    expect(selectAuditCandidate([boundary], NOW)?.id).toBe('EDGE');
  });

  it('excludes a candidate modified 7 days and 1ms ago', () => {
    const justOutside: AuditCandidate = {
      id: 'OUT',
      title: '7 days + 1ms',
      auditedAt: new Date(NOW - 7 * DAY_MS - 120_001).toISOString(),
      updatedAt: new Date(NOW - 7 * DAY_MS - 1).toISOString(),
      sortIndex: 100,
    };
    expect(selectAuditCandidate([justOutside], NOW)).toBeNull();
  });
});

describe('parseAuditCandidatesOutput', () => {
  it('parses a { workItems: [...] } shape', () => {
    const stdout = JSON.stringify({
      success: true,
      count: 1,
      workItems: [{ id: 'WL-1', title: 'A', sortIndex: 100, auditedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:30.000Z' }],
    });
    const parsed = parseAuditCandidatesOutput(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed![0].id).toBe('WL-1');
    expect(parsed![0].sortIndex).toBe(100);
  });

  it('parses a bare array shape', () => {
    const stdout = JSON.stringify([{ id: 'WL-2', title: 'B' }]);
    expect(parseAuditCandidatesOutput(stdout)?.[0].id).toBe('WL-2');
  });

  it('fails closed (null) on malformed JSON', () => {
    expect(parseAuditCandidatesOutput('not json')).toBeNull();
  });

  it('fails closed (null) on output without a list', () => {
    expect(parseAuditCandidatesOutput(JSON.stringify({ success: false }))).toBeNull();
  });

  it('skips items without an id but keeps valid ones', () => {
    const stdout = JSON.stringify({ workItems: [{ title: 'no id' }, { id: 'WL-3', title: 'C' }] });
    const parsed = parseAuditCandidatesOutput(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(1);
    expect(parsed![0].id).toBe('WL-3');
  });

  it('returns an empty array for an empty workItems list', () => {
    expect(parseAuditCandidatesOutput(JSON.stringify({ workItems: [] }))).toEqual([]);
  });
});

describe('audit prompt & pane helpers', () => {
  const candidate: DowntimeCandidate = { id: 'WL-AUD', title: 'Audit me', stage: 'audit' };

  it('builds an /skill:audit prompt', () => {
    const prompt = buildDowntimePrompt('audit', candidate);
    expect(prompt).toContain('/skill:audit WL-AUD');
  });

  it('builds a Downtime audit pane name', () => {
    const args = buildDowntimePaneArgs('audit', 'Run /skill:audit WL-AUD — Audit me.', {
      model: 'plan',
      cwd: '/repo',
    });
    expect(args).toContain('Downtime audit');
    expect(args).toContain('--no-focus');
  });

  it('skillKindFromPrompt detects an audit prompt', () => {
    expect(skillKindFromPrompt('Run /skill:audit WL-AUD — x.')).toBe('audit');
    expect(skillKindFromPrompt('Run /skill:plan WL-1 — x.')).toBe('plan');
    expect(skillKindFromPrompt('Run /skill:intake WL-2 — x.')).toBe('intake');
  });

  it('buildDowntimeDispatchComment renders /skill:audit', () => {
    const comment = buildDowntimeDispatchComment('WL-AUD', 'audit', '2026-01-01T00:00:00.000Z');
    expect(comment).toContain('/skill:audit WL-AUD');
  });

  it('toDowntimeCandidate produces a stage-audit candidate', () => {
    expect(toDowntimeCandidate({ id: 'X', title: 'T' })).toEqual({
      id: 'X',
      title: 'T',
      stage: 'audit',
    });
  });
});

// ── Dispatch audit trail (WL-0MSGPI4AR000YOK8) ────────────────────────

describe('dispatch audit trail', () => {
  it('records a plan dispatch with item id, kind, timestamp and cwd', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(deps.recordDispatch).toHaveBeenCalledTimes(1);
    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.itemId).toBe('WL-ABC');
    expect(event.kind).toBe('plan');
    expect(event.cwd).toBe('/repo');
    expect(Number.isNaN(Date.parse(event.dispatchedAt))).toBe(false);
  });

  it('records an intake fallback dispatch', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null })
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-DEF', title: 'An idea', stage: 'idea' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('intake');
    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.itemId).toBe('WL-DEF');
    expect(event.kind).toBe('intake');
  });

  it('does not record when nothing is dispatched', async () => {
    const deps = makeDeps();

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.recordDispatch).not.toHaveBeenCalled();
  });

  it('keeps the dispatch successful when recordDispatch fails (audit never blocks work)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
      }),
      recordDispatch: vi.fn().mockRejectedValue(new Error('audit boom')),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
  });
});

describe('buildDowntimeDispatchComment', () => {
  it('states the skill, item id, and ISO timestamp', () => {
    const comment = buildDowntimeDispatchComment('WL-ABC', 'plan', '2026-01-01T00:00:00.000Z');
    expect(comment).toContain('/skill:plan WL-ABC');
    expect(comment).toContain('2026-01-01T00:00:00.000Z');
    expect(comment).toContain('herdr downtime worker');
  });

  it('sanitizes newlines out of the embedded title', () => {
    const comment = buildDowntimeDispatchComment('WL-ABC', 'intake', '2026-01-01T00:00:00.000Z', 'multi\nline\rtitle');
    expect(comment).toContain('multi line title');
    expect(comment).not.toMatch(/[\r\n]/);
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
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
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
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
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
        noCandidateCooldownMs: 3_600_000,
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
    cooldownMs?: number;
    status?: unknown;
    deps?: Partial<DowntimeWorkerDeps>;
  } = {}) {
    const cfg = {
      enabled: overrides.enabled ?? true,
      thresholdMs: overrides.thresholdMs ?? 240_000,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: overrides.cooldownMs ?? 3_600_000,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponseFixture(overrides.status ?? idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' },
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

// ── No-candidate cooldown (WL-0MSI7DQL10016QYX) ──────────────────────

describe('downtime no-candidate cooldown (createDowntimeWorker)', () => {
  /** Empty backlog in BOTH stages → the worker should pause. */
  function makeEmptyBacklogWorker(overrides: {
    cooldownMs?: number;
    deps?: Partial<DowntimeWorkerDeps>;
  } = {}) {
    const cfg = {
      enabled: true,
      thresholdMs: 240_000,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: overrides.cooldownMs ?? 3_600_000,
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
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

  it('enters the cooldown only after a genuine no-candidate outcome', async () => {
    const { worker, deps } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // idle run starts
    vi.setSystemTime(start + 240_000); // threshold met → dispatch attempt

    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(worker.paused).toBe(true);
  });

  it('performs no proxy polling, no idle tracking and no dispatch while paused', async () => {
    const { worker, deps, fetcher } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    await worker.tick(); // enters cooldown
    expect(worker.paused).toBe(true);

    const pollsBefore = fetcher.mock.calls.length;
    const idleBefore = worker.idleSince;
    vi.setSystemTime(start + 240_000 + 60_000); // still within the pause
    const result = await worker.tick();

    expect(result).toEqual({ polled: false, dispatched: false, idle: false });
    expect(fetcher.mock.calls.length).toBe(pollsBefore); // no poll
    expect(worker.idleSince).toBe(idleBefore); // no idle tracking
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(worker.paused).toBe(true);
  });

  it('resumes polling once the cooldown expires and requires a fresh full idle period', async () => {
    let backlogEmpty = true;
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: {
        getNextItem: vi.fn().mockImplementation(() =>
          Promise.resolve(
            backlogEmpty
              ? { ok: true, candidate: null }
              : { ok: true, candidate: { id: 'WL-NEW', title: 'New item', stage: 'intake_complete' } },
          ),
        ),
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    await worker.tick(); // empty backlog → cooldown
    expect(worker.paused).toBe(true);

    // The project's backlog fills back up while the worker is paused.
    backlogEmpty = false;
    vi.setSystemTime(start + 240_000 + 3_600_000); // pause expires
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(resumed.dispatched).toBe(false); // fresh idle run — no stale credit
    expect(worker.paused).toBe(false);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();

    // A full new idle period must elapse before the next dispatch.
    vi.setSystemTime(start + 240_000 + 3_600_000 + 240_000);
    const afterFreshIdle = await worker.tick();
    expect(afterFreshIdle.dispatched).toBe(true); // candidate now available
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
  });

  it('does not enter the cooldown on a transient wl error (fail closed to busy)', async () => {
    const { worker, deps } = makeEmptyBacklogWorker({
      deps: { getNextItem: vi.fn().mockResolvedValue({ ok: false }) },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(false); // a single error is NOT an empty backlog
    expect(worker.errorStrikes).toBe(1); // ...but it IS the first strike
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.recordError).not.toHaveBeenCalled();
  });

  it('does not enter the cooldown when the dispatch guard reports in-flight', async () => {
    // Hold the module-level dispatch single-flight guard with an outer
    // in-flight dispatch; the worker's own dispatch call then returns
    // `dispatch-in-flight`, which must NOT trigger the cooldown.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outerDeps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-X', title: 'Outer', stage: 'intake_complete' },
      }),
      spawnAgentPane: vi.fn().mockImplementation(() => gate),
    });
    const outer = dispatchDowntimeWork(outerDeps, { model: 'plan', cwd: '/repo' });

    const { worker } = makeEmptyBacklogWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    const result = await worker.tick();

    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(false); // in-flight guard is not an empty backlog

    release();
    await outer;
  });

  it('re-reads the cooldown setting each tick so a change applies on the next cooldown entry', async () => {
    const { worker, cfg } = makeEmptyBacklogWorker({ cooldownMs: 3_600_000 });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    await worker.tick(); // enters cooldown with 3_600_000 (expires at 4_840_000)
    expect(worker.paused).toBe(true);

    // Operator lowers the cooldown live; the in-progress pause keeps its
    // original expiry, but the NEXT cooldown entry uses the new value.
    cfg.noCandidateCooldownMs = 60_000;
    vi.setSystemTime(start + 240_000 + 3_600_000); // original pause expires
    await worker.tick(); // resumes, starts a fresh idle run

    vi.setSystemTime(start + 240_000 + 3_600_000 + 240_000); // fresh threshold met
    await worker.tick(); // empty backlog again → 60s cooldown (new value)
    expect(worker.paused).toBe(true);

    // With the NEW 60s value the pause expires long before the old 60-min
    // default would have: at +61s the worker has resumed polling.
    vi.setSystemTime(start + 240_000 + 3_600_000 + 240_000 + 61_000);
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(worker.paused).toBe(false);
  });
});

// ── Three-strike rule on CLI errors ───────────────────────────────────

describe('three-strike rule on CLI errors (createDowntimeWorker)', () => {
  /** Every dispatch attempt ends in a wl CLI error ({ok:false} both tiers). */
  function makeErrorWorker(overrides: { deps?: Partial<DowntimeWorkerDeps> } = {}) {
    const cfg = {
      enabled: true,
      thresholdMs: 240_000,
      requiredFreeSlots: 0,
      model: 'plan',
      cwd: '/repo',
      noCandidateCooldownMs: 3_600_000,
    };
    const fetcher = vi.fn().mockResolvedValue(jsonResponseFixture(idleAllSlotsFree));
    const poller = createDowntimePoller('http://proxy:8000', fetcher);
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({ ok: false }),
      ...overrides.deps,
    });
    const worker = createDowntimeWorker({
      poller,
      deps,
      config: () => ({ ...cfg }),
    });
    return { worker, deps, cfg, fetcher };
  }

  it('pauses and records the persistent error after 3 consecutive CLI errors', async () => {
    const { worker, deps } = makeErrorWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick(); // idle run starts
    vi.setSystemTime(start + 240_000); // threshold met

    const s1 = await worker.tick(); // strike 1
    expect(s1.dispatched).toBe(false);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(1);

    const s2 = await worker.tick(); // strike 2
    expect(s2.dispatched).toBe(false);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(2);

    const s3 = await worker.tick(); // strike 3 → pause + log
    expect(s3.dispatched).toBe(false);
    expect(worker.paused).toBe(true);
    expect(worker.errorStrikes).toBe(0); // counter reset once paused
    expect(deps.recordError).toHaveBeenCalledTimes(1);
    const event = (deps.recordError as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.cwd).toBe('/repo');
    expect(event.message).toContain('3 consecutive');
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
  });

  it('resumes with a fresh strike counter once the pause expires', async () => {
    const { worker, deps } = makeErrorWorker();
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);
    await worker.tick(); // strike 1
    await worker.tick(); // strike 2
    await worker.tick(); // strike 3 → paused
    expect(worker.paused).toBe(true);

    vi.setSystemTime(start + 240_000 + 3_600_000); // pause expires
    const resumed = await worker.tick();
    expect(resumed.polled).toBe(true);
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(0);

    // A fresh error is strike 1 again — not a strike 4.
    vi.setSystemTime(start + 240_000 + 3_600_000 + 240_000);
    await worker.tick();
    expect(worker.errorStrikes).toBe(1);
    expect(worker.paused).toBe(false);
  });

  it('resets the strike counter on a successful dispatch', async () => {
    const { worker, deps } = makeErrorWorker({
      deps: {
        getNextItem: vi
          .fn()
          .mockResolvedValueOnce({ ok: false }) // tier 2 error
          .mockResolvedValueOnce({ ok: false }) // tier 3 error → strike 1
          .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete' } })
          .mockResolvedValue({ ok: false }), // errors afterwards
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    await worker.tick(); // strike 1
    expect(worker.errorStrikes).toBe(1);

    await worker.tick(); // successful dispatch → strikes reset
    expect(worker.errorStrikes).toBe(0);
    expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);

    // A fresh full idle period is required after the dispatch (AC5) before
    // the next dispatch attempt.
    vi.setSystemTime(start + 240_000 + 240_000); // fresh idle run starts
    await worker.tick();
    vi.setSystemTime(start + 240_000 + 480_000); // fresh threshold met
    await worker.tick(); // strike 1 (fresh — not a strike 2)
    expect(worker.errorStrikes).toBe(1);
    await worker.tick(); // strike 2
    expect(worker.paused).toBe(false);
    expect(worker.errorStrikes).toBe(2);

    await worker.tick(); // strike 3 → paused
    expect(worker.paused).toBe(true);
    expect(deps.recordError).toHaveBeenCalledTimes(1);
  });

  it('does not strike on a no-candidate outcome (CLI answered — healthy)', async () => {
    const { worker, deps } = makeErrorWorker({
      deps: {
        getNextItem: vi
          .fn()
          .mockResolvedValueOnce({ ok: false })
          .mockResolvedValueOnce({ ok: false }) // strike 1
          .mockResolvedValue({ ok: true, candidate: null }), // genuine empty backlog
      },
    });
    const start = 1_000_000;
    vi.setSystemTime(start);
    await worker.tick();
    vi.setSystemTime(start + 240_000);

    await worker.tick(); // strike 1
    expect(worker.errorStrikes).toBe(1);

    const result = await worker.tick(); // no-candidate → cooldown, strikes reset
    expect(result.dispatched).toBe(false);
    expect(worker.paused).toBe(true); // genuine empty backlog pauses the worker
    expect(worker.errorStrikes).toBe(0);
    expect(deps.recordError).not.toHaveBeenCalled(); // no persistent-error log
  });
});
