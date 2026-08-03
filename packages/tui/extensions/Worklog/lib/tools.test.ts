/**
 * Unit tests for lib/tools.ts — work item tool functions (CLI integration,
 * JSON parsing, list creation).
 *
 * Run: npx vitest run packages/tui/extensions/lib/tools.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

describe('lib/tools exports', () => {
  it('should export the expected functions and types', async () => {
    const mod = await import('./tools.js');
    // Functions
    expect(typeof mod.runWl).toBe('function');
    expect(typeof mod.extractJsonObject).toBe('function');
    expect(typeof mod.normalizeListPayload).toBe('function');
    expect(typeof mod.createDefaultListWorkItems).toBe('function');
    expect(typeof mod.createListWorkItemsWithStage).toBe('function');
    expect(typeof mod.fetchTotalActionableCount).toBe('function');

    // Constants
    expect(mod.NOT_INITIALIZED_PATTERN).toBeDefined();
    expect(typeof mod.NOT_INITIALIZED_FRIENDLY).toBe('string');
  });

  describe('extractJsonObject', () => {
    it('should parse a complete JSON string', async () => {
      const { extractJsonObject } = await import('./tools.js');
      const result = extractJsonObject('{"key": "value"}');
      expect(result).toEqual({ key: 'value' });
    });

    it('should extract JSON from surrounding text', async () => {
      const { extractJsonObject } = await import('./tools.js');
      const result = extractJsonObject('Some text {"key": "value"} trailing');
      expect(result).toEqual({ key: 'value' });
    });

    it('should throw on no JSON object', async () => {
      const { extractJsonObject } = await import('./tools.js');
      expect(() => extractJsonObject('just text')).toThrow('No JSON object in output');
    });
  });

  describe('normalizeListPayload', () => {
    it('should normalize a direct array payload', async () => {
      const { normalizeListPayload } = await import('./tools.js');
      const items = [{ id: 'WL-1', title: 'Test', status: 'open' }];
      const result = normalizeListPayload(items);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('WL-1');
    });

    it('should normalize a wrapped payload (workItems key)', async () => {
      const { normalizeListPayload } = await import('./tools.js');
      const items = [{ id: 'WL-1', title: 'Test', status: 'open' }];
      const result = normalizeListPayload({ workItems: items });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('WL-1');
    });

    it('should normalize a results-based payload', async () => {
      const { normalizeListPayload } = await import('./tools.js');
      const items = [{ workItem: { id: 'WL-1', title: 'Test', status: 'open' } }];
      const result = normalizeListPayload({ results: items });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('WL-1');
    });

    it('should filter out items without an id', async () => {
      const { normalizeListPayload } = await import('./tools.js');
      const items = [
        { id: 'WL-1', title: 'Valid', status: 'open' },
        { noId: true },
      ];
      const result = normalizeListPayload(items);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('WL-1');
    });
  });

  describe('NOT_INITIALIZED_PATTERN', () => {
    it('should match the not-initialized error message', async () => {
      const { NOT_INITIALIZED_PATTERN } = await import('./tools.js');
      expect(NOT_INITIALIZED_PATTERN.test('worklog: not initialized in this checkout/worktree')).toBe(true);
      expect(NOT_INITIALIZED_PATTERN.test('Worklog system is not initialized.')).toBe(true);
      expect(NOT_INITIALIZED_PATTERN.test('normal output')).toBe(false);
    });
  });

  describe('runWl timeout (lock-storm prevention)', () => {
    const mockExecFile = vi.hoisted(() => {
      const store = (globalThis as any).__sharedChildProcessMocks;
      return store?.mockExecFile ?? vi.fn();
    });

    beforeEach(() => {
      mockExecFile.mockReset();
      const realExecFile = (globalThis as any).__sharedChildProcessMocks?.realExecFile;
      if (realExecFile) {
        mockExecFile.mockImplementation(realExecFile);
      }
    });

    it('passes a timeout option to execFile so hung syncs cannot persist', async () => {
      const { runWl } = await import('./tools.js');
      let capturedOptions: any = null;
      mockExecFile.mockImplementationOnce(
        (_binary: string, _args: string[], options: any, callback: (err: Error | null, result: { stdout: string }) => void) => {
          capturedOptions = options;
          callback(null, { stdout: '{"success":true}' });
        },
      );

      const out = await runWl(['sync']);
      expect(out).toBe('{"success":true}');
      expect(capturedOptions).not.toBeNull();
      expect(capturedOptions.timeout).toBeGreaterThan(0);
    });

    it('surfaces a clear timeout error when execFile reports a killed child', async () => {
      const { runWl } = await import('./tools.js');
      mockExecFile.mockImplementationOnce(
        (_binary: string, _args: string[], _options: any, callback: (err: Error | null) => void) => {
          const err = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: 'ETIMEDOUT' });
          callback(err);
        },
      );

      await expect(runWl(['sync'])).rejects.toThrow(/timed out after/);
    });
  });
});
