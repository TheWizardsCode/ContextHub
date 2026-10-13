/**
 * Wiring tests for the durable model-cooldown signal in register-recovery.ts
 * (WL-0MV5638J1006URXA).
 *
 * The pure writer/derivation helpers are covered by retry-loop.test.ts. This
 * file verifies the actual recovery-loop wiring:
 *
 *  - an exhaustion SERVER_ERROR records a durable marker with the resolved
 *    `cooldownUntil` and the best-effort item id / kind;
 *  - a plain retryable 5xx writes nothing;
 *  - the next 2xx provider response clears the marker (via the fetch wrapper);
 *  - recording is best-effort: a failing writer never aborts the retry loop.
 *
 * The shared cooldown contract is mocked with a factory so the wiring is
 * asserted in isolation from the real on-disk I/O (covered by
 * `@worklog/shared/model-cooldown` tests).
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/model-cooldown-wiring.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_RECOVERY_CONFIG } from './error-patterns.js';

const sharedMocks = vi.hoisted(() => ({
  writeModelCooldown: vi.fn(() => true as boolean),
  clearModelCooldown: vi.fn(() => true as boolean),
  resolveMachineCoordinationDir: vi.fn(() => '/tmp/wl-cooldown-wiring'),
}));

vi.mock('@worklog/shared/model-cooldown', () => ({
  resolveMachineCoordinationDir: sharedMocks.resolveMachineCoordinationDir,
  writeModelCooldown: sharedMocks.writeModelCooldown,
  clearModelCooldown: sharedMocks.clearModelCooldown,
}));

const originalFetch = globalThis.fetch;

interface Handler {
  (event: unknown, ctx: unknown): unknown;
}

function makeHarness(): {
  pi: { on: (name: string, handler: Handler) => void; registerCommand: () => void };
  handlers: Map<string, Handler[]>;
} {
  const handlers = new Map<string, Handler[]>();
  return {
    pi: {
      on: (name, handler) => {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerCommand: () => {},
    },
    handlers,
  };
}

function makeCtx(entries: unknown[]) {
  return {
    ui: { notify: vi.fn() },
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => 'sess-1',
    },
    hasPendingMessages: () => false,
    isIdle: () => true,
  };
}

function userImplementEntry(): unknown {
  return { type: 'message', message: { role: 'user', content: '/skill:implement WL-0MV5638J1006URXA' } };
}

function assistantErrorEntry(errorMessage: string): unknown {
  return { type: 'message', message: { role: 'assistant', stopReason: 'error', errorMessage } };
}

async function registerAndTriggerAgentEnd(errorMessage: string): Promise<void> {
  vi.resetModules();
  const { registerRecoveryModule } = await import('./register-recovery.js');
  const { pi, handlers } = makeHarness();
  registerRecoveryModule(pi as never);

  const ctx = makeCtx([userImplementEntry(), assistantErrorEntry(errorMessage)]);
  for (const handler of handlers.get('agent_end') ?? []) {
    await handler({}, ctx);
  }
}

describe('register-recovery durable cooldown wiring', () => {
  beforeEach(() => {
    process.env.HERDR_PANE_ID = 'w1:pane';
    sharedMocks.writeModelCooldown.mockClear();
    sharedMocks.clearModelCooldown.mockClear();
    globalThis.fetch = vi.fn(async () => new Response('body', { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.HERDR_PANE_ID;
    globalThis.fetch = originalFetch;
  });

  it('records a marker for an exhaustion SERVER_ERROR with the resolved cooldownUntil and identity', async () => {
    const before = Date.now();
    await registerAndTriggerAgentEnd('All providers exhausted');

    expect(sharedMocks.writeModelCooldown).toHaveBeenCalledTimes(1);
    const [dir, entry] = sharedMocks.writeModelCooldown.mock.calls[0];
    expect(dir).toBe('/tmp/wl-cooldown-wiring');
    expect(entry).toMatchObject({
      paneId: 'w1:pane',
      sessionId: 'sess-1',
      itemId: 'WL-0MV5638J1006URXA',
      kind: 'implement',
      reason: 'provider exhaustion',
    });
    expect(entry.cooldownUntil).toBeGreaterThanOrEqual(
      before + DEFAULT_RECOVERY_CONFIG.cooldown.defaultMs,
    );
  });

  it('records nothing for a plain retryable 5xx', async () => {
    await registerAndTriggerAgentEnd('500 Internal Server Error');
    expect(sharedMocks.writeModelCooldown).not.toHaveBeenCalled();
  });

  it('records nothing for a timeout', async () => {
    await registerAndTriggerAgentEnd('Request timed out');
    expect(sharedMocks.writeModelCooldown).not.toHaveBeenCalled();
  });

  it('does not abort the retry loop when the marker cannot be written', async () => {
    sharedMocks.writeModelCooldown.mockReturnValueOnce(false);
    await expect(registerAndTriggerAgentEnd('All providers exhausted')).resolves.toBeUndefined();
    // The retry loop still ran (the handler returned normally, not thrown).
    expect(sharedMocks.writeModelCooldown).toHaveBeenCalledTimes(1);
  });

  it('clears the marker key on the next 2xx provider response', async () => {
    vi.resetModules();
    const { registerRecoveryModule } = await import('./register-recovery.js');
    const { pi, handlers } = makeHarness();
    registerRecoveryModule(pi as never);

    // Prime the current session id via the agent_end handler.
    const ctx = makeCtx([userImplementEntry(), assistantErrorEntry('All providers exhausted')]);
    for (const handler of handlers.get('agent_end') ?? []) {
      await handler({}, ctx);
    }
    sharedMocks.clearModelCooldown.mockClear();

    // The registered fetch wrapper observes a successful provider response.
    await (globalThis.fetch as typeof fetch)('http://example.test');

    expect(sharedMocks.clearModelCooldown).toHaveBeenCalledWith(
      '/tmp/wl-cooldown-wiring',
      'w1:pane',
      expect.any(Number),
    );
  });

  it('does not clear the marker on a retryable 5xx response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('body', { status: 502 })) as unknown as typeof fetch;
    vi.resetModules();
    const { registerRecoveryModule } = await import('./register-recovery.js');
    const { pi, handlers } = makeHarness();
    registerRecoveryModule(pi as never);

    const ctx = makeCtx([userImplementEntry(), assistantErrorEntry('All providers exhausted')]);
    for (const handler of handlers.get('agent_end') ?? []) {
      await handler({}, ctx);
    }
    sharedMocks.clearModelCooldown.mockClear();

    await (globalThis.fetch as typeof fetch)('http://example.test');

    expect(sharedMocks.clearModelCooldown).not.toHaveBeenCalled();
  });
});
