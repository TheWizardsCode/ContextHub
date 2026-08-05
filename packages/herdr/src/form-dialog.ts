/**
 * packages/herdr/src/form-dialog.ts — Form dialog for unknown identifiers
 *
 * Provides identifier extraction, form state management, rendering, and
 * input handling for chord commands that contain unknown <identifier>
 * patterns. Known identifiers like <id> are auto-resolved; unknown ones
 * trigger an interactive form overlay in the TUI.
 */

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
 * Substitute all <identifier> placeholders in a command with provided values.
 *
 * Identifiers with an inline default (`<name default="value">`) fall back to
 * their default when no explicit value is supplied.
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
  return command.replace(
    /<([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+default\s*=\s*["']([^"']*)["'])?\s*>/g,
    (_, name: string, def: string | undefined) => {
      if (name in values) return values[name];
      if (def !== undefined) return def;
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

/**
 * Measure the visible (displayed) width of a string, ignoring ANSI SGR
 * sequences. Consistent with the convention used elsewhere in this package
 * (e.g. `worklist.ts`) — no external width/wrap dependencies.
 */
function visibleWidth(content: string): number {
  return content.replace(SGR_RE, '').length;
}

/**
 * Wrap content at a visible width, preserving ANSI SGR styling.
 *
 * Text is wrapped greedily at the given width. When a line break falls
 * inside a styled region, the open style codes are re-emitted at the start
 * of the continuation line so wrapped text keeps its styling. ANSI codes
 * themselves consume no width. `\n` in the input acts as a hard break.
 */
function wrapContent(content: string, width: number): string[] {
  if (width < 1) return [content];
  const segments = content.split(/(\x1b\[[0-9;]*m)/g).filter((s) => s !== '');
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  let openAnsi: string[] = [];

  const flush = (): void => {
    lines.push(current);
    current = '';
    currentWidth = 0;
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
      current += ch;
      currentWidth += 1;
    }
  }
  flush();
  // Drop a trailing empty line produced by a trailing hard break.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Truncate content to a maximum visible width, preserving ANSI styling and
 * appending '…' when truncated. Used as a defensive guard in `padLine` so
 * no content line can ever exceed the dialog border width.
 */
function truncateToWidth(content: string, maxWidth: number): string {
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
 * Mutable state for a multi-field form dialog overlay.
 *
 * Manages field input, navigation between fields, and submission/cancel.
 * Renders itself as a terminal overlay with a border, description,
 * labelled input fields, and action hints.
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
   * Process a single keypress in form mode.
   *
   * @param key - The raw keypress string
   * @returns 'submitted' if form was submitted, 'cancelled' if cancelled,
   *          or null if still editing
   */
  handleInput(key: string): 'submitted' | 'cancelled' | null {
    if (key === '\r' || key === '\n') {
      // Submit the form
      const result = this.getResult();
      this.onSubmit(result);
      return 'submitted';
    }

    if (key === '\x1b') {
      // Cancel the form
      this.onCancel();
      return 'cancelled';
    }

    if (key === '\t') {
      // Tab: advance to next field (wrap around)
      this.activeFieldIndex = (this.activeFieldIndex + 1) % this.fields.length;
      return null;
    }

    if (key === '\x1b[A') {
      // Arrow up: previous field (wrap around)
      this.activeFieldIndex =
        (this.activeFieldIndex - 1 + this.fields.length) % this.fields.length;
      return null;
    }

    if (key === '\x1b[B') {
      // Arrow down: next field (wrap around)
      this.activeFieldIndex = (this.activeFieldIndex + 1) % this.fields.length;
      return null;
    }

    if (key === '\x7f' || key === '\b') {
      // Backspace: delete last character from active field
      const field = this.fields[this.activeFieldIndex];
      if (field.value.length > 0) {
        field.value = field.value.slice(0, -1);
      }
      return null;
    }

    // Regular character input
    if (key.length === 1 && key.charCodeAt(0) >= 0x20) {
      const field = this.fields[this.activeFieldIndex];
      field.value += key;
      return null;
    }

    // Ignore other control sequences
    return null;
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
   * Render the form dialog as a terminal overlay string.
   *
   * The overlay has a border box, description header, labeled input fields
   * (with active field highlighted), and submit/cancel instructions.
   *
   * The dialog width is 80% of the pane width (clamped to a 40-column
   * minimum and to the pane width minus borders), the description and field
   * values wrap at the inner content width, and the box grows downward as
   * wrapped content grows — bounded by `maxRows` so it never overflows the
   * terminal. Every content line is padded to exactly the border width.
   *
   * @param maxCols - Terminal width
   * @param maxRows - Terminal height
   * @returns The rendered overlay string, ready for stdout
   */
  render(maxCols: number, maxRows: number): string {
    // ── Width: 80% of the pane width, clamped ───────────────────────
    const minWidth = 40;
    const maxWidth = Math.max(minWidth, maxCols - 4);
    const effectiveWidth = Math.min(
      Math.max(Math.floor(maxCols * 0.8), minWidth),
      maxWidth,
    );
    const leftPad = Math.max(0, Math.floor((maxCols - effectiveWidth) / 2));
    const innerWidth = effectiveWidth - 4; // `│ ` + content + ` │`

    const padLine = (content: string): string => {
      const truncated = truncateToWidth(content, innerWidth);
      const visibleLen = visibleWidth(truncated);
      // 4 non-content columns: `│ ` left border + ` │` right border.
      const rightPad = Math.max(0, effectiveWidth - visibleLen - 4);
      return (
        ' '.repeat(leftPad) +
        `│ ${truncated}${' '.repeat(rightPad)} │`
      );
    };

    const borderLine = (left: string, right: string): string => {
      return ' '.repeat(leftPad) + `${left}${'─'.repeat(effectiveWidth - 2)}${right}`;
    };

    // Row budget for the content between the two borders (border lines and
    // one blank line above/below the box are outside the budget).
    const availableRows = Math.max(5, maxRows - 4);
    const content: string[] = [];
    const pushContent = (c: string): void => {
      if (content.length < availableRows) content.push(c);
    };

    // ── Build form content ────────────────────────────────────────

    // Title
    pushContent(`${ANSI.bold}${ANSI.fg(76)}⌨ Command Input${ANSI.reset}`);
    pushContent('');

    // Description — wrapped at the inner width
    const descContent = ` ${ANSI.fg(33)}${this.description}${ANSI.reset}`;
    for (const dl of wrapContent(descContent, innerWidth)) {
      pushContent(dl);
    }

    // Separator
    pushContent(` ${ANSI.dim}${'─'.repeat(Math.min(effectiveWidth - 6, 40))}${ANSI.reset}`);
    pushContent('');

    // Fields
    for (let i = 0; i < this.fields.length; i++) {
      const field = this.fields[i];
      const isActive = i === this.activeFieldIndex;

      // Label line
      const labelPrefix = isActive ? `${ANSI.fg(76)}▶${ANSI.reset} ` : '  ';
      const labelStyle = isActive ? `${ANSI.bold}${ANSI.fg(76)}` : `${ANSI.dim}`;
      const labelLine = `${labelPrefix}${labelStyle}${field.name}:${ANSI.reset}`;
      pushContent(labelLine);

      // Value lines — wrapped; the active field reserves one column for
      // the cursor indicator so the last line stays within the border.
      // The 2-column indent is part of the rendered line, so the wrap
      // width for the text itself is `innerWidth - 2` (minus one more
      // column for the active field's cursor).
      const displayValue = field.value || '';
      const valueStyle = isActive ? `${ANSI.fg(33)}` : `${ANSI.dim}`;
      const wrapWidth = isActive
        ? Math.max(1, innerWidth - 3)
        : Math.max(1, innerWidth - 2);
      let valueLines = wrapContent(
        `${valueStyle}${displayValue}${ANSI.reset}`,
        wrapWidth,
      );
      if (valueLines.length === 0) valueLines = [''];

      const shown: string[] = [];
      for (const vl of valueLines) {
        if (content.length >= availableRows) break;
        content.push(`  ${vl}`);
        shown.push(vl);
      }

      if (shown.length > 0) {
        const lastIdx = content.length - 1;
        // Truncation marker when the row budget clipped wrapped lines.
        if (shown.length < valueLines.length) {
          content[lastIdx] = truncateToWidth(`${content[lastIdx]}…`, innerWidth);
        }
        // Cursor indicator (active) / minimum field width (inactive) on
        // the last shown line.
        if (isActive) {
          content[lastIdx] = `${content[lastIdx]}${ANSI.reverse} ${ANSI.reset}`;
        } else {
          const vis = visibleWidth(content[lastIdx]);
          const pad = Math.min(
            Math.max(0, 10 - vis),
            Math.max(0, innerWidth - vis),
          );
          content[lastIdx] = `${content[lastIdx]}${' '.repeat(pad)}`;
        }
      }

      // Blank line between fields
      if (i < this.fields.length - 1) {
        pushContent('');
      }
    }

    // Bottom separator
    pushContent('');
    pushContent(` ${ANSI.dim}${'─'.repeat(Math.min(effectiveWidth - 6, 40))}${ANSI.reset}`);

    // Instructions (short form on narrow dialogs so the hint fits)
    pushContent('');
    const fullHint = '[Tab/↑↓] navigate  [Enter] submit  [Esc] cancel';
    const shortHint = '[Tab] next [Enter] ok [Esc] cancel';
    const hint = visibleWidth(fullHint) <= innerWidth ? fullHint : shortHint;
    pushContent(`${ANSI.dim}${hint}${ANSI.reset}`);

    // ── Assemble the box ──────────────────────────────────────────
    const lines: string[] = [''];
    lines.push(borderLine('┌', '┐'));
    for (const c of content) lines.push(padLine(c));
    lines.push(borderLine('└', '┘'));
    lines.push('');

    // Fill remaining rows with blank lines (never exceeding maxRows).
    const remaining = Math.max(0, maxRows - lines.length);
    for (let i = 0; i < remaining; i++) {
      lines.push('');
    }

    return lines.slice(0, maxRows).join('\n');
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
