/**
 * packages/herdr/src/producer-answer-capture.test.ts — pin for recording a
 * producer's answer in the row's own Appendix and releasing the answered hold
 * (WL-0MWVMRXUZ0031P1S, child 4 of WL-0MWTVPK65009NTER).
 *
 * The parent acceptance criterion is "no answer, no clear": an answer is
 * recorded once (idempotently) in the row's own worklog, and only an answered
 * row's hold is released, with a comment that names the justifying answer.
 * This suite pins:
 *
 *  - the Appendix entry carries the question as asked, the answer verbatim,
 *    the answering party, the batch id, the document path and the evidence link;
 *  - re-running for the same row and batch id UPDATES the entry (never a
 *    duplicate) and never posts a second clear comment;
 *  - clearing refuses — before any write — when the answer entry is absent or
 *    is not this batch's recorded answer;
 *  - the clear runs answer-first then flag-off then audit-comment, naming the
 *    answer comment id, the document path and the clearing agent;
 *  - a "keep waiting / do not proceed" answer is recorded and the row is left
 *    flagged;
 *  - every row write targets the row's own root; the summary is the only write
 *    to the batch item's root.
 *
 * Every fixture is inline data: no live worklog, no filesystem, no sleeps.
 */

import { describe, expect, it } from 'vitest';

import {
  ProducerAnswerCaptureError,
  applyProducerAnswer,
  clearAnsweredRow,
  composeProducerAnswerAppendix,
  composeProducerAnswerClearComment,
  composeProducerAnswerSummary,
  isDeferralAnswer,
  producerAnswerClearMarker,
  producerAnswerMarker,
  producerAnswerSummaryMarker,
  recordAppliedAnswersSummary,
  recordProducerAnswer,
  type ProducerAnswerCaptureIo,
  type ProducerAnswerCommentRef,
  type ProducerAnswerItem,
} from './producer-answer-capture.js';
import {
  ProducerAnswerFileError,
  parseProducerAnswerFile,
  parseProducerInterviewApplyAnswersArgs,
  PRODUCER_INTERVIEW_APPLY_ANSWERS_USAGE,
  resolveAnswers,
  runProducerInterviewApplyAnswers,
  type ProducerInterviewApplyAnswersCliIo,
} from '../../../scripts/producer-interview-apply-answers.js';
import type {
  ProducerInterviewRow,
  ProducerInterviewSnapshot,
} from './producer-interview-snapshot.js';

const BATCH_ID = '2026-11-25T16:37:25.000Z';
const DOCUMENT_PATH = 'docs/dev/producer-interview-batch-2026-11-25.md';
const AI_HELL = '/home/operator/projects/AI_Hell';
const CONTEXT_HUB = '/home/operator/projects/ContextHub';
const BATCH_ITEM = 'WL-0MWTVPK65009NTER';
const ITEM = 'AH-0MWEUSVJ1007EXJY';
const QUESTION = 'Q1: which option? (a) or (b)?';
const ANSWER = 'clear it — option (a)';

function row(
  id: string,
  root: string = AI_HELL,
  question: string = `question: what should ${id} do?`,
): ProducerInterviewRow {
  return {
    id,
    root,
    title: `Title for ${id}`,
    question,
    evidenceCommentId: 'AH-C000000000000001',
    flagAge: '2d 0h',
  };
}

function snapshot(rows: ProducerInterviewRow[], generatedAt = BATCH_ID): ProducerInterviewSnapshot {
  return {
    generatedAt,
    roots: [],
    counts: { 'needs-producer-input': rows.length, 'can-clear-now': 0 },
    flaggedTotal: rows.length,
    skippedNotPrep: 0,
    classified: [],
    interview: rows,
    errors: [],
  };
}

function captureInput(overrides: Partial<Parameters<typeof recordProducerAnswer>[1]> = {}) {
  return {
    root: AI_HELL,
    itemId: ITEM,
    batchId: BATCH_ID,
    question: QUESTION,
    answer: ANSWER,
    answeringParty: 'Map',
    documentPath: DOCUMENT_PATH,
    ...overrides,
  };
}

type Call =
  | { op: 'getItem'; root: string; itemId: string }
  | { op: 'listComments'; root: string; itemId: string }
  | { op: 'addComment'; root: string; itemId: string; body: string; author: string }
  | { op: 'updateComment'; root: string; commentId: string; body: string }
  | { op: 'reviewed'; root: string; itemId: string; value: boolean };

