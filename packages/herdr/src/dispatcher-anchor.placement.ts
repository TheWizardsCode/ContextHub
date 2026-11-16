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
 * Since WL-0MWHW3PKX0048ZYL the resolver is NO LONGER solely dependent on a
 * live plugin pane: a successful live match is persisted write-through into
 * the durable per-root project-workspace map
 * (`DISPATCHER_PROJECT_WORKSPACES_FILE` in the machine coordination dir), and
 * a root whose live scan yields no match (plugin pane down, or a
 * `downtimeWorklogRoots` sweep with no running instance) resolves from that
 * durable map — validated on read against live herdr state via
 * `deps.probeWorkspace` when the seam is wired (AC1/AC2). The live-pane `/proc`
 * advertisement is the fast-path hint, never the only path; the per-prefix
 * `Dispatcher` fallback becomes a rare, logged last resort (AC3).
 *
 * Moved verbatim out of `dispatcher-anchor.ts` (parent WL-0MVGKHCP9005SJPZ;
 * child WL-0MW0JHD2N004XAOS). No logic, signature or doc-comment change.
 * `resolveProjectWorkspace` and `getItemTabAnchor` are re-exported from the
 * `dispatcher-anchor.js` barrel; `normalizeRoot`, `comparePaneIds`,
 * `resolveItemTab` and the shared `findOrProvisionUnderLock` usage are
 * module-local and deliberately stay out of the barrel, so the public
 * surface is unchanged.
 *
 * Layering: imports the contract labels/types from
 * `dispatcher-anchor.contract.js`, the output parser from
 * `dispatcher-anchor.cli-parsers.js`, the subprocess helpers from
 * `dispatcher-anchor.herdr-cli.js`, the shared find-or-provision-under-lock
 * helper from `dispatcher-anchor.provision.js`, `resolveLivePaneInTab` from
 * `dispatcher-anchor.tab-anchors.js` and the machine coordination/primitives
 * from `./machine-coordination.js`. It never
 * imports the `dispatcher-anchor.js` barrel, so the barrel can re-export these
 * resolvers without creating a cycle.
 *
 * Matching rule (WL-0MWHCV3PR002WSQM): `resolveProjectWorkspace` matches on
 * the plugin pane's `HERDR_RESOLVED_CWD` EXACTLY (trailing-slash tolerant,
 * normalised) — never ancestor/descendant or prefix matching, so a pane
 * reporting `…/packages/herdr` does NOT match the worklog root `…/ContextHub`.
 * The near-miss reporting added by WL-0MWHCV3PR002WSQM is DIAGNOSTIC-ONLY:
 * it makes a failed exact-root match visible (expected vs actual root) without
 * changing the match semantics.
 */

import * as path from 'node:path';
import {
  getMachineCoordinationDir,
  ensureMachineCoordinationDir,
} from './machine-coordination.js';

