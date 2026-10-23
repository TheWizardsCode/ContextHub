/**
 * packages/herdr/src/long-running-panes.ts — long-running pane detector
 * (WL-0MVKNC2N50025HXE).
 *
 * Every existing recovery mechanism keys on a pane being NOT busy:
 *
 *  - the stalled-work scan skips an `agent_status: working` pane
 *    (`agent-working`), deliberately never hijacking work in progress;
 *  - the non-terminal pane-close cooldown only applies to closes;
 *  - the pane-close reaper only touches settled/abandoned panes.
 *
 * A pane that stays `working` for 12+ hours while its work item never
 * progresses is therefore invisible to all of them, yet it can monopolise
 * every local-LLM slot and starve the whole fleet's downtime dispatch (the
 * 2026-10-22/23 incident: four panes, 9.5–17.5 h each, one dispatch in nine
 * hours).
 *
 * This module supplies the pure DETECTION half: {@link classifyLongRunningPane}
 * flags a live-agent pane whose item has not progressed (no `updatedAt` bump,
 * no fresh dispatch marker) within a configurable window — INCLUDING while the
 * agent is `working`. It is deliberately OBSERVATION ONLY: nothing here can
 * resume, prompt, hijack or close a pane, so surfacing a flag can never
 * interrupt legitimate long work. The dispatcher records the flags on its
 * capacity-starvation signal so an operator can see WHO holds the model.
 */

import { isActiveBlocker } from './hydrator.js';
import type { DowntimeLogEntry } from './downtime-log.js';
import {
  DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  DOWNTIME_LONG_RUNNING_THRESHOLD_FLOOR_MS,
  DOWNTIME_LONG_RUNNING_THRESHOLD_MAX_MS,
  clampDowntimeLongRunningThresholdMs,
  paneLabelItemId,
} from './downtime-worker.js';
import {
  itemAdvancedPastKind,
  resolveLastActivityAt,
  stalledPaneKindFromLabel,
} from './stalled-work.js';
import type {
  DowntimeItemInfo,
  DowntimeItemResult,
  DowntimeSkillKind,
  HerdrPaneRecord,
} from './downtime-worker.js';

// Re-exported so callers/tests reach the window bounds from the detector
// module, while the canonical definitions live in `downtime-worker.ts` (the
// dispatcher's settings owner). Keeping the definition there means the worker
// needs only a TYPE import of this module — no runtime import cycle.
export {
  DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
  clampDowntimeLongRunningThresholdMs,
  DOWNTIME_LONG_RUNNING_THRESHOLD_FLOOR_MS,
  DOWNTIME_LONG_RUNNING_THRESHOLD_MAX_MS,
};

/**
 * Machine-readable reason a pane is NOT reported as long-running. Never a
 * dispatch outcome — purely diagnostic.
 *
 *  - `no-agent`               — the pane hosts no live pi agent.
 *  - `no-item-id`             — the label has no parseable work-item id.
 *  - `kind-unknown`           — the label carries no dispatch kind.
 *  - `item-terminal`          — the item is completed/deleted or in_review/done.
 *  - `kind-stale`             — the item already advanced past the pane's kind
 *                               (progress HAPPENED; the pane is finishing up).
 *  - `last-activity-unknown`  — no progress timestamp to measure against.
 *  - `progress-recent`        — the item progressed within the window.
 */
export type LongRunningPaneReason =
  | 'no-agent'
  | 'no-item-id'
  | 'kind-unknown'
  | 'item-terminal'
  | 'kind-stale'
  | 'last-activity-unknown'
  | 'progress-recent';

/** The detector's decision: long-running (with evidence) or a reason. */
export type LongRunningPaneDecision =
  | {
      longRunning: true;
      itemId: string;
      kind: DowntimeSkillKind;
      /** Epoch ms of the last progress anchor (item update / dispatch marker). */
      lastActivityAt: number;
      /** How long the item has been without progress (ms). */
      stalledForMs: number;
      /** The pane's live `agent_status` (reported verbatim, e.g. `working`). */
      agentStatus: string;
      /** The item's worklog stage (reported verbatim). */
      stage: string;
    }
  | { longRunning: false; reason: LongRunningPaneReason };

/**
 * Decide whether a live-agent pane has held a non-terminal item without any
 * observable progress for at least `thresholdMs`.
 *
 * Unlike {@link classifyStalledPane} the agent being `working` does NOT
 * exclude the pane: that is exactly the case this detector exists for. The
 * result is OBSERVATION ONLY — callers must never resume/hijack on it.
 *
 * Safety/exclusion rules (mirrors the stall classifier where they apply):
 *  - the pane must host a live agent (`agent` present);
 *  - the label must carry a work-item id and a dispatch kind;
 *  - the item must be non-terminal;
 *  - an item that advanced PAST the pane's kind is not stuck (`kind-stale`);
 *  - progress is anchored at the LATER of `item.updatedAt` and the item's most
 *    recent non-`spawn-failed`, non-`enrichment` dispatch marker for `kind`, so
 *    a pane freshly dispatched for an old item is not mistaken for a stall;
 *  - no parseable anchor → `last-activity-unknown` (fail-safe: never report).
 *
 * Pure: `now` and `thresholdMs` are injected so the decision is deterministic.
 */
