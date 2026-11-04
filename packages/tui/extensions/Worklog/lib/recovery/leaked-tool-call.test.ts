/**
 * Unit tests for the pure leaked tool-call parser and message transformer.
 *
 * Covers WL-0MW109HU60042BVW AC1 (detect and repair), AC2 (never execute a
 * truncated or inactive call) and AC5 (markup-free text untouched, replay
 * idempotent). No Pi imports and no Pi runtime — the module is pure.
 *
 * Run: cd /home/rgardler/projects/ContextHub && npx vitest run packages/tui/extensions/Worklog/lib/recovery/leaked-tool-call.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  LEAKED_TOOL_CALL_CONFIG,
  LEAKED_TOOL_CALL_DIALECTS,
  MAX_NOTE_ARG_LENGTH,
  RECOVERY_NOTE_PREFIX,
  formatRecoveryNote,
  parseLeakedToolCalls,
  repairAssistantMessage,
} from './leaked-tool-call.js';

// ── Fixtures ──────────────────────────────────────────────────────────

/**
 * The shape observed live on the Pi TUI (operator report, 2026-11-03):
 * two calls inside one `<response>` wrapper, the second `</tool_call>` closer
 * immediately followed by the next `<tool_call>` opener. The operator's exact
 * sample is kept verbatim as `OPERATOR_RESPONSE_SAMPLE` below (AC1 fixture).
 */
const LIVE_LEAK = `<response>

 <tool_call>
 <function=read>
 <parameter=path>
 /home/rgardler/.pi/agent/skills/implement/SKILL.md
 </parameter>
 </function>
 </tool_call><tool_call>
 <function=bash>
 <parameter=command>
 cd /home/rgardler/projects/ContextHub && wl show WL-0MVGKGU19004NTHB --json 2>&1
 </parameter>
 </function>
 </tool_call>
</response>`;

/** The corpus shape: no `<tool_call>` opener at all, opener-less fragment. */
const MISSING_OPENER_LEAK = `<function=read>
 <parameter=path>
 /tmp/leaked-target.txt
 </parameter>
</function></tool_call>`;

/** A well-formed single call. */
const COMPLETE_BLOCK = `<tool_call>
<function=bash>
<parameter=command>
ls -la
</parameter>
</function>
</tool_call>`;

/** Active tools used by most tests. */
const ACTIVE_TOOLS = ['read', 'bash'] as const;

// ── Fixtures: AC1 dialect matrix ──────────────────────────────────────

/**
 * The operator's exact `<response>` sample from the parent item
 * (WL-0MW0WBWY3006LQ8W, 2026-11-03) — copied byte-for-byte, trailing newline
 * included. Note the missing `</response>` closer and the two `<tool_call>`
 * wrappers adjacent with no separator: both are real, not typos.
 */
const OPERATOR_RESPONSE_SAMPLE = `<response>

 <tool_call>
 <function=read>
 <parameter=path>
 /home/rgardler/.pi/agent/skills/implement/SKILL.md
 </parameter>
 </function>
 </tool_call><tool_call>
 <function=bash>
 <parameter=command>
 cd /home/rgardler/projects/ContextHub && wl show WL-0MVGKGU19004NTHB --json 2>&1
 </parameter>
 </function>
 </tool_call>
`;

/** Indentation and blank-line variance around an otherwise complete call. */
const INDENTED_LEAK = `   <tool_call>
\t<function=read>

\t   <parameter=path>

\t      /tmp/indented.txt

\t   </parameter>
\t</function>
   </tool_call>`;

/** Two complete blocks adjacent with no separator at all. */
const ADJACENT_LEAK =
  '<function=bash><parameter=command>ls</parameter></function></tool_call><tool_call>' +
  '<function=read><parameter=path>/etc/hosts</parameter></function></tool_call>';

/** A half-streamed `bash` sample: the closer arrived truncated (`</param`). */
const TRUNCATED_BASH_LEAK = `<tool_call>
 <function=bash>
 <parameter=command>
 rm -rf /tmp/important
 </param`;

// ── Fixtures: AC2 false-positive guard ────────────────────────────────

