/**
 * packages/herdr/src/worklist.ts — Core work item list UI logic
 *
 * Provides the state model, rendering, and keyboard handling for the
 * Herdr work item selection list. This module is platform-independent
 * and has NO direct Herdr socket API dependency — it operates purely
 * on in-memory data and produces formatted string output.
 *
 * The design is inspired by the Pi TUI browse.ts but simplified for
 * Herdr's pane-based model.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { fetchChildrenForItem, fetchActionableCount, fetchItemsByStage, fetchItemsByPriority, getWorklogDir, type WorkItem } from './fetcher.js';
import { isPaneVisible, PollGate, DEFAULT_POLL_GATE_TTL_MS } from './visibility.js';
import { isAgentCommand } from './pane-title.js';
import { HerdrEventSubscriber } from './events.js';
import { AgentTracker, mergeAgentStatesCached } from './agent-tracker.js';
import { readCodeFreezeState, readCodeFreezeStatus } from './code-freeze.js';
import type { ShortcutRegistry, ShortcutEntry } from './shortcut-config.js';
import {
  statusIcon,
  stageIcon,
  priorityIcon,
  epicIcon,
  riskIcon,
  effortIcon,
  auditIcon,
  needsProducerReviewIcon,
  stageDisplayIcon,
  getIconPrefix,
  applyStageColour,
  stageColor,
  type IconOptions,
} from '@worklog/shared/icons';
import {
  runSync,
  heartbeatTtlForInterval,
  isSyncHeartbeatFresh,
} from './auto-sync.js';
import { TaskScheduler, DEFAULT_SCHEDULER_TICK_MS } from './scheduler.js';
import { loadSettings } from './settings.js';
import { DbChangeTracker, resolveCacheDir } from './db-change.js';
import { DEFAULT_DOWNTIME_POLL_INTERVAL_MS, DOWNTIME_RUN_TIMEOUT_MS, type DowntimeWorker } from './downtime-worker.js';
import { type ModeSwitchWorker, DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS, MODE_SWITCH_RUN_TIMEOUT_MS } from './mode-switch-worker.js';
import { showToast } from './notify.js';
import { recordCommand, getLastCommand } from './command-log.js';
import {
  hasUnknownIdentifiers,
  getUnknownIdentifiers,
  FormState,
  substituteIdentifiers,
} from './form-dialog.js';
import { readFromClipboard, writeToClipboard } from './clipboard.js';
import { ShipItDialogState, overlayShipItDialog } from './ship-it-dialog.js';
import { extractFilePaths } from './grouping.js';
import { renderMarkdown, renderMarkdownViewer } from './md-viewer.js';
import {
  findNoteInParagraph,
  insertNoteMarker,
  updateNoteMarker,
  removeNoteMarker,
  splitParagraphs,
  mapCursorToParagraph,
  mapParagraphToMarker,
  addNoteWithSync,
  resolveNoteWithSync,
  type NoteEditResult,
} from './md-note-edit.js';

// ── Constants ─────────────────────────────────────────────────────────

/**
 * The dev→main release command dispatched by the Ship It shortcut (`S`,
 * WL-0MSGG5N5Z0074TLY). Global release — receives NO work item id. The
 * command must be typed as `ship` + Enter in the confirmation dialog
 * before it is dispatched via the standard command-routing path.
 */
export const SHIP_IT_COMMAND = '/skill:ship release';

export const STAGES = [
  'idea',
  'intake_complete',
  'plan_complete',
  'in_progress',
  'in_review',
  'completed',
] as const;

export type Stage = (typeof STAGES)[number];

// ── /wl <stage> argument map (WL-0MSDT8X1V003206G) ────────────────────
// Maps every accepted /wl stage argument — shorthand aliases and canonical
// stage names — to the internal stage name used for filtering. Matches the
// Pi TUI extension's STAGE_MAP so `/wl <stage>` behaviour is identical.
export const STAGE_MAP: Record<string, string> = {
  intake: 'intake_complete',
  plan: 'plan_complete',
  progress: 'in_progress',
  review: 'in_review',
  // Canonical names mapped to themselves for validation
  idea: 'idea',
  intake_complete: 'intake_complete',
  plan_complete: 'plan_complete',
  in_progress: 'in_progress',
  in_review: 'in_review',
};

// ── /wl --priority <priority> map (WL-0MSKC8T46006999S) ────────────────
// Canonical priority names accepted by `/wl --priority <p>` and the
// `f p *` priority-filter chords. Invalid/unknown values fall back
// gracefully (no crash, no filter change), matching `/wl <bogus>`.
export const PRIORITY_MAP: Record<string, string> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

// Re-export stage colors from icons for backward compatibility
export const STAGE_COLORS: Record<string, number> = {
  idea: 247,
  intake_complete: 68,
  plan_complete: 172,
  in_progress: 76,
  in_review: 220,
  completed: 33,
};

// ── Metadata panel sizing ───────────────────────────────────────────────
// The list renderer shows the selected item's metadata in a panel below the
// list. The list takes as much vertical space as its content needs (up to
// the full pane height) and the panel fills the remainder, keeping a small
// minimum — see computeDynamicLayout (WL-0MSQ44MDX008U69J).
// computeMetadataPanelHeight below is retained as a legacy fallback (used by
// metaScrollDown when no dynamic panel height is supplied) from the original
// fixed 20–40% reservation (WL-0MSAYNVBY006LM9X).

/** Minimum share of pane rows reserved for the metadata panel (small panes). */
export const MIN_META_SHARE = 0.2;
/** Maximum share of pane rows reserved for the metadata panel (tall panes). */
export const MAX_META_SHARE = 0.4;

/** Pane height (rows) at which the panel uses the minimum share. */
const META_SHARE_MIN_ROWS = 12;
/** Pane height (rows) at which the panel reaches the maximum share. */
const META_SHARE_MAX_ROWS = 40;

/**
 * Legacy fallback: compute a fixed metadata panel height from the pane rows.
 *
 * The share ramps linearly from MIN_META_SHARE at `META_SHARE_MIN_ROWS` to
 * MAX_META_SHARE at `META_SHARE_MAX_ROWS`. The result is clamped to a
 * minimum of 3 rows. Only used by metaScrollDown when no dynamic panel
 * height is provided; the renderer uses computeDynamicLayout instead.
 *
 * @param rows - Total pane height in rows.
 * @returns Number of panel rows (always < rows).
 */
export function computeMetadataPanelHeight(rows: number): number {
  let share = MIN_META_SHARE;
  if (rows > META_SHARE_MIN_ROWS) {
    const t = Math.min(1, (rows - META_SHARE_MIN_ROWS) / (META_SHARE_MAX_ROWS - META_SHARE_MIN_ROWS));
    share = MIN_META_SHARE + (MAX_META_SHARE - MIN_META_SHARE) * t;
  }
  return Math.max(3, Math.min(Math.round(rows * share), Math.floor(rows * MAX_META_SHARE)));
}

/**
 * Compute the dynamic list / metadata panel layout (WL-0MSQ44MDX008U69J).
 *
 * The selection list takes as much vertical space as its content needs, up to
 * the maximum available (pane rows minus the reserved notification row and the
 * metadata panel's minimum height).  The metadata panel fills whatever space
 * remains, expanding when the list is short.
 *
 * This function is called both by the renderer (createListRenderer) and by
 * the main TUI loop (to pass the panel height into metaScrollDown for
 * correct clamping).
 *
 * The display-rows model (WL-0MSL5MPSZ003TG94) passes `DisplayRow[]` —
 * heading rows are first-class rows already counted in the window, so no
 * extra separator accounting is needed.
 *
 * @param rows - Display rows (headings + items) to display.
 * @param scrollOffset - Current scroll offset into the display rows.
 * @param bannerCount - Number of code-freeze banner rows.
 * @param termSize - Terminal size.
 * @returns The metadata panel height, the list area, and the list height.
 */
export function computeDynamicLayout(
  rows: DisplayRow[],
  scrollOffset: number,
  bannerCount: number,
  termSize: TermSize,
): { panelHeight: number; listArea: number; listHeight: number } {
  const { rows: termRows } = termSize;
  const minMeta = 3;
  const chromeLines = 2 + bannerCount; // header + banners + footer

  // Estimate the visible window with metadata at its minimum so the estimate
  // reflects the list's true space need. Heading rows are already part of the
  // window — no separate separator count.
  const estListHeight = Math.max(3, termRows - 4 - minMeta);
  const estVisible = rows.slice(scrollOffset, scrollOffset + estListHeight);
  const estHasTopIndicator = scrollOffset > 0;
  const estHasBottomIndicator = scrollOffset + estVisible.length < rows.length;
  const estIndicatorRows = (estHasTopIndicator ? 1 : 0) + (estHasBottomIndicator ? 1 : 0);
  const contentNeed = estIndicatorRows + estVisible.length;

  const panelHeight = Math.max(minMeta, Math.max(0, termRows - 1 - contentNeed - chromeLines));
  const listArea = Math.max(1, termRows - 1 - panelHeight);
  // The initial visible window is the maximum possible (metadata at its
  // minimum); the caller's trimming logic reduces it to fit the actual
  // budget (fold indicators). This keeps the window generous so
  // a short list is never truncated just because the metadata panel expanded.
  const listHeight = Math.max(3, termRows - 4 - minMeta);
  return { panelHeight, listArea, listHeight };
}

// ── Terminal helpers ─────────────────────────────────────────────────

export interface TermSize {
  rows: number;
  cols: number;
}

/**
 * Get current terminal size. Falls back to defaults.
 */
export function getTermSize(): TermSize {
  try {
    // Prefer process.stdout.columns/rows (reflects actual terminal size dynamically)
    if (process.stdout.columns && process.stdout.rows) {
      return { rows: process.stdout.rows, cols: process.stdout.columns };
    }
    // Fallback to env vars
    const rows = parseInt(process.env.LINES || '', 10) || 24;
    const cols = parseInt(process.env.COLUMNS || '', 10) || 80;
    return { rows, cols };
  } catch {
    return { rows: 24, cols: 80 };
  }
}

/**
 * ANSI escape code helpers.
 */
export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reverse: '\x1b[7m',
  underline: '\x1b[4m',
  yellow: '\x1b[33m',
  clear: '\x1b[2J',
  clearLine: '\x1b[2K',
  cursorHome: '\x1b[H',
  cursorUp: (n: number) => `\x1b[${n}A`,
  cursorDown: (n: number) => `\x1b[${n}B`,
  cursorCol: (n: number) => `\x1b[${n}G`,
  fg: (code: number) => `\x1b[38;5;${code}m`,
  bg: (code: number) => `\x1b[48;5;${code}m`,
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  scrollRegion: (top: number, bottom: number) => `\x1b[${top};${bottom}r`,
  // SGR mouse tracking (WL-0MSGHM5BQ0096BNJ AC1): enable/disable sequences
  // for button-event (1000), button-event-motion (1002) and SGR-encoded
  // (1006) reporting, emitted on raw-mode entry / cleanup respectively.
  mouseEnable: '\x1b[?1000h\x1b[?1002h\x1b[?1006h',
  mouseDisable: '\x1b[?1000l\x1b[?1002l\x1b[?1006l',
};

// ── Navigation Stack ──────────────────────────────────────────────────

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

/**
 * A LIFO stack that tracks navigation history for hierarchical browsing.
 * Each entry captures the parent's scroll position and selection so they
 * can be restored when the user navigates back via Escape.
 */
export class NavigationStack {
  private stack: NavigationStackEntry[] = [];

  /**
   * Push a new entry onto the stack.
   */
  push(entry: NavigationStackEntry): void {
    this.stack.push(entry);
  }

  /**
   * Pop and return the top entry, or undefined if the stack is empty.
   */
  pop(): NavigationStackEntry | undefined {
    return this.stack.pop();
  }

  /**
   * Return the top entry without removing it, or undefined if empty.
   */
  peek(): NavigationStackEntry | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
  }

  /**
   * Remove all entries from the stack.
   */
  clear(): void {
    this.stack = [];
  }

  /**
   * Remove the topmost entry whose parentId matches, if any.
   * Used when collapsing a parent: the saved context for that parent is no
   * longer reachable, so keeping it would make a later Escape pop into a
   * collapsed parent.
   */
  removeForParent(parentId: string): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].parentId === parentId) {
        this.stack.splice(i, 1);
        return;
      }
    }
  }

  /** Current depth of the navigation stack. */
  get depth(): number {
    return this.stack.length;
  }

  /** Whether the navigation stack is empty (at root level). */
  get isEmpty(): boolean {
    return this.stack.length === 0;
  }
}

// ── State ─────────────────────────────────────────────────────────────

export type ViewMode = 'list' | 'detail' | 'filter' | 'form';

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
}

/**
 * A single row in the display-rows model: either a group heading or a work
 * item (children of expanded parents included). Navigation, clamping and
 * scrolling operate over these rows so the cursor can land on headings.
 */
export type DisplayRow = DisplayHeadingRow | WorkItem;

/**
 * Type guard: is this display row a group heading row?
 */
export function isHeadingRow(row: DisplayRow): row is DisplayHeadingRow {
  return 'kind' in row && row.kind === 'heading';
}

/**
 * Mutable state for the work item list UI.
 */
export class WorkItemListState {
  /** All loaded work items (unfiltered). */
  private _allItems: WorkItem[];

  /** Currently visible items (after filtering). */
  items: WorkItem[];

  /** Currently selected index within `items`. */
  selectedIndex = 0;

  /**
   * Set selected index with clamping and scroll adjustment.
   * Uses flattened item count for clamping when hierarchy active.
   */
  setSelectedIndex(index: number): void {
    this.selectedIndex = index;
    this._clampSelection();
    this._adjustScroll();
    this._resetMetaScroll();
    // Cache is keyed by item ID; a new selection means a new item's preview
    // will be needed — invalidate the previous item's cached preview.
    clearDescriptionPreviewCache();
  }

  /** Number of rows in the display-rows model (headings + items). */
  get flatCount(): number {
    return this.getDisplayRows().length;
  }

  /**
   * Clamp using the flattened item count when a filter/hierarchy is active
   * (called automatically from navigation methods).
   */
  private _clampFlat(): void {
    const total = this.flatCount;
    if (total === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= total) {
      this.selectedIndex = total - 1;
    } else if (this.selectedIndex < 0) {
      this.selectedIndex = 0;
    }
  }

  /** Vertical scroll offset for the list display. */
  scrollOffset = 0;

  /** Current view mode. */
  mode: ViewMode = 'list';

  /** Currently displayed detail item (when mode === 'detail'). */
  detailItem: WorkItem | null = null;

  /** Active stage filter (null = no stage filter). */
  activeFilter: string | null = null;

  /**
   * Active priority filter (null = no priority filter). Mutually exclusive
   * with `activeFilter` (replace semantics, WL-0MSKC8T46006999S): applying
   * a priority filter clears the stage filter and vice versa, and sprint
   * clears both. Only one axis can be active at a time.
   */
  activePriorityFilter: string | null = null;

  /**
   * Display label for the active filter, axis-qualified, or null when no
   * filter is active (e.g. `stage in_review`, `priority critical`). The
   * list header renders `(filtered: <label>)` from this value.
   */
  get activeFilterLabel(): string | null {
    if (this.activeFilter) return `stage ${this.activeFilter}`;
    if (this.activePriorityFilter) return `priority ${this.activePriorityFilter}`;
    return null;
  }

  /** Scroll offset within the detail view. */
  detailScrollOffset = 0;

  /** Selected Related Docs ToC entry (detail mode, 0-based). */
  detailToCIndex = 0;

  /**
   * Keyboard focus in the detail view: true = ToC navigation, false =
   * document scroll region (WL-0MSHWHULZ001FL8I).
   */
  detailToCFocus = true;

  /**
   * Which Key File's content is rendered in the md viewer (default 0 =
   * first file, auto-render preserved). Enter on a ToC entry sets this to
   * detailToCIndex.
   */
  detailRenderedIndex = 0;

  /**
   * Paragraph cursor in the md viewer (WL-0MSKV6SKK008MMXR): the index
   * (into `splitParagraphs` of the rendered file) that note-edit chords
   * operate on. Defaults to the first paragraph; the viewer integration
   * moves it as the user scrolls the document region.
   */
  detailNoteCursor = 0;

  /**
   * Scroll offset within the metadata panel. Reset to 0 whenever the
   * selection changes so a stale position from a previous item never
   * leaves the panel blank (WL-0MSAYNVBY006LM9X-FT4).
   */
  metaScrollOffset = 0;

  /** Set of expanded item IDs (for hierarchical display). */
  expandedItems: Set<string> = new Set();

  /**
   * In-memory set of collapsed group numbers (WL-0MSL5MPSZ003TG94).
   *
   * When a group is collapsed its items are hidden from both the render and
   * navigation.  Collapsed state survives list refreshes (keyed by group
   * number, mirroring `expandedItems` handling) and does NOT persist across
   * pane restarts.
   */
  collapsedGroups: Set<number> = new Set();

  /** Navigation stack for hierarchical browsing (push/pop parent contexts). */
  navigationStack: NavigationStack = new NavigationStack();

  // ── Hover tooltip state (WL-0MT9XRZDK006GMUH) ──────────────────────
  /** Display-row index of the currently hovered row (null = no hover). */
  hoveredRowIndex: number | null = null;

  /** True when the user pressed Esc to dismiss the tooltip (blocks auto-show until mouse leaves/re-enters). */
  tooltipDismissed: boolean = false;

  /** Terminal size for layout calculations. */
  termSize: TermSize;

  constructor(items: WorkItem[], termSize: TermSize) {
    this._allItems = [...items];
    this.items = [...items];
    this.termSize = termSize;
    this._clampSelection();
  }

  // ── Navigation ──────────────────────────────────────────────────

  moveUp(): void {
    if (this.flatCount === 0) return;
    if (this.selectedIndex > 0) {
      this.selectedIndex -= 1;
    } else {
      this.selectedIndex = this.flatCount - 1; // wrap to last
    }
    this._adjustScroll();
    this._resetMetaScroll();
  }

  moveDown(): void {
    if (this.flatCount === 0) return;
    if (this.selectedIndex < this.flatCount - 1) {
      this.selectedIndex += 1;
    } else {
      this.selectedIndex = 0; // wrap to first
    }
    this._adjustScroll();
    this._resetMetaScroll();
  }

  pageUp(): void {
    const pageSize = this._listHeight();
    this.selectedIndex = Math.max(0, this.selectedIndex - pageSize);
    this._adjustScroll();
    this._resetMetaScroll();
  }

  pageDown(): void {
    const pageSize = this._listHeight();
    const maxIndex = Math.max(0, this.flatCount - 1);
    this.selectedIndex = Math.min(maxIndex, this.selectedIndex + pageSize);
    this._adjustScroll();
    this._resetMetaScroll();
  }

  goToFirst(): void {
    if (this.mode === 'detail') {
      this.detailScrollOffset = 0;
    } else {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this._resetMetaScroll();
    }
  }

  goToLast(): void {
    if (this.mode === 'detail') {
      this.detailScrollOffset = 999999; // Will be clamped
    } else if (this.flatCount > 0) {
      this.selectedIndex = this.flatCount - 1;
      this._adjustScroll();
      this._resetMetaScroll();
    }
  }

  /**
   * Check if an item ID is currently expanded.
   */
  isExpanded(id: string): boolean {
    return this.expandedItems.has(id);
  }

  /**
   * Save the current navigation state (scroll position, selection) and push
   * it onto the navigation stack so the user can return via Escape.
   */
  pushNavigationState(parentId: string): void {
    this.navigationStack.push({
      parentId,
      scrollOffset: this.scrollOffset,
      selectedIndex: this.selectedIndex,
    });
  }

  /**
   * Pop the top navigation stack entry and restore its scroll/selection state.
   * Returns the restored entry, or undefined if the stack is empty.
   */
  popNavigationState(): NavigationStackEntry | undefined {
    const entry = this.navigationStack.pop();
    if (entry) {
      this.scrollOffset = entry.scrollOffset;
      this.selectedIndex = entry.selectedIndex;
      this._clampSelection();
      this._adjustScroll();
      this._resetMetaScroll();
    }
    return entry;
  }

  /**
   * Drop the saved navigation context for a parent, used when that parent is
   * collapsed so a later Escape does not pop back into a collapsed list.
   */
  clearNavigationStateFor(parentId: string): void {
    this.navigationStack.removeForParent(parentId);
  }

  /**
   * Toggle expand/collapse for an item.
   */
  toggleExpand(id: string): void {
    if (this.expandedItems.has(id)) {
      this.expandedItems.delete(id);
    } else {
      this.expandedItems.add(id);
    }
  }

  /**
   * Toggle the collapse state of a group by its group number.
   *
   * Collapsed groups hide their items from both the display rows and
   * navigation (WL-0MSL5MPSZ003TG94). The heading row itself remains
   * visible so the user can re-expand the group.
   */
  toggleGroupCollapse(group: number): void {
    if (this.collapsedGroups.has(group)) {
      this.collapsedGroups.delete(group);
    } else {
      this.collapsedGroups.add(group);
    }
  }

  /**
   * Produce the display-rows model that interleaves heading rows with item
   * rows (WL-0MSL5MPSZ003TG94).
   *
   * The rows are derived from `getFlattenedItems()` (which includes children
   * of expanded parents) but items belonging to collapsed groups are excluded.
   * A heading row is emitted whenever the group changes between consecutive
   * flattened items, matching the existing group-separator insertion logic.
   *
   * Heading `count` = top-level items in the group in the current view
   * (post stage-filter), unaffected by collapse state. This is computed
   * from `this.items` (top-level, filtered) so children of expanded parents
   * are never counted.
   *
   * @returns An array of `DisplayRow` entries (headings + items).
   */
  getDisplayRows(): DisplayRow[] {
    const result: DisplayRow[] = [];

    // Count top-level items per group (post stage-filter, current view).
    // Only items that carry a group number count toward their group's heading.
    const groupCounts = new Map<number, number>();
    for (const item of this.items) {
      if (item.group !== undefined) {
        groupCounts.set(item.group, (groupCounts.get(item.group) ?? 0) + 1);
      }
    }

    let lastGroup: number | undefined;

    const appendItem = (item: WorkItem, depth: number): void => {
      // Insert a heading row when the group changes between consecutive
      // items. Items without a group field (e.g. children, ungrouped items)
      // never trigger a new heading.
      if (item.group !== undefined && item.id !== '..') {
        if (lastGroup === undefined || item.group !== lastGroup) {
          const isCollapsed = this.collapsedGroups.has(item.group);
          result.push({
            kind: 'heading' as const,
            group: item.group,
            groupLabel: item.groupLabel ?? `Group ${item.group}`,
            count: groupCounts.get(item.group) ?? 0,
            collapsed: isCollapsed,
          });
          lastGroup = item.group;
        }
      }

      // Skip the entire subtree of an item in a collapsed group (children
      // carry no group metadata, so they are excluded via this early return
      // rather than per-item group checks). The heading above was already
      // emitted so the collapsed group stays visible and re-expandable.
      if (item.group !== undefined && this.collapsedGroups.has(item.group)) {
        return;
      }

      if (depth === 0) {
        result.push(item);
      } else {
        result.push(item.depth === depth ? item : { ...item, depth });
      }
      if (item.childCount && item.children && item.children.length > 0 && this.expandedItems.has(item.id)) {
        for (const child of item.children) {
          appendItem(child, depth + 1);
        }
      }
    };

    for (const item of this.items) {
      appendItem(item, 0);
    }

    return result;
  }

  /**
   * Get the flattened item list, inserting children of expanded parents.
   *
   * Recurses into any depth (WL-0MSQ3FH1K000MMJW): after inserting a child
   * of an expanded item, the child's own children are inserted too when the
   * child is itself expanded. Depth is derived from the hierarchy position
   * (top-level = no depth, each nested level = parent's depth + 1), so
   * items fetched at any level render at the correct indentation.
   */
  getFlattenedItems(): WorkItem[] {
    const result: WorkItem[] = [];
    const appendItem = (item: WorkItem, depth: number): void => {
      // Top-level items are pushed as-is (no depth field, matching the
      // pre-hierarchy shape). Nested items keep their object reference when
      // their stored depth already matches the hierarchy position (so
      // on-demand child fetches mutate the live tree object), otherwise the
      // depth is corrected with a shallow copy.
      if (depth === 0) {
        result.push(item);
      } else {
        result.push(item.depth === depth ? item : { ...item, depth });
      }
      if (item.childCount && item.children && item.children.length > 0 && this.expandedItems.has(item.id)) {
        for (const child of item.children) {
          appendItem(child, depth + 1);
        }
      }
    };
    for (const item of this.items) {
      appendItem(item, 0);
    }
    return result;
  }

  /**
   * Compute the hierarchy depth of an item in the current tree
   * (0 = top-level, 1 = child, …). Returns 0 for unknown IDs — the safe
   * default used when fetching their children at depth 1 (WL-0MSQ3FH1K000MMJW).
   */
  getItemDepth(id: string): number {
    const walk = (items: WorkItem[], depth: number): number => {
      for (const item of items) {
        if (item.id === id) return depth;
        if (item.children && item.children.length > 0) {
          const found = walk(item.children, depth + 1);
          if (found >= 0) return found;
        }
      }
      return -1;
    };
    const depth = walk(this.items, 0);
    return depth >= 0 ? depth : 0;
  }

  /**
   * Attach fetched children to the item in the live tree (walking nested
   * levels), never to a flattened copy. Ensures an on-demand fetch for a
   * child at any depth lands on the object the flatten recursion walks, so
   * the grandchildren actually render (WL-0MSQ3FH1K000MMJW).
   */
  attachChildren(id: string, children: WorkItem[]): void {
    const walk = (items: WorkItem[]): boolean => {
      for (const item of items) {
        if (item.id === id) {
          item.children = children;
          return true;
        }
        if (item.children && item.children.length > 0 && walk(item.children)) {
          return true;
        }
      }
      return false;
    };
    walk(this.items);
  }

