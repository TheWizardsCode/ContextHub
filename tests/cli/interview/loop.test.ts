/**
 * Tests for the interview walkthrough loop and LLM-assisted question
 * extraction (WL-0MU55UDBJ008DJ67, WL-0MUH7ACKJ0024VGF).
 *
 * Split verbatim from tests/cli/interview.test.ts (WL-0MVXY35EN004KL85);
 * assertions, fixtures and describe titles are unchanged.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runInterview,
  tryExtractQuestionsWithLlm,
  parseExtractedQuestions,
  buildExtractionPrompt,
  EXTRACTION_TIMEOUT_MS,
  MAX_EXTRACTION_DESCRIPTION_BYTES,
} from '../../../src/commands/interview.js';

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
