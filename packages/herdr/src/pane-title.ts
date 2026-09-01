/**
 * packages/herdr/src/pane-title.ts — shared pane-title construction
 * (WL-0MSJ4E8UA005KG9Y)
 *
 * Centralized pane-title builders shared by the manual spawn paths
 * (index.ts), the shell-command path (index.ts → run-in-pane.sh) and the
 * downtime dispatcher (downtime-worker.ts), so every pi pane follows one
 * naming convention with bounded length.
 */

/** Maximum pane title length — kept short so it fits in the Herdr UI. */
export const MAX_PANE_TITLE_LENGTH = 60;

/** Truncate a pane title to the maximum length, appending '…' when needed. */
export function truncatePaneTitle(title: string): string {
  if (title.length <= MAX_PANE_TITLE_LENGTH) return title;
  return title.substring(0, MAX_PANE_TITLE_LENGTH - 1) + '…';
}

/**
 * Check if a command is an agent command that opens a pi agent pane
 * (`/skill:*`, `/intake`, `/plan`, `/prompt:`).
 */
export function isAgentCommand(command: string): boolean {
  return (
    command.startsWith('/skill:') ||
    command.startsWith('/intake') ||
    command.startsWith('/plan') ||
    command.startsWith('/prompt:')
  );
}

/**
 * Extract the skill name from an agent command string.
 *
 * - `/skill:implement` → `'implement'`
 * - `/skill:audit`     → `'audit'`
 * - `/intake`          → `'intake'`
 * - `/plan`            → `'plan'`
 * - `/prompt:…`        → `null` (free-form — caller uses 'prompt')
 * - anything else      → `null`
 *
 * @param command - Raw agent command.
 * @returns The skill token or `null` when not applicable.
 */
export function stripSkillName(command: string): string | null {
  if (command.startsWith('/skill:')) {
    const after = command.substring('/skill:'.length).trim();
    const token = after.split(/[\s]/)[0];
    return token || null;
  }
  if (command.startsWith('/intake')) return 'intake';
  if (command.startsWith('/plan')) return 'plan';
  if (command.startsWith('/prompt:')) return null;
  return null;
}

/**
 * Strip the `/prompt:` routing prefix from a free-form prompt command.
 *
 * `/prompt:` commands are routed to the agent channel (a new pi pane) so the
 * user can inject an arbitrary prompt, not just skill/workflow invocations.
 * The prefix is a routing signal only — pi must receive the bare prompt text
 * (e.g. `Review the current work item and suggest next steps`), not the
 * prefix itself.
 *
 * @param command - Raw command string, possibly starting with `/prompt:`.
 * @returns The prompt text with the `/prompt:` prefix removed; unchanged
 *          commands (no `/prompt:` prefix) are returned as-is.
 */
export function stripAgentPromptPrefix(command: string): string {
  if (command.startsWith('/prompt:')) {
    return command.substring('/prompt:'.length);
  }
  return command;
}

/**
 * Build a descriptive pane title for a manually-triggered agent command.
 *
 * Format:
 *   `Manually triggered <skill> <work-item title> - <id>`
 * for skill/intake/plan commands with an associated work item. Free-form
 * `/prompt:` commands produce `Manually triggered prompt <first words>…`.
 *
 * Titles are bounded by {@link MAX_PANE_TITLE_LENGTH}.
 *
 * @param command - The agent command (e.g. `/skill:implement WL-0XXX`).
 * @param workItemTitle - The selected work-item title (may be undefined).
 * @param workItemId    - The work-item ID (may be undefined).
 * @returns A descriptive pane title suitable for `--pane-name`.
 */
export function buildManuallyTriggeredPaneTitle(
  command: string,
  workItemTitle?: string,
  workItemId?: string,
): string {
  const skillName = stripSkillName(command);
  let base: string;

  if (skillName) {
    base = `Manually triggered ${skillName}`;
  } else {
    // Free-form prompt — no skill token. Use the first few words.
    const promptText = stripAgentPromptPrefix(command).trim();
    if (promptText) {
      const words = promptText.split(/\s+/).slice(0, 3).join(' ');
      base = `Manually triggered prompt ${words}`;
    } else {
      base = 'Manually triggered prompt';
    }
  }

  // Append work-item context when available.
  if (workItemTitle || workItemId) {
    const titlePart = workItemTitle ? ` ${workItemTitle}` : '';
    const idPart = workItemId ? ` - ${workItemId}` : '';
    base = `${base}${titlePart}${idPart}`;
  }

  return truncatePaneTitle(base);
}

/**
 * Build a descriptive pane title for a shell-command pane (!!/! route).
 *
 * Identifies the command (leading snippet) and, when available, the
 * associated work item — replacing the generic "Command Output".
 *
 * @param command - The shell command (after `!!`/`!` prefix stripped).
 * @param workItemTitle - The selected work-item title (may be undefined).
 * @param workItemId    - The work-item ID (may be undefined).
 * @returns A descriptive pane title.
 */
export function buildShellPaneTitle(
  command: string,
  workItemTitle?: string,
  workItemId?: string,
): string {
  const cmdSnippet = command.length > 30 ? command.substring(0, 30) + '…' : command;
  let base = `Shell: ${cmdSnippet}`;

  if (workItemTitle || workItemId) {
    const titlePart = workItemTitle ? ` (${workItemTitle})` : '';
    const idPart = workItemId ? ` ${workItemId}` : '';
    base = `${base}${titlePart}${idPart}`;
  }

  return truncatePaneTitle(base);
}

/**
 * Build the full-format downtime pane title
 * `Downtime triggered <kind> <title> - <id>` (WL-0MSJ4E8UA005KG9Y).
 * Falls back to `Downtime <kind>` when no item context is available.
 */
export function buildDowntimePaneTitle(
  kind: string,
  itemTitle?: string,
  itemId?: string,
): string {
  if (itemTitle || itemId) {
    const titlePart = itemTitle ? ` ${itemTitle}` : '';
    const idPart = itemId ? ` - ${itemId}` : '';
    return truncatePaneTitle(`Downtime triggered ${kind}${titlePart}${idPart}`);
  }
  return truncatePaneTitle(`Downtime ${kind}`);
}