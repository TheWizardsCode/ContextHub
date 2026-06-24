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
vi.mock('../wl-integration.js', () => ({
  runWl: mockRunWl,
}));

// ── Mock settings ─────────────────────────────────────────────────────

vi.mock('./settings.js', () => ({
  currentSettings: {
    autoInjectEnabled: true,
  },
}));

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

describe('searchRelatedWorkItems', () => {
  beforeEach(() => {
    mockRunWl.mockReset();
  });

  it('should fetch explicitly referenced IDs via wl show', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');
    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'show' && args[0] === 'WL-0MQL0T5TR0060AEH') {
        return {
          id: 'WL-0MQL0T5TR0060AEH',
          title: 'Test Work Item',
          status: 'open',
          priority: 'high',
          stage: 'in_progress',
        };
      }
      return { results: [] };
    });

    const results = await searchRelatedWorkItems(
      'Work on WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('WL-0MQL0T5TR0060AEH');
    expect(results[0].title).toBe('Test Work Item');
  });

  it('should search by prompt context when no IDs are found', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    // Mock the search call
    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'search') {
        return {
          results: [
            {
              id: 'WL-0MP15X5HW001WXZR',
              title: 'Found Item',
              status: 'open',
              priority: 'medium',
            },
          ],
        };
      }
      return {};
    });

    const results = await searchRelatedWorkItems('implementation task', []);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('WL-0MP15X5HW001WXZR');
    expect(results[0].title).toBe('Found Item');
  });

  it('should deduplicate results from ID lookup and search', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'show' && args[0] === 'WL-0MQL0T5TR0060AEH') {
        return {
          id: 'WL-0MQL0T5TR0060AEH',
          title: 'Explicit Item',
          status: 'open',
        };
      }
      if (command === 'search') {
        return {
          results: [
            {
              id: 'WL-0MQL0T5TR0060AEH',
              title: 'Explicit Item',
              status: 'open',
            },
            {
              id: 'WL-0MP15X5HW001WXZR',
              title: 'Search Result',
              status: 'open',
            },
          ],
        };
      }
      return {};
    });

    const results = await searchRelatedWorkItems(
      'WL-0MQL0T5TR0060AEH and more',
      ['WL-0MQL0T5TR0060AEH'],
    );
    expect(results).toHaveLength(2);
  });

  it('should handle failed ID lookups gracefully', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    // Show throws (modeled by mock rejecting)
    mockRunWl.mockImplementation((command: string) => {
      if (command === 'show') {
        throw new Error('Not found');
      }
      return { results: [] };
    });

    const results = await searchRelatedWorkItems('WL-0BADID0000000000', ['WL-0BADID0000000000']);
    expect(results).toEqual([]);
  });

  it('should skip search when prompt is too short', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockRunWl.mockImplementation(() => {
      throw new Error('Should not be called');
    });

    const results = await searchRelatedWorkItems('ab', []);
    expect(results).toEqual([]);
  });

  it('should skip search when prompt only contains IDs', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockRunWl.mockImplementation((command: string) => {
      if (command === 'show') {
        return {
          id: 'WL-0MQL0T5TR0060AEH',
          title: 'Explicit Item',
          status: 'open',
        };
      }
      throw new Error('Search should not be called');
    });

    const results = await searchRelatedWorkItems(
      'WL-0MQL0T5TR0060AEH',
      ['WL-0MQL0T5TR0060AEH'],
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('WL-0MQL0T5TR0060AEH');
  });

  it('should handle search errors gracefully', async () => {
    const { searchRelatedWorkItems } = await import('./auto-inject.js');

    mockRunWl.mockImplementation((command: string) => {
      if (command === 'search') {
        throw new Error('Search failed');
      }
      return {};
    });

    const results = await searchRelatedWorkItems('some search text', []);
    expect(results).toEqual([]);
  });
});

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

  it('should inject context when related items are found', async () => {
    const { registerAutoInject } = await import('./auto-inject.js');

    mockRunWl.mockImplementation((command: string, args: string[]) => {
      if (command === 'search') {
        return {
          results: [
            { id: 'WL-RELATED1', title: 'Related Task', status: 'open', priority: 'high' },
          ],
        };
      }
      return {};
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

  it('should not inject context when no items are found', async () => {
    const { registerAutoInject } = await import('./auto-inject.js');

    mockRunWl.mockImplementation(() => ({ results: [] }));

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
