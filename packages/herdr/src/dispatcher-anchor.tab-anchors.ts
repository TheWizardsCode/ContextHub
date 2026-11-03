/**
 * packages/herdr/src/dispatcher-anchor.tab-anchors.ts — Dispatcher workspace
 * provisioning and the machine-wide / per-prefix tab-anchor resolvers.
 *
 * Single responsibility: the C0/C1 placement policy — resolve or provision the
 * machine-wide Dispatcher workspace anchor pane (`getDispatcherAnchor`) and the
 * per-work-item-prefix tab anchor inside it (`getDispatcherTabAnchor`), plus
 * the resolution helpers they share. The coordination lock
 * (`tryAcquireCoordLock`), the in-lock double-check and the stale-pane
 * re-provision semantics live here unchanged.
 *
 * Moved verbatim out of `dispatcher-anchor.ts` (parent WL-0MVGKHCP9005SJPZ;
 * child WL-0MW0JHC92005XRT1). No logic, signature or coordination-semantics
 * change: the same doc comments, the same lock ordering and the same
 * fail-closed `null`/`unknown` outcomes. `getDispatcherAnchor` and
 * `getDispatcherTabAnchor` are re-exported from the `dispatcher-anchor.js`
 * barrel; every other symbol here (including `resolveLivePaneInTab` and
 * `LivePaneResolution`) is an export for **sibling** use only and is
 * deliberately **not** added to the barrel, so the public surface is
 * unchanged.
 *
 * Layering: imports the labels/types from `dispatcher-anchor.contract.js`, the
 * file helpers from `dispatcher-anchor.persistence.js`, the subprocess helpers
 * from `dispatcher-anchor.herdr-cli.js` and the machine coordination/lock
 * primitives from `./machine-coordination.js` / `./coordination.js`. It never
 * imports the `dispatcher-anchor.js` barrel, so the barrel can import these
 * resolvers without creating a cycle.
 */

import {
  getMachineCoordinationDir,
  ensureMachineCoordinationDir,
} from './machine-coordination.js';
import { tryAcquireCoordLock } from './coordination.js';
import {
  DISPATCHER_WORKSPACE_LABEL,
  DISPATCHER_ROOT_TAB_LABEL,
} from './dispatcher-anchor.contract.js';
import type {
  DispatcherAnchor,
  DispatcherPrefixTabAnchor,
  DispatcherAnchorDeps,
  DispatcherTabInfo,
  DispatcherPaneInfo,
  ItemTabAnchor,
} from './dispatcher-anchor.contract.js';
import {
  readAnchor,
  writeAnchor,
  readTabAnchors,
  readDispatcherWorkspaceId,
  persistPrefixTab,
} from './dispatcher-anchor.persistence.js';
import {
  createTabInWorkspace,
  listPanesInWorkspace,
  listTabsInWorkspace,
} from './dispatcher-anchor.herdr-cli.js';

/**
 * Ensure the Dispatcher workspace exists and return its workspace id: reuse
 * the id persisted by the legacy single anchor, else provision a fresh
 * workspace. Returns `null` on failure (caller fails closed).
 */
async function ensureDispatcherWorkspace(
  deps: DispatcherAnchorDeps,
): Promise<string | null> {
  const existing = readDispatcherWorkspaceId();
  if (existing !== null) return existing;
  try {
    const created = await deps.createWorkspace(DISPATCHER_WORKSPACE_LABEL);
    return created.workspaceId;
  } catch {
    return null;
  }
}

/** Find the tab labelled exactly `label` (never a substring/prefix match). */
function findTabByLabel(
  tabs: DispatcherTabInfo[],
  label: string,
): DispatcherTabInfo | null {
  return tabs.find((tab) => tab.label === label) ?? null;
}

