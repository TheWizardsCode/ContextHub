/**
 * Unit tests for terminal-utils.ts - shared terminal width utilities.
 *
 * Run: npx vitest run packages/tui/extensions/terminal-utils.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  isDoubleWidthEmoji,
  isZeroWidthChar,
  getCharWidth,
  visibleWidth,
  truncateToTerminalWidth,
  truncateWorkItemId,
  wrapToTerminalWidth,
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

  describe('isZeroWidthChar', () => {
    it('returns true for Variation Selector-16 (U+FE0F)', () => {
      expect(isZeroWidthChar(0xFE0F)).toBe(true);
    });

    it('returns true for Variation Selector-15 (U+FE0E)', () => {
      expect(isZeroWidthChar(0xFE0E)).toBe(true);
    });

    it('returns true for Zero Width Joiner (U+200D)', () => {
      expect(isZeroWidthChar(0x200D)).toBe(true);
    });

    it('returns true for Zero Width Space (U+200B)', () => {
      expect(isZeroWidthChar(0x200B)).toBe(true);
    });

    it('returns true for Zero Width Non-Joiner (U+200C)', () => {
      expect(isZeroWidthChar(0x200C)).toBe(true);
    });

    it('returns true for Word Joiner (U+2060)', () => {
      expect(isZeroWidthChar(0x2060)).toBe(true);
    });

    it('returns true for BOM / ZWNBSP (U+FEFF)', () => {
      expect(isZeroWidthChar(0xFEFF)).toBe(true);
    });

    it('returns true for Soft Hyphen (U+00AD)', () => {
      expect(isZeroWidthChar(0x00AD)).toBe(true);
    });

    it('returns true for Left-to-Right Mark (U+200E)', () => {
      expect(isZeroWidthChar(0x200E)).toBe(true);
    });

    it('returns true for Right-to-Left Mark (U+200F)', () => {
      expect(isZeroWidthChar(0x200F)).toBe(true);
    });

    it('returns false for a regular emoji codepoint (U+1F504)', () => {
      expect(isZeroWidthChar(0x1F504)).toBe(false); // 🔄
    });

    it('returns false for ASCII characters', () => {
      expect(isZeroWidthChar(0x41)).toBe(false); // 'A'
      expect(isZeroWidthChar(0x30)).toBe(false); // '0'
    });

    it('returns false for regular double-width emoji (U+26A0)', () => {
      expect(isZeroWidthChar(0x26A0)).toBe(false); // ⚠
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

    it('returns 0 for Variation Selector-16 (U+FE0F)', () => {
      expect(getCharWidth('\uFE0F')).toBe(0);
    });

    it('returns 0 for Zero Width Joiner (U+200D)', () => {
      expect(getCharWidth('\u200D')).toBe(0);
    });

    it('returns 0 for Zero Width Space (U+200B)', () => {
      expect(getCharWidth('\u200B')).toBe(0);
    });

    it('returns 0 for Soft Hyphen (U+00AD)', () => {
      expect(getCharWidth('\u00AD')).toBe(0);
    });

    it('returns 2 for check mark emoji (U+2714) when not followed by VS16', () => {
      expect(getCharWidth('\u2714')).toBe(2);
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

    it('treats Variation Selector-16 as zero-width', () => {
      // ✔️ = U+2714 (2 cols) + U+FE0F (0 cols) = 2 cols total
      expect(visibleWidth('\u2714\uFE0F')).toBe(2);
    });

    it('treats warning sign with VS16 as 2 columns', () => {
      // ⚠️ = U+26A0 (2 cols) + U+FE0F (0 cols) = 2 cols
      expect(visibleWidth('\u26A0\uFE0F')).toBe(2);
    });

    it('treats hammer and wrench with VS16 as 2 columns', () => {
      // 🛠️ = U+1F6E0 (2 cols) + U+FE0F (0 cols) = 2 cols
      expect(visibleWidth('\u{1F6E0}\uFE0F')).toBe(2);
    });

    it('treats wastebasket with VS16 as 2 columns', () => {
      // 🗑️ = U+1F5D1 (2 cols) + U+FE0F (0 cols) = 2 cols
      expect(visibleWidth('\u{1F5D1}\uFE0F')).toBe(2);
    });

    it('handles mixed icons with VS16 sequences correctly', () => {
      // 🔓 (2) + space (1) + 🛠️ (2) + space (1) + ❓ (2) = 8
      expect(visibleWidth('\u{1F513} \u{1F6E0}\uFE0F \u{2754}')).toBe(8);
    });

    it('treats ZWJ sequences correctly counting only visible characters', () => {
      // 👨‍👩‍👧‍👦 = U+1F468 (2) + U+200D (0) + U+1F469 (2) + U+200D (0) + U+1F467 (2) + U+200D (0) + U+1F466 (2) = 8
      expect(visibleWidth('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}')).toBe(8);
    });

    it('handles zero-width space character', () => {
      // 'A' + ZWSP + 'B' = 'A' (1) + ZWSP (0) + 'B' (1) = 2
      expect(visibleWidth('A\u200BB')).toBe(2);
    });
  });

  describe('wrapToTerminalWidth', () => {
    it('returns a single line when text fits within maxWidth', () => {
      expect(wrapToTerminalWidth('hello', 10)).toEqual(['hello']);
    });

    it('wraps at word boundaries for a simple sentence', () => {
      const result = wrapToTerminalWidth('hello world foo', 8);
      expect(result).toEqual(['hello', 'world', 'foo']);
    });

    it('wraps when text exactly equals maxWidth', () => {
      expect(wrapToTerminalWidth('hello', 5)).toEqual(['hello']);
    });

    it('preserves multiple spaces as a single word separator', () => {
      const result = wrapToTerminalWidth('hello   world', 8);
      expect(result).toEqual(['hello', 'world']);
    });

    it('handles leading and trailing whitespace gracefully', () => {
      const result = wrapToTerminalWidth('  hello world  ', 10);
      expect(result).toEqual(['hello', 'world']);
    });

    it('falls back to character-break for words longer than maxWidth', () => {
      const result = wrapToTerminalWidth('abcdefghij', 5);
      expect(result).toEqual(['abcde', 'fghij']);
    });

    it('character-breaks across multiple lines for a single long word', () => {
      const result = wrapToTerminalWidth('superlongword', 4);
      expect(result).toEqual(['supe', 'rlon', 'gwor', 'd']);
    });

    it('preserves ANSI escape sequences at word boundaries', () => {
      const input = '\x1b[32mhello world\x1b[0m foo';
      const result = wrapToTerminalWidth(input, 8);
      // Each line preserves the ANSI codes that were active
      expect(result.some(l => l.includes('\x1b[32m'))).toBe(true);
      expect(result.some(l => l.includes('\x1b[0m'))).toBe(true);
    });

    it('re-applies active ANSI codes at the start of wrapped lines', () => {
      const input = '\x1b[32mhello world foo\x1b[0m';
      const result = wrapToTerminalWidth(input, 8);
      expect(result).toEqual([
        '\x1b[32mhello',
        '\x1b[32mworld',
        '\x1b[32mfoo\x1b[0m',
      ]);
    });

    it('handles double-width emoji in wrapping (emoji counts as 2 columns)', () => {
      const result = wrapToTerminalWidth('🟢a🟢b', 4);
      expect(result).toEqual(['🟢a', '🟢b']);
    });

    it('handles emoji with VS16 correctly in wrapping (VS16 is zero-width)', () => {
      // ✔️a = U+2714+U+FE0F (2 cols) + 'a' (1 col) = 3 cols, fits in 4
      const result = wrapToTerminalWidth('\u2714\uFE0Fa\u2714\uFE0Fb', 4);
      expect(result).toEqual(['\u2714\uFE0Fa', '\u2714\uFE0Fb']);
    });

    it('word-wraps text with emoji correctly', () => {
      const result = wrapToTerminalWidth('hello 🟢 world 🟢 foo', 12);
      expect(result).toEqual(['hello 🟢', 'world 🟢 foo']);
    });

    it('returns empty array for empty string', () => {
      expect(wrapToTerminalWidth('', 10)).toEqual([]);
    });

    it('returns empty array for zero or negative maxWidth', () => {
      expect(wrapToTerminalWidth('hello', 0)).toEqual([]);
      expect(wrapToTerminalWidth('hello', -1)).toEqual([]);
    });

    it('preserves ANSI codes within a word during character-break', () => {
      // One long word with embedded ANSI codes (no spaces)
      const input = 'before\x1b[31mred\x1b[0mafter';
      // visible: 6 + 3 + 5 = 14, break at 10
      // First line fills to maxWidth: 'before\x1b[31mred\x1b[0ma' = 10 visible cols
      const result = wrapToTerminalWidth(input, 10);
      expect(result).toEqual(['before\x1b[31mred\x1b[0ma', 'fter']);
    });

    it('handles words with mixed ANSI codes spanning wrap boundaries', () => {
      const input = '\x1b[32mhello world\x1b[0m';
      const result = wrapToTerminalWidth(input, 8);
      expect(result).toEqual([
        '\x1b[32mhello',
        '\x1b[32mworld\x1b[0m',
      ]);
    });

    it('preserves existing line breaks in the input', () => {
      expect(wrapToTerminalWidth('hello\nworld', 10)).toEqual(['hello', 'world']);
    });

    it('each wrapped line has visible width <= maxWidth', () => {
      const longText = 'The quick brown fox jumps over the lazy dog near the riverbank.';
      const result = wrapToTerminalWidth(longText, 20);
      for (const line of result) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(20);
      }
    });

    it('handles a single space-separated word list correctly', () => {
      const input = 'a bb ccc dddd eeeee ffffff';
      const result = wrapToTerminalWidth(input, 6);
      expect(result).toEqual(['a bb', 'ccc', 'dddd', 'eeeee', 'ffffff']);
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

  // ── truncateWorkItemId ──────────────────────────────────────────────

  describe('truncateWorkItemId', () => {
    it('truncates a standard WL- prefixed work item ID', () => {
      const result = truncateWorkItemId('WL-0MQL0T5TR0060AEH');
      expect(result).toBe('WL...0AEH');
    });

    it('truncates a SA- prefixed work item ID', () => {
      const result = truncateWorkItemId('SA-0MPYMFZXO0004ZU4');
      expect(result).toBe('SA...4ZU4');
    });

    it('truncates a CG- prefixed work item ID', () => {
      const result = truncateWorkItemId('CG-0MQK0OM6I00168HD');
      expect(result).toBe('CG...68HD');
    });

    it('does not truncate short IDs (fewer than 15 chars after dash)', () => {
      expect(truncateWorkItemId('WL-123')).toBe('WL-123');
      expect(truncateWorkItemId('WL-abc123')).toBe('WL-abc123');
      expect(truncateWorkItemId('WL-0MQL0T5TR')).toBe('WL-0MQL0T5TR');
    });

    it('truncates all occurrences in a string with multiple IDs', () => {
      const result = truncateWorkItemId(
        'WL-0MQL0T5TR0060AEH and CG-0MQK0OM6I00168HD'
      );
      expect(result).toBe('WL...0AEH and CG...68HD');
    });

    it('does not truncate IDs that appear at the start of a string', () => {
      const result = truncateWorkItemId('WL-0MQL0T5TR0060AEH is the ID');
      expect(result).toBe('WL...0AEH is the ID');
    });

    it('does not truncate IDs that appear at the end of a string', () => {
      const result = truncateWorkItemId('Process item WL-0MQL0T5TR0060AEH');
      expect(result).toBe('Process item WL...0AEH');
    });

    it('returns original text when no work item IDs are present', () => {
      expect(truncateWorkItemId('Hello world')).toBe('Hello world');
      expect(truncateWorkItemId('')).toBe('');
      expect(truncateWorkItemId('No IDs here at all')).toBe('No IDs here at all');
    });

    it('works with IDs embedded in longer text with spaces', () => {
      const result = truncateWorkItemId('implement WL-0MQL0T5TR0060AEH the feature');
      expect(result).toBe('implement WL...0AEH the feature');
    });

    it('handles IDs with ANSI escape sequences (passes through)', () => {
      const result = truncateWorkItemId('\x1b[31mWL-0MQL0T5TR0060AEH\x1b[0m');
      expect(result).toBe('\x1b[31mWL...0AEH\x1b[0m');
    });

    it('handles multiple IDs separated by various delimiters', () => {
      const result = truncateWorkItemId('WL-0MQL0T5TR0060AEH,WL-0MQLG8PK80041FM3');
      expect(result).toBe('WL...0AEH,WL...1FM3');
    });
  });
});