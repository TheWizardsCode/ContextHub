/**
 * packages/herdr/src/hydrator.test.ts — unit tests for the Herdr hydrator
 * (WL-0MSOJLZD9004P8PI AC6).
 *
 * The orchestration is dependency-injected, so every case runs without
 * spawning `wl` or `herdr`: fake deps record the demotions actually applied
 * and the test asserts observable behaviour (which items were released and
 * to what status/stage), plus the fail-open paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetExecFileAsync, setExecFileAsync } from './fetcher.js';
import {
  hydratorExecRouter,
  makeWorstCaseItems,
  makeWorstCasePanes,
} from './hydrator.fixtures.js';
import {
  ALLOWED_STAGES_BY_STATUS,
  applyActivePaneMarkers,
  collectPaneWorkItemIds,
  compatibleStage,
  createHydratorFileLog,
  createHydratorRunner,
  createProductionHydratorDeps,
  decideDemotion,
  extractWorkItemIdsFromPaneTitles,
  extractWorkItemIdsFromText,
  isActiveBlocker,
  isActivePaneMatch,
  markItemsActiveByPane,
  runHydrationOnce,
  type HydrationResult,
  type HydratorDepTarget,
  type HydratorDeps,
  type HydratorItem,
  type HydratorPane,
} from './hydrator.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Test helpers ──────────────────────────────────────────────────────

interface AppliedDemotion {
  id: string;
  status: string;
  stage: string;
}

/**
 * The injected-deps contract for the responsiveness fix. The clock, per-step
 * timeout and per-tick cap are part of the target contract and are added to
 * `HydratorDeps` by the implementation children (WL-0MUY1CXSV008F8TZ,
 * WL-0MUY1CYV6008BQWX). Declaring them here lets the test seams carry them
 * without changing the production type until the implementation lands.
 */
interface ContractDeps extends HydratorDeps {
  /** Injectable monotonic clock (ms). */
  now?: () => number;
  /** Per-step timeout (ms); must be below the scheduler watchdog. */
  stepTimeoutMs?: number;
  /** Maximum candidates processed per hydrate tick. */
  maxItemsPerTick?: number;
}

