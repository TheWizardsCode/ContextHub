/**
 * Tests for shortcut keys display in browse list help text.
 *
 * Verifies that available shortcuts are dynamically shown in the help line
 * based on the ShortcutRegistry, and that the help text remains unchanged
 * when no registry or an empty registry is provided.
 *
 * Run: npx vitest run packages/tui/tests/browse-shortcut-help.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShortcutRegistry, type ShortcutEntry } from '../extensions/shortcut-config.js';
import { defaultChooseWorkItem, type WorklogBrowseItem } from '../extensions/index.js';

describe('Browse list help text with shortcuts', () => {
  let registry: ShortcutRegistry;
  let items: WorklogBrowseItem[];

  beforeEach(() => {
    const entries: ShortcutEntry[] = [
      { key: 'i', command: '/skill:implement <id>', view: 'both' },
      { key: 'p', command: '/plan <id>', view: 'list' },
      { key: 'n', command: '/intake <id>', view: 'both' },
      { key: 'a', command: '/skill:audit <id>', view: 'detail' },
    ];
    registry = new ShortcutRegistry(entries);
    items = [
      { id: 'WL-001', title: 'Test item', status: 'open' },
    ];
  });

  /**
   * Create a mock BrowseContext that captures the rendered output from the
   * browse widget factory. Returns both the context and a helper to get the
   * captured help line text.
   */
  function createMockContext(): { ctx: { ui: any }; getHelpLine: () => string | null } {
    let capturedHelpLine: string | null = null;

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

        const widget = factory(tui, theme, undefined, done);

        // Capture the last line of the rendered output (help line)
        const lines = widget.render(80);
        capturedHelpLine = lines[lines.length - 1] ?? null;

        // Return a never-resolving promise since we're not testing interactivity
        return new Promise<T>(() => { /* never resolves - testing render output only */ });
      }),
      notify: vi.fn(),
      setEditorText: vi.fn(),
      setWidget: vi.fn(),
    };

    return {
      ctx: { ui: mockUi },
      getHelpLine: () => capturedHelpLine,
    };
  }

  it('displays shortcut hints in help text when registry has list/both entries', async () => {
    const { ctx, getHelpLine } = createMockContext();

    // Invoke defaultChooseWorkItem - the mock custom() calls render synchronously
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);

    // Allow microtasks to flush
    await new Promise(process.nextTick);

    const helpLine = getHelpLine();
    expect(helpLine).not.toBeNull();
    expect(helpLine!).toContain('↑↓ navigate');
    expect(helpLine!).toContain('enter select');
    expect(helpLine!).toContain('esc cancel');
    // Should include hints for 'both' and 'list' view entries
    expect(helpLine!).toContain('i:implement');
    expect(helpLine!).toContain('p:plan');
    expect(helpLine!).toContain('n:intake');
    // Should NOT include 'detail' only entries
    expect(helpLine!).not.toContain('a:audit');
  });

  it('uses correct help text format with bullet separators', async () => {
    const { ctx, getHelpLine } = createMockContext();
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const helpLine = getHelpLine();
    expect(helpLine!).toMatch(/↑↓ navigate • enter select • esc cancel • /);
    expect(helpLine!).toMatch(/i:implement p:plan n:intake/);
  });

  it('omits shortcut hints when no registry is provided', async () => {
    const { ctx, getHelpLine } = createMockContext();
    defaultChooseWorkItem(items, ctx, vi.fn(), undefined);
    await new Promise(process.nextTick);

    const helpLine = getHelpLine();
    expect(helpLine!).toContain('↑↓ navigate • enter select • esc cancel');
    expect(helpLine!).not.toMatch(/ • [a-z]+:/);
  });

  it('omits shortcut hints when registry has no list/both entries', async () => {
    const detailOnly = new ShortcutRegistry([
      { key: 'x', command: 'detail-only <id>', view: 'detail' },
    ]);
    const { ctx, getHelpLine } = createMockContext();
    defaultChooseWorkItem(items, ctx, vi.fn(), detailOnly);
    await new Promise(process.nextTick);

    const helpLine = getHelpLine();
    expect(helpLine!).toContain('↑↓ navigate • enter select • esc cancel');
    expect(helpLine!).not.toMatch(/ • [a-z]+:/);
  });

  it('omits shortcut hints when registry has no entries', async () => {
    const empty = new ShortcutRegistry([]);
    const { ctx, getHelpLine } = createMockContext();
    defaultChooseWorkItem(items, ctx, vi.fn(), empty);
    await new Promise(process.nextTick);

    const helpLine = getHelpLine();
    expect(helpLine!).toContain('↑↓ navigate • enter select • esc cancel');
    expect(helpLine!).not.toMatch(/ • [a-z]+:/);
  });

  it('extracts clean labels from various command formats', async () => {
    const variedCommands = new ShortcutRegistry([
      { key: 'i', command: '/skill:implement <id>', view: 'both' },
      { key: 'c', command: '/intake\n<desc>\nPriority: medium', view: 'list' },
      { key: 'p', command: '/plan <id>', view: 'both' },
    ]);
    const { ctx, getHelpLine } = createMockContext();
    defaultChooseWorkItem(items, ctx, vi.fn(), variedCommands);
    await new Promise(process.nextTick);

    const helpLine = getHelpLine();
    expect(helpLine!).toContain('i:implement');
    expect(helpLine!).toContain('c:intake');
    expect(helpLine!).toContain('p:plan');
    // Should NOT contain raw command parts
    expect(helpLine!).not.toContain('/skill:');
    expect(helpLine!).not.toContain('<id>');
    expect(helpLine!).not.toContain('<desc>');
  });

  it('renders help as the last line in the output', async () => {
    const { ctx, getHelpLine } = createMockContext();
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const helpLine = getHelpLine();
    // Verify it's the help line (contains navigation text)
    expect(helpLine!).toContain('↑↓ navigate');
    expect(helpLine!).toContain('i:implement');
  });
});
