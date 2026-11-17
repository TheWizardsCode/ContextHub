/**
 * packages/herdr/src/index.anchor-resolvers.ts — default anchor resolvers
 * for the Herdr Worklog plugin's downtime dispatch.
 *
 * The four default resolvers that {@link createDowntimeDeps} seeds
 * (`defaultDispatcherAnchorResolver`, `defaultProjectWorkspaceResolver`,
 * `defaultDispatcherTabAnchorResolver`, `defaultItemTabAnchorResolver`):
 * machine-wide Dispatcher anchor / per-prefix Dispatcher tab anchor /
 * project-workspace + item-ID tab placement via the herdr CLI. Extracted
 * verbatim from `packages/herdr/src/index.ts` (move-only,
 * WL-0MVOA0Q9W006WWZL, parent WL-0MVGKGFFN009UCM6); none is re-exported by
 * the barrel — the four are not part of the consumed public surface (they
 * are `createDowntimeDeps`' default parameters, value-imported by the
 * barrel for its internal dispatch paths). Imports are concrete siblings
 * only (`./dispatcher-anchor.js`); no barrel value imports, no new cycles.
 * Signatures and exported names must not change — production seeds for
 * `createDowntimeDeps`.
 */

import {
  getDispatcherAnchor as resolveDispatcherAnchor,
  getDispatcherTabAnchor as resolveDispatcherTabAnchor,
  getItemTabAnchor as resolveItemTabAnchor,
  resolveProjectWorkspace as resolveProjectWorkspaceForRoot,
  createDispatcherAnchorDeps,
  type DispatcherAnchor,
  type DispatcherPrefixTabAnchor,
  type ItemTabAnchor,
  type ProjectWorkspaceTarget,
} from './dispatcher-anchor.js';
import { resolveHerdrBin } from './herdr-bin.js';

/**
 * Placement-failure detail vocabulary (WL-0MWHCUZ5C000I7S6): structurally
 * identical to the family-local alias in `dispatcher-anchor.contract.ts` and
 * the local unions in the deps contracts — the default resolvers forward the
 * report callback untyped through to the tab-anchors resolvers' own
 * structural type.
 */
type PlacementFailureDetail =
  | 'persisted-workspace-missing'
  | 'herdr-unreadable'
  | 'dispatcher-workspace-unprovisionable'
  | 'prefix-empty'
  | 'item-tab-unavailable'
  | 'project-workspace-mismatch';

/**
 * Why the project-workspace resolver returned `null` (WL-0MWHW3PKX0048ZYL
 * AC3) — structurally identical to the contract's
 * `ProjectWorkspaceFallbackReason`; the barrel exports neither, so each
 * module declares its own copy.
 */
type ProjectWorkspaceFallbackReason =
  | 'project-workspace-mismatch'
  | 'project-workspace-missing'
  | 'no-project-workspace'
  | 'herdr-unreadable';

/**
 * Default Dispatcher-anchor resolver used by {@link createDowntimeDeps}
 * (C0 WL-0MTR01EU7005SYZG): resolves the machine-wide dedicated Dispatcher
 * anchor pane via the herdr CLI (F1 WL-0MTR2CD4X006XI7U), provisioning the
 * Dispatcher workspace idempotently on first dispatch. Null on any
 * failure — dispatch degrades to "no dispatch this cycle". Injectable for
 * tests that build real deps without a live herdr session.
 *
 * The optional trailing `report` callback (WL-0MWHCUZ5C000I7S6) is forwarded
 * to the underlying resolver so a fail-closed `null` carries the boundary
 * detail to the placement collector; the catch-all reports the generic
 * unreadable boundary (the underlying resolver reports its own, more
 * specific boundaries before returning `null`).
 */
export async function defaultDispatcherAnchorResolver(
  cwd: string,
  report?: (detail: PlacementFailureDetail) => void,
): Promise<DispatcherAnchor | null> {
  try {
    const herdrBin = resolveHerdrBin();
    return await resolveDispatcherAnchor(
      cwd,
      createDispatcherAnchorDeps(cwd, herdrBin),
      report,
    );
  } catch {
    report?.('herdr-unreadable');
    return null;
  }
}