  selectItem(): void {
    if (this.items.length === 0) return;
    const row = this.getSelectedDisplayRow();
    // Enter on a heading is a no-op (only Tab toggles group collapse,
    // WL-0MSL5MPSZ003TG94 AC5).
    if (row === null || isHeadingRow(row)) return;
    const item = row;
    this.detailItem = item;
    this.mode = 'detail';
    this.detailScrollOffset = 0;
    // Reset ToC/focus state per item (WL-0MSHWHULZ001FL8I): first entry
    // selected, keyboard focus on the ToC, auto-render of the first file
    // remains the initial default.
    this.detailToCIndex = 0;
    this.detailToCFocus = true;
    this.detailRenderedIndex = 0;
    this._resetMetaScroll();
  }

  back(): void {
    if (this.mode === 'detail') {
      this.mode = 'list';
      this.detailItem = null;
      this.detailScrollOffset = 0;
    } else if (this.mode === 'filter') {
      this.mode = 'list';
    }
  }

  // ── Detail scroll ──────────────────────────────────────────────

  detailScrollUp(amount = 1): void {
    this.detailScrollOffset = Math.max(0, this.detailScrollOffset - amount);
  }

  detailScrollDown(amount = 1): void {
    const maxCols = this.termSize.cols;
    const viewportHeight = Math.max(10, this.termSize.rows - 4);
    // The header + ToC block is pinned at the top; only the body below
    // scrolls (WL-0MSHWHULZ001FL8I / WL-0MSI28AP80002F5S).
    const allLines = formatDetailContent(this.detailItem, maxCols);
    const tocLines = formatDetailToC(this.detailItem, maxCols).length;
    const pinnedHeight = DETAIL_HEADER_LINES + tocLines;
    const bodyLines = Math.max(0, allLines.length - pinnedHeight);
    const bodyViewport = Math.max(1, viewportHeight - pinnedHeight);
    const maxScroll = Math.max(0, bodyLines - bodyViewport);
    this.detailScrollOffset = Math.min(maxScroll, this.detailScrollOffset + amount);
  }

  // ── Metadata panel scroll ───────────────────────────────────────

  /**
   * Return the display row at the current selection (heading or item), or
   * null when the list is empty or the selection is out of range.
   */
  getSelectedDisplayRow(): DisplayRow | null {
    const rows = this.getDisplayRows();
    if (rows.length === 0) return null;
    const idx = this.selectedIndex;
    if (idx < 0 || idx >= rows.length) return null;
    return rows[idx];
  }

  /**
   * Return the currently selected item, or null when the selection is a
   * heading row (the metadata panel then renders group info), the list is
   * empty, or the selection is out of range.
   */
  getSelectedItem(): WorkItem | null {
    const row = this.getSelectedDisplayRow();
    if (row === null || isHeadingRow(row)) return null;
    return row;
  }

  /** Scroll the metadata panel up (toward the start of the content). */
  metaScrollUp(amount = 1): void {
    this.metaScrollOffset = Math.max(0, this.metaScrollOffset - amount);
  }

  /** Scroll the metadata panel down (toward the end of the content). */
  metaScrollDown(amount = 1, panelHeight?: number): void {
    // Use the provided panel height (from the renderer's new dynamic layout)
    // or fall back to computing from termSize.
    let ph = panelHeight;
    if (ph === undefined) {
      ph = computeMetadataPanelHeight(this.termSize.rows);
    }
    const selected = this.getSelectedItem();
    if (!selected) return;
    const allLines = formatMetadataPanel(selected, this.termSize.cols, ph, 0);
    const maxScroll = Math.max(0, allLines.length - ph);
    this.metaScrollOffset = Math.min(maxScroll, this.metaScrollOffset + amount);
  }

  /**
   * Reset the metadata panel scroll offset. Called whenever the selection
   * changes so the panel always starts at the top for the newly selected
   * item.
   */
  private _resetMetaScroll(): void {
    this.metaScrollOffset = 0;
  }

  // ── Filtering ───────────────────────────────────────────────────

  activateFilter(): void {
    this.mode = 'filter';
  }

  applyFilter(stage: string): void {
    this.activeFilter = stage;
    this.activePriorityFilter = null; // replace semantics: one axis at a time
    this._applyFilters();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.mode = 'list';
    this._resetMetaScroll();
    // Filter changes the visible item set — invalidate cached previews.
    clearDescriptionPreviewCache();
  }

  /**
   * Apply a priority filter (replace semantics, WL-0MSKC8T46006999S):
   * clears any active stage filter so stage and priority filters are
   * mutually exclusive.
   */
  applyPriorityFilter(priority: string): void {
    this.activePriorityFilter = priority;
    this.activeFilter = null; // replace semantics: one axis at a time
    this._applyFilters();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.mode = 'list';
    this._resetMetaScroll();
    // Filter changes the visible item set — invalidate cached previews.
    clearDescriptionPreviewCache();
  }

  clearFilter(): void {
    this.activeFilter = null;
    this.activePriorityFilter = null;
    this._applyFilters();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this._resetMetaScroll();
    // Reverting a filter changes the visible item set — invalidate cached previews.
    clearDescriptionPreviewCache();
  }

  // ── Refresh ─────────────────────────────────────────────────────

  refreshItems(newItems: WorkItem[]): void {
    // Clear the description preview cache on refresh (descriptions may have
    // changed externally; WL-0MT9ZJF28004UJ28).
    clearDescriptionPreviewCache();

    // Capture the currently selected item's ID before replacing items
    const prevSelectedId = this._captureSelectedId();

    // The fetcher returns fresh top-level objects that never carry a
    // `children` array (normalizeItem drops it), so a plain swap would
    // momentarily collapse every expanded parent until doRefresh re-fetches
    // children asynchronously — the reported flicker (WL-0MSBVBNGH002RDP5).
    // Carry the previously fetched children over to the new objects by ID so
    // the flattened view — and any selection pointing at a child — survives
    // the swap atomically; doRefresh replaces the carried-over data with
    // fresh children immediately afterwards.
    const prevChildrenById = new Map<string, WorkItem[]>();
    for (const item of this._allItems) {
      if (item.children && item.children.length > 0) {
        prevChildrenById.set(item.id, item.children);
      }
    }

    this._allItems = [...newItems];
    this._applyFilters();

    // Attach carried-over children only where the new object has no children
    // yet (fresh children attached by doRefresh are never clobbered).
    for (const item of this._allItems) {
      if (item.childCount && item.childCount > 0 && !item.children) {
        const prev = prevChildrenById.get(item.id);
        if (prev) {
          item.children = prev;
        }
      }
    }

    // Try to restore selection by ID; fall back to clamping if not found
    if (!this._restoreSelectionById(prevSelectedId)) {
      this._clampSelection();
    }

    this._adjustScroll();
    // Only reset the metadata scroll when the selection actually changed
    // (auto-refreshes with the same item selected keep the user's position).
    if (this._captureSelectedId() !== prevSelectedId) {
      this._resetMetaScroll();
    }
  }

  /**
   * Capture the ID of the currently selected item, or undefined if the
   * display rows are empty, the selection is a heading, or nothing is
   * selected.
   */
  private _captureSelectedId(): string | undefined {
    const row = this.getSelectedDisplayRow();
    if (row === null || isHeadingRow(row)) return undefined;
    return row.id;
  }

  /**
   * Search the display rows for an item matching `id` and set
   * selectedIndex to its position.
   *
   * @returns true if the item was found and selection restored;
   *          false if the item is no longer visible.
   */
  private _restoreSelectionById(id: string | undefined): boolean {
    if (id === undefined) return false;
    const rows = this.getDisplayRows();
    const newIndex = rows.findIndex((row) => !isHeadingRow(row) && (row as WorkItem).id === id);
    if (newIndex === -1) return false;
    this.selectedIndex = newIndex;
    return true;
  }

  // ── Internal ────────────────────────────────────────────────────

  private _applyFilters(): void {
    let filtered = [...this._allItems];
    if (this.activeFilter) {
      filtered = filtered.filter((item) => item.stage === this.activeFilter);
    } else if (this.activePriorityFilter) {
      filtered = filtered.filter((item) => item.priority === this.activePriorityFilter);
    }
    this.items = filtered;
  }

  private _clampSelection(): void {
    const total = this.flatCount;
    if (total === 0) {
      this.selectedIndex = 0;
    } else if (this.selectedIndex >= total) {
      this.selectedIndex = total - 1;
    } else if (this.selectedIndex < 0) {
      this.selectedIndex = 0;
    }
  }

  /**
   * Public wrapper around the private `_clampSelection` for external
   * handlers (the private member is not accessible outside the class).
   * Clamps the selected index back into the visible row range (e.g. after
   * collapsing a group removes rows).
   */
  clampSelection(): void {
    this._clampSelection();
  }

  /** Number of visible list rows (accounts for the metadata panel). */
  _listHeight(): number {
    // Dynamic layout (WL-0MSQ44MDX008U69J): list takes up to the max available
    // rows minus the metadata minimum (3 rows).  This approximates the renderer's
    // computation — the state does not know the banner count, so it uses a simpler
    // formula. The renderer's own list-height computation is the source of truth.
    const rows = this.termSize.rows;
    const minMeta = 3; // metadata panel minimum
    return Math.max(3, rows - 4 - minMeta); // rows - chrome(4) - minMeta
  }

  _adjustScroll(): void {
    const listHeight = this._listHeight();
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + listHeight) {
      this.scrollOffset = this.selectedIndex - listHeight + 1;
    }
    // Clamp scroll offset using flattened item count
    const maxOffset = Math.max(0, this.flatCount - listHeight);
    if (this.scrollOffset > maxOffset) {
      this.scrollOffset = maxOffset;
    }
    // Hover tooltip (WL-0MT9XRZDK006GMUH): a scroll/selection adjustment
    // means the rows under the pointer changed (keyboard navigation,
    // refresh) — clear the hovered row so a stale tooltip never renders.
    // The next mouse motion re-establishes it. The Esc dismissal flag is
    // intentionally preserved (it only clears on hover-none / re-entry).
    this.hoveredRowIndex = null;
  }

  /** Returns the currently visible slice of items. */
  getVisibleItems(): WorkItem[] {
    const listHeight = this._listHeight();
    return this.items.slice(this.scrollOffset, this.scrollOffset + listHeight);
  }
}

// ── Stage filter helper ───────────────────────────────────────────────

export class StageFilter {
  private _current: string | null = null;
  private _index = -1;

  get current(): string | null {
    return this._current;
  }

  set(stage: string | null): void {
    this._current = stage;
    if (stage === null) {
      this._index = -1;
    } else {
      this._index = STAGES.indexOf(stage as Stage);
    }
  }

  /** Cycle to the next stage. Wraps around (including null/off). */
  cycle(): void {
    this._index += 1;
    if (this._index >= STAGES.length) {
      this._index = -1;
      this._current = null;
    } else {
      this._current = STAGES[this._index];
    }
  }
}

// ── Formatting functions ──────────────────────────────────────────────

/**
 * Format a single item line for the list display.
 *
 * Includes icon prefix, stage colouring, and group markers.
 */
export function formatItemLine(
  item: WorkItem,
  maxCols: number,
  isSelected = false,
  noIcons = false,
): string {
  // Depth indentation for hierarchical display
  const depth = item.depth ?? 0;
  const depthIndent = depth > 0 ? '  '.repeat(depth) : '';

  // Expand/collapse icon — always 2 cells wide to keep alignment.
  // Items without children get 2 spaces so the icon prefix starts at the
  // same column regardless of whether the expand arrow is present.
  const expandIcon = item.childCount && item.childCount > 0
    ? (item._expanded ? '▼ ' : '▶ ')
    : '  ';

  const prefix = isSelected ? '▸ ' : '  ';
  const iconPrefix = getIconPrefix(item, { noIcons });
  const iconStr = iconPrefix.length > 0 ? `${iconPrefix}` : '';

  // Apply stage colouring to the title
  const colouredTitle = item.stage
    ? applyStageColour(item.title, item.stage)
    : item.title;

  const priorityStr = item.priority
    ? ` ${priorityIcon(item.priority, { noIcons })} ${item.priority}`
    : '';

  const stageTag = item.stage && item.stage !== 'in_progress'
    ? ` [${item.stage}]`
    : '';

  let line = `${depthIndent}${prefix}${expandIcon}${iconStr}${item.id} ${colouredTitle}${stageTag}${priorityStr}`;

  // Truncate to fit terminal width, accounting for ANSI codes
  const visibleLength = line.replace(/\x1b\[[0-9;]*m/g, '').length;
  if (visibleLength > maxCols - 1) {
    // Truncate before ANSI codes, preserving them
    let truncated = '';
    let visLen = 0;
    let i = 0;
    while (visLen < maxCols - 4 && i < line.length) {
      if (line[i] === '\x1b' && line[i + 1] === '[') {
        // Copy ANSI escape sequence
        const end = line.indexOf('m', i);
        if (end >= 0) {
          truncated += line.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      truncated += line[i];
      visLen += 1;
      i += 1;
    }
    // Close any open ANSI codes before ellipsis
    truncated += `${ANSI.reset}…`;
    line = truncated;
  }

  return line;
}

/**
 * Ensure a line (possibly with ANSI codes) fits within the given width
 * by truncating and appending an ellipsis if necessary.
 */
function truncateLine(line: string, maxWidth: number): string {
  const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
  if (visibleLen <= maxWidth) return line;

  let result = '';
  let visLen = 0;
  let i = 0;
  while (visLen < maxWidth - 1 && i < line.length) {
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i);
      if (end >= 0) {
        result += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    result += line[i];
    visLen += 1;
    i += 1;
  }
  // Close open ANSI and append ellipsis
  result += `${ANSI.reset}…`;
  return result;
}

/**
 * Format an ISO-8601 timestamp for display as `DD/MM/YY HH:MM` in the
 * user's local time zone (zero-padded, 24-hour clock).
 *
 * Unparseable input is returned unchanged so a corrupt timestamp never
 * breaks rendering (WL-0MSF8HYUX0012WA9).
 */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ── Hover tooltip rendering (WL-0MT9XRZDK006GMUH) ───────────────────

/**
 * Format a work-item hover tooltip line for an agent-pane row.
 *
 * Renders the 8 metadata fields: ID, Title, Command, Priority, Type,
 * Risk, Effort, and Start Time.
 *
 * @param item - The work item being hovered.
 * @param command - The command recorded for this pane (optional).
 * @param recordedAt - The ISO timestamp when the pane was recorded.
 * @param cols - Terminal width for truncation.
 * @param noIcons - Whether to skip icon rendering.
 * @returns Formatted tooltip lines.
 */
export function formatTooltipLines(
  item: WorkItem,
  command: string | undefined,
  recordedAt: string | undefined,
  cols: number,
  noIcons = false,
): string[] {
  const parts: string[] = [];

  // ID + Title line.
  const titleStr = item.title ? `${item.title}` : '';
  parts.push(`${ANSI.bold}${item.id}${ANSI.reset} ${titleStr}`);

  // Command.
  if (command) {
    parts.push(`${ANSI.dim}Command:${ANSI.reset} ${ANSI.fg(220)}${command}${ANSI.reset}`);
  }

  // Priority + Type (compact row).
  const priorityStr = item.priority ? `${priorityIcon(item.priority, { noIcons })} ${item.priority}` : '';
  const typeStr = item.issueType ? `${item.issueType === 'epic' && !noIcons ? epicIcon() : ''}${item.issueType}` : '';
  const typeLabel = typeStr ? `${ANSI.dim}Type:${ANSI.reset} ${typeStr}` : '';
  const priorityLabel = priorityStr ? `${ANSI.dim}Priority:${ANSI.reset} ${priorityStr}` : '';
  if (priorityLabel && typeLabel) {
    parts.push(`${priorityLabel}${ANSI.dim}  ${typeLabel}${ANSI.reset}`);
  } else if (priorityLabel) {
    parts.push(priorityLabel);
  } else if (typeLabel) {
    parts.push(typeLabel);
  }

  // Risk + Effort (compact row).
  const riskStr = item.risk ? `${riskIcon(item.risk, { noIcons })} ${item.risk}` : '';
  const effortStr = item.effort ? `${effortIcon(item.effort, { noIcons })} ${item.effort}` : '';
  const riskLabel = riskStr ? `${ANSI.dim}Risk:${ANSI.reset} ${riskStr}` : '';
  const effortLabel = effortStr ? `${ANSI.dim}Effort:${ANSI.reset} ${effortStr}` : '';
  if (riskLabel && effortLabel) {
    parts.push(`${riskLabel}${ANSI.dim}  ${effortLabel}${ANSI.reset}`);
  } else if (riskLabel) {
    parts.push(riskLabel);
  } else if (effortLabel) {
    parts.push(effortLabel);
  }

  // Start Time.
  if (recordedAt) {
    parts.push(`${ANSI.dim}Started:${ANSI.reset} ${formatTimestamp(recordedAt)}`);
  }

  // Truncate each line to fit.
  return parts.map((line) => truncateLine(line, cols));
}

/**
 * Format the complete hover tooltip overlay as footer lines.
 *
 * The tooltip replaces the normal footer hints while a pane-associated row
 * is hovered and not dismissed. Each line is wrapped in a dark-grey box
 * so the overlay reads as a distinct panel.
 *
 * @param cols - Terminal width.
 * @param lines - Tooltip content lines from {@link formatTooltipLines}.
 * @returns Formatted footer lines for the tooltip; empty when no content.
 */
export function formatTooltipOverlay(cols: number, lines: string[]): string[] {
  if (lines.length === 0) return [];
  let maxWidth = 0;
  for (const line of lines) {
    const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
    if (visibleLen > maxWidth) maxWidth = visibleLen;
  }
  const boxWidth = Math.min(Math.max(maxWidth + 2, 20), cols - 2);
  return lines.map((line) => {
    const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
    const padding = Math.max(0, boxWidth - visibleLen);
    const bg = ANSI.bg(238);
    const fg = ANSI.fg(252);
    return `${ANSI.reset}${bg}${fg} ${line}${' '.repeat(padding)} ${ANSI.reset}`;
  });
}

/**
 * Build the metadata table rows for a work item (label/value pairs).
 *
 * Includes every tracked field: ID, Title, Status, Stage, Priority, Type,
 * Risk, Effort, Children, Parent, Tags, GitHub Issue, Created, Updated,
 * Audit, Reviewed, and Audited At. When the item's `Key Files:` section
 * contains `.md` paths, a `Related Docs` row lists every one of them (joined
 * with `, `); the row is omitted when there are no `.md` Key Files
 * (WL-0MSGTLSUT002NF29). Fields that are unset are omitted.
 * Timestamps (Created, Updated, Audited At) are rendered in local time as
 * `DD/MM/YY HH:MM` via {@link formatTimestamp}.
 *
 * Icon-bearing fields (Status, Stage, Priority, Type, Risk, Effort, Audit,
 * Reviewed) render as **icon + text label**, using the same icon helpers as
 * the list rows (statusIcon, stageDisplayIcon, priorityIcon, epicIcon,
 * riskIcon, effortIcon, auditIcon, needsProducerReviewIcon) so the metadata
 * section and the list can never diverge (WL-0MSGIXHHI009KFW9). With icons
 * disabled the values fall back to plain text — the metadata deliberately
 * does NOT use the list's `[BRACKET]` fallbacks.
 * Shared by the detail view and the list-mode metadata panel so both stay
 * consistent (WL-0MSAYNVBY006LM9X-FT4).
 */
export function buildMetaRows(item: WorkItem, noIcons = false): Array<[string, string]> {
  const metaRows: Array<[string, string]> = [];
  const addMeta = (label: string, value: string | undefined | null): void => {
    if (value != null && value !== '') {
      metaRows.push([label, value]);
    }
  };

  // Prefix a display value with its icon (`icon + text`, e.g. `🔄
  // in_progress`). Unknown icon keys return '' (e.g. free-form effort `3`),
  // so those rows stay text-only — consistent with the list
  // (WL-0MSGIXHHI009KFW9). When icons are disabled the icon is omitted
  // entirely: plain text only, no emoji, no [BRACKET] fallbacks.
  const iconText = (icon: string, text: string | undefined | null): string | undefined => {
    if (text == null || text === '') return undefined;
    return icon ? `${icon} ${text}` : text;
  };

  // Text labels paired with the Audit/Reviewed icons (AC5).
  const auditLabel = (result: boolean | null | undefined): string | undefined => {
    if (result === true) return 'ready to close';
    if (result === false) return 'not ready';
    return 'unknown';
  };
  const reviewLabel = (needsReview: boolean | undefined): string | undefined => {
    if (needsReview === undefined) return undefined;
    return needsReview ? 'needs review' : 'reviewed';
  };

  addMeta('ID', item.id);
  addMeta('Title', item.title);
  addMeta('Status', iconText(noIcons ? '' : statusIcon(item.status), item.status));
  // Stage mirrors the list's audit-aware in_review icon via the shared
  // stageDisplayIcon helper (AC2).
  addMeta('Stage', iconText(noIcons ? '' : stageDisplayIcon(item), item.stage));
  addMeta('Priority', iconText(noIcons ? '' : priorityIcon(item.priority), item.priority));
  // Type shows the epic icon (⊙) for epic items only, matching the list;
  // non-epic types remain text-only (AC3).
  addMeta('Type', iconText(noIcons ? '' : (item.issueType === 'epic' ? epicIcon() : ''), item.issueType));
  addMeta('Risk', iconText(noIcons ? '' : riskIcon(item.risk), item.risk));
  addMeta('Effort', iconText(noIcons ? '' : effortIcon(item.effort), item.effort));
  addMeta('Children', item.childCount !== undefined ? String(item.childCount) : undefined);
  addMeta('Parent', item.parentId);
  if (item.tags && item.tags.length > 0) {
    metaRows.push(['Tags', item.tags.join(', ')]);
  }
  addMeta('GitHub Issue', item.githubIssueNumber ? `#${item.githubIssueNumber}` : undefined);
  addMeta('Created', item.createdAt ? formatTimestamp(item.createdAt) : undefined);
  addMeta('Updated', item.updatedAt ? formatTimestamp(item.updatedAt) : undefined);
  addMeta('Audit', iconText(noIcons ? '' : auditIcon(item.auditResult), auditLabel(item.auditResult)));
  addMeta('Reviewed', iconText(noIcons ? '' : needsProducerReviewIcon(item.needsProducerReview), reviewLabel(item.needsProducerReview)));
  addMeta('Audited At', item.auditedAt ? formatTimestamp(item.auditedAt) : undefined);

  // Related Docs — every .md path referenced in the item's `Key Files:`
  // section, joined with a compact delimiter so multi-file values fit the
  // existing label/value row format (WL-0MSGTLSUT002NF29). Display-only:
  // paths are shown as written in the description, no file I/O at render
  // time; resolution happens at open time via resolveKeyFilePath.
  const mdPaths = extractFilePaths(item.description ?? '').filter(p => p.endsWith('.md'));
  if (mdPaths.length > 0) {
    metaRows.push(['Related Docs', mdPaths.join(', ')]);
  }

  return metaRows;
}

// ── Compound metadata rows (WL-0MSNIX4V60012266) ──────────────────────────
// The four field pairs that should be rendered on a single compressed row.

/** Metadata field-pair definitions for compressed rendering. */
const META_ROW_PAIRS: Array<[string, string, string]> = [
  ['Status+Stage', 'Status', 'Stage'],
  ['Priority+Type', 'Priority', 'Type'],
  ['Created+Updated', 'Created', 'Updated'],
  ['Audit+AuditedAt', 'Audit', 'Audited At'],
] as const;

/**
 * Post-process `buildMetaRows` output to pair four field combinations onto
 * single rows, reducing the vertical space used in the metadata panel.
 *
 * Pairs: Status+Stage, Priority+Type, Created+Updated, Audit+AuditedAt.
 * Each pair is joined with ` / ` as a separator when BOTH values are
 * present. When only one half of a pair is present, the present half is
 * kept as its own single row (with its original label) so no field
 * information is ever lost (e.g. an item with an audit verdict but no
 * audited-at timestamp still shows its `Audit` row).
 *
 * All other rows pass through unchanged. The original row order is
 * preserved (pairs appear where their first component originally appeared).
 *
 * @param metaRows - Raw label/value pairs from {@link buildMetaRows}.
 * @returns A new array with the four pairs compressed into single rows.
 */
export function pairMetaRows(
  metaRows: Array<[string, string]>,
): Array<[string, string]> {
  const rows = new Map<string, string>(metaRows);
  const consumed = new Set<string>();

  const result: Array<[string, string]> = [];
  for (const [label, value] of metaRows) {
    // Second key of a pair already emitted inside a compound row — skip.
    if (consumed.has(label)) continue;

    // First key of a pair (buildMetaRows always emits the first key before
    // the second, so the compound row lands in its natural position).
    const pairDef = META_ROW_PAIRS.find(([, keyA]) => keyA === label);
    if (pairDef) {
      const [compoundLabel, keyA, keyB] = pairDef;
      const valA = rows.get(keyA);
      const valB = rows.get(keyB);
      if (valA != null && valB != null) {
        result.push([compoundLabel, `${valA} / ${valB}`]);
        consumed.add(keyB);
      } else {
        // Incomplete pair — keep the present half as a single row.
        result.push([label, value]);
      }
    } else {
      // Regular row, or the lone second key of an incomplete pair —
      // pass through unchanged.
      result.push([label, value]);
    }
  }

  return result;
}

// ── Description preview cache (WL-0MT9ZJF28004UJ28) ─────────────────────
// Cache key: `${itemId}|${descHash}|${maxCols}`. Stores FULL rendered markdown
// lines (no heading, no preview slicing) so the markdown parser — the
// expensive step — runs at most once per selection change per item; the
// per-call slicing to available panel space is cheap.
const descriptionPreviewCache = new Map<string, string[]>();

/**
 * Minimum number of description preview lines shown in the metadata panel
 * (rendered markdown lines, after the `Description` heading row).
 */
const DESCRIPTION_PREVIEW_MAX_LINES = 3;

/**
 * Simple djb2 hash for description strings — used as part of the cache key.
 * Collisions are harmless (cache miss triggers re-render); only correctness
 * and speed matter.
 */
function hashString(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Invalidate the description preview cache. Called on selection change
 * (cache reset per item) and item refresh (global clear).
 */
export function clearDescriptionPreviewCache(itemId?: string): void {
  if (itemId) {
    for (const key of descriptionPreviewCache.keys()) {
      if (key.startsWith(itemId + '|')) {
        descriptionPreviewCache.delete(key);
      }
    }
  } else {
    descriptionPreviewCache.clear();
  }
}

/**
 * Build the description preview lines for the metadata panel.
 *
 * Replaces the original raw-line preview with a markdown-aware version that
 * calls {@link renderMarkdown} from `md-viewer.ts`. Results are cached keyed
 * by (item.id, description hash) so the markdown parser runs at most once
 * per selection change (WL-0MT9ZJF28004UJ28 AC3).
 *
 * Returns up to `maxLines` rendered markdown lines from the item's
 * description, each truncated to `maxCols`. The preview starts with a dimmed
 * `Description` heading row. Returns an empty array when the description is
 * missing or blank.
 *
 * The preview fills the available panel space (AC2): `maxLines` is derived
 * from the remaining panel rows by the caller, clamped to a 3-row minimum
 * when other metadata lines are present.
 *
 * @param itemId - Work item ID (used for cache keying).
 * @param description - The work item's description text.
 * @param maxCols - Terminal width for truncation.
 * @param maxLines - Maximum rendered lines to show (floor 3 by default).
 * @returns Preview lines ready to insert into the metadata panel.
 */
function buildDescriptionPreview(
  itemId: string,
  description: string | undefined | null,
  maxCols: number,
  maxLines: number = DESCRIPTION_PREVIEW_MAX_LINES,
): string[] {
  if (!description || description.trim() === '') {
    return [];
  }

  const descHash = hashString(description);
  const renderKey = `${itemId}|${descHash}|${maxCols}`;

  // Reuse the fully rendered output across calls; slicing below is cheap.
  let rendered = descriptionPreviewCache.get(renderKey);
  if (!rendered) {
    rendered = renderMarkdown(description, maxCols);
    descriptionPreviewCache.set(renderKey, rendered);
  }

  const preview: string[] = [];
  // Heading row
  preview.push(` ${ANSI.dim}${ANSI.underline}Description${ANSI.reset}`);

  // Up to `maxLines` rendered markdown lines (the renderer already handles
  // wrapping/truncation, so lines are taken as-is)
  for (const line of rendered) {
    if (preview.length - 1 >= maxLines) break;
    preview.push(line);
  }

  return preview;
}

/**
 * Format the metadata panel shown below the selection list.
 *
 * Renders the selected item's fields (via {@link buildMetaRows}) plus a
 * description preview (up to 3 lines) and a last command line when the item's
 * stage is `in_progress`. The panel scrolls independently with its own offset:
 * when the content is taller than the panel,
 * `metaScrollOffset` selects the visible window and a `[m/M scroll]`
 * indicator is appended to the last line.
 *
 * @param item - Selected work item (or null for an empty panel).
 * @param maxCols - Terminal width (lines are truncated to fit).
 * @param panelRows - Number of rows available for the panel.
 * @param metaScrollOffset - Vertical scroll offset into the panel content.
 * @param lastCommand - Most recent command for the item (shown only when the
 *                      item stage is `in_progress`).
 * @returns Exactly `panelRows` lines ready for the renderer.
 */
export function formatMetadataPanel(
  item: WorkItem | null,
  maxCols: number,
  panelRows: number,
  metaScrollOffset = 0,
  lastCommand?: string | null,
  noIcons = false,
): string[] {
  const lines: string[] = [];
  if (!item) {
    // Blank panel — pad to the full height
    while (lines.length < panelRows) {
      lines.push('');
    }
    return lines;
  }

  // Header separator identifying the selected item
  lines.push(` ${ANSI.dim}── ${item.id} ──${ANSI.reset}`);

  // Metadata rows — pair Status+Stage, Priority+Type, Created+Updated,
  // Audit+AuditedAt onto single rows for a more compact display (WL-0MSNIX4V60012266).
  const metaRows = pairMetaRows(buildMetaRows(item, noIcons));
  if (metaRows.length > 0) {
    const fieldWidth = Math.max(...metaRows.map(([l]) => l.length), 6);
    for (const [label, value] of metaRows) {
      lines.push(` ${label.padEnd(fieldWidth)} ${value}`);
    }
  }

  // Description preview — markdown-rendered lines filling the available
  // panel space (WL-0MT9ZJF28004UJ28 AC2). The 3-row floor keeps a
  // meaningful preview on short panels; tall panels show more of the
  // description. A row is reserved for the Last command line (when the item
  // is in_progress) so it stays visible. Cached per (id, description) so the
  // markdown parser runs at most once per selection change.
  const reserveLastCommand = item.stage === 'in_progress' ? 1 : 0;
  const previewBudget = Math.max(DESCRIPTION_PREVIEW_MAX_LINES, panelRows - lines.length - reserveLastCommand);
  const preview = buildDescriptionPreview(item.id, item.description, maxCols, previewBudget);
  lines.push(...preview);

  // Last command — only meaningful while the item is being worked on
  if (item.stage === 'in_progress') {
    if (lastCommand) {
      lines.push(` ${ANSI.dim}Last command: ${lastCommand}${ANSI.reset}`);
    } else {
      lines.push(` ${ANSI.dim}Last command: none yet${ANSI.reset}`);
    }
  }

  // Truncate to fit the terminal width
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      lines[i] = truncateLine(lines[i], maxCols);
    }
  }

  // Apply independent scrolling
  const maxScroll = Math.max(0, lines.length - panelRows);
  const safeOffset = Math.min(metaScrollOffset, maxScroll);
  const visible = lines.slice(safeOffset, safeOffset + panelRows);

  // Scroll indicator when content overflows
  if (lines.length > panelRows) {
    const percent = Math.round(((safeOffset + panelRows) / lines.length) * 100);
    const indicator = ` ${ANSI.dim}[m/M scroll ${Math.min(percent, 100)}%]${ANSI.reset}`;
    visible[visible.length - 1] = truncateLine(visible[visible.length - 1] + indicator, maxCols);
  }

  // Pad to the panel height
  while (visible.length < panelRows) {
    visible.push('');
  }

  return visible;
}

/**
 * Build the metadata-panel lines for a group heading selection
 * (WL-0MSL5MPSZ003TG94 T5 AC1). Headings have no work-item metadata, so the
 * panel shows the group's label, its item count (post stage-filter, as
 * computed by the display model), and the collapse state. A short hint line
 * tells the user Tab toggles the group.
 *
 * @param heading - The selected heading row.
 * @param maxCols - Terminal width.
 * @param panelRows - Panel height in rows (from the dynamic layout).
 * @returns The panel lines, padded to `panelRows`.
 */
export function formatGroupInfoPanel(
  heading: DisplayHeadingRow,
  maxCols: number,
  panelRows: number,
): string[] {
  const lines: string[] = [];

  // Header separator identifying the selected group
  lines.push(` ${ANSI.dim}── ${heading.groupLabel} ──${ANSI.reset}`);

  // Group metadata rows
  lines.push(` Label: ${heading.groupLabel}`);
  lines.push(` Items: ${heading.count}`);
  lines.push(` Group: ${heading.group}`);
  lines.push(` State: ${heading.collapsed ? 'collapsed' : 'expanded'}`);
  lines.push(` ${ANSI.dim}Tab toggles this group's collapse state${ANSI.reset}`);

  // Truncate to fit the terminal width
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      lines[i] = truncateLine(lines[i], maxCols);
    }
  }

  // Trim to the panel height and pad
  const visible = lines.slice(0, panelRows);
  while (visible.length < panelRows) {
    visible.push('');
  }
  return visible;
}

