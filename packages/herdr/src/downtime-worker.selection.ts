/**
 * packages/herdr/src/downtime-worker.selection.ts — per-tier candidate
 * selection for the downtime worker.
 *
 * Single responsibility: given already-parsed candidates, decide which one a
 * tier dispatches — the eligibility guards (`isSoftDeleted`,
 * `isAssigneeHeld`), the rotation-aware tie-break (`selectWithRotation` and
 * its `RoundRobinRegistry` cursor), the audit / implement / plan-intake /
 * critical-first selectors, the dependency-frontier walk, and the
 * cross-root round-robin ordering helpers.
 *
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * child WL-0MVLIHYOU000YQ0R). No behaviour change: tier ordering, priority
 * handling, risk/effort ordinals, rotation semantics and the dispatcher's
 * ranking contract (Herdr list head is the only ranking path,
 * WL-0MTK1ILM2009QYB2 AC1–2) are unchanged.
 *
 * Layering: this module imports neither the barrel (`downtime-worker.js`) nor
 * `./stalled-work.js` (which imports values back from the barrel). Parsing
 * lives in `downtime-worker.parsers.ts`, which this module imports for
 * `criticalSkillKind`/`CriticalCandidate` — a one-way edge, so no runtime
 * cycle can form.
 */

import { isAuditFresh } from '@worklog/shared/icons';
import type { CoordinationEntry } from './coordination.js';
import { DOWNTIME_AUDIT_RECENCY_WINDOW_MS } from './downtime-worker.constants.js';
import { criticalSkillKind, type CriticalCandidate } from './downtime-worker.parsers.js';
import type {
  AuditCandidate,
  DowntimeCandidate,
  DowntimeItemInfo,
  DowntimeSkillKind,
  ImplementCandidate,
} from './downtime-worker.types.js';
import type { RoundRobinRegistry } from './downtime-round-robin.js';
import {
  advanceRoot,
  loadRoundRobinCursor,
} from './downtime-round-robin-by-root.js';

// ── Candidate eligibility guards (SA-0MUJBLZC60085DI9 / WL-0MV85WCJJ0087VMP)
// Provisional home: these two predicates are consumed by the selectors
// below, so they move with them here (a leaf module cannot import the
// barrel). The dispatch-gates child (WL-0MVLIHZZI004D7EK) takes them on
// to downtime-worker.gates.ts when it lands; the barrel re-exports them
// throughout, so the public surface is unchanged.

/**
 * Whether a candidate/work item carries a soft-delete marker.
 *
 * `wl delete` sets `deletedBy` (and `deleteReason`) and may leave the
 * status untouched, so a status-based filter alone can re-select a deleted
 * item and dispatch it a second time (SA-0MUJBLZC60085DI9). A non-empty
 * (non-whitespace) `deletedBy` is the authoritative deletion marker and
 * excludes the item from every dispatch path. Blank/absent values mean the
 * item is live.
 */
export function isSoftDeleted(
  item: { deletedBy?: string | null } | null | undefined,
): boolean {
  if (item === null || item === undefined) return false;
  const deletedBy = item.deletedBy;
  return typeof deletedBy === 'string' && deletedBy.trim() !== '';
}

/**
 * Whether a candidate/work item is held by a non-empty assignee.
 *
 * An assignee (human or agent) means the item is already being worked, so it
 * must never be auto-dispatched at any tier (WL-0MV85WCJJ0087VMP). The
 * audit-tier claim additionally CASes on the empty assignee
 * (`--if-assignee ""`), so a held item would fail stale there anyway; this
 * helper excludes it up front at every selection path. Blank/absent values
 * mean the item is free to claim.
 */
export function isAssigneeHeld(
  item: { assignee?: string | null } | null | undefined,
): boolean {
  if (item === null || item === undefined) return false;
  const assignee = item.assignee;
  return typeof assignee === 'string' && assignee.trim() !== '';
}

// ── Rotation-aware selection (WL-0MSSRED76008LGB6) ────────────────────

