/**
 * packages/herdr/src/downtime-worker.ts — Local-LLM downtime worker (contract)
 *
 * Test-first contract for the herdr downtime worker (parent
 * WL-0MSF49FMW009M06K). Implemented in F1 (tests + fixtures), F2 (settings
 * clamps, poller, parsing, runtime idle evaluation) and F3 (idle tracker,
 * dispatch orchestration, pane spawn):
 *
 *  - `isIdleStatus` — idle detection from a `/llama/local/status` payload.
 *  - `evaluateIdle` — runtime idle evaluation with the fail-closed
 *    degradation for a configured N < total slots (no per-slot data yet).
 *  - `parseLlamaStatus` / `fetchLocalStatus` / `createDowntimePoller` — the
 *    single-flight poller for `GET {proxyUrl}/llama/local/status` with
 *    per-poll timeout and fail-closed parsing.
 *  - `createIdleTracker` — continuous idle-duration tracker (idleSince vs
 *    threshold).
 *  - `dispatchDowntimeWork` — dispatch orchestration: completed/in_review
 *    items without a valid audit (modified within the last 7 days) →
 *    `/skill:audit <id>` (audit tier, WL-0MSI8H3HP000K0RG), then the
 *    implement tier (WL-0MSMAYPQP001FLR6): the highest-priority open
 *    plan_complete item with risk Low / effort Small|XS →
 *    `/skill:implement <id>`, then `wl next --stage intake_complete` →
 *    `/skill:plan <id>`, fallback `--stage idea` → `/skill:intake <id>`,
 *    pre-dispatch claim, per-process single-flight. Code-freeze gate
 *    (WL-0MSQ0RPQP00636JY): the ship-it marker is re-read fresh on every
 *    dispatch; while frozen OR ambiguous (fail-closed) the audit and
 *    implement tiers are skipped (no new implementations/audits during a
 *    release) and plan/intake still dispatch; an empty plan/intake backlog
 *    during a freeze reports reason 'code-freeze' (never 'no-candidate'),
 *    so the freeze never triggers the no-candidate cooldown and dispatch
 *    resumes immediately when it lifts. The audit tier
 *    additionally excludes items the downtime worker has already dispatched
 *    for `/skill:audit` (durable dispatched-marker exclusion,
 *    WL-0MSLIY8ZR004QUSY) unless a fresh audit exists since, closing the
 *    re-selection loop where a dispatched run reverts the item to
 *    completed/in_review without recording a fresh audit. A tier-2 CLI error does
 *    NOT short-circuit: the idea tier is still attempted so a tier-3
 *    candidate can still dispatch.
 *    `wl next` failures are reported as `{ok:false}` (fail closed to busy)
 *    and are never mistaken for an empty backlog; three consecutive error
 *    outcomes pause the worker entirely after logging the persistent error
 *    via `deps.recordError` (three-strike rule, `DOWNTIME_ERROR_STRIKE_LIMIT`).
 *  - `buildDowntimePaneArgs` / `spawnDowntimePane` — send-to-pi.sh
 *    invocation (`--pane-name Downtime <kind>`, `--no-focus`, `--cwd`,
 *    `--model`), detached and unref'd.
 *  - `createDowntimeWorker` — per-tick orchestrator (poll → evaluate →
 *    track → dispatch) with settings re-read each tick, plus the
 *    no-candidate cooldown (WL-0MSI7DQL10016QYX): a genuine empty backlog
 *    in both stages pauses the worker entirely for
 *    `downtimeNoCandidateCooldownMs` (default 60 min) — no poll, no idle
 *    tracking, no dispatch — and resets the idle tracker so a fresh full
 *    idle period is required after the pause. Transient `wl` errors and the
 *    in-flight dispatch guard never trigger the cooldown; three consecutive
 *    CLI-error outcomes do (three-strike rule), after logging the
 *    persistent error via `deps.recordError`.
 *  - `buildDowntimePrompt` / `BLOCKED_QUESTIONS_INSTRUCTION` — dispatched
 *    agent prompt, including the blocked-questions instruction.
 *  - `clampDowntimePollInterval` / `clampDowntimeIdleThresholdMs` /
 *    `clampDowntimeRequiredFreeSlots` / `clampDowntimeNoCandidateCooldownMs`
 *    — settings clamps, wired into `settings.ts`.
 *
 * Fail-closed behaviour (never dispatch, never throw) is the SAFE default
 * at every boundary.
 */

import { spawn } from 'node:child_process';
import { isAuditFresh } from './icons.js';
import type { CodeFreezeStatus } from './code-freeze.js';

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

/** Sane floor for the no-candidate cooldown (the pause cannot be disabled or set trivially small). */
export const DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS = 60_000;

/** Default pause after a genuine empty backlog: 60 minutes. */
export const DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS = 3_600_000;

/**
 * Audit-tier recency window: a completed/in_review candidate is only
 * dispatched for audit when it was modified within the last 7 days.
 */
export const DOWNTIME_AUDIT_RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Three-strike rule: this many consecutive CLI-error dispatch outcomes
 * pause the worker entirely (after logging the persistent error).
 */
export const DOWNTIME_ERROR_STRIKE_LIMIT = 3;

/**
 * Timeout for the downtime worker's `wl` CLI invocations (`getNextItem` /
 * `getNextAuditCandidate` in index.ts): a hung `wl` child must be killed
 * and the lookup fail closed (a CLI-error strike) within a bounded time
 * instead of wedging the dispatch task until the pane restarts
 * (WL-0MSJIPHD0001L1J9). 10s is comfortably above the healthy ~0.15s wl
 * latency and below the CLI's own 60s safety timeout (used as the upper
 * bound for this value).
 */
export const DOWNTIME_WL_TIMEOUT_MS = 10_000;

/**
 * Scheduler-level watchdog bound for ONE downtime-worker tick run
 * (WL-0MSJIPHD0001L1J9): the maximum wall-clock time a scheduler run may
 * take before it is abandoned and the task's single-flight flag is reset so
 * the next tick retries — a hung run can never permanently wedge the
 * downtime task. Chosen comfortably above the worst-case bounded dispatch
 * path (5s proxy poll + up to three 10s wl lookups + 3s claim + 5s dispatch
 * comment ≈ 45s) so healthy runs never trip it, while a hung run still
 * recovers within a minute instead of wedging until a pane restart.
 */
export const DOWNTIME_RUN_TIMEOUT_MS = 60_000;

export const DEFAULT_DOWNTIME_PROXY_URL = 'http://192.168.0.199:8000';
export const DEFAULT_DOWNTIME_MODEL = 'plan';

// ── Types ─────────────────────────────────────────────────────────────

