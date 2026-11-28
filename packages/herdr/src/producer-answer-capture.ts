/**
 * packages/herdr/src/producer-answer-capture.ts — record a producer's answer in
 * the row's own Appendix and release the answered row's producer hold with an
 * auditable trail (WL-0MWVMRXUZ0031P1S, child 4 of WL-0MWTVPK65009NTER).
 *
 * ## Why this module exists
 *
 * Child 2 rendered the answer sheet and child 3 delivered it once. This module
 * is the reverse direction: the producer's reply is transcribed once, then
 * applied deterministically to each answered row. Two writes happen per
 * answered row, always in this order:
 *
 *  1. the answer is appended to the row's own worklog as an **Appendix** entry
 *     (`[producer-answer:<item>:<batch>]`) carrying the question as asked, the
 *     answer verbatim, the answering party, the batch id, the batch document
 *     path and the evidence link (the producer's answer comment id, when the
 *     reply arrived as a comment);
 *  2. the row's `needsProducerReview` hold is released (`wl reviewed <id>
 *     false` on the row's own root) and an audit comment
 *     (`[producer-answer-clear:<item>:<batch>]`) names the answer entry's
 *     comment id, the batch document path and the clearing agent.
 *
 * Answer-before-clear is the ordering guarantee: a clear can always cite the
 * answer that justified it, and the clear is reversible (`wl reviewed <id>
 * true`).
 *
 * ## No answer, no clear
 *
 * Clearing is refused when the answer entry does not exist on the row (or does
 * not carry this batch's answer marker). The refusal happens BEFORE any write,
 * so a row with no recorded answer is never cleared and nothing is posted.
 *
 * ## Idempotent by construction
 *
 * Both entries carry stable markers. Re-running for the same row and batch id
 * **updates** the existing answer entry (never appends a duplicate) and never
 * posts a second clear comment. A re-run after an interrupted clear completes
 * the missing audit comment without clearing again; a clear comment already
 * present is final, so a producer who re-raises the hold later is respected
 * rather than silently overridden.
 *
 * ## "Keep waiting / do not proceed"
 *
 * A deferral answer is recorded as an answer and the row is **left flagged**;
 * the Appendix entry states the producer's reason and that the hold was left in
 * place. No clear comment is posted.
 *
 * ## Cross-root writes
 *
 * Every row write receives the row's own root (the directory CONTAINING
 * `.worklog/`) and therefore targets that root's store only. The optional
 * applied-answers summary is the one intentional write to the batch item's own
 * root, and it records the summary only — no row is re-created anywhere.
 */

import {
  CLI_BINARIES,
  DEFAULT_CLI_TIMEOUT_MS,
  spawnCliStdout,
  type CliExecFile,
} from './cli-spawn.js';
import { buildWlArgsForRoot, getExecFileAsync } from './fetcher.args.js';
import {
  PRODUCER_INTERVIEW_MAX_BUFFER_BYTES,
  parseCommentListOutput,
} from './producer-interview-snapshot.js';

/** The default author recorded on the Appendix and clear comments. */
export const PRODUCER_ANSWER_AUTHOR = 'implement';

/** The default clearing agent recorded on the clear comment. */
export const PRODUCER_ANSWER_DEFAULT_CLEARING_AGENT = 'implement';

/** Upper bound for one `wl` read (a long comment trail can exceed 1 MB). */
export const PRODUCER_ANSWER_MAX_BUFFER_BYTES = PRODUCER_INTERVIEW_MAX_BUFFER_BYTES;

/**
 * The phrases that mean the producer wants the row left flagged. Matched as
 * whole phrases (case-insensitive) so an answer such as "clear it, do not
 * proceed with the legacy path" is not mistaken for a deferral.
 */
