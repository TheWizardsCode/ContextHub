/**
 * Tests for setWorklogDir and --worklog-dir support in the herdr fetcher.
 *
 * These tests verify that:
 * - setWorklogDir stores the path correctly
 * - runWl includes --worklog-dir when the path is set
 * - runWl does NOT include --worklog-dir when not set
 *
 * Run: npx vitest run packages/herdr/src/setWorklogDir.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  setWorklogDir,
  resetWorklogDir,
  fetchNextItems,
  fetchItemsByStage,
  fetchItemDetails,
  fetchChildrenForItem,
  setExecFileAsync,
  resetExecFileAsync,
} from './fetcher.js';

describe('setWorklogDir / runWl with --worklog-dir', () => {
  beforeEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
  });

  afterEach(() => {
    resetWorklogDir();
  });

  it('includes --worklog-dir arg when set', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ results: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    setWorklogDir('/custom/path/.worklog');

    await fetchItemsByStage('plan_complete');

    // The args should include --worklog-dir /custom/path/.worklog before --json
    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--worklog-dir');
    const wlDirIndex = callArgs.indexOf('--worklog-dir');
    expect(callArgs[wlDirIndex + 1]).toBe('/custom/path/.worklog');
  });

  it('does not include --worklog-dir arg when not set', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ results: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('plan_complete');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('--worklog-dir');
  });

  it('includes --worklog-dir in fetchNextItems', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ results: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    setWorklogDir('/other/path/.worklog');

    await fetchNextItems(5);

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--worklog-dir');
    const wlDirIndex = callArgs.indexOf('--worklog-dir');
    expect(callArgs[wlDirIndex + 1]).toBe('/other/path/.worklog');
  });

  it('includes --worklog-dir in fetchChildrenForItem', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    setWorklogDir('/child-test/.worklog');

    await fetchChildrenForItem('WL-PARENT');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--worklog-dir');
    const wlDirIndex = callArgs.indexOf('--worklog-dir');
    expect(callArgs[wlDirIndex + 1]).toBe('/child-test/.worklog');
  });

  it('places --worklog-dir before the command name (not after)', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workItems: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    setWorklogDir('/global-opt/.worklog');

    await fetchItemsByStage('in_progress');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    // --worklog-dir must appear before the 'list' command
    const listIndex = callArgs.indexOf('list');
    const wlDirIndex = callArgs.indexOf('--worklog-dir');
    expect(wlDirIndex).toBeGreaterThanOrEqual(0);
    expect(wlDirIndex).toBeLessThan(listIndex);
  });

  it('resets to no --worklog-dir after resetWorklogDir', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ results: [] }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    // Set then reset
    setWorklogDir('/some/path/.worklog');
    resetWorklogDir();

    await fetchItemsByStage('plan_complete');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('--worklog-dir');
  });
});
