/**
 * Tests for server-requested retry delays carried on HTTP response headers.
 *
 * Why this file exists (WL-0MU9Z7L8X00117BI RCA): the original fix parsed the
 * retry hint out of the assistant error *message*. Real llm-proxy startup-ramp
 * errors do NOT carry `retry_after` in that message — the observed shape is
 *
 *   503: {"type":"startup_ramp","code":"startup_ramp","message":"Server is starting up; retry shortly."}
 *
 * — and the machine-readable hint is only on the `Retry-After` response header.
 * Pi's `openai-completions` provider throws before the
 * `after_provider_response` extension event fires, so the header never reaches
 * the extension through events. The recovery module therefore captures the
 * header from a transparent `globalThis.fetch` wrapper and feeds it into the
 * retry loop.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/retry-after-header.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import {
  calculateDelay,
  resolveRetryDelay,
  parseServerRetryDelayMs,
  parseRetryAfterHeaders,
  createRetryHintCapturingFetch,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
} from './retry-logic.js';

// The exact error message shape observed in production logs (no retry_after).
const REAL_RAMP_503 =
  '503: {"type":"startup_ramp","code":"startup_ramp","message":"Server is starting up; retry shortly."}';

// ── parseRetryAfterHeaders: Headers object ────────────────────────────

describe('parseRetryAfterHeaders (Headers object)', () => {
  it('parses a delta-seconds Retry-After header', () => {
    const headers = new Headers({ 'Retry-After': '7' });
    expect(parseRetryAfterHeaders(headers)).toBe(7000);
  });

  it('prefers Retry-After-Ms over Retry-After', () => {
    const headers = new Headers({ 'Retry-After-Ms': '5000', 'Retry-After': '9' });
    expect(parseRetryAfterHeaders(headers)).toBe(5000);
  });

  it('parses a fractional delta-seconds header', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'Retry-After': '2.5' }))).toBe(2500);
  });

  it('parses a future HTTP-date header', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfterHeaders(new Headers({ 'Retry-After': future }));
    expect(parsed).toBeDefined();
    expect(parsed!).toBeGreaterThan(5000);
    expect(parsed!).toBeLessThanOrEqual(10_000);
  });

  it('returns 0 (retry now) for a past HTTP-date header', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfterHeaders(new Headers({ 'Retry-After': past }))).toBe(0);
  });

  it('returns undefined when the headers carry no hint', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'Content-Type': 'application/json' }))).toBeUndefined();
  });

  it('returns undefined for malformed values', () => {
    expect(parseRetryAfterHeaders(new Headers({ 'Retry-After': 'soon' }))).toBeUndefined();
  });
});

// ── parseRetryAfterHeaders: plain record ──────────────────────────────

describe('parseRetryAfterHeaders (plain record)', () => {
  it('matches header names case-insensitively', () => {
    expect(parseRetryAfterHeaders({ 'RETRY-AFTER': '12' })).toBe(12000);
    expect(parseRetryAfterHeaders({ 'rEtRy-AfTeR': '3' })).toBe(3000);
  });

  it('is tolerant of absent / null input', () => {
    expect(parseRetryAfterHeaders(undefined)).toBeUndefined();
    expect(parseRetryAfterHeaders(null)).toBeUndefined();
    expect(parseRetryAfterHeaders({})).toBeUndefined();
  });

  it('returns undefined for negative values', () => {
    expect(parseRetryAfterHeaders({ 'retry-after': '-3' })).toBeUndefined();
  });
});

// ── resolveRetryDelay: header hint takes precedence ───────────────────

describe('resolveRetryDelay with a header hint', () => {
  const noJitter = () => 0;

  it('honours a header hint that exceeds the exponential backoff', () => {
    const result = resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, noJitter, 7000);
    expect(result.serverHintMs).toBe(7000);
    expect(result.hintSource).toBe('header');
    expect(result.delayMs).toBe(7000);
  });

  it('prefers the header hint over a message hint', () => {
    const result = resolveRetryDelay(1, '503: {"retry_after": 3}', DEFAULT_BACKOFF_CONFIG, noJitter, 9000);
    expect(result.hintSource).toBe('header');
    expect(result.delayMs).toBe(9000);
  });

  it('falls back to the message hint when no header hint is present', () => {
    const result = resolveRetryDelay(1, '503: {"retry_after": 3}', DEFAULT_BACKOFF_CONFIG, noJitter, undefined);
    expect(result.hintSource).toBe('message');
    expect(result.delayMs).toBe(3000);
  });

  it('caps a large header hint at the configured maximum', () => {
    const result = resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, noJitter, 90_000);
    expect(result.delayMs).toBe(60_000);
  });

  it('treats a negative/NaN header hint as absent', () => {
    expect(resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, noJitter, -1).hintSource).toBeUndefined();
    expect(resolveRetryDelay(1, undefined, DEFAULT_BACKOFF_CONFIG, noJitter, Number.NaN).hintSource).toBeUndefined();
  });

  it('applies upward-only jitter to a header-derived delay', () => {
    const config: BackoffConfig = { baseDelayMs: 2000, maxDelayMs: 60000, multiplier: 2, serverHintJitterRatio: 0.25 };
    expect(calculateDelay(1, config, 8000, () => 0.5)).toBe(9000);
    expect(calculateDelay(1, config, 8000, () => 0.5)).toBeGreaterThanOrEqual(8000);
  });
});

// ── createRetryHintCapturingFetch ─────────────────────────────────────

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response('body', { status, headers });
}

describe('createRetryHintCapturingFetch', () => {
  it('captures the hint from a 503 response', async () => {
    const onHint = vi.fn();
    const capture = createRetryHintCapturingFetch(
      async () => makeResponse(503, { 'Retry-After': '11' }),
      onHint,
    );
    await capture('http://example.test');
    expect(onHint).toHaveBeenCalledWith(11_000);
  });

  it('captures the hint from a 429 response', async () => {
    const onHint = vi.fn();
    const capture = createRetryHintCapturingFetch(
      async () => makeResponse(429, { 'Retry-After-Ms': '2500' }),
      onHint,
    );
    await capture('http://example.test');
    expect(onHint).toHaveBeenCalledWith(2500);
  });

  it('clears the hint on a successful response', async () => {
    const onHint = vi.fn();
    const capture = createRetryHintCapturingFetch(async () => makeResponse(200), onHint);
    await capture('http://example.test');
    expect(onHint).toHaveBeenCalledWith(undefined);
  });

  it('reports undefined for a retryable response without a hint', async () => {
    const onHint = vi.fn();
    const capture = createRetryHintCapturingFetch(async () => makeResponse(502), onHint);
    await capture('http://example.test');
    expect(onHint).toHaveBeenCalledWith(undefined);
  });

  it('returns the original response untouched', async () => {
    const response = makeResponse(503, { 'Retry-After': '5' });
    const capture = createRetryHintCapturingFetch(async () => response, () => {});
    await expect(capture('http://example.test')).resolves.toBe(response);
  });

  it('propagates fetch rejections (network errors) without capturing', async () => {
    const onHint = vi.fn();
    const capture = createRetryHintCapturingFetch(async () => {
      throw new Error('network down');
    }, onHint);
    await expect(capture('http://example.test')).rejects.toThrow('network down');
    expect(onHint).not.toHaveBeenCalled();
  });

  it('does not clear the hint on a non-2xx, non-retryable response', async () => {
    const onHint = vi.fn();
    const capture = createRetryHintCapturingFetch(async () => makeResponse(400), onHint);
    await capture('http://example.test');
    expect(onHint).not.toHaveBeenCalled();
  });
});

// ── RCA regression: the real error shape + header hint ────────────────

describe('startup_ramp RCA regression', () => {
  it('the real error message carries no parseable hint', () => {
    expect(parseServerRetryDelayMs(REAL_RAMP_503)).toBeUndefined();
  });

  it('honours the Retry-After header that the message dropped', () => {
    const headerHint = parseRetryAfterHeaders(new Headers({ 'Retry-After': '12' }));
    const result = resolveRetryDelay(1, REAL_RAMP_503, DEFAULT_BACKOFF_CONFIG, () => 0, headerHint);
    expect(headerHint).toBe(12_000);
    expect(result.hintSource).toBe('header');
    expect(result.delayMs).toBe(12_000);
  });

  it('does not retry sooner than the hint across a full startup ramp', () => {
    const config: BackoffConfig = { baseDelayMs: 2000, maxDelayMs: 60000, multiplier: 2, serverHintJitterRatio: 0.25 };
    let elapsed = 0;
    let attempt = 0;
    while (elapsed < 180_000 && attempt < 100) {
      attempt++;
      // Proxy degrades hints across the ramp, 5s .. 18s.
      const headerHint = parseRetryAfterHeaders(new Headers({ 'Retry-After': String(5 + (attempt % 14)) }));
      const { delayMs } = resolveRetryDelay(attempt, REAL_RAMP_503, config, () => 0, headerHint);
      expect(delayMs).toBeGreaterThanOrEqual(headerHint!);
      elapsed += delayMs;
    }
    expect(elapsed).toBeGreaterThanOrEqual(180_000);
    expect(attempt).toBeLessThan(100);
  });
});
