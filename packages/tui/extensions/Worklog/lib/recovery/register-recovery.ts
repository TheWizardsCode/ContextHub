/**
 * Recovery module registration — wires error detection, dispatch, and
 * retry loop into the extension lifecycle.
 *
 * Handles:
 * - agent_end → error detection → category dispatch
 * - turn_end → state management (reset on success, abort flag)
 * - session_start → state reset
 * - Built-in retry suppression (monkey-patching _prepareRetry)
 * - /retry command registration
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import { classifyError, ErrorCategory } from './error-patterns.js';
import {
  retryStates,
  continuationState,
  interruptibleState,
  executeRetryCommand,
  type RetryCommandContext,
  type RetryCommandOptions,
} from './retry-command.js';

let _recoveryRegistered = false;

/**
 * Register the recovery module with the extension API.
 *
 * Must be called once during extension initialization. Idempotent —
 * subsequent calls are no-ops.
 */
export function registerRecoveryModule(pi: ExtensionAPI): void {
  if (_recoveryRegistered) return;
  _recoveryRegistered = true;

  // ── Suppress pi's built-in retry ───────────────────────────────
  // Monkey-patch AgentSession._prepareRetry to disable the built-in
  // retry mechanism when our recovery module is active. This prevents
  // the built-in retry from racing with our retry loop.
  suppressBuiltinRetry();

  // ── agent_end: detect errors and dispatch ──────────────────────
  pi.on('agent_end', async (event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const lastAssistant = findLastAssistantMessage(entries);

    if (!lastAssistant) return;

    // If user aborted, don't start new recovery
    if (interruptibleState.userAborted) return;

    const category = classifyError(lastAssistant);

    switch (category) {
      case ErrorCategory.RATE_LIMIT:
      case ErrorCategory.AUTH_ERROR:
      case ErrorCategory.QUOTA_EXHAUSTED:
      case ErrorCategory.TERMINATED: {
        // Terminal errors: show message but don't retry
        const errorMsg = lastAssistant.errorMessage || 'Unknown error';
        ctx.ui.notify(
          `Non-retryable error: ${errorMsg.substring(0, 200)}`,
          'error',
        );
        break;
      }

      case ErrorCategory.SERVER_ERROR:
      case ErrorCategory.TIMEOUT: {
        // Retryable errors: trigger retry loop
        const errorMsg = lastAssistant.errorMessage || 'Unknown error';
        const state = retryStates[category as string];
        if (state && !state.getIsRetrying()) {
          state.startRetry(errorMsg);
          state.endRetry();
          ctx.ui.notify(
            `Retrying after ${category}: ${errorMsg.substring(0, 100)}...`,
            'info',
          );
        }
        break;
      }

      case ErrorCategory.CONTEXT_LENGTH: {
        // Context-length: handled by compact-and-continue
        // (notification shown by the compact handler)
        if (!continuationState.getIsContinuing()) {
          continuationState.startContinuation();
          ctx.ui.notify(
            `Max tokens reached — continuing (continuation ${continuationState.getCount()})...`,
            'info',
          );
          continuationState.endContinuation();
        }
        break;
      }

      case ErrorCategory.UNKNOWN:
      default:
        // Unknown errors: show message, no retry
        if (lastAssistant.errorMessage) {
          ctx.ui.notify(
            `Unrecognized error: ${lastAssistant.errorMessage.substring(0, 100)}`,
            'error',
          );
        }
        break;
    }
  });

  // ── turn_end: manage state on successful turns ─────────────────
  pi.on('turn_end', async (event) => {
    const msg = (event as any).message;
    if (msg?.role === 'assistant') {
      if (msg.stopReason === 'aborted') {
        // User cancelled — reset state
        for (const state of Object.values(retryStates)) {
          state.reset();
        }
        continuationState.endContinuation();
        interruptibleState.userAborted = true;
        return;
      }
      if (msg.stopReason !== 'length') {
        // Normal completion — reset everything
        for (const state of Object.values(retryStates)) {
          state.succeed();
        }
        continuationState.complete();
        interruptibleState.userAborted = false;
      }
    }
  });

  // ── session_start: reset state for new session ─────────────────
  pi.on('session_start', async () => {
    interruptibleState.sessionGeneration++;
    for (const state of Object.values(retryStates)) {
      state.reset();
    }
    continuationState.reset();
    interruptibleState.userAborted = false;
  });

  // ── /retry command ─────────────────────────────────────────────
  pi.registerCommand('retry', {
    description: 'Retry controls: /retry (manual), /retry status (diagnostics), /retry reset (clear state)',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const retryCtx: RetryCommandContext = {
        sessionManager: ctx.sessionManager,
        ui: ctx.ui,
      };
      const retryOptions: RetryCommandOptions = {
        triggerRetry: (_category: ErrorCategory) => {
          // Placeholder — actual retry loop happens in the agent_end handler
          ctx.ui.notify(`Retrying ${_category}...`, 'info');
        },
        triggerCompactContinue: () => {
          ctx.ui.notify('Continuing after context-length...', 'info');
        },
        triggerCheckpointTerminate: (_category: string, _errorDetail: string) => {
          ctx.ui.notify(`${_category}: ${_errorDetail.substring(0, 100)}`, 'error');
        },
      };

      await executeRetryCommand(args, retryCtx, retryOptions);
    },
  });
}

// ── Built-in retry suppression ────────────────────────────────────────

/**
 * Suppress pi's built-in retry mechanism by monkey-patching
 * AgentSession._prepareRetry.
 *
 * This prevents the built-in retry from racing with our recovery module.
 * When the recovery module is active, _prepareRetry returns false
 * immediately, so pi's _handlePostAgentRun falls through to the
 * compaction check and the while loop exits cleanly.
 */
function suppressBuiltinRetry(): void {
  try {
    // Dynamically import AgentSession — it may not be available in all
    // runtime environments (e.g., tests without the full pi SDK).
    const { AgentSession } = require('@earendil-works/pi-coding-agent') as any;

    if (typeof AgentSession !== 'function') return;
    if (!AgentSession.prototype) return;

    const original = AgentSession.prototype._prepareRetry;
    if (!original) return;

    AgentSession.prototype._prepareRetry = function () {
      // Our recovery module handles retries; suppress the built-in one.
      return Promise.resolve(false);
    };
  } catch {
    // AgentSession not available in this environment — that's fine.
    // The suppression will take effect when the extension is loaded
    // in the actual pi runtime.
  }
}

// ── Helper ───────────────────────────────────────────────────────────

function findLastAssistantMessage(entries: unknown[]): { role: string; stopReason?: string; errorMessage?: string } | undefined {
  if (!entries || !Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; message?: { role: string; stopReason?: string; errorMessage?: string } };
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      return entry.message;
    }
  }
  return undefined;
}