/** The markup inside a fenced code span — prose *about* markup, not a leak. */
const FENCED_LEAK = `The shape we recover looks like this:

\`\`\`text
<tool_call>
<function=bash>
<parameter=command>
rm -rf /tmp/example
</parameter>
</function>
</tool_call>
\`\`\`

Nothing in that block is executed by the model.`;

/** The markup inside an inline code span. */
const INLINE_CODE_LEAK =
  'Inline prose keeps the tag inert: `<function=read><parameter=path>/etc/hosts</parameter></function>`.';

/** The markup inside a markdown blockquote — a quoted example. */
const BLOCKQUOTE_LEAK = `> <tool_call>
> <function=bash>
> <parameter=command>
> rm -rf /tmp/example
> </parameter>
> </function>
> </tool_call>`;

/** The markup quoted inside a sentence. */
const DOUBLE_QUOTED_LEAK =
  'The operator pasted "<function=bash><parameter=command>rm -rf /tmp/example</parameter></function>" and nothing ran.';

function assistantMessage(
  text: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'local-proxy',
    model: 'qwen-fake',
    usage: { input: 11, output: 22, cacheRead: 0, cacheWrite: 0 },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function textOf(message: any): string {
  return message.content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('\n');
}

function toolCallsOf(message: any): any[] {
  return message.content.filter((block: any) => block.type === 'toolCall');
}

// ── parseLeakedToolCalls ──────────────────────────────────────────────

describe('parseLeakedToolCalls', () => {
  it('parses the live two-call leak, trimming parameter values', () => {
    const calls = parseLeakedToolCalls(LIVE_LEAK);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.name)).toEqual(['read', 'bash']);
    expect(calls[0].arguments).toEqual({
      path: '/home/rgardler/.pi/agent/skills/implement/SKILL.md',
    });
    expect(calls[1].arguments).toEqual({
      command: 'cd /home/rgardler/projects/ContextHub && wl show WL-0MVGKGU19004NTHB --json 2>&1',
    });
    expect(calls.every((call) => call.complete)).toBe(true);
  });

  it('parses a complete single block', () => {
    const [call] = parseLeakedToolCalls(COMPLETE_BLOCK);

    expect(call.name).toBe('bash');
    expect(call.arguments).toEqual({ command: 'ls -la' });
    expect(call.complete).toBe(true);
    expect(call.reason).toBeUndefined();
  });

  it('parses a fragment with no <tool_call> opener', () => {
    const calls = parseLeakedToolCalls(MISSING_OPENER_LEAK);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read');
    expect(calls[0].arguments).toEqual({ path: '/tmp/leaked-target.txt' });
    expect(calls[0].complete).toBe(true);
  });

  it('parses a fragment with no </function> and no </tool_call> closers', () => {
    const calls = parseLeakedToolCalls(
      '<function=read>\n<parameter=path>\n/etc/hosts\n</parameter>\n',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].complete).toBe(true);
    expect(calls[0].arguments).toEqual({ path: '/etc/hosts' });
  });

  it('marks an unterminated parameter complete: false', () => {
    const calls = parseLeakedToolCalls(
      '<function=bash>\n<parameter=command>\nrm -rf /tmp/x\n',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].complete).toBe(false);
    expect(calls[0].reason).toBe('unterminated-parameter');
  });

  it('marks a function block with no parameters complete: false', () => {
    const calls = parseLeakedToolCalls('<tool_call>\n<function=read>\n</function>\n</tool_call>');

    expect(calls).toHaveLength(1);
    expect(calls[0].complete).toBe(false);
    expect(calls[0].reason).toBe('missing-parameter');
  });

  it('returns nothing for markup-free text', () => {
    expect(parseLeakedToolCalls('Just a normal answer about <functions> and XML.')).toEqual([]);
    expect(parseLeakedToolCalls('')).toEqual([]);
  });

  it('does not leak a shared regex lastIndex between calls', () => {
    const first = parseLeakedToolCalls(COMPLETE_BLOCK);
    const second = parseLeakedToolCalls(COMPLETE_BLOCK);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].arguments).toEqual({ command: 'ls -la' });
  });

  it('exposes the dialect table at module scope', () => {
    expect(LEAKED_TOOL_CALL_DIALECTS.map((dialect) => dialect.id)).toContain(
      'hermes-qwen-xml',
    );
  });
});

