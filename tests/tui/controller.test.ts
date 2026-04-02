import { describe, it, expect, vi } from 'vitest';
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

describe('TuiController', () => {
  it('starts with injected deps and layout', async () => {
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
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
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

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [
            {
              id: 'WL-TEST-1',
              title: 'Test',
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
          ],
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
    });

    await controller.start({});

    expect(createLayout).toHaveBeenCalled();
    expect(opencodeCtorCalls.length).toBe(1);
    expect(opencodeCtorCalls[0].port).toBe(0);
  });

  it('shows empty state when there are no items', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;
    const emptyStateBox = { show: vi.fn(), hide: vi.fn() } as any;

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
    };
    const opencodeUi = {
      show: vi.fn(),
      hide: vi.fn(),
    };
    const metadataPane = makeBox();

    const createLayout = vi.fn(() => ({
      screen,
      listComponent: {
        getList: () => list,
        getFooter: () => footer,
        setItems: vi.fn(),
      },
      detailComponent: {
        getDetail: () => detail,
        getCopyIdButton: () => copyIdButton,
      },
      toastComponent: toastBox,
      emptyStateComponent: emptyStateBox,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      opencodeUi,
      metadataPaneComponent: {
        getBox: () => metadataPane,
      },
    }));

    const ctx = {
      blessed: { screen: () => screen },
      program: { opts: () => ({ verbose: false }) },
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [],
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
      OpencodeClient: class FakeOpencodeClient {
        constructor() {}
        startServer = vi.fn();
      } as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    expect(createLayout).toHaveBeenCalled();
    expect(emptyStateBox.show).toHaveBeenCalled();
    expect(screen.render).toHaveBeenCalled();
  });

  it('Ctrl-C triggers shutdown when empty-state is shown', async () => {
    // Build a screen mock that records key registrations so we can invoke handlers
    const screen: any = {
      height: 40,
      width: 120,
      focused: null,
      render: vi.fn(),
      destroy: vi.fn(),
      // we'll capture key registrations here
      _keys: [] as any[],
      key(keys: any, handler: any) {
        this._keys.push([keys, handler]);
      },
      on: vi.fn(),
    };

    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;
    const emptyStateBox = { show: vi.fn(), hide: vi.fn() } as any;

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
    };
    const opencodeUi = {
      show: vi.fn(),
      hide: vi.fn(),
    };
    const metadataPane = makeBox();

    const createLayout = vi.fn(() => ({
      screen,
      listComponent: {
        getList: () => list,
        getFooter: () => footer,
        setItems: vi.fn(),
      },
      detailComponent: {
        getDetail: () => detail,
        getCopyIdButton: () => copyIdButton,
      },
      toastComponent: toastBox,
      emptyStateComponent: emptyStateBox,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      opencodeUi,
      metadataPaneComponent: {
        getBox: () => metadataPane,
      },
    }));

    const saveSpy = vi.fn(async () => undefined);

    const ctx = {
      blessed: { screen: () => screen },
      program: { opts: () => ({ verbose: false }) },
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [],
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
      OpencodeClient: class FakeOpencodeClient { constructor() {} startServer = vi.fn(); } as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: saveSpy,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    // Find the registered quit handler (one of the key registrations should include 'C-c')
    const quitEntry = screen._keys.find((entry: any[]) => {
      const keys = entry[0];
      if (Array.isArray(keys)) return keys.includes('C-c') || keys.includes('C-c'.replace('-', ''));
      return String(keys).includes('C-c');
    });
    expect(quitEntry).toBeTruthy();
    const quitHandler = quitEntry[1];

    // Invoke the handler as if user pressed Ctrl-C while empty-state is shown
    await quitHandler();

    // The early fallback should persist minimal state and destroy the screen
    expect(saveSpy).toHaveBeenCalled();
    expect(screen.destroy).toHaveBeenCalled();
  });

  it('falls back to safe terminal mode when layout startup hits a capability parse error', async () => {
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
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
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
    };

    const createLayout = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('tmux-256color.plab_norm terminal capability parse error');
      })
      .mockImplementation(() => layout) as unknown as (options?: any) => any;

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

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [
            {
              id: 'WL-TEST-2',
              title: 'Test fallback',
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
          ],
          getPrefix: () => undefined,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          createComment: () => ({}),
          get: () => null,
        })),
      },
    } as any;

    const previousTerm = process.env.TERM;
    process.env.TERM = 'xterm-256color';

    try {
      const controller = new TuiController(ctx, {
        createLayout: createLayout as any,
        OpencodeClient: FakeOpencodeClient as any,
        resolveWorklogDir: () => '/tmp',
        createPersistence: () => ({
          loadPersistedState: async () => null,
          savePersistedState: async () => undefined,
          statePath: '/tmp/tui-state.json',
        }),
      });

      await controller.start({});

      expect(createLayout).toHaveBeenCalledTimes(2);
      expect((createLayout as any).mock.calls[0][0]).toEqual(
        expect.objectContaining({ blessed: expect.anything() })
      );
      expect((createLayout as any).mock.calls[1][0]).toEqual(
        expect.objectContaining({
          screenOptions: { terminal: 'xterm-256color' },
          disableColorCapabilityOverride: true,
        })
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        '[wl tui] Terminal capability parse error detected; starting with safe fallback mode.'
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('TERM=xterm-256color; error: tmux-256color.plab_norm terminal capability parse error')
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        '[wl tui] If needed, run: TERM=xterm-256color wl tui'
      );
      expect(opencodeCtorCalls.length).toBe(1);
    } finally {
      stderrSpy.mockRestore();
      if (previousTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = previousTerm;
      }
    }
  });

  it('uses safe startup layout immediately when TERM is tmux-256color', async () => {
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
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
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
    };

    const createLayout = vi.fn(() => layout) as unknown as (options?: any) => any;

    class FakeOpencodeClient {
      constructor(_options: any) {}
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [
            {
              id: 'WL-TEST-3',
              title: 'Test tmux fallback',
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
          ],
          getPrefix: () => undefined,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          createComment: () => ({}),
          get: () => null,
        })),
      },
    } as any;

    const previousTerm = process.env.TERM;
    process.env.TERM = 'tmux-256color';

    try {
      const controller = new TuiController(ctx, {
        createLayout: createLayout as any,
        OpencodeClient: FakeOpencodeClient as any,
        resolveWorklogDir: () => '/tmp',
        createPersistence: () => ({
          loadPersistedState: async () => null,
          savePersistedState: async () => undefined,
          statePath: '/tmp/tui-state.json',
        }),
      });

      await controller.start({});

      expect(createLayout).toHaveBeenCalledTimes(1);
      expect((createLayout as any).mock.calls[0][0]).toEqual(
        expect.objectContaining({
          screenOptions: { terminal: 'xterm-256color' },
          disableColorCapabilityOverride: true,
        })
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        '[wl tui] TERM=tmux-256color can trigger tmux terminfo parse issues; using fallback terminal xterm-256color.'
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        '[wl tui] If needed, run: TERM=xterm-256color wl tui'
      );
    } finally {
      stderrSpy.mockRestore();
      if (previousTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = previousTerm;
      }
    }
  });
});
