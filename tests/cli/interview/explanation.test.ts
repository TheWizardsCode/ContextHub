/**
 * Tests for the producer-review explanation path (WL-0MUUAMP7M008Z4GK,
 * WL-0MUX2W8IN005RW66, WL-0MVAMS4RO000H3B0 F1).
 *
 * Split verbatim from tests/cli/interview.test.ts (WL-0MVXY35EN004KL85);
 * assertions, fixtures and describe titles are unchanged.
 */

import { describe, it, expect, vi } from 'vitest';

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

// ── Restored producer-review flag flow (WL-0MVAMS4RO000H3B0 F1) ─────────
// RED-pinned contract: the flag explain/clear flow was removed with
// `needsProducerReview` (WL-0MV85WFYU0071YQ9). These specs pin the restored
// interface. They are wrapped in `it(...)` so the gated suite stays
// green while the contract is failing; F5 (theme/interview/shortcuts restore)
// flips `it(` → `it(`.
//
// Documented interface (function names/signatures, per the item's AC):
//   buildProducerReviewExplanation(item, opts) → Promise<string|null>
//   buildProducerReviewExplanationResult(item, opts) → { text, usedLlm } | null
//   buildExplanationPrompt(item, comments, auditResult) → string
//   buildFallbackExplanation(item, comments, auditResult) → string
//   renderExplanation(text, maxChars?, maxLines?) → string
//   PRODUCER_REVIEW_INSTRUCTION : string
//   MAX_PROMPT_CONTEXT_BYTES : number
//   MAX_AUDIT_RAW_OUTPUT_BYTES : number
// (`comment` and `fakeChatClient` helpers are already defined above.)

function flaggedItem(description: string, flagged = true): any {
  return {
    id: 'WL-TEST-1',
    title: 'Sample',
    description,
    needsProducerReview: flagged,
  } as any;
}

/** Load the interview module namespace (helpers may not exist yet). */
async function loadInterview(): Promise<Record<string, any>> {
  return import('../../../src/commands/interview.js');
}