/** Shape of `GET /llama/local/status` as served by the llama-proxy. */
export interface LlamaStatus {
  llama_server_running: boolean;
  /**
   * GLOBAL query activity: any request in flight (local AND remote).
   *
   * Prefer `local_active_query` when present — remote provider streams keep
   * this true while the local model is idle with free slots, so treating it
   * as the busy signal would block downtime dispatch (RCA
   * WL-0MSK9TUCA00206M7).
   */
  active_query: boolean;
  /**
   * LOCAL-only query activity (served by proxies exposing the
   * `local_active_queries` counter, LP-0MSL2ZLLS009RVKR). Optional: ABSENT on
   * pre-fix proxies. When present, `isIdleStatus` prefers it over the global
   * `active_query`; `local_active_query=true` implies `active_query=true`.
   */
  local_active_query?: boolean;
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
  // Prefer the local-only signal when the proxy exposes it (LP-0MSL2ZLLS009RVKR):
  // remote streams keep the GLOBAL active_query true while the local model is
  // idle with free slots, so they must not block downtime dispatch. Fall back
  // to the global active_query for pre-fix proxies that do not serve
  // local_active_query (backward compatible).
  const queryActive =
    status.local_active_query !== undefined ? status.local_active_query : status.active_query;
  if (queryActive) return false;
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

/**
 * Runtime idle evaluation (F2). Same conditions as `isIdleStatus`, plus the
 * fail-closed fallback from planning decision Q7: while the proxy does not
 * expose per-slot identity (LP-0MSG5TA7Y002GN39), a configured N with
 * 0 < N < total slots degrades to requiring ALL slots free — stricter than
 * configured, never "any N slots" without same-slot identity. N > total
 * slots never dispatches (carried through `isIdleStatus`).
 */
export function evaluateIdle(status: LlamaStatus, requiredFreeSlots: number): boolean {
  const total = status.total_slots;
  if (!Number.isFinite(total) || total <= 0) return false; // ambiguous → busy
  const effective = requiredFreeSlots > 0 && requiredFreeSlots < total
    ? total
    : requiredFreeSlots;
  return isIdleStatus(status, effective);
}

// ── Idle-duration tracker (implemented — F3) ──────────────────────────

export interface IdleTracker {
  /** Idle-since timestamp (ms), or null when not currently in an idle run. */
  readonly idleSince: number | null;
  /**
   * Record one poll result. `isIdle` true starts (or continues) the idle
   * run; false resets it (idleSince = null).
   */
  record(isIdle: boolean, now?: number): void;
  /**
   * True once the current idle run has lasted `thresholdMs` or longer
   * continuously.
   */
  isThresholdMet(thresholdMs: number, now?: number): boolean;
}

/**
 * Continuous idle-duration tracker. `idleSince` is set on the first idle
 * poll and kept fixed for the whole idle run (so consecutive idle polls
 * advance the run); ANY busy poll resets it to null. A dispatch therefore
 * only fires after the idle state has been continuous for the full
 * threshold, and a fresh full idle period is required after any busy poll.
 */
export function createIdleTracker(): IdleTracker {
  let idleSince: number | null = null;
  return {
    get idleSince(): number | null {
      return idleSince;
    },
    record(isIdle: boolean, now: number = Date.now()): void {
      idleSince = isIdle ? (idleSince ?? now) : null;
    },
    isThresholdMet(thresholdMs: number, now: number = Date.now()): boolean {
      if (idleSince === null) return false;
      return now - idleSince >= thresholdMs;
    },
  };
}

// ── Poller (implemented — F2) ────────────────────────────────────────

/**
 * Minimal structural fetch signature (the DOM `fetch` type is not part of
 * this project's tsconfig lib). Node's global `fetch` satisfies it at
 * runtime.
 */
export type LlamaStatusFetcher = (
  url: string,
  init?: { signal?: unknown },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Per-poll timeout: an unresponsive proxy must fail closed, not hang. */
export const DEFAULT_DOWNTIME_POLL_TIMEOUT_MS = 5_000;

/**
 * Fail-closed parse of a `GET /llama/local/status` payload. Returns null
 * (treated as busy by the caller) when required fields are missing or
 * malformed. `local_lease_active` is derived from the lease fields the
 * proxy actually serves when the boolean is not present.
 */
export function parseLlamaStatus(raw: unknown): LlamaStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.llama_server_running !== 'boolean') return null;
  if (typeof o.active_query !== 'boolean') return null;
  if (typeof o.model_switch_in_progress !== 'boolean') return null;

  // Optional local-only signal (LP-0MSL2ZLLS009RVKR): absent on pre-fix
  // proxies, in which case isIdleStatus falls back to the global
  // active_query. A malformed (non-boolean) value is ambiguous → busy.
  let localActiveQuery: boolean | undefined;
  if (o.local_active_query !== undefined) {
    if (typeof o.local_active_query !== 'boolean') return null;
    localActiveQuery = o.local_active_query;
  }

  const available = o.available_slots;
  const total = o.total_slots;
  if (typeof available !== 'number' || !Number.isFinite(available) || available < 0) return null;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;

  let localLeaseActive: boolean;
  if (typeof o.local_lease_active === 'boolean') {
    localLeaseActive = o.local_lease_active;
  } else {
    // Derived from the lease fields served by the llama-proxy.
    const ownerSession = o.local_owner_session_id;
    const leaseSeconds = o.local_owner_lease_remaining_seconds;
    localLeaseActive =
      (typeof ownerSession === 'string' && ownerSession.length > 0) ||
      (typeof leaseSeconds === 'number' && Number.isFinite(leaseSeconds) && leaseSeconds > 0);
  }

  return {
    llama_server_running: o.llama_server_running,
    active_query: o.active_query,
    local_active_query: localActiveQuery,
    model_switch_in_progress: o.model_switch_in_progress,
    local_lease_active: localLeaseActive,
    available_slots: available,
    total_slots: total,
    current_model: typeof o.current_model === 'string' ? o.current_model : undefined,
    local_owner_session_id:
      typeof o.local_owner_session_id === 'string' ? o.local_owner_session_id : undefined,
    local_owner_lease_remaining_seconds:
      typeof o.local_owner_lease_remaining_seconds === 'number'
        ? o.local_owner_lease_remaining_seconds
        : undefined,
  };
}

/**
 * Fetch and parse `GET {url}/llama/local/status` with a per-poll timeout.
 * Every failure mode — network error, timeout, HTTP error status, invalid
 * JSON, ambiguous payload — resolves to null (busy); this function never
 * throws.
 */
export async function fetchLocalStatus(
  url: string,
  opts?: { timeoutMs?: number; fetcher?: LlamaStatusFetcher },
): Promise<LlamaStatus | null> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_DOWNTIME_POLL_TIMEOUT_MS;
  const fetcher = opts?.fetcher ?? (globalThis.fetch as unknown as LlamaStatusFetcher);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    if (!res.ok) return null;
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return null; // invalid JSON
    }
    return parseLlamaStatus(raw);
  } catch {
    return null; // network errors / timeouts → busy, never throw
  } finally {
    clearTimeout(timer);
  }
}

