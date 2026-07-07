/**
 * Unit tests for lib/auto-inject.ts — Auto-injection of relevant work items
 * before agent turns.
 *
 * Tests the extraction, search, formatting, and registration logic used to
 * automatically inject related work-item context into the system prompt.
 *
 * Run: npx vitest run packages/tui/extensions/lib/auto-inject.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @earendil-works/pi-coding-agent ──────────────────────────────

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

// ── Mock the wl-integration runWl ─────────────────────────────────────

const mockRunWl = vi.fn();
vi.mock('../../wl-integration.js', () => ({
  runWl: mockRunWl,
}));

// ── Mock settings ─────────────────────────────────────────────────────

vi.mock('./settings.js', () => ({
  currentSettings: {
    autoInjectEnabled: true,
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Default mock fixture for a work item returned by `wl show`.
 * Includes description so ID-scanning code has text to scan.
 */
function defaultShowResult(id = 'WL-0MQL0T5TR0060AEH', title = 'Test Work Item', description = ''): object {
  return { id, title, status: 'open', priority: 'high', stage: 'in_progress', description };
}

/**
 * Default mock fixture for empty `wl comment list` output.
 */
function emptyCommentResult(): object {
  return { success: true, count: 0, workItemId: '', comments: [] };
}

/**
 * Default mock fixture for empty `wl list --parent` output.
 */
function emptyChildrenResult(): object {
  return { success: true, count: 0, workItems: [] };
}

/**
 * Set up mockRunWl to handle the common ID-based mode calls.
 * The mock intercepts:
 *   - 'show' → returns the primary work item
 *   - 'comment' with args ['list', ...] → returns comments
 *   - 'list' with args ['--parent', ...] → returns children
 *   - 'search' → returns search results (for fallback tests)
 *   - any other call → throws (test should fail if unexpected calls occur)
 *
 * @param showResult - What to return for `wl show <id>`
 * @param commentResult - What to return for `wl comment list <id>`
 * @param childrenResult - What to return for `wl list --parent <id>`
 * @param searchResult - What to return for `wl search ...`
 */
function mockWlCalls(
  showResult: any = defaultShowResult(),
  commentResult: any = emptyCommentResult(),
  childrenResult: any = emptyChildrenResult(),
  searchResult: any = undefined,
): void {
  mockRunWl.mockImplementation((command: string, args: string[]) => {
    if (command === 'show') {
      return Promise.resolve(showResult);
    }
    if (command === 'comment' && args[0] === 'list') {
      return Promise.resolve(commentResult);
    }
    if (command === 'list' && args[0] === '--parent') {
      return Promise.resolve(childrenResult);
    }
    if (command === 'search') {
      if (searchResult !== undefined) {
        return Promise.resolve(searchResult);
      }
    }
    // Default: reject with error to catch unexpected calls
    return Promise.reject(new Error(`Unexpected wl command: ${command} ${args?.join(' ')}`));
  });
}

// ── Extraction ────────────────────────────────────────────────────────

describe('extractWorkItemIds', () => {
  it('should extract a single work item ID from text', async () => {
    const { extractWorkItemIds } = await import('./auto-inject.js');
    const result = extractWorkItemIds('Implement WL-0MQL0T5TR0060AEH');
    expect(result).toEqual(['WL-0MQL0T5TR0060AEH']);
  });

  it('should extract multiple work item IDs from text', async () => {
    const { extractWorkItemIds } = await import('./auto-inject.js');
    const result = extractWorkItemIds(
      'Fix WL-0MQL0T5TR0060AEH and refactor WL-0MP15X5HW001WXZR'
    );
    expect(result).toEqual(['WL-0MQL0T5TR0060AEH', 'WL-0MP15X5HW001WXZR']);
  });

  it('should deduplicate repeated work item IDs', async () => {
    const { extractWorkItemIds } = await import('./auto-inject.js');
    const result = extractWorkItemIds(
      'WL-0MQL0T5TR0060AEH is related to WL-0MQL0T5TR0060AEH'
    );
    expect(result).toEqual(['WL-0MQL0T5TR0060AEH']);
  });

  it('should return an empty array when no IDs are found', async () => {
    const { extractWorkItemIds } = await import('./auto-inject.js');
    const result = extractWorkItemIds('No work item IDs in this text');
    expect(result).toEqual([]);
  });

  it('should handle empty string input', async () => {
    const { extractWorkItemIds } = await import('./auto-inject.js');
    const result = extractWorkItemIds('');
    expect(result).toEqual([]);
  });

  it('should ignore short alphanumeric codes that are not work item IDs', async () => {
    const { extractWorkItemIds } = await import('./auto-inject.js');
    const result = extractWorkItemIds('Use ABC-123 for reference');
    expect(result).toEqual([]);
  });

  it('should match IDs with different prefixes', async () => {
    const { extractWorkItemIds } = await import('./auto-inject.js');
    const result = extractWorkItemIds('SA-0MPYMFZXO0004ZU4 and TASK-0ABCDEF12345678');
    // TASK- has 4 letters, prefix must be 2-3 uppercase letters
    expect(result).toEqual(['SA-0MPYMFZXO0004ZU4']);
  });
});

