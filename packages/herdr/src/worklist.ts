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

import { fetchChildrenForItem, fetchActionableCount, type WorkItem } from './fetcher.js';
import type { ShortcutRegistry, ShortcutEntry } from './shortcut-config.js';
import {
  statusIcon,
  stageIcon,
  priorityIcon,
  auditIcon,
  needsProducerReviewIcon,
  getIconPrefix,
  applyStageColour,
  iconsEnabled,
  stageColor,
  type IconOptions,
} from './icons.js';
import { runSync, createSyncTimer, clampSyncInterval } from './auto-sync.js';
import {
  hasUnknownIdentifiers,
  getUnknownIdentifiers,
  FormState,
  substituteIdentifiers,
} from './form-dialog.js';

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

// Re-export stage colors from icons for backward compatibility
export const STAGE_COLORS: Record<string, number> = {
  idea: 241,
  intake_complete: 68,
  plan_complete: 172,
  in_progress: 76,
  in_review: 220,
  completed: 33,
};

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
  }

  moveDown(): void {
    if (this.flatCount === 0) return;
    if (this.selectedIndex < this.flatCount - 1) {
      this.selectedIndex += 1;
    } else {
      this.selectedIndex = 0; // wrap to first
    }
    this._adjustScroll();
  }

  pageUp(): void {
    const pageSize = this._listHeight();
    this.selectedIndex = Math.max(0, this.selectedIndex - pageSize);
    this._adjustScroll();
  }

  pageDown(): void {
    const pageSize = this._listHeight();
    const maxIndex = Math.max(0, this.flatCount - 1);
    this.selectedIndex = Math.min(maxIndex, this.selectedIndex + pageSize);
    this._adjustScroll();
  }

  goToFirst(): void {
    if (this.mode === 'detail') {
      this.detailScrollOffset = 0;
    } else {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
    }
  }

  goToLast(): void {
    if (this.mode === 'detail') {
      this.detailScrollOffset = 999999; // Will be clamped
    } else if (this.flatCount > 0) {
      this.selectedIndex = this.flatCount - 1;
      this._adjustScroll();
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
    }
    return entry;
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
    const allLines = formatDetailContent(this.detailItem, maxCols);
    const maxScroll = Math.max(0, allLines.length - viewportHeight);
    this.detailScrollOffset = Math.min(maxScroll, this.detailScrollOffset + amount);
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
  }

  clearFilter(): void {
    this.activeFilter = null;
    this._applyFilters();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  // ── Refresh ─────────────────────────────────────────────────────

  refreshItems(newItems: WorkItem[]): void {
    // Capture the currently selected item's ID before replacing items
    const prevSelectedId = this._captureSelectedId();

    this._allItems = [...newItems];
    this._applyFilters();

    // Try to restore selection by ID; fall back to clamping if not found
    if (!this._restoreSelectionById(prevSelectedId)) {
      this._clampSelection();
    }

    this._adjustScroll();
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

  /** Number of visible list rows. */
  _listHeight(): number {
    // Reserve 3 rows for header, 1 for filter bar, 1 for footer, 1 for status
    return Math.max(3, this.termSize.rows - 6);
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
 * Build the full content lines for a detail view (without scrolling).
 * Returns an array of lines ready for viewport rendering.
 *
 * Metadata section includes: Status, Priority, Stage, Assignee, Created,
 * Updated, Audit (auditResult icon), Reviewed (needsProducerReview icon),
 * and Audited At (ISO timestamp). See `pushMeta()` calls below.
 */
export function formatDetailContent(
  item: WorkItem | null,
  maxCols: number,
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

  // Metadata
  const pushMeta = (label: string, value: string | undefined | null): void => {
    if (value != null && value !== '') {
      lines.push(`  ${label}:     ${value}`);
    }
  };
  pushMeta('Status', item.status);
  pushMeta('Priority', item.priority);
  pushMeta('Stage', item.stage);
  pushMeta('Type', item.issueType);
  pushMeta('Risk', item.risk);
  pushMeta('Effort', item.effort);
  pushMeta('Children', item.childCount !== undefined ? String(item.childCount) : undefined);
  if (item.tags && item.tags.length > 0) {
    lines.push(`  Tags:       ${item.tags.join(', ')}`);
  }
  pushMeta('GitHub Issue', item.githubIssueNumber ? `#${item.githubIssueNumber}` : undefined);
  pushMeta('Created', item.createdAt);
  pushMeta('Updated', item.updatedAt);
  pushMeta('Audit', auditIcon(item.auditResult));
  pushMeta('Reviewed', needsProducerReviewIcon(item.needsProducerReview));
  pushMeta('Audited At', item.auditedAt);

  lines.push(separator);

  // Description
  if (item.description) {
    lines.push('');
    lines.push(` ${ANSI.underline}Description${ANSI.reset}`);
    lines.push('');
    const descLines = item.description.split('\n');
    for (const dl of descLines) {
      // Wrap long lines to fit width
      const indent = 2;
      const wrapWidth = contentWidth - indent - 2;
      if (dl.length > wrapWidth && wrapWidth > 10) {
        let remaining = dl;
        while (remaining.length > 0) {
          const seg = remaining.slice(0, wrapWidth);
          remaining = remaining.slice(wrapWidth);
          lines.push(`  ${seg}`);
        }
      } else {
        lines.push(`  ${dl}`);
      }
      // Limit total lines
      if (lines.length > 500) {
        lines.push(`  ... (truncated, ${descLines.length} total description lines)`);
        break;
      }
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
): string {
  const allLines = formatDetailContent(item, maxCols);
  if (allLines.length === 0) return '';

  const totalLines = allLines.length;
  const maxScroll = Math.max(0, totalLines - viewportHeight);
  const safeOffset = Math.min(scrollOffset, maxScroll);

  const visible = allLines.slice(safeOffset, safeOffset + viewportHeight);

  // Add scroll indicator if content is long
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
 * Format the filter status bar.
 */
export function formatFilterBar(filter: string | null, maxCols: number): string {
  if (filter) {
    const color = STAGE_COLORS[filter] || 241;
    const bar = ` ${ANSI.bg(color)}${ANSI.fg(16)} Filter: ${filter} ${ANSI.reset}`;
    return bar.padEnd(maxCols, '─');
  }
  return ` ${ANSI.dim}No filter — press [f] then [i/n/p/r] to filter by stage${ANSI.reset}`.padEnd(maxCols, ' ');
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
  };
}

/**
 * Check if a key matches any chord leader in the registry.
 */
export function isChordLeader(key: string, registry: ShortcutRegistry): boolean {
  const chords = registry.getChordEntries();
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
): 'chord-complete' | 'chord-cancel' | null {
  const pending = [...chordState.pendingKeys, key];

  // Check if this completes a chord
  const command = registry.lookupChord(pending, view, stage);
  if (command) {
    chordState.pendingKeys = [];
    chordState.hints = '';
    chordState.resolvedCommand = command;
    return 'chord-complete';
  }

  // Check if this is a valid prefix for more chords
  const nextChords = registry.getChordByPrefix(pending, view, stage);
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
export function getChordHelpHints(registry: ShortcutRegistry | undefined): string {
  if (!registry) return '';
  const chords = registry.getChordEntries();
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
  | 'chord-start' | 'chord-complete' | 'chord-cancel'
  | 'toggle-expand' | null;

export interface ChordState {
  /** Keys pressed so far in the current chord sequence */
  pendingKeys: string[];
  /** Hints for next-expected keys and their commands */
  hints: string;
  /** The resolved command if chord was completed (cleared after execution) */
  resolvedCommand: string | null;
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
    // Detail scrolling
    if (key === 'j' || key === '\x1b[B') {
      state.detailScrollDown(1);
      return null;
    }
    if (key === 'k' || key === '\x1b[A') {
      state.detailScrollUp(1);
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
    case 'toggle-expand':
      if (state.mode === 'list' && state.selectedIndex >= 0 && state.items.length > 0) {
        const flat = state.getFlattenedItems();
        if (state.selectedIndex < flat.length) {
          const selected = flat[state.selectedIndex];
          // Only top-level items with children can be expanded/collapsed
          if (selected.depth === undefined && selected.childCount && selected.childCount > 0) {
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
export function createListRenderer(): (
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
) => string {
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
  ): string => {
    const { rows, cols } = termSize;
    const output: string[] = [];
    const listHeight = Math.max(3, rows - 6);

    if (mode === 'detail' && detailItem) {
      const viewportHeight = Math.max(10, rows - 1);
      const offset = detailScrollOffset ?? 0;
      return formatDetailView(detailItem, cols, offset, viewportHeight);
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
    output.push(header);
    output.push('');

    // Filter bar
    output.push(formatFilterBar(activeFilter, cols));

    // Items are already flattened by the caller (render callback in runWorklistTui
    // calls state.getFlattenedItems() before passing items here). Do NOT re-flatten.
    const flatItems = items;

    // Items with group separators
    const visible = flatItems.slice(scrollOffset, scrollOffset + listHeight);
    let lastDisplayedGroup: number | undefined;
    for (let i = 0; i < visible.length; i++) {
      const actualIndex = scrollOffset + i;
      const item = visible[i];

      // Insert group separator when group changes
      if (item.group !== undefined && item.id !== '..') {
        if (lastDisplayedGroup === undefined || item.group !== lastDisplayedGroup) {
          const label = item.groupLabel ?? `Group ${item.group}`;
          const sepColor = stageColor(item.stage);
          output.push(` ${ANSI.fg(sepColor)}${ANSI.bold}── ${label} ──${ANSI.reset}`);
        }
        lastDisplayedGroup = item.group;
      }

      // For hierarchy: apply _expanded flag for icon rendering
      const hasChildCount = item.childCount !== undefined && item.childCount > 0;
      const isExpanded = expandedItems?.has(item.id) ?? false;
      const expandedItem = { ...item, _expanded: hasChildCount && isExpanded };

      const isSelected = actualIndex === selectedIndex;
      const noIcons = !iconsEnabled();
      const line = formatItemLine(expandedItem, cols, isSelected, noIcons);
      if (isSelected) {
        output.push(`${ANSI.reverse}${line}${ANSI.reset}`);
      } else {
        output.push(line);
      }
    }

    // Fill remaining rows
    const used = 3 + 1 + visible.length; // header + blank + filterbar + items
    for (let i = used; i < rows - 1; i++) {
      output.push('');
    }

    // Footer with keyboard hints (dynamic — includes chord hints if available)
    const isChordActive = chordState && chordState.pendingKeys.length > 0;
    if (isChordActive) {
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

    return output.join('\n');
  };
}

// ── Main TUI loop ─────────────────────────────────────────────────────

/**
 * Default renderer instance.
 */
const defaultRenderer = createListRenderer();

/**
 * Resolve `<id>` placeholders in a command and route it through the
 * output mechanism. Used by {@link dispatchChordCommand} for agent
 * workflow and audit command families.
 *
 * @returns true if the command was resolved and routed, false if
 *          `<id>` was required but no item is selected (no-op)
 */
function resolveAndRouteCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string) => void,
): boolean {
  let resolvedCommand = command;

  if (resolvedCommand.includes('<id>')) {
    const flat = state.getFlattenedItems();
    const idx = state.selectedIndex;
    if (idx >= 0 && idx < flat.length) {
      resolvedCommand = resolvedCommand.replace(/<id>/g, flat[idx].id);
    } else {
      // No item selected and command requires <id> — graceful no-op
      return false;
    }
  }

  if (onCommand) {
    onCommand(resolvedCommand);
  }
  return true;
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
  onCommand?: (command: string) => void,
): boolean {
  // ── /wl <stage> commands (internal dispatch) ──────────────
  const wlStageMatch = command.match(/^\/wl\s+(\S+)$/);
  if (wlStageMatch) {
    const wlStage = wlStageMatch[1];
    // Map wl stage names to internal stage names
    const stageMap: Record<string, string> = {
      idea: 'idea',
      intake: 'intake_complete',
      plan: 'plan_complete',
      review: 'in_review',
    };
    const internalStage = stageMap[wlStage];
    if (internalStage) {
      state.applyFilter(internalStage);
      return true;
    }
  }

  // ── Agent skill invocations ─────────────────────────────
  if (command.startsWith('/skill:implement')) {
    return resolveAndRouteCommand(command, state, onCommand);
  }
  if (command.startsWith('/skill:audit')) {
    return resolveAndRouteCommand(command, state, onCommand);
  }

  // ── Agent workflow commands ─────────────────────────────
  if (command.startsWith('/intake')) {
    return resolveAndRouteCommand(command, state, onCommand);
  }
  if (command.startsWith('/plan')) {
    return resolveAndRouteCommand(command, state, onCommand);
  }

  // ── Producer review / audit compound commands ───────────
  if (command.startsWith('!!wl reviewed')) {
    return resolveAndRouteCommand(command, state, onCommand);
  }
  if (command.includes('&& wl audit-set')) {
    return resolveAndRouteCommand(command, state, onCommand);
  }

  // Unknown command — not handled
  return false;
}

/**
 * Execute a resolved chord command.
 *
 * Routing priority:
 * 1. {@link dispatchChordCommand} — handles `/wl <stage>` (internal filter),
 *    `/skill:implement`, `/skill:audit`, `/intake`, `/plan`, `!!wl reviewed`,
 *    and compound `&& wl audit-set` commands (resolves `<id>` and routes to
 *    `onCommand`). Returns 'dispatched'.
 * 2. For unrecognised command families, resolves `<id>` placeholders and
 *    passes to the optional `onCommand` callback. Returns 'callback'.
 * 3. If the command contains `<id>` but no item is selected, silently
 *    drops with 'noop'.
 *
 * @param command - The resolved command string (may contain `<id>` placeholders)
 * @param state - Current work item list state (for selected item lookup)
 * @param onCommand - Optional callback to receive resolved commands
 * @returns 'dispatched' if handled by dispatchChordCommand,
 *          'callback' if passed to onCommand,
 *          'noop' if skipped (no item + <id> requirement)
 */
export function executeResolvedCommand(
  command: string,
  state: WorkItemListState,
  onCommand?: (command: string) => void,
): 'dispatched' | 'callback' | 'noop' {
  // Try dispatchChordCommand first — handles /wl, /skill:, /intake, /plan,
  // !!wl reviewed, and compound audit commands
  if (dispatchChordCommand(command, state, onCommand)) {
    return 'dispatched';
  }

  // Not a recognised command family — resolve <id> placeholders and call onCommand
  let resolvedCommand = command;

  if (resolvedCommand.includes('<id>')) {
    const flat = state.getFlattenedItems();
    const idx = state.selectedIndex;
    if (idx >= 0 && idx < flat.length) {
      resolvedCommand = resolvedCommand.replace(/<id>/g, flat[idx].id);
    } else {
      // No item selected and command requires <id> — graceful no-op
      return 'noop';
    }
  }

  if (onCommand) {
    onCommand(resolvedCommand);
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
  options?: { autoRefresh?: boolean; refreshIntervalMs?: number; autoSync?: boolean; syncIntervalMs?: number; browseItemCount?: number; showHelpText?: boolean; onCommand?: (command: string) => void },
): Promise<WorkItem | undefined> {
  const opts = {
    autoRefresh: options?.autoRefresh ?? true,
    refreshIntervalMs: options?.refreshIntervalMs ?? 30000,
    autoSync: options?.autoSync ?? true,
    syncIntervalMs: options?.syncIntervalMs ?? 60000,
    browseItemCount: options?.browseItemCount ?? 10,
    showHelpText: options?.showHelpText ?? true,
    onCommand: options?.onCommand,
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
  const renderer = defaultRenderer;
  const chordState: ChordState = createChordState();
  let formState: FormState | null = null;
  /** Saved mode before entering form overlay (to restore on cancel) */
  let preFormMode: ViewMode = 'list';
  let refreshNotification = '';

  let totalActionableCount: number | undefined;

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
   * Fetch and apply updated items, with optional notification.
   */
  const doRefresh = async (showNotification = false): Promise<void> => {
    try {
      const newItems = await fetcher();
      const oldLen = state.items.length;
      state.refreshItems(newItems);
      if (showNotification && newItems.length !== oldLen) {
        const diff = newItems.length - oldLen;
        const msg = diff > 0 ? `+${diff} new` : `${diff} removed`;
        refreshNotification = ` ${ANSI.dim}[Refreshed: ${msg}]${ANSI.reset}`;
      } else if (showNotification) {
        refreshNotification = ` ${ANSI.dim}[Refreshed]${ANSI.reset}`;
      }
    } catch {
      refreshNotification = ` ${ANSI.dim}[Refresh failed]${ANSI.reset}`;
    }
    // Also fetch the total actionable count on refresh
    fetchActionableCount().then((count) => {
      totalActionableCount = count;
    }).catch(() => {
      // ignore
    });
    // Clear notification after brief display
    setTimeout(() => {
      refreshNotification = '';
      render();
    }, 3000);
    render();
  };

  const onData = async (chunk: Buffer): Promise<void> => {
    const key = chunk.toString();

    // ── Form mode handling ──────────────────────────────────────
    if (formState !== null) {
      const result = formState.handleInput(key);
      if (result === 'submitted') {
        const resolved = formState.getResult();
        formState = null;
        state.mode = preFormMode;
        if (opts.onCommand) {
          opts.onCommand(resolved);
        }
        refreshNotification = `Sent: ${resolved.length > 60 ? resolved.substring(0, 57) + '...' : resolved}`;
        setTimeout(() => { refreshNotification = ''; render(); }, 3000);
        render();
      } else if (result === 'cancelled') {
        formState = null;
        state.mode = preFormMode;
        refreshNotification = '';
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
      );

      if (chordResult === 'chord-complete') {
        // Chord resolved — execute the command
        const command = chordState.resolvedCommand;
        chordState.resolvedCommand = null;
        if (command) {
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
                if (opts.onCommand) {
                  opts.onCommand(finalCmd);
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
            const result = executeResolvedCommand(command, state, opts.onCommand);
            if (result === 'noop') {
              refreshNotification = `Skipped: ${command.length > 60 ? command.substring(0, 57) + '...' : command} (no item)`;
            } else {
              // Show a brief flash notification, then continue
              refreshNotification = `Sent: ${command.length > 60 ? command.substring(0, 57) + '...' : command}`;
            }
          } catch (e) {
            refreshNotification = `Error: ${(e as Error).message}`;
            process.stderr.write(`[herdr] Command error: ${(e as Error).message}\n`);
          }
          setTimeout(() => { refreshNotification = ''; render(); }, 3000);
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
    if (shortcutRegistry && (action === null || isChordLeader(key, shortcutRegistry as ShortcutRegistry))) {
      // First: check if this key is a complete single-key shortcut
      const singleCmd = (shortcutRegistry as ShortcutRegistry).lookupChord(
        [key],
        state.mode === 'detail' ? 'detail' : 'list',
        state.activeFilter ?? undefined,
      );
      if (singleCmd) {
        // Single-key shortcut — check for unknown identifiers first
        if (hasUnknownIdentifiers(singleCmd)) {
          let description = '';
          const entries = (shortcutRegistry as ShortcutRegistry).getEntries();
          const matchingEntry = entries.find(e => e.command === singleCmd);
          if (matchingEntry && matchingEntry.description) {
            description = matchingEntry.description;
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
              if (opts.onCommand) {
                opts.onCommand(finalCmd);
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
          executeResolvedCommand(singleCmd, state, opts.onCommand);
          // Show a brief flash notification, then continue
          refreshNotification = `Sent: ${singleCmd.length > 60 ? singleCmd.substring(0, 57) + '...' : singleCmd}`;
          setTimeout(() => { refreshNotification = ''; render(); }, 3000);
          render();
        } catch (e) {
          refreshNotification = `Error: ${(e as Error).message}`;
          process.stderr.write(`[herdr] Shortcut error: ${(e as Error).message}\n`);
          render();
        }
        return;
      }

      // Second: check if this key starts a multi-key chord sequence
      if (isChordLeader(key, shortcutRegistry as ShortcutRegistry)) {
        const nextChords = (shortcutRegistry as ShortcutRegistry).getChordByPrefix([key],
          state.mode === 'detail' ? 'detail' : 'list',
          state.activeFilter ?? undefined);
        if (nextChords.length > 0) {
          chordState.pendingKeys = [key];
          chordState.hints = formatChordHintsForHelp(nextChords, [key]);
          chordState.resolvedCommand = null;
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
          const children = await fetchChildrenForItem(selected.id);
          selected.children = children;
          state.toggleExpand(selected.id);
          render();
          return;
        }
      }
    }

    // Re-render
    render();
  };

  // Reset refresh notification on any keypress
  const originalOnData = onData;

  let resolve: (value: WorkItem | undefined) => void;
  const promise = new Promise<WorkItem | undefined>((res) => {
    resolve = res;
  });

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

    // Use flattened items for hierarchy display
    const displayItems = state.mode === 'list' ? state.getFlattenedItems() : state.items;

    // ── Compute stage-appropriate shortcut hints for the footer ──
    let dynamicHints = '';
    if (shortcutRegistry && chordState.pendingKeys.length === 0) {
      const reg = shortcutRegistry as ShortcutRegistry;
      const selIdx = state.selectedIndex;
      const selStage = displayItems.length > 0 && selIdx < displayItems.length
        ? displayItems[selIdx]?.stage
        : undefined;
      const isEmpty = displayItems.length === 0;

      const relevantEntries = reg.getEntriesForStage(selStage)
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
      opts.showHelpText ? dynamicHints : undefined,
      state.navigationStack.depth,
    );

    // Append notifications if present
    let notificationLine = '';
    if (refreshNotification) notificationLine += refreshNotification;
    const rendered = notificationLine
      ? output + '\n' + notificationLine
      : output;

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

  // Auto-refresh timer
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.autoRefresh) {
    refreshTimer = setInterval(() => {
      doRefresh(false);
    }, opts.refreshIntervalMs);
  }

  // Auto-sync timer (background wl sync)
  let syncTimer: ReturnType<typeof createSyncTimer> | undefined;
  if (opts.autoSync && opts.syncIntervalMs !== 0) {
    syncTimer = createSyncTimer({
      intervalMs: opts.syncIntervalMs,
      onSync: () => {
        runSync();
        doRefresh(false);
      },
    });
    syncTimer.start();
  }

  // Cleanup on promise resolution
  promise.finally(() => {
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
    }
    if (syncTimer !== undefined) {
      syncTimer.stop();
    }
    cleanup();
    process.stdout.removeListener('resize', onResize);
    process.stdin.removeListener('data', onData);
  });

  return promise;
}
