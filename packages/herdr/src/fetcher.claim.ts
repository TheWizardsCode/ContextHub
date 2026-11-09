/**
 * packages/herdr/src/fetcher.claim.ts — work-item claim, rollback and
 * needs-producer-review mutations.
 *
 * Single responsibility: the work-item write mutations the dispatcher issues
 * around handing an item to an agent — the tier-aware claim
 * (`claimWorkItem`), the pre-dispatch rollback (`rollbackClaimWorkItem`) and
 * the budget-exhausted producer-review flag
 * (`markNeedsProducerReviewWorkItem`) — plus the `CLAIM_TIMEOUT_MS` bound that
 * keeps a hung `wl` CLI from delaying an agent pane. The read path, the bundle
 * caches and the critical-child root substitution stay in their own leaves.
 *
 * Leaf module: it imports only concrete siblings (`./fetcher.cli.js` for the
 * `wl` spawn and `./fetcher.types.js` for the `ClaimResult` shape) plus the
 * `node:path` builtin; it never imports the `./fetcher.js` barrel (parent AC4).
 *
 * Moved verbatim out of `fetcher.ts` (parent WL-0MVGKH47T007GKN1; extraction
 * WL-0MW08VY7W009DK5W). No behaviour change: the 3 s claim timeout, the
 * audit-tier status-neutral `--if-assignee ""` CAS, the
 * `--if-status`/`--if-stage` guards, both rollback argument vectors and the
 * `reviewed <id> true` invocation are unchanged.
 */

import { join } from 'node:path';
import { runWl } from './fetcher.cli.js';
import type { ClaimResult } from './fetcher.types.js';


// ── Work-item claiming ────────────────────────────────────────────────

/**
 * Timeout for claim status updates so a hung `wl` CLI cannot delay the
 * agent pane from opening (AC2: failures must not block the pane).
 */
const CLAIM_TIMEOUT_MS = 3000;

/**
 * Claim a work item before dispatching an agent command. For every tier
 * except audit the claim sets its status to `in_progress` with the given
 * assignee, matching the claim pattern documented in AGENTS.md. For the
 * audit tier (`expected` = `completed`/`in_review`) the claim is
 * STATUS-NEUTRAL: it writes only the assignee, guarded by
 * `--if-status completed --if-stage in_review --if-assignee ""`, so an
 * audited item never enters the `in_progress`/`in_review` hybrid
 * (WL-0MV85WCJJ0087VMP). Targets the configured worklog database via
 * `--worklog-dir` when set.
 *
 * With `expected` (status/stage), the claim is a compare-and-swap (RCA
 * WL-0MSRBFFLN005W3VT design point 1): `--if-status`/`--if-stage` are
 * passed to `wl update`, so the transition only applies while the item is
 * still in the state the tier selected it in. The audit tier additionally
 * CASes on the empty assignee (`--if-assignee ""`), so assigning an item
 * makes the claim fail stale. Exactly one concurrent pane wins; a loser
 * gets `{success:false, stale:true}` and the caller aborts the dispatch. A
 * stale result is detected from the wl CLI's `"error": "stale"` JSON
 * payload on stderr.
 *
 * `worklogRoot` (optional, WL-0MTQ14W7L003II5A) targets the update at a
 * specific worklog root's database via per-call `--worklog-dir` — the
 * downtime leader's cross-root claims (coordination offers live in the
 * offering instance's root, not the leader's). Undefined → the module
 * override (or ambient cwd) decides, as before.
 *
 * Never throws — failures are returned so callers can log them without
 * blocking the agent pane from opening.
 */
