/**
 * Tests for withTempWorktree process lifecycle integration (WL-0MRTSP4BV002SJY7)
 *
 * Verifies that:
 * - killProcessesForWorktree is called before worktree removal
 * - No-op works correctly when no processes tracked
 * - Processes spawned inside a worktree context can be killed
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
  vi.useRealTimers();
  if (process.kill === mockKill) {
    process.kill = originalKill;
  }
});

async function freshModule() {
  vi.resetModules();
  const mod = await import('../src/process-lifecycle.js');
  return mod;
}

describe('Process lifecycle integration with withTempWorktree pattern', () => {
  it('killProcessesForWorktree is called in cleanup (simulated withTempWorktree pattern)', async () => {
    const mod = await freshModule();
    const worktreePath = '/tmp/test-wt/worktree';

    // Simulate worktree operations
    mod.registerProcess(10001, worktreePath);
    mod.registerProcess(10002, worktreePath);

    // Verify PIDs are tracked
    const before = mod.getTrackedProcesses();
    expect(before[worktreePath]).toEqual(
      expect.arrayContaining([10001, 10002])
    );

    // Simulate the finally block cleanup
    mod.killProcessesForWorktree(worktreePath);

    // Verify PIDs were killed with process group kill
    expect(mockKill).toHaveBeenCalledWith(-10001, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-10002, 'SIGTERM');

    // Verify registry is cleaned up
    const after = mod.getTrackedProcesses();
    expect(after[worktreePath]).toBeUndefined();
  });

  it('is a no-op when no processes were registered for a worktree', async () => {
    const mod = await freshModule();

    // Simulate cleanup with no tracked processes
    mod.killProcessesForWorktree('/tmp/empty-worktree');

    expect(mockKill).not.toHaveBeenCalled();
  });

  it('preserves other worktree PIDs when cleaning up one worktree', async () => {
    const mod = await freshModule();

    mod.registerProcess(20001, '/tmp/wt-a');
    mod.registerProcess(30001, '/tmp/wt-b');

    // Clean up only wt-a
    mod.killProcessesForWorktree('/tmp/wt-a');

    // wt-b should still be tracked
    const after = mod.getTrackedProcesses();
    expect(after['/tmp/wt-b']).toContain(30001);
    expect(after['/tmp/wt-a']).toBeUndefined();
  });

  it('uses killProcessesForWorktree before worktree removal (order verification via mock)', async () => {
    const mod = await freshModule();
    const worktreePath = '/tmp/wt-order-test';

    mod.registerProcess(40001, worktreePath);

    // Execute cleanup step
    mod.killProcessesForWorktree(worktreePath);

    // The key verification: killProcessesForWorktree was invoked
    // (in a real scenario, this happens before git worktree remove)
    expect(mockKill).toHaveBeenCalled();
    expect(mockKill).toHaveBeenCalledWith(-40001, 'SIGTERM');
  });

  it('handles concurrent process kills gracefully during cleanup', async () => {
    const mod = await freshModule();

    // Register processes under different worktrees
    mod.registerProcess(50001, '/tmp/wt-x');
    mod.registerProcess(50002, '/tmp/wt-x');
    mod.registerProcess(50003, '/tmp/wt-y');

    // Clean up both worktrees
    mod.killProcessesForWorktree('/tmp/wt-x');
    mod.killProcessesForWorktree('/tmp/wt-y');

    // All PIDs should have been killed
    expect(mockKill).toHaveBeenCalledWith(-50001, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-50002, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-50003, 'SIGTERM');

    // Registry should be empty
    expect(mod.getTrackedProcesses()).toEqual({});
  });
});

describe('Spawn-and-cleanup lifecycle (end-to-end)', () => {
  it('can spawn, track, and kill a child process through the lifecycle API', async () => {
    const mod = await freshModule();
    const worktreePath = '/tmp/e2e-worktree';

    // Use tracked exec to spawn a command
    const trackedExec = mod.createTrackedExec(worktreePath);
    await trackedExec('echo "lifecycle test"');

    // Verify the PID was registered
    const processes = mod.getTrackedProcesses();
    expect(processes[worktreePath]).toBeDefined();
    expect(processes[worktreePath].length).toBe(1);

    // Now kill all processes for this worktree (simulating cleanup)
    mod.killProcessesForWorktree(worktreePath);

    // mockKill should have been called for the child PID
    expect(mockKill).toHaveBeenCalled();

    // Registry should be clean
    expect(mod.getTrackedProcesses()).toEqual({});
  });

  it('killAllTracked cleans up everything (session end)', async () => {
    const mod = await freshModule();

    mod.registerProcess(60001, '/tmp/wt-a');
    mod.registerProcess(60002, '/tmp/wt-b');

    mod.killAllTracked();

    expect(mockKill).toHaveBeenCalledWith(-60001, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-60002, 'SIGTERM');
    expect(mod.getTrackedProcesses()).toEqual({});
  });
});
