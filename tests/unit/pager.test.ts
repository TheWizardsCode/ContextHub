import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared child_process mock (stored on globalThis by setup-tests.ts).
// The factory reads from the global store directly — no vi.hoisted needed.
// Only test files that need the mock register it here.
vi.mock('child_process', () => {
  const store = (globalThis as any).__sharedChildProcessMocks;
  return {
    spawn: vi.fn(),
    spawnSync: store?.mockSpawnSync ?? vi.fn(),
    execSync: vi.fn(),
  };
});

// Import shared mock instances for use in test bodies.
import { initChildProcessMocks } from '../child-process-mocks.js';
const { mockSpawnSync } = initChildProcessMocks();

import pageOutput from '../../src/pager.js';

describe('pager', () => {
  let origIsTTY: any;
  let origRows: any;
  let writeSpy: any;

  beforeEach(() => {
    origIsTTY = process.stdout.isTTY;
    origRows = (process.stdout as any).rows;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as any);
    // Reset and set default implementation for the shared mock.
    // Each test can override this via mockSpawnSync.mockImplementationOnce etc.
    mockSpawnSync.mockReset();
    mockSpawnSync.mockImplementation(() => ({ status: 0 } as any));
  });

  afterEach(() => {
    process.stdout.isTTY = origIsTTY;
    (process.stdout as any).rows = origRows;
    writeSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('writes directly when not a TTY', () => {
    process.stdout.isTTY = false as any;
    pageOutput('hello\nworld\n');
    expect(writeSpy).toHaveBeenCalled();
  });

  it('does not spawn pager when content fits terminal', () => {
    process.stdout.isTTY = true as any;
    (process.stdout as any).rows = 10;
    pageOutput('line1\nline2\n');
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
  });

  it('spawns pager when content exceeds terminal rows', () => {
    process.stdout.isTTY = true as any;
    (process.stdout as any).rows = 1;
    pageOutput('line1\nline2\nline3\n');
    expect(mockSpawnSync).toHaveBeenCalled();
  });

  it('respects noPager flag', () => {
    process.stdout.isTTY = true as any;
    (process.stdout as any).rows = 1;
    pageOutput('line1\nline2\n', { noPager: true });
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
  });
});