export async function claimWorkItem(
  id: string,
  assignee: string,
  expected?: { status?: string; stage?: string },
  worklogRoot?: string,
  migrateStage?: string,
): Promise<ClaimResult> {
  try {
    // Status-neutral audit-tier claim (WL-0MV85WCJJ0087VMP): an audited
    // `completed`/`in_review` item must never enter the `in_progress`/
    // `in_review` hybrid the stranding autocracies were built on. The claim
    // therefore writes ONLY the assignee — no `--status`/`--stage` — guarded
    // by the tier's status/stage expectation AND the empty-assignee CAS. A
    // failed audit restores by clearing the assignee, so the item never
    // leaves the review queue. Every other tier keeps the status-flip claim.
    const isAuditTier = expected?.status === 'completed' && expected?.stage === 'in_review';
    const args = isAuditTier
      ? [
          'update',
          id,
          '--assignee',
          assignee,
          '--if-status',
          expected.status as string,
          '--if-stage',
          expected.stage as string,
          // `""` is a meaningful expected value: only an UNASSIGNED item may
          // be claimed, so a concurrent/human assignee makes the claim stale.
          '--if-assignee',
          '',
        ]
      : ['update', id, '--status', 'in_progress', '--assignee', assignee];
    if (!isAuditTier) {
      if (expected?.status) {
        args.push('--if-status', expected.status);
      }
      if (expected?.stage) {
        args.push('--if-stage', expected.stage);
      }
      // Retired-stage recovery (WL-0MTYL7DX9000MZOH): an item stuck on a stage
      // that is no longer valid (e.g. the removed `in_progress` stage) cannot
      // satisfy the tier's normalised stage CAS. In that case the caller passes
      // the tier's target stage as an atomic MIGRATION — the CAS guard still
      // matches the item's ACTUAL (retired) stage for race safety, while
      // `--stage` advances the stored value to a valid stage in the same write.
      // Without this, the claim is rejected by the status/stage validator and
      // counted as a hard wl-error strike.
      if (migrateStage !== undefined) {
        args.push('--stage', migrateStage);
      }
    }
    // Per-call --worklog-dir targeting (WL-0MTQ14W7L003II5A): the downtime
    // leader claims coordination offers in the OFFER's own worklog root,
    // which may differ from the module override (the leader pane's root).
    // Passing the root resolves the update against the item's own database;
    // absent/undefined keeps the historical module-override behavior.
    const dirOverride = worklogRoot !== undefined ? join(worklogRoot, '.worklog') : undefined;
    await runWl(args, true, CLAIM_TIMEOUT_MS, dirOverride);
    return { success: true };
  } catch (err: any) {
    const message = err.message ?? String(err);
    // Lost CAS race: the wl CLI exits non-zero with `{"success":false,
    // "error":"stale", ...}` on stderr (runWl surfaces stderr first).
    const stale =
      message.includes('"error":"stale"') ||
      message.includes('"error": "stale"') ||
      message.includes("'stale'") ||
      message.includes('Conditional update skipped');
    return { success: false, stale, error: message };
  }
}

/**
 * Roll back a pre-dispatch CAS claim that succeeded but never completed
 * dispatch (WL-0MT32F908002YFFA AC1/AC2): restore the item to its
 * pre-claim status + stage so a future idle period can re-select it. Used
 * when the dispatch marker cannot be written (`marker-write-failed`) or the
 * pane spawn fails (`spawn-failed`) — in both cases the CAS claimed the item
 * (`in_progress`) but no agent is working it, so leaving it claimed strands
 * it in a state no tier selects.
 *
 * The reverse transition is guarded by the SAME race-safe CAS shape as the
 * claim: `--if-status in_progress` (plus `--if-stage <original.stage>` when
 * known) ensures only THIS claim's state is reverted. A concurrent
 * human/agent that already moved the item makes the update stale → resolves
 * `false` (nothing to roll back) and never clobbers their change.
 *
 * `original.status` defaults to `open` (the plan/intake/implement/risk-effort
 * tiers); the audit tier passes `completed` so a failed audit dispatch
 * returns to the audit queue rather than the open backlog. When
 * `original.assignee` is a non-empty string (the audit tier,
 * WL-0MV85WCJJ0087VMP) the rollback is STATUS-NEUTRAL: it clears only the
 * claiming agent's assignee, guarded by `--if-assignee <agent>`, and never
 * rewrites status/stage. `worklogRoot` targets that root's database via
 * per-call `--worklog-dir` (the same cross-root convention as
 * `claimWorkItem`).
 *
 * Never throws — a failure resolves `false` so the caller can fall back to
 * the fail-closed abort outcome.
 */