/** A fake `wl` runner: every mutation is a recorded call, not a promise. */
class FakeCaptureIo implements ProducerAnswerCaptureIo {
  readonly items = new Map<string, ProducerAnswerItem>();
  readonly comments = new Map<string, ProducerAnswerCommentRef[]>();
  readonly calls: Call[] = [];
  failAddFor: string | null = null;
  failReviewFor: string | null = null;
  private nextComment = 1;

  private key(root: string, itemId: string): string {
    return `${root}\u0000${itemId}`;
  }

  seedItem(item: ProducerAnswerItem, root: string): void {
    this.items.set(this.key(root, item.id), { ...item });
  }

  seedComment(root: string, itemId: string, ref: ProducerAnswerCommentRef): void {
    const key = this.key(root, itemId);
    this.comments.set(key, [...(this.comments.get(key) ?? []), ref]);
  }

  commentsOn(root: string, itemId: string): ReadonlyArray<ProducerAnswerCommentRef> {
    return this.comments.get(this.key(root, itemId)) ?? [];
  }

  addsOn(root: string, itemId: string): Call[] {
    return this.calls.filter(
      (call) => call.op === 'addComment' && call.root === root && call.itemId === itemId,
    );
  }

  reviewsOn(root: string, itemId: string): Call[] {
    return this.calls.filter(
      (call) => call.op === 'reviewed' && call.root === root && call.itemId === itemId,
    );
  }

  async getItem(root: string, itemId: string): Promise<ProducerAnswerItem> {
    this.calls.push({ op: 'getItem', root, itemId });
    const item = this.items.get(this.key(root, itemId));
    if (item === undefined) throw new Error(`work item not found: ${itemId}`);
    return { ...item };
  }

  async listComments(
    root: string,
    itemId: string,
  ): Promise<ReadonlyArray<ProducerAnswerCommentRef>> {
    this.calls.push({ op: 'listComments', root, itemId });
    return [...this.commentsOn(root, itemId)];
  }

  async addComment(input: {
    root: string;
    itemId: string;
    body: string;
    author: string;
  }): Promise<ProducerAnswerCommentRef> {
    this.calls.push({ ...input, op: 'addComment' });
    if (this.failAddFor === input.itemId) throw new Error('wl comment add failed');
    const ref: ProducerAnswerCommentRef = {
      id: `WL-C${String(this.nextComment++).padStart(6, '0')}`,
      comment: input.body,
      author: input.author,
    };
    this.seedComment(input.root, input.itemId, ref);
    return { ...ref };
  }

  async updateComment(input: {
    root: string;
    commentId: string;
    body: string;
  }): Promise<ProducerAnswerCommentRef> {
    this.calls.push({ ...input, op: 'updateComment' });
    for (const [key, refs] of this.comments.entries()) {
      const index = refs.findIndex((ref) => ref.id === input.commentId);
      if (index >= 0) {
        refs[index] = { ...refs[index], comment: input.body };
        return { ...refs[index] };
      }
      void key;
    }
    throw new Error(`comment not found: ${input.commentId}`);
  }

  async setNeedsProducerReview(root: string, itemId: string, value: boolean): Promise<void> {
    this.calls.push({ op: 'reviewed', root, itemId, value });
    if (this.failReviewFor === itemId) throw new Error('wl reviewed failed');
    const item = this.items.get(this.key(root, itemId));
    if (item === undefined) throw new Error(`work item not found: ${itemId}`);
    item.needsProducerReview = value;
  }
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to reject');
}

// ── Deferral detection ───────────────────────────────────────────────

describe('isDeferralAnswer', () => {
  it('recognises the documented "keep waiting / do not proceed" answers', () => {
    expect(isDeferralAnswer('keep waiting — the design is not settled')).toBe(true);
    expect(isDeferralAnswer('Keep waiting')).toBe(true);
    expect(isDeferralAnswer('do not proceed')).toBe(true);
    expect(isDeferralAnswer("don't proceed until Q2 is answered")).toBe(true);
    expect(isDeferralAnswer('leave it flagged for now')).toBe(true);
  });

  it('does not mistake a clear answer that mentions proceeding for a deferral', () => {
    expect(isDeferralAnswer('clear it — proceed with option (a)')).toBe(false);
    expect(isDeferralAnswer('clear it and proceed with the legacy path')).toBe(false);
    expect(isDeferralAnswer('clear it')).toBe(false);
  });
});

// ── Appendix composition ─────────────────────────────────────────────

