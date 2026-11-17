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
import { resetExecFileAsync, setExecFileAsync, resetWorklogDir, setWorklogDir } from './fetcher.js';
import {
  hydratorExecRouter,
  makeCrossWorkspacePanes,
  makeWorstCaseItems,
  makeWorstCasePanes,
  type CrossWorkspacePaneFixture,
} from './hydrator.fixtures.js';
import {
  ALLOWED_STAGES_BY_STATUS,
  HYDRATOR_CLAIM_GRACE_MS,
  applyActivePaneMarkers,
  buildReleaseComment,
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
  type DemotionOptions,
  type HydrationResult,
  type HydratorDepTarget,
  type HydratorDeps,
  type HydratorItem,
  type HydratorPane,
  type ReleaseEvidence,
} from './hydrator.js';
import type { ClaimHolderVerdict } from './claim-lock.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorklogDatabase } from '@worklog/shared';

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

/**
 * The workspace-agnostic pane read the implementation child
 * (WL-0MWHBSWC20067SMY) adds to `HydratorDeps` (parent AC1/AC4):
 * `herdr pane list` with NO `--workspace` scope, i.e. the panes of every
 * workspace on the host. Declared here — like the clock and per-step budget
 * seams above — so the red witnesses in this file compile and run before the
 * seam exists in the production type. `listActivePanes()` called with no
 * workspace id is the other permitted shape for the same read.
 */
interface CrossWorkspaceDeps extends ContractDeps {
  listAllActivePanes?: () => Promise<HydratorPane[] | null>;
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

// Claim grace window (parent WL-0MWH56SWX004HSKQ AC5): an item claimed
// within `HYDRATOR_CLAIM_GRACE_MS` is never released even with no pane
// visible yet; past the window today's rule applies. A LEGACY payload with
// no `updatedAt`/`activityAt` fails open toward KEEPING the claim (treated
// as a fresh claim inside the window). Fixtures that exercise the
// past-window release path therefore carry an explicit OLD timestamp (far
// outside any clock used in this file) so "today's rule" applies
// deterministically.
const PAST_WINDOW_ISO = '2020-01-01T00:00:00.000Z';

/** Build an in-progress item already past the claim grace window. */
const staleItem = (
  overrides: Partial<HydratorItem> = {},
): HydratorItem => ({
  id: WL,
  status: 'in-progress',
  stage: 'plan_complete',
  updatedAt: PAST_WINDOW_ISO,
  activityAt: PAST_WINDOW_ISO,
  ...overrides,
});

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

  // ── Display vs demotion pane scope (WL-0MWHBSRS4001TFNJ, parent AC2) ──
  //
  // The demotion fix (parent AC1, implementation child WL-0MWHBSWC20067SMY)
  // widens the pane evidence behind "is this item being worked on?" to every
  // workspace. The selection-list marker must NOT follow: "does this item
  // have a pane in MY workspace?" is a different question, and widening the
  // display path would light rows for panes the producer cannot see in this
  // workspace (WL-0MV1BWETT005GSUJ intent preserved).
  //
  // Contract: display = workspace-scoped, demotion = workspace-agnostic.

  it('does not stamp the green circle for an item whose only matching pane is in another workspace (parent AC2)', async () => {
    const fixture = makeCrossWorkspacePanes(WL, { paneIn: 'dispatcher' });
    const items: Array<{
      id: string;
      status?: string;
      stage?: string;
      agentState?: string;
    }> = [{ id: WL, status: 'open', stage: 'plan_complete' }];

    // The plugin's own (item-less) pane is visible; the item's dispatch pane
    // lives in the Dispatcher workspace, so neither the in-progress status
    // marker nor the green circle may be stamped.
    await applyActivePaneMarkers(items, fixture.listActivePanes, fixture.pluginWorkspaceId);

    expect(items[0].status).toBe('open');
    expect(items[0].agentState).toBeUndefined();

    // Same fixture, pane placed in the plugin's own workspace: the marker
    // DOES light up. The discriminator is the workspace, not the pane count.
    const inPlugin = makeCrossWorkspacePanes(WL, { paneIn: 'plugin' });
    const marked = [{ id: WL, status: 'open', stage: 'plan_complete' }];
    await applyActivePaneMarkers(marked, inPlugin.listActivePanes, inPlugin.pluginWorkspaceId);
    expect(marked[0].status).toBe('in-progress');
  });

  it(
    'display = workspace-scoped, demotion = workspace-agnostic: an out-of-workspace pane never lights the marker but still suppresses release (parent AC2)',
    async () => {
      // ONE pane set, two questions. `w5M:p1` is the plugin's own worklist
      // pane; `w6B:p3` is the item's dispatch pane in the Dispatcher
      // workspace (the reported 2026-11-15 release).
      const fixture = makeCrossWorkspacePanes(WL, { paneIn: 'dispatcher' });

      // DISPLAY — workspace-scoped: the row stays unmarked.
      const items: Array<{
        id: string;
        status?: string;
        stage?: string;
        agentState?: string;
      }> = [{ id: WL, status: 'open', stage: 'plan_complete' }];
      await applyActivePaneMarkers(items, fixture.listActivePanes, fixture.pluginWorkspaceId);
      expect(items[0].status).toBe('open');
      expect(items[0].agentState).toBeUndefined();

      // DEMOTION — workspace-agnostic (parent AC1): the SAME pane is evidence
      // the item is being worked on, so the live dispatch claim is kept via
      // the wider `listAllActivePanes` read (WL-0MWHBSWC20067SMY).
      const applied: Array<{ id: string; status: string; stage: string }> = [];
      const deps: CrossWorkspaceDeps = {
        listInProgressItems: async () => [
          { id: WL, status: 'in-progress', stage: 'plan_complete', assignee: 'dispatcher' },
        ],
        // Both permitted shapes of the workspace-agnostic read, so either
        // implementation satisfies this test.
        listActivePanes: fixture.listActivePanes,
        listAllActivePanes: fixture.listAllActivePanes,
        listOutboundDeps: async () => [],
        // Pane evidence must be the ONLY signal: pin a dead claim holder.
        hasLiveClaimHolder: async () =>
          new Map<string, ClaimHolderVerdict>([[WL, { held: false, reason: 'no-lock-file' }]]),
        applyDemotion: async (id, status, stage) => {
          applied.push({ id, status, stage });
          return true;
        },
        log: () => {},
      };

      const result = await runHydrationOnce(deps, fixture.pluginWorkspaceId);

      expect(result.demoted).toBe(0);
      expect(applied).toEqual([]);
    },
  );
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

  // ── Live claim holder (WL-0MVWDB3IG004NRIU) ──────────────────────────
  // `held` is evaluated AFTER the `in_review` and `blocked` branches, so a
  // held claim suppresses ONLY the release-to-`open` branch and never
  // overrides the audit-tier or dependency transitions.

  it('suppresses the open release while a claim holder is live', () => {
    expect(decideDemotion(inProgress('plan_complete'), { hasActivePane: false, blocked: false, held: true })).toBeNull();
  });

  it('held never overrides the in_review → completed branch', () => {
    expect(decideDemotion(inProgress('in_review'), { hasActivePane: false, blocked: false, held: true })).toEqual({
      status: 'completed',
      stage: 'in_review',
    });
  });

  it('held never overrides the blocked branch', () => {
    expect(decideDemotion(inProgress('plan_complete'), { hasActivePane: false, blocked: true, held: true })).toEqual({
      status: 'blocked',
      stage: 'plan_complete',
    });
  });

