/**
 * Tests for retry loop engine.
 *
 * Covers exponential backoff calculation, interruptible sleep, state
 * management (RetryState, ContinuationState), and related utilities.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/retry-loop.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateDelay,
  formatDuration,
  getLastAssistantMessage,
  RetryState,
  ContinuationState,
  interruptibleSleep,
  removeErrorFromMessages,
  type BackoffConfig,
  type InterruptibleSleepState,
} from './retry-logic.js';

// ── Exponential Backoff ───────────────────────────────────────────────

describe('calculateDelay', () => {
  it('returns base delay for attempt 1', () => {
    expect(calculateDelay(1)).toBe(2000);
    expect(calculateDelay(1, { baseDelayMs: 1000, maxDelayMs: 60000, multiplier: 2 })).toBe(1000);
  });

  it('doubles for attempt 2 with default multiplier', () => {
    expect(calculateDelay(2)).toBe(4000);
  });

  it('quadruples for attempt 3 with default multiplier', () => {
    expect(calculateDelay(3)).toBe(8000);
  });

  it('capped at max delay for high attempt numbers', () => {
    expect(calculateDelay(100)).toBe(60000); // default max
    expect(calculateDelay(10, { baseDelayMs: 1000, maxDelayMs: 5000, multiplier: 3 })).toBe(5000);
  });

  it('handles custom base delay', () => {
    const config: BackoffConfig = { baseDelayMs: 5000, maxDelayMs: 120000, multiplier: 2 };
    expect(calculateDelay(1, config)).toBe(5000);
    expect(calculateDelay(2, config)).toBe(10000);
    expect(calculateDelay(3, config)).toBe(20000);
  });

  it('handles custom multiplier', () => {
    const config: BackoffConfig = { baseDelayMs: 1000, maxDelayMs: 60000, multiplier: 3 };
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
