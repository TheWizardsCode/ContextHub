/**
 * packages/herdr/src/form-dialog.ts — Form page for unknown identifiers
 *
 * Provides identifier extraction, form state management, rendering, and
 * input handling for chord commands that contain unknown <identifier>
 * patterns. Known identifiers like <id> are auto-resolved; unknown ones
 * trigger an interactive full-pane form page in the TUI.
 */

import { splitKeypresses } from './key-input.js';

// ── Identifier extraction ─────────────────────────────────────────────

/**
 * Regex that matches <name> and <name default="value"> patterns.
 * Capture groups: [1]=name, [2]=default value (optional, without quotes)
 */
const IDENTIFIER_RE =
  /<([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+default\s*=\s*["']([^"']*)["'])?\s*>/g;

/**
 * An identifier extracted from a command template.
 */
export interface ExtractedIdentifier {
  /** Identifier name (e.g., 'title', 'status') */
  name: string;
  /** Optional default value from the template (e.g., 'medium') */
  default: string;
}

/**
 * Extract all unique <identifier> patterns from a command string.
 *
 * Supports the syntax `<name>` and `<name default="value">`.
 *
 * @param command - The command string to scan
 * @returns Array of unique identifier descriptors (without angle brackets)
 */
export function extractIdentifiers(command: string): ExtractedIdentifier[] {
  const seen = new Set<string>();
  const result: ExtractedIdentifier[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(IDENTIFIER_RE.source, 'g');
  while ((match = re.exec(command)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      result.push({ name, default: match[2] ?? '' });
    }
  }
  return result;
}

/**
 * Set of known identifiers that are auto-resolved (e.g., <id>).
 * Extensible for future known identifiers.
 */
export const KNOWN_IDENTIFIERS = new Set<string>(['id']);

/**
 * Get identifiers that are NOT in the known set.
 *
 * @param command - The command string to scan
 * @returns Array of unknown identifier descriptors (without angle brackets)
 */
export function getUnknownIdentifiers(command: string): ExtractedIdentifier[] {
  return extractIdentifiers(command).filter(
    (id) => !KNOWN_IDENTIFIERS.has(id.name),
  );
}

// ── Substitution ──────────────────────────────────────────────────────

/**
 * Quote a value for safe interpolation into a POSIX shell command.
 *
 * The value is wrapped in single quotes, and every embedded single quote is
 * closed, escaped and reopened (`'\''`). Inside single quotes the shell
 * treats every other character — `"`, `$`, backticks, `$(...)`, `|`, `&`,
 * `;`, `\`, newlines, … — literally, so a user-entered value can never
 * terminate the surrounding command or trigger expansion.
 *
 * This form is used for placeholders that are NOT already inside a quoted
 * segment (e.g. `--title <title>`). For a placeholder sitting inside an
 * existing single- or double-quoted segment the context-aware
 * {@link escapeShellValue} must be used instead — wrapping a value there
 * would unbalance the template's quotes.
 *
 * Shell-route commands are always executed by `bash -c`
 * (`packages/herdr/scripts/run-in-pane.sh`), so POSIX quoting applies on
 * every platform, including Windows via Git Bash/WSL.
 *
 * @param value - Raw user-entered value
 * @returns The value wrapped in a single shell-quoted segment
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Shell quoting context at a placeholder's position in a template. */
type ShellQuoteContext = 'single' | 'double' | 'none';

/**
 * Determine the shell quoting context at `offset` in a command template by
 * scanning the preceding text with a minimal POSIX quote state machine.
 *
 * Placeholder syntax (`<name …>`) in the prefix is stripped before scanning
 * so quoted inline defaults cannot perturb the quote state. State persists
 * across `&&`/`;` as it does in a real shell; unterminated quotes fall back
 * to the context they are in (the matching template's closing quote is later
 * in the string).
 */
function shellQuoteContextAt(command: string, offset: number): ShellQuoteContext {
  const prefix = command.slice(0, offset).replace(/<[^>]*>/g, '');
  let state: ShellQuoteContext = 'none';
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (state === 'single') {
      if (ch === "'") state = 'none';
    } else if (state === 'double') {
      if (ch === '\\') i++;
      else if (ch === '"') state = 'none';
    } else if (ch === "'") {
      state = 'single';
    } else if (ch === '"') {
      state = 'double';
    } else if (ch === '\\') {
      i++;
    }
  }
  return state;
}

/**
 * Escape a value for the shell-quoting context it is inserted into.
 *
 * - Inside an open single-quoted segment, only `'` is special: close the
 *   quote, emit an escaped apostrophe and reopen (`'\''`).
 * - Inside an open double-quoted segment, escape `\`, `"`, `$` and backticks.
 * - Otherwise emit a fully single-quoted segment ({@link shellQuote}).
 *
 * Handling the surrounding-quote case is essential: the `a-r` template embeds
 * `<reason>` inside `'Rejected by manual review. <reason>'`, so wrapping the
 * value again would unbalance the quotes (WL-0MU7KEX65004X0U9).
 */
function escapeShellValue(command: string, offset: number, value: string): string {
  switch (shellQuoteContextAt(command, offset)) {
    case 'single':
      return value.replace(/'/g, `'\\''`);
    case 'double':
      return value.replace(/[\\"$`]/g, (ch) => `\\${ch}`);
    default:
      return shellQuote(value);
  }
}