  it('pane match stays primary even when the claim is held', () => {
    expect(decideDemotion(inProgress('plan_complete'), { hasActivePane: true, blocked: false, held: true })).toBeNull();
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
      listInProgressItems: async () => [staleItem()],
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
      // Past the grace window so the release is attempted; the failing
      // `applyDemotion` is what must be counted as skipped (parent AC5 keeps
      // only in-window claims, which never reach the demotion seam).
      listInProgressItems: async () => [staleItem()],
      listActivePanes: async () => [],
      applyDemotion: async () => false,
    });
    const result = await runHydrationOnce(deps);
    expect(result).toMatchObject({ ok: true, demoted: 0, skipped: 1 });
  });

  it('treats a throwing dependency lookup as not-blocked and still releases the item', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [staleItem()],
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
        { id: other, status: 'in-progress', stage: 'plan_complete', updatedAt: PAST_WINDOW_ISO, activityAt: PAST_WINDOW_ISO },
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

// ── Busy = pane OR live claim holder (WL-0MVWDB3IG004NRIU) ────────────
// A pane-less driven session still holds its per-child `flock` claim, so an
// item whose `<worklog>/locks/child-<id>.lock` is held by a LIVE holder must
// be left untouched (counted skipped, logged `kept … live claim holder`)
// instead of being released mid-work. The probe is batched ONCE per cycle
// over the pane-less candidates, bounded by the per-tick cap, and fail-open
// (timeout/throw/unavailable/missing-verdict → suppress, never release).

describe('live claim holder probe (orchestration)', () => {
  const heldVerdict = (over: Partial<ClaimHolderVerdict> = {}): ClaimHolderVerdict => ({
    held: true,
    reason: 'flock-held',
    pid: 4123,
    sessionId: 'sess-1',
    ...over,
  });
  const freeVerdict = (over: Partial<ClaimHolderVerdict> = {}): ClaimHolderVerdict => ({
    held: false,
    reason: 'no-lock-file',
    ...over,
  });

  it('keeps an in-progress item (counted skipped) while its claim holder is live and logs kept', async () => {
    const logs: string[] = [];
    const probe = vi.fn(
      async () => new Map<string, ClaimHolderVerdict>([[WL, heldVerdict()]]),
    ) as unknown as HydratorDeps['hasLiveClaimHolder'];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      hasLiveClaimHolder: probe,
      log: (m) => logs.push(m),
    });

    const result = await runHydrationOnce(deps);

    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 0, skipped: 1 });
    expect(applied).toEqual([]);
    expect(logs).toContain(`[hydrator] kept ${WL}: live claim holder pid 4123 session sess-1`);
  });

  it('releases a pane-less item whose recorded holder is dead, logging the dead-holder signal', async () => {
    const logs: string[] = [];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [staleItem()],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      hasLiveClaimHolder: async () =>
        new Map<string, ClaimHolderVerdict>([[WL, freeVerdict({ reason: 'stale' })]]),
      log: (m) => logs.push(m),
    });

    await runHydrationOnce(deps);

    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
    expect(
      logs.some((l) =>
        l.includes(`[hydrator] released ${WL}:`) && l.includes('(no pane, claim holder dead)'),
      ),
    ).toBe(true);
  });

  it('never probes an item with a matching pane (zero probe calls, pane wins)', async () => {
    const probe = vi.fn(async () => new Map<string, ClaimHolderVerdict>()) as unknown as HydratorDeps['hasLiveClaimHolder'];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [
        { pane_id: 'wC:p1', label: `Downtime triggered implement Foo - ${WL}`, workspace_id: 'wCurrent' },
      ],
      listOutboundDeps: async () => [],
      hasLiveClaimHolder: probe,
    });

    await runHydrationOnce(deps, 'wCurrent');

    expect(probe).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
  });

  it('queries the batched probe once per cycle over exactly the pane-less candidates (cost discipline)', async () => {
    const items = makeWorstCaseItems(10);
    // Panes in wCurrent titled with the first four item IDs → those four are
    // pane-matched and must NEVER be sent to the claim probe.
    const matched = items.slice(0, 4);
    const panes: HydratorPane[] = matched.map((item, i) => ({
      pane_id: `pane-${i}`,
      label: `Downtime triggered implement Foo - ${item.id}`,
      workspace_id: 'wCurrent',
    }));
    const probe = vi.fn(
      async (ids: string[]) => {
        const map = new Map<string, ClaimHolderVerdict>();
        for (const id of ids) map.set(id, freeVerdict());
        return map;
      },
    ) as unknown as HydratorDeps['hasLiveClaimHolder'];
    const batch = vi.fn(
      async (ids: string[]) => {
        const map = new Map<string, HydratorDepTarget[] | undefined>();
        for (const id of ids) map.set(id, []);
        return map;
      },
    ) as unknown as HydratorDeps['listOutboundDepsBatch'];
    const perItem = vi.fn(async () => []) as unknown as HydratorDeps['listOutboundDeps'];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => items,
      listActivePanes: async () => panes,
      listOutboundDeps: perItem,
      listOutboundDepsBatch: batch,
      hasLiveClaimHolder: probe,
    });

    await runHydrationOnce(deps, 'wCurrent');

    // One batched claim-probe call for the whole cycle, no per-item spawns.
    expect(probe).toHaveBeenCalledTimes(1);
    // The batched dep-read fast path is intact and untouched.
    expect(batch).toHaveBeenCalledTimes(1);
    expect(perItem).not.toHaveBeenCalled();
    // The probe sees the same pane-less candidate set as the dep read …
    const probed = probe.mock.calls[0][0];
    const depIds = batch.mock.calls[0][0];
    expect(probed).toEqual(depIds);
    // … bounded to the pane-less items only (none of the matched four).
    expect(probed).toHaveLength(6);
    for (const item of matched) expect(probed).not.toContain(item.id);
    // The pane-less six are released (probe says free), the matched four kept.
    expect(applied).toHaveLength(6);
  });

  it('suppresses only the open release: a held in_review item is still completed', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'in_review' }],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      hasLiveClaimHolder: async () => new Map<string, ClaimHolderVerdict>([[WL, heldVerdict()]]),
    });

    await runHydrationOnce(deps);

    expect(applied).toEqual([{ id: WL, status: 'completed', stage: 'in_review' }]);
  });

  it('suppresses only the open release: a held item with an active blocker is still blocked', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'in_progress' }],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [{ id: 'WL-OTHER', status: 'open', stage: 'plan_complete' }],
      hasLiveClaimHolder: async () => new Map<string, ClaimHolderVerdict>([[WL, heldVerdict()]]),
    });

    await runHydrationOnce(deps);

    expect(applied).toEqual([{ id: WL, status: 'blocked', stage: 'plan_complete' }]);
  });

  it('treats a missing per-item verdict as ambiguous evidence and suppresses that item', async () => {
    const logs: string[] = [];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      // The probe ran but returned no verdict for this item → no release.
      hasLiveClaimHolder: async () => new Map<string, ClaimHolderVerdict>(),
      log: (m) => logs.push(m),
    });

    await runHydrationOnce(deps);

    expect(applied).toEqual([]);
    expect(logs.some((l) => l.includes(`[hydrator] kept ${WL}: live claim holder`))).toBe(true);
  });

  it('aborts the cycle (no demotion) when the claim-probe step exceeds its budget', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      hasLiveClaimHolder: () => new Promise<Map<string, ClaimHolderVerdict>>(() => {}),
      stepTimeoutMs: 50,
      log: () => {},
    });

    const result = await runHydrationOnce(deps);

    expect(result.ok).toBe(false);
    expect(result.reason ?? '').toContain('claim-probe');
    expect(result.reason ?? '').toContain('timeout');
    expect(result.demoted).toBe(0);
    expect(applied).toEqual([]);
  });

  it('aborts the cycle (no demotion) when the claim probe throws or returns an abnormal result', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [{ id: WL, status: 'in-progress', stage: 'plan_complete' }],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      hasLiveClaimHolder: async () => {
        throw new Error('probe exploded');
      },
      log: () => {},
    });

    const result = await runHydrationOnce(deps);

    expect(result.ok).toBe(false);
    expect(result.reason ?? '').toContain('claim-probe');
    expect(result.demoted).toBe(0);
    expect(applied).toEqual([]);
  });

  // ── Production wiring: the real probe, zero CLI spawns ──────────────

  /** Seed a throwaway worklog store with a `locks/` dir. */
  function seedLockStore(lockFiles: Record<string, string> = {}): {
    rootDir: string;
    worklogDir: string;
  } {
    const rootDir = mkdtempSync(join(tmpdir(), 'herdr-claim-probe-'));
    const worklogDir = join(rootDir, '.worklog');
    const locksDir = join(worklogDir, 'locks');
    mkdirSync(locksDir, { recursive: true });
    for (const [name, body] of Object.entries(lockFiles)) {
      writeFileSync(join(locksDir, name), body, 'utf8');
    }
    return { rootDir, worklogDir };
  }

  it('production hasLiveClaimHolder reports a stale lock (dead pid) and spawns no CLI', async () => {
    const seeded = seedLockStore({
      [`child-${WL}.lock`]: JSON.stringify({
        agent: 'implement',
        pid: 999_999_999, // provably not alive on any host
        session_id: 'dead-session',
        started_at: '2026-10-31T10:00:00.000Z',
        token: 'tok',
      }),
    });
    const spawns: string[] = [];
    setExecFileAsync((async (bin: string, args: string[]) => {
      spawns.push(`${bin} ${args.join(' ')}`);
      return { stdout: '{}', stderr: '' };
    }) as never);
    setWorklogDir(seeded.worklogDir);
    try {
      const deps = createProductionHydratorDeps({ log: () => {} });
      const verdicts = await deps.hasLiveClaimHolder!([WL, 'WL-ABSENT000001']);

      expect(verdicts.get(WL)?.held).toBe(false);
      expect(verdicts.get(WL)?.reason).toBe('stale');
      expect(verdicts.get(WL)?.pid).toBe(999_999_999);
      expect(verdicts.get('WL-ABSENT000001')?.held).toBe(false);
      expect(verdicts.get('WL-ABSENT000001')?.reason).toBe('no-lock-file');
      // Local probe only: not one `wl`/`herdr` spawn for the batch.
      expect(spawns).toEqual([]);
    } finally {
      resetWorklogDir();
      rmSync(seeded.rootDir, { recursive: true, force: true });
    }
  });

  it('production hasLiveClaimHolder fails open when the locks directory is absent', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'herdr-claim-probe-nolocks-'));
    const worklogDir = join(rootDir, '.worklog');
    mkdirSync(worklogDir, { recursive: true }); // no locks/ subdirectory
    setWorklogDir(worklogDir);
    try {
      const deps = createProductionHydratorDeps({ log: () => {} });
      const verdicts = await deps.hasLiveClaimHolder!([WL]);

      expect(verdicts.get(WL)?.held).toBe(true);
      expect(verdicts.get(WL)?.reason).toBe('locks-dir-unreadable');
    } finally {
      resetWorklogDir();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

// ── Claim grace window (parent AC5, test-first WL-0MWHBSSOX001RUYA) ──
//
// A hydrator tick that lands between a dispatch spawning its pane and the pane
// title becoming readable sees NO pane for a just-claimed item. Parent AC5
// bounds that spawn→visible window: an item claimed within the configured
// grace window is never released even with no visible pane; once the window
// passes, today's rule applies.
//
// Contract choices pinned here (the impl child WL-0MWHBSX81003M0EM
// implements to these):
//   • recency rides the EXISTING `wl list --json` fields `updatedAt` /
//     `activityAt` (ISO 8601 strings) — no new timestamp field. The hydrator
//     propagates them and derives claim age as
//     `now() − max(timestamp(updatedAt), timestamp(activityAt))`;
//   • precedence matches `held` (WL-0MVWDB3IG004NRIU): the grace branch is
//     evaluated AFTER `in_review → completed` and `blocked`, so it suppresses
//     ONLY the final release to `open`;
//   • absent OR unparseable recency fails open toward KEEPING the claim —
//     treated as a fresh claim still inside the window (the parent's "keep
//     the claim on ambiguity" decision: a stuck claim is recoverable, a
//     released claim under a live agent is not);
//   • the default window is ONE exported constant `HYDRATOR_CLAIM_GRACE_MS`
//     (documented default 120 000 ms, per the parent's open question),
//     overridable via the `hydratorClaimGraceMs` settings key.
//
// RED WITNESSES — `it.fails` bodies assert the POST-fix behaviour and fail
// against today's code for a BEHAVIOUR reason (the item is released instead
// of kept, the constant is undefined), so the suite stays green; the impl
// child flips each `it.fails` → `it` as the grace window lands. The plain
// `it` bodies (boundary-past release, precedence) are green both before and
// after the fix — they pin invariants that must never relax.

/** Documented default for `HYDRATOR_CLAIM_GRACE_MS` (parent open question). */
const GRACE_DEFAULT_MS = 120_000;

describe('claim grace window (AC5)', () => {
  /** Fixed injected clock instant (no real timers anywhere in this block). */
  const NOW_MS = Date.parse('2026-11-15T10:00:00.000Z');
  /** ISO timestamp for a moment `ms` before the injected clock instant. */
  const isoBefore = (ms: number): string => new Date(NOW_MS - ms).toISOString();

  /**
   * The narrow grace-window item surface the impl child adds to `HydratorItem`.
   * Declared here (like the `ContractDeps` clock seams above) so the red
   * witnesses compile and run before the fields exist in the production type.
   */
  interface GraceWindowItem extends HydratorItem {
    /** `wl list --json` recency fields (ISO 8601) the claim age derives from. */
    updatedAt?: string;
    activityAt?: string;
  }

  /** `ContractDeps` widened to carry the recency fields. */
  interface GraceWindowDeps extends ContractDeps {
    listInProgressItems?: () => Promise<GraceWindowItem[] | null>;
  }

  interface GraceApplied {
    id: string;
    status: string;
    stage: string;
    opts?: DemotionOptions;
  }

  /** Grace-window deps factory; records the demotion options like `makeCrossDeps`. */
  function makeGraceDeps(overrides: Partial<GraceWindowDeps> = {}): {
    deps: GraceWindowDeps;
    applied: GraceApplied[];
  } {
    const applied: GraceApplied[] = [];
    const deps: GraceWindowDeps = {
      listInProgressItems: async () => [],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      applyDemotion: async (id, status, stage, opts) => {
        applied.push({ id, status, stage, opts });
        return true;
      },
      log: () => {},
      ...overrides,
    };
    return { deps, applied };
  }

  /** A just-claimed item (5 s old, well inside the default 120 s window). */
  const freshItem = (): GraceWindowItem => ({
    id: WL,
    status: 'in-progress',
    stage: 'plan_complete',
    updatedAt: isoBefore(5_000),
    activityAt: isoBefore(5_000),
  });

  it(
    'keeps an item claimed 5 s ago with no visible pane: inside the grace window (injected clock, no real timers)',
    async () => {
      const { deps, applied } = makeGraceDeps({
        now: () => NOW_MS,
        listInProgressItems: async () => [freshItem()],
        listActivePanes: async () => [],
      });

      const result = await runHydrationOnce(deps);

      // A tick that lands in the spawn→visible gap must not release: the
      // claim age (5 s) is below HYDRATOR_CLAIM_GRACE_MS, so the item is kept
      // (counted skipped), never demoted.
      expect(result).toMatchObject({ ok: true, considered: 1, demoted: 0, skipped: 1 });
      expect(applied).toEqual([]);
    },
  );

  it('releases the same item one millisecond past the grace window exactly as today', async () => {
    // Boundary computation reads the production constant directly (the fix
    // has landed): the documented default drives the fixture.
    const graceMs = HYDRATOR_CLAIM_GRACE_MS;
    const { deps, applied } = makeGraceDeps({
      now: () => NOW_MS,
      listInProgressItems: async () => [
        {
          ...freshItem(),
          updatedAt: isoBefore(graceMs + 1),
          activityAt: isoBefore(graceMs + 1),
        },
      ],
      listActivePanes: async () => [],
    });

    const result = await runHydrationOnce(deps);

    // Once the window has passed, today's rule applies unchanged.
    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 1 });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ id: WL, status: 'open', stage: 'intake_complete' });
    // "Exactly as today": the deciding signal is unchanged — no new
    // grace-only suppression of the no-pane release, and the same comment
    // text rides the demotion.
    expect(applied[0].opts?.reason).toBe('released because no matching pane');
  });

  it('never overrides the in_review → completed (audit tier) transition', async () => {
    const { deps, applied } = makeGraceDeps({
      now: () => NOW_MS,
      listInProgressItems: async () => [
        { ...freshItem(), stage: 'in_review' },
      ],
      listActivePanes: async () => [],
    });

    const result = await runHydrationOnce(deps);

    // Same precedence as `held`: a fresh claim never blocks the audit-tier
    // completion — the grace branch suppresses ONLY the release to `open`.
    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 1 });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ id: WL, status: 'completed', stage: 'in_review' });
  });

  it('never overrides the dependency blocked transition', async () => {
    const { deps, applied } = makeGraceDeps({
      now: () => NOW_MS,
      listInProgressItems: async () => [freshItem()],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [
        { id: 'WL-OTHER', status: 'open', stage: 'plan_complete' },
      ],
    });

    const result = await runHydrationOnce(deps);

    // A fresh claim never hides an active dependency: the grace branch is
    // evaluated after `blocked`, so the item still demotes to `blocked`.
    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 1 });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ id: WL, status: 'blocked', stage: 'plan_complete' });
  });

  it(
    'keeps the claim when recency is absent OR unparseable (legacy payload, fail-open: treated as a fresh claim inside the window)',
    async () => {
      const other = 'AH-0MTVYBL2L0085G6G';
      const { deps, applied } = makeGraceDeps({
        now: () => NOW_MS,
        listInProgressItems: async () => [
          // Absent: a legacy payload with no recency fields at all.
          { id: WL, status: 'in-progress', stage: 'plan_complete' },
          // Unparseable: a malformed timestamp is just as ambiguous.
          {
            id: other,
            status: 'in-progress',
            stage: 'plan_complete',
            updatedAt: 'not-a-date',
            activityAt: 'also-not-a-date',
          },
        ],
        listActivePanes: async () => [],
      });

      const result = await runHydrationOnce(deps);

      // An unknowable claim age is ambiguous evidence: never released (the
      // parent's "keep the claim on ambiguity" decision). Both items are
      // kept and counted skipped.
      expect(result).toMatchObject({ ok: true, considered: 2, demoted: 0, skipped: 2 });
      expect(applied).toEqual([]);
    },
  );

  it(
    'reads the default window from the single exported constant HYDRATOR_CLAIM_GRACE_MS (documented default 120 000 ms)',
    () => {
      expect(HYDRATOR_CLAIM_GRACE_MS).toBe(GRACE_DEFAULT_MS);
    },
  );
});

