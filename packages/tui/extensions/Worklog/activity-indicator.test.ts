/**
 * Unit tests for activity-indicator.ts — the Worklog Pi extension's footer
 * activity status line (WL-0MVGB23MM004X501).
 *
 * This file was deleted by WL-0MSGI7PV9004UD0N (commit 386ba9a2) as part of
 * the Blessed TUI sweep and is restored here because the title-resolution
 * path had no behavioural coverage. Covered:
 *
 * - `detectWorkItemId` matching.
 * - `formatCommandContext` command formatting.
 * - The footer shows command + truncated ID + resolved title (AC1).
 * - The footer falls back to the raw text when the lookup fails (AC5) and
 *   when no ID is present.
 * - Non-TUI environments degrade gracefully (no setStatus → no-op).
 * - The single shared resolver is used for the title lookup (AC3).
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/activity-indicator.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock the shared title resolver ─────────────────────────────────────
// The module under test must NEVER shell out directly: it routes every
// title lookup through lib/work-item-title.ts (AC3). Mocking it lets tests
// verify the footer composition without spawning the wl CLI.

const mocks = vi.hoisted(() => ({
  mockResolveWorkItemTitle: vi.fn(),
}));

vi.mock('./lib/work-item-title.js', () => ({
  resolveWorkItemTitle: mocks.mockResolveWorkItemTitle,
  TITLE_LOOKUP_TIMEOUT_MS: 5000,
  resetTitleLookupCache: vi.fn(),
}));

import {
  detectWorkItemId,
  formatCommandContext,
  showActivity,
  showActivityWithTitleLookup,
  clearActivity,
  registerActivityIndicator,
  ACTIVITY_STATUS_KEY,
  WORK_ITEM_ID_REGEX,
} from './activity-indicator.js';
import { truncateWorkItemId } from './terminal-utils.js';

// ── Test doubles ───────────────────────────────────────────────────────

function makeStatusCtx(theme: boolean = true): { ui: any } {
  return {
    ui: {
      setStatus: vi.fn(),
      ...(theme ? { theme: { fg: (color: string, text: string) => `[${color}]${text}` } } : {}),
    },
  };
}

beforeEach(() => {
  mocks.mockResolveWorkItemTitle.mockReset();
  mocks.mockResolveWorkItemTitle.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── detectWorkItemId ───────────────────────────────────────────────────

describe('detectWorkItemId', () => {
  it('detects a work item ID in a command line', () => {
    expect(detectWorkItemId('/intake RISE-0MVCFSM9B0019M8L')).toBe('RISE-0MVCFSM9B0019M8L');
  });

  it('returns the first ID when several are present', () => {
    expect(detectWorkItemId('WL-0MQL0T5TR0060AEH and WL-0MQLJU82A000AT2W')).toBe('WL-0MQL0T5TR0060AEH');
  });

  it('returns null when no ID is present', () => {
    expect(detectWorkItemId('/wl list')).toBeNull();
    expect(detectWorkItemId('plain text')).toBeNull();
    expect(detectWorkItemId('')).toBeNull();
  });

  it('matches the exported regex so they cannot drift', () => {
    expect(WORK_ITEM_ID_REGEX.test('POD-0MVCFSM9B0019M8L')).toBe(true);
    expect(detectWorkItemId('POD-0MVCFSM9B0019M8L')).toBe('POD-0MVCFSM9B0019M8L');
  });
});

// ── formatCommandContext ───────────────────────────────────────────────

describe('formatCommandContext', () => {
  it('strips the /skill: prefix', () => {
    expect(formatCommandContext('/skill:audit WL-0MQL0T5TR0060AEH')).toBe('audit');
  });

  it('keeps other commands as-is', () => {
    expect(formatCommandContext('/intake RISE-0MVCFSM9B0019M8L')).toBe('/intake');
    expect(formatCommandContext('/implement WL-0MQL0T5TR0060AEH')).toBe('/implement');
  });

  it('handles non-command text', () => {
    expect(formatCommandContext('just some text')).toBe('just');
  });
});

// ── showActivity ───────────────────────────────────────────────────────

describe('showActivity', () => {
  it('sets the activity status with a ⏵ prefix and theme accent', () => {
    const ctx = makeStatusCtx(true);
    showActivity(ctx, '/intake RISE-0MVCFSM9B0019M8L');
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      ACTIVITY_STATUS_KEY,
      '[accent]⏵ /intake RISE-0MVCFSM9B0019M8L',
    );
  });

  it('degrades gracefully in non-TUI environments (no setStatus)', () => {
    const ctx = { ui: {} };
    expect(() => showActivity(ctx as any, '/intake RISE-0MVCFSM9B0019M8L')).not.toThrow();
  });

  it('is a no-op when explicitly suppressed', () => {
    const ctx = makeStatusCtx(true);
    showActivity(ctx, 'text', false);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });
});

// ── showActivityWithTitleLookup ────────────────────────────────────────

describe('showActivityWithTitleLookup', () => {
  it('shows the raw text immediately, then command + ID + title (AC1)', async () => {
    const ctx = makeStatusCtx(false);
    mocks.mockResolveWorkItemTitle.mockResolvedValue('AI cards should be face down');

    await showActivityWithTitleLookup(ctx, '/intake RISE-0MVCFSM9B0019M8L');

    const id = 'RISE-0MVCFSM9B0019M8L';
    const expectedFinal = `/intake ${truncateWorkItemId(id)} AI cards should be face down`;
    const calls = ctx.ui.setStatus.mock.calls.map((c: any[]) => c[1]);
    expect(calls[0]).toBe('⏵ /intake RISE-0MVCFSM9B0019M8L');   // raw first
    expect(calls[calls.length - 1]).toContain(expectedFinal);
  });

  it('routes the lookup through the shared resolver (AC3)', async () => {
    const ctx = makeStatusCtx(true);
    mocks.mockResolveWorkItemTitle.mockResolvedValue('Some title');

    await showActivityWithTitleLookup(ctx, '/implement WL-0MQL0T5TR0060AEH');

    expect(mocks.mockResolveWorkItemTitle).toHaveBeenCalledWith('WL-0MQL0T5TR0060AEH');
  });

  it('keeps the raw text when the title lookup fails (AC5)', async () => {
    const ctx = makeStatusCtx(false);
    mocks.mockResolveWorkItemTitle.mockResolvedValue(null);

    await showActivityWithTitleLookup(ctx, '/intake RISE-0MVCFSM9B0019M8L');

    const calls = ctx.ui.setStatus.mock.calls.map((c: any[]) => c[1]);
    // Only the initial raw display — no replacement, no error.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('⏵ /intake RISE-0MVCFSM9B0019M8L');
  });

  it('does not attempt a title lookup when no ID is present', async () => {
    const ctx = makeStatusCtx(false);
    await showActivityWithTitleLookup(ctx, '/wl list');
    expect(mocks.mockResolveWorkItemTitle).not.toHaveBeenCalled();
  });

  it('survives a stale context after the async boundary (WL-0MUL1BG09005VRBO)', async () => {
    const ctx = makeStatusCtx(true);
    mocks.mockResolveWorkItemTitle.mockResolvedValue('A title');
    // Session replaced during lookup → showActivity throws on the second call.
    ctx.ui.setStatus.mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error('stale ctx'); });

    await expect(showActivityWithTitleLookup(ctx, '/intake RISE-0MVCFSM9B0019M8L')).resolves.toBeUndefined();
  });
});

// ── clearActivity ──────────────────────────────────────────────────────

describe('clearActivity', () => {
  it('clears the activity status', () => {
    const ctx = makeStatusCtx(true);
    clearActivity(ctx as any);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, undefined);
  });

  it('degrades gracefully when setStatus is unavailable', () => {
    expect(() => clearActivity({ ui: {} } as any)).not.toThrow();
  });
});

// ── registerActivityIndicator (integration of handlers) ────────────────

describe('registerActivityIndicator', () => {
  function makeFakePi() {
    const handlers = new Map<string, Function>();
    return {
      handlers,
      on: vi.fn((event: string, handler: Function) => {
        handlers.set(event, handler);
        return handler;
      }),
    };
  }

  it('registers input and session_start handlers', () => {
    const pi = makeFakePi();
    registerActivityIndicator(pi as any, () => true);
    expect(pi.handlers.has('input')).toBe(true);
    expect(pi.handlers.has('session_start')).toBe(true);
  });

  it('shows command + ID + title in the footer for /intake with a cross-project ID', async () => {
    const pi = makeFakePi();
    registerActivityIndicator(pi as any, () => true);

    const ctx = makeStatusCtx(false);
    mocks.mockResolveWorkItemTitle.mockResolvedValue('AI cards should be face down');

    const inputHandler = pi.handlers.get('input') as Function;
    await inputHandler({ text: ' /intake RISE-0MVCFSM9B0019M8L ' }, ctx);

    const id = 'RISE-0MVCFSM9B0019M8L';
    const calls = ctx.ui.setStatus.mock.calls.map((c: any[]) => c[1]);
    expect(calls[0]).toBe('⏵ /intake RISE-0MVCFSM9B0019M8L');
    expect(calls[calls.length - 1]).toContain(`/intake ${truncateWorkItemId(id)} AI cards should be face down`);
    // The lookup went through the shared resolver.
    expect(mocks.mockResolveWorkItemTitle).toHaveBeenCalledWith(id);
  });

  it('falls back to raw text when resolution fails (AC5)', async () => {
    const pi = makeFakePi();
    registerActivityIndicator(pi as any, () => true);

    const ctx = makeStatusCtx(false);
    mocks.mockResolveWorkItemTitle.mockResolvedValue(null);

    const inputHandler = pi.handlers.get('input') as Function;
    await inputHandler({ text: '/intake RISE-0MVCFSM9B0019M8L' }, ctx);

    const calls = ctx.ui.setStatus.mock.calls.map((c: any[]) => c[1]);
    expect(calls).toEqual(['⏵ /intake RISE-0MVCFSM9B0019M8L']);
  });

  it('handles skills without a work item ID through the existing path', async () => {
    const pi = makeFakePi();
    registerActivityIndicator(pi as any, () => true);

    const ctx = makeStatusCtx(true);
    const inputHandler = pi.handlers.get('input') as Function;
    await inputHandler({ text: '/skill:audit' }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(ACTIVITY_STATUS_KEY, '[accent]⏵ skill:audit');
    expect(mocks.mockResolveWorkItemTitle).not.toHaveBeenCalled();
  });
});
