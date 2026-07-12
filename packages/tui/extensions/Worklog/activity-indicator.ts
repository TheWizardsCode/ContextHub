/**
 * Activity indicator for the Worklog Pi extension.
 *
 * Displays the currently executing command or skill in a dedicated footer
 * status line above the directory path and Git branch info. The indicator
 * persists until the next user input, a new session, or a session switch,
 * with best-effort recovery on resume.
 *
 * ## Design
 *
 * Uses Pi's `ctx.ui.setStatus()` API with a unique key (`worklog-activity`)
 * to display the indicator in the footer's status line area. This avoids
 * replacing the entire footer (which would require reimplementing Pi's
 * default path/branch/token display).
 *
 * ## Coverage
 *
 * - **Extension commands** (our own, like `/wl`): set directly in the
 *   command handler (since the `input` event does NOT fire for extension
 *   commands — they are intercepted before the event).
 * - **Skills** (`/skill:name`): captured via the `input` event, which
 *   fires before skill expansion.
 * - **Built-in Pi commands** (`/model`, `/settings`, etc.): the `input`
 *   event fires for these; the indicator is cleared.
 * - **Free-form text**: the `input` event fires; the indicator is cleared.
 * - **Extension commands from other extensions**: not detectable via the
 *   `input` event (documented Pi limitation). These are accepted as a
 *   known limitation.
 *
 * ## Assumptions
 *
 * - The indicator is set/cleared synchronously; no async work is performed
 *   in event handlers beyond best-effort session history recovery.
 * - Terminal width is obtained from `process.stdout.columns` at call time,
 *   defaulting to 80 if unavailable.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { runWl } from '../wl-integration.js';
import { truncateWorkItemId } from './terminal-utils.js';

/**
 * Status key used for the activity indicator in the footer.
 * Passed to `ctx.ui.setStatus()` to set and clear the indicator.
 */
export const ACTIVITY_STATUS_KEY = 'worklog-activity';

/**
 * Known built-in Pi commands that should NOT trigger the activity indicator.
 *
 * When the user types one of these, the indicator is cleared instead of set.
 * This list is from Pi's README.md at the time of implementation and should
 * be updated if Pi adds new built-in commands.
 */
export const BUILTIN_COMMANDS = new Set([
  '/login',
  '/logout',
  '/model',
  '/scoped-models',
  '/settings',
  '/resume',
  '/new',
  '/name',
  '/session',
  '/tree',
  '/trust',
  '/fork',
  '/clone',
  '/compact',
  '/copy',
  '/export',
  '/share',
  '/reload',
  '/hotkeys',
  '/changelog',
  '/quit',
]);

/**
 * Regex to detect work item ID patterns in user input.
 *
 * Matches patterns like `WL-0MQL0T5TR0060AEH` (prefix + dash + 15+ alphanumeric chars).
 * The prefix must be 2-3 uppercase letters followed by a dash and at least 15
 * alphanumeric characters. This is intentionally conservative to avoid false
 * positives on ordinary text while matching all known work item ID formats.
 */
export const WORK_ITEM_ID_REGEX = /\b[A-Z]{2,3}-[A-Z0-9]{15,}/;

/**
 * Extract the first work item ID from input text.
 *
 * Scans the text for a pattern matching a work item ID (e.g., `WL-0MQL0T5TR0060AEH`)
 * and returns the first match. Returns `null` if no ID is found.
 *
 * @example
 * detectWorkItemId('/intake WL-0MQL0T5TR0060AEH') // => 'WL-0MQL0T5TR0060AEH'
 * detectWorkItemId('/wl list')                     // => null
 */
export function detectWorkItemId(text: string): string | null {
  const match = text.match(WORK_ITEM_ID_REGEX);
  return match ? match[0] : null;
}

/**
 * Interface for the subset of ExtensionUIContext used by the activity indicator.
 * Allows passing either a full ExtensionContext or a mock for testing.
 *
 * `theme` is optional to gracefully handle environments (like tests or non-TUI
 * modes) where theme styling is not available.
 */
interface StatusContext {
  ui: {
    setStatus: (key: string, text: string | undefined) => void;
    theme?: {
      fg: (color: string, text: string) => string;
    };
  };
}

