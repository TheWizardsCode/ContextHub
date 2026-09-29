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
}

/**
 * The classification decision for one session.
 */
export interface CloseDecision {
  /** Whether the pane should be closed. */
  close: boolean;
  /** Stable machine-readable reason code. */
  reasonCode: string;
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
 *  5. Idle beyond threshold — agent alive but not responding (only when
 *     threshold > 0).
 *  6. Still active (within threshold, agent alive).
 */
export function classifySession(
  sample: SessionSample,
  opts?: { idleThresholdMs?: number; gracePeriodMs?: number },
): CloseDecision {
  const threshold = opts?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const gracePeriodMs = opts?.gracePeriodMs ?? 0;

  // 1. Never-close guards (highest precedence).
  if (sample.kind === 'implement') {
    return { close: false, reasonCode: 'implement' };
  }
  if (sample.needsProducerReview) {
    return { close: false, reasonCode: 'producer-review' };
  }
  if (sample.isInvokingPane) {
    return { close: false, reasonCode: 'invoking-pane' };
  }
  if (sample.childProcessCount > 0) {
    return { close: false, reasonCode: 'live-children' };
  }

  // 2. Grace period (parent AC5): a pane younger than (or exactly at) the
  //    grace window is never eligible for close, regardless of marker, idle
  //    or dead-agent state. An unknown age (`undefined`/non-finite) cannot be
  //    compared, so the guard does not apply.
  if (
    gracePeriodMs > 0 &&
    typeof sample.ageSinceDispatchMs === 'number' &&
    Number.isFinite(sample.ageSinceDispatchMs) &&
    sample.ageSinceDispatchMs <= gracePeriodMs
  ) {
    return { close: false, reasonCode: 'grace-period' };
  }

  // 3. Marker at end of final assistant message.
  if (typeof sample.lastAssistantText === 'string' && endsWithMarker(sample.lastAssistantText)) {
    return { close: true, reasonCode: 'marker' };
  }

  // 4. Dead agent — the process is gone; operator may still need to read
  //    the final output. No close.
  if (!sample.agentProcessAlive) {
    return { close: false, reasonCode: 'dead-agent' };
  }

  // 5. Idle threshold — only reap when the threshold is positive.
  if (threshold > 0 && sample.idleMs > threshold) {
    return { close: true, reasonCode: 'idle-threshold' };
  }

  // 6. Still active.
  return { close: false, reasonCode: 'active' };
}
