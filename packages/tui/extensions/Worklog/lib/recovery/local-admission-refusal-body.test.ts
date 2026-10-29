/**
 * Tests for classifying a local-admission refusal from the **captured
 * response body** rather than from the assistant message text
 * (WL-0MVTESPHB0021SI7).
 *
 * Why this file exists: `WL-0MVSBF5XZ001H7V7` taught the classifier to read the
 * refusal's polarity (`retryable` / `retry_after`) out of the assistant error
 * message. That is inert on the live wire shape, because the proxy's refusal
 * body carries those fields as **siblings of a string `error` field**:
 *
 *   {"error": "Local admission refused", "code": "local_admission_reject",
 *    "retryable": true, "retry_after": 62}
 *
 * `openai`'s `APIError.makeMessage()` prefers `error.message` and otherwise
 * `JSON.stringify(error)`, so the assistant message is exactly
 * `429 "Local admission refused"` — every machine-readable field is dropped.
 * Live evidence (2026-10-29) shows the turn was then abandoned with
 * `Error: Non-retryable error: 429 "Local admission refused"` after a single
 * request.
 *
 * The fix captures the refusal body in the existing `globalThis.fetch`
 * wrapper (`createRetryHintCapturingFetch()`) and lets the classifier consult
 * it when the message text carries no polarity signal.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/local-admission-refusal-body.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  classifyError,
  isRetryableLocalAdmissionRefusal,
  setCapturedLocalAdmissionRefusalBody,
  getCapturedLocalAdmissionRefusalBody,
  ErrorCategory,
} from './error-patterns.js';
import {
  createRetryHintCapturingFetch,
  resolveRetryDelay,
  DEFAULT_BACKOFF_CONFIG,
  MAX_CAPTURED_REFUSAL_BODY_BYTES,
} from './retry-logic.js';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * The assistant message a real pi client receives for a deferred
 * `local-preferred` request: the SDK-rendered status plus the string `error`
 * field, with every machine-readable field dropped.
 */
const SDK_RENDERED_REFUSAL = '429 "Local admission refused"';

function makeErrorMsg(errorMessage: string, stopReason = 'error'): any {
  return { role: 'assistant', stopReason, errorMessage };
}

/** The capacity-deferral refusal body observed on the wire (2026-10-29). */
const DEFERRABLE_REFUSAL_BODY = JSON.stringify({
  error: 'Local admission refused',
  code: 'local_admission_reject',
  reason: 'prefill_eta_exceeds_deadline',
  verdict: 'deferrable',
  eta_prefill_seconds: 40.6,
  budget_seconds: 60.0,
  retryable: true,
  retry_after: 62,
});

