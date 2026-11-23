/**
 * tests/helpers/frozen-clock.ts — the shared deterministic clock for every
 * `startOn` test (WL-0MWMGEL5R003IH71, parent WL-0MWM0FDZK007BAD0).
 *
 * `startOn` comparisons are temporal: "is this instant in the past or the
 * future?" A test that asks the wall clock is a flake waiting for the day it
 * runs a millisecond away from a boundary, so the shared predicate takes `now`
 * as an explicit parameter (`isNotStarted(item, now)`) and every test supplies
 * it from this clock instead of `Date.now()`.
 *
 * The clock is a plain value holder — no timers, no fake-timer globals, no
 * dependence on the test runner — so it works identically in a unit test, an
 * in-process CLI harness or a standalone script:
 *
 * ```ts
 * const clock = createFrozenClock();                 // 2026-06-01T12:00:00.000Z
 * const future = clock.isoAt(60_000);                // +1 minute
 * isNotStarted({ createdAt: clock.nowIso(), startOn: future }, clock.now()); // true
 * clock.advance(60_000);                             // boundary reached
 * isNotStarted({ createdAt: clock.nowIso(), startOn: future }, clock.now()); // false
 * ```
 *
 * The default instant is deliberately fixed (never "now + N"), so two runs of
 * the same test on different days compare exactly the same instants.
 */

/** The instant {@link createFrozenClock} starts from unless told otherwise. */
export const FROZEN_CLOCK_DEFAULT_ISO = '2026-06-01T12:00:00.000Z';

/** A clock that only moves when a test tells it to. */
export interface FrozenClock {
  /** The instant the clock was created at (epoch milliseconds). */
  readonly startMs: number;
  /** Jump to `instant`; accepts ISO-8601 (with `Z` or an offset) or epoch ms. */
  set(instant: string | number): number;
  /** Move forward (or backward, for a negative delta) by `ms`. */
  advance(ms: number): number;
  /** The current instant in epoch milliseconds — the value to pass as `now`. */
  now(): number;
  /** The current instant as an ISO-8601 UTC string. */
  nowIso(): string;
  /** `now() + offsetMs` as an ISO-8601 UTC string (a future/past instant). */
  isoAt(offsetMs: number): string;
}

/**
 * Coerce an ISO-8601 string or an epoch-millisecond number to milliseconds.
 *
 * ISO values with a `Z` suffix and with an explicit UTC offset (`+01:00`) are
 * accepted identically — the same rule the `startOn` predicate applies — and an
 * unparseable value throws instead of silently becoming `NaN` (a test that
 * passes garbage should fail loudly, not compare against `NaN`).
 */
function toMs(instant: string | number): number {
  const ms = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) {
    throw new Error(`frozen clock: '${String(instant)}' is not a valid instant`);
  }
  return ms;
}

/**
 * Create a frozen clock.
 *
 * @param instant Starting instant (ISO-8601 or epoch ms). Defaults to
 *   {@link FROZEN_CLOCK_DEFAULT_ISO} so tests are reproducible across days.
 */
export function createFrozenClock(instant: string | number = FROZEN_CLOCK_DEFAULT_ISO): FrozenClock {
  let current = toMs(instant);
  const startMs = current;
  return {
    startMs,
    set(next: string | number): number {
      current = toMs(next);
      return current;
    },
    advance(ms: number): number {
      if (!Number.isFinite(ms)) {
        throw new Error(`frozen clock: advance(${String(ms)}) needs a finite millisecond delta`);
      }
      current += ms;
      return current;
    },
    now(): number {
      return current;
    },
    nowIso(): string {
      return new Date(current).toISOString();
    },
    isoAt(offsetMs: number): string {
      if (!Number.isFinite(offsetMs)) {
        throw new Error(`frozen clock: isoAt(${String(offsetMs)}) needs a finite millisecond offset`);
      }
      return new Date(current + offsetMs).toISOString();
    },
  };
}
