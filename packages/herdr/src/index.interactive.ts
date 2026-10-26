/**
 * packages/herdr/src/index.interactive.ts — interactive placement and
 * root-pane cleanup for the Herdr Worklog plugin's pane dispatch.
 *
 * The interactive dispatch path resolves the workspace + item-ID tab anchor
 * for an ID-carrying command, spawns the pane co-located with that item's
 * other panes, and fail-safely closes the freshly provisioned tab's
 * placeholder root pane. Extracted verbatim from
 * `packages/herdr/src/index.ts` (move-only, WL-0MVOA0S1E0022UV7, parent
 * WL-0MVGKGFFN009UCM6): `resolveInteractiveWorkspaceId`,
 * `resolveInteractiveItemAnchor`, `closeInteractiveTabRootPane`,
 * `defaultInteractiveLiveTrackedPanesResolver` are re-exported by the barrel
 * (the consumed public surface — `index.test.ts` imports them through
 * `./index.js`); `InteractiveLiveTrackedPanesResult`,
 * `InteractiveRootPaneCleanupDeps`, `isLiveTrackedPane` and
 * `defaultInteractiveClosePane` stay module-private relative to the barrel —
 * `main()` (still in `index.ts`) value-imports the two internal defaults
 * (`defaultInteractiveLiveTrackedPanesResolver`,
 * `defaultInteractiveClosePane`) and the `main` phase (11) reads the
 * internal defaults for root-pane cleanup from this module. Imports are
 * concrete siblings only (`./dispatcher-anchor.js`, `./fetcher.js`,
 * `./downtime-worker.js`); no barrel value imports, no new cycles.
 * Signatures and exported names must not change — behaviour-preservation
 * gate for the unchanged `index.test.ts` suite.
 */

import {
  getItemTabAnchor as resolveItemTabAnchor,
  createDispatcherAnchorDeps,
  type DispatcherAnchorDeps,
  type ItemTabAnchor,
} from './dispatcher-anchor.js';
import { getExecFileAsync } from './fetcher.js';
import {
  DOWNTIME_WL_TIMEOUT_MS,
  parseHerdrPaneListOutput,
  type HerdrPaneRecord,
} from './downtime-worker.js';

/**
 * Resolve the workspace that should host an interactive item-ID tab
 * (WL-0MUYI3JAO002BTNL, parent WL-0MUKZGEQ2007FECS, Q2a).
 *
 * Interactive dispatch uses the invoking pane's current workspace, not the
 * project-resolved workspace the automated downtime path uses. Reads
 * `HERDR_WORKSPACE_ID` (present in the plugin pane environment); when it is
 * absent/blank it falls back to the workspace component of `HERDR_PANE_ID`
 * (`<workspace>:<pane>`), then `null` so the caller fails open to the
 * current-pane split. Synchronous and total: never throws.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns The workspace id, or `null` when it cannot be determined.
 */
export function resolveInteractiveWorkspaceId(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = env.HERDR_WORKSPACE_ID;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.trim();
  }
  const invokingPane = env.HERDR_PANE_ID;
  if (typeof invokingPane === 'string') {
    const sep = invokingPane.indexOf(':');
    if (sep > 0) {
      const derived = invokingPane.slice(0, sep).trim();
      if (derived !== '') return derived;
    }
  }
  return null;
}

/**
 * Resolve (or create) the item-ID tab anchor for an interactive dispatch
 * (WL-0MUYI3JAO002BTNL, parent WL-0MUKZGEQ2007FECS, AC1/AC2/AC3/AC5).
 *
 * Wraps {@link resolveItemTabAnchor} (`getItemTabAnchor`): the tab labelled
 * exactly `itemId` inside `workspaceId` is created on first use and reused
 * thereafter (the tab label is the key; no duplicate is created). The
 * interactive path is intentionally **fail-open** — unlike the automated
 * downtime path's fail-closed placement, a resolution/creation failure
 * returns `null` so the caller falls back to the current-pane split instead
 * of dropping the operator's dispatch. Never throws.
 *
 * @param cwd - Worklog root used for the coordination directory.
 * @param workspaceId - Host workspace (see {@link resolveInteractiveWorkspaceId}).
 * @param itemId - Exact work-item ID used as the tab label.
 * @param deps - Injectable herdr deps; production builds real ones.
 * @param onCreate Optional create-vs-reuse observer forwarded to
 *   {@link resolveItemTabAnchor} (`getItemTabAnchor`): invoked only when this
 *   call provisioned the tab. The interactive dispatch path uses it to gate
 *   the fail-safe placeholder root-pane cleanup (WL-0MUYI3K8H007MPKF, AC7).
 * @returns The resolved tab anchor, or `null` on any failure/empty input.
 */
export async function resolveInteractiveItemAnchor(
  cwd: string,
  workspaceId: string,
  itemId: string,
  deps?: DispatcherAnchorDeps,
  onCreate?: (anchor: ItemTabAnchor) => void,
): Promise<ItemTabAnchor | null> {
  try {
    if (workspaceId === '' || itemId === '') return null;
    const anchorDeps =
      deps ?? createDispatcherAnchorDeps(cwd, process.env.HERDR_BIN_PATH ?? 'herdr');
    return await resolveItemTabAnchor(cwd, anchorDeps, workspaceId, itemId, onCreate);
  } catch {
    return null;
  }
}

/**
 * Liveness dependency for {@link closeInteractiveTabRootPane}: the ids of
 * panes currently hosting a TRACKED pi/shell session, or `{ok:false}` when
 * the probe cannot be answered (unknown → the caller leaves the pane open).
 *
 * Mirrors the downtime path's `getRunningDowntimePanes` result shape: only a
 * POSITIVE `{ok:true, paneIds}` excludes the anchor from cleanup.
 */
