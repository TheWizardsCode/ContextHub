import blessed from 'blessed';
import type { BlessedBox, BlessedFactory, BlessedScreen } from '../types.js';
import { humanFormatWorkItem } from '../../commands/helpers.js';
import { redactAuditText, parseReadinessLine } from '../../audit.js';
import { stripAnsi, stripTags } from '../id-utils.js';
import { theme } from '../../theme.js';
import { renderMarkdownToTags } from '../markdown-renderer.js';

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

  // Short date/time for the metadata pane: DD/MM HH:MM (local time).
  // Used to append an audit timestamp beside the one-line audit summary.
  private static formatShortDateTime(value: Date | string | undefined): string {
    if (!value) return '';
    const d = typeof value === 'string' ? new Date(value) : value;
    if (isNaN(d.getTime())) return String(value);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month} ${hh}:${mm}`;
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
    // Compact Risk and Effort into a single, predictable line to make the
    // metadata pane easier to scan. Use the same placeholders as before.
    const riskVal = item.risk && item.risk.trim() ? item.risk : placeholder;
    const effortVal = item.effort && item.effort.trim() ? item.effort : placeholder;
    lines.push(`Risk/Effort: ${riskVal}/${effortVal}`);
    lines.push(`Comments: ${commentCount}`);
    lines.push(`Tags:     ${item.tags && item.tags.length > 0 ? item.tags.join(', ') : ''}`);
    lines.push(`Assignee: ${item.assignee ?? ''}`);

    // Surface a one-line Audit summary if present. Prefer reusing the
    // human-readable formatter so the TUI shows the same excerpt as
    // `wl show <id>`. Extract the Audit: line from the human formatter
    // and append the author for quick triage.
    try {
      if ((item as any).audit && typeof (item as any).audit.text === 'string') {
        const formatted = humanFormatWorkItem(item as any, null, 'concise', true);
        const auditLine = formatted.split('\n').find(l => l.trim().startsWith('Audit:')) || '';
        let excerpt = '';
        if (auditLine) {
          excerpt = auditLine.replace(/^Audit:\s*/, '');
        } else {
          const raw = String((item as any).audit.text || '');
          excerpt = (redactAuditText(raw).split(/\r?\n/).find(l => l.trim() !== '') || '').trim();
        }
        if (excerpt) {
          const excerptPlain = stripTags(stripAnsi(excerpt));
          const redactedExcerpt = redactAuditText(excerptPlain);
          const colorExcerpt = excerptPlain.includes('Ready to close: Yes')
            ? theme.tui.text.readyYes(redactedExcerpt)
            : theme.tui.text.readyNo(redactedExcerpt);
          // Append short audit timestamp (DD/MM HH:MM) if available. Prefer
          // the structured audit.time field; fall back to item.updatedAt.
          const auditTime = (item as any)?.audit?.time ?? (item.updatedAt ?? undefined);
          const shortTs = MetadataPaneComponent.formatShortDateTime(auditTime);
          const tsPart = shortTs ? ` ${theme.tui.text.muted(`(${shortTs})`)}` : '';
          lines.push(`${colorExcerpt}${tsPart}`);
        }
      }
    } catch (err) {
      // Non-fatal: if audit formatting fails, do not break the metadata pane
      // — fall through and continue rendering other rows.
    }

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

    // Use the public setContent wrapper so markdown rendering is applied
    // consistently in the metadata pane.
    this.setContent(lines.join('\n'));
  }

  setContent(content: string): void {
    this.box.setContent(renderMarkdownToTags(content));
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
