/**
 * packages/shared/src/predicates.ts — shared semantic predicates exposed to
 * consumers through the `@worklog/shared/predicates` subpath.
 *
 * The root `@worklog/shared` entry (`database.ts`) is a frozen public surface
 * guarded by the DB-split decomposition contract
 * (WL-0MVGKGHNR0019OLT, packages/shared/src/database/decomposition-guard.test.ts):
 * it may never grow a new export. Predicates are therefore published via this
 * dedicated subpath — the same pattern the CLI already uses for
 * `@worklog/shared/fields`, `@worklog/shared/types`, and so on.
 *
 * `isSoftDeleted` is the single definition of "soft-deleted" reconciled across
 * the read (visibility) and write (mutability) paths (WL-0MW7S20IC001F3AP).
 * `isNotStarted` is the single definition of "not yet started" for the
 * `startOn` scheduling dimension (WL-0MWMGEL5R003IH71).
 *
 * `normalizeStartOn` (re-exported from `./start-on.js`) is the single
 * definition of how a `startOn` value is stored — the effective instant
 * `startOn ?? createdAt`, normalised to UTC (WL-0MWMGEPY2004EDZ8). Consumers
 * outside the shared package (JSONL import, the `wl doctor` check) reach it
 * through this subpath, exactly as they reach the predicate.
 */

export { isSoftDeleted } from './database/work-items.js';

export { normalizeStartOn, effectiveStartOn } from './start-on.js';

/**
 * The fields {@link isNotStarted} reads.
 *
 * Deliberately structural rather than `Pick<WorkItem, …>`: the predicate is
 * the *first* slice of the `startOn` epic, so it ships before `WorkItem` grows
 * the field and every later slice (CLI filter, Herdr gate, claim guard) can
 * adopt it without waiting for the type change. `createdAt` is optional here
 * because the predicate must survive a row that lost it (fail-open, see
 * below), which `WorkItem` cannot express.
 */
export interface StartOnFields {
  /** Creation instant (ISO-8601). Absent/unreadable reads as "started". */
  createdAt?: string | null;
  /**
   * Earliest instant the item may proceed (ISO-8601). Absent, empty or
   * unreadable falls back to {@link StartOnFields.createdAt}.
   */
  startOn?: string | null;
}

/**
 * Parse an ISO-8601 instant (with a `Z` suffix or an explicit offset such as
 * `+01:00` — both are read identically) to epoch milliseconds.
 *
 * @returns The instant in milliseconds, or `null` when the value is absent,
 *   blank or unreadable.
 */
function parseInstant(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The effective start instant of an item, in epoch milliseconds.
 *
 * `startOn ?? createdAt` — so an item authored before the field existed
 * behaves exactly as it did before (back-compat is the default, never
 * "blocked"). A `startOn` that is present but unreadable does **not** fall
 * back to `createdAt`: returning `null` makes the caller fail open, so a
 * corrupt scheduling hint can never combine with a future `createdAt` to hide
 * an item.
 *
 * @returns The instant in milliseconds, or `null` when the value that applies
 *   yields no readable instant.
 */
function effectiveStartMs(item: StartOnFields): number | null {
  const hasStartOn = item.startOn !== null && item.startOn !== undefined && String(item.startOn).trim() !== '';
  return hasStartOn ? parseInstant(item.startOn) : parseInstant(item.createdAt);
}

/**
 * Is this work item **not yet started** — i.e. is its effective start instant
 * (`startOn ?? createdAt`) still in the future?
 *
 * The boundary is **inclusive**: an item whose effective start instant equals
 * `now` counts as *started*, so a scheduled instant is live the moment it is
 * reached. The predicate **fails open** (reads as "started") whenever the
 * effective instant cannot be read — a temporal scheduling hint must never
 * hide an item from an operator or a dispatcher.
 *
 * `now` is an explicit parameter in epoch milliseconds: the predicate never
 * reads the wall clock, so tests inject a frozen instant
 * (`tests/helpers/frozen-clock.ts`) and comparisons are deterministic. Every
 * caller filters with the same value so a single `wl list` / `wl next` /
 * Herdr refresh can never straddle a scheduling boundary mid-read.
 *
 * @param item - The work item (only its temporal fields are read).
 * @param now - The comparison instant in epoch milliseconds.
 * @returns true when the item's effective start instant is strictly after
 *   `now`; false when it has started (or cannot be read).
 *
 * @example
 * ```ts
 * isNotStarted({ createdAt: '2026-11-01T00:00:00Z' }, now);                    // false — pre-existing item
 * isNotStarted({ createdAt: '2026-11-01T00:00:00Z',
 *                startOn: '2026-11-19T10:25:00Z' }, now);                       // true until that instant
 * isNotStarted({ createdAt: '2026-11-01T00:00:00Z', startOn: 'nonsense' }, now); // false — fail open
 * ```
 */
export function isNotStarted(item: StartOnFields, now: number): boolean {
  const startMs = effectiveStartMs(item);
  if (startMs === null) return false;
  return now < startMs;
}
