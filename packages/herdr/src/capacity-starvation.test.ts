/**
 * packages/herdr/src/capacity-starvation.test.ts — unit tests for the pure
 * continuous capacity-refusal tracker (WL-0MVKNC2N50025HXE AC3).
 *
 * The tracker recognises a run of capacity-flagged dispatch refusals and
 * reports it once the episode has outlasted the configured window, so a long
 * saturated night logs a `capacity-starved` observation instead of silently
 * NOPing. It is observation only — it never gates dispatch, never strikes,
 * and never changes the underlying refusal reasons.
 */

import { describe, it, expect } from 'vitest';
import {
  CapacityStarvationTracker,
  clampDowntimeCapacityStarvationAlertMs,
  isCapacityRefusal,
  DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS,
  DOWNTIME_CAPACITY_STARVATION_ALERT_FLOOR_MS,
  DOWNTIME_CAPACITY_STARVATION_ALERT_MAX_MS,
  CAPACITY_REFUSAL_REASONS,
} from './capacity-starvation.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');

describe('isCapacityRefusal (WL-0MVKNC2N50025HXE)', () => {
  it('recognises every local-capacity refusal reason', () => {
    for (const reason of CAPACITY_REFUSAL_REASONS) {
      expect(isCapacityRefusal(reason)).toBe(true);
    }
  });

  it('does not treat non-capacity outcomes or observations as capacity refusals', () => {
    for (const reason of ['no-candidate', 'review-queue-hold', 'code-freeze', 'wl-error',
      'audit-in-flight', 'audit-host-saturated', 'idle-age-pending', 'idle-age-qualified',
      'audit-batch-continue', 'audit-batch-end', 'stalled-resume', 'capacity-starved']) {
      expect(isCapacityRefusal(reason)).toBe(false);
    }
  });

  it('`capacity-starved` is never itself a capacity refusal (no feedback loop)', () => {
    expect(isCapacityRefusal('capacity-starved')).toBe(false);
  });
});

describe('clampDowntimeCapacityStarvationAlertMs', () => {
  it('clamps to the supported [5 min, 24 h] range', () => {
    expect(clampDowntimeCapacityStarvationAlertMs(1)).toBe(DOWNTIME_CAPACITY_STARVATION_ALERT_FLOOR_MS);
    expect(clampDowntimeCapacityStarvationAlertMs(1000 * 60 * 60 * 1000)).toBe(
      DOWNTIME_CAPACITY_STARVATION_ALERT_MAX_MS,
    );
    expect(clampDowntimeCapacityStarvationAlertMs(10 * 60 * 1000)).toBe(10 * 60 * 1000);
  });

  it('falls back to the default on non-finite/invalid values', () => {
    expect(clampDowntimeCapacityStarvationAlertMs(Number.NaN)).toBe(
      DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS,
    );
    expect(clampDowntimeCapacityStarvationAlertMs(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS,
    );
  });
});

describe('CapacityStarvationTracker.observe (WL-0MVKNC2N50025HXE AC3)', () => {
  const WINDOW = 5 * 60 * 1000; // floor

  it('does not alert on an isolated refusal (episode shorter than the window)', () => {
    const tracker = new CapacityStarvationTracker();
    tracker.configure(WINDOW);
    expect(tracker.observe('capacity-saturated', NOW)).toBeNull();
    expect(tracker.observe('capacity-saturated', NOW + 60_000)).toBeNull();
  });

  it('alerts once the CONTINUOUS episode crosses the window, with episode evidence', () => {
    const tracker = new CapacityStarvationTracker();
    tracker.configure(WINDOW);
    expect(tracker.snapshot()).toBeNull();
    expect(tracker.observe('capacity-saturated', NOW)).toBeNull();
    const alert = tracker.observe('capacity-saturated', NOW + WINDOW + 1);
    expect(alert).toEqual({
      starvedSince: NOW,
      starvedMs: WINDOW + 1,
      consecutiveRefusals: 2,
      lastReason: 'capacity-saturated',
    });
  });

  it('re-arms so a very long outage alerts at most once per window, not once per tick', () => {
    const tracker = new CapacityStarvationTracker();
    tracker.configure(WINDOW);
    tracker.observe('capacity-saturated', NOW);
    const first = tracker.observe('capacity-saturated', NOW + WINDOW + 1);
    expect(first).not.toBeNull();
    // Within the next window: suppressed (no repeated alert per tick).
    expect(
      tracker.observe('capacity-saturated', NOW + WINDOW + 1 + 60_000),
    ).toBeNull();
    // After another full window: the signal re-fires with an updated episode
    // length and the accumulated refusal count (rate-limited ticks included).
    const second = tracker.observe('capacity-saturated', NOW + 2 * WINDOW + 60_000);
    expect(second).not.toBeNull();
    expect(second!.consecutiveRefusals).toBe(4);
    expect(second!.starvedSince).toBe(NOW);
  });

  it('tracks whatever capacity reason repeats in the episode', () => {
    const tracker = new CapacityStarvationTracker();
    tracker.configure(WINDOW);
    tracker.observe('prefill-cap', NOW);
    const alert = tracker.observe('slots-unavailable', NOW + WINDOW + 1);
    expect(alert!.lastReason).toBe('slots-unavailable');
    expect(alert!.consecutiveRefusals).toBe(2);
  });

  it('ends the episode on a NON-capacity outcome (capacity was available)', () => {
    const tracker = new CapacityStarvationTracker();
    tracker.configure(WINDOW);
    tracker.observe('capacity-saturated', NOW);
    tracker.observe('capacity-saturated', NOW + 60_000);
    // A genuine no-candidate resets: the tick was NOT starved for capacity.
    expect(tracker.observe('no-candidate', NOW + 90_000)).toBeNull();
    expect(tracker.snapshot()).toBeNull();
    // After the interlude a fresh run must re-accumulate from scratch.
    expect(tracker.observe('capacity-saturated', NOW + 90_000 + 1)).toBeNull();
    const alert = tracker.observe('capacity-saturated', NOW + 90_000 + WINDOW + 1);
    expect(alert).not.toBeNull();
    expect(alert!.starvedSince).toBe(NOW + 90_000 + 1);
    expect(alert!.consecutiveRefusals).toBe(2);
  });

  it('reset() clears an in-flight episode and the last-alert latch', () => {
    const tracker = new CapacityStarvationTracker();
    tracker.configure(WINDOW);
    tracker.observe('capacity-saturated', NOW);
    tracker.observe('capacity-saturated', NOW + WINDOW + 1); // alert latched
    tracker.reset();
    expect(tracker.snapshot()).toBeNull();
    // A fresh episode must alert again after a full fresh window.
    expect(tracker.observe('capacity-saturated', NOW + WINDOW + 2)).toBeNull();
    expect(
      tracker.observe('capacity-saturated', NOW + WINDOW + 2 + WINDOW + 1),
    ).not.toBeNull();
  });

  it('configure() clamps the window and a non-finite value falls back to the default', () => {
    const tracker = new CapacityStarvationTracker();
    tracker.configure(Number.NaN);
    expect(tracker.getAlertWindowMs()).toBe(DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS);
    tracker.configure(1);
    expect(tracker.getAlertWindowMs()).toBe(DOWNTIME_CAPACITY_STARVATION_ALERT_FLOOR_MS);
  });
});