/**
 * Extract the first word/command from input text.
 *
 * Returns the text up to the first space, or the entire trimmed text if
 * there is no space.
 *
 * @example
 * extractCommand('/wl list')   // => '/wl'
 * extractCommand('/skill:audit WL-123')  // => '/skill:audit'
 * extractCommand('/model')     // => '/model'
 */
function extractCommand(text: string): string {
  const trimmed = text.trim();
  const firstSpace = trimmed.indexOf(' ');
  return firstSpace > 0 ? trimmed.slice(0, firstSpace) : trimmed;
}

/**
 * Get the current terminal width, defaulting to 80 if unavailable.
 */
function getTerminalWidth(): number {
  try {
    return process.stdout.columns || 80;
  } catch {
    return 80;
  }
}

/**
 * Truncate text to fit within available footer width, with room for styling.
 *
 * The available width is the terminal width minus a small margin for the
 * status prefix and spacing. If the text is too long, it is truncated and
 * an ellipsis character is appended.
 */
function truncateForFooter(text: string): string {
  const terminalWidth = getTerminalWidth();
  // Reserve space for the status indicator prefix (⏵), theme styling, and
  // left/right margins. A generous margin of 10 ensures the indicator
  // doesn't crowd the right side of the footer.
  const maxTextWidth = Math.max(20, terminalWidth - 10);

  if (text.length <= maxTextWidth) return text;
  return text.slice(0, Math.max(0, maxTextWidth - 1)) + '…';
}

/**
 * Show an activity indicator in the footer.
 *
 * Displays the given activity text with a ⏵ prefix and theme accent color.
 * The text is truncated to fit the terminal width.
 *
 * @param ctx - Context with UI methods (ExtensionContext or mock)
 * @param activity - Activity text to display (e.g., '/wl', 'skill:audit')
 * @param showIndicator - When explicitly false, the activity indicator is suppressed (no-op).
 *   Defaults to true (enabled) when not provided, preserving backward compatibility.
 */
export function showActivity(ctx: StatusContext, activity: string, showIndicator?: boolean): void {
  // Gracefully degrade if setStatus is unavailable (non-TUI modes, test mocks)
  if (typeof ctx.ui.setStatus !== 'function') return;
  // When the activity indicator setting is disabled, suppress the indicator entirely.
  // The showIndicator parameter is checked explicitly (=== false) so that undefined
  // (not provided) means enabled by default.
  if (showIndicator === false) return;
  const maxWidth = Math.max(20, getTerminalWidth() - 10);
  const truncated = truncateForFooter(activity);
  const display = `⏵ ${truncated}`;
  // Apply theme accent color if available; otherwise use plain text
  const styled = ctx.ui.theme ? ctx.ui.theme.fg('accent', display) : display;
  ctx.ui.setStatus(ACTIVITY_STATUS_KEY, styled);
}

/**
 * Resolve a work item ID to its title via `wl show <id> --json`.
 *
 * Uses `runWl` from the Worklog integration layer with a 2-second timeout.
 * Returns the title string on success, or `null` if the lookup fails
 * (invalid ID, not found, timeout, or any other error).
 *
 * Errors are silently swallowed so that callers can fall back gracefully
 * without requiring try/catch boilerplate.
 */