export function classifyLongRunningPane(
  pane: HerdrPaneRecord,
  itemInfo: DowntimeItemInfo,
  guards: { entries: DowntimeLogEntry[] },
  now: number = Date.now(),
  thresholdMs: number = DEFAULT_DOWNTIME_LONG_RUNNING_THRESHOLD_MS,
): LongRunningPaneDecision {
  if (typeof pane.agent !== 'string' || pane.agent === '') {
    return { longRunning: false, reason: 'no-agent' };
  }
  const itemId = paneLabelItemId(pane.label);
  if (itemId === null) {
    return { longRunning: false, reason: 'no-item-id' };
  }
  const kind = stalledPaneKindFromLabel(pane.label);
  if (kind === null) {
    return { longRunning: false, reason: 'kind-unknown' };
  }
  if (!isActiveBlocker(itemInfo)) {
    return { longRunning: false, reason: 'item-terminal' };
  }
  if (itemAdvancedPastKind(kind, itemInfo.stage)) {
    return { longRunning: false, reason: 'kind-stale' };
  }
  const lastActivityAt = resolveLastActivityAt(itemInfo, guards.entries, itemId, kind);
  if (lastActivityAt === null) {
    return { longRunning: false, reason: 'last-activity-unknown' };
  }
  const stalledForMs = now - lastActivityAt;
  if (stalledForMs < thresholdMs) {
    return { longRunning: false, reason: 'progress-recent' };
  }
  return {
    longRunning: true,
    itemId,
    kind,
    lastActivityAt,
    stalledForMs,
    agentStatus: pane.agentStatus ?? '',
    stage: itemInfo.stage ?? '',
  };
}

/** One flagged pane, carrying its OWN worklog root. */
export interface LongRunningPaneObservation {
  paneId: string;
  itemId: string;
  /** The item's worklog root (resolved from the pane's cwd / agent_session). */
  cwd: string;
  kind: DowntimeSkillKind;
  lastActivityAt: number;
  stalledForMs: number;
  agentStatus: string;
  stage: string;
  title?: string;
}

/** Options for {@link scanLongRunningPanes}. */
export interface LongRunningScanOptions {
  /** Progress window before a pane is reported (ms). */
  thresholdMs: number;
  /** Injectable clock (defaults to `Date.now`). */
  now?: number;
  /** Upper bound on returned observations (default 10; `0` = unlimited). */
  maxObservations?: number;
}

/**
 * Injectable I/O seams for {@link scanLongRunningPanes}. Production wires the
 * same machine-wide `herdr pane list`, `wl show` fetch, rolling dispatch log
 * and root resolver as the stalled-work scan; tests stub them.
 */
export interface LongRunningScanDeps {
  /** Machine-wide pane list; `null` on an unreadable/unparseable read. */
  listPanes(): Promise<HerdrPaneRecord[] | null>;
  /** Fetch one item by id against its own worklog root (fail-closed). */
  fetchItem(itemId: string, cwd: string): Promise<DowntimeItemResult>;
  /** Read the item root's rolling dispatch log. */
  readEntries(cwd: string): Promise<DowntimeLogEntry[]>;
  /** Resolve the item's worklog root; `null` when ambiguous (skip the pane). */
  resolveRoot(pane: HerdrPaneRecord, fallbackCwd: string): string | null;
}

/**
 * Machine-wide scan for long-running panes (WL-0MVKNC2N50025HXE AC2).
 * Returns observations ordered by `stalledForMs` DESC (worst offender first),
 * each carrying its own worklog root.
 *
 * FAIL-SAFE: an unreadable pane list, an unresolvable root, a failed item
 * fetch or a thrown log read skips that pane and NEVER throws; an unconfigured
 * scan returns an empty array. The scan performs no writes.
 */
export async function scanLongRunningPanes(
  deps: LongRunningScanDeps,
  fallbackCwd: string,
  opts: LongRunningScanOptions,
): Promise<LongRunningPaneObservation[]> {
  const now = opts.now ?? Date.now();
  const thresholdMs = clampDowntimeLongRunningThresholdMs(opts.thresholdMs);
  let panes: HerdrPaneRecord[] | null;
  try {
    panes = await deps.listPanes();
  } catch {
    return [];
  }
  if (!Array.isArray(panes) || panes.length === 0) return [];
  const maxObservations =
    typeof opts.maxObservations === 'number' && Number.isFinite(opts.maxObservations) && opts.maxObservations > 0
      ? Math.floor(opts.maxObservations)
      : 10;

  const observations: LongRunningPaneObservation[] = [];
  for (const pane of panes) {
    // Cheap pre-checks before any per-pane I/O (mirrors the classifier).
    if (typeof pane.agent !== 'string' || pane.agent === '') continue;
    const itemId = paneLabelItemId(pane.label);
    if (itemId === null) continue;
    if (stalledPaneKindFromLabel(pane.label) === null) continue;
    const root = deps.resolveRoot(pane, fallbackCwd);
    if (root === null) continue;
    let fetched: DowntimeItemResult;
    try {
      fetched = await deps.fetchItem(itemId, root);
    } catch {
      continue;
    }
    if (!fetched.ok) continue;
    let entries: DowntimeLogEntry[] = [];
    try {
      entries = await deps.readEntries(root);
    } catch {
      entries = [];
    }
    const decision = classifyLongRunningPane(pane, fetched.info, { entries }, now, thresholdMs);
    if (!decision.longRunning) continue;
    observations.push({
      paneId: pane.paneId,
      itemId: decision.itemId,
      cwd: root,
      kind: decision.kind,
      lastActivityAt: decision.lastActivityAt,
      stalledForMs: decision.stalledForMs,
      agentStatus: decision.agentStatus,
      stage: decision.stage,
      ...(typeof fetched.info.title === 'string' && fetched.info.title !== ''
        ? { title: fetched.info.title }
        : {}),
    });
  }
  return observations
    .sort((a, b) => b.stalledForMs - a.stalledForMs)
    .slice(0, maxObservations);
}