export interface DowntimePoller {
  /**
   * Poll `GET {proxyUrl}/llama/local/status` once. Resolves to the parsed
   * status, or null when the endpoint failed/timed out or the payload was
   * ambiguous (both cases are treated as busy by the caller). Overlapping
   * calls coalesce onto the in-flight poll (single-flight).
   */
  poll(): Promise<LlamaStatus | null>;
  /** True while a poll is in flight (single-flight guard for the loop). */
  isPolling(): boolean;
}

/**
 * Single-flight poller for the llama-proxy status endpoint. `poll()` never
 * overlaps: a second call while one poll is in flight returns the same
 * in-flight promise.
 */
export function createDowntimePoller(
  proxyUrl: string,
  fetcher: LlamaStatusFetcher = globalThis.fetch as unknown as LlamaStatusFetcher,
  timeoutMs: number = DEFAULT_DOWNTIME_POLL_TIMEOUT_MS,
): DowntimePoller {
  let inFlight: Promise<LlamaStatus | null> | null = null;
  const url = `${proxyUrl.replace(/\/+$/, '')}${DOWNTIME_STATUS_PATH}`;

  return {
    poll(): Promise<LlamaStatus | null> {
      if (inFlight !== null) return inFlight;
      inFlight = fetchLocalStatus(url, { timeoutMs, fetcher }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    isPolling(): boolean {
      return inFlight !== null;
    },
  };
}

// ── Dispatch (implemented — F3) ───────────────────────────────────────

export type DowntimeStage = 'intake_complete' | 'idea' | 'audit' | 'implement';
export type DowntimeSkillKind = 'plan' | 'intake' | 'audit' | 'implement';

export interface DowntimeCandidate {
  id: string;
  title: string;
  stage: DowntimeStage;
  /**
   * Worklog status of the candidate (`open` for selectable plan/intake/
   * implement items; `completed` for audit candidates). The plan/intake tiers
   * filter client-side to `status === 'open'` (RCA WL-0MSRBFFLN005W3VT
   * amplifier fix): `wl next --stage X` keeps completed items under a stage
   * filter, so without this guard a completed/in_review item whose stage
   * matches could be dispatched for /skill:plan or /skill:intake.
   */
  status?: string;
  /** wl next priority order preserved for deterministic selection. */
  sortIndex?: number;
}

/**
 * A candidate for the implement tier, parsed from
 * `wl next --stage plan_complete --risk low --effort small -n N --json`.
 * The `status` field distinguishes open items from completed epics that
 * `wl next` keeps under a stage filter (the implement tier must filter
 * client-side to `status === 'open'`, AC2). `sortIndex` preserves wl next's
 * priority order for deterministic selection.
 */
export interface ImplementCandidate {
  id: string;
  title: string;
  status: string;
  risk?: string;
  effort?: string;
  sortIndex?: number;
}

/**
 * A completed/in_review item candidate for the downtime audit tier.
 * Parsed from `wl list --status completed --stage in_review --json`.
 */
export interface AuditCandidate {
  id: string;
  title: string;
  auditedAt?: string | null;
  updatedAt?: string;
  sortIndex?: number;
}

/**
 * Outcome of one `wl next --stage <stage> --json` lookup.
 *
 * `ok: true` means the CLI answered (candidate may still be null when the
 * stage is genuinely empty); `ok: false` means a transient wl/CLI failure
 * (fail-closed to busy — never a candidate). The distinction matters: an
 * empty backlog pauses the worker immediately, while a CLI failure counts
 * as one strike and only pauses after `DOWNTIME_ERROR_STRIKE_LIMIT`
 * consecutive failures (three-strike rule).
 */
export type DowntimeNextResult =
  | { ok: true; candidate: DowntimeCandidate | null }
  | { ok: false };

/**
 * Expected state for the pre-dispatch claim (compare-and-swap, RCA
 * WL-0MSRBFFLN005W3VT design point 1): the claim transition to
 * `in_progress` only applies while the item is still in the state the tier
 * selected it in. `status` matches the stored hyphenated status
 * (`open`/`completed`/...); `stage` matches the worklog stage.
 */
export interface DowntimeClaimExpected {
  status?: string;
  stage?: string;
}

/**
 * Outcome of a pre-dispatch claim. `ok:true` means THIS pane won the
 * claim; `ok:false` with reason `stale` means another pane claimed the item
 * first (or its state changed since selection) — the dispatch MUST abort;
 * `ok:false` with reason `error` is a wl CLI failure (counted as a
 * wl-error strike).
 */
export type DowntimeClaimResult =
  | { ok: true }
  | { ok: false; reason: 'stale' | 'error' };

/** External boundaries injected so the dispatch logic is testable. */
export interface DowntimeWorkerDeps {
  /**
   * Runs `wl next --stage <stage> -n 10 --json` and reports the first
   * selectable candidate (or a wl failure). `cwd` is the worklog root whose
   * `.worklog/downtime-dispatches.log` is consulted for the plan/intake
   * dispatched-marker change-guard (RCA WL-0MSRBFFLN005W3VT design point 3):
   * a candidate already dispatched for its tier while still at its
   * dispatched-at stage is excluded. A batch is fetched so excluding the
   * top candidate does not starve selection of the next one.
   */
  getNextItem(stage: DowntimeStage, cwd: string): Promise<DowntimeNextResult>;
  /**
   * Look up the next completed/in_review item WITHOUT a valid audit (the
   * audit dispatch tier, which runs before the plan/intake tiers). Fail-closed:
   * a wl failure yields no candidate (no dispatch). `cwd` is the worklog root
   * whose `.worklog/downtime-dispatches.log` is consulted for the
   * dispatched-marker exclusion (WL-0MSLIY8ZR004QUSY): items the downtime
   * worker already dispatched for `/skill:audit` are never re-selected while
   * they still lack a fresh audit.
   */
  getNextAuditCandidate(cwd: string): Promise<DowntimeCandidate | null>;
  /**
   * Look up the next implement-tier candidate (WL-0MSMAYPQP001FLR6): the
   * highest-priority open plan_complete item with risk Low / effort Small|XS,
   * excluding dependency-blocked items (wl next default) and items already
   * dispatched for `/skill:implement` (kind `implement` dispatched markers,
   * AC6). Fail-closed: a wl failure yields null (no dispatch) — the
   * plan/intake fallback still runs. `cwd` is the worklog root whose
   * `.worklog/downtime-dispatches.log` is consulted for the marker set.
   */
  getNextImplementCandidate(cwd: string): Promise<DowntimeCandidate | null>;
  /**
   * Read the current code-freeze marker status (tri-state: 'frozen' /
   * 'not-frozen' / 'ambiguous'). `cwd` is the worklog root; the marker
   * lives at `<cwd>/.worklog/code-freeze.json`. Read fresh on EVERY
   * dispatch (never cached) so a freeze that starts or ends between idle
   * periods is honored on the next dispatch attempt (WL-0MSQ0RPQP00636JY).
   * Fail-closed: an 'ambiguous' marker is treated as frozen by the
   * dispatcher — no implement/audit dispatch while the marker cannot be
   * trusted.
   */
  readCodeFreezeStatus(cwd: string): CodeFreezeStatus;
  /**
   * Claim the item (CAS: `wl update <id> --status in_progress --if-status
   * <expected.status> [--if-stage <expected.stage>]`) BEFORE anything else.
   * Exactly one concurrent pane wins; a loser resolves `{ok:false,
   * reason:'stale'}` and the dispatcher aborts (no pane, no marker, no
   * success record). A `{ok:false, reason:'error'}` is a wl CLI failure
   * (a strike, never silently discarded — WL-0MSLWJ310000ND0X absorbed).
   */
  claimItem(itemId: string, expected: DowntimeClaimExpected): Promise<DowntimeClaimResult>;
  /**
   * Open a visible pi agent pane running the prompt (via send-to-pi.sh).
   * Resolves true when the spawn started; false on a handled spawn `error`
   * event (no unhandled-exception crash, WL-0MSLWJ3I70031Z8U absorbed).
   */
  spawnAgentPane(prompt: string, opts: { model: string; cwd: string }): Promise<boolean>;
  /**
   * Audit trail for a successful dispatch: comment on the item + rolling
   * log entry under `.worklog`. Resolves TRUE only when the rolling-log
   * MARKER was written (the dispatched-marker source); a comment failure is
   * tolerated (the comment is a durable cross-machine trail, not the
   * marker). A false result makes the dispatcher ABORT before spawning — an
   * unmarked item is never dispatched (fail-closed, RCA design point 2).
   */
  recordDispatch(event: DowntimeDispatchEvent): Promise<boolean>;
  /**
   * Record a persistent CLI-error event (three consecutive wl failures).
   * Must never throw (fail-closed): logging must not crash the worker.
   */
  recordError(event: DowntimeErrorEvent): Promise<void>;
}

/** Audit event recorded for every successful downtime dispatch. */
export interface DowntimeDispatchEvent {
  itemId: string;
  kind: DowntimeSkillKind;
  /** ISO-8601 UTC timestamp of the dispatch. */
  dispatchedAt: string;
  /** Worklog root (the rolling log lives at `<cwd>/.worklog`). */
  cwd: string;
  title?: string;
  /**
   * Worklog stage of the item at dispatch (plan/intake change-guard, RCA
   * WL-0MSRBFFLN005W3VT design point 3): a candidate is excluded while it is
   * still at its dispatched-at stage; a stage advancement releases it.
   * Backward compatible — absent on legacy entries.
   */
  stage?: string;
}

/**
 * Persistent-error event recorded when the wl CLI fails
 * `DOWNTIME_ERROR_STRIKE_LIMIT` times consecutively. Written to the rolling
 * `.worklog` log so the failure is auditable even though no dispatch occurs.
 */
export interface DowntimeErrorEvent {
  /** Worklog root (the rolling log lives at `<cwd>/.worklog`). */
  cwd: string;
  /** ISO-8601 UTC timestamp of the error. */
  at: string;
  message: string;
}

export interface DowntimeDispatchOutcome {
  dispatched: boolean;
  candidate?: DowntimeCandidate;
  kind?: DowntimeSkillKind;
  /**
   * Non-dispatch reasons: 'dispatch-in-flight' | 'no-candidate' |
   * 'wl-error' | 'code-freeze' | 'claim-failed' (lost the CAS race —
   * another pane won; neutral) | 'marker-write-failed' (fail-closed abort
   * BEFORE spawn) | 'spawn-failed' (handled spawn error; outcome is not
   * success).
   */
  reason?: string;
}

/**
 * Per-process single-flight guard: at most one dispatch can be in flight at
 * a time (concurrent calls are refused, not queued). Cross-pane
 * serialization is handled by the pre-dispatch claim (Q5 — no lock file):
 * the CAS claim atomically moves the item out of `wl next`'s selection set
 * for other panes.
 */
let dispatchInFlight = false;

/**
 * Expected claim state per tier (RCA WL-0MSRBFFLN005W3VT design point 1):
 * the pre-dispatch claim only applies while the item is still in the exact
 * state the tier selected it in. The audit tier selects `completed` /
 * `in_review` items; every other tier selects `open` items at their stage.
 */
const TIER_EXPECTED: Record<DowntimeSkillKind, DowntimeClaimExpected> = {
  audit: { status: 'completed', stage: 'in_review' },
  implement: { status: 'open', stage: 'plan_complete' },
  plan: { status: 'open', stage: 'intake_complete' },
  intake: { status: 'open', stage: 'idea' },
};

/**
 * Dispatch one already-selected candidate through the fixed pipeline:
 * CAS claim → marker write (before spawn) → spawn.
 *
 *  - Claim (compare-and-swap): exactly one concurrent pane wins; a loser
 *    (or a wl claim failure) ABORTS the dispatch — no pane, no marker, no
 *    success record. A lost race resolves reason 'claim-failed' (neutral,
 *    the winner's pane will busy the proxy); a wl claim failure resolves
 *    'wl-error' (counts toward the three-strike rule). Neither is ever
 *    silently discarded (WL-0MSLWJ310000ND0X absorbed).
 *  - Marker write BEFORE the pane spawns: if the marker cannot be written
 *    the dispatch aborts BEFORE spawning (fail-closed — an unmarked item is
 *    never dispatched). The item stays claimed (in_progress), so no other
 *    pane can select it (RCA design point 2).
 *  - Spawn: a handled spawn `error` resolves reason 'spawn-failed' — the
 *    outcome is NOT success (WL-0MSLWJ3I70031Z8U absorbed); the marker
 *    stands so the item is not re-dispatched.
 */
async function dispatchClaimedTier(
  deps: DowntimeWorkerDeps,
  kind: DowntimeSkillKind,
  candidate: DowntimeCandidate,
  opts: { model: string; cwd: string },
): Promise<DowntimeDispatchOutcome> {
  const expected = TIER_EXPECTED[kind];
  const claim = await deps.claimItem(candidate.id, expected);
  if (!claim.ok) {
    return claim.reason === 'stale'
      ? { dispatched: false, reason: 'claim-failed' }
      : { dispatched: false, reason: 'wl-error' };
  }

  let marked = false;
  try {
    marked = await deps.recordDispatch({
      itemId: candidate.id,
      kind,
      dispatchedAt: new Date().toISOString(),
      cwd: opts.cwd,
      title: candidate.title,
      // The worklog stage at dispatch powers the plan/intake change-guard
      // (exclude while the item is still at this stage; release on advancement).
      stage: expected.stage,
    });
  } catch {
    // Fail-closed: a throwing recordDispatch (stub or regression) is a marker
    // write failure — abort before spawn.
    marked = false;
  }
  if (!marked) {
    return { dispatched: false, reason: 'marker-write-failed' };
  }

  const spawned = await deps.spawnAgentPane(buildDowntimePrompt(kind, candidate), opts);
  if (!spawned) {
    return { dispatched: false, reason: 'spawn-failed' };
  }

  return { dispatched: true, candidate, kind };
}

/**
 * dispatch one downtime work item. Selection priority (audit tier first,
 * WL-0MSI8H3HP000K0RG): a completed/in_review item WITHOUT a valid audit AND
 * NOT already dispatched for audit by this worker →
 * `/skill:audit <id>` (the dispatched-marker exclusion,
 * WL-0MSLIY8ZR004QUSY, is applied by `deps.getNextAuditCandidate`); then the
 * implement tier (WL-0MSMAYPQP001FLR6): the highest-priority open
 * plan_complete item with risk Low / effort Small|XS → `/skill:implement <id>`
 * (fail-closed null on wl error or no candidate — never short-circuits the
 * fallback, AC5/AC6); if none, `wl next --stage intake_complete` →
 * `/skill:plan <id>`; if none, `wl next --stage idea` → `/skill:intake <id>`;
 * if all four are empty, no dispatch.
 *
 * Code-freeze gate (WL-0MSQ0RPQP00636JY): the marker is re-read fresh on
 * EVERY dispatch (never cached). While the marker is frozen OR ambiguous
 * (fail-closed), the audit and implement tiers are skipped — no new
 * implementation work (or audits) starts during a release freeze — and
 * dispatch continues with the plan/intake tiers, which are low-risk prep
 * and still allowed. A freeze skip with an empty plan/intake backlog is
 * reported as reason 'code-freeze' (NEVER 'no-candidate'), so it never
 * triggers the worker's no-candidate cooldown: polling continues and
 * implement/audit dispatch resumes immediately when the freeze lifts.
 *
 * A CLI error at the intake_complete tier does NOT short-circuit: the idea
 * tier is still attempted, so a tier-3 candidate can still dispatch. A
 * `wl-error` outcome (any CLI failure) is never a candidate and never a
 * `no-candidate`; the caller's three-strike rule decides when consecutive
 * errors pause the worker. Every tier runs its candidate through
 * `dispatchClaimedTier` (CAS claim → marker → spawn), so the item is
 * claimed BEFORE the pane spawns and a losing pane aborts with no pane, no
 * marker, no success record (the same-instant race, RC-1, is closed). The
 * caller must only invoke this once the idle tracker reports the threshold
 * met (AC1); a dispatch consumes the local slot, so the proxy reports busy
 * and the tracker requires a fresh full idle period before the next dispatch.
 */
export async function dispatchDowntimeWork(
  deps: DowntimeWorkerDeps,
  opts: { model: string; cwd: string },
): Promise<DowntimeDispatchOutcome> {
  if (dispatchInFlight) {
    return { dispatched: false, reason: 'dispatch-in-flight' };
  }
  dispatchInFlight = true;
  try {
    // Code-freeze gate (WL-0MSQ0RPQP00636JY): re-read the marker fresh on
    // every dispatch — never cached, so a freeze that starts or ends
    // mid-idle-period is honored on the next dispatch attempt. Frozen OR
    // ambiguous (fail-closed) → the audit and implement tiers are skipped
    // and dispatch falls through to the plan/intake tiers below.
    const freezeStatus = deps.readCodeFreezeStatus(opts.cwd);
    const frozen = freezeStatus === 'frozen' || freezeStatus === 'ambiguous';

    if (!frozen) {
      const auditCandidate = await deps.getNextAuditCandidate(opts.cwd);
      if (auditCandidate !== null) {
        return await dispatchClaimedTier(deps, 'audit', auditCandidate, opts);
      }
      // Implement tier (WL-0MSMAYPQP001FLR6): after the audit gate, dispatch
      // /skill:implement for the highest-priority open plan_complete item with
      // risk Low / effort Small|XS. getNextImplementCandidate is fail-closed
      // (null on wl failure or no candidate), so a null here means the tier is
      // exhausted and the plan/intake tiers below still run (AC5/AC6 — a wl
      // error at the implement tier does NOT short-circuit the fallback).
      const implementCandidate = await deps.getNextImplementCandidate(opts.cwd);
      if (implementCandidate !== null) {
        return await dispatchClaimedTier(deps, 'implement', implementCandidate, opts);
      }
    }
    // Tier 2 (intake_complete → /skill:plan). A CLI error here does NOT
    // short-circuit: tier 3 is still attempted so a tier-3 candidate can
    // still dispatch (operator refinement).
    let tier2Error = false;
    const intakeComplete = await deps.getNextItem('intake_complete', opts.cwd);
    if (intakeComplete.ok) {
      if (intakeComplete.candidate !== null) {
        return await dispatchClaimedTier(deps, 'plan', intakeComplete.candidate, opts);
      }
    } else {
      tier2Error = true;
    }

    // Tier 3 (idea → /skill:intake) is ALWAYS attempted when tier 2 produced
    // no candidate — including when tier 2 errored.
    const idea = await deps.getNextItem('idea', opts.cwd);
    if (idea.ok) {
      if (idea.candidate !== null) {
        return await dispatchClaimedTier(deps, 'intake', idea.candidate, opts);
      }
      if (tier2Error) {
        // Tier 2 errored and tier 3 answered empty: the backlog is NOT
        // provably empty (the intake_complete state is unknown) → fail
        // closed to busy (a strike), never a no-candidate — partial
        // information must not pause the worker.
        return { dispatched: false, reason: 'wl-error' };
      }
      // Both tiers answered with no candidate → genuine empty backlog. The
      // freeze gate must NOT pause the worker on an empty plan/intake
      // backlog: during a freeze that is a freeze skip (reason
      // 'code-freeze'), never the no-candidate cooldown — polling continues
      // so implement/audit dispatch resumes immediately when the freeze
      // lifts (WL-0MSQ0RPQP00636JY).
      return frozen
        ? { dispatched: false, reason: 'code-freeze' }
        : { dispatched: false, reason: 'no-candidate' };
    }
    // Tier 3 errored (with or without a tier-2 error): fail closed to busy.
    // The worker counts this as one CLI-error strike; the backlog is not
    // provably empty so this is never `no-candidate` (the three-strike rule
    // governs when consecutive errors pause the worker).
    return { dispatched: false, reason: 'wl-error' };
  } finally {
    dispatchInFlight = false;
  }
}

/**
 * Argument vector for spawning `send-to-pi.sh`: visible pane named
 * `Downtime <kind>`, `--no-focus` (visible but never steals focus),
 * `--cwd <wlRoot>`, `--model <downtimeModel>`, then the prompt.
 */
export function buildDowntimePaneArgs(
  kind: DowntimeSkillKind,
  prompt: string,
  opts: { model: string; cwd: string },
): string[] {
  return [
    '--pane-name',
    `Downtime ${kind}`,
    '--no-focus',
    '--cwd',
    opts.cwd,
    '--model',
    opts.model,
    prompt,
  ];
}

/**
 * Minimal spawn handle: the caller unrefs so the parent can exit first, and
 * registers an `error` listener so a spawn failure is observable instead of
 * crashing the plugin process (WL-0MSLWJ3I70031Z8U absorbed).
 */
export interface DowntimeSpawnHandle {
  unref(): void;
  once(event: 'error', listener: (err: Error) => void): void;
}

/** Injectable spawn boundary (matches the repo's injectable-seam pattern). */
export type DowntimeSpawn = (
  scriptPath: string,
  args: string[],
  opts: { cwd: string },
) => DowntimeSpawnHandle;

/**
 * Spawn options for `send-to-pi.sh`: detached, stdio ignored, resolved cwd
 * forwarded so the pane opens in the right project root.
 */
export function buildDowntimeSpawnOptions(cwd: string): {
  detached: boolean;
  stdio: 'ignore';
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: { ...process.env, HERDR_RESOLVED_CWD: cwd },
  };
}

/** Default spawn: detached, stdio ignored, resolved cwd forwarded. */
export const defaultDowntimeSpawn: DowntimeSpawn = (scriptPath, args, opts) =>
  spawn(scriptPath, args, buildDowntimeSpawnOptions(opts.cwd));

/**
 * How long to wait for a spawn-level `error` event before assuming the pane
 * started (an ENOENT/EACCES error fires on the next event-loop tick). The
 * probe keeps the failure observable without delaying the poll loop.
 */
export const DOWNTIME_SPAWN_PROBE_MS = 500;

/**
 * Spawn `send-to-pi.sh` detached with stdio ignored, then unref so the
 * parent (plugin) process can exit independently — same pattern as the
 * TUI's existing agent dispatches. An `error` listener is ALWAYS attached
 * (a spawn failure must not crash the plugin with an unhandled 'error'
 * event, WL-0MSLWJ3I70031Z8U); a spawn error resolves `false` so the
 * dispatch outcome is not a false success.
 */
export async function spawnDowntimePane(
  scriptPath: string,
  args: string[],
  opts: { cwd: string },
  spawnFn: DowntimeSpawn = defaultDowntimeSpawn,
): Promise<boolean> {
  const child = spawnFn(scriptPath, args, opts);
  child.unref();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), DOWNTIME_SPAWN_PROBE_MS);
    child.once('error', (err: Error) => {
      clearTimeout(timer);
      process.stderr.write(
        `[worklog-plugin] Downtime pane spawn failed: ${err.message}\n`,
      );
      resolve(false);
    });
  });
}

