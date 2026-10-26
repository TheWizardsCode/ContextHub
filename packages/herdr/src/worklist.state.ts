/**
 * packages/herdr/src/worklist.state.ts — the worklist's mutable list state
 * machine (and the gated-tick / input-active predicates beside it).
 *
 * Single responsibility: own the ONE mutable `WorkItemListState` instance's
 * shape and transitions (selection, hierarchy, display rows, filtering,
 * scrolling, refresh) plus the two predicates the scheduler ticks use to
 * decide whether a background refresh may run. No rendering, no I/O: the
 * presentation helpers this module needs (`metadataPanelContentHeight`,
 * `formatDetailContent`, `formatDetailToC`, `DETAIL_HEADER_LINES`,
 * `clearDescriptionPreviewCache`) are imported from the presentation leaf
 * modules, one way (parent WL-0MVGKGD2Y0038S6B AC4/AC5 — extracted modules
 * import concrete siblings, never the `worklist.js` barrel).
 *
 * Moved verbatim out of `worklist.ts` (parent WL-0MVGKGD2Y0038S6B; extraction
 * WL-0MVND6F9V004IQ3V). Move-only: no logic, rename or field-order change.
 */

import type { WorkItem, BlockerRef } from './fetcher.js';
import type { FormState } from './form-dialog.js';
import type { ShipItDialogState } from './ship-it-dialog.js';
import type {
  DisplayHeadingRow,
  NavigationStackEntry,
  TermSize,
  ViewMode,
} from './worklist.types.js';
import { NavigationStack } from './worklist.navigation.js';
import { computeMetadataPanelHeight } from './worklist.layout.js';
import {
  clearDescriptionPreviewCache,
  metadataPanelContentHeight,
} from './worklist.meta.js';
import {
  DETAIL_HEADER_LINES,
  formatDetailContent,
  formatDetailToC,
} from './worklist.detail.js';

// ── Input-active predicate (WL-0MTV67MZU003H7SH) ──────────────────────

/**
 * Whether any text-input overlay is currently active.
 *
 * Returns `true` when `formState` or `shipItDialog` is non-null — meaning
 * the user is actively typing into a form (unknown-identifier input),
 * the Ship It confirmation dialog, or note-edit (which opens a FormState).
 * When `true`, the scheduler should skip auto-refresh and auto-sync ticks
 * so keypresses are not dropped by a concurrent re-render.
 *
 * Design decision — skip, don't coalesce: ticks while typing are silently
 * dropped; the next regular tick after close fires normally. No queued
 * immediate refresh is emitted on close (avoids infinite-refresh loops).
 *
 * NOTE: this gate stops background re-render contention but does NOT by
 * itself prevent dropped keystrokes when the user types fast — the PTY can
 * coalesce several keys into one stdin chunk. The text-input handlers run
 * every chunk through `splitKeypresses()` (`key-input.ts`) so no character
 * is discarded (WL-0MTV67MZU003H7SH).
 */
export function isInputActive(
  formState: FormState | null,
  shipItDialog: ShipItDialogState | null,
  blockedNoticeActive = false,
): boolean {
  return formState !== null || shipItDialog !== null || blockedNoticeActive;
}

/**
 * Build the standard scheduler-tick runner used by the worklist's periodic
 * tasks (the 30s auto-refresh and the 60s auto-sync).
 *
 * Gate ordering:
 *   1. Typing gate — skip while any text-input overlay is open so a
 *      background re-render never steals focus or drops a keypress
 *      (WL-0MTV67MZU003H7SH).
 *   2. Visibility gate — skip while the pane's tab is hidden
 *      (pause-when-hidden); the hidden/visible side effects are delegated to
 *      the caller so it can drive the resume-poll and `panePaused` state.
 *   3. DB-change gate — skip when the worklog DB is unchanged and the last
 *      sync is still fresh (zero `wl` spawns for an idle pane).
 *
 * Skips are silent and NOT coalesced: the task stays scheduled, so the next
 * regular tick after the reason clears fires normally.
 *
 * Exported so the scheduler-integration tests exercise the REAL guard
 * ordering with a real `TaskScheduler`, instead of re-implementing the guard
 * inline in the test body.
 */
