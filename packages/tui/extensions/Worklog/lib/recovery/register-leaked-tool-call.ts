/**
 * Leaked tool-call recovery — Pi wiring.
 *
 * The pure repair lives in `leaked-tool-call.ts`; this module connects it to
 * Pi's extension lifecycle:
 *
 * - `message_end` → parse + repair + notify (WL-0MW109HU60042BVW AC1/2/4).
 * - `turn_end` → bounded corrective-continue fallback when the repair handler
 *   could not fix the message (WL-0MW109J84000QJOJ AC1/2/3).
 * - `session_start` → reset the per-session fallback state (AC3/AC4).
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
 * ## Bounded corrective-continue fallback (WL-0MW109J84000QJOJ)
 *
 * When the repair path declines (a truncated parameter, an inactive tool, a
 * missing parameter) nothing is executed and the turn ends, so an unattended
 * session silently stalls. `message_end` therefore records the *missed* calls
 * against the assistant message, and `turn_end` issues exactly one corrective
 * continuation naming them.
 *
 * Bounds — all module state, reset on `session_start`:
 * - one continuation per assistant message (keyed by a content fingerprint, so
 *   a replayed `turn_end` cannot fire twice),
 * - never when that message already produced tool results (a partial repair
 *   executed its call, so the agent loop continues on its own),
 * - never for markup that was only quoted prose, or was already executed as a
 *   duplicate,
 * - at most `LEAKED_TOOL_CALL_CONFIG.sessionCap` continuations per session
 *   (default 5), then exactly one final warning explaining the cap,
 * - never for an aborted run (`interruptibleState.userAborted`).
 *
 * ## Two continuation transports (capability-detected, AC3)
 *
 * Pi ≥1.5 exposes the `turn_end` boundary-result API (`BoundaryResult`):
 * returning `{ entries, continue: true }` appends the corrective
 * `custom_message` and makes Pi run exactly one more turn. The repo's pinned
 * `pi-coding-agent@0.79.10` types no result for `turn_end` (the `on()`
 * signature accepts none), so on that runtime the same corrective text is
 * delivered through the established invisible-continue path
 * (`agent.prompt([...])`, precedent WL-0MSNKWLER003EGE0) once the run settles.
 *
 * The transport is capability-detected from the event shape
 * (`detectBoundaryResultSupport`) and cached for the session: Pi ≥1.5's
 * `TurnEndEvent` extends `BoundaryState` and carries `entries` / `context` /
 * `outcome`, while 0.79.10's carries only `type` / `turnIndex` / `message` /
 * `toolResults`. Detecting the capability rather than a version string keeps
 * one build green on both — no assumption about either API is baked in.
 *
 * ## Behaviour (repair path)
 *
 * - No markup, no mutation, no notification.
 * - A run the user aborted (`interruptibleState.userAborted`) is untouched.
 * - A context without `ui` (deprecated/headless modes) is untouched — the
 *   repair is only applied where the operator can be told about it.
 * - Exactly one `ctx.ui.notify(..., 'warning')` names the recovered call(s).
 * - Replay is idempotent: a repaired message contains no markup, so a second
 *   pass is a no-op.
 * - `LEAKED_TOOL_CALL_CONFIG.enabled` is the capability's master switch.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { executeParseErrorContinue } from './recovery.js';
import { interruptibleState } from './retry-command.js';
import {
  LEAKED_TOOL_CALL_CONFIG,
  MAX_NOTE_ARG_LENGTH,
  repairAssistantMessage,
  type LeakedToolCallSkipReason,
  type ParsedLeakedToolCall,
  type RecoverableAssistantMessage,
  type RecoveredToolCall,
} from './leaked-tool-call.js';

/** Notification level used for every recovery (operator visibility, AC5). */
export const RECOVERY_NOTIFY_LEVEL = 'warning' as const;

/**
 * `custom_message` type of the corrective continuation.
 *
 * Carried by the boundary-result entry (Pi ≥1.5) and, on the invisible-continue
 * transport, by the plain prompt text — one name for the operator to grep.
 */
export const CORRECTIVE_CONTINUATION_CUSTOM_TYPE = 'leaked-tool-call-corrective';

let _leakedToolCallRecoveryRegistered = false;

// ── Live agent capture (invisible-continue transport) ─────────────────

/** The subset of the live Pi agent the invisible-continue branch needs. */
export interface ContinuationAgent {
  prompt(messages: unknown[]): Promise<unknown>;
  waitForIdle?(): Promise<void>;
  /** Agent state, used to check nothing else followed the leaked message. */
  state?: { messages?: unknown[] };
}

