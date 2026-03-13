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

  private static formatDate(value: Date | string | undefined): string {
    if (!value) return '';
    const d = typeof value === 'string' ? new Date(value) : value;
    if (isNaN(d.getTime())) return String(value);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mon = months[d.getUTCMonth()];
    const day = d.getUTCDate();
    const year = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${mon} ${day}, ${year} ${hh}:${mm}`;
  }

  updateFromItem(item: {
    status?: string;
    stage?: string;
    priority?: string;
    risk?: string;
    effort?: string;
    tags?: string[];
    assignee?: string;
    createdAt?: Date | string;
    updatedAt?: Date | string;
    githubIssueNumber?: number;
    githubRepo?: string;
  } | null, commentCount: number): void {
    if (!item) {
      this.box.setContent('');
      return;
    }
    const placeholder = '—';
    const lines: string[] = [];
    lines.push(`Status:   ${item.status ?? ''}`);
    lines.push(`Stage:    ${item.stage ?? ''}`);
    lines.push(`Priority: ${item.priority ?? ''}`);
    lines.push(`Risk:     ${item.risk && item.risk.trim() ? item.risk : placeholder}`);
    lines.push(`Effort:   ${item.effort && item.effort.trim() ? item.effort : placeholder}`);
    lines.push(`Comments: ${commentCount}`);
    lines.push(`Tags:     ${item.tags && item.tags.length > 0 ? item.tags.join(', ') : ''}`);
    lines.push(`Assignee: ${item.assignee ?? ''}`);
    lines.push(`Created:  ${MetadataPaneComponent.formatDate(item.createdAt)}`);
    lines.push(`Updated:  ${MetadataPaneComponent.formatDate(item.updatedAt)}`);

    if (!item.githubRepo) {
      lines.push('GitHub:   (set githubRepo in config to enable)');
    } else if (item.githubIssueNumber) {
      // Only show the issue number in the metadata pane; repo is implied by config
      // Make the text explicit about interaction so controller can wire key/click handlers
      lines.push(`GitHub:   #${item.githubIssueNumber} (G to open)`);
    } else {
      // Show a visual affordance that pushing is available; controller will
      // handle the actual push logic and keyboard/mouse interactions.
      lines.push('GitHub:   (G to push to GitHub)');
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
    const box = this.box as unknown as { removeAllListeners?: () => void; destroy: () => void };
    if (typeof box.removeAllListeners === 'function') box.removeAllListeners();
    this.box.destroy();
  }
}