// ── Worker orchestrator (implemented — F3) ────────────────────────────

/** Per-tick configuration; re-read every tick so settings apply live. */
export interface DowntimeWorkerConfig {
  poller: DowntimePoller;
  deps: DowntimeWorkerDeps;
  /** Re-read each tick so settings changes apply without a restart. */
  config(): {
    enabled: boolean;
    thresholdMs: number;
    requiredFreeSlots: number;
    model: string;
    cwd: string;
    /** Pause duration after a genuine empty backlog (no-candidate), ms. */
    noCandidateCooldownMs: number;
  };
}

export interface DowntimeWorkerTickResult {
  polled: boolean;
  dispatched: boolean;
  idle: boolean;
}

export interface DowntimeWorker {
  /** One poll + evaluation + possible dispatch. Call from the scheduler task. */
  tick(): Promise<DowntimeWorkerTickResult>;
  /** Idle-since timestamp of the current idle run (null when busy). */
  readonly idleSince: number | null;
  /** True while a dispatch is in flight. */
  readonly dispatching: boolean;
  /** Timestamp of the last successful dispatch (null until the first). */
  readonly lastDispatchAt: number | null;
  /** Whether the worker is enabled per the current settings (re-read). */
  readonly enabled: boolean;
  /**
   * True while the worker is paused in the no-candidate cooldown: no proxy
   * polling, no idle tracking, and no dispatch until the pause expires
   * (WL-0MSI7DQL10016QYX).
   */
  readonly paused: boolean;
  /**
   * Count of consecutive CLI-error dispatch outcomes (three-strike rule).
   * Reset to 0 on a successful dispatch, a genuine no-candidate outcome, or
   * when a cooldown expires.
   */
  readonly errorStrikes: number;
}