/**
 * Default project-workspace resolver used by {@link createDowntimeDeps}
 * (WL-0MU321YK70035AYT): resolves the herdr plugin pane/workspace whose
 * logical root (`HERDR_RESOLVED_CWD`) equals the worklog root `cwd`, via the
 * herdr CLI — falling back to the DURABLE per-root project-workspace map when
 * no live plugin pane advertises the root (WL-0MWHW3PKX0048ZYL AC1/AC2). Null
 * on any failure — dispatch falls back to the retained Dispatcher anchor
 * (AC3, rare + logged). Injectable for tests that build real deps without a
 * live herdr session.
 *
 * The optional trailing `reportNearMiss` callback (WL-0MWHCV3PR002WSQM) is
 * forwarded to the underlying resolver: when it returns `null` and a plugin
 * pane reported a DIFFERENT non-empty `HERDR_RESOLVED_CWD`, each near-miss
 * record (expected vs actual root, pane/workspace ids) is reported so the
 * placement collector can record the mismatch on the decision entry.
 * Diagnostic-only — the exact-root matching rule is unchanged.
 *
 * The optional trailing `reportFallbackReason` callback
 * (WL-0MWHW3PKX0048ZYL AC3) is forwarded to the underlying resolver: when it
 * returns `null`, the reason the primary path failed
 * (`no-project-workspace` / `project-workspace-mismatch` /
 * `project-workspace-missing` / `herdr-unreadable`) is reported so a
 * `Dispatcher`-workspace fallback placement is attributable from the dispatch
 * log. Never invoked when the primary path resolves.
 */
export async function defaultProjectWorkspaceResolver(
  cwd: string,
  reportNearMiss?: (nearMiss: {
    expectedRoot: string;
    actualRoot: string;
    paneId: string;
    workspaceId: string;
  }) => void,
  reportFallbackReason?: (reason: ProjectWorkspaceFallbackReason) => void,
): Promise<ProjectWorkspaceTarget | null> {
  try {
    const herdrBin = resolveHerdrBin();
    return await resolveProjectWorkspaceForRoot(
      cwd,
      createDispatcherAnchorDeps(cwd, herdrBin),
      cwd,
      reportNearMiss,
      reportFallbackReason,
    );
  } catch {
    reportFallbackReason?.('herdr-unreadable');
    return null;
  }
}

/**
 * Default per-prefix Dispatcher tab-anchor resolver used by
 * {@link createDowntimeDeps} (C1, parent WL-0MTRQT482001SNXC): resolves or
 * creates the tab labelled with the work-item id prefix (e.g. `WL`, `TCE`)
 * inside the machine-wide Dispatcher workspace and returns its root pane.
 * This is the FALLBACK placement path (AC3, WL-0MUR5FUWD00024XN) — it is only
 * consulted when no project workspace resolves for the item's root. Null on
 * any failure — the dispatch fails closed ('anchor-unavailable'), never a
 * wrong-tab/workspace placement. Injectable for tests that build real deps
 * without a live herdr session.
 */
export async function defaultDispatcherTabAnchorResolver(
  cwd: string,
  prefix: string,
  report?: (detail: PlacementFailureDetail) => void,
): Promise<DispatcherPrefixTabAnchor | null> {
  try {
    const herdrBin = resolveHerdrBin();
    return await resolveDispatcherTabAnchor(
      cwd,
      createDispatcherAnchorDeps(cwd, herdrBin),
      prefix,
      report,
    );
  } catch {
    report?.('herdr-unreadable');
    return null;
  }
}

/**
 * Default item-ID tab-anchor resolver used by {@link createDowntimeDeps}
 * (WL-0MU321YK70035AYT): ensures/reuses the tab labelled with the exact
 * work-item id inside the resolved project workspace and returns its root
 * pane, via the herdr CLI. Null on any failure — the dispatch fails closed
 * ('anchor-unavailable'). Injectable for tests that build real deps without
 * a live herdr session.
 */
export async function defaultItemTabAnchorResolver(
  cwd: string,
  workspaceId: string,
  itemId: string,
): Promise<ItemTabAnchor | null> {
  try {
    const herdrBin = resolveHerdrBin();
    return await resolveItemTabAnchor(
      cwd,
      createDispatcherAnchorDeps(cwd, herdrBin),
      workspaceId,
      itemId,
    );
  } catch {
    return null;
  }
}