/**
 * Build the Related Docs Table of Contents (ToC) lines for the detail view
 * (WL-0MSHWHULZ001FL8I).
 *
 * Lists every `.md` Key File of the item, numbered, with a focus indicator
 * (`▸`) on the selected entry. Returns [] when the item has no `.md` Key
 * Files so the detail view renders exactly as before.
 *
 * @param item - Work item whose `Key Files:` section is scanned.
 * @param maxCols - Terminal width.
 * @param detailToCIndex - Selected ToC entry (0-based).
 * @param detailToCFocus - Whether keyboard focus is on the ToC (unused for
 *   rendering; kept for parity with the state and future dimming).
 * @param noIcons - Icons gated off (focus indicator is a plain text marker).
 * @returns ToC lines, or [] when the item has no `.md` Key Files.
 */
export function formatDetailToC(
  item: WorkItem | null,
  maxCols: number,
  detailToCIndex = 0,
  detailToCFocus = true,
  noIcons = false,
): string[] {
  if (!item) return [];
  const mdPaths = extractFilePaths(item.description ?? '').filter(p => p.endsWith('.md'));
  if (mdPaths.length === 0) return [];

  const lines: string[] = [];
  lines.push('');
  lines.push(` ${ANSI.underline}Related Docs${ANSI.reset}`);
  lines.push('');
  mdPaths.forEach((path, i) => {
    const marker = i === detailToCIndex ? '▸' : ' ';
    lines.push(` ${marker} ${i + 1}. ${path}`);
  });
  lines.push('');
  return lines;
}

/**
 * Build the full content lines for a detail view (without scrolling).
 * Returns an array of lines ready for viewport rendering.
 *
 * Metadata section includes: Status, Priority, Stage, Type, Risk, Effort,
 * Children, Tags, GitHub Issue (number), Created, Updated, Audit
 * (auditResult icon + text label), Reviewed (needsProducerReview icon +
 * text label), and Audited At (ISO timestamp). Rendered as a markdown
 * table; icon-bearing values are `icon + text` via the shared
 * {@link buildMetaRows} (WL-0MSGIXHHI009KFW9). ID and Title are shown in
 * the header (from the shared {@link buildMetaRows} set they are omitted
 * from the table to avoid duplication).
 *
 * When the item has ≥1 `.md` Key File, a pinned `Related Docs` ToC is
 * rendered at the top (see {@link formatDetailToC}); the md viewer section
 * below renders the file at `detailRenderedIndex` (default 0 = first file,
 * preserving the existing auto-render behavior).
 */
export function formatDetailContent(
  item: WorkItem | null,
  maxCols: number,
  readFile?: (filePath: string) => string | null,
  noIcons = false,
  detailToCIndex = 0,
  detailToCFocus = true,
  detailRenderedIndex = 0,
): string[] {
  if (!item) return [];

  const lines: string[] = [];
  const contentWidth = maxCols - 2;
  const separator = '─'.repeat(Math.min(contentWidth, 72));

  // Header
  lines.push('');
  lines.push(` ${item.id}`);
  lines.push(` ${ANSI.bold}${item.title}${ANSI.reset}`);
  lines.push(separator);

  // Related Docs ToC — pinned at the top of the detail view
  // (WL-0MSHWHULZ001FL8I).
  lines.push(...formatDetailToC(item, maxCols, detailToCIndex, detailToCFocus, noIcons));

  // Metadata — rendered as a markdown table (shared row builder; ID and
  // Title are already shown in the header above, so they are filtered out
  // here to avoid duplicating them). Apply compound row pairing for a
  // more compact display (WL-0MSNIX4V60012266).
  const metaRows = pairMetaRows(
    buildMetaRows(item, noIcons).filter(([label]) => label !== 'ID' && label !== 'Title'),
  );

  // Render the metadata as a markdown table
  if (metaRows.length > 0) {
    const fieldWidth = Math.max(...metaRows.map(([l]) => l.length), 6);
    for (const [label, value] of metaRows) {
      lines.push(`| ${label.padEnd(fieldWidth)} | ${value} |`);
    }
  }

  lines.push(separator);

  // Description
  if (item.description) {
    lines.push('');
    lines.push(` ${ANSI.underline}Description${ANSI.reset}`);
    lines.push('');
    // Render the description as GFM (tables, bold/italic, inline code,
    // links, lists, headings) via the shared markdown renderer; NOTE
    // markers render as `<id>↗` links inside the rendered output. Wrap to
    // the content width minus the 2-space indent.
    const indent = 2;
    const wrapWidth = contentWidth - indent - 2;
    const descLines = renderMarkdown(item.description, Math.max(wrapWidth, 20));
    for (const dl of descLines) {
      lines.push(`  ${dl}`);
      // Limit total lines
      if (lines.length > 500) {
        lines.push(`  ... (truncated, ${item.description.split('\n').length} total description lines)`);
        break;
      }
    }
  }

  // Generic md-document viewer for a Key Files: .podcast.md episode file
  // (any .md Key File). When a readFile callback is provided and the item
  // references a readable .md file, render it in place of the raw
  // description so the producer sees the paragraph-format episode.
  // Inline-note markers can be edited from the viewer via the n,e / n,d
  // chords (WL-0MSKV6SKK008MMXR). Renders the file at detailRenderedIndex
  // (default 0 = first file, the existing auto-render); Enter on a ToC
  // entry selects another file
  // (WL-0MSHWHULZ001FL8I).
  if (readFile) {
    const mdPaths = extractFilePaths(item.description ?? '').filter(p => p.endsWith('.md'));
    const mdPath = mdPaths[detailRenderedIndex] ?? mdPaths[0];
    const mdViewerLines = renderFileViewer(item, maxCols, readFile, mdPath);
    if (mdViewerLines.length > 0) {
      lines.push('');
      lines.push(` ${ANSI.underline}Episode file (md viewer)${ANSI.reset}`);
      lines.push('');
      lines.push(...mdViewerLines);
    }
  }

  // Ensure every line fits within the terminal width
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      lines[i] = truncateLine(lines[i], maxCols);
    }
  }

  lines.push(separator);
  lines.push(` ${ANSI.dim}[↑↓/j:k] scroll  [g/G] top/bot  [esc] back  [q] quit  [click] select  [dbl-click] open  [wheel] scroll${ANSI.reset}`);

  return lines;
}

/**
 * Render a Key Files: .md document (e.g. an episode .podcast.md) for the
 * detail view via the generic markdown viewer.
 *
 * @param item - The work item whose description carries a `Key Files:` path.
 * @param maxCols - Terminal width.
 * @param readFile - Synchronous file reader (path -> content or null).
 * @param mdPath - Optional explicit .md path to render. When omitted,
 *   falls back to the first .md Key File (existing auto-render behavior).
 * @returns Viewer lines, or [] when no readable .md file is referenced.
 */
export function renderFileViewer(
  item: WorkItem | null,
  maxCols: number,
  readFile: (filePath: string) => string | null,
  mdPath?: string,
): string[] {
  if (!item) return [];
  const path = mdPath ?? firstMarkdownKeyFile(item.description);
  if (!path) return [];
  const content = readFile(path);
  if (content == null) return [];
  return renderMarkdownViewer(content, maxCols);
}

// ── Note-edit write-back (WL-0MSKV6SKK008MMXR) ────────────────────────

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

/**
 * Read a markdown file, apply an inline-note edit, and write it back.
 *
 * Pure with respect to the document text (via `md-note-edit.ts`): every
 * byte outside the edited paragraph is preserved.  The file reader/writer
 * are dependency-injected so the flow is side-effect-free and testable
 * (the viewer passes `readKeyFile` / a `writeKeyFile` bound to
 * `resolveKeyFilePath`).
 *
 * @param item - The work item whose Key Files carry the document.
 * @param mdPath - The Key Files path of the markdown document.
 * @param action - The edit to apply.
 * @param readFile - Reads the file content (path -> content or null).
 * @param writeFile - Persists the updated content (path, content).
 * @param episodeItems - Optional candidate episode work items (PRD §7.3
 *   note-child sync). When provided, inserts on a podcast script with a
 *   resolvable episode create a note child via `wl create --parent
 *   <episode>` and write the real note-child id into the marker (via
 *   `addNoteWithSync`); removes of a real (non-LOCAL) note id mark the
 *   marker `DONE` and post a resolution comment on the child (via
 *   `resolveNoteWithSync`). Omit (or pass []) for generic markdown — the
 *   local-only path never invokes `wl`.
 * @returns The edit result (doc, byteOffset, newNoteId for inserts).
 */
export async function applyNoteEditToFile(
  item: WorkItem | null,
  mdPath: string,
  action: NoteEditAction,
  readFile: (filePath: string) => string | null | Promise<string | null>,
  writeFile: (filePath: string, content: string) => void | Promise<void>,
  episodeItems?: WorkItem[],
): Promise<NoteEditResult> {
  if (!item) return { doc: '', byteOffset: -1 };
  const content = await readFile(mdPath);
  if (content == null) return { doc: '', byteOffset: -1 };

  let result: NoteEditResult;
  if (action.kind === 'insert') {
    if (episodeItems && episodeItems.length > 0) {
      // Podcast path: create the note child and write the real id (PRD
      // §7.3); unresolvable episode → LOCAL placeholder + warning.
      result = await addNoteWithSync(
        content,
        action.paragraphIndex ?? 0,
        action.text ?? '',
        episodeItems,
      );
    } else {
      // Generic markdown: local placeholder ids only — never invokes wl.
      result = insertNoteMarker(content, action.paragraphIndex ?? 0, action.text ?? '');
    }
  } else if (action.kind === 'update') {
    result = updateNoteMarker(content, action.noteId ?? '', {
      text: action.text ?? '',
      done: action.done,
    });
  } else if (action.kind === 'remove') {
    const noteId = action.noteId ?? '';
    const isLocal = noteId.startsWith('LOCAL-');
    if (episodeItems && episodeItems.length > 0 && noteId && !isLocal) {
      // Podcast delete/resolve: DONE marker + resolution comment on the
      // note child (PRD §7.3).
      result = await resolveNoteWithSync(
        content,
        noteId,
        action.text ?? 'Resolved via Herdr',
        episodeItems,
      );
    } else {
      result = removeNoteMarker(content, noteId);
    }
  } else {
    result = { doc: content, byteOffset: -1 };
  }
  if (result.byteOffset >= 0) {
    await writeFile(mdPath, result.doc);
  }
  return result;
}

/**
 * Build the candidate episode work items for PRD §7.3 note-child sync.
 *
 * The selected work item (an episode's Key Files include the script) plus
 * the loaded worklist items, deduplicated by id.  Used to resolve the
 * episode for a podcast script via `resolveEpisodeId`; generic markdown
 * yields an empty candidate set and stays local-only (never invokes `wl`).
 */
function buildEpisodeCandidates(state: WorkItemListState): WorkItem[] {
  const seen = new Set<string>();
  const candidates: WorkItem[] = [];
  const add = (item: WorkItem | null | undefined): void => {
    if (!item) return;
    if (seen.has(item.id)) return;
    seen.add(item.id);
    candidates.push(item);
  };
  add(state.detailItem);
  for (const item of state.getFlattenedItems()) {
    add(item);
  }
  return candidates;
}
/**
 * Return the first `Key Files:` path ending in `.md` (or empty).
 *
 * Mirrors the `Key Files:` convention used by Worklog descriptions; the
 * plugin's `extractFilePaths` in grouping.ts provides the full list, and
 * this helper picks the first markdown document among them.
 */
export function firstMarkdownKeyFile(description: string | undefined): string {
  if (!description) return '';
  const paths = extractFilePaths(description);
  const md = paths.find(p => p.endsWith('.md'));
  return md ?? '';
}

/**
 * Resolve a `Key Files:` markdown path to an absolute filesystem path.
 *
 * Key Files paths are documented as relative to the worklog root, but the
 * plugin pane's process CWD is the plugin source directory — NOT the worklog
 * root — so resolving against `process.cwd()` alone is wrong
 * (WL-0MSGEA9AY0080V4Q). Candidates are tried in order:
 *
 * 1. the resolved worklog root (the directory containing `.worklog/`,
 *    derived from the configured worklog dir — see configureWorklogTarget /
 *    HERDR_RESOLVED_CWD),
 * 2. the legacy podcast-relative base `<root>/.llm-wiki/wiki/podcast/`
 *    (older episode items wrote Key Files paths relative to the podcast dir
 *    rather than the wiki root),
 * 3. `process.cwd()` as a last resort (plain CWD-relative key paths).
 *
 * Fail-open: returns null when no candidate exists on disk, so the detail
 * view falls back to the raw description.
 */
export function resolveKeyFilePath(filePath: string): string | null {
  const bases: string[] = [];
  const wlDir = getWorklogDir();
  if (wlDir) {
    const wlRoot = dirname(wlDir);
    bases.push(wlRoot);
    bases.push(join(wlRoot, '.llm-wiki', 'wiki', 'podcast'));
  }
  bases.push(process.cwd());
  for (const base of bases) {
    try {
      const candidate = resolvePath(base, filePath);
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore unreadable base and try the next candidate.
    }
  }
  return null;
}

/**
 * Format the detail view for a single work item, with scrolling support.
 *
 * @param item - The work item to display
 * @param maxCols - Terminal width
 * @param scrollOffset - Line offset to scroll the content
 * @param viewportHeight - Number of visible lines (default: terminal rows - 4)
 * @returns The rendered detail view string
 */
/** Fixed height of the detail-view header block (blank, id, title, separator). */
const DETAIL_HEADER_LINES = 4;

export function formatDetailView(
  item: WorkItem | null,
  maxCols: number,
  scrollOffset = 0,
  viewportHeight = 20,
  readFile?: (filePath: string) => string | null,
  noIcons = false,
  detailToCIndex = 0,
  detailToCFocus = true,
  detailRenderedIndex = 0,
): string {
  // The Related Docs ToC is pinned at the top of the detail view; only the
  // body below it scrolls (WL-0MSHWHULZ001FL8I).
  const tocLines = formatDetailToC(item, maxCols, detailToCIndex, detailToCFocus, noIcons);
  const allLines = formatDetailContent(item, maxCols, readFile, noIcons, detailToCIndex, detailToCFocus, detailRenderedIndex);
  if (allLines.length === 0) return '';

  const pinnedHeight = DETAIL_HEADER_LINES + tocLines.length;
  const bodyLines = allLines.slice(pinnedHeight);
  const bodyViewport = Math.max(1, viewportHeight - pinnedHeight);
  const totalBodyLines = bodyLines.length;
  const maxScroll = Math.max(0, totalBodyLines - bodyViewport);
  const safeOffset = Math.min(scrollOffset, maxScroll);

  const visible = [
    ...allLines.slice(0, pinnedHeight),
    ...bodyLines.slice(safeOffset, safeOffset + bodyViewport),
  ];

  // Add scroll indicator if the body is long
  if (totalBodyLines > bodyViewport && safeOffset <= maxScroll) {
    const percent = totalBodyLines > 0
      ? Math.round(((safeOffset + bodyViewport) / totalBodyLines) * 100)
      : 0;
    const scrollInfo = ` ${ANSI.dim}Lines ${safeOffset + 1}-${Math.min(safeOffset + bodyViewport, totalBodyLines)} of ${totalBodyLines} (${percent}%)  ` +
      `[↑↓/j:k scroll  g/G top/bot]${ANSI.reset}`;
    visible[visible.length - 1] = scrollInfo;
  }

  // Pad to fill viewport if less content
  while (visible.length < viewportHeight) {
    visible.push('');
  }

  return visible.join('\n');
}

/**
 * Format the filter selection prompt.
 */
export function formatFilterPrompt(maxCols: number): string {
  const options = STAGES.map((s, i) => {
    const color = STAGE_COLORS[s] || 241;
    return `${ANSI.fg(color)}[${i}] ${s}${ANSI.reset}`;
  }).join('  ');

  const lines = [
    '',
    ` ${ANSI.bold}Filter by stage:${ANSI.reset}`,
    ` ${options}`,
    '',
    ` ${ANSI.dim}[0-5] select stage  [esc] cancel${ANSI.reset}`,
  ];
  return lines.join('\n');
}

// ── Chord state helpers ───────────────────────────────────────────────

/**
 * Create an initial (empty) ChordState.
 */
export function createChordState(): ChordState {
  return {
    pendingKeys: [],
    hints: '',
    resolvedCommand: null,
    resolvedModel: null,
    resolvedOpenPane: undefined,
  };
}

/**
 * Check if a key matches any chord leader in the registry.
 */
export function isChordLeader(key: string, registry: ShortcutRegistry, codeFreezeActive?: boolean, issueType?: string): boolean {
  const chords = registry.getChordEntries(codeFreezeActive, issueType);
  return chords.some(c => {
    const chord = c.chord;
    return chord !== undefined && chord.length >= 1 && chord[0] === key;
  });
}

/**
 * Process a keypress when in chord mode.
 *
 * Returns 'chord-complete' if the chord resolved, 'chord-cancel' if the
 * key is invalid and the chord should be cancelled, or null if still
 * collecting keys.
 */
export function processChordInput(
  chordState: ChordState,
  key: string,
  registry: ShortcutRegistry,
  view: string,
  stage?: string,
  codeFreezeActive?: boolean,
  issueType?: string,
): 'chord-complete' | 'chord-cancel' | null {
  const pending = [...chordState.pendingKeys, key];

  // Check if this completes a chord
  const entry = registry.lookupChordEntry(pending, view, stage, codeFreezeActive, issueType);
  if (entry) {
    chordState.pendingKeys = [];
    chordState.hints = '';
    chordState.resolvedCommand = entry.command;
    chordState.resolvedModel = entry.model ?? null;
    // openPane is undefined when the entry did not set open_pane → the
    // dispatch defaults to opening a pane (WL-0MSJLD1I70045ZUL).
    chordState.resolvedOpenPane = entry.openPane ?? undefined;
    return 'chord-complete';
  }

  // Check if this is a valid prefix for more chords
  const nextChords = registry.getChordByPrefix(pending, view, stage, codeFreezeActive, issueType);
  if (nextChords.length > 0) {
    chordState.pendingKeys = pending;
    // Update hints
    chordState.hints = formatChordHintsForHelp(nextChords, pending);
    return null; // Still collecting
  }

  // Invalid — cancel chord
  chordState.pendingKeys = [];
  chordState.hints = '';
  return 'chord-cancel';
}

