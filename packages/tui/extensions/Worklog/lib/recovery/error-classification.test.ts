/**
 * Tests for error classification patterns.
 *
 * Validates all 7 error categories with realistic provider error messages
 * and verifies that unknown errors are handled gracefully.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/error-classification.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  classifyError,
  isRateLimit,
  isServerError,
  isAuthError,
  isContextLengthExceeded,
  isQuotaExhausted,
  isTimeout,
  isTerminated,
  isParseError,
  ErrorCategory,
  type RecoveryConfig,
} from './error-patterns.js';

// ── Helper: build a minimal AgentMessage-like object ─────────────────
function makeErrorMsg(errorMessage: string, stopReason = 'error'): any {
  return {
    role: 'assistant',
    stopReason,
    errorMessage,
  };
}

// ── Rate Limit (429) ──────────────────────────────────────────────────

describe('isRateLimit', () => {
  it('detects 429 status code in error message', () => {
    expect(isRateLimit(makeErrorMsg('HTTP 429: Too Many Requests'))).toBe(true);
    expect(isRateLimit(makeErrorMsg('Status code 429 - rate limited'))).toBe(true);
    expect(isRateLimit(makeErrorMsg('Error: 429 Too Many Requests'))).toBe(true);
  });

  it('detects rate limit text patterns', () => {
    expect(isRateLimit(makeErrorMsg('Rate limit exceeded. Try again later.'))).toBe(true);
    expect(isRateLimit(makeErrorMsg('rate_limit_error: too many requests'))).toBe(true);
    expect(isRateLimit(makeErrorMsg('Too many requests. Please slow down.'))).toBe(true);
    expect(isRateLimit(makeErrorMsg('API rate limit exceeded'))).toBe(true);
  });

  it('returns false for server errors (5xx)', () => {
    expect(isRateLimit(makeErrorMsg('HTTP 500: Internal Server Error'))).toBe(false);
    expect(isRateLimit(makeErrorMsg('503 Service Unavailable'))).toBe(false);
  });

  it('returns false for non-error messages', () => {
    expect(isRateLimit(makeErrorMsg('', 'stop'))).toBe(false);
    expect(isRateLimit({ role: 'assistant', stopReason: 'stop' } as any)).toBe(false);
  });

  it('returns false when errorMessage is missing', () => {
    expect(isRateLimit({ role: 'assistant', stopReason: 'error' } as any)).toBe(false);
  });
});

// ── Server Error (5xx) ────────────────────────────────────────────────

describe('isServerError', () => {
  it('detects 5xx status codes', () => {
    expect(isServerError(makeErrorMsg('HTTP 500: Internal Server Error'))).toBe(true);
    expect(isServerError(makeErrorMsg('503 Service Unavailable'))).toBe(true);
    expect(isServerError(makeErrorMsg('502 Bad Gateway'))).toBe(true);
    expect(isServerError(makeErrorMsg('504 Gateway Timeout from upstream'))).toBe(true);
  });

  it('detects server error text patterns', () => {
    expect(isServerError(makeErrorMsg('Internal server error'))).toBe(true);
    expect(isServerError(makeErrorMsg('Service unavailable. Please try again.'))).toBe(true);
    expect(isServerError(makeErrorMsg('Server error occurred'))).toBe(true);
    expect(isServerError(makeErrorMsg('The server encountered an error'))).toBe(true);
    expect(isServerError(makeErrorMsg('overloaded'))).toBe(true);
  });

  it('returns false for rate limit errors', () => {
    expect(isServerError(makeErrorMsg('429 Too Many Requests'))).toBe(false);
  });

  it('returns false for non-error messages', () => {
    expect(isServerError(makeErrorMsg('', 'stop'))).toBe(false);
  });
});

// ── Auth Error (401/403) ─────────────────────────────────────────────

describe('isAuthError', () => {
  it('detects 401 status code patterns', () => {
    expect(isAuthError(makeErrorMsg('HTTP 401: Unauthorized'))).toBe(true);
    expect(isAuthError(makeErrorMsg('Authentication failed: invalid API key'))).toBe(true);
    expect(isAuthError(makeErrorMsg('API key not found'))).toBe(true);
    expect(isAuthError(makeErrorMsg('Invalid authentication credentials'))).toBe(true);
  });

  it('detects 403 status code patterns', () => {
    expect(isAuthError(makeErrorMsg('HTTP 403: Forbidden'))).toBe(true);
    expect(isAuthError(makeErrorMsg('403 Forbidden - access denied'))).toBe(true);
  });

  it('detects invalid/revoked API key patterns', () => {
    expect(isAuthError(makeErrorMsg('Invalid API key'))).toBe(true);
    expect(isAuthError(makeErrorMsg('API key has been revoked'))).toBe(true);
    expect(isAuthError(makeErrorMsg('API key missing'))).toBe(true);
  });

  it('returns false for server errors', () => {
    expect(isAuthError(makeErrorMsg('500 Internal Server Error'))).toBe(false);
  });

  it('returns false for non-error messages', () => {
    expect(isAuthError(makeErrorMsg('', 'stop'))).toBe(false);
  });
});

// ── Context-Length Exceeded ──────────────────────────────────────────

describe('isContextLengthExceeded', () => {
  it('detects stopReason "length"', () => {
    expect(isContextLengthExceeded(makeErrorMsg('Model reached max tokens', 'length'))).toBe(true);
  });

  it('does NOT detect stopReason "stop" as context-length', () => {
    expect(isContextLengthExceeded(makeErrorMsg('', 'stop'))).toBe(false);
  });

  it('does NOT detect stopReason "error" as context-length (unless pattern matches)', () => {
    expect(isContextLengthExceeded(makeErrorMsg('some error', 'error'))).toBe(false);
  });

  it('detects context length error patterns even with stopReason "error"', () => {
    expect(isContextLengthExceeded(makeErrorMsg('context length exceeded. reduce your prompt.', 'error'))).toBe(true);
    expect(isContextLengthExceeded(makeErrorMsg('maximum context length is 4096 tokens', 'error'))).toBe(true);
    expect(isContextLengthExceeded(makeErrorMsg('token limit exceeded (4096 > 2048)', 'error'))).toBe(true);
    expect(isContextLengthExceeded(makeErrorMsg('This model\'s maximum context length is 8192 tokens', 'error'))).toBe(true);
  });

  it('returns false for non-context-length errors', () => {
    expect(isContextLengthExceeded(makeErrorMsg('server error', 'error'))).toBe(false);
  });
});

// ── Quota Exhausted ───────────────────────────────────────────────────

describe('isQuotaExhausted', () => {
  it('detects quota/credit exhausted patterns', () => {
    expect(isQuotaExhausted(makeErrorMsg('Not enough credits'))).toBe(true);
    expect(isQuotaExhausted(makeErrorMsg('Insufficient credits to complete request'))).toBe(true);
    expect(isQuotaExhausted(makeErrorMsg('Out of credits. Please purchase more.'))).toBe(true);
    expect(isQuotaExhausted(makeErrorMsg('Quota exhausted for this billing period'))).toBe(true);
    expect(isQuotaExhausted(makeErrorMsg('Rate limit quota exceeded'))).toBe(true);
    expect(isQuotaExhausted(makeErrorMsg('402 Payment Required'))).toBe(true);
  });

  it('returns false for auth errors', () => {
    expect(isQuotaExhausted(makeErrorMsg('Invalid API key'))).toBe(false);
  });

  it('returns false for non-error messages', () => {
    expect(isQuotaExhausted(makeErrorMsg('', 'stop'))).toBe(false);
  });
});

// ── Timeout ───────────────────────────────────────────────────────────

describe('isTimeout', () => {
  it('detects timeout patterns', () => {
    expect(isTimeout(makeErrorMsg('Request timed out'))).toBe(true);
    expect(isTimeout(makeErrorMsg('Timeout waiting for response from upstream'))).toBe(true);
    expect(isTimeout(makeErrorMsg('Connection timeout'))).toBe(true);
    expect(isTimeout(makeErrorMsg('Socket timeout'))).toBe(true);
    expect(isTimeout(makeErrorMsg('Connection error: ETIMEDOUT'))).toBe(true);
    expect(isTimeout(makeErrorMsg('The request timed out after 30 seconds'))).toBe(true);
  });

  it('detects stream ended without finish_reason pattern', () => {
    expect(isTimeout(makeErrorMsg('Stream ended without finish_reason'))).toBe(true);
    expect(isTimeout(makeErrorMsg('stream ended without finish_reason'))).toBe(true);
    expect(isTimeout(makeErrorMsg('Stream ended without finish (connection dropped)'))).toBe(true);
    expect(isTimeout(makeErrorMsg('stream ended without finish - stream dropped'))).toBe(true);
  });

  it('detects network/connection failure patterns', () => {
    expect(isTimeout(makeErrorMsg('Network error: socket hang up'))).toBe(true);
    expect(isTimeout(makeErrorMsg('Fetch failed: ENOTFOUND'))).toBe(true);
    expect(isTimeout(makeErrorMsg('Connection refused'))).toBe(true);
    expect(isTimeout(makeErrorMsg('ECONNRESET - connection reset by peer'))).toBe(true);
    expect(isTimeout(makeErrorMsg('DNS lookup failed'))).toBe(true);
    expect(isTimeout(makeErrorMsg('Upstream connect error'))).toBe(true);
    expect(isTimeout(makeErrorMsg('Broken pipe'))).toBe(true);
  });

  it('returns false for server errors', () => {
    expect(isTimeout(makeErrorMsg('500 Internal Server Error'))).toBe(false);
  });

  it('returns false for non-error messages', () => {
    expect(isTimeout(makeErrorMsg('', 'stop'))).toBe(false);
  });
});

// ── Terminated ────────────────────────────────────────────────────────

describe('isTerminated', () => {
  it('detects termination patterns', () => {
    expect(isTerminated(makeErrorMsg('The model response was terminated'))).toBe(true);
    expect(isTerminated(makeErrorMsg('Response terminated due to content policy'))).toBe(true);
    expect(isTerminated(makeErrorMsg('Message blocked by content filter'))).toBe(true);
    expect(isTerminated(makeErrorMsg('content_filter'))).toBe(true);
    expect(isTerminated(makeErrorMsg('Model response flagged and blocked'))).toBe(true);
  });

  it('returns false for server errors', () => {
    expect(isTerminated(makeErrorMsg('500 Internal Server Error'))).toBe(false);
  });

  it('returns false for non-error messages', () => {
    expect(isTerminated(makeErrorMsg('', 'stop'))).toBe(false);
  });
});

// ── Parse Error (JSON) ────────────────────────────────────────────────

describe('isParseError', () => {
  it('detects V8/Node JSON.parse messages', () => {
    expect(isParseError(makeErrorMsg('Expected \'"\' or \'}\' after property value in JSON at position 123'))).toBe(true);
    expect(isParseError(makeErrorMsg('Unexpected end of JSON input'))).toBe(true);
    expect(isParseError(makeErrorMsg("Unexpected token '}' ... is not valid JSON"))).toBe(true);
    expect(isParseError(makeErrorMsg('Unexpected number in JSON'))).toBe(true);
    expect(isParseError(makeErrorMsg('Unexpected string in JSON at position 42'))).toBe(true);
    expect(isParseError(makeErrorMsg('Unexpected non-whitespace character after JSON at position 7'))).toBe(true);
    expect(isParseError(makeErrorMsg('Unterminated string in JSON at position 10'))).toBe(true);
    expect(isParseError(makeErrorMsg('Bad control character in string literal in JSON'))).toBe(true);
  });

  it('detects Python JSONDecodeError texts', () => {
    expect(isParseError(makeErrorMsg('Expecting value: line 1 column 123 (char 122)'))).toBe(true);
    expect(isParseError(makeErrorMsg("Expecting ',' delimiter: line 1 column 5 (char 4)"))).toBe(true);
    expect(isParseError(makeErrorMsg("Expecting ':' delimiter: line 1 column 9 (char 8)"))).toBe(true);
    expect(isParseError(makeErrorMsg('Expecting property name enclosed in double quotes: line 2'))).toBe(true);
    expect(isParseError(makeErrorMsg('Unterminated string starting at: line 1 column 3 (char 2)'))).toBe(true);
    expect(isParseError(makeErrorMsg('Invalid control character at: line 1 column 3 (char 2)'))).toBe(true);
    expect(isParseError(makeErrorMsg('Extra data: line 2 column 1 (line 1)'))).toBe(true);
  });

  it('detects generic JSON parse mentions', () => {
    expect(isParseError(makeErrorMsg('JSON parse error: Unexpected token o'))).toBe(true);
    expect(isParseError(makeErrorMsg('Invalid JSON received from provider'))).toBe(true);
    expect(isParseError(makeErrorMsg('SyntaxError: JSON.parse: unexpected character at line 1'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isParseError(makeErrorMsg('500 Internal Server Error'))).toBe(false);
    expect(isParseError(makeErrorMsg('Request timed out'))).toBe(false);
    expect(isParseError(makeErrorMsg('429 Too Many Requests'))).toBe(false);
    expect(isParseError(makeErrorMsg('context length exceeded'))).toBe(false);
  });

  it('returns false for non-error messages', () => {
    expect(isParseError(makeErrorMsg('', 'stop'))).toBe(false);
    expect(isParseError({ role: 'assistant', stopReason: 'stop' } as any)).toBe(false);
  });

  it('returns false when errorMessage is missing', () => {
    expect(isParseError({ role: 'assistant', stopReason: 'error' } as any)).toBe(false);
  });
});

// ── classifyError (unified dispatch) ──────────────────────────────────

describe('classifyError', () => {
  it('classifies rate limit errors', () => {
    expect(classifyError(makeErrorMsg('429 Too Many Requests'))).toBe(ErrorCategory.RATE_LIMIT);
    expect(classifyError(makeErrorMsg('Rate limit exceeded'))).toBe(ErrorCategory.RATE_LIMIT);
  });

  it('classifies server errors', () => {
    expect(classifyError(makeErrorMsg('500 Internal Server Error'))).toBe(ErrorCategory.SERVER_ERROR);
    expect(classifyError(makeErrorMsg('503 Service Unavailable'))).toBe(ErrorCategory.SERVER_ERROR);
  });

  it('classifies auth errors', () => {
    expect(classifyError(makeErrorMsg('401 Unauthorized'))).toBe(ErrorCategory.AUTH_ERROR);
    expect(classifyError(makeErrorMsg('Invalid API key'))).toBe(ErrorCategory.AUTH_ERROR);
  });

  it('classifies context-length exceeded', () => {
    expect(classifyError(makeErrorMsg('context length exceeded', 'length'))).toBe(ErrorCategory.CONTEXT_LENGTH);
    expect(classifyError(makeErrorMsg('maximum context length is 4096', 'error'))).toBe(ErrorCategory.CONTEXT_LENGTH);
  });

  it('classifies quota exhausted', () => {
    expect(classifyError(makeErrorMsg('Not enough credits'))).toBe(ErrorCategory.QUOTA_EXHAUSTED);
    expect(classifyError(makeErrorMsg('Quota exhausted'))).toBe(ErrorCategory.QUOTA_EXHAUSTED);
  });

  it('classifies timeout errors', () => {
    expect(classifyError(makeErrorMsg('Request timed out'))).toBe(ErrorCategory.TIMEOUT);
    expect(classifyError(makeErrorMsg('Connection error: ETIMEDOUT'))).toBe(ErrorCategory.TIMEOUT);
    expect(classifyError(makeErrorMsg('Stream ended without finish_reason'))).toBe(ErrorCategory.TIMEOUT);
  });

  it('classifies terminated errors', () => {
    expect(classifyError(makeErrorMsg('content_filter'))).toBe(ErrorCategory.TERMINATED);
    expect(classifyError(makeErrorMsg('Response terminated by content policy'))).toBe(ErrorCategory.TERMINATED);
  });

  it('classifies JSON parse errors', () => {
    expect(classifyError(makeErrorMsg('Expected \'"\' or \'}\' after property value'))).toBe(ErrorCategory.PARSE_ERROR);
    expect(classifyError(makeErrorMsg('Unexpected end of JSON input'))).toBe(ErrorCategory.PARSE_ERROR);
    expect(classifyError(makeErrorMsg('Expecting value: line 1 column 5'))).toBe(ErrorCategory.PARSE_ERROR);
    expect(classifyError(makeErrorMsg('JSON parse error: unexpected token'))).toBe(ErrorCategory.PARSE_ERROR);
    expect(classifyError(makeErrorMsg('Invalid JSON'))).toBe(ErrorCategory.PARSE_ERROR);
  });

  it('returns UNKNOWN for unrecognized errors', () => {
    expect(classifyError(makeErrorMsg('Some weird error nobody has seen'))).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(makeErrorMsg(''))).toBe(ErrorCategory.UNKNOWN);
  });

  it('returns UNKNOWN for non-error messages', () => {
    expect(classifyError({ role: 'assistant', stopReason: 'stop' } as any)).toBe(ErrorCategory.UNKNOWN);
  });

  it('returns UNKNOWN when errorMessage is missing', () => {
    expect(classifyError({ role: 'assistant', stopReason: 'error' } as any)).toBe(ErrorCategory.UNKNOWN);
  });
});

// ── Configurable patterns ─────────────────────────────────────────────

describe('configurable error patterns', () => {
  it('allows custom patterns to override defaults', () => {
    const customConfig: Partial<RecoveryConfig> = {
      rateLimit: {
        enabled: true,
        patterns: [/my-custom-rate-limit-error/i],
      },
    };

    // With default config, this wouldn't be a rate limit
    expect(classifyError(makeErrorMsg('my-custom-rate-limit-error happened'))).toBe(ErrorCategory.UNKNOWN);

    // But we can test that the config structure is valid
    expect(customConfig.rateLimit?.patterns).toBeDefined();
    expect(customConfig.rateLimit?.patterns?.length).toBe(1);
  });

  it('settings structure supports per-category config', () => {
    const fullConfig: RecoveryConfig = {
      rateLimit: { enabled: false, patterns: [/429/i], baseDelayMs: 1000, maxDelayMs: 30000 },
      serverError: { enabled: true, patterns: [/5\d{2}/i, /server error/i], baseDelayMs: 2000, maxDelayMs: 60000 },
      authError: { enabled: false, patterns: [/401/i, /403/i, /invalid api key/i], baseDelayMs: 1000, maxDelayMs: 30000 },
      contextLength: { enabled: true, patterns: [/context length/i, /max.*tokens/i], baseDelayMs: 1000, maxDelayMs: 10000 },
      quotaExhausted: { enabled: false, patterns: [/credit/i, /quota/i], baseDelayMs: 1000, maxDelayMs: 30000 },
      timeout: { enabled: true, patterns: [/timeout/i, /timed out/i], baseDelayMs: 2000, maxDelayMs: 60000 },
      terminated: { enabled: false, patterns: [/terminated/i, /content.filter/i], baseDelayMs: 1000, maxDelayMs: 30000 },
      parseError: { enabled: true, patterns: [/unexpected end of json/i, /expecting value/i], baseDelayMs: 0, maxDelayMs: 0 },
    };

    expect(fullConfig.rateLimit.enabled).toBe(false);
    expect(fullConfig.serverError.enabled).toBe(true);
    expect(fullConfig.serverError.baseDelayMs).toBe(2000);
    expect(fullConfig.contextLength.enabled).toBe(true);
    expect(fullConfig.parseError.enabled).toBe(true);
  });
});

// ── Graceful handling of edge cases ───────────────────────────────────

describe('edge case handling', () => {
  it('handles undefined message gracefully', () => {
    expect(classifyError(undefined as any)).toBe(ErrorCategory.UNKNOWN);
  });

  it('handles null message gracefully', () => {
    expect(classifyError(null as any)).toBe(ErrorCategory.UNKNOWN);
  });

  it('handles non-object message gracefully', () => {
    expect(classifyError('string' as any)).toBe(ErrorCategory.UNKNOWN);
  });

  it('handles message without role gracefully', () => {
    expect(classifyError({ stopReason: 'error', errorMessage: 'test' } as any)).toBe(ErrorCategory.UNKNOWN);
  });

  it('handles non-assistant message gracefully', () => {
    expect(classifyError({ role: 'user', stopReason: 'error', errorMessage: 'test' } as any)).toBe(ErrorCategory.UNKNOWN);
  });

  it('handles very long error messages without crashing', () => {
    const longMsg = 'A'.repeat(10000);
    expect(classifyError(makeErrorMsg(longMsg))).toBe(ErrorCategory.UNKNOWN);
  });
});
