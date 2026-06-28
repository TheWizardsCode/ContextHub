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
import { WorklogConfig } from './config.js';

const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

// Track fs.watch calls for testing
const mockWatchClose = vi.hoisted(() => vi.fn());
const mockWatchListeners: Array<{ path: string; handler: (event: string, filename: string | null) => void }> = [];
const mockWatch = vi.hoisted(() => vi.fn((path: string, handler: (event: string, filename: string | null) => void) => {
  mockWatchListeners.push({ path, handler });
  return { close: mockWatchClose };
}));

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  watch: mockWatch,
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
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockWatch.mockReset();
    mockWatchClose.mockReset();
    mockWatchListeners.length = 0;
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
      version: 1,
    });
  });
});

// ── WorklogConfig hot-reload foundation ───────────────────────────────

describe('WorklogConfig — hot-reload foundation', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockWatch.mockReset();
    mockWatchClose.mockReset();
    mockWatchListeners.length = 0;

    // Default: all settings files missing
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('config is loaded lazily on first get(), not at construction', () => {
    // Construction shouldn't call readFileSync
    const wc = new WorklogConfig();
    expect(mockReadFileSync).not.toHaveBeenCalled();

    // First get() should trigger load
    const config = wc.get();
    expect(config).toEqual(DEFAULT_SETTINGS);
    expect(mockReadFileSync).toHaveBeenCalled();
  });

  it('load() reads settings from disk using loadSettings', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('.pi/settings.json')) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 15, showIcons: false },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const wc = new WorklogConfig();
    wc.load('/some/project');

    const config = wc.get();
    expect(config.browseItemCount).toBe(15);
    expect(config.showIcons).toBe(false);
  });

  it('get() returns a readonly view of the config (immutable)', () => {
    const wc = new WorklogConfig();
    const config = wc.get();

    // TypeScript enforces readonly at compile time; at runtime we verify
    // the object is frozen or a copy that doesn't affect internal state.
    expect(() => {
      (config as any).browseItemCount = 99;
    }).toThrow();
  });

  it('update(partial) merges values into current config', () => {
    const wc = new WorklogConfig();
    wc.get(); // trigger lazy load

    wc.update({ browseItemCount: 10, showIcons: false });
    const config = wc.get();
    expect(config.browseItemCount).toBe(10);
    expect(config.showIcons).toBe(false);
    // Unchanged fields should keep their defaults
    expect(config.showActivityIndicator).toBe(true);
    expect(config.showHelpText).toBe(true);
  });

  it('update(partial) persists settings via writeFileSync', () => {
    const wc = new WorklogConfig();
    wc.get(); // trigger lazy load

    wc.update({ browseItemCount: 20 });
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('update(partial) notifies onChange subscribers', () => {
    const wc = new WorklogConfig();
    wc.get(); // trigger lazy load

    const callback = vi.fn();
    wc.onChange(callback);

    wc.update({ showIcons: false });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('onChange() returns a disposer that unsubscribes the callback', () => {
    const wc = new WorklogConfig();
    wc.get(); // trigger lazy load

    const callback = vi.fn();
    const dispose = wc.onChange(callback);

    // Update triggers callback
    wc.update({ browseItemCount: 7 });
    expect(callback).toHaveBeenCalledTimes(1);

    // Dispose removes the listener
    dispose();
    wc.update({ browseItemCount: 10 });
    expect(callback).toHaveBeenCalledTimes(1); // still 1
  });

  it('change notification propagates to all registered callbacks', () => {
    const wc = new WorklogConfig();
    wc.get(); // trigger lazy load

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();

    wc.onChange(cb1);
    wc.onChange(cb2);
    wc.onChange(cb3);

    wc.update({ showActivityIndicator: false });
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb3).toHaveBeenCalledTimes(1);
  });

  it('supports multiple update() calls with correct state accumulation', () => {
    const wc = new WorklogConfig();
    wc.get(); // trigger lazy load

    wc.update({ browseItemCount: 3 });
    expect(wc.get().browseItemCount).toBe(3);

    wc.update({ showIcons: false });
    expect(wc.get().browseItemCount).toBe(3);
    expect(wc.get().showIcons).toBe(false);

    wc.update({ browseItemCount: 10, showHelpText: false });
    expect(wc.get().browseItemCount).toBe(10);
    expect(wc.get().showIcons).toBe(false);
    expect(wc.get().showHelpText).toBe(false);
  });

  it('is not affected by mutations of the returned get() object', () => {
    const wc = new WorklogConfig();
    wc.get(); // trigger lazy load

    const config = wc.get();
    expect(config.browseItemCount).toBe(DEFAULT_SETTINGS.browseItemCount);

    wc.update({ browseItemCount: 25 });
    // The old reference should not reflect the change
    expect(config.browseItemCount).toBe(DEFAULT_SETTINGS.browseItemCount);
  });

  it('load() with explicit cwd discards previously loaded config', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('project-a/.pi/settings.json')) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 30 },
        });
      }
      if (path.includes('project-b/.pi/settings.json')) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 40 },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const wc = new WorklogConfig();
    wc.load('/path/to/project-a');
    expect(wc.get().browseItemCount).toBe(30);

    wc.load('/path/to/project-b');
    expect(wc.get().browseItemCount).toBe(40);
  });
});

