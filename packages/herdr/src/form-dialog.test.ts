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
import {
  FormState,
  extractIdentifiers,
  getUnknownIdentifiers,
  substituteIdentifiers,
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
