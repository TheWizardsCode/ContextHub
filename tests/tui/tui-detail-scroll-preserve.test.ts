import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';

// Minimal blessed mocks (copied pattern from existing TUI tests)
const makeBox = () => ({
  hidden: true,
  width: 0,
  height: 0,
  style: { border: {} as Record<string, any>, label: {} as Record<string, any>, selected: {}, focus: { border: {} } },
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

const makeTextarea = () => {
  const box = makeBox() as any;
  box._updateCursor = vi.fn();
  return box;
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

const makeScreen = () => ({
  height: 40,
  width: 120,
  focused: null as any,
  render: vi.fn(),
  destroy: vi.fn(),
  key: vi.fn(),
  on: vi.fn(),
});

function makeItem(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    title: `Item ${id}`,
    description: Array(50).fill('Line of description').join('\n'),
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
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
  const helpMenu = { isVisible: vi.fn(() => false), show: vi.fn(), hide: vi.fn() };
  const modalDialogs = { selectList: vi.fn(async () => 0), editTextarea: vi.fn(async () => null), confirmTextbox: vi.fn(async () => false), forceCleanup: vi.fn() };
  const agentPane = { serverStatusBox: makeBox(), dialog: makeBox(), textarea: makeBox(), suggestionHint: makeBox(), sendButton: makeBox(), cancelButton: makeBox(), ensureResponsePane: vi.fn(() => makeBox()) };

  return {
    screen,
    list,
    detail,
    metadataBox,
    updateFromItemMock,
    agentDialog: agentPane.dialog,
    agentText: agentPane.textarea,
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
      agentPane,
      nextDialog: { overlay: makeBox(), dialog: makeBox(), close: makeBox(), text: makeBox(), options: makeList() },
    },
  };
}

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
          getCommentsForWorkItem: getCommentsMock, getAuditResult: () => null,
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

class FakePiAdapter {
  getStatus() { return { status: 'stopped', port: 9999 }; }
  startServer() { return Promise.resolve(true); }
  stopServer() { return undefined; }
  sendPrompt() { return Promise.resolve(); }
}

describe('TUI detail-scroll preservation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('preserves detail pane scroll when re-rendering the same item', async () => {
    const item = makeItem('WL-TEST-1');
    const screen = makeScreen();
    const { layout, detail, list } = buildLayout(screen) as any;
    const { ctx } = buildCtx([item]);

    // Instrument the detail box to observe setScroll calls
    // `detail` returned from buildLayout is the same as layout.detail
    const detailBox = detail as any;
    let storedScroll = 0;
    detailBox.setScroll = vi.fn((n: number) => { storedScroll = n; });
    detailBox.getScroll = vi.fn(() => storedScroll);

    const controller = new TuiController(ctx, {
      createLayout: () => layout as any,
      PiAdapter: FakePiAdapter as any,
      resolveWorklogDir: () => '/tmp/test-worklog',
      createPersistence: () => ({ loadPersistedState: async () => null, savePersistedState: async () => undefined, statePath: '/tmp/tui-state.json' }),
    });

    await controller.start({});

    // Initial render should reset scroll (called at least once)
    expect(detail.setScroll).toHaveBeenCalled();

    // Clear recorded calls and simulate a user scroll position change
    (detail.setScroll as any).mockClear();
    storedScroll = 5;

    // Trigger the registered select handler to force a re-render of the same item
    const listBox = list as any;
    const selectHandler = (listBox as any).__agent_select;
    if (typeof selectHandler === 'function') selectHandler(null, list.selected);

    // Since the same item is being re-rendered, setScroll should NOT be called again
    expect(detail.setScroll).not.toHaveBeenCalled();
  });
});
