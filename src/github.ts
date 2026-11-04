/**
 * src/github.ts — the public barrel of the GitHub integration.
 *
 * Concern: the family's public surface, and nothing else. Every github concern
 * lives in a focused module under `./github/` (transport, types, repo-slug,
 * markers, labels, hierarchy, comments, issues); this file only re-exports the
 * frozen 58-symbol surface consumers import from `'./github.js'` — 52 value
 * exports and 6 type exports — grouped by concern below. It declares no logic
 * of its own.
 *
 * It imports the family modules; no family module imports it, so the family's
 * import graph stays acyclic. Module responsibilities, the cycle-safe layering
 * and a "where to find X" table live in `docs/ARCHITECTURE.md` § GitHub Module
 * Layout (WL-0MVGKGR2H006MNVG, final child WL-0MVVLY034000MDVA).
 */

// `gh` CLI transport (WL-0MVVLXWRQ000IFET): these six symbols keep their names,
// signatures and barrel path; the other transport helpers are internal to the
// family and intentionally NOT re-exported.
export { setVerboseLogger } from './github/transport.js';
export { isSecondaryRateLimitText, SecondaryRateLimitError } from './github/transport.js';
export { ghApiAsyncScheduled, ghApiDetailedScheduled, ghApiJsonScheduled } from './github/transport.js';

// Shared type declarations (WL-0MVVLXXGC0026427). The type-only re-export keeps
// the runtime surface at exactly 52 value exports.
export type {
  GithubConfig,
  GithubIssueRecord,
  GithubIssueComment,
  IssueHierarchy,
  AssignGithubIssueResult,
  LabelEvent,
} from './github/types.js';

// Repo-slug resolution and the worklog marker format + body parsers
// (WL-0MVVLXXGC0026427).
export { parseRepoSlug, getRepoFromGitRemote } from './github/repo-slug.js';
export {
  buildWorklogMarker,
  buildWorklogCommentMarker,
  stripWorklogMarkers,
  extractWorklogId,
  extractWorklogCommentId,
  extractParentId,
  extractParentIssueNumber,
  extractChildIds,
  extractChildIssueNumbers,
} from './github/markers.js';

// Label logic (WL-0MVVLXY42003Q047): `ensureGithubLabelsAsync` is public today
// and stays so (the frozen guard baseline records it); the other label helpers
// (`labelColor`, `isStatusLabel`, the synchronous and `Once*` ensure paths)
// remain internal to the family and are NOT re-exported here.
export {
  normalizeGithubLabelPrefix,
  isSingleValueCategoryLabel,
  ensureGithubLabelsAsync,
  LabelEventCache,
  fetchLabelEventsAsync,
  labelFieldsDiffer,
  getLatestLabelEventTimestamp,
} from './github/labels.js';

// Issue-hierarchy plumbing (WL-0MVVLXYRO006WP2I). `getIssueNodeId` stays
// private to the module.
export {
  getIssueHierarchy,
  getIssueNodeIdAsync,
  getIssueHierarchyAsync,
  addSubIssueLink,
  addSubIssueLinkResult,
  addSubIssueLinkAsync,
  addSubIssueLinkResultAsync,
  listParentIssueNumbersFromTimeline,
} from './github/hierarchy.js';

// Issue-comment CRUD (WL-0MVVLXZFN00994LW). The response normaliser
// `normalizeGithubIssueComment` stays private to that module.
export {
  listGithubIssueComments,
  listGithubIssueCommentsAsync,
  createGithubIssueComment,
  createGithubIssueCommentAsync,
  updateGithubIssueComment,
  updateGithubIssueCommentAsync,
  getGithubIssueComment,
  getGithubIssueCommentAsync,
} from './github/comments.js';

// Issue CRUD and payload mapping (WL-0MVVLY034000MDVA). `LEGACY_PRIORITY_MAP`
// and the response normaliser `normalizeGithubIssue` stay private to that
// module, so the public surface does not grow.
export {
  workItemToIssuePayload,
  issueToWorkItemFields,
  createGithubIssue,
  createGithubIssueAsync,
  updateGithubIssue,
  updateGithubIssueAsync,
  getGithubIssue,
  getGithubIssueAsync,
  listGithubIssues,
  listGithubIssuesAsync,
  assignGithubIssue,
  assignGithubIssueAsync,
} from './github/issues.js';
