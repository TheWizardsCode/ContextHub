/**
 * Shared widget helper functions for the worklog widgets.
 *
 * These are pure functions that can be tested independently of the Pi runtime.
 * Both the Pi extension and the unit tests import from this module.
 */

export interface WorkItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee?: string;
  stage?: string;
  issueType?: string;
  description?: string;
}

/**
 * Get a status icon character for the given status.
 */
export function getStatusIcon(status: string): string {
  switch (status) {
    case 'in_progress': return '◐';
    case 'completed': return '✓';
    case 'blocked': return '⊘';
    default: return '○';
  }
}

/**
 * Truncate text to fit within maxLen characters.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Build the numbered work item list widget lines.
 *
 * @param width - Available width in characters
 * @param items - Work items to display
 * @param selectedIndex - Index of the currently selected item (0-based)
 * @returns Array of line strings for rendering
 */
export function buildWorklogWidgetLines(
  width: number,
  items: WorkItem[],
  selectedIndex: number
): string[] {
  const maxIndex = Math.min(items.length, 9);
  if (maxIndex === 0) return ['  No work items found'];

  const lines: string[] = [];
  lines.push(' Work Items (Ctrl+1-9 select, Ctrl+Up/Down cycle):');

  for (let i = 0; i < maxIndex; i++) {
    const item = items[i];
    const marker = i === selectedIndex ? '▸' : ' ';
    const num = i + 1;
    const statusIcon = getStatusIcon(item.status);
    const title = truncate(item.title, width - 12);
    lines.push(`  ${marker} ${num}: ${statusIcon} ${title}`);
  }

  if (items.length > 9) {
    lines.push(`  ... and ${items.length - 9} more (/worklog-select for full access)`);
  }

  return lines;
}

/**
 * Build the details widget lines for the selected item.
 *
 * @param width - Available width in characters
 * @param item - The selected work item (or null)
 * @returns Array of line strings for rendering
 */
export function buildWorklogDetailsLines(
  width: number,
  item: WorkItem | null
): string[] {
  if (!item) return ['  No item selected'];

  const lines: string[] = [];
  lines.push(` ${item.id}`);
  lines.push(` Title:    ${truncate(item.title, width - 12)}`);
  lines.push(` Status:   ${item.status}`);
  lines.push(` Priority: ${item.priority}`);
  if (item.assignee) lines.push(` Assignee: ${item.assignee}`);
  if (item.stage) lines.push(` Stage:    ${item.stage}`);
  if (item.issueType) lines.push(` Type:     ${item.issueType}`);

  // Description excerpt
  if (item.description) {
    const excerpt = truncate(
      item.description.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim(),
      width - 12
    );
    lines.push(` Summary:  ${excerpt}`);
  }

  return lines;
}