import { PLUGIN_PANE_LABEL } from './dispatcher-anchor.contract.js';
import type {
  DispatcherAnchorDeps,
  DispatcherTabInfo,
  MachinePaneInfo,
  PaneProcessInfo,
  ItemTabAnchor,
  ProjectWorkspaceTarget,
  PlacementMode,
  ProjectWorkspaceFallbackReason,
} from './dispatcher-anchor.contract.js';
import { parseProcEnviron } from './dispatcher-anchor.cli-parsers.js';
import {
  readProjectWorkspaces,
  removeProjectWorkspace,
  upsertProjectWorkspace,
} from './dispatcher-anchor.persistence.js';
import {
  createTabInWorkspace,
  getPaneProcessInfo,
  listMachinePanes,
  listTabsInWorkspace,
  readProcEnvironFile,
} from './dispatcher-anchor.herdr-cli.js';
import { resolveLivePaneInTab } from './dispatcher-anchor.tab-anchors.js';
import {
  findOrProvisionUnderLock,
  type ProvisionFind,
} from './dispatcher-anchor.provision.js';

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
 * worklog root `root` (AC1/AC3), with a durable-source fallback
 * (WL-0MWHW3PKX0048ZYL AC1/AC2).
 *
 * Precedence, deterministic:
 *
 *  1. **Live scan (fast-path hint).** Enumerates the machine-wide `herdr pane
 *     list`, keeps only plugin panes (`label == PLUGIN_PANE_LABEL`), and reads
 *     each candidate's logical project root from `HERDR_RESOLVED_CWD` (via
 *     `pane process-info` + `/proc` environ). Matching is on the logical root
 *     ONLY — never the pane's reported `cwd` (which is the plugin directory)
 *     and never the workspace label. On the first match the mapping is
 *     persisted write-through into the durable per-root map, so the root
 *     stays resolvable while its plugin pane is down.
 *  2. **Durable map (AC1/AC2).** When the live scan yields no match (no
 *     plugin pane for the root, an unreadable boundary, or a
 *     `downtimeWorklogRoots` sweep root with no running instance), read the
 *     persisted per-root project-workspace map. The entry is validated on
 *     read against live herdr state (`deps.probeWorkspace`) when the seam is
 *     wired: `alive` → resolve from it; positively `missing` → the entry is
 *     dropped (self-healed) and the resolver fails closed; `unreadable` →
 *     fail closed (missing ≠ unreadable — a transient herdr must never
 *     wrongly drop a durable entry). An absent probe seam trusts the entry
 *     (legacy/test callers).
 *
 * The matching rule is EXACT-ROOT only (WL-0MWHCV3PR002WSQM): a pane whose
 * `HERDR_RESOLVED_CWD` differs from the wanted root — e.g. the plugin pane
 * reporting `…/packages/herdr` for the worklog root `…/ContextHub` — does NOT
 * match, never falls back to ancestor/descendant or prefix matching, and the
 * existing ambiguity rules (focused first, then lowest pane id, AC3) still
 * hold unchanged.
 *
 * Ambiguity (>=2 matching panes) is deterministic: the focused matching pane
 * wins, else the lowest pane id (AC3). Never selects another root's
 * workspace.
 *
 * Fail-closed `null` on: empty root; `pane list` CLI error / unparseable
 * output with no usable durable entry; a plugin pane's `process-info` failure
 * or missing `shell_pid`; unreadable/missing `/proc/<pid>/environ`; missing
 * `HERDR_RESOLVED_CWD`; no root match anywhere (live or durable); a durable
 * entry probed missing/unreadable; or a match without a workspace id. A
 * `null` result makes the dispatcher fall back to the `Dispatcher` anchor
 * (AC3, rare + logged).
 *
 * @param reportNearMiss Optional diagnostic-only reporter
 *   (WL-0MWHCV3PR002WSQM): invoked with one per-pane near-miss record — a
 *   plugin pane that reported a non-empty `HERDR_RESOLVED_CWD` DIFFERING from
 *   the wanted root — ONLY when the resolver returns `null` on the no-match
 *   path AND no durable entry rescued the resolution (a durable hit IS a
 *   match — no report). No report when a match IS found or when the panes
 *   carry no `HERDR_RESOLVED_CWD` at all (an absent env is not a mismatch,
 *   AC3). Additive: callers that pass no callback are byte-identical to
 *   today, and the match logic itself is unchanged.
 * @param reportFallbackReason Optional attribution reporter
 *   (WL-0MWHW3PKX0048ZYL AC3): invoked exactly once with the reason the
 *   primary path returned `null` (`no-project-workspace` /
 *   `project-workspace-mismatch` / `project-workspace-missing` /
 *   `herdr-unreadable`) so a `Dispatcher`-workspace fallback placement is
 *   attributable from the dispatch log. Never invoked when the resolver
 *   succeeds (live match or durable hit). Additive — callers that pass no
 *   callback are byte-identical to today.
 */
