/**
 * Tests for the interview command (WL-0MU55UDBJ008DJ67).
 *
 * The interview command walks a producer through outstanding clarifying
 * questions recorded in a work item description. Work items are written by
 * the intake/plan skills, whose canonical appendix format is a bullet list:
 *
 *   ## Appendix: Clarifying questions
 *   - Q: "Who is the primary user?" — Answer (user): "Support engineers".
 *     Source: interactive reply.
 *
 * Legacy descriptions also use numbered `**Q:**`/`**A:**` pairs. Detection
 * must be reliable across all of these variants (this was the defect that
 * triggered the original audit rejection).
 */

import { describe, it, expect } from 'vitest';
import registerInterview, {
  extractClarifyingSection,
  parseQAPairs,
  rebuildQAPairs,
  rebuildDescription,
  runInterview,
} from '../../src/commands/interview.js';
import { createTestContext } from '../test-utils.js';

// ── Section extraction ───────────────────────────────────────────────────

describe('extractClarifyingSection', () => {
  it('returns null when section is absent', () => {
    expect(extractClarifyingSection('Some description')).toBeNull();
    expect(extractClarifyingSection('## Other Section')).toBeNull();
  });

  it('extracts the canonical "Clarifying Questions & Answers" heading', () => {
    const desc = 'Intro\n\n## Clarifying Questions & Answers\n\n## Risks';
    const result = extractClarifyingSection(desc);
    expect(result).not.toBeNull();
    expect(result!.header).toBe('## Clarifying Questions & Answers');
    expect(result!.content).toBe('');
    expect(result!.start).toBe(2);
    expect(result!.end).toBe(4);
  });

  it('recognises the intake-skill appendix heading variants', () => {
    const variants = [
      '## Appendix: Clarifying questions',
      '## Appendix: Clarifying Questions',
      '# Appendix: Clarifying questions',
      '## Clarifying questions',
      '### Appendix: Clarifying questions',
      '## Appendix: Clarifying questions & answers',
    ];
    for (const heading of variants) {
      const desc = `Intro\n\n${heading}\n\n- Q: "Q?" — Answer: "A".\n\n## Next`;
      const result = extractClarifyingSection(desc);
      expect(result, heading).not.toBeNull();
      expect(result!.header, heading).toBe(heading);
      expect(result!.content, heading).toContain('Answer: "A"');
    }
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

// ── Q/A pair parsing: numbered format ────────────────────────────────────

describe('parseQAPairs (numbered format)', () => {
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

  it('parses bold "A (user):" attribution on the answer line', () => {
    const content = `1. **Q:** SA-123 proposes a per-project file. What is the relationship?
   **A (user):** Sibling / related but separate.`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].answer).toBe('Sibling / related but separate.');
    expect(pairs[0].unanswered).toBe(false);
  });
});

// ── Q/A pair parsing: canonical bullet format ────────────────────────────

describe('parseQAPairs (canonical bullet appendix)', () => {
  it('parses an inline quoted Q/A pair with a Source trailer', () => {
    const content =
      '- Q: "Who is the primary user?" — Answer (user): "Internal support engineers". Source: interactive reply.';
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe('Who is the primary user?');
    expect(pairs[0].answer).toBe('Internal support engineers');
    expect(pairs[0].unanswered).toBe(false);
  });

  it('detects an inline "*(awaiting producer)*" placeholder as unanswered', () => {
    const content =
      '- **Q (OPEN QUESTION):** Should this be migrated? — **Answer:** *(awaiting producer)*. Context: awaiting reply.';
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toContain('Should this be migrated?');
    expect(pairs[0].unanswered).toBe(true);
  });

  it('does not eat a placeholder asterisk when the marker has no bold closer', () => {
    const content =
      '- Q: "Who is the primary user?" — Answer (user): *(awaiting producer)*. Source: interactive reply.';
    const pairs = parseQAPairs(content);
    expect(pairs[0].answer).toBe('*(awaiting producer)*');
    expect(pairs[0].unanswered).toBe(true);
    expect(rebuildQAPairs(pairs)).toBe(content);

    pairs[0].answer = 'Internal engineers';
    pairs[0].unanswered = false;
    const answered = rebuildQAPairs(pairs);
    expect(answered).toContain(
      'Answer (user): Internal engineers. Source: interactive reply.',
    );
    expect(answered).not.toContain('*Internal');
  });

  it('parses a bold multiline Q/A pair with a Source line', () => {
    const content = `- **Q:** "Where should the new repository be hosted?"
  **Answer (user):** "Same GitHub organization as OpenCode"
  **Source:** Interactive reply. Final: yes.`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe('Where should the new repository be hosted?');
    expect(pairs[0].answer).toBe('Same GitHub organization as OpenCode');
    expect(pairs[0].unanswered).toBe(false);
  });

  it('parses a multiline question with the answer on a later continuation line', () => {
    const content = `- **Q (OPEN QUESTION):** The start-work code now lives in the ampa repository,
  and the fix is already committed there on origin/dev.
  — **Answer:** *(awaiting producer)*. Context: awaiting reply.`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toContain('The start-work code now lives');
    expect(pairs[0].unanswered).toBe(true);
  });

  it('parses several bullet pairs and skips prose-only questions', () => {
    const content = `- Q: "Scope?" — Answer (user): "Repo-wide". Source: reply.
- Q: "Duplicate?" — Answer (user): "No". Source: reply.
- No clarifying questions were required for the third area.`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].question).toBe('Scope?');
    expect(pairs[1].question).toBe('Duplicate?');
  });

  it('treats a TBD answer as outstanding', () => {
    const content = '- Q: "Threshold?" — Answer: TBD pending confirmation. Source: inference.';
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].unanswered).toBe(true);
  });

  it('parses inline-numbered Q markers with bold answer attribution', () => {
    const content = `- **Q1**: "What is the timeout?" — **Answer** (user): "120s". Source: reply.
- **Q2:** "And the scope?"`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].number).toBe(1);
    expect(pairs[0].question).toBe('What is the timeout?');
    expect(pairs[0].answer).toBe('120s');
    expect(pairs[0].unanswered).toBe(false);
    expect(pairs[1].number).toBe(2);
    expect(pairs[1].question).toBe('And the scope?');
    expect(pairs[1].unanswered).toBe(true);
  });

  it('parses bare (unbulleted) bold Q markers', () => {
    const content = `**Q**: "Which header marker?"

**Q**: "Second question?" — **Answer (user):** "Yes".`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].question).toBe('Which header marker?');
    expect(pairs[0].unanswered).toBe(true);
    expect(pairs[1].question).toBe('Second question?');
    expect(pairs[1].answer).toBe('Yes');
  });

  it('parses parenthesised and dash qualifiers in Q markers', () => {
    const content = `- **Q1 (scope):** Should it be split?
  **Answer (operator):** "all recommended" → keep.
- **Q2 — Delete vs close:** Should agents delete?
  **Answer (user):** "close".`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].question).toBe('Should it be split?');
    expect(pairs[0].answer).toBe('all recommended');
    expect(pairs[1].question).toBe('Should agents delete?');
    expect(pairs[1].answer).toBe('close');
  });

  it('detects an inline answer on a continuation line', () => {
    const content = `- **Q1 (scope):** Should the item cover hermetic tests +
  cleanup, or split? — **Answer (operator):** "all recommended" → keep.`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe(
      'Should the item cover hermetic tests + cleanup, or split?',
    );
    expect(pairs[0].answer).toBe('all recommended');
    expect(pairs[0].unanswered).toBe(false);
  });

  it('round-trips a mixed-format appendix losslessly', () => {
    const content = `Here are the questions.

- **Q1 (scope):** Should it be split?
  **Answer (operator):** "all recommended" → keep.
- Q: "Who is the user?" — Answer (user): *(awaiting producer)*. Source: reply.

**Q3**: "Bare marker?"
  — **Answer:** "Answered". Source: reply.`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(3);
    expect(rebuildQAPairs(pairs)).toBe(content);
  });
});

