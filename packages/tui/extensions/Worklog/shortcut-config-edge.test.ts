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

// ─── Chord validation in loadShortcutConfig ─────────────────────────────
//
// These tests verify that loadShortcutConfig properly validates chord
// entries. They use the same mocked fs pattern as the tests above.
//

describe('chord validation in loadShortcutConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('accepts entries with a valid chord array of 2+ strings', () => {
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          chord: ['u', 'p'],
          command: '!!wl update --priority',
          view: 'both',
        },
        {
          chord: ['u', 't'],
          command: '!!wl update --title',
          view: 'both',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    const entries = registry.getEntries();
    expect(entries).toHaveLength(2);

    const upEntry = entries.find((e: any) => e.chord?.[0] === 'u' && e.chord?.[1] === 'p');
    expect(upEntry).toBeDefined();
    expect(upEntry!.command).toBe('!!wl update --priority');

    const utEntry = entries.find((e: any) => e.chord?.[0] === 'u' && e.chord?.[1] === 't');
    expect(utEntry).toBeDefined();
    expect(utEntry!.command).toBe('!!wl update --title');
  });

  it('rejects entries with chord array of fewer than 2 keys', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          chord: ['u'],
          command: '!!wl update --priority',
          view: 'both',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('chord'),
    );
    expect(registry.getEntries()).toHaveLength(0);
    mockWarn.mockRestore();
  });

  it('rejects entries with empty chord array', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          chord: [],
          command: '!!wl update --priority',
          view: 'both',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('chord'),
    );
    expect(registry.getEntries()).toHaveLength(0);
    mockWarn.mockRestore();
  });

  it('rejects entries with chord that is not an array', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          chord: 'up',
          command: '!!wl update --priority',
          view: 'both',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('chord'),
    );
    expect(registry.getEntries()).toHaveLength(0);
    mockWarn.mockRestore();
  });

  it('rejects entries that define both key and chord (mutual exclusivity)', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          key: 'u',
          chord: ['u', 'p'],
          command: '!!wl update --priority',
          view: 'both',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('key'),
    );
    expect(registry.getEntries()).toHaveLength(0);
    mockWarn.mockRestore();
  });

  it('rejects entries with neither key nor chord field', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          command: '!!wl update --priority',
          view: 'both',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('missing'),
    );
    expect(registry.getEntries()).toHaveLength(0);
    mockWarn.mockRestore();
  });

  it('accepts chord entries with optional label and description', () => {
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          chord: ['u', 'p'],
          command: '!!wl update --priority',
          view: 'both',
          label: 'update priority',
          description: 'Update the priority of the selected work item',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    const entry = registry.getEntries()[0];
    expect(entry).toBeDefined();
    expect((entry as any).label).toBe('update priority');
    expect((entry as any).description).toBe(
      'Update the priority of the selected work item',
    );
  });

  it('accepts chord entries with stages array', () => {
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          chord: ['u', 'p'],
          command: '!!wl update --priority',
          view: 'both',
          stages: ['intake_complete', 'plan_complete'],
        },
      ]),
    };

    const registry = loadShortcutConfig();
    const entry = registry.getEntries()[0];
    expect(entry).toBeDefined();
    expect(entry.stages).toEqual(['intake_complete', 'plan_complete']);
  });

  it('maintains backward compatibility with single-key entries when chord validation is present', () => {
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'p', command: 'plan <id>', view: 'both' },
        {
          chord: ['u', 'p'],
          command: 'update-priority <id>',
          view: 'both',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    expect(registry.getEntries()).toHaveLength(3);
    expect(registry.lookup('i', 'list')).toBe('implement <id>');
    expect(registry.lookup('p', 'list')).toBe('plan <id>');
  });

  it('loads valid chord entries alongside valid key entries, skipping invalid ones', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        {
          chord: ['u', 'p'],
          command: 'update-priority <id>',
          view: 'both',
        },
        {
          chord: ['u'],
          command: 'invalid-chord <id>',
          view: 'both',
        },
        {
          key: 'x',
          chord: ['x', 'y'],
          command: 'both-fields <id>',
          view: 'both',
        },
        { key: 'p', command: 'plan <id>', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();
    // The two invalid entries should be skipped, leaving 3 valid entries
    expect(registry.getEntries()).toHaveLength(3);
    expect(registry.lookup('i', 'list')).toBe('implement <id>');
    expect(registry.lookup('p', 'list')).toBe('plan <id>');

    // The chord entry ('u','p') should have been loaded
    const chordEntry = registry
      .getEntries()
      .find((e: any) => Array.isArray(e.chord));
    expect(chordEntry).toBeDefined();
    expect((chordEntry as any).chord).toEqual(['u', 'p']);

    expect(mockWarn).toHaveBeenCalledTimes(2);
    mockWarn.mockRestore();
  });

  it('chord entries accept view values list, detail, and both', () => {
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          chord: ['u', 'p'],
          command: 'update-priority <id>',
          view: 'list',
        },
        {
          chord: ['u', 't'],
          command: 'update-title <id>',
          view: 'detail',
        },
        {
          chord: ['u', 's'],
          command: 'update-status <id>',
          view: 'both',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    expect(registry.getEntries()).toHaveLength(3);
  });

  it('rejects chord entry with invalid view value', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        {
          chord: ['u', 'p'],
          command: 'update-priority <id>',
          view: 'modal',
        },
      ]),
    };

    const registry = loadShortcutConfig();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('unknown "view"'),
    );
    expect(registry.getEntries()).toHaveLength(0);
    mockWarn.mockRestore();
  });
});

