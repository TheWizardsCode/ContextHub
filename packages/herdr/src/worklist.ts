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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { fetchChildrenForItem, fetchActionableCount, fetchItemsByStage, getWorklogDir, type WorkItem } from './fetcher.js';
import { isPaneVisible, PollGate, DEFAULT_POLL_GATE_TTL_MS } from './visibility.js';
import { readCodeFreezeState } from './code-freeze.js';
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
import { extractFilePaths } from './grouping.js';
import { renderMarkdownViewer, renderNoteLinks } from './md-viewer.js';

// ── Constants ─────────────────────────────────────────────────────────

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
   */
  getFlattenedItems(): WorkItem[] {
    const result: WorkItem[] = [];
    for (const item of this.items) {
      result.push(item);
      if (item.childCount && item.children && item.children.length > 0 && this.expandedItems.has(item.id)) {
        for (const child of item.children) {
          result.push({ ...child, depth: child.depth ?? 1 });
        }
      }
    }
    return result;
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
 * Format the metadata panel shown below the selection list.
 *
 * Renders the selected item's fields (via {@link buildMetaRows}) plus a last
 * command line when the item's stage is `in_progress`. The panel scrolls
 * independently with its own offset: when the content is taller than the
 * panel, `metaScrollOffset` selects the visible window and a `[m/M scroll]`
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
    const descLines = item.description.split('\n');
    for (const dl of descLines) {
      // Wrap long lines to fit width; NOTE markers render as links.
      const indent = 2;
      const wrapWidth = contentWidth - indent - 2;
      const linked = renderNoteLinks(dl);
      if (linked.length > wrapWidth && wrapWidth > 10) {
        let remaining = linked;
        while (remaining.length > 0) {
          const seg = remaining.slice(0, wrapWidth);
          remaining = remaining.slice(wrapWidth);
          lines.push(`  ${seg}`);
        }
      } else {
        lines.push(`  ${linked}`);
      }
      // Limit total lines
      if (lines.length > 500) {
        lines.push(`  ... (truncated, ${descLines.length} total description lines)`);
        break;
      }
    }
  }

  // Generic md-document viewer for a Key Files: .podcast.md episode file
  // (preview-only; no notes editor). When a readFile callback is provided
  // and the item references a readable .md file, render it in place of the
  // raw description so the producer sees the paragraph-format episode.
  // Renders the file at detailRenderedIndex (default 0 = first file, the
  // existing auto-render); Enter on a ToC entry selects another file
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
  | 'back' | 'filter' | 'refresh' | 'sync' | 'quit' | 'first' | 'last'
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
    case 'q':
      return 'quit';
    case 'g':
      return 'first';
    case 'G':
      return 'last';
    case 'S':
      return 'sync';
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
          // Toggle expand/collapse for items with actual children data
          if (selected.children && selected.children.length > 0 && selected.depth === undefined) {
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
          // Only top-level items with children can be expanded/collapsed
          if (selected.depth === undefined && selected.childCount && selected.childCount > 0) {
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

    // Code Freeze banner — a prominent warning that implementation is
    // blocked while a ship release is in progress. The banner consumes one
    // chrome row (chromeLines accounts for it) so the `rows - 1` pane
    // line-count invariant still holds (WL-0MSAAON63003N6LO).
    if (codeFreezeActive) {
      const bannerText = `⛔ CODE FREEZE — ship release in progress; implement actions blocked`;
      const bannerLine = `${ANSI.bg(196)}${ANSI.fg(231)} ${bannerText} ${ANSI.reset}`;
      output.push(truncateLine(bannerLine, cols));
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
    const bannerActive = codeFreezeActive === true;
    const chromeLines = bannerActive ? 3 : 2; // header + banner + footer
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

    // Fill remaining rows (header + items + separators)
    const used = chromeLines + visible.length + numSeparators;
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
 * When a stage filter is active, the worklist shows EVERY open root item in
 * that stage (`wl list --status open --stage <stage> --root-only`) — not
 * just the `browseItemCount`-capped `wl next` subset — so stage-filtered
 * views give a complete picture of the stage (WL-0MSDT8X1V003206G). Items
 * with status `blocked`, `in-progress`, or `completed` are excluded; child
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
 * `<podcast-script>`) for the selected work item at dispatch time
 * (OSL-0MSKFXM380098LFL, folding in OSL-0MSHFQ51L009IUOS).
 *
 * The `w` write-script chord command
 * (`/skill:wiki-podcast-script <podcast-target>`) derives its mode from the
 * selected item's lifecycle context:
 * - stage `intake_complete` (sourced): author a new script from the source
 *   synthesis → `--doc <first .md Key File> --force-single`;
 * - otherwise, when open editor-note children exist: rewrite the existing
 *   script → `--rewrite <first .podcast.md Key File>`;
 * - otherwise: belt-and-braces guard — returns an error and does NOT
 *   dispatch (never authors a duplicate).
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
  if (!hasTarget && !hasScript) {
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

  return { command: resolved };
}

/**
 * Execute a resolved chord command.
 *
 * Routing priority:
 * 1. {@link dispatchChordCommand} — handles `/wl <stage>` (internal filter),
 *    `/skill:implement`, `/skill:audit`, `/intake`, `/plan`, `!!wl reviewed`,
 *    and compound `&& wl audit-set` commands (resolves `<id>` and routes to
 *    `onCommand`). Returns 'dispatched'.
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

  let totalActionableCount: number | undefined;

  // Code Freeze state: whether the project is frozen (banner) and whether
  // the Code Freeze notice dialog is currently showing. The banner state is
  // refreshed on each data refresh; the command-dispatch path re-reads the
  // marker fresh so a freeze that starts between refreshes is still enforced
  // at dispatch time (fail-safe client-side blocking).
  let codeFreezeActive = false;
  let codeFreezeNotice = false;

  /** Re-read the code-freeze marker (fail-open: errors => not frozen). */
  const refreshFreezeState = (): void => {
    codeFreezeActive = readCodeFreezeState().active;
  };

  // Initial Code Freeze state read (fail-open: no marker => not frozen).
  refreshFreezeState();

  // Pane-visibility gating (pause-when-hidden). When the pane's tab is not
  // focused, auto-refresh/auto-sync timer ticks are skipped so hidden panes
  // stop spawning wl processes. Fail-open: when visibility can't be
  // determined (no HERDR_PANE_ID / CLI error) the pane is treated as visible
  // and polling proceeds as today. PollGate memoizes the pane-get exec within
  // a TTL so refresh+sync ticks in one cycle share a single `herdr pane get`.
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
            const children = await fetchChildrenForItem(parentId);
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
        if (freshChildren.size > 0) {
          const byId = new Map(newItems.map((it) => [it.id, it]));
          for (const [parentId, children] of freshChildren) {
            const parent = byId.get(parentId);
            if (parent) {
              parent.children = children;
            }
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
   * filtered views show every open root item in the stage
   * (WL-0MSDT8X1V003206G); clearing the filter restores the default view
   * (WL-0MSGSE15000746F7).
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
  // skips are silent because the data is already fresh. Manual 'S' syncs pass
  // ifIdle=false and no heartbeat, so they always wait for the lock like a
  // regular wl sync.
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
          // Podcast-progression markers (<podcast-target>/<podcast-script>)
          // are resolved from the selected item's context BEFORE the generic
          // modal-form check so they never fall through to the input form
          // (OSL-0MSKFXM380098LFL, folding in OSL-0MSHFQ51L009IUOS).
          if (command.includes('<podcast-target>') || command.includes('<podcast-script>')) {
            const podcast = await resolvePodcastTarget(command, state.getSelectedItem());
            if (podcast.error) {
              showToast('Error', { body: podcast.error });
              render();
              return;
            }
            command = podcast.command ?? command;
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
            // so the filtered view shows EVERY open root item in the stage,
            // not just the already-loaded subset (WL-0MSDT8X1V003206G).
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
        // Podcast-progression markers (<podcast-target>/<podcast-script>)
        // are resolved from the selected item's context BEFORE the generic
        // modal-form check so they never fall through to the input form
        // (OSL-0MSKFXM380098LFL, folding in OSL-0MSHFQ51L009IUOS).
        if (singleCmd.includes('<podcast-target>') || singleCmd.includes('<podcast-script>')) {
          const podcast = await resolvePodcastTarget(singleCmd, state.getSelectedItem());
          if (podcast.error) {
            showToast('Error', { body: podcast.error });
            render();
            return;
          }
          singleCmd = podcast.command ?? singleCmd;
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
          // so the filtered view shows EVERY open root item in the stage,
          // not just the already-loaded subset (WL-0MSDT8X1V003206G).
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

    if (action === 'sync') {
      await doSync();
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
          const children = await fetchChildrenForItem(selected.id);
          selected.children = children;
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
    );

    // Notifications are surfaced via Herdr toasts (showToast), never as a
    // bottom line — the pane output must stay within the terminal budget.
    const rendered = output;

    // Clear from cursor to end of screen to remove leftover content
    // from previous renders of different heights
    process.stdout.write(ANSI.clear);
    process.stdout.write(ANSI.cursorHome);
    process.stdout.write(rendered);
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

  // Visibility resume-poll — runs only while the pane is hidden. Polls
  // pane visibility on a short interval so the hidden → visible transition
  // triggers an immediate doRefresh instead of waiting for the next
  // refreshIntervalMs tick. The poll uses only herdr pane get (via the
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