export interface InteractiveLiveTrackedPanesResult {
  ok: boolean;
  paneIds?: string[];
  error?: string;
}

/** Injectable dependencies for {@link closeInteractiveTabRootPane} (tests). */
export interface InteractiveRootPaneCleanupDeps {
  /** Live tracked pi/shell pane ids, or `{ok:false}` when unknown. */
  getLiveTrackedPanes?: (cwd: string) => Promise<InteractiveLiveTrackedPanesResult>;
  /** Close a pane; may reject (the helper swallows it). */
  closePane?: (paneId: string, cwd: string) => Promise<boolean>;
}

/**
 * Fail-safe cleanup of an interactive item tab's placeholder root pane
 * (WL-0MUYI3K8H007MPKF, parent WL-0MUKZGEQ2007FECS, AC7).
 *
 * A freshly provisioned item tab is created with herdr's initial root pane,
 * used only as the split anchor for the FIRST dispatch. Once that dispatch's
 * pane has spawned, the placeholder is closed so the tab shows only the
 * productive pane. This mirrors the downtime path's root-pane cleanup
 * (WL-0MU2EOHK900425VU) with the interactive path's fail-safe/fail-open
 * semantics:
 *
 *  - **Fail-safe:** the anchor is closed ONLY when liveness POSITIVELY
 *    confirms it is not a live tracked pi/shell pane. When the probe is
 *    absent, failed (`ok:false`), or returns an unparseable payload
 *    (no `paneIds`), the anchor is left open — a live agent/shell pane is
 *    never closed (a reused tab's anchor is a live pane and survives).
 *  - **Fail-open:** any thrown error (liveness probe or close) is swallowed;
 *    cleanup never blocks, fails, or changes the dispatch outcome.
 *
 * @param anchorPaneId The anchor pane to close, or `undefined`/empty when no
 *   item tab was provisioned (a no-op — liveness is not even probed).
 * @param ctx The worklog root (`cwd`) the resolver/close operations run in.
 * @param deps Injectable liveness + close dependencies.
 */
export async function closeInteractiveTabRootPane(
  anchorPaneId: string | undefined,
  ctx: { cwd: string },
  deps: InteractiveRootPaneCleanupDeps,
): Promise<void> {
  try {
    if (typeof anchorPaneId !== 'string' || anchorPaneId === '') return;
    if (typeof deps.getLiveTrackedPanes !== 'function') return;
    // Only a POSITIVE liveness answer may authorise a close; anything else
    // (absent dep, ok:false, thrown probe, missing paneIds) leaves it open.
    let liveIds: string[] | null = null;
    try {
      const result = await deps.getLiveTrackedPanes(ctx.cwd);
      if (result && result.ok === true && Array.isArray(result.paneIds)) {
        liveIds = result.paneIds;
      }
    } catch {
      liveIds = null; // fail-safe: unknown liveness → leave open
    }
    if (liveIds === null) return;
    if (liveIds.includes(anchorPaneId)) return; // live tracked pane → leave open
    if (typeof deps.closePane === 'function') {
      await deps.closePane(anchorPaneId, ctx.cwd);
    }
  } catch {
    // fail-open: root-pane cleanup must never block or fail the dispatch
  }
}

/**
 * Default interactive liveness resolver (AC7): the ids of panes currently
 * hosting a TRACKED pi/shell session, derived from `herdr pane list`.
 *
 * A pane is a live tracked pane when it hosts a live pi agent (`agent`
 * present, status not terminal) OR its label marks a shell-command pane
 * (`Shell: …`, set by `run-in-pane.sh` via `buildShellPaneTitle`). A freshly
 * provisioned item tab's placeholder root pane hosts neither, so it is
 * excluded and may be closed; a reused tab's anchor is a live pi/shell pane
 * and is included, so it is never closed.
 *
 * Fail-safe: any herdr failure (missing binary, timeout, unparseable output)
 * resolves `{ok:false}` — the caller then leaves the anchor open rather than
 * risk closing a live pane on unknown state.
 */
export async function defaultInteractiveLiveTrackedPanesResolver(
  _cwd: string,
): Promise<InteractiveLiveTrackedPanesResult> {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
    const { stdout } = await getExecFileAsync()(
      herdrBin,
      ['pane', 'list'],
      { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    const panes = parseHerdrPaneListOutput(stdout);
    if (panes === null) return { ok: false, error: 'herdr pane list parse failure' };
    const paneIds = panes.filter(isLiveTrackedPane).map((p) => p.paneId);
    return { ok: true, paneIds };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * True when a parsed `herdr pane list` record is a live tracked pi/shell
 * pane (see {@link defaultInteractiveLiveTrackedPanesResolver}). A bare
 * placeholder root pane (no agent, no shell-command label) is NOT tracked.
 */
function isLiveTrackedPane(rec: HerdrPaneRecord): boolean {
  const status = (rec.agentStatus ?? '').toLowerCase();
  const agentLive =
    typeof rec.agent === 'string' &&
    rec.agent !== '' &&
    status !== 'done' &&
    status !== 'exited';
  const shellLive = typeof rec.label === 'string' && rec.label.startsWith('Shell: ');
  return agentLive || shellLive;
}

/**
 * Default interactive pane-close dependency (AC7): `herdr pane close
 * <paneId>`. Fail-open at the caller — a failure resolves `false` and is
 * swallowed by {@link closeInteractiveTabRootPane}.
 */
export async function defaultInteractiveClosePane(
  paneId: string,
  _cwd: string,
): Promise<boolean> {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
    await getExecFileAsync()(herdrBin, ['pane', 'close', paneId], {
      encoding: 'utf8',
      timeout: DOWNTIME_WL_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false; // fail-open: a failed close never throws
  }
}
