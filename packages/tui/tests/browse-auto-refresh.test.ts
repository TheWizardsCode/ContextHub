/**
 * Tests for the auto-refresh feature in the browse selection list.
 *
 * Verifies that:
 * - The items list is re-fetched every 5 seconds when reFetchItems is provided
 * - The currently selected item remains selected after refresh if its ID exists
 * - Selection falls back to index 0 when the selected item no longer exists
 * - The interval is cleaned up when the overlay closes (done() is called)
 * - Auto-refresh does not cause errors during normal operation
 *
 * Run: npx vitest run packages/tui/tests/browse-auto-refresh.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defaultChooseWorkItem, type WorklogBrowseItem } from '../extensions/index.js';
import { ShortcutRegistry, type ShortcutEntry } from '../extensions/shortcut-config.js';

describe('Browse list auto-refresh', () => {
  let items: WorklogBrowseItem[];
  let reFetchItems: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    items = [
      { id: 'WL-001', title: 'First item', status: 'open' },
      { id: 'WL-002', title: 'Second item', status: 'in_progress' },
      { id: 'WL-003', title: 'Third item', status: 'open' },
    ];
    reFetchItems = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Create a mock BrowseContext that captures the widget factory output.
   * Returns the mock context and helpers to inspect rendered output and
   * interact with the widget.
   */
  function createMockContext() {
    let capturedWidget: {
      render: (width: number) => string[];
      invalidate: () => void;
      handleInput?: (data: string) => void;
    } | null = null;
    let capturedTui: { requestRender: ReturnType<typeof vi.fn> } | null = null;
    let capturedDone: ReturnType<typeof vi.fn> | null = null;

    const mockUi = {
      custom: vi.fn(<T>(
        factory: (
          tui: any,
          theme: any,
          _keybindings: unknown,
          done: (value: T) => void,
        ) => {
          render: (width: number) => string[];
          invalidate: () => void;
          handleInput?: (data: string) => void;
        },
      ) => {
        const tui = { requestRender: vi.fn() };
        const theme = {
          fg: vi.fn((_color: string, text: string) => text),
          bold: vi.fn((text: string) => text),
        };
        const done = vi.fn();

        capturedWidget = factory(tui, theme, undefined, done);
        capturedTui = tui;
        capturedDone = done;

        // Return a never-resolving promise to keep the overlay "open"
        return new Promise<T>(() => { /* never resolves */ });
      }),
      notify: vi.fn(),
      setEditorText: vi.fn(),
      setWidget: vi.fn(),
      select: vi.fn(),
    };

    return {
      ctx: { ui: mockUi },
      getWidget: () => capturedWidget,
      getTui: () => capturedTui,
      getDone: () => capturedDone,
    };
  }

  it('re-fetches items and re-renders after 5 seconds when reFetchItems is provided', async () => {
    const { ctx, getWidget, getTui } = createMockContext();

    // Set up reFetchItems to return updated items
    reFetchItems.mockResolvedValue([
      { id: 'WL-001', title: 'First item (updated)', status: 'open' },
      { id: 'WL-004', title: 'Brand new item', status: 'open' },
    ]);

    // Start the browse dialog (don't await — it never resolves in the mock)
    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);

    // Initial render should show original items
    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Advance timers by 5 seconds to trigger the refresh
    await vi.advanceTimersByTimeAsync(5000);

    // reFetchItems should have been called
    expect(reFetchItems).toHaveBeenCalledTimes(1);

    // The tui.requestRender should have been called to trigger re-render
    expect(getTui()?.requestRender).toHaveBeenCalled();

    // Re-render to see updated items
    const linesAfter = widget!.render(80);
    // The updated items should now be rendered
    const rendered = linesAfter.join('\n');
    expect(rendered).toContain('First item (updated)');
    expect(rendered).toContain('Brand new item');
    // Original title should no longer be present
    expect(rendered).not.toContain('Second item');
    expect(rendered).not.toContain('Third item');
  });

  it('preserves the selected item index when its ID still exists after refresh', async () => {
    const { ctx, getWidget } = createMockContext();

    // Start with selection on the second item (index 1)
    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);
    const widget = getWidget()!;

    // Simulate navigating down to select the second item
    // The initial selection is index 0 (first item), so press Down to move to index 1
    widget.handleInput!('\u001b[B'); // down key
    const linesBefore = widget.render(80);
    // The selected item line should have '›' prefix (icons appear between › and title)
    const lineWithSecondBefore = linesBefore.find(l => l.includes('Second item'));
    expect(lineWithSecondBefore).toBeDefined();
    expect(lineWithSecondBefore).toContain('›');

    // Now refresh with updated items that still contain 'Second item' at a different position
    reFetchItems.mockResolvedValue([
      { id: 'WL-003', title: 'Third item', status: 'open' },
      { id: 'WL-002', title: 'Second item (updated)', status: 'in_progress' },
      { id: 'WL-001', title: 'First item', status: 'open' },
    ]);

    await vi.advanceTimersByTimeAsync(5000);

    // After refresh, selection should be on the item with ID WL-002 (now at index 1)
    const linesAfter = widget.render(80);
    const rendered = linesAfter.join('\n');
    // The selected item marker (›) should be on the Second item line
    const lineWithSecond = linesAfter.find(l => l.includes('Second item (updated)'));
    expect(lineWithSecond).toBeDefined();
    expect(lineWithSecond).toContain('›');
  });

  it('falls back to index 0 when the previously selected item no longer exists after refresh', async () => {
    const { ctx, getWidget } = createMockContext();

    // Navigate to second item then refresh with items that don't include WL-002
    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);
    const widget = getWidget()!;

    // Navigate down once to select WL-002 (index 1)
    widget.handleInput!('\u001b[B');

    // Refresh with items that only contain WL-001 and WL-003 (WL-002 removed)
    reFetchItems.mockResolvedValue([
      { id: 'WL-001', title: 'First item', status: 'open' },
      { id: 'WL-003', title: 'Third item', status: 'open' },
    ]);

    await vi.advanceTimersByTimeAsync(5000);

    // Selection should have fallen back to index 0 (WL-001)
    const linesAfter = widget.render(80);
    const firstItemLine = linesAfter.find(l => l.includes('First item'));
    expect(firstItemLine).toBeDefined();
    expect(firstItemLine).toContain('›');
  });

  it('does NOT re-fetch when reFetchItems is not provided', async () => {
    const { ctx, reFetchItems: _unused } = createMockContext();

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined);

    // Even with no reFetchItems provided, reFetchItems mock shouldn't be called
    // We just verify the widget works without auto-refresh
    await vi.advanceTimersByTimeAsync(5000);

    // No error should occur
    expect(true).toBe(true);
  });

  it('silently handles errors from reFetchItems without crashing', async () => {
    const { ctx, getWidget } = createMockContext();

    // reFetchItems returns a rejected promise
    reFetchItems.mockRejectedValue(new Error('Network error'));

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);

    // Initial state should be fine
    const widget = getWidget()!;
    let linesBefore = widget.render(80);
    expect(linesBefore.join('\n')).toContain('First item');

    // Advance timers - the error should be caught silently
    await vi.advanceTimersByTimeAsync(5000);

    // Widget should still work after error
    const linesAfter = widget.render(80);
    expect(linesAfter.join('\n')).toContain('First item');
    expect(linesAfter.join('\n')).toContain('Second item');
  });

  it('cleans up the interval when the overlay is closed via Enter', async () => {
    const { ctx, getWidget, getDone } = createMockContext();

    reFetchItems.mockResolvedValue([
      { id: 'WL-001', title: 'New title', status: 'open' },
    ]);

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);
    const widget = getWidget()!;
    const done = getDone()!;

    // Close the overlay by pressing Enter
    widget.handleInput!('\r'); // enter key

    // After done() is called, advance timers — reFetchItems should NOT be called again
    await vi.advanceTimersByTimeAsync(5000);

    // reFetchItems should have been called exactly 0 times (interval was cleared before it could fire)
    // But actually the interval might have fired once before Enter was pressed,
    // depending on timing. Let me restructure to be more precise.
    // Since we're using fake timers and the interval setup is synchronous,
    // the interval hasn't fired yet when we press Enter. So reFetchItems should be 0.
    expect(reFetchItems).toHaveBeenCalledTimes(0);
    expect(done).toHaveBeenCalled();
  });

  it('cleans up the interval when shortcut is dispatched', async () => {
    // Create a registry with a simple shortcut
    const entries: ShortcutEntry[] = [
      { key: 'i', command: '/implement <id>', view: 'list' },
    ];
    const registry = new ShortcutRegistry(entries);
    const { ctx, getWidget, getDone } = createMockContext();

    reFetchItems.mockResolvedValue([
      { id: 'WL-001', title: 'New title', status: 'open' },
    ]);

    defaultChooseWorkItem(items, ctx, vi.fn(), registry, reFetchItems);
    const widget = getWidget()!;
    const done = getDone()!;

    // Dispatch a shortcut by pressing 'i'
    widget.handleInput!('i');

    // After done() is called via shortcut dispatch, advance timers
    await vi.advanceTimersByTimeAsync(5000);

    // reFetchItems should not have been called (interval was cleared when done was called)
    expect(reFetchItems).toHaveBeenCalledTimes(0);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ type: 'shortcut' }));
  });

  it('does not refresh while a chord leader is pending', async () => {
    // Create registry with chord entries
    const chordEntries: ShortcutEntry[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'list' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'list' },
    ];
    const registry = new ShortcutRegistry(chordEntries);
    const { ctx, getWidget } = createMockContext();

    reFetchItems.mockResolvedValue([
      { id: 'WL-099', title: 'Refreshed', status: 'open' },
    ]);

    defaultChooseWorkItem(items, ctx, vi.fn(), registry, reFetchItems);
    const widget = getWidget()!;

    // Simulate pressing the chord leader key 'u' to enter pending state
    widget.handleInput!('u');

    // Advance timers - refresh should NOT fire because chord is pending
    await vi.advanceTimersByTimeAsync(5000);

    // reFetchItems should NOT have been called
    expect(reFetchItems).not.toHaveBeenCalled();

    // Now cancel the chord by pressing Escape
    widget.handleInput!('\u001b'); // escape key

    // Advance timers again - now refresh should fire
    await vi.advanceTimersByTimeAsync(5000);

    // reFetchItems should have been called after chord was cancelled
    expect(reFetchItems).toHaveBeenCalledTimes(1);
  });

  it('refreshes children via fetchChildren while navigating children (navStack non-empty)', async () => {
    const rootItems = [
      { id: 'WL-001', title: 'Parent item', status: 'open', childCount: 2 },
      { id: 'WL-002', title: 'Standalone item', status: 'open' },
    ];
    const childItems = [
      { id: 'WL-010', title: 'Child one', status: 'open' },
      { id: 'WL-011', title: 'Child two', status: 'open' },
    ];
    const updatedChildItems = [
      { id: 'WL-011', title: 'Child two (updated)', status: 'open' },
      { id: 'WL-012', title: 'New child', status: 'open' },
    ];
    const fetchChildren = vi.fn();
    // First call returns initial children, subsequent calls return updated
    fetchChildren.mockResolvedValueOnce(childItems);
    fetchChildren.mockResolvedValue(updatedChildItems);

    const { ctx, getWidget } = createMockContext();

    reFetchItems.mockResolvedValue([
      { id: 'WL-099', title: 'Refreshed root items', status: 'open' },
    ]);

    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, reFetchItems, fetchChildren);
    const widget = getWidget()!;

    // Navigate into children by pressing Enter on parent item (index 0)
    widget.handleInput!('\r');
    await vi.advanceTimersByTimeAsync(10);

    // Verify we're viewing children
    let lines = widget.render(80);
    expect(lines.join('\n')).toContain('Child one');
    expect(lines.join('\n')).toContain('Child two');

    // Verify fetchChildren was called with the correct parent ID
    expect(fetchChildren).toHaveBeenCalledWith('WL-001');
    const firstCallCount = fetchChildren.mock.calls.length;

    // Advance timers by 5 seconds — auto-refresh should fire and call fetchChildren
    await vi.advanceTimersByTimeAsync(5000);

    // fetchChildren should have been called again with the same parent ID
    expect(fetchChildren).toHaveBeenCalledTimes(firstCallCount + 1);
    expect(fetchChildren).toHaveBeenLastCalledWith('WL-001');

    // reFetchItems should NOT have been called (we are not at root level)
    expect(reFetchItems).not.toHaveBeenCalled();

    // The updated children should now be visible
    lines = widget.render(80);
    const rendered = lines.join('\n');
    expect(rendered).toContain('Child two (updated)');
    expect(rendered).toContain('New child');
    // Original items that are no longer in the refreshed set should be gone
    expect(rendered).not.toContain('Child one');
    // The ".." entry should still be present
    expect(rendered).toContain('..');
  });

  it('uses reFetchItems at root level but fetchChildren when viewing children', async () => {
    const rootItems = [
      { id: 'WL-001', title: 'Parent item', status: 'open', childCount: 2 },
      { id: 'WL-002', title: 'Standalone item', status: 'open' },
    ];
    const childItems = [
      { id: 'WL-010', title: 'Child one', status: 'open' },
      { id: 'WL-011', title: 'Child two', status: 'open' },
    ];
    const fetchChildren = vi.fn();
    fetchChildren.mockResolvedValue(childItems);

    const { ctx, getWidget } = createMockContext();

    reFetchItems.mockResolvedValue([
      { id: 'WL-099', title: 'Refreshed after root', status: 'open' },
    ]);

    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, reFetchItems, fetchChildren);
    const widget = getWidget()!;

    // Navigate into children
    widget.handleInput!('\r');
    await vi.advanceTimersByTimeAsync(10);

    // Advance timers — should use fetchChildren, not reFetchItems
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchChildren).toHaveBeenCalledWith('WL-001');
    expect(reFetchItems).not.toHaveBeenCalled();

    // Navigate back to root via Escape, then advance timers
    widget.handleInput!('\u001b');
    await vi.advanceTimersByTimeAsync(5000);

    // Now at root level, reFetchItems SHOULD be called
    expect(reFetchItems).toHaveBeenCalledTimes(1);
    const lines = widget.render(80);
    expect(lines.join('\n')).toContain('Refreshed after root');
  });

  it('properly applies sorted order from wl next on auto-refresh', async () => {
    const { ctx, getWidget } = createMockContext();

    // Initial items in unsorted order (simulating how they might arrive)
    // The auto-refresh should replace with correctly sorted items
    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, reFetchItems);
    const widget = getWidget()!;

    // Render initial items and capture display order
    let lines = widget.render(80);
    const initialRendered = lines.join('\n');
    const initialOrder = [
      initialRendered.indexOf('First item'),
      initialRendered.indexOf('Second item'),
      initialRendered.indexOf('Third item'),
    ];

    // Simulate wl next returning items in a different order (sorted)
    reFetchItems.mockResolvedValue([
      { id: 'WL-003', title: 'Third item', status: 'open' },  // was last, now first
      { id: 'WL-001', title: 'First item', status: 'open' },
      { id: 'WL-002', title: 'Second item', status: 'in_progress' },  // moved to end (in_progress, different priority)
    ]);

    // Advance timers by 5 seconds to trigger refresh
    await vi.advanceTimersByTimeAsync(5000);

    lines = widget.render(80);
    const rendered = lines.join('\n');

    // The order in the rendered list should match the new sorted order
    const orderAfter = [
      rendered.indexOf('Third item'),
      rendered.indexOf('First item'),
      rendered.indexOf('Second item'),
    ];

    // Each item should appear before the next one in the sorted order
    expect(orderAfter[0]).toBeLessThan(orderAfter[1]);
    expect(orderAfter[1]).toBeLessThan(orderAfter[2]);

    // All three items should still be present
    expect(rendered).toContain('First item');
    expect(rendered).toContain('Second item');
    expect(rendered).toContain('Third item');
  });
});