async function resolveWorkItemTitle(id: string): Promise<string | null> {
  try {
    const result = await runWl('show', [id], { timeout: 2000 });
    if (result && typeof result === 'object' && typeof result.title === 'string') {
      return result.title;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Show activity text with optional async work item title resolution.
 *
 * First displays the raw input text immediately. If a work item ID is detected
 * in the text, it then async-looks up the work item title via `wl show` and
 * replaces the display with the format `⏵ <id> <title>` (truncated to fit).
 *
 * On lookup failure (invalid ID, not found, timeout), the raw text remains
 * shown — no error is displayed to the user.
 *
 * @param ctx - Context with UI methods (ExtensionContext or mock)
 * @param text - The full input text to display
 * @param showIndicator - Passed through to showActivity(); when false the
 *   indicator is suppressed entirely.
 */
async function showActivityWithTitleLookup(ctx: StatusContext, text: string, showIndicator?: boolean): Promise<void> {
  // First, show the raw text immediately
  showActivity(ctx, text, showIndicator);

  // Check for a work item ID in the text
  const id = detectWorkItemId(text);
  if (!id) return;

  // Async lookup the title
  const title = await resolveWorkItemTitle(id);
  if (!title) return;

  // Replace with command + truncated ID + title format, truncated to fit terminal width.
  // The command is formatted via formatCommandContext (e.g., /skill:audit → audit).
  const commandCtx = formatCommandContext(text);
  const display = `${commandCtx} ${truncateWorkItemId(id)} ${title}`;
  showActivity(ctx, display, showIndicator);
}

/**
 * Format the command context from the input text for display.
 *
 * Extracts the first word (command) from the input text. If the command
 * starts with `/skill:`, the prefix is stripped and only the skill name
 * is returned. For all other commands, the command is returned as-is.
 *
 * @example
 * formatCommandContext('/intake WL-123')       // => '/intake'
 * formatCommandContext('/skill:audit WL-123')  // => 'audit'
 * formatCommandContext('/implement WL-123')    // => '/implement'
 */
export function formatCommandContext(text: string): string {
  const cmd = extractCommand(text);
  if (cmd.startsWith('/skill:')) {
    return cmd.slice(7); // strip "/skill:" prefix
  }
  return cmd;
}

/**
 * Clear the activity indicator from the footer.
 *
 * @param ctx - Context with UI methods (ExtensionContext or mock)
 */
export function clearActivity(ctx: { ui: { setStatus?: (key: string, text: string | undefined) => void } }): void {
  // Gracefully degrade if setStatus is unavailable
  if (typeof ctx.ui.setStatus !== 'function') return;
  ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
}

/**
 * Attempt to recover the last-known activity from session history on resume.
 *
 * Scans the session entries backwards to find the most recent user message
 * that appears to be a command or skill invocation (starts with `/`).
 * Built-in Pi commands are filtered out.
 *
 * This is a best-effort recovery: if no command is found, or if the session
 * history is unavailable, the indicator is cleared.
 *
 * @param ctx - Extension context with session manager access
 * @param showIndicator - Passed through to showActivity(); when false the
 *   indicator is suppressed entirely.
 */
async function recoverActivity(ctx: ExtensionContext, showIndicator?: boolean): Promise<void> {
  try {
    const entries = ctx.sessionManager.getBranch();

    // Walk backwards through entries to find the last user text input
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];

      // Only inspect user messages
      if (entry.type !== 'message') continue;
      const msg = (entry as any).message;
      if (!msg || msg.role !== 'user') continue;

      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const part of content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          const text = part.text.trim();

          if (!text.startsWith('/')) {
            // Free-form text — skip, look further back for a command
            continue;
          }

          // Found a command in session history
          if (text.startsWith('/skill:')) {
            const skillName = text.slice(7).trim();
            if (skillName.length > 0) {
              showActivity(ctx, `skill:${skillName}`, showIndicator);
              return;
            }
          }

          // Check it's not a built-in Pi command
          const firstWord = extractCommand(text);
          if (!BUILTIN_COMMANDS.has(firstWord)) {
            showActivity(ctx, text, showIndicator);
            return;
          }
          // Built-in command — skip and continue looking
        }
      }
    }

    // No recoverable command found — clear
    ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
  } catch {
    // Best-effort: if recovery fails (e.g., session manager not available),
    // clear the indicator gracefully
    ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
  }
}

/**
 * Register the activity indicator event handlers with a Pi extension instance.
 *
 * Sets up:
 * - `input` event handler to capture skills and handle built-in/free-form clearing
 * - `session_start` event handler to handle session lifecycle (new, resume, startup)
 *
 * Extension commands (like `/wl`) must set the indicator directly in their
 * command handlers, since the `input` event does not fire for them.
 *
 * @param pi - The ExtensionAPI instance
 * @param isActivityEnabled - Optional getter that returns whether the activity
 *   indicator should be shown. When omitted, the indicator is always enabled.
 *   Called dynamically at each event handler invocation so that disabling the
 *   setting takes effect immediately (no restart required).
 */
