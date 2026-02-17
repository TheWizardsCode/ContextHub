import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpencodeClient } from '../../src/tui/opencode-client.js';
import { TuiController } from '../../src/tui/controller.js';

describe('OpencodeClient activity indicators', () => {
  const makeClient = () => new OpencodeClient({
    port: 1234,
    log: () => {},
    showToast: () => {},
    modalDialogs: { selectList: async () => null, editTextarea: async () => null, confirmTextbox: async () => true },
    render: () => {},
    persistedState: { load: async () => ({}), save: async () => {}, getPrefix: () => undefined },
    httpImpl: {} as any,
    spawnImpl: () => { throw new Error('not used'); },
  } as any);

  let client: OpencodeClient;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates pane label for streaming text', () => {
    const paneContent: { value: string } = { value: '' };
    const pane = {
      getContent: () => paneContent.value,
      setContent: (s: string) => { paneContent.value = s; },
      setLabel: vi.fn(),
      setScrollPerc: vi.fn(),
    } as any;

    const tools = (client as any).createSessionTools('s1', pane, null, null, () => {});
    tools.handlers.onTextDelta('hello');

    expect((pane.setLabel as any).mock.calls.length).toBeGreaterThan(0);
    const label = (pane.setLabel as any).mock.calls.slice(-1)[0][0] as string;
    expect(label).toContain('Writing response');
  });

  it('shows inline file op message and activity for write tool', () => {
    const paneContent: { value: string } = { value: '' };
    const pane = {
      getContent: () => paneContent.value,
      setContent: (s: string) => { paneContent.value = s; },
      setLabel: vi.fn(),
      setScrollPerc: vi.fn(),
    } as any;

    const tools = (client as any).createSessionTools('s2', pane, null, null, () => {});
    tools.handlers.onToolUse('write', 'src/test.ts');

    expect((pane.setLabel as any).mock.calls.length).toBeGreaterThan(0);
    const label = (pane.setLabel as any).mock.calls.slice(-1)[0][0] as string;
    expect(label).toContain('Using tool: write');
    expect(paneContent.value).toContain('Write: src/test.ts');
  });

  it('sets processing result activity and clears after delay', async () => {
    vi.useFakeTimers();
    const paneContent: { value: string } = { value: '' };
    const pane = {
      getContent: () => paneContent.value,
      setContent: (s: string) => { paneContent.value = s; },
      setLabel: vi.fn(),
      setScrollPerc: vi.fn(),
    } as any;

    const tools = (client as any).createSessionTools('s3', pane, null, null, () => {});
    tools.handlers.onToolResult('ok\nline2');

    // immediate label set
    expect((pane.setLabel as any).mock.calls.length).toBeGreaterThan(0);
    const label = (pane.setLabel as any).mock.calls.slice(-1)[0][0] as string;
    expect(label).toContain('Processing result');

    // advance timers to trigger clear timeout (600ms in implementation)
    vi.advanceTimersByTime(700);

    // after timeout the code attempts to set label to neutral — ensure it's been called again
    const calls = (pane.setLabel as any).mock.calls;
    const lastLabel = calls[calls.length - 1][0] as string;
    expect(lastLabel).toContain('opencode');
  });
});

describe('OpenCode prompt spinner', () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('animates spinner while waiting and stops on completion', async () => {
    vi.useFakeTimers();
    const screen = makeScreen();
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
      updateDialogComment: makeTextarea(),
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
    const opencodeText = makeTextarea();
    const opencodeDialog = makeBox();
    const responsePane = makeBox();
    const opencodeUi = {
      serverStatusBox: makeBox(),
      dialog: opencodeDialog,
      textarea: opencodeText,
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => responsePane),
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
      opencodeUi,
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

    let onComplete: (() => void) | undefined;
    class FakeOpencodeClient {
      getStatus() { return { status: 'running', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt(options: any) { onComplete = options.onComplete; return Promise.resolve(); }
    }

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

    opencodeText.setValue('hello');
    const sendHandler = (opencodeUi.sendButton as any).__opencode_click as (() => void) | undefined;
    expect(typeof sendHandler).toBe('function');
    sendHandler?.();

    expect(opencodeDialog.setLabel).toHaveBeenCalled();
    const initialLabel = (opencodeDialog.setLabel as any).mock.calls.slice(-1)[0][0] as string;
    expect(initialLabel).toContain('waiting');

    vi.advanceTimersByTime(240);
    const calls = (opencodeDialog.setLabel as any).mock.calls;
    const lastLabel = calls[calls.length - 1][0] as string;
    expect(lastLabel).toContain('waiting');

    onComplete?.();
    vi.advanceTimersByTime(200);
    const finalLabel = (opencodeDialog.setLabel as any).mock.calls.slice(-1)[0][0] as string;
    expect(finalLabel).not.toContain('waiting');
  });
});
