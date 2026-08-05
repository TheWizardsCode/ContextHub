/**
 * packages/herdr/src/scheduler.ts — Single-loop task scheduler
 *
 * Consolidates ALL periodic plugin work (auto-refresh, auto-sync,
 * visibility resume-poll, and future downtime-worker ticks) into ONE
 * `setInterval` loop that dispatches due work by deadline
 * (WL-0MSG4NMF0000YBRP).
 *
 * Key design decisions:
 *  - One loop: a single tick at `DEFAULT_SCHEDULER_TICK_MS` walks the task
 *    table and runs every task whose due time has passed, so tick cadence,
 *    pause-when-hidden gating, and shutdown cleanup live in one place.
 *  - Sequential dispatch: due tasks run one at a time (each awaited) so a
 *    task that memoizes a shared resource (e.g. the PollGate visibility
 *    cache) settles before the next task reads it.
 *  - Deadline scheduling: each task carries its own `intervalMs` and due
 *    time; the base tick only needs to be at the finest granularity needed
 *    (1s for the 2s resume-poll cadence).
 *  - Per-task single-flight: a task with `singleFlight: true` whose previous
 *    run is still pending has its tick SKIPPED and rescheduled to the next
 *    interval (a skipped tick is not coalesced) — same semantics as the
 *    refresh/sync guards they replace.
 *  - Error resilience: a rejecting task never takes down the loop; its
 *    cadence resumes on the next interval.
 *  - Disable/enable: tasks can start disabled (e.g. the resume-poll only
 *    runs while the pane is hidden) and be toggled at runtime without
 *    restarting the loop — the mechanism behind pause-when-hidden.
 *  - Unref'd: the interval is unref'd so the loop never keeps the process
 *    alive on its own.
 */

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Base cadence of the scheduler loop in milliseconds. The finest period any
 * registered task needs is the visibility resume-poll (2s), so a 1s tick
 * dispatches every due task within 1s of its deadline.
 */
export const DEFAULT_SCHEDULER_TICK_MS = 1000;

// ── Task contract ─────────────────────────────────────────────────────

/**
 * A unit of periodic work scheduled by the loop.
 */
export interface SchedulerTask {
  /** Unique task id, used to enable/disable the task at runtime. */
  id: string;
  /** Period between runs in milliseconds (must be > 0). */
  intervalMs: number;
  /** The work to run when the task is due. May be async. */
  run: () => Promise<void> | void;
  /**
   * Skip (and reschedule) a tick when the previous run is still pending, so
   * slow tasks never overlap. Skipped ticks are not coalesced: the next run
   * happens at the following interval boundary.
   */
  singleFlight?: boolean;
  /** Run once immediately when the scheduler starts (first tick). */
  fireImmediately?: boolean;
  /** Start disabled (skipped until `setDisabled(id, false)`). */
  disabled?: boolean;
}

/** Internal bookkeeping for a registered task. */
interface TaskEntry {
  task: SchedulerTask;
  /** Absolute time (ms) of the next scheduled run. */
  dueAt: number;
  /** True while the task's previous run is still pending. */
  inFlight: boolean;
}

// ── Scheduler ─────────────────────────────────────────────────────────

/**
 * A single-interval task scheduler that dispatches due work by deadline.
 *
 * ```
 * const scheduler = new TaskScheduler(DEFAULT_SCHEDULER_TICK_MS);
 * scheduler.addTask({ id: 'refresh', intervalMs: 30_000, run: doRefresh });
 * scheduler.start();
 * ...
 * scheduler.stop();
 * ```
 */
export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tasks = new Map<string, TaskEntry>();

  constructor(private readonly tickMs: number) {}

  /**
   * Register a periodic task. Tasks with `intervalMs <= 0` are treated as
   * disabled and never fire. Adding a task while the scheduler is running
   * is supported; it is armed from `now + intervalMs`.
   */
  addTask(task: SchedulerTask): void {
    if (task.intervalMs <= 0) {
      task = { ...task, disabled: true };
    }
    this.tasks.set(task.id, {
      task,
      dueAt: Date.now() + task.intervalMs,
      inFlight: false,
    });
  }

  /**
   * Enable or disable a task at runtime. Disabled tasks are skipped by the
   * loop; re-enabling arms the task from now, so `setDisabled(id, false)`
   * behaves like starting the task's interval from scratch.
   */
  setDisabled(id: string, disabled: boolean): void {
    const entry = this.tasks.get(id);
    if (!entry) return;
    entry.task.disabled = disabled;
    if (!disabled) {
      // (Re)arm from now — mirrors starting a fresh interval.
      entry.dueAt = Date.now() + entry.task.intervalMs;
    }
  }

  /**
   * Start the loop. Tasks flagged `fireImmediately` run once right away
   * (promise fire-and-forget), then settle into their interval cadence.
   * No-op if already running.
   */
  start(): void {
    if (this.timer !== null) return;
    const now = Date.now();
    for (const entry of this.tasks.values()) {
      if (entry.task.fireImmediately && !entry.task.disabled) {
        void this.runTask(entry, now);
      }
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // Don't keep the process alive just for the loop.
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Stop the loop and clear the interval. Safe to call when not running.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scheduler tick: dispatch every due, enabled, non-in-flight task.
   * Tasks are dispatched SEQUENTIALLY (each run is awaited before the next
   * task is dispatched) so a task that memoizes a shared resource (e.g. the
   * PollGate visibility cache) settles before the next task reads it — the
   * same inter-timer behavior the independent intervals used to have.
   */
  private readonly tick = async (): Promise<void> => {
    const now = Date.now();
    for (const entry of this.tasks.values()) {
      if (entry.task.disabled) continue;
      if (now < entry.dueAt) continue;
      if (entry.task.singleFlight && entry.inFlight) {
        // Skipped tick is not coalesced — reschedule to the next interval.
        entry.dueAt = now + entry.task.intervalMs;
        continue;
      }
      await this.runTask(entry, now);
    }
  };

  /**
   * Run a task: reschedule the next fire before running (so a slow run does
   * not delay the cadence, matching `setInterval` semantics) and track the
   * in-flight flag for single-flight tasks. Errors are swallowed so a
   * failing task never takes down the loop; tasks that need to surface
   * errors should catch them in their own `run` (as the worklist's
   * doRefresh/doSync do).
   */
  private async runTask(entry: TaskEntry, now: number): Promise<void> {
    entry.dueAt = now + entry.task.intervalMs;
    entry.inFlight = true;
    try {
      await entry.task.run();
    } catch {
      // A failing task must never take down the loop or the plugin.
    } finally {
      entry.inFlight = false;
    }
  }
}
