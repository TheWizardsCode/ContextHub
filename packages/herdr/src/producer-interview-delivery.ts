/**
 * packages/herdr/src/producer-interview-delivery.ts — deliver the batched
 * producer interview ONCE and record the batch reference
 * (WL-0MWVMRX4X003DKCT, child 3 of WL-0MWTVPK65009NTER).
 *
 * ## Why this module exists
 *
 * Child 1 re-read the live flagged set (`producer-interview-snapshot.ts`) and
 * child 2 rendered the answer sheet (`producer-interview-batch-doc.ts`). This
 * module is the single moment the batch reaches the producer: it posts ONE
 * delivery comment on the originating remediation item and ONE on the batch
 * item, both quoting the batch id (the snapshot timestamp), the document path,
 * the row count, the per-root counts and every invited item id.
 *
 * ## Idempotent by construction
 *
 * Nobody should be asked twice. The comment carries a stable marker
 * (`[producer-interview-batch:<batchId>]`); before posting to a recipient the
 * module reads that recipient's comments and, when the marker is already
 * there, reuses the existing comment id instead of posting again. A second run
 * for the same batch id therefore posts nothing and reports
 * `alreadyDelivered` — proven by counting posts against a fake `wl` runner.
 * A run interrupted between the two posts is completed (only the missing
 * comment is posted), so "exactly one delivery comment per item" holds on
 * every path.
 *
 * ## Order and idempotency of the reference
 *
 * The remediation item (`WL-0MWTAD1KM0081UUD`) is posted FIRST, then the batch
 * item (`WL-0MWTVPK65009NTER`), so the batch item's comment always finds the
 * reference already recorded. Both comments are the verified comment text; both
 * comment ids are returned in the result for the delivering session's own
 * completion record.
 *
 * ## The document must be the artefact this snapshot produced
 *
 * Delivery is refused (loudly, before anything is posted) when the document is
 * missing on disk, declares a different batch id, was written BEFORE the
 * snapshot instant it claims (stale — the live set moved on after the document
 * was rendered) or declares a different row count than the snapshot payload.
 *
 * ## Read/write surface
 *
 * Reads: `wl comment list <id> --json`, the document file. Writes: exactly one
 * `wl comment add <id> --comment … --author … --json` per recipient that does
 * not already carry the marker. No status, stage, flag or assignee is touched,
 * so the completed/in_review remediation item keeps its state.
 */

import { readFile, stat } from 'node:fs/promises';

import {
  CLI_BINARIES,
  DEFAULT_CLI_TIMEOUT_MS,
  spawnCliStdout,
  type CliExecFile,
} from './cli-spawn.js';
import { buildWlArgsForRoot, getExecFileAsync } from './fetcher.args.js';
import {
  groupProducerInterviewRowsByRoot,
  orderProducerInterviewRowsByRoot,
} from './producer-interview-batch-doc.js';
import {
  parseCommentListOutput,
  type ProducerInterviewRow,
  type ProducerInterviewSnapshot,
} from './producer-interview-snapshot.js';

/**
 * The originating remediation item (the scope item that motivated the batch:
 * "prep backlog is almost entirely producer-review flagged"). The batch
 * reference is recorded here first.
 */
export const PRODUCER_INTERVIEW_REMEDIATION_ITEM = 'WL-0MWTAD1KM0081UUD';

/** The batch item itself (the parent of this delivery child). */
export const PRODUCER_INTERVIEW_BATCH_ITEM = 'WL-0MWTVPK65009NTER';

/** The default author recorded on the delivery comments. */
export const PRODUCER_INTERVIEW_DELIVERY_AUTHOR = 'implement';

/** Upper bound for one `wl` read (a long comment trail can exceed 1 MB). */
export const PRODUCER_INTERVIEW_DELIVERY_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

// ── Receipts and the idempotency marker ─────────────────────────────

/** One recipient of the delivery comment. */
export interface ProducerInterviewDeliveryTarget {
  itemId: string;
  /** The worklog root (the directory CONTAINING `.worklog/`). */
  root: string;
}

