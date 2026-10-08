/**
 * packages/herdr/src/stalled-work.ts — pure stalled-pane classifier
 * (WL-0MUYMBO9X000WDF6, parent WL-0MUMA5OMH0024PN1).
 *
 * The downtime dispatcher must, before opening a NEW pane, notice an existing
 * pane whose pi agent stopped working on a non-terminal work item and resume
 * that work in place. This module provides the pure decision half of that
 * feature: {@link classifyStalledPane} maps a `herdr pane list` record + the
 * pane's work-item info + guard inputs to `{ stalled: true, kind }` or
 * `{ stalled: false, reason }` with no CLI/IO, so every stall condition and
 * every safety/no-progress exclusion is unit-testable in isolation.
 *
 * The resume orchestrator (`resumeStalledPane`) lands in a sibling item
 * (WL-0MUYMBPZ5004LBFX) and builds on this classifier.
 *
 * Reuse, not duplication: `paneLabelItemId` (downtime-worker), the
 * non-terminal status/stage check (`isActiveBlocker`, hydrator), the
 * non-terminal pane-close cooldown (`isNonTerminalCooldownActive`,
 * downtime-log) and the per-item/per-kind attempt cap
 * (`isAttemptBudgetExhausted`, downtime-worker) are the canonical predicates.
 */

import { isActiveBlocker } from './hydrator.js';
import { isNonTerminalCooldownActive, type DowntimeLogEntry } from './downtime-log.js';
import {
  DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
  isAttemptBudgetExhausted,
  paneLabelItemId,
  type DowntimeItemInfo,
  type DowntimeItemResult,
  type DowntimeSkillKind,
  type HerdrPaneRecord,
} from './downtime-worker.js';

// ── Guard inputs ──────────────────────────────────────────────────────

/**
 * The guard inputs the classifier needs beyond the pane and item themselves.
 * Kept explicit (rather than reading settings/log directly) so the classifier
 * stays pure.
 */
export interface StalledPaneGuards {
  /** Rolling downtime dispatch log (cooldown, attempt budget, stall anchor). */
  entries: DowntimeLogEntry[];
  /** Non-terminal pane-close cooldown window (ms). */
  nonTerminalCooldownMs: number;
  /** Per-item/per-kind dispatch attempt cap. */
  maxAttempts: number;
}

// ── Decision types ────────────────────────────────────────────────────

/**
 * Machine-readable reason a pane is NOT a stalled candidate. One code per
 * stall condition / safety exclusion so callers can log or assert precisely:
 *
 *  - `no-agent`                 — the pane hosts no live pi agent.
 *  - `no-item-id`               — the label has no parseable work-item id.
 *  - `kind-unknown`             — the label carries no dispatch kind.
 *  - `item-terminal`            — the item is completed/deleted or in_review/done.
 *  - `needs-producer-review`    — the item is flagged for producer review.
 *  - `agent-working`            — the agent is actively working (not stalled).
 *  - `agent-blocked`            — the agent is blocked (never hijacked).
 *  - `kind-stale`               — the item advanced past the pane's kind.
 *  - `cooldown-active`          — the non-terminal pane-close cooldown holds it.
 *  - `attempt-cap-exhausted`    — the per-item/per-kind attempt cap is reached.
 *  - `last-activity-unknown`    — no activity timestamp to measure a stall.
 *  - `stall-threshold-not-elapsed` — not-working for less than the threshold.
 */
export type StalledPaneReason =
  | 'no-agent'
  | 'no-item-id'
  | 'kind-unknown'
  | 'item-terminal'
  | 'needs-producer-review'
  | 'agent-working'
  | 'agent-blocked'
  | 'kind-stale'
  | 'cooldown-active'
  | 'attempt-cap-exhausted'
  | 'last-activity-unknown'
  | 'stall-threshold-not-elapsed';

/** The classifier's decision: stalled (with the derived kind) or a reason. */
export type StalledPaneDecision =
  | { stalled: true; kind: DowntimeSkillKind }
  | { stalled: false; reason: StalledPaneReason };

// ── Label → kind ──────────────────────────────────────────────────────

