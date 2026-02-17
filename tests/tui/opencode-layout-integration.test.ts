/**
 * Integration tests for TUI opencode layout resizing and textarea.style
 * object preservation through the TuiController.
 *
 * This covers:
 * - ensureOpencodeTextStyle() never replaces the style object
 * - clearOpencodeTextBorders() clears border keys in-place
 * - applyOpencodeCompactLayout() resizes the dialog and textarea correctly
 * - updateOpencodeInputLayout() adjusts height based on content lines
 *
 * Related work item: WL-0MLR6RXK10A4PKH5
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';

// ── Blessed mock helpers ──────────────────────────────────────────────

const makeBox = () => ({
  hidden: true,
  width: 0 as number | string,
  height: 0 as number | string,
  top: undefined as number | string | undefined,
  left: undefined as number | string | undefined,
  bottom: undefined as number | string | undefined,
  style: { border: {} as Record<string, any>, label: {} as Record<string, any>, selected: {}, focus: undefined as any },
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

  // Create textarea and dialog with realistic style objects to test preservation
  const textarea = makeBox();
  textarea.style = {
    border: { fg: 'white', type: 'line' } as Record<string, any>,
    label: {} as Record<string, any>,
    selected: {},
    focus: { border: { fg: 'green' } },
  };

  const dialog = makeBox();

  const opencodeUi = {
    serverStatusBox: makeBox(),
    dialog,
    textarea,
    suggestionHint: makeBox(),
    sendButton: makeBox(),
    cancelButton: makeBox(),
    ensureResponsePane: vi.fn(() => makeBox()),
  };

  return {
    screen,
    list,
    detail,
    textarea,
    dialog,
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
 * Find a registered screen.key handler that matches the given key(s).
 */
function getKeyHandler(mockFn: ReturnType<typeof vi.fn>, keyOrKeys: string | string[]): ((...args: any[]) => any) | null {
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  for (const call of mockFn.mock.calls) {
    const registeredKeys = Array.isArray(call[0]) ? call[0] : [call[0]];
    if (keys.some(k => registeredKeys.includes(k))) return call[1];
  }
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('TUI opencode layout integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('textarea.style object reference is preserved after opening opencode dialog', async () => {
    const root = makeItem('WL-LAYOUT-1');
    const screen = makeScreen();
    const { layout, textarea } = buildLayout(screen);
    const ctx = buildCtx([root]);

    // Capture the original style object reference before the controller touches it
    const originalStyleRef = textarea.style;

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

    // Open the opencode dialog via the 'o' key handler
    const openHandler = getKeyHandler(screen.key, ['o', 'O']);
    if (openHandler) {
      await openHandler();
    }

    // The style object must be the SAME reference — not replaced
    expect(textarea.style).toBe(originalStyleRef);
  });

  it('textarea border properties are cleared in-place, not by object replacement', async () => {
    const root = makeItem('WL-LAYOUT-1');
    const screen = makeScreen();
    const { layout, textarea } = buildLayout(screen);
    const ctx = buildCtx([root]);

    // Set up initial border with known properties
    textarea.style.border = { fg: 'white', type: 'line' } as Record<string, any>;
    const borderRef = textarea.style.border;

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

    // Open the opencode dialog which triggers applyOpencodeCompactLayout
    const openHandler = getKeyHandler(screen.key, ['o', 'O']);
    if (openHandler) {
      await openHandler();
    }

    // The border object should be the SAME reference but with properties cleared
    expect(textarea.style.border).toBe(borderRef);
    // After clearOpencodeTextBorders, fg and type should be deleted
    expect(textarea.style.border.fg).toBeUndefined();
    expect(textarea.style.border.type).toBeUndefined();
  });

  it('opencode dialog dimensions are set correctly in compact mode', async () => {
    const root = makeItem('WL-LAYOUT-1');
    const screen = makeScreen();
    const { layout, dialog } = buildLayout(screen);
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

    // Open the opencode dialog
    const openHandler = getKeyHandler(screen.key, ['o', 'O']);
    if (openHandler) {
      await openHandler();
    }

    // Dialog should be visible
    expect(dialog.hidden).toBe(false);
    // Dialog should be positioned at the bottom
    expect(dialog.width).toBe('100%');
    // MIN_INPUT_HEIGHT is 3 (from constants.ts)
    expect(dialog.height).toBe(3);
    expect(dialog.left).toBe(0);
  });

  it('textarea dimensions are set relative to dialog in compact mode', async () => {
    const root = makeItem('WL-LAYOUT-1');
    const screen = makeScreen();
    const { layout, textarea, dialog } = buildLayout(screen);
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

    const openHandler = getKeyHandler(screen.key, ['o', 'O']);
    if (openHandler) {
      await openHandler();
    }

    // Textarea should fill the dialog minus borders
    expect(textarea.top).toBe(0);
    expect(textarea.left).toBe(0);
    expect(textarea.width).toBe('100%-2');
    // height = dialog height (MIN_INPUT_HEIGHT=3) - 2 = 1
    expect(textarea.height).toBe(1);
  });

  it('style.focus.border properties are cleared without replacing the focus object', async () => {
    const root = makeItem('WL-LAYOUT-1');
    const screen = makeScreen();
    const { layout, textarea } = buildLayout(screen);
    const ctx = buildCtx([root]);

    // Set up initial focus.border
    textarea.style.focus = { border: { fg: 'green' } };
    const focusRef = textarea.style.focus;
    const focusBorderRef = textarea.style.focus.border;

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

    const openHandler = getKeyHandler(screen.key, ['o', 'O']);
    if (openHandler) {
      await openHandler();
    }

    // focus object should be the same reference
    expect(textarea.style.focus).toBe(focusRef);
    // focus.border should be the same reference but with properties cleared
    expect(textarea.style.focus.border).toBe(focusBorderRef);
    expect(textarea.style.focus.border.fg).toBeUndefined();
  });

  it('textarea style is not null or undefined after layout operations', async () => {
    const root = makeItem('WL-LAYOUT-1');
    const screen = makeScreen();
    const { layout, textarea } = buildLayout(screen);
    const ctx = buildCtx([root]);

    // Start with a minimal style object
    textarea.style = { border: {} as Record<string, any>, label: {} as Record<string, any>, selected: {}, focus: undefined };

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

    const openHandler = getKeyHandler(screen.key, ['o', 'O']);
    if (openHandler) {
      await openHandler();
    }

    // Style should never be null or undefined
    expect(textarea.style).toBeDefined();
    expect(textarea.style).not.toBeNull();
    expect(typeof textarea.style).toBe('object');
  });

  it('opening opencode dialog does not throw even when style starts empty', async () => {
    const root = makeItem('WL-LAYOUT-1');
    const screen = makeScreen();
    const { layout, textarea } = buildLayout(screen);
    const ctx = buildCtx([root]);

    // Start with completely empty style to ensure ensureOpencodeTextStyle handles it
    (textarea as any).style = {};

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

    const openHandler = getKeyHandler(screen.key, ['o', 'O']);

    // Should not throw
    await expect((async () => {
      if (openHandler) await openHandler();
    })()).resolves.not.toThrow();
  });

  it('screen.render is called after layout update', async () => {
    const root = makeItem('WL-LAYOUT-1');
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

    const openHandler = getKeyHandler(screen.key, ['o', 'O']);
    if (openHandler) {
      await openHandler();
    }

    const renderCountAfter = (screen.render as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(renderCountAfter).toBeGreaterThan(renderCountBefore);
  });
});
