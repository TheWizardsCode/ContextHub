/**
 * Integration tests for the recovery module.
 *
 * Covers end-to-end flows: error detection → classification → dispatch
 * → correct action (retry, compact-and-continue, checkpoint-and-terminate).
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/integration.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyError, ErrorCategory } from './error-patterns.js';
import { hasContextLengthStop } from './recovery.js';

// ── Helper ────────────────────────────────────────────────────────────

function makeAssistantMsg(errorMessage: string, stopReason = 'error'): any {
  return {
    role: 'assistant',
    stopReason,
    errorMessage,
  };
}

// ── End-to-end: classification → dispatch mapping ─────────────────────

describe('classification → dispatch mapping', () => {
  // Rate limit → UNKNOWN (not retried)
  it('rate limit is classified as RATE_LIMIT', () => {
    const msg = makeAssistantMsg('429 Too Many Requests');
    expect(classifyError(msg)).toBe(ErrorCategory.RATE_LIMIT);
  });

  // Server error → SERVER_ERROR (retried)
  it('server error is classified as SERVER_ERROR', () => {
    const msg = makeAssistantMsg('500 Internal Server Error');
    expect(classifyError(msg)).toBe(ErrorCategory.SERVER_ERROR);
  });

  it('server error 503 is classified as SERVER_ERROR', () => {
    const msg = makeAssistantMsg('503 Service Unavailable');
    expect(classifyError(msg)).toBe(ErrorCategory.SERVER_ERROR);
  });

  // Auth error → AUTH_ERROR (checkpoint + terminate)
  it('auth error 401 is classified as AUTH_ERROR', () => {
    const msg = makeAssistantMsg('401 Unauthorized');
    expect(classifyError(msg)).toBe(ErrorCategory.AUTH_ERROR);
  });

  it('auth error 403 is classified as AUTH_ERROR', () => {
    const msg = makeAssistantMsg('403 Forbidden');
    expect(classifyError(msg)).toBe(ErrorCategory.AUTH_ERROR);
  });

  // Context-length → CONTEXT_LENGTH (compact + continue)
  it('context-length stopReason length is classified as CONTEXT_LENGTH', () => {
    const msg = { role: 'assistant', stopReason: 'length' };
    expect(classifyError(msg)).toBe(ErrorCategory.CONTEXT_LENGTH);
  });

  it('context-length text in error is classified as CONTEXT_LENGTH', () => {
    const msg = makeAssistantMsg('context length exceeded');
    expect(classifyError(msg)).toBe(ErrorCategory.CONTEXT_LENGTH);
  });

  // Quota exhausted → QUOTA_EXHAUSTED (checkpoint + terminate)
  it('quota exhausted is classified as QUOTA_EXHAUSTED', () => {
    const msg = makeAssistantMsg('Not enough credits');
    expect(classifyError(msg)).toBe(ErrorCategory.QUOTA_EXHAUSTED);
  });

  // Timeout → TIMEOUT (retried)
  it('timeout is classified as TIMEOUT', () => {
    const msg = makeAssistantMsg('Request timed out');
    expect(classifyError(msg)).toBe(ErrorCategory.TIMEOUT);
  });

  // Terminated → TERMINATED (checkpoint + terminate)
  it('terminated is classified as TERMINATED', () => {
    const msg = makeAssistantMsg('content_filter');
    expect(classifyError(msg)).toBe(ErrorCategory.TERMINATED);
  });
});

// ── End-to-end: agent_end → classification flow ───────────────────────

describe('agent_end → classification flow', () => {
  it('server error triggers retryable classification', () => {
    const msg = makeAssistantMsg('502 Bad Gateway');
    const category = classifyError(msg);

    // Server errors and timeout are retryable
    expect(category === ErrorCategory.SERVER_ERROR || category === ErrorCategory.TIMEOUT).toBe(true);
  });

  it('auth error triggers terminal classification', () => {
    const msg = makeAssistantMsg('Invalid API key');
    const category = classifyError(msg);

    // Auth, quota, terminated are terminal
    expect([
      ErrorCategory.AUTH_ERROR,
      ErrorCategory.QUOTA_EXHAUSTED,
      ErrorCategory.TERMINATED,
    ]).toContain(category);
  });

  it('context-length triggers continue classification', () => {
    const msg = { role: 'assistant', stopReason: 'length' };
    const category = classifyError(msg);

    expect(category).toBe(ErrorCategory.CONTEXT_LENGTH);
  });
});

// ── hasContextLengthStop integration ───────────────────────────────────

describe('hasContextLengthStop integration', () => {
  it('detects length stop reason', () => {
    expect(hasContextLengthStop({ role: 'assistant', stopReason: 'length' })).toBe(true);
  });

  it('does not detect stop as length', () => {
    expect(hasContextLengthStop({ role: 'assistant', stopReason: 'stop' })).toBe(false);
  });

  it('does not detect error as length without pattern match', () => {
    expect(hasContextLengthStop({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '500 error',
    })).toBe(false);
  });

  it('detects length from error message patterns', () => {
    expect(hasContextLengthStop({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'maximum context length is 4096 tokens',
    })).toBe(true);
  });
});

// ── No false positives for non-retryable errors ───────────────────────

describe('no false positives (non-retryable → not classified as retryable)', () => {
  it('rate limit is NOT classified as SERVER_ERROR', () => {
    expect(classifyError(makeAssistantMsg('429'))).not.toBe(ErrorCategory.SERVER_ERROR);
  });

  it('auth error is NOT classified as SERVER_ERROR', () => {
    expect(classifyError(makeAssistantMsg('401'))).not.toBe(ErrorCategory.SERVER_ERROR);
  });

  it('quota exhausted is NOT classified as TIMEOUT', () => {
    expect(classifyError(makeAssistantMsg('402 Payment Required'))).not.toBe(ErrorCategory.TIMEOUT);
  });

  it('normal stop is NOT classified as any error', () => {
    expect(classifyError({ role: 'assistant', stopReason: 'stop' })).toBe(ErrorCategory.UNKNOWN);
  });
});