/**
 * Compose poller + idle evaluation + tracker + dispatch into the per-tick
 * worker the scheduler loop (F4) registers as a due-work task.
 */
export function createDowntimeWorker(opts: DowntimeWorkerConfig): DowntimeWorker {
  const tracker = createIdleTracker();
  let dispatching = false;
  let lastDispatchAt: number | null = null;
  // No-candidate cooldown (WL-0MSI7DQL10016QYX): timestamp until which the
  // worker is fully paused (no poll, no idle tracking, no dispatch) after a
  // genuine empty backlog OR three consecutive CLI errors. null = not paused.
  let cooldownUntil: number | null = null;
  // Three-strike rule: consecutive CLI-error dispatch outcomes. A successful
  // dispatch, a genuine no-candidate outcome, or an expired cooldown resets it.
  let errorStrikes = 0;

  return {
    get idleSince(): number | null {
      return tracker.idleSince;
    },
    get dispatching(): boolean {
      return dispatching;
    },
    get lastDispatchAt(): number | null {
      return lastDispatchAt;
    },
    get enabled(): boolean {
      return opts.config().enabled;
    },
    get paused(): boolean {
      return cooldownUntil !== null && Date.now() < cooldownUntil;
    },
    get errorStrikes(): number {
      return errorStrikes;
    },
    async tick(): Promise<DowntimeWorkerTickResult> {
      const cfg = opts.config();
      if (!cfg.enabled) return { polled: false, dispatched: false, idle: false };
      // Cooldown gate: while paused the worker performs NO proxy polling, NO
      // idle tracking, and NO dispatch. The pause is a full stop (user
      // confirmed "pause completely"); once it expires the idle tracker is
      // empty, so a fresh full idle period is required before the next
      // dispatch (no stale idle credit from before the pause).
      if (cooldownUntil !== null) {
        if (Date.now() < cooldownUntil) {
          return { polled: false, dispatched: false, idle: false };
        }
        cooldownUntil = null; // pause expired — resume normal polling
        errorStrikes = 0; // fresh strike counter after the pause
      }
      if (opts.poller.isPolling()) return { polled: false, dispatched: false, idle: tracker.idleSince !== null };

      const status = await opts.poller.poll();
      if (status === null) {
        tracker.record(false); // endpoint failure/ambiguity → busy
        return { polled: true, dispatched: false, idle: false };
      }

      const idle = evaluateIdle(status, cfg.requiredFreeSlots);
      tracker.record(idle);
      if (!idle) return { polled: true, dispatched: false, idle: false };
      if (!tracker.isThresholdMet(cfg.thresholdMs)) {
        return { polled: true, dispatched: false, idle: true };
      }
      if (dispatching) return { polled: true, dispatched: false, idle: true };

      dispatching = true;
      try {
        const outcome = await dispatchDowntimeWork(opts.deps, {
          model: cfg.model,
          cwd: cfg.cwd,
        });
        if (outcome.dispatched) {
          lastDispatchAt = Date.now();
          errorStrikes = 0; // a successful dispatch proves the CLI is healthy
          // Belt-and-suspenders: even if the proxy does not immediately
          // report busy, require a fresh full idle period before the next
          // dispatch (AC5).
          tracker.record(false);
        } else if (outcome.reason === 'no-candidate') {
          // Genuine empty backlog (both stages answered with no candidate):
          // pause entirely so the worker stops burning cycles (proxy polling
          // + wl next spawns) for the configured cooldown. Reset the idle
          // tracker so a fresh full idle period is required after the pause.
          errorStrikes = 0; // the CLI answered — it is healthy
          cooldownUntil = Date.now() + cfg.noCandidateCooldownMs;
          tracker.record(false);
        } else if (outcome.reason === 'wl-error') {
          // Three-strike rule on CLI errors: a dispatch attempt ending in a
          // wl failure is one strike. Three consecutive strikes pause the
          // worker entirely (no dispatch) AFTER logging the persistent error
          // so the failure is auditable. A single transient error does NOT
          // pause — it retries on the next idle period.
          errorStrikes += 1;
          if (errorStrikes >= DOWNTIME_ERROR_STRIKE_LIMIT) {
            try {
              await opts.deps.recordError({
                cwd: cfg.cwd,
                at: new Date().toISOString(),
                message:
                  `Downtime worker: ${DOWNTIME_ERROR_STRIKE_LIMIT} consecutive ` +
                  `wl CLI errors — pausing dispatch for ${cfg.noCandidateCooldownMs}ms.`,
              });
            } catch {
              // fail-closed: error logging must never crash the worker
            }
            cooldownUntil = Date.now() + cfg.noCandidateCooldownMs;
            errorStrikes = 0;
            tracker.record(false);
          }
        }
        // Any other non-dispatch outcome (dispatch-in-flight, code-freeze
        // skip) is neutral: no strike, no cooldown — the next idle period
        // retries (a freeze skip keeps polling so implement/audit dispatch
        // resumes immediately when the freeze lifts, WL-0MSQ0RPQP00636JY).
        return { polled: true, dispatched: outcome.dispatched, idle: true };
      } finally {
        dispatching = false;
      }
    },
  };
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
  const skill =
    kind === 'plan' ? '/skill:plan'
    : kind === 'audit' ? '/skill:audit'
    : kind === 'implement' ? '/skill:implement'
    : '/skill:intake';
  return [
    `Run ${skill} ${candidate.id} — ${candidate.title}.`,
    BLOCKED_QUESTIONS_INSTRUCTION,
  ].join('\n');
}

