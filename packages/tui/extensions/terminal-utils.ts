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

// Lazy-loaded references to Pi's built-in terminal utility functions.
// When the extension runs inside Pi, these delegate to @earendil-works/pi-tui
// which handles ANSI codes, emoji widths, and wrapping correctly.
// Falls back to the custom implementations when Pi's TUI is not available.
let _piVisibleWidth: ((text: string) => number) | null = null;
let _piTruncateToWidth: ((text: string, width: number, ellipsis?: string) => string) | null = null;
let _piWrapTextWithAnsi: ((text: string, width: number) => string[]) | null = null;

try {
  const tui = await import('@earendil-works/pi-tui');
  _piVisibleWidth = tui.visibleWidth;
  _piTruncateToWidth = tui.truncateToWidth;
  _piWrapTextWithAnsi = tui.wrapTextWithAnsi;
} catch {
  // Pi TUI not available — fall back to custom implementations
}

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
  if (_piVisibleWidth) return _piVisibleWidth(text);
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
  if (_piTruncateToWidth) return _piTruncateToWidth(text, maxWidth, opts.ellipsis);
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
    
    // Use string.slice to get the full character (handles surrogate pairs)
    const char = text[i];
    const charW = getCharWidth(char);
    
    result += char;
    visible += charW;
    i++; // Move forward - getCharWidth uses codePointAt which handles the surrogate
  }

  return result + ellipsis;
}

// ─────────────────────────────────────────────────────────────────────
// Utility functions for wrapToTerminalWidth
// ─────────────────────────────────────────────────────────────────────

/**
 * Split text into space-delimited words, preserving ANSI escape sequences
 * within each word. Consecutive spaces are treated as a single separator.
 */
function splitSpacedWords(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let i = 0;

  while (i < text.length) {
    // Preserve ANSI escape sequences within words
    if (text[i] === '\x1b') {
      const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        current += match[0];
        i += match[0].length;
        continue;
      }
    }

    if (text[i] === ' ') {
      if (current.length > 0) {
        words.push(current);
        current = '';
      }
      // Skip consecutive spaces
      while (i < text.length && text[i] === ' ') {
        i++;
      }
      continue;
    }

    current += text[i];
    i++;
  }

  if (current.length > 0) {
    words.push(current);
  }

  return words;
}

/**
 * Apply the ANSI escape sequences in `word` onto an existing ANSI state,
 * returning the new ANSI state.
 *
 * When an ANSI reset (`\x1b[0m`) is encountered, the accumulated state is
 * cleared. Other ANSI codes are appended to the state.
 */
function applyAnsiToState(currentState: string, word: string): string {
  let newState = currentState;
  let i = 0;

  while (i < word.length) {
    if (word[i] === '\x1b') {
      const match = word.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        const seq = match[0];
        if (seq === '\x1b[0m') {
          newState = '';
        } else {
          newState += seq;
        }
        i += seq.length;
        continue;
      }
    }
    i++;
  }

  return newState;
}

/**
 * Character-break a word that is longer than maxWidth into lines,
 * preserving ANSI escape sequences. Each continuation line starts
 * with the ANSI state that was active at the break point.
 *
 * The activeAnsiPrefix is the ANSI state that was active before this
 * word started. As the word is traversed, ANSI codes within the word
 * update the active state, which is used when starting new lines.
 */
function charBreakWord(
  word: string,
  maxWidth: number,
  activeAnsiPrefix: string,
): string[] {
  const result: string[] = [];
  // Ensure activeAnsiPrefix is a string (could be undefined/null from external)
  const prefix = typeof activeAnsiPrefix === 'string' ? activeAnsiPrefix : '';
  let currentLine = prefix;
  let currentWidth = visibleWidth(currentLine);
  let activeAnsi = prefix;

  let i = 0;
  while (i < word.length) {
    // Check for ANSI escape sequence
    if (word[i] === '\x1b') {
      const match = word.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        const seq = match[0];
        currentLine += seq;
        i += seq.length;
        // Update tracked ANSI state
        if (seq === '\x1b[0m') {
          activeAnsi = '';
        } else {
          activeAnsi += seq;
        }
        continue;
      }
    }

    // Get the full character, handling surrogate pairs
    const cp = word.codePointAt(i) || 0;
    const charLen = cp >= 0x10000 ? 2 : 1;
    const fullChar = charLen === 2 ? String.fromCodePoint(cp) : word[i];
    const charWidth = getCharWidth(fullChar);

    if (currentWidth + charWidth > maxWidth) {
      // Flush current line
      result.push(currentLine);
      // Start new line with the ANSI state active at this point
      currentLine = activeAnsi;
      currentWidth = visibleWidth(currentLine);
    }

    currentLine += fullChar;
    currentWidth += charWidth;
    i += charLen;
  }

  // Push any remaining content (only if it has visible content beyond the prefix)
  if (currentLine.length > 0 && visibleWidth(currentLine) > 0) {
    result.push(currentLine);
  }

  return result;
}