describe('buildProducerReviewExplanation (RED-contract, restored)', () => {
  const comments = [
    comment('bob', 'Second comment\nwith a second line'),
    comment('alice', 'First comment'),
  ];

  it('returns null when the item is not flagged for producer review', async () => {
    const m = await loadInterview();
    const result = await m.buildProducerReviewExplanation(flaggedItem('desc', false), {
      comments,
      chatClient: fakeChatClient('unused'),
    });
    expect(result).toBeNull();
  });

  it('preserves intentional line breaks in the LLM explanation', async () => {
    const m = await loadInterview();
    const client = fakeChatClient('Reason: AC3 unmet\nAction: fix rendering');
    const result = await m.buildProducerReviewExplanation(flaggedItem('desc'), {
      comments,
      chatClient: client,
    });
    expect(result).toBe('Reason: AC3 unmet\nAction: fix rendering');
    expect(result!.split('\n').length).toBeGreaterThan(1);
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it('skips the LLM and uses the two most recent comments when --no-llm', async () => {
    const m = await loadInterview();
    const client = fakeChatClient('unused');
    const result = await m.buildProducerReviewExplanation(flaggedItem('desc'), {
      comments,
      chatClient: client,
      noLlm: true,
    });
    expect(client.complete).not.toHaveBeenCalled();
    expect(result).toContain('bob: Second comment');
    expect(result).toContain('alice: First comment');
  });

  it('falls back silently when the LLM call fails', async () => {
    const m = await loadInterview();
    const client = fakeChatClient(new Error('network unavailable'));
    const result = await m.buildProducerReviewExplanation(flaggedItem('desc'), {
      comments,
      chatClient: client,
    });
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(result).toContain('bob: Second comment');
  });

  it('uses a generic actionable fallback when there are no comments', async () => {
    const m = await loadInterview();
    const result = await m.buildProducerReviewExplanation(flaggedItem('desc'), {
      comments: [],
      noLlm: true,
    });
    expect(result).toContain('WL-TEST-1');
  });

  it('builds the prompt from the instruction and the two most recent comments', async () => {
    const m = await loadInterview();
    const client = fakeChatClient('ok');
    const older = comment('old', 'Ancient history');
    await m.buildProducerReviewExplanation(flaggedItem('desc'), {
      comments: [...comments, older],
      chatClient: client,
    });
    const prompt = client.complete.mock.calls[0][0] as string;
    expect(prompt).toContain(m.PRODUCER_REVIEW_INSTRUCTION);
    expect(prompt).toContain('alice: First comment');
    expect(prompt).toContain('bob: Second comment');
    expect(prompt).not.toContain('Ancient history');
  });
});

describe('buildProducerReviewExplanationResult (RED-contract, restored)', () => {
  it('reports usedLlm true when the LLM returns an explanation', async () => {
    const m = await loadInterview();
    const result = await m.buildProducerReviewExplanationResult(flaggedItem('desc'), {
      comments: [comment('alice', 'First comment')],
      chatClient: fakeChatClient('LLM reason'),
    });
    expect(result).toEqual({ text: 'LLM reason', usedLlm: true });
  });

  it('reports usedLlm false when the LLM throws (timeout/error)', async () => {
    const m = await loadInterview();
    const result = await m.buildProducerReviewExplanationResult(flaggedItem('desc'), {
      comments: [comment('alice', 'First comment')],
      chatClient: fakeChatClient(new Error('Chat API request timed out')),
    });
    expect(result?.usedLlm).toBe(false);
    expect(result?.text).toBeTruthy();
  });

  it('returns null for an unflagged item', async () => {
    const m = await loadInterview();
    const result = await m.buildProducerReviewExplanationResult(flaggedItem('desc', false), {
      comments: [comment('alice', 'First comment')],
      chatClient: fakeChatClient('unused'),
    });
    expect(result).toBeNull();
  });
});

describe('renderExplanation + buildFallbackExplanation + buildExplanationPrompt (RED-contract, restored)', () => {
  it('renderExplanation preserves line breaks but collapses runs of spaces', async () => {
    const m = await loadInterview();
    const rendered = m.renderExplanation('Line one\n\nLine two   with   spaces');
    expect(rendered).toBe('Line one\n\nLine two with spaces');
    expect(rendered.split('\n').length).toBeGreaterThan(1);
  });

  it('renderExplanation bounds the explanation by length', async () => {
    const m = await loadInterview();
    const bounded = m.renderExplanation('x'.repeat(5000), 100, 50);
    expect(bounded.length).toBeLessThanOrEqual(100);
  });

  it('buildFallbackExplanation reports the audit verdict and summary when an audit result exists', async () => {
    const m = await loadInterview();
    const auditResult = {
      readyToClose: false,
      auditedAt: '2026-10-04T21:00:00.000Z',
      author: 'audit-runner',
      summary: 'AC3 unmet: the explanation is still collapsed to one line',
      rawOutput: 'VERDICT: not ready\nAC3: unmet',
    };
    const fallback = m.buildFallbackExplanation(flaggedItem('desc'), [comment('bob', 'Second comment')], auditResult);
    expect(fallback).toContain('not ready to close');
    expect(fallback).toContain(auditResult.summary);
  });

  it('buildExplanationPrompt includes the audit summary as first-class prompt context', async () => {
    const m = await loadInterview();
    const auditResult = {
      readyToClose: false,
      auditedAt: '2026-10-04T21:00:00.000Z',
      author: 'audit-runner',
      summary: 'AC3 unmet: rendering still truncates',
      rawOutput: 'VERDICT: not ready\nAC3: unmet',
    };
    const prompt = m.buildExplanationPrompt(flaggedItem('desc'), [comment('alice', 'First comment')], auditResult);
    expect(prompt).toContain(auditResult.summary);
    expect(prompt).toContain('Latest audit result:');
    expect(prompt).toContain('not ready to close');
  });
});