function makeDeps(overrides: Partial<ContractDeps> = {}): {
  deps: ContractDeps;
  applied: AppliedDemotion[];
} {
  const applied: AppliedDemotion[] = [];
  const deps: ContractDeps = {
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

// ── Active-pane matching (WL-0MV1BWETT005GSUJ) ───────────────────────

describe('active-pane matching', () => {
  const pane = (label: string, workspace_id?: string): HydratorPane => ({
    pane_id: `p-${label.length}-${workspace_id ?? 'x'}`,
    label,
    workspace_id,
  });

  it('matches an item whose ID appears in a pane title', () => {
    const panes = [pane('Work Items'), pane(`Downtime triggered implement Foo - ${WL}`)];
    expect(isActivePaneMatch(WL, panes)).toBe(true);
    expect(collectPaneWorkItemIds(panes).has(WL)).toBe(true);
  });

  it('matches when the pane title equals the item ID', () => {
    const panes = [pane(WL)];
    expect(isActivePaneMatch(WL, panes)).toBe(true);
  });

  it('ignores panes whose title carries no work-item ID', () => {
    const panes = [pane('Work Items'), pane('Downtime')];
    expect(collectPaneWorkItemIds(panes).size).toBe(0);
    expect(isActivePaneMatch(WL, panes)).toBe(false);
  });

  it('only considers panes in the given workspace', () => {
    const panes = [pane(`Downtime - ${WL}`, 'wOther')];
    expect(isActivePaneMatch(WL, panes, 'wCurrent')).toBe(false);
    expect(isActivePaneMatch(WL, panes, 'wOther')).toBe(true);
  });

  it('includes panes with an unknown workspace when filtering (fail-open)', () => {
    const panes = [pane(`Downtime - ${WL}`)];
    expect(isActivePaneMatch(WL, panes, 'wCurrent')).toBe(true);
  });
});

// ── Pane-based active marker for the selection list (WL-0MV1BWETT005GSUJ) ──

describe('pane-based active marker (selection list)', () => {
  const OTHER = 'WL-0MV24T2VJ007Q49J';

  it('marks an item with a matching pane title as in-progress even when the worklog status is open', () => {
    const items = [{ id: WL, status: 'open', stage: 'plan_complete' }];
    markItemsActiveByPane(items, new Set([WL]));
    expect(items[0].status).toBe('in-progress');
  });

  it('stamps the green-circle agentState when a matching pane exists and clears it otherwise', () => {
    const items = [
      { id: WL, status: 'open', stage: 'plan_complete' },
      { id: OTHER, status: 'open', stage: 'plan_complete' },
    ];
    markItemsActiveByPane(items, new Set([WL]));
    // Matching pane → green circle (agentState 'working').
    expect(items[0].agentState).toBe('working');
    // No matching pane → no green circle.
    expect(items[1].agentState).toBeUndefined();
  });

  it('clears a stale green circle when the pane closes and restores it when it reopens (producer rule)', () => {
    const items = [{ id: WL, status: 'open', stage: 'plan_complete', agentState: 'working' }];
    // Pane closed: a matching pane no longer exists → the green circle clears
    // even though a stale agentState was previously stamped.
    markItemsActiveByPane(items, new Set());
    expect(items[0].agentState).toBeUndefined();
    // Pane reopened → green circle returns.
    markItemsActiveByPane(items, new Set([WL]));
    expect(items[0].agentState).toBe('working');
  });

  it('stamps the green circle regardless of the item stage (open pane = worked on)', () => {
    // Terminal in_review / completed items keep their review STATUS marker,
    // but an OPEN pane still means the item is being worked → green circle.
    const items = [
      { id: WL, status: 'completed', stage: 'in_review' },
      { id: OTHER, status: 'completed', stage: 'done' },
    ];
    markItemsActiveByPane(items, new Set([WL])); // only WL has a matching pane
    expect(items[0].status).toBe('completed'); // review marker untouched
    expect(items[0].agentState).toBe('working'); // but green circle present
    expect(items[1].agentState).toBeUndefined(); // no matching pane in this workspace
  });

  it('leaves an item without a matching pane unchanged', () => {
    const items = [{ id: WL, status: 'open', stage: 'plan_complete' }];
    markItemsActiveByPane(items, new Set([OTHER]));
    expect(items[0].status).toBe('open');
  });

  it('marks matching children recursively', () => {
    const child = { id: WL, status: 'open', stage: 'plan_complete' };
    const parent = { id: 'WL-PARENT000000', status: 'open', stage: 'idea', children: [child] };
    markItemsActiveByPane([parent], new Set([WL]));
    expect(parent.status).toBe('open');
    expect(child.status).toBe('in-progress');
  });

  it('never re-opens terminal in_review / completed items (they keep their review marker)', () => {
    const items = [
      { id: WL, status: 'open', stage: 'in_review' },
      { id: OTHER, status: 'completed', stage: 'done' },
    ];
    markItemsActiveByPane(items, new Set([WL, OTHER]));
    expect(items[0].status).toBe('open');
    expect(items[1].status).toBe('completed');
  });

  it('is idempotent: a still-open pane keeps the marker and a closed pane clears it', () => {
    const items = [{ id: WL, status: 'open', stage: 'plan_complete' }];
    markItemsActiveByPane(items, new Set([WL]));
    expect(items[0].status).toBe('in-progress');
    // Pane still open — a repeated pass must not mistake the marker for the
    // true status and clobber the base bookkeeping.
    markItemsActiveByPane(items, new Set([WL]));
    expect(items[0].status).toBe('in-progress');
    // Pane closed — the marker clears back to the true worklog status without
    // any `wl` re-fetch.
    markItemsActiveByPane(items, new Set());
    expect(items[0].status).toBe('open');
    // Pane re-opened — the marker comes back.
    markItemsActiveByPane(items, new Set([WL]));
    expect(items[0].status).toBe('in-progress');
  });

  it('keeps the bookkeeping status out of the serialized item shape', () => {
    const items = [{ id: WL, status: 'open', stage: 'plan_complete' }];
    markItemsActiveByPane(items, new Set([WL]));
    // Only real fields (id/status/stage + the green-circle agentState) are
    // enumerable; the base-status bookkeeping Symbol is not.
    expect(Object.keys(items[0]).sort()).toEqual(['agentState', 'id', 'stage', 'status']);
  });

  it('applyActivePaneMarkers scopes the pane lookup to the current workspace', async () => {
    const items = [{ id: WL, status: 'open', stage: 'plan_complete' }];
    const seen: Array<string | undefined> = [];
    await applyActivePaneMarkers(
      items,
      async (workspaceId) => {
        seen.push(workspaceId);
        return [{ pane_id: 'wC:p1', label: `Downtime triggered - ${WL}`, workspace_id: 'wCurrent' }];
      },
      'wCurrent',
    );
    expect(seen).toEqual(['wCurrent']);
    expect(items[0].status).toBe('in-progress');
  });

  it('does not mark an item whose only matching pane is in another workspace', async () => {
    const items = [{ id: WL, status: 'open', stage: 'plan_complete' }];
    await applyActivePaneMarkers(
      items,
      async () => [{ pane_id: 'wO:p1', label: `Downtime - ${WL}`, workspace_id: 'wOther' }],
      'wCurrent',
    );
    expect(items[0].status).toBe('open');
  });

  it('fails open when the pane lookup throws or returns null (no marker cleared)', async () => {
    const thrown = [{ id: WL, status: 'open', stage: 'plan_complete' }];
    await applyActivePaneMarkers(
      thrown,
      async () => {
        throw new Error('herdr unavailable');
      },
      'wCurrent',
    );
    expect(thrown[0].status).toBe('open');

    const nulled = [{ id: WL, status: 'open', stage: 'plan_complete' }];
    await applyActivePaneMarkers(nulled, async () => null, 'wCurrent');
    expect(nulled[0].status).toBe('open');
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

  it('never allows the removed in_progress stage for any status (WL-0MUY1CSQG007TCYX)', () => {
    for (const status of Object.keys(ALLOWED_STAGES_BY_STATUS)) {
      expect(ALLOWED_STAGES_BY_STATUS[status]).not.toContain('in_progress');
    }
    // The legacy stage is therefore always repaired to a CLI-valid stage.
    expect(compatibleStage('in_progress', 'open')).toBe('plan_complete');
    expect(compatibleStage('in_progress', 'in-progress')).toBe('plan_complete');
    expect(compatibleStage('in_progress', 'blocked')).toBe('plan_complete');
  });

  it('keeps the CLI-valid stages allowed for open and in-progress', () => {
    expect(ALLOWED_STAGES_BY_STATUS.open).toEqual(['idea', 'intake_complete', 'plan_complete']);
    expect(ALLOWED_STAGES_BY_STATUS['in-progress']).toEqual(['intake_complete', 'plan_complete']);
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

  it('releases an otherwise-stuck item to open at intake_complete (AC3 else-branch)', () => {
    expect(decideDemotion(inProgress('plan_complete'), { hasActivePane: false, blocked: false })).toEqual({
      status: 'open',
      stage: 'intake_complete',
    });
  });
});

// ── Pane-title active detection (AC2 / WL-0MV1BWETT005GSUJ) ──────────
// A pane in the current workspace whose title contains the item ID → active;
// otherwise not. No agent-liveness checks: pane-title existence is the signal.

describe('pane-title active detection (AC2)', () => {
  const pane = (label: string, agent_status?: string, workspace_id?: string): HydratorPane => ({
    pane_id: `p-${label.length}-${agent_status ?? 'none'}`,
    label,
    ...(workspace_id !== undefined ? { workspace_id } : {}),
    ...(agent_status !== undefined ? { agent_status } : {}),
  });

  it('isActivePaneMatch: matches a pane whose title carries the ID regardless of agent_status', () => {
    // Pane-title existence is the signal — agent_status is irrelevant.
    const titled = `Downtime triggered implement Foo - ${WL}`;
    expect(isActivePaneMatch(WL, [pane(titled, 'working')])).toBe(true);
    expect(isActivePaneMatch(WL, [pane(titled, 'done')])).toBe(true);
    expect(isActivePaneMatch(WL, [pane(titled, 'exited')])).toBe(true);
    expect(isActivePaneMatch(WL, [pane(titled)])).toBe(true); // absent status also counts
  });

  it('isActivePaneMatch: matches a pane whose title IS exactly the item ID', () => {
    expect(isActivePaneMatch(WL, [pane(WL)])).toBe(true);
  });

  it('isActivePaneMatch: scopes to the current workspace', () => {
    const titled = `Downtime - ${WL}`;
    expect(isActivePaneMatch(WL, [pane(titled, 'working', 'wOther')], 'wCurrent')).toBe(false);
    expect(isActivePaneMatch(WL, [pane(titled, 'working', 'wCurrent')], 'wCurrent')).toBe(true);
  });

  it('isActivePaneMatch: no match when the pane title carries no work-item ID', () => {
    expect(isActivePaneMatch(WL, [pane('Work Items')])).toBe(false);
    expect(isActivePaneMatch(WL, [pane('A general shell')])).toBe(false);
  });
});

// ── AC1: pane-title ID extraction ─────────────────────────────────────

describe('extractWorkItemIdsFromPaneTitles (AC1)', () => {
  it('extracts every work-item ID found in pane labels', () => {
    const panes = [
      { pane_id: 'p1', label: `implement ${WL} --focused` },
      { pane_id: 'p2', label: 'Work Items' },
    ];
    expect(extractWorkItemIdsFromPaneTitles(panes)).toEqual([WL]);
  });

  it('returns an empty array when no pane label carries an ID', () => {
    expect(extractWorkItemIdsFromPaneTitles([{ pane_id: 'p1', label: 'Nothing here' }])).toEqual([]);
    expect(extractWorkItemIdsFromPaneTitles([])).toEqual([]);
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

  it('demotes a pane-less plain item to open at intake_complete (AC3 else-branch)', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [],
    });
    await runHydrationOnce(deps);
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
  });

  it('keeps an item whose pane title carries the item ID (agent_status irrelevant)', async () => {
    // Pane-title existence is the sole signal — agent_status (done/working/absent) is irrelevant.
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [
        { pane_id: 'wC:p1', label: `Downtime triggered - ${WL}`, agent_status: 'done', workspace_id: 'wCurrent' },
      ],
    });
    const result = await runHydrationOnce(deps, 'wCurrent');
    expect(result.demoted).toBe(0);
    expect(applied).toEqual([]);
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

  it('does not query dependencies when a matching pane exists', async () => {
    const listOutboundDeps = vi.fn(async () => []) as unknown as HydratorDeps['listOutboundDeps'];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [{ pane_id: 'w1:p1', label: `Downtime triggered - ${WL}`, workspace_id: 'w1' }],
      listOutboundDeps,
    });
    const result = await runHydrationOnce(deps, 'w1');
    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 0, skipped: 1 });
    expect(applied).toEqual([]);
    expect(listOutboundDeps).not.toHaveBeenCalled();
  });

  it('leaves a pane-matched item untouched even when the dep list would block', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'in_review' }],
      listActivePanes: async () => [{ pane_id: 'p1', label: `Downtime triggered - ${WL}` }],
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
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
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
      { id: other, status: 'open', stage: 'intake_complete' },
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
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
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
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
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

// ── Responsiveness-fix contract (WL-0MUY1CX9900258E6) ─────────────────
//
// Test-first contract for the hydrate-responsiveness fix. The assertions in
// this section are RED until the implementation children land:
//   • WL-0MUY1CXSV008F8TZ — per-step timing and bounded timeouts (AC2, AC3)
//   • WL-0MUY1CYCB003DTKO — isolate child-process stdio         (AC1)
//   • WL-0MUY1CYV6008BQWX — trim per-tick work                  (AC4, AC5)
//
// Contract pinned here (implement to this):
//   • every hydrator CLI spawn passes `{ stdin: 'ignore', stderr: 'pipe' }`;
//   • `runHydrationOnce` passes the workspace id to `listActivePanes`, which
//     the production deps translate to `herdr pane list [--workspace <id>]`;
//   • each step runs under a per-step timeout (`HydratorDeps.stepTimeoutMs`,
//     default below the 20 s watchdog); a timeout aborts the run with
//     `ok: false` and a `reason` containing the step label;
//   • each step logs `... <label> ... elapsed <n>ms ...` measured with the
//     injected `HydratorDeps.now` clock;
//   • at most `HydratorDeps.maxItemsPerTick` candidates are processed per tick
//     (default 50), each checked against its pane/dependency before demotion.
// Step labels: `in-progress-list`, `pane-list`, `dep-list`, `demotion-apply`.

// ── Verification edge cases (WL-0MV24T2VJ007Q49J) ──────────────────────

describe('pane-title matching (verification)', () => {
  it('keeps an in-progress item whose ID appears in a pane title (producer rule)', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      // A dispatched pane is titled e.g. "Downtime triggered implement Foo -
      // WL-0MSOJLZD9004P8PI" — the ID appears in the title, which is the
      // active signal (WL-0MV1BWETT005GSUJ).
      listActivePanes: async () => [
        { pane_id: 'wC:p1', label: `Downtime triggered implement Foo - ${WL}`, workspace_id: 'wCurrent' },
      ],
    });

    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(result.ok).toBe(true);
    expect(result.demoted).toBe(0);
    expect(applied).toEqual([]);
  });

  it('demotes when no pane title carries the ID', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      listActivePanes: async () => [
        { pane_id: 'wC:p1', label: 'A general shell session', workspace_id: 'wCurrent' },
      ],
    });

    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(result.ok).toBe(true);
    expect(result.demoted).toBe(1);
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
  });
});

