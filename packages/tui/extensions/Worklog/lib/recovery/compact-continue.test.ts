/**
 * Tests for the compact-and-continue recovery handler.
 *
 * Covers detection of context-length exceeded, /compact execution,
 * auto-continuation, failure handling, and continuation state management.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/compact-continue.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { ContinuationState } from './retry-logic.js';
import {
  hasContextLengthStop,
  executeCompactAndContinue,
  DEFAULT_CONTINUATION_PROMPT,
} from './recovery.js';

// ── hasContextLengthStop ──────────────────────────────────────────────

describe('hasContextLengthStop', () => {
  it('detects stopReason "length"', () => {
    expect(hasContextLengthStop({ role: 'assistant', stopReason: 'length' })).toBe(true);
  });

  it('does not detect stopReason "stop" as context-length', () => {
    expect(hasContextLengthStop({ role: 'assistant', stopReason: 'stop' })).toBe(false);
  });

  it('does not detect stopReason "error" as context-length (unless pattern matches)', () => {
    expect(hasContextLengthStop({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'some unrelated error',
    })).toBe(false);
  });

  it('detects context-length error patterns with stopReason "error"', () => {
    expect(hasContextLengthStop({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'context length exceeded. reduce your prompt.',
    })).toBe(true);
  });

  it('detects max tokens pattern', () => {
    expect(hasContextLengthStop({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'This model\'s maximum context length is 8192 tokens',
    })).toBe(true);
  });

  it('detects token limit exceeded patterns', () => {
    expect(hasContextLengthStop({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Token limit exceeded (4096 > 2048)',
    })).toBe(true);
  });

  it('detects "too many tokens" pattern', () => {
    expect(hasContextLengthStop({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Too many tokens in the prompt',
    })).toBe(true);
  });

  it('returns false for user messages', () => {
    expect(hasContextLengthStop({ role: 'user', content: 'hello' })).toBe(false);
  });

  it('returns false for non-object inputs', () => {
    expect(hasContextLengthStop(null)).toBe(false);
    expect(hasContextLengthStop(undefined)).toBe(false);
    expect(hasContextLengthStop('string')).toBe(false);
  });

  it('returns false for messages without stopReason', () => {
    expect(hasContextLengthStop({ role: 'assistant', content: 'normal response' })).toBe(false);
  });
});

// ── executeCompactAndContinue ─────────────────────────────────────────

describe('executeCompactAndContinue', () => {
  it('calls executeCompact when context-length is detected', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    await executeCompactAndContinue(state, {
      executeCompact,
    });

    expect(executeCompact).toHaveBeenCalledTimes(1);
  });

  it('increments continuation count on success', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    const result = await executeCompactAndContinue(state, { executeCompact });
    expect(result.success).toBe(true);
    expect(result.continuationCount).toBe(1);
    expect(state.getCount()).toBe(1); // state is marked continuing, then ended
  });

  it('multiple calls increment continuation count', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    const r1 = await executeCompactAndContinue(state, { executeCompact });
    expect(r1.continuationCount).toBe(1);

    const r2 = await executeCompactAndContinue(state, { executeCompact });
    expect(r2.continuationCount).toBe(2);
  });

  it('returns error when /compact fails', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({
      success: false,
      error: 'Failed to compact context',
    });

    const result = await executeCompactAndContinue(state, { executeCompact });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to compact context');
    // Continuation count should still track the attempt
    expect(result.continuationCount).toBe(1);
  });

  it('handles exceptions from executeCompact gracefully', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockRejectedValue(new Error('Unexpected error'));

    const result = await executeCompactAndContinue(state, { executeCompact });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unexpected error');
  });

  it('handles non-Error exceptions gracefully', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockRejectedValue('string error');

    const result = await executeCompactAndContinue(state, { executeCompact });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown error during compact-and-continue');
  });

  it('uses default continuation prompt when none provided', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    const result = await executeCompactAndContinue(state, { executeCompact });
    expect(result.success).toBe(true);
  });

  it('uses custom continuation prompt when provided', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    await executeCompactAndContinue(state, {
      executeCompact,
      continuationPrompt: 'Custom: keep going.',
    });

    expect(executeCompact).toHaveBeenCalledTimes(1);
  });

  it('resets continuation state on successful completion via complete()', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    // Simulate two continuations
    await executeCompactAndContinue(state, { executeCompact });
    await executeCompactAndContinue(state, { executeCompact });
    expect(state.getCount()).toBe(2);

    // Now simulate normal completion (not context-length)
    state.complete();
    expect(state.getCount()).toBe(0);
    expect(state.getIsContinuing()).toBe(false);
  });

  it('resets continuation state via reset()', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    await executeCompactAndContinue(state, { executeCompact });
    expect(state.getCount()).toBe(1);

    state.reset();
    expect(state.getCount()).toBe(0);
  });
});

// ── Integration: hasContextLengthStop + executeCompactAndContinue ─────

describe('compact-and-continue integration', () => {
  it('full flow: detect → compact → continue (success path)', async () => {
    // Simulate an agent_end event with stopReason "length"
    const message = { role: 'assistant', stopReason: 'length' };

    expect(hasContextLengthStop(message)).toBe(true);

    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    const result = await executeCompactAndContinue(state, { executeCompact });

    expect(result.success).toBe(true);
    expect(executeCompact).toHaveBeenCalledOnce();
  });

  it('full flow: detect → compact fails → graceful fallback', async () => {
    const message = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'context length exceeded',
    };

    expect(hasContextLengthStop(message)).toBe(true);

    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({
      success: false,
      error: 'Compact service unavailable',
    });

    const result = await executeCompactAndContinue(state, { executeCompact });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Compact service unavailable');
    // Caller should save checkpoint and display error
  });

  it('does NOT trigger compact for stopReason "stop" (genuine completion)', () => {
    const message = { role: 'assistant', stopReason: 'stop' };
    expect(hasContextLengthStop(message)).toBe(false);
  });
});

// ── DEFAULT_CONTINUATION_PROMPT ───────────────────────────────────────

describe('DEFAULT_CONTINUATION_PROMPT', () => {
  it('has a sensible default value', () => {
    expect(DEFAULT_CONTINUATION_PROMPT).toBeTruthy();
    expect(typeof DEFAULT_CONTINUATION_PROMPT).toBe('string');
    expect(DEFAULT_CONTINUATION_PROMPT.length).toBeGreaterThan(10);
  });
});
