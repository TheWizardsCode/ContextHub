/**
 * packages/herdr/src/downtime-worker.tiers.test.ts — dispatch tier tests
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4VCZE9001BM06) to keep each test file focused
 * on one concern.
 *
 * Covers the dispatch tier matrix and candidate selection/parsing:
 *   - `dispatch implement tier` — implement-tier priority and fall-through,
 *   - `dispatch code-freeze gate` — free-slot minimums under code freeze,
 *   - `dispatch scheduled-prompts tier` — scheduled-prompt dispatch,
 *   - `implement selection (selectImplementCandidate)` — candidate selection,
 *   - `parseImplementCandidatesOutput` — fail-closed output parsing,
 *   - `implement prompt & pane helpers` — prompt/pane argument helpers,
 *   - `audit selection (selectAuditCandidate)` — audit candidate selection,
 *   - `audit selection 7-day recency (selectAuditCandidate)` — recency gate,
 *   - `audit selection dispatched-marker exclusion (selectAuditCandidate)`,
 *   - `parseAuditCandidatesOutput` — fail-closed output parsing,
 *   - `parseInProgressOutput (active-audit single-flight)`,
 *   - `audit prompt & pane helpers` — prompt/pane argument helpers,
 *   - `plan/intake selection (selectNextCandidate)` — plan/intake fall-through,
 *   - `parseNextCandidatesOutput` — fail-closed output parsing,
 *   - `buildDowntimeDispatchComment` — dispatch comment formatting, and
 *   - `single-flight dispatch guard` — one in-flight dispatch at a time.
 *
 * Shared scaffolding (`makeDeps`, `ago`, etc.) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildDowntimeDispatchComment,
  buildDowntimePaneArgs,
  buildDowntimePrompt,
  dispatchDowntimeWork,
  parseAuditCandidatesOutput,
  parseImplementCandidatesOutput,
  parseInProgressOutput,
  parseNextCandidatesOutput,
  selectAuditCandidate,
  selectImplementCandidate,
  selectNextCandidate,
  skillKindFromPrompt,
  toDowntimeCandidate,
  type AuditCandidate,
  type DowntimeCandidate,
  type DowntimeStage,
  type ImplementCandidate,
  type ScheduledPrompt,
} from './downtime-worker.js';
import { ago, makeDeps } from './downtime-worker.fixtures.js';

// ── Implement dispatch tier (WL-0MSMAYIKX005LLO4) ────────────────────

describe('dispatch implement tier', () => {
  const implementCandidate: DowntimeCandidate = {
    id: 'WL-IMP',
    title: 'Implement me',
    stage: 'implement',
  };

  it('dispatches /skill:implement on the implement candidate after the audit tier', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('WL-IMP');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextImplementCandidate).toHaveBeenCalledWith('/repo');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-IMP', { status: 'open', stage: 'plan_complete' }, '/repo');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:implement WL-IMP'),
      { model: 'plan', cwd: '/repo', itemId: 'WL-IMP', itemTitle: 'Implement me' },
    );
  });

  it('records the implement dispatch with kind implement', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    const event = (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.itemId).toBe('WL-IMP');
    expect(event.kind).toBe('implement');
    expect(event.cwd).toBe('/repo');
  });

  it('dispatch priority is audit → implement → plan → intake (audit stays first)', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit' } }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: { id: 'WL-PLN', title: 'Plan me', stage: 'intake_complete' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Audit wins — the implement tier is never consulted when an audit
    // candidate exists (audit is the release gate).
    expect(outcome.kind).toBe('audit');
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    expect(deps.getNextItem).not.toHaveBeenCalled();
  });

  it('falls back to the implement tier when no audit candidate exists, and audit runs first', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('implement');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextItem).not.toHaveBeenCalled();
  });

  it('falls back to plan (intake_complete) when no implement candidate exists', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-PLN', title: 'Plan me', stage: 'intake_complete' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('plan');
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextItem).toHaveBeenCalledTimes(1);
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
  });

  it('falls back to intake (idea) when no implement or plan candidate exists', async () => {
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null),
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null }) // intake_complete empty
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-IDE', title: 'An idea', stage: 'idea' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('intake');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
  });

  it('a wl next CLI error at the implement tier does NOT short-circuit the plan/intake fallback', async () => {
    // Mirrors the tier-2 (intake_complete) error handling: getNextImplementCandidate
    // is fail-closed at the deps boundary (a wl failure yields null), so the
    // plan/intake tiers still run. The implement tier itself never signals a
    // hard error — null IS the fail-closed shape (AC6).
    const deps = makeDeps({
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(null), // wl error → null
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-PLN', title: 'Plan me', stage: 'intake_complete' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.kind).toBe('plan');
    expect(deps.getNextItem).toHaveBeenCalled();
  });

  it('no-candidate when all tiers (audit, implement, plan, intake) are empty', async () => {
    const deps = makeDeps(); // all four tiers empty

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.getNextItem).toHaveBeenCalledTimes(2);
  });
});

// ── Code-freeze gate (WL-0MSQ0RPQP00636JY) ──────────────────────────
// The dispatcher must honour the ship-it code-freeze marker: while frozen
// (or ambiguous — fail-closed), the audit and implement tiers are skipped
// (no new implementation work / audits during a release) and the plan/intake
// tiers still dispatch (low-risk prep). The marker is re-read on EVERY
// dispatch (never cached) so a freeze that starts or ends mid-idle-period is
// honored on the next dispatch attempt. A freeze skip is reason
// 'code-freeze' — never 'no-candidate' — so it cannot trigger the worker's
// no-candidate cooldown: polling continues and resume is immediate.

describe('dispatch code-freeze gate', () => {
  const auditCandidate: DowntimeCandidate = { id: 'WL-AUD', title: 'Audit me', stage: 'audit' };
  const implementCandidate: DowntimeCandidate = { id: 'WL-IMP', title: 'Implement me', stage: 'implement' };
  const planCandidate: DowntimeCandidate = { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete' };

  it('skips the audit and implement tiers while frozen and still dispatches plan', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // Frozen → the audit/implement tiers are never consulted.
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    // Plan/intake tiers still dispatch.
    expect(deps.getNextItem).toHaveBeenCalledWith('intake_complete', '/repo');
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-PLAN', { status: 'open', stage: 'intake_complete' }, '/repo');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-PLAN'),
      expect.anything(),
    );
  });

  it('treats an ambiguous marker as frozen (fail-closed): no audit/implement, plan still dispatches', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('ambiguous'),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
      getNextImplementCandidate: vi.fn().mockResolvedValue(implementCandidate),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: planCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('frozen with an empty plan/intake backlog reports code-freeze (never no-candidate)', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    // The freeze itself must never look like a genuine empty backlog: the
    // worker must NOT enter the no-candidate cooldown (polling continues).
    expect(outcome.reason).toBe('code-freeze');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('ambiguous with an empty plan/intake backlog also reports code-freeze', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('ambiguous'),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('code-freeze');
  });

  it('frozen still surfaces wl CLI errors as wl-error (a strike, not hidden by the freeze)', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getNextItem: vi.fn().mockResolvedValue({ ok: false }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
  });

  it('re-reads the marker on every dispatch: implement/audit resume immediately when the freeze lifts', async () => {
    // First dispatch: frozen → no audit/implement, empty plan/intake → code-freeze.
    const freezeStatus = vi.fn().mockReturnValue('frozen');
    const deps = makeDeps({
      readCodeFreezeStatus: freezeStatus,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const frozenOutcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(frozenOutcome.reason).toBe('code-freeze');
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();

    // The freeze lifts (marker now reads not-frozen): the SAME deps object is
    // re-read on the next dispatch — no caching — and the implement tier
    // dispatches again.
    freezeStatus.mockReturnValue('not-frozen');
    deps.getNextImplementCandidate = vi.fn().mockResolvedValue(implementCandidate);

    const resumed = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
    expect(resumed.dispatched).toBe(true);
    expect(resumed.kind).toBe('implement');
    expect(deps.getNextImplementCandidate).toHaveBeenCalledTimes(1);
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:implement WL-IMP'),
      expect.anything(),
    );
  });

  it('not-frozen behaves as before: the audit tier still runs', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('not-frozen'),
      getNextAuditCandidate: vi.fn().mockResolvedValue({ ok: true, candidate: auditCandidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
    expect(deps.getNextAuditCandidate).toHaveBeenCalledWith('/repo');
  });
});

// ── Scheduled-prompts tier (WL-0MSS1Q5ER007QDKX) ─────────────────────

describe('dispatch scheduled-prompts tier', () => {
  const duePrompt: ScheduledPrompt = {
    id: '/skill:refactor',
    prompt: '/skill:refactor',
    intervalDays: 3,
    lastTriggeredAt: null,
  };

  it('dispatches a due scheduled prompt FIRST (before audit/implement/plan/intake)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      // The backlog tiers must never be consulted — the prompt dispatches
      // instead of reaching them (AC6).
      getNextAuditCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit' },
      }),
      getNextImplementCandidate: vi.fn().mockResolvedValue({
        id: 'WL-IMP',
        title: 'Implement me',
        status: 'open',
        risk: 'low',
        effort: 'small',
      } as ImplementCandidate),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getDueScheduledPrompt).toHaveBeenCalledWith('/repo');
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('scheduled');
    // The prompt text is the dispatch payload — not a skill+work-item wrap.
    expect(deps.spawnAgentPane).toHaveBeenCalledWith('/skill:refactor', {
      model: 'plan',
      cwd: '/repo',
      paneName: 'Downtime /skill:refactor',
    });
    // No pre-dispatch claim — there is no work item (AC4).
    expect(deps.claimItem).not.toHaveBeenCalled();
    // The backlog tiers are never reached (AC6).
    expect(deps.getNextAuditCandidate).not.toHaveBeenCalled();
    expect(deps.getNextImplementCandidate).not.toHaveBeenCalled();
    expect(deps.getNextItem).not.toHaveBeenCalled();
  });

  it('persists lastTriggeredAt and writes the scheduled log marker before the spawn (AC4)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // The trigger timestamp is persisted (atomic config update) and the
    // rolling log marker is written with kind scheduled + noItemComment.
    expect(deps.recordScheduledPromptTrigger).toHaveBeenCalledWith(
      '/repo',
      '/skill:refactor',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expect(deps.recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: '/skill:refactor',
        kind: 'scheduled',
        cwd: '/repo',
        noItemComment: true,
      }),
    );
    // Marker + persist before spawn: the dispatch is recorded before the
    // pane opens (fail-closed: an unrecorded dispatch never runs).
    const persistOrder =
      (deps.recordScheduledPromptTrigger as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const markerOrder =
      (deps.recordDispatch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const spawnOrder =
      (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(markerOrder);
    expect(markerOrder).toBeLessThan(spawnOrder);
  });

  it('falls through to the existing tiers when no prompt is due', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
      getNextAuditCandidate: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-AUD', title: 'Audit me', stage: 'audit' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getDueScheduledPrompt).toHaveBeenCalledWith('/repo');
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('audit');
  });

  it('skips the scheduled tier while frozen (frozen OR ambiguous are fail-closed, AC5)', async () => {
    for (const freezeStatus of ['frozen', 'ambiguous'] as const) {
      const deps = makeDeps({
        readCodeFreezeStatus: vi.fn().mockReturnValue(freezeStatus),
        getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
        getNextItem: vi.fn().mockResolvedValue({
          ok: true,
          candidate: { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete' },
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      // Scheduled prompts are held by the same freeze gate as audit/implement
      // (no new code changes during a release) — the tier is never consulted.
      expect(deps.getDueScheduledPrompt).not.toHaveBeenCalled();
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(deps.spawnAgentPane).toHaveBeenCalledWith(
        expect.stringContaining('/skill:plan WL-PLAN'),
        expect.anything(),
      );
    }
  });

  it('a frozen+empty plan/intake backlog reports code-freeze even when a prompt is due (AC5)', async () => {
    const deps = makeDeps({
      readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getDueScheduledPrompt).not.toHaveBeenCalled();
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('code-freeze');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('aborts before spawn when the lastTriggeredAt persist fails (fail-closed, AC4)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      recordScheduledPromptTrigger: vi.fn().mockResolvedValue(false),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('marker-write-failed');
    // No log record, no pane: an unrecorded dispatch never runs; the entry
    // stays due for the next idle slot.
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('aborts before spawn when the log marker cannot be written (fail-closed, AC4)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      recordDispatch: vi.fn().mockResolvedValue(false),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('marker-write-failed');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('records a spawn-failure trace and resolves spawn-failed when the pane fails (AC4)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(duePrompt),
      spawnAgentPane: vi.fn().mockResolvedValue({ ok: false, error: 'ENOENT' }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('spawn-failed');
    expect(outcome.error).toBe('ENOENT');
    expect(deps.recordDispatchFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: '/skill:refactor',
        kind: 'scheduled',
        error: 'ENOENT',
        noItemComment: true,
      }),
    );
  });

  it('reports no-candidate (the cooldown trigger) when no prompt is due and the backlog is empty (AC6)', async () => {
    const deps = makeDeps({
      getDueScheduledPrompt: vi.fn().mockResolvedValue(null),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate: null }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
  });

  it('buildDowntimePaneArgs honours an explicit paneName (Downtime <id> for scheduled prompts)', () => {
    const args = buildDowntimePaneArgs('plan', '/skill:refactor', {
      model: 'plan',
      cwd: '/repo',
      paneName: 'Downtime /skill:refactor',
    });
    expect(args).toEqual([
      '--pane-name',
      'Downtime /skill:refactor',
      '--no-focus',
      '--cwd',
      '/repo',
      '--model',
      'plan',
      '/skill:refactor',
    ]);
  });
});

// ── Implement candidate selection (WL-0MSMAYIKX005LLO4) ──────────────

describe('implement selection (selectImplementCandidate)', () => {
  const open: ImplementCandidate = {
    id: 'WL-OPEN',
    title: 'open item',
    status: 'open',
    risk: 'low',
    effort: 'small',
    sortIndex: 100,
  };
  const completed: ImplementCandidate = {
    id: 'WL-DONE',
    title: 'completed item',
    status: 'completed',
    risk: 'low',
    effort: 'small',
    sortIndex: 200,
  };

  it('selects the first open candidate in wl next priority order (ascending sortIndex)', () => {
    expect(selectImplementCandidate([open, completed])?.id).toBe('WL-OPEN');
  });

  it('excludes completed candidates (status=open client-side filter, AC2)', () => {
    expect(selectImplementCandidate([completed, { ...open, id: 'WL-OPEN2', sortIndex: 300 }])?.id).toBe('WL-OPEN2');
  });

  it('returns null when no open candidate exists', () => {
    expect(selectImplementCandidate([completed])).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(selectImplementCandidate([])).toBeNull();
  });

  it('sorts ascending by sortIndex (wl next priority order preserved)', () => {
    const low = { ...open, id: 'WL-LOW', sortIndex: 50 };
    const high = { ...open, id: 'WL-HIGH', sortIndex: 900 };
    expect(selectImplementCandidate([high, low])?.id).toBe('WL-LOW');
  });

  it('excludes candidates present in the dispatched marker set (kind implement)', () => {
    const dispatched = new Set(['WL-DUP']);
    const dup = { ...open, id: 'WL-DUP', sortIndex: 10 };
    const fresh = { ...open, id: 'WL-FRESH', sortIndex: 20 };
    expect(selectImplementCandidate([dup, fresh], dispatched)?.id).toBe('WL-FRESH');
  });

  it('an empty dispatched set is a no-op', () => {
    expect(selectImplementCandidate([open], new Set())?.id).toBe('WL-OPEN');
  });

  // ── Risk/effort threshold boundaries (AC1) ──────────────────────────
  // Belt-and-suspenders client-side guard: even though `wl next --risk low
  // --effort small` filters server-side, the herdr tier verifies the
  // thresholds again so a malformed/absent server filter can never dispatch
  // a Medium+/Large+ item (fail-closed).

  it('risk ≤ Medium eligible (High/Critical excluded)', () => {
    const low = { ...open, id: 'WL-LOW', risk: 'low' as const };
    const medium = { ...open, id: 'WL-MED', risk: 'medium' as const };
    const high = { ...open, id: 'WL-HIGH-R', risk: 'high' as const };
    const critical = { ...open, id: 'WL-CRIT', risk: 'critical' as const };
    // medium is first eligible in input order (all share sortIndex 100)
    expect(selectImplementCandidate([medium, low, high, critical, open])?.id).toBe('WL-MED');
    expect(selectImplementCandidate([medium])?.id).toBe('WL-MED');
    expect(selectImplementCandidate([low])?.id).toBe('WL-LOW');
    expect(selectImplementCandidate([high])).toBeNull();
    expect(selectImplementCandidate([critical])).toBeNull();
  });

  it('effort ≤ Medium eligible (Large/Extra Large excluded)', () => {
    const xs = { ...open, id: 'WL-XS', effort: 'xs' as const };
    const small = { ...open, id: 'WL-S', effort: 'small' as const };
    const medium = { ...open, id: 'WL-MED-E', effort: 'medium' as const };
    const large = { ...open, id: 'WL-LARGE', effort: 'large' as const };
    const xl = { ...open, id: 'WL-XL', effort: 'xl' as const };
    // medium is first eligible in input order (all share sortIndex 100)
    expect(selectImplementCandidate([medium, large, xl, open])?.id).toBe('WL-MED-E');
    expect(selectImplementCandidate([xs])?.id).toBe('WL-XS');
    expect(selectImplementCandidate([small])?.id).toBe('WL-S');
    expect(selectImplementCandidate([medium])?.id).toBe('WL-MED-E');
    expect(selectImplementCandidate([large])).toBeNull();
    expect(selectImplementCandidate([xl])).toBeNull();
  });

  it('unset/empty risk or effort items are excluded (fail-closed)', () => {
    const noRisk = { ...open, id: 'WL-NORISK', risk: undefined };
    const noEffort = { ...open, id: 'WL-NOEFFORT', effort: undefined };
    expect(selectImplementCandidate([noRisk, open])?.id).toBe('WL-OPEN');
    expect(selectImplementCandidate([noEffort, open])?.id).toBe('WL-OPEN');
    expect(selectImplementCandidate([noRisk])).toBeNull();
    expect(selectImplementCandidate([noEffort])).toBeNull();
  });

  it('recognizes long-form effort spellings (Small / Medium / Extra Small)', () => {
    const small = { ...open, id: 'WL-S', effort: 'Small' as const };
    const medium = { ...open, id: 'WL-M', effort: 'Medium' as const };
    const extraSmall = { ...open, id: 'WL-ES', effort: 'Extra Small' as const };
    expect(selectImplementCandidate([small])?.id).toBe('WL-S');
    expect(selectImplementCandidate([medium])?.id).toBe('WL-M');
    expect(selectImplementCandidate([extraSmall])?.id).toBe('WL-ES');
  });

  it('handles verbose risk/effort descriptions (agent-produced fields)', () => {
    const verboseRisk = { ...open, id: 'WL-VERBOSE-RISK', risk: 'medium — NVIDIA driver changes can affect GPU functionality system-wide. Wrong driver version could worsen the problem. Mitigation: test in non-production context first if possible; have rollback plan.' };
    const verboseEffort = { ...open, id: 'WL-VERBOSE-EFFORT', effort: '1–4 hours (estimate: o=1, m=2, p=4) — Small. Diagnostic investigation + targeted fix on a single system. No code changes expected.' };
    // Verbose descriptions with em-dash should extract the leading keyword
    expect(selectImplementCandidate([verboseRisk])?.id).toBe('WL-VERBOSE-RISK');
    expect(selectImplementCandidate([verboseEffort])?.id).toBe('WL-VERBOSE-EFFORT');
    // High risk should still be excluded even with verbose description
    const highVerbose = { ...open, id: 'WL-HIGH-V', risk: 'high — something went wrong' };
    expect(selectImplementCandidate([highVerbose])).toBeNull();
  });

  it('regression: a critical item with verbose risk/effort fields wins over a medium item (WL-0MSN3FWV5008KQE9 dispatch)', () => {
    // Real-world regression: the downtime dispatcher skipped the critical NVIDIA
    // item because its risk/effort fields carry descriptions, selecting the
    // medium mode-switch item instead.
    const nvidia = {
      ...open,
      id: 'WL-0MT1KJNDK004SNPK',
      title: 'Fix NVIDIA kernel/userspace driver API mismatch (chrome-headless)',
      risk: 'Medium — NVIDIA driver changes can affect GPU functionality system-wide. Wrong driver version could worsen the problem. Mitigation: test in non-production context first if possible; have rollback plan.',
      effort: '1–4 hours (estimate: o=1, m=2, p=4) — Small. Diagnostic investigation + targeted fix on a single system. No code changes expected.',
      sortIndex: 900,
      priority: 'critical',
    };
    const modeSwitch = {
      ...open,
      id: 'WL-0MSN3FWV5008KQE9',
      title: 'Herdr plugin: activity-gated proxy mode switching',
      risk: 'Medium',
      effort: 'Small',
      sortIndex: 1600,
      priority: 'medium',
    };
    // Critical (sortIndex 900) must be selected ahead of medium (sortIndex 1600)
    expect(selectImplementCandidate([modeSwitch, nvidia])?.id).toBe('WL-0MT1KJNDK004SNPK');
  });
});

describe('parseImplementCandidatesOutput', () => {
  it('parses the wl next -n N { workItems: [{ workItem }] } shape', () => {
    const stdout = JSON.stringify({
      success: true,
      count: 2,
      requested: 10,
      results: [
        { workItem: { id: 'WL-A', title: 'A', status: 'open', risk: 'low', effort: 'small' } },
        { workItem: { id: 'WL-B', title: 'B', status: 'open', risk: 'low', effort: 'xs' } },
      ],
      workItems: [
        { workItem: { id: 'WL-A', title: 'A', status: 'open', risk: 'low', effort: 'small' } },
        { workItem: { id: 'WL-B', title: 'B', status: 'open', risk: 'low', effort: 'xs' } },
      ],
    });
    const parsed = parseImplementCandidatesOutput(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toMatchObject({ id: 'WL-A', status: 'open', risk: 'low', effort: 'small' });
    expect(parsed?.[1]).toMatchObject({ id: 'WL-B', status: 'open', effort: 'xs' });
  });

  it('fails closed (null) on malformed JSON', () => {
    expect(parseImplementCandidatesOutput('not json')).toBeNull();
  });

  it('fails closed (null) on output without a workItems list', () => {
    expect(parseImplementCandidatesOutput(JSON.stringify({ success: true }))).toBeNull();
  });

  it('returns an empty array for an empty workItems list', () => {
    expect(parseImplementCandidatesOutput(JSON.stringify({ success: true, count: 0, workItems: [] }))).toEqual([]);
  });

  it('skips entries without an id but keeps valid ones', () => {
    const stdout = JSON.stringify({
      success: true,
      workItems: [{ workItem: { title: 'no id' } }, { workItem: { id: 'WL-OK', title: 'ok' } }],
    });
    const parsed = parseImplementCandidatesOutput(stdout);
    expect(parsed?.length).toBe(1);
    expect(parsed?.[0].id).toBe('WL-OK');
  });
});

describe('implement prompt & pane helpers', () => {
  const candidate: DowntimeCandidate = { id: 'WL-IMP', title: 'Implement me', stage: 'implement' };

  it('builds an /skill:implement prompt', () => {
    const prompt = buildDowntimePrompt('implement', candidate);
    expect(prompt).toContain('/skill:implement WL-IMP');
  });

  it('builds a Downtime implement pane name', () => {
    const args = buildDowntimePaneArgs('implement', 'Run /skill:implement WL-IMP — Implement me.', {
      model: 'plan',
      cwd: '/repo',
    });
    expect(args).toContain('Downtime implement');
    expect(args).toContain('--no-focus');
  });

  it('skillKindFromPrompt detects an implement prompt', () => {
    expect(skillKindFromPrompt('Run /skill:implement WL-IMP — x.')).toBe('implement');
  });

  // risk-effort kind (WL-0MTTSWCJR003OMN7)
  it('skillKindFromPrompt detects a risk-effort prompt', () => {
    expect(skillKindFromPrompt('Run /skill:effort-and-risk WL-RE — x.')).toBe('risk-effort');
  });

  it('buildDowntimeDispatchComment renders /skill:implement', () => {
    const comment = buildDowntimeDispatchComment('WL-IMP', 'implement', '2026-01-01T00:00:00.000Z');
    expect(comment).toContain('/skill:implement WL-IMP');
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

  it('never selects a covered child — children are never dispatched independently (AC2)', () => {
    // A covered child: completed/in_review, no own fresh audit, parent has the
    // fresh covering audit. The audit tier is root-only, and this client-side
    // guard is belt-and-suspenders for a leaking/faulty response.
    const coveredChild: AuditCandidate = {
      id: 'WL-COVERED-CHILD',
      title: 'Covered child',
      parentId: 'WL-PARENT',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortIndex: 1,
    };
    expect(selectAuditCandidate([coveredChild, unaudited], NOW)?.id).toBe('NOAUDIT');
    expect(selectAuditCandidate([coveredChild], NOW)).toBeNull();
  });

  it('never selects an uncovered child either (AC2)', () => {
    // Uncovered child: parent demoted/stale, so no covering audit — it must
    // still never enter the audit dispatch tier (flagged, not dispatched;
    // WL-0MUBVH9FV0027COG owns durable uncovered reporting).
    const uncoveredChild: AuditCandidate = {
      id: 'WL-UNCOVERED-CHILD',
      title: 'Uncovered child',
      parentId: 'WL-DEMOTED-PARENT',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortIndex: 1,
    };
    expect(selectAuditCandidate([uncoveredChild], NOW)).toBeNull();
  });

  it('classifies the 60s freshness boundary correctly', () => {
    // auditedAt exactly 60s before updatedAt -> stale (selected)
    const boundaryStale: AuditCandidate = {
      id: 'B1',
      title: 'Boundary stale',
      auditedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    // auditedAt just under 60s before updatedAt -> fresh (not selected)
    const boundaryFresh: AuditCandidate = {
      id: 'B2',
      title: 'Boundary fresh',
      auditedAt: '2026-01-01T00:00:30.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    };
    expect(selectAuditCandidate([boundaryStale], NOW)?.id).toBe('B1');
    expect(selectAuditCandidate([boundaryFresh], NOW)).toBeNull();
  });

  it('does not select an item whose updatedAt did not move (flag-only flip, WL-0MSN6ZCTN0027U2R)', () => {
    // The worklog core guarantees (packages/shared/src/database.ts update())
    // that flipping needsProducerReview does NOT bump updatedAt — so after
    // the flip the item still has its pre-audit updatedAt and the audit
    // remains fresh.  selectAuditCandidate must therefore not re-dispatch
    // a redundant /skill:audit for it.
    const afterFlagFlip: AuditCandidate = {
      id: 'FLAGFLIP',
      title: 'flagged for review',
      auditedAt: '2026-01-01T00:00:30.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', // unchanged by the flag flip
      sortIndex: 10,
    };
    expect(selectAuditCandidate([afterFlagFlip], NOW)).toBeNull();
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

describe('audit selection dispatched-marker exclusion (selectAuditCandidate)', () => {
  // Regression (WL-0MSGTLSUT002NF29): an item already dispatched for audit
  // by the downtime worker must never be re-selected while it still lacks a
  // fresh audit — even though it is completed/in_review (the dispatched run
  // reverts the status without recording a fresh audit).
  const NOW = new Date('2026-01-01T00:05:00.000Z').getTime();
  const dispatchedUnaudited: AuditCandidate = {
    id: 'WL-DUP',
    title: 'already dispatched, no audit',
    sortIndex: 100,
  };
  const otherUnaudited: AuditCandidate = {
    id: 'WL-OTHER',
    title: 'not dispatched',
    sortIndex: 200,
  };

  it('excludes a candidate present in the dispatched set with no fresh audit (regression)', () => {
    const dispatched = new Set(['WL-DUP']);
    expect(selectAuditCandidate([dispatchedUnaudited], NOW, dispatched)).toBeNull();
  });

  it('selects another candidate when the first is excluded', () => {
    const dispatched = new Set(['WL-DUP']);
    expect(selectAuditCandidate([dispatchedUnaudited, otherUnaudited], NOW, dispatched)?.id).toBe(
      'WL-OTHER',
    );
  });

  it('composes with audit freshness: a fresh audit still excludes the item (unchanged)', () => {
    const freshDispatched: AuditCandidate = {
      id: 'WL-FRESH',
      title: 'fresh audit since dispatch',
      auditedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:30.000Z',
      sortIndex: 100,
    };
    const dispatched = new Set(['WL-FRESH']);
    // isAuditFresh governs: fresh → not a candidate, even without the marker.
    expect(selectAuditCandidate([freshDispatched], NOW)).toBeNull();
    // Marker + fresh audit → still not a candidate (unchanged).
    expect(selectAuditCandidate([freshDispatched], NOW, dispatched)).toBeNull();
  });

  it('a stale/absent audit plus an audit marker is excluded', () => {
    const staleDispatched: AuditCandidate = {
      id: 'WL-STALE',
      title: 'stale audit since dispatch',
      auditedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z', // >60s later -> stale
      sortIndex: 100,
    };
    expect(selectAuditCandidate([staleDispatched], NOW, new Set(['WL-STALE']))).toBeNull();
  });

  it('an item without a marker is selected as before (empty set is a no-op)', () => {
    expect(selectAuditCandidate([dispatchedUnaudited], NOW, new Set())?.id).toBe('WL-DUP');
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

  it('parses parentId so child candidates can be excluded client-side (AC2)', () => {
    const stdout = JSON.stringify({
      workItems: [
        { id: 'WL-ROOT', title: 'Root', sortIndex: 1 },
        { id: 'WL-CHILD', title: 'Child', parentId: 'WL-ROOT', sortIndex: 2 },
      ],
    });
    const parsed = parseAuditCandidatesOutput(stdout);
    expect(parsed?.[0].parentId).toBeUndefined();
    expect(parsed?.[1].parentId).toBe('WL-ROOT');
  });
});

describe('parseInProgressOutput (active-audit single-flight)', () => {
  it('parses bare workItems entries into their ids', () => {
    const stdout = JSON.stringify({ success: true, count: 2, workItems: [{ id: 'WL-A' }, { id: 'WL-B' }] });
    expect([...parseInProgressOutput(stdout)!]).toEqual(['WL-A', 'WL-B']);
  });

  it('also accepts the { workItem } wrapper shape inside workItems', () => {
    const stdout = JSON.stringify({ workItems: [{ workItem: { id: 'WL-A' } }, { workItem: { id: 'WL-B' } }] });
    expect([...parseInProgressOutput(stdout)!]).toEqual(['WL-A', 'WL-B']);
  });

  it('fails closed (null) on malformed JSON', () => {
    expect(parseInProgressOutput('not json')).toBeNull();
  });

  it('fails closed (null) on output without a list', () => {
    expect(parseInProgressOutput(JSON.stringify({ success: false }))).toBeNull();
  });

  it('skips entries without an id but keeps valid ones', () => {
    const stdout = JSON.stringify({ workItems: [{ title: 'no id' }, { id: 'WL-A' }] });
    expect([...parseInProgressOutput(stdout)!]).toEqual(['WL-A']);
  });

  it('returns an empty set for an empty workItems list', () => {
    expect([...parseInProgressOutput(JSON.stringify({ workItems: [] }))!]).toEqual([]);
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

// ── Plan/intake selection (RCA WL-0MSRBFFLN005W3VT RC-2 + amplifier) ──

describe('plan/intake selection (selectNextCandidate)', () => {
  const openCandidate = (id: string, sortIndex = 0, stage: DowntimeStage = 'intake_complete') => ({
    id,
    title: id,
    stage,
    status: 'open',
    sortIndex,
  });

  it('selects the first open candidate in wl next priority order (ascending sortIndex)', () => {
    const selected = selectNextCandidate([
      openCandidate('WL-2', 20),
      openCandidate('WL-1', 10),
    ]);
    expect(selected?.id).toBe('WL-1');
  });

  it('excludes a candidate still at its dispatched-at stage (change-guard)', () => {
    const selected = selectNextCandidate(
      [openCandidate('WL-ONCE', 5), openCandidate('WL-NEXT', 20)],
      new Map([['WL-ONCE', 'intake_complete']]),
    );
    // WL-ONCE was dispatched for /skill:plan at intake_complete and is still
    // at intake_complete → excluded; the next candidate is selected.
    expect(selected?.id).toBe('WL-NEXT');
  });

  it('releases a candidate whose stage advanced past its dispatched-at stage', () => {
    // The marker recorded intake_complete but the candidate is now at idea
    // (a different stage) → not suppressed.
    const selected = selectNextCandidate(
      [openCandidate('WL-FREE', 5, 'idea')],
      new Map([['WL-FREE', 'intake_complete']]),
    );
    expect(selected?.id).toBe('WL-FREE');
  });

  it('a legacy marker without a recorded stage never suppresses selection', () => {
    const selected = selectNextCandidate(
      [openCandidate('WL-LEGACY', 5)],
      new Map([['WL-LEGACY', '']]),
    );
    expect(selected?.id).toBe('WL-LEGACY');
  });

  it('excludes completed candidates (client-side open-status guard, amplifier fix)', () => {
    const selected = selectNextCandidate([
      { ...openCandidate('WL-DONE', 5), status: 'completed' },
      openCandidate('WL-OPEN', 10),
    ]);
    expect(selected?.id).toBe('WL-OPEN');
  });

  it('a candidate without a verifiable status is never selected (fail-closed)', () => {
    const selected = selectNextCandidate([
      { id: 'WL-NO-STATUS', title: 'x', stage: 'intake_complete' },
    ]);
    expect(selected).toBeNull();
  });

  it('returns null on an empty list', () => {
    expect(selectNextCandidate([])).toBeNull();
  });
});

describe('parseNextCandidatesOutput', () => {
  it('parses the batch shape (wl next -n N) preserving status and sortIndex', () => {
    const candidates = parseNextCandidatesOutput(
      JSON.stringify({
        success: true,
        workItems: [
          { workItem: { id: 'WL-1', title: 'One', status: 'open', sortIndex: 7 } },
          { workItem: { id: 'WL-2', title: 'Two', status: 'completed', sortIndex: 3 } },
        ],
      }),
      'idea',
    );
    expect(candidates).toEqual([
      { id: 'WL-1', title: 'One', stage: 'idea', status: 'open', sortIndex: 7 },
      { id: 'WL-2', title: 'Two', stage: 'idea', status: 'completed', sortIndex: 3 },
    ]);
  });

  it('parses the legacy single-item shape', () => {
    const candidates = parseNextCandidatesOutput(
      JSON.stringify({ success: true, workItem: { id: 'WL-1', title: 'One', status: 'open' } }),
      'intake_complete',
    );
    expect(candidates).toEqual([
      { id: 'WL-1', title: 'One', stage: 'intake_complete', status: 'open', sortIndex: undefined },
    ]);
  });

  it('treats workItem:null as an empty backlog (not a parse failure)', () => {
    const candidates = parseNextCandidatesOutput(
      JSON.stringify({ success: false, workItem: null, reason: 'none' }),
      'idea',
    );
    expect(candidates).toEqual([]);
  });

  it('returns null on malformed JSON (fail-closed)', () => {
    expect(parseNextCandidatesOutput('not json', 'idea')).toBeNull();
    expect(parseNextCandidatesOutput(JSON.stringify({}), 'idea')).toBeNull();
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

  // risk-effort comment (WL-0MTTSWCJR003OMN7)
  it('renders /skill:effort-and-risk for risk-effort kind', () => {
    const comment = buildDowntimeDispatchComment('WL-RE', 'risk-effort', '2026-09-09T12:00:00.000Z');
    expect(comment).toContain('/skill:effort-and-risk WL-RE');
    expect(comment).toContain('herdr downtime worker');
  });
});

// ── Single-flight (AC5) ───────────────────────────────────────────────

describe('single-flight dispatch guard', () => {
  it('does not dispatch a second time while one dispatch is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true });
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