const DEFERRAL_PATTERN =
  /\b(?:keep\s+waiting|do\s+not\s+proceed|don'?t\s+proceed|not\s+proceed|leave\s+(?:it\s+)?flagged|keep\s+(?:the\s+)?flag|hold\s+off)\b/i;

/** True when the answer asks for the row to keep waiting / not proceed. */
export function isDeferralAnswer(answer: string): boolean {
  return DEFERRAL_PATTERN.test(answer);
}

// ── Markers ──────────────────────────────────────────────────────────

/** The stable marker identifying the Appendix answer entry for one row+batch. */
export function producerAnswerMarker(itemId: string, batchId: string): string {
  return `[producer-answer:${itemId}:${batchId}]`;
}

/** The stable marker identifying the audit clear comment for one row+batch. */
export function producerAnswerClearMarker(itemId: string, batchId: string): string {
  return `[producer-answer-clear:${itemId}:${batchId}]`;
}

/** The stable marker identifying the applied-answers summary comment. */
export function producerAnswerSummaryMarker(batchId: string): string {
  return `[producer-answer-summary:${batchId}]`;
}

// ── Types ────────────────────────────────────────────────────────────

/** The item state the clear path must verify before releasing the hold. */
export interface ProducerAnswerItem {
  id: string;
  needsProducerReview: boolean;
  title?: string;
}

/** One worklog comment, reduced to the fields this module reads. */
export interface ProducerAnswerCommentRef {
  id: string;
  comment: string;
  author?: string;
  createdAt?: string;
}

/** The injectable I/O seam (fake-able in tests). */
export interface ProducerAnswerCaptureIo {
  /** `wl show <id> --json` — the current `needsProducerReview` state. */
  getItem(root: string, itemId: string): Promise<ProducerAnswerItem>;
  /** `wl comment list <id> --json`. */
  listComments(root: string, itemId: string): Promise<ReadonlyArray<ProducerAnswerCommentRef>>;
  /** `wl comment add <id> --comment … --json`. */
  addComment(input: {
    root: string;
    itemId: string;
    body: string;
    author: string;
  }): Promise<ProducerAnswerCommentRef>;
  /** `wl comment update <commentId> --comment … --json`. */
  updateComment(input: {
    root: string;
    commentId: string;
    body: string;
  }): Promise<ProducerAnswerCommentRef>;
  /** `wl reviewed <id> <true|false> --json`. */
  setNeedsProducerReview(root: string, itemId: string, value: boolean): Promise<void>;
}

/** Everything the answer-capture step needs. */
export interface ProducerAnswerCaptureInput {
  /** The row's own root (the directory CONTAINING `.worklog/`). */
  root: string;
  itemId: string;
  /** The batch id — the snapshot timestamp quoted throughout the trail. */
  batchId: string;
  /** The question exactly as it was asked. */
  question: string;
  /** The producer's answer, verbatim. */
  answer: string;
  /** Who answered (the producer identity recorded in the trail). */
  answeringParty: string;
  /** The batch document path quoted in the answer entry. */
  documentPath: string;
  /**
   * The producer's own answer comment id, when the reply arrived as a comment
   * on the row. Omitted when the answer was transcribed from the batch reply.
   */
  sourceAnswerCommentId?: string;
  author?: string;
}

/** The recorded Appendix answer entry. */
export interface ProducerAnswerRecord {
  root: string;
  itemId: string;
  batchId: string;
  /** The answer entry's comment id — the evidence link the clear cites. */
  commentId: string;
  /** True when this run created the entry; false when it updated an existing one. */
  created: boolean;
  /** True when the entry already existed and was updated in place. */
  updated: boolean;
  /** True when the answer asks for the row to stay flagged. */
  deferral: boolean;
  /** The rendered Appendix body. */
  body: string;
  question: string;
  answer: string;
  answeringParty: string;
}

/** Everything the clear step needs. */
export interface ProducerAnswerClearInput {
  root: string;
  itemId: string;
  batchId: string;
  /** The answer entry's comment id, as returned by {@link recordProducerAnswer}. */
  answerCommentId: string;
  documentPath: string;
  /** The agent releasing the hold (recorded in the audit comment). */
  clearingAgent: string;
  author?: string;
}

/** The outcome of releasing (or refusing to release) one row's hold. */
export interface ProducerAnswerClearResult {
  root: string;
  itemId: string;
  batchId: string;
  answerCommentId: string;
  /** The audit comment's id (this run's, or the existing marker's). */
  clearCommentId: string;
  /** True when this run flipped `needsProducerReview` to false. */
  cleared: boolean;
  /** True when the row's hold was already released. */
  alreadyCleared: boolean;
  /** True when this run posted the audit comment. */
  posted: boolean;
  /** The rendered audit comment body. */
  body: string;
}

/** The whole apply outcome for one row. */
export interface ProducerAnswerApplyResult {
  record: ProducerAnswerRecord;
  /** Null when the answer is a deferral (the hold is left in place). */
  clear: ProducerAnswerClearResult | null;
  deferral: boolean;
}

/** The summary row the applied-answers comment records. */
export interface ProducerAnswerSummaryRow {
  itemId: string;
  root: string;
  answerCommentId: string;
  /** Null when the answer deferred and the row was left flagged. */
  clearCommentId: string | null;
  deferral: boolean;
}

// ── Failure surface ──────────────────────────────────────────────────

export type ProducerAnswerFailureCode =
  | 'answer_missing'
  | 'answer_not_captured'
  | 'item_not_found'
  | 'comment_list_failed'
  | 'comment_add_failed'
  | 'comment_update_failed'
  | 'reviewed_failed';

/**
 * A refused or failed mutation. The code says what went wrong; `itemId` names
 * the row when the failure is attributable to one.
 */
export class ProducerAnswerCaptureError extends Error {
  readonly code: ProducerAnswerFailureCode;
  readonly itemId?: string;

  constructor(
    code: ProducerAnswerFailureCode,
    message: string,
    options: { itemId?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProducerAnswerCaptureError';
    this.code = code;
    if (options.itemId !== undefined) this.itemId = options.itemId;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Composition ──────────────────────────────────────────────────────

function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * Compose the Appendix answer entry. Deterministic: identical input yields the
 * identical body, so an idempotent re-run updates the entry to the same text.
 */
export function composeProducerAnswerAppendix(input: ProducerAnswerCaptureInput): string {
  const deferral = isDeferralAnswer(input.answer);
  const lines: string[] = [];

  lines.push(`## Producer answer — ${input.batchId}`);
  lines.push('');
  lines.push(producerAnswerMarker(input.itemId, input.batchId));
  lines.push('');
  lines.push(`**Batch id:** \`${input.batchId}\``);
  lines.push(`**Document:** \`${input.documentPath}\``);
  lines.push(`**Item:** \`${input.itemId}\``);
  lines.push(`**Answering party:** ${input.answeringParty}`);
  lines.push(
    input.sourceAnswerCommentId === undefined
      ? '**Evidence:** transcribed from the batch reply (no source comment)'
      : `**Evidence:** \`comment:${input.sourceAnswerCommentId}\``,
  );
  lines.push('');
  lines.push('### Question (as asked)');
  lines.push('');
  lines.push(quoteBlock(input.question));
  lines.push('');
  lines.push('### Answer (verbatim)');
  lines.push('');
  lines.push(quoteBlock(input.answer));
  lines.push('');
  lines.push('### Outcome');
  lines.push('');
  if (deferral) {
    lines.push(
      '**Left flagged** — the producer asked to keep waiting / not proceed, so `needsProducerReview` stays `true`. Stated reason: the answer above.',
    );
  } else {
    lines.push(
      '**Clear authorised** — the answer above is the justification for releasing `needsProducerReview` on this row.',
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Compose the audit comment that records the clear. It names the answer entry
 * (the justifying answer), the batch document path and the clearing agent, and
 * states how to reverse the clear.
 */
export function composeProducerAnswerClearComment(
  input: Omit<ProducerAnswerClearInput, 'author'>,
): string {
  const lines: string[] = [];
  lines.push(`## Producer hold cleared — ${input.batchId}`);
  lines.push('');
  lines.push(producerAnswerClearMarker(input.itemId, input.batchId));
  lines.push('');
  lines.push(`**Batch id:** \`${input.batchId}\``);
  lines.push(`**Document:** \`${input.documentPath}\``);
  lines.push(`**Item:** \`${input.itemId}\``);
  lines.push(`**Answer:** \`comment:${input.answerCommentId}\``);
  lines.push(`**Clearing agent:** ${input.clearingAgent}`);
  lines.push('');
  lines.push(
    `\`needsProducerReview\` was set to \`false\` with \`wl reviewed ${input.itemId} false\` on this row's own root.`,
  );
  lines.push('');
  lines.push(
    `**Reversible:** re-raise the hold with \`wl --worklog-dir ${input.root}/.worklog reviewed ${input.itemId} true\`.`,
  );
  return `${lines.join('\n')}\n`;
}

/** Compose the applied-answers summary posted on the batch item. */
export function composeProducerAnswerSummary(input: {
  batchId: string;
  documentPath: string;
  rows: ReadonlyArray<ProducerAnswerSummaryRow>;
}): string {
  const lines: string[] = [];
  const cleared = input.rows.filter((row) => !row.deferral).length;
  const deferred = input.rows.length - cleared;

  lines.push(`## Producer answers applied — ${input.batchId}`);
  lines.push('');
  lines.push(producerAnswerSummaryMarker(input.batchId));
  lines.push('');
  lines.push(`**Batch id:** \`${input.batchId}\``);
  lines.push(`**Document:** \`${input.documentPath}\``);
  lines.push(`**Answered rows:** ${input.rows.length}`);
  lines.push(`**Cleared:** ${cleared} · **Left flagged (deferred):** ${deferred}`);
  lines.push('');
  if (input.rows.length === 0) {
    lines.push(
      '- _(no producer answers were on record for this batch — nothing was cleared)_',
    );
    return `${lines.join('\n')}\n`;
  }
  lines.push('| Row | Answer entry | Clear comment | Outcome |');
  lines.push('|---|---|---|---|');
  for (const row of input.rows) {
    lines.push(
      `| \`${row.itemId}\` | \`comment:${row.answerCommentId}\` | ${
        row.clearCommentId === null ? '—' : `\`comment:${row.clearCommentId}\``
      } | ${row.deferral ? 'left flagged' : 'cleared'} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ── Lookup helpers ───────────────────────────────────────────────────

function markerComment(
  comments: ReadonlyArray<ProducerAnswerCommentRef>,
  marker: string,
): ProducerAnswerCommentRef | undefined {
  return comments.find((comment) => comment.comment.includes(marker));
}

async function listComments(
  io: ProducerAnswerCaptureIo,
  root: string,
  itemId: string,
): Promise<ReadonlyArray<ProducerAnswerCommentRef>> {
  try {
    return await io.listComments(root, itemId);
  } catch (error) {
    throw new ProducerAnswerCaptureError(
      'comment_list_failed',
      `cannot read the comments on ${itemId}: ${errorMessage(error)}`,
      { itemId, cause: error },
    );
  }
}

// ── Answer capture ───────────────────────────────────────────────────

/**
 * Append the producer's answer to the row's own Appendix, idempotently. A
 * second run for the same row and batch id updates the existing entry (same
 * comment id) instead of adding a duplicate.
 */
export async function recordProducerAnswer(
  io: ProducerAnswerCaptureIo,
  input: ProducerAnswerCaptureInput,
): Promise<ProducerAnswerRecord> {
  const author = input.author ?? PRODUCER_ANSWER_AUTHOR;
  const marker = producerAnswerMarker(input.itemId, input.batchId);
  const body = composeProducerAnswerAppendix(input);
  const deferral = isDeferralAnswer(input.answer);

  const existing = markerComment(
    await listComments(io, input.root, input.itemId),
    marker,
  );

  let commentId: string;
  let created: boolean;
  if (existing === undefined) {
    let added: ProducerAnswerCommentRef;
    try {
      added = await io.addComment({
        root: input.root,
        itemId: input.itemId,
        body,
        author,
      });
    } catch (error) {
      throw new ProducerAnswerCaptureError(
        'comment_add_failed',
        `wl rejected the answer entry for ${input.itemId}: ${errorMessage(error)}`,
        { itemId: input.itemId, cause: error },
      );
    }
    commentId = added.id;
    created = true;
  } else {
    try {
      await io.updateComment({
        root: input.root,
        commentId: existing.id,
        body,
      });
    } catch (error) {
      throw new ProducerAnswerCaptureError(
        'comment_update_failed',
        `wl rejected the answer update for ${input.itemId}: ${errorMessage(error)}`,
        { itemId: input.itemId, cause: error },
      );
    }
    commentId = existing.id;
    created = false;
  }

  return {
    root: input.root,
    itemId: input.itemId,
    batchId: input.batchId,
    commentId,
    created,
    updated: !created,
    deferral,
    body,
    question: input.question,
    answer: input.answer,
    answeringParty: input.answeringParty,
  };
}

// ── Hold release ─────────────────────────────────────────────────────

/**
 * Release an answered row's producer hold, after proving the answer entry
 * exists. Refuses (before any write) when the answer is absent, so a row with
 * no recorded answer is never cleared.
 */
export async function clearAnsweredRow(
  io: ProducerAnswerCaptureIo,
  input: ProducerAnswerClearInput,
): Promise<ProducerAnswerClearResult> {
  const author = input.author ?? PRODUCER_ANSWER_AUTHOR;
  if (input.answerCommentId.trim().length === 0) {
    throw new ProducerAnswerCaptureError(
      'answer_missing',
      `refusing to clear ${input.itemId}: no answer comment id was supplied`,
      { itemId: input.itemId },
    );
  }

  // Prove the answer exists on the row AND is this batch's captured answer.
  const comments = await listComments(io, input.root, input.itemId);
  const answer = comments.find((comment) => comment.id === input.answerCommentId);
  if (answer === undefined) {
    throw new ProducerAnswerCaptureError(
      'answer_missing',
      `refusing to clear ${input.itemId}: answer comment ${input.answerCommentId} is not on the row`,
      { itemId: input.itemId },
    );
  }
  if (!answer.comment.includes(producerAnswerMarker(input.itemId, input.batchId))) {
    throw new ProducerAnswerCaptureError(
      'answer_not_captured',
      `refusing to clear ${input.itemId}: comment ${input.answerCommentId} is not this batch's recorded answer`,
      { itemId: input.itemId },
    );
  }

  let item: ProducerAnswerItem;
  try {
    item = await io.getItem(input.root, input.itemId);
  } catch (error) {
    throw new ProducerAnswerCaptureError(
      'item_not_found',
      `cannot read ${input.itemId}: ${errorMessage(error)}`,
      { itemId: input.itemId, cause: error },
    );
  }

  const body = composeProducerAnswerClearComment(input);
  const marker = producerAnswerClearMarker(input.itemId, input.batchId);
  const existingClear = markerComment(comments, marker);

  // A clear comment already on the row is final: never clear a second time
  // (a producer who re-raises the hold must not be silently overridden).
  if (existingClear !== undefined) {
    return {
      root: input.root,
      itemId: input.itemId,
      batchId: input.batchId,
      answerCommentId: input.answerCommentId,
      clearCommentId: existingClear.id,
      cleared: false,
      alreadyCleared: !item.needsProducerReview,
      posted: false,
      body,
    };
  }

  const wasFlagged = item.needsProducerReview;
  if (wasFlagged) {
    try {
      await io.setNeedsProducerReview(input.root, input.itemId, false);
    } catch (error) {
      throw new ProducerAnswerCaptureError(
        'reviewed_failed',
        `wl reviewed ${input.itemId} false failed: ${errorMessage(error)}`,
        { itemId: input.itemId, cause: error },
      );
    }
  }

  // Clear first, then record — the audit comment can always cite the clear.
  let created: ProducerAnswerCommentRef;
  try {
    created = await io.addComment({
      root: input.root,
      itemId: input.itemId,
      body,
      author,
    });
  } catch (error) {
    throw new ProducerAnswerCaptureError(
      'comment_add_failed',
      `wl rejected the clear comment for ${input.itemId}: ${errorMessage(error)}`,
      { itemId: input.itemId, cause: error },
    );
  }

  return {
    root: input.root,
    itemId: input.itemId,
    batchId: input.batchId,
    answerCommentId: input.answerCommentId,
    clearCommentId: created.id,
    cleared: wasFlagged,
    alreadyCleared: !wasFlagged,
    posted: true,
    body,
  };
}

// ── Orchestration ────────────────────────────────────────────────────

/**
 * Record one producer answer and, unless the answer defers, release the row's
 * hold with its audit comment. Answer-before-clear is the ordering guarantee.
 */
export async function applyProducerAnswer(
  io: ProducerAnswerCaptureIo,
  input: ProducerAnswerCaptureInput & { clearingAgent?: string },
): Promise<ProducerAnswerApplyResult> {
  const record = await recordProducerAnswer(io, input);
  if (record.deferral) {
    return { record, clear: null, deferral: true };
  }
  const clear = await clearAnsweredRow(io, {
    root: input.root,
    itemId: input.itemId,
    batchId: input.batchId,
    answerCommentId: record.commentId,
    documentPath: input.documentPath,
    clearingAgent: input.clearingAgent ?? PRODUCER_ANSWER_DEFAULT_CLEARING_AGENT,
    author: input.author,
  });
  return { record, clear, deferral: false };
}

// ── Applied-answers summary ──────────────────────────────────────────

/**
 * Record the applied answers on the batch item (row id → answer comment id →
 * clear comment id). Idempotent: the summary carries a stable marker, so a
 * re-run updates the existing summary instead of adding a second one, and the
 * empty summary records that no answers were on record.
 */
export async function recordAppliedAnswersSummary(
  io: ProducerAnswerCaptureIo,
  input: {
    /** The batch item's own root. */
    root: string;
    batchItemId: string;
    batchId: string;
    documentPath: string;
    rows: ReadonlyArray<ProducerAnswerSummaryRow>;
    author?: string;
  },
): Promise<ProducerAnswerCommentRef> {
  const author = input.author ?? PRODUCER_ANSWER_AUTHOR;
  const marker = producerAnswerSummaryMarker(input.batchId);
  const body = composeProducerAnswerSummary({
    batchId: input.batchId,
    documentPath: input.documentPath,
    rows: input.rows,
  });

  const existing = markerComment(
    await listComments(io, input.root, input.batchItemId),
    marker,
  );
  if (existing !== undefined) {
    try {
      return await io.updateComment({
        root: input.root,
        commentId: existing.id,
        body,
      });
    } catch (error) {
      throw new ProducerAnswerCaptureError(
        'comment_update_failed',
        `wl rejected the applied-answers summary update for ${input.batchItemId}: ${errorMessage(error)}`,
        { itemId: input.batchItemId, cause: error },
      );
    }
  }

  try {
    return await io.addComment({
      root: input.root,
      itemId: input.batchItemId,
      body,
      author,
    });
  } catch (error) {
    throw new ProducerAnswerCaptureError(
      'comment_add_failed',
      `wl rejected the applied-answers summary for ${input.batchItemId}: ${errorMessage(error)}`,
      { itemId: input.batchItemId, cause: error },
    );
  }
}

// ── Production wiring ────────────────────────────────────────────────

export interface ProducerAnswerCaptureSourceIo {
  exec: CliExecFile;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function parseItem(stdout: string): ProducerAnswerItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const workItem = record === null ? null : asRecord(record.workItem);
  if (workItem === null) return null;
  const id = typeof workItem.id === 'string' ? workItem.id : undefined;
  if (id === undefined || id.length === 0) return null;
  const item: ProducerAnswerItem = {
    id,
    needsProducerReview: workItem.needsProducerReview === true,
  };
  if (typeof workItem.title === 'string') item.title = workItem.title;
  return item;
}

function parseAddedComment(stdout: string): ProducerAnswerCommentRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const comment = record === null ? null : asRecord(record.comment);
  if (comment === null) return null;
  const id = typeof comment.id === 'string' ? comment.id : undefined;
  if (id === undefined || id.length === 0) return null;
  const ref: ProducerAnswerCommentRef = {
    id,
    comment: typeof comment.comment === 'string' ? comment.comment : '',
  };
  if (typeof comment.author === 'string') ref.author = comment.author;
  if (typeof comment.createdAt === 'string') ref.createdAt = comment.createdAt;
  return ref;
}

/**
 * Wire the real `wl` calls. Every row mutation passes the row's own root
 * (`--worklog-dir <root>/.worklog`), so a cross-root answer lands only in the
 * originating root's store.
 */
export function createProducerAnswerCaptureIo(
  io: Partial<ProducerAnswerCaptureSourceIo> = {},
): ProducerAnswerCaptureIo {
  const exec = io.exec ?? getExecFileAsync();

  async function runWl(root: string, args: string[]): Promise<string> {
    return spawnCliStdout(exec, CLI_BINARIES, buildWlArgsForRoot(root, args), {
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
      maxBuffer: PRODUCER_ANSWER_MAX_BUFFER_BYTES,
    });
  }

  return {
    async getItem(root, itemId) {
      const stdout = await runWl(root, ['show', itemId, '--json']);
      const item = parseItem(stdout);
      if (item === null) {
        throw new Error(`unparseable wl show --json output for ${itemId}`);
      }
      return item;
    },

    async listComments(root, itemId) {
      const stdout = await runWl(root, ['comment', 'list', itemId, '--json']);
      const comments = parseCommentListOutput(stdout);
      if (comments === null) {
        throw new Error(`unparseable wl comment list --json output for ${itemId}`);
      }
      return comments.map((comment) => {
        const ref: ProducerAnswerCommentRef = { id: comment.id, comment: comment.comment };
        if (comment.author !== undefined) ref.author = comment.author;
        if (comment.createdAt !== undefined) ref.createdAt = comment.createdAt;
        return ref;
      });
    },

    async addComment({ root, itemId, body, author }) {
      const stdout = await runWl(root, [
        'comment',
        'add',
        itemId,
        '--comment',
        body,
        '--author',
        author,
        '--json',
      ]);
      const created = parseAddedComment(stdout);
      if (created === null) {
        throw new Error(`unparseable wl comment add --json output for ${itemId}`);
      }
      return created;
    },

    async updateComment({ root, commentId, body }) {
      const stdout = await runWl(root, [
        'comment',
        'update',
        commentId,
        '--comment',
        body,
        '--json',
      ]);
      const updated = parseAddedComment(stdout);
      if (updated === null) {
        throw new Error(`unparseable wl comment update --json output for ${commentId}`);
      }
      return updated;
    },

    async setNeedsProducerReview(root, itemId, value) {
      await runWl(root, ['reviewed', itemId, value ? 'true' : 'false', '--json']);
    },
  };
}
