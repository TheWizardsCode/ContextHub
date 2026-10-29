/**
 * packages/herdr/src/worklist.types.ts — leaf type declarations for the
 * worklist family.
 *
 * Single responsibility: the worklist family's type-only declarations
 * (`TermSize`, `ViewMode`, `DisplayHeadingRow`, `NavigationStackEntry`,
 * `HelpIconRow`, `KeyAction`, `ChordState`, the mouse types
 * `ParsedMouseEvent`/`MouseDragState`/`MouseClickState`/`MouseAction`,
 * `NoteEditAction`, `ReviewQueueBannerState`, `PodcastNotice`, `ExecuteResult`,
 * `PodcastTargetResolution`). Leaf module: type-only, imports nothing from the
 * rest of the worklist family (parent AC4 — this is what keeps sibling modules
 * cycle-free). Moved verbatim out of `worklist.ts` (parent
 * WL-0MVGKGD2Y0038S6B; extraction WL-0MVND6DHH008R3LG). No behaviour change.
 */

export interface TermSize {
  rows: number;
  cols: number;
}

/**
 * A single entry on the navigation stack, representing a parent context
 * that the user can return to via Escape.
 */
export interface NavigationStackEntry {
  /** ID of the parent item whose context was saved. */
  parentId: string;
  /** Scroll offset at the time of push. */
  scrollOffset: number;
  /** Selected index at the time of push. */
  selectedIndex: number;
}

export type ViewMode = 'list' | 'detail' | 'filter' | 'form' | 'help';

/**
 * A group heading row in the display-rows model (WL-0MSL5MPSZ003TG94).
 *
 * Headings are first-class rows interleaved with item rows by
 * `WorkItemListState.getDisplayRows()`. They carry the group number, the
 * human-readable label, the count of top-level items in the group (current
 * view, post stage-filter) and the in-memory collapse state.
 */
export interface DisplayHeadingRow {
  kind: 'heading';
  /** Group number (1-indexed, from regroupWorkItems). */
  group: number;
  /** Human-readable group label (e.g. `Group 1`, `Idea`, `In Review`). */
  groupLabel: string;
  /** Top-level items in this group in the current view (post stage-filter). */
  count: number;
  /** Whether the group's items are hidden (in-memory, session-only). */
  collapsed: boolean;
  /** Depth indentation level (0 = top-level, 1+ = inside expanded parents). */
  depth?: number;
}

/** A note-edit operation to apply to a markdown file. */
export interface NoteEditAction {
  kind: 'insert' | 'update' | 'remove';
  /** Paragraph index (into `splitParagraphs`) for insert. */
  paragraphIndex?: number;
  /** New note body (insert/update). */
  text?: string;
  /** Marker id to update/remove. */
  noteId?: string;
  /** Mark DONE (§7.3) on update. */
  done?: boolean;
}

/** A single row in the help screen's icon legend. */
export interface HelpIconRow {
  /** Icon category (the name prefix, e.g. `status`) used to group the legend. */
  category: string;
  /** The glyph (or noIcons text fallback) as rendered in the list. */
  glyph: string;
  /** Short human-readable meaning of the glyph. */
  meaning: string;
}

export type KeyAction = 'up' | 'down' | 'pageup' | 'pagedown' | 'select'
  | 'back' | 'filter' | 'refresh' | 'quit' | 'first' | 'last'
  | 'meta-up' | 'meta-down'
  | 'chord-start' | 'chord-complete' | 'chord-cancel'
  | 'toggle-expand' | 'dismiss-tooltip' | null;

export interface ChordState {
  /** Keys pressed so far in the current chord sequence */
  pendingKeys: string[];
  /** Hints for next-expected keys and their commands */
  hints: string;
  /** The resolved command if chord was completed (cleared after execution) */
  resolvedCommand: string | null;
  /**
   * The model pattern bound to the resolved shortcut entry, if any
   * (cleared after execution). Used to spawn the pi CLI with `--model`.
   */
  resolvedModel: string | null;
  /**
   * Whether the resolved shortcut should open a visible pane
   * (WL-0MSJLD1I70045ZUL). `undefined` = the entry did not set `open_pane`
   * → open a pane (the default, backward compatible); `false` = run in the
   * background with output captured to a log file. Cleared (undefined)
   * after execution.
   */
  resolvedOpenPane: boolean | undefined;
  /**
   * Whether the resolved shortcut wants the new pane focused
   * (WL-0MT70LC6B009TL3Q). `undefined`/`false` = open without focus
   * (current default); `true` = the new pane is zoomed/focused immediately
   * after opening. Only `P n` (new session) sets this to `true` today.
   * Cleared (undefined) after execution.
   */
  resolvedFocus: boolean | undefined;
}

/**
 * A parsed SGR mouse event with 1-based terminal coordinates.
 */
