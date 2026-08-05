/**
 * tests/herdr/form-dialog.test.ts — Tests for form dialog module
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractIdentifiers,
  KNOWN_IDENTIFIERS,
  getUnknownIdentifiers,
  FormState,
  substituteIdentifiers,
  type FormField,
  type FormResult,
} from '../../packages/herdr/src/form-dialog.js';

// ── extractIdentifiers ────────────────────────────────────────────────

describe('extractIdentifiers', () => {
  it('extracts a single identifier', () => {
    expect(extractIdentifiers('!!wl update <id> --title <title>')).toEqual([
      { name: 'id', default: '' },
      { name: 'title', default: '' },
    ]);
  });

  it('extracts multiple identifiers', () => {
    expect(extractIdentifiers('!!wl update <id> --status <status> --stage <stage>')).toEqual([
      { name: 'id', default: '' },
      { name: 'status', default: '' },
      { name: 'stage', default: '' },
    ]);
  });

  it('returns empty array for no identifiers', () => {
    expect(extractIdentifiers('!!wl search test')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractIdentifiers('')).toEqual([]);
  });

  it('extracts identifiers with underscores', () => {
    expect(extractIdentifiers('<my_var> <another_var>')).toEqual([
      { name: 'my_var', default: '' },
      { name: 'another_var', default: '' },
    ]);
  });

  it('ignores non-matching patterns (no angle brackets)', () => {
    expect(extractIdentifiers('just text here')).toEqual([]);
  });

  it('handles mixed identifiers and regular text', () => {
    expect(extractIdentifiers('/cmd <id> --opt <value> && echo done')).toEqual([
      { name: 'id', default: '' },
      { name: 'value', default: '' },
    ]);
  });

  it('deduplicates identifiers', () => {
    expect(extractIdentifiers('<id> --title <id>')).toEqual([{ name: 'id', default: '' }]);
  });

  it('treats <reason> as an identifier', () => {
    expect(extractIdentifiers("!!wl comment add <id> --body '<reason>'")).toEqual([
      { name: 'id', default: '' },
      { name: 'reason', default: '' },
    ]);
  });

  it('captures inline defaults from the template', () => {
    expect(
      extractIdentifiers("wl create <description> --priority <priority default='medium'>"),
    ).toEqual([
      { name: 'description', default: '' },
      { name: 'priority', default: 'medium' },
    ]);
  });

  it('captures double-quoted inline defaults', () => {
    expect(
      extractIdentifiers('wl update <id> --status <status default="in_progress">'),
    ).toEqual([
      { name: 'id', default: '' },
      { name: 'status', default: 'in_progress' },
    ]);
  });

  it('captures defaults containing spaces', () => {
    expect(
      extractIdentifiers('wl update <id> --title <title default="Default value.">'),
    ).toEqual([
      { name: 'id', default: '' },
      { name: 'title', default: 'Default value.' },
    ]);
  });
});

// ── KNOWN_IDENTIFIERS ─────────────────────────────────────────────────

describe('KNOWN_IDENTIFIERS', () => {
  it('contains id', () => {
    expect(KNOWN_IDENTIFIERS.has('id')).toBe(true);
  });
});

// ── getUnknownIdentifiers ─────────────────────────────────────────────

describe('getUnknownIdentifiers', () => {
  it('returns empty array for known identifiers only', () => {
    expect(getUnknownIdentifiers('!!wl update <id>')).toEqual([]);
  });

  it('returns unknown identifiers excluding known ones', () => {
    expect(getUnknownIdentifiers('!!wl update <id> --title <title>')).toEqual([
      { name: 'title', default: '' },
    ]);
  });

  it('returns multiple unknown identifiers', () => {
    expect(getUnknownIdentifiers('!!wl update <id> --status <status> --stage <stage>')).toEqual([
      { name: 'status', default: '' },
      { name: 'stage', default: '' },
    ]);
  });

  it('returns empty for no identifiers at all', () => {
    expect(getUnknownIdentifiers('!!wl search test')).toEqual([]);
  });

  it('handles all unknown (no known identifiers)', () => {
    expect(getUnknownIdentifiers('!!wl create --title <title>')).toEqual([
      { name: 'title', default: '' },
    ]);
  });

  it('keeps inline defaults on unknown identifiers', () => {
    expect(
      getUnknownIdentifiers('wl create <description> --priority <priority default="medium">'),
    ).toEqual([
      { name: 'description', default: '' },
      { name: 'priority', default: 'medium' },
    ]);
  });

  it('excludes known identifiers even when they carry a default', () => {
    expect(getUnknownIdentifiers('wl update <id default="WL-001"> --title <title>')).toEqual([
      { name: 'title', default: '' },
    ]);
  });
});

// ── substituteIdentifiers ─────────────────────────────────────────────

describe('substituteIdentifiers', () => {
  it('replaces identifiers with provided values', () => {
    const result = substituteIdentifiers('!!wl update <id> --title <title>', {
      id: 'WL-001',
      title: 'New Title',
    });
    expect(result).toBe('!!wl update WL-001 --title New Title');
  });

  it('replaces multiple occurrences of same identifier', () => {
    const result = substituteIdentifiers('<id> && echo <id>', {
      id: 'WL-001',
    });
    expect(result).toBe('WL-001 && echo WL-001');
  });

  it('leaves unknown identifiers unchanged if not in values map', () => {
    const result = substituteIdentifiers('!!wl update <id> --title <title>', {
      id: 'WL-001',
    });
    expect(result).toBe('!!wl update WL-001 --title <title>');
  });

  it('returns command unchanged when no identifiers match', () => {
    const result = substituteIdentifiers('!!wl search test', {});
    expect(result).toBe('!!wl search test');
  });

  it('uses the inline default when no explicit value is provided', () => {
    const result = substituteIdentifiers(
      'wl create <description> --priority <priority default="medium">',
      { description: 'A new item' },
    );
    expect(result).toBe('wl create A new item --priority medium');
  });

  it('gives explicit values precedence over inline defaults', () => {
    const result = substituteIdentifiers(
      'wl create <description> --priority <priority default="medium">',
      { description: 'A new item', priority: 'high' },
    );
    expect(result).toBe('wl create A new item --priority high');
  });

  it('prefers an explicit empty value over the inline default', () => {
    const result = substituteIdentifiers(
      'wl update <id> --status <status default="in_progress">',
      { id: 'WL-001', status: '' },
    );
    expect(result).toBe('wl update WL-001 --status ');
  });
});

// ── FormState ─────────────────────────────────────────────────────────

describe('FormState', () => {
  describe('constructor', () => {
    it('creates fields for each unknown identifier', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        '!!wl update <id> --title <title> --status <status>',
        'Update the title and status',
        [{ name: 'title', default: '' }, { name: 'status', default: '' }],
        onSubmit,
        onCancel,
      );
      expect(state.fields).toHaveLength(2);
      expect(state.fields[0].name).toBe('title');
      expect(state.fields[1].name).toBe('status');
      expect(state.activeFieldIndex).toBe(0);
      expect(state.description).toBe('Update the title and status');
    });

    it('uses command as fallback description when empty', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        '!!wl update <id> --title <title>',
        '',
        [{ name: 'title', default: '' }],
        onSubmit,
        onCancel,
      );
      expect(state.description).toBe('!!wl update <id> --title <title>');
    });

    it('pre-fills field values with inline defaults', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        'wl create <description> --priority <priority default="medium">',
        'Create a new work item',
        [
          { name: 'description', default: '' },
          { name: 'priority', default: 'medium' },
        ],
        onSubmit,
        onCancel,
      );
      expect(state.fields[0].value).toBe('');
      expect(state.fields[1].value).toBe('medium');
      // Submitting without edits keeps the default
      expect(state.getResult()).toBe('wl create  --priority medium');
    });
  });

  describe('handleInput - character input', () => {
    it('adds characters to active field', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        '!!wl update <id> --title <title>',
        'Update title',
        [{ name: 'title', default: '' }],
        onSubmit,
        onCancel,
      );
      state.handleInput('N');
      state.handleInput('e');
      state.handleInput('w');
      expect(state.fields[0].value).toBe('New');
    });

    it('ignores control characters in field value', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <title>', '', [{ name: 'title', default: '' }], onSubmit, onCancel);
      state.handleInput('\x01'); // Ctrl+A
      expect(state.fields[0].value).toBe('');
    });
  });

  describe('handleInput - backspace', () => {
    it('deletes last character from active field', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <title>', '', [{ name: 'title', default: '' }], onSubmit, onCancel);
      state.handleInput('A');
      state.handleInput('B');
      state.handleInput('C');
      expect(state.fields[0].value).toBe('ABC');
      state.handleInput('\x7f'); // Backspace
      expect(state.fields[0].value).toBe('AB');
    });

    it('does nothing when field is empty', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <title>', '', [{ name: 'title', default: '' }], onSubmit, onCancel);
      state.handleInput('\x7f');
      expect(state.fields[0].value).toBe('');
    });
  });

  describe('handleInput - tab navigation', () => {
    it('tab advances to next field', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <a> <b>', '', [{ name: 'a', default: '' }, { name: 'b', default: '' }], onSubmit, onCancel);
      expect(state.activeFieldIndex).toBe(0);
      state.handleInput('\t');
      expect(state.activeFieldIndex).toBe(1);
    });

    it('tab wraps around from last field to first', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <a> <b>', '', [{ name: 'a', default: '' }, { name: 'b', default: '' }], onSubmit, onCancel);
      state.activeFieldIndex = 1;
      state.handleInput('\t');
      expect(state.activeFieldIndex).toBe(0);
    });
  });

  describe('handleInput - enter submission', () => {
    it('calls onSubmit with substituted command when enter pressed', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('!!wl update <id> --title <title>', '', [{ name: 'title', default: '' }], onSubmit, onCancel);
      state.fields[0].value = 'My Title';
      state.handleInput('\r');
      expect(onSubmit).toHaveBeenCalledWith(
        '!!wl update <id> --title My Title'
      );
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('submits with empty field values', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('!!wl update <id> --title <title>', '', [{ name: 'title', default: '' }], onSubmit, onCancel);
      state.handleInput('\r');
      expect(onSubmit).toHaveBeenCalledWith(
        '!!wl update <id> --title '
      );
    });

    it('calls onSubmit with ID already resolved', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('!!wl update <id> --title <title> --status <status>', '', [{ name: 'title', default: '' }, { name: 'status', default: '' }], onSubmit, onCancel);
      state.fields[0].value = 'New Title';
      state.fields[1].value = 'completed';
      state.handleInput('\r');
      expect(onSubmit).toHaveBeenCalledWith(
        '!!wl update <id> --title New Title --status completed'
      );
    });
  });

  describe('handleInput - escape cancel', () => {
    it('calls onCancel when escape pressed', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <title>', '', [{ name: 'title', default: '' }], onSubmit, onCancel);
      state.handleInput('\x1b');
      expect(onCancel).toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('handleInput - arrow keys', () => {
    it('arrow up goes to previous field', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <a> <b>', '', [{ name: 'a', default: '' }, { name: 'b', default: '' }], onSubmit, onCancel);
      state.activeFieldIndex = 1;
      state.handleInput('\x1b[A');
      expect(state.activeFieldIndex).toBe(0);
    });

    it('arrow down goes to next field', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <a> <b>', '', [{ name: 'a', default: '' }, { name: 'b', default: '' }], onSubmit, onCancel);
      state.handleInput('\x1b[B');
      expect(state.activeFieldIndex).toBe(1);
    });

    it('arrow up wraps from first to last', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <a> <b> <c>', '', [{ name: 'a', default: '' }, { name: 'b', default: '' }, { name: 'c', default: '' }], onSubmit, onCancel);
      state.handleInput('\x1b[A');
      expect(state.activeFieldIndex).toBe(2);
    });

    it('arrow down wraps from last to first', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState('cmd <a> <b>', '', [{ name: 'a', default: '' }, { name: 'b', default: '' }], onSubmit, onCancel);
      state.activeFieldIndex = 1;
      state.handleInput('\x1b[B');
      expect(state.activeFieldIndex).toBe(0);
    });
  });

  describe('render', () => {
    it('returns a non-empty string', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        'cmd <title> <status>',
        'My Description',
        [{ name: 'title', default: '' }, { name: 'status', default: '' }],
        onSubmit,
        onCancel,
      );
      const output = state.render(80, 24);
      expect(typeof output).toBe('string');
      expect(output.length).toBeGreaterThan(0);
    });

    it('includes the description', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        'cmd <title>',
        'Update the title of the work item',
        [{ name: 'title', default: '' }],
        onSubmit,
        onCancel,
      );
      const output = state.render(80, 24);
      expect(output).toContain('Update the title of the work item');
    });

    it('includes field labels', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        'cmd <title> <status>',
        'Description',
        [{ name: 'title', default: '' }, { name: 'status', default: '' }],
        onSubmit,
        onCancel,
      );
      const output = state.render(80, 24);
      expect(output).toContain('title');
      expect(output).toContain('status');
    });

    it('includes submit/cancel instructions', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        'cmd <title>',
        'Description',
        [{ name: 'title', default: '' }],
        onSubmit,
        onCancel,
      );
      const output = state.render(80, 24);
      expect(output).toContain('Enter');
      expect(output).toContain('Esc');
    });

    it('does not exceed terminal height', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        'cmd <title>',
        'Description',
        [{ name: 'title', default: '' }],
        onSubmit,
        onCancel,
      );
      const rows = 24;
      const output = state.render(80, rows);
      const lines = output.split('\n');
      expect(lines.length).toBeLessThanOrEqual(rows);
    });

    it('shows active field indicator', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        'cmd <title> <status>',
        'Description',
        [{ name: 'title', default: '' }, { name: 'status', default: '' }],
        onSubmit,
        onCancel,
      );
      const output = state.render(80, 24);
      // The active field (index 0 = title) should have a visual indicator (▶)
      expect(output).toContain('▶');
    });
  });

  describe('getResult', () => {
    it('returns the substituted command', () => {
      const onSubmit = vi.fn();
      const onCancel = vi.fn();
      const state = new FormState(
        '!!wl update <id> --title <title>',
        '',
        [{ name: 'title', default: '' }],
        onSubmit,
        onCancel,
      );
      state.fields[0].value = 'My Title';
      const result = state.getResult();
      expect(result).toBe('!!wl update <id> --title My Title');
    });
  });
});