export async function rollbackClaimWorkItem(
  id: string,
  original?: { status?: string; stage?: string; assignee?: string },
  worklogRoot?: string,
): Promise<boolean> {
  try {
    // The audit tier's claim is STATUS-NEUTRAL (WL-0MV85WCJJ0087VMP): it
    // writes only the assignee and never flips status/stage, so its rollback
    // must likewise not rewrite them — it clears only the claiming agent's
    // assignee, guarded by `--if-assignee <agent>` so a concurrent assignee
    // change makes the rollback stale (no clobber). Every OTHER tier keeps
    // the legacy status/stage restore but ALSO clears THIS claim's assignee
    // (guarded by `--if-assignee <agent>`) so a failed dispatch never leaves a
    // non-empty assignee behind. A non-empty assignee is a scheduling hold
    // (WL-0MV85WDOM007BKF8): residue would make the item permanently
    // undispatchable after a marker-write/spawn failure
    // (WL-0MV85WD400091OZ6). When the claiming agent is unknown the legacy
    // restore is applied as before (fail-safe: no stricter claim than the
    // original).
    const isAuditTier =
      original?.status === 'completed' && original?.stage === 'in_review';
    const claimedAgent = original?.assignee;
    const hasClaimedAgent = typeof claimedAgent === 'string' && claimedAgent.length > 0;
    let args: string[];
    if (isAuditTier && hasClaimedAgent) {
      // Status-neutral, assignee-guarded clear (Option A).
      args = ['update', id, '--assignee', '', '--if-assignee', claimedAgent as string];
    } else if (isAuditTier) {
      // No claimed agent known: best-effort restore of the review-queue state
      // (never the plan_complete coercion that stranded items).
      args = ['update', id, '--status', 'completed', '--stage', original?.stage ?? 'in_review'];
    } else {
      // Legacy status/stage restore + clear THIS claim's assignee (hold).
      args = ['update', id, '--status', original?.status ?? 'open', '--if-status', 'in_progress'];
      if (original?.stage) {
        args.push('--if-stage', original.stage);
        args.push('--stage', original.stage);
      }
      if (hasClaimedAgent) {
        args.push('--assignee', '');
        args.push('--if-assignee', claimedAgent as string);
      }
    }
    const dirOverride = worklogRoot !== undefined ? join(worklogRoot, '.worklog') : undefined;
    await runWl(args, true, CLAIM_TIMEOUT_MS, dirOverride);
    return true;
  } catch {
    // Fail-closed: a failed/stale rollback resolves false (the caller reports
    // the failure and leaves the item as-is — no worse than before recovery).
    return false;
  }
}

/**
 * Flag a work item as needing producer review (`needsProducerReview = true`)
 * via `wl reviewed <id> true` (WL-0MUKYEXMK0033MFK AC3). The downtime
 * dispatcher calls this once an item exhausts its per-item/per-kind attempt
 * budget so it surfaces for human triage instead of looping through idle
 * cycles. `worklogRoot` targets that root's database via per-call
 * `--worklog-dir` (the same cross-root convention as `claimWorkItem`).
 *
 * Idempotent: setting the flag true when it is already true is a no-op.
 * Never throws — a failure resolves `false` (fail-closed: the dispatcher
 * still skips the budget-exhausted item and retries the flag next cycle).
 */
export async function markNeedsProducerReviewWorkItem(
  id: string,
  worklogRoot?: string,
): Promise<boolean> {
  try {
    const dirOverride = worklogRoot !== undefined ? join(worklogRoot, '.worklog') : undefined;
    await runWl(['reviewed', id, 'true'], true, CLAIM_TIMEOUT_MS, dirOverride);
    return true;
  } catch {
    return false;
  }
}
