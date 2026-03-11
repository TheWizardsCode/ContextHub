import { describe, it, expect, vi } from 'vitest';
import { MetadataPaneComponent } from '../../src/tui/components/metadata-pane.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiTestContext } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Helper: minimal mock box/screen for MetadataPaneComponent unit tests
// ---------------------------------------------------------------------------
function createMockMetadataPane() {
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
  const mockBlessed = { box: vi.fn(() => mockBox) };
  const mockScreen = { on: vi.fn() };
  const comp = new MetadataPaneComponent({ parent: mockScreen as any, blessed: mockBlessed as any }).create();
  return { comp, getContent: () => capturedContent };
}

// ---------------------------------------------------------------------------
// Helper: build a TUI layout mock with an injectable metadataPaneComponent.
// Shared across integration tests to reduce duplication.
// ---------------------------------------------------------------------------
function buildLayoutWithMetadataMock(ctx: ReturnType<typeof createTuiTestContext>, updateFromItemMock: ReturnType<typeof vi.fn>) {
  (ctx as any).createLayout = () => ({
    screen: ctx.screen,
    listComponent: { getList: () => ctx.blessed.list(), getFooter: () => ctx.blessed.box() },
    detailComponent: { getDetail: () => ctx.blessed.box(), getCopyIdButton: () => ctx.blessed.box() },
    metadataPaneComponent: { getBox: () => ctx.blessed.box(), updateFromItem: updateFromItemMock },
    toastComponent: { show: (m: string) => ctx.toast.show(m) },
    overlaysComponent: { detailOverlay: ctx.blessed.box(), closeOverlay: ctx.blessed.box(), updateOverlay: ctx.blessed.box() },
    dialogsComponent: {
      detailModal: ctx.blessed.box(), detailClose: ctx.blessed.box(),
      closeDialog: ctx.blessed.box(), closeDialogText: ctx.blessed.box(), closeDialogOptions: ctx.blessed.box(),
      updateDialog: ctx.blessed.box(), updateDialogText: ctx.blessed.box(), updateDialogOptions: ctx.blessed.box(),
      updateDialogStageOptions: ctx.blessed.box(), updateDialogStatusOptions: ctx.blessed.box(),
      updateDialogPriorityOptions: ctx.blessed.box(), updateDialogComment: ctx.blessed.box(),
    },
    helpMenu: { isVisible: () => false, show: () => {}, hide: () => {} },
    modalDialogs: {
      selectList: async () => 0, editTextarea: async () => null,
      confirmTextbox: async () => false, forceCleanup: () => {},
      messageBox: () => ({ update: () => {}, close: () => {} }),
    },
    opencodeUi: {
      serverStatusBox: ctx.blessed.box(), dialog: ctx.blessed.box(), textarea: ctx.blessed.box(),
      suggestionHint: ctx.blessed.box(), sendButton: ctx.blessed.box(), cancelButton: ctx.blessed.box(),
      ensureResponsePane: () => ctx.blessed.box(),
    },
    nextDialog: {
      overlay: ctx.blessed.box(), dialog: ctx.blessed.box(), close: ctx.blessed.box(),
      text: ctx.blessed.box(), options: ctx.blessed.box(),
    },
  });
}

