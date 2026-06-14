/**
 * Edge-case tests for shortcut-config.ts - missing file and malformed JSON.
 *
 * These tests mock fs.readFileSync at the module level so each test can
 * provide different file content without the real shortcuts.json being loaded.
 *
 * Run: npx vitest run packages/tui/extensions/shortcut-config-edge.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the fs module at the top level so loadShortcutConfig uses our mock
let readFileSyncBehavior: { type: 'empty' | 'valid' | 'malformed' | 'invalid'; content?: string } = {
  type: 'empty',
};

vi.mock('node:fs', () => ({
  readFileSync: vi.fn((path: string, encoding: string) => {
    if (readFileSyncBehavior.type === 'empty') {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
    }
    if (readFileSyncBehavior.type === 'valid') {
      return readFileSyncBehavior.content || '[]';
    }
    if (readFileSyncBehavior.type === 'malformed') {
      return readFileSyncBehavior.content || '{ not valid json';
    }
    if (readFileSyncBehavior.type === 'invalid') {
      return readFileSyncBehavior.content || '[]';
    }
    return '[]';
  }),
}));

import {
  ShortcutRegistry,
  loadShortcutConfig,
  type ShortcutEntry,
} from './shortcut-config.js';

describe('loadShortcutConfig edge cases (fs.mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('returns empty registry when shortcuts.json is missing (ENOENT)', () => {
    readFileSyncBehavior = { type: 'empty' };
    const registry = loadShortcutConfig();
    expect(registry.getEntries()).toHaveLength(0);
  });

  it('returns empty registry with console.error for malformed JSON', () => {
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});
    readFileSyncBehavior = { type: 'malformed', content: '{ not valid json' };

    const registry = loadShortcutConfig();

    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('Malformed shortcuts.json'),
    );
    expect(registry.getEntries()).toHaveLength(0);
    mockError.mockRestore();
  });

  it('skips entries with missing key field with console.warn', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { command: 'implement <id>', view: 'both' },
        { key: 'p', command: 'plan <id>', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Skipping entry at index 0'),
    );
    expect(registry.getEntries()).toHaveLength(1);
    expect(registry.lookup('p', 'list')).toBe('plan <id>');
    mockWarn.mockRestore();
  });

  it('skips entries with unknown view value with console.warn', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'x', command: 'unknown <id>', view: 'modal' },
        { key: 'p', command: 'plan <id>', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('unknown "view" value "modal"'),
    );
    expect(registry.getEntries()).toHaveLength(2);
    expect(registry.lookup('i', 'list')).toBe('implement <id>');
    expect(registry.lookup('x', 'list')).toBeUndefined();
    expect(registry.lookup('p', 'list')).toBe('plan <id>');
    mockWarn.mockRestore();
  });

  it('returns empty registry when JSON array is empty', () => {
    readFileSyncBehavior = { type: 'valid', content: '[]' };
    const registry = loadShortcutConfig();
    expect(registry.getEntries()).toHaveLength(0);
  });

  describe('stages field validation', () => {
    it('accepts entries with valid stages array', () => {
      readFileSyncBehavior = {
        type: 'invalid',
        content: JSON.stringify([
          { key: 'n', command: 'intake <id>', view: 'both', stages: ['idea'] },
        ]),
      };

      const registry = loadShortcutConfig();
      expect(registry.getEntries()).toHaveLength(1);
      expect(registry.getEntries()[0].stages).toEqual(['idea']);
    });

    it('accepts entries with multiple stages', () => {
      readFileSyncBehavior = {
        type: 'invalid',
        content: JSON.stringify([
          { key: 'x', command: 'custom <id>', view: 'both', stages: ['idea', 'in_progress'] },
        ]),
      };

      const registry = loadShortcutConfig();
      expect(registry.getEntries()).toHaveLength(1);
      expect(registry.getEntries()[0].stages).toEqual(['idea', 'in_progress']);
    });

    it('skips entry when stages is not an array', () => {
      const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      readFileSyncBehavior = {
        type: 'invalid',
        content: JSON.stringify([
          { key: 'n', command: 'intake <id>', view: 'both', stages: 'idea' },
        ]),
      };

      const registry = loadShortcutConfig();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('"stages" must be an array of strings'),
      );
      expect(registry.getEntries()).toHaveLength(0);
      mockWarn.mockRestore();
    });

    it('accepts entry with empty stages array (treated as unconditional)', () => {
      readFileSyncBehavior = {
        type: 'invalid',
        content: JSON.stringify([
          { key: 'x', command: 'test <id>', view: 'both', stages: [] },
        ]),
      };

      const registry = loadShortcutConfig();
      expect(registry.getEntries()).toHaveLength(1);
      expect(registry.getEntries()[0].stages).toBeUndefined();
    });

    it('still loads valid entries alongside entries with invalid stages', () => {
      const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      readFileSyncBehavior = {
        type: 'invalid',
        content: JSON.stringify([
          { key: 'i', command: 'implement <id>', view: 'both', stages: ['intake_complete'] },
          { key: 'x', command: 'bad <id>', view: 'both', stages: 'not-an-array' },
          { key: 'p', command: 'plan <id>', view: 'both' },
        ]),
      };

      const registry = loadShortcutConfig();
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining('"stages" must be an array of strings'),
      );
      expect(registry.getEntries()).toHaveLength(2);
      expect(registry.lookup('i', 'list')).toBe('implement <id>');
      expect(registry.lookup('p', 'list')).toBe('plan <id>');
      expect(registry.lookup('x', 'list')).toBeUndefined();
      mockWarn.mockRestore();
    });
  });
});