// ── File watching tests ───────────────────────────────────────────────

describe('WorklogConfig — file watching', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockWatch.mockReset();
    mockWatchClose.mockReset();
    mockWatchListeners.length = 0;
    vi.useFakeTimers();

    // Default: all settings files missing
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('watchFile() calls fs.watch with the given path', () => {
    const wc = new WorklogConfig();
    wc.load('/some/project');

    wc.watchFile('/some/project/.pi/settings.json');
    expect(mockWatch).toHaveBeenCalledWith(
      '/some/project/.pi/settings.json',
      expect.any(Function),
    );
  });

  it('external file change triggers onChange subscribers after debounce', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('.pi/settings.json')) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 10 },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const wc = new WorklogConfig();
    wc.load('/some/project');

    const callback = vi.fn();
    wc.onChange(callback);

    wc.watchFile('/some/project/.pi/settings.json');

    // Simulate a file change event
    expect(mockWatchListeners.length).toBe(1);
    const handler = mockWatchListeners[0].handler;

    // Change the file content for reload
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('.pi/settings.json')) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 20 },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    handler('change', 'settings.json');

    // Should not fire immediately (debounced)
    expect(callback).not.toHaveBeenCalled();

    // Advance timers past debounce delay
    vi.advanceTimersByTime(300);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(wc.get().browseItemCount).toBe(20);
  });

  it('debouncing coalesces rapid successive writes', () => {
    // Track content version: each call to readFileSync for .pi/settings.json
    // returns an incrementing version to simulate actual edits.
    let version = 1;

    // Initial load: return version 1
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('.pi/settings.json')) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 10 + version },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const wc = new WorklogConfig();
    wc.load('/some/project');
    // After load, _config has browseItemCount=11 (10+1)

    const callback = vi.fn();
    wc.onChange(callback);
    wc.watchFile('/some/project/.pi/settings.json');

    expect(mockWatchListeners.length).toBe(1);
    const handler = mockWatchListeners[0].handler;

    // Now increment version so file content is different
    version = 5;

    // Rapid successive writes (editor auto-save style)
    handler('change', 'settings.json');
    vi.advanceTimersByTime(50);
    handler('change', 'settings.json');
    vi.advanceTimersByTime(100);
    handler('change', 'settings.json');

    // Should not have fired yet (debounced)
    expect(callback).not.toHaveBeenCalled();

    // Advance past the debounce window
    vi.advanceTimersByTime(300);

    // Should have fired exactly once (last write wins)
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('dispose() closes all file watchers', () => {
    const wc = new WorklogConfig();
    wc.load('/some/project');

    wc.watchFile('/some/project/.pi/settings.json');
    wc.watchFile('/some/project/.pi/other.json');

    expect(mockWatch).toHaveBeenCalledTimes(2);

    mockWatchClose.mockClear();
    wc.dispose();

    expect(mockWatchClose).toHaveBeenCalledTimes(2);
  });

  it('dispose() clears all onChange subscribers', () => {
    const wc = new WorklogConfig();
    wc.get();

    const callback = vi.fn();
    wc.onChange(callback);
    wc.dispose();

    wc.update({ browseItemCount: 5 });
    expect(callback).not.toHaveBeenCalled();
  });

  it('gracefully handles errors when watching a non-existent file', () => {
    mockWatch.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const wc = new WorklogConfig();
    wc.load('/some/project');

    // Should not throw
    expect(() => {
      wc.watchFile('/nonexistent/path/settings.json');
    }).not.toThrow();
  });

  it('does not trigger onChange when file changes but values are unchanged', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('.pi/settings.json')) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 10 },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const wc = new WorklogConfig();
    wc.load('/some/project');

    const callback = vi.fn();
    wc.onChange(callback);
    wc.watchFile('/some/project/.pi/settings.json');

    expect(mockWatchListeners.length).toBe(1);
    const handler = mockWatchListeners[0].handler;

    // Fire change event with same content
    handler('change', 'settings.json');
    vi.advanceTimersByTime(300);

    // Should not fire onChange because content hasn't changed
    expect(callback).not.toHaveBeenCalled();
  });
});