// ── formatRecoveryNote ────────────────────────────────────────────────

describe('formatRecoveryNote', () => {
  it('renders name(arg=value) with the documented prefix', () => {
    const note = formatRecoveryNote({ name: 'read', arguments: { path: '/tmp/a.txt' } });

    expect(note).toBe(`${RECOVERY_NOTE_PREFIX}read(path=/tmp/a.txt)]`);
    expect(note.startsWith('[recovered tool call: ')).toBe(true);
    expect(note.endsWith(']')).toBe(true);
    expect(note).not.toContain('\n');
  });

  it('collapses whitespace and truncates long values', () => {
    const note = formatRecoveryNote({
      name: 'bash',
      arguments: { command: `echo   ${'x'.repeat(200)}` },
    });

    expect(note).not.toContain('\n');
    expect(note.length).toBeLessThan(MAX_NOTE_ARG_LENGTH + 40);
    expect(note).toContain('…');
  });
});

// ── repairAssistantMessage — AC1 ──────────────────────────────────────

describe('repairAssistantMessage — repair (AC1)', () => {
  it('appends one structured toolCall per leaked call and strips the markup', () => {
    const message = assistantMessage(LIVE_LEAK);

    const outcome = repairAssistantMessage(message, ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(true);
    expect(outcome.recovered.map((call) => call.name)).toEqual(['read', 'bash']);

    const repaired = outcome.message as any;
    expect(repaired.stopReason).toBe('toolUse');

    const toolCalls = toolCallsOf(repaired);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      type: 'toolCall',
      name: 'read',
      arguments: { path: '/home/rgardler/.pi/agent/skills/implement/SKILL.md' },
    });
    expect(toolCalls[1]).toMatchObject({
      type: 'toolCall',
      name: 'bash',
      arguments: {
        command:
          'cd /home/rgardler/projects/ContextHub && wl show WL-0MVGKGU19004NTHB --json 2>&1',
      },
    });
    expect(toolCalls[0].id).toMatch(/^call_/);
    expect(toolCalls[0].id).not.toBe(toolCalls[1].id);

    const text = textOf(repaired);
    expect(text).not.toContain('<function=');
    expect(text).not.toContain('<tool_call>');
    expect(text).not.toContain('</response>');
    expect(text).toContain('[recovered tool call: read(path=');
    expect(text).toContain('[recovered tool call: bash(command=');
  });

  it('preserves every other message field', () => {
    const message = assistantMessage(COMPLETE_BLOCK);
    const repaired = repairAssistantMessage(message, ACTIVE_TOOLS).message as any;

    expect(repaired.role).toBe('assistant');
    expect(repaired.api).toBe('anthropic-messages');
    expect(repaired.provider).toBe('local-proxy');
    expect(repaired.model).toBe('qwen-fake');
    expect(repaired.usage).toEqual({ input: 11, output: 22, cacheRead: 0, cacheWrite: 0 });
    expect(repaired.timestamp).toBe(1_700_000_000_000);
  });

  it('repairs a missing-<tool_call>-opener leak (the observed live fragment)', () => {
    const outcome = repairAssistantMessage(assistantMessage(MISSING_OPENER_LEAK), ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(true);
    expect(toolCallsOf(outcome.message)).toHaveLength(1);
    expect(toolCallsOf(outcome.message)[0].arguments).toEqual({
      path: '/tmp/leaked-target.txt',
    });
  });

  it('repairs only the text block that leaked, leaving siblings alone', () => {
    const message = assistantMessage('', {
      content: [
        { type: 'text', text: 'Working on it.' },
        { type: 'text', text: COMPLETE_BLOCK },
      ],
    });

    const repaired = repairAssistantMessage(message, ACTIVE_TOOLS).message as any;

    expect(repaired.content[0]).toEqual({ type: 'text', text: 'Working on it.' });
    expect(repaired.content[1].text).toContain('[recovered tool call: bash(');
    expect(toolCallsOf(repaired)).toHaveLength(1);
  });

  it('does not mutate the original message', () => {
    const message = assistantMessage(COMPLETE_BLOCK);
    const originalContent = JSON.parse(JSON.stringify(message.content));

    repairAssistantMessage(message, ACTIVE_TOOLS);

    expect(message.content).toEqual(originalContent);
    expect(message.stopReason).toBe('stop');
  });
});

