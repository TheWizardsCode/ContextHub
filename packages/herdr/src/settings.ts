/**
 * packages/herdr/src/settings.ts — Settings system & config persistence
 *
 * Provides a typed settings store backed by a JSON file, with
 * sensible defaults and merge semantics.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { clampSyncInterval } from './auto-sync.js';
import {
  clampDowntimeIdleThresholdMs,
  clampDowntimeNoCandidateCooldownMs,
  clampDowntimePollInterval,
  clampDowntimeRequiredFreeSlots,
  DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  DEFAULT_DOWNTIME_MODEL,
  DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
  DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  DEFAULT_DOWNTIME_PROXY_URL,
  DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
} from './downtime-worker.js';
import {
  clampModeSwitchIdleThresholdMs,
  clampModeSwitchPollIntervalMs,
  DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS,
  DEFAULT_MODE_SWITCH_POLL_INTERVAL_MS,
} from './mode-switch-worker.js';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
   * Full pause (no proxy polling, no idle tracking, no dispatch) after the
   * worker finds no candidate in either stage (genuine empty backlog).
   * Floor 60s; default 3_600_000 ms (60 min).
   */
  downtimeNoCandidateCooldownMs: number;
  /** Enable activity-gated mode-switching (fast on agent command, cheap on idle). */
  modeSwitchEnabled: boolean;
  /**
   * Idle window before switching to cheap mode (ms). Default 900_000 (15 min).
   * A new operator agent-route command resets this timer.
   */
  modeSwitchIdleThresholdMs: number;
  /** Poll interval for the mode-switch worker (ms). Defaults to the same
   * cadence as the downtime poller; clamped to a sensible range. */
  modeSwitchPollIntervalMs: number;
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
  browseItemCount: 20,
  showHelpText: true,
  downtimeEnabled: true,
  downtimeIdleThresholdMs: DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS,
  downtimeRequiredFreeSlots: DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS,
  downtimePollIntervalMs: DEFAULT_DOWNTIME_POLL_INTERVAL_MS,
  downtimeProxyUrl: DEFAULT_DOWNTIME_PROXY_URL,
  downtimeModel: DEFAULT_DOWNTIME_MODEL,
  downtimeNoCandidateCooldownMs: DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS,
  modeSwitchEnabled: false,
  modeSwitchIdleThresholdMs: DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS,
  modeSwitchPollIntervalMs: DEFAULT_MODE_SWITCH_POLL_INTERVAL_MS,
  maxSyncStalenessMs: 60_000,
};

/** Minimum allowed browseItemCount. */
export const MIN_BROWSE_ITEM_COUNT = 1;
/** Maximum allowed browseItemCount. */
export const MAX_BROWSE_ITEM_COUNT = 50;

/** Minimum allowed maxSyncStalenessMs (1 s). */
export const MIN_MAX_SYNC_STALENESS_MS = 1_000;
/** Maximum allowed maxSyncStalenessMs (5 min). */
export const MAX_MAX_SYNC_STALENESS_MS = 300_000;

/**
 * Clamp a browseItemCount value to the supported [1, 50] range.
 * Used at load time so persisted/parsed values cannot exceed the bounds.
 */
export function clampBrowseItemCount(value: number): number {
  if (!Number.isFinite(value)) return defaultSettings.browseItemCount;
  return Math.min(Math.max(Math.round(value), MIN_BROWSE_ITEM_COUNT), MAX_BROWSE_ITEM_COUNT);
}

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
      downtimeNoCandidateCooldownMs: typeof parsed.downtimeNoCandidateCooldownMs === 'number'
        ? clampDowntimeNoCandidateCooldownMs(parsed.downtimeNoCandidateCooldownMs)
        : defaultSettings.downtimeNoCandidateCooldownMs,
      modeSwitchEnabled: typeof parsed.modeSwitchEnabled === 'boolean'
        ? parsed.modeSwitchEnabled : defaultSettings.modeSwitchEnabled,
      modeSwitchIdleThresholdMs: typeof parsed.modeSwitchIdleThresholdMs === 'number'
        ? clampModeSwitchIdleThresholdMs(parsed.modeSwitchIdleThresholdMs)
        : defaultSettings.modeSwitchIdleThresholdMs,
      modeSwitchPollIntervalMs: typeof parsed.modeSwitchPollIntervalMs === 'number'
        ? clampModeSwitchPollIntervalMs(parsed.modeSwitchPollIntervalMs)
        : defaultSettings.modeSwitchPollIntervalMs,
      maxSyncStalenessMs: typeof parsed.maxSyncStalenessMs === 'number'
        ? clampMaxSyncStalenessMs(parsed.maxSyncStalenessMs)
        : defaultSettings.maxSyncStalenessMs,
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
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}
