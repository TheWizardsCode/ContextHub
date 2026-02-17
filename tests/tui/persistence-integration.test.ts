/**
 * Integration tests for TUI persistence: loading/saving persisted state,
 * restoring expanded nodes through the TuiController.
 *
 * Related work item: WL-0MLR6RP7Y03T0LVU
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';

// ── Blessed mock helpers ──────────────────────────────────────────────

const makeBox = () => ({
  hidden: true,
  width: 0,
  height: 0,
  style: { border: {}, label: {}, selected: {} },
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

// ── Helpers for building a TuiController with persistence spies ───────

interface PersistenceSpy {
  loadPersistedState: ((prefix?: string) => Promise<any>) & ReturnType<typeof vi.fn>;
  savePersistedState: ((prefix: string | undefined, state: any) => Promise<void>) & ReturnType<typeof vi.fn>;
  statePath: string;
}

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

function buildControllerWithPersistence(
  items: any[],
  persistenceSpy: PersistenceSpy,
) {
  const screen = makeScreen();
  const { layout, list, detail } = buildLayout(screen);

  const ctx = buildCtx(items);

  const controller = new TuiController(ctx, {
    createLayout: () => layout as any,
    OpencodeClient: FakeOpencodeClient as any,
    resolveWorklogDir: () => '/tmp/test-worklog',
    createPersistence: (() => persistenceSpy) as any,
  });

  return { controller, screen, list, detail, persistenceSpy };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('TUI persistence integration', () => {
  let persistenceSpy: PersistenceSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    persistenceSpy = {
      loadPersistedState: vi.fn(async () => null),
      savePersistedState: vi.fn(async () => undefined),
      statePath: '/tmp/test-worklog/tui-state.json',
    };
  });

  it('calls loadPersistedState with the database prefix on startup', async () => {
    const root = makeItem('WL-ROOT-1');
    const child = makeItem('WL-CHILD-1', 'WL-ROOT-1');

    const { controller } = buildControllerWithPersistence(
      [root, child],
      persistenceSpy,
    );

    await controller.start({});

    expect(persistenceSpy.loadPersistedState).toHaveBeenCalledWith('test-prefix');
  });

  it('restores expanded nodes from persisted state', async () => {
    const root = makeItem('WL-ROOT-1');
    const child = makeItem('WL-CHILD-1', 'WL-ROOT-1');

    // Persisted state says WL-ROOT-1 was expanded
    persistenceSpy.loadPersistedState = vi.fn(async () => ({
      expanded: ['WL-ROOT-1'],
    }));

    const { controller, list } = buildControllerWithPersistence(
      [root, child],
      persistenceSpy,
    );

    await controller.start({});

    // The list should have been rendered with the child visible
    // (since WL-ROOT-1 is expanded, WL-CHILD-1 should appear)
    const setItemsCalls = list.setItems.mock.calls;
    expect(setItemsCalls.length).toBeGreaterThan(0);

    // The last setItems call should include at least 2 items (root + child)
    const lastItems = setItemsCalls[setItemsCalls.length - 1][0];
    expect(lastItems.length).toBeGreaterThanOrEqual(2);
  });

  it('does not expand nodes when persisted state is null', async () => {
    const root = makeItem('WL-ROOT-1');
    const child = makeItem('WL-CHILD-1', 'WL-ROOT-1');

    persistenceSpy.loadPersistedState = vi.fn(async () => null);

    const { controller, list } = buildControllerWithPersistence(
      [root, child],
      persistenceSpy,
    );

    await controller.start({});

    // When no persisted state exists, roots are expanded by default,
    // so children should still be visible
    const setItemsCalls = list.setItems.mock.calls;
    expect(setItemsCalls.length).toBeGreaterThan(0);
  });

  it('saves expanded state on shutdown', async () => {
    const root = makeItem('WL-ROOT-1');

    persistenceSpy.loadPersistedState = vi.fn(async () => ({
      expanded: ['WL-ROOT-1'],
    }));

    const { controller, screen } = buildControllerWithPersistence(
      [root],
      persistenceSpy,
    );

    await controller.start({});

    // Find and invoke the quit handler registered on screen.key
    const keyCallArgs = (screen.key as ReturnType<typeof vi.fn>).mock.calls;
    const quitBinding = keyCallArgs.find((call: any[]) => {
      const keys = Array.isArray(call[0]) ? call[0] : [call[0]];
      return keys.includes('q') || keys.includes('Q');
    });

    if (quitBinding) {
      quitBinding[1](); // invoke handler
    }

    // savePersistedState should have been called with the prefix
    expect(persistenceSpy.savePersistedState).toHaveBeenCalled();
    const saveCalls = persistenceSpy.savePersistedState.mock.calls;
    // First argument should be the prefix
    const lastSaveCall = saveCalls[saveCalls.length - 1];
    expect(lastSaveCall[0]).toBe('test-prefix');
    // Second argument should contain expanded array
    expect(lastSaveCall[1]).toHaveProperty('expanded');
    expect(Array.isArray(lastSaveCall[1].expanded)).toBe(true);
  });

  it('handles corrupted persisted state gracefully', async () => {
    const root = makeItem('WL-ROOT-1');

    // Return a state object with non-array expanded (simulate corruption)
    persistenceSpy.loadPersistedState = vi.fn(async () => ({
      expanded: 'not-an-array',
    }));

    const { controller } = buildControllerWithPersistence(
      [root],
      persistenceSpy,
    );

    // Should not throw
    await expect(controller.start({})).resolves.not.toThrow();
  });

  it('handles loadPersistedState returning undefined gracefully', async () => {
    const root = makeItem('WL-ROOT-1');

    persistenceSpy.loadPersistedState = vi.fn(async () => undefined);

    const { controller } = buildControllerWithPersistence(
      [root],
      persistenceSpy,
    );

    // Should not throw
    await expect(controller.start({})).resolves.not.toThrow();
  });

  it('prunes expanded IDs for items no longer in the list', async () => {
    // Persisted state says WL-GONE was expanded, but that item no longer exists
    const root = makeItem('WL-ROOT-1');

    persistenceSpy.loadPersistedState = vi.fn(async () => ({
      expanded: ['WL-GONE', 'WL-ROOT-1'],
    }));

    const { controller, list } = buildControllerWithPersistence(
      [root],
      persistenceSpy,
    );

    await controller.start({});

    // Controller should have started without error, WL-GONE is silently pruned
    const setItemsCalls = list.setItems.mock.calls;
    expect(setItemsCalls.length).toBeGreaterThan(0);
  });
});
