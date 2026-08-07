/**
 * packages/herdr/src/scheduler.test.ts — Unit tests for the single-loop
 * task scheduler (WL-0MSG4NMF0000YBRP).
 *
 * The scheduler drives ALL periodic plugin work (auto-refresh, auto-sync,
 * visibility resume-poll, and future downtime-worker ticks) through one
 * `setInterval`. Tests cover due-work dispatch, independent intervals,
 * fire-immediately tasks, disable/enable (the mechanism behind
 * pause-when-hidden), single-flight (no overlapping runs, skipped ticks are
 * not coalesced), disabled 0-interval tasks, and stop().
 *
 * Run: npx vitest run packages/herdr/src/scheduler.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskScheduler, DEFAULT_SCHEDULER_TICK_MS } from './scheduler.js';

describe('TaskScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('due-work dispatch', () => {
    it('fires a task when its interval elapses, then repeats at the same cadence', async () => {
      const run = vi.fn();
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 30_000, run });
      scheduler.start();

      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(run).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000); // t=30s
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000); // t=60s
      expect(run).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });

    it('dispatches independent tasks at their own deadlines', async () => {
      const fast = vi.fn();
      const slow = vi.fn();
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'fast', intervalMs: 2_000, run: fast });
      scheduler.addTask({ id: 'slow', intervalMs: 5_000, run: slow });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(4_000);
      expect(fast).toHaveBeenCalledTimes(2); // t=2s, t=4s
      expect(slow).toHaveBeenCalledTimes(0);

      await vi.advanceTimersByTimeAsync(1_000); // t=5s
      expect(slow).toHaveBeenCalledTimes(1);
      expect(fast).toHaveBeenCalledTimes(2); // t=6s not reached

      scheduler.stop();
    });

    it('is a no-op when start() is called multiple times', async () => {
      const run = vi.fn();
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 2_000, run });
      scheduler.start();
      scheduler.start();
      scheduler.start();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(run).toHaveBeenCalledTimes(1); // not 3

      scheduler.stop();
    });
  });

  describe('fireImmediately', () => {
    it('runs fireImmediately tasks once on start(), then at the interval', async () => {
      const run = vi.fn();
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'sync', intervalMs: 60_000, run, fireImmediately: true });
      scheduler.start();

      expect(run).toHaveBeenCalledTimes(1); // immediate first tick

      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });

    it('does not run a fireImmediately task that is disabled at start', async () => {
      const run = vi.fn();
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({
        id: 'poll',
        intervalMs: 2_000,
        run,
        fireImmediately: true,
        disabled: true,
      });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(4_000);
      expect(run).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  describe('disable / enable (hidden-pane skipping mechanism)', () => {
    it('skips a disabled task; enabling it arms it from the next interval', async () => {
      const run = vi.fn();
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'poll', intervalMs: 2_000, run, disabled: true });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).not.toHaveBeenCalled(); // disabled → never fires

      scheduler.setDisabled('poll', false);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(run).not.toHaveBeenCalled(); // armed from enable time

      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);

      // Disabling again stops it; re-enabling restarts the cadence.
      scheduler.setDisabled('poll', true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).toHaveBeenCalledTimes(1);

      scheduler.stop();
    });

    it('setDisabled on an unknown id is a safe no-op', () => {
      const scheduler = new TaskScheduler(1000);
      expect(() => scheduler.setDisabled('nope', true)).not.toThrow();
      expect(() => scheduler.setDisabled('nope', false)).not.toThrow();
    });
  });

  describe('single-flight', () => {
    it('skips a tick whose previous run is still pending, and does not coalesce it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const run = vi.fn(() => gate);

      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 30_000, run, singleFlight: true });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(1); // first tick starts (pending)

      // Next tick while pending: skipped (not coalesced) — next run only at
      // the following interval boundary after the pending run settles.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1); // settling does not re-fire

      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });

    it('runs overlapping ticks when singleFlight is false', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const run = vi.fn(() => gate);

      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 2_000, run });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(run).toHaveBeenCalledTimes(1);

      // Without singleFlight the second tick fires even though the first
      // run is still pending.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(run).toHaveBeenCalledTimes(2);

      release();
      await vi.advanceTimersByTimeAsync(0);
      scheduler.stop();
    });
  });

  describe('error resilience', () => {
    it('a rejecting task does not crash the loop and still runs on later ticks', async () => {
      const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 2_000, run });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(run).toHaveBeenCalledTimes(1); // rejected, but loop survives

      await vi.advanceTimersByTimeAsync(2_000);
      expect(run).toHaveBeenCalledTimes(2); // cadence resumes

      scheduler.stop();
    });

    it('a rejecting fireImmediately task does not crash start()', async () => {
      const run = vi.fn().mockRejectedValue(new Error('boom'));
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 60_000, run, fireImmediately: true });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });
  });

  describe('disabled zero/negative intervals', () => {
    it('never fires a task with intervalMs <= 0', async () => {
      const run = vi.fn();
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'zero', intervalMs: 0, run });
      scheduler.addTask({ id: 'neg', intervalMs: -5, run });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).not.toHaveBeenCalled();

      scheduler.stop();
    });
  });

  describe('stop', () => {
    it('stop() prevents further ticks', async () => {
      const run = vi.fn();
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 2_000, run });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(run).toHaveBeenCalledTimes(1);

      scheduler.stop();
      const countAfterStop = run.mock.calls.length;

      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).toHaveBeenCalledTimes(countAfterStop);
    });

    it('stop() before start() is a safe no-op', () => {
      const scheduler = new TaskScheduler(1000);
      expect(() => scheduler.stop()).not.toThrow();
    });
  });

  describe('process lifetime', () => {
    it('unrefs its interval so the loop does not keep the process alive', () => {
      const unref = vi.fn();
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({
        unref,
        hasRef: () => false,
        refresh: () => {},
      } as any);
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 2_000, run: vi.fn() });
      scheduler.start();

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(unref).toHaveBeenCalled();

      scheduler.stop();
      expect(clearIntervalSpy).toHaveBeenCalled();

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });
  });

  it('exposes DEFAULT_SCHEDULER_TICK_MS (1s)', () => {
    expect(DEFAULT_SCHEDULER_TICK_MS).toBe(1000);
  });

  describe('run timeout watchdog (runTimeoutMs)', () => {
    it('abandons a hung run after runTimeoutMs and retries on the next tick', async () => {
      const hung = new Promise<void>(() => {}); // never resolves
      const run = vi.fn(() => hung);
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 30_000, run, singleFlight: true, runTimeoutMs: 5_000 });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(1); // first run starts and hangs

      // Watchdog fires: the run is abandoned and the in-flight flag resets,
      // so the task is NOT permanently wedged (WL-0MSJIPHD0001L1J9).
      await vi.advanceTimersByTimeAsync(5_000);

      // The next tick retries instead of skipping forever.
      await vi.advanceTimersByTimeAsync(25_000); // t=60s
      expect(run).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });

    it('settling the abandoned run late does not double-fire or disturb the cadence', async () => {
      let release!: () => void;
      const firstGate = new Promise<void>((r) => { release = r; });
      const run = vi.fn()
        .mockReturnValueOnce(firstGate) // first run hangs
        .mockResolvedValue(undefined); // later runs settle immediately
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 30_000, run, singleFlight: true, runTimeoutMs: 5_000 });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000); // watchdog abandons run 1
      await vi.advanceTimersByTimeAsync(25_000); // t=60s: next tick retries
      expect(run).toHaveBeenCalledTimes(2);

      // The abandoned first run settles LATE (after run 2 completed): it
      // must not trigger a spurious third invocation.
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30_000); // t=90s: normal cadence
      expect(run).toHaveBeenCalledTimes(3);

      scheduler.stop();
    });

    it('does not trip on a run that settles within runTimeoutMs', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const run = vi.fn(() => gate);
      const scheduler = new TaskScheduler(1000);
      scheduler.addTask({ id: 'a', intervalMs: 30_000, run, singleFlight: true, runTimeoutMs: 5_000 });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(1);

      release(); // settles well before the 5s watchdog
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(30_000); // normal cadence continues
      expect(run).toHaveBeenCalledTimes(2);
      scheduler.stop();
    });

    it('keeps single-flight skipping during a bounded run (no overlap)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const run = vi.fn(() => gate);
      const scheduler = new TaskScheduler(1000);
      // Watchdog window (60s) spans two 30s intervals: the tick at t=60s
      // fires BEFORE the watchdog at t=90s, so the pending run is skipped.
      scheduler.addTask({ id: 'a', intervalMs: 30_000, run, singleFlight: true, runTimeoutMs: 60_000 });
      scheduler.start();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(1);

      // Tick while the run is pending: skipped (not coalesced), watchdog
      // has not fired yet.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(2);
      scheduler.stop();
    });

    it('logs an abandonment to stderr for observability', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const hung = new Promise<void>(() => {});
        const scheduler = new TaskScheduler(1000);
        scheduler.addTask({
          id: 'downtime',
          intervalMs: 30_000,
          run: vi.fn(() => hung),
          singleFlight: true,
          runTimeoutMs: 5_000,
        });
        scheduler.start();

        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("[worklog-plugin] Task 'downtime'"),
        );
        scheduler.stop();
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});
