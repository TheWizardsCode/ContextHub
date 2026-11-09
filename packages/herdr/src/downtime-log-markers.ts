/**
 * packages/herdr/src/downtime-log-markers.ts — dispatched-marker readers and
 * per-item suppression decisions (WL-0MVGKHFT4003X6JW, split out of
 * `downtime-log.ts`).
 *
 * Single responsibility: everything that answers "does a dispatch-marker
 * entry still exclude this item?" — the tier-scoped id sets, the
 * staleness-aware marker map and its stage-guard decision, the per-item
 * attempt budget, and the non-terminal pane-close cooldown. Pure functions
 * over already-read entries: the entries module owns reading and writing, the
 * worker owns the policy inputs.
 *
 * This module doubles as the audit tier's dispatched-marker source
 * (WL-0MSLIY8ZR004QUSY): `auditDispatchedItemIds` lets audit-tier selection
 * exclude items the downtime worker has already dispatched for
 * `/skill:audit`, closing the re-selection loop where a dispatched run
 * reverts the item to completed/in_review without a fresh audit.
 *
 * Extracted verbatim from `downtime-log.ts`; behaviour is unchanged.
 */

import { type DowntimeLogEntry, isDispatchMarkerEntry } from './downtime-log-entries.js';

/**
 * Build the set of itemIds the downtime worker has already dispatched for
 * the given kind (kind-scoped). Entries without an itemId (e.g.
 * persistent-error events) are ignored. Entries with `outcome: 'spawn-failed'
 * are excluded (WL-0MT32F908002YFFA AC2): a spawn-failed dispatch is NOT
 * a success — the item should be re-eligible for selection on the next idle
 * period. Shared by the audit/implement/plan/intake marker readers so every
 * tier's scope guard stays identical.
 */
function dispatchedItemIds(entries: DowntimeLogEntry[], kind: string): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (!isDispatchMarkerEntry(e)) continue; // pane-close/lifecycle entries are not markers
    // Spawn-failed entries are non-excluding (WL-0MT32F908002YFFA AC2).
    if (e.outcome === 'spawn-failed') continue;
    if (e.kind === kind && typeof e.itemId === 'string' && e.itemId.length > 0) {
      ids.add(e.itemId);
    }
  }
  return ids;
}

/**
 * Build the set of itemIds the downtime worker has already dispatched for
 * `/skill:audit` (`kind === 'audit'` entries only). Plan/intake markers are
 * scoped to their own tiers and must NOT suppress audit-tier selection
 * (audit-tier-only scope guard, WL-0MSLIY8ZR004QUSY). Entries without an
 * itemId (e.g. persistent-error events) are ignored.
 */
export function auditDispatchedItemIds(entries: DowntimeLogEntry[]): Set<string> {
  return dispatchedItemIds(entries, 'audit');
}

/**
 * Build the set of itemIds with a `kind` marker whose `dispatchedAt` falls
 * within `windowMs` of `now` (fresh markers only, WL-0MT3PHW4I002SNOV).
 * Powers the active-audit single-flight check: an audit dispatch marker
 * older than the stale window (`DOWNTIME_AUDIT_STALE_WINDOW_MS`, 2h) is
 * treated as stale — the audit pane may have crashed without updating the
 * work item — and ignored, so a NEW audit dispatch can proceed. Entries
 * without an itemId, without a parseable `dispatchedAt`, or of another
 * kind are ignored (fail-closed: missing evidence never claims an active
 * audit). Spawn-failed entries are ignored too (WL-0MT32F908002YFFA AC2):
 * a failed spawn is not an active run.
 */
