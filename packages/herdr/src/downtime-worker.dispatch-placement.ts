/**
 * packages/herdr/src/downtime-worker.dispatch-placement.ts — dispatch pane
 * placement resolution and placeholder root-pane cleanup.
 *
 * Single responsibility: the `dispatchClaimedTier` placement step — resolve the
 * anchor pane a dispatch pane must split from (project workspace + item-ID tab,
 * per-prefix `Dispatcher` tab, then the retained single `Dispatcher` anchor)
 * and, fail-safely, close the placeholder root pane that a tab is provisioned
 * with once it is no longer needed.
 *
 * Extracted from `downtime-worker.dispatch-claims.ts` (WL-0MW5JE0SZ0057K30) so
 * that module stays inside the split-guard line ceiling; the extraction is
 * behaviour-preserving. The module answers two questions only:
 *
 *  - **Where?** `resolveDispatchPlacement` walks the documented precedence and
 *    either yields the anchor (a tab root pane or the persisted Dispatcher
 *    anchor) or fails closed with `{ ok: false }` — never the leader's pane and
 *    never another project's workspace.
 *  - **Nothing left behind?** `closePlaceholderRootPaneBestEffort` closes a
 *    tab's empty root pane once a dispatch pane exists — or once the dispatch
 *    needed it and then aborted (marker-write failure, spawn failure) — using
 *    a fail-safe liveness gate so a reused tab's live anchor is never closed.
 *
 * Layering: imports the anchor contract/types and `countRunningDowntimePanes`
 * from concrete siblings; never the `downtime-worker.js` barrel (which would
 * invert the layering for the split-family modules).
 */

import type {
  DispatcherAnchor,
  DispatcherPrefixTabAnchor,
  ItemTabAnchor,
  ProjectWorkspaceTarget,
} from './dispatcher-anchor.js';
import type { DowntimeDispatchDeps } from './downtime-worker.dispatch-contract.js';
import { countRunningDowntimePanes } from './downtime-worker.pane.js';

/**
 * Placement-failure detail vocabulary naming the exact fail-closed boundary
 * of an `anchor-unavailable` verdict (WL-0MWHCUZ5C000I7S6, parent
 * WL-0MWH50EN4007C6YH AC6). Structurally identical to the family-local
 * alias in `dispatcher-anchor.contract.ts` and to the deps contracts'
 * local unions — cross-referenced by comment; the barrel exports neither,
 * so no consumer imports a non-barrelled symbol (split guard, 38 exports).
 * TypeScript's structural typing makes them assignable wherever they meet.
 * The sibling mismatch item extends the union with `project-workspace-mismatch`
 * (WL-0MWHCV3PR002WSQM) — see {@link ProjectWorkspaceMismatch}.
 */
export type PlacementFailureDetail =
  | 'persisted-workspace-missing'
  | 'herdr-unreadable'
  | 'dispatcher-workspace-unprovisionable'
  | 'prefix-empty'
  | 'item-tab-unavailable'
  | 'project-workspace-mismatch';

/**
 * Primary-path near-miss diagnostic (WL-0MWHCV3PR002WSQM): `resolveProjectWorkspace`
 * failed to match the item's worklog root, but at least one plugin pane
 * reported a DIFFERENT non-empty `HERDR_RESOLVED_CWD`. The record names the
 * expected root, the actual `HERDR_RESOLVED_CWD` and the pane/workspace ids
 * so the ContextHub-style misplacement (pane reporting `…/packages/herdr`
 * for the worklog root `…/ContextHub`) is diagnosable from the decision log
 * instead of looking like "no plugin pane". Diagnostic-only — the matching
 * rule stays exact-root (never a wrong-workspace match). Structurally
 * identical to the resolver's module-local report record and to the copies on
 * the deps contracts / dispatch event.
 */
export interface ProjectWorkspaceMismatch {
  expectedRoot: string;
  actualRoot: string;
  paneId: string;
  workspaceId: string;
}

