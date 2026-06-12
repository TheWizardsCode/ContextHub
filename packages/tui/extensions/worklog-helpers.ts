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
 * Theme interface matching the Pi TUI theme.fg() API.
 */
export interface PiTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

/**
 * Get the theme colour token for a given work item stage.
 *
 * Stage progression maps to Pi TUI theme tokens:
 * - idea → dim (muted/low priority)
 * - intake_complete → mdLink (blue-like)
 * - plan_complete → accent (cyan-like)
 * - in_progress → warning (yellow)
 * - in_review → success (green)
 * - done → text (default/white)
 *
 * @param stage - The work item stage (lowercase with underscores)
 * @returns The Pi TUI theme colour token name
 */
export function stageColourToken(stage?: string): string {
  const s = (stage || '').toLowerCase().trim();
  switch (s) {
    case 'idea':
      return 'dim';
    case 'intake_complete':
      return 'mdLink'; // blue-like (#81a2be)
    case 'plan_complete':
      return 'accent'; // cyan-like (#8abeb7)
    case 'in_progress':
      return 'warning';
    case 'in_review':
      return 'success';
    case 'done':
      return 'text';
    default:
      return 'dim'; // default to dim for unknown/undefined stages
  }
}

/**
 * Apply stage-based colour to text using the Pi TUI theme.
 *
 * Blocked work items appear in red regardless of stage.
 * Otherwise, stage-based colours apply.
 *
 * @param text - The text to colour
 * @param stage - The work item stage
 * @param status - The work item status
 * @param theme - The Pi TUI theme object
 * @returns The coloured text string
 */
export function applyStageColour(
  text: string,
  stage?: string,
  status?: string,
  theme?: PiTheme,
): string {
  if (!theme) return text;
  // Blocked status overrides everything
  if (status === 'blocked') {
    return theme.fg('error', text);
  }
  const token = stageColourToken(stage);
  return theme.fg(token, text);
}

/**
 * Get a status icon character for the given status.
 */
export function getStatusIcon(status: string): string {
  switch (status) {
    case 'open': return '🟢';
    case 'in_progress': return '🔄';
    case 'completed': return '✅';
    case 'blocked': return '⛔';
    case 'deleted': return '🗑️';
    default: return '○';
  }
}

/**
 * Truncate text to fit within maxLen characters.
 */
/**
 * Truncate text to fit within maxLen visible characters.
 * Handles emoji (2 columns each) and ANSI escape codes.
 */
export function truncate(text: string, maxLen: number): string {
  const visibleWidth = (s: string): number => {
    // Strip ANSI codes
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
    // Count codepoints - emoji are 2 columns, other chars are 1
    let width = 0;
    for (const c of stripped) {
      const cp = c.codePointAt(0) || 0;
      // Emoji and special symbol ranges that take 2 terminal columns
      const isEmoji = (cp >= 0x1F300 && cp <= 0x1F9FF) || (cp >= 0x2600 && cp <= 0x27BF);
      width += isEmoji ? 2 : 1;
    }
    return width;
  };

  if (visibleWidth(text) <= maxLen) return text;

  let result = '';
  let w = 0;
  for (const c of text) {
    const cp = c.codePointAt(0) || 0;
    const charWidth = ((cp >= 0x1F300 && cp <= 0x1F9FF) || (cp >= 0x2600 && cp <= 0x27BF)) ? 2 : 1;
    if (w + charWidth + 3 > maxLen) break; // Reserve space for "..."
    result += c;
    w += charWidth;
  }
  return result + '...';
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

  // Emoji icons (no blessed tags - Pi handles styling)
  const statusIcon = getStatusIcon(item.status);
  const priorityIcon = getPriorityIcon(item.priority);

  const lines: string[] = [];
  lines.push(` ${item.id}`);
  lines.push(` Title:    ${truncate(item.title, width - 12)}`);
  lines.push(` Status:   ${statusIcon} ${item.status}`);
  lines.push(` Priority: ${priorityIcon} ${item.priority || '—'}`);
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

/**
 * Get a priority icon character for the given priority.
 */
function getPriorityIcon(priority: string | undefined): string {
  if (!priority) return '';
  switch (priority.toLowerCase()) {
    case 'critical': return '🚨';
    case 'high': return '⭐';
    case 'medium': return '📋';
    case 'low': return '🐢';
    default: return '';
  }
}
