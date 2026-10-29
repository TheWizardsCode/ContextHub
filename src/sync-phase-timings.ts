/**
 * `wl sync` phase-timing observability (WL-0MVK6SD5O001K901).
 *
 * `wl sync` used to report a single wall-clock number with no phase
 * attribution, so the F2 stage harness (WL-0MVJV2NNG00771C6) had to replay
 * `performSync`'s persist pipeline out of process to break the cost down.
 *
 * This module is the single source of truth for the phase names:
 * `performSync` times these phases in the CLI, the F2 probe
 * (`packages/herdr/test/perf/wl-sync-phase-probe.ts`) reports under the same
 * names, and the before/after table therefore lines up with both.
 *
 * The phase set is deliberately small and user-meaningful: `pull`,
 * `persist-items`, `persist-comments`, `export`, `push`.
 */

export const SYNC_PHASE_NAMES = [
  'pull',
  'persist-items',
  'persist-comments',
  'export',
  'push',
] as const;

export type SyncPhaseName = (typeof SYNC_PHASE_NAMES)[number];

/** Wall-clock milliseconds per phase; every phase name is always present. */
export type SyncPhaseTimings = Record<SyncPhaseName, number>;

export interface SyncPhaseTimer {
  /** Open a timing window for `phase`; windows of the same phase accumulate. */
  start(phase: SyncPhaseName): void;
  /** Close the most recent open window for `phase` (a no-op when none is open). */
  end(phase: SyncPhaseName): void;
  /** Time a synchronous step. */
  measure<T>(phase: SyncPhaseName, fn: () => T): T;
  /** Time an asynchronous step. */
  measureAsync<T>(phase: SyncPhaseName, fn: () => Promise<T>): Promise<T>;
  /** Snapshot of the accumulated milliseconds; unmeasured phases report 0. */
  timings(): SyncPhaseTimings;
}

const round1 = (ms: number): number => Math.round(ms * 10) / 10;

function emptyTimings(): SyncPhaseTimings {
  return Object.fromEntries(SYNC_PHASE_NAMES.map((phase) => [phase, 0])) as SyncPhaseTimings;
}

/**
 * Create an accumulating phase timer.
 *
 * Every phase starts at 0 so the emitted shape is stable even when a phase is
 * skipped — a dry run, the zero-change fast path or `--no-push` report 0 for
 * the phase instead of dropping the field.
 *
 * Windows accumulate: measuring the same phase more than once (the delta
 * persist path interleaves items/audits) adds to the phase total.
 */
export function createSyncPhaseTimer(now: () => number = () => performance.now()): SyncPhaseTimer {
  const totals = emptyTimings();
  const open = new Map<SyncPhaseName, number>();

  const start = (phase: SyncPhaseName): void => {
    open.set(phase, now());
  };

  const end = (phase: SyncPhaseName): void => {
    const startedAt = open.get(phase);
    if (startedAt === undefined) return;
    open.delete(phase);
    totals[phase] += now() - startedAt;
  };

  const measure = <T>(phase: SyncPhaseName, fn: () => T): T => {
    start(phase);
    try {
      return fn();
    } finally {
      end(phase);
    }
  };

  const measureAsync = async <T>(
    phase: SyncPhaseName,
    fn: () => Promise<T>,
  ): Promise<T> => {
    start(phase);
    try {
      return await fn();
    } finally {
      end(phase);
    }
  };

  return {
    start,
    end,
    measure,
    measureAsync,
    timings(): SyncPhaseTimings {
      const snapshot = emptyTimings();
      for (const phase of SYNC_PHASE_NAMES) snapshot[phase] = round1(totals[phase]);
      return snapshot;
    },
  };
}

/** Render timings as the single log line `wl sync` writes to its sync log. */
export function formatSyncPhaseTimings(timings: SyncPhaseTimings): string {
  return SYNC_PHASE_NAMES.map(
    (phase) => `${phase}=${round1(timings[phase] ?? 0)}ms`,
  ).join(' ');
}
