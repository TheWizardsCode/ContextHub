/**
 * packages/herdr/src/dispatcher-anchor.ts — Dispatcher anchors and
 * project-workspace resolution (re-export barrel).
 *
 * The three placement strategies, in `dispatchClaimedTier` precedence order
 * (WL-0MUR5FUWD00024XN), each implemented by a sibling module:
 *
 * 1. **Project workspace + item-ID tab (primary)** — `resolveProjectWorkspace`
 *    maps a worklog root to the herdr plugin pane (`label == "Work Items"`)
 *    whose logical project root equals it; `getItemTabAnchor` finds-or-creates
 *    the tab labelled with the exact work-item id inside it and returns the
 *    root pane. `dispatcher-anchor.placement.ts`.
 * 2. **Per-prefix tab inside the Dispatcher workspace (fallback)** —
 *    `getDispatcherTabAnchor(prefix)` resolves or creates a tab labelled with
 *    the work-item id prefix (`WL`, `TCE`, …) in the machine-wide Dispatcher
 *    workspace (WL-0MTRQT482001SNXC). `dispatcher-anchor.tab-anchors.ts`.
 * 3. **Machine-wide Dispatcher fallback (retained)** — `getDispatcherAnchor`
 *    provisions one dedicated Dispatcher workspace with a persisted anchor
 *    pane, used only when neither resolver above yields an anchor and by
 *    scheduled prompts (no work-item id). `dispatcher-anchor.tab-anchors.ts`.
 *
 * Supporting modules (WL-0MVGKHCP9005SJPZ): constants/types
 * `dispatcher-anchor.contract.ts`; `herdr` output parsers
 * `dispatcher-anchor.cli-parsers.ts`; subprocess helpers and deps factory
 * `dispatcher-anchor.herdr-cli.ts`; anchor/tab-anchor persistence
 * `dispatcher-anchor.persistence.ts`. Consumers keep importing
 * `./dispatcher-anchor.js`.
 */

export {
  DISPATCHER_ANCHOR_FILE,
  DISPATCHER_WORKSPACE_LABEL,
  PLUGIN_PANE_LABEL,
  DISPATCHER_ROOT_TAB_LABEL,
  DISPATCHER_TAB_ANCHORS_FILE,
} from './dispatcher-anchor.contract.js';
export type {
  DispatcherAnchor, DispatcherAnchorDeps, DispatcherPaneInfo,
  DispatcherPrefixTabAnchor, DispatcherTabAnchors, DispatcherTabInfo,
  ItemTabAnchor, MachinePaneInfo, PaneProcessInfo, ProjectWorkspaceTarget,
} from './dispatcher-anchor.contract.js';

export {
  parseTabListOutput, parseTabCreateOutput, parsePaneListOutput,
  parseMachinePaneListOutput, parsePaneProcessInfoOutput, parseProcEnviron,
} from './dispatcher-anchor.cli-parsers.js';
export {
  createDispatcherAnchorDeps, listMachinePanes, getPaneProcessInfo,
  readProcEnvironFile, listTabsInWorkspace, listPanesInWorkspace,
  createTabInWorkspace,
} from './dispatcher-anchor.herdr-cli.js';

export {
  getDispatcherAnchor, getDispatcherTabAnchor,
} from './dispatcher-anchor.tab-anchors.js';
export {
  resolveProjectWorkspace, getItemTabAnchor,
} from './dispatcher-anchor.placement.js';
