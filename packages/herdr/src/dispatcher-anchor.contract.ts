/**
 * packages/herdr/src/dispatcher-anchor.contract.ts — dispatcher-anchor
 * constants and shared type declarations (the split's leaf module).
 *
 * Extracted verbatim from `dispatcher-anchor.ts` by WL-0MW0JH8OM004UOHU
 * (parent WL-0MVGKHCP9005SJPZ) so parsers, herdr CLI helpers, persistence and
 * the anchor resolvers can depend on a stable leaf instead of on the
 * 1,333-line monolith.
 *
 * Pure declarations: no logic, no imports, no module-scope mutable state — so
 * this module cannot participate in an import cycle. The barrel
 * (`dispatcher-anchor.ts`) re-exports every symbol declared here, which keeps
 * the public surface and every consumer import unchanged.
 */

// ── Constants ──────────────────────────────────────────────────────────

export const DISPATCHER_ANCHOR_FILE = 'downtime-dispatch-anchor.json';
export const DISPATCHER_WORKSPACE_LABEL = 'Dispatcher';
/**
 * Tab label of the herdr worklog plugin pane (from `herdr-plugin.toml`).
 * Project workspaces are discovered by enumerating machine-wide panes with
 * this exact label and reading each one's logical project root (AC1/AC3).
 */
export const PLUGIN_PANE_LABEL = 'Work Items';
/**
 * Label of the tab that adopts the workspace's initial root pane
 * (WL-0MU2EOHK900425VU) so it is never left blank/unused. The root pane is
 * the split anchor for scheduled-prompt dispatches, so keeping it alive in a
 * labelled tab preserves `send-to-pi.sh --anchor <paneId>` semantics.
 */
export const DISPATCHER_ROOT_TAB_LABEL = 'Downtime';

/**
 * Filename for the per-prefix tab-anchors persistence map
 * (C1, parent WL-0MTRQT482001SNXC). Stored in the machine coordination dir
 * alongside the legacy single-anchor file.
 */
export const DISPATCHER_TAB_ANCHORS_FILE = 'downtime-dispatch-tab-anchors.json';

// ── Types ──────────────────────────────────────────────────────────────

export interface DispatcherAnchor {
  paneId: string;
  workspaceId: string;
}

/**
 * Per-prefix tab-anchors map — keyed by work-item id prefix (e.g. `WL`, `TCE`)
 * so every dispatch for the same prefix reuses the same tab in the Dispatcher
 * workspace (C1, parent WL-0MTRQT482001SNXC).
 */
export interface DispatcherTabAnchors {
  /** Machine-wide Dispatcher workspace id (shared with the legacy single anchor). */
  workspaceId: string;
  /** Prefix → { tabId, paneId } map — one tab per project prefix. */
  byPrefix: Record<string, { tabId: string; paneId: string }>;
}

/**
 * A prefix-aware tab anchor: the Dispatcher workspace id plus the tab and
 * pane for a specific project prefix (e.g. `WL` → `w13:t5` → `w13:p23`).
 */
export interface DispatcherPrefixTabAnchor {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface DispatcherAnchorDeps {
  /** Create a workspace. Resolves to { workspaceId, paneId } or throws. */
  createWorkspace(label: string): Promise<{ workspaceId: string; paneId: string }>;
  /**
   * Move `paneId` into a new tab labelled `label`. Returns true on success,
   * false on CLI failure (the raw error is logged). Used to adopt the
   * workspace's initial root pane so it is never left blank
   * (WL-0MU2EOHK900425VU). Optional; when absent, adoption is skipped and the
   * pre-fix layout is retained (legacy/test callers).
   */
  movePaneToNewTab?(paneId: string, label: string): Promise<boolean>;
  /** True when the pane for `paneId` is alive (RPC pane.get succeeds). */
  isPaneAlive(paneId: string): Promise<boolean>;
  /**
   * List tabs in a workspace (optional; production supplies it). Returns
   * `null` on CLI/parse failure so a caller can fail closed.
   */
  listTabs?(workspaceId: string): Promise<DispatcherTabInfo[] | null>;
  /**
   * Create a tab labelled `label` and return its `{ tabId, paneId }`, or
   * `null` on failure (optional; production supplies it).
   */
  createTab?(workspaceId: string, label: string): Promise<ItemTabAnchor | null>;
  /**
   * List live panes in a workspace as `{ paneId, tabId }` (optional;
   * production supplies it). Returns `null` on CLI/parse failure.
   */
  listPanes?(workspaceId: string): Promise<DispatcherPaneInfo[] | null>;
  /**
   * Machine-wide `herdr pane list` records (project-workspace resolution).
   * `null` on CLI/parse failure → the resolver fails closed (AC3). Optional;
   * production supplies it.
   */
  listMachinePanes?(): Promise<MachinePaneInfo[] | null>;
  /**
   * `herdr pane process-info --pane <id>` → `{ shellPid }`, or `null` on any
   * CLI/parse failure or missing `shell_pid` (fail-closed, AC3). Optional;
   * production supplies it.
   */
  getPaneProcessInfo?(paneId: string): Promise<PaneProcessInfo | null>;
  /**
   * Read `/proc/<shellPid>/environ` (null-delimited) or `null` when it is
   * missing/unreadable (non-Linux, dead process) — fail-closed (AC3).
   * Optional; production supplies it.
   */
  readProcEnviron?(shellPid: string): Promise<string | null>;
}

/** One parsed `herdr tab list` record (id + label, plus agent liveness). */
export interface DispatcherTabInfo {
  tabId: string;
  label: string;
  /** Raw `agent_status` from the tab record, when herdr reports it. */
  agentStatus?: string;
}

/** One parsed workspace-scoped `herdr pane list` record (tab routing). */
export interface DispatcherPaneInfo {
  paneId: string;
  tabId: string;
}

/** One parsed machine-wide `herdr pane list` record (project-workspace resolution). */
export interface MachinePaneInfo {
  paneId: string;
  workspaceId: string;
  tabId: string;
  label?: string;
  /** True when the pane is focused in its workspace (AC3 ambiguity rule). */
  focused: boolean;
}

/** `herdr pane process-info` result — the pane's shell process id. */
export interface PaneProcessInfo {
  shellPid: string;
}

/** A resolved tab anchor: the tab's id and its root (anchor) pane id. */
export interface ItemTabAnchor {
  tabId: string;
  paneId: string;
}

/** Resolved project workspace hosting the plugin pane for a worklog root (AC1/AC3). */
export interface ProjectWorkspaceTarget {
  paneId: string;
  workspaceId: string;
  tabId: string;
}
