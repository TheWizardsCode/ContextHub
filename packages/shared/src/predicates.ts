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
 */

export { isSoftDeleted } from './database/work-items.js';
