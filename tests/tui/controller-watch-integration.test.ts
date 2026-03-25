import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TuiController } from '../../src/tui/controller.js';

const makeBox = () => ({
  hidden: true,
  width: 0,
  height: 0,
  style: { border: {}, label: {}, selected: {} },
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

describe('TuiController - Database Watch Integration', () => {
  let tempDir: string;
  let dbPath: string;
  let walPath: string;
  let listCallCount: number;
  let mockDbList: any;

  beforeEach(() => {
    // Create a real temporary directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-watch-test-'));
    dbPath = path.join(tempDir, 'worklog.db');
    walPath = path.join(tempDir, 'worklog.db-wal');
    
    // Create the database file
    fs.writeFileSync(dbPath, '');
    
    listCallCount = 0;
    mockDbList = vi.fn(() => {
      listCallCount++;
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
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should detect changes when database file is modified', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;

    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
      overlaysComponent: {
        detailOverlay: makeBox(),
        closeOverlay: makeBox(),
        updateOverlay: makeBox(),
      },
      dialogsComponent: {
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
      },
      helpMenu: {
        isVisible: vi.fn(() => false),
        show: vi.fn(),
        hide: vi.fn(),
      },
      modalDialogs: {
        selectList: vi.fn(async () => 0),
        editTextarea: vi.fn(async () => null),
        confirmTextbox: vi.fn(async () => false),
        forceCleanup: vi.fn(),
      },
      opencodeUi: {
        serverStatusBox: makeBox(),
        dialog: makeBox(),
        textarea: makeBox(),
        suggestionHint: makeBox(),
        sendButton: makeBox(),
        cancelButton: makeBox(),
        ensureResponsePane: vi.fn(() => makeBox()),
      },
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

    // We need to mock getDefaultDataPath to return our temp path
    // Since it's imported directly, we'll mock the path module
    const mockPath = {
      ...path,
      join: vi.fn((...args: string[]) => {
        if (args.includes('worklog-data.jsonl')) {
          return path.join(tempDir, 'worklog-data.jsonl');
        }
        return path.join(...args);
      }),
      dirname: vi.fn((p: string) => path.dirname(p)),
      basename: vi.fn((p: string) => path.basename(p)),
    };

    const controller = new TuiController(ctx, {
      createLayout: createLayout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => tempDir,
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: path.join(tempDir, 'tui-state.json'),
      }),
      fs,
      path: mockPath,
    });

    await controller.start({});

    const initialCallCount = listCallCount;
    expect(initialCallCount).toBeGreaterThanOrEqual(1);

    // Simulate database modification by touching the file
    const newContent = `modified at ${Date.now()}`;
    fs.writeFileSync(dbPath, newContent);

    // Wait for watch to detect and debounce
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify database was queried again
    expect(listCallCount).toBeGreaterThan(initialCallCount);
  });

  it('should detect changes when WAL file is modified (SQLite WAL mode)', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;

    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
      overlaysComponent: {
        detailOverlay: makeBox(),
        closeOverlay: makeBox(),
        updateOverlay: makeBox(),
      },
      dialogsComponent: {
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
      },
      helpMenu: {
        isVisible: vi.fn(() => false),
        show: vi.fn(),
        hide: vi.fn(),
      },
      modalDialogs: {
        selectList: vi.fn(async () => 0),
        editTextarea: vi.fn(async () => null),
        confirmTextbox: vi.fn(async () => false),
        forceCleanup: vi.fn(),
      },
      opencodeUi: {
        serverStatusBox: makeBox(),
        dialog: makeBox(),
        textarea: makeBox(),
        suggestionHint: makeBox(),
        sendButton: makeBox(),
        cancelButton: makeBox(),
        ensureResponsePane: vi.fn(() => makeBox()),
      },
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

    const mockPath = {
      ...path,
      join: vi.fn((...args: string[]) => {
        if (args.includes('worklog-data.jsonl')) {
          return path.join(tempDir, 'worklog-data.jsonl');
        }
        return path.join(...args);
      }),
      dirname: vi.fn((p: string) => path.dirname(p)),
      basename: vi.fn((p: string) => path.basename(p)),
    };

    const controller = new TuiController(ctx, {
      createLayout: createLayout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => tempDir,
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: path.join(tempDir, 'tui-state.json'),
      }),
      fs,
      path: mockPath,
    });

    await controller.start({});

    const initialCallCount = listCallCount;

    // Create and modify WAL file (simulating SQLite WAL mode)
    fs.writeFileSync(walPath, 'wal data');

    // Wait for watch to detect
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify database was queried
    expect(listCallCount).toBeGreaterThan(initialCallCount);
  });
});
