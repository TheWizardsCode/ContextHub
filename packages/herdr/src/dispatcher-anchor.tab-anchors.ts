/**
 * packages/herdr/src/dispatcher-anchor.tab-anchors.ts — Dispatcher workspace
 * provisioning and the machine-wide / per-prefix tab-anchor resolvers.
 *
 * Single responsibility: the C0/C1 placement policy — resolve or provision the
 * machine-wide Dispatcher workspace anchor pane (`getDispatcherAnchor`) and the
 * per-work-item-prefix tab anchor inside it (`getDispatcherTabAnchor`), plus
 * the resolution helpers they share. The coordination lock
 * (`tryAcquireCoordLock`), the in-lock double-check and the stale-pane
 * re-provision semantics live here unchanged, as does the persisted-workspace
 * validation added by WL-0MWHCUTDM003B39Q: a persisted Dispatcher workspace
 * that no longer exists is re-provisioned exactly once under the same
 * coordination lock (`provisionDispatcherAnchorUnderLock`) instead of wedging
 * the per-prefix resolver with `anchor-unavailable` forever.
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
  PlacementFailureDetail,
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
 * Result of ensuring the Dispatcher workspace.
 *
 *  - `workspaceId` — the workspace to use (the persisted id, the freshly
 *    provisioned id, or the recovered replacement).
 *  - `recovered` — true when the persisted workspace was positively `missing`
 *    and exactly one replacement was provisioned (or adopted from a racing
 *    recovery) under the coordination lock. A recovered workspace rewrote the
 *    persisted ids, so every cached per-prefix entry is stale by construction.
 */
interface EnsuredDispatcherWorkspace {
  workspaceId: string;
  recovered: boolean;
}

/**
 * Ensure the Dispatcher workspace exists and return its id (plus whether it
 * was recovered). Validates the persisted workspace id against live herdr
 * state BEFORE reuse so a workspace that no longer exists self-heals instead
 * of wedging the per-prefix resolver (parent WL-0MWH50EN4007C6YH):
 *
 *  - persisted id + `probeWorkspace` — `alive` reuses it; `missing` recovers
 *    via {@link provisionDispatcherAnchorUnderLock} (exactly one replacement
 *    under the coordination lock); `unreadable`/absent probe fails closed with
 *    NOTHING provisioned (a transient herdr must never duplicate the
 *    workspace — missing ≠ unreadable, parent AC3).
 *  - no persisted id → provision as today.
 *
 * The probe is consulted ONLY here, on the recovery path — never on a healthy
 * fast-path resolution (AC8, parent AC10). Returns `null` on failure (the
 * caller fails closed with `anchor-unavailable`).
 *
 * @param report Optional trailing fail-closed boundary reporter
 *   (WL-0MWHCUZ5C000I7S6): invoked with the {@link PlacementFailureDetail}
 *   naming the exact boundary before every `null` return, so the placement
 *   collector can make an `anchor-unavailable` refusal diagnosable from the
 *   decision log alone. A positively-missing workspace reports
 *   `persisted-workspace-missing` BEFORE the recovery attempt; a failed
 *   recovery overwrites it with `dispatcher-workspace-unprovisionable` (last
 *   report wins), and a successful recovery reports nothing further — the
 *   caller's `{ok:true}` result carries no detail (parent AC3).
 */
async function ensureDispatcherWorkspace(
  deps: DispatcherAnchorDeps,
  report?: (detail: PlacementFailureDetail) => void,
): Promise<EnsuredDispatcherWorkspace | null> {
  const existing = readDispatcherWorkspaceId();
  if (existing === null) {
    try {
      const created = await deps.createWorkspace(DISPATCHER_WORKSPACE_LABEL);
      return { workspaceId: created.workspaceId, recovered: false };
    } catch {
      report?.('dispatcher-workspace-unprovisionable');
      return null;
    }
  }

  let verdict: 'alive' | 'missing' | 'unreadable';
  try {
    verdict = deps.probeWorkspace ? await deps.probeWorkspace(existing) : 'unreadable';
  } catch {
    verdict = 'unreadable';
  }
  if (verdict === 'unreadable') {
    // Fail closed — never duplicate. The persisted workspace may be perfectly
    // fine; the herdr CLI could not be read to prove it (parent "missing ≠
    // unreadable").
    report?.('herdr-unreadable');
    return null;
  }
  if (verdict === 'alive') return { workspaceId: existing, recovered: false };

  // Positively missing → report the observed boundary, then exactly one
  // replacement under the coordination lock. A successful recovery's
  // `{ok:true}` result carries no detail (parent AC3); a failed recovery
  // overwrites the report below.
  report?.('persisted-workspace-missing');
  const dir = getMachineCoordinationDir();
  if (dir === null) {
    report?.('dispatcher-workspace-unprovisionable');
    return null;
  }
  const recovered = await provisionDispatcherAnchorUnderLock(dir, deps, report);
  return recovered === null ? null : { workspaceId: recovered.workspaceId, recovered: true };
}

