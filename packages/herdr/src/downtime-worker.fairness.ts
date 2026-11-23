/**
 * packages/herdr/src/downtime-worker.fairness.ts — per-project fairness
 * accounting for dispatch decisions.
 *
 * Parent: WL-0MWKE9VF800101V9 (dispatcher seems to unevenly distribute work).
 * Work item: WL-0MWKY141H002LULI (record a per-project fairness metric on
 * dispatch decisions, parent AC3).
 *
 * Every dispatch decision records
 *
 *  - `selectedRoot` — the root `selectLeastRecentlyServed` put first this tick
 *    (absent/null only when there was no candidate root at all, never
 *    fabricated);
 *  - `dispatchingRoot` — the root whose offer was actually consumed (absent on
 *    a `no-dispatch` decision);
 *  - `consecutiveRunLength` — the dispatching root's run length INCLUDING this
 *    dispatch.
 *
 * The leader reports two cheap facts on its outcome (`attemptedRoot`, the root
 * whose offer it tried, and — for the registered-root sweep — `selectedRoot`,
 * its own candidate-universe selection). The orchestrator, which already holds
 * the tick's offer snapshot and owns the decision-log write, composes the final
 * evidence here.
 *
 * ## Run-length source (WL-0MWT3Z9M9002Z9BF — leadership-independent)
 *
 * The run length is read from, and written to, a **machine-scoped run ledger**
 * in the coordination directory (`~/.herdr/downtime/downtime-run-by-root.json`
 * via `downtime-run-ledger.ts`), NOT the leader's own decision log.
 *
 * The previous design derived the run length from the tail of the leader's own
 * `<leader-root>/.worklog/downtime-coordination.log`. Because decision rows are
 * appended with the *leader's* `cwd`, a leadership hand-off to a different root
 * left the new leader's log empty of the previous leader's dispatches, so
 * `previousDispatchRun` returned `null` and the ceiling failed **open** for the
 * first two dispatches of every new leadership (two live runs of 3 were the
 * observed consequence, WL-0MWNN84HO004DXQU).
 *
 * The machine ledger is the only leadership-independent store the dispatcher
 * already trusts, is keyed on the same `worklogRoot` identity as the round-robin
 * cursor, and costs one read-modify-write under the existing coordination lock
 * (no nested lock, ~60 dispatches/hour). The full decision and its rejected
 * alternatives are recorded on WL-0MWT3Z9M9002Z9BF and in `downtime-run-ledger.ts`.
 *
 * ## Fail-open
 *
 * A missing/unreadable/corrupt decision log degrades to "no previous
 * dispatch", i.e. a run length of `1`. Nothing here can block, fail or delay a
 * dispatch: every reader returns a total value and never throws.
 */

import type { CoordinationEntry } from './coordination.js';
import {
  readCurrentDispatchRun,
  recordDispatchRun,
} from './downtime-run-ledger.js';
import { selectLeastRecentlyServed, orderRootsLeastRecentlyServed } from './downtime-round-robin-by-root.js';
import { entryOffers } from './downtime-worker.offer-selection.js';

/**
 * Fairness evidence copied onto a dispatch decision entry (WL-0MWKY141H002LULI,
 * parent AC3).
 *
 * `selectedRoot` is `null` only when no candidate root existed. On a
 * successful dispatch `dispatchingRoot` and `consecutiveRunLength` are always
 * present; on a `no-dispatch` decision `dispatchingRoot` is absent rather than
 * fabricated.
 */
export interface FairnessDecisionEvidence {
  /** The root selection put first this tick (`null` = no candidate root). */
  selectedRoot: string | null;
  /** The root whose offer was consumed — absent on a `no-dispatch` decision. */
  dispatchingRoot?: string;
  /** The dispatching root's run length including this dispatch (`>= 1`). */
  consecutiveRunLength?: number;
}

/**
 * The roots the OFFER path can select this tick: one per live instance entry
 * that still advertises at least one offer. Same filter the leader applies
 * before its `selectLeastRecentlyServed` call, so the orchestrator derives the
 * identical selection from its own snapshot.
 */
export function eligibleOfferRoots(entries: readonly CoordinationEntry[]): string[] {
  return entries
    .filter((entry) => entry.instanceId.length > 0 && entryOffers(entry).length > 0)
    .map((entry) => entry.worklogRoot ?? entry.directory);
}

/**
 * The root `selectLeastRecentlyServed` puts first for this tick's offer list.
 * Pure read via the unchanged round-robin cursor (never charges it).
 */
export function selectedRootForTick(
  coordinationDir: string,
  entries: readonly CoordinationEntry[],
): string | null {
  return selectLeastRecentlyServed(coordinationDir, eligibleOfferRoots(entries));
}

/**
 * The consecutive-run bound (parent WL-0MWKE9VF800101V9 AC1): while a peer root
 * has an admissible offer and surplus capacity exists, a root that has already
 * dispatched this many times in succession is deferred behind its peers.
 */
export const RUN_LENGTH_CEILING = 2;

/**
 * Read the previous dispatch run from the MACHINE-scoped run ledger
 * (WL-0MWT3Z9M9002Z9BF).
 *
 * This is the ONE run-length accounting source; the ordering helpers below
 * consume it rather than reading the leader's own decision log, so a leadership
 * hand-off between roots cannot reset a live run to `1`. `coordinationDir` is
 * the machine coordination directory (`~/.herdr/downtime/`), shared by every
 * leader on the host.
 *
 * Fail-open: a missing/unreadable/corrupt ledger (or any read failure) resolves
 * `null` — "no previous dispatch" — so ordering degrades to today's behaviour
 * and dispatch is never blocked, failed or delayed.
 */