/**
 * Build the audit comment added to the item on a successful downtime
 * dispatch: author-visible statement of the automatic dispatch, the skill
 * run, the item, and the UTC timestamp. Newlines in the title are
 * collapsed so the comment stays a single clean line.
 */
export function buildDowntimeDispatchComment(
  itemId: string,
  kind: DowntimeSkillKind,
  dispatchedAt: string,
  title?: string,
): string {
  const skill =
    kind === 'plan' ? '/skill:plan'
    : kind === 'audit' ? '/skill:audit'
    : kind === 'implement' ? '/skill:implement'
    : '/skill:intake';
  const suffix = title ? ` (${title.replace(/[\r\n]+/g, ' ')})` : '';
  return `Auto-dispatched by the herdr downtime worker at ${dispatchedAt} — running ${skill} ${itemId}${suffix}.`;
}

// ── Wiring helpers (implemented — F4) ─────────────────────────────────

/**
 * Parse the stdout of `wl next --stage <stage> -n N --json` into typed
 * plan/intake candidates. Accepts both the batch shape the CLI emits for
 * `-n N` (`{ workItems: [{ workItem: {...} }] }`) and the legacy single-item
 * shape (`{ workItem: {...} }`) for backward compatibility. Each candidate
 * carries the query `stage`, the worklog `status` (for the client-side
 * `open` guard) and `sortIndex` (wl next priority order). Malformed JSON or
 * output without any parseable entry yields null (fail-closed); an empty
 * result list yields `[]` (a genuine empty backlog).
 */
