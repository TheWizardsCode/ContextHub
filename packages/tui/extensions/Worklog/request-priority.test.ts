/**
 * request-priority.test.ts — Pi Worklog extension `X-Priority` header
 * injection (test-first child WL-0MVF3PZNY003413F, parent WL-0MVE1NZ4J000H5NH,
 * AC4).
 *
 * The LLM proxy retired its global fast/cheap mode in favour of a per-request
 * `X-Priority` header (`low|medium|high`, default `medium`). Herdr conveys the
 * scheduled work item's priority to the pi session it launches as the
 * pane-launch environment variable `HERDR_REQUEST_PRIORITY`; this extension
 * module turns that variable into the provider request header.
 *
 * Contract (fixed by the parent AC):
 *  - valid `low` / `medium` / `high` → set `X-Priority` to that exact value;
 *  - unset / empty / any other value → leave the header map untouched (the
 *    proxy then applies its own `medium` default);
 *  - fail-open: never assume `high`, never throw.
 *
 * RED WITNESS. `request-priority.ts` does not exist yet, so the target specs
 * are committed under vitest's `it.fails(...)` (expected-failure) form — the
 * suite stays GREEN while the assertions are RED, the repo's documented TDD
 * pattern (see `packages/herdr/src/downtime-worker.assignee-claim.test.ts`).
 * The implementation child WL-0MVF3Q2YC003RJPF flips each `it.fails` to `it`
 * once the module lands.
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/request-priority.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Non-literal specifier so the not-yet-created module is loaded dynamically:
 * a missing module then fails the test BODY (expected) rather than breaking
 * the whole file at collection time.
 */
const MODULE_SPECIFIER = './request-priority.js';

interface RequestPriorityModule {
  /** Validate the pane-launch env var; `undefined` when absent/invalid. */
  resolveRequestPriority(
    env?: Record<string, string | undefined>,
  ): 'low' | 'medium' | 'high' | undefined;
  /** Register the `before_provider_headers` hook on the pi extension API. */
  registerRequestPriority(pi: {
    on(event: string, handler: (event: { headers: Record<string, string | null> }) => void): () => void;
  }): void;
}

async function loadModule(): Promise<RequestPriorityModule> {
  return (await import(MODULE_SPECIFIER)) as unknown as RequestPriorityModule;
}

/** A fresh outgoing header map (lower-case keys, as providers send them). */
function headers(): Record<string, string | null> {
  return { 'content-type': 'application/json' };
}

const ENV_VAR = 'HERDR_REQUEST_PRIORITY';

const originalEnvValue = process.env[ENV_VAR];

beforeEach(() => {
  delete process.env[ENV_VAR];
});

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = originalEnvValue;
  }
});

// ── Value validation ─────────────────────────────────────────────────────

describe('resolveRequestPriority (WL-0MVF3PZNY003413F AC1/AC2)', () => {
  it.fails('accepts the three proxy priorities verbatim', async () => {
    const { resolveRequestPriority } = await loadModule();
    expect(resolveRequestPriority({ [ENV_VAR]: 'low' })).toBe('low');
    expect(resolveRequestPriority({ [ENV_VAR]: 'medium' })).toBe('medium');
    expect(resolveRequestPriority({ [ENV_VAR]: 'high' })).toBe('high');
  });

  it.fails('returns undefined when the variable is unset or empty', async () => {
    const { resolveRequestPriority } = await loadModule();
    expect(resolveRequestPriority({})).toBeUndefined();
    expect(resolveRequestPriority({ [ENV_VAR]: '' })).toBeUndefined();
  });

  it.fails('rejects any other value (fail-open, never assumes high)', async () => {
    const { resolveRequestPriority } = await loadModule();
    for (const invalid of ['fast', 'cheap', 'HIGH', 'High', 'critical', ' high', 'high ', '1']) {
      expect(resolveRequestPriority({ [ENV_VAR]: invalid })).toBeUndefined();
    }
  });
});

// ── Header injection through the registered hook ─────────────────────────

describe('before_provider_headers injection (WL-0MVF3PZNY003413F AC1/AC2)', () => {
  /** Register the module against a mock extension API and return the hook. */
  async function register(): Promise<
    (event: { headers: Record<string, string | null> }) => void
  > {
    const { registerRequestPriority } = await loadModule();
    const listeners: Record<string, (event: { headers: Record<string, string | null> }) => void> = {};
    registerRequestPriority({
      on(event, handler) {
        listeners[event] = handler;
        return () => { delete listeners[event]; };
      },
    });
    expect(listeners.before_provider_headers).toBeTypeOf('function');
    return listeners.before_provider_headers;
  }

  it.fails('sets X-Priority to the valid env value on every request', async () => {
    process.env[ENV_VAR] = 'low';
    const hook = await register();
    const h1 = headers();
    hook({ headers: h1 });
    expect(h1['X-Priority']).toBe('low');

    // The value is read per request, not cached at registration.
    process.env[ENV_VAR] = 'high';
    const h2 = headers();
    hook({ headers: h2 });
    expect(h2['X-Priority']).toBe('high');
  });

  it.fails('leaves the header map untouched when the variable is unset', async () => {
    const hook = await register();
    const h = headers();
    hook({ headers: h });
    expect(h).toEqual({ 'content-type': 'application/json' });
    expect(h).not.toHaveProperty('X-Priority');
  });

  it.fails('leaves the header map untouched for an invalid value', async () => {
    process.env[ENV_VAR] = 'turbo';
    const hook = await register();
    const h = headers();
    hook({ headers: h });
    expect(h).toEqual({ 'content-type': 'application/json' });
    expect(h).not.toHaveProperty('X-Priority');
  });

  it.fails('never throws (a broken header hook must not break requests)', async () => {
    process.env[ENV_VAR] = 'medium';
    const hook = await register();
    expect(() => hook({ headers: headers() })).not.toThrow();
  });
});

// ── Registration wiring ──────────────────────────────────────────────────

describe('extension registration (WL-0MVF3PZNY003413F AC3)', () => {
  it.fails('registers exactly one before_provider_headers listener', async () => {
    const { registerRequestPriority } = await loadModule();
    const on = vi.fn(() => () => {});
    registerRequestPriority({ on });
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0][0]).toBe('before_provider_headers');
  });
});