// ── Q/A pair rebuilding ──────────────────────────────────────────────────

describe('rebuildQAPairs', () => {
  it('round-trips numbered Q/A pairs', () => {
    const content = `1. **Q: Question one?**
  **A: Answer one.**

2. **Q: Question two?**
  **A:**`;
    const pairs = parseQAPairs(content);
    expect(rebuildQAPairs(pairs)).toBe(content);
  });

  it('round-trips the canonical bullet format losslessly', () => {
    const content =
      '- Q: "Primary user?" — Answer (user): "Support". Source: interactive reply.\n' +
      '- Q: "Scope?" — Answer (user): "Repo-wide". Source: reply.';
    const pairs = parseQAPairs(content);
    expect(rebuildQAPairs(pairs)).toBe(content);
  });

  it('preserves Source metadata when an answer is replaced', () => {
    const content =
      '- Q: "Primary user?" — Answer (user): "Support". Source: interactive reply.';
    const pairs = parseQAPairs(content);
    pairs[0].answer = 'Internal engineers';
    pairs[0].unanswered = false;
    const rebuilt = rebuildQAPairs(pairs);
    expect(rebuilt).toContain('Internal engineers');
    expect(rebuilt).toContain('Source: interactive reply.');
    expect(rebuilt).not.toContain('"Support"');
  });

  it('preserves the multiline Source line when a placeholder is replaced', () => {
    const content = `- **Q:** "Where?"
  **Answer:** *(awaiting producer)*
  **Source:** interactive reply.`;
    const pairs = parseQAPairs(content);
    expect(pairs[0].unanswered).toBe(true);
    pairs[0].answer = 'Acme org';
    pairs[0].unanswered = false;
    const rebuilt = rebuildQAPairs(pairs);
    expect(rebuilt).toContain('Acme org');
    expect(rebuilt).toContain('**Source:** interactive reply.');
    expect(rebuilt).not.toContain('awaiting producer');
  });

  it('preserves answer content including punctuation', () => {
    const pairs = parseQAPairs(`1. **Q: Question?**\n  **A: It costs £5.00.**`);
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

// ── Core interview loop ──────────────────────────────────────────────────

/** Minimal in-memory work-item store for exercising runInterview. */
function makeStore(item: any) {
  let current = { ...item };
  return {
    update: (_id: string, updates: any) => {
      current = { ...current, ...updates };
      return current;
    },
    current: () => current,
  };
}

function makeItem(description: string, needsProducerReview = true) {
  return {
    id: 'WL-TEST-1',
    title: 'Sample',
    description,
    status: 'open',
    stage: 'intake_complete',
    needsProducerReview,
  } as any;
}

describe('runInterview', () => {
  it('reports no-section without mutating the item', async () => {
    const store = makeStore(makeItem('# Task\n\nNo clarifying section.'));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => 'unused',
    });
    expect(outcome.noSection).toBe(true);
    expect(store.current().description).toContain('No clarifying section.');
    expect(store.current().needsProducerReview).toBe(true);
  });

  it('reports no-questions for a prose-only appendix', async () => {
    const desc = `# Task

## Clarifying Questions & Answers

No clarifying questions were asked; the brief was sufficient.`;
    const store = makeStore(makeItem(desc));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => 'unused',
    });
    expect(outcome.noQuestions).toBe(true);
    expect(store.current().description).toBe(desc);
  });

  it('clears the review flag when every question is already answered', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Scope?" — Answer (user): "Repo-wide". Source: reply.`;
    const store = makeStore(makeItem(desc, true));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => 'unused',
    });
    expect(outcome.allAnswered).toBe(true);
    expect(outcome.recorded).toBe(0);
    expect(store.current().needsProducerReview).toBe(false);
  });

  it('records a bullet-format answer, preserving Source, and clears the flag', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Primary user?" — Answer (user): *(awaiting producer)*. Source: interactive reply.`;
    const store = makeStore(makeItem(desc, true));
    const prompts: string[] = [];
    const outcome = await runInterview(store.current(), store, {
      prompt: async (m: string) => {
        prompts.push(m);
        return 'Internal engineers';
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Primary user?');
    expect(outcome.recorded).toBe(1);
    expect(outcome.allAnswered).toBe(true);
    const updated = store.current();
    expect(updated.description).toContain('Internal engineers');
    expect(updated.description).toContain('Source: interactive reply.');
    expect(updated.description).not.toContain('awaiting producer');
    expect(updated.needsProducerReview).toBe(false);
  });

  it('answers an inline placeholder inside its surrounding markup', async () => {
    const desc = `## Appendix: Clarifying questions

- **Q:** "Where?"
  **Answer:** *(awaiting producer)*
  **Source:** reply.`;
    const store = makeStore(makeItem(desc, true));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => 'Acme org',
    });
    expect(outcome.recorded).toBe(1);
    const updated = store.current();
    expect(updated.description).toContain('**Answer:** Acme org');
    expect(updated.description).toContain('**Source:** reply.');
    expect(updated.description).not.toContain('awaiting producer');
  });

  it('persists partial progress and keeps the flag when interrupted', async () => {
    const desc = `## Appendix: Clarifying questions

- Q: "One?" — Answer: *(awaiting producer)*. Source: reply.
- Q: "Two?" — Answer: *(awaiting producer)*. Source: reply.`;
    const store = makeStore(makeItem(desc, true));
    const answers = ['A1', ''];
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => answers.shift() ?? '',
    });
    expect(outcome.recorded).toBe(1);
    expect(outcome.outstanding).toBe(1);
    expect(outcome.allAnswered).toBe(false);
    const updated = store.current();
    // The first answer is persisted for resume; the second stays outstanding.
    expect(updated.description).toContain('A1');
    expect(updated.description).toContain('awaiting producer');
    expect(updated.needsProducerReview).toBe(true);
  });

  it('leaves the review flag set when no question is answered', async () => {
    const desc = `## Appendix: Clarifying questions

- Q: "One?" — Answer: *(awaiting producer)*. Source: reply.
- Q: "Two?" — Answer: *(awaiting producer)*. Source: reply.`;
    const store = makeStore(makeItem(desc, true));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => '',
    });
    expect(outcome.recorded).toBe(0);
    expect(outcome.allAnswered).toBe(false);
    expect(store.current().needsProducerReview).toBe(true);
  });

  it('appends an answer scaffold when no marker is present', async () => {
    const desc = `## Clarifying questions

- **Q:** A question with no recorded answer marker?`;
    const store = makeStore(makeItem(desc, true));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => 'Yes',
    });
    expect(outcome.recorded).toBe(1);
    const updated = store.current();
    expect(updated.description).toContain('A question with no recorded answer marker?');
    expect(updated.description).toContain('Yes');
    expect(updated.needsProducerReview).toBe(false);
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
    ctx.utils.db.update(id, { description: desc, needsProducerReview: true });

    await ctx.runCli(['interview', id]);

    const updated = ctx.utils.db.get(id);
    expect(updated).not.toBeNull();
    expect(updated!.description).toContain('JSON format.');
    expect(updated!.needsProducerReview).toBe(false);
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