/** Every dispatch kind a pane label can name. */
const STALLED_PANE_KINDS: readonly DowntimeSkillKind[] = [
  'implement',
  'risk-effort',
  'intake',
  'audit',
  'plan',
];

/**
 * Derive the dispatched kind from a pane label. Recognises the launcher's
 * `<Downtime|Manually> triggered <kind> …` convention (the kind token is
 * immediately after `triggered`, so a title word can never masquerade as the
 * kind). Returns `null` for any other label — including a free-form
 * `Manually triggered prompt …` pane, which has no dispatch kind.
 */
export function stalledPaneKindFromLabel(label: string | undefined): DowntimeSkillKind | null {
  if (typeof label !== 'string' || label === '') return null;
  const match = /(?:downtime|manually)\s+triggered\s+([a-z][a-z-]*)/i.exec(label);
  if (match === null) return null;
  const token = match[1].toLowerCase();
  return (STALLED_PANE_KINDS as readonly string[]).includes(token)
    ? (token as DowntimeSkillKind)
    : null;
}

// ── Kind vs item-stage progression ────────────────────────────────────

/** Worklog stage rank (higher = further through the lifecycle). */
const ITEM_STAGE_RANK: Record<string, number> = {
  idea: 0,
  intake_complete: 1,
  plan_complete: 2,
  // Retired `in_progress` stage — an item being implemented. Rank it with
  // plan_complete so an implement pane is not treated as stale.
  in_progress: 2,
  in_review: 3,
  done: 4,
};

/** The stage at which each dispatched kind operates. */
const KIND_STAGE_RANK: Record<DowntimeSkillKind, number> = {
  intake: 0,
  plan: 1,
  'risk-effort': 2,
  implement: 2,
  audit: 3,
};

/**
 * True when the item has already advanced past the pane's dispatched kind
 * (parent AC4): e.g. an `intake` pane on an item now at `intake_complete`, or
 * an `implement` pane on an item now at `in_review`. An unknown stage cannot
 * prove advancement, so it fails open (not stale).
 */
function itemAdvancedPastKind(kind: DowntimeSkillKind, stage: string | undefined): boolean {
  const itemRank = typeof stage === 'string' ? (ITEM_STAGE_RANK[stage] ?? -1) : -1;
  return itemRank > KIND_STAGE_RANK[kind];
}

// ── Not-working duration ──────────────────────────────────────────────

/** `herdr agent_status` values that mean the agent is actively working. */
const WORKING_AGENT_STATUSES: ReadonlySet<string> = new Set([
  'work',
  'working',
  'busy',
  'running',
]);

/**
 * Timestamp of the item's last observed progress, used as the anchor for the
 * "not-working has persisted at least the threshold" test. It is the LATER of
 * the item's `updatedAt` and the item's most recent dispatch marker for
 * `kind`, so a pane freshly dispatched for an item last updated long ago is
 * not mistaken for a stall. Returns `null` when neither is parseable — the
 * caller treats that as an unprovable stall (fail-safe: skip).
 */
function resolveLastActivityAt(
  itemInfo: DowntimeItemInfo,
  entries: DowntimeLogEntry[],
  itemId: string,
  kind: DowntimeSkillKind,
): number | null {
  let anchor: number | null = null;
  if (typeof itemInfo.updatedAt === 'string' && itemInfo.updatedAt !== '') {
    const updated = Date.parse(itemInfo.updatedAt);
    if (!Number.isNaN(updated)) anchor = updated;
  }
  for (const entry of entries) {
    if (entry.itemId !== itemId || entry.kind !== kind) continue;
    if (entry.outcome === 'spawn-failed') continue;
    if (entry.enrichment === true) continue;
    if (typeof entry.dispatchedAt !== 'string') continue;
    const dispatched = Date.parse(entry.dispatchedAt);
    if (Number.isNaN(dispatched)) continue;
    if (anchor === null || dispatched > anchor) anchor = dispatched;
  }
  return anchor;
}

// ── Classifier ────────────────────────────────────────────────────────

