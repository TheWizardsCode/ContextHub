/**
 * Tests for the dependency-free LLM progress-feedback helper
 * (src/lib/progress-feedback.ts).
 *
 * Covers the static status message, the TTY-only animated spinner and its
 * deterministic clearing, suppression of control characters when stdout is
 * not a TTY, the fallback notice, and the disabled (`--json`) path.
 *
 * WL-0MUX2W8IN005RW66
 */

import { describe, it, expect } from 'vitest';
import {
  startLlmProgress,
  LLM_THINKING_MESSAGE,
  LLM_FALLBACK_NOTICE,
  type ProgressWriteStream,
} from '../../src/lib/progress-feedback.js';

const SPINNER_FRAME_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const CLEAR_LINE_RE = /^\r +\r$/;

/** Capturing write stream with a controllable TTY flag. */
function makeStream(isTTY?: boolean): {
  stream: ProgressWriteStream;
  writes: string[];
} {
  const writes: string[] = [];
  const stream: ProgressWriteStream = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  };
  if (isTTY !== undefined) stream.isTTY = isTTY;
  return { stream, writes };
}

describe('startLlmProgress', () => {
  it('prints the static status message and animates a TTY spinner', () => {
    const { stream, writes } = makeStream(true);
    const handle = startLlmProgress({
      outStream: stream,
      isTty: true,
      intervalMs: 1000,
    });

    expect(handle.spinning).toBe(true);
    // The static message is written first, then the first animated frame on
    // the same line (rendered synchronously).
    expect(writes[0]).toBe(`${LLM_THINKING_MESSAGE} `);
    expect(SPINNER_FRAME_RE.test(writes[1])).toBe(true);
    expect(writes[1].startsWith('\r')).toBe(true);

    handle.stop();
    expect(handle.spinning).toBe(false);
  });

  it('clears the animated line when stopped', () => {
    const { stream, writes } = makeStream(true);
    const handle = startLlmProgress({
      outStream: stream,
      isTty: true,
      intervalMs: 1000,
    });
    handle.stop();
    // Carriage return + padding spaces + carriage return wipes the line so no
    // spinner/status remains on screen.
    expect(writes[writes.length - 1]).toMatch(CLEAR_LINE_RE);
  });

  it('emits only the static message (no control characters) when not a TTY', () => {
    const { stream, writes } = makeStream(false);
    const handle = startLlmProgress({ outStream: stream });

    expect(handle.spinning).toBe(false);
    expect(writes).toEqual([`${LLM_THINKING_MESSAGE}\n`]);

    handle.stop();
    // A clean success writes nothing more, and never a carriage return.
    expect(writes).toEqual([`${LLM_THINKING_MESSAGE}\n`]);
    expect(writes.join('')).not.toContain('\r');
  });

  it('prints the fallback notice on failure without mentioning "local"', () => {
    const { stream, writes } = makeStream(false);
    const handle = startLlmProgress({ outStream: stream });
    handle.stop({ fallback: true });

    expect(writes[writes.length - 1]).toBe(`${LLM_FALLBACK_NOTICE}\n`);
    expect(LLM_FALLBACK_NOTICE.toLowerCase()).not.toContain('local');
  });

  it('clears a TTY spinner before printing the fallback notice', () => {
    const { stream, writes } = makeStream(true);
    const handle = startLlmProgress({
      outStream: stream,
      isTty: true,
      intervalMs: 1000,
    });
    handle.stop({ fallback: true });

    const clearIndex = writes.findIndex(w => CLEAR_LINE_RE.test(w));
    const noticeIndex = writes.findIndex(w => w.includes(LLM_FALLBACK_NOTICE));
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeGreaterThan(clearIndex);
  });

  it('is a complete no-op when disabled (--json mode)', () => {
    const { stream, writes } = makeStream(true);
    const handle = startLlmProgress({
      outStream: stream,
      enabled: false,
    });

    expect(handle.spinning).toBe(false);
    handle.stop({ fallback: true });
    expect(writes).toEqual([]);
  });

  it('is idempotent — a second stop writes nothing more', () => {
    const { stream, writes } = makeStream(false);
    const handle = startLlmProgress({ outStream: stream });
    handle.stop();
    const count = writes.length;

    handle.stop({ fallback: true });
    expect(writes.length).toBe(count);
  });
});
