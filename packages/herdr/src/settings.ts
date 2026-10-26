/**
 * packages/herdr/src/settings.ts — Settings system & config persistence
 *
 * Provides a typed settings store backed by a JSON file, with
 * sensible defaults and merge semantics.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { clampSyncInterval } from './auto-sync.js';
import {
  DOWNTIME_LOCAL_PREFERENCE,
  clampDowntimeLocalPreference,
  isLocalPreference,
  type LocalPreference,
} from './local-preference.js';
import {
  clampBrowseItemCount,
  DEFAULT_BROWSE_ITEM_COUNT,
  MIN_BROWSE_ITEM_COUNT,
  MAX_BROWSE_ITEM_COUNT,
} from './browse-window.js';

// Re-exported for backward compatibility: the sprint-view window bounds and
// clamp moved to the leaf `browse-window.ts` module so the downtime dispatcher
// (`downtime-worker.ts`) can share them without an import cycle
// (WL-0MUNS8X97007C9H9 AC1).
export { clampBrowseItemCount, MIN_BROWSE_ITEM_COUNT, MAX_BROWSE_ITEM_COUNT, DEFAULT_BROWSE_ITEM_COUNT };
import {
  clampDowntimeAuditBatchMax,
  clampDowntimeIdleThresholdMs,
  clampDowntimeLongRunningThresholdMs,
  clampDowntimeMarkerStaleWindowMs,
  clampDowntimeMaxAttempts,
  clampDowntimeNoCandidateCooldownMs,
  clampDowntimeNonTerminalCooldownMs,
  clampDowntimePollInterval,
  clampDowntimeRequiredFreeSlots,
  clampDowntimeStallThresholdMs,
  DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_MODEL,
  DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_PROXY_URL,
  DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
  DEFAULT_DOWNTIME_STALL_SCAN_ENABLED,
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
} from './downtime-worker.js';
import {
  clampPaneCloseGracePeriodMinutes,
  clampPaneCloseIdleThresholdMinutes,
  DEFAULT_PANE_CLOSE_ENABLED,
  DEFAULT_PANE_CLOSE_GRACE_PERIOD_MINUTES,
  DEFAULT_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
} from './pane-close-scheduler.js';
import {
  clampDowntimeCapacityStarvationAlertMs,
  DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS,
} from './capacity-starvation.js';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  clampDowntimeCpuGatePercent,
  DEFAULT_DOWNTIME_CPU_GATE_PERCENT,
} from './host-cpu.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface PluginSettings {
  /** Enable periodic auto-refresh of the item list. */
  autoRefresh: boolean;
  /** Interval in ms between refreshes. */
  refreshIntervalMs: number;
  /** Show emoji icons in item lines. */
  showIcons: boolean;
  /** Enable periodic background wl sync. */
  autoSync: boolean;
  /** Interval in ms between background `wl sync` calls. 0 = disabled. Minimum 60000ms. */
  syncIntervalMs: number;
  /** Number of items to fetch and display (1-50). */
  browseItemCount: number;
  /** Show chord help bar at the bottom of the list. */
  showHelpText: boolean;
  /** Enable the downtime worker (local-LLM idle dispatch). */
  downtimeEnabled: boolean;
  /** Minimum continuous idle duration before dispatch (ms). */
  downtimeIdleThresholdMs: number;
  /**
   * Required free slots; 0 = all slots, or a positive integer N (default 2
   * of 3 — spare-capacity dispatch, at least one slot reserved for the
   * operator session).
   */
  downtimeRequiredFreeSlots: number;
  /** Poll interval for the proxy status endpoint (hard floor 10s). */
  downtimePollIntervalMs: number;
  /** Base URL of the llama-proxy (e.g. http://192.168.0.199:8000). */
  downtimeProxyUrl: string;
  /** pi model pattern for dispatched agent panes (default `plan`). */
  downtimeModel: string;
  /**
   * Per-turn locality preference for downtime-dispatched panes
   * (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4; default flipped
   * in WL-0MVNUHWH500196K1): `remote-ok` (default) lets unattended work go
   * remote rather than queue a contended local slot; `local-only`
   * (explicit opt-in) makes the proxy refuse immediately rather than
   * silently wait. Forwarded to the pane as `HERDR_LOCAL_PREFERENCE`,
   * which the Worklog pi extension turns into the `X-Local-Preference`
   * request header.
   */
  downtimeLocalPreference: LocalPreference;
  /**
   * Derived — NEVER persisted (WL-0MVNUIW77000VYAX AC3). True only when the
   * settings file contains a valid `local-only`/`remote-ok`
   * `downtimeLocalPreference` value; an absent key, a missing file and
   * out-of-alphabet values all resolve `false` so the low-priority rule
   * applies. `saveSettings` strips it and `loadSettings` always recomputes it
   * from the file, so it can never become a persisted second alphabet.
   *
   * The dispatch layer uses it to pick the locality precedence: explicit
   * operator setting > priority rule > deployment default.
   */
  downtimeLocalPreferenceExplicit: boolean;
  /**
   * Full pause (no proxy polling, no idle tracking, no dispatch) after the
   * worker finds no candidate in either stage (genuine empty backlog).
   * Floor 60s; default 3_600_000 ms (60 min).
   */
  downtimeNoCandidateCooldownMs: number;
  /**
   * Minimum cooldown (WL-0MUKYERLZ006ELL5) between successive downtime
   * dispatches of the same `(item, kind)` after a pane closed without reaching
   * a terminal stage (`agent-ended-no-terminal`, `audit-ended-no-result`).
   * Neutral skip, never a strike. Default 30 min; clamped to [1 min, 24 h].
   */
  downtimeNonTerminalCooldownMs: number;
  /**
   * Per-item, per-kind dispatch-ATTEMPT cap (WL-0MUKYEXMK0033MFK). Once an
   * item has been dispatched this many times for a kind at its current
   * worklog stage (including non-terminal pane closes), it is flagged
   * `needsProducerReview` and excluded from further automatic dispatch of
   * that kind. A stage advancement resets the budget. Default 3; clamped to
   * [1, 10].
   */
  downtimeMaxAttempts: number;
  /**
   * Depth-aware audit-batch cap (parent WL-0MVEDM8OT007WDRS AC1): bounds
   * how many SEQUENTIAL audit dispatches one continuous idle window may
   * issue when the audit-eligible depth reaches `browseItemCount`. Default
   * 2; clamped to [1, 5]; `1` disables batching (legacy single-dispatch
   * behaviour). Non-finite/missing/invalid values fall back to the default.
   */
  downtimeAuditBatchMax: number;
  /**
   * Dispatched success-marker staleness window (WL-0MU6UL0RJ008IHGT): a
   * SUCCESS dispatch marker whose item is still at the marker's dispatched-at
   * stage is released once its age exceeds this window, so a pane that
   * spawned but whose agent never advanced the item (crash, manual close,
   * silent failure) cannot strand the item permanently. Default 24 h;
   * clamped to [1 h, 7 days].
   */
  downtimeMarkerStaleWindowMs: number;
  /**
   * Enable the pre-dispatch stalled-work scan (WL-0MUYMBK6H005PY16). When on,
   * the dispatcher prefers resuming an existing stalled pane over opening a new
   * one. Default `true`.
   */
  downtimeStallScanEnabled: boolean;
  /**
   * Minimum continuous not-`working` duration before a pane is considered
   * stalled (WL-0MUYMBK6H005PY16). Default 5 min (300000 ms); clamped to
   * [60 s, 60 min]; invalid/missing values fall back to the default.
   */
  downtimeStallThresholdMs: number;
  /**
   * Continuous capacity-refusal window (WL-0MVKNC2N50025HXE AC3) before the
   * dispatcher writes a `capacity-starved` observation naming the panes that
   * hold the local model. Observation only — it never gates dispatch. Default
   * **2 h**; clamped to [5 min, 24 h]; invalid/missing values fall back to the
   * default.
   */
  downtimeCapacityStarvationAlertMs: number;
  /**
   * Host-CPU dispatch gate (WL-0MVK0UO3Q002TXW6): at or above this measured
   * host CPU utilisation (percent, from `/proc/stat` deltas with a
   * load-average fallback) the dispatcher refuses NEW audit/implement work on
   * every dispatch path while intake/plan/risk-effort keep flowing. `0`
   * disables the gate. Default **75**; clamped to [0, 100]; invalid/missing
   * values fall back to the default. Re-read live on every dispatch tick.
   */
  downtimeCpuGatePercent: number;
  /**
   * Progress window (WL-0MVKNC2N50025HXE AC2) before a live-agent pane whose
   * item has not advanced is reported as long-running on a starvation signal.
   * Panes are never resumed/closed from this signal. Default **3 h**; clamped
   * to [1 h, 48 h]; invalid/missing values fall back to the default.
   */
  downtimeLongRunningThresholdMs: number;
  /**
   * Enable periodic auto-close of settled/abandoned agent panes
   * (WL-0MUJL1NAH0042GOS). Default `true`; disable to turn off the reaper
   * without editing code.
   */
  paneCloseEnabled: boolean;
  /**
   * Marker-less idle threshold, in minutes, after which an agent pane with no
   * `</end_session>` marker is reaped. 0 = never close on idle; clamped to [0, 1440].
   */
  paneCloseIdleThresholdMinutes: number;
  /**
   * Grace period, in minutes, since a pane's first dispatch before it is
   * eligible for auto-close (parent AC5). No pane is closed within this
   * window, giving the agent time to start working and producer-review state
   * time to propagate. Default 5; clamped to [1, 1440].
   */
  paneCloseGracePeriodMinutes: number;
  /**
   * Maximum acceptable staleness (ms) for the last successful `wl sync` before
   * forcing a sync even when the DB hasn't changed locally. Bounded by the
   * auto-sync interval so remote changes are pulled at least once per interval.
   * Default 60000 (60 s), clamped to [1000, 300000] (1 s – 5 min).
   */
  maxSyncStalenessMs: number;
}