function makeResponse(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

/** A 429 carrying the real refusal body and its `Retry-After` header. */
function makeDeferralResponse(
  headers: Record<string, string> = { 'Retry-After': '62', 'X-Local-Route': 'refused' },
  body = DEFERRABLE_REFUSAL_BODY,
): Response {
  return makeResponse(429, body, { 'Content-Type': 'application/json', ...headers });
}

beforeEach(() => {
  // The captured body is module state; never let one test leak into another.
  setCapturedLocalAdmissionRefusalBody(undefined);
});

// ── AC1: classification from the wire ─────────────────────────────────

describe('AC1 — classification from the captured response body', () => {
  it('classifies the SDK-rendered message as SERVER_ERROR from the captured body', async () => {
    const capture = createRetryHintCapturingFetch(async () => makeDeferralResponse(), () => {});
    await capture('http://proxy.test/v1/chat/completions');

    // The message the client actually holds carries no polarity signal of its
    // own; the captured body supplies it, so the refusal is retried rather
    // than abandoned.
    expect(isRetryableLocalAdmissionRefusal(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(true);
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.SERVER_ERROR);
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).not.toBe(ErrorCategory.TERMINATED);
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).not.toBe(ErrorCategory.RATE_LIMIT);
  });

  it('schedules the retry no earlier than the advertised Retry-After delay', async () => {
    const onHint = vi.fn();
    const capture = createRetryHintCapturingFetch(async () => makeDeferralResponse(), onHint);
    await capture('http://proxy.test/v1/chat/completions');

    // The hint is the transport's (header or body) retry delay …
    expect(onHint).toHaveBeenCalledWith(62_000);

    // … and the retry loop must not fire sooner than the advertised wait.
    const scheduled = resolveRetryDelay(
      1,
      SDK_RENDERED_REFUSAL,
      DEFAULT_BACKOFF_CONFIG,
      () => 0.999,
      onHint.mock.calls[0][0],
    );
    expect(scheduled.serverHintMs).toBe(62_000);
    expect(scheduled.delayMs).toBeGreaterThanOrEqual(62_000);
  });

  it('derives the retry delay from a body-only retry_after (no Retry-After header)', async () => {
    const onHint = vi.fn();
    const capture = createRetryHintCapturingFetch(
      async () => makeDeferralResponse({}),
      onHint,
    );
    await capture('http://proxy.test/v1/chat/completions');

    expect(onHint).toHaveBeenCalledWith(62_000);
    const scheduled = resolveRetryDelay(
      1,
      SDK_RENDERED_REFUSAL,
      DEFAULT_BACKOFF_CONFIG,
      () => 0,
      onHint.mock.calls[0][0],
    );
    expect(scheduled.delayMs).toBe(62_000);
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.SERVER_ERROR);
  });

  it('classifies a retryable body with no retry_after as SERVER_ERROR', async () => {
    const body = JSON.stringify({
      error: 'Local admission refused',
      code: 'local_admission_reject',
      reason: 'eta_exceeds_budget',
      retryable: true,
    });
    const capture = createRetryHintCapturingFetch(
      async () => makeResponse(429, body, { 'Content-Type': 'application/json' }),
      () => {},
    );
    await capture('http://proxy.test/v1/chat/completions');

    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.SERVER_ERROR);
  });

  it('classifies from the captured body when the message is the bare prose form', async () => {
    const capture = createRetryHintCapturingFetch(async () => makeDeferralResponse(), () => {});
    await capture('http://proxy.test/v1/chat/completions');

    expect(classifyError(makeErrorMsg('429: Local admission refused'))).toBe(ErrorCategory.SERVER_ERROR);
    expect(classifyError(makeErrorMsg('local_admission_reject'))).toBe(ErrorCategory.SERVER_ERROR);
  });

  it('keeps the response body readable by the caller (capture never consumes it)', async () => {
    const response = makeDeferralResponse();
    const capture = createRetryHintCapturingFetch(async () => response, () => {});
    const returned = await capture('http://proxy.test/v1/chat/completions');

    expect(returned).toBe(response);
    await expect(returned.json()).resolves.toMatchObject({
      code: 'local_admission_reject',
      retryable: true,
    });
  });

  it('bounds the captured body and leaves the caller response intact', async () => {
    const hugeBody = JSON.stringify({ error: 'Local admission refused', retryable: true, padding: 'x'.repeat(50_000) });
    const response = makeResponse(429, hugeBody, { 'Content-Type': 'application/json' });
    const capture = createRetryHintCapturingFetch(async () => response, () => {});
    const returned = await capture('http://proxy.test/v1/chat/completions');

    const captured = getCapturedLocalAdmissionRefusalBody();
    expect(captured).toBeDefined();
    expect(captured!.length).toBeLessThanOrEqual(MAX_CAPTURED_REFUSAL_BODY_BYTES);
    // The oversized body was truncated, not buffered in full …
    expect(captured!.length).toBeLessThan(hugeBody.length);
    // … and the response the caller reads is still complete.
    await expect(returned.text()).resolves.toBe(hugeBody);
  });
});

// ── AC2: non-retryable refusals stay terminal ─────────────────────────

