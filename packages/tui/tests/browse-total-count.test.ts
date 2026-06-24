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
 * Tests for the total item count display in the browse selection list title.
 *
 * Verifies that:
 * - The title shows "top X of Y" when a totalCount is provided
 * - The title falls back to "top X" (without "of Y") when totalCount is undefined
 * - Both the ctx.ui.select() fallback path and custom overlay render() path
 *   display the total count correctly
 * - Graceful degradation when totalCount is 0
 *
 * Run: npx vitest run packages/tui/tests/browse-total-count.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defaultChooseWorkItem, type WorklogBrowseItem } from '../extensions/Worklog/index.js';
import { ShortcutRegistry } from '../extensions/shortcut-config.js';

describe('Browse list total count in title', () => {
  let items: WorklogBrowseItem[];

  beforeEach(() => {
    items = [
      { id: 'WL-001', title: 'First item', status: 'open' },
      { id: 'WL-002', title: 'Second item', status: 'in_progress' },
    ];
  });

  /**
   * Create a mock BrowseContext that captures the rendered output from the
   * custom overlay render path. Returns helpers to inspect the title line.
   */
  function createMockCustomContext(): { ctx: { ui: any }; getTitle: () => string | null } {
    let capturedTitle: string | null = null;

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
        const theme = {
          fg: vi.fn((_color: string, text: string) => text),
          bold: vi.fn((text: string) => text),
        };
        const done = vi.fn();
        const tui = { requestRender: vi.fn() };

        const widget = factory(tui, theme, undefined, done);

        // Capture the title (first rendered line)
        const lines = widget.render(80);
        capturedTitle = lines[0] ?? null;

        // Return a never-resolving promise since we're not testing interactivity
        return new Promise<T>(() => { /* never resolves - testing render output only */ });
      }),
      notify: vi.fn(),
      setEditorText: vi.fn(),
      setWidget: vi.fn(),
      select: vi.fn(),
    };

    return {
      ctx: { ui: mockUi },
      getTitle: () => capturedTitle,
    };
  }

  /**
   * Create a mock BrowseContext for the select() fallback path.
   * Does NOT provide a custom() function, so defaultChooseWorkItem uses
   * ctx.ui.select() instead.
   */
  function createMockSelectContext(): { ctx: { ui: any }; getSelectTitle: () => string | null } {
    let capturedSelectTitle: string | null = null;

    const mockUi = {
      select: vi.fn((title: string) => {
        capturedSelectTitle = title;
        // Return a promise that never resolves to match expected behavior
        return new Promise<string | undefined>((resolve) => {
          // Store the title but don't resolve (simulates the user hasn't selected yet)
          // We'll return undefined immediately to unblock the test
          setTimeout(() => resolve(undefined), 0);
        });
      }),
      custom: undefined,
      notify: vi.fn(),
      setEditorText: vi.fn(),
      setWidget: vi.fn(),
    };

    return {
      ctx: { ui: mockUi },
      getSelectTitle: () => capturedSelectTitle,
    };
  }

  // ── Custom overlay render path (Pi TUI) tests ────────────────────

  it('shows "top X of Y" in the custom overlay title when totalCount is provided', async () => {
    const { ctx, getTitle } = createMockCustomContext();

    // Provide a total count of 42 actionable items
    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, 42);
    await new Promise(process.nextTick);

    const title = getTitle();
    expect(title).not.toBeNull();
    expect(title).toContain('Browse Worklog next items (top 5 of 42)');
  });

  it('shows "top X" (without "of Y") in the custom overlay title when totalCount is undefined', async () => {
    const { ctx, getTitle } = createMockCustomContext();

    // No totalCount provided — should fall back to "top X"
    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, undefined);
    await new Promise(process.nextTick);

    const title = getTitle();
    expect(title).not.toBeNull();
    expect(title).toContain('Browse Worklog next items (top 5)');
    expect(title).not.toContain('of');
  });

  it('shows "top X of 0" in the custom overlay title when totalCount is 0', async () => {
    const { ctx, getTitle } = createMockCustomContext();

    // Edge case: total count is 0
    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, 0);
    await new Promise(process.nextTick);

    const title = getTitle();
    expect(title).not.toBeNull();
    expect(title).toContain('Browse Worklog next items (top 5 of 0)');
  });

  it('handles large totalCount values in the custom overlay title', async () => {
    const { ctx, getTitle } = createMockCustomContext();

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, 9999);
    await new Promise(process.nextTick);

    const title = getTitle();
    expect(title).not.toBeNull();
    expect(title).toContain('Browse Worklog next items (top 5 of 9999)');
  });

  // ── select() fallback path (non-TUI) tests ───────────────────────

  it('shows "top X of Y" in the select() fallback title when totalCount is provided', async () => {
    const { ctx, getSelectTitle } = createMockSelectContext();

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, 42);
    // The select() call is made synchronously inside defaultChooseWorkItem
    await new Promise(process.nextTick);

    const title = getSelectTitle();
    expect(title).not.toBeNull();
    expect(title).toContain('Browse Worklog next items (top 5 of 42)');
  });

  it('shows "top X" (without "of Y") in the select() fallback title when totalCount is undefined', async () => {
    const { ctx, getSelectTitle } = createMockSelectContext();

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, undefined);
    await new Promise(process.nextTick);

    const title = getSelectTitle();
    expect(title).not.toBeNull();
    expect(title).toContain('Browse Worklog next items (top 5)');
    expect(title).not.toContain('of');
  });

  it('shows "top X of 0" in the select() fallback title when totalCount is 0', async () => {
    const { ctx, getSelectTitle } = createMockSelectContext();

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, 0);
    await new Promise(process.nextTick);

    const title = getSelectTitle();
    expect(title).not.toBeNull();
    expect(title).toContain('Browse Worklog next items (top 5 of 0)');
  });

  // ── Regression: existing tests still pass ────────────────────────

  it('still renders items correctly in custom overlay when totalCount is provided', async () => {
    const { ctx } = createMockCustomContext();

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, 42);
    await new Promise(process.nextTick);

    // The widget was created without errors — that's the regression check
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it('still renders items correctly in custom overlay when totalCount is undefined', async () => {
    const { ctx } = createMockCustomContext();

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, undefined);
    await new Promise(process.nextTick);

    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
  });

  it('select() fallback still works when totalCount is provided', async () => {
    const { ctx } = createMockSelectContext();

    defaultChooseWorkItem(items, ctx, vi.fn(), undefined, undefined, undefined, 42);
    await new Promise(process.nextTick);

    // Should have called select() with the title and never thrown
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
  });
});