// ── Runtime /wl settings update tests ──────────────────────────────────

describe('WorklogConfig — runtime settings updates', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();

    // Default: all settings files missing
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('update() with full settings object replaces all values', () => {
    const wc = new WorklogConfig();
    wc.get(); // trigger lazy load

    // Simulate /wl settings command applying a batch of changes
    wc.update({
      browseItemCount: 10,
      showIcons: false,
      showActivityIndicator: false,
      showHelpText: false,
      autoInjectEnabled: false,
      guardrailsEnabled: false,
      autoSyncIntervalSeconds: 60,
    });

    const config = wc.get();
    expect(config.browseItemCount).toBe(10);
    expect(config.showIcons).toBe(false);
    expect(config.showActivityIndicator).toBe(false);
    expect(config.showHelpText).toBe(false);
    expect(config.autoInjectEnabled).toBe(false);
    expect(config.guardrailsEnabled).toBe(false);
    expect(config.autoSyncIntervalSeconds).toBe(60);
  });

  it('update() triggers onChange for all subscribed consumers', () => {
    const wc = new WorklogConfig();
    wc.get(); // trigger lazy load

    const browseFlowCallback = vi.fn();
    const autoInjectCallback = vi.fn();
    const guardrailsCallback = vi.fn();
    const activityIndicatorCallback = vi.fn();

    wc.onChange(browseFlowCallback);
    wc.onChange(autoInjectCallback);
    wc.onChange(guardrailsCallback);
    wc.onChange(activityIndicatorCallback);

    // Simulate running /wl settings
    wc.update({ browseItemCount: 8 });

    expect(browseFlowCallback).toHaveBeenCalledTimes(1);
    expect(autoInjectCallback).toHaveBeenCalledTimes(1);
    expect(guardrailsCallback).toHaveBeenCalledTimes(1);
    expect(activityIndicatorCallback).toHaveBeenCalledTimes(1);
  });

  it('values are immediately available via get() after update() without reload', () => {
    // Mock such that the file on disk has different values than what we set
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.includes('.pi/settings.json')) {
        return JSON.stringify({
          'context-hub': { browseItemCount: 3 },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const wc = new WorklogConfig();
    wc.load('/some/project');

    // Initially loaded from file
    expect(wc.get().browseItemCount).toBe(3);

    // Update at runtime — should override the on-disk value without reload
    wc.update({ browseItemCount: 20 });

    // Immediately available without any reload
    expect(wc.get().browseItemCount).toBe(20);

    // Changing it again should reflect immediately
    wc.update({ browseItemCount: 15 });
    expect(wc.get().browseItemCount).toBe(15);
  });

  it('partial update does not affect unchanged values', () => {
    const wc = new WorklogConfig();
    wc.get();

    wc.update({ browseItemCount: 25 });
    const config = wc.get();
    expect(config.browseItemCount).toBe(25);
    expect(config.showIcons).toBe(true); // unchanged
    expect(config.showActivityIndicator).toBe(true); // unchanged
    expect(config.autoSyncIntervalSeconds).toBe(10); // unchanged
  });

  it('multiple runtime update calls accumulate correctly', () => {
    const wc = new WorklogConfig();
    wc.get();

    // Simulate step-by-step configuration changes
    wc.update({ browseItemCount: 10 });
    expect(wc.get().browseItemCount).toBe(10);

    wc.update({ showIcons: false });
    expect(wc.get().browseItemCount).toBe(10); // preserved from earlier
    expect(wc.get().showIcons).toBe(false);

    wc.update({ browseItemCount: 30, showHelpText: false });
    expect(wc.get().browseItemCount).toBe(30);
    expect(wc.get().showIcons).toBe(false); // preserved from earlier
    expect(wc.get().showHelpText).toBe(false);
  });

  it('does not throw on empty or undefined partial', () => {
    const wc = new WorklogConfig();
    wc.get();

    expect(() => wc.update({})).not.toThrow();
    expect(() => wc.update({} as any)).not.toThrow();

    const config = wc.get();
    expect(config).toEqual(DEFAULT_SETTINGS);
  });
});

// ── Config validation tests ───────────────────────────────────────────

describe('WorklogConfig — config validation', () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();

    // Default: all settings files missing
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('browseItemCount validation', () => {
    it('clamps values below 1 to 1', () => {
      const wc = new WorklogConfig();
      wc.get();
      wc.update({ browseItemCount: 0 });
      expect(wc.get().browseItemCount).toBe(1);

      wc.update({ browseItemCount: -5 });
      expect(wc.get().browseItemCount).toBe(1);
    });

    it('clamps values above 50 to 50', () => {
      const wc = new WorklogConfig();
      wc.get();
      wc.update({ browseItemCount: 100 });
      expect(wc.get().browseItemCount).toBe(50);
    });

    it('accepts values within the valid range', () => {
      const wc = new WorklogConfig();
      wc.get();
      wc.update({ browseItemCount: 1 });
      expect(wc.get().browseItemCount).toBe(1);

      wc.update({ browseItemCount: 25 });
      expect(wc.get().browseItemCount).toBe(25);

      wc.update({ browseItemCount: 50 });
      expect(wc.get().browseItemCount).toBe(50);
    });

    it('replaces non-numeric values with default', () => {
      const wc = new WorklogConfig();
      wc.get();
      wc.update({ browseItemCount: null as any });
      expect(wc.get().browseItemCount).toBe(DEFAULT_SETTINGS.browseItemCount);

      wc.update({ browseItemCount: 'abc' as any });
      expect(wc.get().browseItemCount).toBe(DEFAULT_SETTINGS.browseItemCount);

      wc.update({ browseItemCount: undefined as any });
      expect(wc.get().browseItemCount).toBe(DEFAULT_SETTINGS.browseItemCount);
    });
  });

  describe('boolean settings validation', () => {
    it('rejects non-boolean values for showIcons, falling back to default', () => {
      const wc = new WorklogConfig();
      wc.get();
      wc.update({ showIcons: 'maybe' as any });
      expect(wc.get().showIcons).toBe(DEFAULT_SETTINGS.showIcons);
    });

    it('rejects null for showActivityIndicator', () => {
      const wc = new WorklogConfig();
      wc.get();
      wc.update({ showActivityIndicator: null as any });
      expect(wc.get().showActivityIndicator).toBe(DEFAULT_SETTINGS.showActivityIndicator);
    });

    it('rejects undefined for showHelpText', () => {
      const wc = new WorklogConfig();
      wc.get();
      wc.update({ showHelpText: undefined as any });
      expect(wc.get().showHelpText).toBe(DEFAULT_SETTINGS.showHelpText);
    });

    it('rejects non-boolean values for autoInjectEnabled', () => {
      const wc = new WorklogConfig();
      wc.get();
      wc.update({ autoInjectEnabled: 'yes' as any });
      expect(wc.get().autoInjectEnabled).toBe(DEFAULT_SETTINGS.autoInjectEnabled);
    });

    it('rejects non-boolean values for guardrailsEnabled', () => {
      const wc = new WorklogConfig();
      wc.get();
      wc.update({ guardrailsEnabled: 123 as any });
      expect(wc.get().guardrailsEnabled).toBe(DEFAULT_SETTINGS.guardrailsEnabled);
    });

    it('accepts valid boolean values', () => {
      const wc = new WorklogConfig();
      wc.get();

      wc.update({ showIcons: false });
      expect(wc.get().showIcons).toBe(false);

      wc.update({ showIcons: true });
      expect(wc.get().showIcons).toBe(true);
    });
  });

  describe('partial update validation', () => {
    it('only validates the provided keys in a partial update', () => {
      const wc = new WorklogConfig();
      wc.get();

      // Set browseItemCount to a known value first
      wc.update({ browseItemCount: 10 });
      expect(wc.get().browseItemCount).toBe(10);

      // Now update only autoInjectEnabled with an invalid value
      wc.update({ autoInjectEnabled: 'invalid' as any });
      // browseItemCount should remain unchanged
      expect(wc.get().browseItemCount).toBe(10);
      // autoInjectEnabled should fall back to default
      expect(wc.get().autoInjectEnabled).toBe(DEFAULT_SETTINGS.autoInjectEnabled);
    });

    it('does not modify valid values when other keys are invalid', () => {
      const wc = new WorklogConfig();
      wc.get();

      wc.update({
        browseItemCount: 25,
        showIcons: 'bad' as any,
      });

      // Valid value should be applied
      expect(wc.get().browseItemCount).toBe(25);
    });

    it('silently ignores unknown keys', () => {
      const wc = new WorklogConfig();
      wc.get();

      // Should not throw or corrupt state
      wc.update({ unknownKey: 'value' } as any);

      // State should remain at defaults
      expect(wc.get()).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('graceful degradation', () => {
    it('does not throw when all values are invalid', () => {
      const wc = new WorklogConfig();
      wc.get();

      expect(() => {
        wc.update({
          browseItemCount: 'not-a-number' as any,
          showIcons: 'not-a-boolean' as any,
          showActivityIndicator: null as any,
          guardrailsEnabled: 42 as any,
        });
      }).not.toThrow();

      // All values should fall back to defaults
      const config = wc.get();
      expect(config.browseItemCount).toBe(DEFAULT_SETTINGS.browseItemCount);
      expect(config.showIcons).toBe(DEFAULT_SETTINGS.showIcons);
      expect(config.showActivityIndicator).toBe(DEFAULT_SETTINGS.showActivityIndicator);
      expect(config.guardrailsEnabled).toBe(DEFAULT_SETTINGS.guardrailsEnabled);
    });

    it('gracefully handles empty objects without modifying state', () => {
      const wc = new WorklogConfig();
      wc.get();

      wc.update({} as any);
      expect(wc.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('gracefully handles null partial (should not throw)', () => {
      const wc = new WorklogConfig();
      wc.get();

      // TypeScript would catch this, but at runtime it could happen
      expect(() => wc.update(null as any)).not.toThrow();
    });
  });
});
