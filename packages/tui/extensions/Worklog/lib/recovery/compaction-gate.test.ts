/**
 * Tests for the compaction-gate recovery flow.
 *
 * Covers:
 * - Gate detection (detecting the proxy compaction gate signal)
 * - Detect → compact → retry flow (success path)
 * - Compaction failure → fallback guidance
 * - Non-compactable session → explicit guidance
 * - Retry limit guard (prevents infinite detect → compact → retry loops)
 * - Distinct from CONTEXT_LENGTH (stopReason "length")
 *
 * Wire contract (suggested, TBD with llm-proxy LP-0MTBOX45O005LD1S):
 *   HTTP 413 (Payload Too Large) with `X-Compaction-Gate: true` header.
 *   Error message in agent_end contains the compaction gate signal.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/compaction-gate.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyError, ErrorCategory } from './error-patterns.js';
import {
  hasContextLengthStop,
  executeCompactAndContinue,
  type CompactContinueResult,
  isCompactionGateResponse,
  shouldTriggerCompactionGateRecovery,
  COMPACTION_GATE_FALLBACK_MESSAGE,
  MAX_COMPACTION_GATE_RETRIES,
} from './recovery.js';
import { ContinuationState } from './retry-logic.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeAssistantMsg(errorMessage: string, stopReason = 'error'): any {
  return {
    role: 'assistant',
    stopReason,
    errorMessage,
  };
}

// ── isCompactionGateResponse ──────────────────────────────────────────

describe('isCompactionGateResponse', () => {
  it('detects compaction gate error messages', () => {
    expect(isCompactionGateResponse(makeAssistantMsg('Compaction gate triggered'))).toBe(true);
  });

  it('detects HTTP 413 payload-too-large messages', () => {
    expect(isCompactionGateResponse(makeAssistantMsg('HTTP 413: Payload Too Large — context exceeds limit'))).toBe(true);
  });

  it('detects request-too-large messages', () => {
    expect(isCompactionGateResponse(makeAssistantMsg('Request too large: context window exceeded'))).toBe(true);
  });

  it('returns false for stopReason "length" (not a gate)', () => {
    expect(isCompactionGateResponse({ role: 'assistant', stopReason: 'length' })).toBe(false);
  });

  it('returns false for messages without errorMessage', () => {
    expect(isCompactionGateResponse({ role: 'assistant', stopReason: 'stop' })).toBe(false);
  });

  it('returns false for context-length errors (the model-level signal)', () => {
    expect(isCompactionGateResponse(makeAssistantMsg('context length exceeded'))).toBe(false);
  });

  it('returns false for non-assistant and non-object inputs', () => {
    expect(isCompactionGateResponse({ role: 'user', content: 'hi' })).toBe(false);
    expect(isCompactionGateResponse(null)).toBe(false);
    expect(isCompactionGateResponse(undefined)).toBe(false);
  });
});

// ── Gate Detection ────────────────────────────────────────────────────

describe('compaction gate detection', () => {
  it('classifies compaction gate messages as COMPACTION_GATE', () => {
    const msg = makeAssistantMsg('Request too large — context exceeds proxy hard cap');
    expect(classifyError(msg)).toBe(ErrorCategory.COMPACTION_GATE);
  });

  it('classifies compaction gate with "compaction gate" keyword', () => {
    const msg = makeAssistantMsg('Compaction gate triggered: context size limit reached');
    expect(classifyError(msg)).toBe(ErrorCategory.COMPACTION_GATE);
  });

  it('classifies compaction gate with HTTP 413 signal', () => {
    const msg = makeAssistantMsg('HTTP 413: Payload Too Large — context exceeds limit');
    expect(classifyError(msg)).toBe(ErrorCategory.COMPACTION_GATE);
  });

  it('classifies compaction gate with "request too large" pattern', () => {
    const msg = makeAssistantMsg('Request too large: context window exceeded');
    expect(classifyError(msg)).toBe(ErrorCategory.COMPACTION_GATE);
  });

  it('does NOT classify context-length (stopReason "length") as COMPACTION_GATE', () => {
    const msg = { role: 'assistant', stopReason: 'length' };
    expect(classifyError(msg)).toBe(ErrorCategory.CONTEXT_LENGTH);
    expect(classifyError(msg)).not.toBe(ErrorCategory.COMPACTION_GATE);
  });

  it('does NOT classify generic context-length error as COMPACTION_GATE', () => {
    const msg = makeAssistantMsg('context length exceeded — model max tokens');
    expect(classifyError(msg)).toBe(ErrorCategory.CONTEXT_LENGTH);
    expect(classifyError(msg)).not.toBe(ErrorCategory.COMPACTION_GATE);
  });

  it('does NOT classify 500 server error as COMPACTION_GATE', () => {
    const msg = makeAssistantMsg('500 Internal Server Error');
    expect(classifyError(msg)).toBe(ErrorCategory.SERVER_ERROR);
    expect(classifyError(msg)).not.toBe(ErrorCategory.COMPACTION_GATE);
  });

  it('does NOT classify 401 auth error as COMPACTION_GATE', () => {
    const msg = makeAssistantMsg('401 Unauthorized');
    expect(classifyError(msg)).toBe(ErrorCategory.AUTH_ERROR);
    expect(classifyError(msg)).not.toBe(ErrorCategory.COMPACTION_GATE);
  });

  it('returns UNKNOWN for messages that do not match any pattern', () => {
    const msg = makeAssistantMsg('Some completely unrelated error');
    expect(classifyError(msg)).toBe(ErrorCategory.UNKNOWN);
  });

  it('returns UNKNOWN for non-assistant messages', () => {
    expect(classifyError({ role: 'user', content: 'hello' })).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError({ role: 'system', content: 'instructions' })).toBe(ErrorCategory.UNKNOWN);
  });

  it('returns UNKNOWN for null/undefined/non-object inputs', () => {
    expect(classifyError(null)).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(undefined)).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError('string')).toBe(ErrorCategory.UNKNOWN);
  });
});

// ── Gate detection is distinct from CONTEXT_LENGTH ────────────────────

describe('gate detection is distinct from CONTEXT_LENGTH', () => {
  it('CONTEXT_LENGTH (stopReason "length") is NOT COMPACTION_GATE', () => {
    const ctxMsg = { role: 'assistant', stopReason: 'length' };
    const gateMsg = makeAssistantMsg('Compaction gate triggered');

    expect(classifyError(ctxMsg)).toBe(ErrorCategory.CONTEXT_LENGTH);
    expect(classifyError(gateMsg)).toBe(ErrorCategory.COMPACTION_GATE);
    expect(classifyError(ctxMsg)).not.toBe(classifyError(gateMsg));
  });

  it('CONTEXT_LENGTH text patterns do not match COMPACTION_GATE', () => {
    const ctxMsg = makeAssistantMsg('maximum context length is 8192 tokens');
    const gateMsg = makeAssistantMsg('compaction gate: request exceeds proxy limit');

    expect(classifyError(ctxMsg)).toBe(ErrorCategory.CONTEXT_LENGTH);
    expect(classifyError(gateMsg)).toBe(ErrorCategory.COMPACTION_GATE);
  });

  it('hasContextLengthStop returns false for compaction gate messages', () => {
    const gateMsg = makeAssistantMsg('Compaction gate triggered');
    expect(hasContextLengthStop(gateMsg)).toBe(false);
  });

  it('hasContextLengthStop returns true for stopReason "length"', () => {
    const ctxMsg = { role: 'assistant', stopReason: 'length' };
    expect(hasContextLengthStop(ctxMsg)).toBe(true);
  });
});

// ── Gate → Compact → Retry (success path) ─────────────────────────────

describe('gate → compact → retry flow (success path)', () => {
  let state: ContinuationState;
  let executeCompact: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state = new ContinuationState();
    executeCompact = vi.fn().mockResolvedValue({ success: true });
  });

  it('executes compact when gate is detected', async () => {
    const msg = makeAssistantMsg('Compaction gate triggered');
    expect(classifyError(msg)).toBe(ErrorCategory.COMPACTION_GATE);

    await executeCompactAndContinue(state, { executeCompact });

    expect(executeCompact).toHaveBeenCalledTimes(1);
  });

  it('returns success when compaction succeeds', async () => {
    const result = await executeCompactAndContinue(state, { executeCompact });

    expect(result.success).toBe(true);
    expect(result.continuationCount).toBe(1);
  });

  it('increments continuation count across multiple gate events', async () => {
    await executeCompactAndContinue(state, { executeCompact });
    expect(state.getCount()).toBe(1);

    await executeCompactAndContinue(state, { executeCompact });
    expect(state.getCount()).toBe(2);
  });
});

// ── Compaction failure → fallback guidance ────────────────────────────

describe('compaction failure → fallback guidance', () => {
  let state: ContinuationState;

  beforeEach(() => {
    state = new ContinuationState();
  });

  it('returns error when /compact fails', async () => {
    const executeCompact = vi.fn().mockResolvedValue({
      success: false,
      error: 'Compaction failed: context too small to reduce further',
    });

    const result = await executeCompactAndContinue(state, { executeCompact });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Compaction failed: context too small to reduce further');
  });

  it('returns error when /compact throws', async () => {
    const executeCompact = vi.fn().mockRejectedValue(new Error('Compact service unavailable'));

    const result = await executeCompactAndContinue(state, { executeCompact });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Compact service unavailable');
  });

  it('handles non-Error rejection gracefully', async () => {
    const executeCompact = vi.fn().mockRejectedValue('string error');

    const result = await executeCompactAndContinue(state, { executeCompact });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown error during compact-and-continue');
  });

  it('tracks failure attempt in continuation count', async () => {
    const executeCompact = vi.fn().mockResolvedValue({
      success: false,
      error: 'Compact failed',
    });

    const result = await executeCompactAndContinue(state, { executeCompact });

    expect(result.continuationCount).toBe(1);
  });
});

// ── Non-compactable session → explicit guidance ───────────────────────

describe('non-compactable session → explicit guidance', () => {
  it('compaction failure message is actionable', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({
      success: false,
      error: 'Context cannot be compacted further — session at minimum size',
    });

    const result = await executeCompactAndContinue(state, { executeCompact });

    expect(result.success).toBe(false);
    // The fallback guidance should tell the user to start a new session
    expect(result.error).toContain('compacted');
  });

  it('continuation state is properly ended on failure', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({
      success: false,
      error: 'Compact failed',
    });

    await executeCompactAndContinue(state, { executeCompact });

    // After failure, isContinuing should be false
    expect(state.getIsContinuing()).toBe(false);
  });

  it('has an actionable fallback message constant', () => {
    expect(COMPACTION_GATE_FALLBACK_MESSAGE).toContain('start a new session');
    expect(COMPACTION_GATE_FALLBACK_MESSAGE).toContain('compacted');
  });
});

// ── Retry limit guard ─────────────────────────────────────────────────

describe('retry limit guard (prevents infinite loops)', () => {
  it('continuation count increments across retries', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    // Simulate 3 gate → compact → retry cycles
    for (let i = 0; i < 3; i++) {
      await executeCompactAndContinue(state, { executeCompact });
    }

    expect(state.getCount()).toBe(3);
  });

  it('executeCompactAndContinue returns failure once maxRetries is reached', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    // Attempt 1 and 2 succeed within the cap
    const r1 = await executeCompactAndContinue(state, { executeCompact, maxRetries: 2 });
    expect(r1.success).toBe(true);
    const r2 = await executeCompactAndContinue(state, { executeCompact, maxRetries: 2 });
    expect(r2.success).toBe(true);

    // Attempt 3 is at the cap → must NOT compact again (no infinite loop)
    const r3 = await executeCompactAndContinue(state, { executeCompact, maxRetries: 2 });
    expect(r3.success).toBe(false);
    expect(executeCompact).toHaveBeenCalledTimes(2);
    expect(r3.error).toContain('retry limit');
  });

  it('does not increment the count when the retry limit is hit', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    // maxRetries=1 → exactly one compact cycle; later gate events are blocked
    const r1 = await executeCompactAndContinue(state, { executeCompact, maxRetries: 1 });
    expect(r1.success).toBe(true);
    const r2 = await executeCompactAndContinue(state, { executeCompact, maxRetries: 1 });
    expect(r2.success).toBe(false);
    const r3 = await executeCompactAndContinue(state, { executeCompact, maxRetries: 1 });

    expect(r3.success).toBe(false);
    expect(state.getCount()).toBe(1); // capped at the max-retries limit
    expect(executeCompact).toHaveBeenCalledTimes(1);
  });

  it('count resets on successful turn (non-error completion)', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    await executeCompactAndContinue(state, { executeCompact });
    expect(state.getCount()).toBe(1);

    state.complete();
    expect(state.getCount()).toBe(0);
  });

  it('count resets via reset()', async () => {
    const state = new ContinuationState();
    const executeCompact = vi.fn().mockResolvedValue({ success: true });

    await executeCompactAndContinue(state, { executeCompact });
    expect(state.getCount()).toBe(1);

    state.reset();
    expect(state.getCount()).toBe(0);
  });
});

// ── shouldTriggerCompactionGateRecovery guards ────────────────────────

describe('shouldTriggerCompactionGateRecovery', () => {
  const baseGuards = {
    userAborted: false,
    continueInProgress: false,
    continuationInFlight: false,
    continuationCount: 0,
  };

  it('allows recovery when all guards pass', () => {
    expect(shouldTriggerCompactionGateRecovery(baseGuards)).toBe(true);
  });

  it('blocks when the user aborted', () => {
    expect(shouldTriggerCompactionGateRecovery({ ...baseGuards, userAborted: true })).toBe(false);
  });

  it('blocks when another retry loop is running (mutex)', () => {
    expect(shouldTriggerCompactionGateRecovery({ ...baseGuards, continueInProgress: true })).toBe(false);
  });

  it('blocks when a continuation is already in flight', () => {
    expect(shouldTriggerCompactionGateRecovery({ ...baseGuards, continuationInFlight: true })).toBe(false);
  });

  it('allows recovery below the retry cap', () => {
    expect(shouldTriggerCompactionGateRecovery({ ...baseGuards, continuationCount: 1 }, 2)).toBe(true);
  });

  it('blocks recovery once the retry cap is reached', () => {
    expect(shouldTriggerCompactionGateRecovery({ ...baseGuards, continuationCount: 2 }, 2)).toBe(false);
    expect(shouldTriggerCompactionGateRecovery({ ...baseGuards, continuationCount: 3 })).toBe(false);
  });

  it('uses MAX_COMPACTION_GATE_RETRIES as the default cap', () => {
    expect(MAX_COMPACTION_GATE_RETRIES).toBe(2);
    // Below the default cap the guard allows recovery;
    expect(shouldTriggerCompactionGateRecovery({ ...baseGuards, continuationCount: 1 })).toBe(true);
    // at/over the cap it blocks.
    expect(shouldTriggerCompactionGateRecovery({ ...baseGuards, continuationCount: MAX_COMPACTION_GATE_RETRIES })).toBe(false);
  });
});

// ── Classification ordering (gate before context-length patterns) ─────

describe('classification ordering (gate takes priority over generic context-length)', () => {
  it('compaction gate keywords are classified as GATE, not CONTEXT_LENGTH', () => {
    // Even though "context" appears, "compaction gate" is more specific
    const msg = makeAssistantMsg('compaction gate: context exceeds proxy limit');
    expect(classifyError(msg)).toBe(ErrorCategory.COMPACTION_GATE);
    expect(classifyError(msg)).not.toBe(ErrorCategory.CONTEXT_LENGTH);
  });

  it('generic context-length without gate signal stays CONTEXT_LENGTH', () => {
    const msg = makeAssistantMsg('context length limit reached');
    expect(classifyError(msg)).toBe(ErrorCategory.CONTEXT_LENGTH);
  });
});