/**
 * Build hint string for chord-mode display.
 *
 * Groups chords by next expected key and collapses multiple entries sharing
 * the same nextKey into a single `<key>:<firstWord>...` entry. Strips
 * consumed words from labels based on pending chord depth.
 *
 * @param chords - Chord entries to format (already filtered by prefix/view/stage)
 * @param pendingKeys - Current pending chord prefix
 * @returns Space-joined hint string, or empty string if no hints remain
 */
export function formatChordHintsForHelp(
  chords: ShortcutEntry[],
  pendingKeys: string[],
): string {
  const nextIdx = pendingKeys.length;

  type HintEntry = { nextKey: string; hint: string; firstRestWord: string };
  const hints: HintEntry[] = [];

  const extractLabel = (e: ShortcutEntry): string => {
    return e.label ?? e.command
      .replace(/<[^>]+>/g, '')
      .split(/\r?\n/)[0]
      .trim()
      .replace(/^\/(skill:)?/, '');
  };

  for (const c of chords) {
    const chord = c.chord;
    if (!chord || chord.length <= nextIdx) continue;

    const nextKey = chord[nextIdx];
    const label = extractLabel(c);
    const words = label.split(/\s+/);
    // Strip consumed words equal to pending chord depth
    const stripCount = Math.min(pendingKeys.length, Math.max(0, words.length - 1));
    const rest = words.slice(stripCount);
    const firstRestWord = rest.length > 0 ? rest[0] : (words.length > 0 ? words[words.length - 1] : '');
    const hint = rest.length > 0 ? `${nextKey}:${rest.join(' ')}` : nextKey;

    hints.push({ nextKey, hint, firstRestWord });
  }

  // Group by nextKey and collapse
  const byKey = new Map<string, HintEntry[]>();
  for (const h of hints) {
    const group = byKey.get(h.nextKey) ?? [];
    group.push(h);
    byKey.set(h.nextKey, group);
  }

  const result: string[] = [];
  for (const [, group] of byKey) {
    if (group.length > 1) {
      // Collapse: show first word with ellipsis
      result.push(`${group[0].nextKey}:${group[0].firstRestWord}...`);
    } else {
      result.push(group[0].hint);
    }
  }

  return result.join('  ');
}

/**
 * Get chord hints for showing in the help bar when in list mode.
 * Shows leader keys and abbreviated labels for all chords.
 */
export function getChordHelpHints(registry: ShortcutRegistry | undefined, codeFreezeActive?: boolean, issueType?: string): string {
  if (!registry) return '';
  const chords = registry.getChordEntries(codeFreezeActive, issueType);
  // Group by leader key
  const byLeader = new Map<string, string[]>();
  for (const c of chords) {
    const chord = c.chord;
    if (!chord || chord.length < 2) continue;
    const [leader] = chord;
    const label = c.label ?? c.command.replace(/<[^>]+>/g, '').split(/\r?\n/)[0].trim();
    const group = byLeader.get(leader) ?? [];
    group.push(`${leader}→${label.split(/\s+/)[0]}`);
    byLeader.set(leader, group);
  }
  if (byLeader.size === 0) return '';
  return ` [${[...byLeader.keys()].join('/')}] chords`;
}

// ── Keyboard handling ─────────────────────────────────────────────────

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
}

/**
 * Map special key sequences to action names.
 */
export function keyToAction(key: string): KeyAction {
  switch (key) {
    case '\x1b[A':
    case 'k':
      return 'up';
    case '\x1b[B':
    case 'j':
      return 'down';
    case '\x1b[5~':
    case '\x1b[V': // Some terminals send this for page up
      return 'pageup';
    case '\x1b[6~':
    case '\x1b[U': // Some terminals send this for page down
      return 'pagedown';
    case '\r':
    case '\n':
      return 'select';
    case '\t':
      return 'toggle-expand';
    case '\x1b':
      return 'back';
    // '/' filter prompt removed — use f-* chords instead
    // 'r' is a single-key Producer Review shortcut — resolved via ShortcutRegistry
    // 'S' is the Ship It shortcut — resolved via ShortcutRegistry (opens the
    // typed-confirmation dialog, WL-0MSGG5N5Z0074TLY). The manual-sync 'S'
    // binding was removed; auto-sync on the timer is unaffected.
    case 'q':
      return 'quit';
    case 'g':
      return 'first';
    case 'G':
      return 'last';
    case 'm':
      return 'meta-down';
    case 'M':
      return 'meta-up';
    default:
      return null;
  }
}

/**
 * Handle a keypress in the current state. Returns the action performed
 * (or null if unrecognized).
 *
 * @param state - The current list state (mutated in place)
 * @param key - The raw keypress string
 * @param termSize - Current terminal dimensions
 * @param panelHeight - Dynamic metadata panel height (WL-0MSQ44MDX008U69J),
 *                      used to clamp m/M metadata scrolling; falls back to
 *                      the legacy fixed-height computation when omitted.
 * @returns The action string, or null if unhandled
 */
export function handleKeypress(
  state: WorkItemListState,
  key: string,
  termSize: TermSize,
  panelHeight?: number,
): KeyAction {
  if (state.mode === 'detail') {
    if (key === '\x1b' || key === 'q') {
      state.back();
      return 'back';
    }

    // Related Docs ToC navigation (WL-0MSHWHULZ001FL8I). When the item has
    // ≥1 .md Key File and keyboard focus is on the ToC (detailToCFocus),
    // j/k/arrows move the ToC selection; Enter renders the selected doc.
    // Navigating past the last entry transfers focus to document scrolling.
    const mdCount = state.detailItem
      ? extractFilePaths(state.detailItem.description ?? '').filter(p => p.endsWith('.md')).length
      : 0;
    const hasToC = mdCount > 0;

    if (hasToC && state.detailToCFocus) {
      if (key === 'j' || key === '\x1b[B') {
        if (state.detailToCIndex < mdCount - 1) {
          state.detailToCIndex += 1;
        } else {
          // Past the last entry → document scrolling focus
          state.detailToCFocus = false;
        }
        return null;
      }
      if (key === 'k' || key === '\x1b[A') {
        if (state.detailToCIndex > 0) {
          state.detailToCIndex -= 1;
        }
        return null;
      }
      if (key === '\r' || key === '\n') {
        // Enter renders the selected document in the md viewer
        state.detailRenderedIndex = state.detailToCIndex;
        return null;
      }
      if (key === 'g') {
        state.detailToCIndex = 0;
        return null;
      }
      if (key === 'G') {
        state.detailToCIndex = mdCount - 1;
        return null;
      }
      return null;
    }

    // Detail scrolling — when the item has a ToC this branch runs while
    // focus is on the document; k at the top of the document returns focus
    // to the ToC (WL-0MSHWHULZ001FL8I).
    if (key === 'j' || key === '\x1b[B') {
      state.detailScrollDown(1);
      return null;
    }
    if (key === 'k' || key === '\x1b[A') {
      if (hasToC && state.detailScrollOffset <= 0) {
        state.detailToCFocus = true;
      } else {
        state.detailScrollUp(1);
      }
      return null;
    }
    if (key === '\x1b[6~') {
      // Page down
      const pageSize = Math.max(5, termSize.rows - 4);
      state.detailScrollDown(pageSize);
      return null;
    }
    if (key === '\x1b[5~') {
      // Page up
      const pageSize = Math.max(5, termSize.rows - 4);
      state.detailScrollUp(pageSize);
      return null;
    }
    if (key === 'g') {
      state.detailScrollOffset = 0;
      return null;
    }
    if (key === 'G') {
      state.detailScrollOffset = 999999;
      return null;
    }
    return null;
  }

  if (state.mode === 'filter') {
    if (key === '\x1b') {
      state.back();
      return 'back';
    }
    // Digit keys select a stage by index
    const digit = parseInt(key, 10);
    if (!isNaN(digit) && digit >= 0 && digit < STAGES.length) {
      state.applyFilter(STAGES[digit]);
      return 'filter';
    }
    return null;
  }

  // List mode
  // Esc dismissal of a hover tooltip (WL-0MT9XRZDK006GMUH AC2): when the
  // tooltip is currently showing, Esc only dismisses it — the navigation
  // stack is never popped and the list selection is untouched. The tooltip
  // reappears on the next mouse re-entry over a pane-associated row.
  if (key === '\x1b' && state.hoveredRowIndex !== null && !state.tooltipDismissed) {
    state.hoveredRowIndex = null;
    state.tooltipDismissed = true;
    return 'dismiss-tooltip';
  }
  const action = keyToAction(key);
  switch (action) {
    case 'up':
      state.moveUp();
      break;
    case 'down':
      state.moveDown();
      break;
    case 'pageup':
      state.pageUp();
      break;
    case 'pagedown':
      state.pageDown();
      break;
    case 'select':
      if (state.mode === 'list' && state.selectedIndex >= 0) {
        const selected = state.getSelectedItem();
        // Toggle expand/collapse for items with actual children data at
        // ANY depth (WL-0MSQ3FH1K000MMJW): Enter on a child with children
        // expands it like a top-level parent, instead of opening the
        // detail view. Heading rows have no item (null) and fall through
        // to selectItem(), which is a no-op for headings.
        if (selected && selected.children && selected.children.length > 0) {
          if (state.isExpanded(selected.id)) {
            // Collapsing — remove the matching navigation-stack entry so
            // a later Escape does not pop back into a collapsed parent.
            state.clearNavigationStateFor(selected.id);
          } else {
            // Drilling down — save the current (parent) scroll/selection
            // state so Escape can return to it.
            state.pushNavigationState(selected.id);
          }
          state.toggleExpand(selected.id);
          return 'toggle-expand';
        }
      }
      state.selectItem();
      return 'select';
    case 'back':
      // If navigation stack is non-empty, pop to parent context
      if (!state.navigationStack.isEmpty && state.mode === 'list') {
        const entry = state.popNavigationState();
        if (entry) {
          // Collapse the parent we're returning to, so the view is clean
          if (state.isExpanded(entry.parentId)) {
            state.toggleExpand(entry.parentId);
          }
          return 'back';
        }
      }
      state.back();
      break;
    case 'filter':
      state.activateFilter();
      return 'filter';
    case 'refresh':
      return 'refresh';
    case 'quit':
      return 'quit';
    case 'first':
      state.goToFirst();
      break;
    case 'last':
      state.goToLast();
      break;
    case 'meta-down':
      // Scroll the metadata panel (independent of list navigation)
      state.metaScrollDown(1, panelHeight);
      break;
    case 'meta-up':
      state.metaScrollUp(1);
      break;
    case 'toggle-expand':
      if (state.mode === 'list' && state.selectedIndex >= 0 && state.items.length > 0) {
        const selected = state.getSelectedItem();
        if (selected) {
          // Any item with children — at ANY depth — can be expanded/
          // collapsed with Tab (WL-0MSQ3FH1K000MMJW). Children data is
          // fetched on demand by the caller when not yet loaded.
          if (selected.childCount && selected.childCount > 0) {
            // Track hierarchy: push parent state before expanding so Escape
            // can return to it; drop the entry when collapsing.
            if (state.isExpanded(selected.id)) {
              state.clearNavigationStateFor(selected.id);
            } else {
              state.pushNavigationState(selected.id);
            }
            // If children data already loaded, toggle inline
            if (selected.children && selected.children.length > 0) {
              state.toggleExpand(selected.id);
            }
            // Return action so caller can fetch children on demand
            return 'toggle-expand';
          }
        } else {
          // Heading row selected — Tab toggles that group's collapse state
          // (WL-0MSL5MPSZ003TG94 AC3). Handled inline (no on-demand fetch,
          // no navigation-stack churn); the heading row itself stays
          // visible so the group can be re-expanded.
          const row = state.getSelectedDisplayRow();
          if (row !== null && isHeadingRow(row)) {
            state.toggleGroupCollapse(row.group);
            state.clampSelection();
            return null;
          }
        }
      }
      return null;
  }
  return action;
}

// ── Mouse / touch input (WL-0MSGHM5BQ0096BNJ) ─────────────────────────
// SGR mouse-event parsing, split-chunk buffering, and click/wheel/filter
// row mapping for the selection list. Implements the contract pinned by the
// test-first suite packages/herdr/src/worklist-mouse.test.ts
// (WL-0MSI720DX002E9WC): ANSI mouseEnable/mouseDisable lifecycle constants
// (on the ANSI object), the pure SGR parser, the chunk consumer, and the
// state-aware action mapper.

/** Raw SGR mouse sequence: ESC [ < b ; x ; y M|m (M = press, m = release). */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** A plausible partial SGR body: the ESC prefix plus digits/semicolons only
 * (e.g. '\x1b[<0;10;') — still awaiting its terminating M/m. */
