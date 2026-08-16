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

import { fetchChildrenForItem, fetchActionableCount, fetchItemsByStage, getWorklogDir, type WorkItem } from './fetcher.js';
import { isPaneVisible, PollGate, DEFAULT_POLL_GATE_TTL_MS } from './visibility.js';
import { readCodeFreezeState, readCodeFreezeStatus } from './code-freeze.js';
import type { ShortcutRegistry, ShortcutEntry } from './shortcut-config.js';
import {
  statusIcon,
  stageIcon,
  priorityIcon,
  auditIcon,
  needsProducerReviewIcon,
  getIconPrefix,
  applyStageColour,
  stageColor,
  type IconOptions,
} from './icons.js';
import { runSync, heartbeatTtlForInterval } from './auto-sync.js';
import { TaskScheduler, DEFAULT_SCHEDULER_TICK_MS } from './scheduler.js';
import { DEFAULT_DOWNTIME_POLL_INTERVAL_MS, DOWNTIME_RUN_TIMEOUT_MS, type DowntimeWorker } from './downtime-worker.js';
import { showToast } from './notify.js';
import { recordCommand, getLastCommand } from './command-log.js';
import {
  hasUnknownIdentifiers,
  getUnknownIdentifiers,
  FormState,
  substituteIdentifiers,
} from './form-dialog.js';
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

// Re-export stage colors from icons for backward compatibility
export const STAGE_COLORS: Record<string, number> = {
  idea: 247,
  intake_complete: 68,
  plan_complete: 172,
  in_progress: 76,
  in_review: 220,
  completed: 33,
};

// ── Metadata panel sizing (WL-0MSAYNVBY006LM9X) ─────────────────────────
// The list renderer reserves the bottom of the pane for a metadata panel
// showing the selected item's fields plus its last recorded command. The
// panel share of the pane height ramps linearly between MIN_META_SHARE on
// small panes and MAX_META_SHARE on tall panes, so the list always keeps at
// least 60% of the pane.

/** Minimum share of pane rows reserved for the metadata panel (small panes). */
export const MIN_META_SHARE = 0.2;
/** Maximum share of pane rows reserved for the metadata panel (tall panes). */
export const MAX_META_SHARE = 0.4;

/** Pane height (rows) at which the panel uses the minimum share. */
const META_SHARE_MIN_ROWS = 12;
/** Pane height (rows) at which the panel reaches the maximum share. */
const META_SHARE_MAX_ROWS = 40;

