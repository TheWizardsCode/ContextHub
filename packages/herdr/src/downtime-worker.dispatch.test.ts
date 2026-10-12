/**
 * packages/herdr/src/downtime-worker.dispatch.test.ts — dispatch wiring tests
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4V3WJN0013EZZ) to keep each test file focused
 * on one concern.
 *
 * Covers dispatch selection and the dispatcher-anchor wiring paths:
 *   - `dispatch selection` — the plan/intake tier selection contract,
 *   - `dispatcher anchor wiring (C0 dispatcher workspace)`,
 *   - `per-prefix Dispatcher tab dispatch wiring (C1 fallback)`, and
 *   - `project workspace + item-ID tab dispatch wiring (primary path)`.
 *
 * Shared scaffolding (`makeDeps`, etc.) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 */

import { describe, it, expect, vi } from 'vitest';
import { dispatchDowntimeWork, buildDowntimePaneArgs } from './downtime-worker.js';
import { makeDeps } from './downtime-worker.fixtures.js';
import type { StalledPaneCandidate } from './stalled-work.js';

describe('dispatch selection', () => {
  it('runs /skill:plan on the next intake_complete item', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenCalledWith('intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenCalledTimes(1);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('WL-ABC');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-ABC'),
      { model: 'plan', cwd: '/repo', itemId: 'WL-ABC', itemTitle: 'Some task' },
    );
  });

  it('claims the item BEFORE the pane spawns with the tier CAS guard', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    // The claim carries the expected state the tier selected the item in
    // (RCA WL-0MSRBFFLN005W3VT design point 1 — compare-and-swap).
    expect(deps.claimItem).toHaveBeenCalledWith('WL-ABC', { status: 'open', stage: 'intake_complete' }, '/repo');
    const claimOrder = (deps.claimItem as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const spawnOrder = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(spawnOrder);
  });

  it('falls back to /skill:intake on the next idea item when none is intake_complete', async () => {
    const deps = makeDeps({
      getNextItem: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, candidate: null })
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-DEF', title: 'An idea', stage: 'idea', status: 'open' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('WL-DEF');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-DEF', { status: 'open', stage: 'idea' }, '/repo');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:intake WL-DEF'),
      expect.anything(),
    );
  });

  it('does not dispatch when no item exists in either stage', async () => {
    const deps = makeDeps();

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
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
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
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
        .mockResolvedValueOnce({ ok: true, candidate: { id: 'WL-IDE', title: 'An idea', stage: 'idea', status: 'open' } }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('intake');
    expect(outcome.candidate?.id).toBe('WL-IDE');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
    expect(deps.claimItem).toHaveBeenCalledWith('WL-IDE', { status: 'open', stage: 'idea' }, '/repo');
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

    expect(deps.getNextItem).toHaveBeenNthCalledWith(1, 'intake_complete', '/repo');
    expect(deps.getNextItem).toHaveBeenNthCalledWith(2, 'idea', '/repo');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('wl-error');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});

// ── Dispatcher anchor wiring (C0 WL-0MTR01EU7005SYZG / F2 WL-0MTR2HLLJ009PTPJ) ──

describe('dispatcher anchor wiring (C0 dispatcher workspace)', () => {
  it('AC1: buildDowntimePaneArgs appends --anchor <id> when an anchorId is provided', () => {
    const args = buildDowntimePaneArgs('plan', 'Run /skill:plan WL-ABC — Some task.', {
      model: 'plan',
      cwd: '/repo',
      anchorId: 'wD:pANCHOR',
    });
    expect(args).toContain('--anchor');
    expect(args).toContain('wD:pANCHOR');
    expect(args).toContain('--no-focus');
    expect(args).toContain('--cwd');
    expect(args).toContain('/repo');
    expect(args).toContain('--model');
    expect(args).toContain('plan');
  });

  it('AC1 backward-compat: buildDowntimePaneArgs omits --anchor when no anchorId is given', () => {
    const args = buildDowntimePaneArgs('plan', 'Run /skill:plan WL-ABC — Some task.', {
      model: 'plan',
      cwd: '/repo',
    });
    expect(args).not.toContain('--anchor');
    expect(args).not.toContain('wD:pANCHOR');
    expect(args[0]).toBe('--pane-name');
  });

  it('AC3: dispatchDowntimeWork resolves the anchor and passes its pane id to spawnAgentPane', async () => {
    const deps = makeDeps({
      getDispatcherAnchor: vi.fn().mockResolvedValue({
        paneId: 'wD:pANCHOR',
        workspaceId: 'wD',
      }),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(deps.getDispatcherAnchor).toHaveBeenCalled();
    // The resolved anchor pane id flows into the spawn opts (→ --anchor in
    // the send-to-pi.sh args built by buildDowntimePaneArgs).
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-ABC'),
      expect.objectContaining({ anchorId: 'wD:pANCHOR' }),
    );
  });

  it('AC1 legacy wiring: without the getDispatcherAnchor dep no anchorId key is added (backward compat)', async () => {
    const deps = makeDeps({
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-ABC'),
      expect.not.objectContaining({ anchorId: expect.anything() }),
    );
  });

  it('fail-safe: a null anchor (provisioning failed) aborts the dispatch with anchor-unavailable', async () => {
    const deps = makeDeps({
      getDispatcherAnchor: vi.fn().mockResolvedValue(null),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-ABC', title: 'Some task', stage: 'intake_complete', status: 'open' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('anchor-unavailable');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('scheduled-prompt spawns resolve the anchor and forward anchorId (dispatchDowntimeWork path)', async () => {
    const deps = makeDeps({
      getDispatcherAnchor: vi.fn().mockResolvedValue({
        paneId: 'wD:pANCHOR',
        workspaceId: 'wD',
      }),
      getDueScheduledPrompt: vi.fn().mockResolvedValue({
        id: 'prompt-1',
        prompt: 'Run the nightly sweep',
        frequencyMinutes: 60,
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('scheduled');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      'Run the nightly sweep',
      expect.objectContaining({ anchorId: 'wD:pANCHOR' }),
    );
  });
});

// ── Per-prefix tab dispatch wiring (C1 fallback, WL-0MUR5FUWD00024XN) ───────

describe('per-prefix Dispatcher tab dispatch wiring (C1 fallback)', () => {
  const candidate = {
    id: 'WL-ABC',
    title: 'Some task',
    stage: 'intake_complete' as const,
    status: 'open',
  };

  it('AC1: resolves the per-prefix tab and forwards its anchor pane (primary path)', async () => {
    const getDispatcherTabAnchor = vi.fn().mockResolvedValue({
      workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1',
    });
    const deps = makeDeps({
      getDispatcherTabAnchor,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(getDispatcherTabAnchor).toHaveBeenCalledWith('/repo', 'WL');
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-ABC'),
      expect.objectContaining({ anchorId: 'wD:tWL:p1' }),
    );
  });

  it('AC1: each prefix routes to its own tab (WL vs TCE)', async () => {
    const wlDeps = makeDeps({
      getDispatcherTabAnchor: vi.fn().mockResolvedValue({
        workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1',
      }),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-1', title: 'wl', stage: 'intake_complete', status: 'open' },
      }),
    });
    const tceDeps = makeDeps({
      getDispatcherTabAnchor: vi.fn().mockResolvedValue({
        workspaceId: 'wD', tabId: 'wD:tTCE', paneId: 'wD:tTCE:p1',
      }),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'TCE-2', title: 'tce', stage: 'intake_complete', status: 'open' },
      }),
    });

    await dispatchDowntimeWork(wlDeps, { model: 'plan', cwd: '/repo-wl' });
    await dispatchDowntimeWork(tceDeps, { model: 'plan', cwd: '/repo-tce' });

    expect(wlDeps.getDispatcherTabAnchor).toHaveBeenCalledWith('/repo-wl', 'WL');
    expect(tceDeps.getDispatcherTabAnchor).toHaveBeenCalledWith('/repo-tce', 'TCE');
    expect(wlDeps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: 'wD:tWL:p1', cwd: '/repo-wl' }),
    );
    expect(tceDeps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: 'wD:tTCE:p1', cwd: '/repo-tce' }),
    );
  });

  it('AC2/AC4: a resolved project workspace wins and the per-prefix dep is not called', async () => {
    const resolveProjectWorkspace = vi
      .fn()
      .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' });
    const getItemTabAnchor = vi
      .fn()
      .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    const getDispatcherTabAnchor = vi.fn().mockResolvedValue({
      workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1',
    });
    const deps = makeDeps({
      getDispatcherTabAnchor,
      resolveProjectWorkspace,
      getItemTabAnchor,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(resolveProjectWorkspace).toHaveBeenCalledWith('/repo');
    expect(getItemTabAnchor).toHaveBeenCalledWith('/repo', 'wC', 'WL-ABC');
    expect(getDispatcherTabAnchor).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: 'wC:tWL-ABC:p1' }),
    );
  });

  it('AC5: the per-prefix Dispatcher path is used when the project workspace resolves to null', async () => {
    const getDispatcherTabAnchor = vi.fn().mockResolvedValue({
      workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1',
    });
    const resolveProjectWorkspace = vi.fn().mockResolvedValue(null);
    const getItemTabAnchor = vi.fn();
    const getDispatcherAnchor = vi
      .fn()
      .mockResolvedValue({ paneId: 'wD:LEGACY', workspaceId: 'wD' });
    const deps = makeDeps({
      getDispatcherTabAnchor,
      resolveProjectWorkspace,
      getItemTabAnchor,
      getDispatcherAnchor,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(resolveProjectWorkspace).toHaveBeenCalledWith('/repo');
    expect(getItemTabAnchor).not.toHaveBeenCalled();
    expect(getDispatcherTabAnchor).toHaveBeenCalledWith('/repo', 'WL');
    expect(getDispatcherAnchor).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: 'wD:tWL:p1' }),
    );
  });

  it('AC1 fail-safe: a null per-prefix anchor aborts with anchor-unavailable (no fallback)', async () => {
    const getDispatcherTabAnchor = vi.fn().mockResolvedValue(null);
    const getDispatcherAnchor = vi
      .fn()
      .mockResolvedValue({ paneId: 'wD:LEGACY', workspaceId: 'wD' });
    const deps = makeDeps({
      getDispatcherTabAnchor,
      getDispatcherAnchor,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('anchor-unavailable');
    expect(getDispatcherAnchor).not.toHaveBeenCalled();
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC1 fail-safe: a throwing per-prefix resolver aborts with anchor-unavailable', async () => {
    const deps = makeDeps({
      getDispatcherTabAnchor: vi.fn().mockRejectedValue(new Error('herdr down')),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('anchor-unavailable');
    expect(deps.claimItem).not.toHaveBeenCalled();
  });
});

// ── Project workspace + item-ID tab dispatch wiring (WL-0MU321YK70035AYT) ──

// These tests exercise the PRIMARY project-workspace + item-ID tab path,
// reaffirmed as primary in WL-0MUR5FUWD00024XN. The per-prefix Dispatcher tab
// and the legacy single anchor are fallbacks used only when no project
// workspace resolves for the item's root.
describe('project workspace + item-ID tab dispatch wiring (primary path)', () => {
  const candidate = {
    id: 'WL-ABC',
    title: 'Some task',
    stage: 'intake_complete' as const,
    status: 'open',
  };

  it('AC1/AC2: resolves the project workspace, ensures the item-ID tab and forwards its anchor pane', async () => {
    const resolveProjectWorkspace = vi
      .fn()
      .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' });
    const getItemTabAnchor = vi
      .fn()
      .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    const getDispatcherAnchor = vi
      .fn()
      .mockResolvedValue({ paneId: 'wD:LEGACY', workspaceId: 'wD' });
    const deps = makeDeps({
      resolveProjectWorkspace,
      getItemTabAnchor,
      getDispatcherAnchor,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(resolveProjectWorkspace).toHaveBeenCalledWith('/repo');
    expect(getItemTabAnchor).toHaveBeenCalledWith('/repo', 'wC', 'WL-ABC');
    expect(getDispatcherAnchor).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan WL-ABC'),
      expect.objectContaining({ anchorId: 'wC:tWL-ABC:p1' }),
    );
  });

  it('AC4: no project workspace → falls back to the Dispatcher anchor', async () => {
    const resolveProjectWorkspace = vi.fn().mockResolvedValue(null);
    const getItemTabAnchor = vi.fn();
    const getDispatcherAnchor = vi
      .fn()
      .mockResolvedValue({ paneId: 'wD:pFALLBACK', workspaceId: 'wD' });
    const deps = makeDeps({
      resolveProjectWorkspace,
      getItemTabAnchor,
      getDispatcherAnchor,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(getDispatcherAnchor).toHaveBeenCalledWith('/repo');
    expect(getItemTabAnchor).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: 'wD:pFALLBACK' }),
    );
  });

  it('AC4 fail-safe: workspace resolves but item tab fails → anchor-unavailable, no Dispatcher fallback', async () => {
    const resolveProjectWorkspace = vi
      .fn()
      .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1' });
    const getItemTabAnchor = vi.fn().mockResolvedValue(null);
    const getDispatcherAnchor = vi
      .fn()
      .mockResolvedValue({ paneId: 'wD:LEGACY', workspaceId: 'wD' });
    const deps = makeDeps({
      resolveProjectWorkspace,
      getItemTabAnchor,
      getDispatcherAnchor,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('anchor-unavailable');
    expect(getDispatcherAnchor).not.toHaveBeenCalled();
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC4 fail-safe: no project workspace and Dispatcher anchor null → anchor-unavailable, no marker/spawn', async () => {
    const deps = makeDeps({
      resolveProjectWorkspace: vi.fn().mockResolvedValue(null),
      getDispatcherAnchor: vi.fn().mockResolvedValue(null),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('anchor-unavailable');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.recordDispatch).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC4 fail-safe: a throwing project-workspace resolver falls back to the Dispatcher anchor', async () => {
    const getDispatcherAnchor = vi
      .fn()
      .mockResolvedValue({ paneId: 'wD:pFALLBACK', workspaceId: 'wD' });
    const deps = makeDeps({
      resolveProjectWorkspace: vi.fn().mockRejectedValue(new Error('herdr down')),
      getDispatcherAnchor,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(getDispatcherAnchor).toHaveBeenCalled();
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: 'wD:pFALLBACK' }),
    );
  });

  it('AC4 fail-safe: a throwing item-tab resolver aborts with anchor-unavailable', async () => {
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1' }),
      getItemTabAnchor: vi.fn().mockRejectedValue(new Error('tab create blew up')),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('anchor-unavailable');
    expect(deps.claimItem).not.toHaveBeenCalled();
  });

  it('legacy wiring: without the per-prefix dep the item-ID tab path is used (backward compat)', async () => {
    const getItemTabAnchor = vi.fn().mockResolvedValue({ tabId: 'wC:tX', paneId: 'wC:tX:p1' });
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1' }),
      getItemTabAnchor,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(getItemTabAnchor).toHaveBeenCalledWith('/repo', 'wC', 'WL-ABC');
    expect('getDispatcherTabAnchor' in deps).toBe(false);
  });

  it('AC1/AC2 per-project separation: each root resolves its own workspace and tab', async () => {
    const wl = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1' }),
      getItemTabAnchor: vi.fn().mockResolvedValue({ tabId: 'wC:tWL-1', paneId: 'wC:tWL-1:p1' }),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'WL-1', title: 'wl', stage: 'intake_complete', status: 'open' },
      }),
    });
    const tce = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wY:pW', workspaceId: 'wY', tabId: 'wY:t1' }),
      getItemTabAnchor: vi.fn().mockResolvedValue({ tabId: 'wY:tTCE-2', paneId: 'wY:tTCE-2:p1' }),
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'TCE-2', title: 'tce', stage: 'intake_complete', status: 'open' },
      }),
    });

    const first = await dispatchDowntimeWork(wl, { model: 'plan', cwd: '/repo-wl' });
    const second = await dispatchDowntimeWork(tce, { model: 'plan', cwd: '/repo-tce' });

    expect(first.dispatched).toBe(true);
    expect(second.dispatched).toBe(true);
    expect(wl.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: 'wC:tWL-1:p1', cwd: '/repo-wl' }),
    );
    expect(tce.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ anchorId: 'wY:tTCE-2:p1', cwd: '/repo-tce' }),
    );
  });

  it('scheduled-prompt spawns keep the Dispatcher anchor (no work-item id)', async () => {
    const getDispatcherAnchor = vi
      .fn()
      .mockResolvedValue({ paneId: 'wD:pSCHED', workspaceId: 'wD' });
    const resolveProjectWorkspace = vi.fn();
    const deps = makeDeps({
      getDispatcherAnchor,
      resolveProjectWorkspace,
      getDueScheduledPrompt: vi
        .fn()
        .mockResolvedValue({ id: 'prompt-1', prompt: 'Run the nightly sweep', frequencyMinutes: 60 }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('scheduled');
    expect(resolveProjectWorkspace).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      'Run the nightly sweep',
      expect.objectContaining({ anchorId: 'wD:pSCHED' }),
    );
  });

  it('AC2 audit-log context: the marker records the item and its project root before the spawn', async () => {
    const recordDispatch = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wY:pW', workspaceId: 'wY', tabId: 'wY:t1' }),
      getItemTabAnchor: vi.fn().mockResolvedValue({ tabId: 'wY:tTCE-9', paneId: 'wY:tTCE-9:p1' }),
      recordDispatch,
      getNextItem: vi.fn().mockResolvedValue({
        ok: true,
        candidate: { id: 'TCE-9', title: 'Engine task', stage: 'intake_complete', status: 'open' },
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo-tce' });

    expect(outcome.dispatched).toBe(true);
    expect(recordDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'TCE-9', kind: 'plan', cwd: '/repo-tce' }),
    );
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: '/repo-tce', anchorId: 'wY:tTCE-9:p1' }),
    );
    const markerOrder = recordDispatch.mock.invocationCallOrder[0];
    const spawnOrder = (deps.spawnAgentPane as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(markerOrder).toBeLessThan(spawnOrder);
  });

  // ── Root-pane cleanup (WL-0MU2EOHK900425VU) ────────────────────────

  it('AC1: closes the project-workspace item tab root pane after a successful dispatch', async () => {
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi
        .fn()
        .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' }),
      // No live downtime pane carries the anchor id → the anchor IS the root
      // pane and must be closed.
      getRunningDowntimePanes: vi
        .fn()
        .mockResolvedValue({ ok: true, count: 0, paneIds: [], records: [] }),
      closePane,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith('wC:tWL-ABC:p1', '/repo');
  });

  it('AC2: NEVER closes the Dispatcher-fallback anchor (would re-provision a blank pane)', async () => {
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      resolveProjectWorkspace: vi.fn().mockResolvedValue(null),
      getDispatcherAnchor: vi
        .fn()
        .mockResolvedValue({ paneId: 'wD:pFALLBACK', workspaceId: 'wD' }),
      closePane,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(closePane).not.toHaveBeenCalled();
  });

  it('AC2: NEVER closes an anchor that is itself a live downtime dispatch pane', async () => {
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi
        .fn()
        .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' }),
      // The anchor id is a recorded downtime pane → it is a previous
      // dispatch's agent pane and must stay open.
      getRunningDowntimePanes: vi.fn().mockResolvedValue({
        ok: true,
        count: 1,
        paneIds: ['wC:tWL-ABC:p1'],
        records: [{ paneId: 'wC:tWL-ABC:p1', label: 'Downtime triggered plan X - WL-ABC' }],
      }),
      closePane,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(closePane).not.toHaveBeenCalled();
  });

  it('AC5 fail-safe: a throwing closePane never blocks the dispatch outcome', async () => {
    const closePane = vi.fn().mockRejectedValue(new Error('herdr close blew up'));
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi
        .fn()
        .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' }),
      closePane,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(closePane).toHaveBeenCalledTimes(1);
  });

  it('AC5 backward-compat: without the closePane dep no cleanup call is attempted', async () => {
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi
        .fn()
        .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' }),
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(deps.closePane).toBeUndefined();
  });

  // ── Audit-rejection regressions (WL-0MU2EOHK900425VU) ─────────────────
  // The producer rejected the first fix because the empty shell pane was
  // still present after creating a tab in an existing workspace. Root cause:
  // the cleanup preferred `records` (the FULL machine-wide pane set, which
  // always contains the anchor itself) over `paneIds` (the running DOWNTIME
  // panes), so `liveIds.includes(anchorId)` was always true and every close
  // was suppressed. The cleanup now uses the running-downtime set.

  it('AC1 regression: closes the root pane even when records contains the anchor (full pane set)', async () => {
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi
        .fn()
        .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' }),
      // Production `records` = the FULL pane list: it contains the blank
      // anchor (which is not a downtime pane). `paneIds` (running downtime
      // panes) is empty → the anchor must be closed.
      getRunningDowntimePanes: vi.fn().mockResolvedValue({
        ok: true,
        count: 0,
        paneIds: [],
        records: [
          { paneId: 'wC:tWL-ABC:p1', label: 'bash' },
          { paneId: 'wC:other', label: 'bash' },
        ],
      }),
      closePane,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith('wC:tWL-ABC:p1', '/repo');
  });

  it('AC1 regression: records-only payload is filtered to downtime panes (anchor still closed)', async () => {
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi
        .fn()
        .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' }),
      // Legacy payload without `paneIds`; `records` holds the blank anchor
      // (not a downtime pane) → filtering yields no live downtime pane.
      getRunningDowntimePanes: vi.fn().mockResolvedValue({
        ok: true,
        count: 0,
        records: [{ paneId: 'wC:tWL-ABC:p1', label: 'bash' }],
      }),
      closePane,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith('wC:tWL-ABC:p1', '/repo');
  });

  it('AC2 fail-safe regression: leaves the anchor open when liveness fails (ok:false)', async () => {
    const closePane = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      resolveProjectWorkspace: vi
        .fn()
        .mockResolvedValue({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' }),
      getItemTabAnchor: vi
        .fn()
        .mockResolvedValue({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' }),
      // Liveness query FAILED → cannot confirm → leave the anchor open.
      getRunningDowntimePanes: vi.fn().mockResolvedValue({ ok: false, error: 'herdr unavailable' }),
      closePane,
      getNextItem: vi.fn().mockResolvedValue({ ok: true, candidate }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

    expect(outcome.dispatched).toBe(true);
    expect(closePane).not.toHaveBeenCalled();
  });
});

// ── Bounded model-cooldown wake (WL-0MV5639GG00085Q7) ──────────────────

// These tests exercise the dispatcher seam: a due model cooldown candidate
// sourced by the scan is resumed through the existing stalled-resume path,
// at most one per cycle, and it is preferred over opening a new pane.
describe('bounded model-cooldown wake (WL-0MV5639GG00085Q7)', () => {
  const ITEM_ID = 'WL-COOL';
  const NOW = Date.now();

  function cooldownCandidate(paneId: string): StalledPaneCandidate {
    return {
      pane: {
        paneId,
        label: `Downtime triggered implement Cooled job - ${ITEM_ID}`,
        agent: 'pi',
        agentStatus: 'idle',
      },
      item: {
        id: ITEM_ID,
        status: 'open',
        stage: 'plan_complete',
        risk: 'low',
        effort: 'small',
        updatedAt: new Date(NOW - 1000).toISOString(),
      },
      cwd: '/repo',
      kind: 'implement',
      modelCooldown: {
        paneId,
        sessionId: null,
        itemId: ITEM_ID,
        kind: 'implement',
        reason: 'all providers exhausted',
        createdAt: NOW - 60 * 1000,
        cooldownUntil: NOW - 1,
      },
    };
  }

  it('resumes at most ONE due cooldown job and opens no new pane', async () => {
    const resumeStalledPane = vi.fn().mockResolvedValue({
      resumed: true,
      via: 'prompt',
      paneId: 'p1',
      itemId: ITEM_ID,
      kind: 'implement',
    });
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockResolvedValue([cooldownCandidate('p1'), cooldownCandidate('p2')]),
      resumeStalledPane,
      getHerdrListHead: vi.fn().mockResolvedValue({
        ok: true,
        items: [{ id: ITEM_ID, title: 'Cooled job', stage: 'plan_complete' }],
      }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'implement', cwd: '/repo', freeSlots: 5 });

    expect(outcome).toEqual({ dispatched: false, reason: 'stalled-resume' });
    // At most one resume: the loop short-circuits on the first success.
    expect(resumeStalledPane).toHaveBeenCalledTimes(1);
    // Preferred over opening a new pane: no head read, no spawn.
    expect(deps.getHerdrListHead).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.getDueScheduledPrompt).not.toHaveBeenCalled();
  });

  it('still resumes at most one job when an earlier cooldown candidate fails', async () => {
    const resumeStalledPane = vi
      .fn()
      .mockResolvedValueOnce({
        resumed: false,
        reason: 'agent-prompt-stalled',
        paneId: 'p1',
        itemId: ITEM_ID,
        kind: 'implement',
      })
      .mockResolvedValueOnce({
        resumed: true,
        via: 'prompt',
        paneId: 'p2',
        itemId: ITEM_ID,
        kind: 'implement',
      });
    const deps = makeDeps({
      scanStalledPanes: vi.fn().mockResolvedValue([cooldownCandidate('p1'), cooldownCandidate('p2')]),
      resumeStalledPane,
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'implement', cwd: '/repo', freeSlots: 5 });

    expect(outcome).toEqual({ dispatched: false, reason: 'stalled-resume' });
    expect(resumeStalledPane).toHaveBeenCalledTimes(2);
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });
});