/**
 * A candidate carrying the fields needed for rotation-aware selection:
 * a stable id, an optional priority level (the round-robin grouping key),
 * and an optional sortIndex (wl next priority order preserved).
 */
export interface RotatableCandidate {
  id: string;
  priority?: string;
  sortIndex?: number;
}

/**
 * Apply round-robin rotation within the highest-priority group of a
 * candidate list. Fail-open design (WL-0MSSRED76008LGB6):
 *
 * - No registry (or an empty/closed registry) → fall back to the plain
 *   sortIndex order (first candidate wins) — the pre-rotation behaviour.
 * - Candidates with no `priority` field → fall back to sortIndex order
 *   (rotation needs the priority grouping key).
 * - The highest-priority group with multiple members rotates through a
 *   shared durable cursor (`advanceCursor` persists the advance).
 * - A single-member group needs no rotation → sortIndex order stands.
 *
 * Candidates are sorted ascending by sortIndex (wl next priority order)
 * before grouping, so the first group always holds the top priority.
 *
 * @param candidates Candidates already filtered/validated by the caller.
 * @param registry Optional shared round-robin registry. When absent,
 *   rotation is skipped entirely (fail-open).
 * @returns The selected candidate, or null when the list is empty.
 */
export function selectWithRotation<T extends RotatableCandidate>(
  candidates: T[],
  registry?: RoundRobinRegistry,
): T | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  if (sorted.length === 1) return sorted[0] ?? null;
  if (!registry) return sorted[0] ?? null;

  // Group by priority level; only rotate within the highest-priority group
  // (candidates are sorted ascending by sortIndex, so the first group holds
  // the top priority). Missing priority on the leader → no rotation
  // possible (fail-open).
  const topPriority = sorted[0]?.priority;
  if (!topPriority) return sorted[0] ?? null;

  const topGroup = sorted.filter((c) => c.priority === topPriority);
  if (topGroup.length <= 1) return sorted[0] ?? null;

  // Rotate: the cursor selects the next member of the tied group and
  // persists the advance (write-then-spawn ordering handled by callers).
  const index = registry.advanceCursor(topPriority, topGroup.length);
  return topGroup[index] ?? topGroup[0] ?? null;
}

// ── Audit-tier selection (WL-0MSI8H3HP000K0RG) ────────────────────────

/**
 * Select the next audit candidate from parsed in_review items: the first
 * item WITHOUT a valid audit, sorted ascending by `sortIndex` (heartbeat
 * convention). "Valid audit" reuses `isAuditFresh` from @worklog/shared/icons
 * (fresh = a
 * review icon that is neither ⏳ nor 🔍). Returns null when no candidate is
 * unaudited/stale (or the list is empty). Missing auditedAt/updatedAt means
 * not fresh → selected.
 *
 * Dispatched-marker exclusion (WL-0MSLIY8ZR004QUSY): candidates whose id is
 * present in `dispatchedItemIds` (itemIds the downtime worker has already
 * dispatched for `/skill:audit`) are excluded UNLESS they carry a fresh
 * audit — the exclusion composes with `isAuditFresh` above, so an item
 * whose most recent audit is fresh is governed by the existing freshness
 * logic (fresh → not a candidate, unchanged) and an item with a
 * stale/absent audit since its dispatch is never re-selected. This closes
 * the re-selection loop where a dispatched audit run reverts the item to
 * completed/in_review without recording a fresh audit.
 *
 * 7-day recency filter: a candidate must have been modified within
 * `DOWNTIME_AUDIT_RECENCY_WINDOW_MS` (7 days) to be dispatched. A MISSING
 * `updatedAt` is still included (recency cannot be verified → include, per
 * operator decision — absent data must not silently drop candidates); an
 * unparseable `updatedAt` is excluded (fail-closed: recency cannot be
 * verified). `now` is injectable for deterministic tests.
 */
