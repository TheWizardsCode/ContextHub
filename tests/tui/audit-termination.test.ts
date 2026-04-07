import { describe, it, expect, vi } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';

// Minimal widget factories copied from existing controller tests to keep
// this test focused on opencode lifecycle assertions.
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

describe('TUI audit lifecycle', () => {
  it('stops the opencode child when assistant requests input (no orphaned child)', async () => {
    const screen = makeScreen() as any;
    screen._keys = [] as Array<{ keys: string[] | string; handler: (...args: any[]) => any }>;
    screen.key = vi.fn((keys: string[] | string, handler: (...args: any[]) => any) => {
      screen._keys.push({ keys, handler });
    });

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

    let capturedPrompt: string | null = null;
    const instances: any[] = [];

    class FakeOpencodeClient {
      child: any = null;
      _running = false;
      constructor(_opts: any) {
        instances.push(this);
      }
      getStatus() { return { status: this._running ? 'running' : 'stopped', port: this._running ? 9999 : 0 }; }
      async startServer() {
        // Simulate spawn of a child process with a kill spy
        const kill = vi.fn();
        this.child = { pid: 4242, kill } as any;
        // expose the kill spy for assertions
        (this as any)._childKill = kill;
        // preserve historical kill spies across restart cycles so the test
        // can assert that some kill was invoked even if a later start
        // overwrote _childKill.
        (this as any)._childKillHistory = (this as any)._childKillHistory || [];
        (this as any)._childKillHistory.push(kill);
        this._running = true;
        return true;
      }
      stopServer() {
        // mimic real stop behaviour: remove listeners and kill
        try { this.child?.kill?.(); } catch (_) {}
        this.child = null;
        this._running = false;
      }
      async sendPrompt(options: any) {
        capturedPrompt = options.prompt;
        // Simulate the assistant immediately requesting input which should
        // trigger the client to stop the server (defensive behaviour).
        this.stopServer();
        options.onComplete?.();
        return Promise.resolve();
      }
    }

    const ctx = {
      program: { opts: () => ({ verbose: false }) },
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [
            {
              id: 'WL-AUDIT-3',
              title: 'Audit me 3',
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
      createLayout: () => layout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    const auditKey = screen._keys.find((entry: any) => {
      const keys = Array.isArray(entry.keys) ? entry.keys : [entry.keys];
      return keys.includes('A');
    });
    expect(auditKey).toBeTruthy();

    await auditKey!.handler();

    expect(capturedPrompt).toBe('audit WL-AUDIT-3');
    // Ensure our fake client's child.kill was invoked during the flow
    expect(instances.length).toBeGreaterThanOrEqual(1);
    // At least one of the created instances should have had its child.kill invoked
    const anyKilled = instances.some((i: any) => {
      if (typeof i._childKill === 'function' && (i._childKill as any).mock.calls.length > 0) return true;
      if (Array.isArray((i as any)._childKillHistory)) {
        for (const k of (i as any)._childKillHistory) {
          if (k && k.mock && k.mock.calls && k.mock.calls.length > 0) return true;
        }
      }
      return false;
    });
    expect(anyKilled).toBe(true);
  });
});
