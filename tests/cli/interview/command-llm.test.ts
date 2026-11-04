/**
 * Tests for the `wl interview --llm` command path and command-level LLM
 * progress feedback (WL-0MUH7ACKJ0024VGF, WL-0MUX2W8IN005RW66).
 *
 * Split verbatim from tests/cli/interview.test.ts (WL-0MVXY35EN004KL85);
 * assertions, fixtures and describe titles are unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import registerInterview from '../../../src/commands/interview.js';
import {
  LLM_THINKING_MESSAGE,
  LLM_FALLBACK_NOTICE,
  type ProgressWriteStream,
} from '../../../src/lib/progress-feedback.js';
import { createTestContext } from '../../test-utils.js';

/** A chat client stub whose `complete` returns `response` (or throws). */
function fakeChatClient(response: string | Error): any {
  return {
    available: true,
    complete: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  };
}

describe('interview --llm command', () => {
  function setup(options: {
    description?: string;
    config?: any;
    chatClient?: any;
    answers?: string[];
    jsonOutput?: any[];
  } = {}) {
    const ctx = createTestContext();
    const messages: string[] = [];
    const answers = [...(options.answers ?? [])];
    const originalLog = console.log;
    console.log = (...args: any[]) => { messages.push(args.join(' ')); };
    if (options.jsonOutput) {
      ctx.output = {
        json: (data: any) => { options.jsonOutput!.push(data); },
        success: () => {},
        error: () => {},
      };
    }
    ctx.utils.getConfig = () => options.config ?? {};
    const id = ctx.utils.createSampleItem({});
    ctx.utils.db.update(id, {
      description: options.description ?? '# Task\n\nNo clarifying section here.',
      title: 'LLM task',
    });
    const baseGetDatabase = ctx.utils.getDatabase;
    ctx.utils.getDatabase = (prefix?: string) => ({
      ...baseGetDatabase(prefix),
      getCommentsForWorkItem: () => [],
      getAuditResult: () => null,
    });
    registerInterview(ctx as any, {
      chatClientFactory: () => options.chatClient ?? null,
      progressOutStream: { write: () => undefined },
      promptLoopFactory: () => ({
        next: async (message: string) => {
          messages.push(message);
          return answers.shift() ?? '';
        },
        close: () => {},
      }),
    });
    return { ctx, id, messages, restore: () => { console.log = originalLog; } };
  }

  it('extracts, confirms and writes questions when --llm is passed', async () => {
    const chat = fakeChatClient('[{"question":"Who is the user?"}]');
    const t = setup({ chatClient: chat, answers: ['Support engineers'] });
    try {
      await t.ctx.runCli(['interview', t.id, '--llm']);
      expect(chat.complete).toHaveBeenCalledTimes(1);
      const stored = t.ctx.utils.db.get(t.id);
      expect(stored.description).toContain('Who is the user?');
      expect(stored.description).toContain('Support engineers');
    } finally {
      t.restore();
    }
  });

  it('does not call the extraction LLM without --llm or config opt-in', async () => {
    const chat = fakeChatClient('[{"question":"Who is the user?"}]');
    const t = setup({
      chatClient: chat,
      answers: [''],
    });
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(chat.complete).not.toHaveBeenCalled();
    } finally {
      t.restore();
    }
  });

  it('enables extraction from interview.intelligent: true', async () => {
    const chat = fakeChatClient('[{"question":"Who is the user?"}]');
    const t = setup({
      chatClient: chat,
      config: { interview: { intelligent: true } },
      answers: ['Support engineers'],
    });
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(chat.complete).toHaveBeenCalledTimes(1);
      expect(t.ctx.utils.db.get(t.id).description).toContain('Support engineers');
    } finally {
      t.restore();
    }
  });

  it('lets --no-llm override interview.intelligent: true', async () => {
    const chat = fakeChatClient('[{"question":"Who is the user?"}]');
    const t = setup({
      chatClient: chat,
      config: { interview: { intelligent: true } },
      answers: [''],
    });
    try {
      await t.ctx.runCli(['interview', t.id, '--no-llm']);
      expect(chat.complete).not.toHaveBeenCalled();
    } finally {
      t.restore();
    }
  });

  it('never runs extraction in --json mode (no prompts, no mutation)', async () => {
    const chat = fakeChatClient('[{"question":"Who is the user?"}]');
    const jsonOutput: any[] = [];
    const t = setup({
      chatClient: chat,
      answers: [''],
      jsonOutput,
    });
    try {
      await t.ctx.runCli(['interview', t.id, '--json', '--llm']);
      expect(chat.complete).not.toHaveBeenCalled();
      expect(jsonOutput).toHaveLength(1);
      expect(t.ctx.utils.db.get(t.id).description).not.toContain('Who is the user?');
    } finally {
      t.restore();
    }
  });
});