/**
 * A resolved placement.
 *
 * `anchorId` absent means "no anchor": legacy/test callers that wire no
 * placement dep keep the historical current-pane split behaviour.
 */
export interface DispatchPlacement {
  /** Pane the dispatch pane splits from (absent → current-pane behaviour). */
  anchorId?: string;
  /**
   * True when `anchorId` is a TAB ROOT pane (a project item tab or a
   * per-prefix Dispatcher tab). Tab roots are provisioned with herdr's initial
   * root pane (an empty bash pane) which is only needed as the split anchor for
   * the FIRST dispatch — it is closed once the dispatch pane spawns, and on the
   * pre-spawn abort paths. The legacy Dispatcher fallback anchor is
   * deliberately exempt: its root pane is the persisted dispatch anchor and
   * closing it would trigger a blank re-provision loop.
   */
  anchorIsTabRoot: boolean;
  /**
   * Primary-path near-miss diagnostic (WL-0MWHCV3PR002WSQM AC4): present when
   * the primary path did NOT resolve — `resolveProjectWorkspace` matched no
   * pane for the item's worklog root but at least one plugin pane reported a
   * DIFFERENT `HERDR_RESOLVED_CWD` (expected vs actual). Forwarded onto the
   * decision entry (the dispatch marker on success, the outcome fields on a
   * refusal) so a successful Dispatcher fallback placement STILL logs the
   * mismatch — ContextHub panes land in the Dispatcher `WL` tab until the
   * mismatch is fixed, and the fallback must not hide that.
   */
  projectWorkspaceMismatch?: ProjectWorkspaceMismatch;
}

/**
 * Placement outcome: a usable anchor, or the fail-closed
 * `anchor-unavailable` verdict with the machine-readable `detail` naming the
 * failing boundary (so the refusal is diagnosable from the log alone).
 */
export type DispatchPlacementResult =
  | ({ ok: true } & DispatchPlacement)
  | {
      ok: false;
      detail: PlacementFailureDetail;
      /** Primary-path near-miss (WL-0MWHCV3PR002WSQM AC4), when recorded. */
      projectWorkspaceMismatch?: ProjectWorkspaceMismatch;
    };

/**
 * Resolve the anchor pane for one dispatch (precedence, WL-0MUR5FUWD00024XN):
 *
 *  1. **Project workspace + item-ID tab (primary)** — `resolveProjectWorkspace`
 *     finds the project's plugin pane, `getItemTabAnchor` ensures/reuses the
 *     tab labelled with the exact work-item id, and that tab's root pane is
 *     the anchor (WL-0MU321YK70035AYT). A workspace that resolves but whose
 *     tab cannot be provisioned fails closed — never a wrong-placement
 *     fallback.
 *  2. **Per-prefix tab in the `Dispatcher` workspace (fallback)** — used only
 *     when no project workspace resolves (WL-0MTRQT482001SNXC). A null/empty
 *     prefix or a null/throw resolution fails closed.
 *  3. **Legacy single `Dispatcher` anchor (retained)** — only when neither
 *     above produces an anchor; used by scheduled prompts and pre-C1 callers.
 *
 * Called AFTER the CAS claim and AFTER host-budget admission
 * (WL-0MW5JE0SZ0057K30): provisioning a tab any earlier left an orphaned
 * placeholder pane whenever one of those gates refused the tick. The caller
 * rolls the claim back when this yields `{ ok: false }`.
 *
 * Fail-closed at every boundary; never throws.
 */
