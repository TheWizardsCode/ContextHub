/**
 * packages/herdr/src/dispatcher-anchor.placement.ts — project-workspace
 * resolution and the item-ID tab anchor (the primary placement path).
 *
 * Single responsibility: strategy 1 of `dispatchClaimedTier` — map a worklog
 * root to the herdr plugin pane whose logical project root matches it
 * (`resolveProjectWorkspace`, AC1/AC3), then find-or-create the tab labelled
 * with the exact work-item id inside that workspace and return its root pane
 * (`getItemTabAnchor`, AC2/AC5). The deterministic ambiguity rules (focused
 * pane first, then lowest pane id) and the fail-closed `null` outcome at every
 * unreadable boundary live here unchanged.
 *
 * Moved verbatim out of `dispatcher-anchor.ts` (parent WL-0MVGKHCP9005SJPZ;
 * child WL-0MW0JHD2N004XAOS). No logic, signature or doc-comment change.
 * `resolveProjectWorkspace` and `getItemTabAnchor` are re-exported from the
 * `dispatcher-anchor.js` barrel; `normalizeRoot`, `comparePaneIds`,
 * `ItemTabResolution` and `resolveItemTab` are module-local and deliberately
 * stay out of the barrel, so the public surface is unchanged.
 *
 * Layering: imports the contract labels/types from
 * `dispatcher-anchor.contract.js`, the output parser from
 * `dispatcher-anchor.cli-parsers.js`, the subprocess helpers from
 * `dispatcher-anchor.herdr-cli.js`, `resolveLivePaneInTab` from
 * `dispatcher-anchor.tab-anchors.js` and the machine coordination/lock
 * primitives from `./machine-coordination.js` / `./coordination.js`. It never
 * imports the `dispatcher-anchor.js` barrel, so the barrel can re-export these
 * resolvers without creating a cycle.
 */

import * as path from 'node:path';
import {
  getMachineCoordinationDir,
  ensureMachineCoordinationDir,
} from './machine-coordination.js';
import { tryAcquireCoordLock } from './coordination.js';
import { PLUGIN_PANE_LABEL } from './dispatcher-anchor.contract.js';
import type {
  DispatcherAnchorDeps,
  DispatcherTabInfo,
  MachinePaneInfo,
  PaneProcessInfo,
  ItemTabAnchor,
  ProjectWorkspaceTarget,
  PlacementMode,
} from './dispatcher-anchor.contract.js';
import { parseProcEnviron } from './dispatcher-anchor.cli-parsers.js';
import {
  createTabInWorkspace,
  getPaneProcessInfo,
  listMachinePanes,
  listTabsInWorkspace,
  readProcEnvironFile,
} from './dispatcher-anchor.herdr-cli.js';
import { resolveLivePaneInTab } from './dispatcher-anchor.tab-anchors.js';

// ── Project workspace resolution (AC1/AC3) ─────────────────────────────

/**
 * Normalise a path for comparison: resolve `.`/`..`, strip trailing
 * slashes (keeping the filesystem root). Used so `HERDR_RESOLVED_CWD` and the
 * candidate worklog root compare equal modulo a trailing separator.
 */
