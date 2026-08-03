/**
 * Unit tests for packages/herdr/src/visibility.ts — pane visibility
 * detection (isPaneVisible + PollGate).
 *
 * Run: npx vitest run packages/herdr/src/visibility.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setExecFileAsync,
  resetExecFileAsync,
} from './fetcher.js';
import { isPaneVisible, PollGate, DEFAULT_POLL_GATE_TTL_MS } from './visibility.js';

/**
 * Build a herdr-style pane-get envelope. Hidden (non-focused) tabs report
 * `result.pane.focused === false`.
 */
function paneGetEnvelope(focused: boolean): string {
  return JSON.stringify({
    id: 'cli:pane:get',
    result: { pane: { focused } },
  });
}

describe('isPaneVisible', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetExecFileAsync();
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_BIN_PATH;
  });

  afterEach(() => {
    resetExecFileAsync();
    process.env.HERDR_PANE_ID = originalEnv.HERDR_PANE_ID;
    process.env.HERDR_BIN_PATH = originalEnv.HERDR_BIN_PATH;
  });

  it('returns true when HERDR_PANE_ID is not set (fail-open, standalone mode)', async () => {
    delete process.env.HERDR_PANE_ID;
    const mockFn = vi.fn();
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
    // No herdr exec at all when there is no pane context.
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('returns true when the herdr CLI is missing (ENOENT)', async () => {
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const mockFn = vi.fn().mockRejectedValue({ code: 'ENOENT' });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
  });

  it('returns true when the herdr CLI exits non-zero', async () => {
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const mockFn = vi.fn().mockRejectedValue(new Error('herdr: exit status 1'));
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
  });

  it('returns true when the CLI returns unparseable output (fail-open)', async () => {
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const mockFn = vi.fn().mockResolvedValue({ stdout: 'not json at all', stderr: '' });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
  });

  it('returns false when herdr pane get reports result.pane.focused === false', async () => {
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: paneGetEnvelope(false),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(false);
    // The pane id is passed to the CLI.
    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toEqual(['pane', 'get', 'w1:pCM']);
  });

  it('returns true when herdr pane get reports result.pane.focused === true', async () => {
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: paneGetEnvelope(true),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
  });

  it('resolves the herdr binary from HERDR_BIN_PATH when set, else "herdr"', async () => {
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: paneGetEnvelope(true),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    // Default binary name.
    await isPaneVisible();
    expect(mockFn.mock.calls[0][0]).toBe('herdr');

    // Explicit HERDR_BIN_PATH wins.
    process.env.HERDR_BIN_PATH = '/custom/bin/herdr';
    mockFn.mockClear();
    await isPaneVisible();
    expect(mockFn.mock.calls[0][0]).toBe('/custom/bin/herdr');
  });
});

describe('PollGate', () => {
  beforeEach(() => {
    resetExecFileAsync();
    delete process.env.HERDR_PANE_ID;
  });

  afterEach(() => {
    resetExecFileAsync();
    delete process.env.HERDR_PANE_ID;
  });

  it('returns the underlying visibility result', async () => {
    const gate = new PollGate(async () => false);
    expect(await gate.visible()).toBe(false);

    const gate2 = new PollGate(async () => true);
    expect(await gate2.visible()).toBe(true);
  });

  it('memoizes the result within the TTL (one exec for two calls)', async () => {
    const check = vi.fn().mockResolvedValue(false);
    const gate = new PollGate(check, DEFAULT_POLL_GATE_TTL_MS);

    expect(await gate.visible()).toBe(false);
    expect(await gate.visible()).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('re-checks after the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn().mockResolvedValue(true);
      const gate = new PollGate(check, 2000);

      await gate.visible();
      await gate.visible();
      expect(check).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2001);
      await gate.visible();
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails open (returns true) when the underlying check throws', async () => {
    const check = vi.fn().mockRejectedValue(new Error('herdr CLI exploded'));
    const gate = new PollGate(check, 2000);

    expect(await gate.visible()).toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('defaults to isPaneVisible and shares one herdr exec within the TTL', async () => {
    process.env.HERDR_PANE_ID = 'w1:pCM';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: paneGetEnvelope(false),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const gate = new PollGate();
    expect(await gate.visible()).toBe(false);
    expect(await gate.visible()).toBe(false);
    // refresh + sync ticks in one cycle share a single herdr pane get call.
    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});
