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
 * Module layout (WL-0MVGKHCP9005SJPZ): strategy 1 — the project-workspace
 * resolution and the item-ID tab anchor described above — lives in
 * `dispatcher-anchor.placement.ts` (child WL-0MW0JHD2N004XAOS); strategies 2
 * and 3 — the per-prefix tab routing and the machine-wide Dispatcher anchor
 * provisioning — live in `dispatcher-anchor.tab-anchors.ts` (child
 * WL-0MW0JHC92005XRT1). This barrel only re-exports their public resolvers.
 */

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

// ── Project workspace resolution and item-ID tab anchor (AC1/AC3) ──────
//
// Moved verbatim to `dispatcher-anchor.placement.ts`
// (WL-0MW0JHD2N004XAOS, parent WL-0MVGKHCP9005SJPZ) — the primary placement
// path, whose AC1/AC3 ambiguity rules and create-vs-reuse signal are now
// reviewable together. Only the two public resolvers are re-exported here, so
// the barrel's public surface is unchanged; `normalizeRoot`,
// `comparePaneIds`, `ItemTabResolution` and `resolveItemTab` stay module-local
// to that module.

export {
  resolveProjectWorkspace,
  getItemTabAnchor,
} from './dispatcher-anchor.placement.js';
