/**
 * packages/herdr/src/mode-switch-worker.ts — Activity-gated proxy mode switching
 *
 * A worker that tracks operator activity and switches the llama-proxy between
 * **fast** (cloud-backed, 3-slot pool) and **cheap** (2-slot local-first
 * pool) operating modes:
 *
 *  - **Fast switch on command:** when an agent-route command is routed through
 *    the plugin (WL-0MSN3FWV5008KQE9), the worker records the operator
 *    timestamp and fire-and-forget POSTs `/admin/set-mode {"mode":"fast"}`.
 *    A failed switch never blocks or delays the command dispatch (fail-open:
 *    the pane opens regardless). The fast switch fires on the instance that
 *    received the command, whichever pane that is — see the leader note below.
 *  - **Leader-only cheap switching (WL-0MU6MXCZZ007ZXT9, AC1):** only the
 *    downtime leader (`DowntimeWorker.isLeader`, reused — no separate
 *    election) runs the idle cheap-switch logic. Non-leader instances skip
 *    `tick()` entirely, so idle panes can no longer flip the shared proxy to
 *    cheap behind an active pane's back (the flip-flop fix). The leader probe
 *    is read live each tick, so a leadership handover is honoured on the next
 *    tick (AC5).
 *  - **Shared activity broadcast (AC2):** every instance writes its latest
 *    operator-command timestamp to `mode-activity.json` in the coordination
 *    directory (`getMachineCoordinationDir()`, the same dir as the downtime
 *    leader lease) and the leader reads it each tick. The idle clock is the
 *    max of the local clock and the shared timestamp, so the proxy stays fast
 *    while **any** pane has recent activity. A read/write failure falls back
 *    to the local clock (AC6, fail-closed: never a premature cheap switch).
 *  - **Cheap switch on idle:** on each tick (scheduler task, or the downtime
 *    dispatcher's `onProxyIdle` callback — the leader is the only pane that
 *    runs that dispatcher), when the operator has been idle
 *    (no agent-route commands on any pane) for ≥ `modeSwitchIdleThresholdMs`
 *    **AND** the proxy reports idle (reusing `evaluateIdle` from
 *    downtime-worker.ts), the worker POSTs `/admin/set-mode {"mode":"cheap"}`.
 *    **Per-slot operator gate (parent WL-0MT9F67Y3008S0PR, decision 1.a):**
 *    when the proxy serves per-slot identity (`slots[]` valid per
 *    `parseLlamaStatus`), the idle gate requires only ≥ 1 free slot
 *    (`evaluateIdle(status, DOWNTIME_PANE_MIN_FREE_SLOTS)`) — the spare-capacity
 *    semantics shared with the downtime dispatcher, whose autonomous
 *    query/lease work holds the OTHER busy slots. A downtime pane is exactly
 *    the work the operator wants to keep running while the proxy runs cheap,
 *    so the busy slots must **not** delay the switch (Q4b decision;
 *    accepted tradeoff: a fast-mode downtime request in flight during the
 *    mode restart is killed and retried by its client). Without per-slot
 *    data the all-slots-free fail-closed fallback is unchanged
 *    (`evaluateIdle(status, 0)` — full global checks). In every case a busy
 *    proxy (server down, model switch, or 0 free slots) **delays** the
 *    switch — it never kills in-flight work.
 *  - **No redundant switching / no hammering:** the worker skips a switch when
 *    the persisted mode already matches the target (tracking last-known mode,
 *    refreshed via `GET /admin/mode` on each poll). At most one switch per
 *    state change; a `409` (mode-switch restart in progress) is treated as a
 *    no-op and retried on a later tick.
 *  - **Fail-closed everywhere:** endpoint failures, timeouts, network errors,
 *    and ambiguous responses yield no switch and never crash or block the
 *    plugin. On plugin restart the idle clock resets to "active now"
 *    (fail-safe: the proxy stays fast until a fresh full idle window passes).
 *  - **Coexistence with the proxy's built-in schedule:** the plugin's
 *    switches are manual overrides (the API's native semantics,
 *    LP-0MSMF25V9002AY1J); the proxy's time-based schedule (cheap
 *    01:00–10:00, fast 10:00–01:00) reclaims control at its next boundary.
 *    Documented behavior, not a conflict.
 *
 * The proxy URL is shared with the downtime worker (`downtimeProxyUrl` — no
 * separate URL key), and the existing `/llama/local/status` idle evaluation
 * from downtime-worker.ts is reused.
 *
 * **Idle-trigger sources (WL-0MU4MKVR4005WPBJ):** the cheap check runs from
 * two triggers — (1) the independent `mode-switch` scheduler task on
 * `modeSwitchPollIntervalMs`, and (2) the downtime dispatcher's
 * `onProxyIdle` callback, fired with the fresh proxy status whenever the
 * dispatcher's own poll observes the proxy idle (before it dispatches the
 * next item). Trigger (2) removes the up-to-one-poll-interval delay so a
 * downtime item is served by the cheap pool; trigger (1) remains the
 * fallback when the downtime worker is not polling (disabled, non-leader,
 * paused). Both call the same fail-closed `tick()`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluateIdle,
  parseLlamaStatus,
  DOWNTIME_PANE_MIN_FREE_SLOTS,
  type LlamaStatus,
} from './downtime-worker.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Proxy mode-read endpoint path (`GET /admin/mode` only READS; the switch
 * endpoint is `/admin/set-mode`). */
