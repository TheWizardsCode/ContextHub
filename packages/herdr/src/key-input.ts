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

import { StringDecoder } from 'node:string_decoder';

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
  return tokeniseKeys(chunk, false).keys;
}

/**
 * Streaming variant of {@link splitKeypresses} used by {@link KeypressDecoder}.
 *
 * Unlike the pure splitter, a trailing incomplete CSI sequence is returned as
 * `pending` (not as a token) so a stateful caller can prepend it to the next
 * chunk and complete the escape sequence losslessly. A trailing lone ESC is
 * still emitted immediately as the Esc key — see {@link tokeniseKeys}.
 *
 * @param chunk - Text to tokenise (usually a buffer of committed bytes).
 * @returns The complete key tokens plus any withheld incomplete tail.
 */
export function splitKeypressesComplete(
  chunk: string,
): { keys: string[]; pending: string } {
  return tokeniseKeys(chunk, true);
}

/**
 * Shared tokeniser behind {@link splitKeypresses} and
 * {@link splitKeypressesComplete}.
 *
 * `holdIncomplete` controls what happens to a trailing incomplete CSI
 * sequence: `false` keeps it as one remainder token (every byte is emitted);
 * `true` withholds it as `pending` so a streaming caller can complete it from
 * the next chunk.
 *
 * A lone trailing ESC is always emitted as the Esc key immediately — a real
 * Escape must cancel/submit without waiting for the next chunk. (A genuine
 * escape sequence split exactly after its ESC introducer is the one form this
 * cannot recover; terminals write CSI sequences atomically, so it is rare.)
 */
function tokeniseKeys(
  chunk: string,
  holdIncomplete: boolean,
): { keys: string[]; pending: string } {
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
    // Lone trailing ESC — the Esc key itself, emitted immediately.
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
      // Incomplete CSI (split across reads). The streaming decoder withholds
      // it so the next chunk can complete it (mouse / bracketed-paste / arrow
      // sequences split across `data` events); the pure splitter keeps the
      // remainder whole so no bytes are dropped.
      if (holdIncomplete) return { keys, pending: chunk.slice(i) };
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
  return { keys, pending: '' };
}

/**
 * Stateful stdin decoder for the TUI event loop (WL-0MTV67MZU003H7SH).
 *
 * Raw TTY input is a byte stream, not one key per `data` event: a multi-byte
 * UTF-8 code point or an escape sequence can be split across reads, and
 * several keystrokes can be coalesced into one chunk. Decoding each chunk in
 * isolation loses bytes (a split multi-byte character becomes U+FFFD) and
 * mis-delivers a split escape sequence — a chunk ending in the ESC introducer
 * would be read as the Esc key and cancel the open form.
 *
 * `KeypressDecoder` keeps the incomplete tail in a buffer (`StringDecoder`
 * holds partial UTF-8 code points; the tokeniser holds an incomplete CSI
 * sequence) and completes it from the next chunk. Held bytes are never
 * dropped. A trailing lone ESC is still emitted immediately as the Esc key so
 * Escape stays responsive.
 */
export class KeypressDecoder {
  private readonly utf8 = new StringDecoder('utf8');
  private pending = '';

  /**
   * Feed a raw chunk and return the complete key tokens it completed.
   *
   * @param chunk - Raw stdin chunk (Buffer) or already-decoded text (string).
   * @returns Complete key tokens; empty when the chunk only formed a prefix of
   *          a held escape sequence (or was itself empty).
   */
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    if (text.length === 0 && this.pending.length === 0) return [];
    const { keys, pending } = splitKeypressesComplete(this.pending + text);
    this.pending = pending;
    return keys;
  }

  /**
   * Force-emit any held remainder as keys — e.g. a stray incomplete CSI
   * sequence that will never be completed. Returns `[]` when nothing is held.
   */
  flush(): string[] {
    if (this.pending.length === 0) return [];
    const keys = splitKeypresses(this.pending);
    this.pending = '';
    return keys;
  }

  /** Whether a partial escape sequence is currently held for the next chunk. */
  hasPending(): boolean {
    return this.pending.length > 0;
  }
}
