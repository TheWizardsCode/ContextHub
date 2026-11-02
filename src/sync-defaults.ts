/**
 * src/sync-defaults.ts — default git remote and refs the sync pushes to.
 *
 * Concern: the single place the default sync target is declared, so a caller
 * that omits an explicit remote/branch behaves identically everywhere.
 */

export const DEFAULT_GIT_REMOTE = 'origin';
export const DEFAULT_GIT_BRANCH = 'refs/worklog/data';