export const ADMIN_MODE_PATH = '/admin/mode';

/** Proxy mode-switch endpoint path. */
export const ADMIN_SET_MODE_PATH = '/admin/set-mode';

/** Default idle window before switching to cheap mode: 60 minutes. */
export const DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS = 3_600_000;

/**
 * Defensive floor for the idle threshold (60s): a trivially small window
 * would defeat the operator-presence gating (never switch to cheap right
 * after the operator looked away).
 */
export const MODE_SWITCH_IDLE_THRESHOLD_FLOOR_MS = 60_000;

/** Default poll interval for the mode-switch worker (same as the downtime poller). */
export const DEFAULT_MODE_SWITCH_POLL_INTERVAL_MS = 10_000;

/** Hard floor for the poll interval (never hammer the admin endpoints). */
export const MODE_SWITCH_POLL_INTERVAL_FLOOR_MS = 5_000;

/** Sane cap for the poll interval (keeps idle detection responsive). */
export const MODE_SWITCH_POLL_INTERVAL_CAP_MS = 60_000;

/** Timeout for admin API calls (an unresponsive proxy must fail closed). */
export const ADMIN_API_TIMEOUT_MS = 5_000;

/**
 * Scheduler watchdog for the mode-switch task: a tick run that hangs (e.g. a
 * stuck admin fetch that outlived its 5s AbortController) is abandoned after
 * this and the single-flight flag resets so the next tick retries — a hung
 * run can never permanently wedge the task until a pane restart (mirror of
 * DOWNTIME_RUN_TIMEOUT_MS). Generous: a mode-switch restart may take longer
 * than ADMIN_API_TIMEOUT_MS while the proxy reloads its model pool.
 */
export const MODE_SWITCH_RUN_TIMEOUT_MS = 30_000;

// ── Settings clamps ───────────────────────────────────────────────────

/**
 * Clamp the mode-switch idle threshold: reject negative/non-finite (fall
 * back to the 60-minute default) and floor at 60s so the operator cannot
 * configure an immediate cheap-switch.
 */
export function clampModeSwitchIdleThresholdMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS;
  return Math.max(Math.round(value), MODE_SWITCH_IDLE_THRESHOLD_FLOOR_MS);
}

/**
 * Clamp the mode-switch poll interval: reject negative/non-finite (fall
 * back to the 10s default) and clamp into [5s, 60s] so the worker neither
 * hammers the proxy nor goes dormant (settings contract child
 * WL-0MT1EDYS0002CMUK).
 */
export function clampModeSwitchPollIntervalMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MODE_SWITCH_POLL_INTERVAL_MS;
  return Math.min(
    Math.max(Math.round(value), MODE_SWITCH_POLL_INTERVAL_FLOOR_MS),
    MODE_SWITCH_POLL_INTERVAL_CAP_MS,
  );
}

