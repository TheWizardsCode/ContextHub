/**
 * Tests for the herdr settings system — default browseItemCount and
 * load/merge/clamp behavior.
 *
 * Run: npx vitest run packages/herdr/src/settings.test.ts
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultSettings,
  loadSettings,
  saveSettings,
  clampBrowseItemCount,
  MIN_BROWSE_ITEM_COUNT,
  MAX_BROWSE_ITEM_COUNT,
} from './settings.js';

function tempSettingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-settings-test-'));
  return join(dir, 'worklog-plugin.json');
}

describe('defaultSettings', () => {
  it('browseItemCount defaults to 20', () => {
    expect(defaultSettings.browseItemCount).toBe(20);
  });
});

describe('loadSettings', () => {
  it('returns defaults (browseItemCount 20) when no settings file exists', () => {
    const path = tempSettingsPath();
    const settings = loadSettings(path);
    expect(settings.browseItemCount).toBe(20);
    expect(existsSync(path)).toBe(false);
  });

  it('a persisted browseItemCount overrides the default', () => {
    const path = tempSettingsPath();
    saveSettings(path, { ...defaultSettings, browseItemCount: 30 });
    const settings = loadSettings(path);
    expect(settings.browseItemCount).toBe(30);
  });

  it('clamps an out-of-range persisted browseItemCount into [1, 50]', () => {
    const path = tempSettingsPath();
    saveSettings(path, { ...defaultSettings, browseItemCount: 999 });
    expect(loadSettings(path).browseItemCount).toBe(MAX_BROWSE_ITEM_COUNT);

    saveSettings(path, { ...defaultSettings, browseItemCount: -5 });
    expect(loadSettings(path).browseItemCount).toBe(MIN_BROWSE_ITEM_COUNT);
  });

  it('falls back to the default browseItemCount when the persisted value is not a number', () => {
    const path = tempSettingsPath();
    writeFileSync(path, JSON.stringify({ ...defaultSettings, browseItemCount: 'many' }), 'utf-8');
    expect(loadSettings(path).browseItemCount).toBe(20);
  });

  it('does not touch the real user config when given a custom path', () => {
    const path = tempSettingsPath();
    const settings = loadSettings(path);
    expect(settings).toBeTruthy();
    rmSync(join(path, '..'), { recursive: true, force: true });
  });
});

describe('clampBrowseItemCount', () => {
  it('keeps in-range values', () => {
    expect(clampBrowseItemCount(20)).toBe(20);
    expect(clampBrowseItemCount(MIN_BROWSE_ITEM_COUNT)).toBe(MIN_BROWSE_ITEM_COUNT);
    expect(clampBrowseItemCount(MAX_BROWSE_ITEM_COUNT)).toBe(MAX_BROWSE_ITEM_COUNT);
  });

  it('clamps below the minimum to 1', () => {
    expect(clampBrowseItemCount(0)).toBe(MIN_BROWSE_ITEM_COUNT);
    expect(clampBrowseItemCount(-10)).toBe(MIN_BROWSE_ITEM_COUNT);
  });

  it('clamps above the maximum to 50', () => {
    expect(clampBrowseItemCount(51)).toBe(MAX_BROWSE_ITEM_COUNT);
  });

  it('rounds fractional values', () => {
    expect(clampBrowseItemCount(20.6)).toBe(21);
    expect(clampBrowseItemCount(20.4)).toBe(20);
  });

  it('returns the default (20) for non-finite input', () => {
    expect(clampBrowseItemCount(NaN)).toBe(20);
    expect(clampBrowseItemCount(Infinity)).toBe(20);
  });
});
