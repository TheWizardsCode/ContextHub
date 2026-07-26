/**
 * Tests for wl cleanup-worktree command (WL-0MRTSPCNZ001XWRN)
 *
 * Tests the command logic by calling killProcessesForWorktree and
 * killAllTracked directly through the process-lifecycle module.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const mockKill = vi.fn<(...args: any[]) => boolean>();
const originalKill = process.kill;

beforeEach(() => {
  mockKill.mockReset();
  mockKill.mockReturnValue(true);
  process.kill = mockKill as any;
});

afterEach(() => {
  if (process.kill === mockKill) {
    process.kill = originalKill;
  }
});

async function freshModule() {
  vi.resetModules();
  const mod = await import('../src/process-lifecycle.js');
  return mod;
}

describe('cleanup-worktree command logic (through process-lifecycle)', () => {
  it('kills tracked processes for a single worktree path', async () => {
    const mod = await freshModule();
    const wtPath = '/tmp/worktrees/wl-ABC123';

    // Register processes
    mod.registerProcess(1001, wtPath);
    mod.registerProcess(1002, wtPath);

    expect(Object.keys(mod.getTrackedProcesses()).length).toBe(1);

    // Simulate: wl cleanup-worktree /tmp/worktrees/wl-ABC123
    mod.killProcessesForWorktree(wtPath);

    // Verify kill was called with process group
    expect(mockKill).toHaveBeenCalledWith(-1001, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-1002, 'SIGTERM');
    expect(Object.keys(mod.getTrackedProcesses()).length).toBe(0);
  });

  it('uses SIGKILL when --force is specified', async () => {
    const mod = await freshModule();

    mod.registerProcess(3001, '/tmp/wt');

    // Simulate: wl cleanup-worktree /tmp/wt --force
    mod.killProcessesForWorktree('/tmp/wt', 'SIGKILL');

    expect(mockKill).toHaveBeenCalledWith(-3001, 'SIGKILL');
  });

  it('--all kills tracked processes for all worktrees', async () => {
    const mod = await freshModule();

    mod.registerProcess(2001, '/tmp/wt-a');
    mod.registerProcess(2002, '/tmp/wt-b');

    // Simulate: wl cleanup-worktree --all
    mod.killAllTracked();

    expect(mockKill).toHaveBeenCalledWith(-2001, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-2002, 'SIGTERM');
    expect(Object.keys(mod.getTrackedProcesses()).length).toBe(0);
  });

  it('--all with --force uses SIGKILL', async () => {
    const mod = await freshModule();

    mod.registerProcess(4001, '/tmp/wt');

    // Simulate: wl cleanup-worktree --all --force
    mod.killAllTracked('SIGKILL');

    expect(mockKill).toHaveBeenCalledWith(-4001, 'SIGKILL');
  });

  it('is a no-op when no processes are tracked for a path', async () => {
    const mod = await freshModule();

    // No processes registered
    mod.killProcessesForWorktree('/tmp/nonexistent');

    expect(mockKill).not.toHaveBeenCalled();
  });

  it('is a no-op when --all and nothing tracked', async () => {
    const mod = await freshModule();

    mod.killAllTracked();

    expect(mockKill).not.toHaveBeenCalled();
  });

  it('only affects the specified worktree, not others', async () => {
    const mod = await freshModule();

    mod.registerProcess(5001, '/tmp/wt-a');
    mod.registerProcess(5002, '/tmp/wt-b');

    // Cleanup only wt-a
    mod.killProcessesForWorktree('/tmp/wt-a');

    expect(mockKill).toHaveBeenCalledWith(-5001, 'SIGTERM');
    expect(mockKill).not.toHaveBeenCalledWith(-5002, 'SIGTERM');

    const remaining = mod.getTrackedProcesses();
    expect(remaining['/tmp/wt-b']).toContain(5002);
  });
});

describe('cleanup-worktree integration with auto-registered processes', () => {
  it('kills processes spawned via createTrackedExec', async () => {
    const mod = await freshModule();
    const wtPath = '/tmp/worktrees/wl-INTEGRATION';

    // Spawn a process via tracked exec
    const trackedExec = mod.createTrackedExec(wtPath);
    await trackedExec('echo "tracked process"');

    // Verify it's registered
    expect(mod.getTrackedProcesses()[wtPath].length).toBe(1);

    // Kill via cleanup-worktree pattern
    mod.killProcessesForWorktree(wtPath);

    expect(mockKill).toHaveBeenCalled();
    expect(Object.keys(mod.getTrackedProcesses()).length).toBe(0);
  });

  it('getTrackedProcesses returns correct state for status display', async () => {
    const mod = await freshModule();

    // No processes yet
    expect(mod.getTrackedProcesses()).toEqual({});

    mod.registerProcess(6001, '/tmp/wt');

    const processes = mod.getTrackedProcesses();
    expect(processes['/tmp/wt']).toContain(6001);
  });
});
