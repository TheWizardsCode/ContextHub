import { describe, it, expect, vi } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';

// Minimal repro test that demonstrates each keypress inserting three
// characters after reopening the opencode overlay.
it('reproduces triple keypress after reopen', async () => {
  const makeBox = () => ({ hidden: true, show: vi.fn(), hide: vi.fn(), focus: vi.fn(), setValue: vi.fn(), getValue: vi.fn(() => ''), on: vi.fn(), key: vi.fn(), setScrollPerc: vi.fn(), setContent: vi.fn(), setItems: vi.fn(), select: vi.fn(), getItem: vi.fn(() => ({ getContent: vi.fn(() => '') })) });
  const makeTextarea = () => ({ value: '', setValue: vi.fn((v: string) => { (textarea as any).value = v; }), getValue: vi.fn(() => (textarea as any).value), clearValue: vi.fn(), on: vi.fn(), screen: null });
  // Use existing test helpers minimal mocks from other tests
  const screen = { height: 40, width: 120, focused: null, program: { y: 0, x: 0, cuf: vi.fn(), cub: vi.fn(), cud: vi.fn(), cuu: vi.fn(), cup: vi.fn() }, render: vi.fn(), destroy: vi.fn(), key: vi.fn(), on: vi.fn() } as any;

  const overlays = { detailOverlay: makeBox(), closeOverlay: makeBox(), updateOverlay: makeBox() } as any;
  const dialogs = { detailModal: makeBox(), detailClose: makeBox(), closeDialog: makeBox(), closeDialogText: makeBox(), closeDialogOptions: makeBox(), updateDialog: makeBox(), updateDialogText: makeBox(), updateDialogOptions: makeBox(), updateDialogStageOptions: makeBox(), updateDialogStatusOptions: makeBox(), updateDialogPriorityOptions: makeBox(), updateDialogComment: makeBox() } as any;

  const opencodeText = makeTextarea();
  const opencodeUi = { serverStatusBox: makeBox(), dialog: makeBox(), textarea: opencodeText, suggestionHint: makeBox(), sendButton: makeBox(), cancelButton: makeBox(), ensureResponsePane: vi.fn(() => makeBox()) } as any;

  const makeDetailBox = () => ({ ...makeBox(), setScroll: vi.fn(), screen, setLine: vi.fn(), setLabel: vi.fn() });
  const layout = { screen, listComponent: { getList: () => makeBox(), getFooter: () => makeBox() }, detailComponent: { getDetail: () => makeDetailBox(), getCopyIdButton: () => makeBox() }, toastComponent: { show: vi.fn() }, overlaysComponent: overlays, dialogsComponent: dialogs, helpMenu: { isVisible: vi.fn(() => false), show: vi.fn(), hide: vi.fn() }, modalDialogs: { selectList: vi.fn(async () => null), editTextarea: vi.fn(async () => null), confirmTextbox: vi.fn(async () => true), forceCleanup: vi.fn() }, opencodeUi, nextDialog: { overlay: makeBox(), dialog: makeBox(), close: makeBox(), text: makeBox(), options: makeBox() } } as any;

  const ctx = { program: { opts: () => ({ verbose: false }) }, utils: { requireInitialized: vi.fn(), getDatabase: vi.fn(() => ({ list: () => ([{ id: 'WL-TEST-1', title: 'Test item', status: 'open', priority: 'low', sortIndex: 1, parentId: null, createdAt: '', updatedAt: '', tags: [], assignee: '', stage: '', issueType: 'task', createdBy: '', deletedBy: '', deleteReason: '', risk: '', effort: '' } as any]), getPrefix: () => undefined, getCommentsForWorkItem: () => [], update: () => ({}), createComment: () => ({}), get: () => null })) } } as any;

  class FakeOpencodeClient { getStatus() { return { status: 'stopped', port: 9999 }; } startServer() { return Promise.resolve(true); } stopServer() { return undefined; } sendPrompt() { return Promise.resolve(); } }

  const controller = new TuiController(ctx, { createLayout: () => layout as any, OpencodeClient: FakeOpencodeClient as any, resolveWorklogDir: () => '/tmp', createPersistence: () => ({ loadPersistedState: async () => null, savePersistedState: async () => undefined, statePath: '/tmp/tui-state.json' }) });

  // Start controller to wire handlers
  await controller.start({});

  // Simulate open -> type -> close -> reopen -> type -> expect single char insertion
  const textarea = opencodeText as any;
  textarea.screen = screen;
  textarea.value = '';
  // Ensure listeners exist
  const inputHandler = textarea._listener || textarea.__opencode_keypress || null;
  expect(inputHandler).not.toBeNull();

  // Initial open: type 'x' twice
  inputHandler.call(textarea, 'x', { name: 'x' });
  expect(textarea.getValue()).toContain('x');

  // Simulate close (controller keeps dialog open but clears value)
  if (typeof textarea.clearValue === 'function') textarea.clearValue();
  textarea.value = '';

  // Reopen and type a single char - regression shows 3 chars
  inputHandler.call(textarea, 'y', { name: 'y' });
  // We expect only one char inserted
  expect(textarea.getValue().length).toBe(1);
});
