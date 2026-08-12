/**
 * packages/herdr/src/ship-it-dialog.ts — Ship It typed-confirmation dialog
 *
 * The Ship It shortcut (`S`, WL-0MSGG5N5Z0074TLY) triggers a dev→main
 * release, so it must not fire on a stray keypress. Pressing `S` opens a
 * bottom-anchored confirmation dialog overlaid on the lower rows of the
 * selection list (the list stays visible above it — distinct from the
 * full-screen FormState and the centered Code Freeze notice box). The user
 * must type `ship` (case-insensitive) and press Enter to dispatch
 * `/skill:ship release`; Esc cancels.
 *
 * Provides:
 *   - {@link ShipItDialogState} — mutable typed-input state + key handling
 *   - {@link formatShipItDialog} — renders the dialog box lines
 *   - {@link overlayShipItDialog} — composes list output + bottom-anchored
 *     dialog within the pane height budget
 *
 * Width/wrap math reuses the `visibleWidth` helper from form-dialog.ts
 * (no new dependencies).
 */

import { visibleWidth, truncateToWidth } from './form-dialog.js';

// ── ANSI helpers ──────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reverse: '\x1b[7m',
  fg: (code: number) => `\x1b[38;5;${code}m`,
};

// ── ShipItDialogState ─────────────────────────────────────────────────

/**
 * Mutable state for the Ship It confirmation dialog.
 *
 * Holds the typed confirmation buffer and processes keys: printable
 * characters append to the buffer, Backspace deletes, Esc cancels, and
 * Enter submits — dispatching only when the buffer lowercased equals
 * `ship`. Enter with any other text clears the buffer and keeps the dialog
 * open so the user can retry (never dispatches).
 */
export class ShipItDialogState {
  /** Typed confirmation input buffer (matches `ship` case-insensitively). */
  buffer: string;

  /** Called when the user types `ship` and presses Enter. */
  private onConfirm: () => void;

  /** Called when the user presses Esc. */
  private onCancel: () => void;

  constructor(onConfirm: () => void, onCancel: () => void) {
    this.buffer = '';
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
  }

  /**
   * Process a single keypress while the dialog is open.
   *
   * @param key - The raw keypress string
   * @returns 'submitted' if the dialog was confirmed (dispatch fired),
   *          'cancelled' if dismissed with Esc, or null while the dialog
   *          stays open (typed input / non-matching Enter / ignored keys)
   */
  handleInput(key: string): 'submitted' | 'cancelled' | null {
    if (key === '\r' || key === '\n') {
      if (this.buffer.toLowerCase() === 'ship') {
        this.onConfirm();
        return 'submitted';
      }
      // Non-matching Enter: clear the buffer, keep the dialog open so the
      // user can retry (AC3 option (a)) — nothing is dispatched.
      this.buffer = '';
      return null;
    }

    if (key === '\x1b') {
      // Esc cancels without dispatching.
      this.onCancel();
      return 'cancelled';
    }

    if (key === '\x7f' || key === '\b') {
      // Backspace: delete the last character from the buffer.
      if (this.buffer.length > 0) {
        this.buffer = this.buffer.slice(0, -1);
      }
      return null;
    }

    // Regular character input (printable ASCII/UTF-8 single keypress).
    if (key.length === 1 && key.charCodeAt(0) >= 0x20) {
      this.buffer += key;
      return null;
    }

    // Ignore other control sequences.
    return null;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────

/**
 * Render the Ship It confirmation dialog as a bordered box.
 *
 * The box is a compact 7-line block (title, prompt, blank, typed input,
 * hints) styled consistently with the Code Freeze notice dialog
 * (formatCodeFreezeDialog). The dialog itself is bottom-anchored by
 * {@link overlayShipItDialog}; this function renders just the box.
 *
 * @param maxCols - Terminal width (drives box width and centering)
 * @param buffer - Current typed confirmation text
 * @returns The rendered dialog box string (newline-separated lines)
 */
export function formatShipItDialog(maxCols: number, buffer: string): string {
  const lines: string[] = [];
  const dialogWidth = Math.min(maxCols - 4, 64);
  const dialogMinWidth = 44;
  // Clamp to maxCols so a very narrow pane never overflows (unlike the
  // centered Code Freeze box, the bottom-anchored dialog stays within the
  // pane width at every size).
  const effectiveWidth = Math.max(1, Math.min(Math.max(dialogMinWidth, dialogWidth), maxCols));
  const leftPad = Math.max(0, Math.floor((maxCols - effectiveWidth) / 2));

  const padLine = (content: string): string => {
    // Truncate the content to the inner box width so a fixed prompt line
    // can never overflow a very narrow pane (rightPad stays ≥ 0).
    const innerWidth = Math.max(1, effectiveWidth - 4);
    const truncated = truncateToWidth(content, innerWidth);
    const visibleLen = visibleWidth(truncated);
    const rightPad = Math.max(0, effectiveWidth - visibleLen - 4);
    return ' '.repeat(leftPad) + `│ ${truncated}${' '.repeat(rightPad)} │`;
  };

  const borderLine = (left: string, right: string): string =>
    ' '.repeat(leftPad) + `${left}${'─'.repeat(effectiveWidth - 2)}${right}`;

  lines.push(borderLine('┌', '┐'));
  lines.push(padLine(`${ANSI.bold}Ship It — run the dev→main release?${ANSI.reset}`));
  lines.push(padLine(`${ANSI.dim}Type 'ship' to confirm, Esc to cancel${ANSI.reset}`));
  lines.push(padLine(''));
  lines.push(padLine(` ${ANSI.fg(33)}> ${buffer}${ANSI.reverse} ${ANSI.reset}`));
  lines.push(padLine(`${ANSI.dim}[Enter] confirm  [Esc] cancel${ANSI.reset}`));
  lines.push(borderLine('└', '┘'));
  return lines.join('\n');
}

/**
 * Overlay the Ship It dialog on the bottom rows of the rendered selection
 * list.
 *
 * Bottom-anchored: the top of the list output is preserved and only the
 * lower rows are replaced by the dialog, so the list stays visible above
 * it (no full-screen takeover). The total output never exceeds the list
 * renderer's `rows - 1` line budget (the notification row stays free).
 *
 * @param listOutput - The full rendered list screen (newline-separated)
 * @param maxCols - Terminal width
 * @param maxRows - Terminal height
 * @param buffer - Current typed confirmation text
 * @returns The composed screen string (list + bottom dialog)
 */
export function overlayShipItDialog(
  listOutput: string,
  maxCols: number,
  maxRows: number,
  buffer: string,
): string {
  const dialogLines = formatShipItDialog(maxCols, buffer).split('\n');
  const listLines = listOutput.split('\n');
  const keep = Math.max(0, listLines.length - dialogLines.length);
  const result = [...listLines.slice(0, keep), ...dialogLines];
  // Safety clamp: never exceed the pane height budget.
  return result.slice(0, Math.max(1, maxRows)).join('\n');
}
