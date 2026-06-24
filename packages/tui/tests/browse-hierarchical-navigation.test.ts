vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn((path) => {
    if (String(path).endsWith('shortcuts.json')) {
      return JSON.stringify([
        { key: 'n', command: '/intake <id>', view: 'both', stages: ['idea'] },
        { key: 'p', command: '/plan <id>', view: 'both', stages: ['intake_complete'] },
        { key: 'i', command: '/skill:implement <id>', view: 'both', stages: ['intake_complete', 'plan_complete', 'in_progress'] },
        { key: 'a', command: '/skill:audit <id>', view: 'both', stages: ['in_progress', 'in_review'] },
      ]);
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn((p) => p),
}));

/**

 * Tests for hierarchical navigation in the browse selection list.

 *

 * Verifies that:

 * - Items with children show child count indicator regardless of issue type

 * - Enter on item with children fetches and displays children

 * - ".." entry is shown at the top of child lists

 * - Enter on ".." navigates back to the parent level

 * - Escape navigates back one level when viewing children

 * - Escape closes the overlay at root level

 * - Arbitrary depth navigation works (children of children)

 * - Selection position is restored when navigating back

 * - Enter on item without children opens detail view at root level

 *

 * Run: npx vitest run packages/tui/tests/browse-hierarchical-navigation.test.ts

 */



import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { defaultChooseWorkItem, getIconPrefix, type WorklogBrowseItem } from '../extensions/Worklog/index.js';

// ─── getIconPrefix tests ─────────────────────────────────────────────

describe('getIconPrefix - child count indicator', () => {
  it('shows child count for epic items with children (existing behavior)', () => {
    const item: WorklogBrowseItem = {
      id: 'WL-001',
      title: 'Epic item',
      status: 'open',
      issueType: 'epic',
      childCount: 3,
    };
    const prefix = getIconPrefix(item, false);
    expect(prefix).toContain('(3)');
  });

  it('shows child count for feature items with children', () => {
    const item: WorklogBrowseItem = {
      id: 'WL-002',
      title: 'Feature with children',
      status: 'open',
      issueType: 'feature',
      childCount: 2,
    };
    const prefix = getIconPrefix(item, false);
    expect(prefix).toContain('(2)');
  });

  it('shows child count for task items with children', () => {
    const item: WorklogBrowseItem = {
      id: 'WL-003',
      title: 'Task with children',
      status: 'open',
      issueType: 'task',
      childCount: 1,
    };
    const prefix = getIconPrefix(item, false);
    expect(prefix).toContain('(1)');
  });

  it('shows child count for bug items with children', () => {
    const item: WorklogBrowseItem = {
      id: 'WL-004',
      title: 'Bug with children',
      status: 'open',
      issueType: 'bug',
      childCount: 5,
    };
    const prefix = getIconPrefix(item, false);
    expect(prefix).toContain('(5)');
  });

  it('does NOT show child count for items with no children (childCount 0)', () => {
    const item: WorklogBrowseItem = {
      id: 'WL-005',
      title: 'No children',
      status: 'open',
      issueType: 'feature',
      childCount: 0,
    };
    const prefix = getIconPrefix(item, false);
    expect(prefix).not.toMatch(/\(\d+\)/);
  });

  it('does NOT show child count for items with undefined childCount', () => {
    const item: WorklogBrowseItem = {
      id: 'WL-006',
      title: 'No children',
      status: 'open',
      issueType: 'task',
    };
    const prefix = getIconPrefix(item, false);
    expect(prefix).not.toMatch(/\(\d+\)/);
  });

  it('shows child count for all items with children regardless of issueType', () => {
    const epicItem: WorklogBrowseItem = {
      id: 'WL-010', title: 'Epic', status: 'open',
      issueType: 'epic', childCount: 3,
    };
    const featureItem: WorklogBrowseItem = {
      id: 'WL-011', title: 'Feature', status: 'open',
      issueType: 'feature', childCount: 2,
    };
    const taskItem: WorklogBrowseItem = {
      id: 'WL-012', title: 'Task', status: 'open',
      issueType: 'task', childCount: 4,
    };
    const bugItem: WorklogBrowseItem = {
      id: 'WL-013', title: 'Bug', status: 'open',
      issueType: 'bug', childCount: 1,
    };

    expect(getIconPrefix(epicItem, false)).toContain('(3)');
    expect(getIconPrefix(featureItem, false)).toContain('(2)');
    expect(getIconPrefix(taskItem, false)).toContain('(4)');
    expect(getIconPrefix(bugItem, false)).toContain('(1)');
  });

  it('shows child count even when icons are disabled (noIcons=true)', () => {
    const item: WorklogBrowseItem = {
      id: 'WL-020', title: 'Has children', status: 'open',
      issueType: 'feature', childCount: 3,
    };
    const prefix = getIconPrefix(item, true);
    // With noIcons, epic icon may be empty, but child count should still show
    expect(prefix).toContain('(3)');
  });
});

