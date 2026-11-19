/**
 * src/not-started.ts — the single definition of the `startOn` **read** filter
 * and its output marker (WL-0MWMGET8N009KG33, parent WL-0MWM0FDZK007BAD0).
 *
 * ## Why one module
 *
 * Every CLI search surface (`list`, `search`, `next`, `in_progress`, `recent`,
 * `worklist`) must hide not-yet-started items *by default* and show them,
 * marked, only when the operator opts in. Forking that decision per command is
 * exactly the drift the parent epic forbids: two surfaces would eventually
 * disagree about the boundary instant, the in-progress exemption or the
 * `--starts-before` window. The decision therefore lives here once and each
 * command only decides *where* to apply it:
 *
 * - the `db.list()` read paths (`list`, `recent`, `in_progress`, the
 *   `worklist` subsets) call {@link filterNotStarted};
 * - the browse-feed selection (`next`, the `worklist` browse subset and, by
 *   construction, the Herdr fetchers) receives {@link NotStartedFilter.hides}
 *   as a candidate-exclusion predicate inside `src/worklist-selection.ts`;
 * - every surface marks the items it does show with
 *   {@link markNotStarted} so text output carries the `[not started until …]`
 *   trailing marker and JSON carries `notStarted: true`.
 *
 * ## Semantics (the epic's ACs)
 *
 * - **Default exclusion.** A not-yet-started item —
 *   `isNotStarted(item, now)`, i.e. its effective start instant
 *   (`startOn ?? createdAt`) is still in the future — is hidden.
 * - **`in_progress` is never filtered.** A started item has already started:
 *   an in-progress row with a future `startOn` is always shown (and marked).
 * - **Opt-in.** `--include-not-started` shows every not-yet-started item;
 *   `--starts-before <ISO>` is an opt-in too and additionally bounds the
 *   window to items starting strictly before that instant. Supplying both
 *   composes to "not started **and** starting before `<ISO>`".
 * - **One instant per read.** `now` is resolved once per command invocation
 *   and passed to every comparison, so a single read can never straddle a
 *   scheduling boundary mid-result. It is an explicit parameter (never a
 *   hidden `Date.now()` inside the predicate), so tests inject a frozen clock
 *   from `tests/helpers/frozen-clock.ts`.
 * - **Fail open.** A row whose effective instant cannot be parsed is never
 *   hidden (the shared predicate already guarantees this).
 */

import {
  effectiveStartOn,
  isNotStarted as isNotStartedAt,
} from '@worklog/shared/predicates';
import { parseStartOnOption } from './validators/start-on.js';

/** Flag that shows every not-yet-started item instead of hiding it. */
export const INCLUDE_NOT_STARTED_FLAG = '--include-not-started';

/** Flag that opts in *and* bounds the window to items starting before an instant. */
export const STARTS_BEFORE_FLAG = '--starts-before';

/** The `startOn` fields the filter reads (structural, so tests can use literals). */
export interface NotStartedItemLike {
  status?: string | null;
  createdAt?: string | null;
  startOn?: string | null;
}

/** Raw CLI options that feed the filter. */
export interface NotStartedFlagOptions {
  /** `--include-not-started` (commander exposes it as `includeNotStarted`). */
  includeNotStarted?: unknown;
  /** Raw `--starts-before` value as typed. */
  startsBefore?: unknown;
}

/** Options for {@link resolveNotStartedFilter}. */
export interface NotStartedFilterOptions {
  /** Show not-yet-started items instead of hiding them (default: false). */
  includeNotStarted?: boolean;
  /** Epoch-ms upper bound; implies the opt-in and keeps only strictly-earlier starts. */
  startsBefore?: number | null;
  /** Comparison instant in epoch milliseconds (default: `Date.now()`). */
  now?: number;
}

/** A resolved filter — one comparison instant, one decision per item. */
export interface NotStartedFilter {
  /** The single instant every comparison in this read uses (epoch ms). */
  readonly now: number;
  /** True when the caller opted in to seeing not-yet-started items. */
  readonly optedIn: boolean;
  /** The `--starts-before` upper bound (epoch ms), or `null` when unbounded. */
  readonly startsBeforeMs: number | null;
  /** True when the item's effective start instant is still in the future. */
  isNotStarted(item: NotStartedItemLike): boolean;
  /** True when this read must omit the item (default exclusion / window bound). */
  hides(item: NotStartedItemLike): boolean;
}

/** Published result of parsing the raw CLI flags. */
export type NotStartedFlagsResult =
  | { ok: true; filter: NotStartedFilter }
  | { ok: false; message: string };

/**
 * Is this item `in-progress` — the status the epic exempts from filtering?
 *
 * Accepts the stored (`in-progress`) and normalised (`in_progress`) spellings
 * so a hand-written query or a legacy row cannot accidentally lose the
 * exemption.
 */
export function isInProgressStatus(item: NotStartedItemLike): boolean {
  const status = String(item.status ?? '').toLowerCase().trim();
  return status === 'in-progress' || status === 'in_progress';
}

