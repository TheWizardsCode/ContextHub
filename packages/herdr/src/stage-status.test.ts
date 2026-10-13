/**
 * Unit tests for STAGE_STATUS — verifies the correct --status argument per
 * stage in fetchItemsByStage (WL-0MUIB7D30009KG00).
 *
 * Run: npx vitest run packages/herdr/src/stage-status.test.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchItemsByStage,
  setExecFileAsync,
  resetExecFileAsync,
} from './fetcher.js';

afterEach(() => {
  resetExecFileAsync();
});

describe('STAGE_STATUS — fetchItemsByStage --status per stage', () => {
  it('plan_complete includes in-progress status', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ workItems: [] }), stderr: '' });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('plan_complete');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    const statusIdx = callArgs.indexOf('--status');
    expect(statusIdx).toBeGreaterThan(-1);
    expect(callArgs[statusIdx + 1]).toBe('open,in-progress');
  });

  it('intake_complete includes in-progress status', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ workItems: [] }), stderr: '' });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('intake_complete');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    const statusIdx = callArgs.indexOf('--status');
    expect(statusIdx).toBeGreaterThan(-1);
    expect(callArgs[statusIdx + 1]).toBe('open,in-progress');
  });

  it('in_review includes completed, in-progress, open, and blocked statuses', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ workItems: [] }), stderr: '' });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('in_review');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    const statusIdx = callArgs.indexOf('--status');
    expect(statusIdx).toBeGreaterThan(-1);
    // blocked is included so the review filter matches the release gate's
    // `wl list --stage in_review` (no status filter), which treats a
    // status=blocked in_review item as release-blocking (WL-0MV70XY6D008013C).
    expect(callArgs[statusIdx + 1]).toBe('completed,in-progress,open,blocked');
  });

  it('in_review query keeps a status=blocked root item in the filtered list', async () => {
    const mockFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workItems: [
          { id: 'WL-REVIEW', title: 'Review item', status: 'completed', stage: 'in_review' },
          { id: 'WL-BLOCKED', title: 'Blocked review item', status: 'blocked', stage: 'in_review' },
        ],
      }),
      stderr: '',
    });
    setExecFileAsync(mockFn as any);

    const items = await fetchItemsByStage('in_review');

    expect(items.map((i) => i.id)).toContain('WL-REVIEW');
    expect(items.map((i) => i.id)).toContain('WL-BLOCKED');
    const blocked = items.find((i) => i.id === 'WL-BLOCKED');
    expect(blocked?.status).toBe('blocked');
  });

  it('idea uses open-only status (blocked/in-progress excluded)', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ workItems: [] }), stderr: '' });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('idea');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    const statusIdx = callArgs.indexOf('--status');
    expect(statusIdx).toBeGreaterThan(-1);
    expect(callArgs[statusIdx + 1]).toBe('open');
  });

  it('rejects removed stage "completed" without issuing a CLI call (WL-0MUY1CRS7001UTQJ)', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ workItems: [] }), stderr: '' });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('completed');

    // Removed stages must never produce a CLI invocation
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('rejects removed stage "in_progress" without issuing a CLI call (WL-0MUY1CRS7001UTQJ)', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ workItems: [] }), stderr: '' });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('in_progress');

    // Removed stages must never produce a CLI invocation
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('done stage uses open-only status', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ workItems: [] }), stderr: '' });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('done');

    const callArgs = mockFn.mock.calls[0][1] as string[];
    const statusIdx = callArgs.indexOf('--status');
    expect(statusIdx).toBeGreaterThan(-1);
    expect(callArgs[statusIdx + 1]).toBe('open');
  });

  it('rejects unknown stages without issuing a CLI call (WL-0MUY1CRS7001UTQJ)', async () => {
    const mockFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ workItems: [] }), stderr: '' });
    setExecFileAsync(mockFn as any);

    await fetchItemsByStage('bogus');

    // Unknown stages must never produce a CLI invocation
    expect(mockFn).not.toHaveBeenCalled();
  });
});
