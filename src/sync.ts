/**
 * Sync functionality for merging local and remote work items with conflict resolution.
 *
 * Shared type declarations live in `./sync/types.js`, git subprocess plumbing
 * in `./sync/git-exec.js`, the merge decision predicates in
 * `./sync/merge-predicates.js`, the field-level merge implementations in
 * `./sync/field-merge.js`, the public merge entry point in `./sync/merge.js`
 * and the collateral (comment / audit-result / dependency-edge) merges in
 * `./sync/merge-collateral.js` (shared primitives in `./sync/merge-utils.js`;
 * WL-0MVP9QLWU003NV41). The mid-layer concerns
 * live in `./sync/author-identity.js` (author-identity gate), `./sync/refs.js`
 * (last-synced/remote refs), `./sync/prefix-filter.js` (cross-project prefix
 * filter) and `./sync/repo-context.js` (repo-root resolution + cross-project
 * guard) (WL-0MVP9R3PU004EGYE). The I/O layer lives in `./sync/worktree.js`
 * (temporary-worktree lifecycle), `./sync/remote.js` (remote-ref reading and
 * delta replay) and `./sync/push.js` (data-file push / rewrite-and-force-push)
 * (WL-0MVP9RW4Z006VLW1). The public names are re-exported below so the
 * surface of this module is unchanged.
 */


// ── Public type surface (barrel re-export) ────────────────────────────
// The 9 type declarations moved to `./sync/types.js`; re-exporting them here
// keeps all 34 exports importable from `'./sync.js'` unchanged (AC3).
export type {
  GitTarget,
  SyncResult,
  MergeOptions,
  IncomingCommit,
  SyncAllowedAuthors,
  AuthorIdentityOptions,
  AuthorIdentityViolation,
  AuthorIdentityResult,
  DeltaReplayResult,
} from './sync/types.js';

// ── Merged modules (WL-0MVP9QLWU003NV41) ─────────────────────────────
// The merge region of `src/sync.ts` moved to `./sync/{merge-predicates,
// field-merge, merge, merge-collateral}.js`; the public names are
// re-exported here so consumers of `'./sync.js'` are unaffected.
export {
  isRegressionDefault,
  isValueRegression,
  isEmptyMeaningfulField,
  isTerminalStage,
} from './sync/merge-predicates.js';
export { mergeWorkItems } from './sync/merge.js';
export { mergeComments, mergeAuditResults, mergeDependencyEdges } from './sync/merge-collateral.js';

// ── Refs (WL-0MVP9R3PU004EGYE) ───────────────────────────────────────
// The last-synced/remote-ref bookkeeping moved to `./sync/refs.js`; the
// public names are re-exported here so consumers of `'./sync.js'` are
// unaffected.
export {
  getLastSyncedRefPath,
  readLastSyncedRef,
  writeLastSyncedRef,
  getRemoteTrackingRefSha,
  _testOnly_getRemoteTrackingRef,
} from './sync/refs.js';

// ── Repo context (WL-0MVP9R3PU004EGYE) ───────────────────────────────
// The repo-root/cross-project guard moved to `./sync/repo-context.js`; the
// public name is re-exported here so consumers of `'./sync.js'` are unaffected.
export { assertDataFileInCwdRepo } from './sync/repo-context.js';

// ── Prefix filter (WL-0MVP9R3PU004EGYE) ──────────────────────────────
// The cross-project prefix filter moved to `./sync/prefix-filter.js`;
// the public names are re-exported here so consumers of `'./sync.js'`
// are unaffected.
export { isOwnProjectItemId, filterRemoteDataByPrefix } from './sync/prefix-filter.js';

// ── Author identity (WL-0MVP9R3PU004EGYE) ─────────────────────────────
// The author-identity gate moved to `./sync/author-identity.js`; the public
// names are re-exported here so consumers of `'./sync.js'` are unaffected.
export {
  getRemoteAuthorCommits,
  checkAuthorIdentity,
  getConfiguredUserEmail,
  enforceAuthorIdentityGate,
} from './sync/author-identity.js';

// ── Remote fetch + delta replay (WL-0MVP9RW4Z006VLW1) ────────────────
// The remote-ref reading and delta-replay chain moved to `./sync/remote.js`;
// the public names are re-exported here so consumers of `'./sync.js'` are
// unaffected.
export {
  getRemoteDataFileContentWithRef,
  getRemoteDataFileContent,
  replayRemoteDeltaChain,
} from './sync/remote.js';

// ── Push + rewrite (WL-0MVP9RW4Z006VLW1) ────────────────────────────
// The data-file push and rewrite-and-force-push paths moved to
// `./sync/push.js`; the public names are re-exported here so consumers of
// `'./sync.js'` are unaffected.
export {
  gitPushDataFileToBranch,
  rewriteAndForcePushDataFile,
} from './sync/push.js';
