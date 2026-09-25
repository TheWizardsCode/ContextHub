/**
 * Retry logic utilities for the recovery module.
 *
 * Ported from pi-retry/src/retry-logic.ts with enhanced per-category
 * state tracking for the 7 error categories.
 *
 * Provides:
 * - Exponential backoff calculation with configurable base/max/multiplier
 * - Duration formatting for display
 * - RetryState and ContinuationState managers
 * - Interruptible sleep for abort/session-switch detection
 * - Helper to find last assistant message in session entries
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

// ── Backoff configuration ─────────────────────────────────────────────

export interface BackoffConfig {
  /** Base delay in milliseconds for the first retry */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds */
  maxDelayMs: number;
  /** Multiplier applied to delay on each subsequent attempt */
  multiplier: number;
  /**
   * Upward-only jitter ratio applied to delays derived from a
   * server-requested retry delay (`Retry-After` / `retry_after`).
   * Defaults to {@link DEFAULT_SERVER_HINT_JITTER_RATIO}. Set to 0 to
   * disable jitter.
   */
  serverHintJitterRatio?: number;
}

/**
 * Default upward jitter ratio for server-hint-derived delays. Concurrent
 * clients that were told the same `Retry-After` desynchronise instead of
 * retrying in lockstep.
 */
export const DEFAULT_SERVER_HINT_JITTER_RATIO = 0.25;

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  multiplier: 2,
  serverHintJitterRatio: DEFAULT_SERVER_HINT_JITTER_RATIO,
};

/**
 * Parse a server-requested retry delay from an error message.
 *
 * The llm-proxy startup-ramp gate returns HTTP 503 with a `Retry-After`
 * header and a machine-readable body containing `retry_after` (seconds):
 * `{"error":{"type":"startup_ramp",...},"status":503,"retry_after":N}`.
 * Whatever pi folds into the assistant error message is parsed here.
 *
 * Supported forms (in precedence order):
 * - `retry-after-ms` / `retry_after_ms`: milliseconds
 * - `retry-after` / `retry_after`: delta-seconds (fractional allowed)
 * - `retry-after` / `retry_after`: HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT")
 *
 * Escaped JSON (`\"retry_after\": 9`) is handled because some SDKs fold the
 * raw body into `error.message`.
 *
 * @param errorMessage - The assistant error message (may be undefined/null)
 * @returns Delay in milliseconds, or `undefined` when absent or malformed
 */
export function parseServerRetryDelayMs(errorMessage: string | undefined | null): number | undefined {
  if (typeof errorMessage !== 'string' || errorMessage.length === 0) return undefined;

  const keyword = '(?:^|[^\\w-])retry["\\\\]*[-_]?after';

  // 1. Milliseconds form (checked first so `retry-after-ms` is not read as
  //    delta-seconds).
  const msMatch = errorMessage.match(
    new RegExp(`${keyword}["\\\\]*[-_]?ms["\\\\]*\\s*[:=]\\s*["\\\\]*(\\d+(?:\\.\\d+)?)`, 'i'),
  );
  if (msMatch) {
    return normaliseDelayMs(Number.parseFloat(msMatch[1]), 1);
  }

  // 2. Delta-seconds form (includes the `retry_after` JSON body field).
  const secondsMatch = errorMessage.match(
    new RegExp(`${keyword}["\\\\]*\\s*[:=]\\s*["\\\\]*(\\d+(?:\\.\\d+)?)`, 'i'),
  );
  if (secondsMatch) {
    return normaliseDelayMs(Number.parseFloat(secondsMatch[1]), 1000);
  }

  // 3. HTTP-date form.
  const dateMatch = errorMessage.match(
    new RegExp(
      `${keyword}["\\\\]*\\s*[:=]\\s*["\\\\]*([A-Za-z]{3},\\s*\\d{1,2}\\s+[A-Za-z]{3}\\s+\\d{4}\\s+\\d{2}:\\d{2}:\\d{2}\\s+GMT)`,
      'i',
    ),
  );
  if (dateMatch) {
    const target = Date.parse(dateMatch[1]);
    if (!Number.isNaN(target)) {
      // A past date means "retry now" (0ms) rather than an invalid hint.
      return Math.max(0, Math.round(target - Date.now()));
    }
  }

  return undefined;
}