export async function resolveProjectWorkspace(
  cwd: string,
  deps: DispatcherAnchorDeps,
  root: string,
  reportNearMiss?: (nearMiss: {
    expectedRoot: string;
    actualRoot: string;
    paneId: string;
    workspaceId: string;
  }) => void,
  reportFallbackReason?: (reason: ProjectWorkspaceFallbackReason) => void,
): Promise<ProjectWorkspaceTarget | null> {
  const wanted = normalizeRoot(root);
  if (wanted === '') return null;

  const listAllPanes = deps.listMachinePanes ?? (() => listMachinePanes(cwd));
  let panes: MachinePaneInfo[] | null;
  try {
    panes = await listAllPanes();
  } catch {
    panes = null;
  }
  if (panes === null) {
    // `pane list` unreadable → the durable source is still consulted (AC2:
    // the live advertisement is a hint, never the only path).
    const durable = await resolveDurableProjectWorkspace(deps, wanted);
    if (durable !== null && 'target' in durable) return durable.target;
    reportFallbackReason?.(durable !== null ? durable.reason : 'herdr-unreadable');
    return null;
  }

  const candidates = panes.filter((pane) => pane.label === PLUGIN_PANE_LABEL);
  const matches: Array<{ pane: MachinePaneInfo; workspaceId: string }> = [];
  // Per-pane near-miss collector (WL-0MWHCV3PR002WSQM): a plugin pane that
  // reports a non-empty HERDR_RESOLVED_CWD differing from the wanted root is
  // a primary-path near-miss (expected vs actual). Collected while scanning
  // and reported ONLY on the null return below — never when a match is found
  // and never for an absent env (AC3). Additive: the match logic itself is
  // byte-for-byte unchanged.
  const nearMisses: Array<{
    expectedRoot: string;
    actualRoot: string;
    paneId: string;
    workspaceId: string;
  }> = [];
  // Records that at least one candidate hit an unreadable boundary
  // (process-info failure, missing shell_pid, unreadable /proc, absent env,
  // missing workspace id). The scan CONTINUES past a bad candidate — a
  // buildable candidate later in the list still matches — and the flag feeds
  // the fallback-reason attribution when nothing matched.
  let scanUnreadable = false;
  for (const pane of candidates) {
    const getInfo = deps.getPaneProcessInfo ?? ((id: string) => getPaneProcessInfo(cwd, id));
    let info: PaneProcessInfo | null;
    try {
      info = await getInfo(pane.paneId);
    } catch {
      scanUnreadable = true;
      continue;
    }
    if (info === null || info.shellPid === '') {
      scanUnreadable = true;
      continue;
    }

    const readEnv = deps.readProcEnviron ?? ((pid: string) => readProcEnvironFile(pid));
    let rawEnv: string | null;
    try {
      rawEnv = await readEnv(info.shellPid);
    } catch {
      scanUnreadable = true;
      continue;
    }
    if (rawEnv === null) {
      scanUnreadable = true;
      continue;
    }

    const env = parseProcEnviron(rawEnv);
    const resolvedCwd = env.HERDR_RESOLVED_CWD;
    if (typeof resolvedCwd !== 'string' || resolvedCwd === '') {
      scanUnreadable = true;
      continue;
    }
    if (normalizeRoot(resolvedCwd) !== wanted) {
      // Near-miss: this pane claims a DIFFERENT logical root. Matching rule
      // unchanged (exact-root only) — the record makes the mismatch visible.
      nearMisses.push({
        expectedRoot: wanted,
        actualRoot: resolvedCwd,
        paneId: pane.paneId,
        workspaceId: env.HERDR_WORKSPACE_ID ?? pane.workspaceId,
      });
      continue;
    }

    const workspaceId = env.HERDR_WORKSPACE_ID ?? pane.workspaceId;
    if (workspaceId === undefined || workspaceId === '') {
      scanUnreadable = true;
      continue;
    }
    matches.push({ pane, workspaceId });
  }

  if (matches.length > 0) {
    // Focused first; then lowest pane id.
    matches.sort((a, b) => {
      if (a.pane.focused !== b.pane.focused) return a.pane.focused ? -1 : 1;
      return comparePaneIds(a.pane.paneId, b.pane.paneId);
    });
    const chosen = matches[0];
    // Write-through (AC2): learn the durable mapping from the live match so
    // the root stays resolvable while its plugin pane is down. Best-effort,
    // fail-open — a persistence failure never changes the resolution.
    persistProjectWorkspaceFromMatch(wanted, chosen);
    return { paneId: chosen.pane.paneId, workspaceId: chosen.workspaceId, tabId: chosen.pane.tabId };
  }

  // No live match → durable source rescue (AC1/AC2): the item's project
  // workspace resolves even when no live plugin pane advertises the root.
  const durable = await resolveDurableProjectWorkspace(deps, wanted);
  if (durable !== null && 'target' in durable) {
    return durable.target; // a durable hit is a match — no near-miss report
  }

  // Report the collected near-misses ONLY on the null return — the sole case
  // the diagnostic is about (AC2). An absent env or unreadable boundary
  // already fails closed through its own path (AC3).
  if (typeof reportNearMiss === 'function' && nearMisses.length > 0) {
    for (const nearMiss of nearMisses) {
      reportNearMiss(nearMiss);
    }
  }
  // Attribution (AC3): name why the primary path failed, so a fallback
  // placement is observable and attributable. Prefers the more specific
  // durable-probe verdict, then a recorded mismatch, then an unreadable
  // boundary, then a plain miss.
  const reason: ProjectWorkspaceFallbackReason =
    durable !== null
      ? durable.reason
      : nearMisses.length > 0
        ? 'project-workspace-mismatch'
        : scanUnreadable
          ? 'herdr-unreadable'
          : 'no-project-workspace';
  reportFallbackReason?.(reason);
  return null;
}

/**
 * A durable-map verdict: a usable target, a dropped-entry reason, or `null`
 * when the root has no durable entry at all.
 */
type DurableResolution =
  | { target: ProjectWorkspaceTarget }
  | { reason: ProjectWorkspaceFallbackReason }
  | null;

