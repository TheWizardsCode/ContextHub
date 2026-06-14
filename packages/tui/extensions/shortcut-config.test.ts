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
    expect(implementEntry!.stages).toEqual(['intake_complete']);
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
    expect(intakeEntry!.description).toBe('Create a new work item from the selected item via intake');

    const auditEntry = entries.find(e => e.key === 'a');
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.command).toBe('/skill:audit <id>');
    expect(auditEntry!.view).toBe('both');
    expect(auditEntry!.stages).toBeUndefined();
    expect(auditEntry!.label).toBe('audit');
    expect(auditEntry!.description).toBe('Run an audit on the selected work item');
  });

  it('lookup resolves shortcuts loaded from file with stage parameter', () => {
    const registry = loadShortcutConfig();

    // 'i' (implement) should only work for intake_complete stage
    expect(registry.lookup('i', 'list', 'intake_complete')).toBe('/skill:implement <id>');
    expect(registry.lookup('i', 'detail', 'intake_complete')).toBe('/skill:implement <id>');
    expect(registry.lookup('i', 'list', 'idea')).toBeUndefined();
    expect(registry.lookup('i', 'list', 'in_progress')).toBeUndefined();

    // 'p' (plan) should only work for intake_complete stage
    expect(registry.lookup('p', 'list', 'intake_complete')).toBe('/plan <id>');
    expect(registry.lookup('p', 'list', 'idea')).toBeUndefined();

    // 'n' (intake) should only work for idea stage
    expect(registry.lookup('n', 'detail', 'idea')).toBe('/intake <id>');
    expect(registry.lookup('n', 'detail', 'intake_complete')).toBeUndefined();

    // 'a' (audit) has no stages constraint, works unconditionally
    expect(registry.lookup('a', 'list', 'idea')).toBe('/skill:audit <id>');
    expect(registry.lookup('a', 'detail', 'intake_complete')).toBe('/skill:audit <id>');
    expect(registry.lookup('a', 'list', 'in_progress')).toBe('/skill:audit <id>');

    // Without stage parameter, entries with stages constraint still work
    // (backward compatible when calling without stage)
    expect(registry.lookup('n', 'detail')).toBe('/intake <id>');
    expect(registry.lookup('i', 'list')).toBe('/skill:implement <id>');
    expect(registry.lookup('p', 'list')).toBe('/plan <id>');
  });

  it('returns empty registry for unregistered key', () => {
    const registry = loadShortcutConfig();
    expect(registry.lookup('x', 'list')).toBeUndefined();
  });

  it('getEntriesForStage returns correct subset from file with stage constraints', () => {
    const registry = loadShortcutConfig();

    const ideaEntries = registry.getEntriesForStage('idea');
    expect(ideaEntries.length).toBeGreaterThanOrEqual(3); // c, n, a
    expect(ideaEntries.find(e => e.key === 'c')).toBeDefined();
    expect(ideaEntries.find(e => e.key === 'n')).toBeDefined();
    expect(ideaEntries.find(e => e.key === 'a')).toBeDefined();
    expect(ideaEntries.find(e => e.key === 'i')).toBeUndefined();
    expect(ideaEntries.find(e => e.key === 'p')).toBeUndefined();

    const intakeCompleteEntries = registry.getEntriesForStage('intake_complete');
    expect(intakeCompleteEntries.find(e => e.key === 'i')).toBeDefined();
    expect(intakeCompleteEntries.find(e => e.key === 'p')).toBeDefined();
    expect(intakeCompleteEntries.find(e => e.key === 'a')).toBeDefined();
    expect(intakeCompleteEntries.find(e => e.key === 'c')).toBeUndefined();
    expect(intakeCompleteEntries.find(e => e.key === 'n')).toBeUndefined();

    const inProgressEntries = registry.getEntriesForStage('in_progress');
    expect(inProgressEntries).toHaveLength(1);
    expect(inProgressEntries[0].key).toBe('a');
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