/**
 * Options for wrapToTerminalWidth.
 */
export interface WrapOptions {
  /** When true, preserve existing newlines in the input as line breaks. Default: true */
  preserveNewlines?: boolean;
}

/**
 * Wrap text to fit within maxWidth visible terminal columns.
 *
 * Wraps at word boundaries (spaces between words) to preserve readability.
 * Words longer than maxWidth are character-broken to the next line.
 *
 * Features:
 * - Word-boundary wrapping with fallback to character-break for overlong words
 * - ANSI escape sequence preservation (active codes re-applied at wrap boundaries)
 * - Double-width emoji handling (using visibleWidth for column-accurate measure)
 * - Existing newlines in the input are preserved (optional)
 *
 * @param text - The text to wrap
 * @param maxWidth - Maximum visible terminal columns per line
 * @param opts - Optional configuration (see WrapOptions)
 * @returns Array of wrapped lines, each at most maxWidth visible columns wide
 */
export function wrapToTerminalWidth(
  text: string,
  maxWidth: number,
  opts: WrapOptions = {},
): string[] {
  if (_piWrapTextWithAnsi) return _piWrapTextWithAnsi(text, maxWidth);
  const { preserveNewlines = true } = opts;

  if (maxWidth <= 0) return [];
  if (text.length === 0) return [];

  const result: string[] = [];

  // Helper to wrap a single line segment (no internal newlines)
  const wrapSegment = (segment: string): void => {
    if (segment.length === 0) {
      result.push('');
      return;
    }

    const words = splitSpacedWords(segment);
    if (words.length === 0) {
      result.push('');
      return;
    }

    let currentLine = '';
    let currentWidth = 0;
    let activeAnsi = '';

    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi];
      const wordWidth = visibleWidth(word);
      const spaceCost = currentWidth > 0 ? 1 : 0;

      if (currentWidth + wordWidth + spaceCost > maxWidth) {
        // Word doesn't fit on the current line
        // Flush current line first (if non-empty)
        if (currentLine.length > 0) {
          result.push(currentLine);
          currentLine = '';
          currentWidth = 0;
        }

        if (wordWidth > maxWidth) {
          // Word itself is too wide — character-break it
          const broken = charBreakWord(word, maxWidth, activeAnsi);
          for (let bi = 0; bi < broken.length; bi++) {
            if (bi < broken.length - 1) {
              result.push(broken[bi]);
            } else {
              // Last broken piece becomes the current line
              currentLine = broken[bi];
              currentWidth = visibleWidth(currentLine);
            }
          }
        } else {
          // Start new line with word, prepending active ANSI prefix
          currentLine = activeAnsi + word;
          currentWidth = wordWidth;
        }
      } else {
        // Word fits on the current line
        if (spaceCost > 0) {
          currentLine += ' ';
          currentWidth += 1;
        }
        currentLine += word;
        currentWidth += wordWidth;
      }

      // Update active ANSI state by applying this word's ANSI changes
      // onto the current active state (state persists across words)
      activeAnsi = applyAnsiToState(activeAnsi, word);
    }

    if (currentLine.length > 0) {
      result.push(currentLine);
    }
  };

  if (preserveNewlines) {
    // Split by existing newlines, wrapping each segment independently.
    // Empty segments (e.g., from consecutive newlines) produce blank lines.
    const segments = text.split('\n');
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      if (seg === '' && si > 0 && si < segments.length - 1) {
        // Only produce a blank line for truly empty segments between content
        result.push('');
      } else if (seg === '' && segments.length === 1) {
        // Single empty segment = empty string input
        result.push('');
      } else if (seg !== '') {
        wrapSegment(seg);
      }
    }
  } else {
    wrapSegment(text);
  }

  // Trim trailing empty lines (but preserve empty lines between content)
  while (result.length > 0 && result[result.length - 1] === '') {
    result.pop();
  }

  return result;
}