describe('interview LLM progress feedback', () => {
  /** Capturing progress stream with optional TTY emulation and event log. */
  function makeProgressStream(
    isTTY?: boolean,
    events?: string[],
  ): { stream: ProgressWriteStream; writes: string[] } {
    const writes: string[] = [];
    const stream: ProgressWriteStream = {
      write: (chunk: string) => {
        writes.push(chunk);
        if (events) events.push(`write:${chunk}`);
        return true;
      },
    };
    if (isTTY !== undefined) stream.isTTY = isTTY;
    return { stream, writes };
  }

  function setup(options: {
    description?: string;
    chatClient?: any;
    progressStream: ProgressWriteStream;
    answers?: string[];
    jsonOutput?: any[];
  }) {
    const ctx = createTestContext();
    const messages: string[] = [];
    const answers = [...(options.answers ?? [])];
    const originalLog = console.log;
    console.log = (...args: any[]) => { messages.push(args.join(' ')); };
    if (options.jsonOutput) {
      ctx.output = {
        json: (d: any) => options.jsonOutput!.push(d),
        success: () => {},
        error: () => {},
      };
    }
    const id = ctx.utils.createSampleItem({});
    ctx.utils.db.update(id, {
      description: options.description ?? '# Task\n\nNo section here.',
      title: 'Progress task',
    });
    const baseGetDatabase = ctx.utils.getDatabase;
    ctx.utils.getDatabase = (prefix?: string) => ({
      ...baseGetDatabase(prefix),
      getCommentsForWorkItem: () => [],
      getAuditResult: () => null,
    });
    registerInterview(ctx as any, {
      chatClientFactory: () => options.chatClient ?? null,
      progressOutStream: options.progressStream,
      promptLoopFactory: () => ({
        next: async (message: string) => {
          messages.push(message);
          return answers.shift() ?? '';
        },
        close: () => {},
      }),
    });
    return {
      ctx,
      id,
      messages,
      restore: () => { console.log = originalLog; },
    };
  }

  it('prints the status message before the extraction LLM request (--llm)', async () => {
    const events: string[] = [];
    const { stream } = makeProgressStream(undefined, events);
    const chat = {
      available: true,
      complete: vi.fn(async () => {
        events.push('request');
        return '[{"question":"Who is the user?"}]';
      }),
    };
    const t = setup({
      chatClient: chat as any,
      progressStream: stream,
      answers: ['Support engineers'],
    });
    try {
      await t.ctx.runCli(['interview', t.id, '--llm']);
      expect(chat.complete).toHaveBeenCalledTimes(1);
      const statusIndex = events.findIndex(
        e => e.startsWith('write:') && e.includes(LLM_THINKING_MESSAGE),
      );
      const requestIndex = events.indexOf('request');
      expect(statusIndex).toBeGreaterThanOrEqual(0);
      expect(requestIndex).toBeGreaterThan(statusIndex);
    } finally {
      t.restore();
    }
  });

  it('does not emit spinner control characters when stdout is not a TTY', async () => {
    const { stream, writes } = makeProgressStream(false);
    const chat = {
      available: true,
      complete: vi.fn(async () => '[{"question":"Who is the user?"}]'),
    };
    const t = setup({
      chatClient: chat as any,
      progressStream: stream,
      answers: ['Support engineers'],
    });
    try {
      await t.ctx.runCli(['interview', t.id, '--llm']);
      expect(writes.some(w => w.includes(LLM_THINKING_MESSAGE))).toBe(true);
      expect(writes.join('')).not.toContain('\r');
    } finally {
      t.restore();
    }
  });

  it('shows and clears a TTY spinner around the request', async () => {
    const { stream, writes } = makeProgressStream(true);
    const chat = {
      available: true,
      complete: vi.fn(async () => '[{"question":"Who is the user?"}]'),
    };
    const t = setup({
      chatClient: chat as any,
      progressStream: stream,
      answers: ['Support engineers'],
    });
    try {
      await t.ctx.runCli(['interview', t.id, '--llm']);
      expect(writes.some(w => /\r.*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(w))).toBe(true);
      expect(writes.some(w => /^\r +\r$/.test(w))).toBe(true);
    } finally {
      t.restore();
    }
  });

  it('emits no status or spinner in --json mode', async () => {
    const { stream, writes } = makeProgressStream(true);
    const jsonOutput: any[] = [];
    const chat = { available: true, complete: vi.fn(async () => 'Explained') };
    const t = setup({
      chatClient: chat as any,
      progressStream: stream,
      jsonOutput,
    });
    try {
      await t.ctx.runCli(['interview', t.id, '--json']);
      expect(writes).toEqual([]);
      expect(jsonOutput).toHaveLength(1);
    } finally {
      t.restore();
    }
  });

  it('prints the fallback notice when the extraction LLM fails', async () => {
    const { stream, writes } = makeProgressStream();
    const chat = {
      available: true,
      complete: vi.fn(async () => {
        throw new Error('timeout');
      }),
    };
    const t = setup({
      chatClient: chat as any,
      progressStream: stream,
      description: '# Task\n\nNo section here.',
      answers: [''],
    });
    try {
      await t.ctx.runCli(['interview', t.id, '--llm']);
      expect(chat.complete).toHaveBeenCalledTimes(1);
      expect(writes.some(w => w.includes(LLM_FALLBACK_NOTICE))).toBe(true);
    } finally {
      t.restore();
    }
  });

  it('produces no LLM feedback when deterministic questions already exist', async () => {
    const desc = `# Task\n\n## Appendix: Clarifying questions\n\n- Q: "Scope?" — Answer (user): "Repo-wide". Source: reply.`;
    const { stream, writes } = makeProgressStream(true);
    const chat = { available: true, complete: vi.fn(async () => 'unused') };
    const t = setup({
      chatClient: chat as any,
      progressStream: stream,
      description: desc,
    });
    try {
      await t.ctx.runCli(['interview', t.id, '--llm']);
      expect(chat.complete).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    } finally {
      t.restore();
    }
  });
});