// ── Defaults ──────────────────────────────────────────────────────────

export const defaultSettings: PluginSettings = {
  autoRefresh: true,
  refreshIntervalMs: 30000,
  showIcons: true,
  autoSync: true,
  syncIntervalMs: 60000,
  browseItemCount: DEFAULT_BROWSE_ITEM_COUNT,
  showHelpText: true,
  downtimeEnabled: true,
  downtimeIdleThresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  downtimeRequiredFreeSlots: DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
  downtimePollIntervalMs: DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  downtimeProxyUrl: DEFAULT_DOWNTIME_PROXY_URL,
  downtimeModel: DEFAULT_DOWNTIME_MODEL,
  downtimeLocalPreference: DOWNTIME_LOCAL_PREFERENCE,
  // Derived (never persisted): the default settings carry no persisted key,
  // so the priority rule is free to apply (WL-0MVNUIW77000VYAX AC3).
  downtimeLocalPreferenceExplicit: false,
  downtimeNoCandidateCooldownMs: DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
  downtimeNonTerminalCooldownMs: DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  downtimeMaxAttempts: DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  downtimeAuditBatchMax: DEFAULT_DOWNTIME_AUDIT_BATCH_MAX,
  downtimeMarkerStaleWindowMs: DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  downtimeStallScanEnabled: DEFAULT_DOWNTIME_STALL_SCAN_ENABLED,
  downtimeStallThresholdMs: DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  downtimeCapacityStarvationAlertMs: DEFAULT_DOWNTIME_CAPACITY_STARVATION_ALERT_MS,
  downtimeLongRunningThresholdMs: DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  downtimeCpuGatePercent: DEFAULT_DOWNTIME_CPU_GATE_PERCENT,
  paneCloseEnabled: DEFAULT_PANE_CLOSE_ENABLED,
  paneCloseIdleThresholdMinutes: DEFAULT_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
  paneCloseGracePeriodMinutes: DEFAULT_PANE_CLOSE_GRACE_PERIOD_MINUTES,
  maxSyncStalenessMs: 60_000,
};