export function parseNextCandidatesOutput(
  stdout: string,
  stage: DowntimeStage,
): DowntimeCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  let rawItems: unknown[] | null = null;
  if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.workItems)) {
      rawItems = o.workItems;
    } else if (typeof o.workItem === 'object' && o.workItem !== null) {
      rawItems = [o]; // legacy single-item shape with a candidate
    } else if ('workItem' in o) {
      rawItems = []; // legacy single-item shape answered no item → empty backlog
    }
  }
  if (rawItems === null) return null;

  const candidates: DowntimeCandidate[] = [];
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue;
    const nested =
      (entry as { workItem?: unknown }).workItem !== undefined
        ? (entry as { workItem: Record<string, unknown> }).workItem
        : (entry as Record<string, unknown>);
    if (typeof nested !== 'object' || nested === null) continue;
    if (typeof nested.id !== 'string' || nested.id.length === 0) continue;
    candidates.push({
      id: nested.id,
      title: typeof nested.title === 'string' ? nested.title : '',
      stage,
      status: typeof nested.status === 'string' ? nested.status : undefined,
      sortIndex:
        typeof nested.sortIndex === 'number' && Number.isFinite(nested.sortIndex)
          ? nested.sortIndex
          : undefined,
    });
  }
  return candidates;
}

/**
 * Parse the stdout of `wl next --stage <stage> --json` into the first
 * candidate. Returns null (no dispatch) for empty output, a null
 * `workItem`, missing ids, or malformed JSON.
 *
 * Superseded by `parseNextCandidatesOutput` for production selection (the
 * downtime worker fetches a batch so marker-excluded candidates do not
 * starve selection); kept exported for callers/tests that use the
 * single-item shape.
 */
export function parseNextItemOutput(stdout: string, stage: DowntimeStage): DowntimeCandidate | null {
  try {
    const parsed = JSON.parse(stdout) as {
      workItem?: { id?: unknown; title?: unknown } | null;
    };
    const raw = parsed?.workItem;
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
    return {
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : '',
      stage,
    };
  } catch {
    return null;
  }
}

/**
 * Derive the dispatch kind from a prompt built by `buildDowntimePrompt`
 * (the pane name is `Downtime plan` / `Downtime intake` / `Downtime audit` /
 * `Downtime implement`).
 */