/**
 * Decide whether a `herdr pane list` record describes a STALLED pane
 * (parent AC1/AC4). A pane is stalled when ALL hold:
 *
 *  1. it hosts a live pi agent (`agent` present);
 *  2. its label suffix parses to a non-terminal item (status not
 *     `completed`/`deleted`, stage not `in_review`/`done`);
 *  3. its `agent_status` is not `blocked` and not actively working;
 *  4. its not-working state has persisted at least `thresholdMs`;
 *
 * and NONE of the safety/no-progress exclusions apply: producer-review flag,
 * non-terminal pane-close cooldown, attempt cap, or item advanced past the
 * pane's dispatched kind.
 *
 * Pure: `now` and `thresholdMs` are injected so the decision is deterministic.
 * Skips are neutral by construction — the caller must not turn them into a
 * CLI-error strike or a `no-candidate` cooldown.
 *
 * @param pane       Parsed `herdr pane list` record.
 * @param itemInfo   The item named by the pane's label suffix.
 * @param guards     Log-derived cooldown/attempt/anchor inputs.
 * @param now        Current epoch ms (injectable for tests).
 * @param thresholdMs Minimum continuous not-working duration for a stall.
 */
export function classifyStalledPane(
  pane: HerdrPaneRecord,
  itemInfo: DowntimeItemInfo,
  guards: StalledPaneGuards,
  now: number = Date.now(),
  thresholdMs: number = DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
): StalledPaneDecision {
  // 1. A live pi agent must be present (an `agent` value is set).
  if (typeof pane.agent !== 'string' || pane.agent === '') {
    return { stalled: false, reason: 'no-agent' };
  }

  // 2. The label must carry a work-item id and a dispatch kind.
  const itemId = paneLabelItemId(pane.label);
  if (itemId === null) {
    return { stalled: false, reason: 'no-item-id' };
  }
  const kind = stalledPaneKindFromLabel(pane.label);
  if (kind === null) {
    return { stalled: false, reason: 'kind-unknown' };
  }

  // 3. The item must be non-terminal (not completed/deleted, not
  //    in_review/done) — reuse the canonical predicate.
  if (!isActiveBlocker(itemInfo)) {
    return { stalled: false, reason: 'item-terminal' };
  }

  // 4. Producer-review flag is a hard exclusion.
  if (itemInfo.needsProducerReview === true) {
    return { stalled: false, reason: 'needs-producer-review' };
  }

  // 5. The agent must be neither actively working nor blocked.
  const status = (pane.agentStatus ?? '').toLowerCase().trim();
  if (WORKING_AGENT_STATUSES.has(status)) {
    return { stalled: false, reason: 'agent-working' };
  }
  if (status === 'blocked') {
    return { stalled: false, reason: 'agent-blocked' };
  }

  // 6. The item must not have advanced past the pane's dispatched kind.
  if (itemAdvancedPastKind(kind, itemInfo.stage)) {
    return { stalled: false, reason: 'kind-stale' };
  }

  // 7. No-progress guards: non-terminal pane-close cooldown, then attempt cap.
  if (
    isNonTerminalCooldownActive(
      guards.entries,
      itemId,
      kind,
      itemInfo.stage,
      guards.nonTerminalCooldownMs,
      now,
    )
  ) {
    return { stalled: false, reason: 'cooldown-active' };
  }
  if (
    isAttemptBudgetExhausted(
      guards.entries,
      itemId,
      kind,
      itemInfo.stage,
      guards.maxAttempts,
    )
  ) {
    return { stalled: false, reason: 'attempt-cap-exhausted' };
  }

  // 8. The not-working state must have persisted at least the threshold.
  const lastActivityAt = resolveLastActivityAt(itemInfo, guards.entries, itemId, kind);
  if (lastActivityAt === null) {
    return { stalled: false, reason: 'last-activity-unknown' };
  }
  if (now - lastActivityAt < thresholdMs) {
    return { stalled: false, reason: 'stall-threshold-not-elapsed' };
  }

  return { stalled: true, kind };
}

// ── herdr agent CLI seams ─────────────────────────────────────────────

/**
 * Literal continuation prompt submitted when resuming a stalled pane
 * (parent AC2 / intake Q5): a fixed neutral nudge, never a stage-appropriate
 * skill command. Kept as a named constant so the orchestrator and its tests
 * share one source of truth.
 */
export const STALLED_RESUME_PROMPT = 'continue';

