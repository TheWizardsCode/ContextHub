import { describe, it, expect, vi } from 'vitest';
import blessed from 'blessed';
import { createLayout, type TuiLayout, type NextDialogWidgets } from '../../src/tui/layout.js';
import { ListComponent } from '../../src/tui/components/list.js';
import { DetailComponent } from '../../src/tui/components/detail.js';
import { MetadataPaneComponent } from '../../src/tui/components/metadata-pane.js';
import { ToastComponent } from '../../src/tui/components/toast.js';
import { OverlaysComponent } from '../../src/tui/components/overlays.js';
import { DialogsComponent } from '../../src/tui/components/dialogs.js';
import { HelpMenuComponent } from '../../src/tui/components/help-menu.js';
import { ModalDialogsComponent } from '../../src/tui/components/modals.js';
import { OpencodePaneComponent } from '../../src/tui/components/opencode-pane.js';

// ---------------------------------------------------------------------------
// Helper: minimal mock blessed factory
// ---------------------------------------------------------------------------

function createMockWidget(overrides: Record<string, unknown> = {}): any {
  return {
    on: vi.fn(),
    key: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    setFront: vi.fn(),
    setContent: vi.fn(),
    setLabel: vi.fn(),
    setItems: vi.fn(),
    select: vi.fn(),
    destroy: vi.fn(),
    hidden: true,
    style: {},
    items: [],
    ...overrides,
  };
}

function createMockBlessed(): any {
  return {
    screen: vi.fn(() => createMockWidget({ smartCSR: true, title: 'Worklog TUI' })),
    box: vi.fn(() => createMockWidget()),
    list: vi.fn(() => createMockWidget({ items: [] })),
    textarea: vi.fn(() => createMockWidget({ getValue: vi.fn(() => ''), setValue: vi.fn(), clearValue: vi.fn() })),
    text: vi.fn(() => createMockWidget()),
    textbox: vi.fn(() => createMockWidget({ getValue: vi.fn(() => ''), setValue: vi.fn(), clearValue: vi.fn() })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLayout', () => {
  describe('with real blessed', () => {
    it('returns all expected component instances', () => {
      const layout = createLayout();

      expect(layout.screen).toBeDefined();
      expect(layout.listComponent).toBeInstanceOf(ListComponent);
      expect(layout.detailComponent).toBeInstanceOf(DetailComponent);
      expect(layout.metadataPaneComponent).toBeInstanceOf(MetadataPaneComponent);
      expect(layout.toastComponent).toBeInstanceOf(ToastComponent);
      expect(layout.overlaysComponent).toBeInstanceOf(OverlaysComponent);
      expect(layout.dialogsComponent).toBeInstanceOf(DialogsComponent);
      expect(layout.helpMenu).toBeInstanceOf(HelpMenuComponent);
      expect(layout.modalDialogs).toBeInstanceOf(ModalDialogsComponent);
      expect(layout.opencodeUi).toBeInstanceOf(OpencodePaneComponent);
    });

    it('returns next-dialog widgets', () => {
      const layout = createLayout();
      const nd = layout.nextDialog;

      expect(nd).toBeDefined();
      expect(nd.overlay).toBeDefined();
      expect(nd.dialog).toBeDefined();
      expect(nd.close).toBeDefined();
      expect(nd.text).toBeDefined();
      expect(nd.options).toBeDefined();
    });
  });

  describe('with mocked blessed', () => {
    it('creates a screen using the injected blessed factory', () => {
      const mock = createMockBlessed();
      const layout = createLayout({ blessed: mock });

      expect(mock.screen).toHaveBeenCalledTimes(1);
      expect(mock.screen).toHaveBeenCalledWith(
        expect.objectContaining({ smartCSR: true, title: 'Worklog TUI', mouse: true }),
      );
      expect(layout.screen).toBeDefined();
    });

    it('creates next-dialog widgets via the injected blessed factory', () => {
      const mock = createMockBlessed();
      const layout = createLayout({ blessed: mock });

      // box is called for: nextOverlay, nextDialogBox, nextDialogClose, nextDialogText,
      // plus all the component classes internally call box.
      // list is called for: nextDialogOptions, plus component classes.
      // We just verify the factory was called and the widgets are present.
      expect(mock.box.mock.calls.length).toBeGreaterThan(0);
      expect(mock.list.mock.calls.length).toBeGreaterThan(0);
      expect(layout.nextDialog.overlay).toBeDefined();
      expect(layout.nextDialog.dialog).toBeDefined();
      expect(layout.nextDialog.close).toBeDefined();
      expect(layout.nextDialog.text).toBeDefined();
      expect(layout.nextDialog.options).toBeDefined();
    });

    it('returns all component instances even with mock', () => {
      const mock = createMockBlessed();
      const layout = createLayout({ blessed: mock });

      expect(layout.listComponent).toBeInstanceOf(ListComponent);
      expect(layout.detailComponent).toBeInstanceOf(DetailComponent);
      expect(layout.metadataPaneComponent).toBeInstanceOf(MetadataPaneComponent);
      expect(layout.toastComponent).toBeInstanceOf(ToastComponent);
      expect(layout.overlaysComponent).toBeInstanceOf(OverlaysComponent);
      expect(layout.dialogsComponent).toBeInstanceOf(DialogsComponent);
      expect(layout.helpMenu).toBeInstanceOf(HelpMenuComponent);
      expect(layout.modalDialogs).toBeInstanceOf(ModalDialogsComponent);
      expect(layout.opencodeUi).toBeInstanceOf(OpencodePaneComponent);
    });

    it('forwards custom screenOptions to the screen factory', () => {
      const mock = createMockBlessed();
      createLayout({ blessed: mock, screenOptions: { fullUnicode: true } });

      expect(mock.screen).toHaveBeenCalledWith(
        expect.objectContaining({ fullUnicode: true }),
      );
    });
  });

  describe('layout structure', () => {
    it('satisfies the TuiLayout interface', () => {
      const layout = createLayout();

      // Type-level check: all required properties exist.
      const keys: (keyof TuiLayout)[] = [
        'screen',
        'listComponent',
        'detailComponent',
        'metadataPaneComponent',
        'toastComponent',
        'overlaysComponent',
        'dialogsComponent',
        'helpMenu',
        'modalDialogs',
        'opencodeUi',
        'nextDialog',
      ];
      for (const key of keys) {
        expect(layout).toHaveProperty(key);
      }
    });

    it('next-dialog satisfies NextDialogWidgets interface', () => {
      const layout = createLayout();

      const keys: (keyof NextDialogWidgets)[] = [
        'overlay',
        'dialog',
        'close',
        'text',
        'options',
      ];
      for (const key of keys) {
        expect(layout.nextDialog).toHaveProperty(key);
      }
    });
  });
});
