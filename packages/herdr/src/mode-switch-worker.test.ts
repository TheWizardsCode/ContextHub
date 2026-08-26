/**
 * Unit tests for the mode-switch worker core (parent WL-0MSN3FWV5008KQE9):
 * idle-window evaluation, last-command tracking, cheap/fast switch triggers,
 * restart reset, and fail-closed paths.
 *
 * Run: npx vitest run packages/herdr/src/mode-switch-worker.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  createModeSwitchWorker,
  getAdminMode,
  setAdminMode,
  fetchProxyStatus,
  clampModeSwitchIdleThresholdMs,
  clampModeSwitchPollIntervalMs,
  DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS,
  MODE_SWITCH_IDLE_THRESHOLD_FLOOR_MS,
  MODE_SWITCH_POLL_INTERVAL_FLOOR_MS,
  MODE_SWITCH_POLL_INTERVAL_CAP_MS,
  ADMIN_MODE_PATH,
  ADMIN_SET_MODE_PATH,
  PROXY_STATUS_PATH,
  type AdminApiFetcher,
  type ProxyMode,
} from './mode-switch-worker.js';
import type { LlamaStatus } from './downtime-worker.js';

// ── Test helpers ──────────────────────────────────────────────────────

let clock: number;

function now(): number {
  return clock;
}

function advance(ms: number): void {
  clock += ms;
}

/** Build an idle `/llama/local/status` payload (all slots free). */
function idleStatus(overrides: Partial<LlamaStatus> = {}): LlamaStatus {
  return {
    llama_server_running: true,
    active_query: false,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 3,
    total_slots: 3,
    ...overrides,
  };
}

/**
 * Build a per-slot `/llama/local/status` payload (LP-0MSG5TA7Y002GN39): the
 * proxy serves `slots[]` identity with `is_processing` per slot. Defaults to
 * all slots free (valid per `parseLlamaStatus`).
 */
function perSlotStatus(overrides: Partial<LlamaStatus> = {}): LlamaStatus {
  return {
    ...idleStatus(),
    slots: [
      { slot_id: 'slot-1', is_processing: false },
      { slot_id: 'slot-2', is_processing: false },
      { slot_id: 'slot-3', is_processing: false },
    ],
    ...overrides,
  };
}

/** Raw (pre-parse) `/llama/local/status` payloads for `fetchProxyStatus`. */
function rawStatusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    llama_server_running: true,
    active_query: false,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: 3,
    total_slots: 3,
    ...overrides,
  };
}

interface MockAdminApi {
  fetcher: AdminApiFetcher;
  calls: { url: string; method: string; body?: string }[];
  getMode: () => ProxyMode | null;
  setModeResult: () => { status: number; body: unknown };
  setGetMode: (fn: () => ProxyMode | null) => void;
  setSetMode: (fn: () => { status: number; body: unknown }) => void;
  reset: () => void;
}

function mockAdminApi(): MockAdminApi {
  const calls: MockAdminApi['calls'] = [];
  let getMode: () => ProxyMode | null = () => 'fast';
  let setModeResult: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { ok: true },
  });
  const fetcher: AdminApiFetcher = async (url: string, init?: { method?: string; body?: string; signal?: unknown }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body });
    if (method === 'POST') {
      const r = setModeResult();
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.body,
      };
    }
    const mode = getMode();
    return {
      ok: mode !== null,
      status: mode !== null ? 200 : 500,
      json: async () => (mode !== null ? { mode } : { error: 'unreachable' }),
    };
  };
  return {
    fetcher,
    calls,
    getMode: () => getMode(),
    setModeResult: () => setModeResult(),
    setGetMode: (fn) => {
      getMode = fn;
    },
    setSetMode: (fn) => {
      setModeResult = fn;
    },
    reset: () => {
      calls.length = 0;
    },
  };
}

/** Flush fire-and-forget promise chains (onOperatorCommand posts without await). */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** POSTs targeting the set-mode endpoint recorded so far. */
function setModePosts(api: MockAdminApi): MockAdminApi['calls'] {
  return api.calls.filter((c) => c.method === 'POST' && c.url.endsWith(ADMIN_SET_MODE_PATH));
}

// ── Restart reset (fail-safe fast) ───────────────────────────────────

