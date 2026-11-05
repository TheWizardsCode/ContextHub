/**
 * packages/herdr/src/fetcher.review-queue.ts — review-queue banner state
 * derivation and query.
 *
 * Single responsibility: turn review-queue items into the sprint-complete /
 * queue-depth banner state (`count` + `auditsOutstanding`) and fetch that
 * state, preferring the consolidated bundle already read in this refresh over
 * a second `wl` spawn. The bundle's snapshot TTL/cache contract itself lives
 * in `./fetcher.worklist-bundle.js`; this module only consumes it.
 *
 * Leaf module: it imports only concrete siblings (`./fetcher.worklist-bundle.js`
 * for the bundle reads, `./fetcher.cli.js` for the `wl` spawn and
 * `./fetcher.json.js` for payload extraction) plus `import type` for
 * `WorkItem`/`ReviewQueueState` from `./fetcher.types.js`; it never imports the
 * `./fetcher.js` barrel (parent AC4).
 *
 * Moved verbatim out of `fetcher.ts` (parent WL-0MVGKH47T007GKN1; extraction
 * WL-0MW08VW3L003U3HG). No behaviour change: the status filter
 * (`completed,in-progress`), stage `in_review`, `--root-only`, the
 * completed-only banner count and the audit-freshness predicate are unchanged.
 */

import { isAuditFresh } from '@worklog/shared/icons';
import { runWl } from './fetcher.cli.js';
import { extractItems, extractJson } from './fetcher.json.js';
import type { ReviewQueueState, WorkItem, WorklistBundle } from './fetcher.types.js';
import { pendingWorklistBundle, recentWorklistBundle } from './fetcher.worklist-bundle.js';

/**
 * Derive the review-queue state from a bundle's `reviewQueue` subset: the
 * root-only in_review items with status `completed`, plus whether any of them
 * still lacks a current audit. Kept identical to the standalone-query
 * derivation so the banner is unchanged.
 */
function reviewQueueStateFromItems(items: WorkItem[]): ReviewQueueState {
  const completed = items.filter((item) => item.status === 'completed');
  const auditsOutstanding = completed.some((item) =>
    !isAuditFresh(item.auditedAt, item.updatedAt, item.fingerprint, item.currentFingerprint),
  );
  return { count: completed.length, auditsOutstanding };
}

/**
 * Review-queue state from a bundle read earlier in this refresh (same worklog
 * dir, within the bundle module's snapshot TTL), or `undefined` when there is
 * none — the caller then runs the standalone query.
 */
function snapshotReviewQueueState(): ReviewQueueState | undefined {
  const bundle: WorklistBundle | undefined = recentWorklistBundle();
  return bundle === undefined ? undefined : reviewQueueStateFromItems(bundle.reviewQueue);
}

/**
 * The exact `wl list` invocation backing the root-only in_review review
 * queue. Shared so `fetchMandatorySubsets` (the barrel) and
 * {@link fetchReviewQueueState} build an IDENTICAL argument vector — the
 * in-flight fetch memo then deduplicates the two concurrent calls into a
 * single `wl` spawn per refresh (WL-0MV5CBQ6L005SPAG). Changing one query
 * without the other silently reintroduces the duplicate spawn.
 *
 * The status filter spans BOTH `completed` (awaiting producer review) and
 * `in-progress` (being re-worked after review feedback, WL-0MV6JGVPH009YDXB)
 * — the mandatory review set must show both, matching the smart-selection
 * predicate in selectWorkItems.
 */
export function reviewQueueArgs(): string[] {
  return ['list', '--status', 'completed,in-progress', '--stage', 'in_review', '--root-only'];
}

/**
 * Fetch the review-queue state (root-only in_review items with status
 * `completed`) for the sprint-complete / queue-depth banner (parent
 * WL-0MTHSHN5V008R5L0; banner copy selection AH-0MUDYTQ55002NUSJ). Returns
 * the count and whether an outstanding audit remains, or undefined on
 * failure — callers treat undefined as "unknown" and leave state unchanged
 * (fail-closed, AC1).
 *
 * Uses `wl list --status completed,in-progress --stage in_review
 * --root-only --json` — the SAME query as the mandatory review subset (see
 * {@link reviewQueueArgs}), so the in-flight memo deduplicates the two into
 * ONE spawn — and then keeps only the `completed` items in-process. This
 * preserves the banner's historical "completed/in_review" semantics while
 * the mandatory worklist subset consumes the full (completed + in-progress)
 * set (WL-0MV6JGVPH009YDXB). In-progress/in_review items are excluded here
 * because they are being re-worked after review feedback: they are not
 * dispatchable to the audit tier (which selects completed/in_review only),
 * so counting them in "focus on audits" would be misleading.
 *
 * "Outstanding audit" reuses the shared `isAuditFresh` predicate: a missing `auditedAt`
 * or a stored audit that is not current counts as outstanding; a fresh
 * audit (passed or failed) does not. `wl list --json` exposes
 * `currentFingerprint` for items that carry a stored fingerprint, so the
 * predicate uses the primary content gate rather than the 60 s time gate
 * (WL-0MUN7QWFP0010EQC); items without a stored fingerprint still fall back
 * to the time gate. A CLI error or unparseable output resolves to
 * undefined (never throws).
 *
 * Root-only is intentional (WL-0MSTLFW14000KPEC): children are not counted as
 * independent review-queue entries — a completed/in_review child is covered by
 * its parent's audit (derived at read time for display, WL-0MUBVH8QG0020H9L)
 * and is never dispatched for audit independently.
 */
export async function fetchReviewQueueState(): Promise<ReviewQueueState | undefined> {
  // Derive from the consolidated bundle when one was already read (or is in
  // flight) in this refresh (WL-0MVI0IT4S0070G78): the bundle's `reviewQueue`
  // subset is the same query this function used to issue, so the banner needs
  // no second `wl` spawn on the default view.
  const pending = pendingWorklistBundle();
  if (pending !== null) {
    const bundle = await pending.catch(() => null);
    if (bundle) return reviewQueueStateFromItems(bundle.reviewQueue);
  }
  const fromBundle = snapshotReviewQueueState();
  if (fromBundle !== undefined) return fromBundle;

  try {
    // Identical args to the barrel's `fetchMandatorySubsets` review query so
    // the in-flight memo deduplicates the two into ONE spawn when a refresh
    // schedules both concurrently (WL-0MV5CBQ6L005SPAG).
    const output = await runWl(reviewQueueArgs());
    const payload = extractJson(output);
    return reviewQueueStateFromItems(extractItems(payload));
  } catch {
    // Fail-closed: a query failure means we cannot determine queue state
    // — the conservative default is to leave the banner state unchanged (AC1).
    return undefined;
  }
}