describe('AC2 — non-retryable refusals stay terminal', () => {
  const NON_RETRYABLE_REASONS = [
    'prefill_budget_exceeded',
    'context_too_large',
    'resident_prefix_insufficient',
  ];

  for (const reason of NON_RETRYABLE_REASONS) {
    it(`keeps "${reason}" terminal (retryable: false)`, async () => {
      const body = JSON.stringify({
        error: 'Local admission refused',
        code: 'local_admission_reject',
        reason,
        verdict: 'rejected',
        retryable: false,
        suggested_action: 'compact the context and retry',
      });
      const capture = createRetryHintCapturingFetch(
        async () => makeResponse(429, body, { 'Content-Type': 'application/json' }),
        () => {},
      );
      await capture('http://proxy.test/v1/chat/completions');

      expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.TERMINATED);
      expect(isRetryableLocalAdmissionRefusal(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(false);
    });
  }

  it('keeps a bare refusal terminal when no body was captured', () => {
    // No captured body at all (e.g. a refusal surfaced outside the wrapped
    // transport): the pre-existing behaviour — terminal — must hold.
    expect(getCapturedLocalAdmissionRefusalBody()).toBeUndefined();
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.TERMINATED);
  });

  it('keeps a plain 429 rate limit terminal even with a refusal body captured', async () => {
    const capture = createRetryHintCapturingFetch(async () => makeDeferralResponse(), () => {});
    await capture('http://proxy.test/v1/chat/completions');

    // The captured body only supplies polarity for a message that is itself a
    // refusal; an unrelated error must not be upgraded.
    expect(classifyError(makeErrorMsg('429 Too Many Requests'))).toBe(ErrorCategory.RATE_LIMIT);
    expect(classifyError(makeErrorMsg('Rate limit exceeded'))).toBe(ErrorCategory.RATE_LIMIT);
  });

  it('leaves auth, quota and terminated classification unchanged', async () => {
    const capture = createRetryHintCapturingFetch(async () => makeDeferralResponse(), () => {});
    await capture('http://proxy.test/v1/chat/completions');

    expect(classifyError(makeErrorMsg('401 Unauthorized'))).toBe(ErrorCategory.AUTH_ERROR);
    expect(classifyError(makeErrorMsg('403 Forbidden'))).toBe(ErrorCategory.AUTH_ERROR);
    expect(classifyError(makeErrorMsg('402 Payment Required'))).toBe(ErrorCategory.QUOTA_EXHAUSTED);
    expect(classifyError(makeErrorMsg('terminated by provider'))).toBe(ErrorCategory.TERMINATED);
  });

  it('lets an explicit retryable:false in the message win over a captured retryable body', async () => {
    const capture = createRetryHintCapturingFetch(async () => makeDeferralResponse(), () => {});
    await capture('http://proxy.test/v1/chat/completions');

    // A message that carries its own authoritative polarity is never
    // overridden by the transport capture.
    const contradiction =
      '429: {"code": "local_admission_reject", "retryable": false, "retry_after": 15}';
    expect(classifyError(makeErrorMsg(contradiction))).toBe(ErrorCategory.TERMINATED);
  });
});

// ── AC3: no stale-signal leakage ──────────────────────────────────────

describe('AC3 — the captured body is scoped to the failing response', () => {
  it('clears the captured body on a 2xx', async () => {
    const onHint = vi.fn();
    const capture = createRetryHintCapturingFetch(async () => makeDeferralResponse(), onHint);
    await capture('http://proxy.test/v1/chat/completions');
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.SERVER_ERROR);

    const succeeding = createRetryHintCapturingFetch(async () => makeResponse(200, '{}'), onHint);
    await succeeding('http://proxy.test/v1/chat/completions');

    expect(getCapturedLocalAdmissionRefusalBody()).toBeUndefined();
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.TERMINATED);
  });

  it('clears the captured body on a non-2xx that cannot be a refusal', async () => {
    const capture = createRetryHintCapturingFetch(async () => makeDeferralResponse(), () => {});
    await capture('http://proxy.test/v1/chat/completions');
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.SERVER_ERROR);

    const badRequest = createRetryHintCapturingFetch(
      async () => makeResponse(400, '{"error":"bad request"}'),
      () => {},
    );
    await badRequest('http://proxy.test/v1/chat/completions');

    expect(getCapturedLocalAdmissionRefusalBody()).toBeUndefined();
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.TERMINATED);
  });

  it('replaces a retryable refusal with a later non-retryable refusal', async () => {
    const first = createRetryHintCapturingFetch(async () => makeDeferralResponse(), () => {});
    await first('http://proxy.test/v1/chat/completions');
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.SERVER_ERROR);

    const nonRetryableBody = JSON.stringify({
      error: 'Local admission refused',
      code: 'local_admission_reject',
      reason: 'prefill_budget_exceeded',
      retryable: false,
    });
    const second = createRetryHintCapturingFetch(
      async () => makeResponse(429, nonRetryableBody, { 'Content-Type': 'application/json' }),
      () => {},
    );
    await second('http://proxy.test/v1/chat/completions');

    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.TERMINATED);
  });

  it('does not let a refusal body survive an unreadable/empty later response', async () => {
    const capture = createRetryHintCapturingFetch(async () => makeDeferralResponse(), () => {});
    await capture('http://proxy.test/v1/chat/completions');

    // A plain 429 rate-limit response with no body replaces the capture.
    const rateLimited = createRetryHintCapturingFetch(
      async () => makeResponse(429, ''),
      () => {},
    );
    await rateLimited('http://proxy.test/v1/chat/completions');

    expect(getCapturedLocalAdmissionRefusalBody()).toBeUndefined();
    expect(classifyError(makeErrorMsg(SDK_RENDERED_REFUSAL))).toBe(ErrorCategory.TERMINATED);
  });

  it('does not capture a body from a streamed 2xx response', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200 });
    const capture = createRetryHintCapturingFetch(async () => response, () => {});
    const returned = await capture('http://proxy.test/v1/chat/completions');

    expect(getCapturedLocalAdmissionRefusalBody()).toBeUndefined();
    await expect(returned.text()).resolves.toContain('"hi"');
  });
});
