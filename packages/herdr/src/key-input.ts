/**
 * packages/herdr/src/key-input.ts — Raw stdin chunk tokenisation
 *
 * A terminal in raw mode does not deliver exactly one keypress per
 * `process.stdin` `data` event. When the user types quickly (or a paste
 * arrives), the PTY coalesces several bytes into a single chunk. Treating
 * that whole chunk as one "key" silently drops every character after the
 * first — the "missing keypresses when typing fast" bug
 * (WL-0MTV67MZU003H7SH).
 *
 * {@link splitKeypresses} turns a raw chunk into an ordered list of
 * individual key tokens. Escape sequences (CSI / SS3 / Alt) are kept intact
 * as a single token so existing `key === '\x1b[A'`-style checks keep
 * working; every other code point becomes its own token.
 *
 * This is deliberately a pure, dependency-free module so every text-input
 * consumer (the command form and the Ship It dialog) shares exactly one
 * tokeniser instead of each re-implementing (and mis-handling) chunk
 * splitting.
 */

/**
 * Split a raw stdin chunk into individual keypress tokens.
 *
 * Handled escape forms (kept as one token):
 *   - CSI: `ESC [ parameters? intermediates? final` — arrows
 *     (`\x1b[A`), PageUp/Down (`\x1b[5~`), Ctrl+Enter (`\x1b[13;5u`),
 *     bracketed-paste markers (`\x1b[200~` / `\x1b[201~`), SGR mouse.
 *   - SS3: `ESC O final` — some terminals' arrow / function keys.
 *   - Alt/Meta: `ESC <char>` — e.g. Alt+m (`\x1bm`).
 *
 * Every other code point (printable text, control characters, a lone
 * trailing `ESC`) is returned as its own single-character token so
 * coalesced fast typing is preserved character-for-character.
 *
 * An escape sequence left incomplete at the end of the chunk (the PTY split
 * it across reads) is returned as a single remainder token rather than
 * being discarded, so no bytes are lost.
 *
 * @param chunk - Raw stdin chunk (`Buffer.toString()` output).
 * @returns Ordered key tokens; empty only when `chunk` is empty.
 */
export function splitKeypresses(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];

    // Ordinary code point (including control chars and a lone ESC that is
    // the final character of the chunk).
    if (ch !== '\x1b') {
      keys.push(ch);
      i += 1;
      continue;
    }

    const next = chunk[i + 1];
    // Lone trailing ESC — the Esc key itself.
    if (next === undefined) {
      keys.push(ch);
      i += 1;
      continue;
    }

    // CSI: ESC '[' params (0x30–0x3F) intermediates (0x20–0x2F) final (0x40–0x7E).
    if (next === '[') {
      let j = i + 2;
      while (j < chunk.length) {
        const code = chunk.charCodeAt(j);
        if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
          j += 1;
          continue;
        }
        break;
      }
      if (j < chunk.length) {
        const final = chunk.charCodeAt(j);
        if (final >= 0x40 && final <= 0x7e) {
          keys.push(chunk.slice(i, j + 1));
          i = j + 1;
          continue;
        }
      }
      // Incomplete CSI (split across reads): keep the remainder whole so an
      // owning parser can buffer it — never drop bytes.
      keys.push(chunk.slice(i));
      break;
    }

    // SS3: ESC 'O' final (e.g. some terminals' arrow / function keys).
    if (next === 'O' && i + 2 < chunk.length) {
      keys.push(chunk.slice(i, i + 3));
      i += 3;
      continue;
    }

    // Alt/Meta: ESC followed by a single character.
    keys.push(chunk.slice(i, i + 2));
    i += 2;
  }
  return keys;
}
