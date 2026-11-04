/**
 * Tests for the `wl interview` command registration and non-interactive paths
 * (WL-0MU55UDBJ008DJ67, WL-0MULI1N1N0001WRD).
 *
 * Split verbatim from tests/cli/interview.test.ts (WL-0MVXY35EN004KL85);
 * assertions, fixtures and describe titles are unchanged.
 */

import { describe, it, expect } from 'vitest';
import registerInterview from '../../../src/commands/interview.js';
import { createTestContext } from '../../test-utils.js';

describe('interview command', () => {
  it('registers the interview command', () => {
    const ctx = createTestContext();
    registerInterview(ctx as any);
    expect(ctx.program._commands.get('interview')).toBeDefined();
  });

  it('reports work item not found', async () => {
    const ctx = createTestContext();
    registerInterview(ctx as any);
    await expect(ctx.runCli(['interview', 'NONEXISTENT'])).rejects.toThrow();
  });

  it('exits cleanly when no clarifying section exists', async () => {
    const ctx = createTestContext();
    registerInterview(ctx as any);
    const id = ctx.utils.createSampleItem({
      description: '# Some Task\n\nNo clarifying section here.',
    });
    await ctx.runCli(['interview', id]);
    const item = ctx.utils.db.get(id);
    expect(item).not.toBeNull();
  });

  it('exits cleanly when all questions already answered', async () => {
    const ctx = createTestContext();
    registerInterview(ctx as any);

    const desc = `# Interview Test Task

This task has interview questions.

## Clarifying Questions & Answers

1. **Q: What format should the output be in?**
  **A: JSON format.**

2. **Q: Should this be resumable?**
  **A: Yes, track index.**
`.trim();

    const id = ctx.utils.createSampleItem({});
    ctx.utils.db.update(id, { description: desc });

    await ctx.runCli(['interview', id]);

    const updated = ctx.utils.db.get(id);
    expect(updated).not.toBeNull();
    expect(updated!.description).toContain('JSON format.');
  });

  it('handles a clarifying section with no body content', async () => {
    const ctx = createTestContext();
    registerInterview(ctx as any);
    const desc = `# Task with empty clarifying section

Description here.

## Clarifying Questions & Answers

## Next Section

Some content.
`.trim();
    const id = ctx.utils.createSampleItem({ description: desc });
    await ctx.runCli(['interview', id]);
    const item = ctx.utils.db.get(id);
    expect(item).not.toBeNull();
  });
});

describe('interview --json (non-interactive)', () => {
  /** Register the command with a JSON-capturing output. */
  function setup(options: {
    item?: { description?: string };
    comments?: any[];
    auditResult?: any;
    chatClient?: any;
  } = {}) {
    const ctx = createTestContext();
    const jsonOutput: any[] = [];
    ctx.output = {
      json: (data: any) => { jsonOutput.push(data); },
      success: () => {},
      error: () => {},
    };
    const id = ctx.utils.createSampleItem({});
    ctx.utils.db.update(id, {
      description: options.item?.description ?? '# Task\n\nNo clarifying section here.',
      title: 'JSON task',
    });
    const baseGetDatabase = ctx.utils.getDatabase;
    ctx.utils.getDatabase = (prefix?: string) => ({
      ...baseGetDatabase(prefix),
      getCommentsForWorkItem: () => options.comments ?? [],
      getAuditResult: () => options.auditResult ?? null,
    });
    registerInterview(ctx as any, {
      chatClientFactory: () => options.chatClient ?? null,
    });
    return { ctx, id, jsonOutput };
  }

  it('reports no-section state without mutating the item', async () => {
    const { ctx, id, jsonOutput } = setup({
      item: { description: '# Task\n\nNo section.' },
    });

    await ctx.runCli(['interview', id, '--json']);

    expect(jsonOutput).toHaveLength(1);
    expect(jsonOutput[0]).toMatchObject({
      success: true,
      workItemId: id,
      noSection: true,
      noQuestions: false,
    });
    // No mutation in JSON mode.
    const stored = ctx.utils.db.get(id);
    expect(stored.description).toContain('No section.');
  });

  it('reports outstanding-question state without prompting in JSON mode', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Scope?" — Answer: *(awaiting producer)*. Source: reply.`;
    const { ctx, id, jsonOutput } = setup({
      item: { description: desc },
    });

    await ctx.runCli(['interview', id, '--json', '--no-llm']);

    expect(jsonOutput[0]).toMatchObject({
      noSection: false,
      noQuestions: false,
      total: 1,
      outstanding: 1,
      allAnswered: false,
    });
  });
});

describe('interview no-questions interactive path', () => {
  function setupInteractive(options: {
    description?: string;
    answers?: string[];
  } = {}) {
    const ctx = createTestContext();
    const messages: string[] = [];
    const answers = [...(options.answers ?? [])];
    const originalLog = console.log;
    console.log = (...args: any[]) => { messages.push(args.join(' ')); };

    const id = ctx.utils.createSampleItem({});
    ctx.utils.db.update(id, {
      description: options.description ?? '# Task\n\nNo clarifying section here.',
      title: 'Prompt task',
    });

    registerInterview(ctx as any, {
      chatClientFactory: () => null,
      progressOutStream: { write: () => undefined },
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

  it('exits cleanly when there is nothing to interview (no clarifying section)', async () => {
    const t = setupInteractive();
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(t.messages.some(m => /Nothing to interview/.test(m))).toBe(true);
    } finally {
      t.restore();
    }
  });

  it('exits cleanly when questions remain outstanding after an interrupted session', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "One?" — Answer: *(awaiting producer)*. Source: reply.
- Q: "Two?" — Answer: *(awaiting producer)*. Source: reply.`;
    const t = setupInteractive({ description: desc, answers: ['answer'] });
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(t.messages.some(m => /still outstanding/.test(m))).toBe(true);
    } finally {
      t.restore();
    }
  });
});
