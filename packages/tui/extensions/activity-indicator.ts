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
 */
export function showActivity(ctx: StatusContext, activity: string): void {
  // Gracefully degrade if setStatus is unavailable (non-TUI modes, test mocks)
  if (typeof ctx.ui.setStatus !== 'function') return;
  const maxWidth = Math.max(20, getTerminalWidth() - 10);
  const truncated = truncateForFooter(activity);
  const display = `⏵ ${truncated}`;
  // Apply theme accent color if available; otherwise use plain text
  const styled = ctx.ui.theme ? ctx.ui.theme.fg('accent', display) : display;
  ctx.ui.setStatus(ACTIVITY_STATUS_KEY, styled);
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
 */
async function recoverActivity(ctx: ExtensionContext): Promise<void> {
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
              showActivity(ctx, `skill:${skillName}`);
              return;
            }
          }

          // Check it's not a built-in Pi command
          const firstWord = extractCommand(text);
          if (!BUILTIN_COMMANDS.has(firstWord)) {
            showActivity(ctx, text);
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
 */
export function registerActivityIndicator(pi: ExtensionAPI): void {
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
  //   - Built-in Pi commands (/model, /settings, etc.) — we clear
  //   - Free-form text — we clear
  //   - Templates (/templatename) — we clear (not a command or skill)
  //
  // It does NOT fire for extension commands (like /wl), which are handled
  // by their command handlers before the event fires.
  pi.on('input', async (event, ctx) => {
    const text = event.text.trim();

    // Free-form text: clear the indicator (AC 5)
    if (!text.startsWith('/')) {
      ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
      return { action: 'continue' };
    }

    // Skill command: show the skill name in the indicator (AC 2)
    if (text.startsWith('/skill:')) {
      const skillName = text.slice(7).trim();
      const display = skillName.length > 0 ? `skill:${skillName}` : '/skill:';
      showActivity(ctx, display);
      return { action: 'continue' };
    }

    // Built-in Pi command: clear the indicator (AC 4)
    const firstWord = extractCommand(text);
    if (BUILTIN_COMMANDS.has(firstWord)) {
      ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
      return { action: 'continue' };
    }

    // Other /-prefixed input (template, unrecognized): clear the indicator.
    // These are not extension commands or skills, per AC.
    ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
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
        // Resumed session: best-effort recovery from history (AC 3)
        await recoverActivity(ctx);
        break;
    }
  });
}
