/**
 * packages/herdr/src/hydrator.fixtures.ts — shared fixtures for the hydrator
 * responsiveness contract suite (WL-0MUY1CX9900258E6).
 *
 * The contract is written test-first, so the fixtures are deliberately small,
 * deterministic and free of real timers:
 *
 *   • `hydratorExecRouter()` installs a recording exec seam: it answers every
 *     hydrator CLI shape with minimal valid JSON and records the exact
 *     `(bin, args, options)` of every spawn, so tests can assert the stdio
 *     and argument contract.
 *   • `makeWorstCasePanes()` / `makeWorstCaseItems()` build the load profile
 *     the fix must survive (50+ panes, 20+ in-progress items).
 *
 * No `vitest` import: these are plain builders consumed by the test file (and
 * by the implementation children's tests), so they stay usable outside a
 * vitest runtime.
 */

import type { HydratorDeps, HydratorItem, HydratorPane } from './hydrator.js';

// ── Recording exec seam ───────────────────────────────────────────────

/** One recorded CLI spawn. */
export interface RecordedSpawn {
  bin: string;
  args: string[];
  options: Record<string, unknown>;
}

/** Injectable exec seam shape used by the hydrator production deps. */
export type HydratorExec = (
  bin: string,
  args: string[],
  options?: unknown,
) => Promise<{ stdout: string; stderr: string }>;

export interface HydratorExecHarness {
  /** Every spawn, in order. */
  calls: RecordedSpawn[];
  /** The recording implementation to install via `setExecFileAsync()`. */
  exec: HydratorExec;
}

/**
 * Build a recording exec seam that answers the four hydrator CLI shapes with
 * minimal valid JSON and records every call. The pane-listing shape answers
 * `herdr pane list` (the hydrator's active-detection input).
 */
export function hydratorExecRouter(): HydratorExecHarness {
  const calls: RecordedSpawn[] = [];

  const exec: HydratorExec = async (bin, args, options) => {
    calls.push({
      bin,
      args,
      options: (options ?? {}) as Record<string, unknown>,
    });

    // Match on the ARGS, never the exact binary name — the hydrator resolves
    // the CLI as `process.env.HERDR_BIN_PATH ?? 'herdr'`, so a `bin === 'herdr'`
    // check misses whenever the suite runs inside a herdr pane
    // (WL-0MU2FM1L60002URI). `bin` is still recorded above for assertions.
    if (args.includes('pane') && args.includes('list')) {
      return { stdout: JSON.stringify({ result: { panes: [] } }), stderr: '' };
    }
    if (args.includes('dep')) {
      return { stdout: JSON.stringify({ outbound: [] }), stderr: '' };
    }
    if (args.includes('update')) {
      return { stdout: JSON.stringify({ success: true }), stderr: '' };
    }
    if (args.includes('list')) {
      return { stdout: JSON.stringify({ workItems: [] }), stderr: '' };
    }
    return { stdout: '{}', stderr: '' };
  };

  return { calls, exec };
}

// ── Worst-case load fixtures ──────────────────────────────────────────

/** Zero-pad `n` so the generated work-item IDs match WORK_ITEM_ID_REGEX. */
function padded(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Worst-case pane volume: `count` panes (default 60) split across the current
 * workspace (`wCurrent`, even indices) and another workspace, each titled
 * with a work-item ID (a real dispatched pane title carries the ID as a
 * preserved suffix, so the fixture embeds the ID in the label).
 */
export function makeWorstCasePanes(count = 60): HydratorPane[] {
  return Array.from({ length: count }, (_, i) => ({
    pane_id: `pane-${i}`,
    label: `Downtime triggered implement fixture item - WL-PANE${padded(i, 7)}`,
    workspace_id: i % 2 === 0 ? 'wCurrent' : 'wOther',
  }));
}

/**
 * Worst-case in-progress volume: `count` (default 25) pane-less candidates,
 * all at `plan_complete` so every one is eligible for demotion.
 */
export function makeWorstCaseItems(count = 25): HydratorItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `WL-ITEM${padded(i, 7)}`,
    title: `Stuck item ${i}`,
    status: 'in-progress',
    stage: 'plan_complete',
  }));
}