const SGR_PARTIAL_RE = /^\x1b\[<[0-9;]*$/;

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

/** Double-click window in ms (WL-0MSGHM5BQ0096BNJ AC3); boundary
 * inclusive (<=). */
export const DOUBLE_CLICK_WINDOW_MS = 400;

/** Prior left-press coordinates plus an injectable clock for deterministic
 * double-click tests. */
export interface MouseClickState {
  /** The previous left-press position/time, or null when none. */
  lastClick: { x: number; y: number; at: number } | null;
  /** Current clock (ms) — injected for deterministic tests. */
  now: number;
}

/** Dispatchable mouse action — mirrors the list/detail/filter key paths. */
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
  | null; // inert: chrome rows, motion, releases, unknown buttons

/**
 * Parse a COMPLETE SGR mouse sequence ('\x1b[<b;x;yM' press or
 * '\x1b[<b;x;y m' release). Pure: returns null for any non-mouse input and
 * never buffers — split sequences are handled by {@link consumeMouseChunk}.
 */
export function parseMouseEvent(key: string): ParsedMouseEvent | null {
  const m = SGR_MOUSE_RE.exec(key);
  if (!m) return null;
  return {
    button: parseInt(m[1], 10),
    x: parseInt(m[2], 10),
    y: parseInt(m[3], 10),
    release: m[4] === 'm',
  };
}

/** Module-level buffer holding a partial SGR prefix across stdin chunks. */
let mouseChunkBuffer = '';

/**
 * Feed a stdin chunk to the SGR parser, holding a partial prefix
 * ('\x1b[<0;10;') in a module-level buffer until the terminating M/m
 * arrives in a later chunk (AC1 risk mitigation). Foreign escape sequences
 * (cursor moves, screen clears) leave a pending partial untouched; plain
 * input clears any stale pending partial so a stale tail can never complete
 * later.
 */
export function consumeMouseChunk(chunk: string): ParsedMouseEvent | null {
  if (chunk.startsWith('\x1b')) {
    // Escape-sequence chunk: a complete SGR parses and clears; a partial
    // SGR prefix starts buffering; any other control sequence is ignored.
    const complete = parseMouseEvent(chunk);
    if (complete) {
      mouseChunkBuffer = '';
      return complete;
    }
    if (mouseChunkBuffer === '' && SGR_PARTIAL_RE.test(chunk)) {
      mouseChunkBuffer = chunk;
    }
    return null;
  }
  // Non-escape chunk: the tail of a split sequence, or plain input.
  const combined = mouseChunkBuffer + chunk;
  const complete = parseMouseEvent(combined);
  if (complete) {
    mouseChunkBuffer = '';
    return complete;
  }
  if (SGR_PARTIAL_RE.test(combined)) {
    // Still a plausible partial body — keep buffering.
    mouseChunkBuffer = combined;
    return null;
  }
  // Plain input clears any stale pending partial.
  mouseChunkBuffer = '';
  return null;
}

/**
 * The list-mode row budget the renderer uses for the visible window — the
 * header, fold indicators, footer and metadata panel are chrome rows and
 * never map to display rows. Mirrors createListRenderer's window computation
 * so click mapping can never diverge from what is drawn.
 *
 * With the display-rows model (WL-0MSL5MPSZ003TG94) heading rows are
 * first-class rows in the window, so no extra separator accounting is needed.
 */
interface ListRowLayout {
  topIndicator: boolean;
  bottomIndicator: boolean;
  visibleStart: number;
  visibleCount: number;
}

function computeListRowLayout(state: WorkItemListState, termSize: TermSize): ListRowLayout {
  const displayRows = state.getDisplayRows();
  // Use dynamic layout with bannerCount=0 — this path is the mouse click
  // mapper and does not have the banner state; the layout is a close
  // approximation that keeps click mapping consistent with the renderer.
  const { listArea, listHeight } = computeDynamicLayout(
    displayRows,
    state.scrollOffset,
    /* bannerCount = */ 0,
    termSize,
  );
  const chromeLines = 2; // header + footer (no banners in this path)
  const budgetForRows = Math.max(0, listArea - chromeLines);

  let visible = displayRows.slice(state.scrollOffset, state.scrollOffset + listHeight);
  while (visible.length > 0 && visible.length > budgetForRows) {
    visible = visible.slice(0, -1);
  }
  const hasTopIndicator = state.scrollOffset > 0;
  const hasBottomIndicator = state.scrollOffset + visible.length < displayRows.length;
  const indicatorRows = (hasTopIndicator ? 1 : 0) + (hasBottomIndicator ? 1 : 0);
  const effectiveBudget = budgetForRows - indicatorRows;
  while (visible.length > 0 && visible.length > effectiveBudget) {
    visible = visible.slice(0, -1);
  }
  const bottomIndicator = state.scrollOffset + visible.length < displayRows.length;

  return {
    topIndicator: hasTopIndicator,
    bottomIndicator,
    visibleStart: state.scrollOffset,
    visibleCount: visible.length,
  };
}

/** Map a 1-based list row to the display-row index under it, or null when
 * the row is chrome (header, fold indicator, footer, panel). Heading rows
 * map to their own display-row index (they are selectable, WL-0MSL5MPSZ003TG94). */
function mapListRowToIndex(state: WorkItemListState, y: number, termSize: TermSize): number | null {
  if (y <= 1) return null; // header
  const displayRows = state.getDisplayRows();
  const { listArea } = computeDynamicLayout(
    displayRows,
    state.scrollOffset,
    /* bannerCount = */ 0,
    termSize,
  );
  if (y > 1 + listArea) return null; // footer, metadata panel, notification
  const layout = computeListRowLayout(state, termSize);
  let row = 2;
  if (layout.topIndicator) {
    if (y === 2) return null; // '▲ more'
    row = 3;
  }
  for (let i = 0; i < layout.visibleCount; i++) {
    if (y === row) return layout.visibleStart + i;
    row++;
  }
  return null; // '▼ more' or blank fill
}

/** Map a tapped column on the filter-prompt options row (y=3) to a stage
 * index — the option spans '[i] name' (AC5). */
function filterStageIndexForColumn(x: number): number | null {
  let col = 1; // leading space — '[i]' starts at column 2
  for (let i = 0; i < STAGES.length; i++) {
    const start = col + 1;
    const span = `[${i}] ${STAGES[i]}`.length;
    if (x >= start && x < start + span) return i;
    col += span + 2; // two-space separator
  }
  return null;
}

/**
 * Map a parsed SGR mouse event to a dispatchable action for the current
 * state. Gate rules (WL-0MSGHM5BQ0096BNJ AC2–AC6): release events and
 * motion (button & 32) are inert; wheel 64/65 navigate (list) or scroll the
 * detail (detail) and are ignored in filter mode; only the left button
 * selects; two left presses on the same row within
 * {@link DOUBLE_CLICK_WINDOW_MS} open the detail view (list mode) or go
 * back (detail mode); filter-mode taps on the stage-options row select a
 * stage.
 */
export function mapMouseToAction(
  state: WorkItemListState,
  ev: ParsedMouseEvent,
  termSize: TermSize,
  clickState?: MouseClickState,
): MouseAction {
  // Release events are consumed but inert — presses drive selection (AC6).
  if (ev.release) return null;
  // Motion events (button & 32): never navigate, but trigger hover tooltip
  // in list mode (WL-0MT9XRZDK006GMUH). They remain inert in detail/filter.
  if ((ev.button & 32) !== 0) {
    if (state.mode === 'list') {
      const index = mapListRowToIndex(state, ev.y, termSize);
      // Motion over a visible list row → hover-row (tooltip candidate).
      // Motion over chrome/blank rows (header, fold indicators, footer,
      // panel) → hover-none: the pointer has left the rows area, allowing
      // a dismissed tooltip to re-show on the next re-entry (AC2).
      return index !== null ? { type: 'hover-row', index } : { type: 'hover-none' };
    }
    return null; // detail/filter: motion is inert
  }
  // Wheel buttons 64/65 (AC4).
  if (ev.button === 64) {
    if (state.mode === 'list') return { type: 'wheel-up' };
    if (state.mode === 'detail') return { type: 'scroll-detail-up' };
    return null; // filter mode: wheel ignored (plan A2)
  }
  if (ev.button === 65) {
    if (state.mode === 'list') return { type: 'wheel-down' };
    if (state.mode === 'detail') return { type: 'scroll-detail-down' };
    return null;
  }
  // Only the left button (0) selects/taps; middle/right are inert.
  if (ev.button !== 0) return null;

  // Double-click: same coordinates within DOUBLE_CLICK_WINDOW_MS (AC3,
  // inclusive boundary), mirroring the previous press.
  const isDoubleClick = clickState !== undefined
    && clickState.lastClick !== null
    && clickState.lastClick.x === ev.x
    && clickState.lastClick.y === ev.y
    && clickState.now - clickState.lastClick.at <= DOUBLE_CLICK_WINDOW_MS;

  if (isDoubleClick) {
    if (state.mode === 'detail') return { type: 'back' };
    if (state.mode === 'list') {
      const index = mapListRowToIndex(state, ev.y, termSize);
      // Repeated clicks on inert rows stay inert (AC3).
      return index !== null ? { type: 'open-detail' } : null;
    }
    // filter mode: fall through to the single-tap mapping below.
  }

  if (state.mode === 'detail') return null; // single clicks are inert
  if (state.mode === 'filter') {
    if (ev.y !== 3) return null; // AC5: only the options row is tappable
    const index = filterStageIndexForColumn(ev.x);
    return index !== null ? { type: 'filter-stage', index } : null;
  }
  const index = mapListRowToIndex(state, ev.y, termSize);
  return index !== null ? { type: 'select-row', index } : null;
}

/**
 * Wire a raw stdin chunk into the mouse path — the onData entry point
 * (WL-0MSGHM5BQ0096BNJ AC2–AC6, fix WL-0MSZBWT500034E74). Parses SGR mouse
 * events via {@link consumeMouseChunk}, maps them to an action via
 * {@link mapMouseToAction}, dispatches it against `state` (mirroring the
 * handleKeypress action handling), and tracks the double-click window in
 * `clickState`.
 *
 * Returns true when the chunk was mouse-shaped (fully consumed — it must
 * NOT reach the keyboard path); false for plain keys and foreign escape
 * sequences (arrows, etc.) so keyboard handling is untouched (AC6). A
 * partial SGR prefix is consumed (buffered) rather than leaked to the
 * keyboard path, per the split-chunk risk mitigation.
 *
 * Double-click ordering (fix): the clickState tracker is updated to the
 * current left-press AFTER mapMouseToAction runs, so the window compares
 * against the PRIOR press. Updating before the call made every click
 * self-match as a double-click (now - at === 0), opening detail instead of
 * selecting. Only left-button presses (not releases, wheel, or motion)
 * advance the tracker.
 */
export function handleMouseInput(
  state: WorkItemListState,
  key: string,
  termSize: TermSize,
  clickState: MouseClickState,
): boolean {
  const bufferBefore = mouseChunkBuffer;
  const mouseEvent = consumeMouseChunk(key);
  if (mouseEvent === null) {
    // Not a complete mouse event. An ESC chunk that matches the partial SGR
    // prefix, or a non-ESC chunk that touched a pending partial (grew or
    // cleared it), is mouse-shaped — consume it so a split sequence never
    // leaks into the keyboard path. Other input falls through to keys.
    if (key.startsWith('\x1b')) {
      return SGR_PARTIAL_RE.test(key);
    }
    return mouseChunkBuffer !== bufferBefore;
  }

  // Current clock for the double-click window (Date.now; deterministic
  // tests inject clickState directly into mapMouseToAction instead).
  const now = Date.now();
  clickState.now = now;
  const action = mapMouseToAction(state, mouseEvent, termSize, clickState);

  // Advance the tracker AFTER the double-click check — the next event's
  // window compares against THIS press (fix WL-0MSZBWT500034E74).
  if (!mouseEvent.release && mouseEvent.button === 0) {
    clickState.lastClick = { x: mouseEvent.x, y: mouseEvent.y, at: now };
  }

  if (action === null) return true; // consumed but inert (motion, release, chrome)

  // Dispatch mouse actions (mirrors the handleKeypress action handling).
  switch (action.type) {
    case 'select-row': {
      const rows = state.getDisplayRows();
      if (action.index >= 0 && action.index < rows.length) {
        state.selectedIndex = action.index;
      }
      break;
    }
    case 'open-detail': {
      const selected = state.getSelectedItem();
      if (selected) {
        // Toggle expand/collapse for items with actual children data.
        if (selected.children && selected.children.length > 0) {
          if (state.isExpanded(selected.id)) {
            state.clearNavigationStateFor(selected.id);
          } else {
            state.pushNavigationState(selected.id);
          }
          state.toggleExpand(selected.id);
        } else {
          state.selectItem();
        }
      }
      break;
    }
    case 'back':
      state.back();
      break;
    case 'wheel-up':
      state.moveUp();
      break;
    case 'wheel-down':
      state.moveDown();
      break;
    case 'scroll-detail-up':
      if (state.detailItem) state.detailScrollUp(1);
      break;
    case 'scroll-detail-down':
      if (state.detailItem) state.detailScrollDown(1);
      break;
    case 'filter-stage':
      if (action.index >= 0 && action.index < STAGES.length) {
        state.applyFilter(STAGES[action.index]);
      }
      break;
    case 'hover-row':
      // Update hovered row. The dismissed flag is intentionally NOT cleared
      // here (WL-0MT9XRZDK006GMUH AC2): after Esc, the tooltip stays hidden
      // while the pointer keeps moving within the rows area; only a
      // hover-none (pointer left the rows) clears the dismissal.
      state.hoveredRowIndex = action.index;
      break;
    case 'hover-none':
      // Pointer left the rows area — clear hover state and the dismissed
      // flag so a subsequent re-entry over a pane-row re-shows the tooltip.
      state.hoveredRowIndex = null;
      state.tooltipDismissed = false;
      break;
  }
  return true; // consumed a mouse event
}

// ── Renderer ──────────────────────────────────────────────────────────

/**
 * Create a list renderer function.
 *
 * Returns a function that produces the full screen content for the
 * current state. The caller should write this to stdout and handle
 * terminal setup/teardown.
 */
/**
 * Render the inline downtime-worker status fragment appended to the list
 * header (AC3, WL-0MSF49FMW009M06K): `[⏳ downtime idle m:ss]`,
 * `[downtime busy]`, `[⏳ downtime dispatching]`, `[Downtime Off]`,
 * `[Downtime Off (restored)]` (disable restored from the persisted marker,
 * WL-0MT5SG0VU005ARUR), or `[downtime paused]` (no-candidate cooldown,
 * WL-0MSI7DQL10016QYX).
 * `[Downtime Off]` replaces the legacy `[downtime disabled]` text and is
 * shown whenever dispatch is off for the instance — either globally
 * settings-disabled or toggled off via the `d` shortcut (parent
 * WL-0MSZ4NSOE007AQEF). The rendered state ALWAYS agrees with the worker's
 * effective gate (override ?? settings); a disabled pane never shows the
 * enabled-idle string.
 * Inline-only — it never adds a row, so the pane-height budget is intact.
 */
export function renderDowntimeStatus(worker: DowntimeWorker | undefined): string {
  if (!worker) return '';
  if (worker.dispatching) {
    return ` ${ANSI.fg(208)}[⏳ downtime dispatching]${ANSI.reset}`;
  }
  if (!worker.enabled) {
    // Header honesty (WL-0MT5SG0VU005ARUR): a worker whose disable was
    // RESTORED from the persisted marker (.herdr-downtime-disabled) shows an
    // explicit notice so the restored-disabled state is never silent — the
    // operator always sees why this pane is off even after a restart.
    if (worker.restoredFromMarker) {
      return ` ${ANSI.dim}[Downtime Off (restored)]${ANSI.reset}`;
    }
    return ` ${ANSI.dim}[Downtime Off]${ANSI.reset}`;
  }
  if (worker.paused) {
    // No-candidate cooldown: the worker is not polling, so `idleSince` is
    // stale/empty — render the honest paused state instead of a stale idle
    // duration (AC6, WL-0MSI7DQL10016QYX).
    return ` ${ANSI.dim}[downtime paused]${ANSI.reset}`;
  }
  if (worker.idleSince !== null) {
    const elapsedSecs = Math.max(0, Math.floor((Date.now() - worker.idleSince) / 1000));
    const minutes = Math.floor(elapsedSecs / 60);
    const seconds = elapsedSecs % 60;
    return ` ${ANSI.fg(34)}[⏳ downtime idle ${minutes}:${String(seconds).padStart(2, '0')}]${ANSI.reset}`;
  }
  return ` ${ANSI.dim}[downtime busy]${ANSI.reset}`;
}

export function createListRenderer(getShowIcons?: () => boolean): (
  displayRows: DisplayRow[],
  selectedIndex: number,
  scrollOffset: number,
  termSize: TermSize,
  // Display label of the active filter (axis-qualified, e.g. `stage
  // in_review` or `priority critical`; WL-0MSKC8T46006999S) or null when
  // unfiltered. Rendered as `(filtered: <label>)` in the header. Callers
  // pass `state.activeFilterLabel`.
  activeFilter: string | null,
  mode: ViewMode,
  detailItem: WorkItem | null,
  totalCount?: number,
  chordState?: ChordState | null,
  detailScrollOffset?: number,
  autoRefresh?: boolean,
  expandedItems?: Set<string>,
  chordHelpHints?: string,
  navStackDepth?: number,
  panePaused?: boolean,
  codeFreezeActive?: boolean,
  metaScrollOffset?: number,
  metaLastCommand?: string,
  readFile?: (filePath: string) => string | null,
  downtimeStatus?: string,
  detailToCIndex?: number,
  detailToCFocus?: boolean,
  detailRenderedIndex?: number,
  showHelpText?: boolean,
  codeFreezeAmbiguous?: boolean,
  hoverTooltip?: string[],
) => string {
  // Default to icons enabled when no getter is supplied (backwards
  // compatible — callers/tests that render without options keep icons).
  const showIconsGetter = getShowIcons ?? (() => true);
  return (
    displayRows: DisplayRow[],
    selectedIndex: number,
    scrollOffset: number,
    termSize: TermSize,
    activeFilter: string | null,
    mode: ViewMode,
    detailItem: WorkItem | null,
    totalCount?: number,
    chordState?: ChordState | null,
    detailScrollOffset?: number,
    autoRefresh?: boolean,
    expandedItems?: Set<string>,
    chordHelpHints?: string,
    navStackDepth?: number,
    panePaused?: boolean,
    codeFreezeActive?: boolean,
    metaScrollOffset?: number,
    metaLastCommand?: string,
    readFile?: (filePath: string) => string | null,
    downtimeStatus?: string,
    detailToCIndex?: number,
    detailToCFocus?: boolean,
    detailRenderedIndex?: number,
    showHelpText?: boolean,
    codeFreezeAmbiguous?: boolean,
    hoverTooltip?: string[],
  ): string => {
    const { rows, cols } = termSize;
    // Icons are gated by the getter for the whole frame (list lines, detail
    // view, and metadata panel alike) so showIcons=false omits every item
    // icon, including audit/review icons (AC1, WL-0MSBV4RYO008JL70).
    const noIcons = !showIconsGetter();
    const output: string[] = [];
    // Dynamic layout (WL-0MSQ44MDX008U69J): the selection list takes up to the
    // full available pane height; the metadata panel fills whatever space
    // remains, expanding when the list is short and sitting below the fold when
    // the list is long.  The metadata panel keeps a minimum of 3 rows (see
    // computeDynamicLayout).

    if (mode === 'detail' && detailItem) {
      const viewportHeight = Math.max(10, rows - 1);
      const offset = detailScrollOffset ?? 0;
      return formatDetailView(
        detailItem,
        cols,
        offset,
        viewportHeight,
        readFile,
        noIcons,
        detailToCIndex ?? 0,
        detailToCFocus ?? true,
        detailRenderedIndex ?? 0,
      );
    }

    if (mode === 'filter') {
      // Show filter prompt
      const filterPrompt = formatFilterPrompt(cols);
      output.push(filterPrompt);
      // Pad remaining lines
      const remaining = rows - filterPrompt.split('\n').length;
      for (let i = 0; i < remaining; i++) {
        output.push('');
      }
      return output.join('\n');
    }

    // ── Render list mode ──────────────────────────────────────────

    // Header with total count and auto-refresh indicator. `displayRows`
    // includes heading rows, so the item count shown is the row count — the
    // same metric the header has always shown for the flattened list.
    const totalItems = displayRows.length;
    const filterLabel = activeFilter ? ` (filtered: ${activeFilter})` : '';
    let header = ` ${ANSI.bold}Work Items${ANSI.reset} — ${totalItems} item(s)${filterLabel}`;
    if (totalCount !== undefined && totalCount > totalItems) {
      header += ` (top ${totalItems} of ${totalCount})`;
    }
    if (autoRefresh) {
      header += ` ${ANSI.dim}[auto-refresh on]${ANSI.reset}`;
    }
    if (panePaused) {
      header += ` ${ANSI.fg(220)}[paused — hidden]${ANSI.reset}`;
    }
    if (downtimeStatus) {
      header += downtimeStatus;
    }
    output.push(header);

    // Code Freeze banners — a prominent warning that implementation is
    // blocked while a ship release is in progress (active marker), plus a
    // DISTINCT warning when the marker is ambiguous (unreadable file,
    // corrupt JSON, wrong shape): the downtime dispatcher treats ambiguity
    // as frozen (fail-closed), so the operator sees why implement/audit
    // dispatch is disabled (WL-0MSQ0RPQP00636JY). Each banner consumes one
    // chrome row (chromeLines accounts for them) so the `rows - 1` pane
    // line-count invariant still holds (WL-0MSAAON63003N6LO).
    let bannerCount = 0;
    if (codeFreezeActive) {
      const bannerText = `⛔ CODE FREEZE — ship release in progress; implement actions blocked`;
      const bannerLine = `${ANSI.bg(196)}${ANSI.fg(231)} ${bannerText} ${ANSI.reset}`;
      output.push(truncateLine(bannerLine, cols));
      bannerCount++;
    }
    if (codeFreezeAmbiguous) {
      const bannerText = `⚠ Ambiguous Codefreeze marker — implement/audit dispatch disabled`;
      const bannerLine = `${ANSI.bg(220)}${ANSI.fg(0)} ${bannerText} ${ANSI.reset}`;
      output.push(truncateLine(bannerLine, cols));
      bannerCount++;
    }

    // The caller passes the display-rows model (headings + items) — the
    // renderer renders exactly those rows and does NOT derive group
    // separators from group transitions (WL-0MSL5MPSZ003TG94 AC3).

    // Dynamic layout (WL-0MSQ44MDX008U69J): chrome rows already rendered are
    // header + banners.  Compute the list's content need from its rows, then
    // let the metadata panel fill whatever space remains (≥ 3-row minimum).
    const { panelHeight, listArea, listHeight } = computeDynamicLayout(
      displayRows,
      scrollOffset,
      bannerCount,
      termSize,
    );
    const chromeLines = 2 + bannerCount; // header + banners + footer

    // Heading rows are first-class rows in the display model, so the visible
    // window's row count already includes them — no separate separator
    // accounting (WL-0MSAAON63003N6LO keeps the `rows - 1` invariant).
    // The active stage filter is indicated in the header only (filterLabel)
    // — no standalone filter bar is rendered.
    const budgetForRows = Math.max(0, listArea - chromeLines);
    let visible = displayRows.slice(scrollOffset, scrollOffset + listHeight);
    while (visible.length > 0 && visible.length > budgetForRows) {
      // Drop trailing rows until the window fits the pane height.
      visible = visible.slice(0, -1);
    }

    // ── Fold indicators (WL-0MSG8YXYJ008PWJJ) ─────────────────────
    // Show dim `▲ more` / `▼ more` markers so users can tell the list
    // is scrolled or truncated.  Indicator rows consume budget so the
    // `rows - 1` invariant still holds.
    const hasTopIndicator = scrollOffset > 0;
    const hasBottomIndicator = scrollOffset + visible.length < displayRows.length;
    const indicatorRows = (hasTopIndicator ? 1 : 0) + (hasBottomIndicator ? 1 : 0);
    const effectiveBudget = budgetForRows - indicatorRows;
    while (visible.length > 0 && visible.length > effectiveBudget) {
      // Drop trailing rows until rows + indicators fit.
      visible = visible.slice(0, -1);
    }
    // Edge case: the trim may have made the list fully fit — the bottom
    // indicator is then omitted. This terminates in a single pass (no loop).
    const bottomIndicatorActive = scrollOffset + visible.length < displayRows.length;
    // Top indicator — first row of the items region when scrolled down.
    if (hasTopIndicator) {
      output.push(` ${ANSI.dim}▲ more${ANSI.reset}`);
    }
    let numHeadings = 0;
    for (let i = 0; i < visible.length; i++) {
      const actualIndex = scrollOffset + i;
      const row = visible[i];
      const isSelected = actualIndex === selectedIndex;

      // Heading row: render the label + item count + collapse arrow directly
      // from the display model (WL-0MSL5MPSZ003TG94 AC1/AC2).
      if (isHeadingRow(row)) {
        numHeadings++;
        const arrow = row.collapsed ? '▶' : '▼';
        const line = ` ${ANSI.fg(stageColor(undefined))}${ANSI.bold}── ${row.groupLabel} (${row.count}) ${arrow} ──${ANSI.reset}`;
        output.push(isSelected ? `${ANSI.reverse}${line}${ANSI.reset}` : line);
        continue;
      }

      // Item row: existing hierarchy + icon rendering.
      const item = row;
      const hasChildCount = item.childCount !== undefined && item.childCount > 0;
      const isExpanded = expandedItems?.has(item.id) ?? false;
      const expandedItem = { ...item, _expanded: hasChildCount && isExpanded };

      const line = formatItemLine(expandedItem, cols, isSelected, noIcons);
      if (isSelected) {
        output.push(`${ANSI.reverse}${line}${ANSI.reset}`);
      } else {
        output.push(line);
      }
    }

    // Bottom indicator — last row of the rows region when rows remain
    // below the fold (after the trimming edge case is resolved).
    if (bottomIndicatorActive) {
      output.push(` ${ANSI.dim}▼ more${ANSI.reset}`);
    }

    // Fill remaining rows (header + indicators + rows)
    const used = chromeLines + (hasTopIndicator ? 1 : 0) + (bottomIndicatorActive ? 1 : 0) + visible.length;
    for (let i = used; i < listArea; i++) {
      output.push('');
    }

    // Footer with keyboard hints (dynamic — includes chord hints if available).
    // Both the normal hint line and the chord-in-progress line are gated by
    // `showHelpText` (default true), so `showHelpText: false` hides ALL shortcut
    // hints, consistent with the pi browse widget's showHelpText handling
    // (WL-0MSGJDSMJ004128E). Note: gating only affects rendering — chord key
    // handling/accumulation in chordState continues regardless.
    //
    // Hover tooltip (WL-0MT9XRZDK006GMUH): when tooltip lines are supplied
    // they REPLACE the footer hints — the overlay lives in the footer area,
    // directly above the metadata panel.
    const helpEnabled = showHelpText ?? true;
    if (hoverTooltip && hoverTooltip.length > 0) {
      for (const line of formatTooltipOverlay(cols, hoverTooltip)) {
        output.push(line);
      }
    } else {
      const isChordActive = chordState && chordState.pendingKeys.length > 0;
      if (isChordActive && helpEnabled) {
        const pendingStr = chordState!.pendingKeys.join(' ');
        const hintStr = chordState!.hints
          ? `  ${ANSI.dim}${chordState!.hints}${ANSI.reset}`
          : '';
        const footerLine = ` ${ANSI.reverse} chord: ${pendingStr} _ ${ANSI.reset}${hintStr}`;
        output.push(footerLine);
      } else {
        const navHint = (navStackDepth && navStackDepth > 0)
          ? ` ${ANSI.dim}[esc] back${navStackDepth > 1 ? ` (${navStackDepth} levels)` : ''}${ANSI.reset}`
          : '';
        const chordHelpSuffix = chordHelpHints ? ` ${ANSI.fg(220)}${chordHelpHints}${ANSI.reset}` : '';
        const footerLine = navHint + chordHelpSuffix || ' ';
        output.push(footerLine);
      }
    }

    // ── Metadata panel ────────────────────────────────────────────
    // Reserve the bottom `panelHeight` rows for the selected row's
    // metadata (plus its last command when in_progress). The panel has its
    // own scroll offset (m/M) so long metadata never affects list
    // navigation (WL-0MSAYNVBY006LM9X). A heading selection has no item —
    // formatMetadataPanel renders a blank panel (group info lands here via
    // T5).
    const selectedRow = selectedIndex >= 0 && selectedIndex < displayRows.length
      ? displayRows[selectedIndex]
      : null;
    // Heading selection → group info panel (WL-0MSL5MPSZ003TG94 T5 AC1);
    // item selection → the normal metadata panel.
    const panelLines = selectedRow !== null && isHeadingRow(selectedRow)
      ? formatGroupInfoPanel(selectedRow, cols, panelHeight)
      : formatMetadataPanel(
          selectedRow,
          cols,
          panelHeight,
          metaScrollOffset ?? 0,
          metaLastCommand,
          noIcons,
        );
    for (const line of panelLines) {
      output.push(line);
    }

    // Safety clamp: never exceed the renderer's `rows - 1` budget so the
    // notification line appended by render() always fits the pane. Only
    // triggers for pathological tiny term sizes where even the chrome rows
    // do not fit; the header (first line) is always preserved.
    while (output.length > rows - 1) {
      output.pop();
    }

    return output.join('\n');
  };
}

// ── Main TUI loop ─────────────────────────────────────────────────────

/**
 * Work-item ID format: a prefix (e.g. `WL`, `SA`) followed by a hash,
 * e.g. `WL-0MS9NPHQU005Y3VE`.
 */
const WORK_ITEM_ID_TOKEN = /^[A-Z]+-[\w-]+$/;

/**
 * Extract the last work-item ID token from a command string, if any.
 * Commands without an item ID (e.g. `echo hello`) return undefined and are
 * not recorded in the command log.
 */
export function extractWorkItemIdFromCommand(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (WORK_ITEM_ID_TOKEN.test(tokens[i])) {
      return tokens[i];
    }
  }
  return undefined;
}

/**
 * Record a command against its work item in the command log.
 *
 * Best effort: failures are swallowed so logging can never break command
 * dispatch. Commands without a work item ID are not recorded (only
 * plugin-dispatched commands with an item ID are logged).
 */
function logCommandForItem(command: string, itemId?: string): void {
  if (!itemId) return;
  try {
    recordCommand(itemId, command);
  } catch {
    // Logging must never break command routing
  }
}

/**
 * Resolve `<id>` placeholders in a command and route it through the
 * output mechanism. Used by {@link dispatchChordCommand} for agent
 * workflow and audit command families.
 *
 * The resolved command is recorded in the command log against its work
 * item BEFORE it is routed, so a downstream failure never skips the log
 * entry (WL-0MSEPP104006PS7T).
 *
 * @returns true if the command was resolved and routed, false if
 *          `<id>` was required but no item is selected (no-op)
 */
function resolveAndRouteCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string) => void,
  model?: string,
  openPane?: boolean,
  onRefresh?: () => Promise<void>,
): boolean {
  let resolvedCommand = command;
  let itemId: string | undefined;

  if (resolvedCommand.includes('<id>')) {
    const selected = state.getSelectedItem();
    if (selected) {
      resolvedCommand = resolvedCommand.replace(/<id>/g, selected.id);
      itemId = selected.id;
    } else {
      // No item selected and command requires <id> — graceful no-op
      return false;
    }
  } else {
    itemId = extractWorkItemIdFromCommand(resolvedCommand);
  }

  logCommandForItem(resolvedCommand, itemId);

  if (onCommand) {
    // Descriptive pane title (WL-0MSJ4E8UA005KG9Y): build it from the
    // selected/claimed work item IF resolvedCommand is an agent or shell
    // command that will open a pane; else undefined keeps current arity.
    const selected = state.getSelectedItem();
    const paneTitle =
      selected && (isAgentCommand(resolvedCommand) || resolvedCommand.startsWith('!'))
        ? selected.title
        : undefined;
    // The openPane flag is passed only when explicitly set (false): an
    // undefined third arg keeps the 2-arg call identical to today's
    // dispatch, so shortcuts without open_pane are byte-compatible
    // (WL-0MSJLD1I70045ZUL). The onRefresh hook is appended only for
    // background (no-pane) dispatches (openPane === false) so they can
    // trigger a refresh when the child exits (WL-0MT1KB70U0012X6T);
    // pane-opening paths keep their existing arity. Pane titles are
    // appended only when the command opens a pane and a title exists.
    if (openPane === undefined) {
      if (paneTitle !== undefined) {
        onCommand(resolvedCommand, model, undefined, undefined, paneTitle);
      } else {
        onCommand(resolvedCommand, model);
      }
    } else if (onRefresh) {
      if (paneTitle !== undefined) {
        onCommand(resolvedCommand, model, openPane, onRefresh, paneTitle);
      } else {
        onCommand(resolvedCommand, model, openPane, onRefresh);
      }
    } else if (paneTitle !== undefined) {
      onCommand(resolvedCommand, model, openPane, undefined, paneTitle);
    } else {
      onCommand(resolvedCommand, model, openPane);
    }
  }
  return true;
}

/**
 * Check whether a command starts an implementation workflow.
 *
 * Matches `/skill:implement`, `/skill:implement-single`, and
 * `/skill:implementall` (the implement command family). These are the
 * commands blocked while the project is in Code Freeze.
 */
export function isImplementCommand(command: string): boolean {
  const firstToken = command.trim().split(/\s+/)[0] ?? '';
  return firstToken.startsWith('/skill:implement');
}

/**
 * Render the Code Freeze notice dialog as a terminal overlay.
 *
 * Shown when the user issues an implement command while the project is in
 * Code Freeze. Informational only — no input fields; dismissed with Esc or
 * Enter, returning to the list without executing the command.
 *
 * @param maxCols - Terminal width
 * @param maxRows - Terminal height
 * @param reason - Optional freeze reason from the marker (e.g. "ship release")
 * @returns The rendered overlay string, ready for stdout
 */
