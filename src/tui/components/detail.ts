import blessed from 'blessed';
import type { BlessedBox, BlessedFactory, BlessedScreen } from '../types.js';
import { renderMarkdownToTags } from '../../markdown-renderer.js';

export interface DetailComponentOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
}

export class DetailComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;
  private detail: BlessedBox;
  private copyIdButton: BlessedBox;

  constructor(options: DetailComponentOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;

    this.detail = this.blessedImpl.box({
      parent: this.screen,
      label: ' Description & Comments ',
      left: 0,
      top: '50%',
      width: '100%',
      height: '50%-1',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      clickable: true,
      border: { type: 'line' },
      style: { focus: { border: { fg: 'green' } }, border: { fg: 'white' }, label: { fg: 'white' } },
      content: '',
    });

    // Keep a copy-id placeholder widget so controller code and tests
    // that reference getCopyIdButton() continue to work, but do not
    // render the visible '[Copy ID]' label.
    this.copyIdButton = this.blessedImpl.box({
      parent: this.detail,
      top: 0,
      right: 1,
      height: 1,
      // set width to 0 and empty content so the visual label is removed
      // while the widget object remains available for wiring/click handlers.
      width: 0,
      content: '',
      tags: false,
      mouse: true,
      align: 'right',
      style: { fg: 'yellow' },
    });
  }

  create(): this {
    return this;
  }

  getDetail(): BlessedBox {
    return this.detail;
  }

  getCopyIdButton(): BlessedBox {
    return this.copyIdButton;
  }

  /**
   * Set the height and top position of the detail pane.
   * This allows dynamic resizing based on terminal size.
   */
  setHeightAndTop(height: number, top: number): void {
    this.detail.height = height;
    this.detail.top = top;
  }

  setContent(content: string): void {
    this.detail.setContent(renderMarkdownToTags(content));
  }

  focus(): void {
    this.detail.focus();
  }

  show(): void {
    this.detail.show();
  }

  hide(): void {
    this.detail.hide();
  }

  destroy(): void {
    // Remove any listeners attached to child widgets before destroying
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof this.copyIdButton.removeAllListeners === 'function') this.copyIdButton.removeAllListeners();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof this.detail.removeAllListeners === 'function') this.detail.removeAllListeners();
    this.copyIdButton.destroy();
    this.detail.destroy();
  }
}
