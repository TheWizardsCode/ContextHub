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
 *    the pane opens regardless).
 *  - **Cheap switch on idle:** on each tick, when the operator has been idle
 *    (no agent-route commands) for ≥ `modeSwitchIdleThresholdMs` **AND** the
 *    proxy reports idle (reusing `evaluateIdle` from downtime-worker.ts with
 *    `requiredFreeSlots = 0` — llama-server running, no active local query,
 *    no model switch, no local lease, all required slots free), the worker
 *    POSTs `/admin/set-mode {"mode":"cheap"}`. A busy proxy (active local
 *    query) **delays** the switch — it never kills in-flight work.
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
 */

import { evaluateIdle, type LlamaStatus } from './downtime-worker.js';

// ── Constants ─────────────────────────────────────────────────────────

/** Proxy mode-read endpoint path (`GET /admin/mode` only READS; the switch
 * endpoint is `/admin/set-mode`). */
export const ADMIN_MODE_PATH = '/admin/mode';

/** Proxy mode-switch endpoint path. */
export const ADMIN_SET_MODE_PATH = '/admin/set-mode';

/** Default idle window before switching to cheap mode: 15 minutes. */
export const DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS = 900_000;

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

// ── Settings clamps ───────────────────────────────────────────────────

/**
 * Clamp the mode-switch idle threshold: reject negative/non-finite (fall
 * back to the 15-minute default) and floor at 60s so the operator cannot
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
 * non-2xx, invalid JSON) — propagated as proxyStatus null ⇒ fail-closed
 * (treated as busy, no cheap switch).
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
    const raw = (await res.json()) as LlamaStatus;
    if (typeof raw !== 'object' || raw === null) return null;
    return raw as LlamaStatus;
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
}

/**
 * Create the mode-switch worker. Construction sets
 * `lastOperatorCommandAt = now()` — the idle clock resets to "active now",
 * so after a plugin restart the proxy stays fast until a fresh full idle
 * window passes (fail-safe, operator decision Q3: "a").
 *
 * @param deps - Injectable fetcher/time (tests).
 */
export function createModeSwitchWorker(deps?: {
  fetcher?: AdminApiFetcher;
  now?: Now;
}): ModeSwitchWorker {
  const fetcher = deps?.fetcher ?? (globalThis.fetch as unknown as AdminApiFetcher);
  const now = deps?.now ?? Date.now;

  /** Last operator agent-route command timestamp; construction = "now" (restart reset). */
  let lastOperatorCommandAt: number = now();
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
      // Record operator activity (agent-route command).
      lastOperatorCommandAt = now();
      // Fire-and-forget fast switch (fail-open: never blocks dispatch).
      void fireSwitch(proxyUrl, 'fast');
    },

    async tick(opts: ModeSwitchTickOptions): Promise<void> {
      if (!opts.enabled) return;
      if (switchInFlight) return; // single-flight: a switch is settling

      // Idle window: has the operator issued no agent-route command for ≥
      // the threshold? (lastOperatorCommandAt can never be null — restart
      // resets to "active now", so a fresh full window is always required.)
      const elapsed = now() - lastOperatorCommandAt;
      if (elapsed < opts.idleThresholdMs) return;

      // Fetch proxy status when not provided (the worker fetches its own
      // idle state from the proxy so the caller doesn't need to). null
      // proxyStatus ⇒ fetch it; a fetch failure is fail-closed.
      const proxyStatus =
        opts.proxyStatus !== null
          ? opts.proxyStatus
          : await fetchProxyStatus(opts.proxyUrl, fetcher);

      // Proxy idle gate: a busy proxy (active local query / lease / model
      // switch / missing fields) DELAYS the switch — never kills in-flight
      // work (operator decision Q4b). Reuses evaluateIdle with
      // requiredFreeSlots = 0 (all slots free). proxyStatus null (endpoint
      // failure, timeout, ambiguous) ⇒ busy (fail-closed).
      if (proxyStatus === null || !evaluateIdle(proxyStatus, 0)) return;

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