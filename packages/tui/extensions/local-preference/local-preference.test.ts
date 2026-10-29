/**
 * local-preference.test.ts — Pi Worklog extension per-turn local preference
 * (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4, slice C4).
 *
 * The llama-proxy honours a per-request locality preference:
 *   `X-Local-Preference: local-preferred | remote-ok`
 * and reports the route it actually took on responses:
 *   `X-Local-Route` / `X-Local-Fallback-Reason`.
 *
 * This extension module:
 *   - turns the pane-launch env var `HERDR_LOCAL_PREFERENCE` into the
 *     `X-Local-Preference` provider request header on every request
 *     (C4-AC1);
 *   - parses the response route headers and appends ONE bounded JSONL
 *     route-log line per response to `<cwd>/.worklog/local-route.log`
 *     (C4-AC2), carrying the pi session id and reservation ticket when
 *     forwarded (C4-AC4);
 *   - is fail-open (C4-AC3): an unset/invalid knob injects no header
 *     (byte-identical request), absent/malformed route headers write no
 *     log entry, and a capture/write failure never breaks a turn.
 *
 * The retired `local-only` spelling is NOT an alias (WL-0MVSI1S5P003UAMB):
 * it resolves to `undefined` like any other invalid value, so it sends no
 * header and writes no route log.
 *
 * These specs were authored first (test-first). Pure functions are tested
 * directly; the registered hook behaviour is tested through a mock pi API.
 *
 * Run: npx vitest run packages/tui/extensions/local-preference/local-preference.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Non-literal specifier so the not-yet-created module is loaded dynamically. */
const MODULE_SPECIFIER = './local-preference.js';

type LocalPreference = 'local-preferred' | 'remote-ok';

interface RouteLogEntry {
  at?: string;
  sessionId?: string;
  preference?: LocalPreference;
  route?: string;
  fallbackReason?: string;
  model?: string;
  ticket?: string;
}

interface LocalPreferenceModule {
  LOCAL_PREFERENCE_ENV_VAR: string;
  LOCAL_PREFERENCE_HEADER: string;
  LOCAL_ROUTE_HEADER: string;
  LOCAL_FALLBACK_REASON_HEADER: string;
  LOCAL_ROUTE_LOG_FILE: string;
  LOCAL_ROUTE_LOG_MAX_ENTRIES: number;
  resolveLocalPreference(
    env?: Record<string, string | undefined>,
  ): LocalPreference | undefined;
  readRouteHeaders(headers: Record<string, string>): {
    route?: string;
    fallbackReason?: string;
  };
  buildRouteLogEntry(opts: {
    sessionId?: string;
    preference?: LocalPreference;
    model?: string;
    ticket?: string;
    at?: string;
    route?: string;
    fallbackReason?: string;
  }): RouteLogEntry | null;
  appendRouteLogEntry(cwd: string, entry: RouteLogEntry): Promise<void>;
  registerLocalPreference(pi: {
    on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => void): () => void;
  }): void;
}

async function loadModule(): Promise<LocalPreferenceModule> {
  return (await import(MODULE_SPECIFIER)) as unknown as LocalPreferenceModule;
}

const ENV_VAR = 'HERDR_LOCAL_PREFERENCE';
const originalEnvValue = process.env[ENV_VAR];

const tempDirs: string[] = [];

function makeTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-pref-test-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  delete process.env[ENV_VAR];
  delete process.env.PI_LOCAL_RESERVATION_TICKET;
});

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = originalEnvValue;
  }
  delete process.env.PI_LOCAL_RESERVATION_TICKET;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Constants (C1-pinned contract) ──────────────────────────────────────

