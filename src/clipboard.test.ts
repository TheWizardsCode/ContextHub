/**
 * Unit tests for src/clipboard.ts — readFromClipboard & copyToClipboard
 *
 * Run: npx vitest run src/clipboard.test.ts
 *
 * Uses the shared global child_process mock (tests/child-process-mocks.ts,
 * installed by tests/setup-tests.ts). The shared mockSpawn is re-implemented
 * here to return a mock child whose event callbacks are stored in module-level
 * variables; tests fire the stored callbacks directly (like auto-sync.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ── Shared global child_process mock ──────────────────────────────────────
// The global setup already mocks 'node:child_process' with mockSpawn.
// We grab the same instance and override its implementation.
const { mockSpawn } = vi.hoisted(() => (globalThis as any).__sharedChildProcessMocks as {
  mockSpawn: Mock;
});

// ── Module-level state for the mock child ─────────────────────────────────

/** Callback registered via child.on('close', cb) */
let childCloseCallback: ((code: number | null) => void) | null = null;
/** Callback registered via child.stdout.on('data', cb) */
let childDataCallback: ((chunk: Buffer) => void) | null = null;
/** Commands the mock spawn was invoked with */
let spawnCommands: Array<{ cmd: string; args: string[] }> = [];
/** Whether the next spawn call should throw */
let spawnShouldThrow = false;

// Import the module under test (uses the mocked spawn)
import { readFromClipboard, copyToClipboard } from './clipboard.js';

function makeMockChild() {
  const mockOn = vi.fn((event: string, cb: (code: number | null) => void) => {
    if (event === 'close') {
      childCloseCallback = cb;
    }
    return child;
  });
  const mockStdoutOn = vi.fn((event: string, cb: (chunk: Buffer) => void) => {
    if (event === 'data') {
      childDataCallback = cb;
    }
    return child.stdout;
  });
  const child = {
    on: mockOn,
    stdout: { on: mockStdoutOn },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
    unref: vi.fn(),
  };
  return child;
}

function mockSpawnImpl(cmd: string, args: string[]): any {
  if (spawnShouldThrow) {
    throw new Error('spawn failed');
  }
  childCloseCallback = null;
  childDataCallback = null;
  spawnCommands.push({ cmd, args });
  return makeMockChild();
}

let originalSpawnImpl: ((...args: any[]) => any) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalSpawnImpl = mockSpawn.getMockImplementation() ?? undefined;
  mockSpawn.mockImplementation(mockSpawnImpl);
  childCloseCallback = null;
  childDataCallback = null;
  spawnCommands = [];
  spawnShouldThrow = false;
});

let platformSpy: Mock | null = null;

function mockPlatform(platform: string): void {
  platformSpy = vi.spyOn(process, 'platform', 'get');
  platformSpy.mockReturnValue(platform);
}

afterEach(() => {
  platformSpy?.mockRestore();
  platformSpy = null;
  if (originalSpawnImpl) {
    mockSpawn.mockImplementation(originalSpawnImpl);
  }
  vi.useRealTimers();
});

// ── Helpers ───────────────────────────────────────────────────────────────

/** Fire the stored data callback followed by a close, settling the pending read. */
function fireData(data: string): void {
  childDataCallback?.(Buffer.from(data));
}

function fireClose(code: number | null): void {
  childCloseCallback?.(code);
}

function commandNames(): string[] {
  return spawnCommands.map((c) => c.cmd);
}

/** Yield to the event loop so pending microtasks (await continuations) run. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

// ── readFromClipboard tests ───────────────────────────────────────────────

describe('readFromClipboard', () => {
  it('reads from pbpaste on macOS', async () => {
    mockPlatform('darwin');
    const promise = readFromClipboard(undefined, { env: {} } as any);
    fireData('mac data');
    fireClose(0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.data).toBe('mac data');
    expect(commandNames()).toEqual(['pbpaste']);
  });

  it('reads from Get-Clipboard on Windows', async () => {
    mockPlatform('win32');
    const promise = readFromClipboard(undefined, { env: {} } as any);
    fireData('win data');
    fireClose(0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.data).toBe('win data');
    expect(commandNames()).toEqual(['powershell']);
  });

  it('reads from wl-paste on Wayland', async () => {
    const promise = readFromClipboard(undefined, {
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    } as any);
    fireData('wayland data');
    fireClose(0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.data).toBe('wayland data');
    expect(commandNames()).toEqual(['wl-paste']);
  });

  it('falls back to xclip on X11 when wl-paste fails', async () => {
    const promise = readFromClipboard(undefined, {
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    } as any);
    fireClose(1); // wl-paste exits non-zero
    await settle(); // let the code spawn xclip and register callbacks
    fireData('x11 data');
    fireClose(0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.data).toBe('x11 data');
    expect(commandNames()).toEqual(['wl-paste', 'xclip']);
  });

  it('falls back to xsel when wl-paste and xclip both fail', async () => {
    const promise = readFromClipboard(undefined, {
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    } as any);
    fireClose(1); // wl-paste fails
    await settle();
    fireClose(1); // xclip fails
    await settle();
    fireData('xsel data'); // xsel succeeds
    fireClose(0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.data).toBe('xsel data');
    expect(commandNames()).toEqual(['wl-paste', 'xclip', 'xsel']);
  });

  it('skips wl-paste when WAYLAND_DISPLAY is unset', async () => {
    const promise = readFromClipboard(undefined, {
      env: { WAYLAND_DISPLAY: undefined },
    } as any);
    fireData('x11 data');
    fireClose(0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.data).toBe('x11 data');
    expect(commandNames()).toEqual(['xclip']);
  });

  it('fails gracefully when no clipboard tool is available', async () => {
    const promise = readFromClipboard(undefined, {
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    } as any);
    fireClose(1); // wl-paste
    await settle();
    fireClose(1); // xclip
    await settle();
    fireClose(1); // xsel
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.data).toBeUndefined();
    expect(commandNames()).toEqual(['wl-paste', 'xclip', 'xsel']);
  });

  it('handles spawn errors gracefully', async () => {
    spawnShouldThrow = true;
    const result = await readFromClipboard(undefined, {
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    } as any);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns pasted text verbatim (multi-line)', async () => {
    const promise = readFromClipboard(undefined, {
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    } as any);
    fireData('line1\nline2\nline3');
    fireClose(0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.data).toBe('line1\nline2\nline3');
  });

  it('returns error when pbpaste fails on darwin', async () => {
    mockPlatform('darwin');
    const promise = readFromClipboard(undefined, { env: {} } as any);
    fireClose(1);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ── copyToClipboard tests ─────────────────────────────────────────────────

describe('copyToClipboard', () => {
  it('succeeds when platform tool succeeds on Linux', async () => {
    const promise = copyToClipboard('test', { env: {} } as any);
    fireClose(0);
    const result = await promise;

    expect(result.success).toBe(true);
  });

  it('returns false when all clipboard tools fail', async () => {
    const promise = copyToClipboard('test', { env: {} } as any);
    fireClose(1); // xclip fails
    await settle();
    fireClose(1); // xsel fails
    const result = await promise;

    expect(result.success).toBe(false);
  });

  it('handles spawn errors gracefully', async () => {
    spawnShouldThrow = true;
    const result = await copyToClipboard('test', { env: {} } as any);

    expect(result.success).toBe(false);
  });
});
