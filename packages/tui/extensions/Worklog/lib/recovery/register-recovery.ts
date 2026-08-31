/**
 * Recovery module registration — wires error detection, dispatch, and
 * retry loop into the extension lifecycle.
 *
 * Handles:
 * - agent_end → error detection → category dispatch
 * - turn_end → state management (reset on success, abort flag)
 * - session_start → state reset
 * - session_compact → auto-continue after mid-session compaction
 * - agent_end COMPACTION_GATE → /compact + auto-retry (proxy hard cap 4xx)
 * - Built-in retry suppression (monkey-patching _prepareRetry)
 * - /retry command registration
 */

import type { ExtensionAPI, ExtensionCommandContext, SessionCompactEvent } from '@earendil-works/pi-coding-agent';

import { classifyError, DEFAULT_RECOVERY_CONFIG, ErrorCategory } from './error-patterns.js';
import {
  executeParseErrorContinue,
  executeCompactAndContinue,
  shouldAutoContinueAfterCompaction,
  shouldTriggerCompactionContinue,
  shouldTriggerCompactionGateRecovery,
  COMPACTION_GATE_FALLBACK_MESSAGE,
  MAX_COMPACTION_GATE_RETRIES,
} from './recovery.js';
import {
  retryStates,
  continuationState,
  interruptibleState,
  executeRetryCommand,
  type RetryCommandContext,
  type RetryCommandOptions,
} from './retry-command.js';
import { calculateDelay, formatDuration } from './retry-logic.js';

let _recoveryRegistered = false;

// ── Agent reference (captured via monkey-patched subscribe) ───────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _agent: any = null;

// Mutex: only one retry loop may run at a time.
let _continueInProgress = false;

// Notify function, captured from the most recent handler ctx.
let _notifyFn: ((message: string, level: 'info' | 'warning' | 'error') => void) | null = null;