describe('wire contract constants (C1-pinned)', () => {
  it('pins the env var, request header and response headers', async () => {
    const m = await loadModule();
    expect(m.LOCAL_PREFERENCE_ENV_VAR).toBe('HERDR_LOCAL_PREFERENCE');
    expect(m.LOCAL_PREFERENCE_HEADER).toBe('X-Local-Preference');
    expect(m.LOCAL_ROUTE_HEADER).toBe('X-Local-Route');
    expect(m.LOCAL_FALLBACK_REASON_HEADER).toBe('X-Local-Fallback-Reason');
  });

  it('pins the bounded route-log location and cap (C4-AC2)', async () => {
    const m = await loadModule();
    expect(m.LOCAL_ROUTE_LOG_FILE).toBe('local-route.log');
    expect(m.LOCAL_ROUTE_LOG_MAX_ENTRIES).toBe(2000);
  });
});

// ── Preference resolution (C4-AC1) ─────────────────────────────────────

describe('resolveLocalPreference (C4-AC1)', () => {
  it('accepts both preference values verbatim', async () => {
    const { resolveLocalPreference } = await loadModule();
    expect(resolveLocalPreference({ [ENV_VAR]: 'local-preferred' })).toBe('local-preferred');
    expect(resolveLocalPreference({ [ENV_VAR]: 'remote-ok' })).toBe('remote-ok');
  });

  it('returns undefined when the variable is unset or empty (fail-open)', async () => {
    const { resolveLocalPreference } = await loadModule();
    expect(resolveLocalPreference({})).toBeUndefined();
    expect(resolveLocalPreference({ [ENV_VAR]: '' })).toBeUndefined();
  });

  it('rejects the retired local-only spelling — no alias, no normalisation', async () => {
    const { resolveLocalPreference } = await loadModule();
    expect(resolveLocalPreference({ [ENV_VAR]: 'local-only' })).toBeUndefined();
    expect(resolveLocalPreference({ [ENV_VAR]: ' local-only' })).toBeUndefined();
    expect(resolveLocalPreference({ [ENV_VAR]: 'local-only ' })).toBeUndefined();
    expect(resolveLocalPreference({ [ENV_VAR]: 'local_only' })).toBeUndefined();
  });

  it('rejects any other value (never invents a preference)', async () => {
    const { resolveLocalPreference } = await loadModule();
    for (const invalid of [
      'LOCAL',
      'local',
      'remote',
      'both',
      'auto',
      'local-preferred ',
      ' local-preferred',
      'Local-Preferred',
    ]) {
      expect(resolveLocalPreference({ [ENV_VAR]: invalid })).toBeUndefined();
    }
  });
});

// ── Response header parsing (C4-AC2) ───────────────────────────────────

describe('readRouteHeaders (C4-AC2)', () => {
  it('finds the route and fallback-reason headers case-insensitively', async () => {
    const { readRouteHeaders } = await loadModule();
    expect(
      readRouteHeaders({ 'x-local-route': 'local', 'X-Local-Fallback-Reason': 'queue-full' }),
    ).toEqual({ route: 'local', fallbackReason: 'queue-full' });
    expect(
      readRouteHeaders({ 'X-Local-Route': 'remote:opencode-go' }),
    ).toEqual({ route: 'remote:opencode-go' });
  });

  it('returns nothing for absent or blank headers (malformed → no entry)', async () => {
    const { readRouteHeaders } = await loadModule();
    expect(readRouteHeaders({ 'content-type': 'application/json' })).toEqual({});
    expect(readRouteHeaders({ 'x-local-route': '   ' })).toEqual({});
    expect(readRouteHeaders({ 'x-local-fallback-reason': '' })).toEqual({});
  });
});

// ── Route-log entry building (C4-AC2/AC4) ──────────────────────────────

