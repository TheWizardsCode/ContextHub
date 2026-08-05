/**
 * Unit tests for the shortcut config code_freeze field (WL-0MSD81VEL009XHWA).
 *
 * Covers:
 *  - parsing `code_freeze: "block" | "allow" | omitted` from shortcuts.json
 *    (invalid values logged and treated as omit)
 *  - registry filtering: lookupChord, lookupChordEntry, getEntriesForStage,
 *    getChordByPrefix, getChordByLeader, getChordEntries exclude entries with
 *    `code_freeze: "block"` when `codeFreezeActive` is true, while `allow` and
 *    omitted entries always remain visible
 *  - the production shortcuts.json marks the implement (`i`) shortcut blocked
 *
 * Run: npx vitest run packages/herdr/src/shortcut-config.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShortcutRegistry, parseShortcutEntry, loadShortcutConfig } from './shortcut-config.js';
import type { ShortcutEntry } from './shortcut-config.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const blockedEntry: ShortcutEntry = {
  chord: ['i'],
  command: '/skill:implement <id>',
  view: 'both',
  label: 'implement',
  codeFreeze: 'block',
};

const allowedEntry: ShortcutEntry = {
  chord: ['a'],
  command: '/skill:audit <id>',
  view: 'both',
  label: 'audit',
  codeFreeze: 'allow',
};

const omittedEntry: ShortcutEntry = {
  chord: ['s'],
  command: '!!wl search <search_term>',
  view: 'both',
  label: 'search',
};

// ── parseShortcutEntry ───────────────────────────────────────────────────

describe('parseShortcutEntry — code_freeze field', () => {
  it('parses code_freeze: "block"', () => {
    const entry = parseShortcutEntry({
      chord: ['i'],
      command: '/skill:implement <id>',
      view: 'both',
      code_freeze: 'block',
    });
    expect(entry?.codeFreeze).toBe('block');
  });

  it('parses code_freeze: "allow"', () => {
    const entry = parseShortcutEntry({
      chord: ['a'],
      command: '/skill:audit <id>',
      view: 'both',
      code_freeze: 'allow',
    });
    expect(entry?.codeFreeze).toBe('allow');
  });

  it('treats a missing code_freeze as omit (backward compatible)', () => {
    const entry = parseShortcutEntry({
      chord: ['s'],
      command: '!!wl search <search_term>',
      view: 'both',
    });
    expect(entry?.codeFreeze).toBeUndefined();
  });

  it('logs and treats an invalid code_freeze as omit', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const entry = parseShortcutEntry({
      chord: ['x'],
      command: '!!wl close <id>',
      view: 'both',
      code_freeze: 'sometimes',
    });
    expect(entry?.codeFreeze).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('keeps other fields intact when code_freeze is present', () => {
    const entry = parseShortcutEntry({
      chord: ['i'],
      command: '/skill:implement <id>',
      view: 'both',
      model: 'code',
      code_freeze: 'block',
    });
    expect(entry).toMatchObject({
      chord: ['i'],
      command: '/skill:implement <id>',
      view: 'both',
      model: 'code',
      codeFreeze: 'block',
    });
  });
});

// ── loadShortcutConfig ───────────────────────────────────────────────────

describe('loadShortcutConfig — production shortcuts.json', () => {
  it('marks the implement (i) shortcut with code_freeze "block"', () => {
    const registry = loadShortcutConfig();
    const entry = registry.lookupChordEntry(['i'], 'list', undefined, false);
    expect(entry?.codeFreeze).toBe('block');
    expect(entry?.command).toBe('/skill:implement <id>');
  });
});

// ── Registry filtering ───────────────────────────────────────────────────

describe('ShortcutRegistry — codeFreezeActive filtering', () => {
  let registry: ShortcutRegistry;

  beforeEach(() => {
    registry = new ShortcutRegistry([blockedEntry, allowedEntry, omittedEntry]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('lookupChordEntry', () => {
    it('excludes "block" entries when freeze is active', () => {
      expect(registry.lookupChordEntry(['i'], 'list', undefined, true)).toBeUndefined();
    });

    it('includes "block" entries when freeze is inactive', () => {
      expect(registry.lookupChordEntry(['i'], 'list', undefined, false)?.codeFreeze).toBe('block');
    });

    it('includes "block" entries when codeFreezeActive is omitted (default)', () => {
      expect(registry.lookupChordEntry(['i'], 'list')?.codeFreeze).toBe('block');
    });

    it('keeps "allow" entries visible during a freeze', () => {
      expect(registry.lookupChordEntry(['a'], 'list', undefined, true)?.codeFreeze).toBe('allow');
    });

    it('keeps omitted entries visible during a freeze', () => {
      expect(registry.lookupChordEntry(['s'], 'list', undefined, true)?.label).toBe('search');
    });
  });

  describe('lookupChord', () => {
    it('returns undefined for a blocked chord during a freeze', () => {
      expect(registry.lookupChord(['i'], 'list', undefined, true)).toBeUndefined();
    });

    it('returns the command for a blocked chord when not frozen', () => {
      expect(registry.lookupChord(['i'], 'list', undefined, false)).toBe('/skill:implement <id>');
    });

    it('returns commands for allowed and omitted chords during a freeze', () => {
      expect(registry.lookupChord(['a'], 'list', undefined, true)).toBe('/skill:audit <id>');
      expect(registry.lookupChord(['s'], 'list', undefined, true)).toBe('!!wl search <search_term>');
    });
  });

  describe('getEntriesForStage', () => {
    it('omits "block" entries when freeze is active', () => {
      const entries = registry.getEntriesForStage(undefined, true);
      expect(entries.map(e => e.label)).toEqual(['audit', 'search']);
    });

    it('includes "block" entries when freeze is inactive', () => {
      const entries = registry.getEntriesForStage(undefined, false);
      expect(entries.map(e => e.label)).toContain('implement');
    });

    it('includes all entries when codeFreezeActive is omitted', () => {
      const entries = registry.getEntriesForStage();
      expect(entries).toHaveLength(3);
    });
  });

  describe('getChordByPrefix', () => {
    it('omits "block" chords matching the prefix when freeze is active', () => {
      const entries = registry.getChordByPrefix(['i'], 'list', undefined, true);
      expect(entries).toHaveLength(0);
    });

    it('includes "block" chords when freeze is inactive', () => {
      const entries = registry.getChordByPrefix(['i'], 'list', undefined, false);
      expect(entries).toHaveLength(1);
    });

    it('keeps allowed and omitted chords during a freeze', () => {
      const entries = registry.getChordByPrefix(['a'], 'list', undefined, true);
      expect(entries).toHaveLength(1);
      const search = registry.getChordByPrefix(['s'], 'list', undefined, true);
      expect(search).toHaveLength(1);
    });
  });

  describe('getChordByLeader', () => {
    it('omits "block" leaders when freeze is active', () => {
      expect(registry.getChordByLeader('i', 'list', true)).toHaveLength(0);
    });

    it('includes "block" leaders when freeze is inactive', () => {
      expect(registry.getChordByLeader('i', 'list', false)).toHaveLength(1);
    });
  });

  describe('getChordEntries', () => {
    it('omits "block" entries when freeze is active', () => {
      const entries = registry.getChordEntries(true);
      expect(entries.map(e => e.label)).toEqual(['audit', 'search']);
    });

    it('includes all entries when freeze is inactive or omitted', () => {
      expect(registry.getChordEntries(false)).toHaveLength(3);
      expect(registry.getChordEntries()).toHaveLength(3);
    });
  });
});