describe('restart reset', () => {
  it('construction sets lastOperatorCommandAt to now — a fresh worker never cheap-switches immediately', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });

    // Idle window is 600s; the worker was just constructed, so the elapsed
    // time is 0 — the cheap switch must NOT fire even though the proxy is idle.
    await worker.tick({
      enabled: true,
      idleThresholdMs: 600_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);

    // After a FULL idle window elapses (and the proxy is still idle) the
    // cheap switch fires — restart never shortcuts the fresh window.
    advance(600_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 600_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1);
    expect(setModePosts(api)[0].body).toContain('"cheap"');
  });
});

// ── Idle-window evaluation ───────────────────────────────────────────

describe('idle-window evaluation', () => {
  it('a timestamp older than the threshold triggers the cheap path', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    // Operator command issued 15 min ago.
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    const posts = setModePosts(api);
    expect(posts).toHaveLength(1);
    expect(posts[0].url.endsWith(ADMIN_SET_MODE_PATH)).toBe(true);
    expect(posts[0].body).toBe(JSON.stringify({ mode: 'cheap' }));
  });

  it('a fresh timestamp within the threshold does NOT trigger the cheap path', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    worker.onOperatorCommand('http://proxy'); // now
    await flushAsync();
    api.reset();
    advance(60_000); // well inside a 15-min threshold
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('disabled worker never switches even when the idle window is met', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: false,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });
});

// ── Last-command tracking ────────────────────────────────────────────

describe('last-command tracking', () => {
  it('an agent-route command updates the activity clock (resets the idle window)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000); // idle long enough
    worker.onOperatorCommand('http://proxy'); // operator returns — clock resets
    await flushAsync();
    api.reset();
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    // Fresh command → no cheap switch (only the fast switch from
    // onOperatorCommand was recorded, and api.reset cleared it).
    expect(setModePosts(api)).toHaveLength(0);
  });
});

// ── Fast switch on command ───────────────────────────────────────────

describe('fast switch on command', () => {
  it('a new operator agent-route command fires POST /admin/set-mode {"mode":"fast"} fire-and-forget', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    worker.onOperatorCommand('http://proxy');
    await flushAsync();
    const posts = setModePosts(api);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBe(JSON.stringify({ mode: 'fast' }));
  });

  it('skips the fast POST when the last known mode is already fast (no redundant switching)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    worker.onOperatorCommand('http://proxy');
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1);
    api.reset();

    // Second command while already fast — no second POST.
    worker.onOperatorCommand('http://proxy');
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('a failed fast switch never throws and never blocks the command (fail-open)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    api.setSetMode(() => ({ status: 500, body: { error: 'boom' } }));
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    worker.onOperatorCommand('http://proxy');
    await flushAsync();
    // The switch was attempted (fire-and-forget) and the failure was
    // swallowed — the command dispatch itself is never blocked or thrown.
    expect(setModePosts(api)).toHaveLength(1);
  });
});

// ── Cheap switch trigger ─────────────────────────────────────────────

describe('cheap switch trigger', () => {
  it('idle window met AND proxy idle → POST /admin/set-mode {"mode":"cheap"}', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1);
    expect(setModePosts(api)[0].body).toBe(JSON.stringify({ mode: 'cheap' }));
  });

  it('a busy proxy (active local query) delays the switch', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus({ local_active_query: true, active_query: true }),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);

    // Once the proxy goes idle again, the switch fires (delayed, not blocked).
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1);
  });

  it('skips the cheap POST when the freshly-read persisted mode is already cheap (no redundant switching)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    api.setGetMode(() => 'cheap'); // proxy is already in cheap mode
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('after switching to cheap, the mode is tracked — the next tick does not re-POST', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1); // cheap switch happened

    // Next tick: GET reports cheap (persisted) → no redundant POST.
    api.setGetMode(() => 'cheap');
    api.reset();
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });
});

// ── Fail-closed paths ────────────────────────────────────────────────

