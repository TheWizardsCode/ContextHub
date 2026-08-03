/**
 * Tests for the herdr plugin's work-item claiming behaviour:
 * - extractWorkItemId — pulls the work-item ID out of an agent command
 * - claimWorkItem — runs `wl update <id> --status in_progress` (fetcher)
 * - claimItemForAgentCommand — the onCommand seam used before spawning the
 *   agent pane (AC1: set in_progress before spawning; AC2: non-blocking)
 *
 * Run: npx vitest run packages/herdr/src/claim.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractWorkItemId, claimItemForAgentCommand } from './index.js';
import {
  claimWorkItem,
  setWorklogDir,
  resetWorklogDir,
  setExecFileAsync,
  resetExecFileAsync,
} from './fetcher.js';

describe('extractWorkItemId', () => {
  it('extracts the work-item ID from /skill: commands', () => {
    expect(extractWorkItemId('/skill:implement WL-0MS9NPHQU005Y3VE')).toBe(
      'WL-0MS9NPHQU005Y3VE',
    );
    expect(extractWorkItemId('/skill:audit WL-0MRMBRK750042QC9')).toBe(
      'WL-0MRMBRK750042QC9',
    );
  });

  it('extracts the work-item ID from /intake and /plan commands', () => {
    expect(extractWorkItemId('/intake WL-0MS9NPHQU005Y3VE')).toBe(
      'WL-0MS9NPHQU005Y3VE',
    );
    expect(extractWorkItemId('/plan WL-0MS9NPHQU005Y3VE')).toBe(
      'WL-0MS9NPHQU005Y3VE',
    );
  });

  it('returns the last ID when multiple ID-shaped tokens are present', () => {
    expect(extractWorkItemId('/skill:implement WL-0MSAAAAA WL-0MSBBBBB')).toBe(
      'WL-0MSBBBBB',
    );
  });

  it('returns undefined when the command has no work-item ID', () => {
    expect(extractWorkItemId('/intake')).toBeUndefined();
    expect(extractWorkItemId('/plan')).toBeUndefined();
    expect(extractWorkItemId('/skill:implement')).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only commands', () => {
    expect(extractWorkItemId('')).toBeUndefined();
    expect(extractWorkItemId('   ')).toBeUndefined();
  });

  it('returns undefined for unresolved <id> placeholders', () => {
    expect(extractWorkItemId('/skill:implement <id>')).toBeUndefined();
  });
});

describe('claimWorkItem (fetcher)', () => {
  beforeEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
  });

  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
  });

  it('runs wl update with --status in_progress and the assignee', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: '{"success":true}',
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const result = await claimWorkItem('WL-0MS9NPHQU005Y3VE', 'Map');

    expect(result.success).toBe(true);
    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('update');
    expect(callArgs).toContain('WL-0MS9NPHQU005Y3VE');
    expect(callArgs).toContain('--status');
    expect(callArgs[callArgs.indexOf('--status') + 1]).toBe('in_progress');
    expect(callArgs).toContain('--assignee');
    expect(callArgs[callArgs.indexOf('--assignee') + 1]).toBe('Map');
    // JSON output for machine-readable status
    expect(callArgs).toContain('--json');
  });

  it('includes --worklog-dir when the fetcher is configured', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: '{"success":true}',
      stderr: '',
    });
    setExecFileAsync(mockFn as any);
    setWorklogDir('/project/.worklog');

    await claimWorkItem('WL-0MS9NPHQU005Y3VE', 'Map');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--worklog-dir');
    expect(callArgs[callArgs.indexOf('--worklog-dir') + 1]).toBe(
      '/project/.worklog',
    );
  });

  it('returns success:false (does not throw) when wl update fails', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('worklog: no such item'));
    setExecFileAsync(mockFn as any);

    const result = await claimWorkItem('WL-NOTREAL', 'Map');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('claimItemForAgentCommand (onCommand seam)', () => {
  beforeEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
  });

  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
    vi.restoreAllMocks();
  });

  it('claims the item referenced in an agent command', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: '{"success":true}',
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await claimItemForAgentCommand('/skill:implement WL-0MS9NPHQU005Y3VE');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    expect(callArgs).toContain('WL-0MS9NPHQU005Y3VE');
    expect(callArgs).toContain('--status');
    expect(callArgs[callArgs.indexOf('--status') + 1]).toBe('in_progress');
  });

  it('skips the wl update (no error) when the command has no work-item ID', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: '{"success":true}',
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    await expect(claimItemForAgentCommand('/intake')).resolves.toBeUndefined();

    expect(mockFn).not.toHaveBeenCalled();
  });

  it('logs failures to stderr without throwing (non-blocking)', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('wl CLI exploded'));
    setExecFileAsync(mockFn as any);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(
      claimItemForAgentCommand('/intake WL-0MS9NPHQU005Y3VE'),
    ).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to set WL-0MS9NPHQU005Y3VE'),
    );
    stderrSpy.mockRestore();
  });
});