/**
 * A command template is a shell command when it is routed through the shell
 * path (`!`/`!!` prefix — see `routeCommand` in index.ts). Agent-prompt
 * templates (`/skill:*`, `/intake`, `/plan`, `/prompt:`, `/herdr:*`) are NOT
 * shell commands and must receive raw values.
 */
function isShellCommandTemplate(command: string): boolean {
  return command.trimStart().startsWith('!');
}

/**
 * Substitute all <identifier> placeholders in a command with provided values.
 *
 * Identifiers with an inline default (`<name default="value">`) fall back to
 * their default when no explicit value is supplied.
 *
 * Shell-route templates (`!`/`!!` prefix) have their substituted values
 * shell-escaped for the quoting context of each placeholder so user text
 * containing apostrophes or other shell metacharacters cannot break or inject
 * into the command (WL-0MU7KEX65004X0U9). Agent-prompt templates keep raw
 * substitution — the value is passed as a single argv element, never parsed
 * by a shell.
 *
 * @param command - The command template with <identifier> placeholders
 * @param values - Map of identifier name to replacement value (explicit values
 *                 take precedence over inline defaults)
 * @returns The command with all matching placeholders replaced
 */
export function substituteIdentifiers(
  command: string,
  values: Record<string, string>,
): string {
  const isShell = isShellCommandTemplate(command);
  return command.replace(
    /<([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+default\s*=\s*["']([^"']*)["'])?\s*>/g,
    (_, name: string, def: string | undefined, offset: number) => {
      const escape = (value: string): string =>
        isShell ? escapeShellValue(command, offset, value) : value;
      if (name in values) return escape(values[name]);
      if (def !== undefined) return escape(def);
      return `<${name}>`;
    },
  );
}

// ── Form types ────────────────────────────────────────────────────────

export interface FormField {
  /** Identifier name (e.g., 'title', 'status') */
  name: string;
  /** Current text value entered by the user */
  value: string;
  /** Optional default value from the command template */
  default: string;
}

export interface FormResult {
  /** The fully substituted command ready for execution */
  command: string;
}

/**
 * Result of processing a single keypress in form mode.
 *
 * Broadened from the old `'submitted' | 'cancelled' | null` union so the
 * caller can route async clipboard work (paste/cut) without ever freezing
 * the TUI event loop (WL-0MSW6KCTA0092DCV).
 */
export type FormInputResult =
  | { type: 'submitted' }
  | { type: 'cancelled' }
  | /** Ctrl+V: no data yet — the caller should read the OS clipboard and
     * feed the result back via {@link FormState.pasteText} or
     * {@link FormState.notifyPasteFailed}. */
    { type: 'paste' }
  | /** Ctrl+X: the active field has been cleared; `text` holds the value the
     * caller should copy to the OS clipboard (then surface feedback). */
    { type: 'cut'; text: string }
  | /** Ordinary keystroke / navigation — nothing for the caller to do. */
    { type: 'none' };

// ── ANSI helpers ──────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reverse: '\x1b[7m',
  underline: '\x1b[4m',
  fg: (code: number) => `\x1b[38;5;${code}m`,
  bg: (code: number) => `\x1b[48;5;${code}m`,
  cursorUp: (n: number) => `\x1b[${n}A`,
};

