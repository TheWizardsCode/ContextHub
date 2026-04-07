import { describe, it, expect } from 'vitest';
import { VirtualList } from '../../src/tui/virtual-list.js';

describe('VirtualList', () => {
  // ── Constructor ────────────────────────────────────────────────────

  it('initializes with correct defaults', () => {
    const vl = new VirtualList({ totalItems: 100, viewportHeight: 20 });
    expect(vl.totalItems).toBe(100);
    expect(vl.viewportHeight).toBe(20);
    expect(vl.offset).toBe(0);
    expect(vl.selectedIndex).toBe(0);
    expect(vl.selectedIndexInViewport).toBe(0);
  });

  it('clamps negative totalItems to 0', () => {
    const vl = new VirtualList({ totalItems: -5, viewportHeight: 10 });
    expect(vl.totalItems).toBe(0);
  });

  it('clamps viewportHeight below 1 to 1', () => {
    const vl = new VirtualList({ totalItems: 10, viewportHeight: 0 });
    expect(vl.viewportHeight).toBe(1);
  });

  // ── slice() ────────────────────────────────────────────────────────

  it('slice() returns the first viewport window', () => {
    const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const vl = new VirtualList({ totalItems: 50, viewportHeight: 10 });
    expect(vl.slice(items)).toEqual(items.slice(0, 10));
  });

  it('slice() returns correct window after scrolling down', () => {
    const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const vl = new VirtualList({ totalItems: 50, viewportHeight: 10 });
    vl.moveBy(15); // moves selection to index 15, scrolls viewport
    const sliced = vl.slice(items);
    expect(sliced.length).toBe(10);
    expect(sliced[0]).toBe(`item-${vl.offset}`);
  });

  it('slice() handles items shorter than viewportHeight', () => {
    const items = ['a', 'b', 'c'];
    const vl = new VirtualList({ totalItems: 3, viewportHeight: 10 });
    expect(vl.slice(items)).toEqual(['a', 'b', 'c']);
  });

  it('slice() returns empty array for empty list', () => {
    const vl = new VirtualList({ totalItems: 0, viewportHeight: 10 });
    expect(vl.slice([])).toEqual([]);
  });

  // ── moveBy() ──────────────────────────────────────────────────────

  it('moveBy(1) increments selectedIndex', () => {
    const vl = new VirtualList({ totalItems: 10, viewportHeight: 5 });
    vl.moveBy(1);
    expect(vl.selectedIndex).toBe(1);
  });

  it('moveBy does not go below 0', () => {
    const vl = new VirtualList({ totalItems: 10, viewportHeight: 5 });
    vl.moveBy(-5);
    expect(vl.selectedIndex).toBe(0);
    expect(vl.offset).toBe(0);
  });

  it('moveBy does not exceed totalItems - 1', () => {
    const vl = new VirtualList({ totalItems: 5, viewportHeight: 3 });
    vl.moveBy(100);
    expect(vl.selectedIndex).toBe(4);
  });

  it('moveBy scrolls viewport when selection exits bottom', () => {
    const vl = new VirtualList({ totalItems: 20, viewportHeight: 5 });
    // Selection is at 0, viewport is [0..4].  Moving by 5 puts selection at 5.
    vl.moveBy(5);
    expect(vl.selectedIndex).toBe(5);
    // Viewport must have scrolled so selection is visible
    expect(vl.offset).toBeLessThanOrEqual(5);
    expect(vl.offset + vl.viewportHeight - 1).toBeGreaterThanOrEqual(5);
    expect(vl.selectedIndexInViewport).toBe(vl.selectedIndex - vl.offset);
  });

  it('moveBy scrolls viewport when selection exits top', () => {
    const vl = new VirtualList({ totalItems: 20, viewportHeight: 5 });
    vl.selectAbsolute(10);
    const offsetAfterJump = vl.offset;
    vl.moveBy(-5); // go back up 5 rows
    expect(vl.selectedIndex).toBe(5);
    // Viewport should have adjusted so 5 is visible
    expect(vl.offset).toBeLessThanOrEqual(5);
    expect(vl.offset + vl.viewportHeight - 1).toBeGreaterThanOrEqual(5);
    // offset must not exceed the position before the jump
    expect(vl.offset).toBeLessThanOrEqual(offsetAfterJump);
  });

  // ── selectAbsolute() ──────────────────────────────────────────────

  it('selectAbsolute() sets selection and scrolls into view', () => {
    const vl = new VirtualList({ totalItems: 100, viewportHeight: 10 });
    vl.selectAbsolute(50);
    expect(vl.selectedIndex).toBe(50);
    expect(vl.offset).toBeLessThanOrEqual(50);
    expect(vl.offset + vl.viewportHeight - 1).toBeGreaterThanOrEqual(50);
  });

  it('selectAbsolute() clamps to 0 for negative values', () => {
    const vl = new VirtualList({ totalItems: 10, viewportHeight: 5 });
    vl.selectAbsolute(-3);
    expect(vl.selectedIndex).toBe(0);
  });

  it('selectAbsolute() clamps to last item when index >= totalItems', () => {
    const vl = new VirtualList({ totalItems: 5, viewportHeight: 3 });
    vl.selectAbsolute(99);
    expect(vl.selectedIndex).toBe(4);
  });

  // ── selectedIndexInViewport ───────────────────────────────────────

  it('selectedIndexInViewport reflects the relative position', () => {
    const vl = new VirtualList({ totalItems: 30, viewportHeight: 10 });
    vl.selectAbsolute(15);
    expect(vl.selectedIndexInViewport).toBe(vl.selectedIndex - vl.offset);
  });

  it('selectedIndexInViewport is 0 initially', () => {
    const vl = new VirtualList({ totalItems: 30, viewportHeight: 10 });
    expect(vl.selectedIndexInViewport).toBe(0);
  });

  // ── scrollBy() ───────────────────────────────────────────────────

  it('scrollBy(1) advances the viewport offset', () => {
    const vl = new VirtualList({ totalItems: 20, viewportHeight: 5 });
    vl.scrollBy(1);
    expect(vl.offset).toBe(1);
  });

  it('scrollBy clamps at 0 going up', () => {
    const vl = new VirtualList({ totalItems: 20, viewportHeight: 5 });
    vl.scrollBy(-10);
    expect(vl.offset).toBe(0);
  });

  it('scrollBy clamps at maxOffset going down', () => {
    const vl = new VirtualList({ totalItems: 10, viewportHeight: 5 });
    vl.scrollBy(100);
    // maxOffset = 10 - 5 = 5
    expect(vl.offset).toBe(5);
  });

  it('scrollBy adjusts selection to stay within new viewport', () => {
    const vl = new VirtualList({ totalItems: 20, viewportHeight: 5 });
    // selection is 0, offset 0 => scroll down 3
    vl.scrollBy(3);
    expect(vl.offset).toBe(3);
    // selection must be >= offset
    expect(vl.selectedIndex).toBeGreaterThanOrEqual(vl.offset);
  });

  // ── setTotalItems() ───────────────────────────────────────────────

  it('setTotalItems() re-clamps selection when list shrinks', () => {
    const vl = new VirtualList({ totalItems: 20, viewportHeight: 5 });
    vl.selectAbsolute(15);
    vl.setTotalItems(5);
    expect(vl.selectedIndex).toBeLessThanOrEqual(4);
    expect(vl.selectedIndex).toBeGreaterThanOrEqual(0);
  });

  it('setTotalItems(0) resets selection and offset to 0', () => {
    const vl = new VirtualList({ totalItems: 20, viewportHeight: 5 });
    vl.selectAbsolute(10);
    vl.setTotalItems(0);
    expect(vl.selectedIndex).toBe(0);
    expect(vl.offset).toBe(0);
  });

  // ── setViewportHeight() ───────────────────────────────────────────

  it('setViewportHeight() updates height and clamps offset', () => {
    const vl = new VirtualList({ totalItems: 20, viewportHeight: 5 });
    vl.selectAbsolute(18);
    const prevOffset = vl.offset;
    vl.setViewportHeight(10); // larger viewport
    // offset may decrease so selection is visible
    expect(vl.offset).toBeLessThanOrEqual(prevOffset);
    expect(vl.offset + vl.viewportHeight - 1).toBeGreaterThanOrEqual(vl.selectedIndex);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it('handles single-item list without errors', () => {
    const vl = new VirtualList({ totalItems: 1, viewportHeight: 10 });
    expect(vl.selectedIndex).toBe(0);
    expect(vl.offset).toBe(0);
    vl.moveBy(1);
    expect(vl.selectedIndex).toBe(0);
    vl.moveBy(-1);
    expect(vl.selectedIndex).toBe(0);
  });

  it('viewportHeight larger than totalItems returns all items in slice', () => {
    const items = ['a', 'b', 'c'];
    const vl = new VirtualList({ totalItems: 3, viewportHeight: 100 });
    expect(vl.slice(items)).toHaveLength(3);
  });

  it('offset never exceeds totalItems - viewportHeight', () => {
    const vl = new VirtualList({ totalItems: 10, viewportHeight: 5 });
    vl.selectAbsolute(9);
    // maxOffset = 10 - 5 = 5
    expect(vl.offset).toBeLessThanOrEqual(5);
  });
});
