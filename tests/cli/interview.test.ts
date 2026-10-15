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
  tryExtractQuestionsWithLlm,
  parseExtractedQuestions,
  buildExtractionPrompt,
  EXTRACTION_TIMEOUT_MS,
  MAX_EXTRACTION_DESCRIPTION_BYTES,
} from '../../src/commands/interview.js';
import {
  LLM_THINKING_MESSAGE,
  LLM_FALLBACK_NOTICE,
  type ProgressWriteStream,
} from '../../src/lib/progress-feedback.js';
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

function makeItem(description: string) {
  return {
    id: 'WL-TEST-1',
    title: 'Sample',
    description,
    status: 'open',
    stage: 'intake_complete',
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

  it('reports all-answered for a fully answered appendix', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Scope?" — Answer (user): "Repo-wide". Source: reply.`;
    const store = makeStore(makeItem(desc));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => 'unused',
    });
    expect(outcome.allAnswered).toBe(true);
    expect(outcome.recorded).toBe(0);
    expect(store.current().description).toContain('Repo-wide');
  });

  it('records a bullet-format answer, preserving Source', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Primary user?" — Answer (user): *(awaiting producer)*. Source: interactive reply.`;
    const store = makeStore(makeItem(desc));
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
  });

  it('answers an inline placeholder inside its surrounding markup', async () => {
    const desc = `## Appendix: Clarifying questions

- **Q:** "Where?"
  **Answer:** *(awaiting producer)*
  **Source:** reply.`;
    const store = makeStore(makeItem(desc));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => 'Acme org',
    });
    expect(outcome.recorded).toBe(1);
    const updated = store.current();
    expect(updated.description).toContain('**Answer:** Acme org');
    expect(updated.description).toContain('**Source:** reply.');
    expect(updated.description).not.toContain('awaiting producer');
  });

  it('persists partial progress when interrupted', async () => {
    const desc = `## Appendix: Clarifying questions

- Q: "One?" — Answer: *(awaiting producer)*. Source: reply.
- Q: "Two?" — Answer: *(awaiting producer)*. Source: reply.`;
    const store = makeStore(makeItem(desc));
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
  });

  it('records nothing when no answer is given', async () => {
    const desc = `## Appendix: Clarifying questions

- Q: "One?" — Answer: *(awaiting producer)*. Source: reply.
- Q: "Two?" — Answer: *(awaiting producer)*. Source: reply.`;
    const store = makeStore(makeItem(desc));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => '',
    });
    expect(outcome.recorded).toBe(0);
    expect(outcome.allAnswered).toBe(false);
  });

  it('appends an answer scaffold when no marker is present', async () => {
    const desc = `## Clarifying questions

- **Q:** A question with no recorded answer marker?`;
    const store = makeStore(makeItem(desc));
    const outcome = await runInterview(store.current(), store, {
      prompt: async () => 'Yes',
    });
    expect(outcome.recorded).toBe(1);
    const updated = store.current();
    expect(updated.description).toContain('A question with no recorded answer marker?');
    expect(updated.description).toContain('Yes');
  });

  it('prompts with the full multi-line question and answers an OPEN QUESTION placeholder (WL-0MUKCGV3X0030W6K)', async () => {
    const desc = `## Appendix: Clarifying questions

- **Q (round 1 follow-up):** Crash behaviour — destroyed and respawn (like enemy
  collisions) or something else? — **OPEN QUESTION**, context: not yet answered.
  Interim assumption: destroy + reuse the shared player-hit lifecycle.
  Source: wl comment \`AH-C0MUB8JD13004UD9E\`.`;
    const store = makeStore(makeItem(desc));
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

describe('tryExtractQuestionsWithLlm', () => {
  it('reports usedLlm true and the parsed questions on success', async () => {
    const chat = {
      available: true,
      complete: vi.fn(async () => '[{"question":"Q?"}]'),
    };
    const result = await tryExtractQuestionsWithLlm(chat as any, 'desc');
    expect(result).toEqual({ questions: ['Q?'], usedLlm: true });
  });

  it('reports usedLlm false when the request throws', async () => {
    const chat = {
      available: true,
      complete: vi.fn(async () => {
        throw new Error('timeout');
      }),
    };
    const result = await tryExtractQuestionsWithLlm(chat as any, 'desc');
    expect(result).toEqual({ questions: [], usedLlm: false });
  });

  it('reports usedLlm false and skips an unavailable client', async () => {
    const chat = { available: false, complete: vi.fn() };
    const result = await tryExtractQuestionsWithLlm(chat as any, 'desc');
    expect(result).toEqual({ questions: [], usedLlm: false });
    expect(chat.complete).not.toHaveBeenCalled();
  });
});

describe('runInterview LLM progress hooks', () => {
  it('fires onLlmStart before the request and settles with usedLlm true', async () => {
    const store = makeStore(makeItem('# Task\n\nNo section.'));
    const events: string[] = [];
    const chat = {
      available: true,
      complete: vi.fn(async () => {
        events.push('request');
        return '[]';
      }),
    };
    await runInterview(
      store.current(),
      store,
      { prompt: async () => 'unused' },
      {
        llmFallback: true,
        chatClient: chat as any,
        onLlmStart: () => events.push('start'),
        onLlmSettled: info => events.push(`settled:${info.usedLlm}`),
      },
    );
    expect(events).toEqual(['start', 'request', 'settled:true']);
  });

  it('settles with usedLlm false when the request throws', async () => {
    const store = makeStore(makeItem('# Task\n\nNo section.'));
    const settled: boolean[] = [];
    const chat = {
      available: true,
      complete: vi.fn(async () => {
        throw new Error('timeout');
      }),
    };
    await runInterview(
      store.current(),
      store,
      { prompt: async () => 'unused' },
      {
        llmFallback: true,
        chatClient: chat as any,
        onLlmSettled: info => settled.push(info.usedLlm),
      },
    );
    expect(settled).toEqual([false]);
  });

  it('never fires the hooks when deterministic questions exist', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Existing?" — Answer (user): "Yes". Source: reply.`;
    const store = makeStore(makeItem(desc));
    const chat = { available: true, complete: vi.fn(async () => '[]') };
    let started = 0;
    await runInterview(
      store.current(),
      store,
      { prompt: async () => 'unused' },
      {
        llmFallback: true,
        chatClient: chat as any,
        onLlmStart: () => {
          started += 1;
        },
      },
    );
    expect(started).toBe(0);
    expect(chat.complete).not.toHaveBeenCalled();
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

// ── No-section / no-questions interactive path ────────────────────────

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

// ── LLM-assisted question extraction (WL-0MUH7ACKJ0024VGF) ───────────────

describe('parseExtractedQuestions', () => {
  it('parses a JSON array of question objects', () => {
    expect(parseExtractedQuestions('[{"question":"A?"},{"question":"B?"}]')).toEqual([
      'A?',
      'B?',
    ]);
  });

  it('returns an empty array for [] and blank input', () => {
    expect(parseExtractedQuestions('[]')).toEqual([]);
    expect(parseExtractedQuestions('   ')).toEqual([]);
  });

  it('tolerates markdown fences and surrounding prose', () => {
    expect(
      parseExtractedQuestions('Here you go:\n```json\n[{"question":"Fenced?"}]\n```'),
    ).toEqual(['Fenced?']);
  });

  it('degrades to an empty array for malformed or non-array payloads', () => {
    expect(parseExtractedQuestions('not json')).toEqual([]);
    expect(parseExtractedQuestions('{"question":"object?"}')).toEqual([]);
    expect(parseExtractedQuestions('[{"nope":1},"bad",{"question":"  "}]')).toEqual([]);
  });

  it('de-duplicates repeated questions', () => {
    expect(
      parseExtractedQuestions('[{"question":"Same?"},{"question":"Same?"}]'),
    ).toEqual(['Same?']);
  });
});

describe('buildExtractionPrompt', () => {
  it('bounds the description to the 8 KB extraction limit', () => {
    const prompt = buildExtractionPrompt('x'.repeat(20_000));
    expect(prompt).toContain('Extract every unanswered clarifying question');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(
      MAX_EXTRACTION_DESCRIPTION_BYTES + 1000,
    );
  });
});

describe('runInterview LLM extraction fallback', () => {
  const noSectionDesc = '# Task\n\nNo clarifying section here.';
  const noQuestionsDesc = `# Task

## Appendix: Clarifying questions

No questions here — just context prose.`;

  function extractionClient(response: string | Error, available = true): any {
    return {
      available,
      complete: vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
      }),
    };
  }

  it('extracts questions, confirms each, and writes answers deterministically', async () => {
    const store = makeStore(makeItem(noSectionDesc));
    const chat = extractionClient(
      '[{"question":"Who is the user?"},{"question":"What format?"}]',
    );
    const prompts: string[] = [];
    const answers = ['Support engineers', 'JSON'];
    const outcome = await runInterview(
      store.current(),
      store,
      {
        prompt: async (message: string) => {
          prompts.push(message);
          return answers.shift() ?? '';
        },
      },
      { llmFallback: true, chatClient: chat, timeoutMs: EXTRACTION_TIMEOUT_MS },
    );

    expect(chat.complete).toHaveBeenCalledTimes(1);
    expect(chat.complete.mock.calls[0][1]).toEqual({ timeoutMs: 15_000 });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Who is the user?');
    expect(outcome.extracted).toBe(2);
    expect(outcome.recorded).toBe(2);
    expect(outcome.allAnswered).toBe(true);

    const desc = store.current().description;
    expect(desc).toContain('## Appendix: Clarifying questions');
    expect(desc).toContain('- Q: Who is the user? — Answer (producer): Support engineers');
    expect(desc).toContain('- Q: What format? — Answer (producer): JSON');
  });

  it('returns the deterministic no-question fallback when the LLM returns []', async () => {
    const store = makeStore(makeItem(noSectionDesc));
    const chat = extractionClient('[]');
    const outcome = await runInterview(
      store.current(),
      store,
      { prompt: async () => 'unused' },
      { llmFallback: true, chatClient: chat },
    );
    expect(outcome.extracted).toBe(0);
    expect(outcome.noSection).toBe(true);
    expect(store.current().description).toBe(noSectionDesc);
  });

  it('degrades silently when the LLM throws (network/timeout)', async () => {
    const store = makeStore(makeItem(noSectionDesc));
    const chat = extractionClient(new Error('Chat API request timed out after 15000 ms'));
    const outcome = await runInterview(
      store.current(),
      store,
      { prompt: async () => 'unused' },
      { llmFallback: true, chatClient: chat },
    );
    expect(outcome.extracted).toBe(0);
    expect(outcome.noSection).toBe(true);
    expect(store.current().description).toBe(noSectionDesc);
  });

  it('does not call an unavailable client', async () => {
    const store = makeStore(makeItem(noSectionDesc));
    const chat = extractionClient('ignored', false);
    const outcome = await runInterview(
      store.current(),
      store,
      { prompt: async () => 'unused' },
      { llmFallback: true, chatClient: chat },
    );
    expect(chat.complete).not.toHaveBeenCalled();
    expect(outcome.extracted).toBe(0);
  });

  it('never calls the LLM when the deterministic parser finds questions', async () => {
    const desc = `# Task

## Appendix: Clarifying questions

- Q: "Existing?" — Answer (user): "Yes". Source: reply.`;
    const store = makeStore(makeItem(desc));
    const chat = extractionClient('[{"question":"Hallucinated?"}]');
    const outcome = await runInterview(
      store.current(),
      store,
      { prompt: async () => 'unused' },
      { llmFallback: true, chatClient: chat },
    );
    expect(chat.complete).not.toHaveBeenCalled();
    expect(outcome.extracted).toBe(0);
    expect(outcome.allAnswered).toBe(true);
  });

  it('writes only operator-confirmed extracted questions', async () => {
    const store = makeStore(makeItem(noSectionDesc));
    const chat = extractionClient('[{"question":"Keep me?"},{"question":"Skip me?"}]');
    const answers = ['Confirmed', ''];
    const outcome = await runInterview(
      store.current(),
      store,
      { prompt: async () => answers.shift() ?? '' },
      { llmFallback: true, chatClient: chat },
    );
    expect(outcome.recorded).toBe(1);
    expect(outcome.outstanding).toBe(1);
    expect(outcome.allAnswered).toBe(false);
    const desc = store.current().description;
    expect(desc).toContain('Keep me?');
    expect(desc).not.toContain('Skip me?');
  });

  it('feeds the clarifying-section body (not the whole description) to the LLM', async () => {
    const desc = `# Task

UNRELATED_PREAMBLE_SENTINEL

## Appendix: Clarifying questions

SECTION_BODY_SENTINEL

## Risks

MORE`;
    const store = makeStore(makeItem(desc));
    const chat = extractionClient('[]');
    await runInterview(
      store.current(),
      store,
      { prompt: async () => 'unused' },
      { llmFallback: true, chatClient: chat },
    );
    const prompt = chat.complete.mock.calls[0][0] as string;
    expect(prompt).toContain('SECTION_BODY_SENTINEL');
    expect(prompt).not.toContain('UNRELATED_PREAMBLE_SENTINEL');
  });

  it('merges extracted questions into an existing question-free section', async () => {
    const store = makeStore(makeItem(noQuestionsDesc));
    const chat = extractionClient('[{"question":"Merged?"}]');
    const outcome = await runInterview(
      store.current(),
      store,
      { prompt: async () => 'Yes' },
      { llmFallback: true, chatClient: chat },
    );
    expect(outcome.extracted).toBe(1);
    const desc = store.current().description;
    expect(desc.match(/## Appendix: Clarifying questions/g)).toHaveLength(1);
    expect(desc).toContain('just context prose');
    expect(desc).toContain('- Q: Merged? — Answer (producer): Yes');
  });
});

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

// ── Command-level LLM progress feedback (WL-0MUX2W8IN005RW66) ───────────

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
