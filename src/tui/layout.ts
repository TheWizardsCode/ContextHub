/**
 * UI Layout Factory — creates the blessed screen and all TUI component
 * instances without wiring any interaction or event handlers.
 *
 * Extracted from src/commands/tui.ts as part of WL-0MLARGSUH0ZG8E9K.
 */

import blessed from 'blessed';
import { theme } from '../theme.js';
import type {
  BlessedBox,
  BlessedFactory,
  BlessedList,
  BlessedScreen,
} from './types.js';
import {
  DetailComponent,
  DialogsComponent,
  HelpMenuComponent,
  ListComponent,
  ModalDialogsComponent,
  OpencodePaneComponent,
  OverlaysComponent,
  ToastComponent,
} from './components/index.js';

// ── Public types ─────────────────────────────────────────────────────

/** Raw blessed widgets for the "next work-item recommendation" dialog. */
export interface NextDialogWidgets {
  overlay: BlessedBox;
  dialog: BlessedBox;
  close: BlessedBox;
  text: BlessedBox;
  options: BlessedList;
}

/** The full set of UI elements returned by {@link createLayout}. */
export interface TuiLayout {
  screen: BlessedScreen;

  // Component instances
  listComponent: ListComponent;
  detailComponent: DetailComponent;
  toastComponent: ToastComponent;
  overlaysComponent: OverlaysComponent;
  dialogsComponent: DialogsComponent;
  helpMenu: HelpMenuComponent;
  modalDialogs: ModalDialogsComponent;
  opencodeUi: OpencodePaneComponent;

  // "Next recommendation" dialog (raw blessed widgets, not yet wrapped in a component)
  nextDialog: NextDialogWidgets;
}

// ── Options ──────────────────────────────────────────────────────────

export interface CreateLayoutOptions {
  /**
   * A blessed-compatible factory. When omitted the real `blessed` module is used.
   * Tests should supply a mock here.
   */
  blessed?: BlessedFactory;

  /** Options forwarded to `blessed.screen()`. */
  screenOptions?: Record<string, unknown>;
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create the entire TUI layout: blessed screen + every visual component.
 *
 * No event handlers, key bindings or interaction logic is attached — that
 * remains in the caller (currently `src/commands/tui.ts`).
 */
export function createLayout(options: CreateLayoutOptions = {}): TuiLayout {
  const blessedImpl: any = options.blessed || blessed;

  // ── Screen ──────────────────────────────────────────────────────────
  const screen: BlessedScreen = blessedImpl.screen({
    smartCSR: true,
    title: 'Worklog TUI',
    mouse: true,
    ...options.screenOptions,
  });

  // Force 256-color support so blessed tags like {214-fg} render correctly.
  // Blessed relies on terminfo (tput) which may report only 8 colors even
  // when the terminal actually supports 256.  Modern terminals universally
  // handle 256-color SGR sequences, so this override is safe.
  // Cast to any: blessed's program.tput exists at runtime but is missing
  // from @types/blessed's BlessedProgram declaration.
  const prog = screen.program as any;
  if (prog?.tput && prog.tput.colors < 256) {
    prog.tput.colors = 256;
  }

  // ── List (left pane + footer) ───────────────────────────────────────
  const listComponent = new ListComponent({
    parent: screen,
    blessed: blessedImpl,
  }).create();

  // ── Detail (right pane) ─────────────────────────────────────────────
  const detailComponent = new DetailComponent({
    parent: screen,
    blessed: blessedImpl,
  }).create();

  // ── Toast ───────────────────────────────────────────────────────────
  const toastComponent = new ToastComponent({
    parent: screen,
    blessed: blessedImpl,
    position: { bottom: 1, right: 1 },
    style: { fg: theme.tui.colors.lightText, bg: 'green' },
    duration: 1200,
  }).create();

  // ── Overlays + Dialogs ──────────────────────────────────────────────
  const overlaysComponent = new OverlaysComponent({
    parent: screen,
    blessed: blessedImpl,
  }).create();

  const dialogsComponent = new DialogsComponent({
    parent: screen,
    blessed: blessedImpl,
    overlays: overlaysComponent,
  }).create();

  // ── Next work-item recommendation dialog (raw blessed widgets) ──────
  const nextOverlay: BlessedBox = blessedImpl.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100% - 1',
    hidden: true,
    mouse: true,
    clickable: true,
    style: { bg: 'black', fg: theme.tui.colors.lightText },
  });

  const nextDialogBox: BlessedBox = blessedImpl.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '80%',
    height: 12,
    label: ' Next Work Item ',
    border: { type: 'line' },
    hidden: true,
    tags: true,
    mouse: true,
    clickable: true,
    style: { border: { fg: 'cyan' } },
  });

  const nextDialogClose: BlessedBox = blessedImpl.box({
    parent: nextDialogBox,
    top: 0,
    right: 1,
    height: 1,
    width: 3,
    content: '[x]',
    style: { fg: 'red' },
    mouse: true,
    clickable: true,
  });

  const nextDialogText: BlessedBox = blessedImpl.box({
    parent: nextDialogBox,
    top: 1,
    left: 2,
    width: '100%-4',
    height: 5,
    content: 'Evaluating next work item...',
    tags: true,
    wrap: true,
    wordWrap: true,
    scrollable: true,
    alwaysScroll: true,
  });

  const nextDialogOptions: BlessedList = blessedImpl.list({
    parent: nextDialogBox,
    top: 7,
    left: 2,
    width: '100%-4',
    height: 3,
    keys: true,
    mouse: true,
    style: {
      selected: { bg: 'blue' },
    },
    items: ['View', 'Next recommendation', 'Close'],
  });

  // ── Help menu ───────────────────────────────────────────────────────
  const helpMenu = new HelpMenuComponent({
    parent: screen,
    blessed: blessedImpl,
  }).create();

  // ── Modal dialogs (generic) ─────────────────────────────────────────
  const modalDialogs = new ModalDialogsComponent({
    parent: screen,
    blessed: blessedImpl,
  }).create();

  // ── Opencode pane ───────────────────────────────────────────────────
  const opencodeUi = new OpencodePaneComponent({
    parent: screen,
    blessed: blessedImpl,
  }).create();

  // ── Return layout ───────────────────────────────────────────────────
  return {
    screen,
    listComponent,
    detailComponent,
    toastComponent,
    overlaysComponent,
    dialogsComponent,
    helpMenu,
    modalDialogs,
    opencodeUi,
    nextDialog: {
      overlay: nextOverlay,
      dialog: nextDialogBox,
      close: nextDialogClose,
      text: nextDialogText,
      options: nextDialogOptions,
    },
  };
}