export function registerActivityIndicator(pi: ExtensionAPI, isActivityEnabled?: () => boolean): void {
  // ── Handle input events ──────────────────────────────────────────
  //
  // Processing order (from Pi docs):
  // 1. Extension commands checked first — if matched, input event is SKIPPED
  // 2. input event fires
  // 3. Skill expansion (/skill:name)
  // 4. Template expansion
  // 5. Agent processing
  //
  // So the input event fires for:
  //   - Skills (/skill:name) — we capture the skill name
  //   - Built-in Pi commands (/model, /settings, etc.) — we leave unchanged
  //   - Free-form text — we leave unchanged
  //   - Templates (/templatename) — we set to show the name
  //
  // It does NOT fire for extension commands (like /wl), which are handled
  // by their command handlers before the event fires.
  //
  // IMPORTANT: The input handler NEVER clears the indicator. Clearing is
  // exclusively handled by session_start. This ensures that a free-form
  // answer to a skill prompt (e.g., answering an intake question) does not
  // wipe the indicator — it persists until /new or session shutdown.
  pi.on('input', async (event, ctx) => {
    const text = event.text.trim();

    // Compute whether the activity indicator should be shown.
    // The getter is called dynamically at each invocation so that disabling
    // the setting takes effect immediately (no restart required).
    const showAct = isActivityEnabled?.() ?? true;

    // Free-form text: leave the indicator unchanged.
    // The indicator persists across turns so that a free-form answer to
    // a skill (e.g., answering an intake question) does not clear it.
    if (!text.startsWith('/')) {
      return { action: 'continue' };
    }

    // Work item ID detection: if the input contains a work item ID pattern
    // (e.g., WL-0MQL0T5TR0060AEH), resolve it to the item title and display
    // the ID + title in the footer, replacing the raw command/skill text.
    // This takes priority over command-specific display so that the footer
    // always shows the most informative label.
    //
    // Per AC 1-5:
    // - Shows raw text immediately, then async-resolves the title
    // - Falls back to raw text on lookup failure
    // - The first detected ID is used when multiple are present
    if (detectWorkItemId(text)) {
      await showActivityWithTitleLookup(ctx, text, showAct);
      return { action: 'continue' };
    }

    // No work item ID detected — use existing behavior:

    // Skill command: show the skill name in the indicator (AC 2)
    if (text.startsWith('/skill:')) {
      const skillName = text.slice(7).trim();
      const display = skillName.length > 0 ? `skill:${skillName}` : '/skill:';
      showActivity(ctx, display, showAct);
      return { action: 'continue' };
    }

    // Built-in Pi commands: leave the indicator unchanged.
    // These include /model, /settings, /new, /resume, etc.
    // /new and /resume are handled by the session_start handler below.
    // Other built-in commands should not affect the indicator.
    const firstWord = extractCommand(text);
    if (BUILTIN_COMMANDS.has(firstWord)) {
      return { action: 'continue' };
    }

    // Other /-prefixed input: set the indicator showing the full input.
    // This includes:
    //   - Extension commands from other extensions (e.g., /intake WL-123)
    //   - Templates (/templatename)
    //   - Unrecognized commands
    // Per AC 1, extension-registered commands should show in the footer.
    // We pass the full text so that arguments (like a work-item ID) are
    // included; it is truncated by showActivity to fit the terminal width.
    showActivity(ctx, text, showAct);
    return { action: 'continue' };
  });

  // ── Handle session lifecycle ─────────────────────────────────────
  //
  // The indicator persists across turns within a session. It is cleared on:
  //   - New session (/new)
  //   - Startup / reload
  //   - Fork
  //
  // On resume (/resume), we attempt best-effort recovery of the last-known
  // command from the resumed session's history.
  pi.on('session_start', async (event, ctx) => {
    switch (event.reason) {
      case 'new':
      case 'startup':
      case 'reload':
      case 'fork':
        // Fresh or non-resume session: clear indicator (AC 3)
        ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
        break;

      case 'resume':
        // Resumed session: best-effort recovery from history (AC 3).
        // When the activity indicator is disabled, recovery is skipped and
        // the indicator is cleared to prevent stale indicators showing.
        if ((isActivityEnabled?.() ?? true)) {
          await recoverActivity(ctx, true);
        } else {
          ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
        }
        break;
    }
  });
}
