/**
 * Unit tests for shortcut-config.ts - config loader, registry, and dispatch.
 *
 * Run: npx vitest run packages/tui/extensions/shortcut-config.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    const planEntry = entries.find(e => e.key === 'p');
    expect(planEntry).toBeDefined();
    expect(planEntry!.command).toBe('/plan <id>');
    expect(planEntry!.view).toBe('both');

    const intakeEntry = entries.find(e => e.key === 'n');
    expect(intakeEntry).toBeDefined();
    expect(intakeEntry!.command).toBe('/intake <id>');
    expect(intakeEntry!.view).toBe('both');

    const auditEntry = entries.find(e => e.key === 'a');
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.command).toBe('/skill:audit <id>');
    expect(auditEntry!.view).toBe('both');
  });

  it('lookup resolves shortcuts loaded from file', () => {
    const registry = loadShortcutConfig();
    expect(registry.lookup('i', 'list')).toBe('/skill:implement <id>');
    expect(registry.lookup('i', 'detail')).toBe('/skill:implement <id>');
    expect(registry.lookup('p', 'list')).toBe('/plan <id>');
    expect(registry.lookup('n', 'detail')).toBe('/intake <id>');
    expect(registry.lookup('a', 'list')).toBe('/skill:audit <id>');
    expect(registry.lookup('a', 'detail')).toBe('/skill:audit <id>');
  });

  it('returns empty registry for unregistered key', () => {
    const registry = loadShortcutConfig();
    expect(registry.lookup('x', 'list')).toBeUndefined();
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