/**
 * Compute the number of pane rows reserved for the metadata panel.
 *
 * The share ramps linearly from MIN_META_SHARE at `META_SHARE_MIN_ROWS` to
 * MAX_META_SHARE at `META_SHARE_MAX_ROWS`. The result is clamped to a
 * minimum of 3 rows (so the panel stays usable) and to MAX_META_SHARE of the
 * pane (so the list keeps at least 60%).
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
  }

  /** Number of items in the flattened (display) list. */
  get flatCount(): number {
    return this.getFlattenedItems().length;
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

  /** Active stage filter (null = no filter). */
  activeFilter: string | null = null;

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

  /** Navigation stack for hierarchical browsing (push/pop parent contexts). */
  navigationStack: NavigationStack = new NavigationStack();

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
    const flat = this.getFlattenedItems();
    const item = flat[this.selectedIndex] ?? this.items[this.selectedIndex];
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
    // The ToC is pinned at the top of the detail view, so the scrollable
    // region is the body below it (WL-0MSHWHULZ001FL8I).
    const allLines = formatDetailContent(this.detailItem, maxCols);
    const tocLines = formatDetailToC(this.detailItem, maxCols).length;
    const bodyLines = Math.max(0, allLines.length - tocLines);
    const maxScroll = Math.max(0, bodyLines - viewportHeight);
    this.detailScrollOffset = Math.min(maxScroll, this.detailScrollOffset + amount);
  }

  // ── Metadata panel scroll ───────────────────────────────────────

  /**
   * Return the currently selected flattened item, or null when the list is
   * empty or the selection is out of range.
   */
  getSelectedItem(): WorkItem | null {
    const flat = this.getFlattenedItems();
    if (flat.length === 0) return null;
    const idx = this.selectedIndex;
    if (idx < 0 || idx >= flat.length) return null;
    return flat[idx];
  }

  /** Scroll the metadata panel up (toward the start of the content). */
  metaScrollUp(amount = 1): void {
    this.metaScrollOffset = Math.max(0, this.metaScrollOffset - amount);
  }

  /** Scroll the metadata panel down (toward the end of the content). */
  metaScrollDown(amount = 1): void {
    const panelHeight = computeMetadataPanelHeight(this.termSize.rows);
    const selected = this.getSelectedItem();
    if (!selected) return;
    const allLines = formatMetadataPanel(selected, this.termSize.cols, panelHeight, 0);
    const maxScroll = Math.max(0, allLines.length - panelHeight);
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
    this._applyFilters();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.mode = 'list';
    this._resetMetaScroll();
  }

  clearFilter(): void {
    this.activeFilter = null;
    this._applyFilters();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this._resetMetaScroll();
  }

  // ── Refresh ─────────────────────────────────────────────────────

  refreshItems(newItems: WorkItem[]): void {
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
   * Capture the ID of the currently selected item, or undefined if
   * the flattened list is empty or nothing is selected.
   */
  private _captureSelectedId(): string | undefined {
    const flat = this.getFlattenedItems();
    if (flat.length === 0) return undefined;
    const idx = this.selectedIndex;
    if (idx < 0 || idx >= flat.length) return undefined;
    return flat[idx].id;
  }

  /**
   * Search the new flattened list for an item matching `id` and
   * set selectedIndex to its position.
   *
   * @returns true if the item was found and selection restored;
   *          false if the item is no longer visible.
   */
  private _restoreSelectionById(id: string | undefined): boolean {
    if (id === undefined) return false;
    const flat = this.getFlattenedItems();
    const newIndex = flat.findIndex((item) => item.id === id);
    if (newIndex === -1) return false;
    this.selectedIndex = newIndex;
    return true;
  }

  // ── Internal ────────────────────────────────────────────────────

  private _applyFilters(): void {
    let filtered = [...this._allItems];
    if (this.activeFilter) {
      filtered = filtered.filter((item) => item.stage === this.activeFilter);
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

  /** Number of visible list rows (accounts for the metadata panel). */
  _listHeight(): number {
    // Reserve 3 rows for header, 1 for footer, 1 for status
    const panelHeight = computeMetadataPanelHeight(this.termSize.rows);
    return Math.max(3, this.termSize.rows - 4 - panelHeight);
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
  addMeta('ID', item.id);
  addMeta('Title', item.title);
  addMeta('Status', item.status);
  addMeta('Stage', item.stage);
  addMeta('Priority', item.priority);
  addMeta('Type', item.issueType);
  addMeta('Risk', item.risk);
  addMeta('Effort', item.effort);
  addMeta('Children', item.childCount !== undefined ? String(item.childCount) : undefined);
  addMeta('Parent', item.parentId);
  if (item.tags && item.tags.length > 0) {
    metaRows.push(['Tags', item.tags.join(', ')]);
  }
  addMeta('GitHub Issue', item.githubIssueNumber ? `#${item.githubIssueNumber}` : undefined);
  addMeta('Created', item.createdAt ? formatTimestamp(item.createdAt) : undefined);
  addMeta('Updated', item.updatedAt ? formatTimestamp(item.updatedAt) : undefined);
  addMeta('Audit', auditIcon(item.auditResult, { noIcons }));
  addMeta('Reviewed', needsProducerReviewIcon(item.needsProducerReview, { noIcons }));
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

/**
 * Maximum number of description preview lines shown in the metadata panel.
 */
const DESCRIPTION_PREVIEW_MAX_LINES = 3;

/**
 * Build the description preview lines for the metadata panel.
 *
 * Returns up to {@link DESCRIPTION_PREVIEW_MAX_LINES} non-empty lines from the
 * item's description, each truncated to `maxCols`. The preview starts with a
 * dimmed `Description` heading row. Returns an empty array when the description
 * is missing or blank.
 *
 * @param description - The work item's description text.
 * @param maxCols - Terminal width for truncation.
 * @returns Preview lines ready to insert into the metadata panel.
 */
function buildDescriptionPreview(
  description: string | undefined | null,
  maxCols: number,
): string[] {
  if (!description || description.trim() === '') {
    return [];
  }

  const preview: string[] = [];

  // Heading row
  preview.push(` ${ANSI.dim}${ANSI.underline}Description${ANSI.reset}`);

  // First up-to-3 non-empty lines, so blank separator lines between markdown
  // sections don't waste the limited preview space (WL-0MSFZKQL700381P3).
  const lines = description.split('\n');
  let shown = 0;
  for (const line of lines) {
    if (shown >= DESCRIPTION_PREVIEW_MAX_LINES) break;
    if (line.trim() === '') continue;
    preview.push(` ${line}`);
    shown += 1;
  }

  // Truncate to fit the terminal width
  for (let i = 0; i < preview.length; i++) {
    if (preview[i].length > 0) {
      preview[i] = truncateLine(preview[i], maxCols);
    }
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

  // Metadata rows
  const metaRows = buildMetaRows(item, noIcons);
  if (metaRows.length > 0) {
    const fieldWidth = Math.max(...metaRows.map(([l]) => l.length), 6);
    for (const [label, value] of metaRows) {
      lines.push(` ${label.padEnd(fieldWidth)} ${value}`);
    }
  }

  // Description preview — first few lines of the item's description so the
  // user can see what the item is about without opening the detail view
  // (WL-0MSFZKQL700381P3). Shown as-is (markdown source lines), placed after
  // the metadata rows and before the last-command line.
  const preview = buildDescriptionPreview(item.description, maxCols);
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
 * (auditResult icon), Reviewed (needsProducerReview icon), and Audited At
 * (ISO timestamp). Rendered as a markdown table. ID and Title are shown in
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
  // here to avoid duplicating them).
  const metaRows = buildMetaRows(item, noIcons).filter(([label]) => label !== 'ID' && label !== 'Title');

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
  lines.push(` ${ANSI.dim}[↑↓/j:k] scroll  [g/G] top/bot  [esc] back  [q] quit${ANSI.reset}`);

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

  const bodyLines = allLines.slice(tocLines.length);
  const totalLines = bodyLines.length;
  const maxScroll = Math.max(0, totalLines - viewportHeight);
  const safeOffset = Math.min(scrollOffset, maxScroll);

  const visible = [
    ...tocLines,
    ...bodyLines.slice(safeOffset, safeOffset + viewportHeight),
  ];

  // Add scroll indicator if the body is long
  if (totalLines > viewportHeight && safeOffset <= maxScroll) {
    const percent = totalLines > 0
      ? Math.round(((safeOffset + viewportHeight) / totalLines) * 100)
      : 0;
    const scrollInfo = ` ${ANSI.dim}Lines ${safeOffset + 1}-${Math.min(safeOffset + viewportHeight, totalLines)} of ${totalLines} (${percent}%)  ` +
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
  | 'toggle-expand' | null;

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
 * @returns The action string, or null if unhandled
 */
export function handleKeypress(
  state: WorkItemListState,
  key: string,
  termSize: TermSize,
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
        const flat = state.getFlattenedItems();
        if (state.selectedIndex < flat.length) {
          const selected = flat[state.selectedIndex];
          // Toggle expand/collapse for items with actual children data at
          // ANY depth (WL-0MSQ3FH1K000MMJW): Enter on a child with children
          // expands it like a top-level parent, instead of opening the
          // detail view.
          if (selected.children && selected.children.length > 0) {
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
      state.metaScrollDown(1);
      break;
    case 'meta-up':
      state.metaScrollUp(1);
      break;
    case 'toggle-expand':
      if (state.mode === 'list' && state.selectedIndex >= 0 && state.items.length > 0) {
        const flat = state.getFlattenedItems();
        if (state.selectedIndex < flat.length) {
          const selected = flat[state.selectedIndex];
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
        }
      }
      return null;
  }
  return action;
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
 * `[downtime busy]`, `[⏳ downtime dispatching]`, `[downtime disabled]`, or
 * `[downtime paused]` (no-candidate cooldown, WL-0MSI7DQL10016QYX).
 * Inline-only — it never adds a row, so the pane-height budget is intact.
 */
export function renderDowntimeStatus(worker: DowntimeWorker | undefined): string {
  if (!worker) return '';
  if (worker.dispatching) {
    return ` ${ANSI.fg(208)}[⏳ downtime dispatching]${ANSI.reset}`;
  }
  if (!worker.enabled) {
    return ` ${ANSI.dim}[downtime disabled]${ANSI.reset}`;
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
  items: WorkItem[],
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
) => string {
  // Default to icons enabled when no getter is supplied (backwards
  // compatible — callers/tests that render without options keep icons).
  const showIconsGetter = getShowIcons ?? (() => true);
  return (
    items: WorkItem[],
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
  ): string => {
    const { rows, cols } = termSize;
    // Icons are gated by the getter for the whole frame (list lines, detail
    // view, and metadata panel alike) so showIcons=false omits every item
    // icon, including audit/review icons (AC1, WL-0MSBV4RYO008JL70).
    const noIcons = !showIconsGetter();
    const output: string[] = [];
    // The metadata panel reserves 20–40% of the pane height below the list;
    // the list area is the remaining height minus the notification row.
    const panelHeight = computeMetadataPanelHeight(rows);
    const listArea = Math.max(1, rows - 1 - panelHeight);
    const listHeight = Math.max(3, rows - 4 - panelHeight);

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

    // Header with total count and auto-refresh indicator
    const totalItems = items.length;
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

    // Items are already flattened by the caller (render callback in runWorklistTui
    // calls state.getFlattenedItems() before passing items here). Do NOT re-flatten.
    const flatItems = items;

    // Items with group separators. Each `── <Group> ──` separator consumes a
    // row, so the visible window must be sized so header + items + separators
    // + fill + footer fit in `rows - 1` lines (the last row is reserved for
    // the notification line appended by render()). Without this accounting the
    // output overflows the pane and the terminal scrolls the header/top items
    // off the top (WL-0MSAAON63003N6LO). The active stage filter is indicated
    // in the header only (filterLabel) — no standalone filter bar is rendered.
    const chromeLines = 2 + bannerCount; // header + banner(s) + footer
    const budgetForItemsAndSeps = Math.max(0, listArea - chromeLines);
    // Count the group separators a window would render (same logic as the
    // render loop below) so the window can be trimmed when separators would
    // overflow the pane height.
    const countSeparators = (window: WorkItem[]): number => {
      let count = 0;
      let lastGroup: number | undefined;
      for (const item of window) {
        if (item.group !== undefined && item.id !== '..') {
          if (lastGroup === undefined || item.group !== lastGroup) {
            count++;
          }
          lastGroup = item.group;
        }
      }
      return count;
    };
    let visible = flatItems.slice(scrollOffset, scrollOffset + listHeight);
    while (visible.length > 0 && visible.length + countSeparators(visible) > budgetForItemsAndSeps) {
      // Drop trailing items until items + separators fit the pane height.
      visible = visible.slice(0, -1);
    }

    // ── Fold indicators (WL-0MSG8YXYJ008PWJJ) ─────────────────────
    // Show dim `▲ more` / `▼ more` markers so users can tell the list
    // is scrolled or truncated.  Indicator rows consume budget so the
    // `rows - 1` invariant still holds.
    const hasTopIndicator = scrollOffset > 0;
    const hasBottomIndicator = scrollOffset + visible.length < flatItems.length;
    const indicatorRows = (hasTopIndicator ? 1 : 0) + (hasBottomIndicator ? 1 : 0);
    const effectiveBudget = budgetForItemsAndSeps - indicatorRows;
    while (visible.length > 0 && visible.length + countSeparators(visible) > effectiveBudget) {
      // Drop trailing items until items + separators + indicators fit.
      visible = visible.slice(0, -1);
    }
    // Edge case: the trim may have made the list fully fit — the bottom
    // indicator is then omitted. This terminates in a single pass (no loop).
    const bottomIndicatorActive = scrollOffset + visible.length < flatItems.length;
    // Top indicator — first row of the items region when scrolled down.
    if (hasTopIndicator) {
      output.push(` ${ANSI.dim}▲ more${ANSI.reset}`);
    }
    let lastDisplayedGroup: number | undefined;
    let numSeparators = 0;
    for (let i = 0; i < visible.length; i++) {
      const actualIndex = scrollOffset + i;
      const item = visible[i];

      // Insert group separator when group changes
      if (item.group !== undefined && item.id !== '..') {
        if (lastDisplayedGroup === undefined || item.group !== lastDisplayedGroup) {
          const label = item.groupLabel ?? `Group ${item.group}`;
          const sepColor = stageColor(item.stage);
          output.push(` ${ANSI.fg(sepColor)}${ANSI.bold}── ${label} ──${ANSI.reset}`);
          numSeparators++;
        }
        lastDisplayedGroup = item.group;
      }

      // For hierarchy: apply _expanded flag for icon rendering
      const hasChildCount = item.childCount !== undefined && item.childCount > 0;
      const isExpanded = expandedItems?.has(item.id) ?? false;
      const expandedItem = { ...item, _expanded: hasChildCount && isExpanded };

      const isSelected = actualIndex === selectedIndex;
      const line = formatItemLine(expandedItem, cols, isSelected, noIcons);
      if (isSelected) {
        output.push(`${ANSI.reverse}${line}${ANSI.reset}`);
      } else {
        output.push(line);
      }
    }

    // Bottom indicator — last row of the items region when items remain
    // below the fold (after the trimming edge case is resolved).
    if (bottomIndicatorActive) {
      output.push(` ${ANSI.dim}▼ more${ANSI.reset}`);
    }

    // Fill remaining rows (header + indicators + items + separators)
    const used = chromeLines + (hasTopIndicator ? 1 : 0) + (bottomIndicatorActive ? 1 : 0) + visible.length + numSeparators;
    for (let i = used; i < listArea; i++) {
      output.push('');
    }

    // Footer with keyboard hints (dynamic — includes chord hints if available).
    // Both the normal hint line and the chord-in-progress line are gated by
    // `showHelpText` (default true), so `showHelpText: false` hides ALL shortcut
    // hints, consistent with the pi browse widget's showHelpText handling
    // (WL-0MSGJDSMJ004128E). Note: gating only affects rendering — chord key
    // handling/accumulation in chordState continues regardless.
    const helpEnabled = showHelpText ?? true;
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

    // ── Metadata panel ────────────────────────────────────────────
    // Reserve the bottom `panelHeight` rows for the selected item's
    // metadata (plus its last command when in_progress). The panel has its
    // own scroll offset (m/M) so long metadata never affects list
    // navigation (WL-0MSAYNVBY006LM9X).
    const selectedItem = selectedIndex >= 0 && selectedIndex < items.length
      ? items[selectedIndex]
      : null;
    const panelLines = formatMetadataPanel(
      selectedItem,
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
  onCommand?: (command: string, model?: string) => void,
  model?: string,
): boolean {
  let resolvedCommand = command;
  let itemId: string | undefined;

  if (resolvedCommand.includes('<id>')) {
    const flat = state.getFlattenedItems();
    const idx = state.selectedIndex;
    if (idx >= 0 && idx < flat.length) {
      resolvedCommand = resolvedCommand.replace(/<id>/g, flat[idx].id);
      itemId = flat[idx].id;
    } else {
      // No item selected and command requires <id> — graceful no-op
      return false;
    }
  } else {
    itemId = extractWorkItemIdFromCommand(resolvedCommand);
  }

  logCommandForItem(resolvedCommand, itemId);

  if (onCommand) {
    onCommand(resolvedCommand, model);
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
 * stage fetch fails, the default fetcher is used as a fallback so a `wl`
 * error can never blank the list.
 *
 * @param activeFilter - The active stage filter (null = unfiltered view)
 * @param defaultFetcher - The default fetcher for the unfiltered view
 */
export function fetchItemsForView(
  activeFilter: string | null,
  defaultFetcher: () => Promise<WorkItem[]>,
): Promise<WorkItem[]> {
  if (activeFilter) {
    // Fail-open: a wl error must never blank the list — fall back to the
    // default fetcher (which itself fails open in index.ts).
    return fetchItemsByStage(activeFilter).catch(() => defaultFetcher());
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
 * @returns true if the command was handled, false otherwise
 */
export function dispatchChordCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string, model?: string) => void,
  model?: string,
): boolean {
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
  // clears the active stage filter so the next refresh shows the standard
  // smart-selection list. No-op when no filter is active.
  if (/^\/wl\s*$/.test(command)) {
    state.clearFilter();
    return true;
  }

  // ── Agent skill invocations ─────────────────────────────
  if (command.startsWith('/skill:implement')) {
    return resolveAndRouteCommand(command, state, onCommand, model);
  }
  if (command.startsWith('/skill:audit')) {
    return resolveAndRouteCommand(command, state, onCommand, model);
  }
  if (command.startsWith('/skill:ship')) {
    // Dev→main release (Ship It shortcut, WL-0MSGG5N5Z0074TLY). Global
    // release — no <id> substitution; routed to the agent channel like
    // other /skill:* commands. NOT blocked during a Code Freeze (the ship
    // skill gates itself); only the confirmation dialog precedes dispatch.
    return resolveAndRouteCommand(command, state, onCommand, model);
  }

  // ── Agent workflow commands ─────────────────────────────
  if (command.startsWith('/intake')) {
    return resolveAndRouteCommand(command, state, onCommand, model);
  }
  if (command.startsWith('/plan')) {
    return resolveAndRouteCommand(command, state, onCommand, model);
  }

  // ── Producer review / audit compound commands ───────────
  if (command.startsWith('!!wl reviewed')) {
    return resolveAndRouteCommand(command, state, onCommand, model);
  }
  if (command.includes('&& wl audit-set')) {
    return resolveAndRouteCommand(command, state, onCommand, model);
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
 * @returns 'dispatched' if handled by dispatchChordCommand,
 *          'callback' if passed to onCommand,
 *          'noop' if skipped (no item + <id> requirement),
 *          'blocked' if frozen and the command is an implement command.
 */
export function executeResolvedCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string, model?: string) => void,
  codeFreezeActive = false,
  model?: string,
): ExecuteResult {
  // Code Freeze guard: never route implement commands while frozen.
  // This runs BEFORE dispatchChordCommand so no pane spawn, claim, or
  // <id> substitution can happen for a blocked command.
  if (codeFreezeActive && isImplementCommand(command)) {
    return 'blocked';
  }

  // Try dispatchChordCommand first — handles /wl, /skill:, /intake, /plan,
  // !!wl reviewed, and compound audit commands
  if (dispatchChordCommand(command, state, onCommand, model)) {
    return 'dispatched';
  }

  // Not a recognised command family — resolve <id> placeholders and call onCommand
  let resolvedCommand = command;
  let itemId: string | undefined;

  if (resolvedCommand.includes('<id>')) {
    const flat = state.getFlattenedItems();
    const idx = state.selectedIndex;
    if (idx >= 0 && idx < flat.length) {
      resolvedCommand = resolvedCommand.replace(/<id>/g, flat[idx].id);
      itemId = flat[idx].id;
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
    onCommand(resolvedCommand, model);
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
  options?: { autoRefresh?: boolean; refreshIntervalMs?: number; autoSync?: boolean; syncIntervalMs?: number; browseItemCount?: number; showHelpText?: boolean; getShowHelpText?: () => boolean; showIcons?: boolean; getShowIcons?: () => boolean; onCommand?: (command: string, model?: string) => void; downtimeWorker?: DowntimeWorker; downtimePollIntervalMs?: number; mergeAgentStates?: (items: WorkItem[]) => Promise<void> },
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

  // Check if we're in raw mode (stdin is a TTY)
  const isInteractive = process.stdin.isTTY;
  let rawMode = false;

  if (isInteractive) {
    try {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      rawMode = true;
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
    }
    process.stdin.pause();
    process.stdout.write(ANSI.showCursor);
    process.stdout.write(ANSI.reset);
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
          fetchItemsForView(state.activeFilter, fetcher),
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

  /**
   * True when the resolved command is a `/wl` view command — a stage filter
   * (`/wl <stage>`, shorthand alias or canonical name) or the clear-filter
   * `/wl` with no arguments. Used after dispatch to trigger a view refetch:
   * filtered views show every root item in that stage matching the stage's
   * status rule (`wl list --status <status> --stage <stage> --root-only`;
   * see STAGE_STATUS in fetcher.ts) — most stages show `open`-status items
   * only, while the in_review stage additionally includes `completed` and
   * `in-progress` items (WL-0MSKCRX730052IIW); clearing the filter restores
   * the default view (WL-0MSGSE15000746F7).
   */
  const isWlViewCommand = (cmd: string): boolean => {
    if (/^\/wl\s*$/.test(cmd)) return true;
    const m = cmd.match(/^\/wl\s+(\S+)$/);
    return m !== null && STAGE_MAP[m[1]] !== undefined;
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
          const result = executeResolvedCommand(SHIP_IT_COMMAND, state, opts.onCommand, frozen, model);
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

  const onData = async (chunk: Buffer): Promise<void> => {
    const key = chunk.toString();

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
      if (result === 'submitted') {
        const resolved = formState.getResult();
        formState = null;
        state.mode = preFormMode;
        // NOTE: dispatch happens inside FormState's onSubmit callback (which
        // resolves <id> placeholders) — do NOT call onCommand again here or
        // every form submission spawns TWO agent panes (WL-0MSAL0RN1009YNJ7).
        showToast('Sent', { body: resolved.length > 60 ? resolved.substring(0, 57) + '...' : resolved });
        render();
      } else if (result === 'cancelled') {
        formState = null;
        state.mode = preFormMode;
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
        chordState.resolvedCommand = null;
        chordState.resolvedModel = null;
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
                  const flat = state.getFlattenedItems();
                  const idx = state.selectedIndex;
                  if (idx >= 0 && idx < flat.length) {
                    finalCmd = finalCmd.replace(/<id>/g, flat[idx].id);
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
            const result = executeResolvedCommand(command, state, opts.onCommand, frozen, model ?? undefined);
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
            if (result === 'dispatched' && isWlViewCommand(command)) {
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
    const action = handleKeypress(state, key, termSize);

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
                const flat = state.getFlattenedItems();
                const idx = state.selectedIndex;
                if (idx >= 0 && idx < flat.length) {
                  finalCmd = finalCmd.replace(/<id>/g, flat[idx].id);
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
          const result = executeResolvedCommand(singleCmd, state, opts.onCommand, frozen, singleModel);
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
          if (result === 'dispatched' && isWlViewCommand(singleCmd)) {
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
      const flat = state.getFlattenedItems();
      if (state.selectedIndex < flat.length) {
        const selected = flat[state.selectedIndex];
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

    // Use flattened items for hierarchy display
    const displayItems = state.mode === 'list' ? state.getFlattenedItems() : state.items;

    // ── Compute stage-appropriate shortcut hints for the footer ──
    let dynamicHints = '';
    if (shortcutRegistry && chordState.pendingKeys.length === 0) {
      const reg = shortcutRegistry as ShortcutRegistry;
      const selIdx = state.selectedIndex;
      const selItem = displayItems.length > 0 && selIdx < displayItems.length
        ? displayItems[selIdx]
        : undefined;
      const selStage = selItem?.stage;
      const selIssueType = selItem?.issueType;
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

    const output = renderer(
      displayItems,
      state.selectedIndex,
      state.scrollOffset,
      termSize,
      state.activeFilter,
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

  const stopResumePoll = (): void => {
    scheduler.setDisabled('resume-poll', true);
  };

  /** Start the resume poll (no-op when already running). */
  const startResumePoll = (): void => {
    scheduler.setDisabled('resume-poll', false);
  };

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
          startResumePoll();
          return;
        }
        stopResumePoll();
        panePaused = false;
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
          startResumePoll();
          return;
        }
        stopResumePoll();
        panePaused = false;
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
      singleFlight: true,
      runTimeoutMs: DOWNTIME_RUN_TIMEOUT_MS,
      run: async () => {
        await opts.downtimeWorker?.tick();
      },
    });
  }

  scheduler.start();

  // Cleanup on promise resolution
  promise.finally(() => {
    scheduler.stop();
    cleanup();
    process.stdout.removeListener('resize', onResize);
    process.stdin.removeListener('data', onData);
  });

  return promise;
}
