/**
 * Unit tests for the delegate subcommand guard rails:
 * - do-not-delegate tag check
 * - children warning
 * - invalid/missing work item ID
 * - --force bypass
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process to prevent real gh CLI calls
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execSync: vi.fn(() => ''),
}));

// Mock the github-sync module to prevent real GitHub API calls
vi.mock('../../src/github-sync.js', () => ({
  upsertIssuesFromWorkItems: vi.fn(async (items: any[]) => ({
    updatedItems: items,
    result: { created: 0, updated: 0, closed: 0, skipped: 0, errors: [], syncedItems: [], errorItems: [], commentsCreated: 0, commentsUpdated: 0 },
    timing: { totalMs: 0, upsertMs: 0, commentListMs: 0, commentUpsertMs: 0, hierarchyCheckMs: 0, hierarchyLinkMs: 0, hierarchyVerifyMs: 0 },
  })),
  importIssuesToWorkItems: vi.fn(),
}));

// Mock config and github helpers
vi.mock('../../src/config.js', () => ({
  loadConfig: () => ({ githubRepo: 'test-owner/test-repo', githubLabelPrefix: 'wl:' }),
}));

vi.mock('../../src/github.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    getRepoFromGitRemote: () => 'test-owner/test-repo',
    assignGithubIssueAsync: vi.fn(async () => ({ ok: true })),
  };
});

import registerGithub from '../../src/commands/github.js';

/**
 * Create a minimal context that supports nested subcommand registration
 * (github -> delegate). This mimics the real Commander structure enough
 * to invoke the delegate action handler.
 */
function createDelegateTestContext() {
  let nextId = 1;
  const items = new Map<string, any>();
  const comments: any[] = [];
  const createdComments: any[] = [];
  let processExitCode: number | undefined;
  const jsonOutput: any[] = [];
  const errorOutput: any[] = [];
  const consoleMessages: string[] = [];

  // Track registered subcommands by their chain: github -> delegate
  const commandHandlers = new Map<string, { handler: Function; options: any }>();
  let currentChain: string[] = [];

  function createCommandBuilder(parentChain: string[]) {
    const meta: any = { opts: {} };
    const builder: any = {
      description: (_d: string) => builder,
      alias: (_a: string) => builder,
      option: (spec: string, _desc?: string, defaultVal?: any) => {
        // Parse option name from spec (e.g., '--force' -> 'force', '--prefix <prefix>' -> 'prefix')
        const match = spec.match(/--([a-z-]+)/);
        if (match) {
          const camelKey = match[1].replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase());
          if (defaultVal !== undefined) meta.opts[camelKey] = defaultVal;
        }
        return builder;
      },
      command: (spec: string) => {
        const name = spec.split(' ')[0];
        return createCommandBuilder([...parentChain, name]);
      },
      action: (fn: Function) => {
        const key = parentChain.join('.');
        commandHandlers.set(key, { handler: fn, options: meta.opts });
        return builder;
      },
    };
    return builder;
  }

  const makeItem = (overrides: any = {}) => {
    const id = overrides.id || `WL-TEST-${nextId++}`;
    const now = new Date().toISOString();
    const item = {
      id,
      title: overrides.title || 'Sample',
      description: '',
      status: overrides.status || 'open',
      priority: 'medium',
      sortIndex: 0,
      parentId: overrides.parentId || null,
      createdAt: now,
      updatedAt: now,
      tags: overrides.tags || [],
      assignee: overrides.assignee || '',
      stage: '',
      issueType: 'task',
      createdBy: '',
      deletedBy: '',
      deleteReason: '',
      risk: '',
      effort: '',
      needsProducerReview: false,
      githubIssueNumber: overrides.githubIssueNumber,
      ...overrides,
    };
    items.set(id, item);
    return id;
  };

  const db = {
    get: (id: string) => items.get(id) || null,
    getAll: () => Array.from(items.values()),
    getAllComments: () => comments,
    getChildren: (parentId: string) => Array.from(items.values()).filter(i => i.parentId === parentId),
    getDescendants: (parentId: string) => Array.from(items.values()).filter(i => i.parentId === parentId),
    import: (updatedItems: any[]) => {
      for (const item of updatedItems) {
        items.set(item.id, item);
      }
    },
    update: (id: string, updates: any) => {
      const cur = items.get(id);
      if (!cur) return null;
      const next = { ...cur, ...updates };
      items.set(id, next);
      return next;
    },
    createComment: (input: any) => {
      const c = { id: `WL-C${nextId++}`, ...input, createdAt: new Date().toISOString() };
      createdComments.push(c);
      comments.push(c);
      return c;
    },
    getCommentsForWorkItem: (id: string) => comments.filter(c => c.workItemId === id),
  };

  const output = {
    json: (data: any) => jsonOutput.push(data),
    error: (msg: string, data?: any) => errorOutput.push({ msg, data }),
  };

  const program = {
    opts: () => ({ verbose: false, format: undefined, json: false }),
    command: (spec: string) => createCommandBuilder([spec.split(' ')[0]]),
  };

  const ctx = {
    program,
    output,
    utils: {
      requireInitialized: () => {},
      getDatabase: () => db,
      normalizeCliId: (id: string) => id,
      isJsonMode: () => false,
    },
  };

  // Replace process.exit with a throw so we can test exit paths
  const origExit = process.exit;
  const exitSpy = vi.fn((code?: number) => {
    processExitCode = code;
    throw new Error(`process.exit(${code})`);
  }) as any;

  // Capture console.log
  const origLog = console.log;
  const logSpy = vi.fn((...args: any[]) => {
    consoleMessages.push(args.join(' '));
  });

  return {
    ctx,
    db,
    items,
    makeItem,
    commandHandlers,
    output,
    jsonOutput,
    errorOutput,
    consoleMessages,
    getExitCode: () => processExitCode,
    createdComments,
    setup: () => {
      process.exit = exitSpy;
      console.log = logSpy;
    },
    teardown: () => {
      process.exit = origExit;
      console.log = origLog;
      processExitCode = undefined;
      jsonOutput.length = 0;
      errorOutput.length = 0;
      consoleMessages.length = 0;
      createdComments.length = 0;
      items.clear();
      comments.length = 0;
    },
    /**
     * Invoke the delegate handler with the given id and options.
     */
    async runDelegate(id: string, options: Record<string, any> = {}) {
      const entry = commandHandlers.get('github.delegate');
      if (!entry) throw new Error('delegate command not registered');
      const mergedOptions = { ...entry.options, ...options };
      return entry.handler(id, mergedOptions);
    },
  };
}

