/**
 * Integration tests for TUI focus cycling with Ctrl-W chord sequences.
 * Validates that focus moves between panes correctly and that key events
 * do not leak to widget-level handlers after chord consumption.
 *
 * Related work item: WL-0MLR6RTM11N96HX5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';

// ── Blessed mock helpers ──────────────────────────────────────────────

const makeBox = () => ({
  hidden: true,
  width: 0,
  height: 0,
  style: { border: {} as Record<string, any>, label: {} as Record<string, any>, selected: {} },
  show: vi.fn(function () { (this as any).hidden = false; }),
  hide: vi.fn(function () { (this as any).hidden = true; }),
  focus: vi.fn(),
  setFront: vi.fn(),
  setContent: vi.fn(),
  getContent: vi.fn(() => ''),
  setLabel: vi.fn(),
  setItems: vi.fn(),
  select: vi.fn(),
  getItem: vi.fn(() => undefined),
  on: vi.fn(),
  key: vi.fn(),
  setScroll: vi.fn(),
  setScrollPerc: vi.fn(),
  getScroll: vi.fn(() => 0),
  pushLine: vi.fn(),
  clearValue: vi.fn(),
  setValue: vi.fn(),
  getValue: vi.fn(() => ''),
  moveCursor: vi.fn(),
});

const makeList = () => {
  const list = makeBox() as any;
  let selected = 0;
  let items: string[] = [];
  list.setItems = vi.fn((next: string[]) => {
    items = next.slice();
    list.items = items.map(value => ({ getContent: () => value }));
  });
  list.select = vi.fn((idx: number) => { selected = idx; });
  Object.defineProperty(list, 'selected', {
    get: () => selected,
    set: (value: number) => { selected = value; },
  });
  list.getItem = vi.fn((idx: number) => {
    const value = items[idx];
    return value ? { getContent: () => value } : undefined;
  });
  list.items = [] as any[];
  return list;
};

const makeScreen = () => ({
  height: 40,
  width: 120,
  focused: null as any,
  render: vi.fn(),
  destroy: vi.fn(),
  key: vi.fn(),
  on: vi.fn(),
});

// ── Factory for test items ────────────────────────────────────────────

function makeItem(id: string, parentId: string | null = null) {
  const now = new Date().toISOString();
  return {
    id,
    title: `Item ${id}`,
    description: '',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId,
    createdAt: now,
    updatedAt: now,
    tags: [],
    assignee: '',
    stage: '',
    issueType: 'task',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildLayout(screen: any) {
  const list = makeList();
  const footer = makeBox();
  const detail = makeBox();
  const copyIdButton = makeBox();
  const overlays = {
    detailOverlay: makeBox(),
    closeOverlay: makeBox(),
    updateOverlay: makeBox(),
  };
  const dialogs = {
    detailModal: makeBox(),
    detailClose: makeBox(),
    closeDialog: makeBox(),
    closeDialogText: makeBox(),
    closeDialogOptions: makeList(),
    updateDialog: makeBox(),
    updateDialogText: makeBox(),
    updateDialogOptions: makeList(),
    updateDialogStageOptions: makeList(),
    updateDialogStatusOptions: makeList(),
    updateDialogPriorityOptions: makeList(),
    updateDialogComment: makeBox(),
  };
  const helpMenu = {
    isVisible: vi.fn(() => false),
    show: vi.fn(),
    hide: vi.fn(),
  };
  const modalDialogs = {
    selectList: vi.fn(async () => 0),
    editTextarea: vi.fn(async () => null),
    confirmTextbox: vi.fn(async () => false),
    forceCleanup: vi.fn(),
  };
  const opencodeUi = {
    serverStatusBox: makeBox(),
    dialog: makeBox(),
    textarea: makeBox(),
    suggestionHint: makeBox(),
    sendButton: makeBox(),
    cancelButton: makeBox(),
    ensureResponsePane: vi.fn(() => makeBox()),
  };

  return {
    screen,
    list,
    detail,
    opencodeDialog: opencodeUi.dialog,
    opencodeText: opencodeUi.textarea,
    layout: {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: { show: vi.fn() } as any,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      opencodeUi,
      nextDialog: {
        overlay: makeBox(),
        dialog: makeBox(),
        close: makeBox(),
        text: makeBox(),
        options: makeList(),
      },
    },
  };
}

function buildCtx(items: any[]) {
  return {
    program: { opts: () => ({ verbose: false }) },
    utils: {
      requireInitialized: vi.fn(),
      getDatabase: vi.fn(() => ({
        list: () => items,
        getPrefix: () => 'test-prefix',
        getCommentsForWorkItem: () => [],
        update: () => ({}),
        createComment: () => ({}),
        get: (id: string) => items.find(i => i.id === id) ?? null,
      })),
    },
  } as any;
}

class FakeOpencodeClient {
  getStatus() { return { status: 'stopped', port: 9999 }; }
  startServer() { return Promise.resolve(true); }
  stopServer() { return undefined; }
  sendPrompt() { return Promise.resolve(); }
}

/**
 * Extracts registered key handlers from a mock's call history.
 *
 * screen.key(keys, handler) is captured by vi.fn().
 * screen.on('keypress', handler) is captured similarly.
 */
