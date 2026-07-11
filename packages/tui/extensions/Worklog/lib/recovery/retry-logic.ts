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
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  multiplier: 2,
};

/**
 * Calculate delay for a given attempt number using exponential backoff.
 *
 * delay = baseDelayMs * multiplier^(attempt-1)
 * result is capped at maxDelayMs.
 *
 * @param attempt - The attempt number (1-based)
 * @param config - Backoff configuration (defaults if not provided)
 * @returns Delay in milliseconds
 */
export function calculateDelay(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
): number {
  // Guard against non-positive attempt numbers; treat attempt 1 as minimum
  const safeAttempt = Math.max(attempt, 1);
  const delay = config.baseDelayMs * Math.pow(config.multiplier, safeAttempt - 1);
  return Math.min(delay, config.maxDelayMs);
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
