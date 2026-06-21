/**
 * Unit tests for settings persistence across work-item action lifecycle.
 *
 * Verifies that:
 * 1. createDefaultListWorkItems dynamically reads currentSettings.browseItemCount
 *    on each invocation, not at factory-creation time (fix for stale-capture bug).
 * 2. createListWorkItemsWithStage has the same dynamic behavior.
 * 3. updateSettings() correctly updates the module-level currentSettings,
 *    and factory functions pick up the new value on subsequent calls.
 *
 * Run: npx vitest run packages/tui/extensions/settings-persistence.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock node:fs to prevent updateSettings() from writing to the real
 * settings.json on disk, which would leak state into other test files
 * (especially when tests run in parallel workers).
 */
const mockReadFileSync = vi.hoisted(() =>
  vi.fn().mockReturnValue(JSON.stringify({ browseItemCount: 5, showIcons: true })),
);
const mockWriteFileSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  realpathSync: vi.fn((p) => p),
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
  mockReadFileSync.mockReturnValue(JSON.stringify({ browseItemCount: 5, showIcons: true }));
  mockWriteFileSync.mockClear();
  updateSettings({ browseItemCount: 5, showIcons: true });
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

    // Default browseItemCount is 5 (from DEFAULT_SETTINGS)
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
    // Create factory when currentSettings.browseItemCount is default (5)
    const factory = createDefaultListWorkItems(mockRun);

    // Update settings to a different value
    updateSettings({ browseItemCount: 10 });

    // Call the factory (created before the update)
    await factory();

    // Should use the updated value (10), not the original (5)
    expect(mockRun).toHaveBeenCalledWith(
      expect.arrayContaining(['-n', '10']),
    );
  });

  it('dynamically reads updated currentSettings on second call without recreation', async () => {
    const factory = createDefaultListWorkItems(mockRun);

    // First call with default settings
    await factory();
    expect(mockRun).toHaveBeenNthCalledWith(1,
      expect.arrayContaining(['-n', '5']),
    );

    // Update settings
    updateSettings({ browseItemCount: 15 });

    // Second call with updated settings — no new factory needed
    await factory();
    expect(mockRun).toHaveBeenNthCalledWith(2,
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

    // Update settings after factory creation
    updateSettings({ browseItemCount: 20 });

    await factory('in_progress');

    expect(mockRun).toHaveBeenCalledWith(
      expect.arrayContaining(['-n', '20']),
    );
  });

  it('dynamically reads updated currentSettings on second call without recreation', async () => {
    const factory = createListWorkItemsWithStage(mockRun);

    // First call with default
    await factory('intake_complete');
    expect(mockRun).toHaveBeenNthCalledWith(1,
      expect.arrayContaining(['-n', '5']),
    );

    // Update and call again
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
    // showIcons should still have its default (true)
    expect(result.showIcons).toBe(true);
  });

  it('persists multiple field updates', () => {
    const result = updateSettings({ browseItemCount: 12, showIcons: false });
    expect(result.browseItemCount).toBe(12);
    expect(result.showIcons).toBe(false);
  });
});
