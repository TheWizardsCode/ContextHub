/**
 * Tests for background operations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backgroundSyncToJsonl } from '../../src/lib/background-operations.js';

// Mock the jsonl module
vi.mock('../../src/jsonl.js', () => ({
  getDefaultDataPath: vi.fn(() => '/tmp/test-data.jsonl'),
  exportToJsonlAsync: vi.fn(async () => 42),
}));

import { exportToJsonlAsync, getDefaultDataPath } from '../../src/jsonl.js';

describe('backgroundSyncToJsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls exportToJsonlAsync with the correct arguments', async () => {
    const items = [{ id: 'WL-1', title: 'Test' }] as any[];
    const comments = [] as any[];
    const dataPath = '/tmp/custom-path.jsonl';

    await backgroundSyncToJsonl(items, comments, dataPath);

    expect(exportToJsonlAsync).toHaveBeenCalledWith(
      items,
      comments,
      dataPath,
      [],
      [],
    );
  });

  it('uses default data path when none is provided', async () => {
    const items = [{ id: 'WL-2' }] as any[];
    const comments = [] as any[];

    await backgroundSyncToJsonl(items, comments);

    expect(getDefaultDataPath).toHaveBeenCalled();
    expect(exportToJsonlAsync).toHaveBeenCalledWith(
      items,
      comments,
      '/tmp/test-data.jsonl',
      [],
      [],
    );
  });

  it('passes dependencyEdges and auditResults when provided', async () => {
    const items = [{ id: 'WL-3' }] as any[];
    const comments = [] as any[];
    const edges = [{ dependentId: 'WL-2', prerequisiteId: 'WL-1' }] as any[];
    const audits = [{ workItemId: 'WL-3', passed: true }] as any[];

    await backgroundSyncToJsonl(items, comments, undefined, edges, audits);

    expect(exportToJsonlAsync).toHaveBeenCalledWith(
      items,
      comments,
      '/tmp/test-data.jsonl',
      edges,
      audits,
    );
  });

  it('does not throw when exportToJsonlAsync fails', async () => {
    vi.mocked(exportToJsonlAsync).mockRejectedValueOnce(new Error('export failed'));

    const items = [{ id: 'WL-4' }] as any[];
    const comments = [] as any[];

    // Should not throw
    await expect(
      backgroundSyncToJsonl(items, comments),
    ).resolves.toBeUndefined();
  });
});
