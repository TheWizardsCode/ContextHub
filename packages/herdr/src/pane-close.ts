/**
 * packages/herdr/src/pane-close.ts — Shared pane-closure classifier
 *
 * Pure logic module that decides, for one session/pane, whether it should be
 * programmatically closed by the scheduled reaper or the pane-triage skill.
 *
 * This classifier is the single source of truth consumed by both mechanisms
 * (parent AC6): the automatic out-of-process reaper and the
 * `pane-triage` skill (`WL-0MUJMXVPO0016DZM`).
 *
 * Design precedent: mirrors the pure-classifier approach of
 * `packages/herdr/src/pane-lifecycle.ts` — no filesystem, no herdr, no wl.
 *
 * Classification outcomes:
 *  - `marker`        — the final assistant message ends with `</end_session>`
 *  - `dead-agent`     — the agent process is gone (crashed / killed) — no close;
 *    operator may need to read final output.
 *  - `idle-threshold` — the agent is alive but idle beyond the threshold
 *    (disabled when threshold ≤ 0)
 *  - `active`         — still working / within threshold (no close)
 *  - `implement`      — never close an implement pane (AC4)
 *  - `producer-review` — awaiting producer input (never auto-close)
 *  - `invoking-pane`  — the pane that launched the session (never auto-close)
 *  - `live-children`  — has spawned children that must not be orphaned (AC5)
 *  - `grace-period`   — within the configured grace window since first
 *    dispatch (never auto-close; parent AC5)
 */

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Default idle threshold: 30 minutes in milliseconds.
 * Overridable via options passed to `classifySession`.
 * A value of `<= 0` means "never close on idle" (handled by the caller).
 */
export const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * herdr `agent_status` values that mean the agent is actively working
 * (parent AC3). A pane reporting one of these is kept open by the
 * activity guard even when its idle time exceeds the threshold: an agent
 * can be silent-for-a-while yet busy (long-running tool call, model
 * thinking) and must not be reaped.
 */
const ACTIVE_AGENT_STATUSES = new Set(['work', 'working', 'busy', 'running']);

// ── Types ─────────────────────────────────────────────────────────────

/**
 * The session characteristics needed for classification. All fields are
 * optional / tolerant so a partially resolved session never throws.
 */
export interface SessionSample {
  /** The concatenated text of the final assistant message, rstrip-ed. */
  lastAssistantText?: string;
  /** Whether the agent process is currently alive. */
  agentProcessAlive: boolean;
  /** Idle time in milliseconds (time since last activity). */
  idleMs: number;
  /** Work-item stage at decision time, when known (logging snapshot). */
  itemStage?: string;
  /** Pane kind — determines which close policies apply. */
  kind: 'plan' | 'intake' | 'audit' | 'risk-effort' | 'implement' | 'unknown';
  /** Whether the work item has needsProducerReview set. */
  needsProducerReview: boolean;
  /** Whether this pane is the invoking / current operator pane. */
  isInvokingPane: boolean;
  /** Number of child processes spawned by this session. */
  childProcessCount: number;
  /**
   * Age since the pane's first dispatch, in milliseconds. Optional and
   * tolerant: when absent (unknown) the grace-period guard cannot apply and
   * the pane is classified by the remaining rules.
   */
  ageSinceDispatchMs?: number;
  /**
   * Active-agent signal (parent AC3): the pane shows recent file
   * modifications. Optional/tolerant: absent or `false` = no activity.
   */
  hasRecentFileModifications?: boolean;
  /**
   * Active-agent signal (parent AC3): the pane has active network
   * connections. Optional/tolerant: absent or `false` = no activity.
   */
  hasActiveNetworkConnections?: boolean;
  /**
   * Raw herdr agent status (`idle`, `work`, `done`, `unknown`, …), when
   * known. Used both for the logging snapshot and as an activity signal
   * (parent AC3): a `work`-class status keeps the pane open.
   */
  agentStatus?: string;
}

/**
 * The full state snapshot captured with every close decision (parent AC6 /
 * WL-0MUMM5M22006HDPY AC4.1). Every field is derived from the input sample and
 * options, so a decision can be explained after the fact from the log alone.
 * `undefined` optional fields are omitted by JSON serialisation.
 */
export interface CloseReasonSnapshot {
  /** Pane kind at decision time. */
  kind: string;
  /** Whether the agent process was alive at decision time. */
  agentProcessAlive: boolean;
  /** Idle duration in milliseconds at decision time. */
  idleMs: number;
  /** Work-item stage, when known. */
  itemStage?: string;
  /** Whether the item needs producer review. */
  needsProducerReview: boolean;
  /** Whether this pane is the invoking / current operator pane. */
  isInvokingPane: boolean;
  /** Number of live child processes. */
  childProcessCount: number;
  /** Recent file-modification activity signal. */
  hasRecentFileModifications?: boolean;
  /** Active network-connection activity signal. */
  hasActiveNetworkConnections?: boolean;
  /** Raw herdr agent status at decision time, when known. */
  agentStatus?: string;
  /** Pane age since first dispatch (ms), when known. */
  ageSinceDispatchMs?: number;
  /** Configured grace period (ms); `0` = disabled. */
  gracePeriodMs: number;
  /** Whether the pane is within the grace window. */
  withinGracePeriod: boolean;
  /** Configured idle threshold (ms). */
  idleThresholdMs: number;
}

/**
 * The classification decision for one session.
 */