// ── repairAssistantMessage — safety (AC2) ─────────────────────────────

describe('repairAssistantMessage — safety guards (AC2)', () => {
  it('never executes an unterminated parameter', () => {
    const message = assistantMessage(
      '<function=bash>\n<parameter=command>\nrm -rf /tmp/important\n',
    );

    const outcome = repairAssistantMessage(message, ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(false);
    expect(outcome.message).toBe(message);
    expect(toolCallsOf(outcome.message)).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0].complete).toBe(false);
    expect(outcome.skipped[0].reason).toBe('unterminated-parameter');
  });

  it('never executes a tool that is not active', () => {
    const message = assistantMessage(COMPLETE_BLOCK);

    const outcome = repairAssistantMessage(message, ['read']);

    expect(outcome.repaired).toBe(false);
    expect(toolCallsOf(outcome.message)).toHaveLength(0);
    expect(outcome.skipped[0].reason).toBe('inactive-tool');
    expect(outcome.skipped[0].complete).toBe(false);
  });

  it('refuses to repair a truncated (length) turn', () => {
    const message = assistantMessage(COMPLETE_BLOCK, { stopReason: 'length' });

    const outcome = repairAssistantMessage(message, ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(false);
    expect(toolCallsOf(outcome.message)).toHaveLength(0);
    expect(outcome.skipped[0].reason).toBe('unrepairable-stop-reason');
  });

  it('drops a recovered call identical to an existing structured toolCall', () => {
    const message = assistantMessage(COMPLETE_BLOCK, {
      content: [
        { type: 'text', text: COMPLETE_BLOCK },
        { type: 'toolCall', id: 'existing-1', name: 'bash', arguments: { command: 'ls -la' } },
      ],
    });

    const outcome = repairAssistantMessage(message, ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(false);
    expect(toolCallsOf(outcome.message)).toHaveLength(1);
    expect(outcome.skipped[0].reason).toBe('duplicate');
  });
});

// ── repairAssistantMessage — no-op paths (AC5) ────────────────────────

describe('repairAssistantMessage — no-op paths', () => {
  it('leaves markup-free text byte-for-byte untouched', () => {
    const message = assistantMessage('All done — nothing to run here.');

    const outcome = repairAssistantMessage(message, ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(false);
    expect(outcome.message).toBe(message);
    expect(outcome.recovered).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(textOf(outcome.message)).toBe('All done — nothing to run here.');
  });

  it('ignores non-assistant messages', () => {
    const user = {
      role: 'user',
      content: [{ type: 'text', text: COMPLETE_BLOCK }],
    };

    const outcome = repairAssistantMessage(user as any, ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(false);
    expect(outcome.message).toBe(user as any);
  });

  it('is idempotent on replay', () => {
    const first = repairAssistantMessage(assistantMessage(LIVE_LEAK), ACTIVE_TOOLS);
    expect(first.repaired).toBe(true);

    const second = repairAssistantMessage(first.message, ACTIVE_TOOLS);

    expect(second.repaired).toBe(false);
    expect(second.message).toBe(first.message);
    expect(toolCallsOf(second.message)).toHaveLength(2);
  });
});

// ── AC1: dialect matrix ───────────────────────────────────────────────
// Every documented dialect variance either parses correctly or is explicitly
// rejected — a legitimate message is never rewritten on a partial match.

describe('dialect matrix (AC1)', () => {
  it("recovers the operator's exact <response> sample", () => {
    const calls = parseLeakedToolCalls(OPERATOR_RESPONSE_SAMPLE);

    expect(calls.map((call) => call.name)).toEqual(['read', 'bash']);
    expect(calls.every((call) => call.complete)).toBe(true);

    const outcome = repairAssistantMessage(
      assistantMessage(OPERATOR_RESPONSE_SAMPLE),
      ACTIVE_TOOLS,
    );

    expect(outcome.repaired).toBe(true);
    expect(toolCallsOf(outcome.message).map((call: any) => call.name)).toEqual([
      'read',
      'bash',
    ]);
    const text = textOf(outcome.message);
    expect(text).not.toContain('<tool_call>');
    expect(text).not.toContain('</function>');
    expect(text).toContain(
      '[recovered tool call: read(path=/home/rgardler/.pi/agent/skills/implement/SKILL.md)]',
    );
  });

  it('parses blocks with indentation and blank-line variance', () => {
    const calls = parseLeakedToolCalls(INDENTED_LEAK);

    expect(calls).toHaveLength(1);
    expect(calls[0].complete).toBe(true);
    expect(calls[0].arguments).toEqual({ path: '/tmp/indented.txt' });
  });

  it('parses adjacent blocks that have no separator', () => {
    const calls = parseLeakedToolCalls(ADJACENT_LEAK);

    expect(calls.map((call) => call.name)).toEqual(['bash', 'read']);
    expect(calls.every((call) => call.complete)).toBe(true);
    expect(calls[0].arguments).toEqual({ command: 'ls' });
    expect(calls[1].arguments).toEqual({ path: '/etc/hosts' });

    const outcome = repairAssistantMessage(assistantMessage(ADJACENT_LEAK), ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(true);
    expect(toolCallsOf(outcome.message)).toHaveLength(2);
  });

  it('rejects the truncated bash sample outright', () => {
    const [call] = parseLeakedToolCalls(TRUNCATED_BASH_LEAK);

    expect(call.complete).toBe(false);
    expect(call.reason).toBe('unterminated-parameter');

    const outcome = repairAssistantMessage(assistantMessage(TRUNCATED_BASH_LEAK), ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(false);
    expect(toolCallsOf(outcome.message)).toHaveLength(0);
    expect(outcome.message.stopReason).toBe('stop');
  });
});

// ── AC2: rejection matrix ─────────────────────────────────────────────
// Zero calls are synthesised and `complete: false` is reported for every
// unsafe or non-call shape.

describe('rejection matrix (AC2)', () => {
  const rejected: Array<{
    id: string;
    text: string;
    activeTools?: readonly string[];
    reason: string;
  }> = [
    { id: 'unterminated parameter', text: TRUNCATED_BASH_LEAK, reason: 'unterminated-parameter' },
    {
      id: 'tool absent from the active-tool list',
      text: COMPLETE_BLOCK,
      activeTools: ['read'],
      reason: 'inactive-tool',
    },
    {
      id: 'block with no parameters',
      text: '<tool_call>\n<function=read>\n</function>\n</tool_call>',
      reason: 'missing-parameter',
    },
    { id: 'fenced code span', text: FENCED_LEAK, reason: 'quoted' },
    { id: 'inline code span', text: INLINE_CODE_LEAK, reason: 'quoted' },
    { id: 'blockquote', text: BLOCKQUOTE_LEAK, reason: 'quoted' },
    { id: 'quoted prose', text: DOUBLE_QUOTED_LEAK, reason: 'quoted' },
  ];

  it.each(rejected)('synthesises nothing for $id', ({ text, activeTools, reason }) => {
    const message = assistantMessage(text);

    const outcome = repairAssistantMessage(message, activeTools ?? ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(false);
    expect(outcome.recovered).toEqual([]);
    expect(toolCallsOf(outcome.message)).toHaveLength(0);
    expect(outcome.message).toBe(message);
    expect(outcome.message.stopReason).toBe('stop');
    expect(outcome.skipped[0].complete).toBe(false);
    expect(outcome.skipped[0].reason).toBe(reason);
  });

  it('leaves fenced and quoted markup byte-for-byte untouched', () => {
    for (const text of [FENCED_LEAK, INLINE_CODE_LEAK, BLOCKQUOTE_LEAK, DOUBLE_QUOTED_LEAK]) {
      const message = assistantMessage(text);

      const outcome = repairAssistantMessage(message, ACTIVE_TOOLS);

      expect(outcome.message).toBe(message);
      expect(textOf(outcome.message)).toBe(text);
    }
  });
});

// ── AC3: duplicate suppression ────────────────────────────────────────

describe('duplicate suppression (AC3)', () => {
  it('drops a call identical to one already parsed in the same message', () => {
    const message = assistantMessage(`${COMPLETE_BLOCK}\n${COMPLETE_BLOCK}`);

    const outcome = repairAssistantMessage(message, ACTIVE_TOOLS);

    expect(outcome.repaired).toBe(true);
    expect(outcome.recovered.map((call) => call.name)).toEqual(['bash']);
    expect(outcome.skipped.map((call) => call.reason)).toEqual(['duplicate']);
    expect(toolCallsOf(outcome.message)).toHaveLength(1);

    const notes = textOf(outcome.message).match(/\[recovered tool call: /g) ?? [];
    expect(notes).toHaveLength(1);
    expect(textOf(outcome.message)).not.toContain('<function=');
  });

  it('still recovers the distinct call that follows a duplicate', () => {
    const readBlock = `<tool_call>
<function=read>
<parameter=path>
/etc/hosts
</parameter>
</function>
</tool_call>`;
    const message = assistantMessage(
      `${COMPLETE_BLOCK}\n${COMPLETE_BLOCK}\n${readBlock}`,
    );

    const outcome = repairAssistantMessage(message, ACTIVE_TOOLS);

    expect(outcome.recovered.map((call) => call.name)).toEqual(['bash', 'read']);
    expect(outcome.skipped.map((call) => call.reason)).toEqual(['duplicate']);
    expect(toolCallsOf(outcome.message)).toHaveLength(2);

    const notes = textOf(outcome.message).match(/\[recovered tool call: /g) ?? [];
    expect(notes).toHaveLength(2);
  });
});

// ── AC4: idempotence ─────────────────────────────────────────────────

describe('idempotence (AC4)', () => {
  it('is a strict no-op when applied to already-repaired output', () => {
    const first = repairAssistantMessage(
      assistantMessage(OPERATOR_RESPONSE_SAMPLE),
      ACTIVE_TOOLS,
    );
    expect(first.repaired).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(first.message));

    const second = repairAssistantMessage(first.message, ACTIVE_TOOLS);

    expect(second.repaired).toBe(false);
    expect(second.message).toBe(first.message);
    expect(second.message).toEqual(first.message);
    expect(JSON.parse(JSON.stringify(second.message))).toEqual(snapshot);
    expect(second.recovered).toEqual([]);
    expect(second.skipped).toEqual([]);

    const notes = textOf(second.message).match(/\[recovered tool call: /g) ?? [];
    expect(notes).toHaveLength(2);
  });
});

// ── AC6: settings ────────────────────────────────────────────────────

describe('LEAKED_TOOL_CALL_CONFIG (AC6)', () => {
  it('is enabled by default with a session cap of 5', () => {
    expect(LEAKED_TOOL_CALL_CONFIG.enabled).toBe(true);
    expect(LEAKED_TOOL_CALL_CONFIG.sessionCap).toBe(5);
  });

  it('renders recovery notes from its template (one source of truth)', () => {
    expect(LEAKED_TOOL_CALL_CONFIG.noteTemplate.startsWith(RECOVERY_NOTE_PREFIX)).toBe(true);
    expect(LEAKED_TOOL_CALL_CONFIG.noteTemplate).toContain('{name}');
    expect(LEAKED_TOOL_CALL_CONFIG.noteTemplate).toContain('{arguments}');

    const expected = LEAKED_TOOL_CALL_CONFIG.noteTemplate
      .replace('{name}', 'read')
      .replace('{arguments}', 'path=/tmp/a.txt');

    expect(formatRecoveryNote({ name: 'read', arguments: { path: '/tmp/a.txt' } })).toBe(
      expected,
    );
  });

  it('exposes a corrective continuation prompt for the fallback slice', () => {
    const prompt = LEAKED_TOOL_CALL_CONFIG.correctiveContinuationPrompt;

    expect(typeof prompt).toBe('string');
    expect(prompt.toLowerCase()).toContain('tool call');
    expect(prompt.length).toBeGreaterThan(40);
  });
});
