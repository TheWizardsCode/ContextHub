/**
 * packages/herdr/src/capacity-starvation.ts — continuous-capacity-refusal
 * tracking for the downtime dispatcher (WL-0MVKNC2N50025HXE).
 *
 * The dispatcher NOPs by design when the local LLM has no free capacity: the
 * idle / free-slot / prefill gates refuse the tick and the refusal is written
 * to the decision log. That is correct while it lasts seconds or minutes, but
 * it is SILENT when it lasts hours — the 2026-10-22/23 overnight incident
 * produced one work-item dispatch in nine hours while long-running, still
 * `working` agent panes held every local slot.
 *
 * This module supplies the pure decision half of the fix: a tracker that
 * recognises a CONTINUOUS episode of capacity refusals and reports it once
 * the episode exceeds a configurable window, so the dispatcher can emit a
 * visible `capacity-starved` observation (with the panes holding the model)
 * instead of NOPing invisibly all night.
 *
 * Neutral by construction: the tracker never gates dispatch, never counts as
 * a CLI-error strike, and never changes the existing refusal reasons or
 * header tokens. It is observation only.
 */

/**
 * Default window of CONTINUOUS capacity refusal before a starvation signal is
 * produced. Two hours: long enough that ordinary busy periods and prefill
 * pacing are never reported, short enough that an overnight starvation is
 * visible while an operator can still act on it.
 */
export const DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS = 2 * 60 * 60 * 1000; // 2 h

/** Floor for the starvation window (5 min) — prevents alert storms. */
export const DOWNTIME_CAPACITY_STARVATION_ALERT_FLOOR_MS = 5 * 60 * 1000;

/** Ceiling for the starvation window (24 h) — bounds how long a night can be silent. */
export const DOWNTIME_CAPACITY_STARVATION_ALERT_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Clamp the starvation window to `[5 min, 24 h]`. Non-finite / missing /
 * invalid values fall back to the default (2 h) — a malformed setting can
 * never make the signal silent forever or fire constantly.
 */
export function clampDowntimeCapacityStarvationAlertMs(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS;
  }
  return Math.min(
    Math.max(Math.round(value), DOWNTIME_CAPACITY_STARVATION_ALERT_FLOOR_MS),
    DOWNTIME_CAPACITY_STARVATION_ALERT_MAX_MS,
  );
}

/**
 * The no-dispatch reasons that mean "the local model had no capacity for a
 * new pane". Every one of them is already a blocking refusal in the decision
 * log; the set is deliberately conservative so a non-capacity refusal (a
 * genuine `no-candidate`, a `review-queue-hold`, a `code-freeze`, a `wl-error`)
 * ENDS the episode — capacity was available, so the fleet is not starved.
 *
 * `idle-age-pending` is excluded on purpose: it is a non-blocking observation
 * written when free slots exist but the idle age is still short — capacity is
 * available, so it is not starvation.
 */
export const CAPACITY_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'slots-unavailable',
  'capacity-saturated',
  'slot-owned',
  'proxy-contention',
  'prefill-gate',
  'prefill-cap',
  'prefill-eta',
]);

/** True when a no-dispatch reason represents a local-capacity refusal. */
export function isCapacityRefusal(reason: string): boolean {
  return CAPACITY_REFUSAL_REASONS.has(reason);
}

/**
 * A continuous capacity-starvation episode that has crossed the alert window.
 * Every field is observation data for the decision-log entry.
 */
export interface CapacityStarvationObservation {
  /** Epoch ms of the first capacity refusal in this episode. */
  starvedSince: number;
  /** Length of the episode so far (ms). */
  starvedMs: number;
  /** Capacity refusals observed in this episode (including rate-limited ticks). */
  consecutiveRefusals: number;
  /** The most recent capacity-refusal reason. */
  lastReason: string;
}

/** Live (pre-alert) snapshot of the tracker, for diagnostics/tests. */
export interface CapacityStarvationSnapshot {
  starvedSince: number;
  consecutiveRefusals: number;
  lastReason: string;
}

/**
 * Tracks a continuous episode of capacity refusals.
 *
 * Semantics (all pure, clock injected):
 *
 *  - a capacity refusal extends the episode (starting it on the first one);
 *  - ANY non-capacity reason resets the episode (capacity was available);
 *  - `reset()` clears it explicitly (called on a successful dispatch);
 *  - once the episode is at least `alertWindowMs` old, `observe()` returns an
 *    observation — and re-arms, so a very long outage re-alerts at most once
 *    per window instead of once per tick or once forever.
 *
 * The tracker never mutates dispatch state and never throws: it is safe to
 * feed from the dispatcher's decision-log path (which must never affect the
 * dispatch decision).
 */
export class CapacityStarvationTracker {
  private starvedSince: number | null = null;
  private lastAlertAt: number | null = null;
  private consecutiveRefusals = 0;
  private lastReason = '';
  private alertWindowMs = DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS;

  /**
   * Set the alert window (re-read from settings every tick so a change
   * applies live). Invalid values fall back to the clamped default.
   */
  configure(alertWindowMs: number): void {
    this.alertWindowMs = clampDowntimeCapacityStarvationAlertMs(alertWindowMs);
  }

  /** The currently configured alert window (ms). */
  getAlertWindowMs(): number {
    return this.alertWindowMs;
  }

  /**
   * Feed one no-dispatch decision. Returns an observation when this tick
   * crossed (or re-crossed) the alert window, otherwise `null`.
   */
  observe(reason: string, now: number): CapacityStarvationObservation | null {
    if (!isCapacityRefusal(reason)) {
      // Capacity was available on this tick: the episode is over. A
      // non-capacity refusal is NOT starvation (the backlog/gates decided),
      // so it must not keep an old episode alive.
      this.reset();
      return null;
    }

    this.consecutiveRefusals += 1;
    this.lastReason = reason;
    if (this.starvedSince === null) {
      this.starvedSince = now;
      this.lastAlertAt = null;
    }

    const starvedMs = now - this.starvedSince;
    if (starvedMs < this.alertWindowMs) return null;

    // Re-arm: one alert per window, so a multi-hour outage keeps producing
    // evidence without flooding the (bounded) decision log.
    if (this.lastAlertAt !== null && now - this.lastAlertAt < this.alertWindowMs) {
      return null;
    }
    this.lastAlertAt = now;

    return {
      starvedSince: this.starvedSince,
      starvedMs,
      consecutiveRefusals: this.consecutiveRefusals,
      lastReason: reason,
    };
  }

  /** Clear the episode (successful dispatch, mode change, worker pause). */
  reset(): void {
    this.starvedSince = null;
    this.lastAlertAt = null;
    this.consecutiveRefusals = 0;
    this.lastReason = '';
  }

  /** Current episode snapshot, or `null` when no episode is active. */
  snapshot(): CapacityStarvationSnapshot | null {
    if (this.starvedSince === null) return null;
    return {
      starvedSince: this.starvedSince,
      consecutiveRefusals: this.consecutiveRefusals,
      lastReason: this.lastReason,
    };
  }
}
