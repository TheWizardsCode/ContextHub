/**
 * packages/herdr/src/downtime-worker.clamps.ts — the ten `clampDowntime*`
 * settings clamps.
 *
 * Single responsibility: clamp the downtime settings (poll interval, idle
 * threshold, free slots, cooldowns, windows, attempts, batch size) to
 * their hard floors/ceiling.
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * promised deliverable of WL-0MVLIHXD1004L0UO, falsely marked complete —
 * landed via WL-0MVN6UUEH009GID8). No behaviour change.
 */

import {
  DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  DOWNTIME_IDLE_THRESHOLD_FLOOR_MS,
  DOWNTIME_LONG_RUNNING_THRESHOLD_FLOOR_MS,
  DOWNTIME_LONG_RUNNING_THRESHOLD_MAX_MS,
  DOWNTIME_MAX_ATTEMPTS_MIN,
  DOWNTIME_MAX_ATTEMPTS_MAX,
  DOWNTIME_AUDIT_BATCH_MAX_MIN,
  DOWNTIME_AUDIT_BATCH_MAX_MAX,
  DOWNTIME_MARKER_STALE_WINDOW_FLOOR_MS,
  DOWNTIME_MARKER_STALE_WINDOW_MAX_MS,
  DOWNTIME_NON_TERMINAL_COOLDOWN_FLOOR_MS,
  DOWNTIME_NON_TERMINAL_COOLDOWN_MAX_MS,
  DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS,
  DOWNTIME_POLL_INTERVAL_FLOOR_MS,
  MAX_DOWNTIME_STALL_THRESHOLD_MS,
  MIN_DOWNTIME_STALL_THRESHOLD_MS
} from './downtime-worker.constants.js';

/**
 * Clamp the long-running progress window to `[1 h, 48 h]`. Non-finite /
 * missing / invalid values fall back to the default (3 h).
 */
export function clampDowntimeLongRunningThresholdMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS;
  return Math.min(
    Math.max(Math.round(value), DOWNTIME_LONG_RUNNING_THRESHOLD_FLOOR_MS),
    DOWNTIME_LONG_RUNNING_THRESHOLD_MAX_MS,
  );
}
// ── Settings clamps (implemented — wired into settings.ts by F2) ──────

/**
 * Clamp the downtime poll interval: never below the 10s hard floor, default
 * 10s for non-finite input (matches DEFAULT_DOWNTIME_POLL_INTERVAL_MS; the
 * spec's '30s proxy poll' refers to the 30s proxy status refresh).
 */
export function clampDowntimePollInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DOWNTIME_POLL_INTERVAL_MS;
  return Math.max(Math.round(value), DOWNTIME_POLL_INTERVAL_FLOOR_MS);
}
/**
 * Clamp the idle threshold: reject negative/non-finite (fall back to the
 * 75s default, DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS) and floor at 1s to
 * prevent immediate dispatch.
 */
export function clampDowntimeIdleThresholdMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS;
  return Math.max(Math.round(value), DOWNTIME_IDLE_THRESHOLD_FLOOR_MS);
}
/**
 * Clamp the required-free-slots count: a non-negative integer; 0 = all
 * slots. Negative/non-finite input falls back to 0 (all slots, the
 * strictest safe default).
 */
export function clampDowntimeRequiredFreeSlots(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS;
  return Math.round(value);
}
/**
 * Clamp the no-candidate cooldown: reject negative/non-finite (fall back to
 * the 60-minute default) and floor at 60s so the pause cannot be disabled or
 * set trivially small (WL-0MSI7DQL10016QYX).
 */
export function clampDowntimeNoCandidateCooldownMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS;
  return Math.max(Math.round(value), DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS);
}
/**
 * Clamp the non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5): reject
 * negative/non-finite (fall back to the 30-minute default) and clamp to
 * [DOWNTIME_NON_TERMINAL_COOLDOWN_FLOOR_MS,
 * DOWNTIME_NON_TERMINAL_COOLDOWN_MAX_MS] (1 minute – 24 hours) so the control
 * can neither be disabled/trivially small (immediate retry) nor set so large
 * that a repeatedly-failing item is stranded.
 */
export function clampDowntimeNonTerminalCooldownMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS;
  return Math.min(
    Math.max(Math.round(value), DOWNTIME_NON_TERMINAL_COOLDOWN_FLOOR_MS),
    DOWNTIME_NON_TERMINAL_COOLDOWN_MAX_MS,
  );
}
/**
 * Clamp the dispatched success-marker staleness window (WL-0MU6UL0RJ008IHGT):
 * reject negative/non-finite (fall back to the 24 h default) and clamp to
 * [DOWNTIME_MARKER_STALE_WINDOW_FLOOR_MS, DOWNTIME_MARKER_STALE_WINDOW_MAX_MS]
 * (1 h – 7 days) so the age release can neither fire while a freshly
 * dispatched pane is plausibly still running (double-dispatch risk) nor be
 * set so large that a stranded item is excluded for weeks (the original
 * permanent-stranding failure mode at a large but bounded scale).
 */
export function clampDowntimeMarkerStaleWindowMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS;
  return Math.min(
    Math.max(Math.round(value), DOWNTIME_MARKER_STALE_WINDOW_FLOOR_MS),
    DOWNTIME_MARKER_STALE_WINDOW_MAX_MS,
  );
}
/**
 * Clamp the per-item, per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK):
 * reject negative/non-finite (fall back to the 3-attempt default) and clamp
 * to [DOWNTIME_MAX_ATTEMPTS_MIN, DOWNTIME_MAX_ATTEMPTS_MAX] (1–10) so the
 * control can neither disable retries entirely nor be set so high that a
 * stuck item loops indefinitely.
 */
export function clampDowntimeMaxAttempts(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DOWNTIME_MAX_ATTEMPTS;
  return Math.min(
    Math.max(Math.round(value), DOWNTIME_MAX_ATTEMPTS_MIN),
    DOWNTIME_MAX_ATTEMPTS_MAX,
  );
}
/**
 * Clamp the depth-aware audit-batch cap (`downtimeAuditBatchMax`, parent
 * WL-0MVEDM8OT007WDRS AC1): non-finite input (NaN/±Infinity) falls back to
 * the default `2`, and every other value is rounded and clamped to
 * [DOWNTIME_AUDIT_BATCH_MAX_MIN, DOWNTIME_AUDIT_BATCH_MAX_MAX] (1–5). `1`
 * is accepted and means batching is off (legacy single-dispatch behaviour);
 * the ceiling bounds the per-idle-window LLM load.
 */
export function clampDowntimeAuditBatchMax(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DOWNTIME_AUDIT_BATCH_MAX;
  return Math.min(
    Math.max(Math.round(value), DOWNTIME_AUDIT_BATCH_MAX_MIN),
    DOWNTIME_AUDIT_BATCH_MAX_MAX,
  );
}
/**
 * Clamp the stalled-work scan threshold (WL-0MUYMBK6H005PY16): reject
 * negative/non-finite (fall back to the 5-minute default) and clamp to
 * [MIN_DOWNTIME_STALL_THRESHOLD_MS, MAX_DOWNTIME_STALL_THRESHOLD_MS]
 * (60 s – 60 min) so the scan can neither resume panes that are merely
 * between tool calls nor leave genuinely stalled panes unattended for hours.
 */
export function clampDowntimeStallThresholdMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_STALL_THRESHOLD_MS;
  return Math.min(
    Math.max(Math.round(value), MIN_DOWNTIME_STALL_THRESHOLD_MS),
    MAX_DOWNTIME_STALL_THRESHOLD_MS,
  );
}
