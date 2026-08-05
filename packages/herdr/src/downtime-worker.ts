/**
 * packages/herdr/src/downtime-worker.ts — Local-LLM downtime worker (contract)
 *
 * Test-first contract for the herdr downtime worker (parent
 * WL-0MSF49FMW009M06K). This module defines the exported contracts the
 * implementation features must satisfy, plus the PURE parts that are fully
 * implemented here:
 *
 *  - `isIdleStatus` — idle detection from a `/llama/local/status` payload.
 *  - `buildDowntimePrompt` / `BLOCKED_QUESTIONS_INSTRUCTION` — dispatched
 *    agent prompt, including the blocked-questions instruction.
 *  - `clampDowntimePollInterval` / `clampDowntimeIdleThresholdMs` /
 *    `clampDowntimeRequiredFreeSlots` — settings clamps. The settings keys
 *    and load/merge wiring live in `settings.ts` (WL-0MSG80254005ZNE9).
 *
 * The stateful / side-effectful parts are FAIL-CLOSED stubs whose contracts
 * are implemented by the downstream features:
 *
 *  - `createDowntimePoller` — real HTTP poller for `GET {proxyUrl}/llama/
 *    local/status` in WL-0MSG80254005ZNE9 (F2).
 *  - `createIdleTracker` — real idle-duration tracker in
 *    WL-0MSG80AG700429M8 (F3).
 *  - `dispatchDowntimeWork` — real dispatch orchestration (`wl next`,
 *    send-to-pi.sh pane spawn, pre-dispatch claim, single-flight) in
 *    WL-0MSG80AG700429M8 (F3).
 *
 * Fail-closed stub behaviour (never dispatch, never throw) is the SAFE
 * default: until the full worker lands, the plugin must not dispatch work
 * based on unverified logic.
 */

// ── Constants ─────────────────────────────────────────────────────────

/** Proxy status endpoint path. */
export const DOWNTIME_STATUS_PATH = '/llama/local/status';

/** Hard floor for the poll interval (must not hammer the proxy). */
export const DOWNTIME_POLL_INTERVAL_FLOOR_MS = 10_000;

/** Defensive floor for the idle threshold (prevents immediate dispatch). */
export const DOWNTIME_IDLE_THRESHOLD_FLOOR_MS = 1_000;

export const DEFAULT_DOWNTIME_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS = 240_000;

/** 0 = all slots must be free (default). Any positive integer N is accepted. */
export const DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS = 0;

export const DEFAULT_DOWNTIME_PROXY_URL = 'http://192.168.0.199:8000';
export const DEFAULT_DOWNTIME_MODEL = 'plan';

// ── Types ─────────────────────────────────────────────────────────────

/** Shape of `GET /llama/local/status` as served by the llama-proxy. */
export interface LlamaStatus {
  llama_server_running: boolean;
  active_query: boolean;
  model_switch_in_progress: boolean;
  local_lease_active: boolean;
  available_slots: number;
  total_slots: number;
  current_model?: string;
  local_owner_session_id?: string | null;
  local_owner_lease_remaining_seconds?: number | null;
}

// ── Idle detection (implemented) ──────────────────────────────────────

/**
 * True when the proxy reports an idle state for the required free-slot
 * count:
 *
 *  - llama-server is running,
 *  - no active query, model switch, or local lease,
 *  - `requiredFreeSlots <= 0` (default) requires ALL slots free
 *    (`available_slots >= total_slots`) with `total_slots > 0`,
 *  - a positive N requires at least N slots free; N > total_slots can never
 *    be satisfied, so it is never idle,
 *  - ambiguous responses (missing/non-finite fields, `total_slots` 0) are
 *    busy (fail-closed).
 */
export function isIdleStatus(status: LlamaStatus, requiredFreeSlots: number): boolean {
  if (!status.llama_server_running) return false;
  if (status.active_query) return false;
  if (status.model_switch_in_progress) return false;
  if (status.local_lease_active) return false;

  const total = status.total_slots;
  if (!Number.isFinite(total) || total <= 0) return false; // ambiguous → busy

  const available = status.available_slots;
  if (!Number.isFinite(available) || available < 0) return false;

  const required = requiredFreeSlots <= 0 ? total : requiredFreeSlots;
  if (required > total) return false; // N > total_slots can never be idle
  return available >= required;
}

// ── Idle-duration tracker (stub — F3) ─────────────────────────────────

export interface IdleTracker {
  /** Idle-since timestamp (ms), or null when not currently in an idle run. */
  readonly idleSince: number | null;
  /**
   * Record one poll result. `isIdle` true advances the idle run; false
   * resets it (idleSince = null).
   */
  record(isIdle: boolean, now?: number): void;
  /**
   * True once the current idle run has lasted `thresholdMs` or longer
   * continuously.
   */
  isThresholdMet(thresholdMs: number, now?: number): boolean;
}

/**
 * FAIL-CLOSED stub (implemented in WL-0MSG80AG700429M8): never reports an
 * idle threshold met, so no dispatch can occur until the real tracker lands.
 */
