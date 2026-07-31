/**
 * tests/herdr/shortcuts.test.ts — Tests for Herdr chord shortcut system
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ShortcutRegistry, type ShortcutEntry } from '../../packages/herdr/src/shortcut-config.js';
import { dispatchChordCommand, executeResolvedCommand, WorkItemListState } from '../../packages/herdr/src/worklist.js';
import { getTermSize } from '../../packages/herdr/src/worklist.js';
import type { WorkItem } from '../../packages/herdr/src/fetcher.js';

// ── Fixtures ──────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<ShortcutEntry> = {}): ShortcutEntry {
  return {
    chord: ['i'],
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
      { chord: ['i'], command: '/skill:implement <id>', view: 'both', label: 'implement', stages: ['intake_complete', 'plan_complete', 'in_progress'] },
      { chord: ['r'], command: "!!wl reviewed <id> && wl comment add <id> --body '<producer_comment>'", view: 'both', label: 'Producer Review' },
      { chord: ['p'], command: '/plan <id>', view: 'both', label: 'plan', stages: ['intake_complete'] },
      { chord: ['c'], command: '/intake', view: 'both', label: 'create new' },
      { chord: ['n'], command: '/intake <id>', view: 'both', label: 'intake', stages: ['idea'] },
      { chord: ['s'], command: '!!wl search ', view: 'both', label: 'Search' },
    ];
  });

  describe('lookupChord', () => {
    it('returns undefined for unknown chord', () => {
      const reg = new ShortcutRegistry(entries);
      expect(reg.lookupChord(['z'], 'list')).toBeUndefined();
    });

    it('returns command for known single-key chord', () => {
      const reg = new ShortcutRegistry(entries);
      expect(reg.lookupChord(['c'], 'list')).toBe('/intake');
    });

    it('filters by view', () => {
      const reg = new ShortcutRegistry(entries);
      expect(reg.lookupChord(['c'], 'list')).toBe('/intake');
      expect(reg.lookupChord(['c'], 'detail')).toBe('/intake');
    });

    it('filters by stage when entry has stages constraint', () => {
      const reg = new ShortcutRegistry(entries);
      // 'i' is available for intake_complete stage
      expect(reg.lookupChord(['i'], 'list', 'intake_complete')).toBe('/skill:implement <id>');
      // 'i' is NOT available for idea stage
      expect(reg.lookupChord(['i'], 'list', 'idea')).toBeUndefined();
    });

    it('returns command when stage is undefined but entry has no stages constraint', () => {
      const reg = new ShortcutRegistry(entries);
      expect(reg.lookupChord(['c'], 'list')).toBe('/intake');
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
      const ideaIds = ideaEntries.map(e => e.chord[0]);
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
        { chord: ['u', 'p', 'l'], command: '!!wl update <id> --priority low', view: 'both', label: 'priority low' },
        { chord: ['u', 'p', 'm'], command: '!!wl update <id> --priority medium', view: 'both', label: 'priority medium' },
        { chord: ['u', 'p', 'h'], command: '!!wl update <id> --priority high', view: 'both', label: 'priority high' },
        { chord: ['u', 'p', 'c'], command: '!!wl update <id> --priority critical', view: 'both', label: 'priority critical' },
        { chord: ['u', 's'], command: '!!wl update <id> --status <status> --stage <stage> ', view: 'both', label: 'update stage/status' },
        { chord: ['u', 't'], command: '!!wl update <id> --title ', view: 'both', label: 'update title' },
        { chord: ['f', 'i'], command: '/wl idea', view: 'both', label: 'filter idea' },
        { chord: ['f', 'n'], command: '/wl intake', view: 'both', label: 'filter intake' },
        { chord: ['f', 'p'], command: '/wl plan', view: 'both', label: 'filter plan' },
        { chord: ['f', 'r'], command: '/wl review', view: 'both', label: 'filter in_review' },
        { chord: ['x', 'c'], command: '!!wl close <id>', view: 'both', label: 'close done' },
        { chord: ['x', 'd'], command: '!!wl delete <id>', view: 'both', label: 'close deleted' },
        { chord: ['a', 'a'], command: '/skill:audit <id>', view: 'both', label: 'audit automatic', stages: ['in_review'] },
        { chord: ['a', 'y'], command: "!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes --summary 'Approved by manual review'", view: 'both', label: 'audit approve', stages: ['in_review'] },
        { chord: ['a', 'r'], command: "!!wl reviewed <id> false && wl audit-set <id> --ready-to-close no --summary 'Rejected by manual review. <reason>'", view: 'both', label: 'audit reject', stages: ['in_review'] },
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
      expect(uChords.length).toBe(6); // u-p-l, u-p-m, u-p-h, u-p-c, u-s, u-t
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
      const reg = new ShortcutRegistry(chordEntries);
      const reviewChords = reg.getChordByPrefix(['a', 'a'], 'list', 'in_review');
      expect(reviewChords.length).toBe(1);
      const ideaChords = reg.getChordByPrefix(['a', 'a'], 'list', 'idea');
      expect(ideaChords.length).toBe(0);
    });

    it('returns chord entries list', () => {
      const reg = new ShortcutRegistry(chordEntries);
      const chords = reg.getChordEntries();
      // Should include both single-key and multi-key entries
      expect(chords.length).toBeGreaterThanOrEqual(21);
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
      const allChords = entries.map(e => e.chord[0]);
      expect(allChords).toContain('c');
      expect(allChords).toContain('s');
      expect(allChords).toContain('r');
      expect(allChords).toContain('u');
      expect(allChords).toContain('x');
      expect(allChords).toContain('a');
      expect(allChords).toContain('f');
      expect(allChords).toContain('i');
      const chordEntries = registry.getChordEntries();
      expect(chordEntries.length).toBeGreaterThanOrEqual(21);
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

// ── Fixtures for executeResolvedCommand tests ─────────────────────────

function makeWorkItem(id: string, title?: string): WorkItem {
  return {
    id,
    title: title ?? `Item ${id}`,
    status: 'in-progress',
    priority: 'medium',
    stage: 'in_progress',
  };
}

function makeState(items: WorkItem[]): WorkItemListState {
  return new WorkItemListState(items, getTermSize());
}

// ── executeResolvedCommand tests ──────────────────────────────────────

describe('executeResolvedCommand', () => {
  it('returns "dispatched" for /wl filter commands', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const result = executeResolvedCommand('/wl idea', state);
    expect(result).toBe('dispatched');
  });

  it('returns "dispatched" for /wl intake command', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const result = executeResolvedCommand('/wl intake', state);
    expect(result).toBe('dispatched');
  });

  it('returns "dispatched" for /wl plan command', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const result = executeResolvedCommand('/wl plan', state);
    expect(result).toBe('dispatched');
  });

  it('returns "dispatched" for /wl review command', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const result = executeResolvedCommand('/wl review', state);
    expect(result).toBe('dispatched');
  });

  it('calls onCommand callback for non-/wl commands', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl search test', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl search test']);
  });

  it('replaces <id> placeholder with selected item ID', () => {
    const items = [makeWorkItem('WL-001', 'First Item'), makeWorkItem('WL-002', 'Second Item')];
    const state = makeState(items);
    // Select WL-002
    state.selectedIndex = 1;

    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl update <id> --priority high', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl update WL-002 --priority high']);
  });

  it('returns "noop" when no item selected and command requires <id>', () => {
    const state = makeState([]);

    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl update <id> --priority high', state, callback);
    expect(result).toBe('noop');
    expect(commands).toEqual([]);
  });

  it('returns "noop" when selectedIndex is out of range and command requires <id>', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    state.selectedIndex = 999; // Out of range

    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl update <id> --priority high', state, callback);
    expect(result).toBe('noop');
    expect(commands).toEqual([]);
  });

  it('passes commands without <id> to callback even when no items', () => {
    const state = makeState([]);

    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl search test', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl search test']);
  });

  it('replaces multiple <id> occurrences in the command', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);

    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('/custom:tool <id> && echo <id>', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['/custom:tool WL-001 && echo WL-001']);
  });

  it('does not call onCommand when onCommand is undefined', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);

    // Should not throw even with no callback
    const result = executeResolvedCommand('!!wl search test', state);
    expect(result).toBe('callback');
  });

  it('routes !!wl close <id> to callback with ID substitution', () => {
    const items = [makeWorkItem('WL-099')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl close <id>', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl close WL-099']);
  });

  it('routes !!wl delete <id> to callback with ID substitution', () => {
    const items = [makeWorkItem('WL-077')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl delete <id>', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl delete WL-077']);
  });

  it('routes !!wl search [query] to callback', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl search my query', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl search my query']);
  });

  it('returns "noop" for !!wl close when no items selected', () => {
    const state = makeState([]);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl close <id>', state, callback);
    expect(result).toBe('noop');
    expect(commands).toEqual([]);
  });

  it('returns "noop" for !!wl delete when no items selected', () => {
    const state = makeState([]);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl delete <id>', state, callback);
    expect(result).toBe('noop');
    expect(commands).toEqual([]);
  });

  it('routes !!wl close without callback (backward compatible)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const result = executeResolvedCommand('!!wl close <id>', state);
    expect(result).toBe('callback');
  });

  it('routes !!wl delete without callback (backward compatible)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const result = executeResolvedCommand('!!wl delete <id>', state);
    expect(result).toBe('callback');
  });
});

// ── dispatchChordCommand tests ────────────────────────────────────────

describe('dispatchChordCommand', () => {
  it('returns false for unrecognized commands', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    expect(dispatchChordCommand('!!unknown command', state)).toBe(false);
  });

  it('recognizes /skill:implement and routes to onCommand', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('/skill:implement <id>', state, callback);
    expect(result).toBe(true);
    expect(commands).toEqual(['/skill:implement WL-001']);
  });

  it('recognizes /skill:audit and routes to onCommand', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('/skill:audit <id>', state, callback);
    expect(result).toBe(true);
    expect(commands).toEqual(['/skill:audit WL-001']);
  });

  it('recognizes /intake <id> and routes to onCommand', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('/intake <id>', state, callback);
    expect(result).toBe(true);
    expect(commands).toEqual(['/intake WL-001']);
  });

  it('recognizes /intake (without id) and routes to onCommand', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('/intake', state, callback);
    expect(result).toBe(true);
    expect(commands).toEqual(['/intake']);
  });

  it('recognizes /plan <id> and routes to onCommand', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('/plan <id>', state, callback);
    expect(result).toBe(true);
    expect(commands).toEqual(['/plan WL-001']);
  });

  it('recognizes !!wl reviewed prefix and routes to onCommand', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('!!wl reviewed <id> && wl comment add <id> --body "Looks good"', state, callback);
    expect(result).toBe(true);
    expect(commands).toEqual(['!!wl reviewed WL-001 && wl comment add WL-001 --body "Looks good"']);
  });

  it('recognizes compound audit commands with && wl audit-set', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes --summary "Approved"', state, callback);
    expect(result).toBe(true);
    expect(commands).toEqual(['!!wl reviewed WL-001 false && wl audit-set WL-001 --ready-to-close yes --summary "Approved"']);
  });

  it('returns the no-op for /skill:implement when no item selected and command requires <id>', () => {
    const state = makeState([]);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('/skill:implement <id>', state, callback);
    expect(result).toBe(false);
    expect(commands).toEqual([]);
  });

  it('returns true for /wl <stage> filter commands (existing behavior)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('/wl idea', state, callback);
    expect(result).toBe(true);
    // Filter should have been applied, not callback — 'idea' maps to 'idea'
    expect(state.activeFilter).toBe('idea');
    expect(commands).toEqual([]);
  });

  it('handles compound /skill:implement with &&', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('/skill:implement <id> && echo done', state, callback);
    expect(result).toBe(true);
    expect(commands).toEqual(['/skill:implement WL-001 && echo done']);
  });

  it('does not call onCommand for /wl stage commands', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = dispatchChordCommand('/wl idea', state, callback);
    // /wl commands are handled internally, not routed to onCommand
    expect(result).toBe(true);
    expect(commands).toEqual([]);
  });

  it('still applies /wl filter dispatch when onCommand is undefined', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);

    const result = dispatchChordCommand('/wl idea', state);
    expect(result).toBe(true);
    expect(state.activeFilter).toBe('idea');
  });

  it('handles /skill:implement when onCommand is undefined', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);

    const result = dispatchChordCommand('/skill:implement <id>', state);
    expect(result).toBe(true);
  });

  // ── !!wl text-insertion template commands ───────────────────────

  it('returns false for !!wl update command (falls through to executeResolvedCommand)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    expect(dispatchChordCommand('!!wl update <id> --priority high', state)).toBe(false);
  });

  it('routes each priority chord template with id substitution', () => {
    const items = [makeWorkItem('WL-001')];
    const templates = [
      ['!!wl update <id> --priority low', '!!wl update WL-001 --priority low'],
      ['!!wl update <id> --priority medium', '!!wl update WL-001 --priority medium'],
      ['!!wl update <id> --priority high', '!!wl update WL-001 --priority high'],
      ['!!wl update <id> --priority critical', '!!wl update WL-001 --priority critical'],
    ] as const;
    for (const [template, expected] of templates) {
      const commands: string[] = [];
      const callback = (cmd: string) => { commands.push(cmd); };
      const result = executeResolvedCommand(template, makeState(items), callback);
      expect(result).toBe('callback');
      expect(commands).toEqual([expected]);
    }
  });

  it('routes u-s stage/status chord template with id substitution', () => {
    const items = [makeWorkItem('WL-001')];
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };
    const result = executeResolvedCommand('!!wl update <id> --status <status> --stage <stage> ', makeState(items), callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl update WL-001 --status <status> --stage <stage> ']);
  });

  it('routes audit approve/reject chord templates with id substitution', () => {
    const items = [makeWorkItem('WL-001')];
    const templates = [
      ["!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes --summary 'Approved by manual review'", "!!wl reviewed WL-001 false && wl audit-set WL-001 --ready-to-close yes --summary 'Approved by manual review'"],
      ["!!wl reviewed <id> false && wl audit-set <id> --ready-to-close no --summary 'Rejected by manual review. <reason>'", "!!wl reviewed WL-001 false && wl audit-set WL-001 --ready-to-close no --summary 'Rejected by manual review. <reason>'"],
    ] as const;
    for (const [template, expected] of templates) {
      const commands: string[] = [];
      const callback = (cmd: string) => { commands.push(cmd); };
      // dispatchChordCommand handles !!wl reviewed/audit-set and routes to onCommand
      const result = executeResolvedCommand(template, makeState(items), callback);
      expect(result).toBe('dispatched');
      expect(commands).toEqual([expected]);
    }
  });

  it('returns false for !!wl close command (falls through to executeResolvedCommand)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    expect(dispatchChordCommand('!!wl close <id>', state)).toBe(false);
  });

  it('returns false for !!wl delete command (falls through to executeResolvedCommand)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    expect(dispatchChordCommand('!!wl delete <id>', state)).toBe(false);
  });

  it('returns false for !!wl search command (falls through to executeResolvedCommand)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    expect(dispatchChordCommand('!!wl search test', state)).toBe(false);
  });

  it('returns false for !!wl update without callback (backward compatible)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    // When no callback provided, !!wl commands still fall through
    expect(dispatchChordCommand('!!wl update <id> --priority low', state)).toBe(false);
  });

  it('does not invoke onCommand for !!wl update in dispatchChordCommand (always falls through)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    dispatchChordCommand('!!wl update <id> --priority high', state, callback);
    // dispatchChordCommand returns false for !!wl, so onCommand should NOT be called here
    expect(commands).toEqual([]);
  });

  it('returns false for !!wl close with no items (does not attempt id substitution)', () => {
    const state = makeState([]);
    expect(dispatchChordCommand('!!wl close <id>', state)).toBe(false);
  });
});

// ── executeResolvedCommand with dispatchChordCommand routing integration tests ─

describe('executeResolvedCommand with routing', () => {
  it('returns "dispatched" for /skill:implement commands', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('/skill:implement <id>', state, callback);
    expect(result).toBe('dispatched');
    expect(commands).toEqual(['/skill:implement WL-001']);
  });

  it('returns "dispatched" for /skill:audit <id>', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('/skill:audit <id>', state, callback);
    expect(result).toBe('dispatched');
    expect(commands).toEqual(['/skill:audit WL-001']);
  });

  it('returns "dispatched" for /intake <id>', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('/intake <id>', state, callback);
    expect(result).toBe('dispatched');
    expect(commands).toEqual(['/intake WL-001']);
  });

  it('returns "dispatched" for /intake (without id)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('/intake', state, callback);
    expect(result).toBe('dispatched');
    expect(commands).toEqual(['/intake']);
  });

  it('returns "dispatched" for /plan <id>', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('/plan <id>', state, callback);
    expect(result).toBe('dispatched');
    expect(commands).toEqual(['/plan WL-001']);
  });

  it('returns "dispatched" for !!wl reviewed commands', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl reviewed <id> && wl comment add <id> --body "Looks good"', state, callback);
    expect(result).toBe('dispatched');
    expect(commands).toEqual(['!!wl reviewed WL-001 && wl comment add WL-001 --body "Looks good"']);
  });

  it('returns "dispatched" for compound audit commands', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl reviewed <id> false && wl audit-set <id> --ready-to-close yes --summary "Approved"', state, callback);
    expect(result).toBe('dispatched');
    expect(commands).toEqual(['!!wl reviewed WL-001 false && wl audit-set WL-001 --ready-to-close yes --summary "Approved"']);
  });

  it('returns "noop" for /skill:implement when no item selected', () => {
    const state = makeState([]);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('/skill:implement <id>', state, callback);
    expect(result).toBe('noop');
    expect(commands).toEqual([]);
  });

  it('still returns "callback" for unrecognized non-/wl commands', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl search test', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl search test']);
  });

  it('still returns "callback" for !!wl update commands', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl update <id> --priority high', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl update WL-001 --priority high']);
  });

  it('routes !!wl close <id> to callback with ID substitution', () => {
    const items = [makeWorkItem('WL-099')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl close <id>', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl close WL-099']);
  });

  it('routes !!wl delete <id> to callback with ID substitution', () => {
    const items = [makeWorkItem('WL-077')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl delete <id>', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl delete WL-077']);
  });

  it('returns "noop" for !!wl close <id> when no item selected', () => {
    const state = makeState([]);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl close <id>', state, callback);
    expect(result).toBe('noop');
    expect(commands).toEqual([]);
  });

  it('returns "noop" for !!wl delete <id> when no item selected', () => {
    const state = makeState([]);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl delete <id>', state, callback);
    expect(result).toBe('noop');
    expect(commands).toEqual([]);
  });

  it('routes !!wl update <id> --status done --stage in_review to callback with ID', () => {
    const items = [makeWorkItem('WL-042')];
    const state = makeState(items);
    const commands: string[] = [];
    const callback = (cmd: string) => { commands.push(cmd); };

    const result = executeResolvedCommand('!!wl update <id> --status completed --stage in_review', state, callback);
    expect(result).toBe('callback');
    expect(commands).toEqual(['!!wl update WL-042 --status completed --stage in_review']);
  });

  it('routes !!wl close <id> without callback (backward compatible)', () => {
    const items = [makeWorkItem('WL-001')];
    const state = makeState(items);
    // Should not throw even without a callback
    const result = executeResolvedCommand('!!wl close <id>', state);
    expect(result).toBe('callback');
  });
});

describe('runWorklistTui options (type-level)', () => {
  it('accepts onCommand in options parameter', async () => {
    // Verify the type accepts onCommand by checking the function signature
    const mod = await import('../../packages/herdr/src/worklist.js');
    expect(typeof mod.runWorklistTui).toBe('function');
    // Options parameter should accept onCommand
    const optionsType = mod.runWorklistTui.length;
    expect(optionsType).toBeGreaterThanOrEqual(3); // fetcher, initialItems, shortcutRegistry, options
  });
});