/** SGR escape sequence matcher (e.g. `\x1b[38;5;76m`). */
const SGR_RE = /\x1b\[[0-9;]*m/g;

/** Non-global matcher for testing whether a segment is an SGR sequence. */
const IS_SGR_RE = /^\x1b\[[0-9;]*m$/;

// ── Bracketed-paste sequences (WL-0MSW6KCTA0092DCV) ───────────────────
/** Opening bracketed-paste control sequence. */
export const BRACKETED_PASTE_START = '\x1b[200~';
/** Closing bracketed-paste control sequence. */
export const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Ctrl+Enter key encodings that map to a verbatim newline insert.
 *
 * Terminals that report modified keys (kitty / xterm ʼCSI uʼ) encode
 * Ctrl+Enter as `ESC [ 13 ; 5 u`. Herdr may also deliver Enter-with-Ctrl as
 * `ESC [ 1 ; 5 A`-style variants, so both are accepted here.
 */
const CTRL_ENTER_SEQS = ['\x1b[13;5u', '\x1b[13;5~', '\x1b[1;5A'];

/**
 * Extract the inner text from bracketed-paste wrapping, if present.
 *
 * Returns `undefined` when the chunk does not carry a bracketed-paste
 * wrapper. A fully wrapped chunk (`ESC [ 200 ~ … ESC [ 201 ~`) yields its
 * inner content verbatim; leading/trailing lone wrapper markers are stripped
 * so the remaining text can be inserted. Newlines inside are data.
 */
export function unwrapBracketedPaste(chunk: string): string | undefined {
  const startIdx = chunk.indexOf(BRACKETED_PASTE_START);
  const endIdx = chunk.indexOf(BRACKETED_PASTE_END);
  const hasStart = startIdx >= 0;
  const hasEnd = endIdx >= 0;
  if (!hasStart && !hasEnd) return undefined;
  // Full wrap: everything between the markers.
  if (hasStart && hasEnd && endIdx > startIdx) {
    return chunk.slice(startIdx + BRACKETED_PASTE_START.length, endIdx);
  }
  // Lone start marker: strip it, keep the rest.
  if (hasStart) {
    return chunk.slice(startIdx + BRACKETED_PASTE_START.length);
  }
  // Lone end marker: strip it, keep the rest.
  return chunk.slice(0, endIdx);
}

/**
 * Measure the visible (displayed) width of a string, ignoring ANSI SGR
 * sequences. Consistent with the convention used elsewhere in this package
 * (e.g. `worklist.ts`) — no external width/wrap dependencies.
 */
export function visibleWidth(content: string): number {
  return content.replace(SGR_RE, '').length;
}

/**
 * Wrap content at a visible width, preserving ANSI SGR styling.
 *
 * Text is wrapped greedily at the given width. When a line break falls
 * inside a styled region, the open style codes are re-emitted at the start
 * of the continuation line so wrapped text keeps its styling. ANSI codes
 * themselves consume no width. `\n` in the input acts as a hard break.
 *
 * Words that do not fit on the current line move to the next line whole
 * (rewinding to the last space), so no produced line exceeds `width`;
 * a single word longer than `width` is hard-broken at the width.
 */
function wrapContent(content: string, width: number): string[] {
  if (width < 1) return [content];
  const segments = content.split(/(\x1b\[[0-9;]*m)/g).filter((s) => s !== '');
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  let openAnsi: string[] = [];
  // Index into `current` of the last whitespace char appended (or -1).
  let lastSpacePos = -1;

  const flush = (): void => {
    lines.push(current);
    current = '';
    currentWidth = 0;
    lastSpacePos = -1;
  };

  for (const seg of segments) {
    if (IS_SGR_RE.test(seg)) {
      current += seg;
      if (seg === ANSI.reset) openAnsi = [];
      else openAnsi.push(seg);
      continue;
    }
    for (const ch of seg) {
      if (ch === '\n') {
        flush();
        current += openAnsi.join('');
        continue;
      }
      if (currentWidth >= width) {
        flush();
        current += openAnsi.join('');
        // Drop the whitespace that triggered the break so continuation
        // lines do not start with a stray space (and stay within width).
        if (/\s/.test(ch)) continue;
      }
      // A non-space char that would overflow the width: if the current
      // line contains a space, move the trailing word to the next line
      // whole instead of overflowing; otherwise fall through to the
      // hard character break at the width.
      if (!/\s/.test(ch) && currentWidth + 1 > width && lastSpacePos >= 0) {
        const word = current.slice(lastSpacePos + 1);
        current = current.slice(0, lastSpacePos); // drop trailing space + word
        flush();
        current += openAnsi.join('') + word;
        currentWidth = visibleWidth(word);
        lastSpacePos = -1;
      }
      current += ch;
      currentWidth += 1;
      if (/\s/.test(ch)) lastSpacePos = current.length - 1;
    }
  }
  flush();
  // Drop a trailing empty line produced by a trailing hard break.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Truncate content to a maximum visible width, preserving ANSI styling and
 * appending '…' when truncated. Used as a defensive guard so no rendered
 * line can ever exceed the pane width.
 * Exported for reuse by ship-it-dialog.ts (WL-0MSGG5N5Z0074TLY).
 */
export function truncateToWidth(content: string, maxWidth: number): string {
  if (visibleWidth(content) <= maxWidth) return content;
  const segments = content.split(/(\x1b\[[0-9;]*m)/g).filter((s) => s !== '');
  let out = '';
  let remaining = Math.max(0, maxWidth - 1); // reserve room for '…'
  let hasOpenStyle = false;
  for (const seg of segments) {
    if (IS_SGR_RE.test(seg)) {
      out += seg;
      if (seg === ANSI.reset) hasOpenStyle = false;
      else hasOpenStyle = true;
      continue;
    }
    if (remaining <= 0) break;
    const take = seg.slice(0, remaining);
    out += take;
    remaining -= take.length;
  }
  if (hasOpenStyle) out += ANSI.reset;
  return `${out}…`;
}

// ── FormState ─────────────────────────────────────────────────────────

/**
 * Mutable state for a multi-field form page layout.
 *
 * Manages field input, navigation between fields, and submission/cancel.
 * Renders itself as a full-pane page (no border box, no centering) starting
 * at the top-left corner, while keeping the modal keyboard interaction.
 */
export class FormState {
  /** Form fields (one per unknown identifier) */
  fields: FormField[];

  /** Index of the currently active (focused) field */
  activeFieldIndex: number;

  /** Description text (from shortcut entry or fallback to command) */
  description: string;

  /** Original command template with <identifier> placeholders */
  private commandTemplate: string;

  /** Called with the substituted command when the user submits */
  private onSubmit: (result: string) => void;

  /** Called when the user cancels the form */
  private onCancel: () => void;

  /**
   * Bracketed-paste accumulation state (WL-0MSW6KCTA0092DCV). While true,
   * every subsequent key is pushed verbatim (newlines stay data) until the
   * closing `\x1b[201~` arrives. Herdr may deliver the bracketed sequence
   * char-by-char, so the open/close markers are tracked across calls.
   */
  private bracketedPasteOpen = false;

  constructor(
    commandTemplate: string,
    description: string,
    unknownIdentifiers: ExtractedIdentifier[],
    onSubmit: (result: string) => void,
    onCancel: () => void,
  ) {
    this.commandTemplate = commandTemplate;
    this.description = description || commandTemplate;
    this.fields = unknownIdentifiers.map((id) => ({
      name: id.name,
      value: id.default,
      default: id.default,
    }));
    this.activeFieldIndex = 0;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
  }

  /**
   * Process a raw stdin chunk in form mode.
   *
   * A single `data` event may carry SEVERAL coalesced keystrokes when the
   * user types quickly (the PTY batches bytes) — each token is processed in
   * order so no character is dropped (WL-0MTV67MZU003H7SH). Single-key
   * callers are unaffected: the tokeniser returns their key unchanged.
   *
   * @param chunk - The raw keypress chunk (one or more keys)
   * @returns A {@link FormInputResult} describing the outcome. `submitted` /
   *          `cancelled` are terminal; `paste`/`cut` signal the caller to
   *          perform an async OS-clipboard operation; `none` means the
   *          key was consumed by editing/navigation. When a chunk contains a
   *          terminal key, the preceding keys are applied first and the
   *          terminal result is returned.
   */
  handleInput(chunk: string): FormInputResult {
    // Split a coalesced chunk into individual keys and process each in
    // order. A single-token chunk (the common case) falls straight through
    // to the existing single-key logic below.
    const keys = splitKeypresses(chunk);
    if (keys.length > 1) {
      let last: FormInputResult = { type: 'none' };
      for (const token of keys) {
        last = this.handleInput(token);
        if (last.type !== 'none') return last;
      }
      return last;
    }
    const key = keys[0] ?? '';

    // ── Bracketed-paste unwrapping (WL-0MSW6KCTA0092DCV) ──────────
    // When a chunk arrives inside an open bracketed-paste region — or the
    // whole chunk is a self-contained bracketed paste — insert the inner
    // content verbatim (newlines are data, never submit).
    if (this.bracketedPasteOpen) {
      if (key === BRACKETED_PASTE_END) {
        this.bracketedPasteOpen = false;
        return { type: 'none' };
      }
      this.insertIntoActiveField(key);
      return { type: 'none' };
    }
    if (key === BRACKETED_PASTE_START) {
      this.bracketedPasteOpen = true;
      return { type: 'none' };
    }
    const unwrapped = unwrapBracketedPaste(key);
    if (unwrapped !== undefined) {
      this.insertIntoActiveField(unwrapped);
      return { type: 'none' };
    }

    if (key === '\r' || key === '\n') {
      // Submit the form
      const result = this.getResult();
      this.onSubmit(result);
      return { type: 'submitted' };
    }

    // Ctrl+Enter: insert a newline (data) instead of submitting.
    if (CTRL_ENTER_SEQS.includes(key)) {
      this.insertIntoActiveField('\n');
      return { type: 'none' };
    }

    // Ctrl+V: request an OS-clipboard paste (async — done by the caller).
    if (key === '\x16') {
      return { type: 'paste' };
    }

    // Ctrl+X: copy the whole active-field value to the OS clipboard and
    // clear the field. The copy itself is async — performed by the caller.
    if (key === '\x18') {
      const field = this.fields[this.activeFieldIndex];
      const text = field.value;
      field.value = '';
      return { type: 'cut', text };
    }

    if (key === '\x1b') {
      // Cancel the form
      this.onCancel();
      return { type: 'cancelled' };
    }

    if (key === '\t') {
      // Tab: advance to next field (wrap around)
      this.activeFieldIndex = (this.activeFieldIndex + 1) % this.fields.length;
      return { type: 'none' };
    }

    if (key === '\x1b[A') {
      // Arrow up: previous field (wrap around)
      this.activeFieldIndex =
        (this.activeFieldIndex - 1 + this.fields.length) % this.fields.length;
      return { type: 'none' };
    }

    if (key === '\x1b[B') {
      // Arrow down: next field (wrap around)
      this.activeFieldIndex = (this.activeFieldIndex + 1) % this.fields.length;
      return { type: 'none' };
    }

    if (key === '\x7f' || key === '\b') {
      // Backspace: delete last character from active field
      const field = this.fields[this.activeFieldIndex];
      if (field.value.length > 0) {
        field.value = field.value.slice(0, -1);
      }
      return { type: 'none' };
    }

    // Regular character input
    if (key.length === 1 && key.charCodeAt(0) >= 0x20) {
      const field = this.fields[this.activeFieldIndex];
      field.value += key;
      return { type: 'none' };
    }

    // Ignore other control sequences
    return { type: 'none' };
  }

  /**
   * Insert text at the end of the active field verbatim (newlines preserved).
   * Used by the paste path (Ctrl+V) and bracketed-paste unwrapping.
   *
   * @param text - The text to append to the active field.
   */
  insertIntoActiveField(text: string): void {
    const field = this.fields[this.activeFieldIndex];
    field.value += text;
  }

  /**
   * Feed a successful clipboard read into the active field.
   *
   * The paste path is asynchronous: {@link handleInput} returns
   * `{ type: 'paste' }`, the caller reads the OS clipboard, and on success
   * calls this method to commit the text.
   *
   * @param text - The clipboard contents (newlines preserved verbatim).
   */
  pasteText(text: string): void {
    this.insertIntoActiveField(text);
  }

  /**
   * Signal that an OS-clipboard read failed (no reader available, read
   * error, or empty content). The form itself is left untouched so the user
   * can retry or type; the caller uses the return value to surface a visible
   * message (e.g. a toast/hint) without closing the form.
   *
   * @returns The failure reason, for the caller to display.
   */
  notifyPasteFailed(reason: string): string {
    return reason;
  }

  /**
   * Get the fully substituted command with current field values.
   */
  getResult(): string {
    const values: Record<string, string> = {};
    for (const field of this.fields) {
      values[field.name] = field.value;
    }
    return substituteIdentifiers(this.commandTemplate, values);
  }

  /**
   * Render the form as a full-pane page layout.
   *
   * The form is rendered without a border box — no corner decorations, no
   * side borders, no horizontal edge lines. Content starts at the top-left
   * of the pane (no centering, no leading blank lines). Long text wraps at
   * the full pane width (`maxCols`), and the output is bounded by `maxRows`
   * so it never exceeds the terminal height.
   *
   * All inner content is retained: the "⌨ Command Input" heading, the
   * description, labeled fields, action hints, and the active-field cursor
   * indicator. Icon glyphs (`⌨`, `▶`) are followed by a visible space.
   *
   * @param maxCols - Terminal width
   * @param maxRows - Terminal height
   * @returns The rendered page string, ready for stdout
   */
  render(maxCols: number, maxRows: number): string {
    // Row budget: leave a couple of rows for the hint line, minimum 2 for
    // content.
    const availableRows = Math.max(2, maxRows - 2);
    const content: string[] = [];
    const pushContent = (c: string): void => {
      if (content.length < availableRows) content.push(c);
    };

    // ── Build form content (left-aligned, no border) ──────────────

    // Title
    pushContent(`${ANSI.bold}${ANSI.fg(76)}⌨ Command Input${ANSI.reset}`);
    pushContent('');

    // Description — wrapped at full pane width
    const descContent = `${ANSI.fg(33)}${this.description}${ANSI.reset}`;
    for (const dl of wrapContent(descContent, maxCols)) {
      pushContent(dl);
    }

    // Blank line after description
    pushContent('');

    // Fields
    for (let i = 0; i < this.fields.length; i++) {
      const field = this.fields[i];
      const isActive = i === this.activeFieldIndex;

      // Label line
      const labelPrefix = isActive ? `${ANSI.fg(76)}▶ ${ANSI.reset}` : '  ';
      const labelStyle = isActive ? `${ANSI.bold}${ANSI.fg(76)}` : `${ANSI.dim}`;
      const labelLine = `${labelPrefix}${labelStyle}${field.name}:${ANSI.reset}`;
      pushContent(labelLine);

      // Value lines — wrapped at full pane width. The active field
      // reserves one column for the cursor indicator, so the wrap width
      // is reduced by 1 for active fields.
      const displayValue = field.value || '';
      const valueStyle = isActive ? `${ANSI.fg(33)}` : `${ANSI.dim}`;
      const wrapWidth = isActive ? Math.max(1, maxCols - 1) : maxCols;
      let valueLines = wrapContent(
        `${valueStyle}${displayValue}${ANSI.reset}`,
        wrapWidth,
      );
      if (valueLines.length === 0) valueLines = [''];

      const shown: string[] = [];
      for (const vl of valueLines) {
        if (content.length >= availableRows) break;
        content.push(vl);
        shown.push(vl);
      }

      if (shown.length > 0) {
        const lastIdx = content.length - 1;
        // Truncation marker when the row budget clipped wrapped lines.
        if (shown.length < valueLines.length) {
          content[lastIdx] = truncateToWidth(`${content[lastIdx]}…`, maxCols);
        }
        // Cursor indicator (active) on the last shown line. The line is
        // capped to maxCols-1 first so the indicator never overflows the
        // pane (relevant when the truncation marker was also appended).
        if (isActive) {
          content[lastIdx] =
            truncateToWidth(content[lastIdx], maxCols - 1) +
            `${ANSI.reverse} ${ANSI.reset}`;
        }
      }

      // Blank line between fields
      if (i < this.fields.length - 1) {
        pushContent('');
      }
    }

    // Blank line before hint
    pushContent('');

    // Instructions
    const fullHint =
      '[Tab/↑↓] navigate  [Enter] submit  [Ctrl+Enter] newline  [Ctrl+V] paste  [Ctrl+X] cut  [Esc] cancel';
    const hint =
      visibleWidth(fullHint) <= maxCols
        ? fullHint
        : '[Tab] next [Enter] ok [Ctrl+V] paste [Ctrl+X] cut [Esc] cancel';
    pushContent(truncateToWidth(`${ANSI.dim}${hint}${ANSI.reset}`, maxCols));

    // Fill remaining rows with blank lines (never exceeding maxRows).
    const remaining = Math.max(0, maxRows - content.length);
    for (let i = 0; i < remaining; i++) {
      content.push('');
    }

    return content.slice(0, maxRows).join('\n');
  }
}

/**
 * Check if a command has any unknown identifiers that would trigger a form dialog.
 *
 * @param command - The command string to check
 * @returns true if there are unknown identifiers requiring user input
 */
export function hasUnknownIdentifiers(command: string): boolean {
  return getUnknownIdentifiers(command).length > 0;
}