// ── ID-based mode (new behavior) ──────────────────────────────────────

describe('searchRelatedWorkItems — ID-based mode', () => {
  beforeEach(() => {
    mockRunWl.mockReset();
  });

  it('should fetch explicitly referenced IDs via wl show', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockWlCalls(defaultShowResult('WL-0MQL0T5TR0060AEH', 'Test Work Item'));

    const results = await searchRelatedWorkItems(
      'Work on WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('WL-0MQL0T5TR0060AEH');
    expect(results[0].title).toBe('Test Work Item');
  });

  it('should scan description for embedded related work item IDs', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    // The primary work item description mentions a related item
    const desc = 'See WL-0MP15X5HW001WXZR for more details';
    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'show') {
        if (args[0] === 'WL-0MP15X5HW001WXZR') {
          return Promise.resolve(defaultShowResult('WL-0MP15X5HW001WXZR', 'Related Item'));
        }
        return Promise.resolve(defaultShowResult('WL-0MQL0T5TR0060AEH', 'Test Work Item', desc));
      }
      if (command === 'comment' && args[0] === 'list') {
        return Promise.resolve(emptyCommentResult());
      }
      if (command === 'list' && args[0] === '--parent') {
        return Promise.resolve(emptyChildrenResult());
      }
      return Promise.reject(new Error(`Unexpected: ${command} ${args?.join(' ')}`));
    });

    const results = await searchRelatedWorkItems(
      'Work on WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    // Should have: primary ID + related ID from description
    expect(results).toHaveLength(2);
    const ids = results.map(r => r.id).sort();
    // WL-0MP... (P=80) sorts before WL-0MQ... (Q=81)
    expect(ids).toEqual(['WL-0MP15X5HW001WXZR', 'WL-0MQL0T5TR0060AEH']);
  });

  it('should scan comments for embedded related work item IDs', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    // Comments contain a reference to another work item
    const commentPayload = {
      success: true,
      count: 1,
      workItemId: 'WL-0MQL0T5TR0060AEH',
      comments: [
        {
          id: 'WL-C1',
          workItemId: 'WL-0MQL0T5TR0060AEH',
          author: 'test',
          comment: 'See also WL-0MP15X5HW001WXZR for more context',
          createdAt: '2026-01-01T00:00:00.000Z',
          references: [],
        },
      ],
    };

    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'show') {
        // When fetching the related ID found in comments, return it with proper ID
        if (args[0] === 'WL-0MP15X5HW001WXZR') {
          return Promise.resolve(defaultShowResult('WL-0MP15X5HW001WXZR', 'Related Item'));
        }
        return Promise.resolve(defaultShowResult('WL-0MQL0T5TR0060AEH', 'Test Work Item'));
      }
      if (command === 'comment' && args[0] === 'list') {
        return Promise.resolve(commentPayload);
      }
      if (command === 'list' && args[0] === '--parent') {
        return Promise.resolve(emptyChildrenResult());
      }
      return Promise.reject(new Error(`Unexpected: ${command} ${args?.join(' ')}`));
    });

    const results = await searchRelatedWorkItems(
      'Work on WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    expect(results).toHaveLength(2);
    const ids = results.map(r => r.id).sort();
    // WL-0MP... (P=80) sorts before WL-0MQ... (Q=81)
    expect(ids).toEqual(['WL-0MP15X5HW001WXZR', 'WL-0MQL0T5TR0060AEH']);
  });

  it('should include child items as related items', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    // Children returned by wl list --parent
    const childrenPayload = {
      success: true,
      count: 2,
      workItems: [
        { id: 'WL-CHILD1', title: 'Child One', status: 'open', priority: 'medium', stage: 'in_progress' },
        { id: 'WL-CHILD2', title: 'Child Two', status: 'in-progress', priority: 'low', stage: 'plan_complete' },
      ],
    };

    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'show') {
        return Promise.resolve(defaultShowResult());
      }
      if (command === 'comment' && args[0] === 'list') {
        return Promise.resolve(emptyCommentResult());
      }
      if (command === 'list' && args[0] === '--parent') {
        return Promise.resolve(childrenPayload);
      }
      return Promise.reject(new Error(`Unexpected: ${command} ${args?.join(' ')}`));
    });

    const results = await searchRelatedWorkItems(
      'Work on WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    // Should have: primary + two children
    expect(results).toHaveLength(3);
    const ids = results.map(r => r.id).sort();
    expect(ids).toEqual(['WL-0MQL0T5TR0060AEH', 'WL-CHILD1', 'WL-CHILD2']);
    // Child items should have their titles preserved
    const child1 = results.find(r => r.id === 'WL-CHILD1');
    expect(child1?.title).toBe('Child One');
    const child2 = results.find(r => r.id === 'WL-CHILD2');
    expect(child2?.title).toBe('Child Two');
  });

  it('should deduplicate discovered IDs excluding the primary ID', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    // Description mentions only the primary ID (no related IDs), comments contain a related
    const desc = 'Main task WL-0MQL0T5TR0060AEH';  // only primary, no related
    const commentPayload = {
      success: true,
      count: 1,
      workItemId: 'WL-0MQL0T5TR0060AEH',
      comments: [
        {
          id: 'WL-C1',
          workItemId: 'WL-0MQL0T5TR0060AEH',
          author: 'test',
          comment: 'Related WL-0MP15X5HW001WXZR',
          createdAt: '2026-01-01T00:00:00.000Z',
          references: [],
        },
      ],
    };

    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'show') {
        if (args[0] === 'WL-0MP15X5HW001WXZR') {
          return Promise.resolve(defaultShowResult('WL-0MP15X5HW001WXZR', 'Related Item'));
        }
        return Promise.resolve(defaultShowResult('WL-0MQL0T5TR0060AEH', 'Test Work Item', desc));
      }
      if (command === 'comment' && args[0] === 'list') {
        return Promise.resolve(commentPayload);
      }
      if (command === 'list' && args[0] === '--parent') {
        return Promise.resolve(emptyChildrenResult());
      }
      return Promise.reject(new Error(`Unexpected: ${command} ${args?.join(' ')}`));
    });

    const results = await searchRelatedWorkItems(
      'WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    // Should have: primary + related (not duplicated, primary not re-discovered)
    expect(results).toHaveLength(2);
    const ids = results.map(r => r.id).sort();
    // WL-0MP... (P=80) sorts before WL-0MQ... (Q=81)
    expect(ids).toEqual(['WL-0MP15X5HW001WXZR', 'WL-0MQL0T5TR0060AEH']);
  });

  it('should skip wl search when work item IDs are present', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    // Search call should NOT be made — mock rejects if called
    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'show') {
        return Promise.resolve(defaultShowResult());
      }
      if (command === 'comment' && args[0] === 'list') {
        return Promise.resolve(emptyCommentResult());
      }
      if (command === 'list' && args[0] === '--parent') {
        return Promise.resolve(emptyChildrenResult());
      }
      if (command === 'search') {
        return Promise.reject(new Error('Search should not be called in ID-based mode'));
      }
      return Promise.reject(new Error(`Unexpected: ${command} ${args?.join(' ')}`));
    });

    const results = await searchRelatedWorkItems(
      'Work on WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('WL-0MQL0T5TR0060AEH');
  });

  it('should handle failed ID lookups gracefully', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    // Show throws (modeled by mock rejecting)
    mockRunWl.mockImplementation((command: string) => {
      if (command === 'show') {
        return Promise.reject(new Error('Not found'));
      }
      if (command === 'comment') {
        return Promise.resolve(emptyCommentResult());
      }
      if (command === 'list') {
        return Promise.resolve(emptyChildrenResult());
      }
      return Promise.reject(new Error(`Unexpected: ${command}`));
    });

    const results = await searchRelatedWorkItems('WL-0BADID0000000000', ['WL-0BADID0000000000']);
    expect(results).toEqual([]);
  });

  it('should handle comment and child scanning errors gracefully', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'show') {
        return Promise.resolve(defaultShowResult());
      }
      if (command === 'comment') {
        return Promise.reject(new Error('Comment listing failed'));
      }
      if (command === 'list') {
        return Promise.reject(new Error('Child listing failed'));
      }
      return Promise.reject(new Error(`Unexpected: ${command} ${args?.join(' ')}`));
    });

    // Even if comment/child scanning fails, the primary ID should still be returned
    const results = await searchRelatedWorkItems(
      'Work on WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('WL-0MQL0T5TR0060AEH');
  });

  it('should skip search when prompt only contains IDs', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockWlCalls(defaultShowResult());

    const results = await searchRelatedWorkItems(
      'WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('WL-0MQL0T5TR0060AEH');
  });
});