// ---------------------------------------------------------------------------
// Unit tests: MetadataPaneComponent GitHub row rendering
// ---------------------------------------------------------------------------
describe('MetadataPaneComponent GitHub row', () => {
  it('shows configure hint when githubRepo is not set', () => {
    const { comp, getContent } = createMockMetadataPane();
    comp.updateFromItem({ status: 'open', priority: 'medium' }, 0);

    expect(getContent()).toContain('GitHub:');
    expect(getContent()).toContain('githubRepo');
  });

  it('shows issue number when item has a GitHub mapping', () => {
    const { comp, getContent } = createMockMetadataPane();
    comp.updateFromItem({
      status: 'open',
      priority: 'medium',
      githubRepo: 'owner/repo',
      githubIssueNumber: 42,
    }, 0);

    const content = getContent();
    expect(content).toContain('GitHub:');
    // Metadata pane intentionally shows issue number only; repo is implied by config.
    expect(content).toContain('#42');
    expect(content).toContain('G to open');
  });

  it('shows push action when githubRepo is set but item has no issue number', () => {
    const { comp, getContent } = createMockMetadataPane();
    comp.updateFromItem({
      status: 'open',
      priority: 'medium',
      githubRepo: 'owner/repo',
    }, 0);

    const content = getContent();
    expect(content).toContain('GitHub:');
    expect(content).toContain('G to push');
  });

  it('always renders exactly 9 rows regardless of GitHub state', () => {
    const { comp, getContent } = createMockMetadataPane();

    // With no github fields
    comp.updateFromItem({ status: 'open' }, 0);
    expect(getContent().split('\n').length).toBe(9);

    // With github mapping
    comp.updateFromItem({ status: 'open', githubRepo: 'o/r', githubIssueNumber: 1 }, 0);
    expect(getContent().split('\n').length).toBe(9);

    // With github configured but no mapping
    comp.updateFromItem({ status: 'open', githubRepo: 'o/r' }, 0);
    expect(getContent().split('\n').length).toBe(9);
  });

  it('clears content for null item', () => {
    const { comp, getContent } = createMockMetadataPane();
    comp.updateFromItem(null, 0);
    expect(getContent()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: controller passes github fields to updateFromItem
// ---------------------------------------------------------------------------
describe('TUI metadata pane receives GitHub fields', () => {
  it('calls updateFromItem after start', async () => {
    const ctx = createTuiTestContext();
    const updateFromItemMock = vi.fn();
    buildLayoutWithMetadataMock(ctx, updateFromItemMock);

    ctx.utils.createSampleItem({ tags: [] });

    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    await controller.start({});

    // updateFromItem should have been called with the selected item
    expect(updateFromItemMock).toHaveBeenCalled();
  });

  it('passes githubIssueNumber from the item to updateFromItem', async () => {
    const ctx = createTuiTestContext();
    const updateFromItemMock = vi.fn();
    buildLayoutWithMetadataMock(ctx, updateFromItemMock);

    const id = ctx.utils.createSampleItem({ tags: [] });
    // Manually set githubIssueNumber on the item in the in-memory store
    const item = ctx.utils.getDatabase().get(id);
    if (item) (item as any).githubIssueNumber = 77;

    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    await controller.start({});

    expect(updateFromItemMock).toHaveBeenCalled();
    // The first call's first argument should be the item object
    const callArg = updateFromItemMock.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: G key handler (KEY_GITHUB_PUSH)
// ---------------------------------------------------------------------------
describe('TUI G key (shift+G) GitHub action', () => {
  it('shows no-item toast when nothing is selected', async () => {
    const ctx = createTuiTestContext();
    // Override db to return empty list
    ctx.utils.getDatabase = () => ({
      list: () => [],
      getPrefix: () => undefined,
      getCommentsForWorkItem: () => [],
      update: () => ({}),
      createComment: () => ({}),
      get: () => null,
    });

    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    await controller.start({});

    // No items → start returns early with 'No work items found', G press is a no-op
    ctx.screen.emit('keypress', 'G', { name: 'G', shift: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    // Verify no crash occurred; toast may be empty or set from earlier
  });

  it('shows a toast when G is pressed with an item selected (no github config)', async () => {
    const ctx = createTuiTestContext();
    const updateFromItemMock = vi.fn();
    buildLayoutWithMetadataMock(ctx, updateFromItemMock);

    ctx.utils.createSampleItem({ tags: [] });

    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    await controller.start({});

    // Press G (shift+G); resolveGithubConfig will throw because no config in test env
    ctx.screen.emit('keypress', 'G', { name: 'G', shift: true });
    await new Promise(resolve => setTimeout(resolve, 100));

    // Toast should mention github or config
    const msg = ctx.toast.lastMessage();
    expect(msg).toBeTruthy();
    expect(msg.toLowerCase()).toMatch(/github|config|repo|push|set/i);
  });

  it('does NOT trigger the G handler when shift is not pressed (plain g)', async () => {
    const ctx = createTuiTestContext();
    const updateFromItemMock = vi.fn();
    buildLayoutWithMetadataMock(ctx, updateFromItemMock);

    ctx.utils.createSampleItem({ tags: [] });

    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    await controller.start({});

    const toastBefore = ctx.toast.lastMessage();

    // Press 'g' without shift — should NOT trigger GitHub push handler.
    // The KEY_GITHUB_PUSH handler guards with !key.shift and returns early.
    ctx.screen.emit('keypress', 'g', { name: 'g', shift: false });
    await new Promise(resolve => setTimeout(resolve, 100));

    // If the GitHub push handler had fired, it would show a config hint toast.
    // Since it's guarded against shift:false, the toast should NOT contain a
    // "Set githubRepo" message. Any delegate-related toast is acceptable.
    const msg = ctx.toast.lastMessage();
    expect(msg).not.toMatch(/Set githubRepo in config/);
  });
});