let _agent: ContinuationAgent | null = null;

/**
 * Point the invisible-continue transport at the live Pi agent.
 *
 * Called from the `Agent.prototype.subscribe` monkey-patch (the same capture
 * the recovery module uses) and exported so wiring tests can drive the
 * fallback branch without a Pi runtime.
 */
export function setContinuationAgent(agent: ContinuationAgent | null): void {
  _agent = agent;
}

// ── Per-session fallback state ────────────────────────────────────────

/** A leaked call the repair handler declined to reconstruct. */
interface MissedLeakedCall {
  name: string;
  arguments: Record<string, string>;
  reason?: string;
}

interface LeakedToolCallSessionState {
  /** Corrective continuations issued this session. */
  continuations: number;
  /** Fingerprints of assistant messages already corrected (one-shot). */
  continuedMessages: Set<string>;
  /** Whether the cap warning has been shown. */
  capWarned: boolean;
  /** Cached boundary-result capability; `null` until the first `turn_end`. */
  boundaryResultSupported: boolean | null;
  /** Missed calls per assistant-message fingerprint, awaiting `turn_end`. */
  missedByMessage: Map<string, MissedLeakedCall[]>;
}

function freshSessionState(): LeakedToolCallSessionState {
  return {
    continuations: 0,
    continuedMessages: new Set(),
    capWarned: false,
    boundaryResultSupported: null,
    missedByMessage: new Map(),
  };
}

let _session: LeakedToolCallSessionState = freshSessionState();

// ── Registration ──────────────────────────────────────────────────────

/**
 * Register the leaked tool-call recovery handlers.
 *
 * Must be called once during extension initialisation. Idempotent —
 * subsequent calls are no-ops.
 */
export function registerLeakedToolCallRecovery(pi: ExtensionAPI): void {
  if (_leakedToolCallRecoveryRegistered) return;
  _leakedToolCallRecoveryRegistered = true;

  captureAgentInstance();

  pi.on(
    'message_end',
    safeHandler(async (event, ctx) => {
      // Contract reminder: returning a repaired message is what makes Pi execute
      // the recovered call in this turn (see the module header). Do not mutate
      // `event.message` here — Pi applies the returned message in place.
      if (!LEAKED_TOOL_CALL_CONFIG.enabled) return;
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

      // Remember what could not be fixed so `turn_end` can point the model at
      // it. Recorded against the *post-repair* content: Pi replaces the
      // finalised message in place, so that is what `turn_end` carries.
      const missed = missedCallsOf(outcome.skipped);
      if (missed.length > 0) {
        _session.missedByMessage.set(fingerprintMessage(outcome.message), missed);
      }

      if (!outcome.repaired) return;

      notifyRecovered(ctx, outcome.recovered);

      return {
        // `MessageEndEventResult` is not re-exported by the package index, so the
        // structurally-correct repaired message is cast at this one boundary.
        message: outcome.message,
      } as any;
    }),
  );

  // The pinned SDK types `turn_end` without a result type; Pi ≥1.5 consumes a
  // `BoundaryResult` here, so the handler is cast at this one boundary.
  pi.on(
    'turn_end',
    safeHandler(async (event, ctx) => handleTurnEnd(event, ctx)) as any,
  );

  pi.on('session_start', async () => {
    // Fresh session (or a replaced/reloaded one): forget the cap counter, the
    // per-message one-shot set, the cached capability and pending skips.
    _session = freshSessionState();
  });
}

// ── turn_end: bounded corrective continue ─────────────────────────────

/**
 * Decide, and issue, the single corrective continuation for a missed leak.
 *
 * Returns the boundary result on the boundary-result transport, `undefined`
 * everywhere else (including every guard that declines the fallback).
 */