export function skillKindFromPrompt(prompt: string): DowntimeSkillKind {
  if (prompt.includes('/skill:audit ')) return 'audit';
  if (prompt.includes('/skill:implement ')) return 'implement';
  return prompt.includes('/skill:plan ') ? 'plan' : 'intake';
}

// ── Audit-tier selection (WL-0MSI8H3HP000K0RG) ────────────────────────

/**
 * Parse the stdout of `wl list --status completed --stage in_review --json`
 * into typed audit candidates. Accepts both the bare array shape and the
 * `{ workItems: [...] }` wrapper. Malformed/empty output yields null
 * (fail-closed).
 */
export function parseAuditCandidatesOutput(stdout: string): AuditCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const candidates: AuditCandidate[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    candidates.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      auditedAt: typeof o.auditedAt === 'string' ? o.auditedAt : undefined,
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined,
      sortIndex: typeof o.sortIndex === 'number' && Number.isFinite(o.sortIndex) ? o.sortIndex : undefined,
    });
  }
  return candidates;
}

/**
 * Select the next audit candidate from parsed in_review items: the first
 * item WITHOUT a valid audit, sorted ascending by `sortIndex` (heartbeat
 * convention). "Valid audit" reuses `isAuditFresh` from icons.ts (fresh = a
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
): AuditCandidate | null {
  const recencyCutoff = now - DOWNTIME_AUDIT_RECENCY_WINDOW_MS;
  const target = candidates
    .filter((c) => !isAuditFresh(c.auditedAt, c.updatedAt))
    .filter((c) => !(dispatchedItemIds?.has(c.id) ?? false))
    .filter((c) => {
      if (!c.updatedAt) return true; // missing → include
      const updated = new Date(c.updatedAt).getTime();
      if (Number.isNaN(updated)) return false; // unparseable → fail-closed exclude
      return updated >= recencyCutoff;
    })
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return target[0] ?? null;
}

/**
 * Turn a parsed audit candidate into a dispatachable `DowntimeCandidate`
 * (stage `audit`) for the audit tier.
 */
export function toDowntimeCandidate(candidate: AuditCandidate): DowntimeCandidate {
  return { id: candidate.id, title: candidate.title, stage: 'audit' };
}

// ── Implement-tier selection (WL-0MSMAYPQP001FLR6) ───────────────────

/**
 * Ordinal rank of a risk level on the canonical scale
 * (Low < Medium < High < Severe/Critical), mirroring the wl next DB filter
 * semantics (packages/shared riskOrdinal) for the belt-and-suspenders
 * client-side guard. Unset/unknown values map to null (fail-closed).
 */
function riskOrdinal(risk: string | undefined | null): number | null {
  switch ((risk ?? '').trim().toLowerCase()) {
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
function effortOrdinal(effort: string | undefined | null): number | null {
  switch ((effort ?? '').trim().toLowerCase().replace(/[\s-]+/g, '')) {
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
    default: return null;
  }
}

/**
 * Parse the stdout of `wl next --stage plan_complete --risk low --effort
 * small -n N --json` into typed implement candidates. Accepts the
 * `{ workItems: [{ workItem: {...} }] }` shape the CLI emits for a batch
 * (`-n N`); entries without an id are skipped. Malformed JSON or output
 * without a workItems list yields null (fail-closed); an empty list yields
 * `[]` (a genuine empty backlog).
 */
export function parseImplementCandidatesOutput(stdout: string): ImplementCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const items =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { workItems?: unknown }).workItems)
      ? (parsed as { workItems: unknown[] }).workItems
      : null;
  if (items === null) return null;

  const candidates: ImplementCandidate[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { workItem?: Record<string, unknown> };
    const o = entry.workItem;
    if (typeof o !== 'object' || o === null) continue;
    if (typeof o.id !== 'string' || o.id.length === 0) continue;
    candidates.push({
      id: o.id,
      title: typeof o.title === 'string' ? o.title : '',
      status: typeof o.status === 'string' ? o.status : '',
      risk: typeof o.risk === 'string' ? o.risk : undefined,
      effort: typeof o.effort === 'string' ? o.effort : undefined,
      sortIndex: typeof o.sortIndex === 'number' && Number.isFinite(o.sortIndex) ? o.sortIndex : undefined,
    });
  }
  return candidates;
}

/**
 * Select the next implement candidate from parsed wl next output: the
 * first candidate that is open (`status === 'open'`, AC2), carries risk
 * exactly Low and effort Small/Extra Small (AC1 threshold boundaries,
 * fail-closed on unset/unknown), is not in the dispatched-marker set
 * (kind `implement`, AC6), sorted ascending by `sortIndex` (wl next
 * priority order preserved). Returns null when no candidate qualifies
 * (or the list is empty).
 *
 * Belt-and-suspenders client-side guard (AC1): even though `wl next
 * --risk low --effort small` filters server-side, the herdr tier verifies
 * the thresholds again so a malformed/absent server filter can never
 * dispatch a Medium+/Large+ item.
 */
export function selectImplementCandidate(
  candidates: ImplementCandidate[],
  dispatchedItemIds?: ReadonlySet<string>,
): ImplementCandidate | null {
  const target = candidates
    .filter((c) => c.status === 'open')
    .filter((c) => {
      const risk = riskOrdinal(c.risk);
      if (risk === null || risk !== 1) return false; // only risk exactly Low
      const effort = effortOrdinal(c.effort);
      if (effort === null || effort > 2) return false; // Small (2) + Extra Small (1)
      return true;
    })
    .filter((c) => !(dispatchedItemIds?.has(c.id) ?? false))
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return target[0] ?? null;
}

/**
 * Turn a parsed implement candidate into a dispatachable `DowntimeCandidate`
 * (stage `implement`) for the implement tier.
 */
export function toImplementCandidate(candidate: ImplementCandidate): DowntimeCandidate {
  return { id: candidate.id, title: candidate.title, stage: 'implement' };
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
): DowntimeCandidate | null {
  const target = candidates
    .filter((c) => c.status === 'open')
    .filter((c) => {
      const dispatchedAt = dispatchedStages?.get(c.id);
      // Exclude while still at the dispatched-at stage; a missing recorded
      // stage (legacy entry) never suppresses selection.
      return dispatchedAt === undefined || dispatchedAt !== c.stage;
    })
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  return target[0] ?? null;
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

/**
 * Clamp the no-candidate cooldown: reject negative/non-finite (fall back to
 * the 60-minute default) and floor at 60s so the pause cannot be disabled or
 * set trivially small (WL-0MSI7DQL10016QYX).
 */
export function clampDowntimeNoCandidateCooldownMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DOWNTIME_NO_CANDIDATE_COOLDOWN_MS;
  return Math.max(Math.round(value), DOWNTIME_NO_CANDIDATE_COOLDOWN_FLOOR_MS);
}