describe('delegate subcommand guard rails', () => {
  let t: ReturnType<typeof createDelegateTestContext>;

  beforeEach(() => {
    t = createDelegateTestContext();
    registerGithub(t.ctx as any);
    t.setup();
  });

  afterEach(() => {
    t.teardown();
    vi.restoreAllMocks();
  });

  it('registers the delegate subcommand', () => {
    expect(t.commandHandlers.has('github.delegate')).toBe(true);
  });

  it('exits with error when work item is not found', async () => {
    await expect(t.runDelegate('WL-NONEXISTENT')).rejects.toThrow('process.exit(1)');
    expect(t.errorOutput).toHaveLength(1);
    expect(t.errorOutput[0].msg).toContain('Work item not found');
    expect(t.errorOutput[0].data.success).toBe(false);
  });

  it('exits with error when work item has do-not-delegate tag and no --force', async () => {
    const id = t.makeItem({ tags: ['do-not-delegate'] });
    await expect(t.runDelegate(id)).rejects.toThrow('process.exit(1)');
    expect(t.errorOutput).toHaveLength(1);
    expect(t.errorOutput[0].msg).toContain('do-not-delegate');
    expect(t.errorOutput[0].data.error).toBe('do-not-delegate');
  });

  it('proceeds when work item has do-not-delegate tag with --force', async () => {
    const id = t.makeItem({ tags: ['do-not-delegate'], githubIssueNumber: 42 });
    // Should not throw for the do-not-delegate guard; may still proceed to push+assign
    await t.runDelegate(id, { force: true });
    expect(t.consoleMessages.some(m => m.includes('--force'))).toBe(true);
    // Should not have the do-not-delegate error
    expect(t.errorOutput.filter(e => e.data?.error === 'do-not-delegate')).toHaveLength(0);
  });

  it('warns about children in non-interactive mode and proceeds', async () => {
    const parentId = t.makeItem({ id: 'WL-PARENT-1', githubIssueNumber: 10 });
    t.makeItem({ id: 'WL-CHILD-1', parentId: 'WL-PARENT-1', status: 'open' });
    t.makeItem({ id: 'WL-CHILD-2', parentId: 'WL-PARENT-1', status: 'open' });

    // non-interactive mode (stdout is not TTY in test environment)
    await t.runDelegate('WL-PARENT-1');
    // Should warn about children but proceed
    expect(t.consoleMessages.some(m => m.includes('child item(s)'))).toBe(true);
  });

  it('does not warn about children when all children are closed', async () => {
    t.makeItem({ id: 'WL-PARENT-2', githubIssueNumber: 20 });
    t.makeItem({ id: 'WL-CHILD-3', parentId: 'WL-PARENT-2', status: 'completed' });
    t.makeItem({ id: 'WL-CHILD-4', parentId: 'WL-PARENT-2', status: 'deleted' });

    await t.runDelegate('WL-PARENT-2');
    // Should not warn about children since they're all closed/deleted
    expect(t.consoleMessages.filter(m => m.includes('child item(s)'))).toHaveLength(0);
  });

  it('does not warn about children when item has no children', async () => {
    t.makeItem({ id: 'WL-LEAF-1', githubIssueNumber: 30 });

    await t.runDelegate('WL-LEAF-1');
    expect(t.consoleMessages.filter(m => m.includes('child item(s)'))).toHaveLength(0);
  });

  it('outputs success in JSON mode', async () => {
    t.makeItem({ id: 'WL-JSON-1', githubIssueNumber: 50 });
    // Enable JSON mode
    t.ctx.utils.isJsonMode = () => true;

    await t.runDelegate('WL-JSON-1');
    expect(t.jsonOutput).toHaveLength(1);
    expect(t.jsonOutput[0].success).toBe(true);
    expect(t.jsonOutput[0].workItemId).toBe('WL-JSON-1');
    expect(t.jsonOutput[0].issueNumber).toBe(50);
    expect(t.jsonOutput[0].issueUrl).toContain('test-owner/test-repo');
    expect(t.jsonOutput[0].pushed).toBe(true);
    expect(t.jsonOutput[0].assigned).toBe(true);
  });

  it('updates local state on successful delegation', async () => {
    const id = t.makeItem({ id: 'WL-STATE-1', githubIssueNumber: 60, status: 'open', assignee: '' });

    await t.runDelegate('WL-STATE-1');
    const updated = t.db.get('WL-STATE-1');
    expect(updated.status).toBe('in-progress');
    expect(updated.assignee).toBe('@github-copilot');
    expect(updated.stage).toBe('in_progress');
  });

  it('outputs human-readable success messages', async () => {
    t.makeItem({ id: 'WL-HUMAN-1', githubIssueNumber: 70 });

    await t.runDelegate('WL-HUMAN-1');
    expect(t.consoleMessages.some(m => m.includes('Pushing to GitHub'))).toBe(true);
    expect(t.consoleMessages.some(m => m.includes('Assigning to @copilot'))).toBe(true);
    expect(t.consoleMessages.some(m => m.includes('Done. Issue:'))).toBe(true);
  });

  it('handles assignment failure: does not update local state', async () => {
    t.makeItem({ id: 'WL-FAIL-1', githubIssueNumber: 80, status: 'open', assignee: '' });

    // Make assign fail
    const { assignGithubIssueAsync } = await import('../../src/github.js');
    vi.mocked(assignGithubIssueAsync).mockResolvedValueOnce({ ok: false, error: '@copilot user not found' });

    await expect(t.runDelegate('WL-FAIL-1')).rejects.toThrow('process.exit(1)');
    const item = t.db.get('WL-FAIL-1');
    // Local state should NOT be updated
    expect(item.status).toBe('open');
    expect(item.assignee).toBe('');
  });

  it('adds comment on assignment failure', async () => {
    t.makeItem({ id: 'WL-FAIL-2', githubIssueNumber: 90, status: 'open', assignee: '' });

    const { assignGithubIssueAsync } = await import('../../src/github.js');
    vi.mocked(assignGithubIssueAsync).mockResolvedValueOnce({ ok: false, error: 'rate limited' });

    await expect(t.runDelegate('WL-FAIL-2')).rejects.toThrow('process.exit(1)');
    expect(t.createdComments).toHaveLength(1);
    expect(t.createdComments[0].comment).toContain('Failed to assign @copilot');
    expect(t.createdComments[0].comment).toContain('rate limited');
    expect(t.createdComments[0].author).toBe('wl-delegate');
  });

  it('includes "Local state was not updated." in human failure output', async () => {
    t.makeItem({ id: 'WL-FAIL-MSG', githubIssueNumber: 95, status: 'open', assignee: '' });

    const { assignGithubIssueAsync } = await import('../../src/github.js');
    vi.mocked(assignGithubIssueAsync).mockResolvedValueOnce({ ok: false, error: 'not found' });

    await expect(t.runDelegate('WL-FAIL-MSG')).rejects.toThrow('process.exit(1)');
    // Find the assignment failure error (there may be additional errors from re-push)
    const assignError = t.errorOutput.find(e => e.msg.includes('Failed to assign @copilot'));
    expect(assignError).toBeDefined();
    expect(assignError!.msg).toContain('Local state was not updated.');
    expect(assignError!.msg).toContain('Failed to assign @copilot');
  });

  it('delegates item without githubIssueNumber (first push creates issue)', async () => {
    // Item with no githubIssueNumber — the push should create the issue
    const id = t.makeItem({ id: 'WL-FIRST-PUSH', status: 'open', assignee: '' });
    // The mock upsertIssuesFromWorkItems returns the items as-is, so we need
    // to simulate that the push sets githubIssueNumber on the item
    const { upsertIssuesFromWorkItems } = await import('../../src/github-sync.js');
    vi.mocked(upsertIssuesFromWorkItems).mockImplementationOnce(async (items: any[]) => {
      // Simulate push assigning a GitHub issue number
      const updated = items.map((it: any) => ({ ...it, githubIssueNumber: 999 }));
      // Also update the item in the test DB so the refreshed lookup finds it
      for (const u of updated) {
        t.db.update(u.id, { githubIssueNumber: u.githubIssueNumber });
      }
      return {
        updatedItems: updated,
        result: { created: 1, updated: 0, closed: 0, skipped: 0, errors: [], syncedItems: [], errorItems: [], commentsCreated: 0, commentsUpdated: 0 },
        timing: { totalMs: 0, upsertMs: 0, commentListMs: 0, commentUpsertMs: 0, hierarchyCheckMs: 0, hierarchyLinkMs: 0, hierarchyVerifyMs: 0 },
      };
    });

    await t.runDelegate('WL-FIRST-PUSH');
    const updated = t.db.get('WL-FIRST-PUSH');
    expect(updated.status).toBe('in-progress');
    expect(updated.assignee).toBe('@github-copilot');
    expect(updated.githubIssueNumber).toBe(999);
    // Human output should indicate success
    expect(t.consoleMessages.some(m => m.includes('Done. Issue:'))).toBe(true);
  });

  it('outputs structured error JSON on assignment failure', async () => {
    t.makeItem({ id: 'WL-FAIL-3', githubIssueNumber: 100 });
    t.ctx.utils.isJsonMode = () => true;

    const { assignGithubIssueAsync } = await import('../../src/github.js');
    vi.mocked(assignGithubIssueAsync).mockResolvedValueOnce({ ok: false, error: 'forbidden' });

    await expect(t.runDelegate('WL-FAIL-3')).rejects.toThrow('process.exit(1)');
    // Find the error with the assignment failure data (ignore any earlier errors)
    const assignError = t.errorOutput.find(e => e.data?.assigned === false);
    expect(assignError).toBeDefined();
    expect(assignError!.data.success).toBe(false);
    expect(assignError!.data.pushed).toBe(true);
    expect(assignError!.data.assigned).toBe(false);
    expect(assignError!.data.error).toBe('forbidden');
  });
});