async function handleTurnEnd(
  event: any,
  ctx: ExtensionContext | undefined,
): Promise<unknown> {
  if (!LEAKED_TOOL_CALL_CONFIG.enabled) return undefined;
  if (interruptibleState.userAborted) return undefined;

  const message = event?.message;
  if (!message || message.role !== 'assistant') return undefined;

  const key = fingerprintMessage(message);
  const missed = _session.missedByMessage.get(key);
  // No record: the repair handler either fixed the message or had nothing to
  // fix (markup-free, quoted prose, or an already-executed duplicate).
  if (!missed || missed.length === 0) return undefined;
  // One continuation per assistant message — a replayed boundary never fires twice.
  if (_session.continuedMessages.has(key)) return undefined;

  const toolResults = Array.isArray(event?.toolResults) ? event.toolResults : [];
  // A partial repair executed its recovered call; the loop carries on and a
  // correction would race the model's own next step.
  if (toolResults.length > 0) return undefined;

  const cap = LEAKED_TOOL_CALL_CONFIG.sessionCap;
  if (_session.continuations >= cap) {
    if (!_session.capWarned) {
      _session.capWarned = true;
      safeNotify(
        ctx,
        `Leaked tool-call recovery cap reached (${cap} corrective continuations per session) — ` +
          `not continuing again: ${describeCalls(missed)}`,
      );
    }
    return undefined;
  }

  // Book-keeping before any transport, so a replay can never fire twice.
  _session.continuations += 1;
  _session.continuedMessages.add(key);
  _session.missedByMessage.delete(key);

  const correctiveText = buildCorrectiveContinuationText(missed);
  safeNotify(
    ctx,
    `Leaked ${missed.length === 1 ? 'tool call' : 'tool calls'} could not be repaired — ` +
      `issuing one corrective continuation: ${describeCalls(missed)}`,
  );

  if (supportsBoundaryResult(event)) {
    return {
      entries: [
        {
          type: 'custom_message',
          customType: CORRECTIVE_CONTINUATION_CUSTOM_TYPE,
          content: correctiveText,
          // Advisory only: the operator already has the warning notification.
          display: false,
        },
      ],
      continue: true,
    };
  }

  // Invisible-continue transport. Deferred so this turn boundary returns before
  // the agent is asked to continue: awaiting `waitForIdle` inside `turn_end`
  // would deadlock the loop this handler runs in.
  setTimeout(() => {
    void continueInvisibly(correctiveText, key);
  }, 0);
  return undefined;
}

/**
 * Deliver the corrective continuation through the invisible-continue path.
 *
 * `agent.prompt([...])` after the run settles is the established mechanism
 * (precedent WL-0MSNKWLER003EGE0, via the shared single-shot helper). Skipped
 * when the user aborted, the session changed, or the agent already moved past
 * the leaked message — re-prompting then would re-issue a call the model may
 * have made itself.
 */
async function continueInvisibly(text: string, key: string): Promise<void> {
  const agent = _agent;
  if (!agent || typeof agent.prompt !== 'function') return;

  const generation = interruptibleState.sessionGeneration;
  await executeParseErrorContinue({
    waitForIdle: () =>
      typeof agent.waitForIdle === 'function' ? agent.waitForIdle() : Promise.resolve(),
    sendContinue: () => agent.prompt([text]),
    shouldAbort: () =>
      interruptibleState.userAborted ||
      interruptibleState.sessionGeneration !== generation ||
      !isLastAgentMessage(agent, key),
  });
}

/**
 * Is the leaked assistant message still the agent's last message?
 *
 * `true` when the agent exposes no message state (the drift cannot be
 * observed, and the one-shot and session-cap bounds already limit the
 * fallback).
 */
function isLastAgentMessage(agent: ContinuationAgent, key: string): boolean {
  const messages = agent.state?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return true;
  const last = messages[messages.length - 1] as RecoverableAssistantMessage;
  return last?.role === 'assistant' && fingerprintMessage(last) === key;
}

// ── Capability detection ──────────────────────────────────────────────

/**
 * Does the running Pi expose the `turn_end` boundary-result API?
 *
 * Probed once per session from the event shape (cached): Pi ≥1.5's
 * `TurnEndEvent` extends `BoundaryState`, while 0.79.10's carries no boundary
 * fields at all. See the module header for why this is a runtime capability
 * probe rather than a version check.
 */
export function detectBoundaryResultSupport(event: any): boolean {
  return Boolean(
    event &&
      typeof event === 'object' &&
      Array.isArray(event.entries) &&
      event.context &&
      typeof event.context === 'object' &&
      typeof event.context.canContinue === 'boolean',
  );
}

function supportsBoundaryResult(event: any): boolean {
  if (_session.boundaryResultSupported === null) {
    _session.boundaryResultSupported = detectBoundaryResultSupport(event);
  }
  return _session.boundaryResultSupported;
}

// ── Corrective text ───────────────────────────────────────────────────

/**
 * The corrective text: the settings prompt plus one line naming every missed
 * call as `name(firstArgument=value)`.
 */
function buildCorrectiveContinuationText(missed: readonly MissedLeakedCall[]): string {
  const label = missed.length === 1 ? 'Missed call' : 'Missed calls';
  return `${LEAKED_TOOL_CALL_CONFIG.correctiveContinuationPrompt} ${label}: ${describeCalls(missed)}.`;
}

