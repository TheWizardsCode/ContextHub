import { describe, it, expect, vi } from 'vitest';
import { copyToClipboard } from '../../src/clipboard.js';

describe('copyToClipboard', () => {
  /**
   * Helper: create a mock spawn that returns fake child processes.
   * Each invocation returns a child whose close event fires with exitCode.
   * Captures text written to stdin.
   */
  function createMockSpawn(exitCode = 0) {
    const written: string[] = [];
    const commands: string[] = [];

    const mockSpawn = vi.fn((cmd: string, _args: any, _opts?: any) => {
      commands.push(cmd);
      let closeHandler: ((code: number) => void) | null = null;
      const stdin = {
        write: vi.fn((data: string) => { written.push(data); return true; }),
        end: vi.fn(() => {
          if (closeHandler) closeHandler(exitCode);
        }),
      };
      const cp: any = {
        stdin,
        on: vi.fn((event: string, handler: any) => {
          if (event === 'close') closeHandler = handler;
        }),
        unref: vi.fn(),
      };
      return cp;
    });

    return { mockSpawn, written, commands };
  }

  /**
   * Helper: create a mock spawn where each command can have its own exit code.
   * exitCodes is a map from command name to exit code.
   */
  function createMockSpawnWithCodes(exitCodes: Record<string, number>) {
    const written: string[] = [];
    const commands: string[] = [];

    const mockSpawn = vi.fn((cmd: string, _args: any, _opts?: any) => {
      commands.push(cmd);
      const code = exitCodes[cmd] ?? 0;
      let closeHandler: ((code: number) => void) | null = null;
      const hasStdin = _opts?.stdio?.[0] === 'pipe';
      const stdin = hasStdin ? {
        write: vi.fn((data: string) => { written.push(data); return true; }),
        end: vi.fn(() => { if (closeHandler) closeHandler(code); }),
      } : null;
      const cp: any = {
        stdin,
        on: vi.fn((event: string, handler: any) => {
          if (event === 'close') closeHandler = handler;
        }),
        unref: vi.fn(),
      };
      // For commands with stdio: ['ignore', ...], simulate close after tick
      if (!hasStdin) {
        setTimeout(() => { if (closeHandler) closeHandler(code); }, 0);
      }
      return cp;
    });

    return { mockSpawn, written, commands };
  }

  // -- Non-tmux, non-Wayland (basic Linux) -----------------------------------

  it('writes text to stdin of clipboard command and returns success', async () => {
    const { mockSpawn, written } = createMockSpawn(0);
    const result = await copyToClipboard('WL-TEST-123', {
      spawn: mockSpawn,
      env: {}, // no TMUX, no WAYLAND_DISPLAY
    });

    expect(result.success).toBe(true);
    expect(written).toContain('WL-TEST-123');
    expect(mockSpawn).toHaveBeenCalled();
  });

  it('spawns clipboard command with detached: true', async () => {
    const { mockSpawn } = createMockSpawn(0);
    await copyToClipboard('WL-TEST-123', { spawn: mockSpawn, env: {} });

    // All spawn calls should have detached: true
    for (const call of mockSpawn.mock.calls) {
      expect(call[2]).toMatchObject({ detached: true });
    }
  });

  it('calls unref() after the close event (not before)', async () => {
    const callOrder: string[] = [];
    const mockSpawn = vi.fn((_cmd: string, _args: any, _opts?: any) => {
      let closeHandler: ((code: number) => void) | null = null;
      const hasStdin = _opts?.stdio?.[0] === 'pipe';
      const stdin = hasStdin ? {
        write: vi.fn(),
        end: vi.fn(() => { if (closeHandler) closeHandler(0); }),
      } : null;
      const cp: any = {
        stdin,
        on: vi.fn((event: string, handler: any) => {
          if (event === 'close') {
            const wrapped = (code: number) => {
              callOrder.push('close');
              handler(code);
            };
            closeHandler = wrapped;
          }
        }),
        unref: vi.fn(() => { callOrder.push('unref'); }),
      };
      if (!hasStdin) {
        setTimeout(() => { if (closeHandler) closeHandler(0); }, 0);
      }
      return cp;
    });

    await copyToClipboard('WL-TEST-123', { spawn: mockSpawn, env: {} });

    // Every close must be followed by its unref
    const closes = callOrder.filter(e => e === 'close');
    const unrefs = callOrder.filter(e => e === 'unref');
    expect(closes.length).toBeGreaterThan(0);
    expect(unrefs.length).toBe(closes.length);
    for (let i = 0; i < callOrder.length; i++) {
      if (callOrder[i] === 'unref') {
        // The preceding entry should be 'close'
        expect(callOrder[i - 1]).toBe('close');
      }
    }
  });

  it('returns failure when all clipboard commands exit with non-zero code', async () => {
    const { mockSpawn } = createMockSpawn(1);
    const result = await copyToClipboard('WL-TEST-123', {
      spawn: mockSpawn,
      env: {}, // no TMUX
    });

    expect(result.success).toBe(false);
  });

  it('returns failure when spawn emits error event', async () => {
    const mockSpawn = vi.fn((_cmd: string, _args: any, _opts?: any) => {
      let errorHandler: ((err: Error) => void) | null = null;
      const hasStdin = _opts?.stdio?.[0] === 'pipe';
      const cp: any = {
        stdin: hasStdin ? { write: vi.fn(), end: vi.fn() } : null,
        on: vi.fn((event: string, handler: any) => {
          if (event === 'error') errorHandler = handler;
        }),
        unref: vi.fn(),
      };
      setTimeout(() => { if (errorHandler) errorHandler(new Error('spawn ENOENT')); }, 0);
      return cp;
    });

    const result = await copyToClipboard('WL-TEST-123', {
      spawn: mockSpawn,
      env: {}, // no TMUX
    });

    expect(result.success).toBe(false);
    // The error from each failed tool is collected; at least one should contain ENOENT
    expect(result.error).toContain('ENOENT');
  });

  it('returns failure when stdin is not available (null)', async () => {
    const mockSpawn = vi.fn((_cmd: string, _args: any, _opts?: any) => {
      const cp: any = {
        stdin: null,
        on: vi.fn(),
        unref: vi.fn(),
      };
      return cp;
    });

    const result = await copyToClipboard('WL-TEST-123', {
      spawn: mockSpawn,
      env: {}, // no TMUX
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('stdin not available');
  });

  it('handles stdin.write throwing an error', async () => {
    const mockSpawn = vi.fn((_cmd: string, _args: any, _opts?: any) => {
      const cp: any = {
        stdin: {
          write: vi.fn(() => { throw new Error('write EPIPE'); }),
          end: vi.fn(),
        },
        on: vi.fn(),
        unref: vi.fn(),
      };
      return cp;
    });

    const result = await copyToClipboard('WL-TEST-123', {
      spawn: mockSpawn,
      env: {}, // no TMUX
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('write EPIPE');
  });

  it('handles spawn itself throwing', async () => {
    const mockSpawn = vi.fn(() => { throw new Error('spawn failed'); });

    const result = await copyToClipboard('WL-TEST-123', {
      spawn: mockSpawn,
      env: {}, // no TMUX
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn failed');
  });

  it('converts non-string text argument to string', async () => {
    const { mockSpawn, written } = createMockSpawn(0);
    const result = await copyToClipboard(42 as any, { spawn: mockSpawn, env: {} });

    expect(result.success).toBe(true);
    expect(written).toContain('42');
  });

  // -- tmux support -----------------------------------------------------------

  describe('tmux support', () => {
    it('calls tmux set-buffer when TMUX env var is set', async () => {
      const { mockSpawn, commands } = createMockSpawnWithCodes({
        tmux: 0,
        xclip: 0,
      });

      const result = await copyToClipboard('WL-TMUX-1', {
        spawn: mockSpawn,
        env: { TMUX: '/tmp/tmux-1000/default,12345,0' },
      });

      expect(result.success).toBe(true);
      expect(commands).toContain('tmux');
      // tmux set-buffer should be the first call
      expect(commands[0]).toBe('tmux');
      // Should also call a system clipboard tool
      expect(commands.some(c => ['xclip', 'xsel', 'wl-copy'].includes(c))).toBe(true);
    });

    it('succeeds with only tmux if system clipboard tools fail', async () => {
      const { mockSpawn, commands } = createMockSpawnWithCodes({
        tmux: 0,
        xclip: 1,
        xsel: 1,
      });

      const result = await copyToClipboard('WL-TMUX-2', {
        spawn: mockSpawn,
        env: { TMUX: '/tmp/tmux-1000/default,12345,0' },
      });

      expect(result.success).toBe(true);
      expect(commands[0]).toBe('tmux');
    });

    it('passes the text as argument to tmux set-buffer', async () => {
      const { mockSpawn } = createMockSpawnWithCodes({ tmux: 0, xclip: 0 });

      await copyToClipboard('WL-ID-123', {
        spawn: mockSpawn,
        env: { TMUX: '/tmp/tmux-1000/default,12345,0' },
      });

      // Find the tmux call
      const tmuxCall = mockSpawn.mock.calls.find((c: any[]) => c[0] === 'tmux');
      expect(tmuxCall).toBeDefined();
      // args should include set-buffer and the text
      expect(tmuxCall![1]).toEqual(['set-buffer', '--', 'WL-ID-123']);
    });

    it('does not call tmux set-buffer when TMUX is not set', async () => {
      const { mockSpawn, commands } = createMockSpawn(0);

      await copyToClipboard('WL-NO-TMUX', {
        spawn: mockSpawn,
        env: {}, // no TMUX
      });

      expect(commands).not.toContain('tmux');
    });
  });

  // -- OSC 52 support ---------------------------------------------------------

  describe('OSC 52 support', () => {
    it('calls writeOsc52 with base64-encoded text', async () => {
      const writeOsc52 = vi.fn();
      const { mockSpawn } = createMockSpawn(0);

      const result = await copyToClipboard('WL-OSC52', {
        spawn: mockSpawn,
        writeOsc52,
        env: {},
      });

      expect(result.success).toBe(true);
      expect(writeOsc52).toHaveBeenCalledTimes(1);

      const seq = writeOsc52.mock.calls[0][0] as string;
      // Should be OSC 52 format: \x1b]52;c;<base64>\x07
      expect(seq).toMatch(/^\x1b\]52;c;[A-Za-z0-9+/=]+\x07$/);
      // Decode and verify
      const b64 = seq.replace(/^\x1b\]52;c;/, '').replace(/\x07$/, '');
      expect(Buffer.from(b64, 'base64').toString()).toBe('WL-OSC52');
    });

    it('succeeds even if writeOsc52 throws', async () => {
      const writeOsc52 = vi.fn(() => { throw new Error('write failed'); });
      const { mockSpawn } = createMockSpawn(0);

      const result = await copyToClipboard('WL-OSC52-ERR', {
        spawn: mockSpawn,
        writeOsc52,
        env: {},
      });

      // Should still succeed because system clipboard tools work
      expect(result.success).toBe(true);
    });

    it('does not call writeOsc52 when not provided', async () => {
      const { mockSpawn } = createMockSpawn(0);

      const result = await copyToClipboard('WL-NO-OSC', {
        spawn: mockSpawn,
        env: {},
      });

      expect(result.success).toBe(true);
      // No error — writeOsc52 was simply not provided
    });
  });

  // -- Wayland support --------------------------------------------------------

  describe('Wayland support', () => {
    it('tries wl-copy first when WAYLAND_DISPLAY is set', async () => {
      const { mockSpawn, commands } = createMockSpawn(0);
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

      const result = await copyToClipboard('wayland-test', {
        spawn: mockSpawn,
        env: { WAYLAND_DISPLAY: 'wayland-0' },
      });

      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });

      expect(result.success).toBe(true);
      // wl-copy should be the first system clipboard command tried
      const systemCmds = commands.filter(c => c !== 'tmux');
      expect(systemCmds[0]).toBe('wl-copy');
    });

    it('falls back to xclip when wl-copy fails on Wayland', async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

      const { mockSpawn, commands } = createMockSpawnWithCodes({
        'wl-copy': 1,
        xclip: 0,
      });

      const result = await copyToClipboard('wayland-test', {
        spawn: mockSpawn,
        env: { WAYLAND_DISPLAY: 'wayland-0' },
      });

      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });

      expect(result.success).toBe(true);
      expect(commands).toContain('wl-copy');
      expect(commands).toContain('xclip');
    });

    it('does not try wl-copy when WAYLAND_DISPLAY is not set', async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

      const { mockSpawn, commands } = createMockSpawn(0);
      const result = await copyToClipboard('x11-test', {
        spawn: mockSpawn,
        env: {},
      });

      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });

      expect(result.success).toBe(true);
      expect(commands).not.toContain('wl-copy');
      // First system clipboard command should be xclip
      expect(commands[0]).toBe('xclip');
    });
  });

  // -- Combined tmux + Wayland ------------------------------------------------

  describe('combined tmux + Wayland', () => {
    it('sets tmux buffer AND system clipboard', async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

      const writeOsc52 = vi.fn();
      const { mockSpawn, commands } = createMockSpawnWithCodes({
        tmux: 0,
        'wl-copy': 1,
        xclip: 0,
      });

      const result = await copyToClipboard('WL-COMBINED', {
        spawn: mockSpawn,
        writeOsc52,
        env: {
          TMUX: '/tmp/tmux-1000/default,12345,0',
          WAYLAND_DISPLAY: 'wayland-0',
        },
      });

      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });

      expect(result.success).toBe(true);
      expect(commands).toContain('tmux');
      expect(writeOsc52).toHaveBeenCalledTimes(1);
      // Should also have tried system clipboard tools
      expect(commands.some(c => ['xclip', 'xsel', 'wl-copy'].includes(c))).toBe(true);
    });
  });
});
