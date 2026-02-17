/**
 * Shared helper functions for CLI commands
 */

import { theme } from '../theme.js';
import type { WorkItem, Comment } from '../types.js';
import type { SyncResult } from '../sync.js';
import type { WorklogDatabase } from '../database.js';
import { loadConfig } from '../config.js';
import { getStageLabel, getStatusLabel, loadStatusStageRules } from '../status-stage-rules.js';
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

// Return a chalk function appropriate for a given status (for console output)
function titleColorForStatus(status?: string): (text: string) => string {
  const s = (status || '').toLowerCase().trim().replace(/_/g, '-');
  switch (s) {
    case 'completed':
      return theme.status.completed;
    case 'in-progress':
    case 'in progress':
      return theme.status.inProgress;
    case 'blocked':
      return theme.status.blocked;
    case 'open':
    default:
      return theme.status.open;
  }
}

// Return blessed markup tags appropriate for a given status (for TUI output)
function titleColorForStatusTUI(status?: string): (text: string) => string {
  const s = (status || '').toLowerCase().trim().replace(/_/g, '-');
  switch (s) {
    case 'completed':
      return theme.tui.status.completed;
    case 'in-progress':
    case 'in progress':
      return theme.tui.status.inProgress;
    case 'blocked':
      return theme.tui.status.blocked;
    case 'open':
    default:
      return theme.tui.status.open;
  }
}

// Render a work item title with the color appropriate to its status (console output)
function renderTitle(item: WorkItem, prefix: string = ''): string {
  return titleColorForStatus(item.status)(prefix + item.title);
}

// Render a work item title with blessed markup colors for TUI output
function renderTitleTUI(item: WorkItem, prefix: string = ''): string {
  return titleColorForStatusTUI(item.status)(prefix + item.title);
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
      if (item.risk) console.log(`${detailIndent}Risk: ${item.risk}`);
      if (item.effort) console.log(`${detailIndent}Effort: ${item.effort}`);
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

// Standard human formatter: supports 'concise' | 'normal' | 'full' | 'raw'
export function humanFormatWorkItem(item: WorkItem, db: WorklogDatabase | null, format: string | undefined): string {
  const fmt = (format || loadConfig()?.humanDisplay || 'concise').toLowerCase();
  const sortIndexLabel = `SortIndex: ${item.sortIndex}`;
  const rules = loadStatusStageRules();

  const lines: string[] = [];
  const titleLine = `Title: ${formatTitleOnly(item)}`;
  const idLine = `ID:    ${theme.text.muted(item.id)}`;

  if (fmt === 'raw') {
    return JSON.stringify(item, null, 2);
  }

  if (fmt === 'concise') {
    const lines: string[] = [];
    // First line: title + id (compact)
    lines.push(`${formatTitleOnly(item)} ${theme.text.muted(item.id)}`);
    // Second line: status, stage (if present) and priority (core metadata shown previously by list)
    if (item.stage !== undefined) {
      const stageLabel = item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage;
      const statusLabel = getStatusLabel(item.status, rules) || item.status;
      lines.push(`Status: ${statusLabel} · Stage: ${stageLabel} | Priority: ${item.priority}`);
    } else {
      const statusLabel = getStatusLabel(item.status, rules) || item.status;
      lines.push(`Status: ${statusLabel} | Priority: ${item.priority}`);
    }
    lines.push(sortIndexLabel);
    if (item.risk) lines.push(`Risk: ${item.risk}`);
    if (item.effort) lines.push(`Effort: ${item.effort}`);
    if (item.assignee) lines.push(`Assignee: ${item.assignee}`);
    if (item.tags && item.tags.length > 0) lines.push(`Tags: ${item.tags.join(', ')}`);
    return lines.join('\n');
  }

  // normal output
  if (fmt === 'normal') {
    lines.push(idLine);
    lines.push(titleLine);
    if (item.stage !== undefined) {
      const stageLabel = item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage;
      const statusLabel = getStatusLabel(item.status, rules) || item.status;
      lines.push(`Status: ${statusLabel} · Stage: ${stageLabel} | Priority: ${item.priority}`);
    } else {
      const statusLabel = getStatusLabel(item.status, rules) || item.status;
      lines.push(`Status: ${statusLabel} | Priority: ${item.priority}`);
    }
    lines.push(sortIndexLabel);
    if (item.risk) lines.push(`Risk: ${item.risk}`);
    if (item.effort) lines.push(`Effort: ${item.effort}`);
    if (item.assignee) lines.push(`Assignee: ${item.assignee}`);
    if (item.parentId) lines.push(`Parent: ${item.parentId}`);
    if (item.description) lines.push(`Description: ${item.description}`);
    return lines.join('\n');
  }

  // full output
  lines.push(renderTitle(item, '# '));
  lines.push('');
  const issueTypeLabel = item.issueType && item.issueType.trim() !== '' ? item.issueType : 'unknown';
  const frontmatter: Array<[string, string]> = [
    ['ID', theme.text.muted(item.id)],
    ['Status', item.stage !== undefined ? `${getStatusLabel(item.status, rules) || item.status} · Stage: ${item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules) || item.stage} | Priority: ${item.priority}` : `${getStatusLabel(item.status, rules) || item.status} | Priority: ${item.priority}`],
    ['Type', issueTypeLabel],
    ['SortIndex', String(item.sortIndex)]
  ];
  if (item.risk) frontmatter.push(['Risk', item.risk]);
  if (item.effort) frontmatter.push(['Effort', item.effort]);
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
          lines.push(`  [${c.id}] ${c.author} at ${c.createdAt}`);
          lines.push(`    ${c.comment}`);
        }
      }
    }

  return lines.join('\n');
}

// Resolve final format choice: CLI override > provided > config > default
export function resolveFormat(program: Command, provided?: string): string {
  const cliFormat = program.opts().format;
  if (cliFormat && typeof cliFormat === 'string' && cliFormat.trim() !== '') return cliFormat;
  if (provided && provided.trim() !== '') return provided;
  return loadConfig()?.humanDisplay || 'concise';
}

// Human formatter for comments
export function humanFormatComment(comment: Comment, format?: string): string {
  const fmt = (format || loadConfig()?.humanDisplay || 'concise').toLowerCase();
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