/** Convert a parsed value to a non-negative integer millisecond delay. */
function normaliseDelayMs(value: number, factor: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const ms = value * factor;
  if (ms < 0) return undefined;
  return Math.round(ms);
}

/**
 * Parse a server-requested retry delay from HTTP response headers.
 *
 * The llm-proxy startup-ramp gate sets a `Retry-After` header (delta-seconds
 * or HTTP-date) on its 503 response. Pi's `openai-completions` provider throws
 * before the `after_provider_response` extension event fires and formats the
 * assistant error message without the header value, so the recovery retry
 * loop captures the header from a `fetch` wrapper and parses it here.
 *
 * Supports both a real `Headers` object (case-insensitive by construction) and
 * a plain string record. `retry-after-ms` wins over `retry-after`, matching the
 * provider-level retry helper's precedence.
 *
 * @param headers - Response headers (`Headers` or a plain record)
 * @returns Delay in milliseconds, or `undefined` when absent or malformed
 */
export function parseRetryAfterHeaders(
  headers: Headers | Record<string, string | string[] | undefined> | undefined | null,
): number | undefined {
  if (!headers) return undefined;

  const get = (name: string): string | undefined => {
    const maybeHeaders = headers as Headers;
    if (typeof maybeHeaders.get === 'function') {
      const value = maybeHeaders.get(name);
      return value === null ? undefined : value;
    }
    const record = headers as Record<string, string | string[] | undefined>;
    const direct = record[name];
    if (typeof direct === 'string') return direct;
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() === name && typeof value === 'string') return value;
    }
    return undefined;
  };

  // 1. Milliseconds form (checked first so `retry-after-ms` is not read as
  //    delta-seconds).
  const msHeader = get('retry-after-ms');
  if (msHeader !== undefined) {
    const value = Number.parseFloat(msHeader);
    if (Number.isFinite(value)) return normaliseDelayMs(value, 1);
  }

  // 2. Delta-seconds form, then HTTP-date form.
  const retryAfter = get('retry-after');
  if (retryAfter !== undefined) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return normaliseDelayMs(seconds, 1000);
    const target = Date.parse(retryAfter);
    if (!Number.isNaN(target)) {
      // A past date means "retry now" (0ms) rather than an invalid hint.
      return Math.max(0, Math.round(target - Date.now()));
    }
  }

  return undefined;
}

/**
 * Wrap a `fetch` implementation so retryable provider responses report the
 * server-requested retry delay (`Retry-After` / `Retry-After-Ms` on 429/5xx)
 * to `onHint`. Successful (2xx) responses report `undefined` so a stale hint
 * is not reused. The response is returned untouched and fetch rejections
 * propagate unchanged.
 *
 * This is the transport-level source of the retry hint for providers that
 * throw before an extension event can observe the response headers.
 *
 * @param originalFetch - The fetch implementation to delegate to
 * @param onHint - Called with the parsed delay in ms (or undefined to clear)
 * @returns A drop-in fetch wrapper
 */
export function createRetryHintCapturingFetch(
  originalFetch: typeof fetch,
  onHint: (hintMs: number | undefined) => void,
): typeof fetch {
  const capturingFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await originalFetch(input, init);
    if (response && typeof response.status === 'number') {
      if (response.status === 429 || response.status >= 500) {
        onHint(parseRetryAfterHeaders(response.headers));
      } else if (response.status >= 200 && response.status < 300) {
        onHint(undefined);
      }
    }
    return response;
  };
  return capturingFetch as typeof fetch;
}

/**
 * Calculate delay for a given attempt number.
 *
 * Without a server hint: `delay = baseDelayMs * multiplier^(attempt-1)`,
 * capped at `maxDelayMs` (existing exponential backoff, unchanged).
 *
 * With a usable server hint (from `Retry-After` / `retry_after`): the delay
 * tracks the server-requested delay (plus upward-only jitter, capped at
 * `maxDelayMs`). The local exponential backoff is **not** combined into this
 * value — a growing local backoff must not silently override the server's
 * recommendation.
 *
 * @remarks
 * The server hint is authoritative when present. An earlier revision used
 * `max(exponential, serverHintMs)`, which let the local exponential override
 * the hint once it outgrew it (e.g. `Retry-After: 7` -> retry at 32s/60s).
 * That is the behaviour the producer rejected as "the local retry mechanism
 * overriding the recommended wait duration".
 *
 * @param attempt - The attempt number (1-based)
 * @param config - Backoff configuration (defaults if not provided)
 * @param serverHintMs - Server-requested delay in ms (see
 *   {@link parseServerRetryDelayMs}); absent/malformed values fall back to the
 *   plain exponential backoff
 * @param random - Random source in [0, 1) used for jitter (injectable for tests)
 * @returns Delay in milliseconds
 */
