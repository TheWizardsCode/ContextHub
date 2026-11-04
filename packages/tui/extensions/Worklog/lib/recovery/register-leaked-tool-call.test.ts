/**
 * Wiring tests for the leaked tool-call recovery `message_end` handler.
 *
 * Covers WL-0MW109HU60042BVW AC4 (registration, exactly one warning, skipped
 * when aborted / when `ctx.ui` is unavailable, idempotent replay) against a
 * mocked `ExtensionAPI` — no Pi runtime involved.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/register-leaked-tool-call.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock ExtensionAPI ─────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => Promise<any> | any;

function makeMockPi(activeTools: string[] = ['read', 'bash']) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }),
    getActiveTools: vi.fn(() => activeTools),
  };
  return {
    pi,
    getHandlers(event: string): Handler[] {
      return handlers.get(event) ?? [];
    },
    async emit(event: string, payload: any, ctx: any) {
      const registered = handlers.get(event) ?? [];
      let result: any;
      for (const handler of registered) {
        const handlerResult = await handler(payload, ctx);
        if (handlerResult !== undefined) result = handlerResult;
      }
      return result;
    },
  };
}

function makeMockCtx() {
  const notify = vi.fn();
  return { ctx: { ui: { notify } }, notify };
}

const LEAK = `<tool_call>
<function=read>
<parameter=path>
 /tmp/leaked-target.txt
</parameter>
</function>
</tool_call>`;

function assistantMessage(text: string, overrides: Record<string, unknown> = {}): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'local-proxy',
    model: 'qwen-fake',
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function toolCallsOf(message: any): any[] {
  return (message?.content ?? []).filter((block: any) => block.type === 'toolCall');
}

// ── Fresh module per test ─────────────────────────────────────────────
// The registration module is intentionally idempotent (module-level
// `_registered` flag), so each test must evaluate a fresh copy.

let registerLeakedToolCallRecovery: (pi: any) => void;
let interruptibleState: { userAborted: boolean };

beforeEach(async () => {
  vi.resetModules();
  ({ registerLeakedToolCallRecovery } = await import('./register-leaked-tool-call.js'));
  ({ interruptibleState } = await import('./retry-command.js'));
  interruptibleState.userAborted = false;
});

// ── Registration ──────────────────────────────────────────────────────

describe('registerLeakedToolCallRecovery — registration', () => {
  it('registers exactly one message_end handler', () => {
    const mock = makeMockPi();

    registerLeakedToolCallRecovery(mock.pi as any);

    expect(mock.pi.on).toHaveBeenCalledTimes(1);
    expect(mock.pi.on.mock.calls[0][0]).toBe('message_end');
    expect(mock.getHandlers('message_end')).toHaveLength(1);
  });

  it('is idempotent when registered twice', () => {
    const mock = makeMockPi();

    registerLeakedToolCallRecovery(mock.pi as any);
    registerLeakedToolCallRecovery(mock.pi as any);

    expect(mock.getHandlers('message_end')).toHaveLength(1);
  });
});

// ── Repair + notify (AC1, AC4, AC5) ───────────────────────────────────

describe('message_end handler', () => {
  it('returns a repaired message and notifies exactly once', async () => {
    const mock = makeMockPi();
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const result = await mock.emit('message_end', { type: 'message_end', message: assistantMessage(LEAK) }, ctx);

    expect(result?.message).toBeDefined();
    expect(result.message.stopReason).toBe('toolUse');
    expect(toolCallsOf(result.message)).toHaveLength(1);
    expect(toolCallsOf(result.message)[0]).toMatchObject({
      type: 'toolCall',
      name: 'read',
      arguments: { path: '/tmp/leaked-target.txt' },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('read');
    expect(notify.mock.calls[0][1]).toBe('warning');
  });

  it('names every recovered call in the single notification', async () => {
    const mock = makeMockPi();
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const text = `${LEAK}\n<function=bash>\n<parameter=command>\nls\n</parameter>\n</function>`;
    const result = await mock.emit('message_end', { type: 'message_end', message: assistantMessage(text) }, ctx);

    expect(toolCallsOf(result.message)).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('read');
    expect(notify.mock.calls[0][0]).toContain('bash');
  });

  it('is a no-op for markup-free text', async () => {
    const mock = makeMockPi();
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const result = await mock.emit('message_end', { type: 'message_end', message: assistantMessage('Plain answer.') }, ctx);

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores non-assistant messages', async () => {
    const mock = makeMockPi();
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const result = await mock.emit(
      'message_end',
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: LEAK }] } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('is skipped entirely when the run was aborted', async () => {
    const mock = makeMockPi();
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);
    interruptibleState.userAborted = true;

    const result = await mock.emit('message_end', { type: 'message_end', message: assistantMessage(LEAK) }, ctx);

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('is skipped entirely when ctx.ui is unavailable', async () => {
    const mock = makeMockPi();
    registerLeakedToolCallRecovery(mock.pi as any);

    const result = await mock.emit('message_end', { type: 'message_end', message: assistantMessage(LEAK) }, {});

    expect(result).toBeUndefined();
  });

  it('does not synthesise a call for an inactive tool', async () => {
    const mock = makeMockPi(['read']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const text = '<function=bash>\n<parameter=command>\nls\n</parameter>\n</function>';
    const result = await mock.emit('message_end', { type: 'message_end', message: assistantMessage(text) }, ctx);

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not synthesise a call when no tools are active', async () => {
    const mock = makeMockPi([]);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const result = await mock.emit('message_end', { type: 'message_end', message: assistantMessage(LEAK) }, ctx);

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('is idempotent on replay', async () => {
    const mock = makeMockPi();
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const first = await mock.emit('message_end', { type: 'message_end', message: assistantMessage(LEAK) }, ctx);
    const second = await mock.emit('message_end', { type: 'message_end', message: first.message }, ctx);

    expect(second).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(toolCallsOf(first.message)).toHaveLength(1);
  });

  it('still repairs when the notification throws on a stale ctx', async () => {
    const mock = makeMockPi();
    const ctx = {
      ui: {
        notify: vi.fn(() => {
          throw new Error('This extension ctx is stale after session replacement or reload');
        }),
      },
    };
    registerLeakedToolCallRecovery(mock.pi as any);

    const result = await mock.emit('message_end', { type: 'message_end', message: assistantMessage(LEAK) }, ctx);

    expect(result?.message).toBeDefined();
    expect(toolCallsOf(result.message)).toHaveLength(1);
  });
});