/** An existing or freshly created comment on a recipient. */
export interface ProducerInterviewDeliveryCommentRef {
  id: string;
  comment: string;
}

/** One recipient's delivery outcome. */
export interface ProducerInterviewDeliveryComment {
  itemId: string;
  root: string;
  commentId: string;
  /** True when THIS run posted it; false when the marker was already there. */
  posted: boolean;
}

/** The per-root invited-row count quoted in the delivery comment. */
export interface ProducerInterviewRootCount {
  root: string;
  rows: number;
}

/** The whole delivery outcome. */
export interface ProducerInterviewDeliveryResult {
  batchId: string;
  documentPath: string;
  /** The stable idempotency marker carried by every delivery comment. */
  marker: string;
  rows: number;
  perRoot: ProducerInterviewRootCount[];
  /** Every invited item id, in the snapshot's (document) order. */
  invited: string[];
  comments: ProducerInterviewDeliveryComment[];
  /** True when this run posted nothing because the batch was already delivered. */
  alreadyDelivered: boolean;
  /** The comment text composed once and reused for both recipients. */
  body: string;
}

/**
 * The stable idempotency marker for one batch: a second delivery run greps for
 * it instead of posting. Keyed on the snapshot timestamp (the batch id), so a
 * later batch is never mistaken for this one.
 */
export function producerInterviewBatchMarker(batchId: string): string {
  return `[producer-interview-batch:${batchId}]`;
}

/** The default recipients, in delivery order: remediation item first. */
export function defaultProducerInterviewDeliveryTargets(
  root: string,
): ProducerInterviewDeliveryTarget[] {
  return [
    { itemId: PRODUCER_INTERVIEW_REMEDIATION_ITEM, root },
    { itemId: PRODUCER_INTERVIEW_BATCH_ITEM, root },
  ];
}

// ── Document parsing + validation ───────────────────────────────────

/** What {@link ProducerInterviewDeliveryIo.readDocument} returns. */
export interface ProducerInterviewDocumentContents {
  text: string;
  mtimeMs: number;
  documentPath: string;
}

/** The document's declared identity, as written by the batch-document renderer. */
export interface ProducerInterviewDocumentExpectation {
  batchId: string;
  rows: number;
}

