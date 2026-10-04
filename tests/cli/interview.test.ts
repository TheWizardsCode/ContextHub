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

import { describe, it, expect, vi } from 'vitest';
import registerInterview, {
  extractClarifyingSection,
  parseQAPairs,
  rebuildQAPairs,
  rebuildDescription,
  runInterview,
  buildProducerReviewExplanation,
  buildExplanationPrompt,
  buildFallbackExplanation,
  renderExplanation,
  PRODUCER_REVIEW_INSTRUCTION,
  MAX_PROMPT_CONTEXT_BYTES,
  MAX_AUDIT_RAW_OUTPUT_BYTES,
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

  it('does not truncate question text containing em dashes (WL-0MUKCGV3X0030W6K)', () => {
    // Question text with em dashes that are part of the content, not qualifiers
    const content =
      '- **Q:** 4. Crash behaviour — destroyed and respawn (like enemy) — **Answer:** *(awaiting producer)*.';
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe(
      '4. Crash behaviour — destroyed and respawn (like enemy)',
    );
    expect(pairs[0].unanswered).toBe(true);
  });

  it('captures the full multi-line question ending in an OPEN QUESTION marker (WL-0MUKCGV3X0030W6K)', () => {
    // Reproduces the intake appendix from AH-0MUAYB2XR007N10W, where the
    // answer placeholder sits on a continuation line and the question spans
    // two lines. Previously only the first line was surfaced.
    const content = `- **Q (round 1 follow-up):** Crash behaviour — destroyed and respawn (like enemy
  collisions) or something else? — **OPEN QUESTION**, context: not yet answered.
  Interim assumption: destroy + reuse the shared player-hit lifecycle (see
  Assumptions). Source: wl comment \`AH-C0MUB8JD13004UD9E\`.`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe(
      'Crash behaviour — destroyed and respawn (like enemy collisions) or something else?',
    );
    expect(pairs[0].unanswered).toBe(true);
  });

  it('round-trips a multi-line OPEN QUESTION appendix losslessly', () => {
    const content = `- **Q (round 1 follow-up):** Crash behaviour — destroyed and respawn (like enemy
  collisions) or something else? — **OPEN QUESTION**, context: not yet answered.
  Interim assumption: destroy + reuse the shared player-hit lifecycle. Source: reply.`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(rebuildQAPairs(pairs)).toBe(content);
  });

  it('captures a multi-line question with no answer marker at all', () => {
    const content = `- **Q:** A question that spans
  several lines with no marker?`;
    const pairs = parseQAPairs(content);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toBe(
      'A question that spans several lines with no marker?',
    );
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

  it('prompts with the full multi-line question and answers an OPEN QUESTION placeholder (WL-0MUKCGV3X0030W6K)', async () => {
    const desc = `## Appendix: Clarifying questions

- **Q (round 1 follow-up):** Crash behaviour — destroyed and respawn (like enemy
  collisions) or something else? — **OPEN QUESTION**, context: not yet answered.
  Interim assumption: destroy + reuse the shared player-hit lifecycle.
  Source: wl comment \`AH-C0MUB8JD13004UD9E\`.`;
    const store = makeStore(makeItem(desc, true));
    const prompts: string[] = [];
    const outcome = await runInterview(store.current(), store, {
      prompt: async (m: string) => {
        prompts.push(m);
        return 'Destroyed and respawn like enemy collisions';
      },
    });
    expect(prompts).toHaveLength(1);
    // The full question text must be visible in the prompt, not just line 1.
    expect(prompts[0]).toContain('destroyed and respawn (like enemy collisions)');
    expect(prompts[0]).toContain('or something else?');
    expect(outcome.recorded).toBe(1);
    expect(outcome.allAnswered).toBe(true);
    const updated = store.current();
    expect(updated.description).toContain('Destroyed and respawn like enemy collisions');
    expect(updated.description).not.toContain('OPEN QUESTION');
    // Metadata after the placeholder is preserved for the audit trail.
    expect(updated.description).toContain('Source: wl comment');
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

// ── Producer-review explanation ──────────────────────────────────────────

function comment(author: string, body: string): any {
  return {
    id: `C-${author}`,
    workItemId: 'WL-TEST-1',
    author,
    comment: body,
    createdAt: new Date().toISOString(),
    references: [],
  };
}

function flaggedItem(description: string, flagged = true): any {
  return {
    id: 'WL-TEST-1',
    title: 'Sample',
    description,
    needsProducerReview: flagged,
  } as any;
}

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

describe('buildProducerReviewExplanation', () => {
  const comments = [
    comment('bob', 'Second comment\nwith a second line'),
    comment('alice', 'First comment'),
  ];

  it('returns null when the item is not flagged for producer review', async () => {
    const result = await buildProducerReviewExplanation(flaggedItem('desc', false), {
      comments,
      chatClient: fakeChatClient('unused'),
    });
    expect(result).toBeNull();
  });

  it('preserves intentional line breaks in the LLM explanation (AC3)', async () => {
    const client = fakeChatClient('Reason: AC3 unmet\nAction: fix rendering');
    const result = await buildProducerReviewExplanation(flaggedItem('desc'), {
      comments,
      chatClient: client,
    });
    expect(result).toBe('Reason: AC3 unmet\nAction: fix rendering');
    expect(result!.split('\n').length).toBeGreaterThan(1);
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it('skips the LLM and uses the two most recent comments when --no-llm', async () => {
    const client = fakeChatClient('unused');
    const result = await buildProducerReviewExplanation(flaggedItem('desc'), {
      comments,
      chatClient: client,
      noLlm: true,
    });
    expect(client.complete).not.toHaveBeenCalled();
    expect(result).toContain('bob: Second comment');
    expect(result).toContain('alice: First comment');
  });

  it('falls back silently when the LLM call fails', async () => {
    const client = fakeChatClient(new Error('network unavailable'));
    const result = await buildProducerReviewExplanation(flaggedItem('desc'), {
      comments,
      chatClient: client,
    });
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(result).toContain('bob: Second comment');
  });

  it('falls back without calling an unavailable client', async () => {
    const client = { available: false, complete: vi.fn() };
    const result = await buildProducerReviewExplanation(flaggedItem('desc'), {
      comments,
      chatClient: client as any,
    });
    expect(client.complete).not.toHaveBeenCalled();
    expect(result).toContain('alice: First comment');
  });

  it('uses a generic actionable fallback when there are no comments', async () => {
    const result = await buildProducerReviewExplanation(flaggedItem('desc'), {
      comments: [],
      noLlm: true,
    });
    expect(result).toContain('WL-TEST-1');
  });

  it('builds the prompt from the instruction and the two most recent comments', async () => {
    const client = fakeChatClient('ok');
    const older = comment('old', 'Ancient history');
    await buildProducerReviewExplanation(flaggedItem('desc'), {
      comments: [...comments, older],
      chatClient: client,
    });
    const prompt = client.complete.mock.calls[0][0] as string;
    expect(prompt).toContain(PRODUCER_REVIEW_INSTRUCTION);
    expect(prompt).toContain('alice: First comment');
    expect(prompt).toContain('bob: Second comment');
    expect(prompt).not.toContain('Ancient history');
  });

  it('prompt instruction asks for the reason ("why") as well as the action (AC1)', () => {
    const instruction = PRODUCER_REVIEW_INSTRUCTION.toLowerCase();
    expect(instruction).toContain('why');
    expect(instruction).toContain('remove the needsproducerreview flag');
  });

  it('names the audit reason when the LLM path is disabled (AC1)', async () => {
    const auditResult = {
      readyToClose: false,
      auditedAt: '2026-10-04T21:00:00.000Z',
      author: 'audit-runner',
      summary: 'AC1 unmet: explanation does not state why',
    };
    const result = await buildProducerReviewExplanation(flaggedItem('desc'), {
      comments: [],
      auditResult,
      noLlm: true,
    });
    expect(result).toContain('not ready to close');
    expect(result).toContain('AC1 unmet: explanation does not state why');
  });

  it('surfaces audit evidence in the prompt and preserves multi-line rendering', async () => {
    const auditResult = {
      readyToClose: false,
      auditedAt: '2026-10-04T21:00:00.000Z',
      author: 'audit-runner',
      summary: 'AC3 unmet: rendering still truncates',
      rawOutput: 'VERDICT: not ready\nAC3: unmet',
    };
    const client = fakeChatClient('Because AC3 failed\nFix the renderer');
    const result = await buildProducerReviewExplanation(flaggedItem('desc'), {
      comments,
      auditResult,
      chatClient: client,
    });
    const prompt = client.complete.mock.calls[0][0] as string;
    expect(prompt).toContain(auditResult.summary);
    expect(result).toBe('Because AC3 failed\nFix the renderer');
  });

  describe('renderExplanation (AC3)', () => {
    it('preserves line breaks but collapses runs of spaces', () => {
      const rendered = renderExplanation('Line one\n\nLine two   with   spaces');
      expect(rendered).toBe('Line one\n\nLine two with spaces');
      expect(rendered.split('\n').length).toBeGreaterThan(1);
    });

    it('bounds the explanation by length', () => {
      const bounded = renderExplanation('x'.repeat(5000), 100, 50);
      expect(bounded.length).toBeLessThanOrEqual(100);
    });

    it('bounds the explanation by line count', () => {
      const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      const bounded = renderExplanation(many, 5000, 10);
      expect(bounded.split('\n').length).toBeLessThanOrEqual(10);
      expect(bounded.length).toBeLessThanOrEqual(5000);
    });

    it('marks truncation with an ellipsis', () => {
      const bounded = renderExplanation('x'.repeat(5000), 50, 50);
      expect(bounded.endsWith('…')).toBe(true);
    });
  });

  describe('buildFallbackExplanation structured signals (AC4)', () => {
    const auditResult = {
      readyToClose: false,
      auditedAt: '2026-10-04T21:00:00.000Z',
      author: 'audit-runner',
      summary: 'AC3 unmet: the explanation is still collapsed to one line',
      rawOutput: 'VERDICT: not ready\nAC3: unmet',
    };

    it('reports the audit verdict and summary when an audit result exists (a)', () => {
      const fallback = buildFallbackExplanation(flaggedItem('desc'), comments, auditResult);
      expect(fallback).toContain('not ready to close');
      expect(fallback).toContain(auditResult.summary);
      expect(fallback).not.toContain('bob: Second comment');
    });

    it('reports a durable audit waiver when there is no audit result', () => {
      const item = flaggedItem('desc') as any;
      item.auditWaiver = {
        reason: 'Audit gap deliberately accepted for a docs-only change',
        author: 'producer',
        waivedAt: '2026-10-04T21:00:00.000Z',
      };
      const fallback = buildFallbackExplanation(item, comments, null);
      expect(fallback).toContain('Audit gap waived by producer');
      expect(fallback).toContain('docs-only change');
    });

    it('falls back to the comments when there is no audit evidence (b)', () => {
      const fallback = buildFallbackExplanation(flaggedItem('desc'), comments, null);
      expect(fallback).toBe('bob: Second comment\nalice: First comment');
    });

    it('uses a generic actionable line as a last resort (c)', () => {
      const fallback = buildFallbackExplanation(flaggedItem('desc'), [], null);
      expect(fallback).toContain('WL-TEST-1');
      expect(fallback).toContain('No structured evidence');
    });
  });

  describe('buildExplanationPrompt audit context (AC2)', () => {
    const auditResult = {
      readyToClose: false,
      auditedAt: '2026-10-04T21:00:00.000Z',
      author: 'audit-runner',
      summary: 'AC3 unmet: rendering still truncates',
      rawOutput: 'VERDICT: not ready\nAC3: unmet',
    };

    it('includes the audit summary as first-class prompt context', () => {
      const prompt = buildExplanationPrompt(flaggedItem('desc'), comments, auditResult);
      expect(prompt).toContain(auditResult.summary);
      expect(prompt).toContain('Latest audit result:');
      expect(prompt).toContain('not ready to close');
    });

    it('keeps the audit context ahead of a large description', () => {
      const big = flaggedItem('z'.repeat(50000));
      const prompt = buildExplanationPrompt(big, [], auditResult);
      expect(prompt).toContain(auditResult.summary);
    });

    it('bounds the total prompt context by MAX_PROMPT_CONTEXT_BYTES', () => {
      const prefix = `${PRODUCER_REVIEW_INSTRUCTION}.\n\n`;
      const prompt = buildExplanationPrompt(
        flaggedItem('y'.repeat(50000)),
        [comment('a', 'z'.repeat(50000))],
        auditResult,
      );
      expect(prompt.startsWith(prefix)).toBe(true);
      const context = prompt.slice(prefix.length);
      expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(
        MAX_PROMPT_CONTEXT_BYTES,
      );
    });

    it('bounds the raw-output excerpt embedded in the prompt', () => {
      const hugeRaw = { ...auditResult, rawOutput: 'r'.repeat(50000) };
      const prompt = buildExplanationPrompt(flaggedItem('desc'), [], hugeRaw);
      const marker = 'Raw output (excerpt):';
      const rawIdx = prompt.indexOf(marker);
      expect(rawIdx).toBeGreaterThan(-1);
      const excerpt = prompt.slice(rawIdx + marker.length);
      // The bound plus the small trailing description/comments sections.
      expect(Buffer.byteLength(excerpt, 'utf8')).toBeLessThan(
        MAX_AUDIT_RAW_OUTPUT_BYTES + 200,
      );
    });
  });
});

describe('interview --json (non-interactive)', () => {
  /** Register the command with a JSON-capturing output and injected comments. */
  function setup(options: {
    item?: { description?: string; needsProducerReview?: boolean };
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
      needsProducerReview: options.item?.needsProducerReview ?? true,
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

  it('returns the explanation and question state without mutating the item', async () => {
    const client = fakeChatClient('Clear the flag by doing X.');
    const { ctx, id, jsonOutput } = setup({
      item: { description: '# Task\n\nNo section.', needsProducerReview: true },
      comments: [comment('producer', 'Please clarify scope.')],
      chatClient: client,
    });

    await ctx.runCli(['interview', id, '--json']);

    expect(jsonOutput).toHaveLength(1);
    expect(jsonOutput[0]).toMatchObject({
      success: true,
      workItemId: id,
      needsProducerReview: true,
      producerReviewExplanation: 'Clear the flag by doing X.',
      noSection: true,
      noQuestions: false,
    });
    // No mutation in JSON mode applies to the flag or the description.
    const stored = ctx.utils.db.get(id);
    expect(stored.needsProducerReview).toBe(true);
    expect(stored.description).toContain('No section.');
  });

  it('uses the comment fallback with --no-llm and never calls the LLM', async () => {
    const client = fakeChatClient('unused');
    const { ctx, id, jsonOutput } = setup({
      item: { description: '# Task\n\nNo section.', needsProducerReview: true },
      comments: [comment('producer', 'Please clarify scope.\nMore detail.')],
      chatClient: client,
    });

    await ctx.runCli(['interview', id, '--json', '--no-llm']);

    expect(client.complete).not.toHaveBeenCalled();
    expect(jsonOutput[0].producerReviewExplanation).toBe('producer: Please clarify scope.');
  });

  it('preserves a multi-line explanation and does not mutate the item (AC5)', async () => {
    const client = fakeChatClient('Reason: AC3 unmet\nAction: fix rendering');
    const { ctx, id, jsonOutput } = setup({
      item: { description: '# Task\n\nNo section.', needsProducerReview: true },
      comments: [],
      chatClient: client,
    });

    await ctx.runCli(['interview', id, '--json']);

    expect(jsonOutput).toHaveLength(1);
    expect(jsonOutput[0].producerReviewExplanation).toBe(
      'Reason: AC3 unmet\nAction: fix rendering',
    );
    // Round-trips as valid JSON with the newline preserved.
    expect(JSON.parse(JSON.stringify(jsonOutput[0])).producerReviewExplanation).toBe(
      'Reason: AC3 unmet\nAction: fix rendering',
    );
    const stored = ctx.utils.db.get(id);
    expect(stored.needsProducerReview).toBe(true);
    expect(stored.description).toContain('No section.');
  });

  it('surfaces the audit verdict and summary in --json when the LLM is disabled (AC4)', async () => {
    const { ctx, id, jsonOutput } = setup({
      item: { description: '# Task\n\nNo section.', needsProducerReview: true },
      comments: [],
      auditResult: {
        readyToClose: false,
        auditedAt: '2026-10-04T21:00:00.000Z',
        author: 'audit-runner',
        summary: 'AC3 unmet: rendering still truncates',
      },
      chatClient: fakeChatClient('unused'),
    });

    await ctx.runCli(['interview', id, '--json', '--no-llm']);

    expect(jsonOutput[0].producerReviewExplanation).toContain('not ready to close');
    expect(jsonOutput[0].producerReviewExplanation).toContain(
      'AC3 unmet: rendering still truncates',
    );
    const stored = ctx.utils.db.get(id);
    expect(stored.needsProducerReview).toBe(true);
  });

  it('returns a null explanation for a non-flagged item', async () => {
    const { ctx, id, jsonOutput } = setup({
      item: { description: '# Task\n\nNo section.', needsProducerReview: false },
      comments: [comment('producer', 'Hello')],
      chatClient: fakeChatClient('unused'),
    });

    await ctx.runCli(['interview', id, '--json']);

    expect(jsonOutput[0].needsProducerReview).toBe(false);
    expect(jsonOutput[0].producerReviewExplanation).toBeNull();
  });

  it('reports outstanding-question state without prompting in JSON mode', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Scope?" — Answer: *(awaiting producer)*. Source: reply.`;
    const { ctx, id, jsonOutput } = setup({
      item: { description: desc, needsProducerReview: true },
      comments: [comment('producer', 'Scope question raised.')],
      chatClient: fakeChatClient('unused'),
    });

    await ctx.runCli(['interview', id, '--json', '--no-llm']);

    expect(jsonOutput[0]).toMatchObject({
      noSection: false,
      noQuestions: false,
      total: 1,
      outstanding: 1,
      allAnswered: false,
    });
    // A flagged item with outstanding questions gets no explanation (only the
    // noSection/noQuestions cases do).
    expect(jsonOutput[0].producerReviewExplanation).toBeNull();
  });
});

// ── Clear-the-flag interactive prompt ────────────────────────────────────

describe('interview clear-the-flag prompt', () => {
  /**
   * Register the command for an interactive run with captured output and a
   * scripted prompt pool. The prompt loop is injected so no real readline
   * interface is created.
   */
  function setupInteractive(options: {
    description?: string;
    needsProducerReview?: boolean;
    answers?: string[];
    comments?: any[];
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
      needsProducerReview: options.needsProducerReview ?? true,
    });
    const baseGetDatabase = ctx.utils.getDatabase;
    ctx.utils.getDatabase = (prefix?: string) => ({
      ...baseGetDatabase(prefix),
      getCommentsForWorkItem: () => options.comments ?? [],
    });

    registerInterview(ctx as any, {
      chatClientFactory: () => null,
      promptLoopFactory: () => ({
        next: async (message: string) => {
          messages.push(message);
          return answers.shift() ?? '';
        },
        close: () => {},
      }),
      clearPrompt: async (message: string) => {
        messages.push(message);
        return /^y(es)?$/i.test((answers.shift() ?? '').trim());
      },
    });

    return {
      ctx,
      id,
      messages,
      restore: () => { console.log = originalLog; },
    };
  }

  it('prompts to clear the flag and clears it on yes', async () => {
    const t = setupInteractive({ answers: ['y'] });
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(t.messages.some(m => /Clear the needsProducerReview flag\? \(y\/N\)/.test(m))).toBe(true);
      expect(t.ctx.utils.db.get(t.id).needsProducerReview).toBe(false);
    } finally {
      t.restore();
    }
  });

  it('leaves the flag set on an explicit no', async () => {
    const t = setupInteractive({ answers: ['n'] });
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(t.ctx.utils.db.get(t.id).needsProducerReview).toBe(true);
      expect(t.messages.some(m => /remains flagged/.test(m))).toBe(true);
    } finally {
      t.restore();
    }
  });

  it('leaves the flag set on empty input (default No)', async () => {
    const t = setupInteractive({ answers: [''] });
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(t.ctx.utils.db.get(t.id).needsProducerReview).toBe(true);
    } finally {
      t.restore();
    }
  });

  it('does not prompt when no explanation was shown (unflagged item)', async () => {
    const t = setupInteractive({ needsProducerReview: false, answers: ['y'] });
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(t.messages.some(m => /Clear the needsProducerReview flag/.test(m))).toBe(false);
      // Unchanged (still false).
      expect(t.ctx.utils.db.get(t.id).needsProducerReview).toBe(false);
    } finally {
      t.restore();
    }
  });

  it('never prompts or mutates in --json mode', async () => {
    const ctx = createTestContext();
    const jsonOutput: any[] = [];
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => { messages.push(args.join(' ')); };
    ctx.output = { json: (d: any) => jsonOutput.push(d), success: () => {}, error: () => {} };
    const id = ctx.utils.createSampleItem({});
    ctx.utils.db.update(id, {
      description: '# Task\n\nNo clarifying section here.',
      needsProducerReview: true,
    });
    registerInterview(ctx as any, { chatClientFactory: () => null });

    try {
      await ctx.runCli(['interview', id, '--json']);
      expect(jsonOutput).toHaveLength(1);
      expect(ctx.utils.db.get(id).needsProducerReview).toBe(true);
      expect(messages.some(m => /Clear the needsProducerReview flag/.test(m))).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });

  it('does not prompt when questions remain outstanding', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Scope?" — Answer: *(awaiting producer)*. Source: reply.`;
    const t = setupInteractive({ description: desc, answers: ['answer', 'y'] });
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(t.messages.some(m => /Clear the needsProducerReview flag/.test(m))).toBe(false);
    } finally {
      t.restore();
    }
  });

  it('preserves the existing allAnswered auto-clear path (no prompt)', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Scope?" — Answer (user): "Repo-wide". Source: reply.`;
    const t = setupInteractive({ description: desc, answers: [] });
    try {
      await t.ctx.runCli(['interview', t.id]);
      expect(t.messages.some(m => /Clear the needsProducerReview flag/.test(m))).toBe(false);
      expect(t.ctx.utils.db.get(t.id).needsProducerReview).toBe(false);
    } finally {
      t.restore();
    }
  });
});
