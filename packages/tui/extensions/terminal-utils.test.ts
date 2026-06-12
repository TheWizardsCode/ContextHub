/**
 * Unit tests for terminal-utils.ts - shared terminal width utilities.
 *
 * Run: npx vitest run packages/tui/extensions/terminal-utils.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  isDoubleWidthEmoji,
  getCharWidth,
  visibleWidth,
  truncateToTerminalWidth,
} from './terminal-utils.js';

describe('terminal-utils', () => {
  describe('isDoubleWidthEmoji', () => {
    it('returns true for emoji in Miscellaneous Symbols range', () => {
      expect(isDoubleWidthEmoji(0x1F6A8)).toBe(true); // 🚨
      expect(isDoubleWidthEmoji(0x1F7E2)).toBe(true); // 🟢
      expect(isDoubleWidthEmoji(0x1F504)).toBe(true); // 🔄
    });

    it('returns true for emoji in Miscellaneous Symbols and Dingbats range', () => {
      expect(isDoubleWidthEmoji(0x26A0)).toBe(true); // ⚠
      expect(isDoubleWidthEmoji(0x26D4)).toBe(true); // ⛔
      expect(isDoubleWidthEmoji(0x2705)).toBe(true); // ✅
    });

    it('returns true for star emoji (U+2B50)', () => {
      expect(isDoubleWidthEmoji(0x2B50)).toBe(true); // ⭐
    });

    it('returns false for regular ASCII characters', () => {
      expect(isDoubleWidthEmoji(0x41)).toBe(false); // 'A'
      expect(isDoubleWidthEmoji(0x30)).toBe(false); // '0'
    });
  });

  describe('getCharWidth', () => {
    it('returns 2 for double-width emoji', () => {
      expect(getCharWidth('🚨')).toBe(2);
      expect(getCharWidth('🟢')).toBe(2);
      expect(getCharWidth('⭐')).toBe(2);
    });

    it('returns 1 for regular characters', () => {
      expect(getCharWidth('A')).toBe(1);
      expect(getCharWidth(' ')).toBe(1);
      expect(getCharWidth('1')).toBe(1);
    });

    it('returns 0 for empty string', () => {
      expect(getCharWidth('')).toBe(0);
    });
  });

  describe('visibleWidth', () => {
    it('calculates width correctly for plain text', () => {
      expect(visibleWidth('hello')).toBe(5);
      expect(visibleWidth('abc 123')).toBe(7);
    });

    it('counts emoji as 2 columns', () => {
      expect(visibleWidth('🟢')).toBe(2);
      expect(visibleWidth('A🟢B')).toBe(4);
      expect(visibleWidth('⭐🟢')).toBe(4);
    });

    it('ignores ANSI escape codes', () => {
      expect(visibleWidth('\x1b[32m🟢\x1b[0m')).toBe(2);
      expect(visibleWidth('\x1b[1mhello\x1b[0m')).toBe(5);
    });
  });

  describe('truncateToTerminalWidth', () => {
    it('returns original text when it fits', () => {
      expect(truncateToTerminalWidth('hello', 10)).toBe('hello');
    });

    it('truncates text that exceeds width', () => {
      const result = truncateToTerminalWidth('hello world', 8);
      expect(result).toContain('…');
    });

    it('handles emoji correctly in truncation', () => {
      // "🟢A" is 3 visible columns, "🟢B" would be 4
      const result = truncateToTerminalWidth('🟢AB', 4);
      expect(visibleWidth(result)).toBeLessThanOrEqual(4);
    });

    it('preserves ANSI escape sequences', () => {
      const input = '\x1b[32mhello\x1b[0m world';
      const result = truncateToTerminalWidth(input, 8);
      expect(result).toContain('\x1b[32m');
      expect(result).toContain('\x1b[0m');
    });

    it('returns empty string for zero or negative width', () => {
      expect(truncateToTerminalWidth('hello', 0)).toBe('');
      expect(truncateToTerminalWidth('hello', -1)).toBe('');
    });

    it('supports custom ellipsis', () => {
      const result = truncateToTerminalWidth('hello world', 8, { ellipsis: '...' });
      expect(result).toContain('...');
    });
  });
});