// Timestamp of the last completed triggerInvisibleContinue call.
let _lastInvisibleContinueTime = 0;

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
  captureAgentInstance();

  // Refresh the notify function on every handler that carries a ctx.
  pi.on('agent_end', async (_event, ctx) => {
    _notifyFn = (message, level) => ctx.ui.notify(message, level);
  });
  pi.on('turn_end', async (_event, ctx) => {
    if (!_notifyFn) {
      _notifyFn = (message, level) => ctx.ui.notify(message, level);
    }
  });

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
        // Terminal errors: record in retry state for diagnostics, then show message and stop
        const errorMsg = lastAssistant.errorMessage || 'Unknown error';
        const state = retryStates[category as string];
        if (state) {
          state.startRetry(errorMsg);
          state.endRetry();
        }
        ctx.ui.notify(
          `Non-retryable error: ${errorMsg.substring(0, 200)}`,
          'error',
        );
        break;
      }

      case ErrorCategory.SERVER_ERROR:
      case ErrorCategory.TIMEOUT: {
        // Retryable errors: trigger retry loop with exponential backoff
        const errorMsg = lastAssistant.errorMessage || 'Unknown error';
        const state = retryStates[category as string];
        if (state && !state.getIsRetrying()) {
          state.startRetry(errorMsg);
          // Don't endRetry here — the retry loop owns the state
          ctx.ui.notify(
            `Retrying after ${category}: ${errorMsg.substring(0, 100)}...`,
            'info',
          );
          // Fire the retry loop (returns immediately; loops in background)
          void triggerInvisibleContinue();
        }
        break;
      }

      case ErrorCategory.CONTEXT_LENGTH: {
        // Context-length: compact and auto-continue via the retry loop.
        // The retry loop handles: wait-for-idle -> remove error from agent
        // state -> prompt([]) to resume generation.
        if (!continuationState.getIsContinuing()) {
          continuationState.startContinuation();
          ctx.ui.notify(
            `Max tokens reached — continuing (continuation ${continuationState.getCount()})...`,
            'info',
          );
          continuationState.endContinuation();
          // Fire the retry loop to auto-continue after compaction.
          // prompt([]) with the truncated message still in context lets
          // the LLM continue from where it left off. If the continuation
          // also hits max tokens, the next agent_end fires a new
          // continuation (the loop exits because 'length' is not 'error').
          void triggerInvisibleContinue();
        }
        break;
      }

      case ErrorCategory.PARSE_ERROR: {
        // Parse errors: single-shot auto-continue with a plain "continue"
        // prompt. Per operator decision there is NO exponential-backoff
        // loop — one "continue" per detected parse error. The error message
        // stays in agent state so the agent decides how to proceed (e.g.,
        // skip the malformed record). A repeated parse error triggers a new
        // continue on the next agent_end (single-shot per occurrence).
        const errorMsg = lastAssistant.errorMessage || 'Unknown error';
        const state = retryStates[category as string];
        if (state) {
          state.startRetry(errorMsg);
          state.endRetry();
        }
        ctx.ui.notify(
          `JSON parse error — auto-continuing: ${errorMsg.substring(0, 100)}...`,
          'info',
        );
        void triggerParseErrorContinue();
        break;
      }

      case ErrorCategory.COMPACTION_GATE: {
        // Compaction gate (proxy cheap-mode hard cap 4xx): runs /compact
        // via the existing machinery, then auto-retries the original
        // request invisibly. Distinct from CONTEXT_LENGTH (a model-level
        // stopReason "length" signal) — enforced by the classifier.
        void triggerCompactionGateRecovery(ctx);
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

  // ── session_compact: auto-continue after mid-session compaction ──
  // Pi auto-continues only overflow recovery (willRetry) natively; threshold
  // compaction stops. When a compaction is demonstrably mid-session (queued
  // messages pending, an interrupted turn with stopReason length/error, or the
  // agent still streaming), reuse the invisible-continue loop so the agent
  // resumes without the user typing "continue".
  pi.on('session_compact', async (event: SessionCompactEvent, ctx) => {
    _notifyFn = (message, level) => ctx.ui.notify(message, level);

    const entries = ctx.sessionManager.getEntries();
    const lastAssistant = findLastAssistantMessage(entries);

    const signals = {
      hasPendingMessages: ctx.hasPendingMessages(),
      isIdle: ctx.isIdle(),
      lastAssistantStopReason: lastAssistant?.stopReason,
    };

    if (!shouldAutoContinueAfterCompaction(event, signals)) return;
    void triggerCompactionContinue();
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
        // Don't reset if the retry loop is running (it will handle its own state)
        if (!_continueInProgress) {
          for (const state of Object.values(retryStates)) {
            state.succeed();
          }
          continuationState.complete();
          interruptibleState.userAborted = false;
        }
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
        triggerParseErrorContinue: () => {
          ctx.ui.notify('Continuing after JSON parse error...', 'info');
        },
        triggerCheckpointTerminate: (_category: string, _errorDetail: string) => {
          ctx.ui.notify(`${_category}: ${_errorDetail.substring(0, 100)}`, 'error');
        },
      };

      await executeRetryCommand(args, retryCtx, retryOptions);
    },
  });
}

// ── Agent instance capture ────────────────────────────────────────────

/**
 * Monkey-patch Agent.prototype.subscribe to capture the live Agent instance.
 * subscribe() is called during AgentSession construction — fires on both
 * fresh sessions and session resumes.
 */
function captureAgentInstance(): void {
  try {
    const { Agent } = require('@earendil-works/pi-agent-core') as any;
    if (typeof Agent !== 'function' || !Agent.prototype) return;

    const origSubscribe = Agent.prototype.subscribe;
    if (typeof origSubscribe !== 'function') return;

    Agent.prototype.subscribe = function (this: any, ...args: any[]) {
      _agent = this;
      return origSubscribe.apply(this, args);
    };
  } catch {
    // Agent not available in this environment.
  }
}

// ── Retry loop driver ────────────────────────────────────────────────

/**
 * Interruptible sleep that polls abort and session-change flags every 100ms.
 * Returns true if interrupted, false if the full delay elapsed.
 */
function interruptibleRetrySleep(ms: number): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const checkInterval = 100;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += checkInterval;
      if (interruptibleState.userAborted || interruptibleState.sessionGeneration !== _sessionGenerationAtStart) {
        clearInterval(timer);
        resolve(true);
      } else if (elapsed >= ms) {
        clearInterval(timer);
        resolve(false);
      }
    }, checkInterval);
  });
}