describe('fail-closed paths', () => {
  it('GET /admin/mode endpoint failure yields no switch and never throws', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    api.setGetMode(() => {
      throw new Error('network down');
    });
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await expect(
      worker.tick({
        enabled: true,
        idleThresholdMs: 900_000,
        proxyUrl: 'http://proxy',
        proxyStatus: idleStatus(),
      }),
    ).resolves.toBeUndefined();
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('GET /admin/mode timeout/network error resolves null → fail-closed no-op', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    api.setGetMode(() => null); // unreachable proxy
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('POST /admin/set-mode network failure yields no switch, never throws', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    api.setSetMode(() => {
      throw new Error('timeout');
    });
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await expect(
      worker.tick({
        enabled: true,
        idleThresholdMs: 900_000,
        proxyUrl: 'http://proxy',
        proxyStatus: idleStatus(),
      }),
    ).resolves.toBeUndefined();
    await flushAsync();
    expect(api.calls.some((c) => c.url.endsWith(ADMIN_SET_MODE_PATH))).toBe(true);
  });

  it('409 (mode-switch restart in progress) is a no-op and retried on a later tick', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    api.setSetMode(() => ({ status: 409, body: { error: 'restarting' } }));
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    // 409 → no switch accepted; the POST was attempted once and NOT recorded
    // as a succeeded switch.
    expect(setModePosts(api)).toHaveLength(1);

    // Retried on a later tick: the restart completed, the switch lands.
    api.setSetMode(() => ({ status: 200, body: { ok: true } }));
    api.reset();
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1);
    expect(setModePosts(api)[0].body).toBe(JSON.stringify({ mode: 'cheap' }));
  });

  it('proxy status endpoint failure (null status) → treated as busy, no switch', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: null, // endpoint failure / timeout / ambiguous
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('ambiguous mode response (non fast/cheap) yields no switch', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    api.setGetMode(() => 'bogus' as ProxyMode); // ambiguous — getAdminMode nulls it
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('per-process single-flight: overlapping switch attempts coalesce to one POST', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    // Two immediate operator commands: the first fires the fast switch, the
    // second either sees switchInFlight or the just-set lastKnownMode='fast'
    // — either way at most ONE fast POST lands (no hammering).
    worker.onOperatorCommand('http://proxy');
    worker.onOperatorCommand('http://proxy');
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1);
  });
});

// ── Settings clamps (settings contract tie-in) ───────────────────────

describe('settings clamps (contract)', () => {
  it('modeSwitchIdleThresholdMs clamps below its floor and defaults when absent/invalid', () => {
    expect(clampModeSwitchIdleThresholdMs(1_000)).toBe(MODE_SWITCH_IDLE_THRESHOLD_FLOOR_MS);
    expect(clampModeSwitchIdleThresholdMs(NaN)).toBe(DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS);
    expect(clampModeSwitchIdleThresholdMs(-5)).toBe(DEFAULT_MODE_SWITCH_IDLE_THRESHOLD_MS);
    expect(clampModeSwitchIdleThresholdMs(900_000)).toBe(900_000);
  });

  it('modeSwitchPollIntervalMs clamps below its floor and above its cap', () => {
    expect(clampModeSwitchPollIntervalMs(1_000)).toBe(MODE_SWITCH_POLL_INTERVAL_FLOOR_MS);
    expect(clampModeSwitchPollIntervalMs(300_000)).toBe(MODE_SWITCH_POLL_INTERVAL_CAP_MS);
    expect(clampModeSwitchPollIntervalMs(NaN)).toBe(10_000);
    expect(clampModeSwitchPollIntervalMs(10_000)).toBe(10_000);
  });
});

// ── Admin API client ─────────────────────────────────────────────────

describe('fetchProxyStatus', () => {
  it('fetchProxyStatus parses a valid idle status payload', async () => {
    const fetcher: AdminApiFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        llama_server_running: true,
        active_query: false,
        local_active_query: false,
        model_switch_in_progress: false,
        local_lease_active: false,
        available_slots: 3,
        total_slots: 3,
      }),
    });
    const status = await fetchProxyStatus('http://proxy', fetcher);
    expect(status).not.toBeNull();
    expect(status!.llama_server_running).toBe(true);
    expect(status!.available_slots).toBe(3);
  });

  it('fetchProxyStatus returns null on non-2xx response', async () => {
    const fetcher: AdminApiFetcher = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    expect(await fetchProxyStatus('http://proxy', fetcher)).toBeNull();
  });

  it('fetchProxyStatus returns null on network error', async () => {
    const fetcher: AdminApiFetcher = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await fetchProxyStatus('http://proxy', fetcher)).toBeNull();
  });

  it('tick uses fetchProxyStatus when proxyStatus is null', async () => {
    clock = 1_000_000;
    // Use a single counting fetcher that tracks all calls.
    const fetcherCount = { status: 0, adminMode: 0, setMode: 0 };
    const countingFetcher: AdminApiFetcher = async (url, init) => {
      if (url.endsWith(PROXY_STATUS_PATH)) {
        fetcherCount.status++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            llama_server_running: true,
            active_query: false,
            local_active_query: false,
            model_switch_in_progress: false,
            local_lease_active: false,
            available_slots: 3,
            total_slots: 3,
          }),
        };
      }
      if (url.endsWith(ADMIN_MODE_PATH)) {
        fetcherCount.adminMode++;
        return { ok: true, status: 200, json: async () => ({ mode: 'fast' }) };
      }
      if (url.endsWith(ADMIN_SET_MODE_PATH)) {
        fetcherCount.setMode++;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    };
    const worker = createModeSwitchWorker({ fetcher: countingFetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: null, // null → worker fetches its own status
    });
    await flushAsync();
    expect(fetcherCount.status).toBe(1); // fetched its own proxy status
    expect(fetcherCount.adminMode).toBeGreaterThanOrEqual(1); // read mode
    expect(fetcherCount.setMode).toBeGreaterThanOrEqual(1); // switched to cheap
  });
});