export function selectAuditCandidate(
  candidates: AuditCandidate[],
  now: number = Date.now(),
  dispatchedItemIds?: ReadonlySet<string>,
  registry?: RoundRobinRegistry,
): AuditCandidate | null {
  const recencyCutoff = now - DOWNTIME_AUDIT_RECENCY_WINDOW_MS;
  const filtered = candidates
    .filter((c) => !isSoftDeleted(c))
    .filter((c) => !isAuditFresh(c.auditedAt, c.updatedAt, c.fingerprint, c.currentFingerprint))
    // Belt-and-suspenders child exclusion (WL-0MUBVH8QG0020H9L AC2): the
    // audit-tier query is root-only, so children are already excluded
    // server-side; this guard ensures a child can NEVER be dispatched as an
    // audit candidate even if a non-root-only/faulty response leaks one.
    .filter((c) => !c.parentId)
    .filter((c) => !(dispatchedItemIds?.has(c.id) ?? false))
    // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
    .filter((c) => c.needsProducerReview !== true)
    // Assignee hold (WL-0MV85WCJJ0087VMP): a non-empty assignee means the
    // item is already held (e.g. by the producer), so it is not an audit
    // candidate — the claim's `--if-assignee ""` CAS would fail stale.
    .filter((c) => !isAssigneeHeld(c))
    .filter((c) => {
      if (!c.updatedAt) return true; // missing → include
      const updated = new Date(c.updatedAt).getTime();
      if (Number.isNaN(updated)) return false; // unparseable → fail-closed exclude
      return updated >= recencyCutoff;
    })
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return selectWithRotation(filtered, registry);
}

/**
 * Turn a parsed audit candidate into a dispatachable `DowntimeCandidate`
 * (stage `audit`) for the audit tier.
 */
export function toDowntimeCandidate(candidate: AuditCandidate): DowntimeCandidate {
  return {
    id: candidate.id,
    title: candidate.title,
    stage: 'audit',
    needsProducerReview: candidate.needsProducerReview,
  };
}

// ── Implement-tier selection (WL-0MSMAYPQP001FLR6) ───────────────────

/**
 * Ordinal rank of a risk level on the canonical scale
 * (Low < Medium < High < Severe/Critical), mirroring the wl next DB filter
 * semantics (packages/shared riskOrdinal) for the belt-and-suspenders
 * client-side guard. Unset/unknown values map to null (fail-closed).
 */
export function riskOrdinal(risk: string | undefined | null): number | null {
  // Extract the leading keyword before any delimiter (—, -, :, whitespace).
  // Agents may produce verbose risk fields like "Medium — NVIDIA driver changes…";
  // the belt-and-suspenders guard must recognise the level regardless.
  const normalized = (risk ?? '').trim().toLowerCase().split(/[-:–—\s]+/)[0];
  switch (normalized) {
    case 'low': return 1;
    case 'medium': return 2;
    case 'high': return 3;
    case 'severe':
    case 'critical': return 4;
    default: return null;
  }
}

/**
 * Ordinal rank of an effort level on the canonical scale
 * (Extra Small < Small < Medium < Large < Extra Large), mirroring the wl
 * next DB filter semantics (packages/shared effortOrdinal). Accepts both
 * the short CLI spellings (XS/S/M/L/XL) and long-form spellings,
 * normalized case-insensitively. Unset/unknown values map to null
 * (fail-closed).
 */
export function effortOrdinal(effort: string | undefined | null): number | null {
  const normalized = (effort ?? '').trim().toLowerCase();
  // Try exact match on stripped version first (simple cases: "small", "medium",
  // "Extra Small" → "extrasmall"). If that fails, fall back to searching for
  // the keyword anywhere in the string — agents produce verbose fields like
  // "1–4 hours — Small. Diagnostic investigation…" (keyword after the dash).
  const stripped = normalized.replace(/[\s-]+/g, '');
  switch (stripped) {
    case 'xs':
    case 'extrasmall': return 1;
    case 's':
    case 'small': return 2;
    case 'm':
    case 'medium': return 3;
    case 'l':
    case 'large': return 4;
    case 'xl':
    case 'extralarge': return 5;
    default:
      // Fallback: search for the keyword bounded by non-word characters.
      // Checked in order of specificity (longest first) so "small" wins over "s".
      if (/(?:^|\W)extrasmall(?:\W|$)/.test(normalized)) return 1;
      if (/(?:^|\W)xs(?:\W|$)/.test(normalized)) return 1;
      if (/(?:^|\W)small(?:\W|$)/.test(normalized)) return 2;
      if (/(?:^|\W)s(?:\W|$)/.test(normalized)) return 2;
      if (/(?:^|\W)extralarge(?:\W|$)/.test(normalized)) return 5;
      if (/(?:^|\W)large(?:\W|$)/.test(normalized)) return 4;
      if (/(?:^|\W)xl(?:\W|$)/.test(normalized)) return 5;
      if (/(?:^|\W)l(?:\W|$)/.test(normalized)) return 4;
      if (/(?:^|\W)m(?:\W|$)/.test(normalized)) return 3;
      if (/(?:^|\W)medium(?:\W|$)/.test(normalized)) return 3;
      return null;
  }
}

