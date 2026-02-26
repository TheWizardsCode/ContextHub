import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyToClipboard } from '../../src/clipboard.js';

describe('copyToClipboard', () => {
  function createMockSpawn(exitCode = 0) {
    const written: string[] = [];
    let closeHandler: ((code: number) => void) | null = null;

    const mockSpawn = vi.fn((_cmd: string, _args: any, _opts?: any) => {
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

    return { mockSpawn, written };
  }

  it('writes text to stdin of clipboard command and returns success', async () => {
    const { mockSpawn, written } = createMockSpawn(0);
    const result = await copyToClipboard('WL-TEST-123', { spawn: mockSpawn });

    expect(result.success).toBe(true);
    expect(written).toEqual(['WL-TEST-123']);
    expect(mockSpawn).toHaveBeenCalled();
  });

  it('spawns clipboard command with detached: true', async () => {
    const { mockSpawn } = createMockSpawn(0);
    await copyToClipboard('WL-TEST-123', { spawn: mockSpawn });

    // Verify detached: true is passed in spawn options
    const spawnOpts = mockSpawn.mock.calls[0][2];
    expect(spawnOpts).toMatchObject({ detached: true });
  });

  it('calls unref() after the close event (not before)', async () => {
    // unref() must be called after the close event fires, otherwise
    // Node.js stops tracking the child and the close event never fires.
    const callOrder: string[] = [];
    const mockSpawn = vi.fn((_cmd: string, _args: any, _opts?: any) => {
      let closeHandler: ((code: number) => void) | null = null;
      const cp: any = {
        stdin: {
          write: vi.fn(),
          end: vi.fn(() => { if (closeHandler) closeHandler(0); }),
        },
        on: vi.fn((event: string, handler: any) => {
          if (event === 'close') closeHandler = handler;
        }),
        unref: vi.fn(() => { callOrder.push('unref'); }),
      };
      // Intercept the close handler to track order
      const origOn = cp.on;
      cp.on = vi.fn((event: string, handler: any) => {
        if (event === 'close') {
          closeHandler = (code: number) => {
            callOrder.push('close');
            handler(code);
          };
        } else {
          origOn(event, handler);
        }
      });
      return cp;
    });

    await copyToClipboard('WL-TEST-123', { spawn: mockSpawn });

    // close must fire before unref is called
    expect(callOrder).toEqual(['close', 'unref']);
  });

  it('returns failure when clipboard command exits with non-zero code', async () => {
    const { mockSpawn } = createMockSpawn(1);
    const result = await copyToClipboard('WL-TEST-123', { spawn: mockSpawn });

    expect(result.success).toBe(false);
  });

  it('returns failure when spawn emits error event', async () => {
    const mockSpawn = vi.fn(() => {
      let errorHandler: ((err: Error) => void) | null = null;
      const cp: any = {
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
        on: vi.fn((event: string, handler: any) => {
          if (event === 'error') errorHandler = handler;
        }),
        unref: vi.fn(),
      };
      // Simulate error after spawn
      setTimeout(() => { if (errorHandler) errorHandler(new Error('spawn ENOENT')); }, 0);
      return cp;
    });

    const result = await copyToClipboard('WL-TEST-123', { spawn: mockSpawn });

    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn ENOENT');
  });

  it('returns failure when stdin is not available (null)', async () => {
    const mockSpawn = vi.fn(() => {
      let closeHandler: ((code: number) => void) | null = null;
      const cp: any = {
        stdin: null,
        on: vi.fn((event: string, handler: any) => {
          if (event === 'close') closeHandler = handler;
        }),
        unref: vi.fn(),
      };
      return cp;
    });

    const result = await copyToClipboard('WL-TEST-123', { spawn: mockSpawn });

    expect(result.success).toBe(false);
    expect(result.error).toContain('stdin not available');
  });

  it('handles stdin.write throwing an error', async () => {
    const mockSpawn = vi.fn(() => {
      const cp: any = {
        stdin: {
          write: vi.fn(() => { throw new Error('write EPIPE'); }),
          // In real Node.js, end() does not synchronously fire the close event.
          // The catch block in clipboard.ts resolves the promise with the write
          // error before the close event fires.
          end: vi.fn(),
        },
        on: vi.fn(),
        unref: vi.fn(),
      };
      return cp;
    });

    const result = await copyToClipboard('WL-TEST-123', { spawn: mockSpawn });

    expect(result.success).toBe(false);
    expect(result.error).toContain('write EPIPE');
  });

  it('handles spawn itself throwing', async () => {
    const mockSpawn = vi.fn(() => { throw new Error('spawn failed'); });

    const result = await copyToClipboard('WL-TEST-123', { spawn: mockSpawn });

    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn failed');
  });

  it('converts non-string text argument to string', async () => {
    const { mockSpawn, written } = createMockSpawn(0);
    // Pass a number as text (TypeScript type mismatch, but tests defensive behavior)
    const result = await copyToClipboard(42 as any, { spawn: mockSpawn });

    expect(result.success).toBe(true);
    expect(written).toEqual(['42']);
  });

  describe('Wayland support', () => {
    const originalEnv = process.env.WAYLAND_DISPLAY;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.WAYLAND_DISPLAY;
      } else {
        process.env.WAYLAND_DISPLAY = originalEnv;
      }
    });

    it('tries wl-copy first when WAYLAND_DISPLAY is set', async () => {
      process.env.WAYLAND_DISPLAY = 'wayland-0';
      // Force Linux platform for this test
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

      const { mockSpawn } = createMockSpawn(0);
      const result = await copyToClipboard('wayland-test', { spawn: mockSpawn });

      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });

      expect(result.success).toBe(true);
      // wl-copy should be the first command tried
      expect(mockSpawn.mock.calls[0][0]).toBe('wl-copy');
    });

    it('falls back to xclip when wl-copy fails on Wayland', async () => {
      process.env.WAYLAND_DISPLAY = 'wayland-0';
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

      let callIndex = 0;
      const mockSpawn = vi.fn((_cmd: string, _args: any, _opts?: any) => {
        const exitCode = callIndex === 0 ? 1 : 0; // wl-copy fails, xclip succeeds
        callIndex++;
        let closeHandler: ((code: number) => void) | null = null;
        const cp: any = {
          stdin: {
            write: vi.fn(),
            end: vi.fn(() => { if (closeHandler) closeHandler(exitCode); }),
          },
          on: vi.fn((event: string, handler: any) => {
            if (event === 'close') closeHandler = handler;
          }),
          unref: vi.fn(),
        };
        return cp;
      });

      const result = await copyToClipboard('wayland-test', { spawn: mockSpawn });

      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });

      expect(result.success).toBe(true);
      expect(mockSpawn.mock.calls[0][0]).toBe('wl-copy');
      expect(mockSpawn.mock.calls[1][0]).toBe('xclip');
    });

    it('does not try wl-copy when WAYLAND_DISPLAY is not set', async () => {
      delete process.env.WAYLAND_DISPLAY;
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true });

      const { mockSpawn } = createMockSpawn(0);
      const result = await copyToClipboard('x11-test', { spawn: mockSpawn });

      Object.defineProperty(process, 'platform', { value: origPlatform, writable: true });

      expect(result.success).toBe(true);
      // First command should be xclip, not wl-copy
      expect(mockSpawn.mock.calls[0][0]).toBe('xclip');
    });
  });
});
