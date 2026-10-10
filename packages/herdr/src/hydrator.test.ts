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
  makeWorstCaseTabs,
} from './hydrator.fixtures.js';
import {
  ALLOWED_STAGES_BY_STATUS,
  collectTabWorkItemIds,
  compatibleStage,
  createHydratorRunner,
  createProductionHydratorDeps,
  decideDemotion,
  extractWorkItemIdsFromText,
  isActiveBlocker,
  hasItemTab,
  runHydrationOnce,
  type HydrationResult,
  type HydratorDepTarget,
  type HydratorDeps,
  type HydratorItem,
  type HydratorTab,
} from './hydrator.js';

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
    listTabs: async () => [],
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

// ── Active-tab matching ───────────────────────────────────────────────

describe('active-tab matching', () => {
  const tab = (label: string, workspace_id?: string): HydratorTab => ({
    tab_id: `t-${label.length}-${workspace_id ?? 'x'}`,
    label,
    workspace_id,
  });

  it('matches an item whose ID is the exact label of a tab', () => {
    const tabs = [tab('Work Items'), tab(WL)];
    expect(hasItemTab(WL, tabs)).toBe(true);
    expect(collectTabWorkItemIds(tabs).has(WL)).toBe(true);
  });

  it('rejects a tab label that merely contains the item ID (exact match only)', () => {
    const tabs = [tab(`implement ${WL}`), tab(`plan ${WL} - extra`)];
    expect(hasItemTab(WL, tabs)).toBe(false);
    expect(collectTabWorkItemIds(tabs).has(WL)).toBe(false);
  });

  it('ignores tabs whose label is not a work-item ID', () => {
    const tabs = [tab('Work Items'), tab('Downtime')];
    expect(collectTabWorkItemIds(tabs).size).toBe(0);
    expect(hasItemTab(WL, tabs)).toBe(false);
  });

  it('only considers tabs in the given workspace', () => {
    const tabs = [tab(WL, 'wOther')];
    expect(hasItemTab(WL, tabs, 'wCurrent')).toBe(false);
    expect(hasItemTab(WL, tabs, 'wOther')).toBe(true);
  });

  it('includes tabs with an unknown workspace when filtering (fail-open)', () => {
    const tabs = [tab(WL)];
    expect(hasItemTab(WL, tabs, 'wCurrent')).toBe(true);
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

  it('releases an otherwise-stuck item to open at its claimed stage', () => {
    expect(decideDemotion(inProgress('plan_complete'), { hasActivePane: false, blocked: false })).toEqual({
      status: 'open',
      stage: 'plan_complete',
    });
  });
});

// ── Orchestration ─────────────────────────────────────────────────────

describe('runHydrationOnce', () => {
  it('demotes a tab-less in_review item to completed', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'in_review' }],
      listTabs: async () => [],
    });
    const result = await runHydrationOnce(deps);
    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 1 });
    expect(applied).toEqual([{ id: WL, status: 'completed', stage: 'in_review' }]);
  });

  it('demotes a tab-less plain item to open at its claimed stage', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listTabs: async () => [],
    });
    await runHydrationOnce(deps);
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'plan_complete' }]);
  });

  it('demotes to blocked when an outbound dependency is active', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'in_progress' }],
      listTabs: async () => [],
      listOutboundDeps: async () => [{ id: 'WL-OTHER', status: 'open', stage: 'plan_complete' }],
    });
    await runHydrationOnce(deps);
    expect(applied).toEqual([{ id: WL, status: 'blocked', stage: 'plan_complete' }]);
  });

  it('does not query dependencies when a matching tab exists', async () => {
    const listOutboundDeps = vi.fn(async () => []) as unknown as HydratorDeps['listOutboundDeps'];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listTabs: async () => [{ tab_id: 't1', label: WL, workspace_id: 'w1' }],
      listOutboundDeps,
    });
    const result = await runHydrationOnce(deps, 'w1');
    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 0, skipped: 1 });
    expect(applied).toEqual([]);
    expect(listOutboundDeps).not.toHaveBeenCalled();
  });

  it('leaves a tab-matched item untouched even when the dep list would block', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'in_review' }],
      listTabs: async () => [{ tab_id: 't1', label: WL }],
      listOutboundDeps: async () => [{ id: 'WL-OTHER', status: 'open' }],
    });
    await runHydrationOnce(deps);
    expect(applied).toEqual([]);
  });

  it('fails open (no demotion) when the tab list is unavailable', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listTabs: async () => {
        throw new Error('herdr missing');
      },
    });
    const result = await runHydrationOnce(deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tab list');
    expect(applied).toEqual([]);
  });

  it('fails open when the in-progress list is unavailable', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => {
        throw new Error('wl missing');
      },
      listTabs: async () => [],
    });
    const result = await runHydrationOnce(deps);
    expect(result.ok).toBe(false);
    expect(applied).toEqual([]);
  });

  it('counts a failed demotion as skipped, not demoted', async () => {
    const { deps } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listTabs: async () => [],
      applyDemotion: async () => false,
    });
    const result = await runHydrationOnce(deps);
    expect(result).toMatchObject({ ok: true, demoted: 0, skipped: 1 });
  });

  it('treats a throwing dependency lookup as not-blocked and still releases the item', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listTabs: async () => [],
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
      listTabs: async () => [],
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
      listTabs: async () => [],
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
      listTabs: async () => [],
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
    expect(typeof deps.listTabs).toBe('function');
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
//   • `runHydrationOnce` passes the workspace id to `listTabs`, which
//     the production deps translate to `herdr tab list [--workspace <id>]`;
//   • each step runs under a per-step timeout (`HydratorDeps.stepTimeoutMs`,
//     default below the 20 s watchdog); a timeout aborts the run with
//     `ok: false` and a `reason` containing the step label;
//   • each step logs `... <label> ... elapsed <n>ms ...` measured with the
//     injected `HydratorDeps.now` clock;
//   • at most `HydratorDeps.maxItemsPerTick` candidates are processed per tick
//     (default 50), each checked against its tab/dependency before demotion.
// Step labels: `in-progress-list`, `tab-list`, `dep-list`, `demotion-apply`.

// ── Verification edge cases (WL-0MV24T2VJ007Q49J) ──────────────────────

describe('pane-title-only ID no longer counts (verification)', () => {
  it('demotes an in-progress item whose ID appears only in a tab label that contains (not equals) the ID', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      // Simulates the old pane-title behaviour: a tab whose label *contains*
      // the ID but is not the exact ID (e.g. "implement WL-0MSOJLZD9004P8PI").
      // Under the tab-matching contract this does NOT count as active.
      listTabs: async () => [
        { tab_id: 't1', label: `implement ${WL}`, workspace_id: 'wCurrent' },
      ],
    });

    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(result.ok).toBe(true);
    expect(result.demoted).toBe(1);
    // The item is demoted because its ID is not an *exact* tab label match.
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'plan_complete' }]);
  });
});