let _sessionGenerationAtStart = 0;

/**
 * The core retry loop — ported from pi-retry/retry.ts triggerInvisibleContinue().
 *
 * After an error is detected in agent_end, this function:
 * 1. Waits for the agent to become idle
 * 2. Removes the error message from agent state
 * 3. Sleeps with exponential backoff
 * 4. Calls agent.prompt([]) to restart the agent loop invisibly
 * 5. Checks the result — if still an error, loops; if success, exits
 *
 * Respects user abort (ESC) and session switches (/new, /resume).
 */
async function triggerInvisibleContinue(): Promise<void> {
  if (!_agent) return;

  // Guard: if user aborted, don't start
  if (interruptibleState.userAborted) return;

  // Guard: mutex — only one retry loop at a time
  if (_continueInProgress) return;
  _continueInProgress = true;

  // Capture the current session generation
  _sessionGenerationAtStart = interruptibleState.sessionGeneration;

  try {
    // Wait for the current run to finish
    if (typeof _agent.waitForIdle === 'function') {
      await _agent.waitForIdle();
    }

    // Re-check after waitForIdle
    if (interruptibleState.userAborted || interruptibleState.sessionGeneration !== _sessionGenerationAtStart) return;

    let attempt = 0;

    // Loop until success, abort, or session change
    while (true) {
      if (interruptibleState.userAborted || interruptibleState.sessionGeneration !== _sessionGenerationAtStart) return;

      // Remove the error assistant message from agent state
      removeErrorFromAgentState();

      attempt++;
      const delay = calculateDelay(attempt);

      // Notify user
      const duration = formatDuration(delay);
      _notifyRetryAttempt(attempt, duration);

      // Interruptible sleep with backoff before the retry
      const interrupted = await interruptibleRetrySleep(delay);
      if (interrupted) return;

      try {
        await _agent.prompt([]);
      } catch {
        // Agent is already processing or other transient error
        return;
      }

      // Re-check after prompt
      if (interruptibleState.userAborted || interruptibleState.sessionGeneration !== _sessionGenerationAtStart) return;

      // Check result — if no longer an error, exit loop
      if (!lastMessageIsRetryableError()) {
        // Success or non-error terminal state — reset retry state
        for (const state of Object.values(retryStates)) {
          state.succeed();
        }
        continuationState.complete();
        return;
      }

      // Error again — loop back for another attempt
    }
  } finally {
    // Only reset mutex if session hasn't changed
    if (interruptibleState.sessionGeneration === _sessionGenerationAtStart) {
      _continueInProgress = false;
    }
    _lastInvisibleContinueTime = Date.now();
  }
}

/**
 * Auto-continue the agent after a mid-session compaction.
 *
 * Applies the entry-point guards (user abort, retry-loop mutex, and
 * continuation-in-flight so this path never double-triggers with the
 * CONTEXT_LENGTH path), then fires the invisible-continue loop
 * (`agent.prompt([])`) that the CONTEXT_LENGTH branch already uses.
 * The loop itself re-verifies abort/session-change throughout.
 */
async function triggerCompactionContinue(): Promise<void> {
  if (!shouldTriggerCompactionContinue({
    userAborted: interruptibleState.userAborted,
    continueInProgress: _continueInProgress,
    continuationInFlight: continuationState.getIsContinuing() || continuationState.getCount() > 0,
  })) return;

  continuationState.startContinuation();
  if (_notifyFn) {
    _notifyFn('Compaction complete — continuing automatically...', 'info');
  }
  continuationState.endContinuation();

  void triggerInvisibleContinue();
}

/**
 * Compaction-gate recovery: the proxy's cheap-mode hard cap returned an
 * informative 4xx because the context exceeded the cap. The client must
 * compact and retry (AC2/AC3) — never silently drop, never queue-fallback
 * to expensive remote, never burn a near-full-slot prefill.
 *
 * Flow: guard (abort/mutex/in-flight/retry-limit) → notify → /compact via
 * the existing `executeCompactAndContinue()` machinery → on success fire
 * the invisible-continue auto-retry; on failure show explicit guidance
 * (AC4). Distinct from the CONTEXT_LENGTH path: this is a proxy-level 4xx,
 * not a model-level stopReason "length".
 */