/** Epoch ms of the item's effective start instant, or `null` when unreadable. */
function effectiveMs(item: NotStartedItemLike): number | null {
  const iso = effectiveStartOn(item.startOn, item.createdAt);
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve the filter for one read.
 *
 * `now` is read exactly once here, so every comparison in the resulting read
 * uses the same instant (AC: clock-injectable, frozen-clock friendly).
 */
export function resolveNotStartedFilter(
  options: NotStartedFilterOptions = {},
): NotStartedFilter {
  const now = options.now ?? Date.now();
  const startsBeforeMs =
    options.startsBefore === null || options.startsBefore === undefined
      ? null
      : options.startsBefore;
  const optedIn = Boolean(options.includeNotStarted) || startsBeforeMs !== null;

  const isNotStarted = (item: NotStartedItemLike): boolean => isNotStartedAt(item, now);

  return {
    now,
    optedIn,
    startsBeforeMs,
    isNotStarted,
    hides(item: NotStartedItemLike): boolean {
      // A started item has already started: in-progress rows are never filtered.
      if (isInProgressStatus(item)) return false;
      if (!isNotStarted(item)) return false;
      if (!optedIn) return true;
      // Opted in without a window: show every not-yet-started item.
      if (startsBeforeMs === null) return false;
      const ms = effectiveMs(item);
      // Unreadable instants fail open (they already read as "started" above).
      if (ms === null) return false;
      // The window is "not started AND starting strictly before <ISO>".
      return !(ms < startsBeforeMs);
    },
  };
}

/**
 * Parse {@link STARTS_BEFORE_FLAG} and resolve the filter in one step.
 *
 * The bound reuses the `--start-on` validator (a full ISO-8601 timestamp with
 * an explicit timezone), because the same ambiguity applies: a bare date or a
 * timezone-less time would silently move the window. A blank value means "no
 * upper bound" (plain `--include-not-started` semantics).
 *
 * @returns The resolved filter, or the actionable rejection message.
 */
export function resolveNotStartedFilterFromFlags(
  flags: NotStartedFlagOptions = {},
  now?: number,
): NotStartedFlagsResult {
  const rawStart = flags.startsBefore;
  let startsBefore: number | null = null;

  if (rawStart !== undefined && rawStart !== null && rawStart !== false) {
    const parsed = parseStartOnOption(String(rawStart), STARTS_BEFORE_FLAG);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    if (!parsed.clear) {
      const ms = Date.parse(parsed.value);
      if (!Number.isFinite(ms)) {
        return {
          ok: false,
          message: `Invalid ${STARTS_BEFORE_FLAG} value "${parsed.value}": it is not a parseable ISO-8601 timestamp.`,
        };
      }
      startsBefore = ms;
    }
  }

  return {
    ok: true,
    filter: resolveNotStartedFilter({
      includeNotStarted: Boolean(flags.includeNotStarted),
      startsBefore,
      now,
    }),
  };
}

/**
 * Drop the items this read must hide (default exclusion / window bound).
 *
 * The order of the remaining items is preserved, so callers keep their own
 * sorting and limiting semantics — `recent` in particular must filter *before*
 * slicing its window, otherwise a hidden item would consume one of the slots.
 */
export function filterNotStarted<T extends NotStartedItemLike>(
  items: T[],
  filter: NotStartedFilter,
): T[] {
  if (!items || items.length === 0) return items;
  return items.filter(item => !filter.hides(item));
}

/** Output-enrichment shape: the read-only `notStarted` marker on an item. */
export interface NotStartedMark {
  /** Present (and `true`) only when the item is not yet started. */
  notStarted?: true;
}

/**
 * Mark the items this read will show.
 *
 * A shown item whose effective start instant is still in the future carries
 * `notStarted: true` — this is the JSON marker (AC) and the trigger for the
 * text marker in `src/commands/helpers.ts`. Items that already started are
 * returned untouched, so no existing output shape changes.
 */
export function markNotStarted<T extends NotStartedItemLike>(
  items: T[],
  filter: NotStartedFilter,
): Array<T & NotStartedMark> {
  if (!items || items.length === 0) return items as Array<T & NotStartedMark>;
  return items.map(item => (filter.isNotStarted(item) ? { ...item, notStarted: true as const } : item));
}

/** True when an item already carries the read-time `notStarted` marker. */
export function isMarkedNotStarted(item: unknown): boolean {
  return Boolean(item && typeof item === 'object' && (item as NotStartedMark).notStarted === true);
}

/**
 * The trailing text marker for a not-yet-started item, e.g.
 * `[not started until 2026-11-19T10:25:00Z]`, or `null` when the item is
 * started (or its instant is unreadable — fail open, never a bogus marker).
 *
 * The bracketed shape mirrors the worklist's existing `[held: N by Map]`
 * marker (WL-0MVR8FN1D002SCIR) so operators read one visual grammar.
 */
export function notStartedMarker(item: NotStartedItemLike): string | null {
  const iso = effectiveStartOn(item.startOn, item.createdAt);
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return `[not started until ${new Date(ms).toISOString()}]`;
}

/**
 * Marker suffix to append to an item's title line, or `''` when the item is
 * not marked (see {@link isMarkedNotStarted}).
 */
export function notStartedSuffix(item: NotStartedItemLike): string {
  if (!isMarkedNotStarted(item)) return '';
  const marker = notStartedMarker(item);
  return marker ? ` ${marker}` : '';
}
