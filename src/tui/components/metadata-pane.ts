import blessed from 'blessed';
import type { BlessedBox, BlessedFactory, BlessedScreen } from '../types.js';

export interface MetadataPaneOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
}

export class MetadataPaneComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;
  private box: BlessedBox;

  constructor(options: MetadataPaneOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;

    this.box = this.blessedImpl.box({
      parent: this.screen,
      label: ' Metadata ',
      left: '65%',
      top: 0,
      width: '35%',
      height: '50%',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      clickable: true,
      border: { type: 'line' },
      style: {
        focus: { border: { fg: 'green' } },
        border: { fg: 'white' },
        label: { fg: 'white' },
      },
      content: '',
    });
  }

  create(): this {
    return this;
  }

  getBox(): BlessedBox {
    return this.box;
  }

  updateFromItem(item: {
    status?: string;
    stage?: string;
    priority?: string;
    tags?: string[];
    assignee?: string;
    createdAt?: Date | string;
    updatedAt?: Date | string;
  } | null, commentCount: number): void {
    if (!item) {
      this.box.setContent('');
      return;
    }
    const lines: string[] = [];
    lines.push(`Status:   ${item.status ?? ''}`);
    lines.push(`Stage:    ${item.stage ?? ''}`);
    lines.push(`Priority: ${item.priority ?? ''}`);
    lines.push(`Comments: ${commentCount}`);
    if (item.tags && item.tags.length > 0) {
      lines.push(`Tags:     ${item.tags.join(', ')}`);
    }
    if (item.assignee) {
      lines.push(`Assignee: ${item.assignee}`);
    }
    if (item.createdAt) {
      lines.push(`Created:  ${String(item.createdAt)}`);
    }
    if (item.updatedAt) {
      lines.push(`Updated:  ${String(item.updatedAt)}`);
    }
    this.box.setContent(lines.join('\n'));
  }

  setContent(content: string): void {
    this.box.setContent(content);
  }

  focus(): void {
    this.box.focus();
  }

  show(): void {
    this.box.show();
  }

  hide(): void {
    this.box.hide();
  }

  destroy(): void {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof this.box.removeAllListeners === 'function') this.box.removeAllListeners();
    this.box.destroy();
  }
}
