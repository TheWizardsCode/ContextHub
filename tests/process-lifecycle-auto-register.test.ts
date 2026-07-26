/**
 * Tests for CLI and exec auto-registration (WL-0MRTSOTF1002I8WZ)
 *
 * Tests that:
 * - `createTrackedExec` wraps an exec function to register PIDs
 * - `detectWorktreeFromCwd` detects if inside a worktree
 * - CLI entry-point registration works (simulated)
 * - `withinWorktreeContext` / `contextExec` work correctly
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ── Mock process.kill ───────────────────────────────────────────────
const mockKill = vi.fn<(...args: any[]) => boolean>();

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

const originalKill = process.kill;

// ── Shared ──────────────────────────────────────────────────────────
async function freshModule() {
  vi.resetModules();
  const mod = await import('../src/process-lifecycle.js');
  return mod;
}

describe('detectWorktreeFromCwd', () => {
  it('returns null for a non-worktree path', async () => {
    const mod = await freshModule();
    const result = mod.detectWorktreeFromCwd('/home/user/projects/my-project');
    expect(result).toBeNull();
  });

  it('detects a worktree path inside .worklog/worktrees/', async () => {
    const mod = await freshModule();
    const result = mod.detectWorktreeFromCwd(
      '/home/user/projects/my-project/.worklog/worktrees/wl-ABC123-feature-branch'
    );
    expect(result).toBe(
      '/home/user/projects/my-project/.worklog/worktrees/wl-ABC123-feature-branch'
    );
  });

  it('detects a .worklog/worktrees/ path with nested dirs', async () => {
    const mod = await freshModule();
    const result = mod.detectWorktreeFromCwd(
      '/repo/.worklog/worktrees/wl-ABC/some/deep/dir'
    );
    expect(result).toBe('/repo/.worklog/worktrees/wl-ABC');
  });

  it('returns null for a plain .worklog/ path (not a worktree)', async () => {
    const mod = await freshModule();
    const result = mod.detectWorktreeFromCwd('/repo/.worklog');
    expect(result).toBeNull();
  });

  it('uses process.cwd() when no explicit cwd provided', async () => {
    const mod = await freshModule();
    const result = mod.detectWorktreeFromCwd();
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});

describe('createTrackedExec', () => {
  it('returns a function with execAsync-like signature', async () => {
    const mod = await freshModule();
    const trackedExec = mod.createTrackedExec('/tmp/worktrees/wt');
    expect(typeof trackedExec).toBe('function');
    expect(trackedExec.length).toBe(2); // (command, options?)
  });

  it('registers the child PID before execution completes', async () => {
    const mod = await freshModule();
    const trackedExec = mod.createTrackedExec('/tmp/worktrees/wt');

    const result = await trackedExec('echo "hello"');

    expect(result.stdout.trim()).toBe('hello');

    const processes = mod.getTrackedProcesses();
    expect(processes['/tmp/worktrees/wt']).toBeDefined();
    expect(processes['/tmp/worktrees/wt'].length).toBe(1);
  });

  it('does not register when worktreePath is null', async () => {
    const mod = await freshModule();
    const trackedExec = mod.createTrackedExec(null);

    await trackedExec('echo "no tracking"');

    const processes = mod.getTrackedProcesses();
    expect(Object.keys(processes).length).toBe(0);
  });

  it('registers multiple concurrent executions for the same worktree', async () => {
    const mod = await freshModule();
    const trackedExec = mod.createTrackedExec('/tmp/worktrees/a');

    await Promise.all([
      trackedExec('echo "a"'),
      trackedExec('echo "b"'),
      trackedExec('echo "c"'),
    ]);

    const processes = mod.getTrackedProcesses();
    expect(processes['/tmp/worktrees/a'].length).toBe(3);
  });

  it('captures stdout from executed commands', async () => {
    const mod = await freshModule();
    const trackedExec = mod.createTrackedExec('/tmp/worktrees/wt');

    const result = await trackedExec('echo "stdout"');

    expect(result.stdout).toContain('stdout');
    expect(result.exitCode).toBe(0);
  });

  it('rejects when the command fails', async () => {
    const mod = await freshModule();
    const trackedExec = mod.createTrackedExec('/tmp/worktrees/wt');

    await expect(trackedExec('false')).rejects.toThrow();
  });

  it('can kill registered processes via killProcessesForWorktree', async () => {
    const mod = await freshModule();
    const trackedExec = mod.createTrackedExec('/tmp/worktrees/wt');

    await trackedExec('echo "killable"');

    mod.killProcessesForWorktree('/tmp/worktrees/wt');

    expect(mockKill).toHaveBeenCalled();
  });
});

describe('CLI PID registration', () => {
  it('registers the current PID when called with a worktree path', async () => {
    const mod = await freshModule();
    const pid = process.pid;

    mod.registerCurrentProcess('/tmp/worktrees/cli-wt');

    const meta = mod.getProcessMeta(pid);
    expect(meta).not.toBeNull();
    expect(meta!.worktreePath).toBe('/tmp/worktrees/cli-wt');
  });
});

describe('withinWorktreeContext', () => {
  it('sets context so contextExec registers PIDs', async () => {
    const mod = await freshModule();
    const worktreePath = '/tmp/worktrees/wt';

    const restore = mod.withinWorktreeContext(worktreePath);

    await mod.contextExec('echo "context works"');

    const processes = mod.getTrackedProcesses();
    expect(processes[worktreePath]).toBeDefined();

    restore();
  });

  it('does not register after context is restored', async () => {
    const mod = await freshModule();
    const worktreePath = '/tmp/worktrees/wt2';

    const restore = mod.withinWorktreeContext(worktreePath);
    restore();

    await mod.contextExec('echo "after restore"');

    const processes = mod.getTrackedProcesses();
    expect(processes[worktreePath]).toBeUndefined();
  });

  it('supports nested contexts (stack-based)', async () => {
    const mod = await freshModule();

    const restore1 = mod.withinWorktreeContext('/tmp/wt/a');
    const restore2 = mod.withinWorktreeContext('/tmp/wt/b');

    // Should use innermost context
    await mod.contextExec('echo "inner"');

    const processes = mod.getTrackedProcesses();
    expect(processes['/tmp/wt/b']).toBeDefined();
    expect(processes['/tmp/wt/a']).toBeUndefined();

    restore2();
    restore1();
  });
});
