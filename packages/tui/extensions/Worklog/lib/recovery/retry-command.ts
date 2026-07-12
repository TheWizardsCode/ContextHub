/**
 * /retry command handler for the recovery module.
 *
 * Provides three subcommands:
 * - `/retry` (no args) — manual trigger, auto-detects last error and dispatches
 * - `/retry status` — displays diagnostics for all retry state categories
 * - `/retry reset` — clears all retry state and abort flags
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { classifyError, ErrorCategory, DEFAULT_RECOVERY_CONFIG } from './error-patterns.js';
import {
  RetryState,
  ContinuationState,
  getLastAssistantMessage,
  type InterruptibleSleepState,
} from './retry-logic.js';

// ── Shared state for the recovery module ──────────────────────────────

/**
 * Per-category retry state trackers.
 * One RetryState per error category for diagnostics.
 */
export const retryStates: Record<string, RetryState> = {
  rateLimit: new RetryState(),
  serverError: new RetryState(),
  authError: new RetryState(),
  contextLength: new RetryState(),
  quotaExhausted: new RetryState(),
  timeout: new RetryState(),
  terminated: new RetryState(),
};

export const continuationState = new ContinuationState();

export const interruptibleState: InterruptibleSleepState = {
  userAborted: false,
  sessionGeneration: 0,
};

// ── Command handler ───────────────────────────────────────────────────

export interface RetryCommandContext {
  sessionManager: {
    getEntries: () => unknown[];
  };
  ui: {
    notify: (message: string, level?: 'info' | 'warning' | 'error') => void;
  };
}

export interface RetryCommandOptions {
  /** Called to trigger a retry for the given category */
  triggerRetry: (category: ErrorCategory) => void;
  /** Called to trigger compact-and-continue */
  triggerCompactContinue: () => void;
  /** Called to trigger checkpoint-and-terminate */
  triggerCheckpointTerminate: (category: string, errorDetail: string) => void;
}

/**
 * Format diagnostics for /retry status display.
 */
export function formatRetryStatus(
  retryStates: Record<string, RetryState>,
  continuationState: ContinuationState,
): string {
  const lines: string[] = [];

  lines.push('=== Retry Status ===\n');

  for (const [category, state] of Object.entries(retryStates)) {
    const willRetry = (DEFAULT_RECOVERY_CONFIG as any)[category]?.enabled === true;
    lines.push(`${category}:`);
    lines.push(`  Will retry: ${willRetry}`);
    if (willRetry) {
      lines.push(`  Current attempt: ${state.getAttempt()}`);
      lines.push(`  Is retrying: ${state.getIsRetrying()}`);
    }
    const lastErr = state.getLastErrorMessage();
    lines.push(`  Last error: ${lastErr ? lastErr.substring(0, 100) : 'None'}`);
    lines.push('');
  }

  lines.push('Continuation:');
  lines.push(`  Count: ${continuationState.getCount()}`);
  lines.push(`  Is continuing: ${continuationState.getIsContinuing()}`);

  return lines.join('\n');
}

/**
 * Execute a /retry command with the appropriate subcommand.
 *
 * @param args - The command arguments string
 * @param ctx - Extension command context
 * @param options - Retry operation callbacks
 */
export async function executeRetryCommand(
  args: string,
  ctx: RetryCommandContext,
  options: RetryCommandOptions,
): Promise<void> {
  const trimmed = args?.trim() ?? '';
  const parts = trimmed.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();

  // /retry status - Show diagnostics
  if (subcommand === 'status') {
    const status = formatRetryStatus(retryStates, continuationState);
    ctx.ui.notify(status, 'info');
    return;
  }

  // /retry reset - Reset all state
  if (subcommand === 'reset') {
    for (const state of Object.values(retryStates)) {
      state.reset();
    }
    continuationState.reset();
    interruptibleState.userAborted = false;
    ctx.ui.notify('All retry counters and state reset', 'info');
    return;
  }

  // /retry (no args) - Manual trigger with auto-detection
  const entries = ctx.sessionManager.getEntries();
  const lastAssistant = getLastAssistantMessage(entries);

  if (!lastAssistant) {
    ctx.ui.notify('No assistant message found to retry', 'warning');
    return;
  }

  if (lastAssistant.role !== 'assistant') {
    ctx.ui.notify('No assistant message found to retry', 'warning');
    return;
  }

  // Clear abort flag — user explicitly requested retry
  interruptibleState.userAborted = false;

  // Classify the error and dispatch
  const category = classifyError(lastAssistant);

  switch (category) {
    case ErrorCategory.RATE_LIMIT:
    case ErrorCategory.AUTH_ERROR:
    case ErrorCategory.QUOTA_EXHAUSTED:
    case ErrorCategory.TERMINATED:
      ctx.ui.notify(`Manual retry triggered for ${category}`, 'info');
      options.triggerRetry(category);
      break;

    case ErrorCategory.SERVER_ERROR:
    case ErrorCategory.TIMEOUT:
      ctx.ui.notify(`Manual retry triggered for ${category}`, 'info');
      options.triggerRetry(category);
      break;

    case ErrorCategory.CONTEXT_LENGTH:
      ctx.ui.notify('Manual continue after context-length...', 'info');
      options.triggerCompactContinue();
      break;

    case ErrorCategory.UNKNOWN:
    default:
      ctx.ui.notify(
        'No retryable error detected. Use /retry status for diagnostics.',
        'warning',
      );
      break;
  }
}

/**
 * Get the RetryState for a given ErrorCategory.
 */
export function getRetryStateForCategory(category: ErrorCategory): RetryState | undefined {
  return retryStates[category as string] ?? undefined;
}