export interface ParsedMouseEvent {
  /** Raw SGR button code: 0=left, 1=middle, 2=right, 64=wheel up,
   * 65=wheel down; bit 32 = motion. */
  button: number;
  /** 1-based column. */
  x: number;
  /** 1-based row. */
  y: number;
  /** True for '\x1b[<...m' (release), false for '\x1b[<...M' (press). */
  release: boolean;
}

/** State tracker for an active drag-to-scroll gesture.  Tracks the press
 * origin, a fractional accumulator for proportional scrolling, and the
 * pre-press selection/scroll so the drag can restore them when it
 * activates — ensuring a drag never leaves the selection moved by the
 * initial press.  (WL-0MSI72S0Y0060BRK) */
export interface MouseDragState {
  /** Origin of the press (x, y) or null when no drag is active. */
  origin: { x: number; y: number } | null;
  /** Fractional row/line accumulator — integer parts are dispatched as
   * discrete scroll deltas. */
  accumulator: number;
  /** True when the drag has crossed the threshold and is actively
   * scrolling. */
  active: boolean;
  /** Snapshot of selectedIndex and scrollOffset taken at press time, used
   * to restore state when the drag activates so the drag never leaves the
   * selection moved by the initial press. */
  prePressSelection: { selectedIndex: number; scrollOffset: number } | null;
  /** True once the pre-press selection has been restored for this drag
   * gesture — the restore happens exactly once, on the first threshold-
   * crossing motion; subsequent drag events accumulate scroll on top of
   * the restored state. */
  restored: boolean;
}

/** Prior left-press coordinates plus an injectable clock for deterministic
 * double-click tests. */
export interface MouseClickState {
  /** The previous left-press position/time, or null when none. */
  lastClick: { x: number; y: number; at: number } | null;
  /** Current clock (ms) — injected for deterministic tests. */
  now: number;
}

/** Internal drag bookkeeping action — emitted on the first press and
 * never dispatched to the state switch (it triggers state capture only).
 * (WL-0MSI72S0Y0060BRK) */
type DragAction =
  | { type: 'drag-start' }
  | { type: 'drag-list'; rows: number }
  | { type: 'drag-detail'; lines: number };

/** Dispatchable mouse action — mirrors the list/detail/filter key paths.
 * Drag actions are emitted by `mapMouseDrag` and dispatched by
 * `handleMouseInput`; the drag consumer never emits `select-row` /
 * `open-detail`, so a drag-release can never click.  (WL-0MSI72S0Y0060BRK) */
export type MouseAction =
  | { type: 'select-row'; index: number } // list: click/tap an item row
  | { type: 'open-detail' } // list: double-click (Enter-equivalent)
  | { type: 'back' } // detail: double-click (to the list)
  | { type: 'wheel-up' } // list: wheel/touch-scroll up
  | { type: 'wheel-down' } // list: wheel/touch-scroll down
  | { type: 'scroll-detail-up' } // detail: wheel up (k-equivalent)
  | { type: 'scroll-detail-down' } // detail: wheel down (j-equivalent)
  | { type: 'filter-stage'; index: number } // filter: tap a stage option
  | { type: 'hover-row'; index: number } // list: motion over an item row (tooltip)
  | { type: 'hover-none' } // list: motion over chrome rows (pointer left the rows)
  | DragAction // internal drag actions (drag-start, drag-list, drag-detail)
  | null; // inert: chrome rows, motion, releases, unknown buttons

/**
 * Review-queue banner state for the footer (parent WL-0MTHSHN5V008R5L0).
 */
export interface ReviewQueueBannerState {
  /** True when the root-only completed/in_review count ≥ browseItemCount. */
  queueDeep: boolean;
  /** Number of root-level completed/in_review items counted. */
  completedCount: number;
  /** browseItemCount threshold (undefined when the setting is unavailable). */
  browseItemCount?: number;
  /** True when at least one root in_review item has an outstanding audit. */
  auditsOutstanding: boolean;
}

/**
 * Outcome of a podcast w-chord dispatch attempt, surfaced to the operator.
 *
 * - `dispatched` — the command resolved and was sent to a Pi agent pane.
 * - `error` — `resolvePodcastTarget` refused to resolve the command (e.g. no
 *   script in `Key Files:`, or the belt-and-braces "never author a duplicate"
 *   guard). Nothing was dispatched.
 */
export interface PodcastNotice {
  kind: 'dispatched' | 'error';
  body: string;
}

export type ExecuteResult = 'dispatched' | 'callback' | 'noop' | 'blocked';

/**
 * Result of resolving a podcast-progression command marker for the selected
 * work item. Either a fully-resolved command (no markers remain) or an
 * error message that must be surfaced WITHOUT dispatching (OSL-0MSHFQ51L009IUOS
 * belt-and-braces guard).
 */
export interface PodcastTargetResolution {
  command?: string;
  error?: string;
}