export async function readPreviousDispatchRun(
  coordinationDir: string,
): Promise<{ root: string; length: number } | null> {
  try {
    return readCurrentDispatchRun(coordinationDir);
  } catch {
    return null; // fail-open: no history, no deferral
  }
}

/**
 * Defer a run-length ceiling root behind its peers (parent AC1).
 *
 * `orderedRoots` is the whole candidate set in rotation order (fresh — the
 * input is never mutated). When `previousRun` shows the same root dispatched at
 * least {@link RUN_LENGTH_CEILING} times in succession, `surplusCapacity` is
 * true and at least one peer exists, that root is moved to the END of the
 * order: peers are tried first, so the next genuinely admissible peer dispatches
 * instead. A root whose peers are all held still falls through to this root —
 * the bound only bites while a peer has an admissible offer, exactly as parent
 * AC1 states.
 *
 * Pure and total: no I/O, never throws; any condition failing means the order is
 * returned unchanged (fail-open — today's behaviour).
 */
export function deferRunLengthCeilingRoot(
  orderedRoots: readonly string[],
  previousRun: { root: string; length: number } | null,
  surplusCapacity: boolean,
): string[] {
  const ordered = [...orderedRoots];
  if (!surplusCapacity || ordered.length < 2 || previousRun === null) return ordered;
  if (previousRun.length < RUN_LENGTH_CEILING) return ordered;
  const index = ordered.indexOf(previousRun.root);
  if (index < 0) return ordered;
  const [deferred] = ordered.splice(index, 1);
  ordered.push(deferred);
  return ordered;
}

/**
 * Order the leader's ENTIRE entry list for dispatch (WL-0MWKY1839000JM5O).
 *
 * The whole admissible candidate set is rotated, not just the tick's first
 * choice: entries follow {@link orderRootsLeastRecentlyServed} (unknown roots
 * first, least-recently-served first, ties alphabetical), so a
 * selected-but-fully-held root no longer leaves fall-through in raw
 * coordination-file order. The parent AC1 run-length bound then defers a root
 * that already dispatched twice in succession behind its peers while surplus
 * capacity exists, using the decision log (this module's SINGLE run-length
 * source). Stable: entries of one root keep file order, and entries with no
 * candidate root stay last.
 *
 * Pure read of the cursor; the decision-log read is fail-open. Never mutates
 * `entries` and never throws.
 */
export async function orderCoordinationEntriesForDispatch(
  entries: readonly CoordinationEntry[],
  opts: { coordinationDir: string; surplusCapacity: boolean },
): Promise<CoordinationEntry[]> {
  const roots = orderRootsLeastRecentlyServed(opts.coordinationDir, eligibleOfferRoots(entries));
  const previousRun =
    roots.length > 1 ? await readPreviousDispatchRun(opts.coordinationDir) : null;
  const orderedRoots = deferRunLengthCeilingRoot(roots, previousRun, opts.surplusCapacity);
  const rank = new Map(orderedRoots.map((root, index) => [root, index]));
  if (rank.size === 0) return [...entries];
  const rankOf = (entry: CoordinationEntry): number =>
    rank.get(entry.worklogRoot ?? entry.directory) ?? Number.MAX_SAFE_INTEGER;
  return [...entries].sort((a, b) => rankOf(a) - rankOf(b));
}

/**
 * Compose the fairness evidence for one dispatch decision.
 *
 *  - `no-dispatch`: only `selectedRoot` (the sweep's own selection when it
 *    supplied one, else the offer-path selection). `dispatchingRoot` is absent
 *    rather than fabricated.
 *  - `dispatched`: `selectedRoot` plus the root that actually dispatched and
 *    its run length, RECORDED to (and returned from) the machine-scoped run
 *    ledger so the log and the ledger name the same value.
 *
 * This is the SINGLE write site for the run ledger: every dispatched outcome
 * that carries a `dispatchingRoot` (offer path, registered-root sweep, own
 * backlog) passes through here, so the accounting covers all dispatch paths
 * and stays leadership-independent.
 *
 * `tickSelectedRoot` may be `null` when the offer list selected nothing (for
 * example an own-backlog dispatch); a successful dispatch then names its own
 * dispatching root as the selection rather than recording a misleading null.
 */
export async function dispatchDecisionFairness(input: {
  coordinationDir: string;
  tickSelectedRoot: string | null;
  selectedRootOverride?: string | null;
  dispatchingRoot?: string;
  dispatched: boolean;
}): Promise<FairnessDecisionEvidence> {
  const { coordinationDir, tickSelectedRoot, selectedRootOverride, dispatchingRoot, dispatched } =
    input;
  if (!dispatched || dispatchingRoot === undefined) {
    return { selectedRoot: selectedRootOverride ?? tickSelectedRoot };
  }
  return {
    selectedRoot: selectedRootOverride ?? tickSelectedRoot ?? dispatchingRoot,
    dispatchingRoot,
    consecutiveRunLength: recordDispatchRun(coordinationDir, dispatchingRoot),
  };
}
