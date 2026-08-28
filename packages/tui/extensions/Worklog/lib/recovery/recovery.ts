/**
 * Recovery handler for the compact-and-continue flow.
 *
 * When the model hits max output tokens (stopReason "length"), this module
 * triggers /compact to reduce context, then auto-continues via
 * agent.prompt([]) — an invisible retry that does not add user-visible
 * messages to the conversation.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { ContinuationState, RetryState } from './retry-logic.js';
import { DEFAULT_RECOVERY_CONFIG, type RecoveryConfig } from './error-patterns.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Default continuation prompt text sent to the LLM after /compact. */
export const DEFAULT_CONTINUATION_PROMPT = 'Please continue from where you left off.';

/**
 * Maximum gate → compact → retry cycles before falling back to explicit
 * guidance. Prevents an infinite loop when compaction does not reduce
 * context enough to clear the proxy's hard cap (WL-0MTBOXEGR009KDP6).
 */
export const MAX_COMPACTION_GATE_RETRIES = 2;

/**
 * Explicit guidance shown when a gated session cannot be compacted further
 * (compact itself fails, or the retry limit is reached). Never silently
 * drops the request (AC4).
 */
export const COMPACTION_GATE_FALLBACK_MESSAGE =
  'Context cannot be compacted further — please start a new session to continue.';

// ── Detection ─────────────────────────────────────────────────────────

/**
 * Check if an assistant message indicates context-length exceeded.
 *
 * Matches when:
 * - stopReason is "length" (model hit max output tokens)
 * - stopReason is "error" and the error message matches context-length patterns
 *
 * @param message - The assistant message to check
 * @returns true if context-length exceeded
 */
export function hasContextLengthStop(message: AgentMessage | unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  if (m.role !== 'assistant') return false;

  // stopReason "length" is always a context-length event
  if (m.stopReason === 'length') return true;

  // Also check error message patterns for providers that report differently
  if (m.stopReason === 'error' && typeof m.errorMessage === 'string') {
    const patterns = DEFAULT_RECOVERY_CONFIG.contextLength.patterns;
    return patterns.some((p) => p.test(m.errorMessage!));
  }

  return false;
}

/**
 * Check if an assistant message signals the proxy's compaction gate.
 *
 * The llm-proxy cheap-mode hard local-routing cap returns an informative
 * 4xx (wire contract: HTTP 413 + `X-Compaction-Gate: true` header per
 * WL-0MTBOXEGR009KDP6, finalized with LP-0MTBOX45O005LD1S). The gate is a
 * proxy-level signal and is **distinct** from the model-level
 * `stopReason === "length"` context-length event (AC1) — a gate-hit session
 * compacts and retries; a context-length turn continues normally.
 *
 * Matches when:
 * - The message is an assistant error message whose text contains the
 *   compaction-gate patterns (gate keyword, HTTP 413, payload-too-large,
 *   context-over-cap text).
 *
 * @param message - The assistant message to check
 * @returns true if the message is a compaction-gate response
 */
export function isCompactionGateResponse(message: AgentMessage | unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  if (m.role !== 'assistant') return false;
  if (typeof m.errorMessage !== 'string' || m.errorMessage.length === 0) return false;
  return DEFAULT_RECOVERY_CONFIG.compactionGate.patterns.some((p) => p.test(m.errorMessage!));
}

// ── Compaction auto-continue (session_compact) ─────────────────────────

/**
 * Decide whether a `session_compact` event should trigger an automatic
 * continuation (mid-session compaction) or leave the agent stopped
 * (end-of-session compaction).
 *
 * Pi natively auto-continues ONLY overflow recovery (`willRetry: true`);
 * threshold compaction deliberately stops ("user continues manually"). This
 * classification fills that gap without racing Pi's own flows:
 *
 * - `willRetry: true` (overflow) — Pi retries the aborted turn itself after
 *   compaction; continuing again would double-continue → never auto-continue.
 * - `hasPendingMessages` — queued work was in flight when compaction ran
 *   (e.g. pre-prompt threshold compaction) → mid-session.
 * - Last assistant `stopReason` is `length` or `error` — an interrupted
 *   turn (e.g. max output tokens) preceded the compaction → mid-session.
 * - `!isIdle` — the agent was still streaming when compaction started
 *   → mid-session.
 * - Otherwise (agent settled, nothing pending, last turn completed with
 *   `stop`) — end-of-session compaction (e.g. manual `/compact` after a
 *   completed turn) → no auto-continue.
 *
 * @param event - The `session_compact` event (`reason` and `willRetry`)
 * @param signals - Live extension-context signals captured at event time
 * @returns true when the agent should auto-continue after compaction
 */