export function calculateDelay(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  serverHintMs?: number,
  random: () => number = Math.random,
): number {
  // Guard against non-positive attempt numbers; treat attempt 1 as minimum
  const safeAttempt = Math.max(attempt, 1);
  const raw = config.baseDelayMs * Math.pow(config.multiplier, safeAttempt - 1);
  const safeRaw = Number.isSafeInteger(raw) ? raw : Number.MAX_SAFE_INTEGER;
  const exponential = Math.min(safeRaw, config.maxDelayMs);

  // Missing/malformed hint: the existing exponential backoff, unchanged.
  if (serverHintMs === undefined || !Number.isFinite(serverHintMs) || serverHintMs < 0) {
    return exponential;
  }

  // A usable server hint is authoritative: the delay tracks the hint, not the
  // local exponential. Upward-only jitter keeps the delay at or above the
  // requested wait, and the configurable maximum still bounds it.
  const jitterRatio = Math.max(0, config.serverHintJitterRatio ?? DEFAULT_SERVER_HINT_JITTER_RATIO);
  const jittered = serverHintMs * (1 + jitterRatio * random());
  return Math.min(Math.round(jittered), config.maxDelayMs);
}

/**
 * Resolve the retry delay for an attempt from its error message, returning
 * both the delay and the server hint that produced it (if any).
 *
 * This is the single decision point used by the recovery retry loop: it
 * parses a server-requested retry delay from the error text and feeds it to
 * {@link calculateDelay}.
 *
 * @param attempt - The attempt number (1-based)
 * @param errorMessage - The assistant error message
 * @param config - Backoff configuration (defaults if not provided)
 * @param random - Random source in [0, 1) used for jitter (injectable for tests)
 * @param headerHintMs - Retry delay parsed from the response `Retry-After`
 *   header (see {@link parseRetryAfterHeaders}); takes precedence over the
 *   error-message hint
 * @returns The delay in milliseconds, the parsed server hint (if any), and
 *   which source produced it
 */
export function resolveRetryDelay(
  attempt: number,
  errorMessage: string | undefined | null,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  random: () => number = Math.random,
  headerHintMs?: number,
): { delayMs: number; serverHintMs?: number; hintSource?: 'header' | 'message' } {
  const headerHint =
    typeof headerHintMs === 'number' && Number.isFinite(headerHintMs) && headerHintMs >= 0
      ? headerHintMs
      : undefined;
  const messageHint = parseServerRetryDelayMs(errorMessage);
  const serverHintMs = headerHint ?? messageHint;
  const hintSource = headerHint !== undefined ? 'header' : messageHint !== undefined ? 'message' : undefined;
  const delayMs = calculateDelay(attempt, config, serverHintMs, random);

  const result: { delayMs: number; serverHintMs?: number; hintSource?: 'header' | 'message' } = { delayMs };
  if (serverHintMs !== undefined) result.serverHintMs = serverHintMs;
  if (hintSource !== undefined) result.hintSource = hintSource;
  return result;
}

/**
 * Compute the retry delay for an attempt from its error message.
 *
 * Convenience wrapper around {@link resolveRetryDelay} for callers that only
 * need the numeric delay.
 *
 * @param attempt - The attempt number (1-based)
 * @param errorMessage - The assistant error message
 * @param config - Backoff configuration (defaults if not provided)
 * @param random - Random source in [0, 1) used for jitter (injectable for tests)
 * @returns Delay in milliseconds
 */
export function computeRetryDelay(
  attempt: number,
  errorMessage: string | undefined | null,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  random: () => number = Math.random,
): number {
  return resolveRetryDelay(attempt, errorMessage, config, random).delayMs;
}

