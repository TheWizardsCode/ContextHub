/**
 * Shared helper functions for CLI commands
 */

import { theme } from '../theme.js';
import { redactAuditText, parseReadinessLine } from '../audit.js';
import type { WorkItem, Comment } from '../types.js';
import type { SyncResult } from '../sync.js';
import type { WorklogDatabase } from '../database.js';
import { loadConfig } from '../config.js';
import { renderCliMarkdown, stripBlessedTags, shouldUseFormattedOutput, isTty, resolveMarkdownEnabled } from '../cli-output.js';
import { getStageLabel, getStatusLabel, loadStatusStageRules } from '../status-stage-rules.js';
import { priorityIcon, statusIcon, priorityFallback, statusFallback, iconsEnabled } from '../icons.js';
import type { Command } from 'commander';

// Priority ordering for sorting work items (higher number = higher priority)
const PRIORITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const DEFAULT_PRIORITY = PRIORITY_ORDER.medium;

// Helper to format a value for display
export function formatValue(value: any): string {
  if (value === null || value === undefined) {
    return '(empty)';
  }
  if (value === '') {
    return '(empty string)';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }
    return `[${value.join(', ')}]`;
  }
  return String(value);
}

// Helper function to sort items by priority and creation date
export function sortByPriorityAndDate(a: WorkItem, b: WorkItem): number {
  // Higher priority comes first (descending order)
  const aPriority = PRIORITY_ORDER[a.priority] ?? DEFAULT_PRIORITY;
  const bPriority = PRIORITY_ORDER[b.priority] ?? DEFAULT_PRIORITY;
  const priorityDiff = bPriority - aPriority;
  if (priorityDiff !== 0) return priorityDiff;
  // If priorities are equal, sort by creation time (oldest first, ascending order)
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export function sortByPriorityDateAndId(a: WorkItem, b: WorkItem): number {
  const byPriorityAndDate = sortByPriorityAndDate(a, b);
  if (byPriorityAndDate !== 0) return byPriorityAndDate;
  return a.id.localeCompare(b.id);
}

// Format title and id with consistent coloring used in tree/list outputs
export function formatTitleAndId(item: WorkItem, prefix: string = ''): string {
  return `${prefix}${renderTitle(item)} ${theme.text.muted('-')} ${theme.text.muted(item.id)}`;
}

// Format only the title (consistent color)
export function formatTitleOnly(item: WorkItem): string {
  return renderTitle(item);
}

// Format only the title with TUI colors (blessed markup) for use in TUI tree view
export function formatTitleOnlyTUI(item: WorkItem): string {
  return renderTitleTUI(item);
}

// Return chalk function appropriate for a given stage (for console output)
// Stage progression: gray → blue → cyan → yellow → green → white
function titleColorForStage(stage?: string): (text: string) => string {
  const s = (stage || '').toLowerCase().trim();
  switch (s) {
    case 'idea':
      return theme.stage.idea;
    case 'intake_complete':
      return theme.stage.intakeComplete;
    case 'plan_complete':
      return theme.stage.planComplete;
    case 'in_progress':
      return theme.stage.inProgress;
    case 'in_review':
      return theme.stage.inReview;
    case 'done':
      return theme.stage.done;
    default:
      return theme.stage.idea; // default to idea/gray colour
  }
}

// Return blessed markup tags appropriate for a given stage (for TUI output)
// Stage progression: gray-fg → blue-fg → cyan-fg → yellow-fg → green-fg → white-fg
function titleColorForStageTUI(stage?: string): (text: string) => string {
  const s = (stage || '').toLowerCase().trim();
  switch (s) {
    case 'idea':
      return theme.tui.stage.idea;
    case 'intake_complete':
      return theme.tui.stage.intakeComplete;
    case 'plan_complete':
      return theme.tui.stage.planComplete;
    case 'in_progress':
      return theme.tui.stage.inProgress;
    case 'in_review':
      return theme.tui.stage.inReview;
    case 'done':
      return theme.tui.stage.done;
    default:
      return theme.tui.stage.idea; // default to idea/gray-fg colour
  }
}

// Render a work item title with the color appropriate to its status or stage (console output)
// Blocked items always appear red, regardless of stage. Otherwise, stage-based colours apply.
function renderTitle(item: WorkItem, prefix: string = ''): string {
  // Blocked status overrides everything
  if (item.status === 'blocked') {
    return theme.blocked(prefix + item.title);
  }
  // Use stage-based colour; fallback to idea/gray when stage is undefined or empty
  const colorFn = titleColorForStage(item.stage || undefined);
  return colorFn(prefix + item.title);
}

// Render a work item title with blessed markup colors for TUI output
// Blocked items always appear red, regardless of stage. Otherwise, stage-based colours apply.
function renderTitleTUI(item: WorkItem, prefix: string = ''): string {
  // Blocked status overrides everything
  if (item.status === 'blocked') {
    return theme.tui.blocked(prefix + item.title);
  }
  // Use stage-based colour; fallback to idea/gray when stage is undefined or empty
  const colorFn = titleColorForStageTUI(item.stage || undefined);
  return colorFn(prefix + item.title);
}

// Helper to display work items in a tree structure
/**
 * @deprecated Use `displayItemTreeWithFormat(items, db, format)` which delegates
 * to the human formatter and keeps `list` and `show` outputs consistent.
 */
export function displayItemTree(items: WorkItem[]): void {
  walkItemTree(items, {
    sortRootItems: list => list.slice().sort(sortByPriorityAndDate),
    sortChildItems: list => list.slice().sort(sortByPriorityDateAndId),
    render: (item, { indent, isLast, inheritedStage }) => {
      const prefix = indent + (isLast ? '└── ' : '├── ');
      console.log(formatTitleAndId(item, prefix));

      const detailIndent = indent + (isLast ? '    ' : '│   ');
      const effectiveStage = item.stage ?? inheritedStage;
      const statusSummary = effectiveStage
        ? `Status: ${item.status} · Stage: ${effectiveStage} | Priority: ${item.priority}`
        : `Status: ${item.status} | Priority: ${item.priority}`;
      console.log(`${detailIndent}${statusSummary}`);
      console.log(`${detailIndent}Risk: ${item.risk || '—'}`);
      console.log(`${detailIndent}Effort: ${item.effort || '—'}`);
      if (item.assignee) console.log(`${detailIndent}Assignee: ${item.assignee}`);
      if (item.tags.length > 0) console.log(`${detailIndent}Tags: ${item.tags.join(', ')}`);
    }
  });
}

// Display work items using the human formatter but preserve tree hierarchy
export function displayItemTreeWithFormat(items: WorkItem[], db: WorklogDatabase | null, format: string): void {
  const itemIds = new Set(items.map(i => i.id));
  const orderedItems = db
    ? db.getAllOrderedByHierarchySortIndex().filter(item => itemIds.has(item.id))
    : null;
  const sortChildren = (list: WorkItem[]): WorkItem[] => {
    if (!orderedItems) {
      return list.slice().sort(sortByPriorityAndDate);
    }
    const positions = new Map(orderedItems.map((item, index) => [item.id, index]));
    return list
      .slice()
      .sort((a, b) => {
        const aPos = positions.get(a.id);
        const bPos = positions.get(b.id);
        if (aPos === undefined && bPos === undefined) {
          return sortByPriorityAndDate(a, b);
        }
        if (aPos === undefined) return 1;
        if (bPos === undefined) return -1;
        if (aPos !== bPos) return aPos - bPos;
        return sortByPriorityAndDate(a, b);
      });
  };

  walkItemTree(items, {
    sortRootItems: sortChildren,
    sortChildItems: sortChildren,
    render: (item, { indent, isLast, inheritedStage }) => {
      const prefix = indent + (isLast ? '└── ' : '├── ');
      const detailIndent = indent + (isLast ? '    ' : '│   ');

      // If the item doesn't have an explicit stage, fall back to an inherited stage
      const displayItem = Object.assign({}, item, { stage: item.stage ?? inheritedStage });
      // Normalize empty-string stage to explicit empty so downstream logic can detect it
      if (displayItem.stage === '') {
        // keep as empty string to signal 'Undefined' label
      }
      const formatted = humanFormatWorkItem(displayItem, db, format);
      const lines = formatted.split('\n');
      // First line gets the tree marker prefix
      console.log(prefix + lines[0]);
      // Subsequent lines align under the detail indent
      for (let i = 1; i < lines.length; i++) {
        console.log(detailIndent + lines[i]);
      }
    }
  });
}

/**
 * Render the same tree output as `displayItemTreeWithFormat` but return it as
 * a single string instead of printing directly. This is useful when callers
 * wish to pipe the output through a pager or otherwise capture it.
 */
export function displayItemTreeWithFormatToString(items: WorkItem[], db: WorklogDatabase | null, format: string): string {
  const outLines: string[] = [];
  const itemIds = new Set(items.map(i => i.id));
  const orderedItems = db
    ? db.getAllOrderedByHierarchySortIndex().filter(item => itemIds.has(item.id))
    : null;
  const sortChildren = (list: WorkItem[]): WorkItem[] => {
    if (!orderedItems) {
      return list.slice().sort(sortByPriorityAndDate);
    }
    const positions = new Map(orderedItems.map((item, index) => [item.id, index]));
    return list
      .slice()
      .sort((a, b) => {
        const aPos = positions.get(a.id);
        const bPos = positions.get(b.id);
        if (aPos === undefined && bPos === undefined) {
          return sortByPriorityAndDate(a, b);
        }
        if (aPos === undefined) return 1;
        if (bPos === undefined) return -1;
        if (aPos !== bPos) return aPos - bPos;
        return sortByPriorityAndDate(a, b);
      });
  };

  walkItemTree(items, {
    sortRootItems: sortChildren,
    sortChildItems: sortChildren,
    render: (item, { indent, isLast, inheritedStage }) => {
      const prefix = indent + (isLast ? '└── ' : '├── ');
      const detailIndent = indent + (isLast ? '    ' : '│   ');

      const displayItem = Object.assign({}, item, { stage: item.stage ?? inheritedStage });
      if (displayItem.stage === '') {
        // keep as empty string to signal 'Undefined' label
      }
      const formatted = humanFormatWorkItem(displayItem, db, format);
      const lines = formatted.split('\n');
      outLines.push(prefix + lines[0]);
      for (let i = 1; i < lines.length; i++) {
        outLines.push(detailIndent + lines[i]);
      }
    }
  });

  return outLines.join('\n');
}

type TreeRenderContext = {
  indent: string;
  isLast: boolean;
  inheritedStage?: string;
};

type TreeRenderOptions = {
  sortRootItems: (items: WorkItem[]) => WorkItem[];
  sortChildItems: (items: WorkItem[]) => WorkItem[];
  render: (item: WorkItem, context: TreeRenderContext) => void;
};

function walkItemTree(items: WorkItem[], options: TreeRenderOptions): void {
  const itemIds = new Set(items.map(item => item.id));
  const childrenByParent = new Map<string | null, WorkItem[]>();

  for (const item of items) {
    const parentKey = item.parentId && itemIds.has(item.parentId) ? item.parentId : null;
    const list = childrenByParent.get(parentKey) ?? [];
    list.push(item);
    childrenByParent.set(parentKey, list);
  }

  const rootItems = options.sortRootItems(childrenByParent.get(null) ?? []);

  const visit = (item: WorkItem, indent: string, isLast: boolean, inheritedStage?: string) => {
    options.render(item, { indent, isLast, inheritedStage });

    const detailIndent = indent + (isLast ? '    ' : '│   ');
    const effectiveStage = item.stage ?? inheritedStage;
    const children = childrenByParent.get(item.id);
    if (!children || children.length === 0) return;

    const orderedChildren = options.sortChildItems(children);
    orderedChildren.forEach((child, index) => {
      const last = index === orderedChildren.length - 1;
      visit(child, detailIndent, last, effectiveStage);
    });
  };

  rootItems.forEach((item, index) => {
    const isLastItem = index === rootItems.length - 1;
    visit(item, '', isLastItem, undefined);
  });
}

// Helper to apply color to audit excerpt based on readiness status
// Redaction must happen BEFORE applying color
function colorizeAuditExcerpt(auditText: string, tui?: boolean): string {
  const firstLine = auditText.split(/\r?\n/, 1)[0];
  const isTui = Boolean(tui);
  if (firstLine.includes('Ready to close: Yes')) {
    return isTui ? theme.tui.text.readyYes(firstLine) : theme.text.readyYes(firstLine);
  }
  return isTui ? theme.tui.text.readyNo(firstLine) : theme.text.readyNo(firstLine);
}

// Standard human formatter: supports 'summary' | 'concise' | 'normal' | 'full' | 'raw' | 'markdown' | 'auto'
export function humanFormatWorkItem(item: WorkItem, db: WorklogDatabase | null, format: string | undefined, tui?: boolean): string {
  // Load config once and reuse for both humanDisplay and cliFormatMarkdown
  const config = loadConfig();

  // Read audit result from the dedicated table (sole source of truth)
  const auditResult = db ? db.getAuditResult(item.id) : null;

  // Resolve 'auto' and 'markdown' format values
  let fmt = (format || config?.humanDisplay || 'full').toLowerCase();
  let markdownEnabled = false;

  // Track if the format explicitly disables or enables markdown rendering.
  // These flags prevent config from overriding explicit CLI choices.
  let explicitDisabled = false;
  let explicitAuto = false;

  // 'markdown' format means: render full output through the markdown renderer
  if (fmt === 'markdown') {
    fmt = 'full';
    markdownEnabled = true;
  }
  // 'auto' means: use markdown rendering if TTY, otherwise plain full
  if (fmt === 'auto') {
    fmt = 'full';
    explicitAuto = true;
  }
  // 'text' or 'plain' format means: plain text, no markdown
  if (fmt === 'text' || fmt === 'plain') {
    fmt = 'full';
    explicitDisabled = true;
  }

  // Use the shared precedence resolver when no explicit markdown/plain/text/auto
  // flag was specified. This preserves the CLI > config > auto-detect chain.
  if (!markdownEnabled && !explicitDisabled && !explicitAuto) {
    const resolved = resolveMarkdownEnabled({
      format: undefined, // format is already resolved into fmt/explicit flags above
      cliFormatMarkdown: config?.cliFormatMarkdown,
    });
    if (resolved === true) {
      markdownEnabled = true;
    } else if (resolved === false) {
      markdownEnabled = false;
    } else {
      // undefined: auto-detect from TTY
      markdownEnabled = isTty();
    }
  }

  const isTui = Boolean(tui);
  const sortIndexLabel = `SortIndex: ${item.sortIndex}`;
  const rules = loadStatusStageRules();

  // Helper to format status line with icon (for CLI with fallback, TUI without)
  const formatStatusWithIcon = (status: string): string => {
    if (isTui) {
      // TUI: just show status value, icons are in the metadata pane instead
      return getStatusLabel(status, rules) || status;
    }
    const icon = statusIcon(status, { noIcons: !iconsEnabled() });
    const fallback = statusFallback(status);
    const label = getStatusLabel(status, rules) || status;
    return icon ? `${icon} ${label} ${fallback}` : label;
  };

  // Helper to format priority line with icon (for CLI with fallback, TUI without)
  const formatPriorityWithIcon = (priority: string): string => {
    if (isTui) {
      // TUI: just show priority value, icons are in the metadata pane instead
      return priority;
    }
    const icon = priorityIcon(priority, { noIcons: !iconsEnabled() });
    const fallback = priorityFallback(priority);
    return icon ? `${icon} ${priority} ${fallback}` : priority;
  };

  const lines: string[] = [];
  const titleLine = `Title: ${isTui ? formatTitleOnlyTUI(item) : formatTitleOnly(item)}`;
  const idLine = `ID:    ${isTui ? theme.tui.text.muted(item.id) : theme.text.muted(item.id)}`;

  // summary: truly minimal - just title, status, priority
  if (fmt === 'summary') {
    const lines: string[] = [];
    lines.push(`${isTui ? formatTitleOnlyTUI(item) : formatTitleOnly(item)} ${isTui ? theme.tui.text.muted(item.id) : theme.text.muted(item.id)}`);
    if (isTui) {
      const statusLabel = getStatusLabel(item.status, rules) || item.status;
      lines.push(`Status: ${statusLabel} | Priority: ${item.priority || '—'}`);
    } else {
      const sLine = formatStatusWithIcon(item.status);
      lines.push(`Status: ${sLine} | Priority: ${formatPriorityWithIcon(item.priority)}`);
    }
    return lines.join('\n');
  }

  if (fmt === 'raw') {
    return JSON.stringify(item, null, 2);
  }

    if (fmt === 'concise') {
      const lines: string[] = [];
      // First line: title + id (compact)
      lines.push(`${isTui ? formatTitleOnlyTUI(item) : formatTitleOnly(item)} ${isTui ? theme.tui.text.muted(item.id) : theme.text.muted(item.id)}`);
    // Second line: status, stage (if present) and priority (core metadata shown previously by list)
    if (item.stage !== undefined) {
      const stageLabel = item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage;
      const statusLabel = getStatusLabel(item.status, rules) || item.status;
      if (isTui) {
        lines.push(`Status: ${statusLabel} · Stage: ${stageLabel} | Priority: ${item.priority}`);
      } else {
        lines.push(`Status: ${formatStatusWithIcon(item.status)} · Stage: ${stageLabel} | Priority: ${formatPriorityWithIcon(item.priority)}`);
      }
    } else {
      if (isTui) {
        const statusLabel = getStatusLabel(item.status, rules) || item.status;
        lines.push(`Status: ${statusLabel} | Priority: ${item.priority}`);
      } else {
        lines.push(`Status: ${formatStatusWithIcon(item.status)} | Priority: ${formatPriorityWithIcon(item.priority)}`);
      }
    }
    lines.push(sortIndexLabel);
    lines.push(`Risk: ${item.risk || '—'}`);
    lines.push(`Effort: ${item.effort || '—'}`);
    if (item.assignee) lines.push(`Assignee: ${item.assignee}`);
      if (auditResult) {
      // For human outputs, show a truncated, redacted one-line audit excerpt.
      // Do not include the author in concise output to keep it compact.
        const raw = String(auditResult.summary || '');
        const redacted = redactAuditText(raw);
        const colorized = colorizeAuditExcerpt(redacted, isTui);
        lines.push(`Audit: ${colorized}`);
      // Non-blocking warning: if the audit was downgraded to Missing Criteria
      // because the item lacks acceptance criteria, surface a subtle warning
      // in normal/concise human outputs so operators notice without failing
      // the write. This is intentionally non-fatal and mirrors the
      // conservative policy implemented in buildAuditEntry.
      if (!auditResult.readyToClose && !auditResult.summary?.startsWith('Ready to close:')) {
        lines.push(`Warning: Audit claim could not be verified (Missing Criteria)`);
      }
    }
    if (item.tags && item.tags.length > 0) lines.push(`Tags: ${item.tags.join(', ')}`);
    return lines.join('\n');
  }

  // normal output
  if (fmt === 'normal') {
    lines.push(idLine);
    lines.push(titleLine);
    if (item.stage !== undefined) {
      const stageLabel = item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage;
      if (isTui) {
        const statusLabel = getStatusLabel(item.status, rules) || item.status;
        lines.push(`Status: ${statusLabel} · Stage: ${stageLabel} | Priority: ${item.priority}`);
      } else {
        lines.push(`Status: ${formatStatusWithIcon(item.status)} · Stage: ${stageLabel} | Priority: ${formatPriorityWithIcon(item.priority)}`);
      }
    } else {
      if (isTui) {
        const statusLabel = getStatusLabel(item.status, rules) || item.status;
        lines.push(`Status: ${statusLabel} | Priority: ${item.priority}`);
      } else {
        lines.push(`Status: ${formatStatusWithIcon(item.status)} | Priority: ${formatPriorityWithIcon(item.priority)}`);
      }
    }
    lines.push(sortIndexLabel);
    lines.push(`Risk: ${item.risk || '—'}`);
    lines.push(`Effort: ${item.effort || '—'}`);
    if (item.assignee) lines.push(`Assignee: ${item.assignee}`);
      if (auditResult) {
        const raw = String(auditResult.summary || '');
        const redacted = redactAuditText(raw);
        const colorized = colorizeAuditExcerpt(redacted, isTui);
        // Keep concise audit excerpt in normal output as well (author omitted).
        lines.push(`Audit: ${colorized}`);
      }
    if (item.parentId) lines.push(`Parent: ${item.parentId}`);
    if (item.description) lines.push(`Description: ${item.description}`);
    return lines.join('\n');
  }

  // detail-pane: title + description + comments only (metadata is in the metadata pane)
  if (fmt === 'detail-pane') {
    lines.push(isTui ? renderTitleTUI(item, '# ') : renderTitle(item, '# '));

    if (item.description) {
      lines.push('');
      lines.push('## Description');
      lines.push('');
      lines.push(item.description);
    }

    if (db) {
      const comments = db.getCommentsForWorkItem(item.id);
      if (comments.length > 0) {
        lines.push('');
        lines.push('## Comments');
        lines.push('');
        for (const c of comments) {
          lines.push(`  ${c.author} at ${c.createdAt}`);
          lines.push(`    ${c.comment}`);
        }
      }
    }

    return lines.join('\n');
  }

  // full output
  lines.push(isTui ? renderTitleTUI(item, '# ') : renderTitle(item, '# '));
  lines.push('');
  const issueTypeLabel = item.issueType && item.issueType.trim() !== '' ? item.issueType : 'unknown';
  // Build status/priority line with icons for CLI, plain for TUI
  const statusPriorityValue = item.stage !== undefined
    ? (isTui
        ? `${getStatusLabel(item.status, rules) || item.status} · Stage: ${item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage} | Priority: ${item.priority}`
        : `${formatStatusWithIcon(item.status)} · Stage: ${item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage} | Priority: ${formatPriorityWithIcon(item.priority)}`)
    : (isTui
        ? `${getStatusLabel(item.status, rules) || item.status} | Priority: ${item.priority}`
        : `${formatStatusWithIcon(item.status)} | Priority: ${formatPriorityWithIcon(item.priority)}`);
  const frontmatter: Array<[string, string]> = [
    ['ID', isTui ? theme.tui.text.muted(item.id) : theme.text.muted(item.id)],
    ['Status', statusPriorityValue],
    ['Type', issueTypeLabel],
    ['SortIndex', String(item.sortIndex)]
  ];
  if (item.risk) frontmatter.push(['Risk', item.risk]);
  else frontmatter.push(['Risk', '—']);
  if (item.effort) frontmatter.push(['Effort', item.effort]);
  else frontmatter.push(['Effort', '—']);
  if (item.assignee) frontmatter.push(['Assignee', item.assignee]);
  if (item.parentId) frontmatter.push(['Parent', item.parentId]);
  if (item.tags && item.tags.length > 0) frontmatter.push(['Tags', item.tags.join(', ')]);
  const labelWidth = frontmatter.reduce((max, [label]) => Math.max(max, label.length), 0);
  frontmatter.forEach(([label, value]) => {
    lines.push(`${label.padEnd(labelWidth)}: ${value}`);
  });

  if (item.description) {
    lines.push('');
    lines.push('## Description');
    lines.push('');
    lines.push(item.description);
  }

  if (item.stage) {
    lines.push('');
    lines.push('## Stage');
    lines.push('');
    lines.push(item.stage);
  }

  if (db) {
      // Ensure comments are presented newest-first in human output as well.
      const comments = db.getCommentsForWorkItem(item.id);
      if (comments.length > 0) {
        lines.push('');
        lines.push('## Comments');
        lines.push('');
        for (const c of comments) {
          // IDs are internal-only for human display; omit them here per WL-0MKZ5IR3H0O4M8GD.
          lines.push(`  ${c.author} at ${c.createdAt}`);
          lines.push(`    ${c.comment}`);
        }
      }
    }

  if (auditResult) {
    lines.push('');
    lines.push('## Audit');
    lines.push('');
    lines.push(`Ready to close: ${auditResult.readyToClose ? 'Yes' : 'No'}`);
    lines.push(`Audited at: ${auditResult.auditedAt}`);
    if (auditResult.author) lines.push(`Author: ${auditResult.author}`);
    if (auditResult.summary) {
      const redacted = redactAuditText(auditResult.summary);
      const colorizedFirstLine = colorizeAuditExcerpt(redacted, isTui);
      const remainingLines = redacted.split(/\r?\n/).slice(1).join('\n');
      const coloredText = remainingLines ? `${colorizedFirstLine}\n${remainingLines}` : colorizedFirstLine;
      lines.push('');
      lines.push(coloredText);
    }
  }

  const result = lines.join('\n');

  // If markdown rendering is enabled, render the full output through the CLI renderer
  if (markdownEnabled && !isTui) {
    return renderCliMarkdown(result, { formatAsMarkdown: true });
  }

  return result;
}

// Resolve final format choice: CLI override > provided > config > default
export function resolveFormat(program: Command, provided?: string): string {
  const cliFormat = program.opts().format;
  if (cliFormat && typeof cliFormat === 'string' && cliFormat.trim() !== '') return cliFormat;
  if (provided && provided.trim() !== '') return provided;
  return loadConfig()?.humanDisplay || 'full';
}

// Human formatter for comments
export function humanFormatComment(comment: Comment, format?: string): string {
  const fmt = (format || loadConfig()?.humanDisplay || 'full').toLowerCase();
  if (fmt === 'raw') return JSON.stringify(comment, null, 2);
  if (fmt === 'concise') {
    const excerpt = comment.comment.split('\n')[0];
    return `${theme.text.muted('[' + comment.id + ']')} ${comment.author} - ${excerpt}`;
  }

  const lines: string[] = [];
  lines.push(`ID:      ${theme.text.muted(comment.id)}`);
  lines.push(`Author:  ${comment.author}`);
  lines.push(`Created: ${comment.createdAt}`);
  lines.push('');
  lines.push(comment.comment);
  if (comment.references && comment.references.length > 0) {
    lines.push('');
    lines.push(`References: ${comment.references.join(', ')}`);
  }
  return lines.join('\n');
}

// Display detailed conflict information with color coding
export function displayConflictDetails(
  result: SyncResult,
  mergedItems: WorkItem[],
  options?: { repoUrl?: string }
): void {
  if (result.conflictDetails.length === 0) {
    console.log('\n' + theme.text.success('✓ No conflicts detected'));
    return;
  }

  console.log('\n' + theme.text.strong('Conflict Resolution Details:'));
  if (options?.repoUrl) {
    console.log(theme.text.muted(options.repoUrl));
  }
  console.log(theme.text.muted('━'.repeat(80)));
  
  const itemsById = new Map(mergedItems.map(item => [item.id, item]));
  
  result.conflictDetails.forEach((conflict: any, index: number) => {
    const workItem = itemsById.get(conflict.itemId);
    const displayText = workItem ? `${formatTitleOnly(workItem)} (${conflict.itemId})` : conflict.itemId;
    console.log(theme.text.strong(`\n${index + 1}. Work Item: ${displayText}`));
    
    if (conflict.conflictType === 'same-timestamp') {
      console.log(theme.text.warning(`   Same timestamp (${conflict.localUpdatedAt}) - merged deterministically`));
    } else {
      console.log(`   Local updated: ${conflict.localUpdatedAt || 'unknown'}`);
      console.log(`   Remote updated: ${conflict.remoteUpdatedAt || 'unknown'}`);
    }
    
    console.log();
    
    conflict.fields.forEach((field: any) => {
      console.log(theme.text.strong(`   Field: ${field.field}`));
      
      if (field.chosenSource === 'merged') {
        console.log(theme.text.info(`     Local:  ${formatValue(field.localValue)}`));
        console.log(theme.text.info(`     Remote: ${formatValue(field.remoteValue)}`));
        console.log(theme.text.success(`     Merged: ${formatValue(field.chosenValue)}`));
      } else {
        if (field.chosenSource === 'local') {
          console.log(theme.text.success(`   ✓ Local:  ${formatValue(field.localValue)}`));
          console.log(theme.text.error(`   ✗ Remote: ${formatValue(field.remoteValue)}`));
        } else {
          console.log(theme.text.error(`   ✗ Local:  ${formatValue(field.localValue)}`));
          console.log(theme.text.success(`   ✓ Remote: ${formatValue(field.remoteValue)}`));
        }
      }

      console.log(theme.text.muted(`     Reason: ${field.reason}`));
      console.log();
    });
  });

  console.log(theme.text.muted('━'.repeat(80)));
}
