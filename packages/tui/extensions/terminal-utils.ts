/**
 * Terminal utilities for width-aware text operations.
 *
 * Handles emoji (2-column) and other special character widths for proper
 * TUI rendering.
 */

// Emoji and special symbol Unicode ranges that take 2 terminal columns
// Source: https://en.wikipedia.org/wiki/Unicode_block
const EMOJI_RANGES = [
  [0x1F300, 0x1F9FF], // Miscellaneous Symbols and Pictographs
  [0x2600, 0x2B5F],   // Miscellaneous Symbols, Dingbats, and more
] as const;

/**
 * Check if a codepoint is an emoji or special symbol that takes 2 terminal columns.
 */
export function isDoubleWidthEmoji(cp: number): boolean {
  return EMOJI_RANGES.some(([start, end]) => cp >= start && cp <= end);
}

/**
 * Get the terminal column width for a character.
 * Emoji and special symbols take 2 columns, others take 1.
 */
export function getCharWidth(char: string): number {
  if (char.length === 0) return 0;
  const cp = char.codePointAt(0) || 0;
  return isDoubleWidthEmoji(cp) ? 2 : 1;
}

/**
 * Calculate the visible terminal width of a string (excluding ANSI codes).
 */
export function visibleWidth(text: string): number {
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const c of stripped) {
    width += getCharWidth(c);
  }
  return width;
}

/** Options for truncateToTerminalWidth */
export interface TruncateOptions {
  ellipsis?: string;
}

/**
 * Truncate text to fit within maxWidth visible terminal columns.
 * Preserves ANSI escape sequences while truncating.
 */
export function truncateToTerminalWidth(
  text: string,
  maxWidth: number,
  opts: TruncateOptions = {}
): string {
  const ellipsis = opts.ellipsis ?? '…';
  
  if (maxWidth <= 0) return '';
  
  if (visibleWidth(text) <= maxWidth) return text;

  const contentWidth = Math.max(0, maxWidth - ellipsis.length);

  let visible = 0;
  let result = '';
  let i = 0;

  while (i < text.length) {
    // Handle ANSI escape sequences
    if (text[i] === '\x1b') {
      const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        result += match[0];
        i += match[0].length;
        continue;
      }
    }
    
    if (visible >= contentWidth) break;
    
    // Check for surrogate pairs (emoji)
    const char = text[i];
    const charW = getCharWidth(char);
    
    result += char;
    visible += charW;
    i += charW === 2 ? 2 : 1; // Skip both surrogates if it's a 2-char emoji
  }

  return result + ellipsis;
}