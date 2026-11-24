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
 * The run length is read from a **machine-scoped run ledger** in the
 * coordination directory (`~/.herdr/downtime/downtime-run-by-root.json` via
 * `downtime-run-ledger.ts`), NOT the leader's own decision log. The ledger is
 * written by the round-robin charge itself (`advanceRoot`), in the SAME
 * coordination-lock critical section that advances the cursor, on every
 * **consumed** outcome (`dispatched`, `spawn-failed`, `marker-write-failed`),
 * so there is no second lock acquisition and this module never writes it
 * (WL-0MWT54AR8005LMKN).
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
 * already trusts and is keyed on the same `worklogRoot` identity as the
 * round-robin cursor. The full decision and its rejected alternatives are
 * recorded on WL-0MWT3Z9M9002Z9BF and in `downtime-run-ledger.ts`.
 *
 * ## Fail-open
 *
 * The ledger is read first; when it is missing/unreadable/corrupt the read
 * falls back to the tail of the leader's own ROTATED decision log
 * (`readCoordinationLogAllEntries`), and when that is empty too it degrades to
 * "no previous dispatch", i.e. a run length of `1`. The fallback covers only
 * the upgrade / ledger-loss boundary — the next consumed charge recreates the
 * ledger — so the hand-off defect cannot return. Nothing here can block, fail
 * or delay a dispatch: every reader returns a total value and never throws.
 */

import type { CoordinationEntry } from './coordination.js';
import {
  readCoordinationLogAllEntries,
  type CoordinationLogEntry,
} from './downtime-log-coordination.js';
import { readCurrentDispatchRun } from './downtime-run-ledger.js';
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
 * The most recent consumed dispatch recorded in a decision-log history: its
 * dispatching root and the run length it recorded (or, for an older entry that
 * predates the field, the number of consecutive same-root entries visible in
 * the tail).
 *
 * Entries that are not dispatch decisions (`no-dispatch` refusals, check-ins,
 * prune records) are skipped — a no-dispatch tick neither extends nor breaks a
 * run of dispatches. Returns `null` when the history holds no dispatch.
 *
 * This is the FALLBACK source only (ledger absent/unreadable). Pure and total:
 * never throws, tolerant of malformed entries.
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
 * Used only by the fail-open fallback (ledger absent/unreadable). Pure and
 * total: a corrupt/absent history (or any parse failure by the caller) yields
 * the fail-open default `1`.
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
 * Read the previous dispatch run, ledger first.
 *
 * The machine-scoped ledger is the ONE run-length accounting source; a
 * leadership hand-off between roots cannot reset a live run to `1` because
 * every leader on the host reads the same record. It is keyed on the same
 * `worklogRoot` identity as the round-robin cursor.
 *
 * **Fail-open fallback chain (WL-0MWT54AR8005LMKN AC4):** when the ledger is
 * missing/unreadable/corrupt (an upgrade or ledger-loss boundary), fall back to
 * the tail of `countingCwd`'s ROTATED decision log; when that holds no dispatch
 * either, resolve `null` — "no previous dispatch" — and ordering degrades to
 * today's behaviour. Never throws, never blocks, fails or delays a dispatch.
 */
export async function readPreviousDispatchRun(
  coordinationDir: string,
  countingCwd?: string,
): Promise<{ root: string; length: number } | null> {
  try {
    const fromLedger = readCurrentDispatchRun(coordinationDir);
    if (fromLedger !== null) return fromLedger;
  } catch {
    // fall through to the decision-log fallback
  }
  if (countingCwd === undefined || countingCwd.length === 0) return null;
  try {
    return previousDispatchRun(await readCoordinationLogAllEntries(countingCwd));
  } catch {
    return null; // fail-open: no history, no deferral
  }
}

/**
 * The run length a dispatched `root` should record, derived from the SAME
 * machine ledger the ordering bound reads.
 *
 * The charge (`advanceRoot`) has already advanced the ledger by the time the
 * orchestrator records the decision, so a present record names the dispatching
 * root and its value includes this dispatch. A present record naming a
 * DIFFERENT root means this dispatch starts a fresh run of `1` — also derived
 * from the ledger.
 *
 * Fail-open: when the ledger is absent/unreadable/corrupt, fall back to the
 * decision-log tail (then `1`), exactly like {@link readPreviousDispatchRun},
 * so the recorded metric and the bound agree on the same fail-open value.
 */
async function recordedRunLength(
  coordinationDir: string,
  countingCwd: string,
  root: string,
): Promise<number> {
  if (root.length === 0) return 1;
  try {
    const current = readCurrentDispatchRun(coordinationDir);
    if (current !== null) return current.root === root ? current.length : 1;
  } catch {
    // fall through to the decision-log fallback
  }
  try {
    return nextConsecutiveRunLength(await readCoordinationLogAllEntries(countingCwd), root);
  } catch {
    return 1; // fail-open: unknown history records the default run length
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
 * capacity exists, using the machine run ledger (this module's SINGLE
 * run-length source, with the decision-log tail as its fail-open fallback).
 * Stable: entries of one root keep file order, and entries with no
 * candidate root stay last.
 *
 * Pure read of the cursor and the ledger; the ledger/fallback reads are
 * fail-open. Never mutates `entries` and never throws.
 */
export async function orderCoordinationEntriesForDispatch(
  entries: readonly CoordinationEntry[],
  opts: { coordinationDir: string; countingCwd: string; surplusCapacity: boolean },
): Promise<CoordinationEntry[]> {
  const roots = orderRootsLeastRecentlyServed(opts.coordinationDir, eligibleOfferRoots(entries));
  const previousRun =
    roots.length > 1
      ? await readPreviousDispatchRun(opts.coordinationDir, opts.countingCwd)
      : null;
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
 *    its run length, READ from the machine-scoped run ledger the round-robin
 *    charge already advanced (never written here), so the log and the ledger
 *    name the same value.
 *
 * The charge (`advanceRoot`) is the SINGLE ledger write site — it runs on every
 * consumed outcome (`dispatched`, `spawn-failed`, `marker-write-failed`) inside
 * the existing coordination-lock critical section, so there is no second lock
 * acquisition and no write from this composer (WL-0MWT54AR8005LMKN).
 *
 * `tickSelectedRoot` may be `null` when the offer list selected nothing (for
 * example an own-backlog dispatch); a successful dispatch then names its own
 * dispatching root as the selection rather than recording a misleading null.
 */
export async function dispatchDecisionFairness(input: {
  coordinationDir: string;
  countingCwd: string;
  tickSelectedRoot: string | null;
  selectedRootOverride?: string | null;
  dispatchingRoot?: string;
  dispatched: boolean;
}): Promise<FairnessDecisionEvidence> {
  const {
    coordinationDir,
    countingCwd,
    tickSelectedRoot,
    selectedRootOverride,
    dispatchingRoot,
    dispatched,
  } = input;
  if (!dispatched || dispatchingRoot === undefined) {
    return { selectedRoot: selectedRootOverride ?? tickSelectedRoot };
  }
  return {
    selectedRoot: selectedRootOverride ?? tickSelectedRoot ?? dispatchingRoot,
    dispatchingRoot,
    consecutiveRunLength: await recordedRunLength(coordinationDir, countingCwd, dispatchingRoot),
  };
}
