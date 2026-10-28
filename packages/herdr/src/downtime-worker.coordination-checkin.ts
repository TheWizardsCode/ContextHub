/**
 * packages/herdr/src/downtime-worker.coordination-checkin.ts — one
 * coordination CHECK-IN.
 *
 * Extracted from `downtime-worker.coordination-leader.ts` by
 * WL-0MVR8FKMU009XTED so the empty-offer attribution (AC1) has room to grow
 * without pushing the leader module past the 1000-line split-guard ceiling.
 * The computation, entry upsert/removal and fail-open behaviour are unchanged.
 *
 * Work item: WL-0MVR8FKMU009XTED (parent WL-0MVR8EXR6009F05V) — every emptied
 * check-in now records a machine-readable `reason` (`empty-window`,
 * `all-window-items-held` + sentinels, `all-window-items-gated` + dominant
 * gate, `review-queue-hold`, `attempt-budget-exhausted`, `in-flight-hold`,
 * `non-terminal-cooldown`, `stalled-resume`, `wl-error`) instead of a bare
 * `workItemId: null`.
 *
 * Layering: imports the concrete siblings only (coordination file, rolling
 * log, offer computation, attribution helper) — never the barrel.
 */

import { getEntry, removeEntry, upsertEntry, type CoordinationEntry } from './coordination.js';
import { appendCoordinationLogEntry } from './downtime-log.js';
import {
  DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
  DEFAULT_DOWNTIME_MAX_ATTEMPTS,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
} from './downtime-worker.constants.js';
import {
  computeMostImportantItem,
  type CoordinationDeps,
} from './downtime-worker.coordination.js';
import type { EmptyOfferAttribution } from './downtime-worker.offer-attribution.js';

/**
 * The flat log fields for one emptied check-in (AC1). The check-in entry
 * itself already existed (one line per check-in), so this adds attribution
 * fields to an existing line instead of a new line per cycle — no log
 * flooding, and the same bounded rolling log.
 */
function emptyOfferLogFields(attribution: EmptyOfferAttribution | undefined): {
  reason: string;
  windowSize: number;
  heldAssignees?: string[];
  dominantGate?: string;
  gateCounts?: Record<string, number>;
} {
  const resolved: EmptyOfferAttribution = attribution ?? {
    reason: 'empty-window',
    windowSize: 0,
  };
  return {
    reason: resolved.reason,
    windowSize: resolved.windowSize,
    ...(resolved.heldAssignees !== undefined ? { heldAssignees: resolved.heldAssignees } : {}),
    ...(resolved.dominantGate !== undefined ? { dominantGate: resolved.dominantGate } : {}),
    ...(resolved.gateCounts !== undefined ? { gateCounts: resolved.gateCounts } : {}),
  };
}

/**
 * One coordination check-in (WL-0MTMPSCL8000O45H — default every 5 min,
 * parent AC3): recompute this instance's most-important item and upsert
 * its entry in the shared coordination file. When the instance has NOTHING
 * dispatchable (genuine empty backlog, no CLI errors) the own entry is
 * removed — the leader must not float a dead offer; the owner re-offers
 * when work appears (immediately on next tick after dispatch removes it —
 * WL-0MTMPSCL8000O45H AC2). On a CLI-error computation the existing entry
 * is kept (fail-open) — a transient wl failure must never drop a valid
 * offer. Returns the stored item id (or null when nothing was offered).
 *
 * Every emptied check-in records WHY (WL-0MVR8FKMU009XTED AC1); a retained
 * entry after a CLI failure records `wl-error` so "kept the entry" is never
 * indistinguishable from "offered nothing".
 */