export function shouldAutoContinueAfterCompaction(
  event: { reason: string; willRetry: boolean },
  signals: { hasPendingMessages: boolean; isIdle: boolean; lastAssistantStopReason?: string },
): boolean {
  // Pi natively retries the aborted turn after overflow compaction —
  // a second continuation would race it.
  if (event.willRetry) return false;

  // Queued messages mean the agent had work in flight → mid-session.
  if (signals.hasPendingMessages) return true;

  // An interrupted turn (max output tokens / error) is mid-session work.
  const stopReason = signals.lastAssistantStopReason;
  if (stopReason === 'length' || stopReason === 'error') return true;

  // The agent was running when compaction started → mid-session.
  if (!signals.isIdle) return true;

  // Settled agent, no pending work → end-of-session, no auto-continue.
  return false;
}

/**
 * Guard checks for starting a compaction auto-continue.
 *
 * Mirrors the safety guards already enforced inside `triggerInvisibleContinue`
 * (user abort, session switches) at the compaction entry point, plus the
 * retry-loop mutex and the continuation-in-flight flag so the `session_compact`
 * path never races the CONTEXT_LENGTH path or Pi's own overflow retry.
 *
 * @param guards - Current recovery-module state
 * @returns true when a compaction auto-continue may start
 */
export function shouldTriggerCompactionContinue(guards: {
  /** User pressed ESC — never auto-continue. */
  userAborted: boolean;
  /** The invisible-continue retry loop is already running (mutex). */
  continueInProgress: boolean;
  /** A context-length continuation is already in flight (double-trigger guard). */
  continuationInFlight: boolean;
}): boolean {
  if (guards.userAborted) return false;
  if (guards.continueInProgress) return false;
  if (guards.continuationInFlight) return false;
  return true;
}

/**
 * Guard checks for starting a compaction-gate recovery.
 *
 * Mirrors `shouldTriggerCompactionContinue` (user abort, retry-loop mutex,
 * continuation-in-flight) plus the gate-specific retry-limit guard:
 * once `continuationCount` exceeds `maxRetries` consecutive gate→compact→
 * retry cycles, the session clearly cannot be shrunk below the proxy cap,
 * so the caller must fall back to explicit guidance instead of looping
 * forever (WL-0MTBOXEGR009KDP6).
 *
 * The compaction gate is a proxy-level 4xx signal and is deliberately
 * distinct from the model-level CONTEXT_LENGTH path — it never conflates
 * with `stopReason === "length"` handling (AC1).
 *
 * @param guards - Current recovery-module state
 * @param maxRetries - Gate retry cap; defaults to MAX_COMPACTION_GATE_RETRIES
 * @returns true when a gate-driven compaction may start
 */
export function shouldTriggerCompactionGateRecovery(
  guards: {
    /** User pressed ESC — never auto-compact. */
    userAborted: boolean;
    /** The invisible-continue retry loop is already running (mutex). */
    continueInProgress: boolean;
    /** A continuation (context-length or gate) is already in flight. */
    continuationInFlight: boolean;
    /** Consecutive gate→compact→retry cycles already performed. */
    continuationCount: number;
  },
  maxRetries: number = MAX_COMPACTION_GATE_RETRIES,
): boolean {
  if (guards.userAborted) return false;
  if (guards.continueInProgress) return false;
  if (guards.continuationInFlight) return false;
  // Retry-limit guard — at/over the cap, fall back to explicit guidance
  // (never loop detect → compact → retry forever).
  if (guards.continuationCount >= maxRetries) return false;
  return true;
}

