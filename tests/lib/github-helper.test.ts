import { describe, it, expect, vi } from 'vitest';
import {
  openExistingIssue,
  pushAndOpen,
  tryResolveConfig,
  githubPushOrOpen,
  type GithubHelperDeps,
  type GithubConfig,
} from '../../src/lib/github-helper.js';
import type { WorkItem, Comment } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers: create mock deps with sensible defaults
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<GithubHelperDeps>): GithubHelperDeps {
  return {
    resolveGithubConfig: vi.fn(() => ({ repo: 'owner/repo', labelPrefix: 'wl:' })),
    upsertIssuesFromWorkItems: vi.fn(async () => ({
      updatedItems: [],
      result: {
        updated: 0, created: 0, closed: 0, skipped: 0,
        errors: [], syncedItems: [], errorItems: [],
      },
    })),
    openUrl: vi.fn(async () => true),
    copyToClipboard: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

function createItem(overrides?: Partial<WorkItem>): WorkItem {
  return {
    id: 'WL-TEST-1',
    title: 'Test item',
    description: '',
    status: 'open' as any,
    priority: 'medium' as any,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sortIndex: 100,
    tags: [],
    ...overrides,
  } as WorkItem;
}

const testConfig: GithubConfig = { repo: 'owner/repo', labelPrefix: 'wl:' };

// ---------------------------------------------------------------------------
// tryResolveConfig
// ---------------------------------------------------------------------------
describe('tryResolveConfig', () => {
  it('returns config when resolveGithubConfig succeeds', () => {
    const deps = createMockDeps();
    const result = tryResolveConfig(deps);
    expect(result).toEqual({ config: { repo: 'owner/repo', labelPrefix: 'wl:' } });
  });

  it('returns error when resolveGithubConfig throws', () => {
    const deps = createMockDeps({
      resolveGithubConfig: vi.fn(() => { throw new Error('not configured'); }),
    });
    const result = tryResolveConfig(deps);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.success).toBe(false);
      expect(result.error.toastMessage).toContain('githubRepo');
    }
  });

  it('returns error when resolveGithubConfig returns null', () => {
    const deps = createMockDeps({
      resolveGithubConfig: vi.fn(() => null),
    });
    const result = tryResolveConfig(deps);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.success).toBe(false);
      expect(result.error.toastMessage).toContain('githubRepo');
    }
  });
});

// ---------------------------------------------------------------------------
// openExistingIssue
// ---------------------------------------------------------------------------
describe('openExistingIssue', () => {
  it('opens issue URL in browser when open succeeds', async () => {
    const deps = createMockDeps({ openUrl: vi.fn(async () => true) });
    const item = createItem({ githubIssueNumber: 42 } as any);

    const result = await openExistingIssue(item, testConfig, deps);

    expect(result.success).toBe(true);
    expect(result.url).toBe('https://github.com/owner/repo/issues/42');
    expect(result.toastMessage).toContain('Opening GitHub issue');
    expect(deps.openUrl).toHaveBeenCalledWith('https://github.com/owner/repo/issues/42', undefined);
  });

  it('falls back to clipboard when open fails', async () => {
    const deps = createMockDeps({
      openUrl: vi.fn(async () => false),
      copyToClipboard: vi.fn(async () => ({ success: true })),
    });
    const item = createItem({ githubIssueNumber: 42 } as any);

    const result = await openExistingIssue(item, testConfig, deps);

    expect(result.success).toBe(true);
    expect(result.url).toBe('https://github.com/owner/repo/issues/42');
    expect(result.toastMessage).toContain('URL copied');
    expect(deps.copyToClipboard).toHaveBeenCalled();
  });

  it('returns failure when both open and clipboard fail', async () => {
    const deps = createMockDeps({
      openUrl: vi.fn(async () => false),
      copyToClipboard: vi.fn(async () => ({ success: false, error: 'no clipboard' })),
    });
    const item = createItem({ githubIssueNumber: 42 } as any);

    const result = await openExistingIssue(item, testConfig, deps);

    expect(result.success).toBe(false);
    expect(result.toastMessage).toContain('Open failed');
  });

  it('returns GitHub URL in toast when openUrl throws', async () => {
    const deps = createMockDeps({
      openUrl: vi.fn(async () => { throw new Error('spawn failed'); }),
    });
    const item = createItem({ githubIssueNumber: 42 } as any);

    const result = await openExistingIssue(item, testConfig, deps);

    expect(result.success).toBe(false);
    expect(result.toastMessage).toBe('GitHub: https://github.com/owner/repo/issues/42');
  });

  it('passes writeOsc52 to copyToClipboard', async () => {
    const writeOsc52 = vi.fn();
    const deps = createMockDeps({
      openUrl: vi.fn(async () => false),
      copyToClipboard: vi.fn(async () => ({ success: true })),
      writeOsc52,
    });
    const item = createItem({ githubIssueNumber: 7 } as any);

    await openExistingIssue(item, testConfig, deps);

    const callOpts = (deps.copyToClipboard as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callOpts.writeOsc52).toBe(writeOsc52);
  });
});