describe('admin API client', () => {
  it('getAdminMode parses a valid mode payload', async () => {
    const fetcher: AdminApiFetcher = async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({ mode: 'cheap' }),
    });
    expect(await getAdminMode('http://proxy', fetcher)).toBe('cheap');
  });

  it('getAdminMode nulls ambiguous/malformed payloads (fail-closed)', async () => {
    const fetcher: AdminApiFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ mode: 'turbo' }),
    });
    expect(await getAdminMode('http://proxy', fetcher)).toBeNull();
  });

  it('getAdminMode nulls non-2xx responses', async () => {
    const fetcher: AdminApiFetcher = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    expect(await getAdminMode('http://proxy', fetcher)).toBeNull();
  });

  it('setAdminMode posts a JSON body and resolves true on 2xx', async () => {
    let seen: { url: string; init?: { method?: string; body?: string } } | undefined;
    const fetcher: AdminApiFetcher = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    expect(await setAdminMode('http://proxy', 'fast', fetcher)).toBe(true);
    expect(seen?.url.endsWith(ADMIN_SET_MODE_PATH)).toBe(true);
    expect(seen?.init?.method).toBe('POST');
    expect(seen?.init?.body).toBe(JSON.stringify({ mode: 'fast' }));
  });

  it('setAdminMode resolves false on 409 (no-throw no-op)', async () => {
    const fetcher: AdminApiFetcher = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'restarting' }),
    });
    expect(await setAdminMode('http://proxy', 'cheap', fetcher)).toBe(false);
  });

  it('setAdminMode resolves false on network errors (never throws)', async () => {
    const fetcher: AdminApiFetcher = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(setAdminMode('http://proxy', 'cheap', fetcher)).resolves.toBe(false);
  });
});

// ── Per-slot operator gate (parent WL-0MT9F67Y3008S0PR, decision 1.a) ──

/**
 * Per-slot payload: 1 of 3 slots free (operator slot free), the other two
 * busy (`is_processing: true` — downtime panes held), with the GLOBAL
 * query/lease signals active (the downtime dispatcher's autonomous work
 * holds query+lease on the busy slots). This is the exact state the cheap
 * switch must fire into (spare-capacity, `DOWNTIME_PANE_MIN_FREE_SLOTS`
 * semantics): downtime-pane slots must NOT delay the switch.
 */
function perSlotOperatorFree(overrides: Partial<LlamaStatus> = {}): LlamaStatus {
  return perSlotStatus({
    active_query: true,
    local_active_query: true,
    local_lease_active: true,
    available_slots: 1,
    total_slots: 3,
    slots: [
      { slot_id: 'slot-1', is_processing: true },
      { slot_id: 'slot-2', is_processing: true },
      { slot_id: 'slot-3', is_processing: false },
    ],
    ...overrides,
  });
}

