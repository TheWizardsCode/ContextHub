/**
 * Unit tests for lib/browse.ts — browse UI logic (formatting, widgets,
 * keyboard navigation, selection overlay).
 *
 * Run: npx vitest run packages/tui/extensions/lib/browse.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
  getSettingsListTheme: () => ({}),
}));

describe('lib/browse exports', () => {
  it('should export the expected types and functions', async () => {
    const mod = await import('./browse.js');
    // Types are imported from ./tools.js and re-exported; not runtime-accessible
    // Check that runtime exports are present

    // Constants
    expect(mod.RESERVED_NAVIGATION_KEYS).toBeDefined();
    expect(mod.RESERVED_NAVIGATION_KEYS instanceof Set).toBe(true);

    // Functions
    expect(typeof mod.truncateToWidth).toBe('function');
    expect(typeof mod.getIconPrefix).toBe('function');
    expect(typeof mod.formatBrowseOption).toBe('function');
    expect(typeof mod.buildSelectionWidget).toBe('function');
    expect(typeof mod.defaultChooseWorkItem).toBe('function');
    expect(typeof mod.createScrollableWidget).toBe('function');

    // Keyboard helpers
    expect(typeof mod.isUpKey).toBe('function');
    expect(typeof mod.isDownKey).toBe('function');
    expect(typeof mod.isPageUpKey).toBe('function');
    expect(typeof mod.isPageDownKey).toBe('function');
    expect(typeof mod.isEnterKey).toBe('function');
    expect(typeof mod.isCtrlEnterKey).toBe('function');
    expect(typeof mod.isEscapeKey).toBe('function');
  });
});

describe('truncateToWidth', () => {
  it('should truncate text with ellipsis', async () => {
    const { truncateToWidth } = await import('./browse.js');
    const result = truncateToWidth('Hello World', 5);
    expect(result).toBe('Hell…');
  });

  it('should return full text if within width', async () => {
    const { truncateToWidth } = await import('./browse.js');
    const result = truncateToWidth('Hi', 10);
    expect(result).toBe('Hi');
  });

  it('should use custom ellipsis', async () => {
    const { truncateToWidth } = await import('./browse.js');
    const result = truncateToWidth('Hello World', 5, '...');
    expect(result).toBe('He...');
  });
});

describe('RESERVED_NAVIGATION_KEYS', () => {
  it('should contain g, G, and space', async () => {
    const { RESERVED_NAVIGATION_KEYS } = await import('./browse.js');
    expect(RESERVED_NAVIGATION_KEYS.has('g')).toBe(true);
    expect(RESERVED_NAVIGATION_KEYS.has('G')).toBe(true);
    expect(RESERVED_NAVIGATION_KEYS.has(' ')).toBe(true);
    expect(RESERVED_NAVIGATION_KEYS.has('i')).toBe(false);
  });
});

describe('createScrollableWidget', () => {
  it('should return an object with render, invalidate, handleInput', async () => {
    const { createScrollableWidget } = await import('./browse.js');
    const widget = createScrollableWidget(['line 1', 'line 2']);
    expect(typeof widget).toBe('function');
    // Call the factory with mock tui and theme
    const instance = widget({}, {});
    expect(typeof instance.render).toBe('function');
    expect(typeof instance.invalidate).toBe('function');
    expect(typeof instance.handleInput).toBe('function');
  });

  it('should render provided lines', async () => {
    const { createScrollableWidget } = await import('./browse.js');
    const widget = createScrollableWidget(['line 1', 'line 2']);
    const instance = widget({}, {});
    const rendered = instance.render(100);
    expect(rendered).toContain('line 1');
    expect(rendered).toContain('line 2');
  });
});

describe('formatChordHints', () => {
  it('should be exported from browse module', async () => {
    const { formatChordHints } = await import('./browse.js');
    expect(typeof formatChordHints).toBe('function');
  });

  it('should return empty string for empty chords array', async () => {
    const { formatChordHints } = await import('./browse.js');
    expect(formatChordHints([], ['u'])).toBe('');
  });

  it('should collapse multiple chords sharing the same nextKey at intermediate level', async () => {
    const { formatChordHints } = await import('./browse.js');
    // Simulate four u-p-* chords at the 'u' layer (pendingChord = ['u'])
    // All four share nextKey='p', should collapse to 'p:priority...'
    const chords: any[] = [
      { key: '', command: '!!wl update <id> --priority low', view: 'both', chord: ['u', 'p', 'l'], label: 'update priority low' },
      { key: '', command: '!!wl update <id> --priority medium', view: 'both', chord: ['u', 'p', 'm'], label: 'update priority medium' },
      { key: '', command: '!!wl update <id> --priority high', view: 'both', chord: ['u', 'p', 'h'], label: 'update priority high' },
      { key: '', command: '!!wl update <id> --priority critical', view: 'both', chord: ['u', 'p', 'c'], label: 'update priority critical' },
    ];
    const result = formatChordHints(chords, ['u']);
    expect(result).toBe('p:priority...');
  });

  it('should strip correct number of words at deeper chord level (pendingChord.length >= 2)', async () => {
    const { formatChordHints } = await import('./browse.js');
    // At the 'u-p' layer (pendingChord = ['u', 'p']), each u-p-* has unique nextKey
    // Should strip 2 words from each label
    const chords: any[] = [
      { key: '', command: '!!wl update <id> --priority low', view: 'both', chord: ['u', 'p', 'l'], label: 'update priority low' },
      { key: '', command: '!!wl update <id> --priority medium', view: 'both', chord: ['u', 'p', 'm'], label: 'update priority medium' },
      { key: '', command: '!!wl update <id> --priority high', view: 'both', chord: ['u', 'p', 'h'], label: 'update priority high' },
      { key: '', command: '!!wl update <id> --priority critical', view: 'both', chord: ['u', 'p', 'c'], label: 'update priority critical' },
    ];
    const result = formatChordHints(chords, ['u', 'p']);
    expect(result).toBe('l:low m:medium h:high c:critical');
  });

  it('should handle non-standard labels with fewer words gracefully', async () => {
    const { formatChordHints } = await import('./browse.js');
    // x-c has label 'close done' (2 words), chord ['x', 'c']
    // x-d has label 'close deleted' (2 words), chord ['x', 'd']
    // At 'x' layer (pendingChord.length = 1), strip 1 word
    const chords: any[] = [
      { key: '', command: '!!wl close <id>', view: 'both', chord: ['x', 'c'], label: 'close done' },
      { key: '', command: '!!wl delete <id>', view: 'both', chord: ['x', 'd'], label: 'close deleted' },
    ];
    const result = formatChordHints(chords, ['x']);
    // Each has unique nextKey, so no collapsing — full rest shown
    expect(result).toBe('c:done d:deleted');
  });

  it('should filter out commands with <id> when isEmpty option is true', async () => {
    const { formatChordHints } = await import('./browse.js');
    const chords: any[] = [
      { key: '', command: '!!wl close <id>', view: 'both', chord: ['x', 'c'], label: 'close done' },
    ];
    // With empty items, chords referencing <id> should be filtered out
    const result = formatChordHints(chords, ['x'], { isEmpty: true });
    expect(result).toBe('');
  });

  it('should still show chords when isEmpty is false even if they have <id>', async () => {
    const { formatChordHints } = await import('./browse.js');
    const chords: any[] = [
      { key: '', command: '!!wl close <id>', view: 'both', chord: ['x', 'c'], label: 'close done' },
    ];
    const result = formatChordHints(chords, ['x'], { isEmpty: false });
    expect(result).toBe('c:done');
  });

  it('should have safety check when label has fewer words than chord depth', async () => {
    const { formatChordHints } = await import('./browse.js');
    // Label has only 1 word but chord depth is 3
    // Should fall back safely and show the full label
    const chords: any[] = [
      { key: '', command: '!!wl update <id> --priority low', view: 'both', chord: ['u', 'p', 'l'], label: 'low' },
    ];
    const result = formatChordHints(chords, ['u', 'p']);
    // Safety: should show the full label since stripping would produce empty
    expect(result).toBe('l:low');
  });

  it('should handle mixed groups with both single and multiple entries per nextKey', async () => {
    const { formatChordHints } = await import('./browse.js');
    // u-p has 4 entries (all share p), u-s has 1 entry (unique s), u-t has 1 entry (unique t)
    const chords: any[] = [
      { key: '', command: '!!wl update <id> --priority low', view: 'both', chord: ['u', 'p', 'l'], label: 'update priority low' },
      { key: '', command: '!!wl update <id> --priority medium', view: 'both', chord: ['u', 'p', 'm'], label: 'update priority medium' },
      { key: '', command: '!!wl update <id> --priority high', view: 'both', chord: ['u', 'p', 'h'], label: 'update priority high' },
      { key: '', command: '!!wl update <id> --priority critical', view: 'both', chord: ['u', 'p', 'c'], label: 'update priority critical' },
      { key: '', command: '!!wl update <id> --status', view: 'both', chord: ['u', 's'], label: 'update stage/status' },
      { key: '', command: '!!wl update <id> --title', view: 'both', chord: ['u', 't'], label: 'update title' },
    ];
    const result = formatChordHints(chords, ['u']);
    // p:priority... (collapsed), s:stage/status (single), t:title (single)
    expect(result).toContain('p:priority...');
    expect(result).toContain('s:stage/status');
    expect(result).toContain('t:title');
  });

  it('should extract label from command when no explicit label is set', async () => {
    const { formatChordHints } = await import('./browse.js');
    // No label property — should derive from command
    const chords: any[] = [
      { key: '', command: '/intake\n<desc>\nPriority: medium', view: 'both', chord: ['f', 'i'], label: undefined },
    ];
    const result = formatChordHints(chords, ['f']);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should handle non-standard labels without crashing for deep chords', async () => {
    const { formatChordHints } = await import('./browse.js');
    // Label with 2 words, chord depth 2, pendingChord.length = 1
    // Strip 1 word → 'done' for x-c, 'deleted' for x-d
    const chords: any[] = [
      { key: '', command: '!!wl close <id>', view: 'both', chord: ['x', 'c'], label: 'close done' },
      { key: '', command: '!!wl delete <id>', view: 'both', chord: ['x', 'd'], label: 'close deleted' },
    ];
    // At 'x' layer — both have unique nextKey
    const result = formatChordHints(chords, ['x']);
    expect(result).toBe('c:done d:deleted');
  });

  it('should work for a-* audit chords (a-y, a-r, a-a)', async () => {
    const { formatChordHints } = await import('./browse.js');
    const chords: any[] = [
      { key: '', command: '!!wl audit-set <id> --ready-to-close yes', view: 'both', chord: ['a', 'y'], label: 'audit approve' },
      { key: '', command: '!!wl audit-set <id> --ready-to-close no', view: 'both', chord: ['a', 'r'], label: 'audit reject' },
      { key: '', command: '/skill:audit <id>', view: 'both', chord: ['a', 'a'], label: 'audit automatic' },
    ];
    // At 'a' layer — all three share nextKey? No: y, r, a are all different
    // So no collapsing needed
    const result = formatChordHints(chords, ['a']);
    // Strip 1 word: 'approve', 'reject', 'automatic'
    expect(result).toBe('y:approve r:reject a:automatic');
  });
});