export function createIdleTracker(): IdleTracker {
  return {
    idleSince: null,
    record(_isIdle: boolean, _now?: number): void {
      // stub
    },
    isThresholdMet(_thresholdMs: number, _now?: number): boolean {
      return false;
    },
  };
}

// ── Poller (stub — F2) ────────────────────────────────────────────────

/**
 * Minimal structural fetch signature (the DOM `fetch` type is not part of
 * this project's tsconfig lib). Node's global `fetch` satisfies it at
 * runtime.
 */
export type LlamaStatusFetcher = (
  url: string,
  init?: { signal?: unknown },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DowntimePoller {
  /**
   * Poll `GET {proxyUrl}/llama/local/status` once. Resolves to the parsed
   * status, or null when the endpoint failed/timed out or the payload was
   * ambiguous (both cases are treated as busy by the caller).
   */
  poll(): Promise<LlamaStatus | null>;
  /** True while a poll is in flight (single-flight guard for the loop). */
  isPolling(): boolean;
}

/**
 * FAIL-CLOSED stub (implemented in WL-0MSG80254005ZNE9): resolves busy
 * (null) without performing any network I/O.
 */
export function createDowntimePoller(
  _proxyUrl: string,
  _fetcher: LlamaStatusFetcher = globalThis.fetch as unknown as LlamaStatusFetcher,
): DowntimePoller {
  return {
    async poll(): Promise<LlamaStatus | null> {
      return null;
    },
    isPolling(): boolean {
      return false;
    },
  };
}

// ── Dispatch (stub — F3) ──────────────────────────────────────────────

export type DowntimeStage = 'intake_complete' | 'idea';
export type DowntimeSkillKind = 'plan' | 'intake';

export interface DowntimeCandidate {
  id: string;
  title: string;
  stage: DowntimeStage;
}

/** External boundaries injected so the dispatch logic is testable. */
export interface DowntimeWorkerDeps {
  /** Runs `wl next --stage <stage> --json` and returns the first candidate or null. */
  getNextItem(stage: DowntimeStage): Promise<DowntimeCandidate | null>;
  /** Opens a visible pi agent pane running the prompt (via send-to-pi.sh). */
  spawnAgentPane(prompt: string, opts: { model: string; cwd: string }): Promise<void>;
}

export interface DowntimeDispatchOutcome {
  dispatched: boolean;
  candidate?: DowntimeCandidate;
  kind?: DowntimeSkillKind;
  reason?: string;
}

/**
 * FAIL-CLOSED stub (implemented in WL-0MSG80AG700429M8): never dispatches.
 * The real implementation selects `wl next --stage intake_complete` →
 * `/skill:plan <id>` (falling back to `--stage idea` → `/skill:intake
 * <id>`), opens a visible pane via `spawnAgentPane`, and honours the
 * single-flight guard.
 */
export async function dispatchDowntimeWork(
  _deps: DowntimeWorkerDeps,
  _opts: { model: string; cwd: string },
): Promise<DowntimeDispatchOutcome> {
  return { dispatched: false, reason: 'not-implemented' };
}

// ── Blocked-questions prompt (implemented) ────────────────────────────

/**
 * Instruction appended to every dispatched prompt: when the skill run
 * cannot proceed because answers are needed, record the questions in a
 * comment on the work item, mark it as needing producer review, and stop —
 * never block indefinitely (parent AC6).
 */
export const BLOCKED_QUESTIONS_INSTRUCTION =
  'If you cannot proceed because you need answers, record the questions in a ' +
  'comment on the work item (wl comment add <id> --comment "question: ...") and ' +
  'mark the item as needing producer review (wl update <id> --needs-producer-review ' +
  'true), then stop — do not block indefinitely.';

/** Build the prompt dispatched to a pi agent pane for the given candidate. */
export function buildDowntimePrompt(kind: DowntimeSkillKind, candidate: DowntimeCandidate): string {
  const skill = kind === 'plan' ? '/skill:plan' : '/skill:intake';
  return [
    `Run ${skill} ${candidate.id} — ${candidate.title}.`,
    BLOCKED_QUESTIONS_INSTRUCTION,
  ].join('\n');
}

// ── Settings clamps (implemented — wired into settings.ts by F2) ──────

/**
 * Clamp the downtime poll interval: never below the 10s hard floor, default
 * 30s for non-finite input.
 */
export function clampDowntimePollInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DOWNTIME_POLL_INTERVAL_MS;
  return Math.max(Math.round(value), DOWNTIME_POLL_INTERVAL_FLOOR_MS);
}

/**
 * Clamp the idle threshold: reject negative/non-finite (fall back to the
 * 4-minute default) and floor at 1s to prevent immediate dispatch.
 */
export function clampDowntimeIdleThresholdMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_IDLE_THRESHOLD_MS;
  return Math.max(Math.round(value), DOWNTIME_IDLE_THRESHOLD_FLOOR_MS);
}

/**
 * Clamp the required-free-slots count: a non-negative integer; 0 = all
 * slots. Negative/non-finite input falls back to 0 (all slots, the
 * strictest safe default).
 */
export function clampDowntimeRequiredFreeSlots(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_REQUIRED_FREE_SLOTS;
  return Math.round(value);
}
