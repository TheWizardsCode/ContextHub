/**
 * src/github-sync.ts — public barrel of the github-sync flows.
 *
 * Concern: the stable public surface consumers import. It re-exports the push
 * flow (`./github-sync/push.js`), the import flow (`./github-sync/import.js`),
 * the result/progress type declarations (`./github-sync/types.js`) and the
 * label-resolution helpers (`./github-sync/labels.js`). The implementation
 * modules depend on `../github.js` and their siblings, never on this barrel, so
 * the dependency direction stays barrel → modules → `../github.js`.
 *
 * Decomposed from the 1,339-line monolith (WL-0MVGKH9Z900178UF); the push flow
 * moved out in child 6 (WL-0MW0JF9QG008E791) and the import flow in child 7
 * (WL-0MW0JFANE006VCGO), leaving this barrel as a thin façade under the
 * 1,000-line ceiling.
 */

// The result/timing/progress type declarations moved to `./github-sync/types.js`
// (WL-0MW0JF5YE008LV1R) and the label-resolution declarations to
// `./github-sync/labels.js` (WL-0MW0JF7QN007E1JU); re-exporting them here keeps
// all of them importable from `'./github-sync.js'` unchanged.
export type {
  SyncedItem,
  SyncErrorItem,
  GithubSyncResult,
  GithubSyncTiming,
  GithubProgress,
} from './github-sync/types.js';
export type { FieldChange } from './github-sync/labels.js';

// The push flow (issue/comment upsert plus parent/child hierarchy linking) moved
// to `./github-sync/push.js` (WL-0MW0JF9QG008E791). Re-exporting it here keeps
// the public function importable from `'./github-sync.js'` unchanged.
export { upsertIssuesFromWorkItems } from './github-sync/push.js';

// Label-derived field resolution moved to `./github-sync/labels.js`
// (WL-0MW0JF7QN007E1JU). Re-exported here so the public functions stay
// importable from `'./github-sync.js'` unchanged; `LABEL_FIELD_CATEGORIES` is
// family-internal and stays unexported from this barrel.
export { resolveLabelField, resolveAllLabelFields } from './github-sync/labels.js';

// The import flow (GitHub issues → work items: hierarchy hints, close-check,
// label event resolution, merge/enforcement and comment import) moved to
// `./github-sync/import.js` (WL-0MW0JFANE006VCGO). Re-exporting it here keeps
// the public name importable from `'./github-sync.js'` unchanged.
export { importIssuesToWorkItems } from './github-sync/import.js';
