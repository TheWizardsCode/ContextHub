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
 *  - `dispatchDowntimeWork` — dispatch orchestration: `wl next --stage
 *    intake_complete` → `/skill:plan <id>`, fallback `--stage idea` →
 *    `/skill:intake <id>`, pre-dispatch claim, per-process single-flight.
 *  - `buildDowntimePaneArgs` / `spawnDowntimePane` — send-to-pi.sh
 *    invocation (`--pane-name Downtime <kind>`, `--no-focus`, `--cwd`,
 *    `--model`), detached and unref'd.
 *  - `createDowntimeWorker` — per-tick orchestrator (poll → evaluate →
 *    track → dispatch) with settings re-read each tick.
 *  - `buildDowntimePrompt` / `BLOCKED_QUESTIONS_INSTRUCTION` — dispatched
 *    agent prompt, including the blocked-questions instruction.
 *  - `clampDowntimePollInterval` / `clampDowntimeIdleThresholdMs` /
 *    `clampDowntimeRequiredFreeSlots` — settings clamps, wired into
 *    `settings.ts`.
 *
 * Fail-closed behaviour (never dispatch, never throw) is the SAFE default
 * at every boundary.
 */

import { spawn } from 'node:child_process';

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
  /** Claims the item (`wl update <id> --status in_progress`) before dispatch. */
  claimItem(itemId: string): Promise<void>;
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
 * Per-process single-flight guard: at most one dispatch can be in flight at
 * a time (concurrent calls are refused, not queued). Cross-pane
 * serialization is handled by the pre-dispatch claim (Q5 — no lock file):
 * the claimed item leaves `wl next`'s selection set for other panes.
 */
let dispatchInFlight = false;

/**
 * Dispatch one downtime work item. Selection: `wl next --stage
 * intake_complete` → `/skill:plan <id>`; if none, `wl next --stage idea` →
 * `/skill:intake <id>`; if both are empty, no dispatch. The item is claimed
 * BEFORE the pane spawns so it appears in_progress immediately and a second
 * pane cannot select it. The caller must only invoke this once the idle
 * tracker reports the threshold met (AC1); a dispatch consumes the local
 * slot, so the proxy reports busy and the tracker requires a fresh full
 * idle period before the next dispatch.
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
    const intakeComplete = await deps.getNextItem('intake_complete');
    if (intakeComplete !== null) {
      await deps.claimItem(intakeComplete.id);
      await deps.spawnAgentPane(buildDowntimePrompt('plan', intakeComplete), opts);
      return { dispatched: true, candidate: intakeComplete, kind: 'plan' };
    }
    const idea = await deps.getNextItem('idea');
    if (idea !== null) {
      await deps.claimItem(idea.id);
      await deps.spawnAgentPane(buildDowntimePrompt('intake', idea), opts);
      return { dispatched: true, candidate: idea, kind: 'intake' };
    }
    return { dispatched: false, reason: 'no-candidate' };
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

/** Minimal spawn handle: the caller unrefs so the parent can exit first. */
export interface DowntimeSpawnHandle {
  unref(): void;
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
 * Spawn `send-to-pi.sh` detached with stdio ignored, then unref so the
 * parent (plugin) process can exit independently — same pattern as the
 * TUI's existing agent dispatches.
 */
export function spawnDowntimePane(
  scriptPath: string,
  args: string[],
  opts: { cwd: string },
  spawnFn: DowntimeSpawn = defaultDowntimeSpawn,
): void {
  const child = spawnFn(scriptPath, args, opts);
  child.unref();
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
}

/**
 * Compose poller + idle evaluation + tracker + dispatch into the per-tick
 * worker the scheduler loop (F4) registers as a due-work task.
 */
export function createDowntimeWorker(opts: DowntimeWorkerConfig): DowntimeWorker {
  const tracker = createIdleTracker();
  let dispatching = false;
  let lastDispatchAt: number | null = null;

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
    async tick(): Promise<DowntimeWorkerTickResult> {
      const cfg = opts.config();
      if (!cfg.enabled) return { polled: false, dispatched: false, idle: false };
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
          // Belt-and-suspenders: even if the proxy does not immediately
          // report busy, require a fresh full idle period before the next
          // dispatch (AC5).
          tracker.record(false);
        }
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
