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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('parseShortcutEntry — work_item_types field', () => {
  it('parses work_item_types as a string array', () => {
    const entry = parseShortcutEntry({
      chord: ['w'],
      command: '/skill:wiki-podcast-script <id>',
      view: 'both',
      work_item_types: ['podcast'],
    });
    expect(entry?.workItemTypes).toEqual(['podcast']);
  });

  it('treats a missing work_item_types as omit (backward compatible)', () => {
    const entry = parseShortcutEntry({
      chord: ['s'],
      command: '!!wl search <search_term>',
      view: 'both',
    });
    expect(entry?.workItemTypes).toBeUndefined();
  });

  it('logs and treats invalid work_item_types as omit', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: unknown[] = [
      'podcast',          // not an array
      [],                 // empty array
      ['podcast', 42],    // non-string element
      [''],               // empty string element
    ];
    for (const bad of cases) {
      const entry = parseShortcutEntry({
        chord: ['x'],
        command: '!!wl close <id>',
        view: 'both',
        work_item_types: bad,
      });
      expect(entry?.workItemTypes).toBeUndefined();
    }
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('keeps other fields intact when work_item_types is present', () => {
    const entry = parseShortcutEntry({
      chord: ['w'],
      command: '/skill:wiki-podcast-script <id>',
      view: 'both',
      label: 'write script',
      stages: ['intake_complete'],
      work_item_types: ['podcast'],
    });
    expect(entry).toMatchObject({
      chord: ['w'],
      command: '/skill:wiki-podcast-script <id>',
      view: 'both',
      label: 'write script',
      stages: ['intake_complete'],
      workItemTypes: ['podcast'],
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

  it('restricts the bundled code-workflow chords n/p/i to code and docs issue types', () => {
    const registry = loadShortcutConfig();
    const codeTypes = ['bug', 'docs', 'feature', 'task', 'chore', 'epic'];
    for (const chord of ['n', 'p', 'i']) {
      const entry = registry.lookupChordEntry([chord], 'list');
      expect(entry?.workItemTypes).toEqual(codeTypes);
    }
    // Generic chords stay untyped.
    expect(registry.lookupChordEntry(['r'], 'list')?.workItemTypes).toBeUndefined();
    expect(registry.lookupChordEntry(['c'], 'list')?.workItemTypes).toBeUndefined();
    expect(registry.lookupChordEntry(['a', 'a'], 'list')?.workItemTypes).toBeUndefined();
  });

  it('registers the f s sprint chord to return to the default view (WL-0MSGSE15000746F7)', () => {
    const registry = loadShortcutConfig();
    const entry = registry.lookupChordEntry(['f', 's'], 'list', undefined, false);
    expect(entry).toBeDefined();
    expect(entry?.command).toBe('/wl');
    expect(entry?.label).toBe('sprint');
  });

  it('registers the S ship-it chord to /skill:ship release (WL-0MSGG5N5Z0074TLY)', () => {
    const registry = loadShortcutConfig();
    const entry = registry.lookupChordEntry(['S'], 'list', undefined, false);
    expect(entry).toBeDefined();
    expect(entry?.command).toBe('/skill:ship release');
    expect(entry?.label).toBe('ship it');
    expect(entry?.view).toBe('both');
    // NOT code_freeze-blocked: the ship skill gates itself, so the
    // shortcut stays available during a freeze (confirmed decision).
    expect(entry?.codeFreeze).toBeUndefined();
    // S is distinct from lowercase s (Search) — case-sensitive matching.
    const search = registry.lookupChordEntry(['s'], 'list', undefined, false);
    expect(search?.command).toBe('!!wl search <search_term>');
    expect(registry.lookupChordEntry(['s'], 'list', undefined, false)?.command)
      .not.toBe('/skill:ship release');
  });

  it('keeps the S ship-it chord visible during a Code Freeze', () => {
    const registry = loadShortcutConfig();
    expect(registry.lookupChordEntry(['S'], 'list', undefined, true)).toBeDefined();
    expect(registry.getEntriesForStage(undefined, true).some(e => e.chord[0] === 'S')).toBe(true);
  });

  it('registers the d downtime-toggle chord to /downtime toggle (WL-0MSZ4NSOE007AQEF)', () => {
    const registry = loadShortcutConfig();
    const entry = registry.lookupChordEntry(['d'], 'list', undefined, false);
    expect(entry).toBeDefined();
    expect(entry?.command).toBe('/downtime toggle');
    expect(entry?.label).toBe('downtime toggle');
    expect(entry?.view).toBe('both');
    // Visible in both list and detail views.
    expect(registry.lookupChordEntry(['d'], 'detail', undefined, false)).toBeDefined();
  });
});

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

// ── Issue-type filtering (WL-0MSKH1J0R003BM2M) ─────────────────────────
//
// A shortcut entry carrying a `workItemTypes` allowlist is visible ONLY on
// work items whose issue type is listed. Entries without an allowlist, and
// lookups without a supplied issueType, behave exactly as before.

describe('ShortcutRegistry — issue-type filtering', () => {
  const podcastEntry: ShortcutEntry = {
    chord: ['w'],
    command: '/skill:wiki-podcast-script <id>',
    view: 'both',
    label: 'write script',
    workItemTypes: ['podcast'],
  };

  const codeEntry: ShortcutEntry = {
    chord: ['i'],
    command: '/skill:implement <id>',
    view: 'both',
    label: 'implement',
    workItemTypes: ['bug', 'docs', 'feature', 'task', 'chore', 'epic'],
  };

  const untypedEntry: ShortcutEntry = {
    chord: ['s'],
    command: '!!wl search <search_term>',
    view: 'both',
    label: 'search',
  };

  let registry: ShortcutRegistry;

  beforeEach(() => {
    registry = new ShortcutRegistry([podcastEntry, codeEntry, untypedEntry]);
  });

  it('resolves a podcast-gated chord only for podcast items', () => {
    expect(registry.lookupChord(['w'], 'list', undefined, false, 'podcast')).toBe('/skill:wiki-podcast-script <id>');
    expect(registry.lookupChord(['w'], 'list', undefined, false, 'feature')).toBeUndefined();
    expect(registry.lookupChord(['w'], 'list', undefined, false, 'docs')).toBeUndefined();
  });

  it('resolves a code-gated chord only for code and docs item types', () => {
    for (const t of ['bug', 'docs', 'feature', 'task', 'chore', 'epic']) {
      expect(registry.lookupChord(['i'], 'list', undefined, false, t)).toBe('/skill:implement <id>');
    }
    expect(registry.lookupChord(['i'], 'list', undefined, false, 'podcast')).toBeUndefined();
  });

  it('keeps untyped chords available on every type', () => {
    expect(registry.lookupChord(['s'], 'list', undefined, false, 'podcast')).toBe('!!wl search <search_term>');
    expect(registry.lookupChord(['s'], 'list', undefined, false, 'feature')).toBe('!!wl search <search_term>');
    expect(registry.lookupChord(['s'], 'list', undefined, false, 'docs')).toBe('!!wl search <search_term>');
  });

  it('keeps every chord visible when no issueType is supplied (backward compatible)', () => {
    expect(registry.lookupChord(['w'], 'list')).toBe('/skill:wiki-podcast-script <id>');
    expect(registry.lookupChord(['i'], 'list')).toBe('/skill:implement <id>');
    expect(registry.lookupChord(['s'], 'list')).toBe('!!wl search <search_term>');
    expect(registry.getEntries()).toHaveLength(3);
  });

  it('lookupChordEntry honors the allowlist', () => {
    expect(registry.lookupChordEntry(['w'], 'list', undefined, false, 'podcast')?.label).toBe('write script');
    expect(registry.lookupChordEntry(['w'], 'list', undefined, false, 'task')).toBeUndefined();
  });

  it('getEntriesForStage excludes entries whose allowlist misses the type', () => {
    const forPodcast = registry.getEntriesForStage(undefined, false, 'podcast');
    expect(forPodcast.map(e => e.label)).toEqual(['write script', 'search']);
    const forCode = registry.getEntriesForStage(undefined, false, 'task');
    expect(forCode.map(e => e.label)).toEqual(['implement', 'search']);
  });

  it('getChordByPrefix excludes entries whose allowlist misses the type', () => {
    expect(registry.getChordByPrefix(['w'], 'list', undefined, false, 'podcast')).toHaveLength(1);
    expect(registry.getChordByPrefix(['w'], 'list', undefined, false, 'chore')).toHaveLength(0);
    expect(registry.getChordByPrefix(['i'], 'list', undefined, false, 'podcast')).toHaveLength(0);
    expect(registry.getChordByPrefix(['i'], 'list', undefined, false, 'epic')).toHaveLength(1);
  });

  it('getChordByLeader honors the allowlist', () => {
    expect(registry.getChordByLeader('w', 'list', false, 'podcast')).toHaveLength(1);
    expect(registry.getChordByLeader('w', 'list', false, 'feature')).toHaveLength(0);
  });

  it('getChordEntries honors the allowlist', () => {
    expect(registry.getChordEntries(false, 'podcast').map(e => e.label)).toEqual(['write script', 'search']);
    expect(registry.getChordEntries(false, 'task').map(e => e.label)).toEqual(['implement', 'search']);
  });
});

// ── Project-local overrides (WL-0MSHUMX5C004NC4O) ───────────────────────
//
// Merge contract for a project-local <worklog-root>/shortcuts.json loaded
// over the bundled defaults: local-wins override on chord+view, new local
// chords appended, deterministic and deduplicated, malformed local file
// falls back to bundled-only with a logged error.

describe('loadShortcutConfig — project-local shortcuts.json overrides', () => {
  let tempRoots: string[] = [];

  /** Create a temp worklog root; `files` maps relative path -> content. */
  function makeLocalRoot(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-shortcut-override-'));
    tempRoots.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }

  afterEach(() => {
    for (const dir of tempRoots) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempRoots = [];
    vi.restoreAllMocks();
  });

  it('is byte-identical to bundled-only when no local file exists', () => {
    const bundled = loadShortcutConfig();
    const root = makeLocalRoot({}); // empty dir — no shortcuts.json
    const registry = loadShortcutConfig(root);
    expect(registry.getEntries()).toEqual(bundled.getEntries());
  });

  it('is byte-identical to bundled-only when worklogRoot is undefined', () => {
    const bundled = loadShortcutConfig();
    expect(loadShortcutConfig(undefined).getEntries()).toEqual(bundled.getEntries());
  });

  it('appends a local entry with a new chord and resolves it via lookupChord', () => {
    const bundled = loadShortcutConfig();
    const root = makeLocalRoot({
      'shortcuts.json': JSON.stringify([
        { chord: ['w'], command: '/prompt:Write a podcast script for <id>', view: 'both', label: 'podcast script' },
      ]),
    });
    const registry = loadShortcutConfig(root);
    const entries = registry.getEntries();
    expect(entries).toHaveLength(bundled.getEntries().length + 1);
    expect(registry.lookupChord(['w'], 'list')).toBe('/prompt:Write a podcast script for <id>');
    // Bundled entries are unchanged.
    expect(registry.lookupChord(['i'], 'list')).toBe(bundled.lookupChord(['i'], 'list'));
  });

  it('replaces a bundled entry when the local file overrides the same chord+view', () => {
    const bundled = loadShortcutConfig();
    const root = makeLocalRoot({
      'shortcuts.json': JSON.stringify([
        { chord: ['i'], command: '/prompt:overridden', view: 'both', label: 'overridden', model: 'author', stages: ['in_review'] },
      ]),
    });
    const registry = loadShortcutConfig(root);
    const entry = registry.lookupChordEntry(['i'], 'list');
    expect(entry?.command).toBe('/prompt:overridden');
    expect(entry?.label).toBe('overridden');
    expect(entry?.model).toBe('author');
    // The local entry's stages replace the bundled stages (full-entry replacement).
    expect(entry?.stages).toEqual(['in_review']);
    // Replaced, not appended: total count unchanged and no duplicate remains.
    expect(registry.getEntries()).toHaveLength(bundled.getEntries().length);
    const matches = registry.getEntries().filter(e => e.chord.join(',') === 'i' && e.view === 'both');
    expect(matches).toHaveLength(1);
  });

  it('falls back to bundled-only and logs an error for a malformed local file', () => {
    const bundled = loadShortcutConfig();
    const cases: Array<[string, string]> = [
      ['invalid JSON', '{ not json'],
      ['non-array', '{"chord": ["x"]}'],
      ['invalid entries', JSON.stringify([{ chord: ['x'], command: '', view: 'both' }])],
    ];
    for (const [name, content] of cases) {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const root = makeLocalRoot({ 'shortcuts.json': content });
      const registry = loadShortcutConfig(root);
      expect(registry.getEntries()).toEqual(bundled.getEntries());
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('deduplicates chord+view within the local file (last wins) deterministically', () => {
    const root = makeLocalRoot({
      'shortcuts.json': JSON.stringify([
        { chord: ['w'], command: '/prompt:first', view: 'both', label: 'first' },
        { chord: ['w'], command: '/prompt:second', view: 'both', label: 'second' },
      ]),
    });
    const a = loadShortcutConfig(root);
    const b = loadShortcutConfig(root);
    const matches = a.getEntries().filter(e => e.chord.join(',') === 'w' && e.view === 'both');
    expect(matches).toHaveLength(1);
    expect(matches[0].command).toBe('/prompt:second');
    // Merge order is stable across runs.
    expect(JSON.stringify(a.getEntries())).toBe(JSON.stringify(b.getEntries()));
  });
});

// ── w chord split: per-sub-chord stage gating (OSL-0MSKVB5K6008XFOQ) ──
// The single-key `w` write-script chord becomes a chord leader with three
// sub-chords: w-r (write review), w-s (write script), w-b (write both).
// w-r/w-b require an existing script, so they are gated to script-bearing
// stages (plan_complete / in_review / done); w-s keeps today's four-stage
// gate. All three stay gated to podcast-typed items.

describe('loadShortcutConfig — w chord split stage gating', () => {
  let tempRoots: string[] = [];

  function makeLocalRoot(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-w-chord-'));
    tempRoots.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }

  afterEach(() => {
    for (const dir of tempRoots) {
      try { rmSync(dir, { recursive: true }); } catch { /* ignore */ }
    }
    tempRoots = [];
    vi.restoreAllMocks();
  });

  const wEntries = [
    { chord: ['w', 'r'], command: '/skill:wiki-podcast-script --review <podcast-review>', view: 'both', label: 'write review', stages: ['plan_complete', 'in_review', 'done'], work_item_types: ['podcast'] },
    { chord: ['w', 's'], command: '/skill:wiki-podcast-script <podcast-target>', view: 'both', label: 'write script', stages: ['intake_complete', 'plan_complete', 'in_review', 'done'], work_item_types: ['podcast'] },
    { chord: ['w', 'b'], command: '/skill:wiki-podcast-script --review-rewrite <podcast-both>', view: 'both', label: 'write both', stages: ['plan_complete', 'in_review', 'done'], work_item_types: ['podcast'] },
  ];

  it('loads all three w sub-chords and no single-key w', () => {
    const root = makeLocalRoot({ 'shortcuts.json': JSON.stringify(wEntries) });
    const registry = loadShortcutConfig(root);
    expect(registry.lookupChordEntry(['w'], 'list')).toBeUndefined();
    expect(registry.lookupChordEntry(['w', 'r'], 'list')).toBeDefined();
    expect(registry.lookupChordEntry(['w', 's'], 'list')).toBeDefined();
    expect(registry.lookupChordEntry(['w', 'b'], 'list')).toBeDefined();
  });

  it('w-r and w-b are visible only at script-bearing stages (plan_complete, in_review, done)', () => {
    const root = makeLocalRoot({ 'shortcuts.json': JSON.stringify(wEntries) });
    const registry = loadShortcutConfig(root);
    for (const chord of [['w', 'r'], ['w', 'b']]) {
      for (const stage of ['plan_complete', 'in_review', 'done']) {
        expect(registry.lookupChordEntry(chord as ['w', 'r'], 'list', stage)).toBeDefined();
      }
      for (const stage of ['idea', 'intake_complete', 'in_progress']) {
        expect(registry.lookupChordEntry(chord as ['w', 'r'], 'list', stage)).toBeUndefined();
      }
    }
  });

  it('w-s keeps the four-stage gate (intake_complete through done)', () => {
    const root = makeLocalRoot({ 'shortcuts.json': JSON.stringify(wEntries) });
    const registry = loadShortcutConfig(root);
    for (const stage of ['intake_complete', 'plan_complete', 'in_review', 'done']) {
      expect(registry.lookupChordEntry(['w', 's'], 'list', stage)).toBeDefined();
    }
    for (const stage of ['idea', 'in_progress']) {
      expect(registry.lookupChordEntry(['w', 's'], 'list', stage)).toBeUndefined();
    }
  });

  it('all three sub-chords resolve at the script-bearing stages', () => {
    const root = makeLocalRoot({ 'shortcuts.json': JSON.stringify(wEntries) });
    const registry = loadShortcutConfig(root);
    expect(registry.lookupChordEntry(['w', 'r'], 'list', 'plan_complete')?.command)
      .toBe('/skill:wiki-podcast-script --review <podcast-review>');
    expect(registry.lookupChordEntry(['w', 's'], 'list', 'plan_complete')?.command)
      .toBe('/skill:wiki-podcast-script <podcast-target>');
    expect(registry.lookupChordEntry(['w', 'b'], 'list', 'plan_complete')?.command)
      .toBe('/skill:wiki-podcast-script --review-rewrite <podcast-both>');
  });

  it('all three w sub-chords stay gated to podcast-typed items', () => {
    const root = makeLocalRoot({ 'shortcuts.json': JSON.stringify(wEntries) });
    const registry = loadShortcutConfig(root);
    for (const chord of [['w', 'r'], ['w', 's'], ['w', 'b']]) {
      const entry = registry.lookupChordEntry(chord as ['w', 'r'], 'list');
      expect(entry?.workItemTypes).toEqual(['podcast']);
      // Hidden on non-podcast types.
      expect(registry.lookupChordEntry(chord as ['w', 'r'], 'list', undefined, false, 'bug')).toBeUndefined();
    }
  });
});
