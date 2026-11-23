/**
 * packages/shared/src/start-on.ts — normalisation of the `startOn` scheduling
 * field (WL-0MWMGEPY2004EDZ8, parent WL-0MWM0FDZK007BAD0).
 *
 * ## Why a dedicated module
 *
 * `startOn` has one storage invariant: **the column is always populated with
 * the effective instant**, i.e. `startOn ?? createdAt`. Every query therefore
 * compares a single non-null column and never needs `COALESCE` over two, and a
 * row written before the field existed (legacy SQLite row, legacy JSONL, legacy
 * Git object) still behaves exactly as it did before — back-compat is the
 * default, never "blocked".
 *
 * Three paths enforce that invariant and must agree, so they share this one
 * helper: the store's write path (`saveWorkItem`), the store's read path
 * (`rowToWorkItem`, which reads a `NULL` column as `createdAt`) and the JSONL
 * import back-fill. Keeping it here — a module with **no imports** — also keeps
 * the import graph acyclic: `persistent-store.ts` can use it without importing
 * `predicates.ts` (which pulls in `database/work-items.ts` → `database/context.ts`
 * → `persistent-store.ts`).
 *
 * ## Semantics
 *
 * - A present, parseable instant is normalised to canonical UTC
 *   (`...Z`) — an explicit offset (`+01:00`) is accepted and read identically.
 *   Normalising on write makes export bytes stable, so `export → import →
 *   export` is byte-identical.
 * - A present but **unparseable** value is preserved verbatim rather than
 *   dropped or silently replaced: discarding scheduling data on write is worse
 *   than storing something the read path (`isNotStarted`) fails open on.
 * - An absent/blank value falls back to `createdAt`; when both are blank the
 *   effective value is unknowable and `null` is returned (the store then leaves
 *   the column `NULL`, and the read path still falls back to `createdAt`).
 */

/**
 * Normalise a `startOn` value to the instant that should be stored.
 *
 * @param startOn - The requested earliest start instant (ISO-8601), or
 *   absent/blank to use the item's creation instant.
 * @param createdAt - The item's creation instant, the default when `startOn`
 *   is not set.
 * @returns The effective start instant normalised to canonical UTC, the
 *   verbatim value when it cannot be parsed, or `null` when neither value
 *   yields anything to store.
 */
export function normalizeStartOn(
  startOn: string | null | undefined,
  createdAt: string | null | undefined,
): string | null {
  const explicit = trimToEmpty(startOn);
  if (explicit !== '') return toCanonicalUtc(explicit) ?? explicit;
  const created = trimToEmpty(createdAt);
  if (created === '') return null;
  return toCanonicalUtc(created) ?? created;
}

/**
 * The effective start instant of a stored item (`startOn`, else `createdAt`).
 *
 * Identical to {@link normalizeStartOn}; named for the read path so a caller
 * making a "what does this row mean?" decision reads as such.
 */
export function effectiveStartOn(
  startOn: string | null | undefined,
  createdAt: string | null | undefined,
): string | null {
  return normalizeStartOn(startOn, createdAt);
}

/** `String(value).trim()` for the nullable/undefined-friendly callers. */
function trimToEmpty(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Canonical `...Z` ISO-8601 form of a parseable instant, else `null`. */
function toCanonicalUtc(value: string): string | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}
