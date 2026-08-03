/**
 * Unit tests for the form dialog (form-dialog.ts).
 *
 * Run: npx vitest run packages/herdr/src/form-dialog.test.ts
 *
 * Covers the rendering contract of `FormState.render(maxCols, maxRows)`:
 *   - dialog width = 80% of pane width (with min/max clamps)
 *   - every box content line is exactly as wide as the border lines
 *   - long descriptions and field values wrap at the inner content width
 *   - the dialog grows downward with wrapped content, bounded by `maxRows`
 *   - interactions (Tab/↑↓ navigation, Enter submit, Esc cancel) are preserved
 */

import { describe, it, expect } from 'vitest';
import {
  FormState,
  extractIdentifiers,
  getUnknownIdentifiers,
  substituteIdentifiers,
} from './form-dialog.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Strip ANSI SGR codes so visible width/length checks work. */
const visible = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

interface FieldOpts {
  name: string;
  value?: string;
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
    fields.map((f) => f.name),
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

/** The dialog box lines (top border .. bottom border, inclusive). */
function boxLines(out: string): string[] {
  const lines = out.split('\n');
  const top = lines.findIndex((l) => visible(l).includes('┌'));
  const bottom = lines.findIndex((l) => visible(l).includes('└'));
  return lines.slice(top, bottom + 1);
}

/** Visible width of the dialog box (excluding leading centering padding). */
function boxWidth(out: string): number {
  const top = out.split('\n').find((l) => visible(l).includes('┌'));
  if (!top) throw new Error('no dialog top border in output');
  return visible(top).trimStart().length;
}

// ── Dialog width: 80% of pane width ─────────────────────────────────────

describe('FormState.render — dialog width', () => {
  it('uses 80% of the pane width (no 60-column cap)', () => {
    expect(boxWidth(makeForm().render(100, 30))).toBe(80);
    expect(boxWidth(makeForm().render(120, 30))).toBe(96);
    expect(boxWidth(makeForm().render(200, 30))).toBe(160);
  });

  it('clamps to the 40-column minimum on narrow panes', () => {
    expect(boxWidth(makeForm().render(50, 30))).toBe(40);
    expect(boxWidth(makeForm().render(44, 30))).toBe(40);
  });

  it('never exceeds the pane width (box and full line incl. padding)', () => {
    for (const cols of [44, 50, 60, 80, 100, 140, 200]) {
      const out = makeForm().render(cols, 30);
      expect(boxWidth(out)).toBeLessThanOrEqual(cols);
      const top = out.split('\n').find((l) => visible(l).includes('┌'));
      expect(visible(top!).length).toBeLessThanOrEqual(cols);
    }
  });
});

// ── Border alignment: all box lines equal width ─────────────────────────

describe('FormState.render — border alignment', () => {
  it('renders every box line exactly as wide as the borders', () => {
    for (const cols of [44, 50, 60, 80, 100, 140]) {
      const widths = boxLines(makeForm().render(cols, 40)).map((l) => visible(l).length);
      expect(new Set(widths).size, `cols=${cols}`).toBe(1);
    }
  });

  it('keeps all lines aligned with a long description and long values', () => {
    const form = makeForm({
      description: 'A very long description that exceeds the dialog width. '.repeat(3).trim(),
      fields: [
        { name: 'status', value: 'this is a long status value '.repeat(4).trim() },
        { name: 'stage', value: '' },
      ],
    });
    const widths = boxLines(form.render(80, 40)).map((l) => visible(l).length);
    expect(new Set(widths).size).toBe(1);
  });
});

// ── Text wrapping ───────────────────────────────────────────────────────

describe('FormState.render — text wrapping', () => {
  /** Inner region between the two │ border chars of a content line. */
  const region = (l: string): string => {
    const v = visible(l);
    return v.slice(v.indexOf('│') + 1, v.lastIndexOf('│'));
  };

  /** Assert every box line is exactly border width with a padded inner region. */
  const assertAligned = (box: string[]): void => {
    const borderLineLen = visible(box[0]).length; // full line incl. leftPad
    const innerLen = region(box.find((l) => visible(l).includes('│'))!).length;
    for (const l of box) {
      const v = visible(l);
      expect(v.length).toBe(borderLineLen);
      if (v.includes('│')) expect(region(l).length).toBe(innerLen);
    }
  };

  it('wraps a long description onto multiple lines within the inner width', () => {
    const desc = 'word '.repeat(50).trim(); // ~250 chars
    const out = makeForm({ description: desc }).render(100, 40);
    const box = boxLines(out);
    const descLines = box.filter((l) => /word/.test(visible(l)));
    expect(descLines.length).toBeGreaterThan(1);
    assertAligned(box);
    // no single line packs more than the inner width of description text
    const wordsPerLine = descLines.map(
      (l) => (visible(l).match(/word/g) ?? []).length,
    );
    expect(Math.max(...wordsPerLine)).toBeLessThanOrEqual(15);
  });

  it('wraps a long field value onto multiple lines within the inner width', () => {
    const out = makeForm({
      fields: [{ name: 'status', value: 'x'.repeat(300) }],
    }).render(100, 40);
    const box = boxLines(out);
    const valueLines = box.filter((l) => /x{4,}/.test(visible(l)));
    expect(valueLines.length).toBeGreaterThan(1);
    assertAligned(box);
    // no spurious truncation markers when there is plenty of room
    expect(visible(out)).not.toContain('…');
    // wrapped lines fill the inner width (minus indent and cursor column)
    const innerWidth = boxWidth(out) - 4;
    for (const l of valueLines) {
      const xs = visible(l).match(/x+/g) ?? [''];
      expect(Math.max(...xs.map((x) => x.length))).toBeLessThanOrEqual(
        innerWidth,
      );
    }
    expect(Math.max(...valueLines.map((l) => (visible(l).match(/x+/g) ?? ['']).map((x) => x.length)).flat())).toBe(
      innerWidth - 3,
    );
  });
});

// ── Downward expansion within maxRows ───────────────────────────────────

describe('FormState.render — downward expansion within maxRows', () => {
  it('grows the dialog as a value wraps to more lines', () => {
    const short = makeForm({ fields: [{ name: 'status', value: 'short' }] }).render(100, 40);
    const long = makeForm({ fields: [{ name: 'status', value: 'x'.repeat(300) }] }).render(100, 40);
    expect(boxLines(long).length).toBeGreaterThan(boxLines(short).length);
  });

  it('never exceeds maxRows even with overflowing content', () => {
    const out = makeForm({
      description: 'd '.repeat(500).trim(),
      fields: [{ name: 'status', value: 'x'.repeat(500) }],
    }).render(80, 12);
    expect(out.split('\n').length).toBe(12);
    expect(visible(out)).toContain('└');
  });

  it('keeps the cursor indicator on the last value line when it wraps', () => {
    const out = makeForm({
      fields: [{ name: 'status', value: 'a'.repeat(120) }],
      activeField: 0,
    }).render(100, 40);
    const box = boxLines(out);
    const valueLines = box.filter((l) => /a{4,}/.test(visible(l)));
    expect(valueLines.length).toBeGreaterThan(1);
    // cursor (reversed space) sits on the final wrapped value line
    const last = valueLines[valueLines.length - 1];
    expect(last).toContain('\x1b[7m');
    for (const l of valueLines.slice(0, -1)) {
      expect(l).not.toContain('\x1b[7m');
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
      ['status', 'stage'],
      (r) => {
        result = r;
      },
      () => {},
    );
    for (const ch of 'in') state.handleInput(ch);
    state.handleInput('\t');
    for (const ch of 'prod') state.handleInput(ch);
    expect(state.handleInput('\r')).toBe('submitted');
    expect(result).toBe('wl update <id> --status in --stage prod');
  });

  it('cancels with Esc', () => {
    let cancelled = false;
    const state = new FormState('cmd <x>', 'd', ['x'], () => {}, () => {
      cancelled = true;
    });
    expect(state.handleInput('\x1b')).toBe('cancelled');
    expect(cancelled).toBe(true);
  });

  it('navigates fields with Tab and arrow keys (with wrap-around)', () => {
    const state = new FormState('cmd <a> <b> <c>', 'd', ['a', 'b', 'c'], () => {}, () => {});
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
    const state = new FormState('cmd <x>', 'd', ['x'], () => {}, () => {});
    for (const ch of 'hello') state.handleInput(ch);
    expect(state.fields[0].value).toBe('hello');
    state.handleInput('\x7f');
    expect(state.fields[0].value).toBe('hell');
  });
});

// ── Identifier helpers (auto-substitution contract) ─────────────────────

describe('identifier helpers', () => {
  it('extracts unique identifiers in order', () => {
    expect(extractIdentifiers('wl update <id> --status <status> --status <status>')).toEqual([
      'id',
      'status',
    ]);
  });

  it('treats <id> as a known identifier', () => {
    expect(getUnknownIdentifiers('wl update <id> --title <title>')).toEqual(['title']);
  });

  it('substitutes provided values and leaves unknown placeholders intact', () => {
    expect(
      substituteIdentifiers('wl update <id> --status <status>', { status: 'in_progress' }),
    ).toBe('wl update <id> --status in_progress');
  });
});