export interface CloseDecision {
  /** Whether the pane should be closed. */
  close: boolean;
  /** Stable machine-readable reason code. */
  reasonCode: string;
  /**
   * Full state snapshot explaining the decision (parent AC6 / AC4.1).
   * `classifySession` populates this for every outcome; it is optional so
   * hand-built decisions and legacy persisted rows remain valid.
   */
  reasonSnapshot?: CloseReasonSnapshot;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract the `.rstrip()`-ed concatenated text of the final assistant
 * message from a list of session entries.
 *
 * Returns `''` when there is no assistant message, so callers do not need
 * null guards.
 */
export function extractFinalAssistantText(
  entries: { type?: string; text?: string }[],
): string {
  let lastAssistant: string | undefined;
  for (const entry of entries) {
    if (entry.type === 'assistant' && typeof entry.text === 'string') {
      lastAssistant = entry.text;
    }
  }
  return typeof lastAssistant === 'string' ? lastAssistant.trimEnd() : '';
}

/**
 * Check whether a string ends with the `</end_session>` marker after
 * `.rstrip()`-ing trailing whitespace.
 */
function endsWithMarker(text: string): boolean {
  return text.trimEnd().endsWith('</end_session>');
}

// ── Classification ────────────────────────────────────────────────────

/**
 * Classify one session into a close decision. The never-close guards
 * (`implement`, `needsProducerReview`, invoking pane, live children) take
 * precedence over the marker, idle, and dead-agent paths (parent AC3, AC4).
 *
 * Classification order (first match wins):
 *  1. Never-close guards (in order: implement, producer-review, invoking-pane, live-children)
 *  2. Grace period — no pane is eligible for close within `gracePeriodMs` of
 *     its first dispatch (parent AC5)
 *  3. Marker at end of final assistant message
 *  4. Dead agent — the process is gone (no close; operator may need to read
 *     final output).
 *  5. Active-agent signals — recent file modifications or active network
 *     connections keep the pane open (`active`), even when idleMs exceeds
 *     the threshold (parent AC3).
 *  6. Idle beyond threshold — agent alive but not responding (only when
 *     threshold > 0).
 *  7. Still active (within threshold, agent alive).
 */
export function classifySession(
  sample: SessionSample,
  opts?: { idleThresholdMs?: number; gracePeriodMs?: number },
): CloseDecision {
  const threshold = opts?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const gracePeriodMs = opts?.gracePeriodMs ?? 0;
  const age = sample.ageSinceDispatchMs;
  const withinGracePeriod =
    gracePeriodMs > 0 &&
    typeof age === 'number' &&
    Number.isFinite(age) &&
    age <= gracePeriodMs;

  // Full state snapshot (parent AC6 / AC4.1): attached to every decision so
  // the reason can be reconstructed from the log alone.
  const agentStatus =
    typeof sample.agentStatus === 'string' ? sample.agentStatus : undefined;
  const reasonSnapshot: CloseReasonSnapshot = {
    kind: sample.kind,
    agentProcessAlive: sample.agentProcessAlive === true,
    idleMs: typeof sample.idleMs === 'number' && Number.isFinite(sample.idleMs) ? sample.idleMs : 0,
    itemStage: typeof sample.itemStage === 'string' ? sample.itemStage : undefined,
    needsProducerReview: sample.needsProducerReview === true,
    isInvokingPane: sample.isInvokingPane === true,
    agentStatus,
    childProcessCount:
      typeof sample.childProcessCount === 'number' && Number.isFinite(sample.childProcessCount)
        ? sample.childProcessCount
        : 0,
    hasRecentFileModifications: sample.hasRecentFileModifications === true,
    hasActiveNetworkConnections: sample.hasActiveNetworkConnections === true,
    ageSinceDispatchMs: typeof age === 'number' && Number.isFinite(age) ? age : undefined,
    gracePeriodMs,
    withinGracePeriod,
    idleThresholdMs: threshold,
  };

  const decide = (close: boolean, reasonCode: string): CloseDecision => ({
    close,
    reasonCode,
    reasonSnapshot,
  });

  // 1. Never-close guards (highest precedence).
  if (sample.kind === 'implement') {
    return decide(false, 'implement');
  }
  if (sample.needsProducerReview) {
    return decide(false, 'producer-review');
  }
  if (sample.isInvokingPane) {
    return decide(false, 'invoking-pane');
  }
  if (sample.childProcessCount > 0) {
    return decide(false, 'live-children');
  }

  // 2. Grace period (parent AC5): a pane younger than (or exactly at) the
  //    grace window is never eligible for close, regardless of marker, idle
  //    or dead-agent state. An unknown age (`undefined`/non-finite) cannot be
  //    compared, so the guard does not apply.
  if (withinGracePeriod) {
    return decide(false, 'grace-period');
  }

  // 3. Marker at end of final assistant message.
  if (typeof sample.lastAssistantText === 'string' && endsWithMarker(sample.lastAssistantText)) {
    return decide(true, 'marker');
  }

  // 4. Dead agent — the process is gone; operator may still need to read
  //    the final output. No close.
  if (!sample.agentProcessAlive) {
    return decide(false, 'dead-agent');
  }

  // 5. Active-agent signals (parent AC3): a pane showing recent file or
  //    network activity, or reporting a `work`-class agent status, is still
  //    working even when its idle time exceeds the threshold. This guards the
  //    idle-threshold path only — an explicit `</end_session>` marker (above)
  //    still closes the pane.
  if (
    sample.hasRecentFileModifications === true ||
    sample.hasActiveNetworkConnections === true ||
    (agentStatus !== undefined && ACTIVE_AGENT_STATUSES.has(agentStatus.toLowerCase()))
  ) {
    return decide(false, 'active');
  }

  // 6. Idle threshold — only reap when the threshold is positive.
  if (threshold > 0 && sample.idleMs > threshold) {
    return decide(true, 'idle-threshold');
  }

  // 7. Still active.
  return decide(false, 'active');
}