export function recentDispatchedItemIds(
  entries: DowntimeLogEntry[],
  kind: string,
  windowMs: number,
  now: number = Date.now(),
): Set<string> {
  const cutoff = now - windowMs;
  const ids = new Set<string>();
  for (const e of entries) {
    if (!isDispatchMarkerEntry(e)) continue; // pane-close/lifecycle entries are not markers
    // Spawn-failed entries are non-excluding (WL-0MT32F908002YFFA AC2): a
    // failed spawn is NOT an active run — the pane never appeared, so a new
    // dispatch must not be blocked by it.
    if (e.outcome === 'spawn-failed') continue;
    if (e.kind !== kind || typeof e.itemId !== 'string' || e.itemId.length === 0) continue;
    if (typeof e.dispatchedAt !== 'string') continue; // unrecognized timestamp → no active evidence
    const t = Date.parse(e.dispatchedAt);
    if (Number.isNaN(t) || t < cutoff) continue; // unparseable or stale
    ids.add(e.itemId);
  }
  return ids;
}

/**
 * Build the set of itemIds with a NON-STALE audit dispatch marker
 * (`kind === 'audit'`, dispatched within `windowMs` of `now`). Plan/intake/
 * implement markers are scoped out (audit-tier-only, WL-0MT3PHW4I002SNOV).
 */
export function recentAuditDispatchedItemIds(
  entries: DowntimeLogEntry[],
  windowMs: number,
  now: number = Date.now(),
): Set<string> {
  return recentDispatchedItemIds(entries, 'audit', windowMs, now);
}

/**
 * One success marker's lifetime data (WL-0MU6UL0RJ008IHGT): the worklog
 * stage the item was at when dispatched, plus the dispatch timestamp that
 * powers the staleness window. `stage` defaults to `''` for legacy entries
 * and `dispatchedAt` is `undefined` when missing/unparseable, so
 * malformed/foreign lines never break parsing (callers fail closed).
 */
export interface DispatchMarker {
  /** Worklog stage at dispatch; `''` when absent (legacy entry). */
  stage: string;
  /** ISO-8601 dispatch timestamp; `undefined` when missing/unparseable. */
  dispatchedAt?: string;
}

/**
 * Tier semantics for a legacy marker without a recorded stage (see
 * `markerStillExcludes`).
 *
 * - `'stage-guard'` (plan/intake/risk-effort tiers): a missing
 *   dispatched-at stage NEVER suppressed selection — the historical
 *   change-guard semantics (a legacy entry must not freeze an item).
 * - `'id-guard'` (audit/implement tiers): the historical id-set readers
 *   excluded on the id alone; an unknown stage must not weaken duplicate-
 *   dispatch protection for a possibly in-flight marker, so a legacy
 *   marker keeps excluding while fresh — only the age TTL releases it.
 */
export type MarkerStageGuardMode = 'stage-guard' | 'id-guard';

/**
 * Kind-scoped, staleness-aware success-marker map: itemId → the marker's
 * lifetime data (dispatched-at stage + dispatch timestamp) for the
 * dispatched-marker change-guard (WL-0MU6UL0RJ008IHGT). This is the
 * canonical reader for the success-marker staleness window: a marker
 * excludes its item only while the item is STILL at the marker's stage AND
 * the marker is fresh (age ≤ the configured staleness window). Spawn-failed
 * entries are excluded (WL-0MT32F908002YFFA AC2: a failed spawn is NOT a
 * success — the pane never appeared).
 *
 * Missing `stage` maps to `''` (legacy pre-stage entries, backward
 * compatible — see `markerStillExcludes` for how each tier mode treats
 * them); missing `dispatchedAt` maps to `undefined` (fail-closed — the
 * decision helper keeps excluding). When an itemId appears more than once,
 * the LAST entry wins (the most recent dispatch is the authoritative
 * marker: if it is fresh the item is in-flight; if it is stale every
 * earlier, older marker is staler).
 */
export function dispatchedItemMarkers(
  entries: DowntimeLogEntry[],
  kind: string,
): Map<string, DispatchMarker> {
  const markers = new Map<string, DispatchMarker>();
  for (const e of entries) {
    if (!isDispatchMarkerEntry(e)) continue; // pane-close/lifecycle entries are not markers
    // Spawn-failed entries are non-excluding (WL-0MT32F908002YFFA AC2).
    if (e.outcome === 'spawn-failed') continue;
    if (e.kind !== kind || typeof e.itemId !== 'string' || e.itemId.length === 0) continue;
    markers.set(e.itemId, {
      stage: typeof e.stage === 'string' ? e.stage : '',
      dispatchedAt: typeof e.dispatchedAt === 'string' ? e.dispatchedAt : undefined,
    });
  }
  return markers;
}

