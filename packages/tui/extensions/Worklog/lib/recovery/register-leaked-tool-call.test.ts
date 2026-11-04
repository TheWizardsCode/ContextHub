/**
 * Wiring tests for the leaked tool-call recovery handlers.
 *
 * Covers WL-0MW109HU60042BVW AC4 (registration, exactly one warning, skipped
 * when aborted / when `ctx.ui` is unavailable, idempotent replay) and
 * WL-0MW109J84000QJOJ AC1–AC5 (the bounded corrective-continue fallback) against
 * a mocked `ExtensionAPI` — no Pi runtime involved.
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

/** Complete markup for a tool that is *not* active: repair refuses it. */
const COMPLETE_BASH_LEAK = `<tool_call>
<function=bash>
<parameter=command>
ls -la /tmp/leaked
</parameter>
</function>
</tool_call>`;

/** Half-streamed markup: the `<parameter=command>` value never terminates. */
const UNTERMINATED_BASH_LEAK = `<tool_call>
<function=bash>
<parameter=command>
ls -la /tmp/leaked
</function>
</tool_call>`;

/** Markup quoted inside a fenced code block — prose, not a leak. */
const QUOTED_LEAK = ['Here is the dialect:', '```text', COMPLETE_BASH_LEAK, '```'].join('\n');

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

/** Pi 0.79.10 `turn_end` event shape (no boundary-result API). */
function legacyTurnEnd(message: any, overrides: Record<string, unknown> = {}): any {
  return { type: 'turn_end', turnIndex: 0, message, toolResults: [], ...overrides };
}

/** Pi ≥1.5 `turn_end` event shape (`TurnEndEvent extends BoundaryState`). */
function boundaryTurnEnd(message: any, overrides: Record<string, unknown> = {}): any {
  return {
    type: 'turn_end',
    turnIndex: 0,
    message,
    toolResults: [],
    messageEntryId: 'message-entry-1',
    toolResultEntryIds: [],
    entries: [],
    continue: false,
    context: {
      contextEntries: [],
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: true,
    },
    outcome: 'completed',
    ...overrides,
  };
}

function makeMockAgent(messages: any[] = []) {
  const prompt = vi.fn(async () => undefined);
  const waitForIdle = vi.fn(async () => undefined);
  return { agent: { prompt, waitForIdle, state: { messages } }, prompt, waitForIdle };
}