export async function runCoordinationCheckIn(
  deps: CoordinationDeps,
  coordinator: {
    cwd: string;
    coordinationDir: string;
    instanceId: string;
    /** browseItemCount threshold for the review-queue depth gate (defaults to DEFAULT_BROWSE_ITEM_COUNT). */
    browseItemCount?: number;
    /** Dispatched success-marker staleness window (WL-0MU6UL0RJ008IHGT); defaults to DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS. */
    markerStaleWindowMs?: number;
    /** Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5); defaults to DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS. */
    nonTerminalCooldownMs?: number;
    /** Per-item/per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK); defaults to DEFAULT_DOWNTIME_MAX_ATTEMPTS. */
    maxAttempts?: number;
  },
  now: number = Date.now(),
): Promise<{ offered: string | null; updated: boolean }> {
  const current = getEntry(coordinator.coordinationDir, coordinator.instanceId);
  // NOTE (WL-0MUYMBSA90092QV2 AC3): the check-in is NOT idle-gated (it runs
  // before the proxy poll, for leader and non-leader alike), so the
  // stalled-work scan is deliberately DISABLED here — resuming a pane is a
  // dispatch-like side effect that must only run when the dispatcher is
  // idle-gated and would otherwise dispatch. The idle-gated paths
  // (`dispatchDowntimeWork` / `dispatchFromCoordination` / the no-candidate
  // probe below) perform the scan+resume.
  const result = await computeMostImportantItem(
    deps,
    coordinator.cwd,
    now,
    coordinator.browseItemCount,
    coordinator.markerStaleWindowMs ?? DEFAULT_DOWNTIME_MARKER_STALE_WINDOW_MS,
    coordinator.nonTerminalCooldownMs ?? DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
    coordinator.maxAttempts ?? DEFAULT_DOWNTIME_MAX_ATTEMPTS,
    false,
  );
  if (!result.ok) {
    // wl/CLI errors — keep the existing entry (fail-open), retry next check-in.
    // The emptied-offer reason is `wl-error` (AC1): the entry was RETAINED,
    // not emptied, so `workItemId` stays the kept offer.
    void appendCoordinationLogEntry(coordinator.cwd, {
      kind: 'coordination',
      operation: 'checkin',
      instanceId: coordinator.instanceId,
      workItemId: current?.workItemId ?? null,
      reason: 'wl-error',
      ...(result.error !== undefined ? { error: result.error } : {}),
      at: new Date(now).toISOString(),
    });
    return { offered: current?.workItemId ?? null, updated: false };
  }
  if (!('candidate' in result)) {
    // Genuinely nothing dispatchable (`noCandidate`), the deep-queue hold
    // left nothing offerable (`reviewQueueHold`, WL-0MTTSWC1X005P4VD), or a
    // stalled pane was resumed in place (`stalledResume`,
    // WL-0MUYMBSA90092QV2) — either way the own entry is removed (no dead
    // offers; the owner re-offers once work becomes offerable). The caller
    // distinguishes the reasons via the probe path (reviewQueueHold and
    // stalledResume must never pause).
    const removed = removeEntry(coordinator.coordinationDir, coordinator.instanceId) !== null;
    // Audit trail (WL-0MSXHAE290067VAL): log the emptied check-in, now with
    // the machine-readable empty-offer reason (WL-0MVR8FKMU009XTED AC1).
    void appendCoordinationLogEntry(coordinator.cwd, {
      kind: 'coordination',
      operation: 'checkin',
      instanceId: coordinator.instanceId,
      workItemId: null,
      ...emptyOfferLogFields(result.attribution),
      at: new Date(now).toISOString(),
    });
    return { offered: null, updated: removed };
  }
  if (!('candidate' in result) || result.candidate === undefined) {
    // Defensive: a malformed result (stub/regression) keeps the entry.
    return { offered: current?.workItemId ?? null, updated: false };
  }
  const entry: CoordinationEntry = {
    instanceId: coordinator.instanceId,
    workItemId: result.candidate.id,
    directory: coordinator.cwd,
    assignedAt: current?.assignedAt ?? new Date(now).toISOString(),
    lastUpdated: new Date(now).toISOString(),
  };
  const updated = upsertEntry(coordinator.coordinationDir, entry);
  // Audit trail (WL-0MSXHAE290067VAL): log the offered item on every
  // successful check-in write.
  if (updated) {
    void appendCoordinationLogEntry(coordinator.cwd, {
      kind: 'coordination',
      operation: 'checkin',
      instanceId: coordinator.instanceId,
      workItemId: entry.workItemId,
      at: new Date(now).toISOString(),
    });
  }
  return { offered: entry.workItemId, updated };
}