/**
 * Why a `herdr agent prompt` / `herdr agent start` invocation did not resume
 * the pane. Every value is a NEUTRAL outcome — the caller must never turn it
 * into a CLI-error strike, a crash, or a duplicate resume:
 *
 *  - `agent-blocked`        — the CLI refused because the agent is blocked.
 *  - `agent-prompt-stalled` — the submission was accepted but the agent never
 *                             reached `working`/`blocked` within the CLI's
 *                             documented 5 s window.
 *  - `pane-vanished`        — the pane/agent disappeared (e.g. the pane-close
 *                             reaper closed it) between scan and resume.
 *  - `cli-error`            — any other herdr/CLI failure.
 */
export type StalledResumeFailureReason =
  | 'agent-blocked'
  | 'agent-prompt-stalled'
  | 'pane-vanished'
  | 'cli-error';

/** Result of one herdr agent prompt/start invocation (injected seam). */
export type StalledResumeCliResult =
  | { ok: true }
  | { ok: false; reason: StalledResumeFailureReason; error?: string };

/** Options for relaunching an exited agent in its own pane. */
export interface StalledResumeStartOptions {
  /** pi session log path to continue; absent → `pi --continue`. */
  sessionPath?: string;
}

/**
 * Injectable I/O seams for {@link resumeStalledPane}. Production wires them
 * to the real herdr CLI, the rolling dispatch log and the worklog flag write;
 * tests stub them so the orchestrator is fully unit-testable without a live
 * herdr session or filesystem.
 */
export interface ResumeStalledPaneDeps {
  /** Submit `continue` to a live agent: `herdr agent prompt <paneId> continue`. */
  promptAgent(paneId: string, text: string): Promise<StalledResumeCliResult>;
  /**
   * Relaunch pi in an existing pane (agent exited) continuing its session:
   * `herdr agent start pi --kind pi --pane <paneId>` with
   * `-- --session <path>` (or `-- --continue`). The caller submits the
   * literal `continue` prompt afterwards.
   */
  startAgent(paneId: string, opts: StalledResumeStartOptions): Promise<StalledResumeCliResult>;
  /** Read the item root's rolling dispatch log (cooldown/attempt/anchor inputs). */
  readEntries(cwd: string): Promise<DowntimeLogEntry[]>;
  /** Append a dispatch-attempt marker to the item root's rolling log. */
  recordAttempt(cwd: string, entry: DowntimeLogEntry): Promise<void>;
  /** Flag an item whose attempt budget is exhausted for producer review. */
  markNeedsProducerReview(itemId: string, cwd: string): Promise<boolean>;
  /** Per-item/per-kind dispatch attempt cap. */
  maxAttempts: number;
  /** Injectable clock (defaults to `Date.now`). */
  now?(): number;
}

/**
 * Build the `herdr agent start` argument vector for relaunching pi in an
 * existing pane and continuing the item's session. Uses `--session <path>`
 * when the pane records one, else `pi --continue` (most recent session).
 * Pure so the continuation contract is unit-testable without a live CLI.
 */
export function buildStalledResumeStartArgs(
  paneId: string,
  opts: StalledResumeStartOptions = {},
): string[] {
  const args = ['agent', 'start', 'pi', '--kind', 'pi', '--pane', paneId];
  if (typeof opts.sessionPath === 'string' && opts.sessionPath !== '') {
    args.push('--', '--session', opts.sessionPath);
  } else {
    args.push('--', '--continue');
  }
  return args;
}

/**
 * Classify a raw herdr/CLI failure into a neutral resume failure reason.
 * Recognises the CLI's documented codes (`agent_blocked`,
 * `agent_prompt_stalled`) and a vanished pane; everything else is
 * `cli-error`. Pure so the mapping is unit-testable without a live herdr.
 */
export function classifyHerdrAgentFailure(
  raw: string | null | undefined,
): StalledResumeFailureReason {
  const text = (raw ?? '').toLowerCase();
  if (text.includes('agent_blocked') || text.includes('already blocked')) {
    return 'agent-blocked';
  }
  if (text.includes('agent_prompt_stalled') || text.includes('prompt stalled')) {
    return 'agent-prompt-stalled';
  }
  if (
    (text.includes('pane') || text.includes('pane_id')) &&
    (text.includes('not found') ||
      text.includes('no such') ||
      text.includes('does not exist') ||
      text.includes('unknown pane'))
  ) {
    return 'pane-vanished';
  }
  return 'cli-error';
}