describe('per-slot operator gate', () => {
  it('AC1: per-slot payload, ≥1 free slot → posts cheap even while the other two slots are busy (downtime panes)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000); // idle window met
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: perSlotOperatorFree(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1);
    expect(setModePosts(api)[0].body).toBe(JSON.stringify({ mode: 'cheap' }));
  });

  it('AC2: all slots busy (0 free — operator plus panes) → no switch (Q4b protection)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: perSlotStatus({
        available_slots: 0,
        slots: [
          { slot_id: 'slot-1', is_processing: true },
          { slot_id: 'slot-2', is_processing: true },
          { slot_id: 'slot-3', is_processing: true },
        ],
      }),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('AC3: busy slots with ≥1 free slot → switch fires (spare-capacity semantics)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    // 1 free of 3, without the global query/lease signals: the per-slot
    // spare-capacity gate (≥1 free) must still fire.
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: perSlotStatus({
        available_slots: 1,
        slots: [
          { slot_id: 'slot-1', is_processing: true },
          { slot_id: 'slot-2', is_processing: true },
          { slot_id: 'slot-3', is_processing: false },
        ],
      }),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1);
  });

  it('AC4: no per-slot data (slots absent) → only all-free fires; 1-of-3 free yields NO switch', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    // 1-of-3 free, no slots[] identity: unchanged all-slots-free fallback
    // (evaluateIdle(proxyStatus, 0)) — the switch must NOT fire.
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus({ available_slots: 1, total_slots: 3 }),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);

    // All slots free (no per-slot identity) → the switch fires as before.
    api.reset();
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: idleStatus(),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(1);
    expect(setModePosts(api)[0].body).toBe(JSON.stringify({ mode: 'cheap' }));
  });

  it('AC5: per-slot payload, llama-server down → no switch (global gate still enforced)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: perSlotOperatorFree({ llama_server_running: false }),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('AC5: per-slot payload, model-switch in progress → no switch (global gate still enforced)', async () => {
    clock = 1_000_000;
    const api = mockAdminApi();
    const worker = createModeSwitchWorker({ fetcher: api.fetcher, now });
    advance(900_000);
    await worker.tick({
      enabled: true,
      idleThresholdMs: 900_000,
      proxyUrl: 'http://proxy',
      proxyStatus: perSlotOperatorFree({ model_switch_in_progress: true }),
    });
    await flushAsync();
    expect(setModePosts(api)).toHaveLength(0);
  });

  it('AC6: malformed per-slot payloads → fetchProxyStatus resolves null (fail-closed, no switch)', async () => {
    // Each of these is ambiguous per `parseLlamaStatus`: non-array `slots`,
    // non-boolean `is_processing`, missing/empty `slot_id`, duplicate ids,
    // and a negative id colliding with the clamped `0` (WL-0MSVRMAWM007QNR5
    // clamp → duplicate). fetchProxyStatus must resolve null → proxy busy.
    const malformed: Record<string, unknown>[] = [
      { ...rawStatusPayload(), slots: 'not-an-array' },
      { ...rawStatusPayload(), slots: [{ slot_id: 'x', is_processing: 'yes' }] },
      { ...rawStatusPayload(), slots: [{ is_processing: false }] },
      { ...rawStatusPayload(), slots: [{ slot_id: '', is_processing: false }] },
      {
        ...rawStatusPayload(),
        slots: [
          { slot_id: 'dup', is_processing: false },
          { slot_id: 'dup', is_processing: true },
        ],
      },
      {
        ...rawStatusPayload(),
        slots: [
          { slot_id: -1, is_processing: false },
          { slot_id: 0, is_processing: true },
        ],
      },
    ];
    for (const payload of malformed) {
      const fetcher: AdminApiFetcher = async () => ({
        ok: true,
        status: 200,
        json: async () => payload,
      });
      await expect(fetchProxyStatus('http://proxy', fetcher)).resolves.toBeNull();
    }
  });

  it('AC6: malformed per-slot payload fetched by the worker → busy, no switch, never throws', async () => {
    clock = 1_000_000;
    const statusFetches: string[] = [];
    const setModePostsMade: string[] = [];
    const fetcher: AdminApiFetcher = async (url, init) => {
      if (url.endsWith(PROXY_STATUS_PATH)) {
        statusFetches.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...rawStatusPayload(),
            slots: 'garbage', // non-array slots → parse fails → null
          }),
        };
      }
      if (url.endsWith(ADMIN_MODE_PATH)) {
        return { ok: true, status: 200, json: async () => ({ mode: 'fast' }) };
      }
      if (url.endsWith(ADMIN_SET_MODE_PATH)) {
        setModePostsMade.push(url);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    };
    const worker = createModeSwitchWorker({ fetcher, now });
    advance(900_000);
    await expect(
      worker.tick({
        enabled: true,
        idleThresholdMs: 900_000,
        proxyUrl: 'http://proxy',
        proxyStatus: null, // null → worker fetches its own status
      }),
    ).resolves.toBeUndefined();
    await flushAsync();
    // The worker fetched its own status exactly once and never throws.
    expect(statusFetches).toHaveLength(1);
    // Malformed per-slot identity → proxy treated as busy → NO cheap switch.
    expect(setModePostsMade).toHaveLength(0);
  });
});