function getKeyHandler(mockFn: ReturnType<typeof vi.fn>, keyOrEvent: string | string[]): ((...args: any[]) => any) | null {
  const calls = mockFn.mock.calls;
  for (const call of calls) {
    const registeredKeys = call[0];
    const handler = call[1];
    if (typeof registeredKeys === 'string') {
      if (registeredKeys === keyOrEvent) return handler;
    }
    if (Array.isArray(registeredKeys) && Array.isArray(keyOrEvent)) {
      // Check if the registered keys include any of the requested keys
      if (keyOrEvent.some(k => registeredKeys.includes(k))) return handler;
    }
    if (Array.isArray(registeredKeys) && typeof keyOrEvent === 'string') {
      if (registeredKeys.includes(keyOrEvent)) return handler;
    }
  }
  return null;
}

function getEventHandler(mockFn: ReturnType<typeof vi.fn>, event: string): ((...args: any[]) => any) | null {
  const calls = mockFn.mock.calls;
  for (const call of calls) {
    if (call[0] === event) return call[1];
  }
  return null;
}

/**
 * Simulates a Ctrl-W chord sequence by invoking both the raw keypress
 * handler and the screen.key wrapper, matching how blessed dispatches events.
 */
function simulateCtrlWChord(
  screen: any,
  followupKey: string,
) {
  const keypressHandler = getEventHandler(screen.on, 'keypress');
  const ctrlWKeyHandler = getKeyHandler(screen.key, ['C-w']);
  const followupKeyHandler = getKeyHandler(screen.key, ['h', 'j', 'k', 'l', 'w', 'p']);

  // Step 1: send Ctrl-W leader key
  const ctrlWKey = { name: 'w', ctrl: true };
  if (keypressHandler) keypressHandler('', ctrlWKey);
  if (ctrlWKeyHandler) ctrlWKeyHandler('', ctrlWKey);

  // Step 2: send the follow-up key
  const followKey = { name: followupKey };
  if (keypressHandler) keypressHandler(followupKey, followKey);
  if (followupKeyHandler) followupKeyHandler(followupKey, followKey);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('TUI focus cycling integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers Ctrl-W chord handlers on startup', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout } = buildLayout(screen);
    const ctx = buildCtx([root]);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // Check that screen.key was called with C-w prefix
    const keyCalls = (screen.key as ReturnType<typeof vi.fn>).mock.calls;
    const hasCtrlW = keyCalls.some((call: any[]) => {
      const keys = Array.isArray(call[0]) ? call[0] : [call[0]];
      return keys.includes('C-w');
    });
    expect(hasCtrlW).toBe(true);

    // Check that screen.on was called with 'keypress'
    const onCalls = (screen.on as ReturnType<typeof vi.fn>).mock.calls;
    const hasKeypress = onCalls.some((call: any[]) => call[0] === 'keypress');
    expect(hasKeypress).toBe(true);
  });

  it('sets focus styles on the list pane at startup', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout, list } = buildLayout(screen);
    const ctx = buildCtx([root]);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // List should have green border (focused)
    expect(list.style.border.fg).toBe('green');
  });

  it('Ctrl-W w cycles focus forward', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout, list, detail } = buildLayout(screen);
    const ctx = buildCtx([root]);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // Initial focus should be on list
    expect(list.style.border.fg).toBe('green');

    // Simulate Ctrl-W w to cycle focus
    simulateCtrlWChord(screen, 'w');

    // Detail should now be focused (green border)
    expect(detail.style.border.fg).toBe('green');
    // List should be unfocused (white border)
    expect(list.style.border.fg).toBe('white');
  });

  it('Ctrl-W h moves focus left', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout, list, detail } = buildLayout(screen);
    const ctx = buildCtx([root]);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // First cycle to detail (Ctrl-W w)
    simulateCtrlWChord(screen, 'w');
    expect(detail.style.border.fg).toBe('green');

    // Now Ctrl-W h should move back to list
    simulateCtrlWChord(screen, 'h');
    expect(list.style.border.fg).toBe('green');
    expect(detail.style.border.fg).toBe('white');
  });

  it('Ctrl-W l moves focus right', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout, list, detail } = buildLayout(screen);
    const ctx = buildCtx([root]);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // List is focused initially; Ctrl-W l should move to detail
    simulateCtrlWChord(screen, 'l');
    expect(detail.style.border.fg).toBe('green');
    expect(list.style.border.fg).toBe('white');
  });

  it('Ctrl-W p returns to previous pane', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout, list, detail } = buildLayout(screen);
    const ctx = buildCtx([root]);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // Move to detail
    simulateCtrlWChord(screen, 'w');
    expect(detail.style.border.fg).toBe('green');

    // Ctrl-W p should go back to list (previous pane)
    simulateCtrlWChord(screen, 'p');
    expect(list.style.border.fg).toBe('green');
    expect(detail.style.border.fg).toBe('white');
  });

  it('chord events do not leak when help menu is visible', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout, list, detail } = buildLayout(screen);
    const ctx = buildCtx([root]);

    // Make help menu visible
    (layout.helpMenu.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // Initial focus on list
    expect(list.style.border.fg).toBe('green');

    // Try to cycle focus — should be suppressed because help is open
    simulateCtrlWChord(screen, 'w');

    // Focus should NOT have moved
    expect(list.style.border.fg).toBe('green');
  });

  it('chord events do not leak when a dialog is open', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout, list } = buildLayout(screen);
    const ctx = buildCtx([root]);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // Simulate the detail modal being open
    layout.dialogsComponent.detailModal.hidden = false;

    // Try to cycle focus — should be suppressed because dialog is open
    simulateCtrlWChord(screen, 'w');

    // Focus should NOT have moved from list
    expect(list.style.border.fg).toBe('green');
  });

  it('focus wraps around when cycling past the last pane', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout, list, detail } = buildLayout(screen);
    const ctx = buildCtx([root]);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // With opencode dialog hidden, there are 2 panes: list and detail
    // Cycle forward twice to wrap back to list
    simulateCtrlWChord(screen, 'w');
    expect(detail.style.border.fg).toBe('green');

    simulateCtrlWChord(screen, 'w');
    // Should wrap back to list
    expect(list.style.border.fg).toBe('green');
    expect(detail.style.border.fg).toBe('white');
  });

  it('screen.render is called after each focus change', async () => {
    const root = makeItem('WL-FOCUS-1');
    const screen = makeScreen();
    const { layout } = buildLayout(screen);
    const ctx = buildCtx([root]);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    const renderCountBefore = (screen.render as ReturnType<typeof vi.fn>).mock.calls.length;

    simulateCtrlWChord(screen, 'w');

    const renderCountAfter = (screen.render as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(renderCountAfter).toBeGreaterThan(renderCountBefore);
  });
});
