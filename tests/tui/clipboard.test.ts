import { describe, it, expect, vi } from 'vitest';
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
});
