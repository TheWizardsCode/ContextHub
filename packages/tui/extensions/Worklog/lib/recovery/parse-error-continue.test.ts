/**
 * Tests for the single-shot parse-error continue handler.
 *
 * Covers the operator decision: a JSON parse error resumes the session
 * with exactly one plain "continue" prompt — no exponential-backoff
 * retry loop — and a repeated parse error triggers a new continue on the
 * next agent_end (one prompt per occurrence, no unbounded loop).
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/parse-error-continue.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { executeParseErrorContinue } from './recovery.js';
import { classifyError, ErrorCategory } from './error-patterns.js';

// ── executeParseErrorContinue ─────────────────────────────────────────

describe('executeParseErrorContinue', () => {
  it('sends exactly one continue prompt (single-shot, no retry loop)', async () => {
    const sendContinue = vi.fn().mockResolvedValue(undefined);

    const result = await executeParseErrorContinue({ sendContinue });

    expect(sendContinue).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.promptCount).toBe(1);
  });

  it('waits for the agent to become idle before sending the prompt', async () => {
    const order: string[] = [];
    const waitForIdle = vi.fn(async () => {
      order.push('waitForIdle');
    });
    const sendContinue = vi.fn(async () => {
      order.push('sendContinue');
    });

    await executeParseErrorContinue({ waitForIdle, sendContinue });

    expect(order).toEqual(['waitForIdle', 'sendContinue']);
    expect(waitForIdle).toHaveBeenCalledTimes(1);
  });

  it('does not loop on failure — one prompt per call', async () => {
    const sendContinue = vi.fn().mockResolvedValue(undefined);

    // Simulate a repeated parse error across two agent_end events:
    // each occurrence gets exactly one continue prompt.
    await executeParseErrorContinue({ sendContinue });
    await executeParseErrorContinue({ sendContinue });

    expect(sendContinue).toHaveBeenCalledTimes(2);
  });

  it('skips the prompt when shouldAbort returns true before idle', async () => {
    const waitForIdle = vi.fn().mockResolvedValue(undefined);
    const sendContinue = vi.fn().mockResolvedValue(undefined);

    const result = await executeParseErrorContinue({
      waitForIdle,
      sendContinue,
      shouldAbort: () => true,
    });

    expect(sendContinue).not.toHaveBeenCalled();
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.promptCount).toBe(0);
    expect(result.error).toBe('aborted');
  });

  it('skips the prompt when abort happens during the idle wait', async () => {
    const waitForIdle = vi.fn().mockResolvedValue(undefined);
    const sendContinue = vi.fn().mockResolvedValue(undefined);

    const result = await executeParseErrorContinue({
      waitForIdle,
      sendContinue,
      // Abort only after the idle wait (second check)
      shouldAbort: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
    });

    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(sendContinue).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.promptCount).toBe(0);
  });

  it('handles exceptions from sendContinue gracefully', async () => {
    const sendContinue = vi.fn().mockRejectedValue(new Error('agent busy'));

    const result = await executeParseErrorContinue({ sendContinue });

    expect(result.success).toBe(false);
    expect(result.promptCount).toBe(0);
    expect(result.error).toContain('agent busy');
  });

  it('handles non-Error exceptions gracefully', async () => {
    const sendContinue = vi.fn().mockRejectedValue('string error');

    const result = await executeParseErrorContinue({ sendContinue });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown error during parse-error continue');
  });
});

// ── Integration: classification → single-shot continue ───────────────

describe('parse-error classification → continue integration', () => {
  it('full flow: classify parse error → one continue prompt', async () => {
    // Simulate an agent_end message from audit_debug JSONL processing
    const message = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: "Expected ',' or '}' after property value in JSON at position 42",
    };

    expect(classifyError(message)).toBe(ErrorCategory.PARSE_ERROR);

    const sendContinue = vi.fn().mockResolvedValue(undefined);
    const result = await executeParseErrorContinue({ sendContinue });

    expect(result.success).toBe(true);
    expect(result.promptCount).toBe(1);
    expect(sendContinue).toHaveBeenCalledTimes(1);
  });

  it('Python JSONDecodeError classifies as PARSE_ERROR', () => {
    const message = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Expecting value: line 1 column 123 (char 122)',
    };
    expect(classifyError(message)).toBe(ErrorCategory.PARSE_ERROR);
  });

  it('unrelated errors do not trigger the parse-error continue path', () => {
    const message = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Some weird provider error',
    };
    expect(classifyError(message)).toBe(ErrorCategory.UNKNOWN);
  });
});
