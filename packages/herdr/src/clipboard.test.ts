/**
 * Unit tests for the herdr clipboard read/write helpers.
 *
 * Run: npx vitest run packages/herdr/src/clipboard.test.ts
 *
 * Covers `readFromClipboard` (platform-ordered paste readers, graceful
 * degradation when no reader is available) and `writeToClipboard` (copy to
 * OS clipboard) via injectable spawn fakes.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  readFromClipboard,
  writeToClipboard,
  type SpawnLike,
} from './clipboard.js';

/** A tiny fake child process backed by an EventEmitter, shaped like the real
 * `ChildProcess` API used by the clipboard helpers (stdout/stderr data
 * streams, close/error events, stdin write/end). */
function fakeChild(opts: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number;
  error?: Error;
}): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  // Defer stdout/stderr/close on the macrotask queue so the clipboard
  // helper's data/close listeners (attached after spawn returns) are in
  // place before anything is emitted.
  setImmediate(() => {
    if (opts.stdoutData) child.stdout.emit('data', Buffer.from(opts.stdoutData));
    if (opts.stderrData) child.stderr.emit('data', Buffer.from(opts.stderrData));
    if (opts.error) {
      child.emit('error', opts.error);
    } else {
      child.emit('close', opts.exitCode ?? 0);
    }
  });
  return child;
}

/** Build a spawn-like that returns a fake child and records invocations. */
function fakeSpawn(behaviors: Array<{ command?: string; stdoutData?: string; exitCode?: number; error?: Error }>): { spawn: SpawnLike; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  let idx = 0;
  const spawn: SpawnLike = ((command: string, args?: readonly string[]) => {
    calls.push([command, args ? [...args] : []]);
    const behavior = behaviors[Math.min(idx, behaviors.length - 1)];
    idx += 1;
    return fakeChild({
      stdoutData: behavior.stdoutData,
      exitCode: behavior.exitCode,
      error: behavior.error,
    }) as any;
  }) as SpawnLike;
  return { spawn, calls };
}

describe('readFromClipboard', () => {
  it('reads text via pbpaste on macOS', async () => {
    const { spawn, calls } = fakeSpawn([{ command: 'pbpaste', stdoutData: 'hello from clipboard' }]);
    // Force the darwin branch.
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const res = await readFromClipboard({ spawn, env: {} });
      expect(res.success).toBe(true);
      expect(res.text).toBe('hello from clipboard');
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe('pbpaste');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('gracefully reports failure when pbpaste has no output', async () => {
    const { spawn } = fakeSpawn([{ command: 'pbpaste', stdoutData: '', exitCode: 0 }]);
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const res = await readFromClipboard({ spawn, env: {} });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('tries wl-paste then xclip on Linux (Wayland set)', async () => {
    const { spawn, calls } = fakeSpawn([
      { command: 'wl-paste', stdoutData: 'wayland text' },
    ]);
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const res = await readFromClipboard({ spawn, env: { WAYLAND_DISPLAY: ':0' } });
      expect(res.success).toBe(true);
      expect(res.text).toBe('wayland text');
      expect(calls[0][0]).toBe('wl-paste');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('falls through to xsel when wl-paste and xclip fail', async () => {
    const { spawn, calls } = fakeSpawn([
      { command: 'wl-paste', stdoutData: '', exitCode: 1 },
      { command: 'xclip', stdoutData: '', exitCode: 1 },
      { command: 'xsel', stdoutData: 'fallback text' },
    ]);
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const res = await readFromClipboard({ spawn, env: { WAYLAND_DISPLAY: ':0', DISPLAY: ':0' } });
      expect(res.success).toBe(true);
      expect(res.text).toBe('fallback text');
      expect(calls.map((c) => c[0])).toEqual(['wl-paste', 'xclip', 'xsel']);
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('reports failure when no reader succeeds', async () => {
    const { spawn } = fakeSpawn([
      { command: 'wl-paste', stdoutData: '', exitCode: 1 },
      { command: 'xclip', stdoutData: '', exitCode: 1 },
      { command: 'xsel', stdoutData: '', exitCode: 1 },
    ]);
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const res = await readFromClipboard({ spawn, env: { WAYLAND_DISPLAY: ':0', DISPLAY: ':0' } });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('reports failure when the reader binary is missing (spawn error)', async () => {
    const spawn: SpawnLike = (() => {
      throw new Error('ENOENT');
    }) as SpawnLike;
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const res = await readFromClipboard({ spawn, env: {} });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });
});

describe('writeToClipboard', () => {
  it('writes text via pbcopy on macOS', async () => {
    const { spawn, calls } = fakeSpawn([{ command: 'pbcopy' }]);
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const res = await writeToClipboard('value to copy', { spawn, env: {} });
      expect(res.success).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe('pbcopy');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('reports failure when every write tool fails', async () => {
    const { spawn } = fakeSpawn([
      { command: 'xclip', exitCode: 1 },
      { command: 'xsel', exitCode: 1 },
    ]);
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const res = await writeToClipboard('x', { spawn, env: {} });
      expect(res.success).toBe(false);
      expect(res.error).toBeTruthy();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });
});