describe('composeProducerAnswerAppendix', () => {
  it('records the question as asked, the answer verbatim, the party, the batch id and the document', () => {
    const body = composeProducerAnswerAppendix(captureInput());
    expect(body).toContain(QUESTION);
    expect(body).toContain(ANSWER);
    expect(body).toContain('**Answering party:** Map');
    expect(body).toContain(`**Batch id:** \`${BATCH_ID}\``);
    expect(body).toContain(DOCUMENT_PATH);
    expect(body).toContain(producerAnswerMarker(ITEM, BATCH_ID));
  });

  it('records the evidence link when the reply arrived as a comment, and says so when transcribed', () => {
    const withComment = composeProducerAnswerAppendix(
      captureInput({ sourceAnswerCommentId: 'AH-C0MWMSPLPT002T2L6' }),
    );
    expect(withComment).toContain('**Evidence:** `comment:AH-C0MWMSPLPT002T2L6`');
    const transcribed = composeProducerAnswerAppendix(captureInput());
    expect(transcribed).toContain('transcribed from the batch reply');
  });

  it('marks a deferral as left flagged with the stated reason', () => {
    const body = composeProducerAnswerAppendix(
      captureInput({ answer: 'keep waiting because the budget question is unresolved' }),
    );
    expect(body).toContain('**Left flagged**');
    expect(body).toContain('keep waiting because the budget question is unresolved');
    expect(body).not.toContain('Clear authorised');
  });

  it('is deterministic', () => {
    expect(composeProducerAnswerAppendix(captureInput())).toBe(
      composeProducerAnswerAppendix(captureInput()),
    );
  });
});

// ── Answer capture ───────────────────────────────────────────────────

describe('recordProducerAnswer', () => {
  it('appends one Appendix entry on the row\'s own root and returns its comment id', async () => {
    const io = new FakeCaptureIo();
    const record = await recordProducerAnswer(io, captureInput());

    expect(record.created).toBe(true);
    expect(record.updated).toBe(false);
    expect(record.commentId).toBe('WL-C000001');
    expect(io.addsOn(AI_HELL, ITEM)).toHaveLength(1);
    expect(io.commentsOn(AI_HELL, ITEM)).toHaveLength(1);
    expect(io.commentsOn(AI_HELL, ITEM)[0].comment).toContain(producerAnswerMarker(ITEM, BATCH_ID));
  });

  it('updates the existing entry on a re-run for the same row and batch id — never a duplicate', async () => {
    const io = new FakeCaptureIo();
    const first = await recordProducerAnswer(io, captureInput());
    const second = await recordProducerAnswer(io, captureInput({ answer: 'clear it — option (b)' }));

    expect(second.commentId).toBe(first.commentId);
    expect(second.created).toBe(false);
    expect(second.updated).toBe(true);
    expect(io.addsOn(AI_HELL, ITEM)).toHaveLength(1);
    expect(io.commentsOn(AI_HELL, ITEM)).toHaveLength(1);
    expect(io.commentsOn(AI_HELL, ITEM)[0].comment).toContain('clear it — option (b)');
    expect(
      io.calls.filter((call) => call.op === 'updateComment'),
    ).toHaveLength(1);
  });

  it('treats a marker for another batch id as a different entry', async () => {
    const io = new FakeCaptureIo();
    await recordProducerAnswer(io, captureInput());
    await recordProducerAnswer(io, captureInput({ batchId: '2026-11-26T00:00:00.000Z' }));

    expect(io.commentsOn(AI_HELL, ITEM)).toHaveLength(2);
    expect(io.addsOn(AI_HELL, ITEM)).toHaveLength(2);
  });
});

// ── Clear refusal and ordering ───────────────────────────────────────

