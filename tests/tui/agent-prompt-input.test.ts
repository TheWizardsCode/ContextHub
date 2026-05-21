import { describe, it, expect, vi } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';

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
  _updateCursor: vi.fn(),
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

const makeTextarea = () => {
  const box = makeBox() as any;
  box.value = '';
  box.setValue = vi.fn((value: string) => { box.value = value; });
  box.getValue = vi.fn(() => box.value);
  box.clearValue = vi.fn(() => { box.value = ''; });
  return box;
};

const makeScreen = () => ({
  height: 40,
  width: 120,
  focused: null,
  program: { y: 0, x: 0, cuf: vi.fn(), cub: vi.fn(), cud: vi.fn(), cuu: vi.fn(), cup: vi.fn() },
  render: vi.fn(),
  destroy: vi.fn(),
  key: vi.fn(),
  on: vi.fn(),
});

describe('OpenCode prompt input modes', () => {
  it('supports normal/insert mode and cursor movement without inserting', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();

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
      updateDialogComment: makeTextarea(),
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
      selectList: vi.fn(async () => null),
      editTextarea: vi.fn(async () => null),
      confirmTextbox: vi.fn(async () => true),
      forceCleanup: vi.fn(),
    };
    const agentText = makeTextarea();
    const agentPane = {
      serverStatusBox: makeBox(),
      dialog: makeBox(),
      textarea: agentText,
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: { show: vi.fn() } as any,
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

    const ctx = {
      program: { opts: () => ({ verbose: false }) },
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

    class FakePiAdapter {
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      PiAdapter: FakePiAdapter as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    const inputHandler = (agentText as any)._listener as (ch: any, key: any) => void;
    expect(typeof inputHandler).toBe('function');

    (agentText as any).screen = screen;
    screen.focused = agentText;
    (agentText as any).lpos = { yi: 0, yl: 10, xi: 0, xl: 10 };
    (agentText as any).iheight = 0;
    (agentText as any).itop = 0;
    (agentText as any).ileft = 0;
    (agentText as any)._clines = Object.assign([''], { ftor: [[0]] });
    (agentText as any).strWidth = (value: string) => value.length;
    (agentText as any)._getCoords = () => (agentText as any).lpos;

    inputHandler.call(agentText, 'a', { name: 'a' });
    inputHandler.call(agentText, 'b', { name: 'b' });
    expect(agentText.getValue()).toBe('ab');
    expect((agentText as any).__cursor_pos).toBe(2);

    inputHandler.call(agentText, '', { name: 'n', ctrl: true });
    expect((agentText as any).__input_mode).toBe('normal');

    inputHandler.call(agentText, '', { name: 'h' });
    expect(agentText.getValue()).toBe('ab');
    expect((agentText as any).__cursor_pos).toBe(1);

    inputHandler.call(agentText, '', { name: 'l' });
    expect((agentText as any).__cursor_pos).toBe(2);

    inputHandler.call(agentText, '', { name: 'i' });
    expect((agentText as any).__input_mode).toBe('insert');

    inputHandler.call(agentText, '', { name: 'left' });
    expect(agentText.getValue()).toBe('ab');
    expect((agentText as any).__cursor_pos).toBe(1);

    inputHandler.call(agentText, 'c', { name: 'c' });
    expect(agentText.getValue()).toBe('acb');
    expect((agentText as any).__cursor_pos).toBe(2);
  });

  it('guards against duplicate input handling for a single key event', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();

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
      updateDialogComment: makeTextarea(),
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
      selectList: vi.fn(async () => null),
      editTextarea: vi.fn(async () => null),
      confirmTextbox: vi.fn(async () => true),
      forceCleanup: vi.fn(),
    };
    const agentText = makeTextarea();
    const agentPane = {
      serverStatusBox: makeBox(),
      dialog: makeBox(),
      textarea: agentText,
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: { show: vi.fn() } as any,
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

    const ctx = {
      program: { opts: () => ({ verbose: false }) },
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

    class FakePiAdapter {
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      PiAdapter: FakePiAdapter as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    const inputHandler = (agentText as any)._listener as (ch: any, key: any) => void;
    expect(typeof inputHandler).toBe('function');

    const key = { name: 'a' } as any;
    inputHandler.call(agentText, 'a', key);
    inputHandler.call(agentText, 'a', key);

    expect(agentText.getValue()).toBe('a');
  });

  it('auto-resizes prompt height based on wrapped visual lines', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();

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
      updateDialogComment: makeTextarea(),
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
      selectList: vi.fn(async () => null),
      editTextarea: vi.fn(async () => null),
      confirmTextbox: vi.fn(async () => true),
      forceCleanup: vi.fn(),
    };
    const agentText = makeTextarea();
    const agentDialog = makeBox();
    const agentPane = {
      serverStatusBox: makeBox(),
      dialog: agentDialog,
      textarea: agentText,
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: { show: vi.fn() } as any,
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

    const ctx = {
      program: { opts: () => ({ verbose: false }) },
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

    class FakePiAdapter {
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      PiAdapter: FakePiAdapter as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    const keypressHandler = (agentText as any).__keypress_handler as (ch: any, key: any) => void;
    expect(typeof keypressHandler).toBe('function');

    agentText.setValue('wrapped line');
    (agentText as any)._clines = new Array(5).fill('line');

    keypressHandler.call(agentText, 'a', { name: 'a' });
    await new Promise<void>(resolve => process.nextTick(resolve));

    expect(agentDialog.height).toBe(7);
    expect(agentText.height).toBe(5);

    (agentText as any)._clines = new Array(20).fill('line');
    keypressHandler.call(agentText, 'b', { name: 'b' });
    await new Promise<void>(resolve => process.nextTick(resolve));

    expect(agentText.setScrollPerc).toHaveBeenCalledWith(100);
  });
});