/** The `**Batch id:** \`<id>\`` line the renderer writes, or null. */
export function parseProducerInterviewDocumentBatchId(text: string): string | null {
  const match = /\*\*Batch id:\*\*\s*`([^`]+)`/.exec(text);
  return match === null ? null : match[1];
}

/** The `**Rows:** <n>` count the renderer writes, or null. */
export function parseProducerInterviewDocumentRowCount(text: string): number | null {
  const match = /\*\*Rows:\*\*\s*(\d+)/.exec(text);
  return match === null ? null : Number(match[1]);
}

/**
 * Refuse a document that is not the artefact this snapshot produced. The
 * staleness rule is the parent acceptance criterion: a document written BEFORE
 * the snapshot instant it claims is stale (the live set moved on after the
 * render), so delivering it would invite the wrong rows.
 */
export function validateProducerInterviewDocument(
  document: ProducerInterviewDocumentContents,
  expected: ProducerInterviewDocumentExpectation,
): void {
  const declaredBatchId = parseProducerInterviewDocumentBatchId(document.text);
  if (declaredBatchId === null) {
    throw new ProducerInterviewDeliveryError(
      'document_batch_mismatch',
      `${document.documentPath} does not declare a batch id, so it cannot be matched to batch ${expected.batchId}`,
    );
  }
  if (declaredBatchId !== expected.batchId) {
    throw new ProducerInterviewDeliveryError(
      'document_batch_mismatch',
      `${document.documentPath} is for batch id ${declaredBatchId}, not the batch being delivered (${expected.batchId})`,
    );
  }

  const batchMs = Date.parse(expected.batchId);
  if (!Number.isFinite(batchMs)) {
    throw new ProducerInterviewDeliveryError(
      'batch_id_mismatch',
      `batch id ${expected.batchId} is not an ISO-8601 instant`,
    );
  }
  if (document.mtimeMs < batchMs) {
    throw new ProducerInterviewDeliveryError(
      'document_stale',
      `${document.documentPath} is stale: written ${new Date(document.mtimeMs).toISOString()} before the snapshot it claims (${expected.batchId}) — re-render the document from the live snapshot before delivering`,
    );
  }

  const declaredRows = parseProducerInterviewDocumentRowCount(document.text);
  if (declaredRows === null || declaredRows !== expected.rows) {
    throw new ProducerInterviewDeliveryError(
      'document_rows_mismatch',
      `${document.documentPath} declares ${
        declaredRows === null ? 'no row count' : `${declaredRows} rows`
      }, but the snapshot payload carries ${expected.rows}`,
    );
  }
}

// ── Failure surface ─────────────────────────────────────────────────

export type ProducerInterviewDeliveryFailureCode =
  | 'batch_id_mismatch'
  | 'document_unreadable'
  | 'document_batch_mismatch'
  | 'document_stale'
  | 'document_rows_mismatch'
  | 'comment_list_failed'
  | 'comment_failed';

/**
 * A refused delivery. `delivered` carries the outcomes recorded before the
 * failure, so a caller can report (and an idempotent re-run can complete) a
 * partially delivered batch.
 */
export class ProducerInterviewDeliveryError extends Error {
  readonly code: ProducerInterviewDeliveryFailureCode;
  /** The recipient the failure is attributable to, when it is one. */
  readonly itemId?: string;
  readonly delivered: ProducerInterviewDeliveryComment[];

  constructor(
    code: ProducerInterviewDeliveryFailureCode,
    message: string,
    options: {
      itemId?: string;
      delivered?: ReadonlyArray<ProducerInterviewDeliveryComment>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProducerInterviewDeliveryError';
    this.code = code;
    this.delivered = options.delivered === undefined ? [] : [...options.delivered];
    if (options.itemId !== undefined) this.itemId = options.itemId;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Comment composition ─────────────────────────────────────────────

/** Invited rows per root, in the document's group order (codepoint). */
export function producerInterviewPerRootCounts(
  snapshot: ProducerInterviewSnapshot,
): ProducerInterviewRootCount[] {
  return groupProducerInterviewRowsByRoot(snapshot.interview).map((group) => ({
    root: group.root,
    rows: group.rows.length,
  }));
}

function pluralRows(count: number): string {
  return count === 1 ? '1 row' : `${count} rows`;
}

/**
 * Compose the delivery comment text ONCE — the same text is posted on the
 * remediation item and on the batch item, so the reference reads identically
 * wherever it is found. Deterministic: identical input yields identical text.
 */
export function composeProducerInterviewDeliveryComment(input: {
  batchId: string;
  documentPath: string;
  snapshot: ProducerInterviewSnapshot;
}): string {
  const rows: ReadonlyArray<ProducerInterviewRow> = orderProducerInterviewRowsByRoot(
    input.snapshot.interview,
  );
  const perRoot = producerInterviewPerRootCounts(input.snapshot);
  const lines: string[] = [];

  lines.push(`## Producer interview batch delivered — ${input.batchId}`);
  lines.push('');
  lines.push(producerInterviewBatchMarker(input.batchId));
  lines.push('');
  lines.push(`**Batch id:** \`${input.batchId}\``);
  lines.push(`**Document:** \`${input.documentPath}\``);
  lines.push(`**Rows:** ${rows.length}`);
  lines.push(
    `**Per-root counts:** ${
      perRoot.length === 0
        ? 'none'
        : perRoot.map((entry) => `\`${entry.root}\` ${pluralRows(entry.rows)}`).join(' · ')
    }`,
  );
  lines.push('');
  lines.push(`### Invited items (${pluralRows(rows.length)})`);
  lines.push('');
  if (rows.length === 0) {
    lines.push('- _(none — the batch carries no open producer question)_');
  } else {
    for (const row of rows) {
      lines.push(`- \`${row.id}\` — \`${row.root}\``);
    }
  }
  lines.push('');
  lines.push('### How to answer');
  lines.push('');
  lines.push(
    '- Reply **per row number** in the batch document/in-session (for example `1: clear it`, `2: keep waiting because …`), or comment on the row\'s own work item.',
  );
  lines.push(
    '- A row you do not answer **stays flagged** and remains grouped `needs-producer-input`.',
  );
  lines.push(
    "- Answering a row **is the authorisation** for that row's flag clear — no answer, no clear.",
  );
  lines.push('');
  lines.push(
    'This delivery is recorded once per batch id; re-running it for the same batch posts nothing.',
  );

  return `${lines.join('\n')}\n`;
}

