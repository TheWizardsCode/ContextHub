/**
 * Tests for the process lifecycle module (src/process-lifecycle.ts)
 *
 * These tests mock process.kill to verify PID tracking and cleanup behavior
 * without spawning real child processes. The watchdog timer tests use
 * vitest's fake timers for deterministic time control.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── Mock process.kill ───────────────────────────────────────────────
const mockKill = vi.fn<(...args: any[]) => boolean>();

beforeEach(() => {
  mockKill.mockReset();
  // Default: process.kill returns true (signal sent successfully)
  mockKill.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  // Restore original process.kill if we replaced it
  if (process.kill === mockKill) {
    process.kill = originalKill;
  }
  // Shutdown the module to clear watchdog
});

const originalKill = process.kill;

// ── Helper to re-import the module fresh for each test ──────────────
async function freshModule() {
  // Replace process.kill with mock BEFORE importing the module
  process.kill = mockKill as any;
  // Clear any module state by resetting modules
  vi.resetModules();
  const mod = await import('../src/process-lifecycle.js');
  return mod;
}

describe('registerProcess', () => {
  it('registers a PID against a worktree path', async () => {
    const mod = await freshModule();
    mod.registerProcess(1001, '/tmp/worktrees/my-worktree');

    const result = mod.getTrackedProcesses();
    expect(result).toHaveProperty('/tmp/worktrees/my-worktree');
    expect(result['/tmp/worktrees/my-worktree']).toContain(1001);
  });

  it('registers multiple PIDs for the same worktree', async () => {
    const mod = await freshModule();
    mod.registerProcess(1001, '/tmp/worktrees/my-worktree');
    mod.registerProcess(1002, '/tmp/worktrees/my-worktree');
    mod.registerProcess(1003, '/tmp/worktrees/my-worktree');

    const result = mod.getTrackedProcesses();
    expect(result['/tmp/worktrees/my-worktree']).toEqual(
      expect.arrayContaining([1001, 1002, 1003])
    );
    expect(result['/tmp/worktrees/my-worktree']).toHaveLength(3);
  });

  it('registers the same PID under different worktrees', async () => {
    const mod = await freshModule();
    mod.registerProcess(1001, '/tmp/worktrees/a');
    mod.registerProcess(1001, '/tmp/worktrees/b');

    const result = mod.getTrackedProcesses();
    expect(result['/tmp/worktrees/a']).toContain(1001);
    expect(result['/tmp/worktrees/b']).toContain(1001);
  });

  it('ignores duplicate registration of same PID for same worktree', async () => {
    const mod = await freshModule();
    mod.registerProcess(1001, '/tmp/worktrees/wt');
    mod.registerProcess(1001, '/tmp/worktrees/wt');

    const result = mod.getTrackedProcesses();
    expect(result['/tmp/worktrees/wt']).toEqual([1001]);
  });

  it('records registration timestamps for watchdog expiry', async () => {
    const mod = await freshModule();
    const before = Date.now() - 1;
    mod.registerProcess(1001, '/tmp/worktrees/wt');
    const after = Date.now() + 1;

    const meta = mod.getProcessMeta(1001);
    expect(meta).not.toBeNull();
    expect(meta!.registeredAt).toBeGreaterThanOrEqual(before);
    expect(meta!.registeredAt).toBeLessThanOrEqual(after);
    expect(meta!.worktreePath).toBe('/tmp/worktrees/wt');
  });

  it('rejects non-positive PID values', async () => {
    const mod = await freshModule();
    expect(() => mod.registerProcess(-1, '/tmp/wt')).toThrow();
    expect(() => mod.registerProcess(0, '/tmp/wt')).toThrow();
    expect(() => mod.registerProcess(NaN as any, '/tmp/wt')).toThrow();
  });

  it('rejects empty worktree path', async () => {
    const mod = await freshModule();
    expect(() => mod.registerProcess(1001, '')).toThrow();
    expect(() => mod.registerProcess(1001, '   ')).toThrow();
  });
});

describe('killProcessesForWorktree', () => {
  it('kills all tracked PIDs for a given worktree using process groups', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');
    mod.registerProcess(2002, '/tmp/wt');

    mod.killProcessesForWorktree('/tmp/wt');

    // Should try process group kill first (negative PID)
    expect(mockKill).toHaveBeenCalledWith(-2001, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-2002, 'SIGTERM');
  });

  it('uses configured signal', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');

    mod.killProcessesForWorktree('/tmp/wt', 'SIGKILL');

    expect(mockKill).toHaveBeenCalledWith(-2001, 'SIGKILL');
  });

  it('falls back to individual PID kill when process group kill fails with EPERM', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');

    // First call (-2001) throws EPERM, second call (2001) succeeds
    mockKill
      .mockImplementationOnce(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); })
      .mockImplementationOnce(() => true);

    mod.killProcessesForWorktree('/tmp/wt');

    // Should try individual PID after group kill fails
    expect(mockKill).toHaveBeenCalledWith(2001, 'SIGTERM');
  });

  it('falls back to individual PID kill when process group kill fails with ESRCH (no process group)', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');

    mockKill
      .mockImplementationOnce(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); })
      .mockImplementationOnce(() => true);

    mod.killProcessesForWorktree('/tmp/wt');

    expect(mockKill).toHaveBeenCalledWith(2001, 'SIGTERM');
  });

  it('handles individual PID ESRCH gracefully (process already dead)', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');

    // Process group fails, individual PID also fails with ESRCH (already dead)
    mockKill
      .mockImplementationOnce(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); })
      .mockImplementationOnce(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });

    // Should not throw
    expect(() => mod.killProcessesForWorktree('/tmp/wt')).not.toThrow();
  });

  it('handles EPERM on individual PID gracefully (no permission)', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');

    mockKill
      .mockImplementationOnce(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); })
      .mockImplementationOnce(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });

    expect(() => mod.killProcessesForWorktree('/tmp/wt')).not.toThrow();
  });

  it('is a no-op for unknown worktree path', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');

    mod.killProcessesForWorktree('/tmp/nonexistent');

    expect(mockKill).not.toHaveBeenCalled();
  });

  it('is a no-op for worktree with no registered processes', async () => {
    const mod = await freshModule();

    mod.killProcessesForWorktree('/tmp/empty-wt');

    expect(mockKill).not.toHaveBeenCalled();
  });

  it('removes PIDs from registry after successful kill', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');
    mod.registerProcess(2002, '/tmp/wt');

    mod.killProcessesForWorktree('/tmp/wt');

    const result = mod.getTrackedProcesses();
    expect(result['/tmp/wt']).toBeUndefined();
  });

  it('keeps other worktree PIDs untouched when killing one worktree', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt-a');
    mod.registerProcess(3001, '/tmp/wt-b');

    mod.killProcessesForWorktree('/tmp/wt-a');

    const result = mod.getTrackedProcesses();
    expect(result['/tmp/wt-a']).toBeUndefined();
    expect(result['/tmp/wt-b']).toContain(3001);
  });
});

describe('killAllTracked', () => {
  it('kills all tracked processes across all worktrees', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt-a');
    mod.registerProcess(3001, '/tmp/wt-b');
    mod.registerProcess(3002, '/tmp/wt-b');

    mod.killAllTracked();

    // Process group kills for all PIDs
    expect(mockKill).toHaveBeenCalledWith(-2001, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-3001, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-3002, 'SIGTERM');
  });

  it('uses configured signal', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');

    mod.killAllTracked('SIGKILL');

    expect(mockKill).toHaveBeenCalledWith(-2001, 'SIGKILL');
  });

  it('clears all tracking after successful kill', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt');

    mod.killAllTracked();

    expect(mod.getTrackedProcesses()).toEqual({});
  });

  it('is a no-op when nothing is tracked', async () => {
    const mod = await freshModule();
    mod.killAllTracked();
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('handles errors gracefully (continues on failure)', async () => {
    const mod = await freshModule();
    mod.registerProcess(2001, '/tmp/wt-a');
    mod.registerProcess(3001, '/tmp/wt-b');

    // First PID fails with ESRCH, second should still be killed
    mockKill
      .mockImplementationOnce(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); })
      .mockImplementationOnce(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); })
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => true);

    mod.killAllTracked();

    // Both process groups were attempted (even if first failed)
    expect(mockKill).toHaveBeenCalledWith(-2001, 'SIGTERM');
    expect(mockKill).toHaveBeenCalledWith(-3001, 'SIGTERM');
  });
});

describe('Watchdog timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('starts watchdog with default timeout of 10 minutes', async () => {
    const mod = await freshModule();

    expect(mod.getWatchdogTimeout()).toBe(10 * 60 * 1000);
    expect(mod.getWatchdogInterval()).toBe(60_000);  // default check interval
    expect(mod.isWatchdogRunning()).toBe(true);
  });

  it('accepts custom interval and timeout in milliseconds', async () => {
    const mod = await freshModule();

    mod.startWatchdog(5000, 30000); // 5s check, 30s timeout

    expect(mod.getWatchdogInterval()).toBe(5000);
    expect(mod.getWatchdogTimeout()).toBe(30000);
    expect(mod.isWatchdogRunning()).toBe(true);
  });

  it('kills PIDs that exceed the timeout threshold', async () => {
    const mod = await freshModule();
    mod.startWatchdog(100, 100); // check every 100ms, timeout at 100ms

    mod.registerProcess(5001, '/tmp/wt');

    // Advance time past the timeout threshold
    vi.advanceTimersByTime(150);

    // The watchdog should have killed the expired PID
    expect(mockKill).toHaveBeenCalledWith(-5001, 'SIGTERM');
  });

  it('does not kill PIDs within the timeout threshold', async () => {
    const mod = await freshModule();
    mod.startWatchdog(200, 500); // check every 200ms, timeout at 500ms

    mod.registerProcess(5001, '/tmp/wt');

    // Advance only 100ms (well under timeout)
    vi.advanceTimersByTime(100);

    expect(mockKill).not.toHaveBeenCalled();
  });

  it('shutdown stops the watchdog timer', async () => {
    const mod = await freshModule();
    mod.startWatchdog(100, 500);

    expect(mod.isWatchdogRunning()).toBe(true);

    mod.shutdown();
    expect(mod.isWatchdogRunning()).toBe(false);

    // Advance time — should not trigger kills
    vi.advanceTimersByTime(1000);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('shutdown clears tracked processes', async () => {
    const mod = await freshModule();
    mod.registerProcess(5001, '/tmp/wt');

    mod.shutdown();

    expect(mod.getTrackedProcesses()).toEqual({});
  });

  it('watchdog start is idempotent (does not create multiple timers)', async () => {
    const mod = await freshModule();

    mod.startWatchdog(100, 100);
    mod.startWatchdog(100, 100);
    mod.startWatchdog(100, 100);
    mod.startWatchdog(100, 100);

    // Should not throw
    mod.registerProcess(5001, '/tmp/wt');
    vi.advanceTimersByTime(150);

    // Should still work
    expect(mockKill).toHaveBeenCalledWith(-5001, 'SIGTERM');
    // Only called once for this PID (group kill only, no fallback needed)
    expect(mockKill).toHaveBeenCalledTimes(1);
  });

  it('only kills processes older than the configured timeout, not all', async () => {
    const mod = await freshModule();
    mod.startWatchdog(100, 200); // timeout = 200ms

    mod.registerProcess(5001, '/tmp/wt');
    vi.advanceTimersByTime(100); // 100ms elapsed - not yet expired

    mod.registerProcess(5002, '/tmp/wt');

    vi.advanceTimersByTime(150); // 250ms total - 5001 expired, 5002 not yet (150ms)

    // 5001 should have been killed
    expect(mockKill).toHaveBeenCalledWith(-5001, 'SIGTERM');
    // 5002 should NOT have been killed (only 150ms old, timeout is 200ms)
    expect(mockKill).not.toHaveBeenCalledWith(-5002, expect.any(String));
  });
});

describe('Edge cases', () => {
  it('getTrackedProcesses returns empty object when nothing is tracked', async () => {
    const mod = await freshModule();
    expect(mod.getTrackedProcesses()).toEqual({});
  });

  it('getProcessMeta returns null for unknown PID', async () => {
    const mod = await freshModule();
    const meta = mod.getProcessMeta(99999);
    expect(meta).toBeNull();
  });
});
