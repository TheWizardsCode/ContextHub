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

/**
 * Default Dispatcher-anchor resolver used by {@link createDowntimeDeps}
 * (C0 WL-0MTR01EU7005SYZG): resolves the machine-wide dedicated Dispatcher
 * anchor pane via the herdr CLI (F1 WL-0MTR2CD4X006XI7U), provisioning the
 * Dispatcher workspace idempotently on first dispatch. Null on any
 * failure — dispatch degrades to "no dispatch this cycle". Injectable for
 * tests that build real deps without a live herdr session.
 */
export async function defaultDispatcherAnchorResolver(
  cwd: string,
): Promise<DispatcherAnchor | null> {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
    return await resolveDispatcherAnchor(cwd, createDispatcherAnchorDeps(cwd, herdrBin));
  } catch {
    return null;
  }
}

/**
 * Default project-workspace resolver used by {@link createDowntimeDeps}
 * (WL-0MU321YK70035AYT): resolves the herdr plugin pane/workspace whose
 * logical root (`HERDR_RESOLVED_CWD`) equals the worklog root `cwd`, via the
 * herdr CLI. Null on any failure — dispatch falls back to the retained
 * Dispatcher anchor (AC4). Injectable for tests that build real deps without
 * a live herdr session.
 */
export async function defaultProjectWorkspaceResolver(
  cwd: string,
): Promise<ProjectWorkspaceTarget | null> {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
    return await resolveProjectWorkspaceForRoot(
      cwd,
      createDispatcherAnchorDeps(cwd, herdrBin),
      cwd,
    );
  } catch {
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
): Promise<DispatcherPrefixTabAnchor | null> {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
    return await resolveDispatcherTabAnchor(
      cwd,
      createDispatcherAnchorDeps(cwd, herdrBin),
      prefix,
    );
  } catch {
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
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
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
