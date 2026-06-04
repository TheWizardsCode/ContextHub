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
  return screen;
};

const makeBlessed = () => {
  const sharedScreen = makeScreen();
  return {
    screen: () => sharedScreen,
    box: vi.fn((opts: any) => makeNode()),
    list: vi.fn((opts: any) => ({
      ...makeNode(),
      items: opts.items || [],
      selected: 0,
      setItems(items: string[]) { this.items = items; },
      select(i: number) { this.selected = i; },
      getItem(i: number) {
        const content = this.items?.[i];
        return content ? { getContent: () => content } : undefined;
      },
    })),
    textarea: vi.fn((opts: any) => ({
      ...makeNode(),
      value: opts.value || '',
      setValue(v: string) { this.value = v; },
      getValue() { return this.value; },
      clearValue() { this.value = ''; },
    })),
    text: vi.fn((opts: any) => makeNode()),
    textbox: vi.fn((opts: any) => makeNode()),
  };
};

const getHandler = (screen: any, keyName: string) => {
  return screen._keyHandlers.find((h: any) => {
    const ks = Array.isArray(h.keys) ? h.keys : [h.keys];
    return ks.includes(keyName);
  });
};

const getVisibleIds = (listWidget: any) => {
  const lines: string[] = listWidget.items || [];
  return lines
    .map((line) => {
      const match = String(line).match(/WL-[A-Z0-9-]+/);
      return match?.[0];
    })
    .filter((value): value is string => Boolean(value));
};

describe('TUI stage filter shortcuts', () => {
  let blessedImpl: any;
  let program: Command;

  beforeEach(() => {
    blessedImpl = makeBlessed();
    program = new Command();
    program.exitOverride();
    program.opts = () => ({ json: false, verbose: false }) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Alt+T filters to non-closed intake_complete items', async () => {
    const ctx = createPluginContext(program) as any;
    ctx.blessed = blessedImpl;
    ctx.utils.requireInitialized = () => undefined;
    ctx.utils.getDatabase = () => ({
      list: () => [
        { id: 'WL-OPEN-INTAKE', title: 'open intake', status: 'open', stage: 'intake_complete' },
        { id: 'WL-BLOCKED-INTAKE', title: 'blocked intake', status: 'blocked', stage: 'intake_complete' },
        { id: 'WL-COMPLETED-INTAKE', title: 'completed intake', status: 'completed', stage: 'intake_complete' },
        { id: 'WL-DELETED-INTAKE', title: 'deleted intake', status: 'deleted', stage: 'intake_complete' },
        { id: 'WL-OPEN-PLAN', title: 'open plan', status: 'open', stage: 'plan_complete' },
      ],
      get: () => null,
      getCommentsForWorkItem: () => [], getAuditResult: () => null,
      update: () => ({}),
      remove: () => undefined,
      getPrefix: () => undefined,
      createComment: () => undefined,
    });

    const register = (await import('../../src/commands/tui.js')).default;
    register(ctx);
    await program.parseAsync(['tui'], { from: 'user' });

    const screen = blessedImpl.screen();
    const handler = getHandler(screen, 'M-t');
    expect(handler).toBeDefined();

    await handler.cb();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const listWidget = blessedImpl.list.mock.results[0].value as any;
    const ids = getVisibleIds(listWidget);
    expect(ids).toContain('WL-OPEN-INTAKE');
    expect(ids).toContain('WL-BLOCKED-INTAKE');
    expect(ids).not.toContain('WL-COMPLETED-INTAKE');
    expect(ids).not.toContain('WL-DELETED-INTAKE');
    expect(ids).not.toContain('WL-OPEN-PLAN');
  });

  it('Alt+P filters to non-closed plan_complete items', async () => {
    const ctx = createPluginContext(program) as any;
    ctx.blessed = blessedImpl;
    ctx.utils.requireInitialized = () => undefined;
    ctx.utils.getDatabase = () => ({
      list: () => [
        { id: 'WL-OPEN-INTAKE', title: 'open intake', status: 'open', stage: 'intake_complete' },
        { id: 'WL-INPROGRESS-PLAN', title: 'in progress plan', status: 'in-progress', stage: 'plan_complete' },
        { id: 'WL-BLOCKED-PLAN', title: 'blocked plan', status: 'blocked', stage: 'plan_complete' },
        { id: 'WL-COMPLETED-PLAN', title: 'completed plan', status: 'completed', stage: 'plan_complete' },
      ],
      get: () => null,
      getCommentsForWorkItem: () => [], getAuditResult: () => null,
      update: () => ({}),
      remove: () => undefined,
      getPrefix: () => undefined,
      createComment: () => undefined,
    });

    const register = (await import('../../src/commands/tui.js')).default;
    register(ctx);
    await program.parseAsync(['tui'], { from: 'user' });

    const screen = blessedImpl.screen();
    const handler = getHandler(screen, 'M-p');
    expect(handler).toBeDefined();

    await handler.cb();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const listWidget = blessedImpl.list.mock.results[0].value as any;
    const ids = getVisibleIds(listWidget);
    expect(ids).toContain('WL-INPROGRESS-PLAN');
    expect(ids).toContain('WL-BLOCKED-PLAN');
    expect(ids).not.toContain('WL-COMPLETED-PLAN');
    expect(ids).not.toContain('WL-OPEN-INTAKE');
  });
});
