/**
 * Shared child_process mock store (globalThis-based).
 *
 * All test files that mock `child_process` use the same mock instances,
 * eliminating vitest module cache conflicts when factories from different
 * files reference different variable names.
 *
 * Mock instances are stored on `globalThis` (initChildProcessMocks is called
 * in setup-tests.ts, which runs before any test file). Test files access them
 * via `vi.hoisted()` without any static imports.
 *
 * Usage in a test file:
 * ```ts
 * // No import needed! Use vi.hoisted to access the global store:
 * const { mockSpawn, mockExecSync, mockSpawnSync } =
 *   vi.hoisted(() => (globalThis as any).__sharedChildProcessMocks);
 * vi.mock('child_process', () => ({ spawn: mockSpawn, ... }));
 * ```
 */

import { vi } from 'vitest';

const STORE_KEY = '__sharedChildProcessMocks';

interface MockStore {
  mockSpawn: ReturnType<typeof vi.fn>;
  mockExecSync: ReturnType<typeof vi.fn>;
  mockSpawnSync: ReturnType<typeof vi.fn>;
}

/**
 * Initialize (or re-retrieve) the shared mock instances on globalThis.
 * Called from setup-tests.ts (runs before each test file).
 *
 * Safe to call multiple times — returns the existing store on subsequent calls.
 */
export function initChildProcessMocks(): MockStore {
  if (!(globalThis as any)[STORE_KEY]) {
    (globalThis as any)[STORE_KEY] = {
      mockSpawn: vi.fn(),
      mockExecSync: vi.fn(),
      mockSpawnSync: vi.fn(),
    };
  }
  return (globalThis as any)[STORE_KEY] as MockStore;
}