function normalizeRoot(p: string): string {
  if (p === '') return '';
  const resolved = path.resolve(p);
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

/** Deterministic pane-id ordering — the lower id wins (AC3 ambiguity rule). */
function comparePaneIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve the herdr project workspace that hosts the worklog plugin pane for
 * worklog root `root` (AC1/AC3).
 *
 * Enumerates the machine-wide `herdr pane list`, keeps only plugin panes
 * (`label == PLUGIN_PANE_LABEL`), and reads each candidate's logical project
 * root from `HERDR_RESOLVED_CWD` (via `pane process-info` + `/proc` environ).
 * Matching is on the logical root ONLY — never the pane's reported `cwd`
 * (which is the plugin directory) and never the workspace label.
 *
 * Ambiguity (>=2 matching panes) is deterministic: the focused matching pane
 * wins, else the lowest pane id (AC3). Never selects another root's
 * workspace.
 *
 * Fail-closed `null` on: empty root; `pane list` CLI error / unparseable
 * output; a plugin pane's `process-info` failure or missing `shell_pid`;
 * unreadable/missing `/proc/<pid>/environ`; missing `HERDR_RESOLVED_CWD`; no
 * root match; or a match without a workspace id. A `null` result makes the
 * dispatcher fall back to the Dispatcher anchor (AC4).
 */
export async function resolveProjectWorkspace(
  cwd: string,
  deps: DispatcherAnchorDeps,
  root: string,
): Promise<ProjectWorkspaceTarget | null> {
  const wanted = normalizeRoot(root);
  if (wanted === '') return null;

  const listAllPanes = deps.listMachinePanes ?? (() => listMachinePanes(cwd));
  let panes: MachinePaneInfo[] | null;
  try {
    panes = await listAllPanes();
  } catch {
    return null;
  }
  if (panes === null) return null;

  const candidates = panes.filter((pane) => pane.label === PLUGIN_PANE_LABEL);
  const matches: Array<{ pane: MachinePaneInfo; workspaceId: string }> = [];
  for (const pane of candidates) {
    const getInfo = deps.getPaneProcessInfo ?? ((id: string) => getPaneProcessInfo(cwd, id));
    let info: PaneProcessInfo | null;
    try {
      info = await getInfo(pane.paneId);
    } catch {
      return null;
    }
    if (info === null || info.shellPid === '') return null;

    const readEnv = deps.readProcEnviron ?? ((pid: string) => readProcEnvironFile(pid));
    let rawEnv: string | null;
    try {
      rawEnv = await readEnv(info.shellPid);
    } catch {
      return null;
    }
    if (rawEnv === null) return null;

    const env = parseProcEnviron(rawEnv);
    const resolvedCwd = env.HERDR_RESOLVED_CWD;
    if (typeof resolvedCwd !== 'string' || resolvedCwd === '') return null;
    if (normalizeRoot(resolvedCwd) !== wanted) continue;

    const workspaceId = env.HERDR_WORKSPACE_ID ?? pane.workspaceId;
    if (workspaceId === undefined || workspaceId === '') return null;
    matches.push({ pane, workspaceId });
  }

  if (matches.length === 0) return null;
  // Focused first; then lowest pane id.
  matches.sort((a, b) => {
    if (a.pane.focused !== b.pane.focused) return a.pane.focused ? -1 : 1;
    return comparePaneIds(a.pane.paneId, b.pane.paneId);
  });
  const chosen = matches[0];
  return { paneId: chosen.pane.paneId, workspaceId: chosen.workspaceId, tabId: chosen.pane.tabId };
}

// ── Item-ID tab anchor in a resolved project workspace (AC2/AC5) ────────

/**
 * Return the anchor pane for the tab labelled with the exact work-item id
 * `itemId` inside `workspaceId`, creating it on first use (AC2).
 *
 * Algorithm (fail-closed at every boundary):
 *  1. Fast path — an existing tab whose label equals `itemId` and whose root
 *     pane is alive is adopted.
 *  2. Otherwise, under the coordination lock with a double-check, adopt a
 *     matching tab again (a racing caller may have created it) or
 *     `herdr tab create --workspace <id> --label <itemId> --no-focus`.
 *
 * No persistence file: the tab label IS the key, discovered via `herdr tab
 * list`, so a second dispatch for the same item reuses the same tab (never a
 * duplicate). The retired per-prefix `downtime-dispatch-tab-anchors.json`
 * map is gone (AC5).
 *
 * Returns `null` on any failure (missing machine dir, empty inputs,
 * unparseable `tab list`/`tab create`/`pane list`, or a matching tab whose
 * anchor pane cannot be resolved) — the caller fails closed (never a
 * wrong-project placement).
 *
 * @param onCreate Optional callback invoked with the freshly-provisioned
 *   anchor when this call CREATED the tab (as opposed to adopting an existing
 *   one). Lets the interactive dispatch path gate its fail-safe root-pane
 *   cleanup on a genuine create-vs-reuse signal without a second `tab list`
 *   round-trip (WL-0MUYI3K8H007MPKF, parent WL-0MUKZGEQ2007FECS, AC7). A
 *   throwing callback is swallowed — provisioning must never fail because a
 *   best-effort observer threw.
 */
export async function getItemTabAnchor(
  cwd: string,
  deps: DispatcherAnchorDeps,
  workspaceId: string,
  itemId: string,
  onCreate?: (anchor: ItemTabAnchor) => void,
  placementMode: PlacementMode = 'right',
): Promise<ItemTabAnchor | null> {
  if (workspaceId === '' || itemId === '') return null;
  const dir = getMachineCoordinationDir();
  if (dir === null) return null;
  if (!ensureMachineCoordinationDir(dir)) return null;

  const listTabs = deps.listTabs ?? ((ws: string) => listTabsInWorkspace(cwd, ws));

  // 1. Fast path: an existing tab with this exact label hosting a live pane.
  const fast = await resolveItemTab(cwd, deps, workspaceId, itemId, listTabs);
  if (fast.status === 'unknown') return null;
  if (fast.status === 'found') return { tabId: fast.tabId, paneId: fast.paneId };

  // 2. Provision under the coordination lock with a double-check.
  const release = tryAcquireCoordLock(dir);
  if (release === null) {
    // Another holder may be creating the same tab; re-check once, else fail.
    const raced = await resolveItemTab(cwd, deps, workspaceId, itemId, listTabs);
    if (raced.status === 'found') return { tabId: raced.tabId, paneId: raced.paneId };
    return null;
  }
  try {
    const inside = await resolveItemTab(cwd, deps, workspaceId, itemId, listTabs);
    if (inside.status === 'unknown') return null;
    if (inside.status === 'found') return { tabId: inside.tabId, paneId: inside.paneId };
    // inside.status === 'none' → create the tab (never focus-stealing).
    const createTab =
      deps.createTab ?? ((ws: string, label: string) => createTabInWorkspace(cwd, ws, label));
    let created: ItemTabAnchor | null;
    try {
      created = await createTab(workspaceId, itemId);
    } catch {
      return null;
    }
    if (created === null) return null;
    const anchor: ItemTabAnchor = { tabId: created.tabId, paneId: created.paneId };
    // Create-vs-reuse signal (WL-0MUYI3K8H007MPKF): only the provisioning
    // branch invokes the observer, so the interactive path can close the
    // placeholder root pane after the first dispatch. Best-effort: a throwing
    // observer must never fail provisioning.
    if (typeof onCreate === 'function') {
      try {
        onCreate(anchor);
      } catch {
        // fail-open: an observer error never breaks tab provisioning
      }
    }
    // Placement: move freshly created tab per placementMode (fail-open).
    // Only applies to fresh creates — adopted tabs are never moved.
    await applyPlacementMode(cwd, deps, workspaceId, placementMode, anchor.tabId);
    return anchor;
  } finally {
    release();
  }
}

/** Result of resolving the item-ID tab: found + live pane, absent, or unreadable. */
type ItemTabResolution =
  | { status: 'found'; tabId: string; paneId: string }
  | { status: 'none' }
  | { status: 'unknown' };

/**
 * Resolve the live anchor pane for the tab labelled exactly `itemId`.
 *
 *  - `found` — the tab exists and hosts a live pane (adopt it).
 *  - `none` — `tab list` was read but no matching tab matches, or the
 *    matching tab has no live pane → the caller creates a replacement.
 *  - `unknown` — `tab list`/`pane list` was unreadable → fail closed.
 */
async function resolveItemTab(
  cwd: string,
  deps: DispatcherAnchorDeps,
  workspaceId: string,
  itemId: string,
  listTabs: (workspaceId: string) => Promise<DispatcherTabInfo[] | null>,
): Promise<ItemTabResolution> {
  let tabs: DispatcherTabInfo[] | null;
  try {
    tabs = await listTabs(workspaceId);
  } catch {
    return { status: 'unknown' };
  }
  if (tabs === null) return { status: 'unknown' };
  const match = tabs.find((tab) => tab.label === itemId);
  if (match === undefined) return { status: 'none' };
  const resolution = await resolveLivePaneInTab(cwd, deps, workspaceId, match.tabId);
  if (resolution.status === 'unknown') return { status: 'unknown' };
  if (resolution.status === 'found') {
    return { status: 'found', tabId: match.tabId, paneId: resolution.paneId };
  }
  return { status: 'none' };
}

// ── Extensions/Worklog tab resolution (left-of-extensions placement) ───

/**
 * Resolve the index of the extensions/Worklog tab in `workspaceId`.
 *
 * Strategy (deterministic, fail-open):
 *  1. List tabs in the workspace.
 *  2. Strategy 1 — a tab hosting a pane labelled `PLUGIN_PANE_LABEL`
 *     (`Work Items`), discovered via the machine-wide `pane list` (the only
 *     herdr output that carries pane labels) filtered to this workspace.
 *  3. Strategy 2 — a tab labelled exactly `Worklog` (the common
 *     human-readable name set by `open-worklog-tab.sh`).
 *  4. If exactly one tab matches a strategy, return its index. Ambiguity
 *     (>=2 candidate tabs) or a failed read falls to the next strategy /
 *     `null` — never guess.
 *
 * Returns `null` when the tab cannot be resolved (no match, ambiguous,
 * CLI failure) — the caller then leaves the tab at its default position
 * (fail-open, WL-0MVZ88G51004IYHW).
 */
export async function resolveExtensionsTab(
  cwd: string,
  deps: DispatcherAnchorDeps,
  workspaceId: string,
): Promise<number | null> {
  const listTabsFn =
    deps.listTabs ?? ((ws: string) => listTabsInWorkspace(cwd, ws));
  let tabs: DispatcherTabInfo[] | null;
  try {
    tabs = await listTabsFn(workspaceId);
  } catch {
    return null;
  }
  if (tabs === null || tabs.length === 0) return null;

  // Strategy 1: a tab hosting a pane labelled PLUGIN_PANE_LABEL. Only the
  // machine-wide `pane list` carries pane labels, so use it and filter to
  // this workspace (a project workspace may share the machine pane list).
  const listAllPanes = deps.listMachinePanes ?? (() => listMachinePanes(cwd));
  let allPanes: MachinePaneInfo[] | null;
  try {
    allPanes = await listAllPanes();
  } catch {
    allPanes = null;
  }
  if (allPanes !== null) {
    const pluginTabIds = new Set<string>();
    for (const pane of allPanes) {
      if (pane.workspaceId !== workspaceId) continue;
      if (pane.label !== PLUGIN_PANE_LABEL) continue;
      pluginTabIds.add(pane.tabId);
    }
    if (pluginTabIds.size === 1) {
      const tabId = [...pluginTabIds][0];
      const idx = tabs.findIndex((tab) => tab.tabId === tabId);
      if (idx >= 0) return idx;
    }
    // >=2 distinct plugin-pane tabs is AMBIGUOUS: never guess (even when a
    // unique `Worklog` label exists). Fail open (WL-0MVZ88G51004IYHW).
    if (pluginTabIds.size > 1) return null;
    // 0 matches → fall through to strategy 2 (absent plugin pane).
  }

  // Strategy 2: a tab labelled exactly `Worklog`.
  const worklogMatches = tabs.filter((tab) => tab.label === 'Worklog');
  if (worklogMatches.length === 1) {
    return tabs.findIndex((tab) => tab.label === 'Worklog');
  }

  // Ambiguous, absent, or unreadable — fail open (leave tab at default).
  return null;
}

/**
 * After creating a tab for an interactive dispatch, move it left of the
 * extensions/Worklog tab.
 *
 * Uses the placement mode to decide whether repositioning is needed:
 *  - `right` — no repositioning (default, dispatcher behaviour).
 *  - `left-of-extensions` — resolve the extensions tab and `tab.move`
 *    the new tab to its index (immediately left of it).
 *
 * Fail-open at every boundary: if the extensions tab cannot be resolved,
 * or the move fails, the tab stays at its default position. The dispatch
 * is never blocked.
 *
 * Returns `true` if the tab was moved, `false` otherwise.
 */
export async function applyPlacementMode(
  cwd: string,
  deps: DispatcherAnchorDeps,
  workspaceId: string,
  placementMode: PlacementMode,
  tabId: string,
): Promise<boolean> {
  if (placementMode === 'right') return false;

  const index = await resolveExtensionsTab(cwd, deps, workspaceId);
  if (index === null) return false; // fail-open: can't resolve extensions tab

  const moveTabFn = deps.moveTab;
  if (typeof moveTabFn !== 'function') return false; // missing dep → fail-open

  try {
    const ok = await moveTabFn(workspaceId, tabId, index);
    return ok;
  } catch {
    return false; // fail-open: move error → leave tab where it is
  }
}