export async function resolveDispatchPlacement(
  deps: DowntimeDispatchDeps,
  opts: { cwd: string; itemId: string },
): Promise<DispatchPlacementResult> {
  let anchorId: string | undefined;
  let anchorIsTabRoot = false;
  // Extract the work-item id prefix (e.g. `WL-0MTO…` → `WL`, `TCE-…` → `TCE`).
  const prefix = opts.itemId.split('-', 1)[0];
  // Per-call collector (WL-0MWHCUZ5C000I7S6): the anchor resolvers report
  // the fail-closed boundary through the optional trailing callback into
  // this local, so no cross-dispatch state is introduced. Last report wins
  // (a recovered workspace's `persisted-workspace-missing` observation is
  // overwritten by a later un-recoverable boundary, and a successful
  // resolution returns `{ok:true}` with no detail at all).
  let placementDetail: PlacementFailureDetail | undefined;
  const reportAnchorDetail = (detail: PlacementFailureDetail): void => {
    placementDetail = detail;
  };
  // Per-call near-miss collector (WL-0MWHCV3PR002WSQM AC4): the project-
  // workspace resolver reports each plugin pane's `HERDR_RESOLVED_CWD`
  // near-miss through its optional trailing callback into this local; FIRST
  // report wins (deterministic, pane-scan order). Only ever set when the
  // primary path returned null (the resolver reports no match), so a
  // successful project-workspace resolution records nothing (AC3).
  let projectWorkspaceMismatch: ProjectWorkspaceMismatch | undefined;
  const reportNearMiss = (nearMiss: ProjectWorkspaceMismatch): void => {
    projectWorkspaceMismatch ??= nearMiss;
  };

  // ── Primary path: project workspace + item-ID tab ─────────────────────
  // When a project plugin pane resolves for the root, the Dispatcher workspace
  // is NOT used (AC2/AC3). A null resolution falls through to the fallbacks.
  if (typeof deps.resolveProjectWorkspace === 'function') {
    let projectTarget: ProjectWorkspaceTarget | null = null;
    try {
      projectTarget = await deps.resolveProjectWorkspace(opts.cwd, reportNearMiss);
    } catch {
      projectTarget = null; // fail-closed on any resolver error
    }
    if (projectTarget !== null && typeof deps.getItemTabAnchor === 'function') {
      let tabAnchor: ItemTabAnchor | null = null;
      try {
        tabAnchor = await deps.getItemTabAnchor(
          opts.cwd,
          projectTarget.workspaceId,
          opts.itemId,
        );
      } catch {
        tabAnchor = null; // fail-closed
      }
      if (tabAnchor === null) {
        // The workspace resolved but its item tab could not be provisioned:
        // fail closed rather than place a project pane in the Dispatcher
        // workspace (never a wrong placement).
        return { ok: false, detail: 'item-tab-unavailable' };
      }
      anchorId = tabAnchor.paneId;
      anchorIsTabRoot = true;
    }
  }

  // ── Fallback: per-prefix tab in the Dispatcher workspace (AC3) ───────
  // When wired, the per-prefix resolver REPLACES the legacy single anchor — a
  // null/failed resolution is 'anchor-unavailable' and NEVER falls back to the
  // legacy Dispatcher anchor or the leader's pane (fail-safe, never a
  // wrong-tab placement).
  if (anchorId === undefined && typeof deps.getDispatcherTabAnchor === 'function') {
    if (!prefix) {
      // No prefix extractable (empty/invalid id) → cannot route by prefix.
      return {
        ok: false,
        detail: 'prefix-empty',
        ...(projectWorkspaceMismatch !== undefined ? { projectWorkspaceMismatch } : {}),
      };
    }
    let prefixAnchor: DispatcherPrefixTabAnchor | null = null;
    try {
      // The trailing report callback collects the fail-closed boundary the
      // resolver names (prefix-empty / herdr-unreadable / …).
      prefixAnchor = await deps.getDispatcherTabAnchor(
        opts.cwd,
        prefix,
        reportAnchorDetail,
      );
    } catch {
      prefixAnchor = null; // fail-closed — boundary reported by the resolver
    }
    if (prefixAnchor === null) {
      return {
        ok: false,
        detail: placementDetail ?? 'herdr-unreadable',
        ...(projectWorkspaceMismatch !== undefined ? { projectWorkspaceMismatch } : {}),
      };
    }
    anchorId = prefixAnchor.paneId;
    // Per-prefix Dispatcher tabs use herdr's initial root pane as anchor.
    anchorIsTabRoot = true;
  }

  // ── Fallback: legacy Dispatcher single anchor (AC4) ───────────────────
  // When this dep IS wired, a null/failed resolution fails closed — never a
  // current-pane placement. When it is NOT wired (pre-C0 / legacy/test
  // callers), no anchor is set and the spawn uses the legacy current-pane
  // behaviour.
  if (anchorId === undefined && typeof deps.getDispatcherAnchor === 'function') {
    let anchor: DispatcherAnchor | null = null;
    try {
      // The trailing report callback collects the fail-closed boundary the
      // resolver names (herdr-unreadable / …).
      anchor = await deps.getDispatcherAnchor(opts.cwd, reportAnchorDetail);
    } catch {
      anchor = null; // fail-closed on any anchor error
    }
    if (anchor === null) {
      return {
        ok: false,
        detail: placementDetail ?? 'herdr-unreadable',
        // The primary-path near-miss rides along even when the Dispatcher
        // fallback ALSO fails — a fallback failure never hides the recorded
        // mismatch (WL-0MWHCV3PR002WSQM AC4).
        ...(projectWorkspaceMismatch !== undefined ? { projectWorkspaceMismatch } : {}),
      };
    }
    anchorId = anchor.paneId;
    // The legacy Dispatcher anchor is NOT a tab root — it is the persisted
    // dispatch pane and must never be closed.
    anchorIsTabRoot = false;
  }

  return {
    ok: true,
    anchorId,
    anchorIsTabRoot,
    // Recorded on the placement result (and forwarded onto the dispatch
    // decision entry) even when the Dispatcher fallback subsequently succeeds
    // (WL-0MWHCV3PR002WSQM AC4) — the fallback success must not hide that the
    // primary path near-missed.
    ...(projectWorkspaceMismatch !== undefined ? { projectWorkspaceMismatch } : {}),
  };
}

