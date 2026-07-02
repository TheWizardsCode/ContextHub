/**
 * Unit tests for editor-shortcuts.ts — Shortcut mode manager and current item tracker.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/editor-shortcuts.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ShortcutModeManager,
  CurrentItemTracker,
  SHORTCUT_MODE_STATUS_KEY,
} from './editor-shortcuts.js';
import { ShortcutRegistry } from './shortcut-config.js';
import type { ShortcutEntry } from './shortcut-config.js';

// ── Mocks ─────────────────────────────────────────────────────────────

/**
 * Mock _matchesKey so we can simulate key matching in tests.
 * Returns a function that matches 'ctrl+shift+w' against a known sentinel.
 * Uses vi.hoisted() so the variable is available in the vi.mock() factory.
 */
const mockMatchesKey = vi.hoisted(() => vi.fn((data: string, keyId: string): boolean => {
  if (keyId === 'ctrl+shift+w') {
    return data === '\x17'; // Ctrl+W byte
  }
  if (keyId === 'escape') {
    return data === '\x1b' || data === 'escape';
  }
  return false;
}));

// Mock the shortcuts module so we control _matchesKey and isEscapeKey
vi.mock('./lib/shortcuts.js', () => ({
  _matchesKey: mockMatchesKey,
  isEscapeKey: (data: string): boolean => {
    return data === '\x1b' || data === 'escape';
  },
  RESERVED_NAVIGATION_KEYS: new Set(['g', 'G', ' ']),
  // Provide non-mocked versions of other helpers to avoid import errors
  isUpKey: () => false,
  isDownKey: () => false,
  isPageUpKey: () => false,
  isPageDownKey: () => false,
  isEnterKey: () => false,
}));

// ── Helpers ──────────────────────────────────────────────────────────

function createMockRegistry(entries?: ShortcutEntry[]): ShortcutRegistry {
  const defaultEntries: ShortcutEntry[] = entries ?? [
    { key: 'i', command: '/skill:implement <id>', view: 'both', label: 'implement', stages: ['intake_complete', 'plan_complete', 'in_progress'] },
    { key: 'a', command: '/skill:audit <id>', view: 'both', label: 'audit', stages: ['in_progress', 'in_review'] },
    { key: 'p', command: '/plan <id>', view: 'both', label: 'plan', stages: ['intake_complete'] },
    { key: 'n', command: '/intake <id>', view: 'both', label: 'intake', stages: ['idea'] },
    { key: 'c', command: '/intake\n<desc>\nPriority: medium', view: 'both', label: 'create new' },
    { key: 's', command: '!!wl search ', view: 'both', label: 'Search' },
  ];

  return new ShortcutRegistry(entries ?? defaultEntries);
}

function createUiMock() {
  return {
    setEditorText: vi.fn(),
    setStatus: vi.fn(),
  };
}

// ── CurrentItemTracker ────────────────────────────────────────────────

describe('CurrentItemTracker', () => {
  let tracker: CurrentItemTracker;

  beforeEach(() => {
    tracker = new CurrentItemTracker();
  });

  it('starts with no current ID', () => {
    expect(tracker.getCurrentId()).toBeNull();
  });

  it('returns the ID after setCurrentId', () => {
    tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
    expect(tracker.getCurrentId()).toBe('WL-0MQL0T5TR0060AEH');
  });

  it('overwrites the previous ID on subsequent calls', () => {
    tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
    tracker.setCurrentId('WL-0MQTHL7ER0012JK1');
    expect(tracker.getCurrentId()).toBe('WL-0MQTHL7ER0012JK1');
  });

  it('clears the ID on clear()', () => {
    tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
    tracker.clear();
    expect(tracker.getCurrentId()).toBeNull();
  });

  it('allows setCurrentId(null) to clear', () => {
    tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
    tracker.setCurrentId(null);
    expect(tracker.getCurrentId()).toBeNull();
  });
});

// ── ShortcutModeManager ───────────────────────────────────────────────

