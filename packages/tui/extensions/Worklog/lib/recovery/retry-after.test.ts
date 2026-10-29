/**
 * Tests for server-requested retry-delay handling (Retry-After / retry_after).
 *
 * Covers:
 * - Parsing the proxy's `retry_after` body field and `Retry-After` header
 *   (delta-seconds and HTTP-date forms), including escaped JSON.
 * - Honouring the hint in `calculateDelay` / `computeRetryDelay`, bounded by
 *   the configured cap (default 10 minutes), with upward-only jitter.
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
  clampCooldownMs,
  DEFAULT_BACKOFF_CONFIG,
  DEFAULT_SERVER_HINT_MAX_DELAY_MS,
  type BackoffConfig,
} from './retry-logic.js';
import { DEFAULT_RECOVERY_CONFIG } from './error-patterns.js';

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
    const config: BackoffConfig = { baseDelayMs: 2000, maxDelayMs: 600000, multiplier: 2 };
    expect(calculateDelay(1, config, 900_000, noJitter)).toBe(600_000);
  });

  it('applies upward-only jitter to hint-derived delays', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 600000,
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
    // where the local exponential would otherwise be capped at 10 minutes.
    for (const attempt of [1, 2, 3, 4, 5, 6, 10]) {
      expect(calculateDelay(attempt, DEFAULT_BACKOFF_CONFIG, 7000, () => 0)).toBe(7000);
    }
  });

  it('never retries sooner than the hint under maximum jitter', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 600000,
      multiplier: 2,
      serverHintJitterRatio: 0.5,
    };
    // Even with the largest jitter multiplier the delay only grows.
    expect(calculateDelay(1, config, 12_000, () => 1)).toBeGreaterThanOrEqual(12_000);
  });

  it('honours a zero jitter ratio exactly', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 600000,
      multiplier: 2,
      serverHintJitterRatio: 0,
    };
    expect(calculateDelay(1, config, 7000, () => 1)).toBe(7000);
  });

  it('caps a jittered hint-derived delay at the maximum', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 600000,
      multiplier: 2,
      serverHintJitterRatio: 0.25,
    };
    // floor = 600000 (hint), jitter pushes above, cap brings it back to 600000.
    expect(calculateDelay(1, config, 600_000, () => 1)).toBe(600_000);
  });
});

// ── calculateDelay: long server hints beyond the exponential cap (AC1) ─
//
// The llm-proxy emits a truthful `Retry-After` / `retry_after` on its
// "All providers exhausted" 503 that, during overnight UTC gaps, is minutes
// to hours. `BackoffConfig.serverHintMaxDelayMs` (default 6h = 21600000ms,
// documented in retry-logic.ts) bounds those long hints so the client waits
// the advertised time out instead of re-clamping to the 10-minute exponential cap.

describe('calculateDelay with a long server hint (server-hint ceiling)', () => {
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const SIX_HOURS_MS = 6 * ONE_HOUR_MS;

  it('exposes a 6-hour server-hint ceiling in the default config (AC7)', () => {
    expect(DEFAULT_BACKOFF_CONFIG.serverHintMaxDelayMs).toBe(SIX_HOURS_MS);
  });

  it('honours a hint longer than maxDelayMs in full, including upward jitter (AC1)', () => {
    // Hint = 1h, upward jitter = 25% * 0.5 = 12.5% -> 1h + 7m30s.
    expect(calculateDelay(1, DEFAULT_BACKOFF_CONFIG, ONE_HOUR_MS, () => 0.5)).toBe(
      4_050_000,
    );
  });

  it('does not clamp a long hint to the 10-minute exponential cap (AC1)', () => {
    const delay = calculateDelay(1, DEFAULT_BACKOFF_CONFIG, ONE_HOUR_MS, () => 0);
    expect(delay).toBe(ONE_HOUR_MS);
    expect(delay).toBeGreaterThan(DEFAULT_BACKOFF_CONFIG.maxDelayMs);
  });

  it('bounds a hint beyond the ceiling at the ceiling', () => {
    // An absurd 100h hint is bounded by the configurable 6h ceiling.
    expect(calculateDelay(1, DEFAULT_BACKOFF_CONFIG, 100 * ONE_HOUR_MS, () => 0)).toBe(
      SIX_HOURS_MS,
    );
  });

  it('allows the server-hint ceiling to be configured per instance', () => {
    const config: BackoffConfig = {
      baseDelayMs: 2000,
      maxDelayMs: 600000,
      multiplier: 2,
      serverHintMaxDelayMs: 2 * ONE_HOUR_MS,
    };
    expect(calculateDelay(1, config, 3 * ONE_HOUR_MS, () => 0)).toBe(2 * ONE_HOUR_MS);
    expect(calculateDelay(1, config, ONE_HOUR_MS, () => 0)).toBe(ONE_HOUR_MS);
  });

  it('leaves hints shorter than maxDelayMs unchanged (AC3)', () => {
    expect(calculateDelay(1, DEFAULT_BACKOFF_CONFIG, 7000, () => 0)).toBe(7000);
    expect(calculateDelay(6, DEFAULT_BACKOFF_CONFIG, 30_000, () => 0)).toBe(30_000);
  });

  it('keeps the no-hint exponential path capped at maxDelayMs (AC4)', () => {
    // The larger server-hint ceiling must not leak into the no-hint path.
    expect(calculateDelay(100, DEFAULT_BACKOFF_CONFIG)).toBe(600_000); // 10-minute ceiling
    expect(calculateDelay(50, DEFAULT_BACKOFF_CONFIG, undefined, () => 1)).toBe(600_000);
  });

  it('applies upward-only jitter to long hints (AC5)', () => {
    expect(calculateDelay(1, DEFAULT_BACKOFF_CONFIG, ONE_HOUR_MS, () => 0)).toBe(
      ONE_HOUR_MS,
    );
    expect(calculateDelay(1, DEFAULT_BACKOFF_CONFIG, ONE_HOUR_MS, () => 1)).toBe(
      4_500_000,
    );
  });

  it('never waits less than a long hint under maximum jitter (AC5)', () => {
    const delay = calculateDelay(1, DEFAULT_BACKOFF_CONFIG, ONE_HOUR_MS, () => 1);
    expect(delay).toBeGreaterThanOrEqual(ONE_HOUR_MS);
  });

  it('honours a multi-hour hint end-to-end from the proxy error message (AC1)', () => {
    const message =
      '503: {"error":{"type":"no_available_models"},"status":503,"retry_after":3600}';
    const result = resolveRetryDelay(1, message, DEFAULT_BACKOFF_CONFIG, () => 0);
    expect(result.serverHintMs).toBe(ONE_HOUR_MS);
    expect(result.delayMs).toBe(ONE_HOUR_MS);
    expect(result.delayMs).toBeGreaterThan(DEFAULT_BACKOFF_CONFIG.maxDelayMs);
  });

  it('honours a multi-hour Retry-After header hint (AC1)', () => {
    const result = resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, () => 0, 2 * ONE_HOUR_MS);
    expect(result.hintSource).toBe('header');
    expect(result.delayMs).toBe(2 * ONE_HOUR_MS);
  });
});

// ── Bounded default cooldown (WL-0MV5639X70029BOI) ────────────────────
//
// The durable model-cooldown marker must be best-effort but never unbounded
// and never zero: an absent/malformed `Retry-After` yields the bounded
// default, an explicit hint inside the window is honoured, and an over-ceiling
// (or absurd) hint is clamped to the 6-hour ceiling.

describe('clampCooldownMs (bounded default cooldown)', () => {
  const { defaultMs, floorMs, ceilingMs } = DEFAULT_RECOVERY_CONFIG.cooldown;

  it('falls back to the bounded default when the hint is absent', () => {
    expect(clampCooldownMs(undefined)).toBe(defaultMs);
    expect(clampCooldownMs(null)).toBe(defaultMs);
  });

  it('falls back to the bounded default for a malformed hint', () => {
    expect(clampCooldownMs(Number.NaN)).toBe(defaultMs);
    expect(clampCooldownMs(Number.POSITIVE_INFINITY)).toBe(defaultMs);
    expect(clampCooldownMs(Number.NEGATIVE_INFINITY)).toBe(defaultMs);
    expect(clampCooldownMs(-1)).toBe(defaultMs);
  });

  it('never yields a zero hold for an explicit zero hint (floors it)', () => {
    expect(clampCooldownMs(0)).toBe(floorMs);
    expect(clampCooldownMs(999)).toBe(floorMs);
  });

  it('honours a truthful short hint inside the window', () => {
    expect(clampCooldownMs(7000)).toBe(7000);
    expect(clampCooldownMs(11_000)).toBe(11_000);
  });

  it('clamps an honest hint above the ceiling rather than honouring it unbounded', () => {
    const tenHours = 10 * 60 * 60 * 1000;
    expect(clampCooldownMs(tenHours)).toBe(ceilingMs);
    expect(ceilingMs).toBe(DEFAULT_SERVER_HINT_MAX_DELAY_MS);
  });

  it('keeps the floor at or below the default and the default at or below the ceiling', () => {
    expect(floorMs).toBeGreaterThan(0);
    expect(defaultMs).toBeGreaterThanOrEqual(floorMs);
    expect(ceilingMs).toBeGreaterThanOrEqual(defaultMs);
  });

  it('supports a per-instance clamp configuration', () => {
    const config = { defaultMs: 120_000, floorMs: 5000, ceilingMs: 300_000 };
    expect(clampCooldownMs(undefined, config)).toBe(120_000);
    expect(clampCooldownMs(0, config)).toBe(5000);
    expect(clampCooldownMs(10 * 60 * 1000, config)).toBe(300_000);
    expect(clampCooldownMs(60_000, config)).toBe(60_000);
  });

  it('rounds fractional millisecond candidates to a whole number', () => {
    expect(clampCooldownMs(7000.4)).toBe(7000);
    expect(clampCooldownMs(7000.6)).toBe(7001);
  });
});

// ── calculateDelay: unchanged fallback (AC3) ──────────────────────────

describe('calculateDelay without a usable hint', () => {
  it('is unchanged from the original exponential backoff', () => {
    expect(calculateDelay(1)).toBe(2000);
    expect(calculateDelay(2)).toBe(4000);
    expect(calculateDelay(3)).toBe(8000);
    expect(calculateDelay(100)).toBe(600000); // 10-minute ceiling (WL-0MUY9GDPG0062NWF)
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

  it('exposes a bounded cooldownUntil from the no-hint default, distinct from delayMs', () => {
    const result = resolveRetryDelay(1, 'plain server error', DEFAULT_BACKOFF_CONFIG, () => 0, undefined, 1_000_000);
    // The retry-sleep delay is the (unchanged) exponential backoff...
    expect(result.delayMs).toBe(2000);
    // ...but the durable marker uses the bounded default.
    expect(result.cooldownUntil).toBe(1_000_000 + DEFAULT_RECOVERY_CONFIG.cooldown.defaultMs);
  });

  it('exposes a hint-derived cooldownUntil inside the clamp window', () => {
    const result = resolveRetryDelay(1, '503: {"retry_after": 11}', DEFAULT_BACKOFF_CONFIG, () => 0, undefined, 1_000_000);
    expect(result.delayMs).toBe(11_000);
    expect(result.cooldownUntil).toBe(1_011_000);
  });

  it('clamps an over-ceiling honest hint in cooldownUntil', () => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const result = resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, () => 0, oneDayMs, 1_000_000);
    expect(result.cooldownUntil).toBe(1_000_000 + DEFAULT_RECOVERY_CONFIG.cooldown.ceilingMs);
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
      maxDelayMs: 600000,
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
      maxDelayMs: 600000,
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

// ── Local-admission refusal (429) retry hint (WL-0MVSBF5XZ001H7V7) ──

/** The llm-proxy retryable local-admission refusal as it reaches the retry loop. */
const LOCAL_ADMISSION_REFUSAL_429 =
  '429: {"error": "Local admission refused", "code": "local_admission_reject", ' +
  '"reason": "eta_exceeds_budget", "eta_prefill_seconds": 11.2, "budget_seconds": 60.0, ' +
  '"projected_wait_seconds": 74.4, "retryable": true, "retry_after": 15, ' +
  '"retry_at": "2026-10-28T15:45:39Z"}';

describe('local-admission refusal retry hint', () => {
  it('parses the refusal retry_after body field', () => {
    expect(parseServerRetryDelayMs(LOCAL_ADMISSION_REFUSAL_429)).toBe(15000);
  });

  it('resolveRetryDelay honours the refusal hint as the retry delay', () => {
    const result = resolveRetryDelay(
      1,
      LOCAL_ADMISSION_REFUSAL_429,
      DEFAULT_BACKOFF_CONFIG,
      () => 0,
      undefined,
      1_000_000,
    );
    expect(result.serverHintMs).toBe(15000);
    expect(result.hintSource).toBe('message');
    expect(result.delayMs).toBe(15000);
  });

  it('a non-retryable refusal body is not mistaken for a wait hint', () => {
    // `retryable: false` carries no Retry-After on the wire; even if a stray
    // hint text were present the classifier keeps it terminal — here we pin
    // that the plain body yields no hint to sleep on.
    const budget =
      '429: {"error": "Local admission refused", "code": "local_admission_reject", ' +
      '"reason": "prefill_budget_exceeded", "retryable": false, ' +
      '"suggested_action": "compact the context and retry"}';
    expect(parseServerRetryDelayMs(budget)).toBeUndefined();
  });
});