// ── IO seam ─────────────────────────────────────────────────────────

/** The injectable I/O the delivery runs through (fake-able in tests). */
export interface ProducerInterviewDeliveryIo {
  /** Read the rendered batch document, including its mtime (staleness proof). */
  readDocument(documentPath: string): Promise<ProducerInterviewDocumentContents>;
  /** `wl --worklog-dir <root>/.worklog comment list <itemId> --json`. */
  listComments(
    root: string,
    itemId: string,
  ): Promise<ReadonlyArray<ProducerInterviewDeliveryCommentRef>>;
  /** `wl --worklog-dir <root>/.worklog comment add <itemId> --comment … --json`. */
  addComment(input: {
    root: string;
    itemId: string;
    body: string;
    author: string;
  }): Promise<ProducerInterviewDeliveryCommentRef>;
}

/** The whole delivery request. */
export interface ProducerInterviewDeliveryRequest {
  /** The batch id — the snapshot timestamp the document declares. */
  batchId: string;
  documentPath: string;
  snapshot: ProducerInterviewSnapshot;
  targets: ReadonlyArray<ProducerInterviewDeliveryTarget>;
  author?: string;
}

// ── Delivery core ───────────────────────────────────────────────────

/** The validated, composed delivery — everything except the posts. */
export interface ProducerInterviewPreparedDelivery {
  batchId: string;
  documentPath: string;
  marker: string;
  rows: number;
  perRoot: ProducerInterviewRootCount[];
  invited: string[];
  body: string;
}

/**
 * Validate the document and compose the comment WITHOUT posting anything (the
 * dry-run path, and the first half of {@link deliverProducerInterviewBatch}).
 */
