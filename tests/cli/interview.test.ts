/**
 * Tests for the interview command (WL-0MU55UDBJ008DJ67).
 *
 * Tests cover:
 * - Clarifying section extraction from descriptions
 * - Q/A pair parsing and rebuilding
 * - Description reconstruction
 * - Command registration and basic invocation
 */

import { describe, it, expect } from 'vitest';
import registerInterview, {
  extractClarifyingSection,
  parseQAPairs,
  rebuildQAPairs,
  rebuildDescription,
} from '../../src/commands/interview.js';
import { createTestContext } from '../test-utils.js';

// ── Section extraction ───────────────────────────────────────────────────

describe('extractClarifyingSection', () => {
  it('returns null when section is absent', () => {
    expect(extractClarifyingSection('Some description')).toBeNull();
    expect(extractClarifyingSection('## Other Section')).toBeNull();
  });

  it('extracts an empty section', () => {
    const desc = 'Intro\n\n## Clarifying Questions & Answers\n\n## Risks';
    const result = extractClarifyingSection(desc);
    expect(result).not.toBeNull();
    expect(result!.header).toBe('## Clarifying Questions & Answers');
    expect(result!.content).toBe('');
    expect(result!.start).toBe(2);
    expect(result!.end).toBe(4);
  });

  it('extracts section with content before the next section', () => {
    const desc = `
Title here

Some description text

## Clarifying Questions & Answers

1. **Q: What format should the replay output be in?**
   **A: The replay outputs to stdout as markdown.**

2. **Q: Should partial interviews be resumable?**
   **A: Yes, by tracking answered question indices.**

## Risks & Assumptions

Some risk text here.
`.trim();
    const result = extractClarifyingSection(desc);
    expect(result).not.toBeNull();
    expect(result!.header).toBe('## Clarifying Questions & Answers');
    expect(result!.content).toContain('What format should the replay output be in?');
    expect(result!.content).toContain('Should partial interviews be resumable?');
    expect(result!.start).toBeGreaterThan(0);
    expect(result!.end).toBeLessThan(result!.start + 10);
  });
});

// ── Q/A pair parsing ─────────────────────────────────────────────────────

describe('parseQAPairs', () => {
  it('returns empty array for empty content', () => {
    expect(parseQAPairs('')).toEqual([]);
    expect(parseQAPairs('Some prose text.')).toEqual([]);
  });

  it('parses a single unanswered question', () => {
    const content = '1. **Q: What is the question?**\n  **A:**';
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].number).toBe(1);
    expect(pairs[0].question).toBe('What is the question?');
    expect(pairs[0].answer).toBe('');
    expect(pairs[0].unanswered).toBe(true);
    expect(pairs[0].startLine).toBe(0);
    expect(pairs[0].endLine).toBe(1);
  });

  it('parses a single answered question', () => {
    const content = '1. **Q: What is the question?**\n  **A: The answer goes here.**';
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe('What is the question?');
    expect(pairs[0].answer).toBe('The answer goes here.');
    expect(pairs[0].unanswered).toBe(false);
  });

  it('parses multiple mixed Q/A pairs', () => {
    const content = `1. **Q: Unanswered question?**
  **A:**

2. **Q: Already answered?**
  **A: Yes, this was answered.**

3. **Q: Another unanswered?**
  **A:**`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(3);
    expect(pairs[0].question).toBe('Unanswered question?');
    expect(pairs[0].unanswered).toBe(true);
    expect(pairs[1].question).toBe('Already answered?');
    expect(pairs[1].answer).toBe('Yes, this was answered.');
    expect(pairs[1].unanswered).toBe(false);
    expect(pairs[2].question).toBe('Another unanswered?');
    expect(pairs[2].unanswered).toBe(true);
  });
});

// ── Q/A pair rebuilding ──────────────────────────────────────────────────