// ── Terminal error categories ─────────────────────────────────────────

/**
 * Error categories that should terminate with a checkpoint (no retry).
 */
export const TERMINAL_CATEGORIES = ['authError', 'quotaExhausted', 'terminated'] as const;

export type TerminalCategory = typeof TERMINAL_CATEGORIES[number];

// ── Terminal error handler ────────────────────────────────────────────

/**
 * Result of a checkpoint-and-terminate operation.
 */
export interface CheckpointTerminateResult {
  /** Whether the checkpoint was saved successfully */
  success: boolean;
  /** The error message that was displayed */
  errorMessage: string;
  /** User-friendly title for the error */
  title: string;
}

/**
 * Get a user-friendly title for a terminal error category.
 */
export function getTerminalErrorTitle(category: TerminalCategory): string {
  switch (category) {
    case 'authError':
      return 'Authentication Error';
    case 'quotaExhausted':
      return 'Quota Exhausted';
    case 'terminated':
      return 'Response Terminated';
  }
}

/**
 * Execute the checkpoint-and-terminate flow for unrecoverable errors.
 *
 * 1. Saves a checkpoint (captures current session state)
 * 2. Displays an informative error message
 * 3. Does NOT attempt retry — the caller's retry state is reset
 *
 * This is a pure-logic harness — it takes the functions it needs as
 * parameters so it can be tested without a live agent.
 *
 * @param category - The terminal error category
 * @param errorDetail - The detailed error message from the provider
 * @param options.saveCheckpoint - Function that saves a checkpoint
 * @param options.notify - Function that displays a notification
 * @returns The result of the operation
 */
