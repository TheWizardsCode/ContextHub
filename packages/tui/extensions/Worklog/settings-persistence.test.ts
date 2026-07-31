/**
 * Unit tests for settings persistence to Pi's .pi/settings.json.
 *
 * Verifies that:
 * 1. createDefaultListWorkItems dynamically reads currentSettings.browseItemCount
 *    on each invocation, not at factory-creation time (fix for stale-capture bug).
 * 2. createListWorkItemsWithStage has the same dynamic behavior.
 * 3. updateSettings() correctly updates the module-level currentSettings,
 *    and factory functions pick up the new value on subsequent calls.
 * 4. updateSettings() persists changes to .pi/settings.json under the
 *    context-hub namespace, preserving other keys.
 *
 * Run: npx vitest run packages/tui/extensions/settings-persistence.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock node:fs to prevent updateSettings() from writing to real
 * settings files on disk, which would leak state into other test files
 * (especially when tests run in parallel workers).
 */
const mockReadFileSync = vi.hoisted(() =>
  vi.fn(),
);
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  realpathSync: vi.fn((p) => p),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

import {
  createDefaultListWorkItems,
  createListWorkItemsWithStage,
  updateSettings,
} from './index.js';

/**
 * Reset module-level settings state to defaults before each test.
 * Uses updateSettings which modifies currentSettings in memory; the
 * mocked writeFileSync prevents filesystem side effects.
 */