describe('buildRouteLogEntry (C4-AC2/AC4)', () => {
  it('builds a full entry when route headers are present', async () => {
    const { buildRouteLogEntry } = await loadModule();
    const entry = buildRouteLogEntry({
      sessionId: 'herdr-1-2-3',
      preference: 'local-preferred',
      model: 'local-qwen3',
      ticket: 'tkt-1',
      at: '2026-01-01T00:00:00.000Z',
      route: 'local',
      fallbackReason: 'queue-full',
    });
    expect(entry).toEqual({
      at: '2026-01-01T00:00:00.000Z',
      sessionId: 'herdr-1-2-3',
      preference: 'local-preferred',
      model: 'local-qwen3',
      ticket: 'tkt-1',
      route: 'local',
      fallbackReason: 'queue-full',
    });
  });

  it('returns null when neither route header is present (absent → no entry)', async () => {
    const { buildRouteLogEntry } = await loadModule();
    expect(
      buildRouteLogEntry({ sessionId: 's1', at: 'x', route: undefined, fallbackReason: undefined }),
    ).toBeNull();
    expect(
      buildRouteLogEntry({ sessionId: 's1', at: 'x', fallbackReason: '   ' }),
    ).toBeNull();
  });
});

// ── Bounded route log (C4-AC2) ─────────────────────────────────────────

describe('appendRouteLogEntry (C4-AC2)', () => {
  it('appends one JSONL line per response under .worklog/', async () => {
    const { appendRouteLogEntry, LOCAL_ROUTE_LOG_FILE } = await loadModule();
    const cwd = makeTempCwd();
    await appendRouteLogEntry(cwd, {
      at: '2026-01-01T00:00:00.000Z',
      sessionId: 'herdr-1',
      preference: 'local-preferred',
      route: 'local',
    });
    await appendRouteLogEntry(cwd, {
      at: '2026-01-01T00:00:01.000Z',
      sessionId: 'herdr-1',
      preference: 'local-preferred',
      route: 'remote:opencode-go',
      fallbackReason: 'stall_after_reasoning',
    });
    const lines = readFileSync(join(cwd, '.worklog', LOCAL_ROUTE_LOG_FILE), 'utf8')
      .split('\n')
      .filter((ln) => ln.trim() !== '');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ route: 'local', sessionId: 'herdr-1' });
    expect(JSON.parse(lines[1])).toMatchObject({
      route: 'remote:opencode-go',
      fallbackReason: 'stall_after_reasoning',
    });
  });

  it('rolls the file back to the cap (2000 entries), keeping the newest', async () => {
    const { appendRouteLogEntry, LOCAL_ROUTE_LOG_FILE, LOCAL_ROUTE_LOG_MAX_ENTRIES } =
      await loadModule();
    const cwd = makeTempCwd();
    // Pre-seed a FULL log (appending 2000 lines one at a time would rewrite
    // the file 2000 times — the trim path only needs a full file + 2 appends).
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(cwd, '.worklog'), { recursive: true });
    const seeded = Array.from({ length: LOCAL_ROUTE_LOG_MAX_ENTRIES }, (_, i) =>
      JSON.stringify({ at: `t${i}`, sessionId: 's', route: 'local' }),
    );
    writeFileSync(join(cwd, '.worklog', LOCAL_ROUTE_LOG_FILE), seeded.join('\n') + '\n');

    await appendRouteLogEntry(cwd, { at: 'newest-1', sessionId: 's', route: 'local' });
    await appendRouteLogEntry(cwd, { at: 'newest-2', sessionId: 's', route: 'local' });

    const lines = readFileSync(join(cwd, '.worklog', LOCAL_ROUTE_LOG_FILE), 'utf8')
      .split('\n')
      .filter((ln) => ln.trim() !== '');
    expect(lines).toHaveLength(LOCAL_ROUTE_LOG_MAX_ENTRIES);
    // Newest entries survive; the two oldest seeds rolled off.
    expect(JSON.parse(lines[lines.length - 1])).toMatchObject({ at: 'newest-2' });
    expect(JSON.parse(lines[0])).toMatchObject({ at: 't2' });
  });
});

// ── Hook registration (C4-AC1/AC3) ─────────────────────────────────────

