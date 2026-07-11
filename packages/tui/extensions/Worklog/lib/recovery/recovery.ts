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
  },
): Promise<CompactContinueResult> {
  const continuationPrompt = options.continuationPrompt ?? DEFAULT_CONTINUATION_PROMPT;

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
