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
 * Family-local vocabulary naming the failing boundary of an
 * `anchor-unavailable` placement refusal (WL-0MWHCUZ5C000I7S6, parent
 * WL-0MWH50EN4007C6YH AC6): where exactly the anchor resolution failed
 * closed, so the `no-dispatch` decision entry is diagnosable from the log
 * alone (the reported incident showed 124 identical `anchor-unavailable`
 * entries with no way to tell a vanished workspace from a broken CLI).
 *
 * Deliberately **not** re-exported by the `dispatcher-anchor.js` barrel
 * (the split guard freezes the barrel at 38 exports) and **not** imported by
 * consumers: the dispatch side (`downtime-worker.dispatch-placement.ts` and
 * the deps contracts) declares a structurally identical string-literal
 * union, and TypeScript's structural typing makes them assignable wherever
 * they meet. Additive by design: the sibling mismatch item extends the union
 * with `project-workspace-mismatch`.
 *
 * - `persisted-workspace-missing` — the persisted Dispatcher workspace id
 *   is POSITIVELY absent from a successfully read `herdr workspace list`
 *   (probe verdict `missing`); recoverable via the re-provision path, so a
 *   successful recovery never leaves a detail behind.
 * - `herdr-unreadable` — the herdr CLI could not be read (probe `unreadable`,
 *   an unparseable/empty `tab list`/`pane list`, a throwing aliveness probe):
 *   fail closed, nothing provisioned (missing ≠ unreadable).
 * - `dispatcher-workspace-unprovisionable` — the replacement Dispatcher
 *   workspace (or its persistence) could not be provisioned, including the
 *   positively-missing-plus-unrecoverable case and any per-prefix
 *   provisioning failure.
 * - `prefix-empty` — no extractable work-item id prefix to route by.
 * - `item-tab-unavailable` — a resolved project workspace's item-ID tab
 *   could not be provisioned (the primary placement path).
 */
export type PlacementFailureDetail =
  | 'persisted-workspace-missing'
  | 'herdr-unreadable'
  | 'dispatcher-workspace-unprovisionable'
  | 'prefix-empty'
  | 'item-tab-unavailable';

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

export type PlacementMode = 'right' | 'left-of-extensions';

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
  /**
   * Move a tab within a workspace to a specific insert index using the herdr
   * socket API (`tab.move` with `insert_index`). Returns true on success,
   * false on CLI/socket failure — never throws. Used for left-of-extensions
   * placement of interactive dispatches (WL-0MVZ88G51004IYHW). Optional;
   * production supplies it; absent in legacy/test callers.
   */
  moveTab?(workspaceId: string, tabId: string, insertIndex: number): Promise<boolean>;
  /**
   * Classify a persisted Dispatcher `workspaceId` as `alive`, positively
   * `missing`, or `unreadable` (WL-0MWHCUPGQ001FASL, parent
   * WL-0MWH50EN4007C6YH). `alive` when the id appears in a successfully read
   * `herdr workspace list`; `missing` only when that list was read and parsed
   * successfully and the id is absent from it; every CLI error, unparseable/
   * empty output or absent dep is `unreadable` → the caller fails closed and
   * provisions nothing. Optional; production supplies it; an absent dep is
   * treated exactly as `unreadable`, never as `missing`. Only ever consulted
   * on the recovery path — never on the healthy dispatch path.
   */
  probeWorkspace?(workspaceId: string): Promise<'alive' | 'missing' | 'unreadable'>;
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