async function triggerCompactionGateRecovery(ctx: { compact(options?: { onComplete?: () => void; onError?: (error: Error) => void }): void }): Promise<void> {
  if (!_agent) return;

  if (!shouldTriggerCompactionGateRecovery({
    userAborted: interruptibleState.userAborted,
    continueInProgress: _continueInProgress,
    continuationInFlight: continuationState.getIsContinuing(),
    continuationCount: continuationState.getCount(),
  })) return;

  if (_notifyFn) {
    _notifyFn(`Proxy context limit reached — compacting session (attempt ${continuationState.getCount() + 1}/${MAX_COMPACTION_GATE_RETRIES})...`, 'info');
  }

  const result = await executeCompactAndContinue(continuationState, {
    // ctx.compact() is fire-and-forget; the callbacks resolve the promise.
    executeCompact: () => new Promise((resolve) => {
      ctx.compact({
        onComplete: () => resolve({ success: true }),
        onError: (err) => resolve({ success: false, error: err.message }),
      });
    }),
    maxRetries: MAX_COMPACTION_GATE_RETRIES,
  });

  if (!result.success) {
    // Explicit guidance — never silently drop the gated request (AC4).
    const reason = result.error ?? COMPACTION_GATE_FALLBACK_MESSAGE;
    if (_notifyFn) {
      _notifyFn(reason, 'error');
    }
    return;
  }

  // Compaction succeeded — auto-retry the original request invisibly.
  if (_notifyFn) {
    _notifyFn('Compaction complete — retrying your request automatically...', 'info');
  }
  void triggerInvisibleContinue();
}

/**
 * Single-shot invisible continue for JSON parse errors.
 *
 * Waits for the agent to become idle, then sends exactly one plain
 * "continue" prompt. No exponential backoff and no error-message removal —
 * a deterministic parse error simply triggers another continue on the next
 * agent_end (single-shot per occurrence). Guards against user abort and
 * session switches; the mutex prevents concurrent continues.
 */
async function triggerParseErrorContinue(): Promise<void> {
  if (!_agent) return;

  // Guard: if user aborted, don't start
  if (interruptibleState.userAborted) return;

  // Guard: mutex — only one continue at a time
  if (_continueInProgress) return;
  _continueInProgress = true;

  const sessionGenerationAtStart = interruptibleState.sessionGeneration;

  try {
    await executeParseErrorContinue({
      waitForIdle: () => _agent?.waitForIdle?.(),
      // Plain "continue" prompt per operator decision; text is
      // settings-driven via the parseError category config.
      sendContinue: () => _agent.prompt([DEFAULT_RECOVERY_CONFIG.parseError.continuationPrompt ?? 'continue']),
      shouldAbort: () =>
        interruptibleState.userAborted ||
        interruptibleState.sessionGeneration !== sessionGenerationAtStart,
    });
  } finally {
    // Only reset mutex if session hasn't changed
    if (interruptibleState.sessionGeneration === sessionGenerationAtStart) {
      _continueInProgress = false;
    }
  }
}

/** Notify user about a retry attempt */
function _notifyRetryAttempt(attempt: number, duration: string): void {
  if (_notifyFn) {
    _notifyFn(`Retry attempt ${attempt} (backoff ${duration})...`, 'info');
  }
}

/** Remove the last error assistant message from agent state */
function removeErrorFromAgentState(): void {
  if (!_agent) return;
  const messages = _agent.state?.messages;
  if (!messages || !Array.isArray(messages)) return;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'assistant' && lastMsg.stopReason === 'error') {
    _agent.state.messages = messages.slice(0, -1);
  }
}

/** Check if agent's last message is a retryable error */
function lastMessageIsRetryableError(): boolean {
  if (!_agent) return false;
  const messages = _agent.state?.messages;
  if (!messages || !Array.isArray(messages)) return false;
  const lastMsg = messages[messages.length - 1];
  return lastMsg?.role === 'assistant' && lastMsg.stopReason === 'error';
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