export function createGatedTick(deps: {
  isInputActive: () => boolean;
  isVisible: () => Promise<boolean>;
  onHidden: () => void;
  onVisible: () => void;
  isDbUnchanged: () => boolean;
  action: () => void;
}): () => Promise<void> {
  return async () => {
    if (deps.isInputActive()) return;
    if (!(await deps.isVisible())) {
      deps.onHidden();
      return;
    }
    deps.onVisible();
    if (deps.isDbUnchanged()) return;
    deps.action();
  };
}

// ── State ─────────────────────────────────────────────────────────────

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

  /**
   * All loaded items (unfiltered). Lets the pane-marker refresh re-evaluate
   * every item — including those excluded by the active stage/priority
   * filter — without a `wl` re-fetch (WL-0MV1BWETT005GSUJ).
   */
  allItems(): WorkItem[] {
    return this._allItems;
  }

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
   * Active recent-dispatches filter (WL-0MUL2IZLF002S9X5). The third
   * mutually-exclusive filter axis: when true the list shows log-derived
   * synthetic rows from `.worklog/downtime-dispatches.log` instead of live
   * `wl` items. Applying a stage/priority filter clears it and vice versa,
   * and `clearFilter()` clears all three axes.
   */
  activeDispatchFilter = false;

  /**
   * Display label for the active filter, axis-qualified, or null when no
   * filter is active (e.g. `stage in_review`, `priority critical`,
   * `dispatches`). The list header renders `(filtered: <label>)` from this
   * value.
   */
  get activeFilterLabel(): string | null {
    if (this.activeFilter) return `stage ${this.activeFilter}`;
    if (this.activePriorityFilter) return `priority ${this.activePriorityFilter}`;
    if (this.activeDispatchFilter) return 'dispatches';
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

  /**
   * Active blockers of the current selection, supplied by the render loop so
   * the metadata-panel scroll clamp counts the same `Blocked By` rows the
   * renderer shows (WL-0MV8EZRDJ001TDA8). Null while unresolved or absent.
   */
  metaBlockedBy: BlockerRef[] | null = null;

  /**
   * Active blockers of the detail item, supplied by the render loop so the
   * detail-view scroll clamp counts the `Blocked By` rows the renderer shows
   * (WL-0MVBMLY2Z0032CYR). Null while unresolved or absent.
   */
  detailBlockedBy: BlockerRef[] | null = null;

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

    const appendItem = (item: WorkItem, depth: number, parent: WorkItem | null): void => {
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
            depth,
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

      // Enrich nested items with their direct parent's audit state so the
      // render layer can derive coverage at read time
      // (WL-0MUBVH8QG0020H9L). Root rows pass through unchanged.
      const node = depth > 0 ? withParentAudit(item, parent) : item;
      if (depth === 0) {
        result.push(node);
      } else {
        result.push(node.depth === depth ? node : { ...node, depth });
      }
      if (item.childCount && item.children && item.children.length > 0 && this.expandedItems.has(item.id)) {
        for (const child of item.children) {
          appendItem(child, depth + 1, item);
        }
      }
    };

    for (const item of this.items) {
      appendItem(item, 0, null);
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
    const appendItem = (item: WorkItem, depth: number, parent: WorkItem | null): void => {
      // Enrich nested items with their direct parent's audit state so derived
      // coverage is available on the flattened rows as well as the display
      // rows (WL-0MUBVH8QG0020H9L).
      const node = depth > 0 ? withParentAudit(item, parent) : item;
      // Top-level items are pushed as-is (no depth field, matching the
      // pre-hierarchy shape). Nested items are always shallow copies: the
      // coverage enrichment above adds `parentAudit`, and a stored depth that
      // does not match the hierarchy position is additionally corrected.
      // On-demand child fetches mutate the LIVE tree (attachChildren), which
      // the next flatten picks up — the copy is display-only.
      if (depth === 0) {
        result.push(node);
      } else {
        result.push(node.depth === depth ? node : { ...node, depth });
      }
      if (item.childCount && item.children && item.children.length > 0 && this.expandedItems.has(item.id)) {
        for (const child of item.children) {
          appendItem(child, depth + 1, item);
        }
      }
    };
    for (const item of this.items) {
      appendItem(item, 0, null);
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
    // scrolls (WL-0MSHWHULZ001FL8I / WL-0MSI28AP80002F5S). The content
    // height must include the `Blocked By` rows the renderer shows or they
    // become unreachable when the view scrolls (WL-0MVBMLY2Z0032CYR).
    const allLines = formatDetailContent(this.detailItem, maxCols, undefined, false, 0, true, 0, this.detailBlockedBy);
    const tocLines = formatDetailToC(this.detailItem, maxCols).length;
    const pinnedHeight = DETAIL_HEADER_LINES + tocLines;
    const bodyLines = Math.max(0, allLines.length - pinnedHeight);
    const bodyViewport = Math.max(1, viewportHeight - pinnedHeight);
    const maxScroll = Math.max(0, bodyLines - bodyViewport);
    this.detailScrollOffset = Math.min(maxScroll, this.detailScrollOffset + amount);
  }

  // ── Selection-preserving list scroll (drag-to-scroll) ───────────
  /**
   * Scroll the list by a given number of rows **without** changing the
   * selected index.  Clamps `scrollOffset` to `[0, maxOffset]` using the
   * same `_listHeight()` / `flatCount` maths as `_adjustScroll`.  (WL-0MSI72S0Y0060BRK)
   */
  scrollBy(rows: number): void {
    const listHeight = this._listHeight();
    const maxOffset = Math.max(0, this.flatCount - listHeight);
    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + rows));
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
    const contentHeight = metadataPanelContentHeight(selected, this.termSize.cols, ph, undefined, false, this.metaBlockedBy);
    const maxScroll = Math.max(0, contentHeight - ph);
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
    this.activeDispatchFilter = false; // replace semantics: one axis at a time
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
    this.activeDispatchFilter = false; // replace semantics: one axis at a time
    this._applyFilters();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.mode = 'list';
    this._resetMetaScroll();
    // Filter changes the visible item set — invalidate cached previews.
    clearDescriptionPreviewCache();
  }

  /**
   * Apply the recent-dispatches filter (replace semantics,
   * WL-0MUL2IZLF002S9X5): clears any active stage/priority filter so the
   * dispatch axis is mutually exclusive with the other two. The dispatch
   * rows are supplied by `fetchItemsForView` (sourced from the local rolling
   * dispatch log), so `_applyFilters` passes them through unchanged.
   */
  applyDispatchFilter(): void {
    this.activeDispatchFilter = true;
    this.activeFilter = null; // replace semantics: one axis at a time
    this.activePriorityFilter = null; // replace semantics: one axis at a time
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
    this.activeDispatchFilter = false;
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
    // The dispatches axis is applied at FETCH time (fetchItemsForView
    // returns exactly the log-derived rows); there is nothing further to
    // filter here, so every fetched row passes through unchanged
    // (WL-0MUL2IZLF002S9X5).
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

/**
 * Return a shallow copy of a nested item carrying its DIRECT parent's audit
 * state, so the render layer can derive child coverage at read time
 * (WL-0MUBVH8QG0020H9L). Coverage is derived, never persisted: the copy's
 * `parentAudit` is consumed by the shared `isCoveredByParent` /
 * `stageDisplayIcon` helpers. A root item (parent === null) is returned
 * unchanged. Depth is limited to the direct parent (depth 1); transitive
 * coverage is intentionally out of scope.
 */
function withParentAudit(item: WorkItem, parent: WorkItem | null): WorkItem {
  if (!parent) return item;
  return {
    ...item,
    parentId: item.parentId ?? parent.id,
    parentAudit: {
      auditResult: parent.auditResult,
      auditedAt: parent.auditedAt,
      updatedAt: parent.updatedAt,
      fingerprint: parent.fingerprint,
      currentFingerprint: parent.currentFingerprint,
    },
  };
}
