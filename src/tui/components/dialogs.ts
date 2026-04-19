import blessed from 'blessed';
import { theme } from '../../theme.js';
import type { BlessedBox, BlessedFactory, BlessedList, BlessedScreen, BlessedTextarea } from '../types.js';
import type { OverlaysComponent } from './overlays.js';

export interface DialogsComponentOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
  overlays: OverlaysComponent;
}

export class DialogsComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;
  private overlays: OverlaysComponent;

  readonly detailModal: BlessedBox;
  readonly detailClose: BlessedBox;

  readonly closeDialog: BlessedBox;
  readonly closeDialogText: BlessedBox;
  readonly closeDialogOptions: BlessedList;

  readonly updateDialog: BlessedBox;
  readonly updateDialogText: BlessedBox;
  readonly updateDialogOptions: BlessedList;
  readonly updateDialogStageOptions: BlessedList;
  readonly updateDialogStatusOptions: BlessedList;
  readonly updateDialogPriorityOptions: BlessedList;
  readonly updateDialogComment: BlessedTextarea;

  readonly createDialog: BlessedBox;
  readonly createDialogText: BlessedBox;
  readonly createDialogTitleInput: BlessedTextarea;
  readonly createDialogDescription: BlessedTextarea;
  readonly createDialogIssueTypeOptions: BlessedList;
  readonly createDialogPriorityOptions: BlessedList;
  readonly createDialogCreateButton: BlessedBox;
  readonly createDialogCancelButton: BlessedBox;

  constructor(options: DialogsComponentOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;
    this.overlays = options.overlays;

    this.detailModal = this.blessedImpl.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '70%',
      height: '70%',
      label: ' Item Details ',
      border: { type: 'line' },
      hidden: true,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'green' } },
      content: '',
    });

    this.detailClose = this.createText({
      parent: this.detailModal,
      top: 0,
      right: 1,
      height: 1,
      width: 3,
      content: '[x]',
      style: { fg: 'red' },
      mouse: true,
    });

    this.closeDialog = this.createContainer({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 10,
      label: ' Close Work Item ',
      style: { border: { fg: 'magenta' } },
    });

    this.closeDialogText = this.createText({
      parent: this.closeDialog,
      top: 1,
      left: 2,
      height: 2,
      width: '100%-4',
      content: 'Close selected item with stage:',
    });

    this.closeDialogOptions = this.createList({
      parent: this.closeDialog,
      top: 4,
      left: 2,
      width: '100%-4',
      height: 4,
      items: ['Close (in_review)', 'Close (done)', 'Close (deleted)', 'Cancel'],
    });

    this.updateDialog = this.createContainer({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '70%',
      height: 24,
      label: ' Update Work Item ',
      style: { border: { fg: 'magenta' } },
    });

    this.updateDialogText = this.createText({
      parent: this.updateDialog,
      top: 1,
      left: 2,
      height: 3,
      width: '100%-4',
      content: 'Update selected item fields:',
    });

    const updateDialogColumnWidth = '33%-2';
    const updateDialogListHeight = 15;
    const updateDialogListTop = 6;

    this.createLabel({
      parent: this.updateDialog,
      top: 5,
      left: 2,
      height: 1,
      width: updateDialogColumnWidth,
      content: 'Status',
    });

    this.createLabel({
      parent: this.updateDialog,
      top: 5,
      left: '33%+1',
      height: 1,
      width: updateDialogColumnWidth,
      content: 'Stage',
    });

    this.createLabel({
      parent: this.updateDialog,
      top: 5,
      left: '66%+1',
      height: 1,
      width: updateDialogColumnWidth,
      content: 'Priority',
    });

    const statusList = this.createList({
      parent: this.updateDialog,
      top: updateDialogListTop,
      left: 2,
      width: updateDialogColumnWidth,
      height: updateDialogListHeight,
      items: [],
    });

    const stageList = this.createList({
      parent: this.updateDialog,
      top: updateDialogListTop,
      left: '33%+1',
      width: updateDialogColumnWidth,
      height: updateDialogListHeight,
      items: [],
    });

    const priorityList = this.createList({
      parent: this.updateDialog,
      top: updateDialogListTop,
      left: '66%+1',
      width: updateDialogColumnWidth,
      height: updateDialogListHeight,
      items: ['critical', 'high', 'medium', 'low'],
    });

    this.updateDialogOptions = stageList;
    this.updateDialogStageOptions = stageList;
    this.updateDialogStatusOptions = statusList;
    this.updateDialogPriorityOptions = priorityList;

    // Multiline comment textarea placed below the selection lists. It accepts
    // inputOnFocus so Enter inserts newlines; Tab/Shift-Tab navigation is
    // handled by focus management logic elsewhere.
    // Create the textarea without a hard-coded height. We'll position it
    // with `top` and `bottom` so it fills the available space inside the
    // dialog. This prevents it from rendering below the dialog on small
    // terminals and ensures it behaves as a multiline input.
    this.updateDialogComment = this.createTextarea({
      parent: this.updateDialog,
      // initial placement; updateLayout will adjust on show/resize
      top: updateDialogListTop + updateDialogListHeight + 1,
      left: 2,
      right: 2,
      width: '100%-4',
      // Do not set `height` here — use `bottom` in updateLayout so the
      // textarea expands to available space inside the dialog.
      inputOnFocus: false,
      label: ' Comment ',
    });

    const updateLayout = () => {
      const screenHeight = Math.max(0, this.screen.height as number);
      const screenWidth = Math.max(0, this.screen.width as number);
      if (!screenHeight || !screenWidth) return;

      const extraCommentLines = screenHeight >= 28 ? 5 : 0;
      const textareaMinHeight = 4 + extraCommentLines;

      // Adjust overall dialog and list heights depending on screen size
      if (screenHeight < 28) {
        const height = Math.max(16, screenHeight - 4);
        this.updateDialog.height = height;
      } else {
        this.updateDialog.height = 24;
      }

      // Size lists to leave room for the comment box inside the dialog.
      const dialogHeight = Number(this.updateDialog.height as any) || 24;
      const listMaxHeight = Math.max(6, updateDialogListHeight - extraCommentLines);
      const listAvailable = dialogHeight - updateDialogListTop - textareaMinHeight - 3;
      const listHeight = Math.max(6, Math.min(listMaxHeight, listAvailable));
      stageList.height = listHeight;
      statusList.height = listHeight;
      priorityList.height = listHeight;

      // Position the comment textarea directly below the lists and let it
      // fill the remaining vertical space inside the dialog. Using a
      // `bottom` value (instead of explicit numeric `height`) keeps the
      // textarea responsive and prevents it from overflowing the dialog
      // when the terminal is small.
      const textareaTop = updateDialogListTop + listHeight + 1;
      // Position textarea to start below the lists and extend to 1 row above
      // the bottom border of the dialog. Using `bottom` ensures the control
      // remains inside the dialog even when the dialog shrinks.
      (this.updateDialogComment.top as any) = textareaTop;
      // Some terminals/versions of blessed behave better when we set an
      // explicit height rather than relying on `bottom`. Compute the height
      // available inside the dialog and clamp it to a reasonable minimum so
      // the textarea is always visible.
      // Leave 2 rows for dialog borders/spacing
      const available = dialogHeight - textareaTop - 2;
      const textareaHeight = Math.max(textareaMinHeight, available);
      (this.updateDialogComment.height as any) = textareaHeight;
      (this.updateDialogComment.left as any) = 2;
      (this.updateDialogComment.right as any) = 2;
      try { if (typeof this.updateDialogComment.show === 'function') this.updateDialogComment.show(); } catch (_) {}

      this.updateDialog.width = screenWidth < 100 ? '90%' : '70%';
    };

    this.updateDialog.on('show', updateLayout);
    // Some test doubles for blessed's screen do not implement `.on`.
    // Guard the call so tests can provide lightweight mocks without a full
    // blessed.Screen implementation.
    try {
      if (typeof (this.screen as any).on === 'function') {
        this.screen.on('resize', updateLayout);
      }
    } catch (_) {}

    // Create Work Item Dialog
    this.createDialog = this.createContainer({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '70%',
      height: 32,
      label: ' Create Work Item ',
      style: { border: { fg: 'magenta' } },
    });

    this.createDialogText = this.createText({
      parent: this.createDialog,
      top: 1,
      left: 2,
      height: 1,
      width: '100%-4',
      content: '',
    });

    // Title input field
    this.createLabel({
      parent: this.createDialog,
      top: 3,
      left: 2,
      height: 1,
      width: '100%-4',
      content: 'Title (required)',
    });

    this.createDialogTitleInput = this.createTextarea({
      parent: this.createDialog,
      top: 4,
      left: 2,
      right: 2,
      height: 3,
    });

    // Description textarea
    this.createLabel({
      parent: this.createDialog,
      top: 8,
      left: 2,
      height: 1,
      width: '100%-4',
      content: 'Description',
    });

    this.createDialogDescription = this.createTextarea({
      parent: this.createDialog,
      top: 9,
      left: 2,
      right: 2,
      height: 6,
      label: ' Description ',
    });

    // Issue Type list
    this.createLabel({
      parent: this.createDialog,
      top: 16,
      left: 2,
      height: 1,
      width: '30%',
      content: 'Issue Type',
    });

    this.createDialogIssueTypeOptions = this.createList({
      parent: this.createDialog,
      top: 17,
      left: 2,
      width: '30%',
      height: 5,
      items: ['feature', 'bug', 'task', 'epic', 'chore'],
    });

    // Priority list
    this.createLabel({
      parent: this.createDialog,
      top: 16,
      left: '35%',
      height: 1,
      width: '30%',
      content: 'Priority',
    });

    this.createDialogPriorityOptions = this.createList({
      parent: this.createDialog,
      top: 17,
      left: '35%',
      width: '30%',
      height: 5,
      items: ['critical', 'high', 'medium', 'low'],
    });

    // Create Item button
    this.createDialogCreateButton = this.createButton({
      parent: this.createDialog,
      top: 23,
      left: '20%',
      width: '25%',
      height: 3,
      content: '{center}Create Item (Ctrl+S){/center}',
      style: {
        border: { fg: 'green' },
        bg: 'green',
        fg: 'white',
      },
    });

    // Cancel button
    this.createDialogCancelButton = this.createButton({
      parent: this.createDialog,
      top: 23,
      left: '55%',
      width: '25%',
      height: 3,
      content: '{center}Cancel (Esc){/center}',
      style: {
        border: { fg: 'red' },
        fg: 'white',
      },
    });

    // Layout update function for create dialog
    const updateCreateLayout = () => {
      const screenHeight = Math.max(0, this.screen.height as number);
      const screenWidth = Math.max(0, this.screen.width as number);
      if (!screenHeight || !screenWidth) return;

      // Adjust dialog height for small screens
      if (screenHeight < 30) {
        this.createDialog.height = Math.max(20, screenHeight - 4);
      } else {
        this.createDialog.height = 32;
      }

      this.createDialog.width = screenWidth < 100 ? '90%' : '70%';
    };

    this.createDialog.on('show', updateCreateLayout);
    try {
      if (typeof (this.screen as any).on === 'function') {
        this.screen.on('resize', updateCreateLayout);
      }
    } catch (_) {}
  }

  /**
   * Create a configured Blessed List with sensible defaults for dialogs.
   * @param opts Partial blessed list options; parent/position/items may be provided.
   */
  private createList(opts: any): BlessedList {
    const defaults = {
      keys: true,
      mouse: true,
      style: { selected: { bg: 'blue' } },
      items: [],
    } as any;
    return this.blessedImpl.list(Object.assign({}, defaults, opts)) as BlessedList;
  }

  /**
   * Create a configured Blessed Textarea with sensible defaults.
   * @param opts Partial blessed textarea options.
   */
  private createTextarea(opts: any): BlessedTextarea {
    const defaults = {
      input: true,
      inputOnFocus: true,
      vi: true,
      wrap: true,
      keys: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      border: { type: 'line' },
      style: { fg: theme.tui.colors.lightText, bg: 'black', border: { fg: 'gray' } },
      scrollbar: { ch: ' ', inverse: true },
    } as any;
    return this.blessedImpl.textarea(Object.assign({}, defaults, opts)) as BlessedTextarea;
  }

  /**
   * Create a compact text box used for simple dialog text content.
   * @param opts Partial blessed box options.
   */
  private createText(opts: any): BlessedBox {
    const defaults = {
      height: 1,
      tags: false,
    } as any;
    return this.blessedImpl.box(Object.assign({}, defaults, opts)) as BlessedBox;
  }

  /**
   * Create a small helper for dialog containers with sensible defaults.
   * @param opts Partial blessed box options.
   */
  private createContainer(opts: any): BlessedBox {
    const defaults = {
      border: { type: 'line' },
      hidden: true,
      tags: true,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'magenta' } },
    } as any;
    return this.blessedImpl.box(Object.assign({}, defaults, opts)) as BlessedBox;
  }

  /**
   * Create a helper for dialog buttons with sensible defaults.
   * @param opts Partial blessed box options.
   */
  private createButton(opts: any): BlessedBox {
    const defaults = {
      tags: true,
      border: { type: 'line' },
      mouse: true,
      clickable: true,
    } as any;
    return this.blessedImpl.box(Object.assign({}, defaults, opts)) as BlessedBox;
  }

  /**
   * Create a label box used as a section header inside dialogs.
   * @param opts Partial blessed box options.
   */
  private createLabel(opts: any): BlessedBox {
    const defaults = {
      height: 1,
      tags: false,
      style: { fg: 'cyan', bold: true },
    } as any;
    return this.blessedImpl.box(Object.assign({}, defaults, opts)) as BlessedBox;
  }

  create(): this {
    return this;
  }

  getDetailOverlay(): any {
    return this.overlays.detailOverlay;
  }

  getCloseOverlay(): any {
    return this.overlays.closeOverlay;
  }

  getUpdateOverlay(): any {
    return this.overlays.updateOverlay;
  }

  getCreateOverlay(): any {
    return this.overlays.createOverlay;
  }

  show(): void {
    // Dialogs are shown individually.
  }

  hide(): void {
    this.detailModal.hide();
    this.closeDialog.hide();
    this.updateDialog.hide();
    this.createDialog.hide();
    this.overlays.hide();
  }

  focus(): void {
    // No single focus target.
  }

  destroy(): void {
    try { this.detailClose.removeAllListeners?.(); } catch (_) {}
    try { this.detailModal.removeAllListeners?.(); } catch (_) {}
    try { this.detailClose.destroy(); } catch (_) {}
    try { this.detailModal.destroy(); } catch (_) {}

    try { this.closeDialogOptions.removeAllListeners?.(); } catch (_) {}
    try { this.closeDialogText.removeAllListeners?.(); } catch (_) {}
    try { this.closeDialog.removeAllListeners?.(); } catch (_) {}
    try { this.closeDialogOptions.destroy(); } catch (_) {}
    try { this.closeDialogText.destroy(); } catch (_) {}
    try { this.closeDialog.destroy(); } catch (_) {}

    try { this.updateDialogOptions.removeAllListeners?.(); } catch (_) {}
    try { this.updateDialogText.removeAllListeners?.(); } catch (_) {}
    try { this.updateDialog.removeAllListeners?.(); } catch (_) {}
    try { this.updateDialogOptions.destroy(); } catch (_) {}
    try { this.updateDialogText.destroy(); } catch (_) {}
    try { this.updateDialog.destroy(); } catch (_) {}

    try { this.createDialogTitleInput.removeAllListeners?.(); } catch (_) {}
    try { this.createDialogDescription.removeAllListeners?.(); } catch (_) {}
    try { this.createDialogIssueTypeOptions.removeAllListeners?.(); } catch (_) {}
    try { this.createDialogPriorityOptions.removeAllListeners?.(); } catch (_) {}
    try { this.createDialogCreateButton.removeAllListeners?.(); } catch (_) {}
    try { this.createDialogCancelButton.removeAllListeners?.(); } catch (_) {}
    try { this.createDialogText.removeAllListeners?.(); } catch (_) {}
    try { this.createDialog.removeAllListeners?.(); } catch (_) {}
    try { this.createDialogTitleInput.destroy(); } catch (_) {}
    try { this.createDialogDescription.destroy(); } catch (_) {}
    try { this.createDialogIssueTypeOptions.destroy(); } catch (_) {}
    try { this.createDialogPriorityOptions.destroy(); } catch (_) {}
    try { this.createDialogCreateButton.destroy(); } catch (_) {}
    try { this.createDialogCancelButton.destroy(); } catch (_) {}
    try { this.createDialogText.destroy(); } catch (_) {}
    try { this.createDialog.destroy(); } catch (_) {}
  }
}
