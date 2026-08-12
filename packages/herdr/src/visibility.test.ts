/**
 * Unit tests for packages/herdr/src/visibility.ts — pane visibility
 * detection (isPaneVisible + PollGate).
 *
 * Visibility signal: the pane is visible when its TAB is focused
 * (`HERDR_TAB_ID` → `herdr tab get <id>` → `result.tab.focused`),
 * regardless of which pane in the tab holds keyboard focus (multi-pane
 * split bug, WL-0MSJNJPRM009RM35). No pane-focus fallback.
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
 * Build a herdr-style tab-get envelope. A hidden (non-focused) tab reports
 * `result.tab.focused === false`.
 */
function tabGetEnvelope(focused: boolean): string {
  return JSON.stringify({
    id: 'cli:tab:get',
    result: { tab: { focused } },
  });
}

describe('isPaneVisible', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetExecFileAsync();
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_BIN_PATH;
  });

  afterEach(() => {
    resetExecFileAsync();
    process.env.HERDR_TAB_ID = originalEnv.HERDR_TAB_ID;
    process.env.HERDR_PANE_ID = originalEnv.HERDR_PANE_ID;
    process.env.HERDR_BIN_PATH = originalEnv.HERDR_BIN_PATH;
  });

  it('returns true when HERDR_TAB_ID is not set (fail-open, standalone mode)', async () => {
    delete process.env.HERDR_TAB_ID;
    const mockFn = vi.fn();
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
    // No herdr exec at all when there is no tab context.
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('returns true when the herdr CLI is missing (ENOENT)', async () => {
    process.env.HERDR_TAB_ID = 'w1:t11';
    const mockFn = vi.fn().mockRejectedValue({ code: 'ENOENT' });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
  });

  it('returns true when the herdr CLI exits non-zero', async () => {
    process.env.HERDR_TAB_ID = 'w1:t11';
    const mockFn = vi.fn().mockRejectedValue(new Error('herdr: exit status 1'));
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
  });

  it('returns true when the CLI returns unparseable output (fail-open)', async () => {
    process.env.HERDR_TAB_ID = 'w1:t11';
    const mockFn = vi.fn().mockResolvedValue({ stdout: 'not json at all', stderr: '' });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
  });

  it('returns false when herdr tab get reports result.tab.focused === false (tab not focused)', async () => {
    process.env.HERDR_TAB_ID = 'w1:t11';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: tabGetEnvelope(false),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(false);
    // The tab id is passed to the CLI.
    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toEqual(['tab', 'get', 'w1:t11']);
  });

  it('returns true when herdr tab get reports result.tab.focused === true (tab focused)', async () => {
    process.env.HERDR_TAB_ID = 'w1:t11';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: tabGetEnvelope(true),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
  });

  it('multi-pane bug case: tab focused + pane unfocused → visible', async () => {
    // The bug (WL-0MSJNJPRM009RM35): in a split tab the worklist pane is
    // NOT the keyboard-focused pane, so `herdr pane get` reports
    // `focused: false` — yet the pane is visible on screen. The tab-focus
    // signal (HERDR_TAB_ID + tab get) must decide visibility, so the pane
    // keeps refreshing. Both env vars present mirrors the real environment;
    // the pane id is set but must NOT be consulted (no pane-focus fallback).
    process.env.HERDR_TAB_ID = 'w1:t11';
    process.env.HERDR_PANE_ID = 'w1:p41';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: tabGetEnvelope(true),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
    // Only the tab-get path is exercised — never a pane-get.
    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toEqual(['tab', 'get', 'w1:t11']);
  });

  it('multi-pane bug case: tab focused + pane focused → visible', async () => {
    process.env.HERDR_TAB_ID = 'w1:t11';
    process.env.HERDR_PANE_ID = 'w1:p41';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: tabGetEnvelope(true),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    expect(await isPaneVisible()).toBe(true);
    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toEqual(['tab', 'get', 'w1:t11']);
  });

  it('resolves the herdr binary from HERDR_BIN_PATH when set, else "herdr"', async () => {
    process.env.HERDR_TAB_ID = 'w1:t11';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: tabGetEnvelope(true),
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
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
  });

  afterEach(() => {
    resetExecFileAsync();
    delete process.env.HERDR_TAB_ID;
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

  it('defaults to isPaneVisible and shares one tab-get exec within the TTL', async () => {
    process.env.HERDR_TAB_ID = 'w1:t11';
    const mockFn = vi.fn().mockResolvedValue({
      stdout: tabGetEnvelope(false),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const gate = new PollGate();
    expect(await gate.visible()).toBe(false);
    expect(await gate.visible()).toBe(false);
    // refresh + sync ticks in one cycle share a single herdr tab get call.
    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});
