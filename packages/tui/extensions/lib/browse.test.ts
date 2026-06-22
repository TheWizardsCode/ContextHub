/**
 * Unit tests for lib/browse.ts — browse UI logic (formatting, widgets,
 * keyboard navigation, selection overlay).
 *
 * Run: npx vitest run packages/tui/extensions/lib/browse.test.ts
 */

import { describe, it, expect, vi } from 'vitest';

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