/**
 * Select the next implement candidate from parsed wl next output: the
 * first candidate that is open (`status === 'open'`, AC2), carries risk
 * risk ≤ Medium and effort ≤ Medium (AC1 threshold boundaries,
 * fail-closed on unset/unknown), is not in the dispatched-marker set
 * (kind `implement`, AC6), sorted ascending by `sortIndex` (wl next
 * priority order preserved). Returns null when no candidate qualifies
 * (or the list is empty).
 *
 * Belt-and-suspenders client-side guard (AC1): even though `wl next
 * --risk medium --effort medium` filters server-side, the herdr tier verifies
 * the thresholds again so a malformed/absent server filter can never
 * dispatch a Medium+/Large+ item.
 */
export function selectImplementCandidate(
  candidates: ImplementCandidate[],
  dispatchedItemIds?: ReadonlySet<string>,
  registry?: RoundRobinRegistry,
): ImplementCandidate | null {
  const filtered = candidates
    .filter((c) => !isSoftDeleted(c))
    // Assignee hold (WL-0MV85WCJJ0087VMP): a held item is never dispatched.
    .filter((c) => !isAssigneeHeld(c))
    .filter((c) => c.status === 'open')
    .filter((c) => {
      const risk = riskOrdinal(c.risk);
      if (risk === null || risk > 2) return false; // risk ≤ Medium (1=Low, 2=Medium)
      const effort = effortOrdinal(c.effort);
      if (effort === null || effort > 3) return false; // effort ≤ Medium (1=XS, 2=S, 3=M)
      return true;
    })
    // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
    .filter((c) => c.needsProducerReview !== true)
    .filter((c) => !(dispatchedItemIds?.has(c.id) ?? false))
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return selectWithRotation(filtered, registry);
}

/**
 * Turn a parsed implement candidate into a dispatachable `DowntimeCandidate`
 * (stage `implement`) for the implement tier.
 */
export function toImplementCandidate(candidate: ImplementCandidate): DowntimeCandidate {
  return {
    id: candidate.id,
    title: candidate.title,
    stage: 'implement',
    needsProducerReview: candidate.needsProducerReview,
  };
}

// ── Plan/intake selection (RCA WL-0MSRBFFLN005W3VT RC-2 + amplifier) ──

/**
 * Select the next plan/intake candidate from parsed `wl next` batch output:
 * the first candidate that is `status === 'open'` (client-side guard — `wl
 * next --stage X` keeps completed items under a stage filter, so without it
 * a completed/in_review item whose stage matches could be dispatched),
 * excluding candidates in the dispatched-marker change-guard map (id →
 * stage at dispatch): a candidate is excluded while it is still at its
 * dispatched-at stage; a stage advancement (or any stage differing from the
 * recorded one) releases it. Sorted ascending by `sortIndex` (wl next
 * priority order preserved). Returns null when no candidate qualifies.
 *
 * Missing `status` never qualifies (fail-closed: an item whose state cannot
 * be verified is not dispatched) — `parseNextCandidatesOutput` always
 * carries the status from the enriched workItem.
 */