/** Let the deferred invisible-continue transport run (one macrotask). */
function flushDeferred(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Fresh module per test ─────────────────────────────────────────────
// The registration module is intentionally idempotent (module-level
// `_registered` flag) and keeps per-session state in module scope, so each
// test must evaluate a fresh copy.

let registerLeakedToolCallRecovery: (pi: any) => void;
let setContinuationAgent: (agent: any) => void;
let detectBoundaryResultSupport: (event: any) => boolean;
let interruptibleState: { userAborted: boolean; sessionGeneration: number };

beforeEach(async () => {
  vi.resetModules();
  ({
    registerLeakedToolCallRecovery,
    setContinuationAgent,
    detectBoundaryResultSupport,
  } = await import('./register-leaked-tool-call.js'));
  ({ interruptibleState } = await import('./retry-command.js'));
  interruptibleState.userAborted = false;
});

/** Run `message_end` for a message the repair handler cannot fix. */
async function recordMissed(
  mock: ReturnType<typeof makeMockPi>,
  ctx: any,
  text: string = COMPLETE_BASH_LEAK,
): Promise<any> {
  const message = assistantMessage(text);
  const result = await mock.emit('message_end', { type: 'message_end', message }, ctx);
  // Refused calls keep their markup, so nothing is returned for replacement.
  expect(result).toBeUndefined();
  return message;
}

// ── Registration ──────────────────────────────────────────────────────

describe('registerLeakedToolCallRecovery — registration', () => {
  it('registers one handler per lifecycle event', () => {
    const mock = makeMockPi();

    registerLeakedToolCallRecovery(mock.pi as any);

    expect(mock.pi.on.mock.calls.map((call) => call[0])).toEqual([
      'message_end',
      'turn_end',
      'session_start',
    ]);
    expect(mock.getHandlers('message_end')).toHaveLength(1);
    expect(mock.getHandlers('turn_end')).toHaveLength(1);
    expect(mock.getHandlers('session_start')).toHaveLength(1);
  });

  it('is idempotent when registered twice', () => {
    const mock = makeMockPi();

    registerLeakedToolCallRecovery(mock.pi as any);
    registerLeakedToolCallRecovery(mock.pi as any);

    expect(mock.getHandlers('message_end')).toHaveLength(1);
    expect(mock.getHandlers('turn_end')).toHaveLength(1);
    expect(mock.getHandlers('session_start')).toHaveLength(1);
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

// ── Capability detection (AC3) ────────────────────────────────────────

describe('detectBoundaryResultSupport', () => {
  it('detects the boundary-result API from a Pi ≥1.5 turn_end event', () => {
    expect(detectBoundaryResultSupport(boundaryTurnEnd(assistantMessage('x')))).toBe(true);
  });

  it('reports no support for the pinned 0.79.10 turn_end event shape', () => {
    expect(detectBoundaryResultSupport(legacyTurnEnd(assistantMessage('x')))).toBe(false);
  });

  it('reports no support for malformed events', () => {
    expect(detectBoundaryResultSupport(undefined)).toBe(false);
    expect(detectBoundaryResultSupport({})).toBe(false);
    expect(detectBoundaryResultSupport({ entries: [], context: {} })).toBe(false);
  });
});

// ── Corrective-continue fallback (AC1, AC2, AC3, AC4, AC5) ────────────

describe('turn_end fallback', () => {
  it('issues one corrective continuation through the boundary result', async () => {
    const mock = makeMockPi(['read']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = await recordMissed(mock, ctx);
    const result = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    expect(result?.continue).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      type: 'custom_message',
      customType: 'leaked-tool-call-corrective',
      display: false,
    });
    // AC1: the corrective text names the missed call with its first argument.
    expect(result.entries[0].content).toContain('bash(command=ls -la /tmp/leaked)');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('warning');
  });

  it('uses the invisible-continue path when the boundary-result API is absent', async () => {
    const mock = makeMockPi(['read']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = await recordMissed(mock, ctx);
    const { agent, prompt, waitForIdle } = makeMockAgent([message]);
    setContinuationAgent(agent);

    const result = await mock.emit('turn_end', legacyTurnEnd(message), ctx);
    expect(result).toBeUndefined();

    await flushDeferred();

    expect(waitForIdle).toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
    const sent = prompt.mock.calls[0][0] as unknown[];
    expect(Array.isArray(sent)).toBe(true);
    expect(String(sent[0])).toContain('bash(command=ls -la /tmp/leaked)');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('names a truncated call without inventing arguments', async () => {
    const mock = makeMockPi(['bash']);
    const { ctx } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = await recordMissed(mock, ctx, UNTERMINATED_BASH_LEAK);
    const result = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    expect(result?.continue).toBe(true);
    expect(result.entries[0].content).toContain('Missed call: bash.');
  });

  it('truncates a long argument in the corrective text', async () => {
    const mock = makeMockPi(['read']);
    const { ctx } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const longCommand = 'x'.repeat(200);
    const message = await recordMissed(
      mock,
      ctx,
      `<function=bash>\n<parameter=command>\n${longCommand}\n</parameter>\n</function>`,
    );
    const result = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    const content: string = result.entries[0].content;
    expect(content).toContain('…');
    expect(content).not.toContain(longCommand);
  });

  it('never fires twice for the same assistant message', async () => {
    const mock = makeMockPi(['read']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = await recordMissed(mock, ctx);
    const first = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);
    const second = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    expect(first?.continue).toBe(true);
    expect(second).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the message already produced tool results', async () => {
    const mock = makeMockPi(['read']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = await recordMissed(mock, ctx);
    const result = await mock.emit(
      'turn_end',
      boundaryTurnEnd(message, {
        toolResults: [{ role: 'toolResult', toolCallId: 'call_1', content: [] }],
      }),
      ctx,
    );

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not fire when the run was aborted', async () => {
    const mock = makeMockPi(['read']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = await recordMissed(mock, ctx);
    interruptibleState.userAborted = true;

    const result = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not fire for a message the repair handler fixed', async () => {
    const mock = makeMockPi(['read', 'bash']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const repaired = await mock.emit(
      'message_end',
      { type: 'message_end', message: assistantMessage(COMPLETE_BASH_LEAK) },
      ctx,
    );
    expect(repaired?.message).toBeDefined();

    const result = await mock.emit('turn_end', boundaryTurnEnd(repaired.message), ctx);

    expect(result).toBeUndefined();
    // Only the repair notification — no fallback event.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not fire for quoted markup', async () => {    const mock = makeMockPi(['read']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = assistantMessage(QUOTED_LEAK);
    await mock.emit('message_end', { type: 'message_end', message }, ctx);
    const result = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not fire for a message another recovery path already owns', async () => {
    const mock = makeMockPi(['read']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    // `length` (max tokens) is handled by the compaction/continue machinery;
    // a second corrective prompt here would race it.
    const message = assistantMessage(COMPLETE_BASH_LEAK, { stopReason: 'length' });
    await mock.emit('message_end', { type: 'message_end', message }, ctx);
    const result = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not fire for a markup-free message', async () => {
    const mock = makeMockPi();
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = assistantMessage('All done, nothing to call.');
    await mock.emit('message_end', { type: 'message_end', message }, ctx);
    const result = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    expect(result).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('stops at the session cap and warns exactly once', async () => {
    const mock = makeMockPi(['read']);
    const { ctx, notify } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const continuations: Array<unknown> = [];
    for (let index = 0; index < 6; index += 1) {
      const message = await recordMissed(
        mock,
        ctx,
        COMPLETE_BASH_LEAK.replace('/tmp/leaked', `/tmp/leaked-${index}`),
      );
      continuations.push(await mock.emit('turn_end', boundaryTurnEnd(message), ctx));
    }

    // Default cap is 5: five continuations, then the cap stops the sixth.
    expect(continuations.slice(0, 5).every((result: any) => result?.continue === true)).toBe(true);
    expect(continuations[5]).toBeUndefined();

    const capWarnings = notify.mock.calls.filter((call) => String(call[0]).includes('cap reached'));
    expect(capWarnings).toHaveLength(1);
    expect(String(capWarnings[0][0])).toContain('5');
    // Five continuation warnings plus the single cap warning.
    expect(notify).toHaveBeenCalledTimes(6);
  });

  it('resets the cap counter on session_start', async () => {
    const mock = makeMockPi(['read']);
    const { ctx } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    for (let index = 0; index < 5; index += 1) {
      const message = await recordMissed(
        mock,
        ctx,
        COMPLETE_BASH_LEAK.replace('/tmp/leaked', `/tmp/leaked-${index}`),
      );
      expect((await mock.emit('turn_end', boundaryTurnEnd(message), ctx))?.continue).toBe(true);
    }

    await mock.emit('session_start', { type: 'session_start' }, ctx);

    const message = await recordMissed(mock, ctx, COMPLETE_BASH_LEAK.replace('/tmp/leaked', '/tmp/fresh'));
    const result = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    expect(result?.continue).toBe(true);
  });

  it('still continues when the notification throws on a stale ctx', async () => {
    const mock = makeMockPi(['read']);
    const ctx = {
      ui: {
        notify: vi.fn(() => {
          throw new Error('This extension ctx is stale after session replacement or reload');
        }),
      },
    };
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = await recordMissed(mock, ctx as any);
    const result = await mock.emit('turn_end', boundaryTurnEnd(message), ctx);

    expect(result?.continue).toBe(true);
  });

  it('skips the invisible continue when the agent already moved past the message', async () => {
    const mock = makeMockPi(['read']);
    const { ctx } = makeMockCtx();
    registerLeakedToolCallRecovery(mock.pi as any);

    const message = await recordMissed(mock, ctx);
    // The agent state ends with a *newer* assistant message: the loop moved on.
    const { agent, prompt } = makeMockAgent([message, assistantMessage('retried on its own')]);
    setContinuationAgent(agent);

    await mock.emit('turn_end', legacyTurnEnd(message), ctx);
    await flushDeferred();

    expect(prompt).not.toHaveBeenCalled();
  });
});