/**
 * Adopt the workspace's initial root pane into a labelled tab so it is never
 * left blank/unused (WL-0MU2EOHK900425VU). `herdr workspace create` always
 * provisions a root pane, which was previously persisted as the anchor but
 * never surfaced in any tab — leaving a blank pane alongside the per-prefix
 * tabs. Moving it into a {@link DISPATCHER_ROOT_TAB_LABEL} tab keeps the pane
 * (and therefore `send-to-pi.sh --anchor <paneId>` dispatch) alive while
 * giving it a productive home.
 *
 * Best-effort: a `false`/throwing `movePaneToNewTab` leaves the pane where it
 * is and the caller still persists the anchor, so dispatch degrades to the
 * pre-fix layout rather than entering a re-provision loop. Deps without
 * `movePaneToNewTab` (legacy/test callers) skip adoption entirely.
 */
async function adoptRootPaneIntoNewTab(
  deps: DispatcherAnchorDeps,
  paneId: string,
): Promise<void> {
  if (typeof deps.movePaneToNewTab !== 'function') return;
  try {
    await deps.movePaneToNewTab(paneId, DISPATCHER_ROOT_TAB_LABEL);
  } catch {
    // best-effort — never fail provisioning on an adoption error
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Return the persisted Dispatcher anchor, provisioning it idempotently when
 * absent or stale (closed pane → re-provision). Fail-safe: null on any
 * unrecoverable error (caller degrades to "no dispatch this cycle").
 *
 * Idempotency: the provision path runs under the coordination lock
 * (O_CREAT|O_EXCL), so concurrent first-dispatches produce exactly one
 * workspace/pane.
 */
export async function getDispatcherAnchor(
  cwd: string,
  deps: DispatcherAnchorDeps,
): Promise<DispatcherAnchor | null> {
  const dir = getMachineCoordinationDir();
  if (dir === null) return null;
  if (!ensureMachineCoordinationDir(dir)) return null;

  const existing = readAnchor(dir);
  if (existing !== null) {
    try {
      const alive = await deps.isPaneAlive(existing.paneId);
      if (alive) return existing;
    } catch {
      return null;
    }
    // Stale → re-provision under lock (fall through to provision path)
  }

  // Provision under the coordination lock so concurrent first-dispatches do not duplicate.
  const release = tryAcquireCoordLock(dir);
  if (release === null) {
    // Another holder is provisioning — re-read whatever they wrote, or null.
    const raced = readAnchor(dir);
    if (raced !== null) {
      try {
        const alive = await deps.isPaneAlive(raced.paneId);
        if (alive) return raced;
      } catch { return null; }
    }
    return null;
  }

  try {
    // Double-check inside the lock: another instance may have written between
    // our earlier read and acquiring the lock.
    const inside = readAnchor(dir);
    if (inside !== null) {
      try {
        const alive = await deps.isPaneAlive(inside.paneId);
        if (alive) return inside;
      } catch { return null; }
      // stale inside-lock → re-provision below (overwrite)
    }

    let created: { workspaceId: string; paneId: string };
    try {
      created = await deps.createWorkspace(DISPATCHER_WORKSPACE_LABEL);
    } catch {
      return null;
    }
    // Adopt the freshly-provisioned root pane into its own tab so the
    // workspace never shows a blank pane (WL-0MU2EOHK900425VU).
    await adoptRootPaneIntoNewTab(deps, created.paneId);
    const anchor: DispatcherAnchor = { paneId: created.paneId, workspaceId: created.workspaceId };
    if (!writeAnchor(dir, anchor)) return null;
    return anchor;
  } finally {
    release();
  }
}

/**
 * Outcome of resolving a live anchor pane inside a tab.
 *
 *  - `{ status: 'found', paneId }` — an alive pane was found (adopt the tab).
 *  - `{ status: 'none' }` — the pane list was read but no live pane exists in
 *    the tab (the tab is effectively dead → create a replacement).
 *  - `{ status: 'unknown' }` — the pane list could not be read/parsed (fail
 *    closed — never guess, never duplicate).
 */
export type LivePaneResolution =
  | { status: 'found'; paneId: string }
  | { status: 'none' }
  | { status: 'unknown' };

/**
 * Find a LIVE pane inside `tabId` (used to adopt a tab that exists in herdr
 * but is not yet recorded in the persisted map — e.g. the anchor file was
 * lost or the tab was created out-of-band).
 */
export async function resolveLivePaneInTab(
  cwd: string,
  deps: DispatcherAnchorDeps,
  workspaceId: string,
  tabId: string,
): Promise<LivePaneResolution> {
  const listPanes =
    deps.listPanes ?? ((ws: string) => listPanesInWorkspace(cwd, ws));
  let panes: DispatcherPaneInfo[] | null;
  try {
    panes = await listPanes(workspaceId);
  } catch {
    return { status: 'unknown' };
  }
  if (panes === null) return { status: 'unknown' };
  for (const pane of panes) {
    if (pane.tabId !== tabId) continue;
    try {
      if (await deps.isPaneAlive(pane.paneId)) {
        return { status: 'found', paneId: pane.paneId };
      }
    } catch {
      return { status: 'unknown' }; // fail-closed on an aliveness probe error
    }
  }
  return { status: 'none' };
}

// ── Per-prefix tab anchor (C1, parent WL-0MTRQT482001SNXC) ─────────────

/**
 * Result of resolving a per-prefix tab anchor.
 *
 *  - `{ status: 'found', tabId, paneId }` — an existing tab with the prefix
 *    label, whose root pane is alive.
 *  - `{ status: 'none' }` — no matching tab exists (or the existing one is
 *    stale) → the caller provisions a new tab.
 *  - `{ status: 'unknown' }` — `tab list` / `pane list` could not be read
 *    → fail closed (never guess, never duplicate).
 */
type PrefixTabResolution =
  | { status: 'found'; tabId: string; paneId: string }
  | { status: 'none' }
  | { status: 'unknown' };

/**
 * Resolve the live anchor pane for the tab labelled exactly `prefix` in
 * `workspaceId`.
 *
 *  - `found` — the tab exists and hosts a live pane (adopt it).
 *  - `none` — `tab list` was read but no matching tab exists, or the matching
 *    tab has no live pane → the caller provisions a replacement.
 *  - `unknown` — `tab list`/`pane list` was unreadable → fail closed.
 */
async function resolvePrefixTab(
  cwd: string,
  deps: DispatcherAnchorDeps,
  workspaceId: string,
  prefix: string,
  listTabs: (workspaceId: string) => Promise<DispatcherTabInfo[] | null>,
): Promise<PrefixTabResolution> {
  let tabs: DispatcherTabInfo[] | null;
  try {
    tabs = await listTabs(workspaceId);
  } catch {
    return { status: 'unknown' };
  }
  if (tabs === null) return { status: 'unknown' };
  const match = findTabByLabel(tabs, prefix);
  if (match === null) return { status: 'none' };
  const resolution = await resolveLivePaneInTab(cwd, deps, workspaceId, match.tabId);
  if (resolution.status === 'unknown') return { status: 'unknown' };
  if (resolution.status === 'found') {
    return { status: 'found', tabId: match.tabId, paneId: resolution.paneId };
  }
  return { status: 'none' };
}

/**
 * Resolve or create the tab-anchored pane for a given work-item id prefix
 * inside the Dispatcher workspace (C1, parent WL-0MTRQT482001SNXC).
 *
 * FALLBACK placement (AC3, WL-0MUR5FUWD00024XN): `dispatchClaimedTier`
 * consults this resolver only when `resolveProjectWorkspace` does not resolve
 * a project workspace for the item's root.
 *
 * Algorithm:
 *  1. Ensure the Dispatcher workspace exists (re-use the legacy single
 *     anchor's workspace id when available, or provision it).
 *  2. List tabs in the Dispatcher workspace and look for one labelled with
 *     the prefix.
 *  3. If found, validate the root pane is alive (`pane get`); if alive,
 *     return it.
 *  4. If absent or stale, provision under the coordination lock:
 *     a. Double-check `tab list` inside the lock (a racing caller may have
 *        created the same tab).
 *     b. If still absent, `herdr tab create --workspace <id> --label <prefix>
 *        --no-focus`.
 *     c. Persist the new mapping in `downtime-dispatch-tab-anchors.json`.
 *  5. Return `{ workspaceId, tabId, paneId }` or `null` on any failure.
 *
 * Idempotency: the coordination lock serialises tab creation and the
 * double-check inside the lock prevents duplicate tabs from concurrent
 * first-dispatches. Stale panes trigger re-provisioning.
 *
 * Fail-safe: a provisioning failure degrades to `null` (caller treats as
 * 'anchor-unavailable', never falls back to a wrong workspace).
 */
export async function getDispatcherTabAnchor(
  cwd: string,
  deps: DispatcherAnchorDeps,
  prefix: string,
): Promise<DispatcherPrefixTabAnchor | null> {
  if (prefix === '') return null;
  const dir = getMachineCoordinationDir();
  if (dir === null) return null;
  if (!ensureMachineCoordinationDir(dir)) return null;

  const listTabs = deps.listTabs ?? ((ws: string) => listTabsInWorkspace(cwd, ws));

  // 1. Ensure the Dispatcher workspace exists.
  let workspaceId: string | null = null;
  try {
    workspaceId = await ensureDispatcherWorkspace(deps);
  } catch {
    workspaceId = null;
  }
  if (workspaceId === null || workspaceId === '') return null;

  // 2. Fast path: a persisted anchor for this prefix whose pane is still
  //    alive is reused directly (no `tab list` round-trip).
  const persisted = readTabAnchors(dir);
  const cached = persisted?.byPrefix[prefix];
  if (cached !== undefined) {
    let alive = false;
    try {
      alive = await deps.isPaneAlive(cached.paneId);
    } catch {
      alive = false; // fail-closed — fall through to re-provision
    }
    if (alive) {
      return { workspaceId, tabId: cached.tabId, paneId: cached.paneId };
    }
    // Stale cache (dead pane / closed tab) → fall through to re-provision.
  }

  // 3. Look for an existing tab labelled with the prefix (authoritative,
  //    handles an anchor file lost or written out-of-band).
  const fast = await resolvePrefixTab(cwd, deps, workspaceId, prefix, listTabs);
  if (fast.status === 'unknown') return null; // fail-closed (never duplicate)
  if (fast.status === 'found') {
    persistPrefixTab(dir, workspaceId, prefix, fast.tabId, fast.paneId);
    return { workspaceId, tabId: fast.tabId, paneId: fast.paneId };
  }

  // 4. Provision under the coordination lock with a double-check so
  //    concurrent first-dispatches for a NEW prefix cannot duplicate tabs.
  const release = tryAcquireCoordLock(dir);
  if (release === null) {
    // Another holder is provisioning — re-check once, else fail closed.
    const raced = await resolvePrefixTab(cwd, deps, workspaceId, prefix, listTabs);
    if (raced.status === 'found') {
      persistPrefixTab(dir, workspaceId, prefix, raced.tabId, raced.paneId);
      return { workspaceId, tabId: raced.tabId, paneId: raced.paneId };
    }
    return null;
  }

  try {
    // Double-check inside the lock: a racing caller may have created the tab
    // between our step-3 read and acquiring the lock.
    const inside = await resolvePrefixTab(cwd, deps, workspaceId, prefix, listTabs);
    if (inside.status === 'unknown') return null;
    if (inside.status === 'found') {
      persistPrefixTab(dir, workspaceId, prefix, inside.tabId, inside.paneId);
      return { workspaceId, tabId: inside.tabId, paneId: inside.paneId };
    }

    // inside.status === 'none' → create the tab (never focus-stealing).
    const createTabFn =
      deps.createTab ?? ((ws: string, label: string) => createTabInWorkspace(cwd, ws, label));
    let created: ItemTabAnchor | null;
    try {
      created = await createTabFn(workspaceId, prefix);
    } catch {
      return null;
    }
    if (created === null) return null;

    // Persist the new mapping (authority for subsequent reuse).
    if (!persistPrefixTab(dir, workspaceId, prefix, created.tabId, created.paneId)) return null;
    return { workspaceId, tabId: created.tabId, paneId: created.paneId };
  } finally {
    release();
  }
}
