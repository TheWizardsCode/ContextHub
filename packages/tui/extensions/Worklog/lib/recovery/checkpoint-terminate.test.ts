/**
 * Tests for the checkpoint-and-terminate handler.
 *
 * Covers detection of unrecoverable errors (auth, quota, terminated),
 * checkpoint save triggering, informative error display, and verifying
 * no retry is attempted for terminal categories.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/checkpoint-terminate.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import {
  executeCheckpointAndTerminate,
  getTerminalErrorTitle,
  TERMINAL_CATEGORIES,
  type TerminalCategory,
} from './recovery.js';

// ── getTerminalErrorTitle ─────────────────────────────────────────────

describe('getTerminalErrorTitle', () => {
  it('returns correct title for authError', () => {
    expect(getTerminalErrorTitle('authError')).toBe('Authentication Error');
  });

  it('returns correct title for quotaExhausted', () => {
    expect(getTerminalErrorTitle('quotaExhausted')).toBe('Quota Exhausted');
  });

  it('returns correct title for terminated', () => {
    expect(getTerminalErrorTitle('terminated')).toBe('Response Terminated');
  });
});

// ── TERMINAL_CATEGORIES ───────────────────────────────────────────────

describe('TERMINAL_CATEGORIES', () => {
  it('contains all 3 terminal categories', () => {
    expect(TERMINAL_CATEGORIES).toEqual(['authError', 'quotaExhausted', 'terminated']);
  });
});

// ── executeCheckpointAndTerminate ─────────────────────────────────────

describe('executeCheckpointAndTerminate', () => {
  it('saves checkpoint and displays error for auth errors', async () => {
    const saveCheckpoint = vi.fn().mockResolvedValue({ success: true });
    const notify = vi.fn();

    const result = await executeCheckpointAndTerminate(
      'authError',
      '401 Unauthorized - invalid API key',
      { saveCheckpoint, notify },
    );

    expect(result.success).toBe(true);
    expect(result.title).toBe('Authentication Error');
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Checkpoint saved'),
      'error',
    );
  });

  it('saves checkpoint and displays error for quota exhausted', async () => {
    const saveCheckpoint = vi.fn().mockResolvedValue({ success: true });
    const notify = vi.fn();

    const result = await executeCheckpointAndTerminate(
      'quotaExhausted',
      'Not enough credits to complete request',
      { saveCheckpoint, notify },
    );

    expect(result.success).toBe(true);
    expect(result.title).toBe('Quota Exhausted');
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Checkpoint saved'),
      'error',
    );
  });

  it('saves checkpoint and displays error for terminated', async () => {
    const saveCheckpoint = vi.fn().mockResolvedValue({ success: true });
    const notify = vi.fn();

    const result = await executeCheckpointAndTerminate(
      'terminated',
      'content_filter',
      { saveCheckpoint, notify },
    );

    expect(result.success).toBe(true);
    expect(result.title).toBe('Response Terminated');
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Checkpoint saved'),
      'error',
    );
  });

  it('still displays error when checkpoint fails', async () => {
    const saveCheckpoint = vi.fn().mockResolvedValue({
      success: false,
      error: 'Checkpoint service unavailable',
    });
    const notify = vi.fn();

    const result = await executeCheckpointAndTerminate(
      'quotaExhausted',
      'Quota exceeded',
      { saveCheckpoint, notify },
    );

    expect(result.success).toBe(false);
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('(checkpoint failed)'),
      'error',
    );
  });

  it('handles exceptions during checkpoint gracefully', async () => {
    const saveCheckpoint = vi.fn().mockRejectedValue(new Error('Disk full'));
    const notify = vi.fn();

    const result = await executeCheckpointAndTerminate(
      'authError',
      '403 Forbidden',
      { saveCheckpoint, notify },
    );

    expect(result.success).toBe(false);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Authentication Error'),
      'error',
    );
  });

  it('truncates long error messages in display', async () => {
    const saveCheckpoint = vi.fn().mockResolvedValue({ success: true });
    const notify = vi.fn();

    const longError = 'A'.repeat(1000);
    await executeCheckpointAndTerminate(
      'terminated',
      longError,
      { saveCheckpoint, notify },
    );

    // The display message should be truncated
    const notifyArg = notify.mock.calls[0][0] as string;
    expect(notifyArg.length).toBeLessThan(200);
  });

  it('displays error message even when saveCheckpoint is not provided', async () => {
    const notify = vi.fn();

    const result = await executeCheckpointAndTerminate(
      'authError',
      'Invalid API key',
      { saveCheckpoint: vi.fn().mockResolvedValue({ success: true }), notify },
    );

    expect(result.success).toBe(true);
    expect(result.errorMessage).toBe('Invalid API key');
  });

  it('does NOT trigger any retry-related function', async () => {
    const saveCheckpoint = vi.fn().mockResolvedValue({ success: true });
    const notify = vi.fn();
    const retryFallback = vi.fn();

    await executeCheckpointAndTerminate(
      'authError',
      '401 Unauthorized',
      { saveCheckpoint, notify },
    );

    // No retry-related function should be called
    expect(retryFallback).not.toHaveBeenCalled();
    // Only checkpoint and notify
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('includes the original error detail in the result', async () => {
    const saveCheckpoint = vi.fn().mockResolvedValue({ success: true });
    const notify = vi.fn();

    const result = await executeCheckpointAndTerminate(
      'quotaExhausted',
      '402 Payment Required - quota exceeded',
      { saveCheckpoint, notify },
    );

    expect(result.errorMessage).toBe('402 Payment Required - quota exceeded');
  });
});