/**
 * Resolve the durable per-root project-workspace map for `wanted`
 * (WL-0MWHW3PKX0048ZYL AC1/AC2).
 *
 * Returns `{ target }` when the root HAS a durable entry and it validates
 * (`probeWorkspace` seam absent → trusted; probed `alive` → used); `{ reason }`
 * when the entry exists but fails closed (`project-workspace-missing` — the
 * entry was positively probed MISSING and is dropped; `herdr-unreadable` —
 * the probe could not be read); `null` when the root has no durable entry.
 * The caller attributes the reason on its own null return when this returns
 * `{ reason }`; a `null` (no entry) falls through to the plain-miss reason.
 */
async function resolveDurableProjectWorkspace(
  deps: DispatcherAnchorDeps,
  wanted: string,
): Promise<DurableResolution> {
  const dir = getMachineCoordinationDir();
  if (dir === null) return null;
  const map = readProjectWorkspaces(dir);
  const record = map?.byRoot[wanted];
  if (record === undefined || record.workspaceId === '') return null;
  if (typeof deps.probeWorkspace === 'function') {
    let verdict: 'alive' | 'missing' | 'unreadable';
    try {
      verdict = await deps.probeWorkspace(record.workspaceId);
    } catch {
      verdict = 'unreadable';
    }
    if (verdict === 'missing') {
      // Self-heal: never route into a dead workspace again.
      removeProjectWorkspace(dir, wanted);
      return { reason: 'project-workspace-missing' };
    }
    if (verdict === 'unreadable') return { reason: 'herdr-unreadable' };
    // verdict === 'alive' → fall through to the trusted hit.
  }
  return {
    target: {
      workspaceId: record.workspaceId,
      ...(record.paneId !== undefined ? { paneId: record.paneId } : {}),
      ...(record.tabId !== undefined ? { tabId: record.tabId } : {}),
    },
  };
}

/** Learn the durable mapping from a live match (best-effort, fail-open). */
function persistProjectWorkspaceFromMatch(
  wanted: string,
  chosen: { pane: MachinePaneInfo; workspaceId: string },
): void {
  try {
    const dir = getMachineCoordinationDir();
    if (dir === null) return;
    if (!ensureMachineCoordinationDir(dir)) return;
    upsertProjectWorkspace(dir, wanted, {
      workspaceId: chosen.workspaceId,
      ...(chosen.pane.paneId !== '' ? { paneId: chosen.pane.paneId } : {}),
      ...(chosen.pane.tabId !== '' ? { tabId: chosen.pane.tabId } : {}),
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // fail-open: the durable map is a hint, never a hard dependency
  }
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
 * wrong-project placement). The coordination-lock + double-check + create
 * sequence itself is the family's shared `findOrProvisionUnderLock`
 * (`dispatcher-anchor.provision.ts`, AC1); `getItemTabAnchor` supplies the
 * item-ID resolver and creator hooks (the tab label IS the key — no
 * persistence file).
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

  // Shared find-or-provision-under-lock sequence (AC1): fast path outside
  // the lock, raced single re-check when the lock is held, in-lock
  // double-check, then create. All three fail-closed boundaries are silent on
  // this strategy (getItemTabAnchor carries no PlacementFailureDetail
  // channel — the dispatch side reports `item-tab-unavailable` itself).
  return findOrProvisionUnderLock<ItemTabAnchor>({
    dir,
    find: () => resolveItemTab(cwd, deps, workspaceId, itemId, listTabs),
    create: async () => {
      const createTab =
        deps.createTab ?? ((ws: string, label: string) => createTabInWorkspace(cwd, ws, label));
      return createTab(workspaceId, itemId);
    },
    // The item-ID tab adopts without persistence (the tab label IS the key).
    adoptCreated: async (anchor) => {
      // Create-vs-reuse signal (WL-0MUYI3K8H007MPKF): only the provisioning
      // branch invokes the observer, so the interactive path can close the
      // placeholder root pane after the first dispatch. Best-effort: a
      // throwing observer must never fail provisioning.
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
      return true;
    },
    fastUnknownDetail: 'item-tab-unavailable',
    racedUnknownDetail: 'item-tab-unavailable',
    racedMissDetail: 'item-tab-unavailable',
    inLockUnknownDetail: 'item-tab-unavailable',
    createFailDetail: 'item-tab-unavailable',
  });
}

/**
 * Resolve the live anchor pane for the tab labelled exactly `itemId`
 * (shared ProvisionFind contract, AC1).
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
): Promise<ProvisionFind<ItemTabAnchor>> {
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
    return { status: 'found', value: { tabId: match.tabId, paneId: resolution.paneId } };
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
