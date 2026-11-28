/**
 * packages/herdr/src/downtime-worker.claim-dependency-guard.ts — dispatch-time
 * dependency re-check at the claim/spawn boundary.
 *
 * Single responsibility: immediately before a downtime pane is CLAIMED and
 * spawned, answer "does this item still have a live outbound `depends-on` edge
 * to a non-terminal item?" and refuse the dispatch when it does (or when the
 * lookup cannot be trusted). This is DEFENCE IN DEPTH under the selection-side
 * guards (F2, `resolveHeadDependencyFrontier`): no selection path, resumed
 * offer, stale marker or peer instance's coordination hand-off can reach a
 * claim on a dependency-blocked item.
 *
 * Parent: WL-0MWWLLGD2001QKAL (bug: dispatching implement on a
 * dependency-blocked critical item). This item: WL-0MWWMPCD2008HSSP.
 *
 * ## Why the claim boundary, not only selection
 *
 * Selection-side guards cannot cover an offer computed by a PEER instance: the
 * leader claims and spawns an offer it did not compute (`fetchItem` carries no
 * dependency-edge information). Re-checking at the ONE shared claim boundary
 * (`dispatchClaimedTier`) closes that gap on every path at once — direct head
 * dispatch, the coordination offer loop, the own-backlog fallback, the
 * registered-root sweep and the legacy tier chain.
 *
 * ## Rules
 *
 *  - NON-audit kinds only. The audit tier re-checks freshness at dispatch time
 *    (`hasFreshAudit`) and audits completed/in_review items, which are never
 *    waiting on an outbound dependency.
 *  - A LIVE edge (target not `completed`/`deleted` and not at an `in_review`/
 *    `done` stage — the shared {@link isActiveBlocker} predicate) refuses the
 *    dispatch with the stable {@link DEPENDENCY_BLOCKED_REASON} token.
 *  - A failed lookup (thrown `wl dep list`/`wl show`, or the legacy `null`
 *    fail-closed signal) refuses it with {@link DEPENDENCY_LOOKUP_FAILED_REASON}
 *    — fail closed, never a silent wrong target.
 *  - Both refusals are NEUTRAL: `dispatchClaimedTier` returns before the claim,
 *    so no attempt-budget strike, no non-terminal cooldown and no pane are
 *    recorded; the next idle tick re-checks.
 *  - The seam is optional: absent (legacy/test callers) leaves every existing
 *    caller byte-identical.
 *
 * ## Memoisation (one `wl dep list` per candidate per TICK)
 *
 * A dispatch entry point (a tick) creates ONE {@link DependencyRecheckMemo} and
 * shares it with both the F2 selection guard and this claim guard, so a
 * candidate is read at most once per tick even when two scans of the same tick
 * visit it. {@link memoizeBlockerFetcher} keys the cache by `cwd` + item id
 * (cross-root offers resolve against their OWN worklog root).
 */

import { isActiveBlocker } from './fetcher.blockers.js';
import type { CriticalCandidate } from './downtime-worker.parsers.js';
import type { DowntimeSkillKind } from './downtime-worker.types.js';

/**
 * Neutral decision-log token for a live outbound dependency at the claim
 * boundary. The same token names the offer path's dependency gate
 * (`downtime-worker.coordination.ts`), so the vocabulary of record is shared.
 */
export const DEPENDENCY_BLOCKED_REASON = 'dependency-blocked';

/**
 * Neutral decision-log token for an untrustworthy dependency lookup
 * (`wl dep list` thrown or unparseable). Shared with the F2 selection guard
 * (`resolveHeadDependencyFrontier`) so a broken lookup reads identically on
 * every path.
 */
export const DEPENDENCY_LOOKUP_FAILED_REASON = 'dependency-lookup-failed';

/** The claim guard's verdict for ONE candidate. */
export type DependencyRecheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: typeof DEPENDENCY_BLOCKED_REASON | typeof DEPENDENCY_LOOKUP_FAILED_REASON;
      /** The candidate the verdict belongs to (decision-log evidence). */
      itemId: string;
    };

/**
 * The dependency slice the claim guard reads — structurally named so this leaf
 * module never imports the barrel (`DowntimeWorkerDeps` lives there).
 */
export interface DependencyRecheckDeps {
  fetchCriticalBlockers?(cwd: string, itemId: string): Promise<CriticalCandidate[] | null>;
}

/**
 * One tick's blocker-read cache. Created per dispatch entry point and shared by
 * the selection guard (`resolveHeadDependencyFrontier`) and this claim guard.
 */
export interface DependencyRecheckMemo {
  /** `cwd \0 itemId` → the in-flight/settled outbound-blocker read. */
  readonly blockers: Map<string, Promise<CriticalCandidate[] | null>>;
}

/** Create the empty memo for one dispatch tick. */
export function createDependencyRecheckMemo(): DependencyRecheckMemo {
  return { blockers: new Map() };
}

/**
 * Wrap a blocker fetcher so each `cwd` + item id is read at most once per memo
 * (one dispatch tick). The in-flight promise is cached, so two concurrent
 * callers share the SINGLE `wl dep list` rather than racing a second one.
 */
export function memoizeBlockerFetcher(
  fetch: (cwd: string, itemId: string) => Promise<CriticalCandidate[] | null>,
  memo: DependencyRecheckMemo,
): (cwd: string, itemId: string) => Promise<CriticalCandidate[] | null> {
  return (cwd, itemId) => {
    const key = `${cwd}\u0000${itemId}`;
    const cached = memo.blockers.get(key);
    if (cached !== undefined) return cached;
    const read = Promise.resolve().then(() => fetch(cwd, itemId));
    memo.blockers.set(key, read);
    return read;
  };
}

/**
 * Re-check a candidate's outbound dependencies immediately before the claim.
 * AUDIT kinds and a missing seam are admitted unchanged; every other kind is
 * refused when a live outbound blocker exists or the lookup cannot be trusted.
 */
export async function recheckDependenciesForClaim(
  deps: DependencyRecheckDeps,
  kind: DowntimeSkillKind,
  itemId: string,
  cwd: string,
  memo?: DependencyRecheckMemo,
): Promise<DependencyRecheckResult> {
  if (kind === 'audit') return { ok: true };
  const seam = deps.fetchCriticalBlockers;
  if (seam === undefined) return { ok: true };
  const fetch = memo === undefined ? seam : memoizeBlockerFetcher(seam, memo);
  try {
    const blockers = await fetch(cwd, itemId);
    // The legacy fail-closed signal: the read answered, but not trustworthily.
    if (blockers === null) {
      return { ok: false, reason: DEPENDENCY_LOOKUP_FAILED_REASON, itemId };
    }
    if (blockers.some(isActiveBlocker)) {
      return { ok: false, reason: DEPENDENCY_BLOCKED_REASON, itemId };
    }
    return { ok: true };
  } catch {
    // A thrown `wl`/parse failure is NEVER an empty frontier (fail closed).
    return { ok: false, reason: DEPENDENCY_LOOKUP_FAILED_REASON, itemId };
  }
}

/**
 * True when a dispatch outcome is a dependency hold — the claim-boundary
 * refusal (or the F2 selection refusal, which shares the token). Callers use it
 * to end the tick on the NEUTRAL reason instead of `no-candidate`, so a
 * dependency-blocked item never arms the no-candidate cooldown.
 */
export function isDependencyHoldOutcome(outcome: { reason?: string }): boolean {
  return (
    outcome.reason === DEPENDENCY_BLOCKED_REASON ||
    outcome.reason === DEPENDENCY_LOOKUP_FAILED_REASON
  );
}