/**
 * Decide whether a dispatched SUCCESS marker still excludes its item from
 * re-dispatch (WL-0MU6UL0RJ008IHGT AC1/AC2/AC5).
 *
 * A marker keeps excluding ONLY while BOTH hold:
 *  1. the item has NOT advanced past the marker's dispatched-at stage
 *     (`itemStage === marker.stage`), and
 *  2. the marker is still fresh — its age is ≤ `stalenessWindowMs`.
 *
 * Fail-closed (AC5): a MISSING or UNPARSEABLE `dispatchedAt` keeps
 * excluding — the staleness window cannot be proven, so the item stays
 * protected against double dispatch. At exactly `stalenessWindowMs` the
 * marker still excludes; one ms past the window it releases ("exceeds"
 * the window per AC1).
 *
 * A stage advancement releases the marker exactly as the historical
 * change-guard did (AC2 — no behaviour change for healthy flow). Legacy
 * markers without a recorded stage follow `mode` (see
 * `MarkerStageGuardMode`).
 */
export function markerStillExcludes(
  marker: DispatchMarker,
  itemStage: string | undefined,
  now: number,
  stalenessWindowMs: number,
  mode: MarkerStageGuardMode = 'id-guard',
): boolean {
  if (marker.stage === '') {
    // Legacy marker without a recorded stage. Stage-guard tiers release it
    // (historical semantics); id-guard tiers keep excluding while fresh so
    // a possibly-in-flight marker is never double-dispatched, and the age
    // TTL below still releases it once stale.
    if (mode === 'stage-guard') return false;
  } else if (marker.stage !== (itemStage ?? '')) {
    // The item advanced past its dispatched-at stage → released (AC2).
    return false;
  }
  // Flowing through here: same stage (or unknown stage under id-guard) —
  // the marker's age decides, fail-closed on unproven freshness.
  if (marker.dispatchedAt === undefined) return true;
  const t = Date.parse(marker.dispatchedAt);
  if (Number.isNaN(t)) return true; // unparseable → fail-closed: keep excluding
  return now - t <= stalenessWindowMs;
}

// ── Per-item/per-kind dispatch-attempt budget (WL-0MUKYEXMK0033MFK) ───

/**
 * Count dispatch ATTEMPTS for one `(itemId, kind)` pair at the item's
 * CURRENT stage (WL-0MUKYEXMK0033MFK AC1).
 *
 * An "attempt" is a dispatch-marker entry for the kind — the same predicate
 * the success-marker readers use (`isDispatchMarkerEntry`), so pane-close
 * lifecycle entries are not counted on their own: each non-terminal close
 * still counts exactly once, via the dispatch marker that opened its pane.
 * Two entry kinds are excluded from the count because they do not represent
 * an opened pane:
 *
 *  - `outcome: 'spawn-failed'` traces — the pane never appeared (same
 *    non-excluding convention as the marker readers, WL-0MT32F908002YFFA);
 *  - `enrichment: true` entries — the best-effort post-spawn enrichment
 *    copies the marker verbatim and would otherwise double-count a single
 *    dispatch (WL-0MUBVL251006JAQ0).
 *
 * BUDGET RESET ON STAGE ADVANCEMENT (AC4): only markers whose dispatched-at
 * `stage` equals the item's current stage count. A marker written before an
 * advancement carries the old stage and no longer counts, giving the item a
 * fresh budget at its new stage. Legacy markers without a recorded stage
 * are treated as `''` and never match a real stage, so a partial/legacy log
 * under-counts (fail-open) rather than over-counting.
 *
 * FAIL-OPEN (AC7e): a missing/unreadable/corrupt log yields no entries (see
 * `readDowntimeLogEntries`) and therefore a count of 0 — a bad log can never
 * block all dispatch. Never throws.
 */
