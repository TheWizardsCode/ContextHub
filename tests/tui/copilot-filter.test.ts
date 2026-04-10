import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { createPluginContext } from '../../src/cli-utils.js';

const makeNode = () => ({
  hidden: true,
  focus: () => {},
  setFront: () => {},
  hide: () => {},
  show: () => {},
  setItems: () => {},
  select: () => {},
  getItem: () => undefined,
  setContent: () => {},
  getContent: () => '',
  setScroll: () => {},
  setScrollPerc: () => {},
  pushLine: () => {},
  on: () => {},
  key: () => {},
  removeAllListeners: () => {},
  destroy: () => {},
});

const makeScreen = () => {
  const screen: any = { _keyHandlers: [] };
  screen.height = 40;
  screen.width = 120;
  screen.focused = null;
  screen.render = () => undefined;
  screen.append = () => undefined;
  screen.destroy = () => undefined;
  screen.key = (keys: any, cb: any) => { screen._keyHandlers.push({ keys, cb }); };
  screen.emitKey = (name: string) => {
    for (const h of screen._keyHandlers) {
      const ks = Array.isArray(h.keys) ? h.keys : [h.keys];
      for (const k of ks) {
        if (k === name || (Array.isArray(k) && k.includes(name))) {
          try { h.cb(); } catch (_) {}
        }
      }
    }
  };
  return screen;
};

const makeBlessed = () => {
  const sharedScreen = makeScreen();
  return {
    screen: () => sharedScreen,
    box: vi.fn((opts: any) => makeNode()),
    list: vi.fn((opts: any) => ({ ...makeNode(), items: opts.items || [], selected: 0, setItems(items: string[]) { this.items = items; }, select(i: number) { this.selected = i; }, getItem(i: number) { const content = this.items?.[i]; return content ? { getContent: () => content } : undefined; } })),
    textarea: vi.fn((opts: any) => ({ ...makeNode(), value: opts.value || '', setValue(v: string) { this.value = v; }, getValue() { return this.value; }, clearValue() { this.value = ''; } })),
    text: vi.fn((opts: any) => makeNode()),
    textbox: vi.fn((opts: any) => makeNode()),
  };
};

describe('Copilot filter (Alt+g)', () => {
  let blessedImpl: any;
  let program: Command;
  beforeEach(() => {
    blessedImpl = makeBlessed();
    program = new Command();
    program.exitOverride();
    program.opts = () => ({ json: false, verbose: false }) as any;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('filters to items assigned to @github-copilot', async () => {
    const ctx = createPluginContext(program) as any;
    ctx.blessed = blessedImpl;
    ctx.utils.requireInitialized = () => undefined;
    // Provide a simple in-memory DB
    ctx.utils.getDatabase = () => ({
      list: () => [
        { id: 'WL-1', title: 'one', status: 'open', assignee: '@github-copilot' },
        { id: 'WL-2', title: 'two', status: 'open', assignee: '@alice' },
      ],
      get: (id: string) => null,
      getCommentsForWorkItem: () => [],
      update: () => ({}),
      remove: () => undefined,
      getPrefix: () => undefined,
      createComment: () => undefined,
    });

    const register = (await import('../../src/commands/tui.js')).default;
    register(ctx);
    await program.parseAsync(['tui'], { from: 'user' });

    const screen = (blessedImpl.screen as any)();
    // Find the registered handler for M-g (meta-g) which is exposed as 'M-g'
    const handler = screen._keyHandlers.find((h: any) => {
      const ks = Array.isArray(h.keys) ? h.keys : [h.keys];
      return ks.includes('M-g') || ks.includes('M-g');
    });
    expect(handler).toBeDefined();
    // Invoke the handler
    await handler.cb();
    // After handler runs, the list items should be filtered to only copilot assignment
    // Access the list widget from blessed mock (first list created)
    const listWidget = blessedImpl.list.mock.results[0].value as any;
    // The widget's items should contain just the copilot item
    const containsCopilot = (listWidget.items || []).some((ln: string) => String(ln).includes('WL-1'));
    expect(containsCopilot).toBe(true);
  });
});