beforeEach(() => {
  // Default mock: global settings file doesn't exist, project settings file
  // exists with basic settings.
  mockReadFileSync.mockImplementation((path: string) => {
    if (path.endsWith('.pi/settings.json')) {
      return JSON.stringify({
        'context-hub': { browseItemCount: 5, showIcons: true, showActivityIndicator: true, showHelpText: true },
      });
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  mockWriteFileSync.mockClear();
  mockMkdirSync.mockClear();
  // Reset to known defaults via updateSettings
  updateSettings({ browseItemCount: 5, showIcons: true, showActivityIndicator: true, showHelpText: true });
});

/**
 * Create a mock run function that captures args and returns a valid empty
 * response compatible with extractJsonObject/normalizeListPayload.
 */
function createMockRun() {
  return vi.fn().mockResolvedValue('{"results":[]}');
}

describe('createDefaultListWorkItems', () => {
  let mockRun: ReturnType<typeof createMockRun>;

  beforeEach(() => {
    mockRun = createMockRun();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses currentSettings.browseItemCount when no explicit count is given', async () => {
    const factory = createDefaultListWorkItems(mockRun);
    await factory();

    expect(mockRun).toHaveBeenCalledWith(
      expect.arrayContaining(['-n', '5']),
    );
  });

  it('uses explicit count when provided, ignoring currentSettings', async () => {
    const factory = createDefaultListWorkItems(mockRun, 3);
    await factory();

    expect(mockRun).toHaveBeenCalledWith(
      expect.arrayContaining(['-n', '3']),
    );
  });

  it('dynamically reads updated currentSettings after factory creation', async () => {
    const factory = createDefaultListWorkItems(mockRun);

    updateSettings({ browseItemCount: 10 });

    await factory();

    expect(mockRun).toHaveBeenCalledWith(
      expect.arrayContaining(['-n', '10']),
    );
  });

  it('dynamically reads updated currentSettings on second call without recreation', async () => {
    const factory = createDefaultListWorkItems(mockRun);

    await factory();
    // First call: wl next -n 5 (mandatory subset list queries follow).
    expect(mockRun).toHaveBeenNthCalledWith(1,
      expect.arrayContaining(['-n', '5']),
    );

    updateSettings({ browseItemCount: 15 });

    await factory();
    // Second factory call: the wl next call is the 4th invocation overall
    // (calls 1-3: next + 2 mandatory list queries from the first fetch).
    expect(mockRun).toHaveBeenNthCalledWith(4,
      expect.arrayContaining(['-n', '15']),
    );
  });
});

describe('createListWorkItemsWithStage', () => {
  let mockRun: ReturnType<typeof createMockRun>;

  beforeEach(() => {
    mockRun = createMockRun();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses currentSettings.browseItemCount when no explicit count is given', async () => {
    const factory = createListWorkItemsWithStage(mockRun);
    await factory('in_progress');

    expect(mockRun).toHaveBeenCalledWith(
      expect.arrayContaining(['-n', '5']),
    );
  });

  it('uses explicit count when provided', async () => {
    const factory = createListWorkItemsWithStage(mockRun, 3);
    await factory('in_progress');

    expect(mockRun).toHaveBeenCalledWith(
      expect.arrayContaining(['-n', '3']),
    );
  });

  it('passes stage argument to the run function', async () => {
    const factory = createListWorkItemsWithStage(mockRun);
    await factory('plan_complete');

    expect(mockRun).toHaveBeenCalledWith(
      expect.arrayContaining(['--stage', 'plan_complete']),
    );
  });

  it('dynamically reads updated currentSettings after factory creation', async () => {
    const factory = createListWorkItemsWithStage(mockRun);

    updateSettings({ browseItemCount: 20 });

    await factory('in_progress');

    expect(mockRun).toHaveBeenCalledWith(
      expect.arrayContaining(['-n', '20']),
    );
  });

  it('dynamically reads updated currentSettings on second call without recreation', async () => {
    const factory = createListWorkItemsWithStage(mockRun);

    await factory('intake_complete');
    expect(mockRun).toHaveBeenNthCalledWith(1,
      expect.arrayContaining(['-n', '5']),
    );

    updateSettings({ browseItemCount: 8 });
    await factory('in_review');
    expect(mockRun).toHaveBeenNthCalledWith(2,
      expect.arrayContaining(['-n', '8']),
    );
  });
});

describe('updateSettings', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the updated settings object', () => {
    const result = updateSettings({ browseItemCount: 42 });
    expect(result.browseItemCount).toBe(42);
  });

  it('preserves other settings fields when updating one field', () => {
    const result = updateSettings({ browseItemCount: 7 });
    expect(result.showIcons).toBe(true);
  });

  it('persists multiple field updates', () => {
    const result = updateSettings({ browseItemCount: 12, showIcons: false });
    expect(result.browseItemCount).toBe(12);
    expect(result.showIcons).toBe(false);
  });

  it('writes to .pi/settings.json under context-hub namespace', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      // Project settings file exists with some keys
      if (path.endsWith('.pi/settings.json')) {
        return JSON.stringify({
          'llm-wiki': { notices: false },
          'context-hub': { browseItemCount: 10, showIcons: false },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockWriteFileSync.mockClear();

    updateSettings({ browseItemCount: 7, showActivityIndicator: false });

    // First readFileSync call during updateSettings reads existing .pi/settings.json
    // Then writeFileSync should be called with updated content
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

    const writeCall = mockWriteFileSync.mock.calls[0];
    const writtenPath = writeCall[0];
    expect(writtenPath).toContain('.pi/settings.json');

    const writtenContent = JSON.parse(writeCall[1]);
    // llm-wiki key should be preserved
    expect(writtenContent['llm-wiki']).toEqual({ notices: false });
    // context-hub should have the merged settings
    expect(writtenContent['context-hub'].browseItemCount).toBe(7);
    expect(writtenContent['context-hub'].showIcons).toBe(false); // preserved from existing file
    expect(writtenContent['context-hub'].showActivityIndicator).toBe(false); // newly set
    // showHelpText was never set in existing config or partial, so it should not be present
    expect(writtenContent['context-hub']).not.toHaveProperty('showHelpText');
  });

  it('preserves other top-level keys when writing to .pi/settings.json', () => {
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith('.pi/settings.json')) {
        return JSON.stringify({
          'llm-wiki': { notices: false, trajectories: true },
          'context-hub': { browseItemCount: 5, showIcons: true },
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockWriteFileSync.mockClear();

    updateSettings({ showHelpText: false });

    const writeCall = mockWriteFileSync.mock.calls[0];
    const writtenContent = JSON.parse(writeCall[1]);
    // Other namespaces preserved
    expect(writtenContent['llm-wiki']).toEqual({ notices: false, trajectories: true });
    expect(writtenContent['context-hub'].showHelpText).toBe(false);
  });

  it('creates the .pi directory if it does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockWriteFileSync.mockClear();
    mockMkdirSync.mockClear();

    updateSettings({ browseItemCount: 5 });

    expect(mockMkdirSync).toHaveBeenCalled();
    // Should be called with recursive: true
    const mkdirCall = mockMkdirSync.mock.calls[0];
    expect(mkdirCall[1]).toEqual({ recursive: true });
  });

  it('handles write errors gracefully (no crash)', () => {
    mockWriteFileSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    // Should not throw
    expect(() => updateSettings({ browseItemCount: 5 })).not.toThrow();
  });
});
