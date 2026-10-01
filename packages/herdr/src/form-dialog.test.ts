/**
 * Unit tests for the form dialog (form-dialog.ts).
 *
 * Run: npx vitest run packages/herdr/src/form-dialog.test.ts
 *
 * Covers the rendering contract of `FormState.render(maxCols, maxRows)`:
 *   - No border box decoration (no ┌, ┐, └, ┘, │, ─ edges)
 *   - Content starts at top-left (no centering, no leading blank lines)
 *   - Text wraps at the full pane width (maxCols)
 *   - Output is bounded by maxRows
 *   - Interactions (Tab/↑↓ navigation, Enter submit, Esc cancel) are preserved
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  FormState,
  extractIdentifiers,
  getUnknownIdentifiers,
  substituteIdentifiers,
  shellQuote,
  unwrapBracketedPaste,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
} from './form-dialog.js';

const visible = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

interface FieldOpts {
  name: string;
  value?: string;
  default?: string;
}

function makeForm(opts: {
  description?: string;
  fields?: FieldOpts[];
  activeField?: number;
} = {}): FormState {
  const fields = opts.fields ?? [{ name: 'status' }];
  const state = new FormState(
    '!!wl update <id> --status <status> --stage <stage>',
    opts.description ?? 'Update the status of the selected work item',
    fields.map((f) => ({ name: f.name, default: f.default ?? '' })),
    () => {},
    () => {},
  );
  fields.forEach((f, i) => {
    if (state.fields[i] && f.value !== undefined) {
      state.fields[i].value = f.value;
    }
  });
  if (opts.activeField !== undefined) {
    state.activeFieldIndex = opts.activeField;
  }
  return state;
}

// ── No border box decoration ────────────────────────────────────────────

describe('FormState.render — no border box', () => {
  it('does not render any box-drawing characters', () => {
    const out = makeForm().render(100, 30);
    const vis = visible(out);
    expect(vis).not.toContain('┌');
    expect(vis).not.toContain('┐');
    expect(vis).not.toContain('└');
    expect(vis).not.toContain('┘');
    expect(vis).not.toContain('│');
    const lines = out.split('\n');
    for (const line of lines) {
      const visLine = visible(line).trim();
      expect(visLine).not.toMatch(/^─+$/);
    }
  });
});

// ── Top-left alignment ──────────────────────────────────────────────────

describe('FormState.render — top-left alignment', () => {
  it('starts content on the first line (no leading blank lines)', () => {
    const out = makeForm().render(100, 30);
    const firstLine = out.split('\n')[0];
    expect(visible(firstLine)).toMatch(/Command Input/);
  });

  it('content is not center-padded', () => {
    const out = makeForm().render(100, 30);
    const firstNonBlank = out.split('\n').find((l) => visible(l).trim().length > 0);
    expect(firstNonBlank).toBeDefined();
    expect(visible(firstNonBlank!).charAt(0)).not.toBe(' ');
  });
});

// ── Full-width wrapping ─────────────────────────────────────────────────

describe('FormState.render — full-width wrapping', () => {
  it('wraps description at full pane width (maxCols)', () => {
    const longDesc = 'word '.repeat(50).trim();
    const out = makeForm({ description: longDesc }).render(40, 30);
    const lines = out.split('\n').map(visible);
    const descLines = lines.filter((l) => /word/.test(l));
    expect(descLines.length).toBeGreaterThan(1);
    for (const dl of descLines) {
      expect(dl.length).toBeLessThanOrEqual(40);
    }
  });

  it('wraps field values at full pane width', () => {
    const out = makeForm({
      fields: [{ name: 'status', value: 'x'.repeat(200) }],
    }).render(50, 30);
    const lines = out.split('\n').map(visible);
    const valueLines = lines.filter((l) => /x{4,}/.test(l));
    expect(valueLines.length).toBeGreaterThan(1);
    for (const vl of valueLines) {
      expect(vl.length).toBeLessThanOrEqual(50);
    }
  });

  it('more wrapping at narrower width', () => {
    const longDesc = 'a '.repeat(100).trim();
    const out80 = makeForm({ description: longDesc }).render(80, 30);
    const out100 = makeForm({ description: longDesc }).render(100, 30);
    const aLines80 = out80.split('\n').map(visible).filter((l) => /a/.test(l));
    const aLines100 = out100.split('\n').map(visible).filter((l) => /a/.test(l));
    expect(aLines80.length).toBeGreaterThan(aLines100.length);
    for (const l of out80.split('\n').map(visible)) expect(l.length).toBeLessThanOrEqual(80);
    for (const l of out100.split('\n').map(visible)) expect(l.length).toBeLessThanOrEqual(100);
  });
});

// ── Content within pane bounds ──────────────────────────────────────────

describe('FormState.render — pane bounds', () => {
  it('never exceeds maxRows lines', () => {
    const out = makeForm({
      description: 'd '.repeat(500).trim(),
      fields: [{ name: 'status', value: 'x'.repeat(500) }],
    }).render(80, 12);
    expect(out.split('\n').length).toBeLessThanOrEqual(12);
  });

  it('never has a line whose visible width exceeds maxCols', () => {
    for (const cols of [20, 30, 40, 50, 80, 100, 140, 200]) {
      const out = makeForm({
        description: 'very long description text '.repeat(10),
        fields: [{ name: 'status', value: 'y'.repeat(200) }],
      }).render(cols, 30);
      for (const line of out.split('\n')) {
        const vis = visible(line);
        expect(vis.length).toBeLessThanOrEqual(cols);
      }
    }
  });
});

// ── Content retained ───────────────────────────────────────────────────

describe('FormState.render — content retained', () => {
  it('renders the Command Input heading', () => {
    const out = makeForm().render(100, 30);
    expect(visible(out)).toContain('Command Input');
  });

  it('renders the description text', () => {
    const out = makeForm({ description: 'My custom description' }).render(100, 30);
    expect(visible(out)).toContain('My custom description');
  });

  it('renders field labels', () => {
    const out = makeForm({ fields: [{ name: 'myField' }] }).render(100, 30);
    expect(visible(out)).toContain('myField');
  });

  it('renders field values', () => {
    const out = makeForm({ fields: [{ name: 'status', value: 'in_progress' }] }).render(100, 30);
    expect(visible(out)).toContain('in_progress');
  });

  it('renders action hints', () => {
    const out = makeForm().render(100, 30);
    expect(visible(out)).toContain('navigate');
    expect(visible(out)).toContain('submit');
    expect(visible(out)).toContain('cancel');
  });

  it('shows the cursor indicator on the active field', () => {
    const out = makeForm({ fields: [{ name: 'status' }], activeField: 0 }).render(100, 30);
    expect(out).toContain('\x1b[7m');
  });

  it('places a space between icon glyphs and adjacent text', () => {
    const out = makeForm().render(100, 30);
    expect(visible(out)).toMatch(/⌨ Command/);
  });
});

// ── Downward expansion ──────────────────────────────────────────────────

describe('FormState.render — downward expansion', () => {
  it('grows the page as a value wraps to more lines', () => {
    const short = makeForm({ fields: [{ name: 'status', value: 'short' }] }).render(100, 40);
    const long = makeForm({ fields: [{ name: 'status', value: 'x'.repeat(300) }] }).render(100, 40);
    const sNonBlank = short.split('\n').filter((l) => visible(l).trim().length > 0).length;
    const lNonBlank = long.split('\n').filter((l) => visible(l).trim().length > 0).length;
    expect(lNonBlank).toBeGreaterThan(sNonBlank);
  });

  it('renders multi-line field values wrapped without layout breakage', () => {
    const out = makeForm({ fields: [{ name: 'status', value: 'line one\nline two\nline three' }] }).render(40, 40);
    const vis = out.split('\n').map(visible);
    expect(vis.some((l) => /line one/.test(l))).toBe(true);
    expect(vis.some((l) => /line two/.test(l))).toBe(true);
    expect(vis.some((l) => /line three/.test(l))).toBe(true);
    // No line exceeds the pane width.
    for (const line of vis) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
});

// ── Interactions preserved ──────────────────────────────────────────────

describe('FormState interactions', () => {
  it('submits with Enter and substitutes field values', () => {
    let result = '';
    const state = new FormState(
      'wl update <id> --status <status> --stage <stage>',
      'd',
      [{ name: 'status', default: '' }, { name: 'stage', default: '' }],
      (r) => { result = r; },
      () => {},
    );
    for (const ch of 'in') state.handleInput(ch);
    state.handleInput('\t');
    for (const ch of 'prod') state.handleInput(ch);
    expect(state.handleInput('\r')).toEqual({ type: 'submitted' });
    expect(result).toBe('wl update <id> --status in --stage prod');
  });

  it('cancels with Esc', () => {
    let cancelled = false;
    const state = new FormState('cmd <x>', 'd', [{ name: 'x', default: '' }], () => {}, () => {
      cancelled = true;
    });
    expect(state.handleInput('\x1b')).toEqual({ type: 'cancelled' });
    expect(cancelled).toBe(true);
  });

  it('navigates fields with Tab and arrow keys', () => {
    const state = new FormState(
      'cmd <a> <b> <c>',
      'd',
      [{ name: 'a', default: '' }, { name: 'b', default: '' }, { name: 'c', default: '' }],
      () => {},
      () => {},
    );
    expect(state.activeFieldIndex).toBe(0);
    state.handleInput('\t');
    expect(state.activeFieldIndex).toBe(1);
    state.handleInput('\x1b[B');
    expect(state.activeFieldIndex).toBe(2);
    state.handleInput('\x1b[A');
    expect(state.activeFieldIndex).toBe(1);
    state.handleInput('\t');
    expect(state.activeFieldIndex).toBe(2);
    state.handleInput('\t');
    expect(state.activeFieldIndex).toBe(0);
  });

  it('edits the active field value with character input and backspace', () => {
    const state = new FormState('cmd <x>', 'd', [{ name: 'x', default: '' }], () => {}, () => {});
    for (const ch of 'hello') state.handleInput(ch);
    expect(state.fields[0].value).toBe('hello');
    state.handleInput('\x7f');
    expect(state.fields[0].value).toBe('hell');
  });

  it('pre-fills fields with their inline default value', () => {
    const state = new FormState(
      'wl create <description> --priority <priority default="medium">',
      'd',
      [{ name: 'description', default: '' }, { name: 'priority', default: 'medium' }],
      () => {},
      () => {},
    );
    expect(state.fields[0].value).toBe('');
    expect(state.fields[1].value).toBe('medium');
    expect(state.getResult()).toBe('wl create  --priority medium');
  });

  it('lets the user override an inline default', () => {
    const state = new FormState(
      'wl create <description> --priority <priority default="medium">',
      'd',
      [{ name: 'description', default: '' }, { name: 'priority', default: 'medium' }],
      () => {},
      () => {},
    );
    state.handleInput('\t');
    for (let i = 0; i < 'medium'.length; i++) state.handleInput('\x7f');
    for (const ch of 'high') state.handleInput(ch);
    expect(state.getResult()).toBe('wl create  --priority high');
  });
});

// ── Coalesced chunk handling — fast typing (WL-0MTV67MZU003H7SH) ──────
// Fast typing delivers several keystrokes in one stdin chunk; every
// character must be preserved (previously the whole chunk was dropped).

describe('FormState coalesced chunk handling (fast typing)', () => {
  it('appends every character from a single multi-character chunk', () => {
    const state = makeForm({ fields: [{ name: 'status' }] });
    state.handleInput('hello');
    expect(state.fields[0].value).toBe('hello');
  });

  it('preserves characters across many coalesced chunks (no drops)', () => {
    const state = makeForm({ fields: [{ name: 'status' }] });
    for (const chunk of ['the ', 'quick ', 'brown ', 'fox']) state.handleInput(chunk);
    expect(state.fields[0].value).toBe('the quick brown fox');
  });

  it('applies printable characters before an escape sequence in the same chunk', () => {
    const state = makeForm({ fields: [{ name: 'a' }, { name: 'b' }] });
    state.handleInput('ab\x1b[B');
    expect(state.fields[0].value).toBe('ab');
    expect(state.activeFieldIndex).toBe(1);
  });

  it('submits when a candidate chunk ends with Enter, keeping preceding characters', () => {
    let submitted: string | null = null;
    const state = new FormState('cmd <x>', 'd', [{ name: 'x', default: '' }],
      (r) => { submitted = r; }, () => {});
    state.handleInput('value\r');
    expect(submitted).toBe('cmd value');
  });

  it('applies Backspace inside a coalesced chunk', () => {
    const state = makeForm({ fields: [{ name: 'status' }] });
    state.handleInput('abc\x7f');
    expect(state.fields[0].value).toBe('ab');
  });

  it('navigates fields with Tab inside a coalesced chunk', () => {
    const state = makeForm({ fields: [{ name: 'a' }, { name: 'b' }] });
    state.handleInput('a\tb');
    expect(state.fields[0].value).toBe('a');
    expect(state.fields[1].value).toBe('b');
  });

  it('cancels when a chunk contains Esc (terminal result)', () => {
    let cancelled = false;
    const state = new FormState('cmd <x>', 'd', [{ name: 'x', default: '' }],
      () => {}, () => { cancelled = true; });
    state.handleInput('\x1b');
    expect(cancelled).toBe(true);
  });

  it('still inserts a full self-contained bracketed paste verbatim', () => {
    const state = makeForm({ fields: [{ name: 'status' }] });
    state.handleInput(`${BRACKETED_PASTE_START}multi\nline${BRACKETED_PASTE_END}`);
    expect(state.fields[0].value).toBe('multi\nline');
  });
});

// ── Paste / cut / newline / bracketed-paste (WL-0MSW6KCTA0092DCV) ────

describe('FormState paste & cut', () => {
  it('Ctrl+V returns a paste request without touching the field', () => {
    const state = makeForm({ fields: [{ name: 'status', value: 'abc' }] });
    expect(state.handleInput('\x16')).toEqual({ type: 'paste' });
    expect(state.fields[0].value).toBe('abc');
  });

  it('pasteText inserts clipboard text verbatim (newlines preserved)', () => {
    const state = makeForm({ fields: [{ name: 'status', value: 'abc' }] });
    state.pasteText('line1\nline2\r\nline3');
    expect(state.fields[0].value).toBe('abcline1\nline2\r\nline3');
  });

  it('a pasted newline does not submit the form', () => {
    let submitted = false;
    const state = new FormState('cmd <x>', 'd', [{ name: 'x', default: '' }],
      () => { submitted = true; }, () => {});
    state.pasteText('multi\nline');
    expect(submitted).toBe(false);
    expect(state.fields[0].value).toBe('multi\nline');
    // A subsequent plain Enter still submits normally.
    expect(state.handleInput('\r')).toEqual({ type: 'submitted' });
    expect(submitted).toBe(true);
  });

  it('Ctrl+X clears the field and returns the copied text', () => {
    const state = makeForm({ fields: [{ name: 'status', value: 'copy me' }] });
    const res = state.handleInput('\x18');
    expect(res).toEqual({ type: 'cut', text: 'copy me' });
    expect(state.fields[0].value).toBe('');
  });

  it('Ctrl+X on an empty field returns empty text and stays empty', () => {
    const state = makeForm({ fields: [{ name: 'status', value: '' }] });
    const res = state.handleInput('\x18');
    expect(res).toEqual({ type: 'cut', text: '' });
    expect(state.fields[0].value).toBe('');
  });

  it('cut operates on the active field only', () => {
    const state = makeForm({ fields: [{ name: 'a', value: 'first' }, { name: 'b', value: 'second' }] });
    state.activeFieldIndex = 1;
    const res = state.handleInput('\x18');
    expect(res).toEqual({ type: 'cut', text: 'second' });
    expect(state.fields[1].value).toBe('');
    expect(state.fields[0].value).toBe('first');
  });

  it('notifyPasteFailed exposes the failure reason (additive, no data loss)', () => {
    const state = makeForm({ fields: [{ name: 'status', value: 'keep' }] });
    expect(state.notifyPasteFailed('no clipboard reader available')).toBe(
      'no clipboard reader available',
    );
    expect(state.fields[0].value).toBe('keep');
  });
});

describe('FormState Ctrl+Enter newline', () => {
  it('inserts a newline into the active field instead of submitting', () => {
    let submitted = false;
    const state = new FormState('cmd <x>', 'd', [{ name: 'x', default: '' }],
      () => { submitted = true; }, () => {});
    state.handleInput('f');
    state.handleInput('i');
    state.handleInput('r');
    state.handleInput('s');
    state.handleInput('t');
    state.handleInput('\x1b[13;5u');
    expect(state.fields[0].value).toBe('first\n');
    expect(submitted).toBe(false);
  });

  it('plain Enter still submits after a Ctrl+Enter newline', () => {
    let submitted = false;
    const state = new FormState('cmd <x>', 'd', [{ name: 'x', default: '' }],
      () => { submitted = true; }, () => {});
    state.handleInput('a');
    state.handleInput('\x1b[13;5u');
    state.handleInput('b');
    expect(state.handleInput('\r')).toEqual({ type: 'submitted' });
    expect(submitted).toBe(true);
  });
});

describe('bracketed-paste unwrapping', () => {
  it('extracts inner text from a fully wrapped chunk', () => {
    expect(unwrapBracketedPaste(`${BRACKETED_PASTE_START}hello\nworld${BRACKETED_PASTE_END}`)).toBe('hello\nworld');
  });

  it('returns undefined for a chunk with no wrapper', () => {
    expect(unwrapBracketedPaste('plain text')).toBeUndefined();
  });

  it('inserts a full self-contained bracketed paste verbatim', () => {
    const state = makeForm({ fields: [{ name: 'status', value: '' }] });
    state.handleInput(`${BRACKETED_PASTE_START}multi\nline content${BRACKETED_PASTE_END}`);
    expect(state.fields[0].value).toBe('multi\nline content');
  });

  it('accumulates char-by-char bracketed paste across open/close markers', () => {
    const state = makeForm({ fields: [{ name: 'status', value: '' }] });
    state.handleInput(BRACKETED_PASTE_START);
    for (const ch of ['h', 'i', '\n', 'y', 'o', 'u']) state.handleInput(ch);
    state.handleInput(BRACKETED_PASTE_END);
    expect(state.fields[0].value).toBe('hi\nyou');
  });

  it('does not submit on a newline inside a bracketed paste', () => {
    let submitted = false;
    const state = new FormState('cmd <x>', 'd', [{ name: 'x', default: '' }],
      () => { submitted = true; }, () => {});
    state.handleInput(BRACKETED_PASTE_START);
    state.handleInput('\n');
    state.handleInput(BRACKETED_PASTE_END);
    expect(submitted).toBe(false);
    expect(state.fields[0].value).toBe('\n');
  });

  it('strips wrapper markers when they bracket the chunk', () => {
    expect(unwrapBracketedPaste(`${BRACKETED_PASTE_START}tail`)).toBe('tail');
    expect(unwrapBracketedPaste(`head${BRACKETED_PASTE_END}`)).toBe('head');
  });
});

// ── Identifier helpers ──────────────────────────────────────────────────

describe('identifier helpers', () => {
  it('extracts unique identifiers in order', () => {
    expect(extractIdentifiers('wl update <id> --status <status> --status <status>')).toEqual([
      { name: 'id', default: '' },
      { name: 'status', default: '' },
    ]);
  });

  it('extracts inline defaults alongside identifiers', () => {
    expect(extractIdentifiers('wl create <description> --priority <priority default="medium">')).toEqual([
      { name: 'description', default: '' },
      { name: 'priority', default: 'medium' },
    ]);
  });

  it('supports single-quoted defaults', () => {
    expect(extractIdentifiers("wl create <description> --priority <priority default='medium'>")).toEqual([
      { name: 'description', default: '' },
      { name: 'priority', default: 'medium' },
    ]);
  });

  it('treats <id> as a known identifier', () => {
    expect(getUnknownIdentifiers('wl update <id> --title <title>')).toEqual([
      { name: 'title', default: '' },
    ]);
  });

  it('reports defaults on unknown identifiers', () => {
    expect(getUnknownIdentifiers('wl create <description> --priority <priority default="medium">')).toEqual([
      { name: 'description', default: '' },
      { name: 'priority', default: 'medium' },
    ]);
  });

  it('substitutes provided values and leaves unknown placeholders intact', () => {
    expect(substituteIdentifiers('wl update <id> --status <status>', { status: 'in_progress' })).toBe(
      'wl update <id> --status in_progress',
    );
  });

  it('substitutes the inline default when no explicit value is given', () => {
    expect(
      substituteIdentifiers('wl create <description> --priority <priority default="medium">', {
        description: 'A new item',
      }),
    ).toBe('wl create A new item --priority medium');
  });

  it('gives explicit values precedence over inline defaults', () => {
    expect(
      substituteIdentifiers('wl create <description> --priority <priority default="medium">', {
        description: 'A new item',
        priority: 'high',
      }),
    ).toBe('wl create A new item --priority high');
  });
});

// ── Shell-escaping of user-provided values (WL-0MU7KEX65004X0U9) ──────

/** Execute `command` through bash and return its stdout (verbatim `%s`). */
function bashPrint(command: string): { stdout: string; status: number | null } {
  const result = spawnSync('bash', ['-c', command], { encoding: 'utf8' });
  return { stdout: result.stdout, status: result.status };
}

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('in_progress')).toBe("'in_progress'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("don't")).toBe("'don'\\''t'");
  });

  it('leaves double quotes, dollars and backticks literal (single-quoted)', () => {
    expect(shellQuote('$HOME `id` "x"')).toBe("'$HOME `id` \"x\"'");
  });

  it('preserves an empty value as an empty quoted segment', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('substituteIdentifiers — shell-route escaping', () => {
  const AR_TEMPLATE =
    "!!wl reviewed <id> false && wl update <id> --status open --stage plan_complete --priority medium && wl audit-set <id> --ready-to-close no --summary 'Rejected by manual review. <reason>'";

  it('escapes only the apostrophe inside the existing single-quoted summary', () => {
    const out = substituteIdentifiers(AR_TEMPLATE, { reason: "don't" });
    expect(out).toContain("--summary 'Rejected by manual review. don'\\''t'");
    // <id> is known and must remain a placeholder for later resolution.
    expect(out).toContain('<id>');
  });

  it('escapes an apostrophe inside a producer-comment quoted body', () => {
    const template =
      "!!wl reviewed <id> && wl comment add <id> --body '<producer_comment>' --author <author>";
    const out = substituteIdentifiers(template, {
      producer_comment: "it's a comment; rm -rf /",
      author: 'Map',
    });
    expect(out).toContain("--body 'it'\\''s a comment; rm -rf /'");
    expect(out).toContain('--author \'Map\'');
  });

  it('shell-quotes a bare placeholder value', () => {
    expect(
      substituteIdentifiers('!!wl update <id> --title <title>', {
        title: "Bob's work; rm -rf / #",
      }),
    ).toBe("!!wl update <id> --title 'Bob'\\''s work; rm -rf / #'");
  });

  it('does not shell-quote agent-prompt values (raw argv, no shell)', () => {
    expect(
      substituteIdentifiers('/herdr:note-edit <note_text>', {
        note_text: "don't shell-escape me",
      }),
    ).toBe("/herdr:note-edit don't shell-escape me");
  });

  it('ignores quoted inline defaults when detecting the quoting context', () => {
    // The `'x'` default before <b> must not be mistaken for an open quote
    // around <b>; <b> sits inside the following single quotes.
    expect(
      substituteIdentifiers("!!cmd <a default='x'> '<b>'", { b: "y'z" }),
    ).toBe("!!cmd 'x' 'y'\\''z'");
  });

  it('keeps valid simple input functional for update and search', () => {
    expect(
      substituteIdentifiers('!!wl update <id> --status <status> --stage <stage>', {
        status: 'open',
        stage: 'plan_complete',
      }),
    ).toBe("!!wl update <id> --status 'open' --stage 'plan_complete'");
    expect(
      substituteIdentifiers('!!wl search <search_term>', { search_term: 'apostrophe' }),
    ).toBe("!!wl search 'apostrophe'");
  });
});

// End-to-end: the generated command must parse in bash and deliver the
// user's text verbatim. `printf '%s'` echoes back exactly what the shell
// passed, so an injection or a premature quote-termination would show up as
// different stdout (or a non-zero status).
describe.skipIf(process.platform === 'win32')('substituteIdentifiers — bash round-trip', () => {
  it("preserves a reason containing an apostrophe (regression WL-0MU7KEX65004X0U9)", () => {
    const { stdout, status } = bashPrint(
      substituteIdentifiers("!!printf '%s' 'Rejected by manual review. <reason>'", {
        reason: "Why don't we just do this?",
      }).replace(/^!+/, ''),
    );
    expect(status).toBe(0);
    expect(stdout).toBe("Rejected by manual review. Why don't we just do this?");
  });

  it('preserves the full metacharacter set verbatim', () => {
    const malicious = `don't $(whoami) \`id\` "quoted" ; rm -rf / | cat & echo \\ end`;
    const { stdout, status } = bashPrint(
      substituteIdentifiers("!!printf '%s' '<reason>'", { reason: malicious }).replace(/^!+/, ''),
    );
    expect(status).toBe(0);
    expect(stdout).toBe(malicious);
  });

  it('preserves newlines inside the value', () => {
    const value = 'line one\nline two';
    const { stdout, status } = bashPrint(
      substituteIdentifiers("!!printf '%s' '<reason>'", { reason: value }).replace(/^!+/, ''),
    );
    expect(status).toBe(0);
    expect(stdout).toBe(value);
  });

  it('escapes values inside a double-quoted template segment', () => {
    const value = 'a "b" $HOME `id` \\ end';
    const { stdout, status } = bashPrint(
      substituteIdentifiers('!!printf "%s" "<reason>"', { reason: value }).replace(/^!+/, ''),
    );
    expect(status).toBe(0);
    expect(stdout).toBe(value);
  });

  it('does not execute an injected command substituted as a value', () => {
    const injection = "'; echo INJECTED; '";
    const { stdout, status } = bashPrint(
      substituteIdentifiers("!!printf '%s' '<reason>'", { reason: injection }).replace(/^!+/, ''),
    );
    expect(status).toBe(0);
    expect(stdout).toBe(injection);
  });
});
