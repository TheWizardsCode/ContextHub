/**
 * packages/herdr/src/producer-interview-delivery.test.ts — pin for the
 * once-only delivery of the batched producer interview (WL-0MWVMRX4X003DKCT,
 * child 3 of WL-0MWTVPK65009NTER).
 *
 * Delivery is the moment the batch reaches the producer, so this suite pins the
 * contract the parent acceptance criterion names:
 *
 *  - exactly one delivery comment on each recipient — the remediation item
 *    first, then the batch item — carrying the batch id (snapshot timestamp),
 *    the document path, the row count, the per-root counts and every invited
 *    item id;
 *  - the answer instructions: reply per row number in-session or comment on the
 *    row's own item, unanswered rows stay flagged, and an answer is the
 *    authorisation for that row's clear;
 *  - idempotency from the stable `[producer-interview-batch:<id>]` marker: a
 *    second run for the same batch id posts nothing and reports "already
 *    delivered" (proven by counting posts against a fake `wl` runner);
 *  - a stale document (older than the snapshot it claims) or a document for a
 *    different batch/row set is refused before anything is posted;
 *  - a `wl` rejection is a loud, attributable failure that leaves an idempotent
 *    re-run possible.
 *
 * Every fixture is inline data: no live worklog, no filesystem, no sleeps.
 */

import { describe, expect, it } from 'vitest';

import {
  PRODUCER_INTERVIEW_BATCH_ITEM,
  PRODUCER_INTERVIEW_REMEDIATION_ITEM,
  ProducerInterviewDeliveryError,
  composeProducerInterviewDeliveryComment,
  defaultProducerInterviewDeliveryTargets,
  deliverProducerInterviewBatch,
  parseProducerInterviewDocumentBatchId,
  parseProducerInterviewDocumentRowCount,
  producerInterviewBatchMarker,
  producerInterviewPerRootCounts,
  validateProducerInterviewDocument,
  type ProducerInterviewDeliveryCommentRef,
  type ProducerInterviewDeliveryIo,
  type ProducerInterviewDeliveryRequest,
} from './producer-interview-delivery.js';
import {
  parseProducerInterviewDeliverArgs,
  PRODUCER_INTERVIEW_DELIVERY_USAGE,
  runProducerInterviewDeliver,
  type ProducerInterviewDeliverCliIo,
} from '../../../scripts/producer-interview-deliver.js';
import type {
  ProducerInterviewRow,
  ProducerInterviewSnapshot,
} from './producer-interview-snapshot.js';

const BATCH_ID = '2026-11-25T16:01:53.100Z';
const BATCH_MS = Date.parse(BATCH_ID);
const CONTEXT_HUB = '/home/operator/projects/ContextHub';
const AI_HELL = '/home/operator/projects/AI_Hell';
const DOCUMENT_PATH = 'docs/dev/producer-interview-batch-2026-11-25.md';
const REMEDIATION = 'WL-0MWTAD1KM0081UUD';
const BATCH_ITEM = 'WL-0MWTVPK65009NTER';

