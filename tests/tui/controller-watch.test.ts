import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';
import * as fs from 'fs';
import * as path from 'path';

const makeBox = () => ({
  hidden: true,
  width: 0,
  height: 0,
  style: { border: {}, label: {}, selected: {}, focus: { border: {} } },
  show: vi.fn(function() { (this as any).hidden = false; }),
  hide: vi.fn(function() { (this as any).hidden = true; }),
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

const makeTextarea = () => {
  const textarea = makeBox() as any;
  textarea._updateCursor = vi.fn();
  return textarea;
};

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

const makeScreen = () => {
  const screen: any = {
    height: 40,
    width: 120,
    focused: null,
    render: vi.fn(),
    destroy: vi.fn(),
    key: vi.fn(),
    on: vi.fn(),
  };
  return screen;
};

describe('TuiController - Database Watch', () => {
  let mockFs: any;
  let mockPath: any;
  let watchCallbacks: Array<{ eventType: string; filename: string }>;
  let mockWatcher: any;
  let currentMtime: number;
  let listCalls: string[][];

  beforeEach(() => {
    watchCallbacks = [];
    currentMtime = 1000;
    listCalls = [];
    
    mockWatcher = {
      close: vi.fn(),
    };

    mockFs = {
      watch: vi.fn((dir: string, callback: any) => {
        // Store the callback to trigger it manually in tests
        mockFs.watchCallback = callback;
        return mockWatcher;
      }),
      statSync: vi.fn((filepath: string) => ({
        mtimeMs: currentMtime,
      })),
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    };

    mockPath = {
      ...path,
      dirname: vi.fn((p: string) => '/tmp/.worklog'),
      basename: vi.fn((p: string) => 'worklog.db'),
      join: vi.fn((...args: string[]) => args.join('/')),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should refresh when database file changes', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;

    const overlays = {
      detailOverlay: makeBox(),
      closeOverlay: makeBox(),
      updateOverlay: makeBox(),
      createOverlay: makeBox(),
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
      createDialog: makeBox(),
      createDialogText: makeBox(),
      createDialogTitleInput: makeTextarea(),
      createDialogDescription: makeTextarea(),
      createDialogIssueTypeOptions: makeList(),
      createDialogPriorityOptions: makeList(),
      createDialogCreateButton: makeBox(),
      createDialogCancelButton: makeBox(),
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
    const agentPane = {
      serverStatusBox: makeBox(),
      dialog: makeBox(),
      textarea: makeBox(),
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      agentPane,
      nextDialog: {
        overlay: makeBox(),
        dialog: makeBox(),
        close: makeBox(),
        text: makeBox(),
        options: makeList(),
      },
    };

    const createLayout = vi.fn(() => layout) as unknown as (options?: any) => any;
    const opencodeCtorCalls: any[] = [];
    class FakeOpencodeClient {
      constructor(options: any) {
        opencodeCtorCalls.push(options);
      }
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    // Track database list calls to verify refresh happens
    let listCallCount = 0;
    const mockDbList = vi.fn(() => {
      listCallCount++;
      listCalls.push([`call-${listCallCount}`]);
      return [
        {
          id: `WL-TEST-${listCallCount}`,
          title: `Test Item ${listCallCount}`,
          description: '',
          status: 'open',
          priority: 'medium',
          sortIndex: 0,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
          assignee: '',
          stage: '',
          issueType: 'task',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '',
          effort: '',
        },
      ];
    });

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: mockDbList,
          getPrefix: () => undefined,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          createComment: () => ({}),
          get: () => null,
        })),
      },
    } as any;

    const controller = new TuiController(ctx, {
      createLayout: createLayout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
      fs: mockFs,
      path: mockPath,
    });

    await controller.start({});

    // Verify that fs.watch was called
    expect(mockFs.watch).toHaveBeenCalled();
    
    // Get the watch callback that was registered
    const watchCallback = mockFs.watchCallback;
    expect(watchCallback).toBeDefined();

    // Initial database call on startup
    const initialCallCount = listCallCount;
    expect(initialCallCount).toBeGreaterThanOrEqual(1);

    // Simulate a database file change event
    currentMtime = 2000; // Update mtime to simulate file change
    watchCallback('change', 'worklog.db');

    // Wait for the debounce timeout (75ms) + refresh timeout (300ms)
    await new Promise(resolve => setTimeout(resolve, 400));

    // Verify that the database was queried again (refresh happened)
    expect(listCallCount).toBeGreaterThan(initialCallCount);
  });

  it('should refresh on every watch event (no mtime filtering)', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;

    const overlays = {
      detailOverlay: makeBox(),
      closeOverlay: makeBox(),
      updateOverlay: makeBox(),
      createOverlay: makeBox(),
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
      createDialog: makeBox(),
      createDialogText: makeBox(),
      createDialogTitleInput: makeTextarea(),
      createDialogDescription: makeTextarea(),
      createDialogIssueTypeOptions: makeList(),
      createDialogPriorityOptions: makeList(),
      createDialogCreateButton: makeBox(),
      createDialogCancelButton: makeBox(),
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
    const agentPane = {
      serverStatusBox: makeBox(),
      dialog: makeBox(),
      textarea: makeBox(),
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      agentPane,
      nextDialog: {
        overlay: makeBox(),
        dialog: makeBox(),
        close: makeBox(),
        text: makeBox(),
        options: makeList(),
      },
    };

    const createLayout = vi.fn(() => layout) as unknown as (options?: any) => any;
    class FakeOpencodeClient {
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    let listCallCount = 0;
    const mockDbList = vi.fn(() => {
      listCallCount++;
      return [
        {
          id: 'WL-TEST-1',
          title: 'Test Item',
          description: '',
          status: 'open',
          priority: 'medium',
          sortIndex: 0,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
          assignee: '',
          stage: '',
          issueType: 'task',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '',
          effort: '',
        },
      ];
    });

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: mockDbList,
          getPrefix: () => undefined,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          createComment: () => ({}),
          get: () => null,
        })),
      },
    } as any;

    const controller = new TuiController(ctx, {
      createLayout: createLayout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
      fs: mockFs,
      path: mockPath,
    });

    await controller.start({});

    const watchCallback = mockFs.watchCallback;
    const initialCallCount = listCallCount;

    // Advance mtime so the signature changes and the refresh proceeds
    currentMtime = 2000;

    // Simulate a watch event (should trigger refresh when signature changes)
    watchCallback('change', 'worklog.db');

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 400));

    // Should have triggered a refresh on any valid watch event
    expect(listCallCount).toBeGreaterThan(initialCallCount);
  });

  it('ignores filename-less watch events when db/wal signature is unchanged', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;

    const overlays = {
      detailOverlay: makeBox(),
      closeOverlay: makeBox(),
      updateOverlay: makeBox(),
      createOverlay: makeBox(),
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
      createDialog: makeBox(),
      createDialogText: makeBox(),
      createDialogTitleInput: makeTextarea(),
      createDialogDescription: makeTextarea(),
      createDialogIssueTypeOptions: makeList(),
      createDialogPriorityOptions: makeList(),
      createDialogCreateButton: makeBox(),
      createDialogCancelButton: makeBox(),
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
    const agentPane = {
      serverStatusBox: makeBox(),
      dialog: makeBox(),
      textarea: makeBox(),
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      agentPane,
      nextDialog: {
        overlay: makeBox(),
        dialog: makeBox(),
        close: makeBox(),
        text: makeBox(),
        options: makeList(),
      },
    };

    const createLayout = vi.fn(() => layout) as unknown as (options?: any) => any;
    class FakeOpencodeClient {
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    let listCallCount = 0;
    const mockDbList = vi.fn(() => {
      listCallCount++;
      return [
        {
          id: 'WL-TEST-1',
          title: 'Test Item',
          description: '',
          status: 'open',
          priority: 'medium',
          sortIndex: 0,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
          assignee: '',
          stage: '',
          issueType: 'task',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '',
          effort: '',
        },
      ];
    });

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: mockDbList,
          getPrefix: () => undefined,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          createComment: () => ({}),
          get: () => null,
        })),
      },
    } as any;

    const controller = new TuiController(ctx, {
      createLayout: createLayout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
      fs: mockFs,
      path: mockPath,
    });

    await controller.start({});

    const watchCallback = mockFs.watchCallback;
    const initialCallCount = listCallCount;

    // filename is undefined and stat signature is unchanged -> should be ignored
    watchCallback('change', undefined);

    await new Promise(resolve => setTimeout(resolve, 400));

    expect(listCallCount).toBe(initialCallCount);
  });

  it('ignores filename watch events when db/wal signature is unchanged', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;

    const overlays = {
      detailOverlay: makeBox(),
      closeOverlay: makeBox(),
      updateOverlay: makeBox(),
      createOverlay: makeBox(),
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
      createDialog: makeBox(),
      createDialogText: makeBox(),
      createDialogTitleInput: makeTextarea(),
      createDialogDescription: makeTextarea(),
      createDialogIssueTypeOptions: makeList(),
      createDialogPriorityOptions: makeList(),
      createDialogCreateButton: makeBox(),
      createDialogCancelButton: makeBox(),
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
    const agentPane = {
      serverStatusBox: makeBox(),
      dialog: makeBox(),
      textarea: makeBox(),
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      agentPane,
      nextDialog: {
        overlay: makeBox(),
        dialog: makeBox(),
        close: makeBox(),
        text: makeBox(),
        options: makeList(),
      },
    };

    const createLayout = vi.fn(() => layout) as unknown as (options?: any) => any;
    class FakeOpencodeClient {
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    let listCallCount = 0;
    const mockDbList = vi.fn(() => {
      listCallCount++;
      return [
        {
          id: 'WL-TEST-1',
          title: 'Test Item',
          description: '',
          status: 'open',
          priority: 'medium',
          sortIndex: 0,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
          assignee: '',
          stage: '',
          issueType: 'task',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '',
          effort: '',
        },
      ];
    });

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: mockDbList,
          getPrefix: () => undefined,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          createComment: () => ({}),
          get: () => null,
        })),
      },
    } as any;

    const controller = new TuiController(ctx, {
      createLayout: createLayout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
      fs: mockFs,
      path: mockPath,
    });

    await controller.start({});

    const watchCallback = mockFs.watchCallback;
    const initialCallCount = listCallCount;

    // filename is 'worklog.db' but signature is unchanged -> should be ignored
    watchCallback('change', 'worklog.db');

    await new Promise(resolve => setTimeout(resolve, 400));

    expect(listCallCount).toBe(initialCallCount);
  });

  it('skips expensive re-render on watch refresh when dataset is unchanged', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;

    const overlays = {
      detailOverlay: makeBox(),
      closeOverlay: makeBox(),
      updateOverlay: makeBox(),
      createOverlay: makeBox(),
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
      createDialog: makeBox(),
      createDialogText: makeBox(),
      createDialogTitleInput: makeTextarea(),
      createDialogDescription: makeTextarea(),
      createDialogIssueTypeOptions: makeList(),
      createDialogPriorityOptions: makeList(),
      createDialogCreateButton: makeBox(),
      createDialogCancelButton: makeBox(),
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
    const agentPane = {
      serverStatusBox: makeBox(),
      dialog: makeBox(),
      textarea: makeBox(),
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      agentPane,
      nextDialog: {
        overlay: makeBox(),
        dialog: makeBox(),
        close: makeBox(),
        text: makeBox(),
        options: makeList(),
      },
    };

    const createLayout = vi.fn(() => layout) as unknown as (options?: any) => any;
    class FakeOpencodeClient {
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    let listCallCount = 0;
    const constantUpdatedAt = '2026-05-10T00:00:00.000Z';
    const mockDbList = vi.fn(() => {
      listCallCount++;
      return [
        {
          id: 'WL-TEST-1',
          title: 'Test Item',
          description: '',
          status: 'open',
          priority: 'medium',
          sortIndex: 0,
          parentId: null,
          createdAt: constantUpdatedAt,
          updatedAt: constantUpdatedAt,
          tags: [],
          assignee: '',
          stage: '',
          issueType: 'task',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '',
          effort: '',
        },
      ];
    });

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: mockDbList,
          getPrefix: () => undefined,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          createComment: () => ({}),
          get: () => null,
        })),
      },
    } as any;

    const controller = new TuiController(ctx, {
      createLayout: createLayout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
      fs: mockFs,
      path: mockPath,
    });

    await controller.start({});

    const watchCallback = mockFs.watchCallback;
    const initialListCallCount = listCallCount;
    const initialSetItemsCount = (list.setItems as any).mock.calls.length;

    // Advance mtime so the signature changes and the refresh proceeds
    currentMtime = 2000;

    watchCallback('change', 'worklog.db');
    await new Promise(resolve => setTimeout(resolve, 400));

    expect(listCallCount).toBeGreaterThan(initialListCallCount);
    expect((list.setItems as any).mock.calls.length).toBe(initialSetItemsCount);
  });

  it('should watch WAL file for SQLite WAL mode', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;

    const overlays = {
      detailOverlay: makeBox(),
      closeOverlay: makeBox(),
      updateOverlay: makeBox(),
      createOverlay: makeBox(),
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
      createDialog: makeBox(),
      createDialogText: makeBox(),
      createDialogTitleInput: makeTextarea(),
      createDialogDescription: makeTextarea(),
      createDialogIssueTypeOptions: makeList(),
      createDialogPriorityOptions: makeList(),
      createDialogCreateButton: makeBox(),
      createDialogCancelButton: makeBox(),
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
    const agentPane = {
      serverStatusBox: makeBox(),
      dialog: makeBox(),
      textarea: makeBox(),
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      agentPane,
      nextDialog: {
        overlay: makeBox(),
        dialog: makeBox(),
        close: makeBox(),
        text: makeBox(),
        options: makeList(),
      },
    };

    const createLayout = vi.fn(() => layout) as unknown as (options?: any) => any;
    class FakeOpencodeClient {
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    let listCallCount = 0;
    const mockDbList = vi.fn(() => {
      listCallCount++;
      return [
        {
          id: 'WL-TEST-1',
          title: 'Test Item',
          description: '',
          status: 'open',
          priority: 'medium',
          sortIndex: 0,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
          assignee: '',
          stage: '',
          issueType: 'task',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '',
          effort: '',
        },
      ];
    });

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: mockDbList,
          getPrefix: () => undefined,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          createComment: () => ({}),
          get: () => null,
        })),
      },
    } as any;

    const controller = new TuiController(ctx, {
      createLayout: createLayout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
      fs: mockFs,
      path: mockPath,
    });

    await controller.start({});

    const watchCallback = mockFs.watchCallback;
    const initialCallCount = listCallCount;

    // Simulate a WAL file change event
    currentMtime = 3000;
    watchCallback('change', 'worklog.db-wal');

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 400));

    // Should have triggered a refresh for WAL file too
    expect(listCallCount).toBeGreaterThan(initialCallCount);
  });
});
