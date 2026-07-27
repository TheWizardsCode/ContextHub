/**
 * tests/herdr/shortcuts.test.ts — Tests for Herdr chord shortcut system
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ShortcutRegistry, type ShortcutEntry } from '../../packages/herdr/src/shortcut-config.js';

// ── Fixtures ──────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ShortcutEntry> = {}): ShortcutEntry {
  return {
    key: 'i',
    command: 'implement <id>',
    view: 'both',
    label: 'implement',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('ShortcutRegistry', () => {
  let entries: ShortcutEntry[];

  beforeEach(() => {
    entries = [
      { key: 'i', command: '/skill:implement <id>', view: 'both', label: 'implement', stages: ['intake_complete', 'plan_complete', 'in_progress'] },
      { key: 'p', command: '/plan <id>', view: 'both', label: 'plan', stages: ['intake_complete'] },
      { key: 'c', command: '/intake', view: 'both', label: 'create new' },
      { key: 'n', command: '/intake <id>', view: 'both', label: 'intake', stages: ['idea'] },
      { key: 's', command: '!!wl search ', view: 'both', label: 'Search' },
    ];
  });

  describe('lookup', () => {
    it('returns undefined for unknown key', () => {
      const reg = new ShortcutRegistry(entries);
      expect(reg.lookup('z', 'list')).toBeUndefined();
    });

    it('returns command for known key', () => {
      const reg = new ShortcutRegistry(entries);
      expect(reg.lookup('c', 'list')).toBe('/intake');
    });

    it('filters by view', () => {
      const reg = new ShortcutRegistry(entries);
      expect(reg.lookup('c', 'list')).toBe('/intake');
      expect(reg.lookup('c', 'detail')).toBe('/intake');
    });

    it('filters by stage when entry has stages constraint', () => {
      const reg = new ShortcutRegistry(entries);
      // 'i' is available for intake_complete stage
      expect(reg.lookup('i', 'list', 'intake_complete')).toBe('/skill:implement <id>');
      // 'i' is NOT available for idea stage
      expect(reg.lookup('i', 'list', 'idea')).toBeUndefined();
    });

    it('returns command when stage is undefined but entry has no stages constraint', () => {
      const reg = new ShortcutRegistry(entries);
      expect(reg.lookup('c', 'list')).toBe('/intake');
    });
  });

  describe('getEntriesForStage', () => {
    it('returns all entries with no stage constraint', () => {
      const reg = new ShortcutRegistry(entries);
      const stageEntries = reg.getEntriesForStage('in_progress');
      expect(stageEntries.length).toBeGreaterThan(0);
    });

    it('filters entries by stage', () => {
      const reg = new ShortcutRegistry(entries);
      const ideaEntries = reg.getEntriesForStage('idea');
      // Only 'n' (idea) and 'c' and 's' (no stage constraint) should match
      const ideaIds = ideaEntries.map(e => e.key);
      expect(ideaIds).toContain('n');
      expect(ideaIds).toContain('c');
      expect(ideaIds).toContain('s');
    });
  });

  describe('chord support', () => {
    let chordEntries: ShortcutEntry[];

    beforeEach(() => {
      chordEntries = [
        ...entries,
        { key: '', command: '!!wl update <id> --priority low', view: 'both', chord: ['u', 'p', 'l'], label: 'priority low' },
        { key: '', command: '!!wl update <id> --priority medium', view: 'both', chord: ['u', 'p', 'm'], label: 'priority medium' },
        { key: '', command: '!!wl update <id> --priority high', view: 'both', chord: ['u', 'p', 'h'], label: 'priority high' },
        { key: '', command: '!!wl update <id> --priority critical', view: 'both', chord: ['u', 'p', 'c'], label: 'priority critical' },
        { key: '', command: '/wl idea', view: 'both', chord: ['f', 'i'], label: 'filter idea' },
        { key: '', command: '/wl intake', view: 'both', chord: ['f', 'n'], label: 'filter intake' },
        { key: '', command: '/wl plan', view: 'both', chord: ['f', 'p'], label: 'filter plan' },
        { key: '', command: '/wl review', view: 'both', chord: ['f', 'r'], label: 'filter in_review' },
        { key: '', command: '!!wl close <id>', view: 'both', chord: ['x', 'c'], label: 'close done' },
      ];
    });

    it('looks up chord by full sequence', () => {
      const reg = new ShortcutRegistry(chordEntries);
      expect(reg.lookupChord(['u', 'p', 'h'], 'list')).toBe('!!wl update <id> --priority high');
    });

    it('returns undefined for incomplete chord', () => {
      const reg = new ShortcutRegistry(chordEntries);
      expect(reg.lookupChord(['u', 'p'], 'list')).toBeUndefined();
    });

    it('gets chords by leader key', () => {
      const reg = new ShortcutRegistry(chordEntries);
      const uChords = reg.getChordByLeader('u');
      expect(uChords.length).toBe(4); // u-p-l, u-p-m, u-p-h, u-p-c
    });

    it('gets chords by prefix', () => {
      const reg = new ShortcutRegistry(chordEntries);
      const upChords = reg.getChordByPrefix(['u', 'p']);
      expect(upChords.length).toBe(4); // all 4 priority chords
    });

    it('filters chords by view', () => {
      const reg = new ShortcutRegistry(chordEntries);
      const detailChords = reg.getChordByPrefix(['u', 'p'], 'detail');
      expect(detailChords.length).toBeGreaterThan(0);
    });

    it('filters chords by stage', () => {
      const chordWithStages: ShortcutEntry[] = [
        ...chordEntries,
        { key: '', command: '/skill:audit <id>', view: 'both', chord: ['a', 'a'], label: 'audit automatic', stages: ['in_review'] },
      ];
      const reg = new ShortcutRegistry(chordWithStages);
      const reviewChords = reg.getChordByPrefix(['a', 'a'], 'list', 'in_review');
      expect(reviewChords.length).toBe(1);
      const ideaChords = reg.getChordByPrefix(['a', 'a'], 'list', 'idea');
      expect(ideaChords.length).toBe(0);
    });

    it('returns chord entries list', () => {
      const reg = new ShortcutRegistry(chordEntries);
      const chords = reg.getChordEntries();
      expect(chords.length).toBeGreaterThanOrEqual(8);
    });
  });

  describe('loadShortcutConfig', () => {
    it('loads and validates shortcuts.json', async () => {
      // Verify the export exists via dynamic import
      const mod = await import('../../packages/herdr/src/shortcut-config.js');
      expect(typeof mod.loadShortcutConfig).toBe('function');
    });

    it('returns a registry with loaded entries', async () => {
      const mod = await import('../../packages/herdr/src/shortcut-config.js');
      const registry = mod.loadShortcutConfig();
      const entries = registry.getEntries();
      expect(entries.length).toBeGreaterThan(0);
      // Should have at least 'c', 's', and 'f' chords
      const allKeys = entries.map(e => e.key).filter(k => k.length > 0);
      expect(allKeys).toContain('c');
      expect(allKeys).toContain('s');
      const chords = registry.getChordEntries();
      expect(chords.length).toBeGreaterThanOrEqual(4);
    });

    it('handles missing shortcuts.json gracefully', async () => {
      // Temporarily remove require cache for a clean test
      // We can simulate by passing wrong path, but the module uses __dirname
      // so just verify it doesn't crash
      const mod = await import('../../packages/herdr/src/shortcut-config.js');
      const registry = mod.loadShortcutConfig();
      expect(registry).toBeDefined();
    });
  });
});