export function countAttempts(
  entries: DowntimeLogEntry[],
  itemId: string,
  kind: string,
  itemStage: string | undefined,
): number {
  const stage = itemStage ?? '';
  let count = 0;
  for (const e of entries) {
    if (!isDispatchMarkerEntry(e)) continue;
    if (e.outcome === 'spawn-failed') continue;
    if (e.enrichment === true) continue;
    if (e.kind !== kind || e.itemId !== itemId) continue;
    const entryStage = typeof e.stage === 'string' ? e.stage : '';
    if (entryStage !== stage) continue;
    count += 1;
  }
  return count;
}

// ── Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5) ────────────

/**
 * Worklog stage rank used by the non-terminal pane-close cooldown to detect
 * stage advancement (WL-0MUKYERLZ006ELL5). Higher means further through the
 * lifecycle; an unknown stage ranks -1 so it never looks "advanced".
 */
const NON_TERMINAL_COOLDOWN_STAGE_RANK: Record<string, number> = {
  idea: 0,
  intake_complete: 1,
  plan_complete: 2,
  in_review: 3,
};

/**
 * Reason codes on a pane-close entry that represent a TERMINAL close — the
 * item genuinely reached a terminal stage or the pane finished cleanly.
 * `'none'` covers `closed-as-intake-complete` / `closed-as-plan-complete` /
 * `audit-passed` / `audit-failed`; `'reached-in-review'` is the implement-pane
 * success close (parent AC5). Any OTHER code — including future/unknown or
 * absent ones — is treated as NON-terminal (fail-closed).
 */
const TERMINAL_PANE_CLOSE_REASON_CODES: ReadonlySet<string> = new Set([
  'none',
  'reached-in-review',
]);

function cooldownStageRank(stage: string | undefined): number {
  if (typeof stage !== 'string') return -1;
  return NON_TERMINAL_COOLDOWN_STAGE_RANK[stage] ?? -1;
}

/**
 * Decide whether a MINIMUM COOLDOWN still excludes an item from re-dispatch
 * after a NON-TERMINAL pane close (WL-0MUKYERLZ006ELL5). Neutral sequential
 * filter (never a strike, never a `no-candidate`): it consults the most recent
 * `entryType: 'pane-close'` entry for the `(itemId, kind)` pair and returns
 * true (skip) while that close:
 *
 *  1. is NON-terminal — its `reasonCode` is not in
 *     {@link TERMINAL_PANE_CLOSE_REASON_CODES} (fail-closed: unknown/absent
 *     codes are non-terminal), AND
 *  2. the item has NOT advanced past the close's dispatched-at `stage`
 *     (parent AC4; a genuinely progressed item is released immediately), AND
 *  3. is younger than `cooldownMs` (`now - closeTime < cooldownMs`).
 *
 * Returns false when there is no close record, the close was terminal, the item
 * advanced, or the cooldown has elapsed. FAIL-CLOSED: a missing or unparseable
 * close timestamp returns true (safe no-dispatch), bounded by the
 * stage-advancement release. The most recent close wins — a later terminal
 * close supersedes an earlier failure, and a later failure re-arms.
 */
