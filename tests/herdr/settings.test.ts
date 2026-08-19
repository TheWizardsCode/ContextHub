/**
 * tests/herdr/settings.test.ts — Tests for settings config persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  type PluginSettings,
  defaultSettings,
  loadSettings,
  saveSettings,
  clampBrowseItemCount,
} from '../../packages/herdr/src/settings.js';
import { unlinkSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

// ── Tests ─────────────────────────────────────────────────────────────

describe('defaultSettings', () => {
  it('has autoRefresh enabled by default', () => {
    expect(defaultSettings.autoRefresh).toBe(true);
  });

  it('has 30s refresh interval', () => {
    expect(defaultSettings.refreshIntervalMs).toBe(30000);
  });

  it('has icons enabled by default', () => {
    expect(defaultSettings.showIcons).toBe(true);
  });

  it('has default browseItemCount of 20', () => {
    // Default raised 10 → 20 in WL-0MSHUDQXR009T29L (see packages/herdr/src/settings.ts)
    expect(defaultSettings.browseItemCount).toBe(20);
  });

  it('clamps browseItemCount to the [1, 50] range at load time', () => {
    expect(clampBrowseItemCount(0)).toBe(1);
    expect(clampBrowseItemCount(-5)).toBe(1);
    expect(clampBrowseItemCount(99)).toBe(50);
    expect(clampBrowseItemCount(25)).toBe(25);
    // Non-finite input falls back to the default (20, not 10)
    expect(clampBrowseItemCount(NaN)).toBe(20);
    expect(clampBrowseItemCount(2.7)).toBe(3);
  });

  it('has showHelpText enabled by default', () => {
    expect(defaultSettings.showHelpText).toBe(true);
  });

  it('has syncIntervalMs set to 60000 (60s) by default', () => {
    expect(defaultSettings.syncIntervalMs).toBe(60000);
  });

  it('has syncIntervalMs enabled by default', () => {
    expect(defaultSettings.syncIntervalMs).toBeGreaterThan(0);
  });

  it('has downtimeEnabled enabled by default', () => {
    expect(defaultSettings.downtimeEnabled).toBe(true);
  });

  it('has a 60s idle threshold by default', () => {
    expect(defaultSettings.downtimeIdleThresholdMs).toBe(60000);
  });

  it('has downtimeRequiredFreeSlots 0 (all slots) by default', () => {
    expect(defaultSettings.downtimeRequiredFreeSlots).toBe(0);
  });

  it('has a 10s poll interval by default', () => {
    expect(defaultSettings.downtimePollIntervalMs).toBe(10000);
  });

  it('has the llama-proxy URL and plan model by default', () => {
    expect(defaultSettings.downtimeProxyUrl).toBe('http://192.168.0.199:8000');
    expect(defaultSettings.downtimeModel).toBe('plan');
  });
});

describe('loadSettings', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'herdr-settings-'));
    settingsPath = join(tmpDir, 'test-settings.json');
  });

  afterEach(() => {
    try {
      if (existsSync(settingsPath)) unlinkSync(settingsPath);
      if (existsSync(tmpDir)) {
        unlinkSync(tmpDir); // May fail on non-empty dir
        try { unlinkSync(tmpDir); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  });

  it('returns default settings when file does not exist', () => {
    const settings = loadSettings(settingsPath);
    expect(settings.autoRefresh).toBe(true);
    expect(settings.refreshIntervalMs).toBe(30000);
    expect(settings.syncIntervalMs).toBe(60000);
  });

  it('clamps browseItemCount when loading out-of-range persisted value', () => {
    writeFileSync(settingsPath, JSON.stringify({
      browseItemCount: 999,
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.browseItemCount).toBe(50);
  });

  it('clamps downtime settings when loading out-of-range persisted values', () => {
    writeFileSync(settingsPath, JSON.stringify({
      downtimePollIntervalMs: 5000,          // below the 10s floor
      downtimeIdleThresholdMs: -1,           // negative → default
      downtimeRequiredFreeSlots: -2,         // negative → 0 (all slots)
      downtimeModel: '',                     // empty → default
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.downtimePollIntervalMs).toBe(10000);
    expect(settings.downtimeIdleThresholdMs).toBe(60000);
    expect(settings.downtimeRequiredFreeSlots).toBe(0);
    expect(settings.downtimeModel).toBe('plan');
  });

  it('merges partial downtime settings with defaults', () => {
    writeFileSync(settingsPath, JSON.stringify({
      downtimeEnabled: false,
      downtimeProxyUrl: 'http://10.0.0.5:8000',
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.downtimeEnabled).toBe(false);
    expect(settings.downtimeProxyUrl).toBe('http://10.0.0.5:8000');
    expect(settings.downtimeIdleThresholdMs).toBe(60000); // from defaults
    expect(settings.downtimePollIntervalMs).toBe(10000); // from defaults
    expect(settings.downtimeRequiredFreeSlots).toBe(0); // from defaults
  });

  it('loads showIcons: false from the config file', () => {
    writeFileSync(settingsPath, JSON.stringify({ showIcons: false }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.showIcons).toBe(false);
  });

  it('defaults showIcons to true when missing from the config', () => {
    writeFileSync(settingsPath, JSON.stringify({ autoRefresh: false }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.showIcons).toBe(true);
  });

  it('loads settings from existing file', () => {
    writeFileSync(settingsPath, JSON.stringify({
      autoRefresh: false,
      refreshIntervalMs: 60000,
      syncIntervalMs: 60000,
      browseItemCount: 25,
      showHelpText: false,
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.autoRefresh).toBe(false);
    expect(settings.refreshIntervalMs).toBe(60000);
    expect(settings.syncIntervalMs).toBe(60000);
    expect(settings.browseItemCount).toBe(25);
    expect(settings.showHelpText).toBe(false);
  });

  it('merges partial settings with defaults', () => {
    writeFileSync(settingsPath, JSON.stringify({
      autoRefresh: false,
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.autoRefresh).toBe(false);
    expect(settings.refreshIntervalMs).toBe(30000); // from defaults
    expect(settings.syncIntervalMs).toBe(60000); // from defaults
  });

  it('handles malformed JSON', () => {
    writeFileSync(settingsPath, '{invalid', 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings).toEqual(defaultSettings);
  });
});

describe('saveSettings', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'herdr-settings-'));
    settingsPath = join(tmpDir, 'test-settings.json');
  });

  afterEach(() => {
    try {
      if (existsSync(settingsPath)) unlinkSync(settingsPath);
    } catch { /* ignore */ }
  });

  it('writes settings to file', () => {
    const settings: PluginSettings = {
      autoRefresh: false,
      refreshIntervalMs: 60000,
      showIcons: false,
      autoSync: false,
      syncIntervalMs: 30000,
      browseItemCount: 25,
      showHelpText: false,
      downtimeEnabled: true,
      downtimeIdleThresholdMs: 60000,
      downtimeRequiredFreeSlots: 0,
      downtimePollIntervalMs: 10000,
      downtimeProxyUrl: 'http://192.168.0.199:8000',
      downtimeModel: 'plan',
    };
    saveSettings(settingsPath, settings);
    expect(existsSync(settingsPath)).toBe(true);
    const loaded = loadSettings(settingsPath);
    expect(loaded.autoRefresh).toBe(false);
  });

  it('creates parent directory if needed', () => {
    const nestedPath = join(tmpDir, 'sub', 'nested', 'settings.json');
    const settings = defaultSettings;
    saveSettings(nestedPath, settings);
    expect(existsSync(nestedPath)).toBe(true);
    const loaded = loadSettings(nestedPath);
    expect(loaded.autoRefresh).toBe(true);
  });
});
