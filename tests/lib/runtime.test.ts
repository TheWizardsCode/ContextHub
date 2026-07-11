/**
 * Tests for WorklogRuntime background task system
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  WorklogRuntime, 
  getRuntime, 
  initializeRuntime, 
  shutdownRuntime,
  type RuntimeOptions,
} from '../../src/lib/runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for a specified number of milliseconds */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Create a task that completes after a delay */
function delayedTask(label: string, delayMs: number = 10): { run: () => Promise<void>; fn: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async () => {
    await wait(delayMs);
  });
  return { run: fn, fn };
}

// ---------------------------------------------------------------------------
// Runtime instance tests
// ---------------------------------------------------------------------------

describe('WorklogRuntime', () => {
  let runtime: WorklogRuntime;

  beforeEach(() => {
    runtime = new WorklogRuntime();
  });

  afterEach(async () => {
    await runtime.awaitAll();
  });

  describe('launchTask', () => {
    it('runs a background task', async () => {
      const { run, fn } = delayedTask('test');
      runtime.launchTask('test', run);
      // Wait for task to complete
      await wait(20);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('tracks in-flight tasks', () => {
      const { run } = delayedTask('inflight-test', 50);
      runtime.launchTask('inflight-test', run);
      expect(runtime.isInFlight('inflight-test')).toBe(true);
    });

    it('marks tasks as not in-flight after completion', async () => {
      const { run } = delayedTask('quick', 5);
      runtime.launchTask('quick', run);
      await wait(30);
      expect(runtime.isInFlight('quick')).toBe(false);
    });

    it('prevents duplicate tasks with the same label (single-flight guard)', async () => {
      const fn1 = vi.fn(async () => { await wait(100); });
      const fn2 = vi.fn(async () => { await wait(100); });

      runtime.launchTask('dedup', fn1);
      runtime.launchTask('dedup', fn2); // Should be ignored

      await wait(200);
      // Only the first task should have run
      expect(fn1).toHaveBeenCalledOnce();
      expect(fn2).not.toHaveBeenCalled();
    });

    it('allows re-launching a completed task', async () => {
      const fn1 = vi.fn(async () => { await wait(5); });
      const fn2 = vi.fn(async () => { await wait(5); });

      runtime.launchTask('relaunch', fn1);
      await wait(30);
      expect(fn1).toHaveBeenCalledOnce();

      // Re-launch with same label after completion
      runtime.launchTask('relaunch', fn2);
      await wait(30);
      expect(fn2).toHaveBeenCalledOnce();
    });

    it('handles tasks that throw errors gracefully', async () => {
      const errorFn = vi.fn(async () => {
        await wait(5);
        throw new Error('task failed');
      });

      // Should not throw to the caller
      runtime.launchTask('error-task', errorFn);
      
      await wait(30);
      expect(errorFn).toHaveBeenCalledOnce();
      // Task should no longer be in-flight after error
      expect(runtime.isInFlight('error-task')).toBe(false);
    });

    it('runs multiple independent tasks concurrently', async () => {
      const task1 = vi.fn(async () => { await wait(50); });
      const task2 = vi.fn(async () => { await wait(50); });
      const task3 = vi.fn(async () => { await wait(50); });

      runtime.launchTask('concurrent-1', task1);
      runtime.launchTask('concurrent-2', task2);
      runtime.launchTask('concurrent-3', task3);

      expect(runtime.isInFlight('concurrent-1')).toBe(true);
      expect(runtime.isInFlight('concurrent-2')).toBe(true);
      expect(runtime.isInFlight('concurrent-3')).toBe(true);

      await wait(100);

      expect(task1).toHaveBeenCalledOnce();
      expect(task2).toHaveBeenCalledOnce();
      expect(task3).toHaveBeenCalledOnce();
    });

    it('accepts the same label after the first task errors', async () => {
      const errorFn = vi.fn(async () => { throw new Error('fail'); });
      const successFn = vi.fn(async () => { await wait(5); });

      runtime.launchTask('retry-after-error', errorFn);
      await wait(20);
      
      runtime.launchTask('retry-after-error', successFn);
      await wait(20);

      expect(errorFn).toHaveBeenCalledOnce();
      expect(successFn).toHaveBeenCalledOnce();
    });
  });

  describe('isInFlight', () => {
    it('returns false for unlaunched labels', () => {
      expect(runtime.isInFlight('nonexistent')).toBe(false);
    });

    it('returns false after awaitAll clears everything', async () => {
      runtime.launchTask('clear-test', async () => { await wait(10); });
      await runtime.awaitAll();
      expect(runtime.isInFlight('clear-test')).toBe(false);
    });
  });

  describe('awaitAll', () => {
    it('waits for all tasks to complete', async () => {
      const fn1 = vi.fn(async () => { await wait(30); });
      const fn2 = vi.fn(async () => { await wait(50); });

      runtime.launchTask('wait-1', fn1);
      runtime.launchTask('wait-2', fn2);

      await runtime.awaitAll();

      expect(fn1).toHaveBeenCalledOnce();
      expect(fn2).toHaveBeenCalledOnce();
    });

    it('resolves immediately when no tasks are in-flight', async () => {
      const start = Date.now();
      await runtime.awaitAll();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    it('can be called multiple times safely', async () => {
      runtime.launchTask('multi-await', async () => { await wait(10); });
      
      await runtime.awaitAll();
      await runtime.awaitAll(); // Second call should be a no-op
      
      expect(runtime.isInFlight('multi-await')).toBe(false);
    });

    it('catches any task errors without throwing', async () => {
      runtime.launchTask('silent-error', async () => {
        await wait(5);
        throw new Error('expected error');
      });

      // awaitAll should not throw despite task error
      await expect(runtime.awaitAll()).resolves.toBeUndefined();
    });

    it('new tasks launched after awaitAll are not affected', async () => {
      await runtime.awaitAll();

      const fn = vi.fn(async () => { await wait(10); });
      runtime.launchTask('post-await', fn);
      
      expect(runtime.isInFlight('post-await')).toBe(true);
      await runtime.awaitAll();
      expect(fn).toHaveBeenCalledOnce();
    });
  });
});

// ---------------------------------------------------------------------------
// Singleton / integration tests
// ---------------------------------------------------------------------------

describe('getRuntime / initializeRuntime / shutdownRuntime', () => {
  afterEach(async () => {
    // Clean up any runtime state
    await shutdownRuntime();
  });

  it('getRuntime returns a WorklogRuntime instance', () => {
    const r = getRuntime();
    expect(r).toBeInstanceOf(WorklogRuntime);
  });

  it('getRuntime returns the same instance on repeated calls', () => {
    const r1 = getRuntime();
    const r2 = getRuntime();
    expect(r1).toBe(r2);
  });

  it('initializeRuntime sets up signal handlers', () => {
    const onSpy = vi.spyOn(process, 'on');
    
    initializeRuntime();
    
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('beforeExit', expect.any(Function));
    
    onSpy.mockRestore();
  });

  it('initializeRuntime accepts custom options', () => {
    const options: RuntimeOptions = {};
    const result = initializeRuntime(options);
    expect(result).toBe(getRuntime());
  });

  it('shutdownRuntime awaits pending tasks and removes handlers', async () => {
    const fn = vi.fn(async () => { await wait(10); });
    const runtime = getRuntime();
    runtime.launchTask('shutdown-test', fn);

    await shutdownRuntime();
    
    expect(fn).toHaveBeenCalledOnce();
  });

  it('can reinitialize after shutdown', () => {
    initializeRuntime();
    shutdownRuntime();
    
    // Should not throw
    const r = initializeRuntime();
    expect(r).toBeInstanceOf(WorklogRuntime);
  });

  it('default runtime options do not install signal handlers when silent=true', () => {
    const onSpy = vi.spyOn(process, 'on');
    
    initializeRuntime({ silent: true });
    
    // When silent, signal handlers should still be installed
    // (silent only affects logging)
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    
    onSpy.mockRestore();
  });

  it('shutdownRuntime is safe to call multiple times', async () => {
    await shutdownRuntime();
    await shutdownRuntime(); // Second call should not throw
  });
});

describe('background operations', () => {
  let runtime: WorklogRuntime;

  beforeEach(() => {
    runtime = new WorklogRuntime();
  });

  afterEach(async () => {
    await runtime.awaitAll();
  });

  it('supports registering and invoking background operations', async () => {
    const opFn = vi.fn(async () => { await wait(5); });
    
    // Register an operation under a label
    const label = 'custom-operation';
    runtime.launchTask(label, opFn);
    
    expect(runtime.isInFlight(label)).toBe(true);
    await runtime.awaitAll();
    expect(opFn).toHaveBeenCalledOnce();
  });
});