describe('duplicate key+view detection in loadShortcutConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('warns when two key-based entries share the same key and view', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'i', command: 'implement-again <id>', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate shortcut'),
    );
    // Both entries are still loaded (first wins at lookup time)
    expect(registry.getEntries()).toHaveLength(2);
    // First entry still wins (backward compatible)
    expect(registry.lookup('i', 'list')).toBe('implement <id>');
    mockWarn.mockRestore();
  });

  it('warns when two chord-based entries share the same chord and view', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { chord: ['u', 'p'], command: 'update-priority', view: 'both' },
        { chord: ['u', 'p'], command: 'update-priority-alt', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate shortcut'),
    );
    expect(registry.getEntries()).toHaveLength(2);
    // First entry still wins
    expect((registry as any).lookupChord(['u', 'p'], 'list')).toBe('update-priority');
    mockWarn.mockRestore();
  });

  it('does NOT warn for entries with same key but different views', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'list' },
        { key: 'i', command: 'implement-detail <id>', view: 'detail' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Duplicate shortcut'),
    );
    expect(registry.getEntries()).toHaveLength(2);
    expect(registry.lookup('i', 'list')).toBe('implement <id>');
    expect(registry.lookup('i', 'detail')).toBe('implement-detail <id>');
    mockWarn.mockRestore();
  });

  it('does NOT warn for entries with different keys and same view', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'p', command: 'plan <id>', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Duplicate shortcut'),
    );
    expect(registry.getEntries()).toHaveLength(2);
    mockWarn.mockRestore();
  });

  it('warns separately for each duplicate pair', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'i', command: 'implement-alt <id>', view: 'both' },
        { key: 'p', command: 'plan <id>', view: 'both' },
        { key: 'p', command: 'plan-alt <id>', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();

    // Should have warned twice (one for 'i', one for 'p')
    const duplicateWarnings = mockWarn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('Duplicate shortcut'),
    );
    expect(duplicateWarnings.length).toBe(2);
    expect(registry.getEntries()).toHaveLength(4);
    // First entries still win
    expect(registry.lookup('i', 'list')).toBe('implement <id>');
    expect(registry.lookup('p', 'list')).toBe('plan <id>');
    mockWarn.mockRestore();
  });

  it('detects mixed duplicates across key and chord entries separately', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'i', command: 'implement-alt <id>', view: 'both' },
        { chord: ['u', 'p'], command: 'update-priority', view: 'list' },
        { chord: ['u', 'p'], command: 'update-priority-alt', view: 'list' },
      ]),
    };

    const registry = loadShortcutConfig();

    const duplicateWarnings = mockWarn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('Duplicate shortcut'),
    );
    expect(duplicateWarnings.length).toBe(2);
    expect(registry.getEntries()).toHaveLength(4);
    // First entries still win
    expect(registry.lookup('i', 'list')).toBe('implement <id>');
    expect((registry as any).lookupChord(['u', 'p'], 'list')).toBe('update-priority');
    mockWarn.mockRestore();
  });

  it('does NOT warn for unique chord+view combinations', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { chord: ['u', 'p'], command: 'update-priority', view: 'list' },
        { chord: ['u', 't'], command: 'update-title', view: 'list' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Duplicate shortcut'),
    );
    expect(registry.getEntries()).toHaveLength(2);
    mockWarn.mockRestore();
  });

  it('does not emit duplicate warning for the first occurrence of a unique combination', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'p', command: 'plan <id>', view: 'both' },
        { key: 'a', command: 'audit <id>', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Duplicate shortcut'),
    );
    expect(registry.getEntries()).toHaveLength(3);
    mockWarn.mockRestore();
  });

  it('warning message includes the shortcut key and view in the text', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'i', command: 'implement-alt <id>', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringMatching(/Duplicate shortcut.*i:both/i),
    );
    mockWarn.mockRestore();
  });

  it('warning includes the index of the duplicate entry', () => {
    const mockWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileSyncBehavior = {
      type: 'invalid',
      content: JSON.stringify([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'i', command: 'implement-alt <id>', view: 'both' },
      ]),
    };

    const registry = loadShortcutConfig();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringMatching(/index\s+1/i),
    );
    mockWarn.mockRestore();
  });
});