/**
 * Provision exactly ONE Dispatcher anchor under the machine coordination lock
 * (lock → in-lock double-check → create workspace → adopt root pane → write
 * anchor → release). Returns the anchor, or `null` on any failure.
 *
 * Shared by `getDispatcherAnchor` (stale-pane re-provision) and the recovery
 * path in `ensureDispatcherWorkspace` (positively-missing workspace) — the
 * single provisioning mechanism of the anchor family (AC2), so racing callers
 * can never create two Dispatcher workspaces.
 */
async function provisionDispatcherAnchorUnderLock(
  dir: string,
  deps: DispatcherAnchorDeps,
  report?: (detail: PlacementFailureDetail) => void,
): Promise<DispatcherAnchor | null> {
  const release = tryAcquireCoordLock(dir);
  if (release === null) {
    // Another holder is provisioning — re-read whatever they wrote, or null.
    const raced = readAnchor(dir);
    if (raced !== null) {
      try {
        const alive = await deps.isPaneAlive(raced.paneId);
        if (alive) return raced;
      } catch {
        report?.('herdr-unreadable');
        return null;
      }
    }
    report?.('dispatcher-workspace-unprovisionable');
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
      } catch {
        report?.('herdr-unreadable');
        return null;
      }
      // stale inside-lock → re-provision below (overwrite)
    }

    let created: { workspaceId: string; paneId: string };
    try {
      created = await deps.createWorkspace(DISPATCHER_WORKSPACE_LABEL);
    } catch {
      report?.('dispatcher-workspace-unprovisionable');
      return null;
    }
    // Adopt the freshly-provisioned root pane into its own tab so the
    // workspace never shows a blank pane (WL-0MU2EOHK900425VU).
    await adoptRootPaneIntoNewTab(deps, created.paneId);
    const anchor: DispatcherAnchor = { paneId: created.paneId, workspaceId: created.workspaceId };
    if (!writeAnchor(dir, anchor)) {
      report?.('dispatcher-workspace-unprovisionable');
      return null;
    }
    return anchor;
  } finally {
    release();
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
  report?: (detail: PlacementFailureDetail) => void,
): Promise<DispatcherAnchor | null> {
  const dir = getMachineCoordinationDir();
  if (dir === null) {
    report?.('dispatcher-workspace-unprovisionable');
    return null;
  }
  if (!ensureMachineCoordinationDir(dir)) {
    report?.('dispatcher-workspace-unprovisionable');
    return null;
  }

  const existing = readAnchor(dir);
  if (existing !== null) {
    try {
      const alive = await deps.isPaneAlive(existing.paneId);
      if (alive) return existing;
    } catch {
      report?.('herdr-unreadable');
      return null;
    }
    // Stale → re-provision under lock (fall through to provision path)
  }

  // Provision under the coordination lock so concurrent first-dispatches do not duplicate.
  return provisionDispatcherAnchorUnderLock(dir, deps, report);
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
 *  1. Read the persisted anchors (cheap file reads — no probe, no CLI). A
 *     healthy cached pane whose workspace still matches both persistence files
 *     is reused directly.
 *  2. Ensure the Dispatcher workspace exists: validate the persisted id
 *     against live herdr state (`probeWorkspace`), recovering a positively
 *     missing workspace under the coordination lock. `unreadable`/absent
 *     probe fails closed with NOTHING provisioned; a recovered workspace gets
 *     a fresh id.
 *  3. List tabs in the Dispatcher workspace and look for one labelled with
 *     the prefix.
 *  4. If found, validate the root pane is alive (`pane get`); if alive,
 *     return it.
 *  5. If absent or stale, provision under the coordination lock:
 *     a. Double-check `tab list` inside the lock (a racing caller may have
 *        created the same tab).
 *     b. If still absent, `herdr tab create --workspace <id> --label <prefix>
 *        --no-focus`.
 *     c. Persist the new mapping in `downtime-dispatch-tab-anchors.json`,
 *        rewriting the workspace id when it was recovered.
 *  6. Return `{ workspaceId, tabId, paneId }` or `null` on any failure.
 *
 * Idempotency: the coordination lock serialises tab creation and the
 * double-check inside the lock prevents duplicate tabs from concurrent
 * first-dispatches. Stale panes trigger re-provisioning.
 *
 * Fail-safe: a provisioning failure degrades to `null` (caller treats as
 * 'anchor-unavailable', never falls back to a wrong workspace).
 *
 * @param report Optional trailing fail-closed boundary reporter
 *   (WL-0MWHCUZ5C000I7S6): invoked with the {@link PlacementFailureDetail}
 *   naming the exact boundary before every `null` return (additive — callers
 *   that pass no callback behave exactly as before). The persisted-workspace
 *   recovery path reports `persisted-workspace-missing` before the recovery
 *   attempt; a failed recovery overwrites it with
 *   `dispatcher-workspace-unprovisionable` (last report wins), and a
 *   successful recovery reports nothing further.
 */
export async function getDispatcherTabAnchor(
  cwd: string,
  deps: DispatcherAnchorDeps,
  prefix: string,
  report?: (detail: PlacementFailureDetail) => void,
): Promise<DispatcherPrefixTabAnchor | null> {
  if (prefix === '') {
    report?.('prefix-empty');
    return null;
  }
  const dir = getMachineCoordinationDir();
  if (dir === null) {
    report?.('dispatcher-workspace-unprovisionable');
    return null;
  }
  if (!ensureMachineCoordinationDir(dir)) {
    report?.('dispatcher-workspace-unprovisionable');
    return null;
  }

  const listTabs = deps.listTabs ?? ((ws: string) => listTabsInWorkspace(cwd, ws));

  // 1. Cheap persisted reads — no probe, no CLI. A healthy fast-path
  //    resolution therefore issues exactly the herdr calls it made before the
  //    workspace-validation fix (AC8, parent AC10: the probe is only
  //    consulted after a stale-pane fast-path miss).
  const persisted = readTabAnchors(dir);
  const persistedWorkspaceId = readDispatcherWorkspaceId();

  // 2. Fast path: a persisted anchor for this prefix whose pane is still
  //    alive AND whose workspace agrees with BOTH persistence files is reused
  //    directly (no `tab list`, no probe). A cached entry for a different
  //    workspace belongs to a dead/missing workspace and must never short-
  //    circuit past recovery (AC5).
  const cached =
    persistedWorkspaceId !== null && persisted?.workspaceId === persistedWorkspaceId
      ? persisted?.byPrefix[prefix]
      : undefined;
  if (cached !== undefined && persistedWorkspaceId !== null) {
    let alive = false;
    try {
      alive = await deps.isPaneAlive(cached.paneId);
    } catch {
      alive = false; // fail-closed — fall through to re-provision
    }
    if (alive) {
      return { workspaceId: persistedWorkspaceId, tabId: cached.tabId, paneId: cached.paneId };
    }
    // Stale cache (dead pane / closed tab) → fall through to re-provision.
  }

  // 3. Ensure the Dispatcher workspace exists — now VALIDATING the persisted
  //    id against live herdr state (probe) and recovering a positively missing
  //    workspace under the coordination lock (AC1/AC3). The probe is consulted
  //    exactly here; the recovery trigger is the stale-pane miss above, so a
  //    healthy resolution never probes (AC8). The boundary reporter names the
  //    fail-closed verdict (`herdr-unreadable` vs `dispatcher-workspace-
  //    unprovisionable`, WL-0MWHCUZ5C000I7S6).
  let ensured: EnsuredDispatcherWorkspace | null = null;
  try {
    ensured = await ensureDispatcherWorkspace(deps, report);
  } catch {
    ensured = null;
  }
  if (ensured === null) return null; // detail reported inside ensure
  if (ensured.workspaceId === '') {
    report?.('dispatcher-workspace-unprovisionable');
    return null;
  }
  const workspaceId = ensured.workspaceId;
  // A recovered workspace rewrote the persisted ids, so any cached entry
  // (already rejected above) is stale by construction — the resolution below
  // runs against the fresh workspace and `persistPrefixTab` rewrites the
  // per-prefix map with the new workspace id (AC5).

  // 4. Look for an existing tab labelled with the prefix (authoritative,
  //    handles an anchor file lost or written out-of-band).
  const fast = await resolvePrefixTab(cwd, deps, workspaceId, prefix, listTabs);
  if (fast.status === 'unknown') {
    report?.('herdr-unreadable'); // tab list unreadable — fail-closed
    return null;
  }
  if (fast.status === 'found') {
    persistPrefixTab(dir, workspaceId, prefix, fast.tabId, fast.paneId);
    return { workspaceId, tabId: fast.tabId, paneId: fast.paneId };
  }

  // 5. Provision under the coordination lock with a double-check so
  //    concurrent first-dispatches for a NEW prefix cannot duplicate tabs.
  const release = tryAcquireCoordLock(dir);
  if (release === null) {
    // Another holder is provisioning — re-check once, else fail closed.
    const raced = await resolvePrefixTab(cwd, deps, workspaceId, prefix, listTabs);
    if (raced.status === 'found') {
      persistPrefixTab(dir, workspaceId, prefix, raced.tabId, raced.paneId);
      return { workspaceId, tabId: raced.tabId, paneId: raced.paneId };
    }
    report?.('dispatcher-workspace-unprovisionable');
    return null;
  }

  try {
    // Double-check inside the lock: a racing caller may have created the tab
    // between our step-4 read and acquiring the lock.
    const inside = await resolvePrefixTab(cwd, deps, workspaceId, prefix, listTabs);
    if (inside.status === 'unknown') {
      report?.('herdr-unreadable'); // fail-closed (never duplicate)
      return null;
    }
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
      report?.('dispatcher-workspace-unprovisionable');
      return null;
    }
    if (created === null) {
      report?.('dispatcher-workspace-unprovisionable');
      return null;
    }

    // Persist the new mapping (authority for subsequent reuse).
    if (!persistPrefixTab(dir, workspaceId, prefix, created.tabId, created.paneId)) {
      report?.('dispatcher-workspace-unprovisionable');
      return null;
    }
    return { workspaceId, tabId: created.tabId, paneId: created.paneId };
  } finally {
    release();
  }
}
