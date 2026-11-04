/**
 * Tripwire: a leaked tool call repaired at `message_end` actually executes.
 *
 * WL-0MW109HU60042BVW AC1. This is the contract proof for the undocumented Pi
 * behaviour the recovery depends on: `AgentSession._replaceMessageInPlace()`
 * copies the message returned by a `message_end` handler onto the finalised
 * assistant message *before* `agent-loop.js` reads
 * `message.content.filter(c => c.type === 'toolCall')`.
 *
 * The test drives the real `runAgentLoop` from the repo's pinned
 * `@earendil-works/pi-agent-core` with a scripted fake stream that emits the
 * leaked markup, and a recording tool executor. The `emit` sink mirrors what
 * `agent-session.js` does with a handler result. Two negative cases pin the
 * tripwire: if the repair is not applied, or if the replacement is applied to
 * a copy instead of in place, the tool must not execute — so a Pi upgrade that
 * changes the contract fails this file loudly.
 *
 * No network, no real model, no wall-clock dependence.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/leaked-tool-call.execution.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runAgentLoop } from '@earendil-works/pi-agent-core';

import { registerLeakedToolCallRecovery } from './register-leaked-tool-call.js';
import { interruptibleState } from './retry-command.js';

// ── Fixtures ──────────────────────────────────────────────────────────

/** The live leak shape, reduced to a single `read` call. */
const LEAKED_MARKUP = `<response>
 <tool_call>
 <function=read>
 <parameter=path>
 /tmp/leaked-target.txt
 </parameter>
 </function>
 </tool_call>
</response>`;

const MODEL = {
  id: 'fake-model',
  name: 'fake-model',
  provider: 'fake-provider',
  api: 'fake-api',
} as any;

function assistantText(text: string, stopReason = 'stop'): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'fake-api',
    provider: 'fake-provider',
    model: 'fake-model',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

function userPrompt(): any {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'read the file' }],
    timestamp: Date.now(),
  };
}

/**
 * Scripted stream: yields `messages[call]` (clamped to the last entry) on
 * each provider request, so a loop that asks for a follow-up turn terminates.
 */
function fakeStreamFn(messages: any[]) {
  let call = 0;
  return async () => {
    const message = messages[Math.min(call, messages.length - 1)];
    call += 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: { ...message, content: [{ type: 'text', text: '' }] } };
        yield { type: 'done', reason: 'stop', message };
      },
      result: async () => message,
    };
  };
}

/** Recording `read` tool; terminates the batch so one turn proves the point. */
function makeReadTool() {
  const executions: Array<Record<string, unknown>> = [];
  const tool = {
    name: 'read',
    label: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    execute: vi.fn(async (_id: string, params: Record<string, unknown>) => {
      executions.push(params);
      return { content: [{ type: 'text', text: 'file contents' }], details: {}, terminate: true };
    }),
  };
  return { tool, executions };
}

// ── Agent-session contract mirror ─────────────────────────────────────

/** Mirrors `AgentSession._replaceMessageInPlace()` (agent-session.js). */
function replaceMessageInPlace(target: any, replacement: any): void {
  if (target === replacement) return;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

interface MockPi {
  on: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
  handlers: Record<string, Array<(event: any, ctx: any) => any>>;
}

function makeMockPi(activeTools: string[]): MockPi {
  const handlers: MockPi['handlers'] = {};
  const pi = {
    on: vi.fn((event: string, handler: any) => {
      (handlers[event] ??= []).push(handler);
    }),
    getActiveTools: vi.fn(() => activeTools),
    handlers,
  };
  return pi as unknown as MockPi;
}

// The extension registers its handlers once at initialisation (module-level
// idempotence guard), so every scenario shares the same registered mock.
let sharedPi: MockPi | null = null;

function getRegisteredPi(): MockPi {
  if (!sharedPi) {
    sharedPi = makeMockPi(['read', 'bash']);
    registerLeakedToolCallRecovery(sharedPi as any);
  }
  return sharedPi;
}

type ContractMode = 'in-place' | 'copy' | 'repair-bypassed';

/**
 * Build the `emit` sink for `runAgentLoop`.
 *
 * - `in-place`: what Pi does today — the handler result is copied onto the
 *   finalised message object the loop is holding.
 * - `copy`: a future Pi that only swaps its own event payload; the loop's
 *   message is unchanged (contract drift).
 * - `repair-bypassed`: no handler runs at all.
 */
function makeEmit(
  pi: MockPi,
  mode: ContractMode,
  notify: (message: string, level: string) => void,
) {
  const handler = pi.handlers['message_end']?.[0];
  return async (event: any): Promise<void> => {
    if (mode === 'repair-bypassed') return;
    if (event?.type !== 'message_end' || !handler) return;
    const result = await handler({ type: 'message_end', message: event.message }, { ui: { notify } });
    if (!result?.message) return;
    if (mode === 'in-place') replaceMessageInPlace(event.message, result.message);
    else event.message = result.message;
  };
}

async function runScenario(mode: ContractMode) {
  const { tool, executions } = makeReadTool();
  const pi = getRegisteredPi();

  const notify = vi.fn();
  const streamFn = fakeStreamFn([
    assistantText(LEAKED_MARKUP),
    // Only reached when the tool batch does not terminate — i.e. a loop that
    // did not execute anything and asked the model again.
    assistantText('Nothing to run.'),
  ]);

  const newMessages = await runAgentLoop(
    [userPrompt()],
    { systemPrompt: '', messages: [], tools: [tool as any] },
    { model: MODEL, convertToLlm: async (messages: any[]) => messages } as any,
    makeEmit(pi, mode, notify),
    undefined,
    streamFn as any,
  );

  return { executions, notify, newMessages, tool };
}

// ── Tests ─────────────────────────────────────────────────────────────

beforeEach(() => {
  interruptibleState.userAborted = false;
});

describe('leaked tool call executes through runAgentLoop', () => {
  it('executes the recovered call exactly once when the repair is applied in place', async () => {
    const { executions, notify } = await runScenario('in-place');

    expect(executions).toHaveLength(1);
    expect(executions[0]).toEqual({ path: '/tmp/leaked-target.txt' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]).toBe('warning');
  });

  it('leaves the assistant message repaired in the returned transcript', async () => {
    const { newMessages } = await runScenario('in-place');

    const assistant = newMessages.find((message: any) => message.role === 'assistant') as any;
    expect(assistant.stopReason).toBe('toolUse');
    expect(assistant.content.some((block: any) => block.type === 'toolCall')).toBe(true);
    expect(JSON.stringify(assistant.content)).not.toContain('<function=read>');
  });

  it('fails the tripwire if the repair is bypassed — nothing executes', async () => {
    const { executions, notify } = await runScenario('repair-bypassed');

    expect(executions).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('fails the tripwire if the replacement is not applied in place — nothing executes', async () => {
    const { executions } = await runScenario('copy');

    expect(executions).toHaveLength(0);
  });
});
