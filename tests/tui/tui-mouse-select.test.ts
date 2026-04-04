/**
 * Regression tests for TUI mouse click-to-select.
 *
 * Selecting a work item via mouse click should update the detail pane content,
 * exactly as arrow-key navigation does.  The regression was that clicking a
 * *different* item than the currently selected one never fired the 'select'
 * event; it fires 'select item' via List.prototype.select() instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';

// ── Minimal blessed mocks ─────────────────────────────────────────────

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
  // Track 'select item' listeners so tests can fire them directly
  const selectItemListeners: Array<(...args: any[]) => void> = [];
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
  // Intercept on() calls so we can retrieve 'select item' listeners
  list.on = vi.fn((ev: string, cb: (...args: any[]) => void) => {
    if (ev === 'select item') selectItemListeners.push(cb);
  });
  list._selectItemListeners = selectItemListeners;
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

// ── Helpers ───────────────────────────────────────────────────────────

function makeItem(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    title: `Item ${id}`,
    description: `Description for ${id}`,
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
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

function buildLayout(screen: any) {
  const list = makeList();
  const footer = makeBox();
  const detail = makeBox();
  const copyIdButton = makeBox();
  const metadataBox = makeBox();
  const updateFromItemMock = vi.fn();
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
  const helpMenu = { isVisible: vi.fn(() => false), show: vi.fn(), hide: vi.fn() };
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
    metadataBox,
    updateFromItemMock,
    layout: {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      metadataPaneComponent: { getBox: () => metadataBox, updateFromItem: updateFromItemMock },
      toastComponent: { show: vi.fn() } as any,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      opencodeUi,
      nextDialog: { overlay: makeBox(), dialog: makeBox(), close: makeBox(), text: makeBox(), options: makeList() },
    },
  };
}

function buildCtx(items: any[]) {
  return {
    ctx: {
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
    } as any,
  };
}

class FakeOpencodeClient {
  getStatus() { return { status: 'stopped', port: 9999 }; }
  startServer() { return Promise.resolve(true); }
  stopServer() { return undefined; }
  sendPrompt() { return Promise.resolve(); }
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('TUI mouse click-to-select (regression)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('updates detail pane when user clicks a different list item (select item event)', async () => {
    const item1 = makeItem('WL-MOUSE-1');
    const item2 = makeItem('WL-MOUSE-2');
    const screen = makeScreen();
    const { layout, detail, list, updateFromItemMock } = buildLayout(screen);
    const { ctx } = buildCtx([item1, item2]);

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

    // The 'select item' handler is stored via __opencode_select_item
    const selectItemHandler = (list as any).__opencode_select_item;
    expect(typeof selectItemHandler).toBe('function');

    // Record the initial detail content shown for item 1 (index 0)
    const initialContent = (detail.setContent as any).mock.calls.slice(-1)[0]?.[0] ?? '';

    // Reset mock to detect the update triggered by clicking item 2
    (detail.setContent as any).mockClear();
    updateFromItemMock.mockClear();

    // Simulate blessed's 'select item' event for item at index 1 (item2)
    // This is what blessed fires when the user clicks a different list item.
    const item2Element = list.items?.[1] ?? {};
    selectItemHandler(item2Element, 1);

    // The detail pane must be updated
    expect(detail.setContent).toHaveBeenCalled();
    const updatedContent: string = (detail.setContent as any).mock.calls[0][0] ?? '';
    expect(updateFromItemMock).toHaveBeenCalled();
    const [selectedItem] = updateFromItemMock.mock.calls[0] ?? [];
    expect(selectedItem).toMatchObject({ id: item2.id });
    // The updated content must mention item2's id
    expect(updatedContent).toContain('WL-MOUSE-2');
    // And must differ from the initial (item1) content
    expect(updatedContent).not.toBe(initialContent);
  });

  it('does not reset scroll position when clicking the already-selected item', async () => {
    const item1 = makeItem('WL-MOUSE-3');
    const screen = makeScreen();
    const { layout, detail, list } = buildLayout(screen);
    const { ctx } = buildCtx([item1]);

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

    (detail.setScroll as any).mockClear();

    // Simulate clicking the already-selected item (index 0)
    const selectItemHandler = (list as any).__opencode_select_item;
    if (typeof selectItemHandler === 'function') {
      selectItemHandler(list.items?.[0] ?? {}, 0);
    }

    // The scroll should NOT be reset when re-selecting the same item
    expect(detail.setScroll).not.toHaveBeenCalled();
  });

  it('registers __opencode_select_item handler on startup', async () => {
    const item = makeItem('WL-MOUSE-4');
    const screen = makeScreen();
    const { layout, list } = buildLayout(screen);
    const { ctx } = buildCtx([item]);

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

    // Verify the handler was registered
    expect((list as any).__opencode_select_item).toBeDefined();
    expect(typeof (list as any).__opencode_select_item).toBe('function');

    // Verify it was registered via list.on('select item', ...)
    const onCalls = (list.on as any).mock.calls;
    const selectItemCall = onCalls.find((c: any[]) => c[0] === 'select item');
    expect(selectItemCall).toBeDefined();
    expect(typeof selectItemCall?.[1]).toBe('function');
  });
});
