/**
 * packages/herdr/src/host-budget-dialog.test.ts — the interactive over-quota
 * confirmation dialog (WL-0MVXY0Z93002HKCZ F4, parent WL-0MVXWQFGV000D2AB).
 *
 * Covers the dialog half of F4:
 *   - copy: tier named, live count, cap and the overshoot (AC3/AC4);
 *   - keys: Enter/y proceeds, Esc/n cancels, cancel is the state on open and
 *     every other key leaves it there (AC5);
 *   - render: a bottom-anchored box composed within the pane height/width
 *     budget with the list still visible (AC1);
 *   - the renderer↔awaiter bridge: no renderer ⇒ cancel, unregistering a
 *     renderer settles a pending prompt as cancel (never an indefinite await).
 *
 * Run: npx vitest run packages/herdr/src/host-budget-dialog.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import {
  HostBudgetDialogState,
  createHostBudgetPromptHost,
  formatHostBudgetDialog,
  formatHostBudgetHeadline,
  hostBudgetOvershoot,
  overlayHostBudgetDialog,
  type HostBudgetPromptRequest,
} from './host-budget-dialog.js';
import { computeOverQuota } from './host-dispatch-budget.js';

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '');

function makeRequest(overrides: Partial<HostBudgetPromptRequest> = {}): HostBudgetPromptRequest {
  return { kind: 'implement', live: 2, max: 2, ...overrides };
}

// ── Copy (AC3/AC4) ────────────────────────────────────────────────────

describe('host budget dialog copy (AC3/AC4)', () => {
  it('names the tier, the live count, the cap and the overshoot', () => {
    const headline = formatHostBudgetHeadline(makeRequest({ kind: 'implement', live: 2, max: 2 }));
    expect(headline).toContain('Implement dispatch would exceed the host quota');
    expect(headline).toContain('(2 running, max 2)');
    expect(headline).toContain('over by 1.');
  });

  it('labels the audit tier', () => {
    const headline = formatHostBudgetHeadline(makeRequest({ kind: 'audit', live: 1, max: 1 }));
    expect(headline).toContain('Audit dispatch would exceed the host quota');
    expect(headline).toContain('(1 running, max 1)');
    expect(headline).toContain('over by 1.');
  });

  // AC4: at cap ⇒ over by 1; already n over cap ⇒ over by n + 1.
  it.each([
    { live: 2, max: 2, overBy: 1, label: 'exactly at cap' },
    { live: 3, max: 2, overBy: 2, label: 'one over cap' },
    { live: 4, max: 2, overBy: 3, label: 'two over cap' },
    { live: 5, max: 2, overBy: 4, label: 'three over cap' },
    { live: 0, max: 0, overBy: 1, label: 'disabled tier' },
  ])('overshoot arithmetic: $label ⇒ over by $overBy', ({ live, max, overBy }) => {
    expect(hostBudgetOvershoot({ kind: 'implement', live, max })).toBe(overBy);
    // The dialog and the dispatcher quote the same figure.
    expect(hostBudgetOvershoot({ kind: 'implement', live, max })).toBe(computeOverQuota(live, max));
    expect(formatHostBudgetHeadline({ kind: 'implement', live, max })).toContain(
      `over by ${overBy}.`,
    );
  });

  it('renders live/max for the tier (AC4)', () => {
    const headline = formatHostBudgetHeadline({ kind: 'implement', live: 4, max: 2 });
    expect(headline).toContain('(4 running, max 2)');
  });
});

// ── Key handling (AC5) ────────────────────────────────────────────────

describe('HostBudgetDialogState key handling (AC5)', () => {
  function makeDialog(): {
    state: HostBudgetDialogState;
    onProceed: ReturnType<typeof vi.fn>;
    onCancel: ReturnType<typeof vi.fn>;
  } {
    const onProceed = vi.fn();
    const onCancel = vi.fn();
    return {
      state: new HostBudgetDialogState(makeRequest(), onProceed, onCancel),
      onProceed,
      onCancel,
    };
  }

  it('opens in the safe default state (cancel)', () => {
    const { state } = makeDialog();
    expect(state.choice).toBe('cancel');
  });

  it('proceeds on Enter', () => {
    const { state, onProceed, onCancel } = makeDialog();
    expect(state.handleInput('\r')).toBe('proceed');
    expect(state.choice).toBe('proceed');
    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('proceeds on y and Y', () => {
    const lower = makeDialog();
    expect(lower.state.handleInput('y')).toBe('proceed');
    expect(lower.onProceed).toHaveBeenCalledTimes(1);

    const upper = makeDialog();
    expect(upper.state.handleInput('Y')).toBe('proceed');
    expect(upper.onProceed).toHaveBeenCalledTimes(1);
  });

  it('cancels on Esc and on n/N', () => {
    const esc = makeDialog();
    expect(esc.state.handleInput('\x1b')).toBe('cancel');
    expect(esc.state.choice).toBe('cancel');
    expect(esc.onCancel).toHaveBeenCalledTimes(1);

    const lower = makeDialog();
    expect(lower.state.handleInput('n')).toBe('cancel');
    const upper = makeDialog();
    expect(upper.state.handleInput('N')).toBe('cancel');
  });

  it('ignores every other key and stays on the safe default', () => {
    const { state, onProceed, onCancel } = makeDialog();
    for (const key of ['q', ' ', '\t', '\x1b[A', '\x1b[B', 'S']) {
      expect(state.handleInput(key)).toBeNull();
    }
    expect(state.choice).toBe('cancel');
    expect(onProceed).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('applies a coalesced chunk in order — the first terminal key wins', () => {
    const { state, onProceed } = makeDialog();
    expect(state.handleInput('yn')).toBe('proceed');
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it('cancels a coalesced chunk that starts with n', () => {
    const { state, onCancel } = makeDialog();
    expect(state.handleInput('ny')).toBe('cancel');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ── Rendering (AC1) ───────────────────────────────────────────────────

describe('formatHostBudgetDialog (AC1)', () => {
  it('renders a bordered box with the headline, figures and key hints', () => {
    const output = stripAnsi(formatHostBudgetDialog(100, makeRequest({ live: 2, max: 2 })));
    const lines = output.split('\n');
    expect(lines[0]).toContain('┌');
    expect(lines[lines.length - 1]).toContain('└');
    expect(output).toContain('Host quota exceeded — Implement dispatch');
    expect(output).toContain('Implement dispatch would exceed the host quota');
    expect(output).toContain('(2 running, max 2) — over by 1.');
    expect(output).toContain('[Enter/y] proceed anyway');
    expect(output).toContain('[Esc/n] cancel (default)');
  });

  it('never exceeds the pane width, even in a very narrow pane', () => {
    for (const cols of [20, 30, 45, 60, 80, 140]) {
      const output = formatHostBudgetDialog(cols, makeRequest());
      for (const line of output.split('\n')) {
        // Two trailing style resets are ANSI, not visible columns.
        expect(stripAnsi(line).length).toBeLessThanOrEqual(Math.max(cols, 1));
      }
    }
  });

  it('quotes the overshoot for an already-over-quota tier', () => {
    const output = stripAnsi(formatHostBudgetDialog(100, makeRequest({ live: 4, max: 2 })));
    expect(output).toContain('(4 running, max 2) — over by 3.');
  });
});

describe('overlayHostBudgetDialog (AC1)', () => {
  const list = Array.from({ length: 24 }, (_, i) => `list row ${i + 1}`).join('\n');

  it('keeps the selection list visible above the dialog', () => {
    const output = stripAnsi(overlayHostBudgetDialog(list, 100, 30, makeRequest()));
    expect(output).toContain('list row 1');
    expect(output).toContain('Host quota exceeded');
    // The dialog is bottom-anchored: its last line is the frame's last line.
    expect(output.split('\n')[output.split('\n').length - 1]).toContain('└');
  });

  it('never exceeds the pane height budget', () => {
    const output = overlayHostBudgetDialog(list, 100, 8, makeRequest());
    expect(output.split('\n').length).toBeLessThanOrEqual(8);
  });
});

// ── Prompt bridge ─────────────────────────────────────────────────────

describe('createHostBudgetPromptHost', () => {
  it('resolves cancel when no renderer is registered (safe default)', async () => {
    const host = createHostBudgetPromptHost();
    await expect(host.ask(makeRequest())).resolves.toBe('cancel');
  });

  it('opens the prompt through the registered renderer and reports the answer', async () => {
    const host = createHostBudgetPromptHost();
    let opened: HostBudgetPromptRequest | undefined;
    host.register({
      open: (request, resolve) => {
        opened = request;
        resolve('proceed');
      },
    });

    const request = makeRequest({ live: 3, max: 2 });
    await expect(host.ask(request)).resolves.toBe('proceed');
    expect(opened).toEqual(request);
  });

  it('settles a pending prompt as cancel when the renderer unregisters', async () => {
    const host = createHostBudgetPromptHost();
    let pendingResolve: ((choice: 'proceed' | 'cancel') => void) | undefined;
    const unregister = host.register({
      open: (_request, resolve) => {
        pendingResolve = resolve;
      },
    });

    const answer = host.ask(makeRequest());
    expect(pendingResolve).toBeTypeOf('function');
    unregister();
    await expect(answer).resolves.toBe('cancel');
  });

  it('cancels an already-pending prompt before opening a new one', async () => {
    const host = createHostBudgetPromptHost();
    const resolves: ((choice: 'proceed' | 'cancel') => void)[] = [];
    host.register({
      open: (_request, resolve) => {
        resolves.push(resolve);
      },
    });

    const first = host.ask(makeRequest());
    const second = host.ask(makeRequest({ kind: 'audit', live: 1, max: 1 }));
    expect(resolves).toHaveLength(2);

    await expect(first).resolves.toBe('cancel');
    resolves[1]?.('proceed');
    await expect(second).resolves.toBe('proceed');
  });
});
