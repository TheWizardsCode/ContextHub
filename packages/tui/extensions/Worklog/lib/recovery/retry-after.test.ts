/**
 * Tests for server-requested retry-delay handling (Retry-After / retry_after).
 *
 * Covers:
 * - Parsing the proxy's `retry_after` body field and `Retry-After` header
 *   (delta-seconds and HTTP-date forms), including escaped JSON.
 * - Honouring the hint in `calculateDelay` / `computeRetryDelay`, bounded by
 *   the configured cap (default 60s), with upward-only jitter.
 * - Malformed/missing hints falling back to the existing exponential backoff,
 *   unchanged.
 * - Surviving a full 180s startup ramp.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/retry-after.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  calculateDelay,
  computeRetryDelay,
  resolveRetryDelay,
  parseServerRetryDelayMs,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
} from './retry-logic.js';

// A representative llm-proxy 503 startup-ramp error message as it reaches the
// extension (pi's formatProviderError renders "<status>: <body>").
const PROXY_RAMP_503 =
  '503: {"error":{"type":"startup_ramp","code":"startup_ramp","message":"Server is starting up; retry shortly."},"status":503,"retry_after":7}';

// ── parseServerRetryDelayMs: body field ───────────────────────────────

describe('parseServerRetryDelayMs (retry_after body field)', () => {
  it('parses retry_after from the proxy 503 startup_ramp body', () => {
    expect(parseServerRetryDelayMs(PROXY_RAMP_503)).toBe(7000);
  });

  it('parses escaped JSON retry_after (SDK folded the body into the message)', () => {
    const escaped = '503: {\\"retry_after\\": 9}';
    expect(parseServerRetryDelayMs(escaped)).toBe(9000);
  });

  it('parses fractional delta-seconds', () => {
    expect(parseServerRetryDelayMs('503: {"retry_after": 2.5}')).toBe(2500);
  });

  it('parses retry_after_ms as milliseconds', () => {
    expect(parseServerRetryDelayMs('503: {"retry_after_ms": 5000}')).toBe(5000);
  });

  it('returns 0 (retry now) for a retry_after of zero', () => {
    expect(parseServerRetryDelayMs('503: {"retry_after": 0}')).toBe(0);
  });
});

// ── parseServerRetryDelayMs: header forms ─────────────────────────────

describe('parseServerRetryDelayMs (Retry-After header forms)', () => {
  it('parses a delta-seconds Retry-After header', () => {
    expect(parseServerRetryDelayMs('HTTP 503\nRetry-After: 5')).toBe(5000);
  });

  it('is case-insensitive for the header name', () => {
    expect(parseServerRetryDelayMs('retry-after: 12')).toBe(12000);
  });

  it('parses retry-after-ms before retry-after', () => {
    expect(parseServerRetryDelayMs('Retry-After-Ms: 5000, Retry-After: 9')).toBe(5000);
  });

  it('parses an HTTP-date Retry-After (future)', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseServerRetryDelayMs(`503\nRetry-After: ${future}`);
    expect(parsed).toBeDefined();
    // Allow a generous window for test execution overhead.
    expect(parsed!).toBeGreaterThan(5000);
    expect(parsed!).toBeLessThanOrEqual(10_000);
  });

  it('returns 0 (retry now) for a past HTTP-date', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseServerRetryDelayMs(`503\nRetry-After: ${past}`)).toBe(0);
  });
});

// ── parseServerRetryDelayMs: malformed / absent ───────────────────────

describe('parseServerRetryDelayMs (malformed and absent)', () => {
  it('returns undefined for absent input', () => {
    expect(parseServerRetryDelayMs(undefined)).toBeUndefined();
    expect(parseServerRetryDelayMs(null)).toBeUndefined();
    expect(parseServerRetryDelayMs('')).toBeUndefined();
  });

  it('returns undefined when no hint is present', () => {
    expect(parseServerRetryDelayMs('503: Service temporarily unavailable')).toBeUndefined();
  });

  it('does not treat the HTTP status code as a hint', () => {
    expect(parseServerRetryDelayMs('503: upstream failure, status 503')).toBeUndefined();
  });

  it('returns undefined for non-numeric values', () => {
    expect(parseServerRetryDelayMs('503: {"retry_after": "abc"}')).toBeUndefined();
    expect(parseServerRetryDelayMs('Retry-After: soon')).toBeUndefined();
  });

  it('returns undefined for negative values', () => {
    expect(parseServerRetryDelayMs('503: {"retry_after": -3}')).toBeUndefined();
  });
});

// ── calculateDelay: hint honoured, bounded, jittered ──────────────────

describe('calculateDelay with a server hint', () => {
  const noJitter = () => 0;

  it('waits at least the server-requested delay when it exceeds the backoff', () => {
    // attempt 1 exponential = 2000ms, hint = 7000ms -> floor is 7000ms.
    expect(calculateDelay(1, DEFAULT_BACKOFF_CONFIG, 7000, noJitter)).toBe(7000);
  });

  it('honours the server hint even when the local exponential has grown larger', () => {
    // attempt 5 exponential = 32000ms, hint = 5000ms. The server hint is
    // authoritative: the local backoff must not override the recommended wait
    // (producer rejection: "the local retry mechanism overriding the
    // recommended wait duration").
    expect(calculateDelay(5, DEFAULT_BACKOFF_CONFIG, 5000, noJitter)).toBe(5000);
  });

  it('caps the server-requested delay at the configured maximum', () => {
    const config: BackoffConfig = { baseDelayMs: 2000, maxDelayMs: 60000, multiplier: 2 };
    expect(calculateDelay(1, config, 90_000, noJitter)).toBe(60_000);
  });

  it('applies upward-only jitter to hint-derived delays', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      multiplier: 2,
      serverHintJitterRatio: 0.25,
    };
    // Hint-derived delays track the hint, not the (smaller) exponential.
    expect(calculateDelay(1, config, 8000, () => 0)).toBe(8000);
    expect(calculateDelay(1, config, 8000, () => 0.5)).toBe(9000);
    expect(calculateDelay(1, config, 8000, () => 1)).toBe(10_000);
  });

  it('does not let the local backoff escalate a hint-derived delay across attempts', () => {
    // A constant 7s hint must yield ~7s on every attempt, even at attempt 6
    // where the local exponential would otherwise be capped at 60s.
    for (const attempt of [1, 2, 3, 4, 5, 6, 10]) {
      expect(calculateDelay(attempt, DEFAULT_BACKOFF_CONFIG, 7000, () => 0)).toBe(7000);
    }
  });

  it('never retries sooner than the hint under maximum jitter', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      multiplier: 2,
      serverHintJitterRatio: 0.5,
    };
    // Even with the largest jitter multiplier the delay only grows.
    expect(calculateDelay(1, config, 12_000, () => 1)).toBeGreaterThanOrEqual(12_000);
  });

  it('honours a zero jitter ratio exactly', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      multiplier: 2,
      serverHintJitterRatio: 0,
    };
    expect(calculateDelay(1, config, 7000, () => 1)).toBe(7000);
  });

  it('caps a jittered hint-derived delay at the maximum', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      multiplier: 2,
      serverHintJitterRatio: 0.25,
    };
    // floor = 60000 (hint), jitter pushes above, cap brings it back to 60000.
    expect(calculateDelay(1, config, 60_000, () => 1)).toBe(60_000);
  });
});

// ── calculateDelay: unchanged fallback (AC3) ──────────────────────────

describe('calculateDelay without a usable hint', () => {
  it('is unchanged from the original exponential backoff', () => {
    expect(calculateDelay(1)).toBe(2000);
    expect(calculateDelay(2)).toBe(4000);
    expect(calculateDelay(3)).toBe(8000);
    expect(calculateDelay(100)).toBe(60000);
  });

  it('treats NaN/Infinity/negative hints as absent', () => {
    expect(calculateDelay(1, DEFAULT_BACKOFF_CONFIG, Number.NaN)).toBe(2000);
    expect(calculateDelay(1, DEFAULT_BACKOFF_CONFIG, Number.POSITIVE_INFINITY)).toBe(2000);
    expect(calculateDelay(1, DEFAULT_BACKOFF_CONFIG, -1)).toBe(2000);
  });
});

// ── computeRetryDelay: error message -> delay ─────────────────────────

describe('computeRetryDelay', () => {
  it('honours the proxy retry_after body hint', () => {
    expect(computeRetryDelay(1, PROXY_RAMP_503, DEFAULT_BACKOFF_CONFIG, () => 0)).toBe(7000);
  });

  it('falls back to exponential backoff for malformed/unparseable hints', () => {
    expect(computeRetryDelay(1, '503: {"retry_after": "soon"}', DEFAULT_BACKOFF_CONFIG, () => 0)).toBe(2000);
    expect(computeRetryDelay(2, 'no hint here', DEFAULT_BACKOFF_CONFIG, () => 0)).toBe(4000);
    expect(computeRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, () => 0)).toBe(2000);
  });

  it('honours a Retry-After header hint', () => {
    expect(computeRetryDelay(1, '503\nRetry-After: 11', DEFAULT_BACKOFF_CONFIG, () => 0)).toBe(11_000);
  });
});

// ── resolveRetryDelay: the recovery loop's decision point ─────────────

describe('resolveRetryDelay', () => {
  it('returns the honoured delay and the parsed server hint', () => {
    const result = resolveRetryDelay(1, PROXY_RAMP_503, DEFAULT_BACKOFF_CONFIG, () => 0);
    expect(result.serverHintMs).toBe(7000);
    expect(result.delayMs).toBe(7000);
  });

  it('omits the server hint when the error carries none', () => {
    const result = resolveRetryDelay(2, 'plain server error', DEFAULT_BACKOFF_CONFIG, () => 0);
    expect(result.serverHintMs).toBeUndefined();
    expect(result.delayMs).toBe(4000);
  });

  it('matches computeRetryDelay for the same inputs', () => {
    const result = resolveRetryDelay(1, '503\nRetry-After: 11', DEFAULT_BACKOFF_CONFIG, () => 0.5);
    expect(result.delayMs).toBe(computeRetryDelay(1, '503\nRetry-After: 11', DEFAULT_BACKOFF_CONFIG, () => 0.5));
  });
});

// ── AC4: survive a full startup ramp ──────────────────────────────────

describe('startup-ramp survival (AC4)', () => {
  it('keeps scheduling delays at or above the server hint across a 180s ramp', () => {
    let elapsed = 0;
    let attempt = 0;
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      multiplier: 2,
      serverHintJitterRatio: 0.25,
    };

    // The proxy emits a randomised hint in [5s, 15s] per request during a
    // 180s ramp. There is no client budget: the loop must keep honouring it.
    while (elapsed < 180_000 && attempt < 100) {
      attempt++;
      const hintMs = 5000 + (attempt % 5) * 2500; // 5.0s .. 15.0s
      const delay = calculateDelay(attempt, config, hintMs, () => 0);
      expect(delay).toBeGreaterThanOrEqual(hintMs);
      expect(delay).toBeLessThanOrEqual(config.maxDelayMs);
      elapsed += delay;
    }

    expect(elapsed).toBeGreaterThanOrEqual(180_000);
    expect(attempt).toBeLessThan(100);
  });

  it('never waits less than the largest hint seen on an attempt', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      multiplier: 2,
      serverHintJitterRatio: 0.25,
    };
    for (let attempt = 1; attempt <= 20; attempt++) {
      const hintMs = 15_000;
      const delay = calculateDelay(attempt, config, hintMs, () => 0.999);
      expect(delay).toBeGreaterThanOrEqual(hintMs);
    }
  });
});
