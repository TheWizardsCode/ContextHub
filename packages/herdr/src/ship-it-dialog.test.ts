/**
 * packages/herdr/src/ship-it-dialog.test.ts — Unit tests for the Ship It
 * typed-confirmation dialog (WL-0MSGG5N5Z0074TLY).
 *
 * Covers:
 *   - ShipItDialogState key handling: typed-input accumulation, Backspace,
 *     case-insensitive `ship` matching on Enter, non-matching Enter (buffer
 *     cleared, dialog stays open — AC3 option (a)), Esc cancellation.
 *   - formatShipItDialog rendering: prompt, typed buffer reflection, box
 *     borders, line widths within the pane width.
 *   - overlayShipItDialog: bottom-anchored overlay — the selection list
 *     stays visible above the dialog and the output stays within the pane
 *     height budget.
 *
 * Run: npx vitest run packages/herdr/src/ship-it-dialog.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ShipItDialogState,
  formatShipItDialog,
  overlayShipItDialog,
} from './ship-it-dialog.js';

const visible = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeDialog(): { state: ShipItDialogState; onConfirm: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const state = new ShipItDialogState(onConfirm, onCancel);
  return { state, onConfirm, onCancel };
}

// ── ShipItDialogState — key handling ───────────────────────────────────

describe('ShipItDialogState — typed input', () => {
  it('appends printable characters to the buffer', () => {
    const { state } = makeDialog();
    expect(state.handleInput('s')).toBeNull();
    expect(state.handleInput('h')).toBeNull();
    expect(state.buffer).toBe('sh');
  });

  it('deletes the last character with Backspace', () => {
    const { state } = makeDialog();
    state.handleInput('s');
    state.handleInput('h');
    state.handleInput('\x7f');
    expect(state.buffer).toBe('s');
  });

  it('ignores non-printable control keys', () => {
    const { state } = makeDialog();
    expect(state.handleInput('\x1b[A')).toBeNull(); // arrow up
    expect(state.handleInput('\t')).toBeNull();
    expect(state.buffer).toBe('');
  });
});

describe('ShipItDialogState — confirmation matching (case-insensitive)', () => {
  it('submits when the buffer equals ship (lowercase)', () => {
    const { state, onConfirm } = makeDialog();
    for (const ch of 'ship') state.handleInput(ch);
    const result = state.handleInput('\r');
    expect(result).toBe('submitted');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('submits for mixed/upper case input (Ship, SHIP)', () => {
    for (const typed of ['Ship', 'SHIP', 'sHiP']) {
      const { state, onConfirm } = makeDialog();
      for (const ch of typed) state.handleInput(ch);
      expect(state.handleInput('\n')).toBe('submitted');
      expect(onConfirm).toHaveBeenCalledTimes(1);
    }
  });

  it('does not submit for a superstring of ship', () => {
    const { state, onConfirm } = makeDialog();
    for (const ch of 'shipped') state.handleInput(ch);
    const result = state.handleInput('\r');
    expect(result).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not submit for a partial match', () => {
    const { state, onConfirm } = makeDialog();
    state.handleInput('sh');
    expect(state.handleInput('\r')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clears the buffer on non-matching Enter and keeps the dialog open (AC3 option (a))', () => {
    const { state, onConfirm } = makeDialog();
    for (const ch of 'nope') state.handleInput(ch);
    expect(state.buffer).toBe('nope');
    const result = state.handleInput('\r');
    expect(result).toBeNull(); // dialog stays open
    expect(onConfirm).not.toHaveBeenCalled();
    expect(state.buffer).toBe(''); // buffer cleared so the user can retry
  });

  it('does not dispatch on Enter with an empty buffer', () => {
    const { state, onConfirm } = makeDialog();
    expect(state.handleInput('\r')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ShipItDialogState — Esc cancellation', () => {
  it('cancels with Esc without dispatching', () => {
    const { state, onConfirm, onCancel } = makeDialog();
    for (const ch of 'ship') state.handleInput(ch);
    const result = state.handleInput('\x1b');
    expect(result).toBe('cancelled');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels with Esc even with no typed input', () => {
    const { state, onCancel } = makeDialog();
    expect(state.handleInput('\x1b')).toBe('cancelled');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ── formatShipItDialog — rendering ─────────────────────────────────────

describe('formatShipItDialog — rendering', () => {
  it('renders the prompt, hint and typed buffer', () => {
    const out = visible(formatShipItDialog(80, 'sh'));
    expect(out).toContain('Ship It');
    expect(out).toContain("Type 'ship' to confirm, Esc to cancel");
    expect(out).toContain('> sh');
    expect(out).toContain('[Enter] confirm  [Esc] cancel');
  });

  it('reflects the current typed input', () => {
    const empty = visible(formatShipItDialog(80, ''));
    const typed = visible(formatShipItDialog(80, 'SHIP'));
    expect(empty).toContain('> ');
    expect(typed).toContain('> SHIP');
  });

  it('draws a bordered box', () => {
    const out = visible(formatShipItDialog(80, ''));
    expect(out).toContain('┌');
    expect(out).toContain('┐');
    expect(out).toContain('└');
    expect(out).toContain('┘');
    expect(out).toContain('│');
  });

  it('never emits a line wider than maxCols', () => {
    for (const cols of [40, 60, 80, 120]) {
      for (const buffer of ['', 's', 'shipped']) {
        for (const line of visible(formatShipItDialog(cols, buffer)).split('\n')) {
          expect(line.length).toBeLessThanOrEqual(cols);
        }
      }
    }
  });
});

// ── overlayShipItDialog — bottom-anchored composition ──────────────────

describe('overlayShipItDialog — bottom-anchored overlay', () => {
  // A 24-row list renderer output (23 lines, the rows-1 budget).
  const listLines = Array.from({ length: 23 }, (_, i) => i === 0 ? 'Work Items — 3 item(s)' : `row ${i}`);
  const listOutput = listLines.join('\n');

  it('keeps the selection list visible above the dialog', () => {
    const out = overlayShipItDialog(listOutput, 80, 24, 'ship');
    expect(out).toContain('Work Items — 3 item(s)');
    expect(out).toContain('Ship It');
  });

  it('anchors the dialog at the bottom rows', () => {
    const out = overlayShipItDialog(listOutput, 80, 24, 'ship');
    const lines = out.split('\n');
    // The dialog box is the LAST 7 lines; the list rows above remain.
    const dialogStart = lines.findIndex((l) => visible(l).includes('Ship It'));
    expect(dialogStart).toBeGreaterThanOrEqual(0);
    expect(visible(lines[lines.length - 1])).toContain('┘');
    // The header (first row) is always preserved.
    expect(visible(lines[0])).toContain('Work Items');
    // The top list rows above the dialog are unchanged.
    expect(visible(lines[1])).toBe('row 1');
  });

  it('stays within the pane height budget', () => {
    const out = overlayShipItDialog(listOutput, 80, 24, 'ship');
    expect(out.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('replaces exactly the bottom dialog-height rows (23 → 16 list + 7 dialog)', () => {
    const out = overlayShipItDialog(listOutput, 80, 24, 'ship');
    const lines = out.split('\n');
    expect(lines.length).toBe(23); // same as the list output (rows - 1)
    expect(visible(lines[15])).toBe('row 15'); // last preserved list row (16 kept)
    expect(visible(lines[16])).toContain('┌'); // dialog starts on the next row
  });

  it('never exceeds the pane height even for a short list', () => {
    const shortList = ['Work Items — 1 item(s)', ''];
    const out = overlayShipItDialog(shortList.join('\n'), 80, 24, '');
    expect(out.split('\n').length).toBeLessThanOrEqual(24);
    expect(out).toContain('Ship It');
  });
});