// ── Release clears the scheduling hold (WL-0MVWDB7F2003SORI) ─────────
// A non-empty `assignee` is the scheduling hold (WL-0MV85WDOM007BKF8), so a
// release that writes only status/stage leaves the item permanently
// undispatchable (live evidence: `LP-0MVUH9OMY004MQ3U` was `open` with
// `assignee=Map` after its release). Every release therefore clears the hold
// with a CAS guard on the holder it observed (mirroring
// `rollbackClaimWorkItem()`) and records that holder in a `herdr-hydrator`
// audit comment. Failed comments are tolerated — the demotion stands.

describe('release clears the scheduling hold', () => {
  it('buildReleaseComment names the signal and the previous holder, or (none)', () => {
    expect(
      buildReleaseComment('released because no pane and claim holder dead', 'implement'),
    ).toBe('released because no pane and claim holder dead; previous assignee: implement');
    expect(buildReleaseComment('released because no matching pane')).toBe(
      'released because no matching pane; previous assignee: (none)',
    );
    // An explicitly empty holder is "no holder", never an empty suffix.
    expect(buildReleaseComment('released because no matching pane', '')).toBe(
      'released because no matching pane; previous assignee: (none)',
    );
  });

  it('appends the compact evidence suffix after the unchanged legacy prefix (parent AC8)', () => {
    const evidence: ReleaseEvidence = {
      paneCount: 14,
      workspaceIds: ['w6B', 'w5M', 'w7C'],
      claimAgeMs: 240_000,
      graceMs: 120_000,
      itemId: WL,
    };
    expect(
      buildReleaseComment('released because no matching pane', 'dispatcher', evidence),
    ).toBe(
      'released because no matching pane; previous assignee: dispatcher; evidence: ' +
        '14 panes in 3 workspaces (w5M,w6B,w7C) none titled WL-…; claim age 240s (grace 120s)',
    );
  });

  it('workspace ids are sorted and deduplicated, capped with +N overflow (parent AC8)', () => {
    const evidence: ReleaseEvidence = {
      paneCount: 30,
      workspaceIds: ['wZ', 'wA', 'wC', 'wM', 'wB', 'wD', 'wE', 'wF', 'wA'],
      claimAgeMs: 60_000,
      graceMs: 60_000,
      itemId: WL,
    };
    const comment = buildReleaseComment('released because no matching pane', 'implement', evidence);
    // Sorted, deduplicated (wA appears twice), capped at
    // HYDRATOR_RELEASE_EVIDENCE_MAX_WORKSPACES (6) with +N overflow; the
    // overflow marker is the `+2` (8 distinct ids − 6 listed).
    expect(comment).toContain(
      '30 panes in 8 workspaces (wA,wB,wC,wD,wE,wF,+2) none titled WL-…; claim age 60s (grace 60s)',
    );
    // The cap bounds the comment (proven by the full-phrase assertion above;
    // the capped list is a substring of it).
    expect(comment.length).toBeLessThanOrEqual(200);
  });

  it('dead-holder variant carries the same evidence with the deciding signal named once (parent AC8)', () => {
    const evidence: ReleaseEvidence = {
      paneCount: 14,
      workspaceIds: ['w5M', 'w6B', 'w7C'],
      claimAgeMs: 240_000,
      graceMs: 120_000,
      itemId: WL,
    };
    const comment = buildReleaseComment(
      'released because no pane and claim holder dead',
      'implement',
      evidence,
    );
    expect(comment.startsWith(
      'released because no pane and claim holder dead; previous assignee: implement; evidence: ',
    )).toBe(true);
    // Evidence present: panes, workspaces, claim age, grace.
    expect(comment).toContain('14 panes in 3 workspaces (w5M,w6B,w7C)');
    expect(comment).toContain('claim age 240s (grace 120s)');
    // The no-pane fact is the deciding signal's first half — named once, so
    // the evidence does NOT restate it as "none titled …".
    expect(comment).not.toContain('none titled');
  });

  it('renders an unknowable claim age as unknown, not a bogus number (parent AC8)', () => {
    const evidence: ReleaseEvidence = {
      paneCount: 0,
      workspaceIds: [],
      claimAgeMs: null,
      graceMs: 120_000,
      itemId: WL,
    };
    expect(buildReleaseComment('released because no matching pane', '', evidence)).toContain(
      'claim age unknown (grace 120s)',
    );
  });

  it('demotes with --assignee "" CAS-guarded by --if-assignee, then comments the signal and holder', async () => {
    resetWorklogDir();
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps({ log: () => {} });

    const applied = await deps.applyDemotion(WL, 'open', 'intake_complete', {
      previousAssignee: 'implement',
      reason: 'released because no pane and claim holder dead',
    });

    expect(applied).toBe(true);
    const update = calls.find((call) => call.args.includes('update'));
    expect(update).toBeDefined();
    // AC1: the hold is always cleared; the observed holder is a CAS guard so a
    // concurrent assignee change makes the demotion stale instead of a clobber.
    expect(update!.args).toEqual([
      'update',
      WL,
      '--status',
      'open',
      '--stage',
      'intake_complete',
      '--assignee',
      '',
      '--if-assignee',
      'implement',
      '--json',
    ]);

    // AC2: the release trail names the deciding signal and the previous holder.
    const comment = calls.find((call) => call.args.includes('comment'));
    expect(comment).toBeDefined();
    expect(comment!.args).toEqual([
      'comment',
      'add',
      WL,
      '--comment',
      'released because no pane and claim holder dead; previous assignee: implement',
      '--author',
      'herdr-hydrator',
      '--json',
    ]);
  });

  it('omits --if-assignee and records (none) when the item has no assignee', async () => {
    resetWorklogDir();
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps({ log: () => {} });

    const applied = await deps.applyDemotion(WL, 'open', 'intake_complete', {
      reason: 'released because no matching pane',
    });

    expect(applied).toBe(true);
    const update = calls.find((call) => call.args.includes('update'));
    expect(update).toBeDefined();
    expect(update!.args).toEqual([
      'update',
      WL,
      '--status',
      'open',
      '--stage',
      'intake_complete',
      '--assignee',
      '',
      '--json',
    ]);
    expect(update!.args).not.toContain('--if-assignee');

    const comment = calls.find((call) => call.args.includes('comment'));
    expect(comment).toBeDefined();
    expect(comment!.args).toContain(
      'released because no matching pane; previous assignee: (none)',
    );
  });

  it('production wiring appends the evidence to the release comment (parent AC8)', async () => {
    resetWorklogDir();
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps({ log: () => {} });

    const applied = await deps.applyDemotion(WL, 'open', 'intake_complete', {
      previousAssignee: 'dispatcher',
      reason: 'released because no matching pane',
      evidence: {
        paneCount: 14,
        workspaceIds: ['w5M', 'w6B', 'w7C'],
        claimAgeMs: 240_000,
        graceMs: 120_000,
        itemId: WL,
      },
    });

    expect(applied).toBe(true);
    const comment = calls.find((call) => call.args.includes('comment'));
    expect(comment).toBeDefined();
    expect(comment!.args).toContain(
      'released because no matching pane; previous assignee: dispatcher; evidence: ' +
        '14 panes in 3 workspaces (w5M,w6B,w7C) none titled WL-…; claim age 240s (grace 120s)',
    );
  });

  it('does not comment when the CAS guard rejects the demotion (holder changed concurrently)', async () => {
    resetWorklogDir();
    const calls: Array<{ bin: string; args: string[] }> = [];
    setExecFileAsync((async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      // The CAS guard rejected the write (success:false), as `wl` does when
      // `--if-assignee` no longer matches.
      return { stdout: JSON.stringify({ success: false }), stderr: '' };
    }) as never);
    const deps = createProductionHydratorDeps({ log: () => {} });

    const applied = await deps.applyDemotion(WL, 'open', 'intake_complete', {
      previousAssignee: 'implement',
      reason: 'released because no matching pane',
    });

    expect(applied).toBe(false);
    expect(calls.some((call) => call.args.includes('comment'))).toBe(false);
  });

  it('tolerates a failing comment: the demotion stands, is logged, and the cycle neither aborts nor re-demotes', async () => {
    resetWorklogDir();
    const calls: Array<{ bin: string; args: string[] }> = [];
    const logs: string[] = [];
    setExecFileAsync((async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      if (args.includes('comment')) throw new Error('wl comment exploded');
      if (args.includes('pane')) {
        return { stdout: JSON.stringify({ result: { panes: [] } }), stderr: '' };
      }
      if (args.includes('dep')) {
        return { stdout: JSON.stringify({ outbound: [] }), stderr: '' };
      }
      if (args.includes('update')) {
        return { stdout: JSON.stringify({ success: true }), stderr: '' };
      }
      if (args.includes('list')) {
        return {
          stdout: JSON.stringify({
            workItems: [
              {
                id: WL,
                status: 'in-progress',
                stage: 'plan_complete',
                assignee: 'implement',
                updatedAt: PAST_WINDOW_ISO,
                activityAt: PAST_WINDOW_ISO,
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '{}', stderr: '' };
    }) as never);
    const deps: HydratorDeps = {
      ...createProductionHydratorDeps({ log: (message) => logs.push(message) }),
      // The claim probe would touch the real filesystem: pin a dead holder so
      // the release signal is deterministic and local.
      hasLiveClaimHolder: async () =>
        new Map<string, ClaimHolderVerdict>([[WL, { held: false, reason: 'stale' }]]),
    };

    const result = await runHydrationOnce(deps);

    expect(result).toMatchObject({ ok: true, demoted: 1 });
    // Exactly ONE demotion write: the failed comment never triggers a retry.
    expect(calls.filter((call) => call.args.includes('update'))).toHaveLength(1);
    expect(
      logs.some(
        (line) => line.includes('release comment failed') && line.includes(WL),
      ),
    ).toBe(true);
    // The release log line (the primary local trail) is still emitted.
    expect(logs.some((line) => line.includes(`[hydrator] released ${WL}:`))).toBe(true);
  });

  it('emits neither an assignee clear nor a comment for a kept item (pane-matched and live holder)', async () => {
    const other = 'WL-0MVWDB7F2OTHER1';
    const calls: Array<{ bin: string; args: string[] }> = [];
    setExecFileAsync((async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      return { stdout: '{}', stderr: '' };
    }) as never);
    const deps: HydratorDeps = {
      ...createProductionHydratorDeps({ log: () => {} }),
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete', assignee: 'implement' },
        { id: other, status: 'in-progress', stage: 'plan_complete', assignee: 'implement' },
      ],
      listActivePanes: async () => [
        { pane_id: 'wC:p1', label: `implement - ${WL}`, workspace_id: 'wCurrent' },
      ],
      // The wider demotion read must also be served by an injected seam —
      // production wiring would hit the exec stub (which answers `{}` for
      // everything), and a kept-item test asserts ZERO spawns below
      // (WL-0MWHBSWC20067SMY).
      listAllActivePanes: async () => [
        { pane_id: 'wC:p1', label: `implement - ${WL}`, workspace_id: 'wCurrent' },
      ],
      listOutboundDeps: async () => [],
      hasLiveClaimHolder: async () =>
        new Map<string, ClaimHolderVerdict>([[other, { held: true, reason: 'flock-held' }]]),
    };

    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(result).toMatchObject({ ok: true, demoted: 0, skipped: 2 });
    // No `wl update` and no `wl comment add` for kept items — the spawn list
    // is empty because every lookup was served by the injected seams.
    expect(calls).toEqual([]);
  });

  it('logs the deciding signal for every applied demotion (no-pane release)', async () => {
    const logs: string[] = [];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { ...staleItem(), assignee: 'implement' },
      ],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      log: (message) => logs.push(message),
    });

    await runHydrationOnce(deps);

    expect(applied).toEqual([
      { id: WL, status: 'open', stage: 'intake_complete' },
    ]);
    // The release log line keeps the deciding signal AND names the claim age
    // and window when a release is allowed past the grace window (parent
    // WL-0MWH56SWX004HSKQ AC5). The exact claim-age number depends on the
    // wall clock, so assert both phrases on the same line.
    expect(
      logs.some(
        (line) =>
          line.includes(`[hydrator] released ${WL}: in-progress/plan_complete → open/intake_complete (no matching pane)`) &&
          line.includes('claim age') &&
          line.includes('past grace window'),
      ),
    ).toBe(true);
    // Parent AC8: the same evidence lands on the log line (primary local
    // trail) so log-only debugging sees the panes/workspaces/age/grace too.
    expect(
      logs.some((line) => line.includes('evidence:') && line.includes('panes in')),
    ).toBe(true);
  });

  it('passes the observed holder, the deciding signal and the release evidence to the demotion seam', async () => {
    const seen: Array<{ id: string; opts?: DemotionOptions }> = [];
    // Deterministic clock so the evidence claim age is exact (parent AC8).
    const NOW_MS = Date.parse('2026-11-15T10:00:00.000Z');
    const claimAgeMs = NOW_MS - Date.parse(PAST_WINDOW_ISO);
    const { deps } = makeDeps({
      now: () => NOW_MS,
      listInProgressItems: async () => [
        { ...staleItem(), assignee: 'implement' },
      ],
      listAllActivePanes: async () => [
        { pane_id: 'w5M:p1', label: 'Work Items', workspace_id: 'w5M' },
        { pane_id: 'w6B:p3', label: 'Dispatcher pane (fallback)', workspace_id: 'w6B' },
      ],
      listActivePanes: async () => [],
      listOutboundDeps: async () => [],
      hasLiveClaimHolder: async () =>
        new Map<string, ClaimHolderVerdict>([[WL, { held: false, reason: 'stale' }]]),
      applyDemotion: async (id, _status, _stage, opts) => {
        seen.push({ id, opts });
        return true;
      },
    });

    await runHydrationOnce(deps);

    expect(seen).toEqual([
      {
        id: WL,
        opts: {
          previousAssignee: 'implement',
          reason: 'released because no pane and claim holder dead',
          evidence: {
            paneCount: 2,
            workspaceIds: ['w5M', 'w6B'],
            claimAgeMs,
            graceMs: HYDRATOR_CLAIM_GRACE_MS,
            itemId: WL,
          },
        },
      },
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
      listInProgressItems: async () => [staleItem()],
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
      staleItem(),
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
  it('exposes the five injectable seams', () => {
    const deps = createProductionHydratorDeps();
    expect(typeof deps.listInProgressItems).toBe('function');
    expect(typeof deps.listActivePanes).toBe('function');
    expect(typeof deps.listOutboundDeps).toBe('function');
    expect(typeof deps.listOutboundDepsBatch).toBe('function');
    expect(typeof deps.hasLiveClaimHolder).toBe('function');
    expect(typeof deps.applyDemotion).toBe('function');
  });
});

// ── F4 batched in-process dep read (WL-0MVJV2ORY002MNFF) ─────────────
//
// The hydrator used to spawn `wl dep list <id>` (plus `wl show` per
// non-terminal edge) once per candidate per tick. F4 adds the batched
// in-process seam: runHydrationOnce prefers it when present (production
// wiring reads the SQLite store in one connection per tick), the per-item
// spawn seam stays as the fallback, and every bounded-timeout / cap /
// fail-open rule is preserved.

describe('batched dependency reads (F4)', () => {
  /** Seed a throwaway worklog with one candidate + one active + one done blocker. */
  function seedWorklog(): { rootDir: string; worklogDir: string; item: string; active: string; done: string } {
    const rootDir = mkdtempSync(join(tmpdir(), 'herdr-hydrator-inproc-'));
    const worklogDir = join(rootDir, '.worklog');
    mkdirSync(worklogDir, { recursive: true });
    const db = new WorklogDatabase(
      'WL',
      join(worklogDir, 'worklog.db'),
      join(worklogDir, 'worklog-data.jsonl'),
      true,
      false,
    );
    const item = db.create({ title: 'Candidate', status: 'in-progress', stage: 'plan_complete' });
    const active = db.create({ title: 'Active blocker', status: 'open' });
    const done = db.create({ title: 'Done blocker', status: 'completed', stage: 'in_review' });
    db.addDependencyEdge(item.id, active.id);
    db.addDependencyEdge(item.id, done.id);
    db.close();
    return { rootDir, worklogDir, item: item.id, active: active.id, done: done.id };
  }

  it('production listOutboundDepsBatch reads deps in-process with zero wl spawns', async () => {
    const seeded = seedWorklog();
    try {
      const spawns: string[] = [];
      setExecFileAsync((async (_bin: string, args: string[]) => {
        spawns.push(args.join(' '));
        return { stdout: '{}', stderr: '' };
      }) as never);
      setWorklogDir(seeded.worklogDir);

      const deps = createProductionHydratorDeps({ log: () => {} });
      const byItem = await deps.listOutboundDepsBatch!([seeded.item, 'WL-NONE']);

      expect(spawns).toEqual([]);
      const targets = byItem?.get(seeded.item) ?? [];
      const active = targets.find((t) => t.id === seeded.active);
      expect(active?.status).toBe('open');
      const done = targets.find((t) => t.id === seeded.done);
      expect(done?.status).toBe('completed');
      // Stage enrichment (the `wl show` the spawn path pays for) is free here.
      expect(done?.stage).toBe('in_review');
      expect(byItem?.get('WL-NONE')).toEqual([]);
    } finally {
      resetWorklogDir();
      rmSync(seeded.rootDir, { recursive: true, force: true });
    }
  });

  it('production listOutboundDepsBatch fails open (undefined) without an in-process read', async () => {
    resetWorklogDir();
    const deps = createProductionHydratorDeps({ log: () => {} });
    const result = await deps.listOutboundDepsBatch!([WL]);
    expect(result).toBeUndefined();
  });

  it('prefers the batched seam: one call for every candidate, per-item seam untouched', async () => {
    const items = makeWorstCaseItems(10);
    const perItem = vi.fn(async () => []) as unknown as HydratorDeps['listOutboundDeps'];
    const batch = vi.fn(
      async (ids: string[]) => {
        const map = new Map<string, HydratorDepTarget[] | undefined>();
        for (const id of ids) map.set(id, []);
        return map;
      },
    ) as unknown as HydratorDeps['listOutboundDepsBatch'];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => items,
      listActivePanes: async () => [] as HydratorPane[],
      listOutboundDeps: perItem,
      listOutboundDepsBatch: batch,
    });

    const result = await runHydrationOnce(deps);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(10);
    expect(perItem).not.toHaveBeenCalled();
    expect(result.demoted).toBe(10);
    expect(applied).toHaveLength(10);
  });

  it('keeps an item blocked when the batched read finds an active blocker', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'in_progress' },
      ],
      listActivePanes: async () => [],
      listOutboundDepsBatch: async () =>
        new Map([[WL, [{ id: 'WL-OTHER', status: 'open', stage: 'plan_complete' }]]]),
    });

    await runHydrationOnce(deps);

    expect(applied).toEqual([{ id: WL, status: 'blocked', stage: 'plan_complete' }]);
  });

  it('releases an item whose batched dep entry is missing (fail-open)', async () => {
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [staleItem()],
      listActivePanes: async () => [],
      listOutboundDepsBatch: async () => new Map(), // no entry for WL
    });

    const result = await runHydrationOnce(deps);

    expect(result.demoted).toBe(1);
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
  });

  it('aborts the run when the batched dep read exceeds its budget', async () => {
    const { deps } = makeDeps({
      listInProgressItems: async () => [
        { id: WL, status: 'in-progress', stage: 'plan_complete' },
      ],
      listActivePanes: async () => [],
      listOutboundDepsBatch: () =>
        new Promise<Map<string, HydratorDepTarget[] | undefined>>(() => {}),
      stepTimeoutMs: 50,
      log: () => {},
    });

    const result = await runHydrationOnce(deps);

    expect(result.ok).toBe(false);
    expect(result.reason ?? '').toContain('dep-list');
    expect(result.reason ?? '').toContain('timeout');
    expect(result.demoted).toBe(0);
  });

  it('falls back to the per-item dep seam when the batched read is unavailable', async () => {
    const perItem = vi.fn(async () => []) as unknown as HydratorDeps['listOutboundDeps'];
    const { deps, applied } = makeDeps({
      listInProgressItems: async () => [staleItem()],
      listActivePanes: async () => [],
      listOutboundDeps: perItem,
      listOutboundDepsBatch: async () => undefined,
    });

    const result = await runHydrationOnce(deps);

    expect(perItem).toHaveBeenCalledTimes(1);
    expect(result.demoted).toBe(1);
    expect(applied).toEqual([{ id: WL, status: 'open', stage: 'intake_complete' }]);
  });

  it('batches deps only within the per-tick cap', async () => {
    const items = makeWorstCaseItems(25);
    const batch = vi.fn(
      async (ids: string[]) => {
        const map = new Map<string, HydratorDepTarget[] | undefined>();
        for (const id of ids) map.set(id, []);
        return map;
      },
    ) as unknown as HydratorDeps['listOutboundDepsBatch'];
    const { deps } = makeDeps({
      listInProgressItems: async () => items,
      listActivePanes: async () => [] as HydratorPane[],
      listOutboundDepsBatch: batch,
      maxItemsPerTick: 10,
    });

    const result = await runHydrationOnce(deps);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(10);
    expect(result.demoted).toBe(10);
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
        staleItem(),
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
        staleItem(),
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

// ── Cross-workspace demotion evidence (WL-0MWHBSQUU009LKML) ───────────
// Parent WL-0MWH56SWX004HSKQ, AC1/AC3/AC4.
//
// The 2026-11-15 01:11 release: the plugin reports its own workspace
// (`HERDR_WORKSPACE_ID` → `w5M` in ContextHub) while the downtime fallback
// placement put the dispatch pane in the Dispatcher workspace (`w6B`).
// Demotion evidence was read with `herdr pane list --workspace w5M`, so the
// live pane was invisible and the claim was released ~5 s after spawn.
//
// Frozen contract for the implementation child (WL-0MWHBSWC20067SMY):
// demotion evidence comes from a WORKSPACE-AGNOSTIC pane read
// (`listAllActivePanes()`, or `listActivePanes()` with no workspace id),
// while the selection-list marker keeps its workspace-scoped read (pinned
// by the sibling test child WL-0MWHBSRS4001TFNJ). "Is this item being
// worked on anywhere?" and "does it have a pane in my workspace?" are
// separate questions and must not share one filter.
//
// The `it` bodies below assert the POST-FIX behaviour — they were authored
// as `it.fails` RED WITNESSES (the repo's documented test-first pattern,
// `downtime-worker.clamps.test.ts`) and flipped to plain `it` when the
// implementation child (WL-0MWHBSWC20067SMY) landed the wider read. The
// plain `it` AC3 case is the anti-over-correction guard.

describe('cross-workspace demotion evidence (parent AC1/AC3/AC4)', () => {
  /** The item of the reported release (`Downtime triggered plan …`). */
  const REPRODUCED = 'WL-0MWFKDH78002T2CR';

  interface CrossApplied {
    id: string;
    status: string;
    stage: string;
    previousAssignee?: string;
    reason?: string;
  }

  /**
   * Deps for the cross-workspace cases: the injected `listActivePanes` is the
   * scoped `herdr pane list --workspace <id>` fake, `listAllActivePanes` the
   * wider read. Every call is recorded so "no release" is observable as an
   * empty `applied` list (a release comment is written by `applyDemotion`).
   */
  function makeCrossDeps(
    fixture: CrossWorkspacePaneFixture,
    overrides: Partial<CrossWorkspaceDeps> = {},
  ): { deps: CrossWorkspaceDeps; applied: CrossApplied[] } {
    const applied: CrossApplied[] = [];
    const deps: CrossWorkspaceDeps = {
      listInProgressItems: async () => [
        {
          id: REPRODUCED,
          status: 'in-progress',
          stage: 'plan_complete',
          assignee: 'dispatcher',
          // Parent AC5: recency past the claim grace window so the AC3
          // pane-less release path exercises "today's rule" (a
          // timestamp-less legacy item would be kept as a fresh claim).
          updatedAt: PAST_WINDOW_ISO,
          activityAt: PAST_WINDOW_ISO,
        },
      ],
      listActivePanes: fixture.listActivePanes,
      listAllActivePanes: fixture.listAllActivePanes,
      listOutboundDeps: async () => [],
      applyDemotion: async (id, status, stage, opts) => {
        applied.push({
          id,
          status,
          stage,
          previousAssignee: opts?.previousAssignee,
          reason: opts?.reason,
        });
        return true;
      },
      log: () => {},
      ...overrides,
    };
    return { deps, applied };
  }

  it(
    'does not release a live dispatch claim whose pane is in the Dispatcher workspace (AC1, reported state)',
    async () => {
      // Pane `w6B:p3`, plugin workspace `w5M`: exactly the reported state.
      const fixture = makeCrossWorkspacePanes(REPRODUCED, {
        paneIn: 'dispatcher',
        label: `Downtime triggered plan finish moves the pane - ${REPRODUCED}`,
      });
      const { deps, applied } = makeCrossDeps(fixture);

      const result = await runHydrationOnce(deps, fixture.pluginWorkspaceId);

      // The live pane is evidence the item is being worked, wherever it
      // lives: no demotion, no release comment (comments ride on
      // `applyDemotion`).
      expect(result.considered).toBe(1);
      expect(result.demoted).toBe(0);
      expect(applied).toEqual([]);
    },
  );

  it(
    'production wiring writes no release update and no release comment for that item (AC1)',
    async () => {
      const fixture = makeCrossWorkspacePanes(REPRODUCED);
      const calls: Array<{ bin: string; args: string[] }> = [];
      const panePayload = fixture.panes.map((pane) => ({
        pane_id: pane.pane_id,
        tab_id: `${pane.workspace_id}:t1`,
        workspace_id: pane.workspace_id,
        label: pane.label,
      }));

      // A herdr stand-in whose unscoped `pane list` sees BOTH workspaces and
      // whose `--workspace`-scoped read sees only that workspace — the two
      // read shapes the fix must distinguish.
      setExecFileAsync((async (_bin: string, args: string[]) => {
        calls.push({ bin: _bin, args });
        if (args.includes('pane') && args.includes('list')) {
          const wsIndex = args.indexOf('--workspace');
          const scoped = wsIndex >= 0 ? args[wsIndex + 1] : undefined;
          const panes = scoped
            ? panePayload.filter((pane) => pane.workspace_id === scoped)
            : panePayload;
          return { stdout: JSON.stringify({ result: { panes } }), stderr: '' };
        }
        if (args.includes('dep')) return { stdout: JSON.stringify({ outbound: [] }), stderr: '' };
        if (args.includes('update')) return { stdout: JSON.stringify({ success: true }), stderr: '' };
        if (args.includes('comment')) return { stdout: JSON.stringify({ success: true }), stderr: '' };
        if (args.includes('list')) {
          return {
            stdout: JSON.stringify({
              workItems: [
                {
                  id: REPRODUCED,
                  status: 'in-progress',
                  stage: 'plan_complete',
                  assignee: 'dispatcher',
                },
              ],
            }),
            stderr: '',
          };
        }
        return { stdout: '{}', stderr: '' };
      }) as never);

      const deps: HydratorDeps = {
        ...createProductionHydratorDeps({ log: () => {} }),
        // The real claim probe touches the filesystem; pin a dead holder so
        // the pane evidence is the only signal under test.
        hasLiveClaimHolder: async () =>
          new Map<string, ClaimHolderVerdict>([[REPRODUCED, { held: false, reason: 'stale' }]]),
        listOutboundDepsBatch: async () => undefined,
        listOutboundDeps: async () => [],
      };

      const result = await runHydrationOnce(deps, fixture.pluginWorkspaceId);

      expect(result.demoted).toBe(0);
      // No `wl update` (hold clear) and no `wl comment add` (release trail).
      expect(calls.filter((call) => call.args.includes('update'))).toEqual([]);
      expect(calls.filter((call) => call.args.includes('comment'))).toEqual([]);
      // AC10: exactly ONE pane-list spawn per hydrate tick, and the demotion
      // read passes NO `--workspace` filter — it is the workspace-agnostic
      // machine-wide read (WL-0MWHBSWC20067SMY).
      const paneListCalls = calls.filter(
        (call) => call.args.includes('pane') && call.args.includes('list'),
      );
      expect(paneListCalls).toHaveLength(1);
      expect(paneListCalls[0].args).toEqual(['pane', 'list']);
    },
  );

  it('still releases an item with no pane in any workspace and no live claim holder (AC3)', async () => {
    // No over-correction: a genuinely pane-less claim stays releasable, with
    // today's release-comment text (parent AC3).
    const fixture = makeCrossWorkspacePanes(REPRODUCED, { paneIn: 'none' });
    const { deps, applied } = makeCrossDeps(fixture, {
      hasLiveClaimHolder: async () =>
        new Map<string, ClaimHolderVerdict>([[REPRODUCED, { held: false, reason: 'no-lock-file' }]]),
    });

    const result = await runHydrationOnce(deps, fixture.pluginWorkspaceId);

    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 1 });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      id: REPRODUCED,
      status: 'open',
      stage: 'intake_complete',
      previousAssignee: 'dispatcher',
      reason: 'released because no matching pane',
    });
  });

  it('prep-tier pane-only contract: intake/plan/audit hold no per-child lock, so pane evidence is the only busy signal (AC7)', async () => {
    // Header contract (hydrator.ts, parent AC7): `/skill:intake`,
    // `/skill:plan` and audit runs hold NO per-child claim lock, so for those
    // tiers pane evidence is the ONLY busy signal — the claim-holder probe is
    // the second signal only where a lock exists (the implement tier). A
    // dispatcher-dispatched plan item whose pane lives in the Dispatcher
    // workspace is therefore kept purely by pane evidence, even when the
    // probe (wired with a no-lock-file verdict, as it would find for a
    // prep-tier item) reports no holder.
    const fixture = makeCrossWorkspacePanes(REPRODUCED, {
      paneIn: 'dispatcher',
      label: `Downtime triggered plan - ${REPRODUCED}`,
    });
    const { deps, applied } = makeCrossDeps(fixture, {
      // The probe finds nothing for a prep item (no per-child lock): the
      // pane above must be the whole decision.
      hasLiveClaimHolder: async () =>
        new Map<string, ClaimHolderVerdict>([[REPRODUCED, { held: false, reason: 'no-lock-file' }]]),
    });

    const result = await runHydrationOnce(deps, fixture.pluginWorkspaceId);

    expect(result).toMatchObject({ ok: true, considered: 1, demoted: 0 });
    expect(applied).toEqual([]);
  });

  it(
    'keeps the claim and reports ok:false when the wider pane read is unavailable (AC4)',
    async () => {
      const fixture = makeCrossWorkspacePanes(REPRODUCED);
      const { deps, applied } = makeCrossDeps(fixture, {
        // The scoped read works; ONLY the workspace-agnostic read is
        // unavailable — ambiguous evidence must never become a release.
        listActivePanes: async (workspaceId?: string) =>
          typeof workspaceId === 'string' && workspaceId.length > 0
            ? fixture.listActivePanes(workspaceId)
            : null,
        listAllActivePanes: async () => null,
      });

      const result = await runHydrationOnce(deps, fixture.pluginWorkspaceId);

      expect(result.ok).toBe(false);
      expect(result.demoted).toBe(0);
      // No release comment either: a release only happens via applyDemotion.
      expect(applied).toEqual([]);
    },
  );

  it(
    'keeps the claim when the wider pane read exceeds its step budget (AC4)',
    async () => {
      const fixture = makeCrossWorkspacePanes(REPRODUCED);
      // Slow but settling (no test hang): well past the 10 ms step budget.
      const slowRead = () =>
        new Promise<HydratorPane[]>((resolve) => setTimeout(() => resolve([...fixture.panes]), 60));
      const { deps, applied } = makeCrossDeps(fixture, {
        listActivePanes: async (workspaceId?: string) =>
          typeof workspaceId === 'string' && workspaceId.length > 0
            ? fixture.listActivePanes(workspaceId)
            : slowRead(),
        listAllActivePanes: slowRead,
        stepTimeoutMs: 10,
      });

      const result = await runHydrationOnce(deps, fixture.pluginWorkspaceId);

      // A timed-out wider read is indistinguishable from an unavailable one:
      // fail open by keeping the claim.
      expect(result.ok).toBe(false);
      expect(result.demoted).toBe(0);
      expect(applied).toEqual([]);
    },
  );
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
    // lookup (pane titles are the signal). Five spawns: in-progress list,
    // pane list, per-item dep list, demotion update and its release comment
    // (WL-0MVWDB7F2003SORI added the comment spawn).
    expect(calls).toHaveLength(5);
    // The seam uses `herdr pane list` (bin may be a full path when
    // HERDR_BIN_PATH is set).
    const paneCall = calls.find(
      (call) => call.bin.endsWith('herdr') && call.args.includes('pane'),
    );
    expect(paneCall).toBeDefined();
    expect(paneCall!.args).toEqual(['pane', 'list']);
  });

  it('runs exactly ONE machine-wide pane-list spawn per hydrate tick, with no --workspace filter (AC10)', async () => {
    // WL-0MWHBSWC20067SMY parent AC10: the workspace-agnostic demotion read
    // replaces the scoped read — still exactly ONE `herdr pane list` spawn
    // per tick, and that single demotion read passes NO `--workspace` filter
    // (a pane in the Dispatcher workspace must be evidence).
    const { calls, exec } = hydratorExecRouter();
    setExecFileAsync(exec as never);
    const deps = createProductionHydratorDeps({ log: () => {} });

    // A full tick against the recording router (empty in-progress list):
    // in-progress list spawn + pane-list spawn. Count only pane-list
    // spawns — the demotion read must be exactly one machine-wide
    // `herdr pane list` with no `--workspace`.
    const result = await runHydrationOnce(deps, 'wCurrent');

    expect(result.ok).toBe(true);
    const paneListCalls = calls.filter(
      (call) => call.args.includes('pane') && call.args.includes('list'),
    );
    expect(paneListCalls).toHaveLength(1);
    expect(paneListCalls[0].args).toEqual(['pane', 'list']);
  });
});

describe('closed pane clears the in-progress marker (cadence re-evaluation)', () => {
  it('a pane present keeps the item; removing the pane demotes on next run', async () => {
    let visiblePane: string | undefined = `Downtime triggered - ${WL}`;
    const applied: AppliedDemotion[] = [];
    const { deps } = makeDeps({
      listInProgressItems: async () => [staleItem()],
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

    // All five hydrator spawn shapes were exercised (in-progress list, pane
    // list, per-item dep list, demotion update and its release comment —
    // WL-0MVWDB7F2003SORI added the comment spawn).
    expect(calls).toHaveLength(5);
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
        // Parent AC5: recency past the claim grace window under the injected
        // clock so the item reaches the demotion-apply step (a fresh claim
        // would be kept and the step would never log).
        return [{
          id: WL,
          status: 'in-progress',
          stage: 'plan_complete',
          updatedAt: new Date(clock - 200_000).toISOString(),
          activityAt: new Date(clock - 200_000).toISOString(),
        }];
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