describe('registerLocalPreference hooks', () => {
  interface MockPi {
    on(event: string, handler: (event: Record<string, unknown>, ctx?: unknown) => void): () => void;
  }

  async function register(): Promise<{
    handlers: Record<string, (event: Record<string, unknown>, ctx?: unknown) => void>;
    on: MockPi['on'];
  }> {
    const { registerLocalPreference } = await loadModule();
    const handlers: Record<string, (event: Record<string, unknown>, ctx?: unknown) => void> = {};
    const on: MockPi['on'] = (event, handler) => {
      handlers[event] = handler;
      return () => {
        delete handlers[event];
      };
    };
    registerLocalPreference({ on });
    return { handlers, on };
  }

  function ctx(cwd: string): Record<string, unknown> {
    return {
      cwd,
      model: { id: 'local-qwen3' },
      sessionManager: { getSessionId: () => 'herdr-42' },
    };
  }

  it('injects X-Local-Preference for both values (C4-AC1)', async () => {
    const { handlers } = await register();
    process.env[ENV_VAR] = 'local-preferred';
    const h1: Record<string, string | null> = { 'content-type': 'application/json' };
    handlers.before_provider_headers({ headers: h1 });
    expect(h1['X-Local-Preference']).toBe('local-preferred');

    process.env[ENV_VAR] = 'remote-ok';
    const h2: Record<string, string | null> = { 'content-type': 'application/json' };
    handlers.before_provider_headers({ headers: h2 });
    expect(h2['X-Local-Preference']).toBe('remote-ok');
  });

  it('uses the canonical header name and leaves other request headers intact', async () => {
    const { handlers } = await register();
    process.env[ENV_VAR] = 'local-preferred';
    const headers: Record<string, string | null> = {
      'content-type': 'application/json',
      'x-local-preference': null,
    };
    handlers.before_provider_headers({ headers });
    // The wire name is exactly `X-Local-Preference` (C1-pinned), and the
    // lower-case carrier is left untouched.
    expect(headers['X-Local-Preference']).toBe('local-preferred');
    expect(headers['x-local-preference']).toBeNull();
    expect(headers['content-type']).toBe('application/json');
  });

  it('leaves the request untouched when the knob is absent, empty or invalid (C4-AC3)', async () => {
    const { handlers } = await register();
    const h = { 'content-type': 'application/json' };
    handlers.before_provider_headers({ headers: h });
    expect(h).toEqual({ 'content-type': 'application/json' });

    process.env[ENV_VAR] = '';
    const hEmpty = { 'content-type': 'application/json' };
    handlers.before_provider_headers({ headers: hEmpty });
    expect(hEmpty).toEqual({ 'content-type': 'application/json' });

    process.env[ENV_VAR] = 'locale-only';
    const h2 = { 'content-type': 'application/json' };
    handlers.before_provider_headers({ headers: h2 });
    expect(h2).toEqual({ 'content-type': 'application/json' });
  });

  it('treats the retired local-only value as invalid — no header, no route log', async () => {
    const { handlers } = await register();
    const cwd = makeTempCwd();
    process.env[ENV_VAR] = 'local-only';

    const headers: Record<string, string | null> = { 'content-type': 'application/json' };
    handlers.before_provider_headers({ headers });
    expect(headers).toEqual({ 'content-type': 'application/json' });

    const response = handlers.after_provider_response as (
      event: Record<string, unknown>,
      c: unknown,
    ) => void;
    response({ status: 200, headers: { 'x-local-route': 'local' } }, ctx(cwd));
    // Give any accidental async append a chance to land, then assert absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(() =>
      readFileSync(join(cwd, '.worklog', 'local-route.log'), 'utf8'),
    ).toThrow();
  });

  it('writes one route-log line per response with session id, model and ticket (C4-AC4)', async () => {
    const { handlers } = await register();
    const cwd = makeTempCwd();
    process.env[ENV_VAR] = 'local-preferred';
    process.env.PI_LOCAL_RESERVATION_TICKET = 'tkt-granted-1';
    const response = handlers.after_provider_response as (
      event: Record<string, unknown>,
      c: unknown,
    ) => void;
    response(
      { status: 200, headers: { 'x-local-route': 'local' } },
      ctx(cwd),
    );
    // The append is async — allow microtasks to settle.
    await vi.waitFor(() => {
      const raw = readFileSync(join(cwd, '.worklog', 'local-route.log'), 'utf8');
      expect(raw).toContain('"route":"local"');
    });
    const line = JSON.parse(
      readFileSync(join(cwd, '.worklog', 'local-route.log'), 'utf8').trim(),
    );
    expect(line.sessionId).toBe('herdr-42');
    expect(line.model).toBe('local-qwen3');
    expect(line.ticket).toBe('tkt-granted-1');
    expect(line.preference).toBe('local-preferred');
  });

  it('records preference "remote-ok" in the route log for a remote-ok pane (WL-0MVNUHWH500196K1 AC4)', async () => {
    const { handlers } = await register();
    const cwd = makeTempCwd();
    process.env[ENV_VAR] = 'remote-ok';
    const response = handlers.after_provider_response as (
      event: Record<string, unknown>,
      c: unknown,
    ) => void;
    response(
      { status: 200, headers: { 'x-local-route': 'remote:opencode-go' } },
      ctx(cwd),
    );
    // The append is async — allow microtasks to settle.
    await vi.waitFor(() => {
      const raw = readFileSync(join(cwd, '.worklog', 'local-route.log'), 'utf8');
      expect(raw).toContain('"route":"remote:opencode-go"');
    });
    const line = JSON.parse(
      readFileSync(join(cwd, '.worklog', 'local-route.log'), 'utf8').trim(),
    );
    // The observable route log matches the default downtime preference.
    expect(line.preference).toBe('remote-ok');
  });

  it('writes no entry when no route header is present, even with the knob set (C4-AC2)', async () => {
    const { handlers } = await register();
    const cwd = makeTempCwd();
    process.env[ENV_VAR] = 'local-preferred';
    const response = handlers.after_provider_response as (
      event: Record<string, unknown>,
      c: unknown,
    ) => void;
    response({ status: 200, headers: { 'content-type': 'application/json' } }, ctx(cwd));
    // Give any accidental async append a chance to land, then assert absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(() =>
      readFileSync(join(cwd, '.worklog', 'local-route.log'), 'utf8'),
    ).toThrow();
  });

  it('writes no entry when the knob is unset (no header, no log — C4-AC3)', async () => {
    const { handlers } = await register();
    const cwd = makeTempCwd();
    const response = handlers.after_provider_response as (
      event: Record<string, unknown>,
      c: unknown,
    ) => void;
    response({ status: 200, headers: { 'x-local-route': 'local' } }, ctx(cwd));
    await new Promise((r) => setTimeout(r, 50));
    expect(() =>
      readFileSync(join(cwd, '.worklog', 'local-route.log'), 'utf8'),
    ).toThrow();
  });

  it('never throws on a capture or write failure (C4-AC3)', async () => {
    const { handlers } = await register();
    process.env[ENV_VAR] = 'local-preferred';
    const response = handlers.after_provider_response as (
      event: Record<string, unknown>,
      c: unknown,
    ) => void;
    // Unwritable cwd must not break the turn.
    expect(() =>
      response({ status: 200, headers: { 'x-local-route': 'local' } }, ctx('/nonexistent-root-none')),
    ).not.toThrow();
    // A malformed ctx (no session manager) must not break the turn either.
    expect(() =>
      response(
        { status: 200, headers: { 'x-local-route': 'local' } },
        { cwd: makeTempCwd() },
      ),
    ).not.toThrow();
  });
});
