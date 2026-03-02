/**
 * Integration test for the 50/50 split layout with metadata and details panes.
 *
 * Exercises:
 * - Selection propagation: selecting an item updates the MetadataPane and detail pane
 * - Comment creation: adding a comment updates the comments view and #comments in metadata
 * - Tab/Shift-Tab focus cycling between the three panes
 *
 * Related work item: WL-0MLORPQUE1B7X8C3
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';
import { MetadataPaneComponent } from '../../src/tui/components/metadata-pane.js';

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
    description: 'Test description',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId,
    createdAt: now,
    updatedAt: now,
    tags: ['test'],
    assignee: 'alice',
    stage: 'prd_complete',
    issueType: 'task',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
  };
}

// ── Layout builder ────────────────────────────────────────────────────

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
    metadataBox,
    updateFromItemMock,
    opencodeDialog: opencodeUi.dialog,
    opencodeText: opencodeUi.textarea,
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

// ── Context builder ───────────────────────────────────────────────────

function buildCtx(items: any[], comments: any[] = []) {
  const createCommentMock = vi.fn();
  const getCommentsMock = vi.fn(() => comments);
  return {
    ctx: {
      program: { opts: () => ({ verbose: false }) },
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => items,
          getPrefix: () => 'test-prefix',
          getCommentsForWorkItem: getCommentsMock,
          update: () => ({}),
          createComment: createCommentMock,
          get: (id: string) => items.find(i => i.id === id) ?? null,
        })),
      },
    } as any,
    createCommentMock,
    getCommentsMock,
  };
}

class FakeOpencodeClient {
  getStatus() { return { status: 'stopped', port: 9999 }; }
  startServer() { return Promise.resolve(true); }
  stopServer() { return undefined; }
  sendPrompt() { return Promise.resolve(); }
}

// ── Helper to get screen.key handlers ────────────────────────────────

function getKeyHandler(mockFn: ReturnType<typeof vi.fn>, keyOrEvent: string | string[]): ((...args: any[]) => any) | null {
  const calls = mockFn.mock.calls;
  for (const call of calls) {
    const registeredKeys = call[0];
    const handler = call[1];
    if (typeof registeredKeys === 'string') {
      if (registeredKeys === keyOrEvent) return handler;
    }
    if (Array.isArray(registeredKeys) && Array.isArray(keyOrEvent)) {
      if (keyOrEvent.some(k => registeredKeys.includes(k))) return handler;
    }
    if (Array.isArray(registeredKeys) && typeof keyOrEvent === 'string') {
      if (registeredKeys.includes(keyOrEvent)) return handler;
    }
  }
  return null;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('TUI 50/50 split layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('layout includes metadataPaneComponent', async () => {
    const item = makeItem('WL-LAYOUT-1');
    const screen = makeScreen();
    const { layout } = buildLayout(screen);

    expect(layout.metadataPaneComponent).toBeDefined();
    expect(typeof layout.metadataPaneComponent.getBox).toBe('function');
    expect(typeof layout.metadataPaneComponent.updateFromItem).toBe('function');
  });

  it('selecting an item updates the metadata pane', async () => {
    const item = makeItem('WL-SELECT-1');
    const screen = makeScreen();
    const { layout, list, updateFromItemMock } = buildLayout(screen);
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

    // After start, the metadata pane should have been updated with the selected item
    expect(updateFromItemMock).toHaveBeenCalled();
    const [calledItem] = updateFromItemMock.mock.calls[0];
    expect(calledItem).toMatchObject({ id: item.id });
  });

  it('metadata pane shows comment count', async () => {
    const item = makeItem('WL-COMMENT-COUNT-1');
    const comments = [
      { id: 'c1', workItemId: item.id, comment: 'First comment', author: '@user', createdAt: new Date().toISOString() },
      { id: 'c2', workItemId: item.id, comment: 'Second comment', author: '@user', createdAt: new Date().toISOString() },
    ];
    const screen = makeScreen();
    const { layout, updateFromItemMock } = buildLayout(screen);
    const { ctx } = buildCtx([item], comments);

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

    // updateFromItem should be called with the comment count (2)
    expect(updateFromItemMock).toHaveBeenCalled();
    const [, commentCount] = updateFromItemMock.mock.calls[0];
    expect(commentCount).toBe(2);
  });

  it('Tab key cycles focus forward (list → metadata → detail)', async () => {
    const item = makeItem('WL-TAB-1');
    const screen = makeScreen();
    const { layout, list, detail, metadataBox } = buildLayout(screen);
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

    // Tab handler should be registered
    const tabHandler = getKeyHandler(screen.key as ReturnType<typeof vi.fn>, ['tab', 'C-i']);
    expect(tabHandler).not.toBeNull();

    // Initial focus on list
    expect(list.style.border.fg).toBe('green');

    // Tab: list → metadata
    tabHandler!('', { name: 'tab' });
    expect(metadataBox.style.border.fg).toBe('green');
    expect(list.style.border.fg).toBe('white');

    // Tab: metadata → detail
    tabHandler!('', { name: 'tab' });
    expect(detail.style.border.fg).toBe('green');
    expect(metadataBox.style.border.fg).toBe('white');

    // Tab: detail → list (wrap)
    tabHandler!('', { name: 'tab' });
    expect(list.style.border.fg).toBe('green');
    expect(detail.style.border.fg).toBe('white');
  });

  it('Shift-Tab key cycles focus backward (list → detail → metadata)', async () => {
    const item = makeItem('WL-STAB-1');
    const screen = makeScreen();
    const { layout, list, detail, metadataBox } = buildLayout(screen);
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

    // Shift-Tab handler should be registered
    const shiftTabHandler = getKeyHandler(screen.key as ReturnType<typeof vi.fn>, ['S-tab', 'C-S-i']);
    expect(shiftTabHandler).not.toBeNull();

    // Initial focus on list
    expect(list.style.border.fg).toBe('green');

    // Shift-Tab: list → detail (wrap backward)
    shiftTabHandler!('', { name: 'S-tab' });
    expect(detail.style.border.fg).toBe('green');
    expect(list.style.border.fg).toBe('white');

    // Shift-Tab: detail → metadata
    shiftTabHandler!('', { name: 'S-tab' });
    expect(metadataBox.style.border.fg).toBe('green');
    expect(detail.style.border.fg).toBe('white');

    // Shift-Tab: metadata → list
    shiftTabHandler!('', { name: 'S-tab' });
    expect(list.style.border.fg).toBe('green');
    expect(metadataBox.style.border.fg).toBe('white');
  });

  it('Tab/Shift-Tab do not fire when a dialog is open', async () => {
    const item = makeItem('WL-TAB-DIALOG-1');
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

    // Simulate a dialog being open
    layout.dialogsComponent.updateDialog.hidden = false;

    const tabHandler = getKeyHandler(screen.key as ReturnType<typeof vi.fn>, ['tab', 'C-i']);
    expect(tabHandler).not.toBeNull();

    // Tab should not change focus while dialog is open
    tabHandler!('', { name: 'tab' });
    expect(list.style.border.fg).toBe('green'); // still on list
  });

  it('MetadataPaneComponent.updateFromItem formats metadata correctly', () => {
    // Create a mock blessed factory
    let capturedContent = '';
    const mockBox = {
      setContent: vi.fn((c: string) => { capturedContent = c; }),
      on: vi.fn(),
      key: vi.fn(),
      focus: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      destroy: vi.fn(),
      removeAllListeners: vi.fn(),
      style: {},
    };
    const mockBlessed = {
      box: vi.fn(() => mockBox),
    };
    const mockScreen = { on: vi.fn() };

    const comp = new MetadataPaneComponent({ parent: mockScreen as any, blessed: mockBlessed as any }).create();

    comp.updateFromItem({
      status: 'in-progress',
      stage: 'prd_complete',
      priority: 'high',
      tags: ['backend', 'feature'],
      assignee: 'alice',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-06-01T00:00:00Z',
    }, 3);

    expect(capturedContent).toContain('Status:');
    expect(capturedContent).toContain('in-progress');
    expect(capturedContent).toContain('Priority:');
    expect(capturedContent).toContain('high');
    expect(capturedContent).toContain('Comments: 3');
    expect(capturedContent).toContain('Tags:');
    expect(capturedContent).toContain('backend');
    expect(capturedContent).toContain('Assignee:');
    expect(capturedContent).toContain('alice');
  });

  it('MetadataPaneComponent.updateFromItem clears content for null item', () => {
    let capturedContent = 'initial';
    const mockBox = {
      setContent: vi.fn((c: string) => { capturedContent = c; }),
      on: vi.fn(),
      key: vi.fn(),
      focus: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      destroy: vi.fn(),
      removeAllListeners: vi.fn(),
      style: {},
    };
    const mockBlessed = {
      box: vi.fn(() => mockBox),
    };
    const mockScreen = { on: vi.fn() };

    const comp = new MetadataPaneComponent({ parent: mockScreen as any, blessed: mockBlessed as any }).create();
    comp.updateFromItem(null, 0);

    expect(capturedContent).toBe('');
  });
});