// ── Shared activity (cross-pane arbitration) ─────────────────────────

/**
 * Name of the shared activity file written into the coordination directory.
 * Every mode-switch worker instance (leader and non-leader alike) broadcasts
 * its latest operator-command timestamp here so the downtime leader can
 * evaluate idleness against activity from *any* pane (AC2). The file is a
 * tiny JSON object (`{ "lastActivityAt": <epoch ms> }`) written atomically.
 */
export const MODE_ACTIVITY_FILE = 'mode-activity.json';

/** Shared activity record shape (tolerant reader). */
interface ModeActivityRecord {
  lastActivityAt: number;
}

/**
 * Read the shared operator-activity timestamp from the coordination
 * directory. Returns the epoch-ms timestamp, or null when the coordination
 * directory is unset, the file is absent/unreadable/malformed, or the value
 * is not a finite number. A null result makes the caller fall back to its
 * local clock (fail-closed, AC6) — never a premature cheap switch.
 */
export function readSharedActivity(coordinationDir: string | undefined): number | null {
  if (!coordinationDir) return null;
  try {
    const path = join(coordinationDir, MODE_ACTIVITY_FILE);
    if (!existsSync(path)) return null;
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const ts = (raw as Partial<ModeActivityRecord>).lastActivityAt;
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
  } catch {
    return null; // unreadable / invalid JSON → fall back to the local clock
  }
}

/**
 * Broadcast an operator-activity timestamp to the shared activity file so
 * every pane's mode-switch worker sees it (AC2). The write is atomic (temp
 * file + rename) and monotonic (never regresses an existing newer value).
 * Returns true on success and false when the coordination directory is unset
 * or the write fails — the caller then relies on its local clock (AC6).
 */
export function writeSharedActivity(
  coordinationDir: string | undefined,
  timestamp: number,
): boolean {
  if (!coordinationDir) return false;
  try {
    mkdirSync(coordinationDir, { recursive: true });
    const path = join(coordinationDir, MODE_ACTIVITY_FILE);
    const existing = readSharedActivity(coordinationDir);
    const value = existing !== null ? Math.max(existing, timestamp) : timestamp;
    const payload = JSON.stringify({ lastActivityAt: value });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, payload, 'utf8');
    try {
      renameSync(tmp, path);
    } catch {
      // rename-over-existing is not portable (Windows); fall back to a
      // direct small synchronous write.
      writeFileSync(path, payload, 'utf8');
    }
    return true;
  } catch {
    return false; // permission/IO error → local clock only (AC6)
  }
}

// ── Types ─────────────────────────────────────────────────────────────

/** Proxy operating mode: 'fast' (cloud-backed) or 'cheap' (local-first). */
export type ProxyMode = 'fast' | 'cheap';

/**
 * Injectable HTTP fetcher for the admin API (tests replace this so no real
 * HTTP calls are made). Structured to satisfy both `GET /admin/mode` and
 * `POST /admin/set-mode`.
 */
