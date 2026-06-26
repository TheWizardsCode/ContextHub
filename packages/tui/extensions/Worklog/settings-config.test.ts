/**
 * Unit tests for settings-config.ts — settings loader and validator.
 *
 * Tests the Pi-based settings loading from global and project settings files
 * under the `context-hub` namespace.
 *
 * Run: npx vitest run packages/tui/extensions/settings-config.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSettings, DEFAULT_SETTINGS } from './settings-config.js';

const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

// A test helper that returns path as-is so we can match on it in mock
// implementations. The actual code uses `join()` which normalises paths,
// but for mocking we just need to know which file is being read.
const AGENT_DIR = '/home/test-user/.pi/agent';
const CWD = '/home/test-user/projects/test-project';
const PROJECT_PI_PATH = `${CWD}/.pi/settings.json`;
const GLOBAL_SETTINGS_PATH = `${AGENT_DIR}/settings.json`;

describe('loadSettings', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns default settings when both settings files are missing', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const settings = loadSettings(CWD, AGENT_DIR);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.browseItemCount).toBe(5);
    expect(settings.showIcons).toBe(true);
    expect(settings.showActivityIndicator).toBe(true);
    expect(settings.showHelpText).toBe(true);
  });

  it('reads settings from global settings file under context-hub namespace', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === GLOBAL_SETTINGS_PATH) {
        return JSON.stringify({
          'context-hub': {
            browseItemCount: 10,
            showIcons: false,
          },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const settings = loadSettings(CWD, AGENT_DIR);
    expect(settings.browseItemCount).toBe(10);
    expect(settings.showIcons).toBe(false);
    // Falls back to defaults for values not set in global
    expect(settings.showActivityIndicator).toBe(true);
    expect(settings.showHelpText).toBe(true);
  });

  it('reads settings from project settings file under context-hub namespace', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': {
            browseItemCount: 15,
            showActivityIndicator: false,
          },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const settings = loadSettings(CWD, AGENT_DIR);
    expect(settings.browseItemCount).toBe(15);
    expect(settings.showActivityIndicator).toBe(false);
    // Falls back to defaults for values not set in project
    expect(settings.showIcons).toBe(true);
    expect(settings.showHelpText).toBe(true);
  });

  it('project settings override global settings', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === GLOBAL_SETTINGS_PATH) {
        return JSON.stringify({
          'context-hub': {
            browseItemCount: 10,
            showIcons: false,
            showActivityIndicator: false,
          },
        });
      }
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': {
            browseItemCount: 20,
            showIcons: true,
          },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const settings = loadSettings(CWD, AGENT_DIR);
    // Project values override global
    expect(settings.browseItemCount).toBe(20);
    expect(settings.showIcons).toBe(true);
    // Global value for showActivityIndicator is not overridden by project
    expect(settings.showActivityIndicator).toBe(false);
    // Default for showHelpText since neither set it
    expect(settings.showHelpText).toBe(true);
  });

  it('supports partial settings with defaults filling in missing fields', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': {
            browseItemCount: 3,
          },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const settings = loadSettings(CWD, AGENT_DIR);
    expect(settings.browseItemCount).toBe(3);
    expect(settings.showIcons).toBe(true); // default
    expect(settings.showActivityIndicator).toBe(true); // default
    expect(settings.showHelpText).toBe(true); // default
  });

  it('clamps browseItemCount to valid range [1, 50] from Pi settings', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 0 },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).browseItemCount).toBe(1);

    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { browseItemCount: -5 },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).browseItemCount).toBe(1);

    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 100 },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).browseItemCount).toBe(50);
  });

  it('coerces string numeric browseItemCount to numbers', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { browseItemCount: '8' },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).browseItemCount).toBe(8);
  });

  it('handles empty context-hub section in project settings', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': {},
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const settings = loadSettings(CWD, AGENT_DIR);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('handles malformed JSON in project settings file', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return 'not valid json';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const settings = loadSettings(CWD, AGENT_DIR);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('handles malformed JSON in global settings file', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === GLOBAL_SETTINGS_PATH) {
        return 'not valid json';
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const settings = loadSettings(CWD, AGENT_DIR);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('returns default showActivityIndicator when value is invalid', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { showActivityIndicator: 'maybe' },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).showActivityIndicator).toBe(true);
  });

  it('returns default showHelpText when value is invalid', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { showHelpText: null },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).showHelpText).toBe(true);
  });

  it('coerces string "true"/"false" for boolean settings', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': {
            showActivityIndicator: 'false',
            showHelpText: 'true',
          },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const settings = loadSettings(CWD, AGENT_DIR);
    expect(settings.showActivityIndicator).toBe(false);
    expect(settings.showHelpText).toBe(true);
  });

  it('handles null browseItemCount by using default', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { browseItemCount: null },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).browseItemCount).toBe(5);
  });

  it('handles non-numeric browseItemCount by using default', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 'abc' },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).browseItemCount).toBe(5);
  });

  it('reads autoInjectEnabled from project settings', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { autoInjectEnabled: false },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).autoInjectEnabled).toBe(false);
  });

  it('autoInjectEnabled defaults to true when not set', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).autoInjectEnabled).toBe(true);
  });

  it('coerces string "true"/"false" for autoInjectEnabled', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { autoInjectEnabled: 'false' },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).autoInjectEnabled).toBe(false);
  });

  it('handles invalid autoInjectEnabled by using default', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { autoInjectEnabled: 'maybe' },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).autoInjectEnabled).toBe(true);
  });

  it('handles null autoInjectEnabled by using default', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'context-hub': { autoInjectEnabled: null },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(loadSettings(CWD, AGENT_DIR).autoInjectEnabled).toBe(true);
  });

  it('ignores other namespace keys in Pi settings files', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === PROJECT_PI_PATH) {
        return JSON.stringify({
          'llm-wiki': { notices: false },
          'context-hub': {
            browseItemCount: 7,
          },
          'other-namespace': { foo: 'bar' },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const settings = loadSettings(CWD, AGENT_DIR);
    expect(settings.browseItemCount).toBe(7);
    expect(settings.showIcons).toBe(true); // default unaffected
  });

  it('uses default cwd and handles getAgentDir gracefully when not available', () => {
    // When called without cwd/agentDir, loadSettings should use
    // process.cwd() as fallback and try-catch getAgentDir errors.
    // In the test environment, getAgentDir may throw.
    // We just verify defaults are returned when files are missing.
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const settings = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('Settings interface structure', () => {
  it('DEFAULT_SETTINGS has the correct shape', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      browseItemCount: 5,
      showIcons: true,
      showActivityIndicator: true,
      showHelpText: true,
      autoInjectEnabled: true,
      guardrailsEnabled: true,
      autoSyncIntervalSeconds: 10,
    });
  });
});
