/**
 * src/sync/merge-predicates.ts — merge decision predicates.
 *
 * Concern: the "is this a regression / a default / a protected close / a real
 * delete?" decisions that steer field-level merge resolution — the regression
 * guard (WL-0MV85WBZ2004VDUQ), the empty-meaningful assignee hold, the
 * terminal close stages and the attributed-delete test.
 *
 * Moved verbatim from `src/sync.ts` (WL-0MVP9QLWU003NV41, child 3 of 6 of the
 * WL-0MVGKGMU400631VZ `src/sync.ts` decomposition). Move-only: no logic
 * edited, no signature changed, no symbol renamed.
 *
 * Public surface (re-exported from the `./sync.js` barrel):
 * `isRegressionDefault`, `isValueRegression`, `isEmptyMeaningfulField`,
 * `isTerminalStage`.
 *
 * `EMPTY_IS_MEANINGFUL_FIELDS` stays module-local (only
 * `isEmptyMeaningfulField` reads it). `isAttributedDelete` is exported for
 * `./field-merge.js` only — it is NOT added to the `src/sync.ts` public
 * surface. The dependency edge here is leaf-ward: nothing imports this module
 * except the merge modules and the barrel.
 */

import type { WorkItem } from '../types.js';

/**
 * Regression-guard definition of "default" for merge-participating fields.
 * These are the values that constitute a regression when they appear on the
 * remote side while the local side has a meaningful non-default value.
 *
 * This is DISTINCT from `isDefaultValue` which only treats ''/undefined/[] as
 * defaults.  The regression guard uses a broader definition so that
 * `status: open`, `stage: idea`, `priority: medium` are recognised as defaults
 * that signal data loss when they overwrite local non-default values.
 *
 * `assignee` is intentionally NOT a regression-guarded field
 * (WL-0MV85WBZ2004VDUQ, epic Q1 option (a)).  It is a scheduling hold whose
 * clear must propagate cross-root, so an empty value is treated as meaningful
 * intent and resolved by timestamp rather than refused as a regression.
 */
export function isRegressionDefault(value: unknown, field: string): boolean {
  if (value === undefined || value === '') {
    // `assignee` is a scheduling hold whose clear is meaningful intent
    // (WL-0MV85WBZ2004VDUQ, Q1 option (a)) — empty is never a regression.
    return field !== 'assignee';
  }
  const str = String(value);
  switch (field) {
    case 'status':
      // 'open' is the default; everything else is a real value.
      return str === 'open';
    case 'stage':
      // 'idea' is the default; everything else is a real value.
      return str === 'idea';
    case 'priority':
      // 'medium' is the default.
      return str === 'medium';
    default:
      return false;
  }
}

/**
 * Check whether a remote value is a "regression default" while the local
 * value is a meaningful non-default — the core regression-detection predicate.
 */
export function isValueRegression(localValue: unknown, remoteValue: unknown, field: string): boolean {
  return !isRegressionDefault(localValue, field) && isRegressionDefault(remoteValue, field);
}

/**
 * Merge fields whose empty value carries intent rather than signalling
 * absence, so it must NOT take part in the "prefer non-default" heuristic.
 *
 * `assignee` is a scheduling hold (WL-0MV85WBZ2004VDUQ, epic Q1 option (a)):
 * assigning an item holds it from auto-dispatch and clearing the assignee
 * releases it.  If `''` were treated as a default, a newer remote clear would
 * either be refused as a regression (old behaviour) or lose to a stale local
 * non-empty value — both resurrect stale claims.  Resolving such fields by
 * timestamp/tie-break like any other field lets a newer clear win, so it
 * propagates cross-root without `--accept-regressions`.
 */
const EMPTY_IS_MEANINGFUL_FIELDS: ReadonlySet<string> = new Set(['assignee']);

/** True when `field`'s empty value is meaningful (never treated as a default). */
export function isEmptyMeaningfulField(field: string): boolean {
  return EMPTY_IS_MEANINGFUL_FIELDS.has(field);
}

/**
 * Terminal (closed) workflow stages. An item with `completed` status and a
 * terminal stage is a protected close state: it must never be silently
 * reverted by a stale remote `open`/`in_progress` copy during merge.
 *
 * `in_review` is the standard 'ready for review' state after a pi audit — a
 * closed state until manually reopened (WL-0MSPZP7FE009YXPG).
 *
 * Whitelist per approved plan: {done, in_review}. Custom stages are NOT
 * protected and fall back to normal timestamp/lexicographic resolution.
 */
export function isTerminalStage(stage: string | undefined): boolean {
  return stage === 'done' || stage === 'in_review';
}

/**
 * DELETE-SIDE PROTECTION (WL-0MSKZ30SK007K9TO): an attributed delete carries real
 * intent — non-empty `deletedBy` (who) or `deleteReason` (why). Unattributed
 * `status='deleted'` markers (empty both) are NOT real deletes and must never
 * override a live remote/local item (mirrors the close-preservation model that
 * protects `status='completed'`).
 */
export function isAttributedDelete(item: WorkItem): boolean {
  return Boolean(item.deletedBy) || Boolean(item.deleteReason);
}
