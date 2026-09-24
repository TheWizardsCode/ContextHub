/**
 * packages/herdr/src/hydrator.test.ts — unit tests for the Herdr hydrator
 * (WL-0MSOJLZD9004P8PI AC6).
 *
 * The orchestration is dependency-injected, so every case runs without
 * spawning `wl` or `herdr`: fake deps record the demotions actually applied
 * and the test asserts observable behaviour (which items were released and
 * to what status/stage), plus the fail-open paths.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  collectPaneWorkItemIds,
  compatibleStage,
  createHydratorRunner,
  createProductionHydratorDeps,
  decideDemotion,
  extractWorkItemIdsFromText,
  isActiveBlocker,
  isActivePaneMatch,
  runHydrationOnce,
  type HydratorDeps,
  type HydratorItem,
  type HydratorPane,
} from './hydrator.js';

// ── Test helpers ──────────────────────────────────────────────────────

interface AppliedDemotion {
  id: string;
  status: string;
  stage: string;
}

function makeDeps(overrides: Partial<HydratorDeps> = {}): {
  deps: HydratorDeps;
  applied: AppliedDemotion[];
} {
  const applied: AppliedDemotion[] = [];
  const deps: HydratorDeps = {
    listInProgressItems: async () => [],
    listActivePanes: async () => [],
    listOutboundDeps: async () => [],
    applyDemotion: async (id, status, stage) => {
      applied.push({ id, status, stage });
      return true;
    },
    log: () => {},
    ...overrides,
  };
  return { deps, applied };
}

const WL = 'WL-0MSOJLZD9004P8PI';

// ── ID extraction ─────────────────────────────────────────────────────

describe('extractWorkItemIdsFromText', () => {
  it('extracts a work-item ID embedded in a pane title', () => {
    expect(
      extractWorkItemIdsFromText(`Manually triggered implement Foo - ${WL}`),
    ).toEqual([WL]);
  });

  it('extracts every ID from a title with multiple matches', () => {
    expect(
      extractWorkItemIdsFromText('implement WL-AAA111111 AND AH-BBB222222'),
    ).toEqual(['WL-AAA111111', 'AH-BBB222222']);
  });

  it('returns an empty array when no ID is present (truncated title)', () => {
    expect(
      extractWorkItemIdsFromText('Manually triggered implement Enable Main Street…'),
    ).toEqual([]);
  });

  it('ignores lowercase ids and empty input', () => {
    expect(extractWorkItemIdsFromText('wl-1234567890')).toEqual([]);
    expect(extractWorkItemIdsFromText('')).toEqual([]);
  });
});

// ── Active-pane matching ──────────────────────────────────────────────

describe('active-pane matching', () => {
  const pane = (label: string, workspace_id?: string): HydratorPane => ({
    pane_id: `p-${label.length}-${workspace_id ?? 'x'}`,
    label,
    workspace_id,
  });

  it('matches an item whose ID appears in any live pane title', () => {
    const panes = [pane(`implement Foo - AA-111111111`), pane(`plan ${WL}`)];
    expect(isActivePaneMatch(WL, panes)).toBe(true);
    expect(collectPaneWorkItemIds(panes).has(WL)).toBe(true);
  });

  it('returns false when no pane carries the ID', () => {
    const panes = [pane('Manually triggered implement Enable Main Street…')];
    expect(isActivePaneMatch(WL, panes)).toBe(false);
  });

  it('only considers panes in the given workspace', () => {
    const panes = [pane(`implement ${WL}`, 'wOther')];
    expect(isActivePaneMatch(WL, panes, 'wCurrent')).toBe(false);
    expect(isActivePaneMatch(WL, panes, 'wOther')).toBe(true);
  });

  it('includes panes with an unknown workspace when filtering (fail-open)', () => {
    const panes = [pane(`implement ${WL}`)];
    expect(isActivePaneMatch(WL, panes, 'wCurrent')).toBe(true);
  });
});

// ── Dependency blocker ────────────────────────────────────────────────

describe('isActiveBlocker', () => {
  it('treats an open/unfinished target as an active blocker', () => {
    expect(isActiveBlocker({ id: 'WL-1', status: 'open', stage: 'plan_complete' })).toBe(true);
  });

  it('is not a blocker when the target is completed or deleted', () => {
    expect(isActiveBlocker({ id: 'WL-1', status: 'completed', stage: 'in_review' })).toBe(false);
    expect(isActiveBlocker({ id: 'WL-1', status: 'deleted', stage: 'idea' })).toBe(false);
  });

  it('is not a blocker when the target is at a terminal stage', () => {
    expect(isActiveBlocker({ id: 'WL-1', status: 'open', stage: 'in_review' })).toBe(false);
    expect(isActiveBlocker({ id: 'WL-1', status: 'open', stage: 'done' })).toBe(false);
  });
});

// ── Compatibility + decision ──────────────────────────────────────────

describe('compatibleStage', () => {
  it('keeps a stage valid for the target status', () => {
    expect(compatibleStage('plan_complete', 'open')).toBe('plan_complete');
    expect(compatibleStage('idea', 'blocked')).toBe('idea');
  });

  it('repairs an invalid stage (blocked cannot sit at in_progress)', () => {
    expect(compatibleStage('in_progress', 'blocked')).toBe('plan_complete');
  });
});

describe('decideDemotion', () => {
  const inProgress = (stage?: string): HydratorItem => ({ id: WL, status: 'in-progress', stage });

  it('leaves non-in-progress items untouched', () => {
    expect(decideDemotion({ id: WL, status: 'open', stage: 'idea' }, { hasActivePane: false, blocked: false })).toBeNull();
  });

  it('leaves items with a live pane untouched', () => {
    expect(decideDemotion(inProgress('plan_complete'), { hasActivePane: true, blocked: false })).toBeNull();
  });

  it('completes an in_review item', () => {
    expect(decideDemotion(inProgress('in_review'), { hasActivePane: false, blocked: false })).toEqual({
      status: 'completed',
      stage: 'in_review',
    });
  });

  it('blocks an item with an active dependency', () => {
    expect(decideDemotion(inProgress('plan_complete'), { hasActivePane: false, blocked: true })).toEqual({
      status: 'blocked',
      stage: 'plan_complete',
    });
  });

  it('releases an otherwise-stuck item to open at its claimed stage', () => {
    expect(decideDemotion(inProgress('plan_complete'), { hasActivePane: false, blocked: false })).toEqual({
      status: 'open',
      stage: 'plan_complete',
    });
  });
});

// ── Orchestration ─────────────────────────────────────────────────────

describe('runHydrationOnce', () => {
  it('demotes a pane-less in_review item to completed', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'in_review' }],
      listActivePanes: async () => [],
    });
    const result = await runHydrationOnce(deps);
    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 1 });
    expect(applied).toEqual([{ id: WL, status: 'completed', stage: 'in_review' }]);
  });

  it('demotes a pane-less plain item to open at its claimed stage', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [],
    });
    await runHydrationOnce(deps);
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'plan_complete' }]);
  });

  it('demotes to blocked when an outbound dependency is active', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'in_progress' }],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [{ id: 'WL-OTHER', status: 'open', stage: 'plan_complete' }],
    });
    await runHydrationOnce(deps);
    expect(applied).toEqual([{ id: WL, status: 'blocked', stage: 'plan_complete' }]);
  });

  it('does not query dependencies when a live pane matches', async () => {
    const listOutboundDeps = vi.fn(async () => []) as unknown as HydratorDeps['listOutboundDeps'];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [{ pane_id: 'p1', label: `implement ${WL}`, workspace_id: 'w1' }],
      listOutboundDeps,
    });
    const result = await runHydrationOnce(deps, 'w1');
    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 0, skipped: 1 });
    expect(applied).toEqual([]);
    expect(listOutboundDeps).not.toHaveBeenCalled();
  });

  it('leaves a live-pane item untouched even when the dep list would block', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'in_review' }],
      listActivePanes: async () => [{ pane_id: 'p1', label: `implement ${WL}` }],
      listOutboundDeps: async () => [{ id: 'WL-OTHER', status: 'open' }],
    });
    await runHydrationOnce(deps);
    expect(applied).toEqual([]);
  });

  it('fails open (no demotion) when the pane list is unavailable', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => {
        throw new Error('herdr missing');
      },
    });
    const result = await runHydrationOnce(deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('pane list');
    expect(applied).toEqual([]);
  });

  it('fails open when the in-progress list is unavailable', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => {
        throw new Error('wl missing');
      },
      listActivePanes: async () => [],
    });
    const result = await runHydrationOnce(deps);
    expect(result.ok).toBe(false);
    expect(applied).toEqual([]);
  });

  it('counts a failed demotion as skipped, not demoted', async () => {
    const { deps } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [],
      applyDemotion: async () => false,
    });
    const result = await runHydrationOnce(deps);
    expect(result).toMatchObject({ ok: true, demoted: 0, skipped: 1 });
  });

  it('treats a throwing dependency lookup as not-blocked and still releases the item', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [],
      listOutboundDeps: async () => {
        throw new Error('dep lookup failed');
      },
    });
    const result = await runHydrationOnce(deps);
    expect(result.demoted).toBe(1);
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'plan_complete' }]);
  });

  it('demotes multiple stuck items independently', async () => {
    const other = 'AH-0MTVYBL2L0085G6G';
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'in_review' },
        { id: other, status: 'in-progress', stage: 'plan_complete' },
      ],
      listActivePanes: async () => [],
    });
    const result = await runHydrationOnce(deps);
    expect(result.demoted).toBe(2);
    expect(applied).toEqual([
      { id: WL, status: 'completed', stage: 'in_review' },
      { id: other, status: 'open', stage: 'plan_complete' },
    ]);
  });
});

// ── Visibility-gated runner (AC4/AC5) ─────────────────────────────────

describe('createHydratorRunner', () => {
  it('does not run (zero work) while the pane is hidden', async () => {
    const listInProgressItems = vi.fn(async () => []);
    const { deps } = makeDeps({ listInProgressItems });
    const run = createHydratorRunner(deps, {
      isVisible: async () => false,
    });
    expect(await run()).toBeNull();
    expect(listInProgressItems).not.toHaveBeenCalled();
  });

  it('runs the hydration cycle when visible', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [],
    });
    const run = createHydratorRunner(deps, { isVisible: async () => true });
    const result = await run();
    expect(result).toMatchObject({ ok: true, demoted: 1 });
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'plan_complete' }]);
  });

  it('runs immediately on the hidden→visible focus-resume (no interval wait)', async () => {
    let visible = false;
    const listInProgressItems = vi.fn(async () => [
      { id: WL, status: 'in-progress', stage: 'plan_complete' },
    ]);
    const { deps, applied } = makeDeps({
      listInProgressItems,
      listActivePanes: async () => [],
    });
    const run = createHydratorRunner(deps, { isVisible: async () => visible });

    // Hidden: gated, no work.
    expect(await run()).toBeNull();
    expect(listInProgressItems).not.toHaveBeenCalled();

    // Focus regained: the SAME runner re-checks immediately.
    visible = true;
    const result = await run();
    expect(result).toMatchObject({ ok: true, demoted: 1 });
    expect(applied).toHaveLength(1);
  });
});

// ── Production wiring ─────────────────────────────────────────────────

describe('createProductionHydratorDeps', () => {
  it('exposes the four injectable seams', () => {
    const deps = createProductionHydratorDeps();
    expect(typeof deps.listInProgressItems).toBe('function');
    expect(typeof deps.listActivePanes).toBe('function');
    expect(typeof deps.listOutboundDeps).toBe('function');
    expect(typeof deps.applyDemotion).toBe('function');
  });
});