describe('workspace scoping at orchestration level', () => {
  it('demotes when the only matching tab is in a different workspace', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      listTabs: async () => [
        { tab_id: 't1', label: WL, workspace_id: 'wOther' },
      ],
    });

    await runHydrationOnce(deps, 'wCurrent');

    // Tab exists but in the wrong workspace → item demoted.
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'plan_complete' }]);
  });

  it('keeps an item when a matching tab is in the current workspace', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      listTabs: async () => [
        { tab_id: 't1', label: 'Work Items' },
        { tab_id: 't2', label: WL, workspace_id: 'wCurrent' },
      ],
    });

    await runHydrationOnce(deps, 'wCurrent');

    // Exact tab in current workspace → item not demoted.
    expect(applied).toEqual([]);
  });
});

describe('unparseable tab list output fails open', () => {
  it('does not demote when parseTabListOutput returns null (unparseable output)', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      // Simulates parseTabListOutput returning null (e.g. garbled JSON output).
      // This is the unparseable path of the tab-list seam.
      listTabs: async () => null,
    });

    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tab list');
    expect(applied).toEqual([]);
  });
});

describe('no pane list in production hydrator spawns', () => {
  it('asserts that every hydrator CLI spawn uses tab list, never pane list', async () => {
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps();

    await deps.listInProgressItems();
    await deps.listTabs();
    await deps.listOutboundDeps(WL);
    await deps.applyDemotion(WL, 'open', 'plan_complete');

    // Every recorded spawn must not include `pane`.
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain('pane');
    }
    // The second call (listTabs) must use `herdr tab list` (bin may be a
    // full path when HERDR_BIN_PATH is set).
    const tabCall = calls.find((call) => call.args.includes('tab'));
    expect(tabCall).toBeDefined();
    expect(tabCall!.bin.endsWith('herdr')).toBe(true);
    expect(tabCall!.args).toEqual(['tab', 'list']);
  });
});