export function isNonTerminalCooldownActive(
  entries: DowntimeLogEntry[],
  itemId: string,
  kind: string,
  itemStage: string | undefined,
  cooldownMs: number,
  now: number = Date.now(),
): boolean {
  // Most-recent close for this (itemId, kind) wins (append order).
  let latest: DowntimeLogEntry | undefined;
  for (const e of entries) {
    if (e.entryType !== 'pane-close') continue;
    if (e.itemId !== itemId || e.kind !== kind) continue;
    latest = e;
  }
  if (latest === undefined) return false;

  // Terminal close → no cooldown (parent AC5). Fail-closed: unknown/absent
  // codes are non-terminal.
  const reasonCode = typeof latest.reasonCode === 'string' ? latest.reasonCode : '';
  if (TERMINAL_PANE_CLOSE_REASON_CODES.has(reasonCode)) return false;

  // Stage advancement releases (parent AC4). Only release when the
  // dispatched-at stage is KNOWN and the current stage is strictly higher —
  // a close without a recorded stage cannot prove progress, so it stays held
  // (fail-closed; the age check below still bounds it).
  const dispatchedRank = cooldownStageRank(latest.stage);
  const currentRank = cooldownStageRank(itemStage);
  if (dispatchedRank >= 0 && currentRank > dispatchedRank) return false;

  // Age check. Missing/unparseable timestamp → fail-closed skip.
  if (typeof latest.timestamp !== 'string') return true;
  const t = Date.parse(latest.timestamp);
  if (Number.isNaN(t)) return true;
  return now - t < cooldownMs;
}

/**
 * Build the set of itemIds the downtime worker has already dispatched for
 * `/skill:implement` (`kind === 'implement'` entries only). Audit/plan/
 * intake markers are scoped to their own tiers and must NOT suppress
 * implement-tier selection (implement-tier-only scope guard,
 * WL-0MSMAYPQP001FLR6 AC6). Entries without an itemId (e.g. persistent-error
 * events) are ignored.
 */
export function implementDispatchedItemIds(entries: DowntimeLogEntry[]): Set<string> {
  return dispatchedItemIds(entries, 'implement');
}

/**
 * Build the set of itemIds the downtime worker has already dispatched for
 * risk-effort evaluation (`kind === 'risk-effort'` entries only). Entries
 * without an itemId are ignored. A risk-effort marker prevents re-dispatching
 * the evaluation until the item advances past plan_complete (WL-0MTTSWCJR003OMN7).
 */
export function riskEffortDispatchedItemIds(entries: DowntimeLogEntry[]): Set<string> {
  return dispatchedItemIds(entries, 'risk-effort');
}

/**
 * Build the kind-scoped id → dispatched-at-stage map used by the plan/intake
 * change-guard (RCA WL-0MSRBFFLN005W3VT design point 3): entries of the
 * given kind map itemId to the worklog stage the item had when it was
 * dispatched. Selection excludes a candidate while it is still at its
 * dispatched-at stage; a stage advancement (or any stage differing from the
 * recorded one) releases it. Entries without a recorded stage map to '' — a
 * missing stage never suppresses selection (legacy pre-fix entries stay
 * valid and do not freeze an item).
 */
export function dispatchedItemStages(entries: DowntimeLogEntry[], kind: string): Map<string, string> {
  const stages = new Map<string, string>();
  for (const e of entries) {
    if (!isDispatchMarkerEntry(e)) continue; // pane-close/lifecycle entries are not markers
    // Spawn-failed entries are non-excluding (WL-0MT32F908002YFFA AC2).
    if (e.outcome === 'spawn-failed') continue;
    if (e.kind === kind && typeof e.itemId === 'string' && e.itemId.length > 0) {
      stages.set(e.itemId, typeof e.stage === 'string' ? e.stage : '');
    }
  }
  return stages;
}

/**
 * Plan-tier marker map (`kind === 'plan'` entries only): itemId → stage at
 * dispatch. A plan candidate (`intake_complete`) is excluded while a plan
 * marker records the same stage; advancing the item releases it.
 */
export function planDispatchedItemStages(entries: DowntimeLogEntry[]): Map<string, string> {
  return dispatchedItemStages(entries, 'plan');
}

/**
 * Intake-tier marker map (`kind === 'intake'` entries only): itemId → stage
 * at dispatch. An intake candidate (`idea`) is excluded while an intake
 * marker records the same stage; advancing the item releases it.
 */
export function intakeDispatchedItemStages(entries: DowntimeLogEntry[]): Map<string, string> {
  return dispatchedItemStages(entries, 'intake');
}