// ── Resume orchestrator ───────────────────────────────────────────────

/**
 * Process-wide in-flight resume guard, keyed by `(paneId, itemId)`
 * (parent AC5): a second concurrent resume of the same pane/item in this
 * process is a neutral `concurrent-resume` skip, so a stalled pane is never
 * prompted twice in the same cycle.
 */
const _stalledResumeInFlight = new Set<string>();

/**
 * Test helper: clear the in-process resume guard between tests.
 */
export function _resetStalledResumeInFlight(): void {
  _stalledResumeInFlight.clear();
}

function stalledResumeKey(paneId: string, itemId: string): string {
  return `${paneId}\u0000${itemId}`;
}

/** Inputs for one in-place resume attempt. */
export interface StalledResumeInput {
  /** Parsed `herdr pane list` record for the stalled pane. */
  pane: HerdrPaneRecord;
  /** The item named by the pane's label suffix. */
  item: DowntimeItemInfo;
  /** The item's worklog root (resolved from the pane's cwd / agent_session). */
  cwd: string;
  /** Non-terminal pane-close cooldown window (ms). */
  nonTerminalCooldownMs: number;
  /** Minimum continuous not-working duration (ms). */
  thresholdMs?: number;
  /**
   * The dispatched kind derived from the pane label by the scan. The
   * classifier re-derives it from the label and wins on any mismatch, so the
   * two parses can never silently diverge.
   */
  kind: DowntimeSkillKind;
}

/**
 * Outcome of one {@link resumeStalledPane} attempt. `resumed:false` is ALWAYS
 * a neutral "not resumed this cycle" result — never a strike, never a crash,
 * never a duplicate. Includes every classifier reason plus the in-process
 * concurrency guard and the herdr CLI failures.
 */
export type StalledResumeOutcomeReason =
  | StalledPaneReason
  | 'concurrent-resume'
  | StalledResumeFailureReason;

export type StalledResumeOutcome =
  | {
      resumed: true;
      via: 'prompt' | 'start';
      paneId: string;
      itemId: string;
      kind: DowntimeSkillKind;
    }
  | {
      resumed: false;
      reason: StalledResumeOutcomeReason;
      paneId: string;
      itemId: string;
      kind: DowntimeSkillKind;
    };

/** Best-effort producer-review escalation — never throws. */
async function flagStalledResumeBudgetExhausted(
  deps: ResumeStalledPaneDeps,
  itemId: string,
  cwd: string,
): Promise<void> {
  try {
    await deps.markNeedsProducerReview(itemId, cwd);
  } catch {
    // fail-closed: a flag write failure must never crash the worker
  }
}

