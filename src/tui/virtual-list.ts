/**
 * VirtualList — lightweight virtual-scroll viewport for the work-item tree.
 *
 * Keeps track of a contiguous *viewport* window over a flat array of item
 * labels so that only the visible rows need to be passed to the blessed List
 * widget at any given time.  All indexing arithmetic lives here so it can be
 * tested independently of the blessed runtime.
 *
 * Introduced as the default virtual-scroll feature for the work-item tree.
 */

export interface VirtualListOptions {
  /** Total number of items in the full list. */
  totalItems: number;
  /** Number of rows the viewport can display at once. */
  viewportHeight: number;
}

export class VirtualList {
  private _totalItems: number;
  private _viewportHeight: number;

  /** Index of the first item currently visible (0-based). */
  private _offset: number = 0;

  /** Index of the selected item within the full list (0-based). */
  private _selectedIndex: number = 0;

  constructor(options: VirtualListOptions) {
    this._totalItems = Math.max(0, options.totalItems);
    this._viewportHeight = Math.max(1, options.viewportHeight);
  }

  // ── Accessors ─────────────────────────────────────────────────────

  get totalItems(): number {
    return this._totalItems;
  }

  get viewportHeight(): number {
    return this._viewportHeight;
  }

  /** The scroll offset: index of the first visible item. */
  get offset(): number {
    return this._offset;
  }

  /** The globally selected index (into the full item list). */
  get selectedIndex(): number {
    return this._selectedIndex;
  }

  /**
   * The selected index relative to the current viewport window
   * (i.e. the row that should be highlighted inside the blessed List).
   */
  get selectedIndexInViewport(): number {
    return this._selectedIndex - this._offset;
  }

  // ── Mutation helpers ──────────────────────────────────────────────

  /**
   * Update the total number of items (e.g. after the tree is rebuilt).
   * Clamps existing offset/selection to valid ranges.
   */
  setTotalItems(n: number): void {
    this._totalItems = Math.max(0, n);
    this._clamp();
  }

  /**
   * Update the viewport height (e.g. on terminal resize).
   * Re-clamps the offset so the selection remains visible.
   */
  setViewportHeight(h: number): void {
    this._viewportHeight = Math.max(1, h);
    this._clamp();
  }

  /**
   * Move the selection by `delta` rows (positive = down, negative = up).
   * Scrolls the viewport window to follow the cursor.
   */
  moveBy(delta: number): void {
    this._selectedIndex = Math.max(
      0,
      Math.min(this._totalItems - 1, this._selectedIndex + delta),
    );
    this._scrollToSelection();
  }

  /**
   * Jump the selection to an absolute index in the full list.
   */
  selectAbsolute(index: number): void {
    this._selectedIndex = Math.max(
      0,
      Math.min(this._totalItems - 1, index),
    );
    this._scrollToSelection();
  }

  /**
   * Scroll the viewport by `delta` rows without moving the selection
   * (clamped to valid range).  Updates selection if it falls outside the
   * new viewport.
   */
  scrollBy(delta: number): void {
    this._offset = Math.max(
      0,
      Math.min(this._maxOffset(), this._offset + delta),
    );
    // Keep selection within the new viewport
    if (this._selectedIndex < this._offset) {
      this._selectedIndex = this._offset;
    }
    const lastVisible = this._offset + this._viewportHeight - 1;
    if (this._selectedIndex > lastVisible) {
      this._selectedIndex = lastVisible;
    }
    this._clamp();
  }

  // ── Slice helper ──────────────────────────────────────────────────

  /**
   * Return the slice of `allItems` that should be visible in the current
   * viewport.  `allItems` must have exactly `totalItems` entries.
   */
  slice<T>(allItems: T[]): T[] {
    const end = Math.min(this._offset + this._viewportHeight, allItems.length);
    return allItems.slice(this._offset, end);
  }

  // ── Private helpers ───────────────────────────────────────────────

  private _maxOffset(): number {
    return Math.max(0, this._totalItems - this._viewportHeight);
  }

  /** Ensure offset and selectedIndex are within valid bounds. */
  private _clamp(): void {
    this._selectedIndex = Math.max(
      0,
      Math.min(this._totalItems > 0 ? this._totalItems - 1 : 0, this._selectedIndex),
    );
    this._offset = Math.max(0, Math.min(this._maxOffset(), this._offset));
    // If selection is now outside viewport, re-scroll
    this._scrollToSelection();
  }

  /**
   * Adjust `_offset` so the selected item is always visible.
   * Uses a "scroll-ahead" of 0 (selection lands exactly at edge).
   */
  private _scrollToSelection(): void {
    if (this._totalItems === 0) {
      this._offset = 0;
      return;
    }
    if (this._selectedIndex < this._offset) {
      this._offset = this._selectedIndex;
    }
    const lastVisible = this._offset + this._viewportHeight - 1;
    if (this._selectedIndex > lastVisible) {
      this._offset = this._selectedIndex - this._viewportHeight + 1;
    }
    this._offset = Math.max(0, Math.min(this._maxOffset(), this._offset));
  }
}
