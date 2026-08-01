/**
 * packages/herdr/src/settings.ts — Settings system & config persistence
 *
 * Provides a typed settings store backed by a JSON file, with
 * sensible defaults and merge semantics.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { clampSyncInterval } from './auto-sync.js';
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
  /** Interval in ms between background `wl sync` calls. 0 = disabled. Minimum 30000ms. */
  syncIntervalMs: number;
  /** Number of items to fetch and display (1-50). */
  browseItemCount: number;
  /** Show chord help bar at the bottom of the list. */
  showHelpText: boolean;
}

// ── Defaults ──────────────────────────────────────────────────────────

export const defaultSettings: PluginSettings = {
  autoRefresh: true,
  refreshIntervalMs: 30000,
  showIcons: true,
  autoSync: true,
  syncIntervalMs: 30000,
  browseItemCount: 10,
  showHelpText: true,
};

/** Minimum allowed browseItemCount. */
export const MIN_BROWSE_ITEM_COUNT = 1;
/** Maximum allowed browseItemCount. */
export const MAX_BROWSE_ITEM_COUNT = 50;

/**
 * Clamp a browseItemCount value to the supported [1, 50] range.
 * Used at load time so persisted/parsed values cannot exceed the bounds.
 */
export function clampBrowseItemCount(value: number): number {
  if (!Number.isFinite(value)) return defaultSettings.browseItemCount;
  return Math.min(Math.max(Math.round(value), MIN_BROWSE_ITEM_COUNT), MAX_BROWSE_ITEM_COUNT);
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
