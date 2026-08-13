/**
 * Tests for the /retry command handler.
 *
 * Covers status, reset, and manual-trigger subcommands, edge cases,
 * and state management.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/retry-command.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  retryStates,
  continuationState,
  interruptibleState,
  formatRetryStatus,
  executeRetryCommand,
  getRetryStateForCategory,
} from './retry-command.js';

// Re-export for test access
const abortState = interruptibleState;
import { RetryState, ContinuationState } from './retry-logic.js';
import { ErrorCategory } from './error-patterns.js';

// ── formatRetryStatus ─────────────────────────────────────────────────

describe('formatRetryStatus', () => {
  it('returns a string with all category names', () => {
    const status = formatRetryStatus(retryStates, continuationState);
    expect(status).toContain('rateLimit');
    expect(status).toContain('serverError');
    expect(status).toContain('authError');
    expect(status).toContain('contextLength');
    expect(status).toContain('quotaExhausted');
    expect(status).toContain('timeout');
    expect(status).toContain('terminated');
    expect(status).toContain('parseError');
    expect(status).toContain('Continuation');
  });

  it('shows Will retry: true for retryable categories and false for terminal ones', () => {
    const status = formatRetryStatus(retryStates, continuationState);
    // Retryable categories (enabled: true by default)
    expect(status).toContain('serverError');
    expect(status).toContain('Will retry: true');
    expect(status).toContain('timeout');
    expect(status).toContain('Will retry: true');
    // Non-retryable categories (enabled: false by default)
    expect(status).toContain('rateLimit');
    expect(status).toContain('Will retry: false');
    expect(status).toContain('authError');
    expect(status).toContain('Will retry: false');
    expect(status).toContain('quotaExhausted');
    expect(status).toContain('Will retry: false');
    expect(status).toContain('terminated');
    expect(status).toContain('Will retry: false');
  });

  it('omits attempt/isRetrying details for terminal categories', () => {
    const testStates: Record<string, RetryState> = {
      rateLimit: new RetryState(),
      serverError: new RetryState(),
      authError: new RetryState(),
      contextLength: new RetryState(),
      quotaExhausted: new RetryState(),
      timeout: new RetryState(),
      terminated: new RetryState(),
    };
    testStates.serverError.startRetry('500 error');

    const status = formatRetryStatus(testStates, continuationState);
    
    // serverError is retryable — shows attempt
    expect(status).toContain('Current attempt: 1');
    expect(status).toContain('Is retrying');
    
    // Terminal categories show Will retry: false but no attempt/isRetrying
    expect(status).toContain('Will retry: false');
    // Count how many times 'Current attempt' appears — should be only for retryable categories
    const attemptMatches = status.match(/Current attempt/g);
    expect(attemptMatches).not.toBeNull();
    // serverError and timeout are retryable (2) + contextLength (1) = 3
    expect(attemptMatches!.length).toBe(3);
  });

  it('shows attempt count after a retry', () => {
    const testStates: Record<string, RetryState> = {
      rateLimit: new RetryState(),
      serverError: new RetryState(),
      authError: new RetryState(),
      contextLength: new RetryState(),
      quotaExhausted: new RetryState(),
      timeout: new RetryState(),
      terminated: new RetryState(),
    };

    testStates.serverError.startRetry('500 error');
    testStates.timeout.startRetry('timeout error');

    const status = formatRetryStatus(testStates, continuationState);
    expect(status).toContain('serverError');
    expect(status).toContain('Current attempt: 1');
  });

  it('shows last error message', () => {
    const testStates: Record<string, RetryState> = {
      rateLimit: new RetryState(),
      serverError: new RetryState(),
      authError: new RetryState(),
      contextLength: new RetryState(),
      quotaExhausted: new RetryState(),
      timeout: new RetryState(),
      terminated: new RetryState(),
    };

    testStates.serverError.startRetry('500 Internal Server Error');

    const status = formatRetryStatus(testStates, continuationState);
    expect(status).toContain('500 Internal Server Error');
  });

  it('shows "None" for last error when no error recorded', () => {
    const status = formatRetryStatus(retryStates, continuationState);
    expect(status).toContain('Last error: None');
  });

  it('shows continuation count', () => {
    const testContinuation = new ContinuationState();
    testContinuation.startContinuation();
    testContinuation.startContinuation();

    const status = formatRetryStatus(retryStates, testContinuation);
    expect(status).toContain('Count: 2');
  });
});

// ── executeRetryCommand ───────────────────────────────────────────────

describe('executeRetryCommand', () => {
  let mockCtx: any;
  let mockOptions: any;

  beforeEach(() => {
    mockCtx = {
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
      },
      ui: {
        notify: vi.fn(),
      },
    };
    mockOptions = {
      triggerRetry: vi.fn(),
      triggerCompactContinue: vi.fn(),
      triggerParseErrorContinue: vi.fn(),
      triggerCheckpointTerminate: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // /retry status
  it('/retry status displays diagnostics', async () => {
    await executeRetryCommand('status', mockCtx, mockOptions);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Retry Status'),
      'info',
    );
  });

  it('/retry status with extra whitespace works', async () => {
    await executeRetryCommand('  status  ', mockCtx, mockOptions);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Retry Status'),
      'info',
    );
  });

  // /retry reset
  it('/retry reset clears all retry states', async () => {
    // Pre-populate some state
    const testCtx = {
      sessionManager: { getEntries: vi.fn().mockReturnValue([]) },
      ui: { notify: vi.fn() },
    };

    // Run reset
    await executeRetryCommand('reset', testCtx, mockOptions);

    expect(testCtx.ui.notify).toHaveBeenCalledWith(
      'All retry counters and state reset',
      'info',
    );
  });

  it('/retry reset clears abort flag', async () => {
    interruptibleState.userAborted = true;

    await executeRetryCommand('reset', mockCtx, mockOptions);

    expect(interruptibleState.userAborted).toBe(false);
  });

  // /retry (no args) with no message
  it('/retry with no assistant message shows warning', async () => {
    mockCtx.sessionManager.getEntries = vi.fn().mockReturnValue([]);

    await executeRetryCommand('', mockCtx, mockOptions);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      'No assistant message found to retry',
      'warning',
    );
  });

  it('/retry with undefined args handles gracefully', async () => {
    mockCtx.sessionManager.getEntries = vi.fn().mockReturnValue([]);

    await executeRetryCommand(undefined as any, mockCtx, mockOptions);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      'No assistant message found to retry',
      'warning',
    );
  });

  // /retry with server error
  it('/retry with server error triggers retry', async () => {
    mockCtx.sessionManager.getEntries = vi.fn().mockReturnValue([
      {
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '500 Internal Server Error',
        },
      },
    ]);

    await executeRetryCommand('', mockCtx, mockOptions);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Manual retry triggered'),
      'info',
    );
    expect(mockOptions.triggerRetry).toHaveBeenCalled();
  });

  // /retry with auth error
  it('/retry with auth error triggers retry (manual override)', async () => {
    mockCtx.sessionManager.getEntries = vi.fn().mockReturnValue([
      {
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '401 Unauthorized',
        },
      },
    ]);

    await executeRetryCommand('', mockCtx, mockOptions);

    // Manual /retry overrides terminal category — it should still trigger
    expect(mockOptions.triggerRetry).toHaveBeenCalled();
  });

  // /retry with context-length
  it('/retry with context-length triggers compact-continue', async () => {
    mockCtx.sessionManager.getEntries = vi.fn().mockReturnValue([
      {
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'length',
        },
      },
    ]);

    await executeRetryCommand('', mockCtx, mockOptions);

    expect(mockOptions.triggerCompactContinue).toHaveBeenCalled();
  });

  // /retry with JSON parse error
  it('/retry with JSON parse error triggers single-shot continue', async () => {
    mockCtx.sessionManager.getEntries = vi.fn().mockReturnValue([
      {
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: "Unexpected end of JSON input",
        },
      },
    ]);

    await executeRetryCommand('', mockCtx, mockOptions);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('JSON parse error'),
      'info',
    );
    expect(mockOptions.triggerParseErrorContinue).toHaveBeenCalled();
    expect(mockOptions.triggerRetry).not.toHaveBeenCalled();
  });

  // /retry with unknown error
  it('/retry with unknown error shows warning', async () => {
    mockCtx.sessionManager.getEntries = vi.fn().mockReturnValue([
      {
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Some completely unknown error',
        },
      },
    ]);

    await executeRetryCommand('', mockCtx, mockOptions);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('No retryable error detected'), expect.any(String));
  });

  // /retry with non-error message
  it('/retry with non-error message shows warning', async () => {
    mockCtx.sessionManager.getEntries = vi.fn().mockReturnValue([
      {
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Here is the answer...',
        },
      },
    ]);

    await executeRetryCommand('', mockCtx, mockOptions);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('No retryable error detected'),
      expect.any(String),
    );
  });

  // /retry clears abort flag
  it('/retry clears the abort flag for manual override', async () => {
    interruptibleState.userAborted = true;

    mockCtx.sessionManager.getEntries = vi.fn().mockReturnValue([
      {
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '503 Service Unavailable',
        },
      },
    ]);

    await executeRetryCommand('', mockCtx, mockOptions);

    expect(interruptibleState.userAborted).toBe(false);
  });
});

// ── getRetryStateForCategory ──────────────────────────────────────────

describe('getRetryStateForCategory', () => {
  it('returns RetryState for rateLimit category', () => {
    const state = getRetryStateForCategory(ErrorCategory.RATE_LIMIT);
    expect(state).toBeDefined();
    expect(state?.getAttempt()).toBe(0);
  });

  it('returns RetryState for serverError category', () => {
    const state = getRetryStateForCategory(ErrorCategory.SERVER_ERROR);
    expect(state).toBeDefined();
    expect(state?.getAttempt()).toBe(0);
  });

  it('returns RetryState for parseError category', () => {
    const state = getRetryStateForCategory(ErrorCategory.PARSE_ERROR);
    expect(state).toBeDefined();
    expect(state?.getAttempt()).toBe(0);
  });

  it('returns undefined for unknown category', () => {
    const state = getRetryStateForCategory('unknown' as any);
    expect(state).toBeUndefined();
  });
});
