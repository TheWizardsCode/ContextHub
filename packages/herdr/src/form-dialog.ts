/**
 * packages/herdr/src/form-dialog.ts — Form dialog for unknown identifiers
 *
 * Provides identifier extraction, form state management, rendering, and
 * input handling for chord commands that contain unknown <identifier>
 * patterns. Known identifiers like <id> are auto-resolved; unknown ones
 * trigger an interactive form overlay in the TUI.
 */

// ── Identifier extraction ─────────────────────────────────────────────

const IDENTIFIER_RE = /<([a-zA-Z_][a-zA-Z0-9_]*)>/g;

/**
 * Extract all unique <identifier> patterns from a command string.
 *
 * @param command - The command string to scan
 * @returns Array of unique identifier names (without angle brackets)
 */
export function extractIdentifiers(command: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(IDENTIFIER_RE.source, 'g');
  while ((match = re.exec(command)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      result.push(name);
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
 * @returns Array of unknown identifier names (without angle brackets)
 */
export function getUnknownIdentifiers(command: string): string[] {
  return extractIdentifiers(command).filter(
    (name) => !KNOWN_IDENTIFIERS.has(name),
  );
}

// ── Substitution ──────────────────────────────────────────────────────

/**
 * Substitute all <identifier> placeholders in a command with provided values.
 *
 * @param command - The command template with <identifier> placeholders
 * @param values - Map of identifier name to replacement value
 * @returns The command with all matching placeholders replaced
 */
export function substituteIdentifiers(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(/<([a-zA-Z_][a-zA-Z0-9_]*)>/g, (_, name: string) => {
    return name in values ? values[name] : `<${name}>`;
  });
}

// ── Form types ────────────────────────────────────────────────────────

export interface FormField {
  /** Identifier name (e.g., 'title', 'status') */
  name: string;
  /** Current text value entered by the user */
  value: string;
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
    unknownIdentifiers: string[],
    onSubmit: (result: string) => void,
    onCancel: () => void,
  ) {
    this.commandTemplate = commandTemplate;
    this.description = description || commandTemplate;
    this.fields = unknownIdentifiers.map((name) => ({
      name,
      value: '',
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
   * @param maxCols - Terminal width
   * @param maxRows - Terminal height
   * @returns The rendered overlay string, ready for stdout
   */
  render(maxCols: number, maxRows: number): string {
    const lines: string[] = [];
    const dialogWidth = Math.min(maxCols - 4, 60);
    const dialogMinWidth = 40;
    const effectiveWidth = Math.max(dialogMinWidth, dialogWidth);
    const leftPad = Math.max(0, Math.floor((maxCols - effectiveWidth) / 2));

    const padLine = (content: string): string => {
      const visibleLen = content.replace(/\x1b\[[0-9;]*m/g, '').length;
      const padding = effectiveWidth - visibleLen - 2; // 2 for border spaces
      const rightPad = Math.max(0, padding);
      return ' '.repeat(leftPad) + `│ ${content}${' '.repeat(rightPad)} │`;
    };

    const borderLine = (left: string, right: string): string => {
      return ' '.repeat(leftPad) + `${left}${'─'.repeat(effectiveWidth - 2)}${right}`;
    };

    // ── Build form content ────────────────────────────────────────

    lines.push('');

    // Top border
    lines.push(borderLine('┌', '┐'));

    // Title
    lines.push(padLine(`${ANSI.bold}${ANSI.fg(76)}⌨ Command Input${ANSI.reset}`));
    lines.push(padLine(''));

    // Description
    const descLine = ` ${ANSI.fg(33)}${this.description}${ANSI.reset}`;
    lines.push(padLine(descLine));

    // Separator
    lines.push(padLine(` ${ANSI.dim}${'─'.repeat(Math.min(effectiveWidth - 6, 40))}${ANSI.reset}`));
    lines.push(padLine(''));

    // Fields
    for (let i = 0; i < this.fields.length; i++) {
      const field = this.fields[i];
      const isActive = i === this.activeFieldIndex;

      // Label line
      const labelPrefix = isActive ? `${ANSI.fg(76)}▶${ANSI.reset} ` : '  ';
      const labelStyle = isActive ? `${ANSI.bold}${ANSI.fg(76)}` : `${ANSI.dim}`;
      const labelLine = `${labelPrefix}${labelStyle}${field.name}:${ANSI.reset}`;
      lines.push(padLine(labelLine));

      // Value line — show the typed value with cursor indicator
      const displayValue = field.value || '';
      const cursorStyle = isActive ? `${ANSI.reverse} ${ANSI.reset}` : ' ';
      const valueDisplay = isActive
        ? `${displayValue}${cursorStyle}`
        : `${displayValue}${' '.repeat(Math.max(1, 10 - displayValue.length))}`;
      const valueStyle = isActive ? `${ANSI.fg(33)}` : `${ANSI.dim}`;
      const valueLine = `  ${valueStyle}${valueDisplay}${ANSI.reset}`;
      lines.push(padLine(valueLine));

      // Blank line between fields
      if (i < this.fields.length - 1) {
        lines.push(padLine(''));
      }
    }

    // Separator
    lines.push(padLine(''));
    lines.push(padLine(` ${ANSI.dim}${'─'.repeat(Math.min(effectiveWidth - 6, 40))}${ANSI.reset}`));

    // Instructions
    lines.push(padLine(''));
    const instructionLine = `${ANSI.dim}[Tab/↑↓] navigate  [Enter] submit  [Esc] cancel${ANSI.reset}`;
    lines.push(padLine(instructionLine));

    // Bottom border
    lines.push(borderLine('└', '┘'));
    lines.push('');

    // Calculate total lines used
    const totalLines = lines.length;

    // If there's room below the dialog, add blank lines to fill
    const remaining = Math.max(0, maxRows - totalLines);
    for (let i = 0; i < remaining; i++) {
      lines.push('');
    }

    return lines.join('\n');
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
