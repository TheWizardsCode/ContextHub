/**
 * packages/herdr/src/dispatcher-anchor.ts — Dispatcher anchors and project-workspace resolution
 *
 * Three placement strategies live here, listed in `dispatchClaimedTier`
 * precedence order (WL-0MUR5FUWD00024XN):
 *
 * 1. **Project workspace + item-ID tab (primary path).**
 *    `resolveProjectWorkspace` maps a worklog root `R` to the herdr plugin
 *    pane (`label == "Work Items"`) whose logical project root (read from
 *    `HERDR_RESOLVED_CWD` via `herdr pane process-info` + `/proc/<pid>/environ`)
 *    equals `R`. `getItemTabAnchor` then finds-or-creates a tab labelled with
 *    the exact work-item id inside that workspace and returns its root pane,
 *    so automated panes are co-located with the project and grouped per item.
 *
 * 2. **Per-prefix tab routing inside the Dispatcher workspace (C1).**
 *    `getDispatcherTabAnchor(prefix)` resolves or creates a tab labelled with
 *    the work-item id prefix (e.g. `WL`, `TCE`) inside the machine-wide
 *    Dispatcher workspace and returns its root pane. Consulted only when no
 *    project workspace resolves for the item's root (AC3 fallback). Automated
 *    downtime dispatches for items sharing the same prefix land in the same
 *    tab (WL-0MTRQT482001SNXC).
 *
 * 3. **Machine-wide Dispatcher fallback (retained).**
 *    `getDispatcherAnchor` provisions one dedicated "Dispatcher" workspace
 *    with a persisted anchor pane (`downtime-dispatch-anchor.json`), used only
 *    when neither a project plugin pane nor a per-prefix anchor can be
 *    resolved, and by scheduled prompts (which have no work-item id).
 *
 * Provisioning: workspace create --label Dispatcher (no-focus); the workspace
 *               root pane is then adopted into a "Downtime" tab
 *               (pane move <id> --new-tab --tab-label Downtime --no-focus) so
 *               it is never left blank (WL-0MU2EOHK900425VU);
 *               tab create --workspace <id> --label <ITEM-ID> --no-focus.
 * Validation: pane RPC aliveness check detects closed anchor; re-provisions.
 *
 * Module layout (WL-0MVGKHCP9005SJPZ): strategies 2 and 3 — the per-prefix tab
 * routing and the machine-wide Dispatcher anchor provisioning described above
 * — live in `dispatcher-anchor.tab-anchors.ts` (child WL-0MW0JHC92005XRT1) and
 * are re-exported from here. Strategy 1 (project workspace + item-ID tab) stays
 * in this module until child 7 extracts the placement module.
 */

import * as path from 'node:path';
import {
  getMachineCoordinationDir,
  ensureMachineCoordinationDir,
} from './machine-coordination.js';
import { tryAcquireCoordLock } from './coordination.js';
import { resolveHerdrBin } from './herdr-bin.js';
import { PLUGIN_PANE_LABEL } from './dispatcher-anchor.contract.js';
import type {
  DispatcherAnchorDeps,
  DispatcherTabInfo,
  MachinePaneInfo,
  PaneProcessInfo,
  ItemTabAnchor,
  ProjectWorkspaceTarget,
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

// ── Constants and types ─────────────────────────────────────────────────
//
// Declared in `dispatcher-anchor.contract.ts` (WL-0MW0JH8OM004UOHU), a pure
// declaration leaf with no imports, and re-exported here unchanged so every
// consumer of `./dispatcher-anchor.js` keeps compiling with no import edits.

export {
  DISPATCHER_ANCHOR_FILE,
  DISPATCHER_WORKSPACE_LABEL,
  PLUGIN_PANE_LABEL,
  DISPATCHER_ROOT_TAB_LABEL,
  DISPATCHER_TAB_ANCHORS_FILE,
} from './dispatcher-anchor.contract.js';
export type {
  DispatcherAnchor,
  DispatcherTabAnchors,
  DispatcherPrefixTabAnchor,
  DispatcherAnchorDeps,
  DispatcherTabInfo,
  DispatcherPaneInfo,
  MachinePaneInfo,
  PaneProcessInfo,
  ItemTabAnchor,
  ProjectWorkspaceTarget,
} from './dispatcher-anchor.contract.js';

// ── herdr CLI output parsers ────────────────────────────────────────────
//
// Moved verbatim to `dispatcher-anchor.cli-parsers.ts`
// (WL-0MW0JH9QP00131ZJ), a pure leaf module that imports only the result
// types from `dispatcher-anchor.contract.js`. Re-exported here unchanged so
// every consumer of `./dispatcher-anchor.js` (including `hydrator.ts`) keeps
// compiling with no import edits.

export {
  parseTabListOutput,
  parseTabCreateOutput,
  parsePaneListOutput,
  parseMachinePaneListOutput,
  parsePaneProcessInfoOutput,
  parseProcEnviron,
} from './dispatcher-anchor.cli-parsers.js';

// ── herdr CLI helpers and production deps factory ──────────────────────
//
// Moved verbatim to `dispatcher-anchor.herdr-cli.ts` (WL-0MW0JHALU00928SX,
// parent WL-0MVGKHCP9005SJPZ) — the subprocess layer, separate from the anchor
// provisioning policy in this module. Re-exported here unchanged so every
// consumer of `./dispatcher-anchor.js` keeps compiling with no import edits.

export {
  createDispatcherAnchorDeps,
  listMachinePanes,
  getPaneProcessInfo,
  readProcEnvironFile,
  listTabsInWorkspace,
  listPanesInWorkspace,
  createTabInWorkspace,
} from './dispatcher-anchor.herdr-cli.js';

// ── Dispatcher provisioning and tab anchors (C0/C1) ────────────────────
//
// Moved verbatim to `dispatcher-anchor.tab-anchors.ts`
// (WL-0MW0JHC92005XRT1, parent WL-0MVGKHCP9005SJPZ) — the provisioning policy
// (coordination lock, in-lock double-check, stale-pane re-provision) now lives
// in that module. Only the two public resolvers are re-exported here, so the
// barrel's public surface is unchanged; the module's internal helpers
// (`resolveLivePaneInTab`, `LivePaneResolution`, …) are imports for sibling
// use only. The anchor/tab-anchor persistence helpers they call live in
// `dispatcher-anchor.persistence.ts` (WL-0MW0JHBFX006GMBQ) and stay internal
// to the family.

export {
  getDispatcherAnchor,
  getDispatcherTabAnchor,
} from './dispatcher-anchor.tab-anchors.js';

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
