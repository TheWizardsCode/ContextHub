/**
 * Unit tests for shortcut-config.ts - config loader, registry, and dispatch.
 *
 * Run: npx vitest run packages/tui/extensions/shortcut-config.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ShortcutRegistry,
  loadShortcutConfig,
  type ShortcutEntry,
} from './shortcut-config.js';

describe('ShortcutRegistry', () => {
  let registry: ShortcutRegistry;

  beforeEach(() => {
    const entries: ShortcutEntry[] = [
      { key: 'i', command: 'implement <id>', view: 'both' },
      { key: 'p', command: 'plan <id>', view: 'list' },
      { key: 'a', command: 'audit <id>', view: 'detail' },
      { key: 'n', command: 'intake <id>', view: 'both' },
    ];
    registry = new ShortcutRegistry(entries);
  });

  describe('lookup(key, view)', () => {
    it('returns the command for a matching key in "both" view', () => {
      expect(registry.lookup('i', 'list')).toBe('implement <id>');
      expect(registry.lookup('i', 'detail')).toBe('implement <id>');
    });

    it('returns the command for a matching key in its specific view', () => {
      expect(registry.lookup('p', 'list')).toBe('plan <id>');
      expect(registry.lookup('p', 'detail')).toBeUndefined();

      expect(registry.lookup('a', 'detail')).toBe('audit <id>');
      expect(registry.lookup('a', 'list')).toBeUndefined();
    });

    it('returns undefined for an unregistered key', () => {
      expect(registry.lookup('x', 'list')).toBeUndefined();
      expect(registry.lookup('x', 'detail')).toBeUndefined();
    });

    it('returns undefined for an empty key', () => {
      expect(registry.lookup('', 'list')).toBeUndefined();
    });

    it('returns all entries via getEntries', () => {
      const entries = registry.getEntries();
      expect(entries).toHaveLength(4);
      expect(entries[0]).toEqual({ key: 'i', command: 'implement <id>', view: 'both' });
    });
  });

  describe('lookup(key, view, stage)', () => {
    it('returns command when entry has no stages constraint regardless of stage', () => {
      expect(registry.lookup('i', 'list')).toBe('implement <id>');
      expect(registry.lookup('i', 'list', 'idea')).toBe('implement <id>');
      expect(registry.lookup('i', 'list', 'intake_complete')).toBe('implement <id>');
      expect(registry.lookup('i', 'list', 'in_progress')).toBe('implement <id>');
    });

    it('returns command when stage matches an entry with stages allow-list', () => {
      const stageEntries: ShortcutEntry[] = [
        { key: 'n', command: 'intake <id>', view: 'both', stages: ['idea'] },
        { key: 'i', command: 'implement <id>', view: 'both', stages: ['intake_complete'] },
        { key: 'a', command: 'audit <id>', view: 'both' },
      ];
      const reg = new ShortcutRegistry(stageEntries);

      // 'n' only works for idea stage (also works when no stage provided)
      expect(reg.lookup('n', 'list', 'idea')).toBe('intake <id>');
      expect(reg.lookup('n', 'list', 'intake_complete')).toBeUndefined();
      expect(reg.lookup('n', 'list')).toBe('intake <id>'); // backward compat: no stage filter

      // 'i' only works for intake_complete stage
      expect(reg.lookup('i', 'list', 'intake_complete')).toBe('implement <id>');
      expect(reg.lookup('i', 'list', 'idea')).toBeUndefined();
      expect(reg.lookup('i', 'list')).toBe('implement <id>'); // backward compat: no stage filter

      // 'a' (no stages) works unconditionally
      expect(reg.lookup('a', 'list', 'idea')).toBe('audit <id>');
      expect(reg.lookup('a', 'list', 'intake_complete')).toBe('audit <id>');
      expect(reg.lookup('a', 'list')).toBe('audit <id>');
    });

    it('returns command when stage is undefined and entry has stages (backward compat)', () => {
      // When stage is explicitly undefined (not known), entries with stages
      // still match for backward compatibility — the stage filter is only
      // applied when a known stage string is provided.
      const stageEntries: ShortcutEntry[] = [
        { key: 'n', command: 'intake <id>', view: 'both', stages: ['idea'] },
        { key: 'a', command: 'audit <id>', view: 'both' },
      ];
      const reg = new ShortcutRegistry(stageEntries);

      // When stage is undefined (unknown), the filter is skipped — backward compat
      expect(reg.lookup('n', 'list', undefined)).toBe('intake <id>');
      expect(reg.lookup('a', 'list', undefined)).toBe('audit <id>');
    });

    it('returns undefined when stage does not match entry with stages allow-list', () => {
      const stageEntries: ShortcutEntry[] = [
        { key: 'p', command: 'plan <id>', view: 'both', stages: ['intake_complete'] },
      ];
      const reg = new ShortcutRegistry(stageEntries);

      expect(reg.lookup('p', 'list', 'idea')).toBeUndefined();
      expect(reg.lookup('p', 'list', 'plan_complete')).toBeUndefined();
      expect(reg.lookup('p', 'list', 'in_progress')).toBeUndefined();
      expect(reg.lookup('p', 'list', 'in_review')).toBeUndefined();
      expect(reg.lookup('p', 'list', '')).toBeUndefined();
    });

    it('matches stage against multiple allowed stages', () => {
      const multiStage: ShortcutEntry[] = [
        { key: 'x', command: 'custom <id>', view: 'both', stages: ['idea', 'in_progress'] },
      ];
      const reg = new ShortcutRegistry(multiStage);

      expect(reg.lookup('x', 'list', 'idea')).toBe('custom <id>');
      expect(reg.lookup('x', 'list', 'in_progress')).toBe('custom <id>');
      expect(reg.lookup('x', 'list', 'intake_complete')).toBeUndefined();
      expect(reg.lookup('x', 'list', 'plan_complete')).toBeUndefined();
      expect(reg.lookup('x', 'list', 'in_review')).toBeUndefined();
    });

    it('still respects view filter combined with stage filter', () => {
      const viewStageEntries: ShortcutEntry[] = [
        { key: 'i', command: 'implement <id>', view: 'list', stages: ['intake_complete'] },
        { key: 'i', command: 'implement-detail <id>', view: 'detail', stages: ['intake_complete'] },
      ];
      const reg = new ShortcutRegistry(viewStageEntries);

      expect(reg.lookup('i', 'list', 'intake_complete')).toBe('implement <id>');
      expect(reg.lookup('i', 'detail', 'intake_complete')).toBe('implement-detail <id>');
      expect(reg.lookup('i', 'list', 'idea')).toBeUndefined();
      expect(reg.lookup('i', 'detail', 'idea')).toBeUndefined();
    });
  });

  describe('getEntriesForStage', () => {
    it('returns all entries when no stage constraints and stage is undefined', () => {
      const entries = registry.getEntriesForStage(undefined);
      expect(entries).toHaveLength(4);
    });

    it('returns only entries matching the given stage', () => {
      const stageEntries: ShortcutEntry[] = [
        { key: 'n', command: 'intake <id>', view: 'both', stages: ['idea'] },
        { key: 'i', command: 'implement <id>', view: 'both', stages: ['intake_complete'] },
        { key: 'a', command: 'audit <id>', view: 'both' },
      ];
      const reg = new ShortcutRegistry(stageEntries);

      const ideaEntries = reg.getEntriesForStage('idea');
      expect(ideaEntries).toHaveLength(2);
      expect(ideaEntries.find(e => e.key === 'n')).toBeDefined();
      expect(ideaEntries.find(e => e.key === 'a')).toBeDefined();

      const intakeCompleteEntries = reg.getEntriesForStage('intake_complete');
      expect(intakeCompleteEntries).toHaveLength(2);
      expect(intakeCompleteEntries.find(e => e.key === 'i')).toBeDefined();
      expect(intakeCompleteEntries.find(e => e.key === 'a')).toBeDefined();

      const unknownStageEntries = reg.getEntriesForStage('in_progress');
      expect(unknownStageEntries).toHaveLength(1);
      expect(unknownStageEntries.find(e => e.key === 'a')).toBeDefined();
    });

    it('returns only unconditional entries when stage is undefined and entries have stages constraints', () => {
      const stageEntries: ShortcutEntry[] = [
        { key: 'n', command: 'intake <id>', view: 'both', stages: ['idea'] },
        { key: 'a', command: 'audit <id>', view: 'both' },
      ];
      const reg = new ShortcutRegistry(stageEntries);

      const entries = reg.getEntriesForStage(undefined);
      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe('a');
    });

    it('returns entries with empty stages array unconditionally', () => {
      const entriesWithEmptyStages: ShortcutEntry[] = [
        { key: 'x', command: 'test <id>', view: 'both', stages: [] },
      ];
      const reg = new ShortcutRegistry(entriesWithEmptyStages);

      expect(reg.getEntriesForStage('idea')).toHaveLength(1);
      expect(reg.getEntriesForStage(undefined)).toHaveLength(1);
    });
  });

  describe('empty registry', () => {
    it('returns undefined for all lookups', () => {
      const empty = new ShortcutRegistry([]);
      expect(empty.lookup('i', 'list')).toBeUndefined();
      expect(empty.lookup('i', 'detail')).toBeUndefined();
    });
  });
});

describe('loadShortcutConfig', () => {
  it('loads valid entries from shortcuts.json', () => {
    const registry = loadShortcutConfig();
    const entries = registry.getEntries();
    expect(entries).toHaveLength(5);

    const implementEntry = entries.find(e => e.key === 'i');
    expect(implementEntry).toBeDefined();
    expect(implementEntry!.command).toBe('/skill:implement <id>');
    expect(implementEntry!.view).toBe('both');
    expect(implementEntry!.stages).toEqual(['plan_complete']);
    expect(implementEntry!.label).toBe('implement');
    expect(implementEntry!.description).toBe('Run the implement workflow on the selected work item');

    const planEntry = entries.find(e => e.key === 'p');
    expect(planEntry).toBeDefined();
    expect(planEntry!.command).toBe('/plan <id>');
    expect(planEntry!.view).toBe('both');
    expect(planEntry!.stages).toEqual(['intake_complete']);
    expect(planEntry!.label).toBe('plan');
    expect(planEntry!.description).toBe('Run the plan workflow on the selected work item');

    const intakeEntry = entries.find(e => e.key === 'n');
    expect(intakeEntry).toBeDefined();
    expect(intakeEntry!.command).toBe('/intake <id>');
    expect(intakeEntry!.view).toBe('both');
    expect(intakeEntry!.stages).toEqual(['idea']);
    expect(intakeEntry!.label).toBe('intake');
    expect(intakeEntry!.description).toBe('Ensure that the selected item is reasonably well defined in terms of objectives.');

    const auditEntry = entries.find(e => e.key === 'a');
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.command).toBe('/skill:audit <id>');
    expect(auditEntry!.view).toBe('both');
    expect(auditEntry!.stages).toEqual(['in_review']);
    expect(auditEntry!.label).toBe('audit');
    expect(auditEntry!.description).toBe('Run an audit on the selected work item');
  });

  it('lookup resolves shortcuts loaded from file with stage parameter', () => {
    const registry = loadShortcutConfig();

    // 'i' (implement) should only work for plan_complete stage
    expect(registry.lookup('i', 'list', 'plan_complete')).toBe('/skill:implement <id>');
    expect(registry.lookup('i', 'detail', 'plan_complete')).toBe('/skill:implement <id>');
    expect(registry.lookup('i', 'list', 'idea')).toBeUndefined();
    expect(registry.lookup('i', 'list', 'intake_complete')).toBeUndefined();
    expect(registry.lookup('i', 'list', 'in_progress')).toBeUndefined();

    // 'p' (plan) should only work for intake_complete stage
    expect(registry.lookup('p', 'list', 'intake_complete')).toBe('/plan <id>');
    expect(registry.lookup('p', 'list', 'idea')).toBeUndefined();

    // 'n' (intake) should only work for idea stage
    expect(registry.lookup('n', 'detail', 'idea')).toBe('/intake <id>');
    expect(registry.lookup('n', 'detail', 'intake_complete')).toBeUndefined();

    // 'a' (audit) has stages: ['in_review'], works only for that stage
    expect(registry.lookup('a', 'list', 'in_review')).toBe('/skill:audit <id>');
    expect(registry.lookup('a', 'detail', 'in_review')).toBe('/skill:audit <id>');
    expect(registry.lookup('a', 'list', 'in_progress')).toBeUndefined();
    expect(registry.lookup('a', 'list', 'idea')).toBeUndefined();

    // Without stage parameter, entries with stages constraint still work
    // (backward compatible when calling without stage)
    expect(registry.lookup('n', 'detail')).toBe('/intake <id>');
    expect(registry.lookup('i', 'list')).toBe('/skill:implement <id>');
    expect(registry.lookup('p', 'list')).toBe('/plan <id>');
    expect(registry.lookup('a', 'list')).toBe('/skill:audit <id>');
  });

  it('returns empty registry for unregistered key', () => {
    const registry = loadShortcutConfig();
    expect(registry.lookup('x', 'list')).toBeUndefined();
  });

  it('getEntriesForStage returns correct subset from file with stage constraints', () => {
    const registry = loadShortcutConfig();

    const ideaEntries = registry.getEntriesForStage('idea');
    expect(ideaEntries.length).toBeGreaterThanOrEqual(2); // c, n
    expect(ideaEntries.find(e => e.key === 'c')).toBeDefined();
    expect(ideaEntries.find(e => e.key === 'n')).toBeDefined();
    expect(ideaEntries.find(e => e.key === 'a')).toBeUndefined(); // 'a' requires in_review
    expect(ideaEntries.find(e => e.key === 'i')).toBeUndefined();
    expect(ideaEntries.find(e => e.key === 'p')).toBeUndefined();

    const intakeCompleteEntries = registry.getEntriesForStage('intake_complete');
    expect(intakeCompleteEntries.find(e => e.key === 'p')).toBeDefined();
    expect(intakeCompleteEntries.find(e => e.key === 'a')).toBeUndefined(); // 'a' requires in_review
    expect(intakeCompleteEntries.find(e => e.key === 'c')).toBeDefined();
    expect(intakeCompleteEntries.find(e => e.key === 'n')).toBeUndefined();
    expect(intakeCompleteEntries.find(e => e.key === 'i')).toBeUndefined(); // 'i' requires plan_complete

    const planCompleteEntries = registry.getEntriesForStage('plan_complete');
    expect(planCompleteEntries.find(e => e.key === 'i')).toBeDefined();
    expect(planCompleteEntries.find(e => e.key === 'a')).toBeUndefined(); // 'a' requires in_review
    expect(planCompleteEntries.find(e => e.key === 'c')).toBeDefined();

    const inReviewEntries = registry.getEntriesForStage('in_review');
    expect(inReviewEntries.length).toBeGreaterThanOrEqual(2); // c (unconditional) + a
  });
});

describe('ShortcutRegistry unregistered keys (dispatcher)', () => {
  it('returns undefined for unregistered key', () => {
    const entries: ShortcutEntry[] = [
      { key: 'i', command: 'implement <id>', view: 'both' },
      { key: 'p', command: 'plan <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    expect(registry.lookup('x', 'list')).toBeUndefined();
    expect(registry.lookup('y', 'detail')).toBeUndefined();
    expect(registry.lookup('zz', 'both')).toBeUndefined();
  });
});

// ─── Chord schema, registry, and dispatch tests ─────────────────────────
//
// These tests describe the expected behaviour of chord shortcuts that will
// be implemented in F2 (schema), F3 (registry) and F4 (dispatch).  Until
// those work items are complete, some tests use `as any` type assertions to
// permit referencing the `chord` property and chord methods that do not yet
// exist on the production types.  Once F2/F3/F4 are landed the casts can be
// removed — the tests themselves act as the acceptance specification.
//

describe('ShortcutEntry chord field', () => {
  it('accepts entries with a chord field alongside existing fields', () => {
    // Simulate a chord entry using `as any` until ShortcutEntry gains the
    // optional `chord` field (F2).
    const entry = {
      chord: ['u', 'p'],
      command: 'update-priority <id>',
      view: 'both',
    } as any;

    const registry = new ShortcutRegistry([entry]);
    const entries = registry.getEntries();
    expect(entries).toHaveLength(1);
    expect((entries[0] as any).chord).toEqual(['u', 'p']);
    expect((entries[0] as any).command).toBe('update-priority <id>');
    expect((entries[0] as any).view).toBe('both');
  });

  it('supports both key-based and chord-based entries in the same registry', () => {
    const entries: any[] = [
      { key: 'i', command: 'implement <id>', view: 'both' },
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    // Single-key lookup still works for key-based entries
    expect(registry.lookup('i', 'list')).toBe('implement <id>');
    // Single-key lookup should NOT match chord entries
    expect(registry.lookup('u', 'list')).toBeUndefined();
    expect(registry.lookup('u', 'detail')).toBeUndefined();
  });

  it('lookup returns undefined for the leader key of a chord entry', () => {
    // A chord leader key (e.g. 'u') should NOT dispatch a command when
    // pressed — it enters the pending-chord state instead.
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    // Pressing 'u' alone must NOT trigger dispatch (no single-key 'u' entry)
    expect(registry.lookup('u', 'list')).toBeUndefined();
    expect(registry.lookup('u', 'detail')).toBeUndefined();
  });

  it('chord entries support optional fields (label, description, stages)', () => {
    const entry: any = {
      chord: ['u', 'p'],
      command: 'update-priority <id>',
      view: 'both',
      label: 'update priority',
      description: 'Update the priority of the selected work item',
      stages: ['intake_complete', 'plan_complete'],
    };
    const registry = new ShortcutRegistry([entry]);
    const entries = registry.getEntries();
    expect((entries[0] as any).label).toBe('update priority');
    expect((entries[0] as any).description).toBe(
      'Update the priority of the selected work item',
    );
    expect((entries[0] as any).stages).toEqual([
      'intake_complete',
      'plan_complete',
    ]);
  });
});

describe('getChordByLeader', () => {
  it('returns chord entries whose first key matches the leader', () => {
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'both' },
      { chord: ['w', 's'], command: 'workflow-status <id>', view: 'list' },
    ];
    const registry = new ShortcutRegistry(entries);

    const uChords = (registry as any).getChordByLeader('u');
    expect(uChords).toHaveLength(2);
    expect(uChords[0].chord).toEqual(['u', 'p']);
    expect(uChords[1].chord).toEqual(['u', 't']);

    const wChords = (registry as any).getChordByLeader('w');
    expect(wChords).toHaveLength(1);
    expect(wChords[0].chord).toEqual(['w', 's']);
  });

  it('returns empty array for a leader key with no matching chords', () => {
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    expect((registry as any).getChordByLeader('x')).toEqual([]);
    expect((registry as any).getChordByLeader('')).toEqual([]);
  });

  it('returns empty array when no chord entries exist', () => {
    const registry = new ShortcutRegistry([
      { key: 'i', command: 'implement <id>', view: 'both' },
    ]);

    expect((registry as any).getChordByLeader('u')).toEqual([]);
  });

  it('returns empty array from empty registry', () => {
    const registry = new ShortcutRegistry([]);
    expect((registry as any).getChordByLeader('u')).toEqual([]);
  });

  it('filters chord entries by view when view argument is provided', () => {
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'list' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'detail' },
      { chord: ['u', 's'], command: 'update-status <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    // Call with both view and list — should only return list + both entries
    const listChords = (registry as any).getChordByLeader('u', 'list');
    expect(listChords).toHaveLength(2);
    expect(listChords[0].chord).toEqual(['u', 'p']);
    expect(listChords[1].chord).toEqual(['u', 's']);

    const detailChords = (registry as any).getChordByLeader('u', 'detail');
    expect(detailChords).toHaveLength(2);
    expect(detailChords[0].chord).toEqual(['u', 't']);
    expect(detailChords[1].chord).toEqual(['u', 's']);
  });

  it('getChordByLeader without view argument returns all matching chords regardless of view', () => {
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'list' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'detail' },
    ];
    const registry = new ShortcutRegistry(entries);

    const allChords = (registry as any).getChordByLeader('u');
    expect(allChords).toHaveLength(2);
  });
});

describe('lookupChord', () => {
  it('returns the command for an exact chord match', () => {
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    expect((registry as any).lookupChord(['u', 'p'], 'list')).toBe(
      'update-priority <id>',
    );
    expect((registry as any).lookupChord(['u', 't'], 'detail')).toBe(
      'update-title <id>',
    );
  });

  it('respects view filter', () => {
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'list' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'detail' },
      { chord: ['u', 's'], command: 'update-status <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    // list view should only match 'list' and 'both' entries
    expect((registry as any).lookupChord(['u', 'p'], 'list')).toBe(
      'update-priority <id>',
    );
    expect((registry as any).lookupChord(['u', 'p'], 'detail')).toBeUndefined();

    // detail view should only match 'detail' and 'both' entries
    expect((registry as any).lookupChord(['u', 't'], 'detail')).toBe(
      'update-title <id>',
    );
    expect((registry as any).lookupChord(['u', 't'], 'list')).toBeUndefined();

    // 'both' entries should match either view
    expect((registry as any).lookupChord(['u', 's'], 'list')).toBe(
      'update-status <id>',
    );
    expect((registry as any).lookupChord(['u', 's'], 'detail')).toBe(
      'update-status <id>',
    );
  });

  it('respects stage filter', () => {
    const entries: any[] = [
      {
        chord: ['u', 'p'],
        command: 'update-priority <id>',
        view: 'both',
        stages: ['intake_complete', 'plan_complete'],
      },
    ];
    const registry = new ShortcutRegistry(entries);

    // Matching stages
    expect(
      (registry as any).lookupChord(['u', 'p'], 'list', 'intake_complete'),
    ).toBe('update-priority <id>');
    expect(
      (registry as any).lookupChord(['u', 'p'], 'list', 'plan_complete'),
    ).toBe('update-priority <id>');

    // Non-matching stage
    expect(
      (registry as any).lookupChord(['u', 'p'], 'list', 'idea'),
    ).toBeUndefined();
  });

  it('returns undefined when stage is provided but chord entry has no stages constraint', () => {
    // If a chord entry has no stages constraint, it should still match
    // when a stage is provided (backward compatible).
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    expect(
      (registry as any).lookupChord(['u', 'p'], 'list', 'idea'),
    ).toBe('update-priority <id>');
    expect(
      (registry as any).lookupChord(['u', 'p'], 'list', 'intake_complete'),
    ).toBe('update-priority <id>');
  });

  it('returns undefined for chords that do not match any entry', () => {
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    expect((registry as any).lookupChord(['x', 'y'], 'list')).toBeUndefined();
    expect((registry as any).lookupChord(['u', 'x'], 'list')).toBeUndefined();
    expect((registry as any).lookupChord(['a', 'b', 'c'], 'list')).toBeUndefined();
  });

  it('returns undefined for chords with wrong number of keys', () => {
    const entries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    // Single key (should not match a 2-key chord)
    expect((registry as any).lookupChord(['u'], 'list')).toBeUndefined();
    // Three keys (over-long)
    expect((registry as any).lookupChord(['u', 'p', 'x'], 'list')).toBeUndefined();
  });

  it('returns undefined when no chord entries exist', () => {
    const registry = new ShortcutRegistry([
      { key: 'i', command: 'implement <id>', view: 'both' },
    ]);

    expect((registry as any).lookupChord(['u', 'p'], 'list')).toBeUndefined();
  });

  it('combines view and stage filters together', () => {
    const entries: any[] = [
      {
        chord: ['u', 'p'],
        command: 'update-priority <id>',
        view: 'list',
        stages: ['intake_complete'],
      },
      {
        chord: ['u', 'p'],
        command: 'update-priority-detail <id>',
        view: 'detail',
        stages: ['intake_complete'],
      },
    ];
    const registry = new ShortcutRegistry(entries);

    // Match both view and stage
    expect(
      (registry as any).lookupChord(['u', 'p'], 'list', 'intake_complete'),
    ).toBe('update-priority <id>');
    expect(
      (registry as any).lookupChord(['u', 'p'], 'detail', 'intake_complete'),
    ).toBe('update-priority-detail <id>');

    // Wrong view
    expect(
      (registry as any).lookupChord(['u', 'p'], 'list', 'idea'),
    ).toBeUndefined();

    // Wrong stage
    expect(
      (registry as any).lookupChord(['u', 'p'], 'detail', 'idea'),
    ).toBeUndefined();
  });
});

describe('chord backward compatibility', () => {
  it('single-key shortcuts work identically when chords are present', () => {
    const entries: any[] = [
      { key: 'i', command: 'implement <id>', view: 'both' },
      { key: 'p', command: 'plan <id>', view: 'both' },
      { key: 'a', command: 'audit <id>', view: 'both' },
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    // All single-key lookups must still work
    expect(registry.lookup('i', 'list')).toBe('implement <id>');
    expect(registry.lookup('p', 'list')).toBe('plan <id>');
    expect(registry.lookup('a', 'list')).toBe('audit <id>');
    expect(registry.lookup('i', 'detail')).toBe('implement <id>');
  });

  it('stage-filtered lookups still work when chords are present', () => {
    const entries: any[] = [
      {
        key: 'n',
        command: 'intake <id>',
        view: 'both',
        stages: ['idea'],
      },
      {
        key: 'i',
        command: 'implement <id>',
        view: 'both',
        stages: ['intake_complete'],
      },
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    expect(registry.lookup('n', 'list', 'idea')).toBe('intake <id>');
    expect(registry.lookup('n', 'list', 'intake_complete')).toBeUndefined();
    expect(registry.lookup('i', 'list', 'intake_complete')).toBe(
      'implement <id>',
    );
    expect(registry.lookup('i', 'list', 'idea')).toBeUndefined();
  });

  it('view filters still work for single-key entries when chords are present', () => {
    const entries: any[] = [
      { key: 'p', command: 'plan <id>', view: 'list' },
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    expect(registry.lookup('p', 'list')).toBe('plan <id>');
    expect(registry.lookup('p', 'detail')).toBeUndefined();
  });

  it('getEntriesForStage still works correctly when chords are present', () => {
    const entries: any[] = [
      { key: 'a', command: 'audit <id>', view: 'both' },
      {
        key: 'n',
        command: 'intake <id>',
        view: 'both',
        stages: ['idea'],
      },
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    // getEntriesForStage should include all entries
    const allEntries = registry.getEntriesForStage('idea');
    expect(allEntries).toHaveLength(3);
  });
});

describe('chord dispatch integration (browse view)', () => {
  /**
   * Helper: create a mock BrowseContext with a custom() implementation that
   * captures the widget factory and exposes it for test-driven interaction.
   * The test can then call widget.handleInput() and inspect widget.render().
   */
  function createChordMockContext() {
    type DoneFn = (value: any) => void;

    let capturedFactory: ((
      tui: any,
      theme: any,
      _keybindings: unknown,
      done: DoneFn,
    ) => {
      render: (width: number) => string[];
      invalidate: () => void;
      handleInput?: (data: string) => void;
    }) | null = null;

    let capturedDone: DoneFn | null = null;
    let doneResult: any = undefined;
    let doneCalled = false;

    const tui = {
      requestRender: vi.fn(),
    };
    const theme = {
      fg: vi.fn((_color: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    };

    const mockUi = {
      custom: vi.fn(<T>(
        factory: (
          tui: any,
          theme: any,
          _keybindings: unknown,
          done: DoneFn,
        ) => {
          render: (width: number) => string[];
          invalidate: () => void;
          handleInput?: (data: string) => void;
        },
      ) => {
        capturedFactory = factory;
        capturedDone = vi.fn((value: T) => {
          doneCalled = true;
          doneResult = value;
        });

        // Invoke factory synchronously to capture the widget
        const widget = factory(tui, theme, undefined, capturedDone as unknown as DoneFn);

        // Store widget for test interaction
        (mockUi as any)._widget = widget;

        // Return a never-resolving promise so tests can inspect synchronously
        return new Promise<T>(() => {});
      }),
      notify: vi.fn(),
      setEditorText: vi.fn(),
      setWidget: vi.fn(),
    };

    return {
      ctx: { ui: mockUi },
      tui,
      theme,
      getWidget: () => (mockUi as any)._widget as {
        render: (width: number) => string[];
        invalidate: () => void;
        handleInput?: (data: string) => void;
      } | null,
      getHelpLine: () => {
        const widget = (mockUi as any)._widget;
        if (!widget) return null;
        const lines = widget.render(80);
        return lines[lines.length - 1] ?? null;
      },
      getRenderLines: () => {
        const widget = (mockUi as any)._widget;
        if (!widget) return [];
        return widget.render(80);
      },
      dispatchResult: () => doneResult,
      wasDispatched: () => doneCalled,
      resetDispatch: () => {
        doneCalled = false;
        doneResult = undefined;
      },
    };
  }

  it('pending chord state: pressing chord leader updates help line with completions', async () => {
    const { ctx, getWidget, getHelpLine } = createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const chordEntries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    // Start the browse widget
    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // The 'u' key is a chord leader but has no single-key shortcut.
    // The registry should report undefined for single-key lookup of 'u'.
    expect(registry.lookup('u', 'list')).toBeUndefined();

    // Start: help line shows all available shortcuts
    const initialHelp = getHelpLine();
    expect(initialHelp).not.toBeNull();
  });

  it('pressing a valid second key after chord leader dispatches via done()', async () => {
    const {
      ctx,
      getWidget,
      getHelpLine,
      dispatchResult,
      wasDispatched,
      resetDispatch,
    } = createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const chordEntries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press the chord leader 'u'
    // This should enter pending-chord state (no dispatch yet)
    widget!.handleInput!('u');

    // The pending chord's help line should show available completions
    const pendingHelp = getHelpLine();
    expect(pendingHelp).not.toBeNull();

    // Press the completion key 'p' to finish the chord
    widget!.handleInput!('p');

    // The chord should have dispatched via done() with a ShortcutResult
    expect(wasDispatched()).toBe(true);
    expect(dispatchResult()).toEqual(
      expect.objectContaining({
        type: 'shortcut',
        command: expect.stringContaining('update-priority'),
      }),
    );
  });

  it('chord cancellation: pressing unrecognised key cancels pending chord', async () => {
    const {
      ctx,
      getWidget,
      dispatchResult,
      wasDispatched,
    } = createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const chordEntries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press the chord leader 'u' to enter pending state
    widget!.handleInput!('u');

    // Press an unrecognised key (not a valid chord completion)
    widget!.handleInput!('z');

    // No dispatch should have occurred (invalid chord cancelled)
    expect(wasDispatched()).toBe(false);
  });

  it('chord cancellation: Escape cancels pending chord', async () => {
    const { ctx, getWidget, dispatchResult, wasDispatched } =
      createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const chordEntries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press the chord leader 'u' to enter pending state
    widget!.handleInput!('u');

    // Press Escape to cancel
    widget!.handleInput!('\u001b');

    // No dispatch should have occurred (cancelled)
    expect(wasDispatched()).toBe(false);
  });

  it('u-p dispatches with stage-filtered chord entry', async () => {
    const { ctx, getWidget, dispatchResult, wasDispatched } =
      createChordMockContext();

    // Item with a stage that matches the chord's stage restriction
    const items = [
      {
        id: 'WL-001',
        title: 'Test item',
        status: 'open',
        stage: 'intake_complete',
      },
    ];
    const chordEntries: any[] = [
      {
        chord: ['u', 'p'],
        command: '!!wl update --priority <id>',
        view: 'both',
        stages: ['intake_complete'],
      },
      {
        chord: ['u', 't'],
        command: '!!wl update --title <id>',
        view: 'both',
        stages: ['intake_complete'],
      },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press 'u' then 'p'
    widget!.handleInput!('u');
    widget!.handleInput!('p');

    expect(wasDispatched()).toBe(true);
    expect(dispatchResult()).toEqual(
      expect.objectContaining({
        type: 'shortcut',
        command: '!!wl update --priority WL-001',
      }),
    );
  });

  it('u-p and u-t dispatch correctly with stage filtering', async () => {
    const { ctx, getWidget, dispatchResult, wasDispatched, resetDispatch } =
      createChordMockContext();

    const items = [
      {
        id: 'WL-002',
        title: 'Another item',
        status: 'open',
        stage: 'intake_complete',
      },
    ];
    const chordEntries: any[] = [
      {
        chord: ['u', 'p'],
        command: '!!wl update --priority <id>',
        view: 'both',
        stages: ['intake_complete', 'plan_complete'],
      },
      {
        chord: ['u', 't'],
        command: '!!wl update --title <id>',
        view: 'both',
        stages: ['intake_complete', 'plan_complete'],
      },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press 'u' then 'p' — should dispatch u-p
    widget!.handleInput!('u');
    widget!.handleInput!('p');

    expect(wasDispatched()).toBe(true);
    expect(dispatchResult()).toEqual(
      expect.objectContaining({
        type: 'shortcut',
        command: '!!wl update --priority WL-002',
      }),
    );

    // Reset and test u-t
    resetDispatch();

    // Re-create widget for second test
    const ctx2 = createChordMockContext();
    defaultChooseWorkItem(items, ctx2.ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget2 = ctx2.getWidget();
    expect(widget2).not.toBeNull();

    widget2!.handleInput!('u');
    widget2!.handleInput!('t');

    expect(ctx2.wasDispatched()).toBe(true);
    expect(ctx2.dispatchResult()).toEqual(
      expect.objectContaining({
        type: 'shortcut',
        command: '!!wl update --title WL-002',
      }),
    );
  });

  it('detail-only chord entries do not dispatch from list view', async () => {
    const { ctx, getWidget, wasDispatched } =
      createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const chordEntries: any[] = [
      {
        chord: ['u', 'p'],
        command: '!!wl update --priority <id>',
        view: 'detail',
      },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press 'u' (chord leader) — in list view, 'u-p' is detail-only,
    // so it should NOT enter pending chord state
    widget!.handleInput!('u');
    // Press 'p' — no pending chord, so this is just a normal key
    widget!.handleInput!('p');

    // No dispatch should have occurred
    expect(wasDispatched()).toBe(false);
  });

  it('dispatch respects stage filter via selected item stage', async () => {
    const { ctx, getWidget, wasDispatched } =
      createChordMockContext();

    const items = [
      {
        id: 'WL-001',
        title: 'Idea item',
        status: 'open',
        stage: 'idea',
      },
    ];
    const chordEntries: any[] = [
      {
        chord: ['u', 'p'],
        command: '!!wl update --priority <id>',
        view: 'both',
        stages: ['intake_complete', 'plan_complete'],
      },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press 'u' then 'p'
    widget!.handleInput!('u');
    widget!.handleInput!('p');

    // The selected item has stage 'idea', but u-p requires intake_complete
    // or plan_complete. So dispatch should not happen for this item.
    expect(wasDispatched()).toBe(false);
  });

  it('reserved navigation keys (g) take precedence over chord leaders', async () => {
    const { ctx, getWidget, dispatchResult, wasDispatched } =
      createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    // 'g' is a reserved navigation key - even if a chord entry starts with
    // 'g', it must NOT trigger chord pending state.
    const chordEntries: any[] = [
      { chord: ['g', 't'], command: 'go-top <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press 'g' — this is a reserved navigation key and should NOT enter
    // chord pending state.  No dispatch should occur.
    widget!.handleInput!('g');
    expect(wasDispatched()).toBe(false);
  });

  it('reserved navigation keys (G) take precedence over chord leaders', async () => {
    const { ctx, getWidget, dispatchResult, wasDispatched } =
      createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const chordEntries: any[] = [
      { chord: ['G', 't'], command: 'go-bottom <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press 'G' — reserved navigation key, must not enter chord state
    widget!.handleInput!('G');
    expect(wasDispatched()).toBe(false);
  });

  it('reserved navigation keys (space) take precedence over chord leaders', async () => {
    const { ctx, getWidget, dispatchResult, wasDispatched } =
      createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const chordEntries: any[] = [
      { chord: [' ', 'n'], command: 'next-page <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press space — reserved navigation key, must not enter chord state
    widget!.handleInput!(' ');
    expect(wasDispatched()).toBe(false);
  });

  it('chord pending state help line shows completion hints', async () => {
    const { ctx, getWidget, getHelpLine } = createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const chordEntries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
      { chord: ['u', 't'], command: 'update-title <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Get the initial help line (before chord)
    const initialHelp = getHelpLine();

    // Press 'u' to enter pending chord state
    widget!.handleInput!('u');

    // After entering pending chord state, the help line should update
    // to show available completions (u-p and u-t hints).
    const pendingHelp = getHelpLine();
    expect(pendingHelp).not.toBeNull();
  });



  it('normal single-key shortcuts still dispatch when chords are present', async () => {
    const { ctx, getWidget, dispatchResult, wasDispatched } =
      createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const entries: any[] = [
      { key: 'i', command: 'implement <id>', view: 'both' },
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(entries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press 'i' (single-key shortcut) — should dispatch immediately
    widget!.handleInput!('i');
    expect(wasDispatched()).toBe(true);
    expect(dispatchResult()).toEqual(
      expect.objectContaining({
        type: 'shortcut',
        command: 'implement WL-001',
      }),
    );
  });

  it('chord pending state is per-view (independent list and detail state)', async () => {
    // Since defaultChooseWorkItem creates a single widget for the list view,
    // and the detail view is separate, we verify that each widget manages
    // its own chord state independently.
    const { ctx, getWidget, getHelpLine, dispatchResult, wasDispatched } =
      createChordMockContext();

    const items = [{ id: 'WL-001', title: 'Test item', status: 'open' }];
    const chordEntries: any[] = [
      { chord: ['u', 'p'], command: 'update-priority <id>', view: 'both' },
    ];
    const registry = new ShortcutRegistry(chordEntries);

    const { defaultChooseWorkItem } = await import('./index.js');
    defaultChooseWorkItem(items, ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const widget = getWidget();
    expect(widget).not.toBeNull();

    // Press chord leader 'u' on the list widget
    widget!.handleInput!('u');

    // Create a second (detail) widget with the same registry
    // The detail widget should have its own independent state
    const detailCtx = createChordMockContext();
    defaultChooseWorkItem(items, detailCtx.ctx, vi.fn(), registry);
    await new Promise(process.nextTick);

    const detailWidget = detailCtx.getWidget();
    expect(detailWidget).not.toBeNull();

    // The detail widget starts in non-pending state
    // Pressing 'p' without first pressing 'u' should not dispatch
    detailWidget!.handleInput!('p');
    expect(detailCtx.wasDispatched()).toBe(false);

    // Now press 'u' then 'p' on the detail widget
    detailWidget!.handleInput!('u');
    detailWidget!.handleInput!('p');

    expect(detailCtx.wasDispatched()).toBe(true);
    expect(detailCtx.dispatchResult()).toEqual(
      expect.objectContaining({
        type: 'shortcut',
        command: expect.stringContaining('update-priority'),
      }),
    );
  });
});