// ─── Hierarchical navigation tests ──────────────────────────────────

describe('Hierarchical navigation in defaultChooseWorkItem', () => {
  let rootItems: WorklogBrowseItem[];
  let childItems: WorklogBrowseItem[];
  let grandchildItems: WorklogBrowseItem[];

  beforeEach(() => {
    vi.useFakeTimers();
    rootItems = [
      { id: 'WL-001', title: 'Parent item', status: 'open', childCount: 2 },
      { id: 'WL-002', title: 'Standalone item', status: 'open' },
    ];
    childItems = [
      { id: 'WL-003', title: 'First child', status: 'open', childCount: 1 },
      { id: 'WL-004', title: 'Second child', status: 'open' },
    ];
    grandchildItems = [
      { id: 'WL-005', title: 'Grandchild', status: 'open' },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Create a mock BrowseContext that captures the widget factory output.
   * Pattern adapted from browse-auto-refresh.test.ts.
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

  /**
   * Helper: check if a rendered line has the selection marker (›) for the
   * item at the given index.
   */
  function getSelectionMarker(lines: string[], itemTitle: string): string | undefined {
    return lines.find(l => l.includes(itemTitle));
  }

  it('calls done with the selected item when Enter is pressed on an item without children (root level)', () => {
    const { ctx, getWidget, getDone } = createMockContext();

    defaultChooseWorkItem(rootItems, ctx, vi.fn());
    const widget = getWidget()!;
    const done = getDone()!;

    // Navigate down to standalone item (index 1, no childCount)
    widget.handleInput!('\u001b[B');
    // Press Enter
    widget.handleInput!('\r');

    expect(done).toHaveBeenCalledWith(rootItems[1]);
  });

  it('does NOT call done when Enter is pressed on an item with children (uses fetchChildren instead)', () => {
    const { ctx, getWidget, getDone } = createMockContext();

    // Provide a fetchChildren mock
    const fetchChildren = vi.fn().mockResolvedValue(childItems);
    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, undefined, fetchChildren);
    const widget = getWidget()!;
    const done = getDone()!;

    // Press Enter on parent item (index 0, childCount=2)
    widget.handleInput!('\r');

    // done should NOT have been called (we're navigating into children, not selecting)
    expect(done).not.toHaveBeenCalled();
    // fetchChildren should have been called with the parent ID
    expect(fetchChildren).toHaveBeenCalledWith('WL-001');
  });

  it('renders child items and a ".." entry after Enter on parent', async () => {
    const { ctx, getWidget, getDone } = createMockContext();

    const fetchChildren = vi.fn().mockResolvedValue(childItems);
    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, undefined, fetchChildren);
    const widget = getWidget()!;

    // Initial render should show root items
    let lines = widget.render(80);
    expect(lines.join('\n')).toContain('Parent item');
    expect(lines.join('\n')).toContain('Standalone item');

    // Press Enter on parent item (index 0, has 2 children)
    widget.handleInput!('\r');

    // After Enter, children should be fetched and rendered
    await vi.advanceTimersByTimeAsync(10); // Let the promise resolve

    lines = widget.render(80);
    const rendered = lines.join('\n');

    // Should contain the ".." entry
    expect(rendered).toContain('..');
    // Should contain child items
    expect(rendered).toContain('First child');
    expect(rendered).toContain('Second child');
    // Should NOT contain parent root items anymore
    expect(rendered).not.toContain('Parent item');
    expect(rendered).not.toContain('Standalone item');
  });

  it('navigates back to parent level when Enter is pressed on ".." entry', async () => {
    const { ctx, getWidget, getDone } = createMockContext();

    const fetchChildren = vi.fn().mockResolvedValue(childItems);
    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, undefined, fetchChildren);
    const widget = getWidget()!;

    // Navigate into parent's children
    widget.handleInput!('\r');
    await vi.advanceTimersByTimeAsync(10);

    // Now we should be viewing children. Press Enter on ".." (index 0)
    widget.handleInput!('\r');

    // Should be back at root level with root items
    const lines = widget.render(80);
    const rendered = lines.join('\n');
    expect(rendered).toContain('Parent item');
    expect(rendered).toContain('Standalone item');
    expect(rendered).not.toContain('First child');
  });

  it('navigates back to parent level when Escape is pressed (while viewing children)', async () => {
    const { ctx, getWidget, getDone } = createMockContext();

    const fetchChildren = vi.fn().mockResolvedValue(childItems);
    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, undefined, fetchChildren);
    const widget = getWidget()!;

    // Navigate into children
    widget.handleInput!('\r');
    await vi.advanceTimersByTimeAsync(10);

    // Verify we're in children view
    let lines = widget.render(80);
    expect(lines.join('\n')).toContain('First child');

    // Press Escape to go back
    widget.handleInput!('\u001b');

    // Should be back at root
    lines = widget.render(80);
    const rendered = lines.join('\n');
    expect(rendered).toContain('Parent item');
    expect(rendered).toContain('Standalone item');
    expect(rendered).not.toContain('First child');
  });

  it('closes the overlay when Escape is pressed at root level', () => {
    const { ctx, getWidget, getDone } = createMockContext();

    defaultChooseWorkItem(rootItems, ctx, vi.fn());
    const widget = getWidget()!;
    const done = getDone()!;

    // Press Escape at root level (navigation stack empty)
    widget.handleInput!('\u001b');

    expect(done).toHaveBeenCalledWith(null);
  });

  it('supports arbitrary depth navigation (children of children)', async () => {
    const { ctx, getWidget, getDone } = createMockContext();

    // First level: children have child items
    const deepChildItems: WorklogBrowseItem[] = [
      { id: 'WL-003', title: 'First child', status: 'open', childCount: 1 },
      { id: 'WL-004', title: 'Second child', status: 'open' },
    ];

    const fetchChildren = vi.fn((id: string) => {
      if (id === 'WL-001') return Promise.resolve(deepChildItems);
      if (id === 'WL-003') return Promise.resolve(grandchildItems);
      return Promise.resolve([]);
    });

    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, undefined, fetchChildren);
    const widget = getWidget()!;

    // Navigate into WL-001's children
    widget.handleInput!('\r');
    await vi.advanceTimersByTimeAsync(10);

    // Navigate down to "First child" (WL-003, has childCount=1)
    widget.handleInput!('\u001b[B'); // move to child item (index 1, after "..")
    widget.handleInput!('\r'); // Enter on First child
    await vi.advanceTimersByTimeAsync(10);

    // Should now be viewing grandchildren
    let lines = widget.render(80);
    expect(lines.join('\n')).toContain('Grandchild');

    // Press Escape to go back
    widget.handleInput!('\u001b');
    lines = widget.render(80);
    expect(lines.join('\n')).toContain('First child');
    expect(lines.join('\n')).toContain('Second child');

    // Press Escape again to go to root
    widget.handleInput!('\u001b');
    lines = widget.render(80);
    expect(lines.join('\n')).toContain('Parent item');
    expect(lines.join('\n')).toContain('Standalone item');
  });

  it('restores selection position when navigating back', async () => {
    const { ctx, getWidget, getDone } = createMockContext();

    const fetchChildren = vi.fn().mockResolvedValue(childItems);
    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, undefined, fetchChildren);
    const widget = getWidget()!;

    // Navigate down to "Standalone item" (index 1) — verification step
    widget.handleInput!('\u001b[B');
    let lines = widget.render(80);
    expect(getSelectionMarker(lines, 'Standalone item')).toContain('›');

    // Navigate UP back to parent (index 0) and press Enter to see children
    widget.handleInput!('\u001b[A');
    widget.handleInput!('\r');
    await vi.advanceTimersByTimeAsync(10);

    // Verify we're viewing children now
    let childLines = widget.render(80);
    expect(childLines.join('\n')).toContain('First child');

    // Navigate back via Escape
    widget.handleInput!('\u001b');
    lines = widget.render(80);

    // Should be back at root level showing root items
    const rendered = lines.join('\n');
    expect(rendered).toContain('Parent item');
    expect(rendered).toContain('Standalone item');
    expect(rendered).not.toContain('First child');

    // Selection should be restored to the item that was selected when Enter
    // was pressed to navigate into children — that is "Parent item" (index 0)
    expect(getSelectionMarker(lines, 'Parent item')).toContain('›');
  });

  it('treats items without childCount as not having children', () => {
    const { ctx, getWidget, getDone } = createMockContext();

    const items = [
      { id: 'WL-001', title: 'No childCount field', status: 'open' },
      { id: 'WL-002', title: 'Second', status: 'open' },
    ];

    const fetchChildren = vi.fn();
    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, fetchChildren);
    const widget = getWidget()!;
    const done = getDone()!;

    // Press Enter on first item (no childCount defined)
    widget.handleInput!('\r');

    // Should call done (no children to navigate to)
    expect(done).toHaveBeenCalledWith(items[0]);
    expect(fetchChildren).not.toHaveBeenCalled();
  });

  it('does not render ".." entry at root level', () => {
    const { ctx, getWidget } = createMockContext();

    defaultChooseWorkItem(rootItems, ctx, vi.fn());
    const widget = getWidget()!;

    const lines = widget.render(80);
    const rendered = lines.join('\n');
    // The ".." should not appear at root level
    expect(rendered).not.toContain('..');
  });

  it('preserves shortcut dispatch when viewing children', async () => {
    // Import ShortcutRegistry for testing
    const { ShortcutRegistry } = await import('../extensions/shortcut-config.js');
    const entries = [
      { key: 'i', command: '/implement <id>', view: 'list' },
    ];
    const registry = new ShortcutRegistry(entries);

    const { ctx, getWidget, getDone } = createMockContext();

    const fetchChildren = vi.fn().mockResolvedValue(childItems);
    defaultChooseWorkItem(rootItems, ctx, vi.fn(), registry, undefined, fetchChildren);
    const widget = getWidget()!;
    const done = getDone()!;

    // Navigate into children
    widget.handleInput!('\r');
    await vi.advanceTimersByTimeAsync(10);

    // Press shortcut key 'i' while viewing children
    widget.handleInput!('i');

    // Should dispatch the shortcut with the correct child item ID
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'shortcut' as const })
    );
  });

  it('handles fetchChildren errors gracefully without crashing', async () => {
    const { ctx, getWidget, getDone } = createMockContext();

    const fetchChildren = vi.fn().mockRejectedValue(new Error('Fetch failed'));
    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, undefined, fetchChildren);
    const widget = getWidget()!;

    // Press Enter on parent item
    widget.handleInput!('\r');
    await vi.advanceTimersByTimeAsync(10);

    // Should not crash - should remain at root level
    const lines = widget.render(80);
    const rendered = lines.join('\n');
    expect(rendered).toContain('Parent item');
    expect(rendered).toContain('Standalone item');
  });

  it('uses childCount of synthetic ".." entry as undefined (not a real work item)', async () => {
    const { ctx, getWidget } = createMockContext();

    const fetchChildren = vi.fn().mockResolvedValue(childItems);
    defaultChooseWorkItem(rootItems, ctx, vi.fn(), undefined, undefined, fetchChildren);
    const widget = getWidget()!;

    // Navigate into children
    widget.handleInput!('\r');
    await vi.advanceTimersByTimeAsync(10);

    const lines = widget.render(80);
    const rendered = lines.join('\n');
    // Should have ".." at the top (before "First child")
    const parentIdx = rendered.indexOf('..');
    const firstChildIdx = rendered.indexOf('First child');
    expect(parentIdx).toBeGreaterThanOrEqual(0);
    expect(firstChildIdx).toBeGreaterThan(parentIdx);
  });
});
