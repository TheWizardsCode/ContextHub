/**
 * packages/herdr/src/dispatcher-anchor.tab-anchors.ts — Dispatcher workspace
 * provisioning and the machine-wide / per-prefix tab-anchor resolvers.
 *
 * Single responsibility: the C0/C1 placement policy — resolve or provision the
 * machine-wide Dispatcher workspace anchor pane (`getDispatcherAnchor`) and the
 * per-work-item-prefix tab anchor inside it (`getDispatcherTabAnchor`), plus
 * the resolution helpers they share. The coordination-lock + double-check +
 * create sequence is delegated to the family's shared
 * `findOrProvisionUnderLock` (`dispatcher-anchor.provision.ts`, WL-0MWHWH68L007L7IO
 * AC1); the stale-pane re-provision semantics live here unchanged, as does
 * the persisted-workspace
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
 * from `dispatcher-anchor.herdr-cli.js`, the shared find-or-provision-under-
 * lock helper from `dispatcher-anchor.provision.js` and the machine
 * coordination primitives from `./machine-coordination.js`. It never imports
 * the `dispatcher-anchor.js` barrel, so the barrel can import these resolvers
 * without creating a cycle.
 */

import {
  getMachineCoordinationDir,
  ensureMachineCoordinationDir,
} from './machine-coordination.js';
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
import {
  findOrProvisionUnderLock,
  type ProvisionFind,
} from './dispatcher-anchor.provision.js';

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
 * Shared by `getDispatcherAnchor` and the recovery path in
 * `ensureDispatcherWorkspace` (positively-missing workspace) — the single
 * provisioning mechanism of the anchor family (AC2), so racing callers can
 * never create two Dispatcher workspaces.
 *
 * Implemented on the family's shared `findOrProvisionUnderLock` (AC1): the
 * in-lock `find` re-reads the anchor and probes liveness (a racing caller may
 * have written one), the raced single re-check adopts a winner's anchor, and
 * `create` provisions the workspace + adopts the root pane + persists the
 * anchor file, failing closed when any step fails.
 */
async function provisionDispatcherAnchorUnderLock(
  dir: string,
  deps: DispatcherAnchorDeps,
  report?: (detail: PlacementFailureDetail) => void,
): Promise<DispatcherAnchor | null> {
  return findOrProvisionUnderLock<DispatcherAnchor>({
    dir,
    find: async () => {
      const existing = readAnchor(dir);
      if (existing === null) return { status: 'none' };
      try {
        const alive = await deps.isPaneAlive(existing.paneId);
        return alive ? { status: 'found', value: existing } : { status: 'none' };
      } catch {
        return { status: 'unknown' }; // missing ≠ unreadable
      }
    },
    create: async () => {
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
    },
    report,
    fastUnknownDetail: 'herdr-unreadable',
    racedUnknownDetail: 'herdr-unreadable',
    racedMissDetail: 'dispatcher-workspace-unprovisionable',
    inLockUnknownDetail: 'herdr-unreadable',
    createFailDetail: 'dispatcher-workspace-unprovisionable',
  });
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

  // Shared find-or-provision-under-lock (AC1): the helper's fast `find`
  // adopts a persisted live anchor, a stale/absent anchor falls through to
  // the single under-lock provisioning sequence (`provisionDispatcherAnchor-
  // UnderLock`), which the recovery path reuses unchanged.
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
 * Resolve the live anchor pane for the tab labelled exactly `prefix` in
 * `workspaceId` (shared ProvisionFind contract, AC1).
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
): Promise<ProvisionFind<DispatcherPrefixTabAnchor>> {
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
    return {
      status: 'found',
      value: { workspaceId, tabId: match.tabId, paneId: resolution.paneId },
    };
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

  // 4–5. Resolve-or-provision the tab via the family's shared
  //    find-or-provision-under-lock sequence (AC1): fast path adopts an
  //    existing live tab; a raced single re-check adopts a racing caller's
  //    result when the lock is held; the in-lock double-check re-reads; and
  //    the `none` case creates the tab. Every found path rewrites the
  //    persisted mapping best-effort (current behaviour — the return is
  //    ignored on found), while the created-path persist is fail-closed
  //    (without the mapping the next dispatch cannot reuse the tab).
  return findOrProvisionUnderLock<DispatcherPrefixTabAnchor>({
    dir,
    find: () => resolvePrefixTab(cwd, deps, workspaceId, prefix, listTabs),
    create: async () => {
      const createTabFn =
        deps.createTab ?? ((ws: string, label: string) => createTabInWorkspace(cwd, ws, label));
      let createdTab: ItemTabAnchor | null = null;
      try {
        createdTab = await createTabFn(workspaceId, prefix);
      } catch {
        return null; // fail-closed → helper reports createFailDetail
      }
      if (createdTab === null) return null;
      return { workspaceId, tabId: createdTab.tabId, paneId: createdTab.paneId };
    },
    adoptFound: (value) => {
      persistPrefixTab(dir, workspaceId, prefix, value.tabId, value.paneId);
    },
    adoptCreated: (value) =>
      persistPrefixTab(dir, workspaceId, prefix, value.tabId, value.paneId),
    report,
    fastUnknownDetail: 'herdr-unreadable',
    racedUnknownDetail: 'dispatcher-workspace-unprovisionable',
    racedMissDetail: 'dispatcher-workspace-unprovisionable',
    inLockUnknownDetail: 'herdr-unreadable',
    createFailDetail: 'dispatcher-workspace-unprovisionable',
  });
}