/** Minimum allowed maxSyncStalenessMs (1 s). */
export const MIN_MAX_SYNC_STALENESS_MS = 1_000;
/** Maximum allowed maxSyncStalenessMs (5 min). */
export const MAX_MAX_SYNC_STALENESS_MS = 300_000;

/**
 * Clamp maxSyncStalenessMs to the supported [1000, 300000] range.
 */
export function clampMaxSyncStalenessMs(value: number): number {
  if (!Number.isFinite(value)) return defaultSettings.maxSyncStalenessMs;
  return Math.min(Math.max(Math.round(value), MIN_MAX_SYNC_STALENESS_MS), MAX_MAX_SYNC_STALENESS_MS);
}

// ── Default config path ───────────────────────────────────────────────

/**
 * Get the default settings file path.
 * Creates the config directory if it doesn't exist.
 */
export function getDefaultSettingsPath(): string {
  const configDir = join(homedir(), '.config', 'herdr');
  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
    } catch {
      // Ignore permission errors — fall back to default path
    }
  }
  return join(configDir, 'worklog-plugin.json');
}

// ── Load/Save ─────────────────────────────────────────────────────────

/**
 * Load settings from a JSON file, merging with defaults.
 * Missing keys are filled from defaultSettings.
 */
export function loadSettings(settingsPath?: string): PluginSettings {
  const path = settingsPath ?? getDefaultSettingsPath();

  try {
    if (!existsSync(path)) return { ...defaultSettings };

    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) {
      return { ...defaultSettings };
    }

    return {
      autoRefresh: typeof parsed.autoRefresh === 'boolean'
        ? parsed.autoRefresh : defaultSettings.autoRefresh,
      refreshIntervalMs: typeof parsed.refreshIntervalMs === 'number'
        ? parsed.refreshIntervalMs : defaultSettings.refreshIntervalMs,
      showIcons: typeof parsed.showIcons === 'boolean'
        ? parsed.showIcons : defaultSettings.showIcons,
      autoSync: typeof parsed.autoSync === 'boolean'
        ? parsed.autoSync : defaultSettings.autoSync,
      syncIntervalMs: typeof parsed.syncIntervalMs === 'number'
        ? clampSyncInterval(parsed.syncIntervalMs)
        : defaultSettings.syncIntervalMs,
      browseItemCount: typeof parsed.browseItemCount === 'number'
        ? clampBrowseItemCount(parsed.browseItemCount) : defaultSettings.browseItemCount,
      showHelpText: typeof parsed.showHelpText === 'boolean'
        ? parsed.showHelpText : defaultSettings.showHelpText,
      downtimeEnabled: typeof parsed.downtimeEnabled === 'boolean'
        ? parsed.downtimeEnabled : defaultSettings.downtimeEnabled,
      downtimeIdleThresholdMs: typeof parsed.downtimeIdleThresholdMs === 'number'
        ? clampDowntimeIdleThresholdMs(parsed.downtimeIdleThresholdMs)
        : defaultSettings.downtimeIdleThresholdMs,
      downtimeRequiredFreeSlots: typeof parsed.downtimeRequiredFreeSlots === 'number'
        ? clampDowntimeRequiredFreeSlots(parsed.downtimeRequiredFreeSlots)
        : defaultSettings.downtimeRequiredFreeSlots,
      downtimePollIntervalMs: typeof parsed.downtimePollIntervalMs === 'number'
        ? clampDowntimePollInterval(parsed.downtimePollIntervalMs)
        : defaultSettings.downtimePollIntervalMs,
      downtimeProxyUrl: typeof parsed.downtimeProxyUrl === 'string' && parsed.downtimeProxyUrl.length > 0
        ? parsed.downtimeProxyUrl : defaultSettings.downtimeProxyUrl,
      downtimeModel: typeof parsed.downtimeModel === 'string' && parsed.downtimeModel.length > 0
        ? parsed.downtimeModel : defaultSettings.downtimeModel,
      downtimeLocalPreference: clampDowntimeLocalPreference(parsed.downtimeLocalPreference),
      // Derived explicitness signal (WL-0MVNUIW77000VYAX AC3): true ONLY when
      // the file holds a valid two-value preference. Deliberately computed
      // here (never read from the file, never persisted) so a clamped default
      // is distinguishable from an operator's explicit choice.
      downtimeLocalPreferenceExplicit: isLocalPreference(parsed.downtimeLocalPreference),
      downtimeNoCandidateCooldownMs: typeof parsed.downtimeNoCandidateCooldownMs === 'number'
        ? clampDowntimeNoCandidateCooldownMs(parsed.downtimeNoCandidateCooldownMs)
        : defaultSettings.downtimeNoCandidateCooldownMs,
      downtimeNonTerminalCooldownMs: typeof parsed.downtimeNonTerminalCooldownMs === 'number'
        ? clampDowntimeNonTerminalCooldownMs(parsed.downtimeNonTerminalCooldownMs)
        : defaultSettings.downtimeNonTerminalCooldownMs,
      downtimeMaxAttempts: typeof parsed.downtimeMaxAttempts === 'number'
        ? clampDowntimeMaxAttempts(parsed.downtimeMaxAttempts)
        : defaultSettings.downtimeMaxAttempts,
      downtimeAuditBatchMax: typeof parsed.downtimeAuditBatchMax === 'number'
        ? clampDowntimeAuditBatchMax(parsed.downtimeAuditBatchMax)
        : defaultSettings.downtimeAuditBatchMax,
      downtimeMarkerStaleWindowMs: typeof parsed.downtimeMarkerStaleWindowMs === 'number'
        ? clampDowntimeMarkerStaleWindowMs(parsed.downtimeMarkerStaleWindowMs)
        : defaultSettings.downtimeMarkerStaleWindowMs,
      downtimeStallScanEnabled: typeof parsed.downtimeStallScanEnabled === 'boolean'
        ? parsed.downtimeStallScanEnabled : defaultSettings.downtimeStallScanEnabled,
      downtimeStallThresholdMs: typeof parsed.downtimeStallThresholdMs === 'number'
        ? clampDowntimeStallThresholdMs(parsed.downtimeStallThresholdMs)
        : defaultSettings.downtimeStallThresholdMs,
      downtimeCapacityStarvationAlertMs:
        typeof parsed.downtimeCapacityStarvationAlertMs === 'number'
          ? clampDowntimeCapacityStarvationAlertMs(parsed.downtimeCapacityStarvationAlertMs)
          : defaultSettings.downtimeCapacityStarvationAlertMs,
      downtimeLongRunningThresholdMs:
        typeof parsed.downtimeLongRunningThresholdMs === 'number'
          ? clampDowntimeLongRunningThresholdMs(parsed.downtimeLongRunningThresholdMs)
          : defaultSettings.downtimeLongRunningThresholdMs,
      downtimeCpuGatePercent: typeof parsed.downtimeCpuGatePercent === 'number'
        ? clampDowntimeCpuGatePercent(parsed.downtimeCpuGatePercent)
        : defaultSettings.downtimeCpuGatePercent,
      paneCloseEnabled: typeof parsed.paneCloseEnabled === 'boolean'
        ? parsed.paneCloseEnabled : defaultSettings.paneCloseEnabled,
      paneCloseIdleThresholdMinutes: typeof parsed.paneCloseIdleThresholdMinutes === 'number'
        ? clampPaneCloseIdleThresholdMinutes(parsed.paneCloseIdleThresholdMinutes)
        : defaultSettings.paneCloseIdleThresholdMinutes,
      paneCloseGracePeriodMinutes: typeof parsed.paneCloseGracePeriodMinutes === 'number'
        ? clampPaneCloseGracePeriodMinutes(parsed.paneCloseGracePeriodMinutes)
        : defaultSettings.paneCloseGracePeriodMinutes,
      maxSyncStalenessMs: typeof parsed.maxSyncStalenessMs === 'number'
        ? clampMaxSyncStalenessMs(parsed.maxSyncStalenessMs)
        : defaultSettings.maxSyncStalenessMs,
      // NOTE (WL-0MU2EP6JL006A1U3): `downtimeMaxRunningPanes` and its legacy
      // alias `downtimeMaxConcurrentDispatches` are deliberately NOT read.
      // Dispatched panes stay open until an operator closes them, so a
      // client-side pane count can never be the concurrency limiter — the
      // local LLM idle check is (see downtime-worker.ts). A config file still
      // carrying either key loads cleanly and the key is simply ignored.
    };
  } catch {
    return { ...defaultSettings };
  }
}

/**
 * Save settings to a JSON file.
 * Creates parent directories if they don't exist.
 */
export function saveSettings(settingsPath: string, settings: PluginSettings): void {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // `downtimeLocalPreferenceExplicit` is a DERIVED signal
  // (WL-0MVNUIW77000VYAX AC3): persisting it would turn every explicit
  // deployment permanently explicit after one save. Strip it so the settings
  // file keeps only the two-value `downtimeLocalPreference` alphabet, and keep
  // the preference KEY absent for a deployment that was not explicit (its
  // value is only the clamped default) so saving settings never silently
  // disables the priority rule.
  const {
    downtimeLocalPreferenceExplicit: explicit,
    downtimeLocalPreference,
    ...rest
  } = settings;
  const persisted = explicit ? { ...rest, downtimeLocalPreference } : rest;
  writeFileSync(settingsPath, JSON.stringify(persisted, null, 2), 'utf-8');
}