// ---------------------------------------------------------------------------
// pushAndOpen
// ---------------------------------------------------------------------------
describe('pushAndOpen', () => {
  it('pushes and opens the newly created issue', async () => {
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: vi.fn(async () => ({
        updatedItems: [createItem({ githubIssueNumber: 99 } as any)],
        result: {
          updated: 0, created: 1, closed: 0, skipped: 0,
          errors: [],
          syncedItems: [{ action: 'created' as const, id: 'WL-TEST-1', title: 'Test item', issueNumber: 99 }],
          errorItems: [],
        },
      })),
      openUrl: vi.fn(async () => true),
    });
    const item = createItem();

    const result = await pushAndOpen(item, [], testConfig, deps);

    expect(result.success).toBe(true);
    expect(result.url).toBe('https://github.com/owner/repo/issues/99');
    expect(result.toastMessage).toBe('Pushed: owner/repo#99');
    expect(result.updatedItems).toHaveLength(1);
    expect(result.syncResult).toBeDefined();
  });

  it('falls back to clipboard after push when open fails', async () => {
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: vi.fn(async () => ({
        updatedItems: [createItem({ githubIssueNumber: 99 } as any)],
        result: {
          updated: 0, created: 1, closed: 0, skipped: 0,
          errors: [],
          syncedItems: [{ action: 'created' as const, id: 'WL-TEST-1', title: 'Test item', issueNumber: 99 }],
          errorItems: [],
        },
      })),
      openUrl: vi.fn(async () => false),
      copyToClipboard: vi.fn(async () => ({ success: true })),
    });
    const item = createItem();

    const result = await pushAndOpen(item, [], testConfig, deps);

    expect(result.success).toBe(true);
    // Push toast takes priority over clipboard toast when both succeed.
    expect(result.toastMessage).toBe('Pushed: owner/repo#99');
    expect(deps.copyToClipboard).toHaveBeenCalled();
    expect(result.updatedItems).toHaveLength(1);
  });

  it('shows URL-copied toast when push succeeds but both open and clipboard fail', async () => {
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: vi.fn(async () => ({
        updatedItems: [createItem({ githubIssueNumber: 99 } as any)],
        result: {
          updated: 0, created: 1, closed: 0, skipped: 0,
          errors: [],
          syncedItems: [{ action: 'created' as const, id: 'WL-TEST-1', title: 'Test item', issueNumber: 99 }],
          errorItems: [],
        },
      })),
      openUrl: vi.fn(async () => false),
      copyToClipboard: vi.fn(async () => ({ success: false, error: 'no clipboard' })),
    });
    const item = createItem();

    const result = await pushAndOpen(item, [], testConfig, deps);

    // Open failed, clipboard failed → shows Open failed message.
    expect(result.success).toBe(false);
    expect(result.toastMessage).toContain('Open failed');
  });

  it('returns error when push returns sync errors', async () => {
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: vi.fn(async () => ({
        updatedItems: [],
        result: {
          updated: 0, created: 0, closed: 0, skipped: 0,
          errors: ['Rate limit exceeded'],
          syncedItems: [],
          errorItems: [{ id: 'WL-TEST-1', title: 'Test item', error: 'Rate limit exceeded' }],
        },
      })),
    });
    const item = createItem();

    const result = await pushAndOpen(item, [], testConfig, deps);

    expect(result.success).toBe(false);
    expect(result.toastMessage).toBe('Push failed: Rate limit exceeded');
  });

  it('returns "no changes" when push syncs nothing', async () => {
    const deps = createMockDeps();
    const item = createItem();

    const result = await pushAndOpen(item, [], testConfig, deps);

    expect(result.success).toBe(true);
    expect(result.toastMessage).toBe('Push complete (no changes)');
  });

  it('returns failure when upsertIssuesFromWorkItems throws', async () => {
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: vi.fn(async () => { throw new Error('Network timeout'); }),
    });
    const item = createItem();

    const result = await pushAndOpen(item, [], testConfig, deps);

    expect(result.success).toBe(false);
    expect(result.toastMessage).toBe('Push failed: Network timeout');
  });

  it('opens existing mapping URL when sync does not return the item', async () => {
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: vi.fn(async () => ({
        updatedItems: [],
        result: {
          updated: 0, created: 0, closed: 0, skipped: 1,
          errors: [],
          syncedItems: [],
          errorItems: [],
        },
      })),
      openUrl: vi.fn(async () => true),
    });
    // Item already has a mapping but was passed to push anyway.
    const item = createItem({ githubIssueNumber: 55 } as any);

    const result = await pushAndOpen(item, [], testConfig, deps);

    expect(result.success).toBe(true);
    expect(result.url).toBe('https://github.com/owner/repo/issues/55');
    expect(result.toastMessage).toContain('Opening GitHub issue');
  });

  it('passes comments to upsertIssuesFromWorkItems', async () => {
    const deps = createMockDeps();
    const item = createItem();
    const comments = [{ workItemId: 'WL-TEST-1', id: 'C1', comment: 'test', author: 'a', createdAt: '', references: [] }] as Comment[];

    await pushAndOpen(item, comments, testConfig, deps);

    expect(deps.upsertIssuesFromWorkItems).toHaveBeenCalledWith(
      [item],
      comments,
      testConfig,
    );
  });
});