function row(
  id: string,
  root: string = CONTEXT_HUB,
  title: string = `Title for ${id}`,
): ProducerInterviewRow {
  return {
    id,
    root,
    title,
    question: `question: what should ${id} do?`,
    evidenceCommentId: 'WL-C000000000000001',
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

/** The header the batch-document renderer writes (child 2). */
function documentText(batchId = BATCH_ID, rows = 3): string {
  return [
    `# Producer interview batch — ${batchId}`,
    '',
    `**Batch id:** \`${batchId}\` · **Rows:** ${rows} · **Roots:** 2`,
    '',
    '## How to answer',
    '',
    'Reply once, **per row number**.',
    '',
  ].join('\n');
}

function targets(): Array<{ itemId: string; root: string }> {
  return defaultProducerInterviewDeliveryTargets(CONTEXT_HUB);
}

function request(overrides: Partial<ProducerInterviewDeliveryRequest> = {}): ProducerInterviewDeliveryRequest {
  return {
    batchId: BATCH_ID,
    documentPath: DOCUMENT_PATH,
    snapshot: snapshot([row('AH-1', AI_HELL), row('AH-2', AI_HELL), row(REMEDIATION)]),
    targets: targets(),
    author: 'implement',
    ...overrides,
  };
}

/**
 * A fake `wl` runner: it records every write, serves a scripted document and
 * returns generated comment ids, so "posted exactly once" is a count, not a
 * promise.
 */
class FakeDeliveryIo implements ProducerInterviewDeliveryIo {
  document: { text: string; mtimeMs: number } | { error: string };
  readonly comments = new Map<string, ProducerInterviewDeliveryCommentRef[]>();
  readonly posts: Array<{ root: string; itemId: string; body: string; author: string }> = [];
  readonly documentPaths: string[] = [];
  failPostFor: string | null = null;
  failListFor: string | null = null;
  private nextComment = 1;

  constructor(text = documentText(), mtimeMs = BATCH_MS + 1_000) {
    this.document = { text, mtimeMs };
  }

  async readDocument(path: string): Promise<{ text: string; mtimeMs: number; documentPath: string }> {
    this.documentPaths.push(path);
    if ('error' in this.document) throw new Error(this.document.error);
    return { ...this.document, documentPath: path };
  }

  async listComments(
    _root: string,
    itemId: string,
  ): Promise<ReadonlyArray<ProducerInterviewDeliveryCommentRef>> {
    if (this.failListFor === itemId) throw new Error('wl comment list failed');
    return this.comments.get(itemId) ?? [];
  }

  async addComment(input: {
    root: string;
    itemId: string;
    body: string;
    author: string;
  }): Promise<ProducerInterviewDeliveryCommentRef> {
    if (this.failPostFor === input.itemId) {
      throw new Error(`wl comment add ${input.itemId}: work item not found`);
    }
    const ref: ProducerInterviewDeliveryCommentRef = {
      id: `WL-C${String(this.nextComment++).padStart(6, '0')}`,
      comment: input.body,
    };
    this.posts.push({ ...input });
    this.comments.set(input.itemId, [...(this.comments.get(input.itemId) ?? []), ref]);
    return ref;
  }

  /** Seed an existing comment (e.g. a previous delivery's marker). */
  seed(itemId: string, comment: string, id = 'WL-CSEEDED00001'): void {
    this.comments.set(itemId, [
      ...(this.comments.get(itemId) ?? []),
      { id, comment },
    ]);
  }

  postCount(itemId: string): number {
    return this.posts.filter((post) => post.itemId === itemId).length;
  }
}

async function failWith(
  promise: Promise<unknown>,
): Promise<ProducerInterviewDeliveryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProducerInterviewDeliveryError);
    return error as ProducerInterviewDeliveryError;
  }
  throw new Error('expected a ProducerInterviewDeliveryError');
}

// ── Pure helpers ─────────────────────────────────────────────────────

describe('producer-interview delivery helpers', () => {
  it('builds the stable idempotency marker from the batch id', () => {
    expect(producerInterviewBatchMarker(BATCH_ID)).toBe(
      '[producer-interview-batch:2026-11-25T16:01:53.100Z]',
    );
  });

  it('parses the batch id and row count the document declares', () => {
    const text = documentText(BATCH_ID, 17);
    expect(parseProducerInterviewDocumentBatchId(text)).toBe(BATCH_ID);
    expect(parseProducerInterviewDocumentRowCount(text)).toBe(17);
    expect(parseProducerInterviewDocumentBatchId('no header here')).toBeNull();
    expect(parseProducerInterviewDocumentRowCount('no header here')).toBeNull();
  });

  it('counts invited rows per root in codepoint order', () => {
    const payload = snapshot([
      row('B-1', AI_HELL),
      row('C-1', CONTEXT_HUB),
      row('B-2', AI_HELL),
    ]);
    expect(producerInterviewPerRootCounts(payload)).toEqual([
      { root: AI_HELL, rows: 2 },
      { root: CONTEXT_HUB, rows: 1 },
    ]);
  });

  it('orders the default recipients remediation-item first, batch item second', () => {
    const defaults = defaultProducerInterviewDeliveryTargets(CONTEXT_HUB);
    expect(defaults).toEqual([
      { itemId: REMEDIATION, root: CONTEXT_HUB },
      { itemId: BATCH_ITEM, root: CONTEXT_HUB },
    ]);
    expect(PRODUCER_INTERVIEW_REMEDIATION_ITEM).toBe(REMEDIATION);
    expect(PRODUCER_INTERVIEW_BATCH_ITEM).toBe(BATCH_ITEM);
  });
});