describe('clearAnsweredRow', () => {
  async function recorded(io: FakeCaptureIo) {
    io.seedItem({ id: ITEM, needsProducerReview: true }, AI_HELL);
    return recordProducerAnswer(io, captureInput());
  }

  it('refuses to clear a row with no answer comment id — posting nothing and clearing nothing', async () => {
    const io = new FakeCaptureIo();
    io.seedItem({ id: ITEM, needsProducerReview: true }, AI_HELL);

    const error = await reject(
      clearAnsweredRow(io, {
        root: AI_HELL,
        itemId: ITEM,
        batchId: BATCH_ID,
        answerCommentId: '   ',
        documentPath: DOCUMENT_PATH,
        clearingAgent: 'Map',
      }),
    );

    expect(error).toBeInstanceOf(ProducerAnswerCaptureError);
    expect((error as ProducerAnswerCaptureError).code).toBe('answer_missing');
    expect(io.addsOn(AI_HELL, ITEM)).toHaveLength(0);
    expect(io.reviewsOn(AI_HELL, ITEM)).toHaveLength(0);
  });

  it('refuses to clear when the answer entry is not on the row', async () => {
    const io = new FakeCaptureIo();
    io.seedItem({ id: ITEM, needsProducerReview: true }, AI_HELL);

    const error = await reject(
      clearAnsweredRow(io, {
        root: AI_HELL,
        itemId: ITEM,
        batchId: BATCH_ID,
        answerCommentId: 'WL-CMISSING',
        documentPath: DOCUMENT_PATH,
        clearingAgent: 'Map',
      }),
    );

    expect((error as ProducerAnswerCaptureError).code).toBe('answer_missing');
    expect(io.addsOn(AI_HELL, ITEM)).toHaveLength(0);
    expect(io.reviewsOn(AI_HELL, ITEM)).toHaveLength(0);
  });

  it('refuses a comment that is not this batch\'s recorded answer', async () => {
    const io = new FakeCaptureIo();
    io.seedItem({ id: ITEM, needsProducerReview: true }, AI_HELL);
    io.seedComment(AI_HELL, ITEM, { id: 'WL-CRANDOM', comment: 'unrelated comment' });

    const error = await reject(
      clearAnsweredRow(io, {
        root: AI_HELL,
        itemId: ITEM,
        batchId: BATCH_ID,
        answerCommentId: 'WL-CRANDOM',
        documentPath: DOCUMENT_PATH,
        clearingAgent: 'Map',
      }),
    );

    expect((error as ProducerAnswerCaptureError).code).toBe('answer_not_captured');
    expect(io.addsOn(AI_HELL, ITEM)).toHaveLength(0);
    expect(io.reviewsOn(AI_HELL, ITEM)).toHaveLength(0);
  });

  it('records the answer, then clears the flag, then posts the audit comment naming the answer, document and agent', async () => {
    const io = new FakeCaptureIo();
    const record = await recorded(io);

    const clear = await clearAnsweredRow(io, {
      root: AI_HELL,
      itemId: ITEM,
      batchId: BATCH_ID,
      answerCommentId: record.commentId,
      documentPath: DOCUMENT_PATH,
      clearingAgent: 'Map',
    });

    expect(clear.cleared).toBe(true);
    expect(clear.alreadyCleared).toBe(false);
    expect(clear.posted).toBe(true);
    expect(clear.clearCommentId).not.toBe(record.commentId);

    const reviewed = io.reviewsOn(AI_HELL, ITEM);
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toMatchObject({ value: false });

    // Answer-before-clear-before-comment ordering.
    const order = io.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.op === 'reviewed' || (call.op === 'addComment' && call.itemId === ITEM))
      .map(({ call, index }) => ({ op: call.op, index }));
    expect(order.map((entry) => entry.op)).toEqual(['addComment', 'reviewed', 'addComment']);
    expect(order[0].index).toBeLessThan(order[1].index);
    expect(order[1].index).toBeLessThan(order[2].index);

    const clearComment = io.commentsOn(AI_HELL, ITEM).find(
      (comment) => comment.id === clear.clearCommentId,
    );
    expect(clearComment?.comment).toContain(`comment:${record.commentId}`);
    expect(clearComment?.comment).toContain(DOCUMENT_PATH);
    expect(clearComment?.comment).toContain('**Clearing agent:** Map');
    expect(clearComment?.comment).toContain(producerAnswerClearMarker(ITEM, BATCH_ID));
    expect(clearComment?.comment).toContain('Reversible');
  });

  it('does not post a second clear comment or clear again on a re-run', async () => {
    const io = new FakeCaptureIo();
    const record = await recorded(io);
    const input = {
      root: AI_HELL,
      itemId: ITEM,
      batchId: BATCH_ID,
      answerCommentId: record.commentId,
      documentPath: DOCUMENT_PATH,
      clearingAgent: 'Map',
    };
    const first = await clearAnsweredRow(io, input);
    const second = await clearAnsweredRow(io, input);

    expect(second.posted).toBe(false);
    expect(second.cleared).toBe(false);
    expect(second.alreadyCleared).toBe(true);
    expect(second.clearCommentId).toBe(first.clearCommentId);
    expect(io.reviewsOn(AI_HELL, ITEM)).toHaveLength(1);
    expect(
      io.commentsOn(AI_HELL, ITEM).filter((comment) =>
        comment.comment.includes(producerAnswerClearMarker(ITEM, BATCH_ID)),
      ),
    ).toHaveLength(1);
  });

  it('completes the audit comment on an already-cleared row without clearing again', async () => {
    const io = new FakeCaptureIo();
    io.seedItem({ id: ITEM, needsProducerReview: false }, AI_HELL);
    io.seedComment(AI_HELL, ITEM, {
      id: 'WL-CANSWER',
      comment: composeProducerAnswerAppendix(captureInput()),
    });

    const clear = await clearAnsweredRow(io, {
      root: AI_HELL,
      itemId: ITEM,
      batchId: BATCH_ID,
      answerCommentId: 'WL-CANSWER',
      documentPath: DOCUMENT_PATH,
      clearingAgent: 'Map',
    });

    expect(clear.posted).toBe(true);
    expect(clear.cleared).toBe(false);
    expect(clear.alreadyCleared).toBe(true);
    expect(io.reviewsOn(AI_HELL, ITEM)).toHaveLength(0);
  });
});