describe('workspace scoping at orchestration level', () => {
  it('demotes when the only matching pane is in a different workspace', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      listActivePanes: async () => [
        { pane_id: 'wO:p1', label: `Downtime triggered - ${WL}`, workspace_id: 'wOther' },
      ],
    });

    await runHydrationOnce(deps, 'wCurrent');

    // Pane exists but in the wrong workspace → item demoted.
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
  });

  it('keeps an item when a matching pane is in the current workspace', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      listActivePanes: async () => [
        { pane_id: 'wC:p1', label: 'Work Items' },
        { pane_id: 'wC:p2', label: `Downtime triggered - ${WL}`, workspace_id: 'wCurrent' },
      ],
    });

    await runHydrationOnce(deps, 'wCurrent');

    // Pane in current workspace → item not demoted.
    expect(applied).toEqual([]);
  });
});

describe('unparseable pane list output fails open', () => {
  it('does not demote when the pane seam returns null (unparseable output)', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      // Simulates the pane-list seam returning null (e.g. garbled JSON output).
      listActivePanes: async () => null,
    });

    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('pane list');
    expect(applied).toEqual([]);
  });
});

describe('production active-detection spawns (pane list)', () => {
  it('asserts that every hydrator CLI spawn uses pane list, never tab list', async () => {
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps();

    await deps.listInProgressItems();
    await deps.listActivePanes();
    await deps.listOutboundDeps(WL);
    await deps.applyDemotion(WL, 'open', 'plan_complete');

    // Every recorded spawn must not include `tab` for the active-detection
    // lookup (pane titles are the signal).
    expect(calls).toHaveLength(4);
    // The seam uses `herdr pane list` (bin may be a full path when
    // HERDR_BIN_PATH is set).
    const paneCall = calls.find(
      (call) => call.bin.endsWith('herdr') && call.args.includes('pane'),
    );
    expect(paneCall).toBeDefined();
    expect(paneCall!.args).toEqual(['pane', 'list']);
  });
});

