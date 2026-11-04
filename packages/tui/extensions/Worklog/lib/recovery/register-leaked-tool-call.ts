/**
 * Leaked tool-call recovery — `message_end` wiring.
 *
 * The pure repair lives in `leaked-tool-call.ts`; this module connects it to
 * Pi's extension lifecycle:
 *
 * - `message_end` → parse + repair + notify (WL-0MW109HU60042BVW AC1/2/4).
 *
 * ## The Pi contract this module depends on (read from Pi's source, not docs)
 *
 * Pi stores the finalised assistant message in agent state *before* emitting
 * `message_end`. `AgentSession._replaceMessageInPlace()` (in
 * `agent-session.js`) copies the message returned by the extension handler
 * onto that stored object, and only then does `agent-loop.js` read
 * `message.content.filter(c => c.type === 'toolCall')` to decide what to
 * execute. Returning a repaired message therefore makes the recovered call
 * execute in the same turn.
 *
 * That behaviour is undocumented and is verified for the repo's pinned
 * `@earendil-works/pi-agent-core` by
 * `leaked-tool-call.execution.test.ts` — the tripwire that fails loudly if a
 * future Pi upgrade stops applying the replacement in place.
 *
 * ## Behaviour
 *
 * - No markup, no mutation, no notification.
 * - A run the user aborted (`interruptibleState.userAborted`) is untouched.
 * - A context without `ui` (deprecated/headless modes) is untouched — the
 *   repair is only applied where the operator can be told about it.
 * - Exactly one `ctx.ui.notify(..., 'warning')` names the recovered call(s).
 * - Replay is idempotent: a repaired message contains no markup, so a second
 *   pass is a no-op.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { interruptibleState } from './retry-command.js';
import {
  repairAssistantMessage,
  type RecoverableAssistantMessage,
  type RepairOutcome,
  type RecoveredToolCall,
} from './leaked-tool-call.js';

/** Notification level used for every recovery (operator visibility, AC5). */
export const RECOVERY_NOTIFY_LEVEL = 'warning' as const;

let _leakedToolCallRecoveryRegistered = false;

/**
 * Register the leaked tool-call recovery handlers.
 *
 * Must be called once during extension initialisation. Idempotent —
 * subsequent calls are no-ops.
 */
export function registerLeakedToolCallRecovery(pi: ExtensionAPI): void {
  if (_leakedToolCallRecoveryRegistered) return;
  _leakedToolCallRecoveryRegistered = true;

  pi.on('message_end', async (event, ctx) => {
    // Contract reminder: returning a repaired message is what makes Pi execute
    // the recovered call in this turn (see the module header). Do not mutate
    // `event.message` here — Pi applies the returned message in place.
    if (interruptibleState.userAborted) return;

    // No UI (deprecated/headless modes): leave the turn exactly as it was.
    if (!ctx || !ctx.ui) return;

    const message = event?.message;
    if (!message || message.role !== 'assistant') return;

    const activeTools = readActiveTools(pi);
    if (activeTools.length === 0) return;

    const outcome = repairAssistantMessage(
      message as unknown as RecoverableAssistantMessage,
      activeTools,
    );
    if (!outcome.repaired) return;

    notifyRecovered(ctx, outcome.recovered);

    return {
      // `MessageEndEventResult` is not re-exported by the package index, so the
      // structurally-correct repaired message is cast at this one boundary.
      message: outcome.message,
    } as any;
  });
}

/**
 * Read the session's active tool names.
 *
 * Returns an empty list when the runtime cannot answer — with no active tools
 * there is nothing safe to execute, so repair is skipped (AC2).
 */
function readActiveTools(pi: ExtensionAPI): string[] {
  try {
    if (typeof pi.getActiveTools !== 'function') return [];
    const tools = pi.getActiveTools();
    return Array.isArray(tools) ? tools.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Tell the operator, exactly once, which calls were recovered.
 *
 * A stale extension context throws when notified; the repair has already been
 * decided, so a failed notification must never break the session (AC5).
 */
function notifyRecovered(
  ctx: ExtensionContext,
  recovered: readonly RecoveredToolCall[],
): void {
  if (recovered.length === 0) return;
  const names = recovered.map((call) => call.name).join(', ');
  const label = recovered.length === 1 ? 'leaked tool call' : 'leaked tool calls';
  try {
    ctx.ui.notify(`Recovered ${label}: ${names} — executing now`, RECOVERY_NOTIFY_LEVEL);
  } catch {
    // Stale ctx after session replacement: the repair still applies.
  }
}