// ── Orchestration ────────────────────────────────────────────────────

describe('applyProducerAnswer', () => {
  it('records the answer then clears the answered row', async () => {
    const io = new FakeCaptureIo();
    io.seedItem({ id: ITEM, needsProducerReview: true }, AI_HELL);

    const result = await applyProducerAnswer(io, captureInput({ clearingAgent: 'Map' }));

    expect(result.deferral).toBe(false);
    expect(result.record.created).toBe(true);
    expect(result.clear?.cleared).toBe(true);
    expect(io.items.get(`${AI_HELL}\u0000${ITEM}`)?.needsProducerReview).toBe(false);
  });

  it('records a "keep waiting" answer and leaves the row flagged with no clear comment', async () => {
    const io = new FakeCaptureIo();
    io.seedItem({ id: ITEM, needsProducerReview: true }, AI_HELL);

    const result = await applyProducerAnswer(
      io,
      captureInput({ answer: 'keep waiting because the design question is unresolved' }),
    );

    expect(result.deferral).toBe(true);
    expect(result.clear).toBeNull();
    expect(io.items.get(`${AI_HELL}\u0000${ITEM}`)?.needsProducerReview).toBe(true);
    expect(io.reviewsOn(AI_HELL, ITEM)).toHaveLength(0);
    expect(
      io.commentsOn(AI_HELL, ITEM).some((comment) =>
        comment.comment.includes(producerAnswerClearMarker(ITEM, BATCH_ID)),
      ),
    ).toBe(false);
    expect(io.commentsOn(AI_HELL, ITEM)[0].comment).toContain('**Left flagged**');
    expect(io.commentsOn(AI_HELL, ITEM)[0].comment).toContain(
      'keep waiting because the design question is unresolved',
    );
  });
});

// ── Cross-root writes ────────────────────────────────────────────────

describe('cross-root writes', () => {
  it('targets only the row\'s own root; the summary is the only batch-root write', async () => {
    const io = new FakeCaptureIo();
    io.seedItem({ id: ITEM, needsProducerReview: true }, AI_HELL);

    const applied = await applyProducerAnswer(io, captureInput({ clearingAgent: 'Map' }));
    await recordAppliedAnswersSummary(io, {
      root: CONTEXT_HUB,
      batchItemId: BATCH_ITEM,
      batchId: BATCH_ID,
      documentPath: DOCUMENT_PATH,
      rows: [
        {
          itemId: ITEM,
          root: AI_HELL,
          answerCommentId: applied.record.commentId,
          clearCommentId: applied.clear?.clearCommentId ?? null,
          deferral: false,
        },
      ],
    });

    const rowCalls = io.calls.filter(
      (call) => call.op !== 'reviewed' && call.itemId !== BATCH_ITEM,
    );
    expect(rowCalls.every((call) => call.root === AI_HELL)).toBe(true);
    expect(io.calls.filter((call) => call.itemId === BATCH_ITEM).every((call) => call.root === CONTEXT_HUB)).toBe(
      true,
    );
    // Nothing about the AI_Hell row was re-created in ContextHub's store.
    expect(io.commentsOn(CONTEXT_HUB, ITEM)).toHaveLength(0);
  });
});

// ── Applied-answers summary ──────────────────────────────────────────