/**
 * Format a duration in milliseconds for display.
 *
 * Returns a human-readable string like "2.0s", "1m 30s", or "500ms".
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

/**
 * Get the last assistant message from an array of session entries.
 *
 * Scans backwards through the entries array to find the most recent
 * message with role "assistant".
 *
 * @param entries - Array of session entries (e.g., from sessionManager.getEntries())
 * @returns The last AssistantMessage, or undefined if none found
 */
export function getLastAssistantMessage(entries: unknown[]): AgentMessage | undefined {
  if (!entries || !Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; message?: AgentMessage };
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      return entry.message;
    }
  }
  return undefined;
}

// ── Retry state managers ──────────────────────────────────────────────

/**
 * Tracks retry state for a single error category.
 *
 * Records attempt count, retry-in-progress flag, and last error message.
 * Compatible with the per-category pattern from the error classification
 * module (7 categories: rateLimit, serverError, authError, contextLength,
 * quotaExhausted, timeout, terminated).
 */
export class RetryState {
  private attempt = 0;
  private isRetrying = false;
  private lastErrorMessage = '';

  getAttempt(): number {
    return this.attempt;
  }

  getIsRetrying(): boolean {
    return this.isRetrying;
  }

  getLastErrorMessage(): string {
    return this.lastErrorMessage;
  }

  startRetry(errorMessage: string): void {
    this.isRetrying = true;
    this.attempt++;
    this.lastErrorMessage = errorMessage;
  }

  endRetry(): void {
    this.isRetrying = false;
  }

  reset(): void {
    this.attempt = 0;
    this.isRetrying = false;
    this.lastErrorMessage = '';
  }

  succeed(): void {
    this.attempt = 0;
    this.isRetrying = false;
    this.lastErrorMessage = '';
  }
}

/**
 * Tracks continuation state for context-length exceeded handling.
 *
 * Unlike RetryState, continuations are also uncapped — each one produces
 * valid output and the model naturally terminates when done.
 */
export class ContinuationState {
  private count = 0;
  private isContinuing = false;

  getCount(): number {
    return this.count;
  }

  getIsContinuing(): boolean {
    return this.isContinuing;
  }

  startContinuation(): void {
    this.isContinuing = true;
    this.count++;
  }

  endContinuation(): void {
    this.isContinuing = false;
  }

  /**
   * Called when a turn completes without hitting max_tokens.
   * Resets the counter since the model finished normally.
   */
  complete(): void {
    this.count = 0;
    this.isContinuing = false;
  }

  reset(): void {
    this.count = 0;
    this.isContinuing = false;
  }
}

// ── Interruptible sleep ──────────────────────────────────────────────

export interface InterruptibleSleepState {
  /** Set to true to signal abort */
  userAborted: boolean;
  /** Session generation counter; changes signal session switch */
  sessionGeneration: number;
}

/**
 * Sleep for a given duration while polling abort and session-change flags.
 *
 * Checks every 100ms whether the user has aborted or the session has
 * changed. Returns true if interrupted, false if the full delay elapsed.
 *
 * @param ms - Duration to sleep in milliseconds
 * @param state - Reference to shared abort/session-generation state
 * @param generation - The session generation captured when the retry started
 * @returns Promise<boolean> - true if interrupted (abort or session change)
 */
export function interruptibleSleep(
  ms: number,
  state: InterruptibleSleepState,
  generation: number,
): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const checkInterval = 100;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      if (state.userAborted || state.sessionGeneration !== generation) {
        clearInterval(timer);
        resolve(true);
      } else if (elapsed >= ms) {
        clearInterval(timer);
        resolve(false);
      }
    }, checkInterval);
  });
}

/**
 * Remove the error assistant message from the agent's live transcript.
 *
 * The error message stays in the session journal for history but is
 * removed from the agent's current state so the LLM receives a clean
 * context on retry.
 *
 * @param messages - The agent's current message array (mutated in-place via slice)
 * @returns A new message array with the last error message removed (if applicable)
 */
export function removeErrorFromMessages(
  messages: Array<{ role: string; stopReason?: string }>,
): Array<{ role: string; stopReason?: string }> {
  if (messages.length === 0) return messages;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'assistant' && lastMsg.stopReason === 'error') {
    return messages.slice(0, -1);
  }
  return messages;
}
