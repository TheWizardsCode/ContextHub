/**
 * Unit tests for settings-config.ts — settings loader and validator.
 *
 * Run: npx vitest run packages/tui/extensions/settings-config.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSettings, DEFAULT_SETTINGS } from './settings-config.js';

const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
}));

describe('loadSettings', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns default settings when settings.json is missing', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const settings = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.browseItemCount).toBe(5);
    expect(settings.showIcons).toBe(true);
  });

  it('returns default settings when settings.json contains malformed JSON', () => {
    mockReadFileSync.mockReturnValue('not valid json');

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const settings = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('parses valid settings.json and returns merged settings', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      browseItemCount: 10,
      showIcons: false,
      showActivityIndicator: false,
      showHelpText: false,
    }));

    const settings = loadSettings();
    expect(settings.browseItemCount).toBe(10);
    expect(settings.showIcons).toBe(false);
    expect(settings.showActivityIndicator).toBe(false);
    expect(settings.showHelpText).toBe(false);
  });

  it('fills in missing fields with defaults', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      browseItemCount: 3,
    }));

    const settings = loadSettings();
    expect(settings.browseItemCount).toBe(3);
    expect(settings.showIcons).toBe(true); // default
    expect(settings.showActivityIndicator).toBe(true); // default
    expect(settings.showHelpText).toBe(true); // default
  });

  it('clamps browseItemCount to valid range [1, 50]', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ browseItemCount: 0 }));
    expect(loadSettings().browseItemCount).toBe(1);

    mockReadFileSync.mockReturnValue(JSON.stringify({ browseItemCount: -5 }));
    expect(loadSettings().browseItemCount).toBe(1);

    mockReadFileSync.mockReturnValue(JSON.stringify({ browseItemCount: 100 }));
    expect(loadSettings().browseItemCount).toBe(50);
  });

  it('coerces string numeric values to numbers', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ browseItemCount: '8' }));
    expect(loadSettings().browseItemCount).toBe(8);
  });

  it('uses defaults for missing settings.json with some fields', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ showIcons: false }));

    const settings = loadSettings();
    expect(settings.browseItemCount).toBe(5); // default
    expect(settings.showIcons).toBe(false);
  });

  it('handles empty JSON object', () => {
    mockReadFileSync.mockReturnValue('{}');
    const settings = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('returns default showActivityIndicator when value is invalid', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ showActivityIndicator: 'maybe' }));
    expect(loadSettings().showActivityIndicator).toBe(true);
  });

  it('returns default showHelpText when value is invalid', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ showHelpText: null }));
    expect(loadSettings().showHelpText).toBe(true);
  });

  it('coerces string "true"/"false" for boolean settings', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      showActivityIndicator: 'false',
      showHelpText: 'true',
    }));
    const settings = loadSettings();
    expect(settings.showActivityIndicator).toBe(false);
    expect(settings.showHelpText).toBe(true);
  });

  it('handles null browseItemCount by using default', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ browseItemCount: null }));
    expect(loadSettings().browseItemCount).toBe(5);
  });

  it('handles non-numeric browseItemCount by using default', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ browseItemCount: 'abc' }));
    expect(loadSettings().browseItemCount).toBe(5);
  });
});

describe('Settings interface structure', () => {
  it('DEFAULT_SETTINGS has the correct shape', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      browseItemCount: 5,
      showIcons: true,
      showActivityIndicator: true,
      showHelpText: true,
    });
  });
});