describe('closed pane clears the in-progress marker (cadence re-evaluation)', () => {
  it('a pane present keeps the item; removing the pane demotes on next run', async () => {
    let visiblePane: string | undefined = `Downtime triggered - ${WL}`;
    const applied: AppliedDemotion[] = [];
    const { deps } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      listActivePanes: async () =>
        visiblePane
          ? [{ pane_id: 'wC:p1', label: visiblePane, workspace_id: 'wCurrent' }]
          : [],
      applyDemotion: async (id, status, stage) => {
        applied.push({ id, status, stage });
        return true;
      },
    });
    const run = createHydratorRunner(deps, {
      isVisible: async () => true,
    });

    // Pane is present — no demotion.
    const result1 = await run();
    expect(result1?.ok).toBe(true);
    expect(result1?.demoted).toBe(0);
    expect(applied).toHaveLength(0);

    // Simulate the user closing the work-item pane.
    visiblePane = undefined;

    // Next cadence run — pane gone → demotion.
    const result2 = await run();
    expect(result2?.ok).toBe(true);
    expect(result2?.demoted).toBe(1);
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
  });
});

// ── Production log sink (AC5 / F2) ────────────────────────────────────

describe('production log sink (AC5)', () => {
  it('createProductionHydratorDeps exposes a log sink by default', () => {
    const deps = createProductionHydratorDeps();
    expect(typeof deps.log).toBe('function');
  });

  it('listOutboundDeps enriches non-terminal edges with their stage via wl show (AC3)', async () => {
    // A dep edge whose target is at stage in_review must NOT be treated as an
    // active blocker (per isDependencyActive in database.ts), even though
    // `wl dep list` carries only status. The production seam therefore fetches
    // the stage via `wl show` for every non-completed/deleted edge.
    let showCalls = 0;
    const exec = async (bin: string, args: string[]) => {
      if (args[0] === 'dep') {
        return {
          stdout: JSON.stringify({
            outbound: [
              { id: 'WL-EDGE-INREVIEW', status: 'open', direction: 'depends-on' },
              { id: 'WL-EDGE-DONE', status: 'completed', direction: 'depends-on' },
              { id: 'WL-EDGE-PLAN', status: 'in-progress', direction: 'depends-on' },
            ],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'show') {
        showCalls += 1;
        const stage =
          args[1] === 'WL-EDGE-INREVIEW'
            ? 'in_review'
            : args[1] === 'WL-EDGE-PLAN'
              ? 'plan_complete'
              : 'idea';
        return {
          stdout: JSON.stringify({ workItem: { id: args[1], stage } }),
          stderr: '',
        };
      }
      return { stdout: '{}', stderr: '' };
    };
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps({ log: () => {} });

    const targets = await deps.listOutboundDeps(WL);

    expect(showCalls).toBe(2); // only the two non-terminal edges are fetched
    expect(targets).toEqual([
      { id: 'WL-EDGE-INREVIEW', status: 'open', direction: 'depends-on', stage: 'in_review' },
      { id: 'WL-EDGE-DONE', status: 'completed', direction: 'depends-on' },
      { id: 'WL-EDGE-PLAN', status: 'in-progress', direction: 'depends-on', stage: 'plan_complete' },
    ]);
  });

  it('listOutboundDeps fails open when wl show is unavailable (edge keeps status only)', async () => {
    const exec = async (bin: string, args: string[]) => {
      if (args[0] === 'dep') {
        return {
          stdout: JSON.stringify({
            outbound: [{ id: 'WL-EDGE', status: 'open', direction: 'depends-on' }],
          }),
          stderr: '',
        };
      }
      throw new Error('wl show unavailable');
    };
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps({ log: () => {} });

    const targets = await deps.listOutboundDeps(WL);

    // Stage unknown → edge retained as-is; isActiveBlocker conservatively
    // treats the unknown-stage edge as an active blocker.
    expect(targets).toEqual([{ id: 'WL-EDGE', status: 'open', direction: 'depends-on' }]);
  });

  it('logs a diagnostic through the injected sink when a cycle fails open', async () => {
    const logs: string[] = [];
    const { deps } = makeDeps({
      log: (m) => logs.push(m),
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      listActivePanes: async () => {
        throw new Error('herdr missing');
      },
    });
    const result = await runHydrationOnce(deps);
    expect(result.ok).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('pane-list'))).toBe(true);
  });

  it('createHydratorFileLog appends bounded lines to <cwd>/.worklog/logs/hydrator.log', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hydrator-log-'));
    const log = createHydratorFileLog({ cwd: tmp, maxLines: 3 });
    log('one');
    log('two');
    log('three');
    log('four');
    const text = readFileSync(join(tmp, '.worklog', 'logs', 'hydrator.log'), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('two');
    expect(lines[2]).toContain('four');
  });
});

// Restore the injectable exec seam after every test in this file.
afterEach(() => {
  resetExecFileAsync();
});

// ── AC1: stdio isolation on every hydrator CLI spawn ──────────────────

describe('hydrator CLI stdio isolation (AC1)', () => {
  it('passes stdin:ignore and stderr:pipe on every hydrator CLI spawn', async () => {
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);

    const deps = createProductionHydratorDeps();
    await deps.listInProgressItems();
    await deps.listActivePanes();
    await deps.listOutboundDeps(WL);
    await deps.applyDemotion(WL, 'open', 'plan_complete');

    // All four hydrator spawn shapes were exercised (in-progress list, pane
    // list, per-item dep list, demotion apply).
    expect(calls).toHaveLength(4);
    expect(calls.some((call) => call.args.includes('pane'))).toBe(true);
    expect(calls.some((call) => call.args.includes('dep'))).toBe(true);
    expect(calls.some((call) => call.args.includes('update'))).toBe(true);
    for (const call of calls) {
      expect(call.options).toMatchObject({ stdin: 'ignore', stderr: 'pipe' });
    }
  });
});