/**
 * Close a dispatch's placeholder tab-root pane, fail-safely and best-effort
 * (WL-0MU2EOHK900425VU, extended to the pre-spawn abort paths by
 * WL-0MW5JE0SZ0057K30).
 *
 * A tab root is herdr's initial empty bash pane, provisioned with the tab and
 * only used as the split anchor for the FIRST dispatch; once a dispatch pane
 * exists (or the dispatch is abandoned) the tab must not keep the blank pane.
 *
 * Fail-safe: the anchor is closed ONLY when liveness POSITIVELY confirms it is
 * not a live downtime pane. The check uses the running DOWNTIME pane ids
 * (`paneIds`) — NEVER the machine-wide pane set (`records` contains the anchor
 * itself and would suppress every close); a `records`-only payload is filtered
 * through `countRunningDowntimePanes`. When liveness cannot be confirmed
 * (query failed/absent) the anchor is left open so a live agent pane is never
 * closed.
 *
 * Fail-open: an absent `closePane` seam, a throwing liveness query or a
 * throwing close is a non-event — cleanup never blocks or changes the dispatch
 * outcome, and never turns a refusal into a strike.
 */
export async function closePlaceholderRootPaneBestEffort(
  deps: DowntimeDispatchDeps,
  opts: { cwd: string; anchorId: string | undefined; anchorIsTabRoot: boolean },
): Promise<void> {
  const { anchorId } = opts;
  if (!opts.anchorIsTabRoot || anchorId === undefined) return;
  if (typeof deps.closePane !== 'function') return;
  try {
    let confirmedRootPane = false;
    if (typeof deps.getRunningDowntimePanes === 'function') {
      const running = await deps.getRunningDowntimePanes(opts.cwd);
      if (running.ok) {
        const liveIds = Array.isArray(running.paneIds)
          ? running.paneIds
          : running.records !== undefined
            ? countRunningDowntimePanes(running.records)
            : null;
        if (liveIds !== null) confirmedRootPane = !liveIds.includes(anchorId);
      }
    }
    if (confirmedRootPane) {
      await deps.closePane(anchorId, opts.cwd);
    }
  } catch {
    // fail-open: root-pane cleanup must never block the dispatch outcome
  }
}