describe('recordAppliedAnswersSummary', () => {
  it('records row id → answer comment id → clear comment id, idempotently', async () => {
    const io = new FakeCaptureIo();
    const input = {
      root: CONTEXT_HUB,
      batchItemId: BATCH_ITEM,
      batchId: BATCH_ID,
      documentPath: DOCUMENT_PATH,
      rows: [
        {
          itemId: ITEM,
          root: AI_HELL,
          answerCommentId: 'WL-CANSWER',
          clearCommentId: 'WL-CCLEAR',
          deferral: false,
        },
        {
          itemId: 'AH-2',
          root: AI_HELL,
          answerCommentId: 'WL-CANSWER2',
          clearCommentId: null,
          deferral: true,
        },
      ],
    };
    const first = await recordAppliedAnswersSummary(io, input);
    const second = await recordAppliedAnswersSummary(io, input);

    expect(second.id).toBe(first.id);
    expect(io.addsOn(CONTEXT_HUB, BATCH_ITEM)).toHaveLength(1);
    expect(first.comment).toContain('`comment:WL-CANSWER`');
    expect(first.comment).toContain('`comment:WL-CCLEAR`');
    expect(first.comment).toContain('left flagged');
    expect(first.comment).toContain(producerAnswerSummaryMarker(BATCH_ID));
  });

  it('records explicitly that no answers were on record', () => {
    const body = composeProducerAnswerSummary({
      batchId: BATCH_ID,
      documentPath: DOCUMENT_PATH,
      rows: [],
    });
    expect(body).toContain('no producer answers were on record');
  });
});

// ── The batch answer file ────────────────────────────────────────────

function answersFile(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    batchId: BATCH_ID,
    documentPath: DOCUMENT_PATH,
    answeringParty: 'Map',
    clearingAgent: 'Map',
    answers: { 1: 'clear it', 2: 'keep waiting because unresolved' },
    ...overrides,
  });
}

describe('parseProducerAnswerFile', () => {
  it('parses the batch id, document, party and row-number keyed answers', () => {
    const parsed = parseProducerAnswerFile(answersFile());
    expect(parsed.batchId).toBe(BATCH_ID);
    expect(parsed.documentPath).toBe(DOCUMENT_PATH);
    expect(parsed.answeringParty).toBe('Map');
    expect(parsed.clearingAgent).toBe('Map');
    expect(parsed.answers[1]).toBe('clear it');
  });

  it('parses an object answer with an evidence comment id', () => {
    const parsed = parseProducerAnswerFile(
      answersFile({ answers: { 1: { answer: 'clear it', answerCommentId: 'AH-C1' } } }),
    );
    expect(parsed.answers[1]).toEqual({ answer: 'clear it', answerCommentId: 'AH-C1' });
  });

  it('refuses a missing batch id, document, party, answers object or empty answer', () => {
    const failures: Array<[string, string]> = [
      [answersFile({ batchId: '' }), 'batch_id_missing'],
      [answersFile({ documentPath: '' }), 'document_path_missing'],
      [answersFile({ answeringParty: '' }), 'answering_party_missing'],
      [answersFile({ answers: null }), 'answers_missing'],
      [answersFile({ answers: { 1: '  ' } }), 'answer_empty'],
      [answersFile({ answers: { zero: 'x' } }), 'row_number_invalid'],
      ['not json', 'answer_file_invalid'],
    ];
    for (const [text, code] of failures) {
      let error: unknown;
      try {
        parseProducerAnswerFile(text);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ProducerAnswerFileError);
      expect((error as ProducerAnswerFileError).code).toBe(code);
    }
  });
});

describe('resolveAnswers', () => {
  it('maps row numbers in the document order — root codepoint, snapshot order within a root', () => {
    const payload = snapshot([
      row('AH-1', AI_HELL),
      row('WL-1', CONTEXT_HUB),
      row('AH-2', AI_HELL),
    ]);
    const parsed = parseProducerAnswerFile(answersFile());
    const resolved = resolveAnswers(parsed, payload);

    expect(resolved.map((entry) => [entry.rowNumber, entry.row.id])).toEqual([
      [1, 'AH-1'],
      [2, 'AH-2'],
    ]);
  });

  it('refuses an out-of-range row number rather than dropping the answer', () => {
    const payload = snapshot([row('AH-1', AI_HELL)]);
    const parsed = parseProducerAnswerFile(answersFile({ answers: { 2: 'clear it' } }));
    let error: unknown;
    try {
      resolveAnswers(parsed, payload);
    } catch (caught) {
      error = caught;
    }
    expect((error as ProducerAnswerFileError).code).toBe('row_number_out_of_range');
  });
});

// ── The thin CLI wrapper ─────────────────────────────────────────────