// ── AC4: workspace-scoped pane listing ────────────────────────────────

describe('workspace-scoped pane listing (AC4)', () => {
  it('passes the current workspace id to the pane-list seam', async () => {
    const seen: Array<string | undefined> = [];
    const { deps } = makeDeps({
      listInProgressItems: async () => [],
      listActivePanes: (async (workspaceId?: string) => {
        seen.push(workspaceId);
        return [];
      }) as HydratorDeps['listActivePanes'],
    });

    await runHydrationOnce(deps, 'wCurrent');

    expect(seen).toEqual(['wCurrent']);
  });

  it('runs "herdr pane list --workspace <id>" when the workspace id is known', async () => {
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps();
    const listActivePanes = deps.listActivePanes as (
      workspaceId?: string,
    ) => Promise<HydratorPane[] | null>;

    await listActivePanes('wCurrent');

    const paneCall = calls.find((call) => call.args.includes('pane'));
    expect(paneCall).toBeDefined();
    const index = paneCall!.args.indexOf('--workspace');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(paneCall!.args[index + 1]).toBe('wCurrent');
  });

  it('omits the --workspace filter when the workspace id is unknown', async () => {
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps();

    await deps.listActivePanes();

    const paneCall = calls.find((call) => call.args.includes('pane'));
    expect(paneCall).toBeDefined();
    expect(paneCall!.args).not.toContain('--workspace');
  });
});