// ── Search-based mode (fallback) ──────────────────────────────────────

describe('searchRelatedWorkItems — Search-based mode (fallback)', () => {
  beforeEach(() => {
    mockRunWl.mockReset();
  });

  it('should search by prompt context when no IDs are found', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'search') {
        return Promise.resolve({
          results: [
            {
              id: 'WL-0MP15X5HW001WXZR',
              title: 'Found Item',
              status: 'open',
              priority: 'medium',
            },
          ],
        });
      }
      return Promise.reject(new Error(`Unexpected: ${command} ${args?.join(' ')}`));
    });

    const results = await searchRelatedWorkItems('implementation task', []);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('WL-0MP15X5HW001WXZR');
    expect(results[0].title).toBe('Found Item');
  });

  it('should handle search errors gracefully', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockRunWl.mockImplementation((command: string) => {
      if (command === 'search') {
        return Promise.reject(new Error('Search failed'));
      }
      return Promise.resolve({ results: [] });
    });

    const results = await searchRelatedWorkItems('some search text', []);
    expect(results).toEqual([]);
  });

  it('should skip search when prompt is too short', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockRunWl.mockImplementation(() => {
      return Promise.reject(new Error('Should not be called'));
    });

    const results = await searchRelatedWorkItems('ab', []);
    expect(results).toEqual([]);
  });
});

