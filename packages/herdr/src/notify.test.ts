/**
 * packages/herdr/src/notify.test.ts — Unit tests for the fire-and-forget
 * Herdr toast notification wrapper (WL-0MSACL482002RNYH).
 *
 * Uses the shared child_process mock store (tests/child-process-mocks.ts)
 * to avoid vitest module cache conflicts.
 *
 * Run: npx vitest run packages/herdr/src/notify.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Access the shared child_process mocks (installed by tests/setup-tests.ts)
const { mockSpawn } = vi.hoisted(() => {
  const store = (globalThis as any).__sharedChildProcessMocks;
  return { mockSpawn: store.mockSpawn };
});

// Now import the module under test
import { showToast } from './notify.js';

// ── Mock spawn control ───────────────────────────────────────────────

let spawnShouldThrow = false;
let childErrorCallback: (() => void) | null = null;
let capturedChild: { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> } | null = null;

beforeEach(() => {
  spawnShouldThrow = false;
  childErrorCallback = null;
  capturedChild = null;
  mockSpawn.mockImplementation((() => {
    if (spawnShouldThrow) {
      throw new Error('spawn failed');
    }
    childErrorCallback = null;
    const child = {
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'error') {
          childErrorCallback = cb;
        }
        return child;
      }),
      unref: vi.fn(),
    };
    capturedChild = child;
    return child;
  }) as any);
});

afterEach(() => {
  mockSpawn.mockRestore();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// showToast
// ---------------------------------------------------------------------------

describe('showToast', () => {
  it('spawns `herdr notification show <title>` with default bottom-right position', () => {
    showToast('Refreshed');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      'herdr',
      ['notification', 'show', 'Refreshed', '--position', 'bottom-right'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('includes --body when provided', () => {
    showToast('Sync failed', { body: 'lock held' });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      'herdr',
      ['notification', 'show', 'Sync failed', '--body', 'lock held', '--position', 'bottom-right'],
      expect.anything(),
    );
  });

  it('uses the configured position when provided', () => {
    showToast('Refreshed', { position: 'top-right' });
    expect(mockSpawn).toHaveBeenCalledWith(
      'herdr',
      ['notification', 'show', 'Refreshed', '--position', 'top-right'],
      expect.anything(),
    );
  });

  it('registers a no-op error handler on the child (ENOENT tolerance)', () => {
    showToast('Refreshed');
    expect(capturedChild).not.toBeNull();
    expect(capturedChild!.on).toHaveBeenCalledWith('error', expect.any(Function));
    // Firing the error handler must not throw (missing binary tolerated)
    expect(() => childErrorCallback?.()).not.toThrow();
  });

  it('does not throw when spawn itself throws', () => {
    spawnShouldThrow = true;
    expect(() => showToast('Refreshed')).not.toThrow();
  });

  it('does not keep the node process alive (child unref called)', () => {
    showToast('Refreshed');
    expect(capturedChild).not.toBeNull();
    expect(capturedChild!.unref).toHaveBeenCalled();
  });
});
