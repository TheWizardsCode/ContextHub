/**
 * packages/herdr/src/key-input.test.ts — Tests for raw stdin chunk
 * tokenisation (WL-0MTV67MZU003H7SH).
 *
 * Verifies that a chunk carrying several coalesced keystrokes (fast typing /
 * paste) is split into every key, while multi-byte escape sequences are kept
 * whole. This is the root fix for "missing keypresses when typing fast".
 *
 * Run: npx vitest run packages/herdr/src/key-input.test.ts
 */

import { describe, it, expect } from 'vitest';
import { splitKeypresses, splitKeypressesComplete, KeypressDecoder } from './key-input.js';

describe('splitKeypresses', () => {
  it('returns an empty list for an empty chunk', () => {
    expect(splitKeypresses('')).toEqual([]);
  });

  it('splits coalesced printable keystrokes into one token each', () => {
    expect(splitKeypresses('hello')).toEqual(['h', 'e', 'l', 'l', 'o']);
  });

  it('preserves spaces and punctuation inside a coalesced chunk', () => {
    expect(splitKeypresses('a b!c')).toEqual(['a', ' ', 'b', '!', 'c']);
  });

  it('treats a lone printable character as a single token', () => {
    expect(splitKeypresses('x')).toEqual(['x']);
  });

  it('keeps a CSI arrow sequence as one token', () => {
    expect(splitKeypresses('\x1b[A')).toEqual(['\x1b[A']);
    expect(splitKeypresses('\x1b[B')).toEqual(['\x1b[B']);
  });

  it('keeps a CSI Ctrl+Enter sequence as one token', () => {
    expect(splitKeypresses('\x1b[13;5u')).toEqual(['\x1b[13;5u']);
    expect(splitKeypresses('\x1b[13;5~')).toEqual(['\x1b[13;5~']);
    expect(splitKeypresses('\x1b[1;5A')).toEqual(['\x1b[1;5A']);
  });

  it('keeps bracketed-paste markers as one token each', () => {
    expect(splitKeypresses('\x1b[200~')).toEqual(['\x1b[200~']);
    expect(splitKeypresses('\x1b[201~')).toEqual(['\x1b[201~']);
  });

  it('keeps an SS3 sequence as one token', () => {
    expect(splitKeypresses('\x1bOA')).toEqual(['\x1bOA']);
  });

  it('keeps an Alt/Meta two-byte sequence as one token', () => {
    expect(splitKeypresses('\x1bm')).toEqual(['\x1bm']);
  });

  it('mixes printable text and escape sequences in order', () => {
    expect(splitKeypresses('ab\x1b[Ac')).toEqual(['a', 'b', '\x1b[A', 'c']);
  });

  it('keeps control characters as individual tokens', () => {
    expect(splitKeypresses('a\tb\x7fc')).toEqual(['a', '\t', 'b', '\x7f', 'c']);
  });

  it('keeps a trailing newline as its own token', () => {
    expect(splitKeypresses('hi\r')).toEqual(['h', 'i', '\r']);
  });

  it('treats a lone trailing ESC as the Esc key token', () => {
    expect(splitKeypresses('a\x1b')).toEqual(['a', '\x1b']);
  });

  it('returns an incomplete CSI remainder as one token (never drops bytes)', () => {
    expect(splitKeypresses('\x1b[')).toEqual(['\x1b[']);
    expect(splitKeypresses('a\x1b[3')).toEqual(['a', '\x1b[3']);
  });

  it('round-trips: re-joining the tokens reproduces the chunk', () => {
    for (const chunk of ['hello', 'ab\x1b[Ac', '\x1b[13;5uok\r', '\x1b[200~x\ny\x1b[201~']) {
      expect(splitKeypresses(chunk).join('')).toBe(chunk);
    }
  });
});

describe('splitKeypressesComplete — streaming variant (WL-0MTV67MZU003H7SH)', () => {
  it('emits complete keys and withholds an incomplete CSI tail', () => {
    expect(splitKeypressesComplete('ab\x1b[')).toEqual({
      keys: ['a', 'b'],
      pending: '\x1b[',
    });
    expect(splitKeypressesComplete('a\x1b[3')).toEqual({
      keys: ['a'],
      pending: '\x1b[3',
    });
  });

  it('returns a complete CSI sequence with no pending tail', () => {
    expect(splitKeypressesComplete('\x1b[A')).toEqual({ keys: ['\x1b[A'], pending: '' });
    expect(splitKeypressesComplete('\x1b[200~')).toEqual({ keys: ['\x1b[200~'], pending: '' });
  });

  it('emits a lone trailing ESC as the Esc key (never withheld)', () => {
    expect(splitKeypressesComplete('\x1b')).toEqual({ keys: ['\x1b'], pending: '' });
    expect(splitKeypressesComplete('a\x1b')).toEqual({ keys: ['a', '\x1b'], pending: '' });
  });
});

describe('KeypressDecoder — cross-chunk lossless decoding (WL-0MTV67MZU003H7SH)', () => {
  it('splits a coalesced printable chunk into one key per character', () => {
    const decoder = new KeypressDecoder();
    expect(decoder.push('hello')).toEqual(['h', 'e', 'l', 'l', 'o']);
    expect(decoder.hasPending()).toBe(false);
  });

  it('reassembles a multi-byte UTF-8 character split across two Buffers', () => {
    const decoder = new KeypressDecoder();
    // 'é' is 0xC3 0xA9. Splitting mid-sequence would yield U+FFFD if each
    // chunk were decoded on its own.
    expect(decoder.push(Buffer.from([0xc3]))).toEqual([]);
    expect(decoder.push(Buffer.from([0xa9]))).toEqual(['é']);
  });

  it('reassembles an SGR mouse sequence split across chunks instead of cancelling', () => {
    const decoder = new KeypressDecoder();
    // A split like this previously delivered a bare ESC first, which the form
    // read as Esc and cancelled the whole overlay.
    expect(decoder.push('\x1b[<0;10;')).toEqual([]);
    expect(decoder.push('5M')).toEqual(['\x1b[<0;10;5M']);
  });

  it('reassembles a bracketed-paste opener split across chunks', () => {
    const decoder = new KeypressDecoder();
    expect(decoder.push('\x1b[20')).toEqual([]);
    expect(decoder.push('0~')).toEqual(['\x1b[200~']);
  });

  it('emits a lone ESC immediately (Escape stays responsive)', () => {
    const decoder = new KeypressDecoder();
    expect(decoder.push('\x1b')).toEqual(['\x1b']);
    expect(decoder.hasPending()).toBe(false);
  });

  it('flush() force-emits a stuck incomplete escape as literal keys', () => {
    const decoder = new KeypressDecoder();
    expect(decoder.push('\x1b[')).toEqual([]);
    expect(decoder.hasPending()).toBe(true);
    expect(decoder.flush()).toEqual(['\x1b[']);
    expect(decoder.hasPending()).toBe(false);
  });

  it('never drops bytes: held plus completed tokens reconstruct the input', () => {
    const decoder = new KeypressDecoder();
    const first = decoder.push('ab\x1b[');
    const second = decoder.push('Ac');
    expect([...first, ...second].join('')).toBe('ab\x1b[Ac');
  });
});