// ── Formatting ────────────────────────────────────────────────────────

describe('formatWorkItemContext', () => {
  it('should format items in full-detail mode when under threshold', async () => {
    const { formatWorkItemContext } = await import('./auto-inject.js');
    const items = [
      { id: 'WL-1', title: 'First Item', status: 'open', priority: 'high', stage: 'in_progress' },
      { id: 'WL-2', title: 'Second Item', status: 'in-progress', priority: 'medium' },
    ];
    const result = formatWorkItemContext(items);
    expect(result).toContain('## Relevant Work Items');
    expect(result).toContain('WL-1');
    expect(result).toContain('First Item');
    expect(result).toContain('WL-2');
    expect(result).toContain('Second Item');
    expect(result).toContain('`high`');
    expect(result).toContain('`open`');
  });

  it('should include status tags in full-detail mode', async () => {
    const { formatWorkItemContext } = await import('./auto-inject.js');
    const items = [
      { id: 'WL-1', title: 'Test', status: 'open', priority: 'high', stage: 'in_progress' },
    ];
    const result = formatWorkItemContext(items);
    expect(result).toContain('`high`');
    expect(result).toContain('`open`');
    expect(result).toContain('`in_progress`');
  });

  it('should handle items without priority or stage gracefully', async () => {
    const { formatWorkItemContext } = await import('./auto-inject.js');
    const items = [
      { id: 'WL-1', title: 'Minimal', status: 'open' },
    ];
    const result = formatWorkItemContext(items);
    expect(result).toContain('WL-1');
    expect(result).toContain('Minimal');
    expect(result).toContain('`open`');
  });

  it('should return empty string for empty items array', async () => {
    const { formatWorkItemContext } = await import('./auto-inject.js');
    const result = formatWorkItemContext([]);
    expect(result).toBe('');
  });
});

// ── Registration ──────────────────────────────────────────────────────

