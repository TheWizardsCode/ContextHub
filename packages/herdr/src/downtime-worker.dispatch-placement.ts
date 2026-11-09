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
}

/**
 * Placement outcome: a usable anchor, or the fail-closed
 * `anchor-unavailable` verdict.
 */
export type DispatchPlacementResult = ({ ok: true } & DispatchPlacement) | { ok: false };

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

  // ── Primary path: project workspace + item-ID tab ─────────────────────
  // When a project plugin pane resolves for the root, the Dispatcher workspace
  // is NOT used (AC2/AC3). A null resolution falls through to the fallbacks.
  if (typeof deps.resolveProjectWorkspace === 'function') {
    let projectTarget: ProjectWorkspaceTarget | null = null;
    try {
      projectTarget = await deps.resolveProjectWorkspace(opts.cwd);
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
        return { ok: false };
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
      return { ok: false };
    }
    let prefixAnchor: DispatcherPrefixTabAnchor | null = null;
    try {
      prefixAnchor = await deps.getDispatcherTabAnchor(opts.cwd, prefix);
    } catch {
      prefixAnchor = null; // fail-closed
    }
    if (prefixAnchor === null) {
      return { ok: false };
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
      anchor = await deps.getDispatcherAnchor(opts.cwd);
    } catch {
      anchor = null; // fail-closed on any anchor error
    }
    if (anchor === null) {
      return { ok: false };
    }
    anchorId = anchor.paneId;
    // The legacy Dispatcher anchor is NOT a tab root — it is the persisted
    // dispatch pane and must never be closed.
    anchorIsTabRoot = false;
  }

  return { ok: true, anchorId, anchorIsTabRoot };
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