/** Session log path recorded on the pane, when present. */
function stalledResumeSessionPath(pane: HerdrPaneRecord): string | undefined {
  const value = pane.agentSession?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Attempt an IN-PLACE resume of a stalled pane (parent AC2/AC5/AC6). It
 * re-classifies the pane against the item's CURRENT rolling log, then:
 *
 *  - a live agent receives the literal `continue`
 *    (`herdr agent prompt <paneId> continue`);
 *  - a pane whose agent has exited (`done`/`exited`) has pi relaunched in the
 *    SAME pane continuing its session (`herdr agent start pi …`), after which
 *    the literal `continue` prompt is submitted.
 *
 * It records a dispatch attempt for `(item, kind)` on success, so the existing
 * per-item/per-kind attempt cap applies to resumes too, and enforces that cap
 * up front — escalating via `needsProducerReview` when exhausted.
 *
 * FAIL-SAFE: every not-resumed outcome (a classifier exclusion, a concurrent
 * resume, a `blocked` agent, `agent_prompt_stalled`, a vanished pane, or any
 * CLI error) is NEUTRAL — it never throws, never records a strike, and never
 * spawns a duplicate. A successful resume is the ONLY path that records an
 * attempt. A new pane is NEVER spawned: the resume always targets
 * `pane.paneId`.
 */
export async function resumeStalledPane(
  input: StalledResumeInput,
  deps: ResumeStalledPaneDeps,
): Promise<StalledResumeOutcome> {
  const { pane, item, cwd, kind, nonTerminalCooldownMs } = input;
  const itemId = item.id;
  const base = { paneId: pane.paneId, itemId, kind };

  // 1. Concurrency guard (paneId, itemId): a second resume in flight for the
  //    same pane/item is a neutral skip.
  const key = stalledResumeKey(pane.paneId, itemId);
  if (_stalledResumeInFlight.has(key)) {
    return { resumed: false, reason: 'concurrent-resume', ...base };
  }
  _stalledResumeInFlight.add(key);

  try {
    // 2. Re-classify against the item's CURRENT log (cooldown, attempt cap,
    //    stall anchor). Fail-safe: an unreadable log yields [] (fail-open).
    let entries: DowntimeLogEntry[] = [];
    try {
      entries = await deps.readEntries(cwd);
    } catch {
      entries = [];
    }
    const decision = classifyStalledPane(
      pane,
      item,
      { entries, nonTerminalCooldownMs, maxAttempts: deps.maxAttempts },
      (deps.now ?? Date.now)(),
      input.thresholdMs ?? DEFAULT_DOWNTIME_STALL_THRESHOLD_MS,
    );
    if (!decision.stalled) {
      // Attempt-budget exhaustion is the one exclusion that escalates: flag
      // the item for producer review so a repeatedly stalled pane surfaces
      // instead of looping through idle cycles forever (parent AC2).
      if (decision.reason === 'attempt-cap-exhausted') {
        await flagStalledResumeBudgetExhausted(deps, itemId, cwd);
      }
      return { resumed: false, reason: decision.reason, ...base };
    }

    // 3. Resume in place. An exited agent is relaunched in the SAME pane
    //    (continuing its session) before the literal prompt is submitted; a
    //    live agent is prompted directly.
    const status = (pane.agentStatus ?? '').toLowerCase().trim();
    const mustRelaunch = status === 'done' || status === 'exited';
    if (mustRelaunch) {
      const started = await deps.startAgent(pane.paneId, {
        sessionPath: stalledResumeSessionPath(pane),
      });
      if (!started.ok) {
        return { resumed: false, reason: started.reason, ...base };
      }
    }
    const prompted = await deps.promptAgent(pane.paneId, STALLED_RESUME_PROMPT);
    if (!prompted.ok) {
      return { resumed: false, reason: prompted.reason, ...base };
    }

    // 4. Record the dispatch attempt (success only) — reuses the normal
    //    claim/attempt bookkeeping so the cap applies to resumes too. A write
    //    failure is swallowed (fail-open): the resume already happened and a
    //    logging failure must not turn it into a crash or a wrong outcome.
    try {
      await deps.recordAttempt(cwd, {
        itemId,
        kind,
        dispatchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
        cwd,
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.stage !== undefined ? { stage: item.stage } : {}),
      });
    } catch {
      // fail-open: the resume already happened
    }

    return { resumed: true, via: mustRelaunch ? 'start' : 'prompt', ...base };
  } catch {
    // Any unexpected throw (an unwired/throwing seam) is a neutral CLI error.
    return { resumed: false, reason: 'cli-error', ...base };
  } finally {
    _stalledResumeInFlight.delete(key);
  }
}

// ── Machine-wide scan (WL-0MUYMBSA90092QV2) ───────────────────────────

/**
 * Options threaded through the stalled-work scan and resume. Re-read from the
 * plugin settings on every idle tick (never cached) so a settings change —
 * `downtimeStallScanEnabled` / `downtimeStallThresholdMs` — applies live.
 */
export interface StalledScanOptions {
  /** Master switch (`downtimeStallScanEnabled`). False → no scan at all. */
  enabled: boolean;
  /** True while the code-freeze marker is frozen/ambiguous (split-by-skill). */
  frozen: boolean;
  /** Minimum continuous not-working duration (`downtimeStallThresholdMs`). */
  thresholdMs: number;
  /** Non-terminal pane-close cooldown window (ms). */
  nonTerminalCooldownMs: number;
  /** Per-item/per-kind dispatch attempt cap. */
  maxAttempts: number;
  /** Injectable clock (defaults to `Date.now`). */
  now?: number;
}

