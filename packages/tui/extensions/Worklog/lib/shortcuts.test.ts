/**
 * Unit tests for lib/shortcuts.ts — keyboard shortcut detection and
 * navigation helpers.
 *
 * Run: npx vitest run packages/tui/extensions/lib/shortcuts.test.ts
 */

import { describe, it, expect } from 'vitest';

describe('lib/shortcuts exports', () => {
  it('should export keyboard navigation helpers', async () => {
    const mod = await import('./shortcuts.js');
    // _matchesKey may be null (Pi TUI unavailable) or function
    expect(mod._matchesKey === null || typeof mod._matchesKey === 'function').toBe(true);
    expect(typeof mod.isUpKey).toBe('function');
    expect(typeof mod.isDownKey).toBe('function');
    expect(typeof mod.isPageUpKey).toBe('function');
    expect(typeof mod.isPageDownKey).toBe('function');
    expect(typeof mod.isEnterKey).toBe('function');
    expect(typeof mod.isEscapeKey).toBe('function');
    expect(typeof mod.isCtrlEnterKey).toBe('function');
  });
});

describe('isEnterKey', () => {
  it('should detect carriage return', async () => {
    const { isEnterKey } = await import('./shortcuts.js');
    expect(isEnterKey('\r')).toBe(true);
  });

  it('should detect newline', async () => {
    const { isEnterKey } = await import('./shortcuts.js');
    expect(isEnterKey('\n')).toBe(true);
  });

  it('should detect the string "enter"', async () => {
    const { isEnterKey } = await import('./shortcuts.js');
    expect(isEnterKey('enter')).toBe(true);
  });

  it('should return false for non-enter keys', async () => {
    const { isEnterKey } = await import('./shortcuts.js');
    expect(isEnterKey('a')).toBe(false);
    expect(isEnterKey('\u001b')).toBe(false);
  });
});

describe('isEscapeKey', () => {
  it('should detect escape character', async () => {
    const { isEscapeKey } = await import('./shortcuts.js');
    expect(isEscapeKey('\u001b')).toBe(true);
  });

  it('should detect the string "escape"', async () => {
    const { isEscapeKey } = await import('./shortcuts.js');
    expect(isEscapeKey('escape')).toBe(true);
  });

  it('should return false for non-escape keys', async () => {
    const { isEscapeKey } = await import('./shortcuts.js');
    expect(isEscapeKey('a')).toBe(false);
    expect(isEscapeKey('\r')).toBe(false);
  });
});

describe('isUpKey', () => {
  it('should detect ANSI up escape sequence', async () => {
    const { isUpKey } = await import('./shortcuts.js');
    expect(isUpKey('\u001b[A')).toBe(true);
  });

  it('should detect the string "up"', async () => {
    const { isUpKey } = await import('./shortcuts.js');
    expect(isUpKey('up')).toBe(true);
  });
});

describe('isDownKey', () => {
  it('should detect ANSI down escape sequence', async () => {
    const { isDownKey } = await import('./shortcuts.js');
    expect(isDownKey('\u001b[B')).toBe(true);
  });

  it('should detect the string "down"', async () => {
    const { isDownKey } = await import('./shortcuts.js');
    expect(isDownKey('down')).toBe(true);
  });
});

describe('isPageUpKey', () => {
  it('should detect ANSI page up', async () => {
    const { isPageUpKey } = await import('./shortcuts.js');
    expect(isPageUpKey('\u001b[5~')).toBe(true);
  });

  it('should detect "pageup"', async () => {
    const { isPageUpKey } = await import('./shortcuts.js');
    expect(isPageUpKey('pageup')).toBe(true);
  });
});

describe('isPageDownKey', () => {
  it('should detect ANSI page down', async () => {
    const { isPageDownKey } = await import('./shortcuts.js');
    expect(isPageDownKey('\u001b[6~')).toBe(true);
  });

  it('should detect space as page down', async () => {
    const { isPageDownKey } = await import('./shortcuts.js');
    expect(isPageDownKey(' ')).toBe(true);
  });
});

describe('isCtrlEnterKey', () => {
  it('should detect Kitty protocol Ctrl+Enter sequence', async () => {
    const { isCtrlEnterKey } = await import('./shortcuts.js');
    expect(isCtrlEnterKey('\u001b[13;5u')).toBe(true);
  });

  it('should detect ANSI modifyOtherKeys Ctrl+Enter sequence', async () => {
    const { isCtrlEnterKey } = await import('./shortcuts.js');
    expect(isCtrlEnterKey('\u001b[27;5;13~')).toBe(true);
  });

  it('should detect the string "ctrl+enter"', async () => {
    const { isCtrlEnterKey } = await import('./shortcuts.js');
    expect(isCtrlEnterKey('ctrl+enter')).toBe(true);
  });

  it('should detect the string "ctrl+return"', async () => {
    const { isCtrlEnterKey } = await import('./shortcuts.js');
    expect(isCtrlEnterKey('ctrl+return')).toBe(true);
  });

  it('should return false for regular Enter', async () => {
    const { isCtrlEnterKey } = await import('./shortcuts.js');
    expect(isCtrlEnterKey('\r')).toBe(false);
    expect(isCtrlEnterKey('\n')).toBe(false);
    expect(isCtrlEnterKey('enter')).toBe(false);
  });

  it('should return false for non-enter keys', async () => {
    const { isCtrlEnterKey } = await import('./shortcuts.js');
    expect(isCtrlEnterKey('a')).toBe(false);
    expect(isCtrlEnterKey('\u001b')).toBe(false);
  });
});