export function selectNextCandidate(
  candidates: DowntimeCandidate[],
  dispatchedStages?: ReadonlyMap<string, string>,
  registry?: RoundRobinRegistry,
): DowntimeCandidate | null {
  const filtered = candidates
    .filter((c) => !isSoftDeleted(c))
    // Assignee hold (WL-0MV85WCJJ0087VMP): a held item is never dispatched.
    .filter((c) => !isAssigneeHeld(c))
    .filter((c) => c.status === 'open')
    // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
    .filter((c) => c.needsProducerReview !== true)
    .filter((c) => {
      const dispatchedAt = dispatchedStages?.get(c.id);
      // Exclude while still at the dispatched-at stage; a missing recorded
      // stage (legacy entry) never suppresses selection.
      return dispatchedAt === undefined || dispatchedAt !== c.stage;
    })
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return selectWithRotation(filtered, registry);
}

// ── Critical-first selection (WL-0MT3FM8VA005XBHE, F2) ───────────────
// The critical-first pre-tier dispatches an open critical item at ANY
// stage (idea / intake_complete / plan_complete) with its stage-
// appropriate skill — ahead of EVERY non-critical candidate. Stage→skill
// mapping: idea → /skill:intake, intake_complete → /skill:plan,
// plan_complete → /skill:implement. Implement dispatch keeps the
// implement tier's risk/effort caps (decision Q2); every existing guard
// (CAS claim, dispatched-marker change-guard, single-flight) composes
// unchanged.

/**
 * Select the next critical-tier candidate from parsed wl list output:
 * the first open candidate at a dispatchable stage (idea /
 * intake_complete / plan_complete), with `plan_complete` gated by the
 * implement caps (risk ≤ Medium / effort ≤ Medium, decision Q2 — an
 * above-caps critical is never implement-dispatched by the downtime
 * worker), excluding candidates in the dispatched-marker change-guard
 * map (id → stage at dispatch — excluded while still at the dispatched-
 * at stage; a stage advancement releases it). Sorted ascending by
 * `sortIndex` (wl priority order) with round-robin tie-break within the
 * critical group (reused `selectWithRotation`; the rotation cursor keys
 * on the `critical` priority, so critical rotation never disturbs
 * non-critical tier cursors). Returns null when no candidate qualifies
 * (or the list is empty).
 */
export function selectCriticalCandidate(
  candidates: CriticalCandidate[],
  dispatchedStages?: ReadonlyMap<string, string>,
  registry?: RoundRobinRegistry,
): CriticalCandidate | null {
  const filtered = candidates
    .filter((c) => !isSoftDeleted(c))
    // Assignee hold (WL-0MV85WCJJ0087VMP): a held item is never dispatched.
    .filter((c) => !isAssigneeHeld(c))
    .filter((c) => c.status === 'open')
    // Dispatchable stages only (idea / intake_complete / plan_complete).
    .filter((c) => criticalSkillKind(c.stage) !== null)
    // Caps retained (Q2): a plan_complete candidate must be risk ≤ Medium
    // / effort ≤ Medium to be implement-dispatched — same ordinal filter
    // semantics as selectImplementCandidate (fail-closed on unset).
    .filter((c) => {
      if (c.stage !== 'plan_complete') return true;
      const risk = riskOrdinal(c.risk);
      if (risk === null || risk > 2) return false; // risk ≤ Medium
      const effort = effortOrdinal(c.effort);
      if (effort === null || effort > 3) return false; // effort ≤ Medium
      return true;
    })
    // Exclude items needing producer review (parent WL-0MTIAL65N004T22F AC1).
    .filter((c) => c.needsProducerReview !== true)
    .filter((c) => {
      const dispatchedAt = dispatchedStages?.get(c.id);
      // Change-guard: exclude while still at the dispatched-at stage; a
      // missing recorded stage (legacy entry) never suppresses selection.
      return dispatchedAt === undefined || dispatchedAt !== c.stage;
    })
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return selectWithRotation(filtered, registry);
}