describe('registerAutoInject', () => {
  beforeEach(() => {
    mockRunWl.mockReset();
  });

  it('should register a before_agent_start handler', async () => {
    const { registerAutoInject } = await import('./auto-inject.js');
    const onMock = vi.fn();

    registerAutoInject({ on: onMock } as any);

    expect(onMock).toHaveBeenCalledWith('before_agent_start', expect.any(Function));
  });

  it('should skip injection when auto-inject is disabled', async () => {
    // Temporarily switch auto-inject to disabled
    const { currentSettings } = await import('./settings.js');
    const original = currentSettings.autoInjectEnabled;
    currentSettings.autoInjectEnabled = false;

    const { registerAutoInject } = await import('./auto-inject.js');
    const handler = vi.fn();
    const onMock = vi.fn((_event: string, fn: any) => { handler.mockImplementation(fn); });

    registerAutoInject({ on: onMock } as any);

    // Call the registered handler
    const event = { prompt: 'test', systemPrompt: 'system prompt' };
    const ctx = { ui: { setStatus: vi.fn() } };
    await handler(event, ctx);

    // Should not have called runWl (no search performed)
    expect(mockRunWl).not.toHaveBeenCalled();

    // Restore
    currentSettings.autoInjectEnabled = original;
  });

  it('should inject context when related items are found via search', async () => {
    const { registerAutoInject } = await import('./auto-inject.js');

    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'search') {
        return Promise.resolve({
          results: [
            { id: 'WL-RELATED1', title: 'Related Task', status: 'open', priority: 'high' },
          ],
        });
      }
      return Promise.resolve({});
    });

    const onMock = vi.fn();
    const setStatusMock = vi.fn();
    let registeredHandler: Function = async () => {};

    registerAutoInject({
      on: (_event: string, fn: any) => { registeredHandler = fn; },
    } as any);

    const event = {
      prompt: 'working on implementation task',
      systemPrompt: 'You are an AI assistant.',
    };
    const ctx = { ui: { setStatus: setStatusMock } };

    const result = await registeredHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain('## Relevant Work Items');
    expect(result!.systemPrompt).toContain('WL-RELATED1');
    expect(result!.systemPrompt).toContain('Related Task');
    expect(result!.systemPrompt).toContain(event.systemPrompt); // Original system prompt preserved
    expect(setStatusMock).toHaveBeenCalled();
  });

  it('should inject context when related items are found via ID scanning', async () => {
    const { registerAutoInject } = await import('./auto-inject.js');

    // Prompt has a work item ID, so ID-based mode is used
    // The description references a related item (must be 15+ chars to match regex)
    const desc = 'See WL-0MP15X5HW001WXZR for more details';
    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'show') {
        if (args[0] === 'WL-0MP15X5HW001WXZR') {
          return Promise.resolve({ id: 'WL-0MP15X5HW001WXZR', title: 'Related Task', status: 'open', priority: 'high' });
        }
        return Promise.resolve(defaultShowResult('WL-0MQL0T5TR0060AEH', 'Primary Task', desc));
      }
      if (command === 'comment' && args[0] === 'list') {
        return Promise.resolve(emptyCommentResult());
      }
      if (command === 'list' && args[0] === '--parent') {
        return Promise.resolve(emptyChildrenResult());
      }
      return Promise.resolve({ results: [] });
    });

    const onMock = vi.fn();
    const setStatusMock = vi.fn();
    let registeredHandler: Function = async () => {};

    registerAutoInject({
      on: (_event: string, fn: any) => { registeredHandler = fn; },
    } as any);

    const event = {
      prompt: 'working on WL-0MQL0T5TR0060AEH',
      systemPrompt: 'You are an AI assistant.',
    };
    const ctx = { ui: { setStatus: setStatusMock } };

    const result = await registeredHandler(event, ctx);

    expect(result).toBeDefined();
    expect(result!.systemPrompt).toContain('## Relevant Work Items');
    expect(result!.systemPrompt).toContain('WL-0MQL0T5TR0060AEH');
    expect(result!.systemPrompt).toContain('WL-0MP15X5HW001WXZR');
    expect(result!.systemPrompt).toContain('Primary Task');
    expect(result!.systemPrompt).toContain(event.systemPrompt);
    expect(setStatusMock).toHaveBeenCalled();
  });

  it('should not inject context when no items are found', async () => {
    const { registerAutoInject } = await import('./auto-inject.js');

    mockRunWl.mockImplementation(() => Promise.resolve({ results: [] }));

    const onMock = vi.fn();
    let registeredHandler: Function = async () => {};

    registerAutoInject({
      on: (_event: string, fn: any) => { registeredHandler = fn; },
    } as any);

    const event = {
      prompt: 'random text with no matches',
      systemPrompt: 'You are an AI assistant.',
    };
    const ctx = { ui: { setStatus: vi.fn() } };

    const result = await registeredHandler(event, ctx);

    expect(result).toBeUndefined();
  });
});