// ---------------------------------------------------------------------------
// githubPushOrOpen (high-level orchestrator)
// ---------------------------------------------------------------------------
describe('githubPushOrOpen', () => {
  it('returns config error when resolveGithubConfig throws', async () => {
    const deps = createMockDeps({
      resolveGithubConfig: vi.fn(() => { throw new Error('not configured'); }),
    });
    const item = createItem();

    const result = await githubPushOrOpen(item, deps);

    expect(result.success).toBe(false);
    expect(result.toastMessage).toContain('githubRepo');
  });

  it('opens existing issue when item has githubIssueNumber', async () => {
    const deps = createMockDeps({ openUrl: vi.fn(async () => true) });
    const item = createItem({ githubIssueNumber: 42 } as any);

    const result = await githubPushOrOpen(item, deps);

    expect(result.success).toBe(true);
    expect(result.url).toContain('/issues/42');
    // Should NOT call upsertIssuesFromWorkItems.
    expect(deps.upsertIssuesFromWorkItems).not.toHaveBeenCalled();
  });

  it('pushes when item has no githubIssueNumber', async () => {
    const upsertFn = vi.fn(async () => ({
      updatedItems: [createItem({ githubIssueNumber: 10 } as any)],
      result: {
        updated: 0, created: 1, closed: 0, skipped: 0,
        errors: [],
        syncedItems: [{ action: 'created' as const, id: 'WL-TEST-1', title: 'Test item', issueNumber: 10 }],
        errorItems: [],
      },
    }));
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: upsertFn,
      openUrl: vi.fn(async () => true),
    });
    const item = createItem();

    const result = await githubPushOrOpen(item, deps);

    expect(result.success).toBe(true);
    expect(result.toastMessage).toContain('Pushed');
    expect(upsertFn).toHaveBeenCalled();
  });

  it('persists updated items via db.upsertItems', async () => {
    const updatedItem = createItem({ githubIssueNumber: 10 } as any);
    const upsertItems = vi.fn();
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: vi.fn(async () => ({
        updatedItems: [updatedItem],
        result: {
          updated: 0, created: 1, closed: 0, skipped: 0,
          errors: [],
          syncedItems: [{ action: 'created' as const, id: 'WL-TEST-1', title: 'Test item', issueNumber: 10 }],
          errorItems: [],
        },
      })),
      openUrl: vi.fn(async () => true),
    });
    const item = createItem();

    await githubPushOrOpen(item, {
      ...deps,
      db: {
        getCommentsForWorkItem: vi.fn(() => []),
        upsertItems,
      },
    });

    expect(upsertItems).toHaveBeenCalledWith([updatedItem]);
  });

  it('calls refreshFromDatabase after push', async () => {
    const refreshFromDatabase = vi.fn();
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: vi.fn(async () => ({
        updatedItems: [createItem({ githubIssueNumber: 10 } as any)],
        result: {
          updated: 0, created: 1, closed: 0, skipped: 0,
          errors: [],
          syncedItems: [{ action: 'created' as const, id: 'WL-TEST-1', title: 'Test item', issueNumber: 10 }],
          errorItems: [],
        },
      })),
      openUrl: vi.fn(async () => true),
    });
    const item = createItem();

    await githubPushOrOpen(item, {
      ...deps,
      refreshFromDatabase,
      selectedIndex: 3,
    });

    expect(refreshFromDatabase).toHaveBeenCalledWith(3);
  });

  it('fetches comments from db when provided', async () => {
    const getCommentsForWorkItem = vi.fn(() => [{ workItemId: 'WL-TEST-1', id: 'C1', comment: 'hi', author: 'a', createdAt: '', references: [] }]);
    const deps = createMockDeps({
      openUrl: vi.fn(async () => true),
    });
    const item = createItem();

    await githubPushOrOpen(item, {
      ...deps,
      db: { getCommentsForWorkItem, upsertItems: vi.fn() },
    });

    expect(getCommentsForWorkItem).toHaveBeenCalledWith('WL-TEST-1');
    // Comments should have been passed to upsertIssuesFromWorkItems.
    const upsertCall = (deps.upsertIssuesFromWorkItems as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(upsertCall[1]).toHaveLength(1);
  });

  it('does not crash when refreshFromDatabase throws', async () => {
    const deps = createMockDeps({
      upsertIssuesFromWorkItems: vi.fn(async () => ({
        updatedItems: [],
        result: {
          updated: 0, created: 0, closed: 0, skipped: 0,
          errors: [], syncedItems: [], errorItems: [],
        },
      })),
    });
    const item = createItem();

    const result = await githubPushOrOpen(item, {
      ...deps,
      refreshFromDatabase: () => { throw new Error('render crashed'); },
    });

    // Should still return a result (no throw).
    expect(result).toBeDefined();
    expect(result.toastMessage).toBe('Push complete (no changes)');
  });
});