function describeCalls(missed: readonly MissedLeakedCall[]): string {
  return missed.map(formatMissedCall).join(', ');
}

/**
 * `name(firstArgument=value)` for readability, truncated to
 * `MAX_NOTE_ARG_LENGTH` — the same bound the repair note uses, so the
 * corrective text can never balloon with a pasted file body.
 */
function formatMissedCall(call: MissedLeakedCall): string {
  const [key, value] = Object.entries(call.arguments)[0] ?? [];
  if (key === undefined || value === undefined) return call.name;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  const truncated =
    collapsed.length <= MAX_NOTE_ARG_LENGTH
      ? collapsed
      : `${collapsed.slice(0, MAX_NOTE_ARG_LENGTH - 1)}…`;
  return `${call.name}(${key}=${truncated})`;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * The calls the repair handler refused to reconstruct.
 *
 * Excluded, because none of them is a *missed* call that a continuation could
 * help with:
 * - `duplicate` — the identical call already executes as a structured call;
 * - `quoted` — prose about markup (docs, READMEs, tests), not a leak;
 * - `unrepairable-stop-reason` — the message was cut off (`length`) or already
 *   failed (`error`/`aborted`); the compaction/continue machinery in
 *   `register-recovery.ts` owns that message and a second prompt would race it.
 */
function missedCallsOf(skipped: readonly ParsedLeakedToolCall[]): MissedLeakedCall[] {
  const ignored: readonly (LeakedToolCallSkipReason | undefined)[] = [
    'duplicate',
    'quoted',
    'unrepairable-stop-reason',
  ];
  return skipped
    .filter((call) => !ignored.includes(call.reason))
    .map((call) => ({
      name: call.name,
      arguments: { ...call.arguments },
      ...(call.reason ? { reason: call.reason } : {}),
    }));
}

/**
 * Stable fingerprint of an assistant message's content.
 *
 * Pi replaces the finalised message *in place*, so `turn_end` carries the
 * post-repair content: fingerprinting content (not object identity) matches a
 * skip record to the message that produced it on both Pi versions.
 */
function fingerprintMessage(message: RecoverableAssistantMessage): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .map((block) => {
      if (block?.type === 'text') {
        return `text:${String((block as { text?: unknown }).text ?? '')}`;
      }
      if (block?.type === 'toolCall') {
        return `toolCall:${String((block as { id?: unknown }).id ?? '')}`;
      }
      return block?.type ?? 'unknown';
    })
    .join('\u0000');
}

/** Handler shape used by {@link safeHandler}. */
type Handler = (event: any, ctx: any) => Promise<any> | any;

/**
 * Never let a parser/notify/handler exception break the session: the turn
 * simply ends as it would without the extension (AC5).
 */
function safeHandler(handler: Handler): Handler {
  return async (event, ctx) => {
    try {
      return await handler(event, ctx);
    } catch {
      return undefined;
    }
  };
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
  safeNotify(ctx, `Recovered ${label}: ${names} — executing now`);
}

/**
 * Dispatch a warning notification, swallowing a stale-ctx throw.
 *
 * The house pattern for every handler that carries a `ctx`: after a session
 * replacement the reference throws, and a notification is never worth breaking
 * the turn for.
 */
function safeNotify(ctx: ExtensionContext | undefined, message: string): void {
  try {
    ctx?.ui?.notify(message, RECOVERY_NOTIFY_LEVEL);
  } catch {
    // Stale ctx after session replacement: the recovery still applies.
  }
}

// ── Agent capture ─────────────────────────────────────────────────────

/**
 * Capture the live agent instance for the invisible-continue transport.
 *
 * The same `Agent.prototype.subscribe` patch the recovery module installs:
 * `subscribe()` runs during `AgentSession` construction, so the instance is
 * captured on fresh sessions and resumes alike. Chaining is safe — the
 * recovery module's wrapper (registered first) still runs. `require` keeps the
 * dependency optional: without it this branch no-ops and Pi ≥1.5 uses the
 * boundary-result transport anyway.
 */
function captureAgentInstance(): void {
  try {
    const { Agent } = require('@earendil-works/pi-agent-core') as any;
    if (typeof Agent !== 'function' || !Agent.prototype) return;

    const originalSubscribe = Agent.prototype.subscribe;
    if (typeof originalSubscribe !== 'function') return;

    Agent.prototype.subscribe = function (this: ContinuationAgent, ...args: unknown[]) {
      setContinuationAgent(this);
      return originalSubscribe.apply(this, args);
    };
  } catch {
    // Agent not available in this environment (e.g. unit tests).
  }
}