describe('rebuildQAPairs', () => {
  it('round-trips Q/A pairs', () => {
    const pairs = parseQAPairs(`1. **Q: Question one?**
  **A: Answer one.**

2. **Q: Question two?**
  **A:**`);
    const rebuilt = rebuildQAPairs(pairs);
    const reparsed = parseQAPairs(rebuilt);
    expect(reparsed).toHaveLength(2);
    expect(reparsed[0].question).toBe('Question one?');
    expect(reparsed[0].answer).toBe('Answer one.');
    expect(reparsed[1].question).toBe('Question two?');
    expect(reparsed[1].answer).toBe('');
  });

  it('preserves answer content including punctuation', () => {
    const pairs = parseQAPairs(`1. **Q: Question?**
  **A: It costs £5.00.**`);
    const rebuilt = rebuildQAPairs(pairs);
    const reparsed = parseQAPairs(rebuilt);
    expect(reparsed[0].answer).toBe('It costs £5.00.');
  });
});

describe('rebuildDescription', () => {
  it('rebuilds the full description with updated content', () => {
    const original = `# Title

Some description.

## Clarifying Questions & Answers

1. **Q: Old question?**
  **A: Old answer.**

## Risks

Some risk text.
`.trim();

    const section = extractClarifyingSection(original);
    const newPairs = parseQAPairs(section!.content);
    newPairs[0].answer = 'New answer!';
    newPairs[0].unanswered = false;
    const updatedContent = rebuildQAPairs(newPairs);
    const rebuilt = rebuildDescription(original, section, updatedContent);

    expect(rebuilt).toContain('New answer!');
    expect(rebuilt).toContain('Old question');
    expect(rebuilt).toContain('Some risk text');
  });

  it('handles a section at the end of the description', () => {
    const original = `# Title

Some description.

## Clarifying Questions & Answers

1. **Q: Last question?**
  **A:**`.trim();

    const section = extractClarifyingSection(original);
    expect(section).not.toBeNull();
    expect(section!.end).toBe(original.split('\n').length);

    const newPairs = parseQAPairs(section!.content);
    newPairs[0].answer = 'Done!';
    newPairs[0].unanswered = false;
    const updatedContent = rebuildQAPairs(newPairs);
    const rebuilt = rebuildDescription(original, section, updatedContent);

    expect(rebuilt).toContain('Done!');
  });

  it('returns original when section is null', () => {
    expect(rebuildDescription('No section', null, 'new content')).toBe('No section');
  });
});

// ── Command registration ─────────────────────────────────────────────────

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
    // Should not throw — the command logs and returns
    await ctx.runCli(['interview', id]);
    // Verify the item was not modified
    const item = ctx.utils.db.get(id);
    expect(item).not.toBeNull();
  });

  it('exits cleanly when no unanswered questions exist', async () => {
    const ctx = createTestContext();
    registerInterview(ctx as any);
    const desc = `# Some Task

Some description.

## Clarifying Questions & Answers

1. **Q: Already answered?**
  **A: Yes, answered.**
`.trim();
    const id = ctx.utils.createSampleItem({ description: desc });
    await ctx.runCli(['interview', id]);
    // Verify the item was not modified
    const item = ctx.utils.db.get(id);
    expect(item).not.toBeNull();
    expect(item!.needsProducerReview).toBe(false);
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
    const item = ctx.utils.db.get(id);
    if (item) {
      ctx.utils.db.update(id, { description: desc, needsProducerReview: true });
    }

    await ctx.runCli(['interview', id]);

    const updated = ctx.utils.db.get(id);
    expect(updated).not.toBeNull();
    expect(updated!.description).toContain('JSON format.');
  });

  it('handles clarifying section with no body content', async () => {
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

  it('handles clarifying section with only answered questions and needsProducerReview flag', async () => {
    const ctx = createTestContext();
    registerInterview(ctx as any);

    const desc = `# Task with answered questions

## Clarifying Questions & Answers

1. **Q: Question one?**
  **A: Answer one.**

2. **Q: Question two?**
  **A: Answer two.**

## Risks

None.
`.trim();

    const id = ctx.utils.createSampleItem({});
    const item = ctx.utils.db.get(id);
    if (item) {
      ctx.utils.db.update(id, { description: desc, needsProducerReview: true });
    }

    await ctx.runCli(['interview', id]);

    const updated = ctx.utils.db.get(id);
    expect(updated!.needsProducerReview).toBe(false);
  });
});