export async function executeCheckpointAndTerminate(
  category: TerminalCategory,
  errorDetail: string,
  options: {
    saveCheckpoint: () => Promise<{ success: boolean; error?: string }>;
    notify: (message: string, level?: 'info' | 'warning' | 'error') => void;
  },
): Promise<CheckpointTerminateResult> {
  const title = getTerminalErrorTitle(category);
  const userMessage = `${title}: ${errorDetail.substring(0, 200)}`;

  try {
    // Step 1: Save checkpoint
    const checkpointResult = await options.saveCheckpoint();

    // Step 2: Display informative error message
    if (checkpointResult.success) {
      options.notify(
        `Checkpoint saved. ${title}: ${errorDetail.substring(0, 100)}`,
        'error',
      );
      return {
        success: true,
        errorMessage: errorDetail,
        title,
      };
    } else {
      options.notify(
        `${title} (checkpoint failed): ${errorDetail.substring(0, 100)}`,
        'error',
      );
      return {
        success: false,
        errorMessage: errorDetail,
        title,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error during checkpoint';
    options.notify(`${title}: ${errorDetail.substring(0, 100)}`, 'error');
    return {
      success: false,
      errorMessage: errorDetail,
      title,
    };
  }
}

// ── Compact-and-Continue handler ──────────────────────────────────────

/**
 * Result of a compact-and-continue operation.
 */
export interface CompactContinueResult {
  /** Whether the operation was successful */
  success: boolean;
  /** The continuation count after this operation */
  continuationCount: number;
  /** Optional error message if the operation failed */
  error?: string;
}

/**
 * Execute the compact-and-continue flow.
 *
 * 1. Sends the /compact command to reduce context
 * 2. On success, auto-continues via agent.prompt([]) with the configured
 *    continuation prompt
 * 3. On failure, returns an error (caller should save checkpoint + display)
 *
 * This is a pure-logic harness — it takes the functions it needs as
 * parameters so it can be tested without a live agent.
 *
 * @param state - The ContinuationState tracker
 * @param options.handlerCompact - Function that executes the /compact command
 * @param options.continuationPrompt - Optional custom continuation prompt text
 * @returns Promise with the result
 */
export async function executeCompactAndContinue(
  state: ContinuationState,
  options: {
    executeCompact: () => Promise<{ success: boolean; error?: string }>;
    continuationPrompt?: string;
    /**
     * Maximum compact-and-continue cycles allowed (WL-0MTBOXEGR009KDP6).
     * Once the continuation count reaches this limit, compaction is
     * skipped and a failure is returned so the caller can fall back to
     * explicit guidance — prevents an infinite detect → compact → retry
     * loop when compaction cannot shrink context below the proxy cap.
     */
    maxRetries?: number;
  },
): Promise<CompactContinueResult> {
  const continuationPrompt = options.continuationPrompt ?? DEFAULT_CONTINUATION_PROMPT;

  // Retry-limit guard (checked BEFORE starting a new cycle): when the
  // existing count already equals/exceeds the cap, skip compaction so the
  // count never climbs past the limit and no infinite detect → compact →
  // retry loop can form (WL-0MTBOXEGR009KDP6). The caller falls back to
  // explicit guidance on this failure.
  const maxRetries = options.maxRetries;
  if (maxRetries !== undefined && state.getCount() >= maxRetries) {
    return {
      success: false,
      continuationCount: state.getCount(),
      error: `Compaction gate retry limit reached (${maxRetries}); compacting again would not clear the proxy cap — please start a new session to continue.`,
    };
  }

  // Notify start
  state.startContinuation();
  const count = state.getCount();

  try {
    // Step 1: Execute /compact
    const compactResult = await options.executeCompact();

    if (!compactResult.success) {
      // /compact failed — no retry, just report the error
      state.endContinuation();
      return {
        success: false,
        continuationCount: count,
        error: compactResult.error ?? '/compact command failed',
      };
    }

    // Step 2: Auto-continue after successful compact
    state.endContinuation();
    return {
      success: true,
      continuationCount: count,
    };
  } catch (err) {
    state.endContinuation();
    return {
      success: false,
      continuationCount: count,
      error: err instanceof Error ? err.message : 'Unknown error during compact-and-continue',
    };
  }
}

// ── Parse-error continue handler ─────────────────────────────────────

/**
 * Result of a single-shot parse-error continue operation.
 */
export interface ParseErrorContinueResult {
  /** Whether the continue prompt was sent */
  success: boolean;
  /**
   * Number of continue prompts sent (always 1 on success — single-shot;
   * 0 when skipped or failed).
   */
  promptCount: number;
  /** Optional error message if the operation failed */
  error?: string;
}

/**
 * Execute the single-shot continue flow for JSON parse errors.
 *
 * Per operator decision, a JSON parse error resumes the session with
 * exactly one plain "continue" prompt — no exponential-backoff retry
 * loop. The error message stays in agent state so the agent can decide
 * how to proceed (e.g., skip the malformed record). A repeated parse
 * error on the next `agent_end` triggers a new single-shot continue
 * (one prompt per occurrence, never an unbounded loop within a turn).
 *
 * This is a pure-logic harness — it takes the functions it needs as
 * parameters so it can be tested without a live agent.
 *
 * @param options.waitForIdle - Optional; waits for the agent to become idle
 * @param options.sendContinue - Sends the plain "continue" prompt
 * @param options.shouldAbort - Optional; checked before/after idle wait;
 *   returns true when the continue should be skipped (e.g. user abort)
 * @returns Promise with the result
 */
export async function executeParseErrorContinue(
  options: {
    waitForIdle?: () => Promise<void>;
    sendContinue: () => Promise<void>;
    shouldAbort?: () => boolean;
  },
): Promise<ParseErrorContinueResult> {
  try {
    if (options.shouldAbort?.()) {
      return { success: false, promptCount: 0, error: 'aborted' };
    }
    if (options.waitForIdle) {
      await options.waitForIdle();
    }
    if (options.shouldAbort?.()) {
      return { success: false, promptCount: 0, error: 'aborted' };
    }
    // Single-shot: exactly one continue prompt, then return. No backoff,
    // no loop — a persistent parse error re-triggers on the next agent_end.
    await options.sendContinue();
    return { success: true, promptCount: 1 };
  } catch (err) {
    return {
      success: false,
      promptCount: 0,
      error: err instanceof Error ? err.message : 'Unknown error during parse-error continue',
    };
  }
}