export async function prepareProducerInterviewDelivery(
  io: Pick<ProducerInterviewDeliveryIo, 'readDocument'>,
  request: ProducerInterviewDeliveryRequest,
): Promise<ProducerInterviewPreparedDelivery> {
  if (request.batchId !== request.snapshot.generatedAt) {
    throw new ProducerInterviewDeliveryError(
      'batch_id_mismatch',
      `batch id ${request.batchId} does not match the snapshot payload's generatedAt (${request.snapshot.generatedAt})`,
    );
  }

  let document: ProducerInterviewDocumentContents;
  try {
    document = await io.readDocument(request.documentPath);
  } catch (error) {
    throw new ProducerInterviewDeliveryError(
      'document_unreadable',
      `cannot read the batch document ${request.documentPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  validateProducerInterviewDocument(
    { ...document, documentPath: request.documentPath },
    { batchId: request.batchId, rows: request.snapshot.interview.length },
  );

  return {
    batchId: request.batchId,
    documentPath: request.documentPath,
    marker: producerInterviewBatchMarker(request.batchId),
    rows: request.snapshot.interview.length,
    perRoot: producerInterviewPerRootCounts(request.snapshot),
    invited: orderProducerInterviewRowsByRoot(request.snapshot.interview).map((row) => row.id),
    body: composeProducerInterviewDeliveryComment({
      batchId: request.batchId,
      documentPath: request.documentPath,
      snapshot: request.snapshot,
    }),
  };
}

function existingMarkerComment(
  comments: ReadonlyArray<ProducerInterviewDeliveryCommentRef>,
  marker: string,
): ProducerInterviewDeliveryCommentRef | undefined {
  return comments.find((comment) => comment.comment.includes(marker));
}

/**
 * Deliver the batch exactly once. Validation runs BEFORE the first post; the
 * recipients are then processed in order, each skipped when its marker is
 * already present. A failure is a {@link ProducerInterviewDeliveryError} that
 * names the recipient and carries the comments already recorded.
 */
export async function deliverProducerInterviewBatch(
  io: ProducerInterviewDeliveryIo,
  request: ProducerInterviewDeliveryRequest,
): Promise<ProducerInterviewDeliveryResult> {
  const author = request.author ?? PRODUCER_INTERVIEW_DELIVERY_AUTHOR;
  const prepared = await prepareProducerInterviewDelivery(io, request);
  const { marker, body } = prepared;

  const comments: ProducerInterviewDeliveryComment[] = [];
  for (const target of request.targets) {
    let existing: ReadonlyArray<ProducerInterviewDeliveryCommentRef>;
    try {
      existing = await io.listComments(target.root, target.itemId);
    } catch (error) {
      throw new ProducerInterviewDeliveryError(
        'comment_list_failed',
        `cannot read the comments on ${target.itemId}: ${errorMessage(error)}`,
        { itemId: target.itemId, delivered: comments, cause: error },
      );
    }

    const already = existingMarkerComment(existing, marker);
    if (already !== undefined) {
      comments.push({
        itemId: target.itemId,
        root: target.root,
        commentId: already.id,
        posted: false,
      });
      continue;
    }

    let created: ProducerInterviewDeliveryCommentRef;
    try {
      created = await io.addComment({
        root: target.root,
        itemId: target.itemId,
        body,
        author,
      });
    } catch (error) {
      throw new ProducerInterviewDeliveryError(
        'comment_failed',
        `wl rejected the delivery comment for ${target.itemId}: ${errorMessage(error)}`,
        { itemId: target.itemId, delivered: comments, cause: error },
      );
    }
    comments.push({
      itemId: target.itemId,
      root: target.root,
      commentId: created.id,
      posted: true,
    });
  }

  return {
    ...prepared,
    comments,
    alreadyDelivered: comments.every((comment) => !comment.posted),
  };
}

// ── Production wiring ───────────────────────────────────────────────

export interface ProducerInterviewDeliverySourceIo {
  exec: CliExecFile;
}

function parseAddedComment(stdout: string): ProducerInterviewDeliveryCommentRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  const comment = record === null ? null : record.comment;
  const entry =
    typeof comment === 'object' && comment !== null
      ? (comment as Record<string, unknown>)
      : null;
  const id = entry === null ? undefined : entry.id;
  const text = entry === null ? undefined : entry.comment;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id, comment: typeof text === 'string' ? text : '' };
}

/**
 * Wire the real document read and the two `wl` calls. Both `wl` invocations
 * target the recipient's own root (`--worklog-dir <root>/.worklog`), so the
 * reference lands in the right database even when the recipients live in
 * different projects.
 */
export function createProducerInterviewDeliveryIo(
  io: Partial<ProducerInterviewDeliverySourceIo> = {},
): ProducerInterviewDeliveryIo {
  const exec = io.exec ?? getExecFileAsync();

  async function runWl(root: string, args: string[]): Promise<string> {
    return spawnCliStdout(exec, CLI_BINARIES, buildWlArgsForRoot(root, args), {
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
      maxBuffer: PRODUCER_INTERVIEW_DELIVERY_MAX_BUFFER_BYTES,
    });
  }

  return {
    async readDocument(documentPath) {
      const info = await stat(documentPath);
      const text = await readFile(documentPath, 'utf8');
      return { text, mtimeMs: info.mtimeMs, documentPath };
    },

    async listComments(root, itemId) {
      const stdout = await runWl(root, ['comment', 'list', itemId, '--json']);
      const comments = parseCommentListOutput(stdout);
      if (comments === null) {
        throw new Error(`unparseable wl comment list --json output for ${itemId}`);
      }
      return comments.map((comment) => ({ id: comment.id, comment: comment.comment }));
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
  };
}