// ── Cross-workspace dispatch placement (WL-0MWHBSQUU009LKML) ──────────
//
// Reproduces the 2026-11-15 01:11 release: the plugin reports its own
// workspace (`HERDR_WORKSPACE_ID` → `w5M` in ContextHub) while the downtime
// fallback placement puts the dispatch pane in the **Dispatcher** workspace
// (`w6B`). A pane read scoped to the plugin workspace cannot see it, so
// `hasActivePane` is deterministically false and the claim is released
// seconds after spawn (parent WL-0MWH56SWX004HSKQ, root cause 1).
//
// The fixture builds both workspaces' panes plus the two read shapes the
// hydrator must distinguish:
//   • `listActivePanes(workspaceId)` — `herdr pane list --workspace <id>`
//     (the workspace-SCOPED display read, unchanged by the fix),
//   • `listAllPanes()` / `listActivePanes()` (no workspace) — the
//     workspace-AGNOSTIC demotion-evidence read the fix adds (parent AC1).

/** Plugin (`HERDR_WORKSPACE_ID`) workspace of the reported release. */
export const CROSS_WORKSPACE_PLUGIN_WORKSPACE = 'w5M';
/** Dispatcher workspace the fallback placement puts dispatch panes in. */
export const CROSS_WORKSPACE_DISPATCHER_WORKSPACE = 'w6B';

/** Where the item's dispatch pane lives (`none` = pane-less everywhere). */
export type CrossWorkspacePanePlacement = 'dispatcher' | 'plugin' | 'none';

export interface CrossWorkspacePaneSpec {
  /** Workspace holding the item's dispatch pane; defaults to `dispatcher`
   *  (the bug: visible only to a workspace-agnostic read). */
  paneIn?: CrossWorkspacePanePlacement;
  /** Pane title for the dispatch pane; defaults to a dispatch-shaped title. */
  label?: string;
  /** Plugin (hydrator) workspace; defaults to {@link CROSS_WORKSPACE_PLUGIN_WORKSPACE}. */
  pluginWorkspaceId?: string;
  /** Dispatcher workspace; defaults to {@link CROSS_WORKSPACE_DISPATCHER_WORKSPACE}. */
  dispatcherWorkspaceId?: string;
}

export interface CrossWorkspacePaneFixture {
  pluginWorkspaceId: string;
  dispatcherWorkspaceId: string;
  /** Every pane on the host, across both workspaces. */
  panes: HydratorPane[];
  /**
   * `herdr pane list [--workspace <id>]` fake: scoped to `workspaceId` when
   * given, every pane when omitted (the wider read's other permitted shape).
   */
  listActivePanes: HydratorDeps['listActivePanes'];
  /** Workspace-agnostic pane read, as its own seam. */
  listAllPanes: () => Promise<HydratorPane[]>;
}

/**
 * Build the reported cross-workspace pane layout for `itemId`.
 *
 * Always includes the plugin's own (non-item) worklist pane, so a scoped read
 * is non-empty and still misses the dispatch pane — the discriminator is the
 * workspace, never the pane count.
 */
export function makeCrossWorkspacePanes(
  itemId: string,
  spec: CrossWorkspacePaneSpec = {},
): CrossWorkspacePaneFixture {
  const pluginWorkspaceId = spec.pluginWorkspaceId ?? CROSS_WORKSPACE_PLUGIN_WORKSPACE;
  const dispatcherWorkspaceId =
    spec.dispatcherWorkspaceId ?? CROSS_WORKSPACE_DISPATCHER_WORKSPACE;
  const paneIn = spec.paneIn ?? 'dispatcher';
  const label = spec.label ?? `Downtime triggered plan finish moves the pane - ${itemId}`;

  const panes: HydratorPane[] = [
    {
      pane_id: `${pluginWorkspaceId}:p1`,
      label: 'Work Items',
      workspace_id: pluginWorkspaceId,
    },
  ];
  if (paneIn !== 'none') {
    const workspaceId = paneIn === 'dispatcher' ? dispatcherWorkspaceId : pluginWorkspaceId;
    panes.push({
      pane_id: `${workspaceId}:p3`,
      // Pane-title existence is the only signal: `agent_status` is carried
      // but must never decide the outcome.
      label,
      workspace_id: workspaceId,
      agent_status: 'working',
    });
  }

  return {
    pluginWorkspaceId,
    dispatcherWorkspaceId,
    panes,
    listActivePanes: async (workspaceId?: string) =>
      typeof workspaceId === 'string' && workspaceId.length > 0
        ? panes.filter((pane) => pane.workspace_id === workspaceId)
        : [...panes],
    listAllPanes: async () => [...panes],
  };
}
