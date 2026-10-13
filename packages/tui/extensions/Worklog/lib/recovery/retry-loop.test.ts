/**
 * Tests for retry loop engine.
 *
 * Covers exponential backoff calculation, interruptible sleep, state
 * management (RetryState, ContinuationState), and related utilities.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/retry-loop.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelCooldowns } from '@worklog/shared/model-cooldown';
import {
  calculateDelay,
  formatDuration,
  getLastAssistantMessage,
  RetryState,
  ContinuationState,
  interruptibleSleep,
  removeErrorFromMessages,
  resolveRetryDelay,
  deriveCooldownIdentity,
  recordExhaustionCooldown,
  clearModelCooldownSignal,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
  type InterruptibleSleepState,
} from './retry-logic.js';
import { DEFAULT_RECOVERY_CONFIG } from './error-patterns.js';

// ── Exponential Backoff ───────────────────────────────────────────────

describe('calculateDelay', () => {
  it('returns base delay for attempt 1', () => {
    expect(calculateDelay(1)).toBe(2000);
    expect(calculateDelay(1, { baseDelayMs: 1000, maxDelayMs: 600000, multiplier: 2 })).toBe(1000);
  });

  it('doubles for attempt 2 with default multiplier', () => {
    expect(calculateDelay(2)).toBe(4000);
  });

  it('quadruples for attempt 3 with default multiplier', () => {
    expect(calculateDelay(3)).toBe(8000);
  });

  it('capped at max delay for high attempt numbers', () => {
    expect(calculateDelay(100)).toBe(600000); // 10-minute default max (WL-0MUY9GDPG0062NWF)
    expect(calculateDelay(10, { baseDelayMs: 1000, maxDelayMs: 5000, multiplier: 3 })).toBe(5000);
  });

  it('handles custom base delay', () => {
    const config: BackoffConfig = { baseDelayMs: 5000, maxDelayMs: 120000, multiplier: 2 };
    expect(calculateDelay(1, config)).toBe(5000);
    expect(calculateDelay(2, config)).toBe(10000);
    expect(calculateDelay(3, config)).toBe(20000);
  });

  it('handles custom multiplier', () => {
    const config: BackoffConfig = { baseDelayMs: 1000, maxDelayMs: 600000, multiplier: 3 };
    expect(calculateDelay(1, config)).toBe(1000);
    expect(calculateDelay(2, config)).toBe(3000);
    expect(calculateDelay(3, config)).toBe(9000);
  });

  it('respects max delay even with aggressive multiplier', () => {
    const config: BackoffConfig = { baseDelayMs: 1000, maxDelayMs: 10000, multiplier: 10 };
    expect(calculateDelay(1, config)).toBe(1000);
    expect(calculateDelay(2, config)).toBe(10000); // capped
    expect(calculateDelay(3, config)).toBe(10000); // still capped
  });

  it('handles attempt 0 gracefully (treats as attempt 1)', () => {
    expect(calculateDelay(0)).toBe(2000);
  });

  it('handles negative attempt gracefully', () => {
    expect(calculateDelay(-1)).toBe(2000);
  });
});

// ── Duration Formatting ───────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats milliseconds under 1s', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('formats seconds', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(2500)).toBe('2.5s');
    expect(formatDuration(59000)).toBe('59.0s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
    expect(formatDuration(90000)).toBe('1m 30s');
    expect(formatDuration(120000)).toBe('2m 0s');
    expect(formatDuration(150000)).toBe('2m 30s');
  });

  it('handles very large durations', () => {
    expect(formatDuration(3600000)).toBe('60m 0s');
  });
});

// ── getLastAssistantMessage ───────────────────────────────────────────

describe('getLastAssistantMessage', () => {
  it('returns the last assistant message from entries', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'hello' } },
      { type: 'message', message: { role: 'assistant', content: 'hi there' } },
    ];
    const result = getLastAssistantMessage(entries);
    expect(result).toBeDefined();
    expect(result?.role).toBe('assistant');
    expect(result?.content).toBe('hi there');
  });

  it('skips non-message entries', () => {
    const entries = [
      { type: 'event', event: 'turn_start' },
      { type: 'message', message: { role: 'assistant', content: 'final' } },
    ];
    expect(getLastAssistantMessage(entries)?.content).toBe('final');
  });

  it('returns undefined for empty entries', () => {
    expect(getLastAssistantMessage([])).toBeUndefined();
  });

  it('returns undefined when no assistant message exists', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'hello' } },
    ];
    expect(getLastAssistantMessage(entries)).toBeUndefined();
  });

  it('finds the LAST assistant message when multiple exist', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: 'first' } },
      { type: 'message', message: { role: 'user', content: 'follow-up' } },
      { type: 'message', message: { role: 'assistant', content: 'second' } },
    ];
    expect(getLastAssistantMessage(entries)?.content).toBe('second');
  });

  it('handles undefined entries gracefully', () => {
    expect(getLastAssistantMessage(undefined as any)).toBeUndefined();
  });
});

// ── RetryState ────────────────────────────────────────────────────────

describe('RetryState', () => {
  let state: RetryState;

  beforeEach(() => {
    state = new RetryState();
  });

  it('starts with zero attempts, not retrying, no error message', () => {
    expect(state.getAttempt()).toBe(0);
    expect(state.getIsRetrying()).toBe(false);
    expect(state.getLastErrorMessage()).toBe('');
  });

  it('startRetry increments attempt and sets isRetrying', () => {
    state.startRetry('error 1');
    expect(state.getAttempt()).toBe(1);
    expect(state.getIsRetrying()).toBe(true);
    expect(state.getLastErrorMessage()).toBe('error 1');
  });

  it('multiple startRetry calls increment attempts', () => {
    state.startRetry('error 1');
    state.startRetry('error 2');
    state.startRetry('error 3');
    expect(state.getAttempt()).toBe(3);
    expect(state.getLastErrorMessage()).toBe('error 3');
  });

  it('endRetry clears isRetrying but preserves attempt count', () => {
    state.startRetry('error');
    state.endRetry();
    expect(state.getIsRetrying()).toBe(false);
    expect(state.getAttempt()).toBe(1);
    expect(state.getLastErrorMessage()).toBe('error');
  });

  it('succeed resets everything to zero', () => {
    state.startRetry('error');
    state.succeed();
    expect(state.getAttempt()).toBe(0);
    expect(state.getIsRetrying()).toBe(false);
    expect(state.getLastErrorMessage()).toBe('');
  });

  it('reset clears all state', () => {
    state.startRetry('error');
    state.reset();
    expect(state.getAttempt()).toBe(0);
    expect(state.getIsRetrying()).toBe(false);
    expect(state.getLastErrorMessage()).toBe('');
  });

  it('multiple startRetry and succeed cycles work correctly', () => {
    state.startRetry('err1');
    expect(state.getAttempt()).toBe(1);
    state.succeed();

    state.startRetry('err2');
    expect(state.getAttempt()).toBe(1); // reset by succeed
    state.succeed();

    expect(state.getAttempt()).toBe(0);
  });
});

// ── ContinuationState ─────────────────────────────────────────────────

describe('ContinuationState', () => {
  let state: ContinuationState;

  beforeEach(() => {
    state = new ContinuationState();
  });

  it('starts with zero count, not continuing', () => {
    expect(state.getCount()).toBe(0);
    expect(state.getIsContinuing()).toBe(false);
  });

  it('startContinuation increments count and sets isContinuing', () => {
    state.startContinuation();
    expect(state.getCount()).toBe(1);
    expect(state.getIsContinuing()).toBe(true);
  });

  it('multiple startContinuation calls accumulate count', () => {
    state.startContinuation();
    state.startContinuation();
    state.startContinuation();
    expect(state.getCount()).toBe(3);
  });

  it('endContinuation clears isContinuing but preserves count', () => {
    state.startContinuation();
    state.endContinuation();
    expect(state.getIsContinuing()).toBe(false);
    expect(state.getCount()).toBe(1);
  });

  it('complete resets count and isContinuing', () => {
    state.startContinuation();
    state.startContinuation();
    state.complete();
    expect(state.getCount()).toBe(0);
    expect(state.getIsContinuing()).toBe(false);
  });

  it('reset clears all state', () => {
    state.startContinuation();
    state.reset();
    expect(state.getCount()).toBe(0);
    expect(state.getIsContinuing()).toBe(false);
  });

  it('complete followed by startContinuation restarts from zero', () => {
    state.startContinuation();
    state.complete();
    state.startContinuation();
    expect(state.getCount()).toBe(1);
  });
});

// ── Interruptible Sleep ───────────────────────────────────────────────

describe('interruptibleSleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves false after full delay when no interruption', async () => {
    const state: InterruptibleSleepState = { userAborted: false, sessionGeneration: 1 };
    const promise = interruptibleSleep(500, state, 1);

    // Advance time past the delay
    vi.advanceTimersByTime(500);

    await expect(promise).resolves.toBe(false);
  });

  it('resolves true when userAborted is set', async () => {
    const state: InterruptibleSleepState = { userAborted: false, sessionGeneration: 1 };
    const promise = interruptibleSleep(5000, state, 1);

    // Simulate abort after 150ms
    vi.advanceTimersByTime(150);
    state.userAborted = true;
    vi.advanceTimersByTime(100); // next poll interval catches it

    await expect(promise).resolves.toBe(true);
  });

  it('resolves true when session generation changes', async () => {
    const state: InterruptibleSleepState = { userAborted: false, sessionGeneration: 1 };
    const promise = interruptibleSleep(5000, state, 1);

    // Simulate session switch after 200ms
    vi.advanceTimersByTime(200);
    state.sessionGeneration = 2;
    vi.advanceTimersByTime(100); // next poll interval catches it

    await expect(promise).resolves.toBe(true);
  });

  it('resolves immediately for zero or negative delay', async () => {
    const state: InterruptibleSleepState = { userAborted: false, sessionGeneration: 1 };
    await expect(interruptibleSleep(0, state, 1)).resolves.toBe(false);
    await expect(interruptibleSleep(-1, state, 1)).resolves.toBe(false);
  });

  it('checks abort flag at least once per 100ms interval', async () => {
    const state: InterruptibleSleepState = { userAborted: false, sessionGeneration: 1 };
    const promise = interruptibleSleep(1000, state, 1);

    // After 50ms, abort should not yet be checked (next poll at 100ms)
    vi.advanceTimersByTime(50);
    state.userAborted = true;

    // Advance past 100ms - should be caught
    vi.advanceTimersByTime(60);

    await expect(promise).resolves.toBe(true);
  });
});

// ── Interruptible Sleep: long server-hint waits (AC6) ─────────────────
//
// A multi-hour `Retry-After` must remain abortable by ESC (userAborted) and
// by a session switch (sessionGeneration change) — no non-interruptible
// timer. LONG_WAIT_MS (2 min) is deliberately > 60s to exercise the long
// path without slowing the suite.

describe('interruptibleSleep (long waits)', () => {
  const LONG_WAIT_MS = 120_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('can be aborted by ESC during a long (>60s) wait', async () => {
    const state: InterruptibleSleepState = { userAborted: false, sessionGeneration: 1 };
    const promise = interruptibleSleep(LONG_WAIT_MS, state, 1);

    // Only 100ms has elapsed when the operator hits ESC.
    await vi.advanceTimersByTimeAsync(100);
    state.userAborted = true;
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe(true);
  });

  it('can be aborted by a session switch during a long (>60s) wait', async () => {
    const state: InterruptibleSleepState = { userAborted: false, sessionGeneration: 1 };
    const promise = interruptibleSleep(LONG_WAIT_MS, state, 1);

    await vi.advanceTimersByTimeAsync(100);
    state.sessionGeneration = 2;
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe(true);
  });

  it('does not resolve a long wait before the delay elapses', async () => {
    const state: InterruptibleSleepState = { userAborted: false, sessionGeneration: 1 };
    let settled = false;
    const promise = interruptibleSleep(LONG_WAIT_MS, state, 1).then((interrupted) => {
      settled = true;
      return interrupted;
    });

    await vi.advanceTimersByTimeAsync(LONG_WAIT_MS - 100);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe(false);
  });
});

// ── Backoff config shape (AC7) ────────────────────────────────────────

describe('DEFAULT_BACKOFF_CONFIG (server-hint ceiling)', () => {
  it('uses a 10-minute exponential cap and 6h server-hint ceiling (AC7)', () => {
    expect(DEFAULT_BACKOFF_CONFIG.maxDelayMs).toBe(600_000); // 10-minute ceiling (WL-0MUY9GDPG0062NWF)
    expect(DEFAULT_BACKOFF_CONFIG.serverHintMaxDelayMs).toBe(21_600_000);
  });
});

// ── removeErrorFromMessages ───────────────────────────────────────────

describe('removeErrorFromMessages', () => {
  it('removes last message if it is an assistant error', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', stopReason: 'error', content: 'error msg' },
    ];
    const result = removeErrorFromMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('does not remove messages where last is not an error', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', stopReason: 'stop', content: 'response' },
    ];
    const result = removeErrorFromMessages(messages);
    expect(result).toHaveLength(2);
  });

  it('does not remove messages where last is assistant but non-error role', () => {
    const messages = [
      { role: 'assistant', stopReason: 'error' },
      { role: 'user', content: 'ok' },
    ];
    const result = removeErrorFromMessages(messages);
    expect(result).toHaveLength(2);
  });

  it('handles empty messages array', () => {
    expect(removeErrorFromMessages([])).toEqual([]);
  });

  it('handles single error message array', () => {
    const messages = [{ role: 'assistant', stopReason: 'error' }];
    expect(removeErrorFromMessages(messages)).toEqual([]);
  });

  it('does not crash on messages without stopReason', () => {
    const messages = [
      { role: 'assistant', content: 'hello' },
    ];
    expect(removeErrorFromMessages(messages)).toHaveLength(1);
  });
});

// ── getLastAssistantMessage with error messages ───────────────────────

describe('getLastAssistantMessage (error diagnostics)', () => {
  it('finds last assistant message with errorMessage', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', stopReason: 'error', errorMessage: '429 Too Many Requests' } },
    ];
    const result = getLastAssistantMessage(entries);
    expect(result?.errorMessage).toBe('429 Too Many Requests');
  });

  it('returns undefined when entries have no assistant messages', () => {
    const entries = [
      { type: 'event', event: 'turn_start' },
      { type: 'message', message: { role: 'user', content: 'hello' } },
    ];
    expect(getLastAssistantMessage(entries)).toBeUndefined();
  });

  it('ignores entries with missing message property', () => {
    const entries = [
      { type: 'message', message: null },
      { type: 'message', message: { role: 'assistant' } },
    ];
    expect(getLastAssistantMessage(entries)?.role).toBe('assistant');
  });
});

// ── Durable model cooldown signal (WL-0MV5638J1006URXA) ───────────────
//
// The recovery loop records a durable, machine-wide cooldown marker when an
// exhaustion SERVER_ERROR starts a backoff, and clears it on the next 2xx.
// These tests pin the pure pieces: the resolved `cooldownUntil`, the
// best-effort identity derivation, and the never-throwing writer/clearer.

const COOLDOWN_NOW = 1_700_000_000_000;

function makeUserEntry(content: unknown): unknown {
  return { type: 'message', message: { role: 'user', content } };
}

describe('resolveRetryDelay cooldownUntil', () => {
  it('uses the bounded default for cooldownUntil while leaving delayMs as the exponential backoff', () => {
    const result = resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, () => 0, undefined, COOLDOWN_NOW);
    // Retry sleep: unchanged exponential backoff.
    expect(result.delayMs).toBe(2000);
    expect(result.serverHintMs).toBeUndefined();
    // Durable marker: the bounded default (never zero, never unbounded).
    expect(result.cooldownUntil).toBe(COOLDOWN_NOW + DEFAULT_RECOVERY_CONFIG.cooldown.defaultMs);
    expect(result.cooldownUntil).toBeGreaterThan(COOLDOWN_NOW + result.delayMs);
  });

  it('tracks a server-provided retry hint inside the clamp window', () => {
    const result = resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, () => 0, 11_000, COOLDOWN_NOW);
    expect(result.delayMs).toBe(11_000);
    expect(result.serverHintMs).toBe(11_000);
    expect(result.cooldownUntil).toBe(COOLDOWN_NOW + 11_000);
  });

  it('clamps an over-ceiling hint in cooldownUntil', () => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const result = resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, () => 0, oneDayMs, COOLDOWN_NOW);
    expect(result.cooldownUntil).toBe(COOLDOWN_NOW + DEFAULT_RECOVERY_CONFIG.cooldown.ceilingMs);
  });

  it('defaults now to the current clock', () => {
    const before = Date.now();
    const result = resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, () => 0);
    expect(result.cooldownUntil).toBeGreaterThanOrEqual(before + DEFAULT_RECOVERY_CONFIG.cooldown.defaultMs);
    expect(result.cooldownUntil).toBeLessThanOrEqual(Date.now() + DEFAULT_RECOVERY_CONFIG.cooldown.defaultMs);
  });
});

describe('deriveCooldownIdentity', () => {
  it('derives item id and kind from a dispatch user message', () => {
    expect(deriveCooldownIdentity([makeUserEntry('/skill:implement WL-0MV5638J1006URXA')])).toEqual({
      itemId: 'WL-0MV5638J1006URXA',
      kind: 'implement',
    });
  });

  it('derives from array content parts', () => {
    const entries = [makeUserEntry([{ type: 'text', text: 'please /skill:plan WL-0ABC123456 now' }])];
    expect(deriveCooldownIdentity(entries)).toEqual({ itemId: 'WL-0ABC123456', kind: 'plan' });
  });

  it('derives the kind from a triggered-pane dispatch phrasing', () => {
    expect(deriveCooldownIdentity([makeUserEntry('Downtime triggered audit WL-0ABC123456')]).kind).toBe('audit');
  });

  it('handles risk-effort', () => {
    const entries = [makeUserEntry('/skill:risk-effort WL-0ABC123456')];
    expect(deriveCooldownIdentity(entries).kind).toBe('risk-effort');
  });

  it('returns nulls when no user message carries identity', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: '/skill:implement WL-0MV5638J1006URXA' } },
      makeUserEntry('hello there'),
    ];
    expect(deriveCooldownIdentity(entries)).toEqual({ itemId: null, kind: null });
  });

  it('leaves kind null when only an item id is present', () => {
    expect(deriveCooldownIdentity([makeUserEntry('working on WL-0ABC123456')])).toEqual({
      itemId: 'WL-0ABC123456',
      kind: null,
    });
  });

  it('leaves itemId null when only a kind is present', () => {
    expect(deriveCooldownIdentity([makeUserEntry('/skill:audit')])).toEqual({ itemId: null, kind: 'audit' });
  });

  it('returns nulls for empty or malformed entries', () => {
    expect(deriveCooldownIdentity([])).toEqual({ itemId: null, kind: null });
    expect(deriveCooldownIdentity(undefined as any)).toEqual({ itemId: null, kind: null });
  });
});

describe('recordExhaustionCooldown', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wl-cooldown-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a durable marker for an exhaustion SERVER_ERROR', () => {
    const written = recordExhaustionCooldown({
      cooldownUntil: COOLDOWN_NOW + 30_000,
      errorMessage: 'All providers exhausted',
      paneId: 'w1:p1',
      sessionId: 'sess-1',
      itemId: 'WL-0ABC123456',
      kind: 'implement',
      reason: 'provider exhaustion',
      dir,
      now: COOLDOWN_NOW,
    });

    expect(written).toBe(true);
    const entries = readModelCooldowns(dir, COOLDOWN_NOW);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toMatchObject({
      paneId: 'w1:p1',
      sessionId: 'sess-1',
      itemId: 'WL-0ABC123456',
      kind: 'implement',
      reason: 'provider exhaustion',
      cooldownUntil: COOLDOWN_NOW + 30_000,
    });
  });

  it('does not write for a plain retryable 5xx', () => {
    const written = recordExhaustionCooldown({
      cooldownUntil: COOLDOWN_NOW + 2_000,
      errorMessage: '500 Internal Server Error',
      dir,
      now: COOLDOWN_NOW,
    });
    expect(written).toBe(false);
    expect(readModelCooldowns(dir, COOLDOWN_NOW)).toEqual([]);
  });

  it('does not write for a timeout', () => {
    const written = recordExhaustionCooldown({
      cooldownUntil: COOLDOWN_NOW + 2_000,
      errorMessage: 'Request timed out',
      dir,
      now: COOLDOWN_NOW,
    });
    expect(written).toBe(false);
    expect(readModelCooldowns(dir, COOLDOWN_NOW)).toEqual([]);
  });

  it('degrades to a session-only key when HERDR_PANE_ID is absent', () => {
    const original = process.env.HERDR_PANE_ID;
    delete process.env.HERDR_PANE_ID;
    try {
      const written = recordExhaustionCooldown({
        cooldownUntil: COOLDOWN_NOW + 5_000,
        errorMessage: 'all providers unavailable',
        sessionId: 'sess-only',
        dir,
        now: COOLDOWN_NOW,
      });
      expect(written).toBe(true);
      const entries = readModelCooldowns(dir, COOLDOWN_NOW);
      expect(entries?.[0]?.paneId).toBeNull();
      expect(entries?.[0]?.sessionId).toBe('sess-only');
    } finally {
      if (original === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = original;
    }
  });

  it('never throws (returns false) when the marker directory is unwritable', () => {
    const unwritable = join(dir, 'not-a-dir');
    writeFileSync(unwritable, 'x');

    expect(() =>
      recordExhaustionCooldown({
        cooldownUntil: COOLDOWN_NOW + 5_000,
        errorMessage: 'all providers exhausted',
        paneId: 'w1:p1',
        sessionId: 'sess-1',
        dir: join(unwritable, 'nested'),
        now: COOLDOWN_NOW,
      }),
    ).not.toThrow();

    expect(
      recordExhaustionCooldown({
        cooldownUntil: COOLDOWN_NOW + 5_000,
        errorMessage: 'all providers exhausted',
        paneId: 'w1:p1',
        sessionId: 'sess-1',
        dir: join(unwritable, 'nested'),
        now: COOLDOWN_NOW,
      }),
    ).toBe(false);
  });
});

describe('clearModelCooldownSignal', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wl-cooldown-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('clears the entry written for the pane/session key', () => {
    recordExhaustionCooldown({
      cooldownUntil: COOLDOWN_NOW + 30_000,
      errorMessage: 'all providers exhausted',
      paneId: 'w1:p1',
      sessionId: 'sess-1',
      dir,
      now: COOLDOWN_NOW,
    });
    expect(clearModelCooldownSignal({ paneId: 'w1:p1', sessionId: 'sess-1', dir, now: COOLDOWN_NOW })).toBe(true);
    expect(readModelCooldowns(dir, COOLDOWN_NOW)).toEqual([]);
  });

  it('clears a session-only entry', () => {
    recordExhaustionCooldown({
      cooldownUntil: COOLDOWN_NOW + 30_000,
      errorMessage: 'all providers exhausted',
      paneId: null,
      sessionId: 'sess-only',
      dir,
      now: COOLDOWN_NOW,
    });
    expect(clearModelCooldownSignal({ paneId: null, sessionId: 'sess-only', dir, now: COOLDOWN_NOW })).toBe(true);
    expect(readModelCooldowns(dir, COOLDOWN_NOW)).toEqual([]);
  });

  it('is a no-op when no entry matches', () => {
    expect(clearModelCooldownSignal({ paneId: 'w1:p9', sessionId: 'sess-x', dir, now: COOLDOWN_NOW })).toBe(false);
  });

  it('never throws for a corrupt marker file', () => {
    writeFileSync(join(dir, 'model-cooldowns.json'), '{not json');
    expect(() =>
      clearModelCooldownSignal({ paneId: 'w1:p1', sessionId: 'sess-1', dir, now: COOLDOWN_NOW }),
    ).not.toThrow();
    expect(clearModelCooldownSignal({ paneId: 'w1:p1', sessionId: 'sess-1', dir, now: COOLDOWN_NOW })).toBe(false);
  });
});