export type AdminApiFetcher = (
  url: string,
  init?: { method?: string; body?: string; signal?: unknown },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ── Admin API client ──────────────────────────────────────────────────

/**
 * Read the current proxy mode via `GET /admin/mode`. Returns null on any
 * failure mode — network error, timeout, non-2xx status, invalid JSON,
 * ambiguous payload (fail-closed: an unreadable mode is treated as
 * "unknown", which the caller resolves to a safe no-op).
 */
export async function getAdminMode(
  proxyUrl: string,
  fetcher: AdminApiFetcher = globalThis.fetch as unknown as AdminApiFetcher,
): Promise<ProxyMode | null> {
  const url = `${proxyUrl.replace(/\/+$/, '')}${ADMIN_MODE_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_API_TIMEOUT_MS);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    if (!res.ok) return null;
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return null; // invalid JSON → ambiguous
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (o.mode !== 'fast' && o.mode !== 'cheap') return null;
    return o.mode as ProxyMode;
  } catch {
    return null; // network errors / timeouts → unknown, never throw
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Switch the proxy mode via `POST /admin/set-mode`. Resolves true when the
 * switch was accepted (2xx); false on every other outcome — including a
 * `409` (a mode-switch restart is already in progress: treated as a no-op
 * and retried on a later tick) and all failure modes (timeout, network
 * error, non-2xx, ambiguous response). Never throws.
 */
export async function setAdminMode(
  proxyUrl: string,
  mode: ProxyMode,
  fetcher: AdminApiFetcher = globalThis.fetch as unknown as AdminApiFetcher,
): Promise<boolean> {
  const url = `${proxyUrl.replace(/\/+$/, '')}${ADMIN_SET_MODE_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_API_TIMEOUT_MS);
  try {
    const res = await fetcher(url, {
      method: 'POST',
      body: JSON.stringify({ mode }),
      signal: controller.signal,
    });
    if (res.status === 409) {
      // Mode-switch restart in progress — no-op for this tick; the poller
      // retries on a later tick.
      return false;
    }
    return res.ok;
  } catch {
    return false; // network errors / timeouts → no switch, never throw
  } finally {
    clearTimeout(timer);
  }
}

// ── Mode-switch worker ────────────────────────────────────────────────

/** Path for the llama-proxy's local status endpoint (idle evaluation). */
export const PROXY_STATUS_PATH = '/llama/local/status';

/**
 * Fetch and parse the llama-proxy's `/llama/local/status` payload for idle
 * evaluation. Returns null on any failure mode (network error, timeout,
 * non-2xx, invalid JSON, ambiguous payload) — propagated as proxyStatus null
 * ⇒ fail-closed (treated as busy, no cheap switch). Parsing routes through
 * the shared `parseLlamaStatus` (downtime-worker.ts) so per-slot identity
 * (`slots[]`) is validated identically to the downtime dispatcher: a
 * malformed/ambiguous per-slot payload (non-array `slots`, non-boolean
 * `is_processing`, missing/empty/duplicate/negative-clamped `slot_id`,
 * non-finite counts) resolves null → busy (parent WL-0MT9F67Y3008S0PR).
 */
export async function fetchProxyStatus(
  proxyUrl: string,
  fetcher: AdminApiFetcher = globalThis.fetch as unknown as AdminApiFetcher,
): Promise<LlamaStatus | null> {
  const url = `${proxyUrl.replace(/\/+$/, '')}${PROXY_STATUS_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_API_TIMEOUT_MS);
  try {
    const res = await fetcher(url, { signal: controller.signal });
    if (!res.ok) return null;
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      return null; // invalid JSON → ambiguous
    }
    return parseLlamaStatus(raw);
  } catch {
    return null; // network errors / timeouts → unknown, never throw
  } finally {
    clearTimeout(timer);
  }
}


/** Tick inputs for the mode-switch worker (settings re-read per tick). */
export interface ModeSwitchTickOptions {
  /** Whether activity-gated mode switching is enabled (modeSwitchEnabled). */
  enabled: boolean;
  /** Idle window in ms (modeSwitchIdleThresholdMs, clamped). */
  idleThresholdMs: number;
  /** Proxy base URL (reused from downtimeProxyUrl). */
  proxyUrl: string;
  /**
   * Latest parsed `/llama/local/status` payload, or null when the status
   * endpoint failed / timed out / was ambiguous. null ⇒ proxy treated as
   * BUSY (fail-closed: no cheap switch).
   */
  proxyStatus: LlamaStatus | null;
}

/** Injectable time source (tests use a deterministic clock). */
export type Now = () => number;

/**
 * The mode-switch worker interface. Used by the scheduler (worklist.ts) to
 * tick the worker and by index.ts (agent-route hook) to record operator
 * activity and fire fast-switches.
 */
export interface ModeSwitchWorker {
  /**
   * Record that the operator issued an agent-route command through the
   * plugin. Updates the idle clock and (fire-and-forget) POSTs
   * `/admin/set-mode {"mode":"fast"}` when the last known mode is not
   * already fast. Never blocks or delays the command dispatch (fail-open).
   * `proxyUrl` is the shared `downtimeProxyUrl`.
   */
  onOperatorCommand(proxyUrl: string): void;
  /**
   * One poll tick: when enabled and the idle window is met and the proxy
   * reports idle, POST `/admin/set-mode {"mode":"cheap"}` — skipping when
   * the freshly-read persisted mode is already cheap. All failures are
   * fail-closed (no switch) and never throw.
   */
  tick(opts: ModeSwitchTickOptions): Promise<void>;
  /**
   * The most recently observed proxy mode, or `null` when it has not been
   * resolved yet (mode switching disabled, or no poll/switch has run).
   * Consumed by the downtime dispatcher's mode-aware
   * `AUDIT_PHASE2_PARALLELISM` decision (WL-0MT50S9JW001DHME): an unknown
   * mode (`null`) conservatively maps to the serial `'1'` default.
   */
  getLastKnownMode(): ProxyMode | null;
}

/**
 * Optional dependencies and coordination hooks for the mode-switch worker.
 * All fields are injectable for tests; production (index.ts) passes only
 * `isLeader` and `coordinationDir`.
 */
export interface ModeSwitchWorkerOptions {
  /** Injectable HTTP fetcher (tests). */
  fetcher?: AdminApiFetcher;
  /** Injectable time source (tests). */
  now?: Now;
  /**
   * Leadership probe reused from the downtime worker
   * (`DowntimeWorker.isLeader` — constraint: reuse the existing election).
   * Read live on every tick so a leadership handover is honoured without
   * reconstructing the worker (AC1/AC5). Defaults to `() => true`: with no
   * coordination there is exactly one instance and it is always the leader.
   */
  isLeader?: () => boolean;
  /**
   * Machine-wide coordination directory containing the shared activity file
   * (AC2). When absent the worker keeps the original process-local idle
   * clock (no shared state).
   */
  coordinationDir?: string;
}

/**
 * Create the mode-switch worker. Construction sets
 * `lastOperatorCommandAt = now()` — the idle clock resets to "active now",
 * so after a plugin restart the proxy stays fast until a fresh full idle
 * window passes (fail-safe, operator decision Q3: "a").
 *
 * @param deps - Injectable fetcher/time plus the leader probe and shared
 *   activity-coordination directory (tests / index.ts).
 */
export function createModeSwitchWorker(deps?: ModeSwitchWorkerOptions): ModeSwitchWorker {
  const fetcher = deps?.fetcher ?? (globalThis.fetch as unknown as AdminApiFetcher);
  const now = deps?.now ?? Date.now;
  const isLeader = deps?.isLeader ?? (() => true);
  const coordinationDir = deps?.coordinationDir;

  /** Last operator agent-route command timestamp; construction = "now" (restart reset). */
  let lastOperatorCommandAt: number = now();

  /**
   * Latest operator-activity timestamp across all panes: the max of this
   * process's local clock and the shared activity file. Falls back to the
   * local clock when the shared state is unreadable or unwritable (AC6,
   * fail-closed: never a premature cheap switch off stale cross-pane state).
   */
  const effectiveLastActivityAt = (): number => {
    const shared = readSharedActivity(coordinationDir);
    if (shared === null) return lastOperatorCommandAt;
    return Math.max(lastOperatorCommandAt, shared);
  };
  /** Last known proxy mode (refreshed via GET /admin/mode on each poll). */
  let lastKnownMode: ProxyMode | null = null;
  /** True while a mode-switch POST is in flight (per-process single-flight). */
  let switchInFlight = false;

  /**
   * Fire-and-forget mode switch with per-process single-flight and
   * last-known-mode dedup. Resolves when the switch attempt settles; used
   * both by the fast path (operator command) and the cheap path (idle
   * tick). Never throws.
   */
  const fireSwitch = async (proxyUrl: string, target: ProxyMode): Promise<void> => {
    if (switchInFlight) return; // at most one switch in flight per process
    if (lastKnownMode === target) return; // no redundant switching
    switchInFlight = true;
    try {
      const ok = await setAdminMode(proxyUrl, target, fetcher);
      if (ok) {
        lastKnownMode = target;
      }
      // A 409 (restart in progress) or any failure leaves lastKnownMode
      // unchanged — the poller retries on a later tick (fail-closed).
    } catch {
      // fail-closed: a throwing admin client (regression) never crashes.
    } finally {
      switchInFlight = false;
    }
  };

  return {
    onOperatorCommand(proxyUrl: string): void {
      // Record operator activity (agent-route command) on the local clock.
      lastOperatorCommandAt = now();
      // Broadcast to every pane — leader and non-leader alike — so the
      // downtime leader's idle evaluation sees activity from any pane (AC2).
      // A failed broadcast leaves this process's local clock authoritative
      // (AC6, fail-closed).
      writeSharedActivity(coordinationDir, lastOperatorCommandAt);
      // Fire-and-forget fast switch on the instance that received the
      // command (fail-open: never blocks dispatch). Fast is always the safe
      // direction, and the operator's active pane may not be the downtime
      // leader — gating fast on leadership would leave the proxy in cheap
      // while the operator is actively working (AC4). Only the *cheap* idle
      // switch is leader-gated; see tick() (AC1).
      void fireSwitch(proxyUrl, 'fast');
    },

    getLastKnownMode(): ProxyMode | null {
      return lastKnownMode;
    },

    async tick(opts: ModeSwitchTickOptions): Promise<void> {
      if (!opts.enabled) return;
      // Leader-only cheap switching (AC1): non-leader instances skip the
      // entire idle cheap-switch logic (no proxy status fetch, no mode read,
      // no POST). The probe is read live so a leadership handover is picked
      // up on the next tick (AC5).
      if (!isLeader()) return;
      if (switchInFlight) return; // single-flight: a switch is settling

      // Idle window: has there been no operator agent-route command on ANY
      // pane for ≥ the threshold? (local clock max shared activity, AC2; a
      // shared read failure falls back to the local clock, AC6. The local
      // clock can never be null — restart resets to "active now", so a fresh
      // full window is always required.)
      const elapsed = now() - effectiveLastActivityAt();
      if (elapsed < opts.idleThresholdMs) return;

      // Fetch proxy status when not provided (the worker fetches its own
      // idle state from the proxy so the caller doesn't need to). null
      // proxyStatus ⇒ fetch it; a fetch failure is fail-closed.
      const proxyStatus =
        opts.proxyStatus !== null
          ? opts.proxyStatus
          : await fetchProxyStatus(opts.proxyUrl, fetcher);

      // Proxy idle gate: a busy proxy DELAYS the switch — never kills
      // in-flight work. Per-slot operator gate (parent WL-0MT9F67Y3008S0PR,
      // decision 1.a): when the proxy serves per-slot identity (`slots[]`
      // valid per parseLlamaStatus), the gate requires ≥ 1 free slot
      // (spare-capacity, DOWNTIME_PANE_MIN_FREE_SLOTS — the relaxed per-slot
      // global checks: llama-server up + no model switch only), so busy
      // downtime-pane slots holding the dispatcher's query/lease no longer
      // block the switch. Without per-slot data the all-slots-free
      // fail-closed fallback is unchanged (requiredFreeSlots = 0, full
      // global checks). proxyStatus null (endpoint failure, timeout,
      // ambiguous/malformed) ⇒ busy (fail-closed).
      const requiredFreeSlots = Array.isArray(proxyStatus?.slots)
        ? DOWNTIME_PANE_MIN_FREE_SLOTS
        : 0;
      if (proxyStatus === null || !evaluateIdle(proxyStatus, requiredFreeSlots)) return;

      // Refresh last-known mode via GET /admin/mode before deciding (AC:
      // "track last-known mode; refresh via GET /admin/mode on poll").
      // A failed read keeps lastKnownMode as-is (fail-closed, no switch).
      const currentMode = await getAdminMode(opts.proxyUrl, fetcher);
      if (currentMode !== null) {
        lastKnownMode = currentMode;
      }
      // Skip when the persisted mode already matches the target (or is
      // unknown/read-unreachable — fail-closed no-op).
      if (lastKnownMode === 'cheap' || lastKnownMode === null) return;

      await fireSwitch(opts.proxyUrl, 'cheap');
    },
  };
}