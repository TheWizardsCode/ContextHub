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
 * ## Run-length source (design decision, recorded for the fix item)
 *
 * The run length is **derived from the tail of the coordination decision log**
 * rather than stored in a second durable cursor. Rationale:
 *
 *  - restart-safe and single-source-of-truth: a restarted leader reads the
 *    same history an auditor reads;
 *  - no new on-disk state and no extra lock acquisition — the on-disk
 *    round-robin cursor (`downtime-round-robin-by-root.json`) keeps its
 *    documented `{ "<worklogRoot>": "<ISO-8601>" }` format unchanged;
 *  - one bounded local file read per consumed offer (the log is already
 *    written per root and capped by the rolling policy).
 *
 * A durable run cursor was rejected because it would add a file, an extra
 * coordination-lock acquisition and a second source of truth that can drift
 * from the entry it describes.
 *
 * ## Fail-open
 *
 * A missing/unreadable/corrupt decision log degrades to "no previous
 * dispatch", i.e. a run length of `1`. Nothing here can block, fail or delay a
 * dispatch: every reader returns a total value and never throws.
 */

import type { CoordinationEntry } from './coordination.js';
import {
  readCoordinationLogEntries,
  type CoordinationLogEntry,
} from './downtime-log-coordination.js';
import { selectLeastRecentlyServed } from './downtime-round-robin-by-root.js';
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

/** A decision entry as the run-length scan needs to see it (defensive read). */
function dispatchRunOf(entry: CoordinationLogEntry): {
  root: string;
  length: number | null;
} | null {
  if (entry.kind !== 'decision') return null;
  const root = entry.dispatchingRoot;
  if (typeof root !== 'string' || root.length === 0) return null;
  const length =
    typeof entry.consecutiveRunLength === 'number' &&
    Number.isFinite(entry.consecutiveRunLength) &&
    entry.consecutiveRunLength > 0
      ? Math.trunc(entry.consecutiveRunLength)
      : null;
  return { root, length };
}

/**
 * The most recent dispatch recorded in a decision-log history: its dispatching
 * root and the run length it recorded (or, for an older entry that predates the
 * field, the number of consecutive same-root entries visible in the tail).
 *
 * Entries that are not dispatch decisions (`no-dispatch` refusals, check-ins,
 * prune records) are skipped — a no-dispatch tick neither extends nor breaks a
 * run of dispatches. Returns `null` when the history holds no dispatch.
 *
 * Pure and total: never throws, tolerant of malformed entries.
 */
export function previousDispatchRun(
  entries: readonly CoordinationLogEntry[],
): { root: string; length: number } | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const current = dispatchRunOf(entries[i]);
    if (current === null) continue;
    if (current.length !== null) {
      return { root: current.root, length: current.length };
    }
    // No recorded length (an entry written before the field existed): count
    // the consecutive same-root dispatch entries visible in the tail.
    let length = 0;
    for (let j = i; j >= 0; j -= 1) {
      const row = dispatchRunOf(entries[j]);
      if (row === null) continue;
      if (row.root !== current.root) break;
      length += 1;
    }
    return { root: current.root, length };
  }
  return null;
}

/**
 * The consecutive-run length to record for a dispatch to `root`, given the
 * decision-log history: one more than the previous dispatch's run when that
 * dispatch went to the same root, otherwise `1`.
 *
 * Pure and total: a corrupt/absent history (or any parse failure by the
 * caller) yields the fail-open default `1`.
 */
export function nextConsecutiveRunLength(
  entries: readonly CoordinationLogEntry[],
  root: string,
): number {
  if (root.length === 0) return 1;
  const previous = previousDispatchRun(entries);
  if (previous === null || previous.root !== root) return 1;
  return previous.length + 1;
}

/**
 * Read this leader's bounded decision log (`<cwd>/.worklog/downtime-coordination.log`)
 * and compute the run length for `root`.
 *
 * Fail-open: an unreadable/absent log is "no history", so a dispatch still
 * records the default `1` and proceeds — never blocks, fails or delays.
 */
export async function nextRunLengthForRoot(cwd: string, root: string): Promise<number> {
  try {
    const entries = await readCoordinationLogEntries(cwd);
    return nextConsecutiveRunLength(entries, root);
  } catch {
    return 1; // fail-open: unknown history records the default run length
  }
}

/**
 * Compose the fairness evidence for one dispatch decision.
 *
 *  - `no-dispatch`: only `selectedRoot` (the sweep's own selection when it
 *    supplied one, else the offer-path selection). `dispatchingRoot` is absent
 *    rather than fabricated.
 *  - `dispatched`: `selectedRoot` plus the root that actually dispatched and
 *    its run length, read fail-open from the decision log.
 *
 * `tickSelectedRoot` may be `null` when the offer list selected nothing (for
 * example an own-backlog dispatch); a successful dispatch then names its own
 * dispatching root as the selection rather than recording a misleading null.
 */
export async function dispatchDecisionFairness(input: {
  cwd: string;
  tickSelectedRoot: string | null;
  selectedRootOverride?: string | null;
  dispatchingRoot?: string;
  dispatched: boolean;
}): Promise<FairnessDecisionEvidence> {
  const { cwd, tickSelectedRoot, selectedRootOverride, dispatchingRoot, dispatched } = input;
  if (!dispatched || dispatchingRoot === undefined) {
    return { selectedRoot: selectedRootOverride ?? tickSelectedRoot };
  }
  return {
    selectedRoot: selectedRootOverride ?? tickSelectedRoot ?? dispatchingRoot,
    dispatchingRoot,
    consecutiveRunLength: await nextRunLengthForRoot(cwd, dispatchingRoot),
  };
}