export function formatCodeFreezeDialog(maxCols: number, maxRows: number, reason?: string): string {
  const lines: string[] = [];
  const dialogWidth = Math.min(maxCols - 4, 64);
  const dialogMinWidth = 44;
  const effectiveWidth = Math.max(dialogMinWidth, dialogWidth);
  const leftPad = Math.max(0, Math.floor((maxCols - effectiveWidth) / 2));

  const padLine = (content: string): string => {
    const visibleLen = content.replace(/\x1b\[[0-9;]*m/g, '').length;
    const rightPad = Math.max(0, effectiveWidth - visibleLen - 2);
    return ' '.repeat(leftPad) + `│ ${content}${' '.repeat(rightPad)} │`;
  };

  const borderLine = (left: string, right: string): string => {
    return ' '.repeat(leftPad) + `${left}${'─'.repeat(effectiveWidth - 2)}${right}`;
  };

  lines.push('');
  lines.push(borderLine('┌', '┐'));

  // Title
  lines.push(padLine(`${ANSI.bold}${ANSI.fg(196)}⛔ CODE FREEZE${ANSI.reset}`));
  lines.push(padLine(''));

  // Body
  lines.push(padLine(` ${ANSI.bold}Implementation is blocked while a ship-it release${ANSI.reset}`));
  lines.push(padLine(` ${ANSI.bold}is in progress for this project.${ANSI.reset}`));
  lines.push(padLine(''));
  if (reason) {
    lines.push(padLine(` ${ANSI.dim}Reason: ${reason}${ANSI.reset}`));
    lines.push(padLine(''));
  }
  lines.push(padLine(` ${ANSI.dim}No agent pane was spawned and no work item was claimed.${ANSI.reset}`));
  lines.push(padLine(''));
  lines.push(padLine(` ${ANSI.dim}The freeze lifts automatically when the release finishes.${ANSI.reset}`));
  lines.push(padLine(''));

  lines.push(borderLine('├', '┤'));
  lines.push(padLine(''));
  lines.push(padLine(`${ANSI.dim}[Esc] dismiss  [Enter] dismiss${ANSI.reset}`));
  lines.push(borderLine('└', '┘'));
  lines.push('');

  const totalLines = lines.length;
  const remaining = Math.max(0, maxRows - totalLines);
  for (let i = 0; i < remaining; i++) {
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Fetch the items for the current view.
 *
 * When a stage filter is active, the worklist shows every root item in that
 * stage matching the stage's status rule (`wl list --status <status> --stage
 * <stage> --root-only`; see STAGE_STATUS in fetcher.ts) — not just the
 * `browseItemCount`-capped `wl next` subset — so stage-filtered views give
 * a complete picture of the stage (WL-0MSDT8X1V003206G). Most stages show
 * `open`-status items only; the in_review stage additionally includes
 * `completed` and `in-progress` items, because per the project workflow
 * advancing an item to in_review sets its status to `completed` (or leaves
 * it `in-progress` while being re-worked after review feedback)
 * (WL-0MSKCRX730052IIW). Items with status `blocked` are excluded; child
 * items stay hidden and remain reachable via expand exactly as in the
 * unfiltered view. Results follow the standard list order (sortIndex).
 *
 * Without an active filter the default fetcher is used unchanged (the
 * default `/wl` view keeps its existing smart-selection behaviour). If the
 * stage/priority fetch fails, the default fetcher is used as a fallback so a
 * `wl` error can never blank the list.
 *
 * @param activeFilter - The active stage filter (null = no stage filter)
 * @param activePriorityFilter - The active priority filter (null = no
 *   priority filter). Mutually exclusive with `activeFilter` (replace
 *   semantics, WL-0MSKC8T46006999S): at most one is set.
 * @param defaultFetcher - The default fetcher for the unfiltered view
 */
export function fetchItemsForView(
  activeFilter: string | null,
  activePriorityFilter: string | null,
  defaultFetcher: () => Promise<WorkItem[]>,
): Promise<WorkItem[]> {
  if (activeFilter) {
    // Fail-open: a wl error must never blank the list — fall back to the
    // default fetcher (which itself fails open in index.ts).
    return fetchItemsByStage(activeFilter).catch(() => defaultFetcher());
  }
  if (activePriorityFilter) {
    // Fail-open: same fallback as the stage path.
    return fetchItemsByPriority(activePriorityFilter).catch(() => defaultFetcher());
  }
  // Unfiltered: delegate straight to the default fetcher so the refresh
  // cadence is byte-for-byte unchanged (single-flight timing preserved).
  return defaultFetcher();
}

/**
 * Dispatch a chord command by mapping it to the appropriate TUI action
 * or routing it through the stdout command output mechanism.
 *
 * Recognised command families:
 * - `/wl <stage>` — stage filter actions (applied internally)
 * - `/skill:implement`, `/skill:audit` — agent skill invocations
 * - `/intake`, `/plan` — agent workflow commands
 * - `!!wl reviewed` — producer review toggle
 * - Compound audit commands containing `&& wl audit-set`
 *
 * @param command - The resolved command string (may contain `<id>` placeholders)
 * @param state - Current work item list state (for selected item lookup)
 * @param onCommand - Optional callback to route non-/wl commands to the output mechanism
 * @param model - Optional model for the routed command
 * @param onDowntimeToggle - Optional callback invoked for the internal
 *   `/downtime toggle` command (flips the per-instance worker override;
 *   never spawns a pane, never writes to stdout — parent
 *   WL-0MSZ4NSOE007AQEF)
 * @param openPane - Optional open-pane flag (WL-0MSJLD1I70045ZUL): `false`
 *   runs the command in the background (no pane); `undefined`/`true` open a
 *   pane as today. Passed to onCommand only when explicitly set.
 * @returns true if the command was handled, false otherwise
 */
export function dispatchChordCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string) => void,
  model?: string,
  onDowntimeToggle?: () => void,
  openPane?: boolean,
  onRefresh?: () => Promise<void>,
): boolean {
  // ── /downtime toggle (internal action, WL-0MSZ4NSOE007AQEF) ──────
  // Per-instance in-memory toggle of downtime dispatch for the current
  // herdr pane. Fully internal — no pane spawned, no stdout write, no
  // <id> substitution. The header re-renders via the worker's state.
  if (/^\/downtime toggle$/.test(command.trim())) {
    if (onDowntimeToggle) {
      onDowntimeToggle();
    }
    return true;
  }

  // ── /wl --priority <priority> commands (internal dispatch) ─────
  // Priority filter axis (WL-0MSKC8T46006999S): `/wl --priority <p>` with a
  // canonical name (critical|high|medium|low) applies the priority filter;
  // unknown values fall through unhandled (no crash, no filter change),
  // matching the `/wl <bogus>` behaviour below.
  const wlPriorityMatch = command.match(/^\/wl\s+--priority\s+(\S+)$/);
  if (wlPriorityMatch) {
    const wlPriority = wlPriorityMatch[1];
    const internalPriority = PRIORITY_MAP[wlPriority];
    if (internalPriority) {
      state.applyPriorityFilter(internalPriority);
      return true;
    }
  }

  // ── /wl <stage> commands (internal dispatch) ──────────────
  const wlStageMatch = command.match(/^\/wl\s+(\S+)$/);
  if (wlStageMatch) {
    const wlStage = wlStageMatch[1];
    const internalStage = STAGE_MAP[wlStage];
    if (internalStage) {
      state.applyFilter(internalStage);
      return true;
    }
  }

  // ── /wl (no arguments): return to the default unfiltered view ────
  // Equivalent to the Pi TUI's `/wl` with no args (WL-0MSGSE15000746F7):
  // clears the active stage AND priority filters so the next refresh shows
  // the standard smart-selection list. No-op when no filter is active.
  if (/^\/wl\s*$/.test(command)) {
    state.clearFilter();
    return true;
  }

  // ── Agent skill invocations ─────────────────────────────
  if (command.startsWith('/skill:implement')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh);
  }
  if (command.startsWith('/skill:audit')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh);
  }
  if (command.startsWith('/skill:ship')) {
    // Dev→main release (Ship It shortcut, WL-0MSGG5N5Z0074TLY). Global
    // release — no <id> substitution; routed to the agent channel like
    // other /skill:* commands. NOT blocked during a Code Freeze (the ship
    // skill gates itself); only the confirmation dialog precedes dispatch.
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh);
  }

  // ── Agent workflow commands ─────────────────────────────
  if (command.startsWith('/intake')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh);
  }
  if (command.startsWith('/plan')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh);
  }

  // ── Producer review / audit compound commands ───────────
  if (command.startsWith('!!wl reviewed')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh);
  }
  // ── Data-modifying wl commands (close/delete/update/search) ──
  // These mutate the work-item data set or change the list contents, so
  // they are routed here (not the generic callback path) so the caller's
  // isWlModifyingCommand check sees 'dispatched' and triggers an immediate
  // list refresh after the command completes (WL-0MTA217DZ003H5K8).
  if (/^!!\s*wl\s+(close|delete|update|search)\b/i.test(command)) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh);
  }
  if (command.includes('&& wl audit-set')) {
    return resolveAndRouteCommand(command, state, onCommand, model, openPane, onRefresh);
  }

  // Unknown command — not handled
  return false;
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

/**
 * Resolve podcast-progression command markers (`<podcast-target>`,
 * `<podcast-script>`, `<podcast-review>`, `<podcast-both>`) for the selected
 * work item at dispatch time (OSL-0MSKFXM380098LFL, folding in
 * OSL-0MSHFQ51L009IUOS and the OSL-0MSKVB5K6008XFOQ w-chord split).
 *
 * The `w s` write-script sub-chord command
 * (`/skill:wiki-podcast-script <podcast-target>`) derives its mode from the
 * selected item's lifecycle context:
 * - stage `intake_complete` (sourced): author a new script from the source
 *   synthesis → `--doc <first .md Key File> --force-single`;
 * - otherwise, when open editor-note children exist: rewrite the existing
 *   script → `--rewrite <first .podcast.md Key File>`;
 * - otherwise: belt-and-braces guard — returns an error and does NOT
 *   dispatch (never authors a duplicate).
 *
 * The `w r` write-review sub-chord command
 * (`/skill:wiki-podcast-script --review <podcast-review>`) runs the 6
 * reviews on the existing script, and the `w b` write-both sub-chord
 * command (`/skill:wiki-podcast-script --review-rewrite <podcast-both>`)
 * runs reviews + rewrite in one pass (7 LLM calls). Both resolve
 * `<podcast-review>`/`<podcast-both>` to the first `.podcast.md` Key File
 * in raw form (same as the existing `--rewrite` resolution) with a
 * belt-and-braces error when no script exists.
 *
 * The `t` TTS chord command
 * (`/skill:wiki-tts-generate --podcast-file <podcast-script>`) resolves
 * `<podcast-script>` to the first `.podcast.md` Key File, normalized to the
 * wiki-dir-relative `podcast/...` form the TTS skill expects (a bare
 * `<title>/<title>.podcast.md` Key File path is podcast-dir-relative).
 *
 * Markers are resolved BEFORE the generic modal-form check so they never
 * fall through to the input form. Returns the input command unchanged when
 * it carries no podcast markers.
 *
 * @param command - Resolved shortcut command (may contain markers).
 * @param item - Selected work item (or null when nothing is selected).
 * @param fetchChildren - Child fetcher (injectable for tests; defaults to
 *   {@link fetchChildrenForItem}).
 */
export async function resolvePodcastTarget(
  command: string,
  item: WorkItem | null,
  fetchChildren: (parentId: string) => Promise<WorkItem[]> = fetchChildrenForItem,
): Promise<PodcastTargetResolution> {
  const hasTarget = command.includes('<podcast-target>');
  const hasScript = command.includes('<podcast-script>');
  const hasReview = command.includes('<podcast-review>');
  const hasBoth = command.includes('<podcast-both>');
  if (!hasTarget && !hasScript && !hasReview && !hasBoth) {
    return { command };
  }
  if (!item) {
    return { error: 'No work item selected' };
  }

  const mdPaths = extractFilePaths(item.description ?? '').filter(p => p.endsWith('.md'));
  const synthesis = mdPaths.find(p => !p.endsWith('.podcast.md')) ?? mdPaths[0];
  const script = mdPaths.find(p => p.endsWith('.podcast.md'));
  let resolved = command;

  if (hasTarget) {
    // `w` write-script chord: mode derives from stage + open notes.
    if (item.stage === 'intake_complete') {
      // Sourced episode — author a new script from the synthesis.
      if (!synthesis) {
        return { error: 'No source synthesis found in Key Files: — run wiki-ingest-batch/research first' };
      }
      resolved = resolved.replace(/<podcast-target>/g, `--doc ${synthesis} --force-single`);
    } else {
      // Drafted/written episode — rewrite only when open note children exist.
      let children: WorkItem[] = [];
      try {
        children = await fetchChildren(item.id);
      } catch {
        children = [];
      }
      const openNotes = children.filter(c => {
        const status = c.status ?? '';
        return status !== 'completed' && status !== 'closed' && status !== 'deleted';
      });
      if (openNotes.length === 0) {
        return { error: 'podcast script already present, review and edit that rather than author a new one' };
      }
      if (!script) {
        return { error: 'No podcast script found in Key Files:' };
      }
      resolved = resolved.replace(/<podcast-target>/g, `--rewrite ${script}`);
    }
  }

  if (hasScript) {
    if (!script) {
      return { error: 'No podcast script found in Key Files: — author the script first (w)' };
    }
    // The TTS skill resolves --podcast-file relative to the wiki dir;
    // episode Key Files store the script podcast-dir-relative.
    const podcastFile = script.startsWith('podcast/') || script.startsWith('wiki/')
      ? script
      : `podcast/${script}`;
    resolved = resolved.replace(/<podcast-script>/g, podcastFile);
  }

  // `w r` write-review / `w b` write-both sub-chords: both require an
  // existing script and resolve the marker to the raw first `.podcast.md`
  // Key File (same raw form the `--rewrite` resolution uses). The chords
  // are stage-gated to script-bearing stages, but a belt-and-braces guard
  // still protects the unfiltered/edge case (OSL-0MSKVB5K6008XFOQ).
  if (hasReview || hasBoth) {
    if (!script) {
      return { error: 'No podcast script found in Key Files: — author the script first (w)' };
    }
    if (hasReview) {
      resolved = resolved.replace(/<podcast-review>/g, script);
    }
    if (hasBoth) {
      resolved = resolved.replace(/<podcast-both>/g, script);
    }
  }

  return { command: resolved };
}

/**
 * Execute a resolved chord command.
 *
 * Routing priority:
 * 1. {@link dispatchChordCommand} — handles `/wl <stage>` (internal filter),
 *    `/skill:implement`, `/skill:audit`, `/skill:ship`, `/intake`, `/plan`,
 *    `!!wl reviewed`, and compound `&& wl audit-set` commands (resolves
 *    `<id>` and routes to `onCommand`). Returns 'dispatched'.
 * 2. Code Freeze guard — when `codeFreezeActive` is true and the command is
 *    an implement command, the command is NOT routed; returns 'blocked' so
 *    the caller can show the Code Freeze dialog instead of spawning a pane.
 * 3. For unrecognised command families, resolves `<id>` placeholders and
 *    passes to the optional `onCommand` callback. Returns 'callback'.
 * 4. If the command contains `<id>` but no item is selected, silently
 *    drops with 'noop'.
 *
 * @param command - The resolved command string (may contain `<id>` placeholders)
 * @param state - Current work item list state (for selected item lookup)
 * @param onCommand - Optional callback to receive resolved commands
 * @param codeFreezeActive - Whether the project is in Code Freeze (implement
 *                           commands are blocked). Defaults to false.
 * @param model - Optional model for the routed command.
 * @param onDowntimeToggle - Optional callback for the internal
 *   `/downtime toggle` command (see {@link dispatchChordCommand}).
 * @param openPane - Optional open-pane flag (WL-0MSJLD1I70045ZUL): `false`
 *   runs the command in the background (no pane); `undefined`/`true` open a
 *   pane as today. Passed to onCommand only when explicitly set.
 * @returns 'dispatched' if handled by dispatchChordCommand,
 *          'callback' if passed to onCommand,
 *          'noop' if skipped (no item + <id> requirement),
 *          'blocked' if frozen and the command is an implement command.
 */
export function executeResolvedCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string) => void,
  codeFreezeActive = false,
  model?: string,
  onDowntimeToggle?: () => void,
  openPane?: boolean,
  onRefresh?: () => Promise<void>,
): ExecuteResult {
  // Code Freeze guard: never route implement commands while frozen.
  // This runs BEFORE dispatchChordCommand so no pane spawn, claim, or
  // <id> substitution can happen for a blocked command.
  if (codeFreezeActive && isImplementCommand(command)) {
    return 'blocked';
  }

  // Try dispatchChordCommand first — handles /wl, /downtime, /skill:,
  // /intake, /plan, !!wl reviewed, and compound audit commands
  if (dispatchChordCommand(command, state, onCommand, model, onDowntimeToggle, openPane, onRefresh)) {
    return 'dispatched';
  }

  // Not a recognised command family — resolve <id> placeholders and call onCommand
  let resolvedCommand = command;
  let itemId: string | undefined;

  if (resolvedCommand.includes('<id>')) {
    const selected = state.getSelectedItem();
    if (selected) {
      resolvedCommand = resolvedCommand.replace(/<id>/g, selected.id);
      itemId = selected.id;
    } else {
      // No item selected and command requires <id> — graceful no-op
      return 'noop';
    }
  } else {
    itemId = extractWorkItemIdFromCommand(resolvedCommand);
  }

  // Record before execution so failures never skip the log entry.
  logCommandForItem(resolvedCommand, itemId);

  if (onCommand) {
    // Descriptive pane title (WL-0MSJ4E8UA005KG9Y): thread the selected
    // item's title forward so the caller can build a pane name without an
    // extra wl spawn. Only pane-opening routes (agent + shell commands)
    // need it; plain commands derive nothing from the title and keep the
    // 2-arg call (byte-compatible).
    const selected = state.getSelectedItem();
    const paneTitle =
      selected && (isAgentCommand(resolvedCommand) || resolvedCommand.startsWith('!'))
        ? selected.title
        : undefined;
    // The openPane flag is passed only when explicitly set (false): an
    // undefined third arg keeps the 2-arg call identical to today's
    // dispatch, so shortcuts without open_pane are byte-compatible
    // (WL-0MSJLD1I70045ZUL). The onRefresh hook is appended only for
    // background (no-pane) dispatches (openPane === false) so they can
    // trigger a refresh when the child exits (WL-0MT1KB70U0012X6T);
    // pane-opening paths keep their existing arity.
    if (openPane === undefined) {
      if (paneTitle !== undefined) {
        onCommand(resolvedCommand, model, undefined, undefined, paneTitle);
      } else {
        onCommand(resolvedCommand, model);
      }
    } else if (onRefresh) {
      if (paneTitle !== undefined) {
        onCommand(resolvedCommand, model, openPane, onRefresh, paneTitle);
      } else {
        onCommand(resolvedCommand, model, openPane, onRefresh);
      }
    } else if (paneTitle !== undefined) {
      onCommand(resolvedCommand, model, openPane, undefined, paneTitle);
    } else {
      onCommand(resolvedCommand, model, openPane);
    }
  }
  return 'callback';
}

/**
 * Run the main selection list TUI. This function:
 * 1. Sets up raw terminal mode
 * 2. Enters an event loop reading keypresses
 * 3. Calls the fetcher to load/refresh items
 * 4. Renders the current state
 * 5. Exits when the user presses 'q'
 *
 * @param fetcher - Async function that returns the work items to display
 * @param initialItems - Pre-loaded items (optional, for testing)
 * @param shortcutRegistry - Optional shortcut registry for chord handling
 * @returns The selected WorkItem when the user presses enter, or undefined
 */
export async function runWorklistTui(
  fetcher: () => Promise<WorkItem[]>,
  initialItems?: WorkItem[],
  shortcutRegistry?: { lookupChord: Function; getChordByLeader: Function; getChordByPrefix: Function; getChordEntries: Function } | ShortcutRegistry | undefined,
  options?: { autoRefresh?: boolean; refreshIntervalMs?: number; autoSync?: boolean; syncIntervalMs?: number; browseItemCount?: number; showHelpText?: boolean; getShowHelpText?: () => boolean; showIcons?: boolean; getShowIcons?: () => boolean; onCommand?: (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string) => void; downtimeWorker?: DowntimeWorker; downtimePollIntervalMs?: number; mergeAgentStates?: (items: WorkItem[]) => Promise<void>; subscriber?: HerdrEventSubscriber | null; agentTracker?: AgentTracker | null; onDowntimeToggle?: () => void; modeSwitchWorker?: ModeSwitchWorker; modeSwitchPollIntervalMs?: number; modeSwitchEnabled?: boolean; maxSyncStalenessMs?: number; onRefresh?: () => Promise<void> },
): Promise<WorkItem | undefined> {
  const opts = {
    autoRefresh: options?.autoRefresh ?? true,
    refreshIntervalMs: options?.refreshIntervalMs ?? 30000,
    autoSync: options?.autoSync ?? true,
    syncIntervalMs: options?.syncIntervalMs ?? 60000,
    browseItemCount: options?.browseItemCount ?? 10,
    showHelpText: options?.showHelpText ?? true,
    getShowHelpText: options?.getShowHelpText ?? (() => options?.showHelpText ?? true),
    showIcons: options?.showIcons ?? true,
    getShowIcons: options?.getShowIcons ?? (() => options?.showIcons ?? true),
    onCommand: options?.onCommand,
    downtimeWorker: options?.downtimeWorker,
    downtimePollIntervalMs: options?.downtimePollIntervalMs ?? DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
    mergeAgentStates: options?.mergeAgentStates,
    subscriber: options?.subscriber ?? null,
    agentTracker: options?.agentTracker ?? null,
    onDowntimeToggle: options?.onDowntimeToggle,
    modeSwitchWorker: options?.modeSwitchWorker,
    modeSwitchPollIntervalMs: options?.modeSwitchPollIntervalMs ?? 10_000,
    modeSwitchEnabled: options?.modeSwitchEnabled ?? true,
    maxSyncStalenessMs: options?.maxSyncStalenessMs ?? 60_000,
    onRefresh: options?.onRefresh,
  };

  let termSize = getTermSize();

  // Load items
  let items: WorkItem[];
  try {
    items = initialItems ?? await fetcher();
  } catch {
    items = [];
  }

  // Fetch total actionable count (best effort — failure is silent)
  fetchActionableCount().then((count) => {
    totalActionableCount = count;
    render();
  }).catch(() => {
    // ignore
  });

  const state = new WorkItemListState(items, termSize);
  // Icons are gated by the getShowIcons getter (re-read on every render so a
  // showIcons setting change applies without a plugin restart — same pattern
  // as getShowHelpText). The renderer is created per-TUI-run with the getter.
  const renderer = createListRenderer(opts.getShowIcons);
  const chordState: ChordState = createChordState();
  let formState: FormState | null = null;
  /** Saved mode before entering form overlay (to restore on cancel) */
  let preFormMode: ViewMode = 'list';
  /**
   * Ship It confirmation dialog (WL-0MSGG5N5Z0074TLY). Non-null while the
   * dialog is open; its buffer holds the typed confirmation input. The
   * dialog is bottom-anchored — the selection list stays visible above it.
   */
  let shipItDialog: ShipItDialogState | null = null;

  let totalActionableCount: number | undefined;

  // Code Freeze state: whether the project is frozen (banner) and whether
  // the Code Freeze notice dialog is currently showing. The banner state is
  // refreshed on each data refresh; the command-dispatch path re-reads the
  // marker fresh so a freeze that starts between refreshes is still enforced
  // at dispatch time (fail-safe client-side blocking). `codeFreezeAmbiguous`
  // drives the separate "Ambiguous Codefreeze marker" banner
  // (WL-0MSQ0RPQP00636JY): a marker that cannot be parsed disables
  // implement/audit downtime dispatch (fail-closed) and the operator must
  // see why. Browsing/shortcut blocking keep their fail-open semantics —
  // `codeFreezeActive` stays false for an ambiguous marker.
  let codeFreezeActive = false;
  let codeFreezeAmbiguous = false;
  let codeFreezeNotice = false;

  /**
   * Re-read the code-freeze marker tri-state. Fail-open for browsing: an
   * ambiguous marker keeps `codeFreezeActive` false (browsing and shortcut
   * blocking are unchanged); only the ambiguous-marker banner state and the
   * downtime dispatcher's fail-closed gate are affected
   * (WL-0MSQ0RPQP00636JY).
   */
  const refreshFreezeState = (): void => {
    const status = readCodeFreezeStatus();
    codeFreezeActive = status === 'frozen';
    codeFreezeAmbiguous = status === 'ambiguous';
  };

  // Initial Code Freeze state read (fail-open: no marker => not frozen).
  refreshFreezeState();

  // Pane-visibility gating (pause-when-hidden). When the pane's tab is not
  // focused, auto-refresh/auto-sync timer ticks are skipped so hidden panes
  // stop spawning wl processes. Fail-open: when visibility can't be
  // determined (no HERDR_TAB_ID / CLI error) the pane is treated as visible
  // and polling proceeds as today. Tab focus is the signal (herdr tab get
  // -> result.tab.focused); PollGate memoizes the tab-get exec within a
  // TTL so refresh+sync ticks in one cycle share a single `herdr tab get`.
  const paneGate = new PollGate(isPaneVisible, DEFAULT_POLL_GATE_TTL_MS);
  // Whether the pane is currently hidden (drives the header indicator).
  // Updated by the gate check on each timer tick; fail-open defaults to false.
  let panePaused = false;

  // ── Event-driven window status (WL-0MSHB7DHO004RHBJ) ──────────────
  // The herdr event subscriber (when available) replaces the polling paths:
  //  - `pane_focused` for the CURRENT pane → immediate visibility update
  //    + refresh (replaces the 2s resume-poll for hidden→visible).
  //  - `pane_agent_status_changed` / `pane_agent_detected` / `pane_closed` /
  //    `pane_exited` → immediate icon updates (replaces the agent-list poll).
  // Polling stays the fail-open fallback whenever events are unavailable.
  const subscriber = opts.subscriber;
  const agentTracker = opts.agentTracker;

  /** True while the event subscription is healthy (drives resume-poll gating). */
  let eventsActive = false;

  /**
   * Sync the subscriber's per-pane subscriptions with the tracker's pane
   * set (from the shared `.worklog/agent-panes.json`). Per-pane
   * `pane.agent_status_changed` subscriptions must exist for every tracked
   * pane so status events are received (AC1/AC3). Late-spawned agents are
   * covered by `pane_agent_detected` + re-reading the shared file.
   * Best-effort: subscription failures never break the event loop.
   */
  const syncPaneSubscriptions = async (): Promise<void> => {
    if (!subscriber || !agentTracker) return;
    try {
      const current = new Set(subscriber.getTrackedPaneIds());
      for (const entry of agentTracker.snapshot()) {
        if (!current.has(entry.paneId)) {
          await subscriber.addPaneSubscription(entry.paneId);
        }
      }
    } catch {
      // Fail-open: a subscription sync failure keeps polling as fallback.
    }
  };

  /**
   * Re-apply the tracker's cached states to the live items and re-render
   * (coalesced per microtask so event storms do not thrash the TUI).
   */
  let agentEventRenderPending = false;
  const scheduleAgentEventRender = (): void => {
    if (agentEventRenderPending) return;
    agentEventRenderPending = true;
    Promise.resolve().then(() => {
      agentEventRenderPending = false;
      try {
        if (agentTracker) {
          mergeAgentStatesCached(state.items, agentTracker);
        }
        render();
      } catch {
        // Fail-open: render failures never crash the TUI.
      }
    });
  };

  if (subscriber) {
    subscriber.setCallbacks({
      // A pane_focused event for the CURRENT pane means its tab is focused
      // (a pane cannot hold focus while its tab is hidden) → visible.
      // Applies the event value to the gate (no `herdr tab get` exec),
      // clears the paused indicator, and refreshes immediately — replacing
      // the 2s resume-poll for the hidden → visible transition.
      onPaneFocused: (data) => {
        const currentPaneId = process.env.HERDR_PANE_ID;
        if (!currentPaneId || data.pane_id !== currentPaneId) return;
        if (data.focused === false) {
          paneGate.setVisibleFromEvent(false);
          panePaused = true;
          return;
        }
        paneGate.setVisibleFromEvent(true);
        panePaused = false;
        stopResumePoll();
        doRefresh(true);
      },
      // Agent-status events update the tracker's cached state map and
      // re-render the icons immediately (no `herdr agent list` exec).
      onAgentStatusChanged: (data) => {
        if (!agentTracker) return;
        agentTracker.applyAgentStatusChanged(data.pane_id, data.agent_status);
        scheduleAgentEventRender();
      },
      // A new agent pane appeared (possibly from another herdr instance):
      // re-read the shared file for late associations and add the pane to
      // the per-pane subscription set (AC3).
      onAgentDetected: (data) => {
        if (!agentTracker || !subscriber) return;
        const grew = agentTracker.applyAgentDetected();
        if (grew) void syncPaneSubscriptions();
        void subscriber.addPaneSubscription(data.pane_id).catch(() => {});
        scheduleAgentEventRender();
      },
      // A pane closed/exited: prune its associations so its icons disappear
      // immediately and drop the per-pane subscription (best-effort).
      onPaneClosed: (data) => {
        if (!agentTracker || !subscriber) return;
        agentTracker.applyPaneGone(data.pane_id);
        void subscriber.removePaneSubscription(data.pane_id).catch(() => {});
        scheduleAgentEventRender();
      },
      onPaneExited: (data) => {
        if (!agentTracker || !subscriber) return;
        agentTracker.applyPaneGone(data.pane_id);
        void subscriber.removePaneSubscription(data.pane_id).catch(() => {});
        scheduleAgentEventRender();
      },
      onError: () => {
        // Socket errors are already handled by the subscriber's reconnect
        // logic; no TUI action needed (fail-open).
      },
    });

    // Start the subscription (fail-open: an unreachable socket keeps the
    // existing polling cadence and the resume-poll fallback).
    subscriber.connect().then((result) => {
      eventsActive = result.type === 'subscribed';
      if (eventsActive) {
        // The event path now handles hidden → visible transitions; stop the
        // resume-poll fallback (it may have started during the connect
        // window while eventsActive was still false).
        stopResumePoll();
        void syncPaneSubscriptions();
      }
    });
  }


  // Check if we're in raw mode (stdin is a TTY)
  const isInteractive = process.stdin.isTTY;
  let rawMode = false;

  // SGR mouse tracking is enabled by default (WL-0MT0AP2LR000JFWN). This is
  // a toggle state so the user can temporarily disable mouse tracking and use
  // the terminal's native text-selection to copy content from the terminal.
  let mouseTrackingEnabled = true;

  // Alt+m toggle handler (WL-0MT0AP2LR000JFWN): toggles mouse tracking on/off
  // by emitting the matching enable/disable ANSI sequences to the terminal.
  const toggleMouseTracking = (): void => {
    mouseTrackingEnabled = !mouseTrackingEnabled;
    process.stdout.write(
      mouseTrackingEnabled ? ANSI.mouseEnable : ANSI.mouseDisable,
    );
  };

  if (isInteractive) {
    try {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      rawMode = true;
      // SGR mouse tracking (WL-0MSGHM5BQ0096BNJ AC1): emit the enable
      // sequences when raw mode is entered so the terminal starts
      // delivering mouse events to stdin.
      process.stdout.write(ANSI.mouseEnable);
    } catch {
      // Not a TTY, use line-buffered mode
    }
  }

  // Setup cleanup
  const cleanup = (): void => {
    // Clear form mode on cleanup
    formState = null;
    state.mode = preFormMode;
    if (rawMode) {
      try {
        process.stdin.setRawMode?.(false);
      } catch {
        // ignore
      }
      // Disable SGR mouse tracking on exit (AC1) — only when raw mode was
      // entered.
      process.stdout.write(ANSI.mouseDisable);
    }
    process.stdin.pause();
    process.stdout.write(ANSI.showCursor);
    process.stdout.write(ANSI.reset);
  };

  // Event-subscriber teardown on TUI exit (WL-0MSHB7DHO004RHBJ F6): close
  // the socket and cancel reconnect timers so no connection leaks when the
  // plugin pane exits. Fail-open: a close failure is swallowed.
  const closeEventSubscriber = (): void => {
    if (subscriber) {
      subscriber.close().catch(() => {});
    }
  };

  // Data reading callback

  /**
   * In-flight guard: true while a refresh cycle is awaiting its fetcher/wl
   * calls. A refresh tick that fires while this is set is SKIPPED
   * (single-flight), so refresh cycles never overlap and wl processes cannot
   * pile up under load (WL-0MSBVYBMD004007C). Cleared in `finally` so a
   * rejecting fetcher can never leave the guard stuck. Per-pane scope
   * (declared inside runWorklistTui): panes refresh independently. A skipped
   * tick is not coalesced — the next tick or a manual refresh updates the
   * list (no stale-forever regression). Mirrors the `_syncInFlight` guard in
   * auto-sync.ts.
   */
  let refreshInFlight = false;

  /**
   * Fetch and apply updated items, with optional notification.
   */
  const doRefresh = async (showNotification = false): Promise<void> => {
    // Single-flight guard: skip the tick while the previous refresh cycle is
    // still running, so overlapping wl spawn bursts cannot happen.
    if (refreshInFlight) {
      return;
    }
    refreshInFlight = true;
    try {
      try {
        // Fetch the new top-level items and the children of currently
        // expanded parents in PARALLEL, then apply both in one synchronous
        // refreshItems step. The fetcher returns fresh top-level objects
        // without `children`, so a swap followed by an async children
        // re-fetch would render a collapsed intermediate state — the
        // "momentary collapse" flicker (WL-0MSBVBNGH002RDP5). Fetching
        // children up front removes that window entirely; refreshItems also
        // carries over previously fetched children as a safety net when a
        // children re-fetch fails.
        const expanded = [...state.expandedItems];
        const freshChildren = new Map<string, WorkItem[]>();
        const fetchExpandedChildren = async (parentId: string): Promise<WorkItem[]> => {
          try {
            // Depth derived from the item's hierarchy position so nested
            // expanded items re-fetch their children at the correct depth
            // (WL-0MSQ3FH1K000MMJW).
            const children = await fetchChildrenForItem(parentId, state.getItemDepth(parentId) + 1);
            freshChildren.set(parentId, children);
            return children;
          } catch {
            // Ignore: refreshItems carries over the previously fetched
            // children when the re-fetch fails.
            return [];
          }
        };
        const [newItems] = await Promise.all([
          fetchItemsForView(state.activeFilter, state.activePriorityFilter, fetcher),
          ...expanded.map(fetchExpandedChildren),
        ]);
        const oldLen = state.items.length;

        // Attach freshly fetched children to the new parent objects BEFORE
        // the swap so the flattened view is complete at render time.
        // Walks the whole tree (top-level + nested children) because
        // expandedItems may contain items at any depth: a nested parent is
        // not in the top-level id→item map, so without the walk its fresh
        // grandchildren would be dropped and the nested expansion would
        // collapse on refresh (WL-0MSQ3FH1K000MMJW AC-4).
        if (freshChildren.size > 0) {
          const attachFresh = (list: WorkItem[]): void => {
            for (const item of list) {
              const fresh = freshChildren.get(item.id);
              if (fresh) {
                item.children = fresh;
              }
              if (item.children && item.children.length > 0) {
                attachFresh(item.children);
              }
            }
          };
          for (const topLevel of newItems) {
            attachFresh([topLevel]);
          }
        }
        state.refreshItems(newItems);
        // Re-read the Code Freeze marker so a freeze that started (or ended)
        // since the last refresh is reflected in the banner promptly.
        refreshFreezeState();
        // Merge agent-status state into the refreshed items (top-level +
        // expanded children) so the agent icons reflect the latest tracker
        // state (WL-0MSBQUJQX005RAT9). Fail-open: no herdr CLI → no icons.
        try {
          await opts.mergeAgentStates?.(newItems);
        } catch {
          // Fail-open: a merge failure must never break the refresh cycle.
        }
        if (showNotification && newItems.length !== oldLen) {
          const diff = newItems.length - oldLen;
          const msg = diff > 0 ? `+${diff} new` : `${diff} removed`;
          showToast('Refreshed', { body: msg });
        } else if (showNotification) {
          showToast('Refreshed');
        }
      } catch {
        showToast('Refresh failed');
      }
      // Also fetch the total actionable count on refresh
      fetchActionableCount().then((count) => {
        totalActionableCount = count;
      }).catch(() => {
        // ignore
      });
      render();
    } finally {
      // Always clear the guard — a successful, failed, or aborted cycle must
      // never block the next refresh tick.
      refreshInFlight = false;
    }
  };

  // Wire the completion-triggered refresh hook (WL-0MT1KB70U0012X6T):
  // background (no-pane) shortcut dispatches receive this callback so their
  // child's 'exit' event can trigger a refresh of the current view. The
  // callback is fire-and-forget and non-blocking — doRefresh has its own
  // single-flight guard and never blocks the TUI event loop or the
  // dispatched command's own execution. Scoped to this TUI instance (no
  // global watcher, no cross-instance effects).
  opts.onRefresh = opts.onRefresh ?? (() => doRefresh(false));

  /**
   * True when the resolved command is a `/wl` view command — a stage filter
   * (`/wl <stage>`, shorthand alias or canonical name), a priority filter
   * (`/wl --priority <p>`, canonical name), or the clear-filter `/wl` with
   * no arguments. Used after dispatch to trigger a view refetch: filtered
   * views show every root item matching the filter's rule (`wl list --status
   * <status> --stage <stage> --root-only` / `--priority <p>`; see
   * STAGE_STATUS in fetcher.ts) — most stages show `open`-status items only,
   * while the in_review stage additionally includes `completed` and
   * `in-progress` items (WL-0MSKCRX730052IIW); clearing the filter restores
   * the default view (WL-0MSGSE15000746F7).
   */
  const isWlViewCommand = (cmd: string): boolean => {
    if (/^\/wl\s*$/.test(cmd)) return true;
    const stageMatch = cmd.match(/^\/wl\s+(\S+)$/);
    if (stageMatch !== null && STAGE_MAP[stageMatch[1]] !== undefined) return true;
    const priorityMatch = cmd.match(/^\/wl\s+--priority\s+(\S+)$/);
    return priorityMatch !== null && PRIORITY_MAP[priorityMatch[1]] !== undefined;
  };

  // True when a command modifies the work-item data set (close, delete,
  // update, reviewed, search), warranting an immediate list refresh so the
  // selection list reflects the change without waiting for the auto-refresh
  // cycle (WL-0MTA217DZ003H5K8).
  const isWlModifyingCommand = (cmd: string): boolean => {
    // Commands like "!!wl close <id>", "!!wl delete <id>", "!!wl update <id> ..."
    if (/^!!\s*wl\s+(close|delete|update|reviewed|search)\b/i.test(cmd)) return true;
    return false;
  };

  // Run `wl sync` and surface the outcome as a toast so sync status is
  // visible (success and graceful failure). Targets the resolved worklog
  // directory so sync operates on the tab project.
  //
  // With ifIdle=true (auto-sync timer path) runSync applies its single-flight
  // guard and passes --if-idle to the CLI, so overlapping syncs are skipped
  // instead of piling up (lock-storm prevention). With a heartbeatTtlMs the
  // auto-sync path ALSO skips without spawning when another pane synced
  // recently (cross-instance coordination, F3 — WL-0MSGAEJQA005QG3W); such
  // skips are silent because the data is already fresh. The manual 'S' sync
  // binding was removed (WL-0MSGG5N5Z0074TLY) — doSync is now reached only
  // from the auto-sync timer path.
  const doSync = async (ifIdle = false, heartbeatTtlMs?: number): Promise<void> => {
    const outcome = await runSync(getWorklogDir(), {
      ifIdle,
      ...(heartbeatTtlMs !== undefined ? { heartbeat: true, heartbeatTtlMs } : {}),
    });
    if (outcome.skipped) {
      // Heartbeat skip: another pane synced within the window — silent.
      if (outcome.reason === 'heartbeat') return;
      // Another sync is already in-flight / holding the lock — do not pile on.
      showToast('Sync in progress');
      return;
    }
    if (outcome.success) {
      showToast('Synced');
    } else {
      showToast('Sync failed', { body: outcome.error ?? 'unknown error' });
    }
  };

  /**
   * Open the Ship It confirmation dialog (WL-0MSGG5N5Z0074TLY).
   *
   * The dev→main release shortcut requires the user to type `ship`
   * (case-insensitive) and press Enter before the command is dispatched.
   * Dispatch (on confirm) goes through the SAME standard command-routing
   * path as every other shortcut — executeResolvedCommand →
   * dispatchChordCommand (which recognizes the `/skill:ship` family) →
   * onCommand — with NO `<id>` substitution (global release). Esc cancels
   * without dispatching.
   */
  const openShipItDialog = (model?: string): void => {
    shipItDialog = new ShipItDialogState(
      // onConfirm — typed 'ship' + Enter: dispatch via the standard path.
      () => {
        try {
          // Fresh marker read at dispatch time (fail-safe client-side).
          const frozen = readCodeFreezeState().active;
          if (frozen) {
            codeFreezeActive = true;
          }
          const result = executeResolvedCommand(SHIP_IT_COMMAND, state, opts.onCommand, frozen, model, opts.onDowntimeToggle, undefined, opts.onRefresh);
          if (result === 'noop') {
            showToast('Skipped', { body: `${SHIP_IT_COMMAND} (no item)` });
          } else {
            showToast('Sent', { body: SHIP_IT_COMMAND });
          }
        } catch (e) {
          showToast('Error', { body: (e as Error).message });
          process.stderr.write(`[herdr] Command error: ${(e as Error).message}\n`);
        }
      },
      // onCancel — Esc: nothing is dispatched.
      () => {
        // no-op: dialog state is cleared by the onData handler.
      },
    );
    render();
  };

  // Double-click state tracker — persists across onData calls for the TUI
  // lifetime. Updated on every left-press so handleMouseInput can detect
  // double-clicks within {@link DOUBLE_CLICK_WINDOW_MS}. (WL-0MSGHM5BQ0096BNJ AC3)
  let clickState: MouseClickState = { lastClick: null, now: 0 };

  // ── Mouse event dispatch (WL-0MSGHM5BQ0096BNJ AC2–AC6) ─────────
  // handleMouseInput parses SGR mouse events from the raw chunk BEFORE the
  // keypress path and dispatches them (click select, double-click open,
  // wheel/scroll, filter tap). Mouse-shaped sequences are fully consumed;
  // plain keys and foreign escapes fall through to the keyboard handler
  // untouched (AC6). See the fix note in handleMouseInput for the
  // single-click-select vs double-click-open ordering (WL-0MSZBWT500034E74).
  const dispatchMouse = (key: string): boolean =>
    handleMouseInput(state, key, termSize, clickState);

  const onData = async (chunk: Buffer): Promise<void> => {
    const key = chunk.toString();

    // Alt+m toggle shortcut (WL-0MT0AP2LR000JFWN): always available,
    // even in modal states. Toggles mouse tracking on/off so the user
    // can use the terminal's native text-selection to copy content.
    if (key === '\x1bm') {
      toggleMouseTracking();
      render();
      return;
    }

    // Try mouse event dispatch first — only runs when the pane is not in a
    // modal state (code-freeze notice, form, ship-it dialog), matching the
    // keyboard path. Mouse input is ignored during those modal states.
    if (!codeFreezeNotice && formState === null && shipItDialog === null) {
      if (dispatchMouse(key)) {
        render();
        return;
      }
    }

    // ── Code Freeze notice handling ─────────────────────────────
    // While the notice is showing, Esc/Enter/q dismiss it and return to the
    // list. All other keys are consumed (the notice is modal). The blocked
    // command is never executed, so no pane is spawned.
    if (codeFreezeNotice) {
      if (key === '\x1b' || key === '\r' || key === '\n' || key === 'q') {
        codeFreezeNotice = false;
      }
      render();
      return;
    }

    // ── Form mode handling ──────────────────────────────────────
    if (formState !== null) {
      const result = formState.handleInput(key);
      if (result.type === 'submitted') {
        const resolved = formState.getResult();
        formState = null;
        state.mode = preFormMode;
        // NOTE: dispatch happens inside FormState's onSubmit callback (which
        // resolves <id> placeholders) — do NOT call onCommand again here or
        // every form submission spawns TWO agent panes (WL-0MSAL0RN1009YNJ7).
        showToast('Sent', { body: resolved.length > 60 ? resolved.substring(0, 57) + '...' : resolved });
        render();
      } else if (result.type === 'cancelled') {
        formState = null;
        state.mode = preFormMode;
        render();
      } else if (result.type === 'paste') {
        // Ctrl+V: read the OS clipboard asynchronously (never freezes the
        // TUI), then commit the text verbatim or surface a graceful failure
        // and keep the form open (WL-0MSW6KCTA0092DCV).
        const read = await readFromClipboard();
        if (read.success && read.text !== undefined) {
          formState.pasteText(read.text);
        } else {
          const reason = read.error ?? 'Clipboard read failed';
          formState.notifyPasteFailed(reason);
          showToast('Paste failed', { body: reason });
        }
        render();
      } else if (result.type === 'cut') {
        // Ctrl+X: copy the active field value to the OS clipboard
        // asynchronously and surface feedback. On failure the field value is
        // restored so no data is lost (WL-0MSW6KCTA0092DCV).
        const copy = await writeToClipboard(result.text);
        if (copy.success) {
          showToast('Copied', { body: result.text.length > 40 ? result.text.substring(0, 37) + '...' : (result.text || '(empty)') });
        } else {
          formState.pasteText(result.text);
          showToast('Copy failed', { body: copy.error ?? 'Clipboard unavailable' });
        }
        render();
      } else {
        render();
      }
      return;
    }

    // ── Ship It confirmation dialog handling (WL-0MSGG5N5Z0074TLY) ────
    // While the dialog is open, all keys are consumed by the dialog:
    // printable characters append to the typed buffer, Backspace deletes,
    // Enter submits (dispatching only when the buffer matches `ship`
    // case-insensitively), Esc cancels. The list stays visible beneath the
    // bottom-anchored overlay.
    if (shipItDialog !== null) {
      const result = shipItDialog.handleInput(key);
      if (result === 'submitted' || result === 'cancelled') {
        shipItDialog = null;
      }
      render();
      return;
    }

    if (key === 'q' && state.mode !== 'filter') {
      cleanup();
      resolve(undefined);
      return;
    }

    // ── Chord mode handling ────────────────────────────────────
    if (chordState.pendingKeys.length > 0) {
      // We're in chord mode — process the next key
      const chordResult = processChordInput(
        chordState,
        key,
        shortcutRegistry as ShortcutRegistry,
        state.mode === 'detail' ? 'detail' : 'list',
        state.activeFilter ?? undefined,
        codeFreezeActive,
        state.getSelectedItem()?.issueType,
      );

      if (chordResult === 'chord-complete') {
        // Chord resolved — execute the command
        let command = chordState.resolvedCommand;
        const model = chordState.resolvedModel;
        // openPane: undefined (default) = open a pane; false = background,
        // no pane (WL-0MSJLD1I70045ZUL). Cleared after execution.
        const openPane = chordState.resolvedOpenPane;
        chordState.resolvedCommand = null;
        chordState.resolvedModel = null;
        chordState.resolvedOpenPane = undefined;
        if (command) {
          // Podcast-progression markers (<podcast-target>/<podcast-script>/
          // <podcast-review>/<podcast-both>) are resolved from the selected
          // item's context BEFORE the generic modal-form check so they never
          // fall through to the input form (OSL-0MSKFXM380098LFL, folding in
          // OSL-0MSHFQ51L009IUOS; w-chord split OSL-0MSKVB5K6008XFOQ).
          if (command.includes('<podcast-target>') || command.includes('<podcast-script>')
              || command.includes('<podcast-review>') || command.includes('<podcast-both>')) {
            const podcast = await resolvePodcastTarget(command, state.getSelectedItem());
            if (podcast.error) {
              showToast('Error', { body: podcast.error });
              render();
              return;
            }
            command = podcast.command ?? command;
          }
          // Ship It confirmation (WL-0MSGG5N5Z0074TLY): the dev→main
          // release command, however it reaches this path, requires a typed
          // 'ship' confirmation before dispatch. Esc cancels, the dialog
          // stays bottom-anchored over the list.
          if (command === SHIP_IT_COMMAND) {
            openShipItDialog(model ?? undefined);
            return;
          }
          // Inline note-edit chords (WL-0MSKV6SKK008MMXR): add/edit/delete
          // `[NOTE ...]` markers in the md viewer. Scoped to the detail
          // view via shortcuts.json (view: 'detail'), so the `<note_text>`
          // placeholder only reaches this branch from the viewer.
          if (command === '/herdr:note-edit <note_text>'
              || command === '/herdr:note-delete') {
            const mdPaths = state.detailItem
              ? extractFilePaths(state.detailItem.description ?? '')
                  .filter(p => p.endsWith('.md'))
              : [];
            const mdPath = mdPaths[state.detailRenderedIndex] ?? mdPaths[0];
            if (!mdPath) {
              showToast('Note', { body: 'No markdown document in this view.' });
              render();
              return;
            }
            const content = readKeyFile(mdPath);
            if (content == null) {
              showToast('Note', { body: 'Markdown document unreadable.' });
              render();
              return;
            }
            // The visible cursor line (scroll offset) maps to the source
            // paragraph the user has scrolled to.
            const paragraphIndex = mapCursorToParagraph(content, state.detailScrollOffset);
            state.detailNoteCursor = Math.max(0, paragraphIndex);
            const marker = mapParagraphToMarker(content, state.detailNoteCursor);

            // Candidate episodes for PRD §7.3 note-child sync: the selected
            // item (an episode's Key Files include the script) plus the
            // loaded worklist items, deduplicated by id. Empty for generic
            // markdown never invokes `wl` (local placeholder ids only).
            const episodeItems = buildEpisodeCandidates(state);

            if (command === '/herdr:note-delete') {
              if (!marker) {
                showToast('Note', { body: 'No note on this paragraph.' });
                render();
                return;
              }
              const result = await applyNoteEditToFile(
                state.detailItem,
                mdPath,
                { kind: 'remove', noteId: marker.noteId },
                readKeyFile,
                writeKeyFile,
                episodeItems,
              );
              if (result.byteOffset < 0) {
                showToast('Note', { body: 'Delete did not apply.' });
              } else if (result.warning) {
                showToast('Warning', { body: result.warning });
              } else {
                showToast('Note deleted', { body: `${marker.noteId} removed.` });
              }
              render();
              return;
            }

            // Add/edit: open the note-text form, pre-filled in edit mode.
            const existing = marker ? findNoteInParagraph(
              splitParagraphs(content)[state.detailNoteCursor]?.text ?? '',
            ) : null;
            const prefill = existing ? existing.body : '';
            const template = existing
              ? `/herdr:note-edit <note_text default="${prefill.replace(/"/g, '&quot;')}">`
              : '/herdr:note-edit <note_text>';
            const noteId = existing?.id ?? undefined;
            preFormMode = state.mode;
            state.mode = 'form';
            formState = new FormState(
              template,
              'Note text (inline [NOTE <id>: ...] marker, PRD §7.1)',
              getUnknownIdentifiers(template),
              // onSubmit: apply the edit and re-render.
              async (resolved: string) => {
                const textMatch = resolved.match(/note_text[= >]*([\s\S]*)$/);
                const text = (textMatch ? textMatch[1] : resolved).trim();
                formState = null;
                state.mode = preFormMode;
                const action = noteId
                  ? { kind: 'update' as const, noteId, text }
                  : { kind: 'insert' as const, paragraphIndex: state.detailNoteCursor, text };
                const result = await applyNoteEditToFile(
                  state.detailItem,
                  mdPath,
                  action,
                  readKeyFile,
                  writeKeyFile,
                  episodeItems,
                );
                if (result.byteOffset < 0) {
                  showToast('Note', { body: 'Edit did not apply.' });
                } else if (result.warning) {
                  showToast('Warning', { body: result.warning });
                } else {
                  showToast('Note saved', { body: `${result.newNoteId ?? noteId ?? 'marker'} written.` });
                }
                render();
              },
              // onCancel
              () => {
                formState = null;
                state.mode = preFormMode;
              },
            );
            render();
            return;
          }
          // Check for unknown identifiers that need form input
          if (hasUnknownIdentifiers(command)) {
            // Look up description from shortcut entry
            let description = '';
            if (shortcutRegistry) {
              const entries = (shortcutRegistry as ShortcutRegistry).getEntries();
              // Reconstruct the full chord that was just completed
              // The chord key sequences are available from the pending keys
              const matchingEntry = entries.find(e => e.command === command);
              if (matchingEntry && matchingEntry.description) {
                description = matchingEntry.description;
              }
            }
            const unknownIds = getUnknownIdentifiers(command);
            preFormMode = state.mode;
            state.mode = 'form';
            formState = new FormState(
              command,
              description,
              unknownIds,
              // onSubmit: resolve and execute
              (resolved: string) => {
                // Handle <id> resolution
                let finalCmd = resolved;
                if (finalCmd.includes('<id>')) {
                  const selected = state.getSelectedItem();
                  if (selected) {
                    finalCmd = finalCmd.replace(/<id>/g, selected.id);
                  }
                }
                // Record the submitted command against its work item before
                // routing it (WL-0MSEPP104006PS7T).
                logCommandForItem(finalCmd, extractWorkItemIdFromCommand(finalCmd));
                // Code Freeze guard: never submit an implement command while
                // frozen — show the notice instead of dispatching.
                if (readCodeFreezeState().active && isImplementCommand(finalCmd)) {
                  codeFreezeNotice = true;
                  return;
                }
                if (opts.onCommand) {
                  opts.onCommand(finalCmd, model ?? undefined);
                }
              },
              // onCancel
              () => {
                formState = null;
                state.mode = preFormMode;
              },
            );
            render();
            return;
          }

          // No unknown identifiers — execute as before
          try {
            // Fresh marker read at dispatch time: a freeze that started
            // between refreshes is enforced here (fail-safe client-side).
            const frozen = readCodeFreezeState().active;
            if (frozen) {
              codeFreezeActive = true;
            }
            const result = executeResolvedCommand(command, state, opts.onCommand, frozen, model ?? undefined, opts.onDowntimeToggle, openPane, opts.onRefresh);
            if (result === 'blocked') {
              // Code Freeze — show the notice dialog; the command was NOT
              // routed, no pane spawned, no work item claimed.
              codeFreezeNotice = true;
            } else if (result === 'noop') {
              showToast('Skipped', { body: `${command.length > 60 ? command.substring(0, 57) + '...' : command} (no item)` });
            } else {
              // Surface a brief toast, then continue
              showToast('Sent', { body: command.length > 60 ? command.substring(0, 57) + '...' : command });
            }
            // Stage-filter dispatch (/wl <stage> or f-chord shortcut): refetch
            // so the filtered view shows every root item in the stage matching
            // the stage's status rule, not just the already-loaded subset
            // (WL-0MSDT8X1V003206G).
            // Modifying-command dispatch (close, delete, update, reviewed,
            // search): refetch so the selection list reflects the change
            // immediately instead of waiting for the auto-refresh cycle
            // (WL-0MTA217DZ003H5K8).
            if (result === 'dispatched' && (isWlViewCommand(command) || isWlModifyingCommand(command))) {
              await doRefresh(true);
            }
          } catch (e) {
            showToast('Error', { body: (e as Error).message });
            process.stderr.write(`[herdr] Command error: ${(e as Error).message}\n`);
          }
          render();
          return;
        }
        // No command — fall through to normal handling
      }

      if (chordResult === 'chord-cancel') {
        // Cancel chord, continue in normal mode
        render();
        return;
      }

      // Still collecting chord keys
      render();
      return;
    }

    // ── Normal key handling ────────────────────────────────────
    // Save mode before processing — selectItem() changes mode to 'detail',
    // but we need to distinguish "just entered detail" from "confirm in detail".
    const prevMode = state.mode;
    // Compute the dynamic panel height so metaScrollDown clamps correctly
    // (WL-0MSQ44MDX008U69J). The value is used only for the m/M scroll
    // clamping — the actual rendering is done by createListRenderer.
    const displayItems = state.mode === 'list'
      ? state.getDisplayRows()
      : state.items;
    const bannerCount = (codeFreezeActive ? 1 : 0) + (codeFreezeAmbiguous ? 1 : 0);
    const { panelHeight } = computeDynamicLayout(
      displayItems,
      state.scrollOffset,
      bannerCount,
      termSize,
    );
    const action = handleKeypress(state, key, termSize, panelHeight);

    // If key wasn't handled as navigation and chord registry exists,
    // check if it's a shortcut or part of a chord sequence
    if (shortcutRegistry && (action === null || isChordLeader(key, shortcutRegistry as ShortcutRegistry, codeFreezeActive, state.getSelectedItem()?.issueType))) {
      // First: check if this key is a complete single-key shortcut
      const singleEntry = (shortcutRegistry as ShortcutRegistry).lookupChordEntry(
        [key],
        state.mode === 'detail' ? 'detail' : 'list',
        state.activeFilter ?? undefined,
        codeFreezeActive,
        state.getSelectedItem()?.issueType,
      );
      if (singleEntry) {
        let singleCmd = singleEntry.command;
        const singleModel = singleEntry.model ?? undefined;
        // openPane: undefined (default) = open a pane; false = background,
        // no pane (WL-0MSJLD1I70045ZUL).
        const singleOpenPane = singleEntry.openPane ?? undefined;
        // Podcast-progression markers (<podcast-target>/<podcast-script>/
        // <podcast-review>/<podcast-both>) are resolved from the selected
        // item's context BEFORE the generic modal-form check so they never
        // fall through to the input form (OSL-0MSKFXM380098LFL, folding in
        // OSL-0MSHFQ51L009IUOS; w-chord split OSL-0MSKVB5K6008XFOQ).
        if (singleCmd.includes('<podcast-target>') || singleCmd.includes('<podcast-script>')
            || singleCmd.includes('<podcast-review>') || singleCmd.includes('<podcast-both>')) {
          const podcast = await resolvePodcastTarget(singleCmd, state.getSelectedItem());
          if (podcast.error) {
            showToast('Error', { body: podcast.error });
            render();
            return;
          }
          singleCmd = podcast.command ?? singleCmd;
        }
        // Ship It (S) — typed-confirmation dialog (WL-0MSGG5N5Z0074TLY):
        // the dev→main release shortcut does NOT dispatch immediately. It
        // opens a bottom-anchored confirmation dialog that keeps the
        // selection list visible; the user must type `ship` + Enter to
        // dispatch, Esc to cancel.
        if (singleCmd === SHIP_IT_COMMAND) {
          openShipItDialog(singleModel);
          return;
        }
        // Single-key shortcut — check for unknown identifiers first
        if (hasUnknownIdentifiers(singleCmd)) {
          let description = '';
          if (singleEntry.description) {
            description = singleEntry.description;
          }
          const unknownIds = getUnknownIdentifiers(singleCmd);
          preFormMode = state.mode;
          state.mode = 'form';
          formState = new FormState(
            singleCmd,
            description,
            unknownIds,
            (resolved: string) => {
              let finalCmd = resolved;
              if (finalCmd.includes('<id>')) {
                const selected = state.getSelectedItem();
                if (selected) {
                  finalCmd = finalCmd.replace(/<id>/g, selected.id);
                }
              }
              // Record the submitted command against its work item before
              // routing it (WL-0MSEPP104006PS7T).
              logCommandForItem(finalCmd, extractWorkItemIdFromCommand(finalCmd));
              // Code Freeze guard: never submit an implement command while
              // frozen — show the notice instead of dispatching.
              if (readCodeFreezeState().active && isImplementCommand(finalCmd)) {
                codeFreezeNotice = true;
                return;
              }
              if (opts.onCommand) {
                opts.onCommand(finalCmd, singleModel);
              }
            },
            () => {
              formState = null;
              state.mode = preFormMode;
            },
          );
          render();
          return;
        }

        // Single-key shortcut — execute immediately and keep TUI alive
        try {
          // Fresh marker read at dispatch time (fail-safe client-side).
          const frozen = readCodeFreezeState().active;
          if (frozen) {
            codeFreezeActive = true;
          }
          const result = executeResolvedCommand(singleCmd, state, opts.onCommand, frozen, singleModel, opts.onDowntimeToggle, singleOpenPane, opts.onRefresh);
          if (result === 'blocked') {
            // Code Freeze — show the notice dialog; no pane spawned.
            codeFreezeNotice = true;
          } else {
            // Surface a brief toast, then continue
            showToast('Sent', { body: singleCmd.length > 60 ? singleCmd.substring(0, 57) + '...' : singleCmd });
          }
          // Stage-filter dispatch (/wl <stage> or f-chord shortcut): refetch
          // so the filtered view shows every root item in the stage matching
          // the stage's status rule, not just the already-loaded subset
          // (WL-0MSDT8X1V003206G).
          // Modifying-command dispatch (close, delete, update, reviewed,
          // search): refetch so the selection list reflects the change
          // immediately instead of waiting for the auto-refresh cycle
          // (WL-0MTA217DZ003H5K8).
          if (result === 'dispatched' && (isWlViewCommand(singleCmd) || isWlModifyingCommand(singleCmd))) {
            await doRefresh(true);
          }
          render();
        } catch (e) {
          showToast('Error', { body: (e as Error).message });
          process.stderr.write(`[herdr] Shortcut error: ${(e as Error).message}\n`);
          render();
        }
        return;
      }

      // Second: check if this key starts a multi-key chord sequence
      if (isChordLeader(key, shortcutRegistry as ShortcutRegistry, codeFreezeActive, state.getSelectedItem()?.issueType)) {
        const nextChords = (shortcutRegistry as ShortcutRegistry).getChordByPrefix([key],
          state.mode === 'detail' ? 'detail' : 'list',
          state.activeFilter ?? undefined,
          codeFreezeActive,
          state.getSelectedItem()?.issueType);
        if (nextChords.length > 0) {
          chordState.pendingKeys = [key];
          chordState.hints = formatChordHintsForHelp(nextChords, [key]);
          chordState.resolvedCommand = null;
          chordState.resolvedModel = null;
          render();
          return;
        }
      }
    }

    if (action === 'refresh') {
      await doRefresh(true);
      return;
    }

    if (action === 'select' && prevMode === 'detail') {
      cleanup();
      resolve(state.detailItem ?? undefined);
      return;
    }

    if (action === 'toggle-expand' && state.mode === 'list') {
      const selected = state.getSelectedItem();
      if (selected) {
        // If children data not yet loaded, fetch them on demand
        if (selected.childCount && selected.childCount > 0 && (!selected.children || selected.children.length === 0)) {
          render(); // immediate render while fetch is pending
          // Depth derived from the selected item's hierarchy position so
          // grandchildren of a nested item fetch at depth N+1, not 1
          // (WL-0MSQ3FH1K000MMJW).
          const children = await fetchChildrenForItem(selected.id, (selected.depth ?? 0) + 1);
          // Attach to the live tree object so the fetched grandchildren
          // survive the flatten (which may hold a copy with a corrected
          // depth) — see WorkItemListState.attachChildren.
          state.attachChildren(selected.id, children);
          // Merge agent-status state into the freshly loaded children so
          // their rows show agent icons too (WL-0MSBQUJQX005RAT9).
          try {
            await opts.mergeAgentStates?.([selected]);
          } catch {
            // Fail-open: a merge failure must never break expansion.
          }
          state.toggleExpand(selected.id);
          render();
          return;
        }
      }
    }

    // Re-render
    render();
  };

  let resolve: (value: WorkItem | undefined) => void;
  const promise = new Promise<WorkItem | undefined>((res) => {
    resolve = res;
  });

  /**
   * Read a Key Files: markdown document (e.g. an episode .podcast.md) for
   * the generic md viewer in the detail pane. Paths are resolved against
   * the worklog root (via resolveKeyFilePath) — the plugin pane's process
   * CWD is the plugin source dir, not the worklog root
   * (WL-0MSGEA9AY0080V4Q). Fail-open: unreadable or missing files yield
   * null and the detail view falls back to the raw description.
   */
  const readKeyFile = (filePath: string): string | null => {
    const resolved = resolveKeyFilePath(filePath);
    if (!resolved) return null;
    try {
      return readFileSync(resolved, 'utf-8');
    } catch {
      return null;
    }
  };

  /**
   * Write a Key Files: markdown document back to disk (WL-0MSKV6SKK008MMXR
   * note-edit write-back). Path resolution mirrors `readKeyFile`
   * (resolveKeyFilePath against the worklog root); a missing resolved path
   * is a silent no-op so the TUI never crashes on a stale Key Files entry.
   */
  const writeKeyFile = (filePath: string, content: string): void => {
    const resolved = resolveKeyFilePath(filePath);
    if (!resolved) return;
    try {
      writeFileSync(resolved, content, 'utf-8');
    } catch (error) {
      process.stderr.write(`[herdr] Note write-back failed: ${String(error)}\n`);
    }
  };

  const render = (): void => {
    termSize = getTermSize();
    state.termSize = termSize;

    // ── Form overlay rendering ─────────────────────────────────
    if (formState !== null) {
      const formOutput = formState.render(termSize.cols, termSize.rows);
      process.stdout.write(ANSI.clear);
      process.stdout.write(ANSI.cursorHome);
      process.stdout.write(formOutput);
      return;
    }

    // ── Code Freeze notice overlay rendering ───────────────────
    // Shown when an implement command was attempted during a freeze. The
    // freeze reason (if any) comes from the marker for a helpful message.
    if (codeFreezeNotice) {
      const freezeReason = readCodeFreezeState().reason;
      const dialogOutput = formatCodeFreezeDialog(termSize.cols, termSize.rows, freezeReason);
      process.stdout.write(ANSI.clear);
      process.stdout.write(ANSI.cursorHome);
      process.stdout.write(dialogOutput);
      return;
    }

    // Use the display-rows model for list rendering (headings + items,
    // WL-0MSL5MPSZ003TG94). Heading rows have no stage/issueType, so
    // shortcut hints fall back to defaults for heading selections.
    const displayItems = state.mode === 'list' ? state.getDisplayRows() : state.items;

    // ── Compute stage-appropriate shortcut hints for the footer ──
    let dynamicHints = '';
    if (shortcutRegistry && chordState.pendingKeys.length === 0) {
      const reg = shortcutRegistry as ShortcutRegistry;
      const selIdx = state.selectedIndex;
      const selItem = displayItems.length > 0 && selIdx < displayItems.length
        ? displayItems[selIdx]
        : undefined;
      // Narrow the display-row union: heading rows carry no work-item
      // fields (stage/issueType belong to WorkItem rows only).
      const selStage =
        selItem !== undefined && !isHeadingRow(selItem) ? selItem.stage : undefined;
      const selIssueType =
        selItem !== undefined && !isHeadingRow(selItem) ? selItem.issueType : undefined;
      const isEmpty = displayItems.length === 0;

      const relevantEntries = reg.getEntriesForStage(selStage, codeFreezeActive, selIssueType)
        .filter(e => e.view === 'list' || e.view === 'both')
        .filter(e => {
          if (isEmpty && e.command.includes('<id>')) return false;
          return true;
        });

      if (relevantEntries.length > 0) {
        const seenChordLeaders = new Set<string>();
        const hints = relevantEntries
          .filter(e => {
            if (e.chord && e.chord.length >= 2) {
              const leader = e.chord[0];
              if (seenChordLeaders.has(leader)) return false;
              seenChordLeaders.add(leader);
            }
            return true;
          })
          .map(e => {
            const label = e.label ?? e.command
              .replace(/<[^>]+>/g, '')
              .split(/\r?\n/)[0]
              .trim()
              .replace(/^\/(skill:)?/, '');
            if (e.chord && e.chord.length >= 2) {
              const leaderKey = e.chord[0];
              const firstWord = label.split(/\s+/)[0];
              return `${leaderKey}:${firstWord}...`;
            }
            return `${e.chord[0]}:${label}`;
          })
          .join('  ');
        dynamicHints = hints;
      }
    }

    // Mouse-tracking toggle hint (WL-0MT0AP2LR000JFWN): appends the Alt+m
    // toggle to the footer shortcut hints so the user knows how to switch
    // between mouse interaction and native text-selection (drag-select).
    // Shown whenever help text is enabled.
    if (opts.getShowHelpText()) {
      const mouseHint = mouseTrackingEnabled
        ? `alt+m mouse on`
        : `alt+m mouse off`;
      dynamicHints = dynamicHints ? `${dynamicHints}  ${mouseHint}` : ` ${mouseHint}`;
    }

    // Look up the selected item's last recorded command for the metadata
    // panel (only shown for in_progress items). Best effort: a missing or
    // unreadable log yields undefined and the panel falls back gracefully.
    let metaLastCommand: string | undefined;
    if (state.mode === 'list') {
      const selected = state.getSelectedItem();
      if (selected && selected.stage === 'in_progress') {
        try {
          metaLastCommand = getLastCommand(selected.id)?.command ?? undefined;
        } catch {
          // ignore: panel shows the graceful "none yet" fallback
        }
      }
    }

    // ── Hover tooltip (WL-0MT9XRZDK006GMUH) ────────────────────────
    // Build the tooltip lines for the currently hovered row when it is a
    // work item with an associated agent-pane and the tooltip has not been
    // dismissed by Esc. Fail-open: any lookup error yields no tooltip.
    let hoverTooltipLines: string[] | undefined;
    if (state.mode === 'list' && !state.tooltipDismissed && state.hoveredRowIndex !== null) {
      try {
        const rows = state.getDisplayRows();
        const row = rows[state.hoveredRowIndex];
        if (row !== undefined && !isHeadingRow(row)) {
          const entry = agentTracker?.getEntry(row.id) ?? undefined;
          if (entry) {
            hoverTooltipLines = formatTooltipLines(
              row,
              entry.command,
              entry.recordedAt,
              termSize.cols,
              !opts.showIcons,
            );
          }
        }
      } catch {
        // Fail-open: never let a tooltip lookup break rendering.
      }
    }

    const output = renderer(
      displayItems,
      state.selectedIndex,
      state.scrollOffset,
      termSize,
      state.activeFilterLabel,
      state.mode,
      state.detailItem,
      totalActionableCount,
      chordState,
      state.detailScrollOffset,
      opts.autoRefresh,
      state.expandedItems,
      opts.getShowHelpText() ? dynamicHints : undefined,
      state.navigationStack.depth,
      panePaused,
      codeFreezeActive,
      state.metaScrollOffset,
      metaLastCommand,
      readKeyFile,
      renderDowntimeStatus(opts.downtimeWorker),
      state.detailToCIndex,
      state.detailToCFocus,
      state.detailRenderedIndex,
      // Gate the chord-in-progress footer behind showHelpText so `false` hides
      // ALL shortcut hint lines (normal and chord-mode), matching the pi browse
      // widget (WL-0MSGJDSMJ004128E). Chord key handling is unaffected.
      opts.getShowHelpText(),
      // Ambiguous code-freeze marker banner state (WL-0MSQ0RPQP00636JY):
      // distinct from the active-freeze banner; both can render (defensive)
      // but the tri-state read guarantees at most one is true.
      codeFreezeAmbiguous,
      // Hover tooltip lines for the footer overlay (WL-0MT9XRZDK006GMUH).
      hoverTooltipLines,
    );

    // Notifications are surfaced via Herdr toasts (showToast), never as a
    // bottom line — the pane output must stay within the terminal budget.
    const rendered = output;

    // ── Ship It confirmation dialog overlay (WL-0MSGG5N5Z0074TLY) ─────
    // Bottom-anchored: the selection list is rendered normally and the
    // dialog replaces only the lower rows, so the list stays visible above
    // it (contrast: FormState full-screen, Code Freeze notice centered
    // full-pane box). The overlay never exceeds the `rows - 1` budget.
    const finalOutput = shipItDialog !== null
      ? overlayShipItDialog(rendered, termSize.cols, termSize.rows, shipItDialog.buffer)
      : rendered;

    // Clear from cursor to end of screen to remove leftover content
    // from previous renders of different heights
    process.stdout.write(ANSI.clear);
    process.stdout.write(ANSI.cursorHome);
    process.stdout.write(finalOutput);
  };

  // Initial render
  render();

  // Handle resize events
  const onResize = (): void => {
    termSize = getTermSize();
    state.termSize = termSize;
    render();
  };

  process.stdout.on('resize', onResize);

  // Read keypresses
  process.stdin.on('data', onData);

  // ── Consolidated scheduler loop (WL-0MSG4NMF0000YBRP) ──────────────
  // All periodic plugin work — auto-refresh, auto-sync, visibility
  // resume-poll, and future downtime-worker ticks — runs through ONE
  // TaskScheduler interval. Tasks are dispatched by due-time deadline at a
  // 1s base tick; each task applies its own visibility gate (refresh/sync
  // skip when hidden, resume-poll only runs while hidden). Tick cadence,
  // pause-when-hidden gating, and shutdown cleanup live in one place.
  const scheduler = new TaskScheduler(DEFAULT_SCHEDULER_TICK_MS);

  // DB-change tracker: detects whether the worklog DB has changed since the
  // last cycle. Used to gate auto-refresh/sync ticks so idle panes spawn
  // zero wl processes (WL-0MSJ1OLTL009N4IQ). Created only when we can
  // resolve the worklog dir (set via fetcher.setWorklogDir()); otherwise
  // the gate is effectively disabled (fail-open: all ticks run).
  const worklogDir = getWorklogDir();
  const tracker = worklogDir
    ? new DbChangeTracker(resolveCacheDir(), worklogDir)
    : null;

  const stopResumePoll = (): void => {
    scheduler.setDisabled('resume-poll', true);
  };

  /** Start the resume poll (no-op when already running). */
  const startResumePoll = (): void => {
    scheduler.setDisabled('resume-poll', false);
  };

  /**
   * Whether the resume-poll fallback should run. The resume-poll is only
   * the FALLBACK for the hidden → visible transition — when the event
   * subscription is active, `pane_focused` events handle it instead, so the
   * polling task stays disabled (WL-0MSHB7DHO004RHBJ F3).
   */
  const resumePollEnabled = (): boolean => !eventsActive;

  // Auto-refresh task — fetches fresh items on an interval. NOTE: this task
  // does NOT run `wl sync`; the dedicated sync task below is the single sync
  // source. Running sync from both tasks caused a double-spawn per pane that
  // amplified the wl sync lock storm (WL-0MSAB7ZUC004SK7E).
  // Visibility-gated: when the pane is hidden (not focused), ticks are
  // skipped so hidden panes spawn zero wl processes (pause-when-hidden).
  if (opts.autoRefresh) {
    scheduler.addTask({
      id: 'refresh',
      intervalMs: opts.refreshIntervalMs,
      singleFlight: true,
      run: async () => {
        if (!(await paneGate.visible())) {
          panePaused = true;
          if (resumePollEnabled()) startResumePoll();
          return;
        }
        stopResumePoll();
        panePaused = false;
        // DB-change gate: skip when DB unchanged since last cycle
        if (tracker && !tracker.dbChanged()) {
          return; // DB unchanged — zero wl spawns for this tick
        }
        doRefresh(false);
      },
    });
  }

  // Auto-sync task (background wl sync) — the only auto-sync source. Uses
  // the single-flight + lock-aware (--if-idle) guard so concurrent
  // panes/TUI instances skip instead of piling up under lock contention,
  // and the cross-instance heartbeat (F3) so only the first pane per window
  // spawns `wl sync` at all. Visibility-gated like the refresh task: hidden
  // panes skip the sync (and its follow-up refresh) entirely. Fires once
  // immediately on start (as the previous SyncTimer did) so the first sync
  // cycle is not delayed.
  if (opts.autoSync && opts.syncIntervalMs !== 0) {
    // Heartbeat window tied to the configured interval (interval minus a 15s
    // margin) so the sync cadence still lands ~once per interval while only
    // the first pane per window spawns a process.
    const heartbeatTtlMs = heartbeatTtlForInterval(opts.syncIntervalMs);
    scheduler.addTask({
      id: 'sync',
      intervalMs: opts.syncIntervalMs,
      fireImmediately: true,
      run: async () => {
        if (!(await paneGate.visible())) {
          panePaused = true;
          if (resumePollEnabled()) startResumePoll();
          return;
        }
        stopResumePoll();
        panePaused = false;
        // DB-change gate: skip when DB unchanged AND last sync fresh within cap.
        // Subject to existing heartbeat / single-flight / --if-idle guards in doSync.
        if (tracker && opts.maxSyncStalenessMs > 0) {
          const dbChanged = tracker.dbChanged();
          const syncDir = worklogDir ?? join(process.cwd(), '.worklog');
          const heartbeatFresh = isSyncHeartbeatFresh(syncDir, opts.maxSyncStalenessMs);
          if (!dbChanged && heartbeatFresh) {
            return; // DB unchanged, last sync recent — skip
          }
        }
        doSync(true, heartbeatTtlMs); // ifIdle + heartbeat: skip when another sync is in-flight / fresh
        doRefresh(false);
      },
    });
  }

  // Visibility resume-poll — runs only while the pane's tab is hidden. Polls
  // tab visibility on a short interval so the hidden → visible transition
  // triggers an immediate doRefresh instead of waiting for the next
  // refreshIntervalMs tick. The poll uses only herdr tab get (via the
  // PollGate memoizer, TTL aligned with the poll interval) — never wl —
  // preserving the zero-wl-when-hidden guarantee.
  scheduler.addTask({
    id: 'resume-poll',
    intervalMs: DEFAULT_POLL_GATE_TTL_MS,
    singleFlight: true,
    disabled: true,
    run: async () => {
      if (await paneGate.visible()) {
        // Hidden → visible transition: refresh immediately (with the
        // "refreshed" notification) and let the normal cadence resume.
        // DB-change gate: skip when DB unchanged (same as refresh tick).
        if (tracker && !tracker.dbChanged()) {
          stopResumePoll();
          panePaused = false;
          return; // DB unchanged — no need to refresh on visibility change
        }
        stopResumePoll();
        panePaused = false;
        doRefresh(true);
      }
    },
  });

  // Downtime-worker task — polls the llama-proxy for idle state and, after
  // the configured idle threshold, dispatches a pi agent pane (parent
  // WL-0MSF49FMW009M06K). Unlike refresh/sync it is NOT visibility-gated:
  // the worker runs while the worklist pane is open (parent Assumptions).
  // Single-flight: the poller and dispatch guards inside the worker prevent
  // overlapping work; the scheduler task itself is also single-flight.
  // Scheduler-level watchdog (WL-0MSJIPHD0001L1J9): a tick run that hangs
  // (e.g. an unbounded wl invocation) is abandoned after
  // DOWNTIME_RUN_TIMEOUT_MS and the single-flight flag resets so the next
  // tick retries — a hung run can never permanently wedge the downtime
  // task until a pane restart.
  if (opts.downtimeWorker) {
    scheduler.addTask({
      id: 'downtime',
      intervalMs: opts.downtimePollIntervalMs,
      // Probe jitter (WL-0MSSRED76008LGB6): the effective poll interval is
      // jittered ±50% of the configured downtimePollIntervalMs per tick
      // (random, injectable via the registry's RNG) so instances with
      // identical configuration do not probe in lockstep — the jittered
      // interval is recomputed fresh on EVERY reschedule. Fallback: when
      // the worker's registry is unavailable, the static interval stands.
      getIntervalMs: opts.downtimeWorker
        ? () => opts.downtimeWorker!.jitterPollIntervalMs(opts.downtimePollIntervalMs)
        : undefined,
      singleFlight: true,
      runTimeoutMs: DOWNTIME_RUN_TIMEOUT_MS,
      run: async () => {
        await opts.downtimeWorker?.tick();
      },
    });
  }

  // Mode-switch worker task — polls the llama-proxy for idle state and,
  // after the configured idle threshold, switches from fast (cloud) to
  // cheap (local) mode (parent WL-0MSN3FWV5008KQE9). Pattern-matched on the
  // downtime task: single-flight + runTimeoutMs watchdog (a hung tick can
  // never wedge the task), visibility-independent (runs while the worklist
  // pane is open). The task is only registered when the feature is enabled
  // at startup (modeSwitchEnabled); the run ALSO re-reads settings every
  // tick so a disable or threshold change applies without a plugin restart.
  // Probe jitter is intentionally NOT applied: each instance's idle clock
  // resets at construction, so panes' cheap-switch timings are already
  // naturally desynchronized (unlike the downtime poller's shared registry).
  const modeSwitchEnabledAtStartup =
    loadSettings().modeSwitchEnabled ?? opts.modeSwitchEnabled;
  if (opts.modeSwitchWorker && modeSwitchEnabledAtStartup) {
    scheduler.addTask({
      id: 'mode-switch',
      intervalMs: opts.modeSwitchPollIntervalMs,
      singleFlight: true,
      runTimeoutMs: MODE_SWITCH_RUN_TIMEOUT_MS,
      run: async () => {
        // Re-read settings every tick so modeSwitchEnabled / idle threshold
        // changes apply without a plugin restart (matching downtime config).
        const s = loadSettings();
        await opts.modeSwitchWorker?.tick({
          enabled: s.modeSwitchEnabled ?? opts.modeSwitchEnabled,
          idleThresholdMs: s.modeSwitchIdleThresholdMs ?? DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS,
          proxyUrl: s.downtimeProxyUrl,
          proxyStatus: null, // worker fetches its own proxy status
        });
      },
    });
  }

  scheduler.start();

  // Cleanup on promise resolution
  promise.finally(() => {
    scheduler.stop();
    closeEventSubscriber();
    cleanup();
    process.stdout.removeListener('resize', onResize);
    process.stdin.removeListener('data', onData);
  });

  return promise;
}