/**
 * A stalled pane the scan is willing to resume, carrying the item's OWN
 * worklog root so a foreign-root pane is resumed against that root — never
 * the leader's (parent AC5).
 */
export interface StalledPaneCandidate {
  pane: HerdrPaneRecord;
  item: DowntimeItemInfo;
  /** The item's worklog root (resolved from the pane's cwd / agent_session). */
  cwd: string;
  kind: DowntimeSkillKind;
}

/**
 * Injectable I/O seams for {@link scanStalledPanes}. Production wires these to
 * the real machine-wide `herdr pane list`, the `wl show` fetch and the rolling
 * dispatch log; tests stub them so the scan is fully unit-testable without a
 * live herdr session or filesystem.
 */
export interface StalledScanDeps {
  /** Machine-wide pane list; `null` on an unreadable/unparseable read. */
  listPanes(): Promise<HerdrPaneRecord[] | null>;
  /** Fetch one item by id against its own worklog root (fail-closed). */
  fetchItem(itemId: string, cwd: string): Promise<DowntimeItemResult>;
  /** Read the item root's rolling dispatch log. */
  readEntries(cwd: string): Promise<DowntimeLogEntry[]>;
  /**
   * Resolve the item's worklog root from the pane's `cwd` / `agent_session`.
   * Returns `null` when the root cannot be resolved unambiguously — the scan
   * fails closed (skips the pane) rather than resuming against a wrong root.
   */
  resolveRoot(pane: HerdrPaneRecord, fallbackCwd: string): string | null;
}

/**
 * Machine-wide stalled-pane scan (WL-0MUYMBSA90092QV2 AC1/AC4): classify
 * every `herdr pane list` record and return the resumable stalled candidates
 * in list order. Pure orchestration over injected I/O so the ordering, the
 * cross-root resolution and the fail-safe exclusions are unit-testable.
 *
 * FAIL-SAFE: an empty array when the scan is disabled, the pane list is
 * unreadable/unparseable, or nothing is stalled. A per-pane failure (an
 * unresolvable root, a failed `wl show`, a thrown log read) skips that pane
 * and NEVER aborts the scan or throws. A code-frozen cycle skips `audit`/
 * `implement` panes so a resume can never bypass the freeze split-by-skill.
 */
export async function scanStalledPanes(
  deps: StalledScanDeps,
  fallbackCwd: string,
  opts: StalledScanOptions,
): Promise<StalledPaneCandidate[]> {
  if (opts.enabled !== true) return [];
  let panes: HerdrPaneRecord[] | null;
  try {
    panes = await deps.listPanes();
  } catch {
    return []; // fail-safe: an unreadable scan degrades to no stalled resume
  }
  if (!Array.isArray(panes) || panes.length === 0) return [];
  const now = opts.now ?? Date.now();
  const candidates: StalledPaneCandidate[] = [];
  for (const pane of panes) {
    // Cheap pre-checks before any per-pane I/O (mirrors the classifier).
    if (typeof pane.agent !== 'string' || pane.agent === '') continue;
    const itemId = paneLabelItemId(pane.label);
    if (itemId === null) continue;
    const kind = stalledPaneKindFromLabel(pane.label);
    if (kind === null) continue;
    // Code-freeze split-by-skill: never resume an audit/implement pane while
    // frozen/ambiguous — the resume path composes with, never bypasses, it.
    if (opts.frozen && (kind === 'audit' || kind === 'implement')) continue;
    const root = deps.resolveRoot(pane, fallbackCwd);
    if (root === null) continue; // unresolvable root → fail closed (skip)
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
    const decision = classifyStalledPane(
      pane,
      fetched.info,
      {
        entries,
        nonTerminalCooldownMs: opts.nonTerminalCooldownMs,
        maxAttempts: opts.maxAttempts,
      },
      now,
      opts.thresholdMs,
    );
    if (decision.stalled) {
      candidates.push({ pane, item: fetched.info, cwd: root, kind: decision.kind });
    }
  }
  return candidates;
}