// ── AC2: per-step timeouts abort and name the offending step ──────────

describe('per-step timeouts (AC2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the run and names the first step when it exceeds its budget', async () => {
    const listOutboundDeps = vi.fn(async () => []);
    const applyDemotion = vi.fn(async () => true);
    const { deps } = makeDeps({
      // The first lookup wedges like a hung `wl`/`herdr` child.
      listInProgressItems: () => new Promise<HydratorItem[]>(() => {}),
      listActivePanes: async () => [],
      listOutboundDeps,
      applyDemotion,
      stepTimeoutMs: 1_000,
      log: () => {},
    });

    let result: HydrationResult | undefined;
    void runHydrationOnce(deps).then((r) => {
      result = r;
    });

    await vi.advanceTimersByTimeAsync(1_001);

    expect(result).toBeDefined();
    expect(result?.ok).toBe(false);
    expect(result?.reason ?? '').toMatch(/timeout/i);
    expect(result?.reason ?? '').toContain('in-progress-list');
    expect(listOutboundDeps).not.toHaveBeenCalled();
    expect(applyDemotion).not.toHaveBeenCalled();
  });

  it('stops the item loop when a per-item dep-list step times out', async () => {
    const items: HydratorItem[] = [
      { id: 'WL-AAA0000000001', status: 'in-progress', stage: 'plan_complete' },
      { id: 'WL-BBB0000000002', status: 'in-progress', stage: 'plan_complete' },
    ];
    const listOutboundDeps = vi.fn(
      () => new Promise<HydratorDepTarget[]>(() => {}),
    );
    const applyDemotion = vi.fn(async () => true);
    const { deps } = makeDeps({
      listInProgressItems: async () => items,
      listActivePanes: async () => [],
      listOutboundDeps,
      applyDemotion,
      stepTimeoutMs: 500,
      log: () => {},
    });

    let result: HydrationResult | undefined;
    void runHydrationOnce(deps).then((r) => {
      result = r;
    });

    await vi.advanceTimersByTimeAsync(501);

    expect(result?.ok).toBe(false);
    expect(result?.reason ?? '').toContain('dep-list');
    // The loop stopped after the timed-out item: one dep-list, no demotion,
    // and the deferred second item was never looked up.
    expect(listOutboundDeps).toHaveBeenCalledTimes(1);
    expect(applyDemotion).not.toHaveBeenCalled();
  });
});