// ── The delivery comment text ────────────────────────────────────────

describe('delivery comment composition', () => {
  const compose = (payload = request()) =>
    composeProducerInterviewDeliveryComment({
      batchId: payload.batchId,
      documentPath: payload.documentPath,
      snapshot: payload.snapshot,
    });

  it('quotes the batch id, document path, row count and per-root counts', () => {
    const body = compose();
    expect(body).toContain(BATCH_ID);
    expect(body).toContain(DOCUMENT_PATH);
    expect(body).toContain('**Rows:** 3');
    expect(body).toContain(AI_HELL);
    expect(body).toContain(CONTEXT_HUB);
  });

  it('lists every invited item id, once each', () => {
    const payload = request();
    const body = compose(payload);
    for (const invited of payload.snapshot.interview) {
      expect(body).toContain(invited.id);
      expect(body.split(invited.id).length - 1).toBe(1);
    }
  });

  it('states how to answer, that unanswered rows stay flagged, and that an answer authorises the clear', () => {
    const body = compose().toLowerCase();
    expect(body).toContain('row number');
    expect(body).toContain("row's own");
    expect(body).toContain('stays flagged');
    expect(body).toMatch(/authoris/);
    expect(body).toContain('needs-producer-input');
  });

  it('lists the invited rows in the document\'s group order — root codepoint, snapshot order within a root', () => {
    const payload = request({
      snapshot: snapshot([
        row('T-1', '/roots/zeta'),
        row('A-1', '/roots/alpha'),
        row('A-2', '/roots/alpha'),
      ]),
    });
    const body = compose(payload);
    const positions = ['A-1', 'A-2', 'T-1'].map((id) => body.indexOf(id));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('carries the idempotency marker', () => {
    expect(compose()).toContain(producerInterviewBatchMarker(BATCH_ID));
  });

  it('is deterministic — the same input composes the same text', () => {
    expect(compose()).toBe(compose());
  });
});

// ── Document validation ──────────────────────────────────────────────

describe('delivery document validation', () => {
  const expected = { batchId: BATCH_ID, rows: 3 };

  it('accepts a document written for this batch, at or after the snapshot instant', () => {
    expect(() =>
      validateProducerInterviewDocument(
        { text: documentText(), mtimeMs: BATCH_MS, documentPath: DOCUMENT_PATH },
        expected,
      ),
    ).not.toThrow();
  });

  it('refuses a document older than the snapshot it claims', () => {
    expect(() =>
      validateProducerInterviewDocument(
        { text: documentText(), mtimeMs: BATCH_MS - 1, documentPath: DOCUMENT_PATH },
        expected,
      ),
    ).toThrow(/stale/i);
  });

  it('refuses a document for a different batch id', () => {
    expect(() =>
      validateProducerInterviewDocument(
        {
          text: documentText('2026-11-25T15:50:28.074Z'),
          mtimeMs: BATCH_MS + 1_000,
          documentPath: DOCUMENT_PATH,
        },
        expected,
      ),
    ).toThrow(/batch id/i);
  });

  it('refuses a document whose row count does not match the snapshot', () => {
    expect(() =>
      validateProducerInterviewDocument(
        { text: documentText(BATCH_ID, 2), mtimeMs: BATCH_MS, documentPath: DOCUMENT_PATH },
        expected,
      ),
    ).toThrow(/rows/i);
  });
});

// ── Delivery ─────────────────────────────────────────────────────────

describe('deliverProducerInterviewBatch', () => {
  it('posts one identical delivery comment per recipient, remediation item first', async () => {
    const io = new FakeDeliveryIo();
    const result = await deliverProducerInterviewBatch(io, request());

    expect(io.posts.map((post) => post.itemId)).toEqual([REMEDIATION, BATCH_ITEM]);
    expect(io.posts[0].body).toBe(io.posts[1].body);
    expect(io.posts[0].root).toBe(CONTEXT_HUB);
    expect(io.posts[0].author).toBe('implement');
    expect(io.posts[0].body).toContain(producerInterviewBatchMarker(BATCH_ID));

    expect(result.alreadyDelivered).toBe(false);
    expect(result.rows).toBe(3);
    expect(result.comments).toEqual([
      { itemId: REMEDIATION, root: CONTEXT_HUB, commentId: 'WL-C000001', posted: true },
      { itemId: BATCH_ITEM, root: CONTEXT_HUB, commentId: 'WL-C000002', posted: true },
    ]);
  });

  it('posts nothing and reports already-delivered on a second run for the same batch id', async () => {
    const io = new FakeDeliveryIo();
    const first = await deliverProducerInterviewBatch(io, request());
    const before = io.posts.length;

    const second = await deliverProducerInterviewBatch(io, request());

    expect(io.posts.length).toBe(before);
    expect(io.postCount(REMEDIATION)).toBe(1);
    expect(io.postCount(BATCH_ITEM)).toBe(1);
    expect(second.alreadyDelivered).toBe(true);
    expect(second.comments).toEqual(
      first.comments.map((comment) => ({ ...comment, posted: false })),
    );
  });

  it('completes a partially delivered batch by posting only the missing comment', async () => {
    const io = new FakeDeliveryIo();
    io.seed(REMEDIATION, `delivered\n${producerInterviewBatchMarker(BATCH_ID)}`, 'WL-CDELIVERED');

    const result = await deliverProducerInterviewBatch(io, request());

    expect(io.posts.map((post) => post.itemId)).toEqual([BATCH_ITEM]);
    expect(result.comments[0]).toEqual({
      itemId: REMEDIATION,
      root: CONTEXT_HUB,
      commentId: 'WL-CDELIVERED',
      posted: false,
    });
    expect(result.comments[1].posted).toBe(true);
    expect(result.alreadyDelivered).toBe(false);
  });

  it('does not treat a marker for another batch id as this batch', async () => {
    const io = new FakeDeliveryIo();
    io.seed(REMEDIATION, producerInterviewBatchMarker('2026-11-25T15:50:28.074Z'));
    io.seed(BATCH_ITEM, producerInterviewBatchMarker('2026-11-25T15:50:28.074Z'));

    await deliverProducerInterviewBatch(io, request());

    expect(io.posts.map((post) => post.itemId)).toEqual([REMEDIATION, BATCH_ITEM]);
  });

  it('refuses a stale document before posting anything', async () => {
    const io = new FakeDeliveryIo(documentText(), BATCH_MS - 60_000);

    const error = await failWith(deliverProducerInterviewBatch(io, request()));

    expect(error.code).toBe('document_stale');
    expect(io.posts).toHaveLength(0);
    expect(error.delivered).toEqual([]);
  });

  it('refuses a document for a different batch id before posting anything', async () => {
    const io = new FakeDeliveryIo(documentText('2026-11-25T15:50:28.074Z'), BATCH_MS + 1_000);

    const error = await failWith(deliverProducerInterviewBatch(io, request()));

    expect(error.code).toBe('document_batch_mismatch');
    expect(io.posts).toHaveLength(0);
  });

  it('refuses a document whose row count does not match the snapshot', async () => {
    const io = new FakeDeliveryIo(documentText(BATCH_ID, 9), BATCH_MS + 1_000);

    const error = await failWith(deliverProducerInterviewBatch(io, request()));

    expect(error.code).toBe('document_rows_mismatch');
    expect(io.posts).toHaveLength(0);
  });

  it('fails loudly when the document is missing on disk', async () => {
    const io = new FakeDeliveryIo();
    io.document = { error: 'ENOENT: no such file or directory' };

    const error = await failWith(deliverProducerInterviewBatch(io, request()));

    expect(error.code).toBe('document_unreadable');
    expect(io.posts).toHaveLength(0);
  });

  it('refuses a batch id that disagrees with the snapshot payload', async () => {
    const io = new FakeDeliveryIo();

    const error = await failWith(
      deliverProducerInterviewBatch(io, request({ batchId: '2026-11-25T00:00:00.000Z' })),
    );

    expect(error.code).toBe('batch_id_mismatch');
    expect(io.posts).toHaveLength(0);
  });

  it('reports a rejected first comment with its item and posts nothing to the second item', async () => {
    const io = new FakeDeliveryIo();
    io.failPostFor = REMEDIATION;

    const error = await failWith(deliverProducerInterviewBatch(io, request()));

    expect(error.code).toBe('comment_failed');
    expect(error.itemId).toBe(REMEDIATION);
    expect(error.message).toContain(REMEDIATION);
    expect(error.delivered).toEqual([]);
    expect(io.postCount(BATCH_ITEM)).toBe(0);
  });

  it('reports a rejected second comment, keeps the first, and lets a re-run finish idempotently', async () => {
    const io = new FakeDeliveryIo();
    io.failPostFor = BATCH_ITEM;

    const error = await failWith(deliverProducerInterviewBatch(io, request()));

    expect(error.code).toBe('comment_failed');
    expect(error.itemId).toBe(BATCH_ITEM);
    expect(error.delivered).toEqual([
      { itemId: REMEDIATION, root: CONTEXT_HUB, commentId: 'WL-C000001', posted: true },
    ]);

    io.failPostFor = null;
    const retry = await deliverProducerInterviewBatch(io, request());

    expect(io.postCount(REMEDIATION)).toBe(1);
    expect(io.postCount(BATCH_ITEM)).toBe(1);
    expect(retry.comments[0].posted).toBe(false);
    expect(retry.comments[1].posted).toBe(true);
  });

  it('reports an unreadable comment list without posting anything', async () => {
    const io = new FakeDeliveryIo();
    io.failListFor = REMEDIATION;

    const error = await failWith(deliverProducerInterviewBatch(io, request()));

    expect(error.code).toBe('comment_list_failed');
    expect(error.itemId).toBe(REMEDIATION);
    expect(io.posts).toHaveLength(0);
  });
});

// ── The thin CLI wrapper ─────────────────────────────────────────────

interface FakeCli {
  io: ProducerInterviewDeliverCliIo;
  delivery: FakeDeliveryIo;
  stdout: string[];
  stderr: string[];
}

function fakeCli(
  payload: unknown = snapshot([row('AH-1', AI_HELL), row('AH-2', AI_HELL), row(REMEDIATION)]),
  delivery: FakeDeliveryIo = new FakeDeliveryIo(),
): FakeCli {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    delivery,
    stdout,
    stderr,
    io: {
      readStdin: async () => JSON.stringify(payload),
      readFile: async () => JSON.stringify(payload),
      cwd: () => CONTEXT_HUB,
      createIo: () => delivery,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

describe('producer-interview-deliver CLI', () => {
  it('parses defaults: stdin snapshot, cwd root, the two documented recipients', () => {
    const parsed = parseProducerInterviewDeliverArgs([]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.args).toMatchObject({
      remediationItem: REMEDIATION,
      batchItem: BATCH_ITEM,
      author: 'implement',
      dryRun: false,
      json: false,
      help: false,
    });
    expect(parsed.args.snapshotPath).toBeUndefined();
  });

  it('parses explicit flags and rejects unknown arguments', () => {
    const parsed = parseProducerInterviewDeliverArgs([
      '--snapshot',
      '/tmp/snapshot.json',
      '--document',
      '/tmp/doc.md',
      '--root',
      '/tmp/root',
      '--remediation',
      'XX-1',
      '--batch-item',
      'XX-2',
      '--author',
      'producer',
      '--dry-run',
    ]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.args).toMatchObject({
      snapshotPath: '/tmp/snapshot.json',
      documentPath: '/tmp/doc.md',
      root: '/tmp/root',
      remediationItem: 'XX-1',
      batchItem: 'XX-2',
      author: 'producer',
      dryRun: true,
      json: false,
    });
    expect(parseProducerInterviewDeliverArgs(['--nope'])).toEqual({
      error: 'unknown argument: --nope',
    });
    expect(parseProducerInterviewDeliverArgs(['--dry-run', '--json'])).toHaveProperty('error');
  });

  it('prints the help text on --help', async () => {
    const cli = fakeCli();
    const code = await runProducerInterviewDeliver(['--help'], cli.io);
    expect(code).toBe(0);
    expect(cli.stdout.join('')).toBe(PRODUCER_INTERVIEW_DELIVERY_USAGE);
  });

  it('delivers once and prints both recorded comment ids', async () => {
    const cli = fakeCli();
    const code = await runProducerInterviewDeliver(['--root', CONTEXT_HUB], cli.io);

    expect(code).toBe(0);
    expect(cli.stderr.join('')).toBe('');
    expect(cli.delivery.postCount(REMEDIATION)).toBe(1);
    expect(cli.delivery.postCount(BATCH_ITEM)).toBe(1);
    const output = cli.stdout.join('');
    expect(output).toContain(REMEDIATION);
    expect(output).toContain(BATCH_ITEM);
    expect(output).toContain('WL-C000001');
    expect(output).toContain('WL-C000002');
  });

  it('drives the documented default document path from the batch id', async () => {
    const cli = fakeCli();
    const code = await runProducerInterviewDeliver([], cli.io);
    expect(code).toBe(0);
    expect(cli.delivery.documentPaths).toEqual([DOCUMENT_PATH]);
  });

  it('reports "already delivered" and posts nothing on a second run', async () => {
    const cli = fakeCli();
    await runProducerInterviewDeliver([], cli.io);
    const before = cli.delivery.posts.length;

    const code = await runProducerInterviewDeliver([], cli.io);

    expect(code).toBe(0);
    expect(cli.delivery.posts.length).toBe(before);
    expect(cli.stdout.join('')).toMatch(/already delivered/i);
  });

  it('prints the composed comment and posts nothing with --dry-run', async () => {
    const cli = fakeCli();
    const code = await runProducerInterviewDeliver(['--dry-run'], cli.io);

    expect(code).toBe(0);
    expect(cli.delivery.posts).toHaveLength(0);
    const output = cli.stdout.join('');
    expect(output).toContain(producerInterviewBatchMarker(BATCH_ID));
    expect(output).toContain(REMEDIATION);
  });

  it('prints the machine result with --json', async () => {
    const cli = fakeCli();
    const code = await runProducerInterviewDeliver(['--json'], cli.io);

    expect(code).toBe(0);
    const parsed = JSON.parse(cli.stdout.join('')) as {
      batchId: string;
      alreadyDelivered: boolean;
      comments: Array<{ itemId: string; commentId: string; posted: boolean }>;
    };
    expect(parsed.batchId).toBe(BATCH_ID);
    expect(parsed.alreadyDelivered).toBe(false);
    expect(parsed.comments.map((comment) => comment.itemId)).toEqual([
      REMEDIATION,
      BATCH_ITEM,
    ]);
  });

  it('exits 1 with the refusal reason when the document is stale', async () => {
    const cli = fakeCli(undefined, new FakeDeliveryIo(documentText(), BATCH_MS - 1_000));
    const code = await runProducerInterviewDeliver([], cli.io);

    expect(code).toBe(1);
    expect(cli.stderr.join('')).toMatch(/stale/i);
    expect(cli.delivery.posts).toHaveLength(0);
  });

  it('exits 2 on a payload that is not a snapshot', async () => {
    const cli = fakeCli({ nope: true });
    const code = await runProducerInterviewDeliver([], cli.io);

    expect(code).toBe(2);
    expect(cli.stderr.join('')).toContain('not a producer-interview snapshot payload');
  });
});