describe('closed tab clears the in-progress marker (cadence re-evaluation)', () => {
  it('a tab present keeps the item; removing the tab demotes on next run', async () => {
    let visibleTab: string | undefined = WL;
    const applied: AppliedDemotion[] = [];
    const { deps } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      listTabs: async () =>
        visibleTab
          ? [{ tab_id: 't1', label: visibleTab, workspace_id: 'wCurrent' }]
          : [],
      applyDemotion: async (id, status, stage) => {
        applied.push({ id, status, stage });
        return true;
      },
    });
    const run = createHydratorRunner(deps, {
      isVisible: async () => true,
    });

    // Tab is present — no demotion.
    const result1 = await run();
    expect(result1?.ok).toBe(true);
    expect(result1?.demoted).toBe(0);
    expect(applied).toHaveLength(0);

    // Simulate the user closing the work-item tab.
    visibleTab = undefined;

    // Next cadence run — tab gone → demotion.
    const result2 = await run();
    expect(result2?.ok).toBe(true);
    expect(result2?.demoted).toBe(1);
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'plan_complete' }]);
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
    await deps.listTabs();
    await deps.listOutboundDeps(WL);
    await deps.applyDemotion(WL, 'open', 'plan_complete');

    // All four hydrator spawn shapes were exercised (in-progress list, tab
    // list, per-item dep list, demotion apply).
    expect(calls).toHaveLength(4);
    expect(calls.some((call) => call.args.includes('tab'))).toBe(true);
    expect(calls.some((call) => call.args.includes('dep'))).toBe(true);
    expect(calls.some((call) => call.args.includes('update'))).toBe(true);
    for (const call of calls) {
      expect(call.options).toMatchObject({ stdin: 'ignore', stderr: 'pipe' });
    }
  });
});

// ── AC4: workspace-scoped tab listing ─────────────────────────────────

describe('workspace-scoped tab listing (AC4)', () => {
  it('passes the current workspace id to the tab-list seam', async () => {
    const seen: Array<string | undefined> = [];
    const { deps } = makeDeps({
      listInProgressItems: async () => [],
      listTabs: (async (workspaceId?: string) => {
        seen.push(workspaceId);
        return [];
      }) as HydratorDeps['listTabs'],
    });

    await runHydrationOnce(deps, 'wCurrent');

    expect(seen).toEqual(['wCurrent']);
  });

  it('runs "herdr tab list --workspace <id>" when the workspace id is known', async () => {
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps();
    const listTabs = deps.listTabs as (
      workspaceId?: string,
    ) => Promise<HydratorTab[] | null>;

    await listTabs('wCurrent');

    const tabCall = calls.find((call) => call.args.includes('tab'));
    expect(tabCall).toBeDefined();
    const index = tabCall!.args.indexOf('--workspace');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(tabCall!.args[index + 1]).toBe('wCurrent');
  });

  it('omits the --workspace filter when the workspace id is unknown', async () => {
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps();

    await deps.listTabs();

    const tabCall = calls.find((call) => call.args.includes('tab'));
    expect(tabCall).toBeDefined();
    expect(tabCall!.args).not.toContain('--workspace');
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
      listTabs: async () => [],
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
      listTabs: async () => [],
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
      listTabs: async () => {
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
    expect(lineFor('tab-list')).toMatch(/elapsed 3ms/);
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
      listTabs: async () => [],
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

  it('honours the cap under a 60-tab / 25-item worst case', async () => {
    const tabs = makeWorstCaseTabs(60);
    const items = makeWorstCaseItems(25);
    const depChecked: string[] = [];
    const { deps } = makeDeps({
      listInProgressItems: async () => items,
      listTabs: async () => tabs,
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
      listTabs: async () => [],
      listOutboundDeps: async () => [],
      applyDemotion: async () => true,
    });

    const result = await runHydrationOnce(deps);

    expect(result.demoted).toBeLessThanOrEqual(50);
  });
});