// ── AC3: per-step timing logs via the injected clock ──────────────────

describe('per-step timing logs (AC3)', () => {
  it('emits a labelled elapsed-ms log for every step using the injected clock', async () => {
    const logs: string[] = [];
    // Each seam advances the injected clock by its own duration, so the
    // elapsed value is deterministic and independent of how often the
    // implementation reads `now()`. The clock deltas are 7/3/5/12 ms.
    let clock = 1_000;
    const { deps } = makeDeps({
      now: () => clock,
      listInProgressItems: async () => {
        clock += 7;
        return [{ id: WL, status: 'in-progress', stage: 'plan_complete' }];
      },
      listActivePanes: async () => {
        clock += 3;
        return [];
      },
      listOutboundDeps: async () => {
        clock += 5;
        return [];
      },
      applyDemotion: async () => {
        clock += 12;
        return true;
      },
      log: (message) => logs.push(message),
    });

    await runHydrationOnce(deps);

    const lineFor = (label: string): string | undefined =>
      logs.find((line) => line.includes(label));
    expect(lineFor('in-progress-list')).toMatch(/elapsed 7ms/);
    expect(lineFor('pane-list')).toMatch(/elapsed 3ms/);
    expect(lineFor('dep-list')).toMatch(/elapsed 5ms/);
    expect(lineFor('demotion-apply')).toMatch(/elapsed 12ms/);
  });
});