describe('ShortcutModeManager', () => {
  let registry: ShortcutRegistry;
  let ui: ReturnType<typeof createUiMock>;
  let tracker: CurrentItemTracker;

  beforeEach(() => {
    registry = createMockRegistry();
    ui = createUiMock();
    tracker = new CurrentItemTracker();
  });

  function createManager(options?: { leaderKey?: string }): ShortcutModeManager {
    const manager = new ShortcutModeManager(
      () => tracker.getCurrentId(),
      () => registry,
      options,
    );
    manager.init(ui);
    return manager;
  }

  describe('initial state', () => {
    it('starts inactive', () => {
      const manager = createManager();
      expect(manager.getState()).toBe('inactive');
      expect(manager.isActive()).toBe(false);
    });

    it('does not show indicator initially', () => {
      createManager();
      expect(ui.setStatus).not.toHaveBeenCalled();
    });
  });

  describe('leader key activation', () => {
    it('activates shortcut mode when leader key pressed and current ID is set', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      const result = manager.handleInput('\x17'); // Ctrl+Shift+W

      expect(result).toEqual({ consume: true });
      expect(manager.getState()).toBe('active');
      expect(manager.isActive()).toBe(true);
      expect(ui.setStatus).toHaveBeenCalledWith(SHORTCUT_MODE_STATUS_KEY, '🔧 WL');
    });

    it('does NOT activate when no current ID is set', () => {
      const manager = createManager();
      expect(tracker.getCurrentId()).toBeNull();

      const result = manager.handleInput('\x17');

      expect(result).toBeUndefined();
      expect(manager.getState()).toBe('inactive');
      expect(manager.isActive()).toBe(false);
    });

    it('does nothing with leader key when _matchesKey returns false', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      // A byte that doesn't match the leader key
      const result = manager.handleInput('x');

      expect(result).toBeUndefined();
      expect(manager.getState()).toBe('inactive');
    });
  });

  describe('leader key toggle off', () => {
    it('deactivates shortcut mode when leader key pressed again', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      expect(manager.getState()).toBe('active');

      const result = manager.handleInput('\x17'); // deactivate

      expect(result).toEqual({ consume: true });
      expect(manager.getState()).toBe('inactive');
      expect(manager.isActive()).toBe(false);
      expect(ui.setStatus).toHaveBeenLastCalledWith(SHORTCUT_MODE_STATUS_KEY, undefined);
    });
  });

  describe('Escape exits shortcut mode', () => {
    it('exits shortcut mode on Escape', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      expect(manager.getState()).toBe('active');

      const result = manager.handleInput('\x1b'); // Escape

      expect(result).toEqual({ consume: true });
      expect(manager.getState()).toBe('inactive');
      expect(manager.isActive()).toBe(false);
      expect(ui.setStatus).toHaveBeenLastCalledWith(SHORTCUT_MODE_STATUS_KEY, undefined);
    });

    it('exits chord-pending state on Escape', () => {
      const chordEntries: ShortcutEntry[] = [
        { key: '', command: '!!wl update <id> --priority ', view: 'both', label: 'update priority', chord: ['u', 'p'] },
      ];
      registry = createMockRegistry(chordEntries);
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate

      // Press a chord leader (e.g., 'u')
      manager.handleInput('u'); // Should transition to chord_pending
      expect(manager.getState()).toBe('chord_pending');

      const result = manager.handleInput('\x1b'); // Escape

      expect(result).toEqual({ consume: true });
      expect(manager.getState()).toBe('inactive');
    });
  });

  describe('single-key shortcuts', () => {
    it('dispatches a matched single-key shortcut with ID substitution', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate

      const result = manager.handleInput('i'); // implement

      expect(result).toEqual({ consume: true });
      expect(ui.setEditorText).toHaveBeenCalledWith('/skill:implement WL-0MQL0T5TR0060AEH');
      expect(manager.getState()).toBe('inactive'); // exits after dispatch
    });

    it('exits shortcut mode if current ID becomes null between activation and dispatch', () => {
      const manager = createManager();

      // Activate with an ID, then clear it
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      manager.handleInput('\x17'); // activate
      tracker.clear();

      const result = manager.handleInput('i');

      // Should exit shortcut mode without dispatching
      expect(result).toBeUndefined();
      expect(manager.getState()).toBe('inactive');
      expect(ui.setEditorText).not.toHaveBeenCalled();
    });

    it('dispatches audit shortcut', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      manager.handleInput('a');

      expect(ui.setEditorText).toHaveBeenCalledWith('/skill:audit WL-0MQL0T5TR0060AEH');
    });

    it('dispatches plan shortcut', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      manager.handleInput('p');

      expect(ui.setEditorText).toHaveBeenCalledWith('/plan WL-0MQL0T5TR0060AEH');
    });

    it('dispatches intake shortcut', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      manager.handleInput('n');

      expect(ui.setEditorText).toHaveBeenCalledWith('/intake WL-0MQL0T5TR0060AEH');
    });
  });

  describe('chord shortcuts', () => {
    it('transitions to chord_pending state on chord leader key', () => {
      const entries: ShortcutEntry[] = [
        { key: '', command: '!!wl update <id> --priority ', view: 'both', label: 'update priority', chord: ['u', 'p'] },
        { key: '', command: '!!wl close <id>', view: 'both', label: 'close done', chord: ['x', 'c'] },
        { key: 'i', command: '/skill:implement <id>', view: 'both', label: 'implement' },
      ];
      registry = createMockRegistry(entries);
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate

      const result = manager.handleInput('u'); // chord leader

      expect(result).toEqual({ consume: true });
      expect(manager.getState()).toBe('chord_pending');
    });

    it('dispatches a completed chord shortcut', () => {
      const entries: ShortcutEntry[] = [
        { key: '', command: '!!wl update <id> --priority ', view: 'both', label: 'update priority', chord: ['u', 'p'] },
        { key: '', command: '!!wl close <id>', view: 'both', label: 'close done', chord: ['x', 'c'] },
      ];
      registry = createMockRegistry(entries);
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      manager.handleInput('u');   // chord leader
      const result = manager.handleInput('p'); // complete chord

      expect(result).toEqual({ consume: true });
      expect(ui.setEditorText).toHaveBeenCalledWith('!!wl update WL-0MQL0T5TR0060AEH --priority ');
      expect(manager.getState()).toBe('inactive');
    });

    it('dispatches close chord shortcut', () => {
      const entries: ShortcutEntry[] = [
        { key: '', command: '!!wl close <id>', view: 'both', label: 'close done', chord: ['x', 'c'] },
      ];
      registry = createMockRegistry(entries);
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      manager.handleInput('x');   // chord leader
      manager.handleInput('c');   // complete chord

      expect(ui.setEditorText).toHaveBeenCalledWith('!!wl close WL-0MQL0T5TR0060AEH');
    });
  });

  describe('reserved navigation keys', () => {
    it('passes through g (reserved key) without consuming', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate

      const result = manager.handleInput('g'); // reserved

      expect(result).toBeUndefined(); // pass through
      expect(manager.getState()).toBe('inactive'); // exits shortcut mode
    });

    it('passes through G (reserved key) without consuming', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate

      const result = manager.handleInput('G');

      expect(result).toBeUndefined();
      expect(manager.getState()).toBe('inactive');
    });

    it('passes through space (reserved key) without consuming', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate

      const result = manager.handleInput(' ');

      expect(result).toBeUndefined();
      expect(manager.getState()).toBe('inactive');
    });
  });

  describe('unknown keys', () => {
    it('passes through an unmatched single key and exits shortcut mode', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate

      const result = manager.handleInput('z'); // no shortcut for 'z'

      expect(result).toBeUndefined();
      expect(manager.getState()).toBe('inactive');
    });
  });

  describe('multi-character data', () => {
    it('passes through multi-character data (like arrow key sequences)', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate

      // Simulate an arrow key escape sequence (multi-byte)
      const result = manager.handleInput('\x1b[A');

      expect(result).toBeUndefined();
      expect(manager.getState()).toBe('inactive');
    });
  });

  describe('footer indicator', () => {
    it('sets indicator on activation', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate

      expect(ui.setStatus).toHaveBeenCalledWith(SHORTCUT_MODE_STATUS_KEY, '🔧 WL');
    });

    it('clears indicator on deactivation via leader key', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      manager.handleInput('\x17'); // deactivate

      expect(ui.setStatus).toHaveBeenLastCalledWith(SHORTCUT_MODE_STATUS_KEY, undefined);
    });

    it('clears indicator on Escape', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      manager.handleInput('\x1b'); // Escape

      expect(ui.setStatus).toHaveBeenLastCalledWith(SHORTCUT_MODE_STATUS_KEY, undefined);
    });

    it('shows chord hint when chord is pending', () => {
      const entries: ShortcutEntry[] = [
        { key: '', command: '!!wl update <id> --priority ', view: 'both', label: 'update priority', chord: ['u', 'p'] },
      ];
      registry = createMockRegistry(entries);
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      manager.handleInput('u');   // chord leader

      expect(ui.setStatus).toHaveBeenCalledWith(SHORTCUT_MODE_STATUS_KEY, '🔧 WL u…');
    });
  });

  describe('init() and edge cases', () => {
    it('works without setEditorText', () => {
      const manager = createManager();
      // re-init with no setEditorText
      manager.init({ setStatus: vi.fn() });

      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      manager.handleInput('\x17'); // activate

      // Should not throw when dispatching
      expect(() => manager.handleInput('i')).not.toThrow();
    });

    it('works without setStatus', () => {
      const manager = createManager();
      manager.init({ setEditorText: vi.fn() });

      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      manager.handleInput('\x17'); // activate

      expect(manager.getState()).toBe('active');
    });

    it('reset() returns to inactive state', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager();

      manager.handleInput('\x17'); // activate
      expect(manager.isActive()).toBe(true);

      manager.reset();
      expect(manager.getState()).toBe('inactive');
      expect(manager.isActive()).toBe(false);
    });
  });

  describe('custom leader key', () => {
    it('supports a custom leader key via constructor options', () => {
      tracker.setCurrentId('WL-0MQL0T5TR0060AEH');
      const manager = createManager({ leaderKey: 'ctrl+shift+a' });

      // Our mock matches 'ctrl+shift+w', not 'ctrl+shift+a', so '\x17' should NOT activate
      const result = manager.handleInput('\x17');

      expect(result).toBeUndefined();
      expect(manager.getState()).toBe('inactive');
    });
  });
});
