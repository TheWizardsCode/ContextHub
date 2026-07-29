/**
 * tests/herdr/settings.test.ts — Tests for settings config persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  type PluginSettings,
  defaultSettings,
  loadSettings,
  saveSettings,
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

  it('has default WL count of 20', () => {
    expect(defaultSettings.wlCount).toBe(20);
  });

  it('has default browseItemCount of 10', () => {
    expect(defaultSettings.browseItemCount).toBe(10);
  });

  it('has showHelpText enabled by default', () => {
    expect(defaultSettings.showHelpText).toBe(true);
  });

  it('has syncIntervalMs set to 60000 by default', () => {
    expect(defaultSettings.syncIntervalMs).toBe(60000);
  });

  it('has syncIntervalMs enabled by default', () => {
    expect(defaultSettings.syncIntervalMs).toBeGreaterThan(0);
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

  it('loads settings from existing file', () => {
    writeFileSync(settingsPath, JSON.stringify({
      autoRefresh: false,
      refreshIntervalMs: 60000,
      syncIntervalMs: 60000,
      wlCount: 10,
      browseItemCount: 25,
      showHelpText: false,
    }), 'utf-8');
    const settings = loadSettings(settingsPath);
    expect(settings.autoRefresh).toBe(false);
    expect(settings.refreshIntervalMs).toBe(60000);
    expect(settings.syncIntervalMs).toBe(60000);
    expect(settings.wlCount).toBe(10);
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
    expect(settings.wlCount).toBe(20); // from defaults
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
      wlCount: 10,
      autoSync: false,
      syncIntervalMs: 30000,
      browseItemCount: 25,
      showHelpText: false,
    };
    saveSettings(settingsPath, settings);
    expect(existsSync(settingsPath)).toBe(true);
    const loaded = loadSettings(settingsPath);
    expect(loaded.autoRefresh).toBe(false);
    expect(loaded.wlCount).toBe(10);
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