// ── Dependency frontier resolution (WL-0MT3FM8VA005XBHE, F3) ────────
// Decision Q3: when the selected critical candidate is dependency-blocked,
// the downtime worker follows the blocking chain to the nearest OPEN
// blocker and dispatches IT with the blocker's own stage-appropriate
// skill (the dependency frontier). Recursion walks while blockers are
// themselves dependency-blocked; a chain that bottoms in closed or
// non-dispatchable items yields null and the critical tier falls through
// to the normal tier order.

/**
 * Resolve the dependency frontier for a selected critical candidate
 * (decision Q3). When the candidate is dependency-blocked, follow the
 * blocking chain and return the nearest OPEN, dispatchable blocker — the
 * item to dispatch with its own stage-appropriate skill (a blocker at
 * idea → /skill:intake, intake_complete → /skill:plan, plan_complete →
 * /skill:implement with the implement caps applied to the blocker too,
 * Q2). Semantics:
 *
 * - Not dependency-blocked (no blockers under the candidate) → the
 *   candidate itself (dispatch it normally — no frontier redirect).
 * - A direct blocker that is open + dispatchable + within caps and not
 *   itself dependency-blocked → that blocker (nearest open blocker, in
 *   sortIndex order among direct blockers).
 * - A direct blocker that is open but itself dependency-blocked → recurse
 *   into its chain (the blocking chain is followed to the nearest open
 *   unblocked ancestor).
 * - A direct blocker at a non-dispatchable stage (in_progress,
 *   in_review) or above the implement caps → not itself a frontier target;
 *   if it has open blockers beneath, the recursion surfaces the deeper
 *   open ancestor, otherwise the chain bottoms.
 * - Chain bottoms in closed / non-dispatchable items, or a cycle (bounded
 *   recursion) → null: no dispatch from the critical tier, fall through to
 *   the normal tier order.
 * - The injected `fetchBlockers` resolves the blocker edges for an item
 *   (`wl dep list` outbound depends-on edges) and returns null on a wl
 *   failure — fail-closed: resolution yields null (no dispatch) rather
 *   than a silent wrong target.
 *
 * @param candidate The selected open critical candidate.
 * @param fetchBlockers Resolves the blockers of an item id (null = wl
 *   failure).
 * @param opts.maxDepth Upper bound on recursion depth (cycle guard).
 * @returns The frontier dispatch target, or null when the chain bottoms /
 *   cycles / the blocker lookup fails (fall through to normal tiers).
 */
export async function resolveDependencyFrontier(
  candidate: CriticalCandidate,
  fetchBlockers: (itemId: string) => Promise<CriticalCandidate[] | null>,
  opts: { maxDepth?: number } = {},
): Promise<CriticalCandidate | null> {
  const maxDepth = opts.maxDepth ?? 8;
  const visited = new Set<string>();

  /** Caps guard shared with selectCriticalCandidate (Q2 applies to blockers). */
  const dispatchable = (c: CriticalCandidate): boolean =>
    c.status === 'open' &&
    criticalSkillKind(c.stage) !== null &&
    // Exclude review-gated blockers (parent WL-0MTIAL65N004T22F AC2).
    c.needsProducerReview !== true &&
    (c.stage !== 'plan_complete' ||
      ((riskOrdinal(c.risk) ?? 9) <= 2 && (effortOrdinal(c.effort) ?? 9) <= 3));

  // Recursive walk: returns the nearest OPEN dispatchable blocker in the
  // chain beneath `item` (or the item itself when it is unblocked and
  // dispatchable). OPEN dispatchable blockers are tried first (nearest by
  // sortIndex); when an open blocker is itself dependency-blocked, its own
  // chain is walked before accepting it (an open blocker with open
  // descendants must not shadow a deeper unblocked ancestor). Non-
  // dispatchable blockers (in_progress / in_review / closed / capped) are
  // never dispatched themselves but their open descendants are still
  // surfaced by recursing through them. Cycles bottom the walk via
  // `visited` (bounded recursion, decision Q3).
  async function walk(item: CriticalCandidate, depth: number): Promise<CriticalCandidate | null> {
    if (visited.has(item.id) || depth > maxDepth) return null; // cycle / bound
    visited.add(item.id);
    const blockers = await fetchBlockers(item.id);
    if (blockers === null) return null; // wl failure → fail-closed
    if (blockers.length === 0) {
      // Not dependency-blocked: this item IS the frontier target, but only
      // when it is itself a dispatchable open item (a closed / in_progress
      // / in_review / capped leaf is never dispatched).
      return dispatchable(item) ? item : null;
    }
    const sorted = [...blockers].sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
    // 1) Nearest OPEN dispatchable blocker (recursing into its own chain
    //    when it is dependency-blocked).
    for (const blocker of sorted) {
      if (!dispatchable(blocker)) continue;
      const deeper = await walk(blocker, depth + 1);
      if (deeper !== null) return deeper;
    }
    // 2) No open blocker yielded a frontier — recurse through the non-
    //    dispatchable blockers (they may have open ancestors beneath).
    for (const blocker of sorted) {
      if (dispatchable(blocker)) continue;
      const deeper = await walk(blocker, depth + 1);
      if (deeper !== null) return deeper;
    }
    // Chain bottoms in closed / non-dispatchable / capped items → fall
    // through to the normal tier order.
    return null;
  }

  const blockers = await fetchBlockers(candidate.id);
  if (blockers === null) return null; // wl failure → fail-closed
  if (blockers.length === 0) return candidate; // not dependency-blocked
  return walk(candidate, 0);
}