interface FakeCli {
  io: ProducerInterviewApplyAnswersCliIo;
  capture: FakeCaptureIo;
  stdout: string[];
  stderr: string[];
}

function snapshotRaw(rows: ProducerInterviewRow[], generatedAt = BATCH_ID): string {
  return JSON.stringify(snapshot(rows, generatedAt));
}

function fakeCli(options: {
  snapshotText?: string;
  answersText?: string;
  failRead?: boolean;
  cwd?: string;
  capture?: FakeCaptureIo;
} = {}): FakeCli {
  const capture = options.capture ?? new FakeCaptureIo();
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    capture,
    stdout,
    stderr,
    io: {
      readStdin: async () => options.snapshotText ?? snapshotRaw([]),
      readFile: async (path: string) => {
        if (options.failRead === true) throw new Error('ENOENT');
        if (path.endsWith('answers.json')) return options.answersText ?? answersFile();
        return options.snapshotText ?? snapshotRaw([]);
      },
      cwd: () => options.cwd ?? CONTEXT_HUB,
      createIo: () => capture,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

function seedRows(capture: FakeCaptureIo, rows: ProducerInterviewRow[]): void {
  for (const entry of rows) {
    capture.seedItem({ id: entry.id, needsProducerReview: true }, entry.root);
  }
}

describe('producer-interview-apply-answers CLI', () => {
  it('parses defaults and requires --answers', () => {
    const parsed = parseProducerInterviewApplyAnswersArgs(['--answers', '/tmp/answers.json']);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.args).toMatchObject({
      answersPath: '/tmp/answers.json',
      summaryItem: BATCH_ITEM,
      author: 'implement',
      clearingAgent: 'implement',
      dryRun: false,
      json: false,
    });
    expect(parseProducerInterviewApplyAnswersArgs([])).toEqual({ error: '--answers is required' });
    expect(parseProducerInterviewApplyAnswersArgs(['--nope'])).toEqual({
      error: 'unknown argument: --nope',
    });
    expect(
      parseProducerInterviewApplyAnswersArgs(['--answers', 'a', '--dry-run', '--json']),
    ).toHaveProperty('error');
  });

  it('prints the help text on --help', async () => {
    const cli = fakeCli();
    const code = await runProducerInterviewApplyAnswers(['--help'], cli.io);
    expect(code).toBe(0);
    expect(cli.stdout.join('')).toBe(PRODUCER_INTERVIEW_APPLY_ANSWERS_USAGE);
  });

  it('applies each answered row to its own root and records the summary on the batch item', async () => {
    const rows = [row('AH-1', AI_HELL), row('AH-2', AI_HELL), row('WL-1', CONTEXT_HUB)];
    const cli = fakeCli({ snapshotText: snapshotRaw(rows) });
    seedRows(cli.capture, rows);

    const code = await runProducerInterviewApplyAnswers(
      ['--answers', '/tmp/answers.json', '--json'],
      cli.io,
    );

    expect(code).toBe(0);
    expect(cli.stderr.join('')).toBe('');
    const parsed = JSON.parse(cli.stdout.join('')) as {
      answered: number;
      cleared: number;
      deferred: number;
      summaryCommentId: string;
      rows: Array<{ rowNumber: number; itemId: string; root: string; clearCommentId: string | null }>;
    };
    expect(parsed.answered).toBe(2);
    expect(parsed.cleared).toBe(1);
    expect(parsed.deferred).toBe(1);
    expect(parsed.rows.map((entry) => [entry.rowNumber, entry.itemId, entry.root])).toEqual([
      [1, 'AH-1', AI_HELL],
      [2, 'AH-2', AI_HELL],
    ]);
    // AH-1 cleared, AH-2 deferred (flagged), WL-1 unanswered.
    expect(cli.capture.items.get(`${AI_HELL}\u0000AH-1`)?.needsProducerReview).toBe(false);
    expect(cli.capture.items.get(`${AI_HELL}\u0000AH-2`)?.needsProducerReview).toBe(true);
    expect(cli.capture.items.get(`${CONTEXT_HUB}\u0000WL-1`)?.needsProducerReview).toBe(true);
    expect(cli.capture.commentsOn(CONTEXT_HUB, BATCH_ITEM)).toHaveLength(1);
    expect(parsed.summaryCommentId).toBeDefined();
  });

  it('writes nothing with --dry-run', async () => {
    const rows = [row('AH-1', AI_HELL)];
    const cliWithOneAnswer = fakeCli({
      snapshotText: snapshotRaw(rows),
      answersText: answersFile({ answers: { 1: 'clear it' } }),
    });
    seedRows(cliWithOneAnswer.capture, rows);
    const code = await runProducerInterviewApplyAnswers(
      ['--answers', '/tmp/answers.json', '--dry-run'],
      cliWithOneAnswer.io,
    );

    expect(code).toBe(0);
    expect(cliWithOneAnswer.capture.calls).toHaveLength(0);
    expect(cliWithOneAnswer.stdout.join('')).toContain('row 1 AH-1');
    expect(cliWithOneAnswer.stdout.join('')).toContain(producerAnswerMarker('AH-1', BATCH_ID));
  });

  it('exits 2 when the answer file batch id disagrees with the snapshot', async () => {
    const cli = fakeCli({
      snapshotText: snapshotRaw([row('AH-1')]),
      answersText: answersFile({ batchId: '2026-11-26T00:00:00.000Z' }),
    });
    const code = await runProducerInterviewApplyAnswers(
      ['--answers', '/tmp/answers.json'],
      cli.io,
    );
    expect(code).toBe(2);
    expect(cli.stderr.join('')).toMatch(/does not match/i);
    expect(cli.capture.calls).toHaveLength(0);
  });

  it('exits 2 on an out-of-range row number and writes nothing', async () => {
    const cli = fakeCli({
      snapshotText: snapshotRaw([row('AH-1')]),
      answersText: answersFile({ answers: { 4: 'clear it' } }),
    });
    const code = await runProducerInterviewApplyAnswers(
      ['--answers', '/tmp/answers.json'],
      cli.io,
    );
    expect(code).toBe(2);
    expect(cli.stderr.join('')).toMatch(/out of range/i);
    expect(cli.capture.calls).toHaveLength(0);
  });

  it('exits 2 on a payload that is not a snapshot', async () => {
    const cli = fakeCli({ snapshotText: JSON.stringify({ nope: true }) });
    const code = await runProducerInterviewApplyAnswers(['--answers', '/tmp/answers.json'], cli.io);
    expect(code).toBe(2);
    expect(cli.stderr.join('')).toContain('not a producer-interview snapshot payload');
  });

  it('exits 1 when a mutation is refused, naming what was already recorded', async () => {
    const rows = [row('AH-1', AI_HELL)];
    const cli = fakeCli({
      snapshotText: snapshotRaw(rows),
      answersText: answersFile({ answers: { 1: 'clear it' } }),
    });
    seedRows(cli.capture, rows);
    cli.capture.failReviewFor = 'AH-1';

    const code = await runProducerInterviewApplyAnswers(
      ['--answers', '/tmp/answers.json'],
      cli.io,
    );

    expect(code).toBe(1);
    expect(cli.stderr.join('')).toMatch(/wl reviewed AH-1 false failed/i);
    // The answer entry was recorded before the clear failed; a re-run is idempotent.
    expect(cli.capture.commentsOn(AI_HELL, 'AH-1')).toHaveLength(1);
  });

  it('records the empty summary when no answers were on record', async () => {
    const rows = [row('AH-1', AI_HELL)];
    const cli = fakeCli({
      snapshotText: snapshotRaw(rows),
      answersText: answersFile({ answers: {} }),
    });
    seedRows(cli.capture, rows);

    const code = await runProducerInterviewApplyAnswers(
      ['--answers', '/tmp/answers.json', '--json'],
      cli.io,
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(cli.stdout.join('')) as { answered: number; rows: unknown[] };
    expect(parsed.answered).toBe(0);
    expect(parsed.rows).toEqual([]);
    expect(cli.capture.commentsOn(CONTEXT_HUB, BATCH_ITEM)[0].comment).toContain(
      'no producer answers were on record',
    );
  });
});

// ── Composition sanity for the clear comment ─────────────────────────

describe('composeProducerAnswerClearComment', () => {
  it('names the answer, document, agent and the reverse command', () => {
    const body = composeProducerAnswerClearComment({
      root: AI_HELL,
      itemId: ITEM,
      batchId: BATCH_ID,
      answerCommentId: 'WL-CANSWER',
      documentPath: DOCUMENT_PATH,
      clearingAgent: 'Map',
    });
    expect(body).toContain('`comment:WL-CANSWER`');
    expect(body).toContain(DOCUMENT_PATH);
    expect(body).toContain('**Clearing agent:** Map');
    expect(body).toContain(`wl --worklog-dir ${AI_HELL}/.worklog reviewed ${ITEM} true`);
  });
});