// ── AC5: per-tick processing cap ──────────────────────────────────────

describe('per-tick processing cap (AC5)', () => {
  it('processes at most maxItemsPerTick candidates, each with its check', async () => {
    const items = makeWorstCaseItems(25);
    const depChecked: string[] = [];
    const demoted: string[] = [];
    const { deps } = makeDeps({
      listInProgressItems: async () => items,
      listActivePanes: async () => [],
      listOutboundDeps: async (id) => {
        depChecked.push(id);
        return [];
      },
      applyDemotion: async (id) => {
        demoted.push(id);
        return true;
      },
      maxItemsPerTick: 10,
    });

    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(demoted).toHaveLength(10);
    expect(depChecked).toHaveLength(10);
    // Every demotion was preceded by its own tab/dependency check.
    for (const id of demoted) expect(depChecked).toContain(id);
    // Deferred candidates were never touched this tick.
    for (const id of items.slice(10).map((item) => item.id)) {
      expect(depChecked).not.toContain(id);
      expect(demoted).not.toContain(id);
    }
    expect(result.demoted).toBe(10);
  });

  it('honours the cap under a 60-pane / 25-item worst case', async () => {
    const panes = makeWorstCasePanes(60);
    const items = makeWorstCaseItems(25);
    const depChecked: string[] = [];
    const { deps } = makeDeps({
      listInProgressItems: async () => items,
      listActivePanes: async () => panes,
      listOutboundDeps: async (id) => {
        depChecked.push(id);
        return [];
      },
      applyDemotion: async () => true,
      maxItemsPerTick: 5,
    });

    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(result.demoted).toBe(5);
    expect(depChecked).toHaveLength(5);
  });

  it('applies a default cap of at most 50 candidates', async () => {
    const items = makeWorstCaseItems(60);
    const { deps } = makeDeps({
      listInProgressItems: async () => items,
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      applyDemotion: async () => true,
    });

    const result = await runHydrationOnce(deps);

    expect(result.demoted).toBeLessThanOrEqual(50);
  });
});