// ── Round-robin helpers (WL-0MTJE0FXC006WAOX) ──────────────────────────

/** Internal tier-group entry: a CoordinationEntry paired with its dispatch info. */
type TierEntry = { entry: CoordinationEntry; info: DowntimeItemInfo; skill: DowntimeSkillKind };

/**
 * Sort a tier group by round-robin cursor order (WL-0MTJE0FXC006WAOX).
 *
 * Uses `loadRoundRobinCursor` (fail-open → `{}` → file order) to order
 * entries: unknown/new roots first (never penalised), known roots oldest
 * last-served first; stable sort preserves file order for timestamp ties.
 *
 * This is a pure sort — it does NOT advance the cursor. Advancement
 * happens only when the dispatched entry is consumed (every `removeEntry`
 * path).
 */
export function sortEntriesByRoundRobin(
  group: TierEntry[],
  coordinationDir: string,
): TierEntry[] {
  if (group.length <= 1) return group;

  // Load cursor state (fail-open → {}). No lock needed for read-only sort.
  const cursor = loadRoundRobinCursor(coordinationDir);

  // Stable sort: unknown roots first, then oldest known first.
  return [...group].sort((a, b) => {
    const rootA = a.entry.worklogRoot ?? a.entry.directory;
    const rootB = b.entry.worklogRoot ?? b.entry.directory;

    const aKnown = rootA in cursor;
    const bKnown = rootB in cursor;

    // Unknown roots sort before known roots.
    if (!aKnown && bKnown) return -1;
    if (aKnown && !bKnown) return 1;

    // Both known: oldest timestamp first (stable sort preserves file order for ties).
    if (aKnown && bKnown) {
      const tsA = new Date(cursor[rootA]).getTime();
      const tsB = new Date(cursor[rootB]).getTime();
      const diff = tsA - tsB;
      if (diff !== 0) return diff;
    }

    // Both unknown or timestamp tie: stable sort (preserve original file order).
    return 0;
  });
}

/**
 * Advance the round-robin cursor for a given root (WL-0MTJE0FXC006WAOX).
 *
 * Calls `advanceRoot` from the cursor module under the coordination lock.
 * Fail-open: lock contention or I/O error silently tolerates the missed
 * advance (the project will be selected sooner on the next cycle).
 *
 * This is called AFTER `removeEntry` on every consumed-entry path:
 * - critical tier dispatched
 * - critical tier spawn-failed / marker-write-failed
 * - non-critical tier dispatched
 * - non-critical tier spawn-failed / marker-write-failed
 */
export function advanceRoundRobinCursor(
  coordinationDir: string,
  root: string,
  now: number,
): void {
  if (root.length === 0) return;
  advanceRoot(coordinationDir, root, now);
}
