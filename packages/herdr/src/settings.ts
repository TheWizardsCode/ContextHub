/**
 * packages/herdr/src/settings.ts — Settings system & config persistence
 *
 * Provides a typed settings store backed by a JSON file, with
 * sensible defaults and merge semantics.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
  /** Number of items to fetch from wl. */
  wlCount: number;
  /** Enable periodic background wl sync. */
  autoSync: boolean;
  /** Interval in ms between syncs. */
  syncIntervalMs: number;
}

// ── Defaults ──────────────────────────────────────────────────────────

export const defaultSettings: PluginSettings = {
  autoRefresh: true,
  refreshIntervalMs: 30000,
  showIcons: true,
  wlCount: 20,
  autoSync: true,
  syncIntervalMs: 60000,
};

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
      wlCount: typeof parsed.wlCount === 'number'
        ? parsed.wlCount : defaultSettings.wlCount,
      autoSync: typeof parsed.autoSync === 'boolean'
        ? parsed.autoSync : defaultSettings.autoSync,
      syncIntervalMs: typeof parsed.syncIntervalMs === 'number'
        ? parsed.syncIntervalMs : defaultSettings.syncIntervalMs,
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
