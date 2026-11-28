/**
 * packages/herdr/src/producer-interview-reconcile.test.ts — fixture-driven pin
 * for the post-batch reconciliation and no-change verification
 * (WL-0MWVMRYL60019FD1, child 5 of WL-0MWTVPK65009NTER).
 *
 * The batch is only trustworthy if the run can prove, per root, exactly what
 * changed: which invited rows were cleared against a recorded answer, which
 * stayed flagged, and that no gate/budget/dispatcher-selection file moved. This
 * suite pins:
 *
 *  - the cleared / unanswered / "keep waiting" (deferred) row outcomes;
 *  - the orphan-clear failure (a row gone from the group with no answer link is
 *    a failure, never a silent reconciliation);
 *  - the explicit fresh-read assertion that an unanswered row still carries
 *    `needsProducerReview=true` and still groups `needs-producer-input`;
 *  - the protected dispatcher-path no-change assertion;
 *  - the deterministic per-root markdown table and JSON payload.
 *
 * Every fixture is inline data: no live worklog, no filesystem, no sleeps.
 */

import { describe, expect, it } from 'vitest';
import {
  DISPATCHER_PROTECTED_PATH_PATTERNS,
  findDispatcherProtectedChanges,
  PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM,
  producerInterviewReconciliationMarker,
  reconcileProducerInterviewBatch,
  renderProducerInterviewReconciliationJson,
  renderProducerInterviewReconciliationMarkdown,
  type ProducerInterviewAnswerLink,
  type ProducerInterviewReconcileInput,
} from './producer-interview-reconcile.js';
import type { ProducerInterviewSnapshot } from './producer-interview-snapshot.js';
import {
  PRODUCER_INTERVIEW_RECONCILE_USAGE,
  parseProducerInterviewReconcileArgs,
  runProducerInterviewReconcile,
  type ProducerInterviewReconcileCliIo,
} from '../../../scripts/producer-interview-reconcile.js';

const CONTEXT_HUB = '/home/operator/projects/ContextHub';
const SORRA_AGENTS = '/home/operator/projects/SorraAgents';

type Group = 'needs-producer-input' | 'can-clear-now';

interface SnapshotRow {
  id: string;
  root: string;
  group: Group;
  title?: string;
}

/** Build a minimal snapshot with the rows in the requested group. */
function snapshot(generatedAt: string, rows: SnapshotRow[]): ProducerInterviewSnapshot {
  const interview = rows
    .filter((row) => row.group === 'needs-producer-input')
    .map((row) => ({
      id: row.id,
      root: row.root,
      title: row.title ?? row.id,
      question: 'question: which option?',
      evidenceCommentId: null,
      flagAge: '1d 0h',
    }));
  const classified = rows.map((row) => ({
    id: row.id,
    root: row.root,
    title: row.title ?? row.id,
    source: 'manual' as const,
    evidence: 'none',
    flagAge: '1d 0h',
    openQuestion: row.group === 'needs-producer-input',
    group: row.group,
    reason: '',
  }));
  const roots = [...new Set(rows.map((row) => row.root))].sort().map((root) => ({
    root,
    flagged: rows.filter((row) => row.root === root).length,
    skippedNotPrep: 0,
    needsProducerInput: rows.filter(
      (row) => row.root === root && row.group === 'needs-producer-input',
    ).length,
    canClearNow: rows.filter((row) => row.root === root && row.group === 'can-clear-now').length,
  }));
  return {
    generatedAt,
    roots,
    counts: {
      'needs-producer-input': interview.length,
      'can-clear-now': classified.filter((row) => row.group === 'can-clear-now').length,
    },
    flaggedTotal: rows.length,
    skippedNotPrep: 0,
    classified,
    interview,
    errors: [],
  };
}

function answer(
  itemId: string,
  root: string,
  options: { clearCommentId?: string | null; deferral?: boolean } = {},
): ProducerInterviewAnswerLink {
  if (options.deferral === true) {
    return { itemId, root, answerCommentId: `ANS-${itemId}`, clearCommentId: null, deferral: true };
  }
  const clearCommentId = Object.prototype.hasOwnProperty.call(options, 'clearCommentId')
    ? options.clearCommentId ?? null
    : `CLR-${itemId}`;
  return {
    itemId,
    root,
    answerCommentId: `ANS-${itemId}`,
    clearCommentId,
    deferral: false,
  };
}

function flagMap(entries: Record<string, boolean>): ReadonlyMap<string, boolean> {
  return new Map(Object.entries(entries));
}

const BEFORE_AT = '2026-11-25T16:37:25.000Z';
const AFTER_AT = '2026-11-25T18:00:00.000Z';

/** The happy-path fixture: one cleared, one deferred, two unanswered. */
const HAPPY_BEFORE = snapshot(BEFORE_AT, [
  { id: 'WL-A', root: CONTEXT_HUB, group: 'needs-producer-input' },
  { id: 'WL-B', root: CONTEXT_HUB, group: 'needs-producer-input' },
  { id: 'SA-C', root: SORRA_AGENTS, group: 'needs-producer-input' },
  { id: 'SA-D', root: SORRA_AGENTS, group: 'needs-producer-input' },
]);

const HAPPY_AFTER = snapshot(AFTER_AT, [
  { id: 'WL-B', root: CONTEXT_HUB, group: 'needs-producer-input' },
  { id: 'SA-C', root: SORRA_AGENTS, group: 'needs-producer-input' },
  { id: 'SA-D', root: SORRA_AGENTS, group: 'needs-producer-input' },
  { id: 'SA-E', root: SORRA_AGENTS, group: 'needs-producer-input' },
]);

const HAPPY_ANSWERS: ProducerInterviewAnswerLink[] = [
  answer('WL-A', CONTEXT_HUB),
  answer('WL-B', CONTEXT_HUB, { deferral: true }),
];

const HAPPY_FLAGS = flagMap({
  'WL-A': false,
  'WL-B': true,
  'SA-C': true,
  'SA-D': true,
  'SA-E': true,
});

function happyInput(
  overrides: Partial<ProducerInterviewReconcileInput> = {},
): ProducerInterviewReconcileInput {
  return {
    before: HAPPY_BEFORE,
    after: HAPPY_AFTER,
    answers: HAPPY_ANSWERS,
    afterFlags: HAPPY_FLAGS,
    ...overrides,
  };
}

describe('reconcileProducerInterviewBatch — the row outcomes', () => {
  it('classifies one cleared, one deferred and two unanswered rows', () => {
    const result = reconcileProducerInterviewBatch(happyInput());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.batchId).toBe(BEFORE_AT);
    expect(result.afterGeneratedAt).toBe(AFTER_AT);

    expect(result.cleared).toEqual([
      { id: 'WL-A', root: CONTEXT_HUB, answerCommentId: 'ANS-WL-A', clearCommentId: 'CLR-WL-A' },
    ]);

    expect(result.stillFlagged).toEqual([
      {
        id: 'WL-B',
        root: CONTEXT_HUB,
        reason: 'deferred',
        answerCommentId: 'ANS-WL-B',
        needsProducerReview: true,
        groupedNeedsProducerInput: true,
      },
      {
        id: 'SA-C',
        root: SORRA_AGENTS,
        reason: 'unanswered',
        answerCommentId: null,
        needsProducerReview: true,
        groupedNeedsProducerInput: true,
      },
      {
        id: 'SA-D',
        root: SORRA_AGENTS,
        reason: 'unanswered',
        answerCommentId: null,
        needsProducerReview: true,
        groupedNeedsProducerInput: true,
      },
    ]);

    expect(result.unanswered).toEqual(['SA-C', 'SA-D']);
    expect(result.appearedAfter).toEqual(['SA-E']);
  });

  it('records one row per root with flagged-before, cleared, still-flagged and invited', () => {
    const result = reconcileProducerInterviewBatch(happyInput());

    expect(result.roots).toEqual([
      {
        root: CONTEXT_HUB,
        flaggedBefore: 2,
        clearedAgainstAnswer: 1,
        stillFlagged: 1,
        totalInvited: 2,
      },
      {
        root: SORRA_AGENTS,
        flaggedBefore: 2,
        clearedAgainstAnswer: 0,
        stillFlagged: 2,
        totalInvited: 2,
      },
    ]);
    for (const root of result.roots) {
      expect(root.clearedAgainstAnswer + root.stillFlagged).toBe(root.totalInvited);
      expect(root.totalInvited).toBe(root.flaggedBefore);
    }
    expect(result.totals).toEqual({
      flaggedBefore: 4,
      clearedAgainstAnswer: 1,
      stillFlagged: 3,
      totalInvited: 4,
      appearedAfter: 1,
    });
  });

  it('reports 0 cleared and N still flagged when the producer answered nothing', () => {
    const after = snapshot(AFTER_AT, [
      { id: 'WL-A', root: CONTEXT_HUB, group: 'needs-producer-input' },
      { id: 'WL-B', root: CONTEXT_HUB, group: 'needs-producer-input' },
      { id: 'SA-C', root: SORRA_AGENTS, group: 'needs-producer-input' },
      { id: 'SA-D', root: SORRA_AGENTS, group: 'needs-producer-input' },
      { id: 'SA-E', root: SORRA_AGENTS, group: 'needs-producer-input' },
    ]);
    const result = reconcileProducerInterviewBatch(
      happyInput({
        after,
        answers: [],
        afterFlags: flagMap({
          'WL-A': true,
          'WL-B': true,
          'SA-C': true,
          'SA-D': true,
          'SA-E': true,
        }),
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.cleared).toEqual([]);
    expect(result.totals).toEqual({
      flaggedBefore: 4,
      clearedAgainstAnswer: 0,
      stillFlagged: 4,
      totalInvited: 4,
      appearedAfter: 1,
    });
  });
});

describe('reconcileProducerInterviewBatch — fail-closed failures', () => {
  it('fails a cleared row with no answer link instead of reporting it reconciled', () => {
    const result = reconcileProducerInterviewBatch(happyInput({ answers: [] }));

    expect(result.valid).toBe(false);
    expect(result.cleared).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'cleared_without_answer', itemId: 'WL-A' }),
    );
  });

  it('fails a cleared row whose answer has no clear comment link', () => {
    const result = reconcileProducerInterviewBatch(
      happyInput({
        answers: [answer('WL-A', CONTEXT_HUB, { clearCommentId: null }), HAPPY_ANSWERS[1]],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'cleared_without_clear_comment', itemId: 'WL-A' }),
    );
  });

  it('fails a "keep waiting" row that was cleared anyway', () => {
    const after = snapshot(AFTER_AT, [
      { id: 'SA-C', root: SORRA_AGENTS, group: 'needs-producer-input' },
      { id: 'SA-D', root: SORRA_AGENTS, group: 'needs-producer-input' },
      { id: 'SA-E', root: SORRA_AGENTS, group: 'needs-producer-input' },
    ]);
    const result = reconcileProducerInterviewBatch(
      happyInput({
        after,
        answers: [answer('WL-A', CONTEXT_HUB), answer('WL-B', CONTEXT_HUB, { deferral: true })],
        afterFlags: flagMap({
          'WL-A': false,
          'WL-B': false,
          'SA-C': true,
          'SA-D': true,
          'SA-E': true,
        }),
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'deferral_row_cleared', itemId: 'WL-B' }),
    );
  });

  it('fails a non-deferral answer whose clear did not take', () => {
    const after = snapshot(AFTER_AT, [
      { id: 'WL-A', root: CONTEXT_HUB, group: 'needs-producer-input' },
      { id: 'WL-B', root: CONTEXT_HUB, group: 'needs-producer-input' },
      { id: 'SA-C', root: SORRA_AGENTS, group: 'needs-producer-input' },
      { id: 'SA-D', root: SORRA_AGENTS, group: 'needs-producer-input' },
      { id: 'SA-E', root: SORRA_AGENTS, group: 'needs-producer-input' },
    ]);
    const result = reconcileProducerInterviewBatch(happyInput({ after }));

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'answer_clear_did_not_take', itemId: 'WL-A' }),
    );
  });

  it('fails an unanswered row that is still flagged but no longer grouped needs-producer-input', () => {
    // SA-C is still flagged (needsProducerReview=true) but the fresh re-run
    // regraded it can-clear-now. The batch did not clear it, so the check fails.
    const after = snapshot(AFTER_AT, [
      { id: 'WL-B', root: CONTEXT_HUB, group: 'needs-producer-input' },
      { id: 'SA-C', root: SORRA_AGENTS, group: 'can-clear-now' },
      { id: 'SA-D', root: SORRA_AGENTS, group: 'needs-producer-input' },
    ]);
    const result = reconcileProducerInterviewBatch(happyInput({ after }));

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'unanswered_row_regrouped', itemId: 'SA-C' }),
    );
  });

  it('fails an unanswered row whose fresh flag read is false', () => {
    const result = reconcileProducerInterviewBatch(
      happyInput({
        afterFlags: flagMap({ 'WL-A': false, 'WL-B': true, 'SA-C': false, 'SA-D': true, 'SA-E': true }),
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'unanswered_row_not_flagged', itemId: 'SA-C' }),
    );
  });
});

describe('protected dispatcher path no-change assertion', () => {
  it('matches the three protected path families exactly', () => {
    expect(DISPATCHER_PROTECTED_PATH_PATTERNS).toHaveLength(3);
    expect(findDispatcherProtectedChanges(['packages/herdr/src/downtime-worker.ts'])).toEqual([
      'packages/herdr/src/downtime-worker.ts',
    ]);
    expect(findDispatcherProtectedChanges(['packages/herdr/src/downtime-log-budget.ts'])).toEqual([
      'packages/herdr/src/downtime-log-budget.ts',
    ]);
    expect(
      findDispatcherProtectedChanges([
        'packages/herdr/src/downtime-round-robin.ts',
        'packages/herdr/src/downtime-round-robin-by-root.ts',
        'packages/herdr/src/downtime-round-robin-by-root.test.ts',
      ]),
    ).toEqual([
      'packages/herdr/src/downtime-round-robin.ts',
      'packages/herdr/src/downtime-round-robin-by-root.ts',
      'packages/herdr/src/downtime-round-robin-by-root.test.ts',
    ]);
  });

  it('ignores the reconciliation module and its sibling docs', () => {
    expect(
      findDispatcherProtectedChanges([
        'packages/herdr/src/producer-interview-reconcile.ts',
        'packages/herdr/src/producer-interview-reconcile.test.ts',
        'scripts/producer-interview-reconcile.ts',
        'docs/dev/downtime-dispatcher.md',
        'packages/herdr/src/downtime-worker-helpers.ts',
      ]),
    ).toEqual([]);
  });
});

describe('rendering', () => {
  it('renders the per-root table, cleared links and still-flagged assertion', () => {
    const markdown = renderProducerInterviewReconciliationMarkdown(
      reconcileProducerInterviewBatch(happyInput()),
    );

    expect(markdown).toContain(
      '| root | flagged before | cleared against an answer | still flagged | total invited |',
    );
    expect(markdown).toContain(`| \`${CONTEXT_HUB}\` | 2 | 1 | 1 | 2 |`);
    expect(markdown).toContain(`| \`${SORRA_AGENTS}\` | 2 | 0 | 2 | 2 |`);
    expect(markdown).toContain(
      '| `WL-A` | ' + `\`${CONTEXT_HUB}\`` + ' | `comment:ANS-WL-A` | `comment:CLR-WL-A` |',
    );
    expect(markdown).toContain('still carry `needsProducerReview=true`');
    expect(markdown).toContain('grouped `needs-producer-input`');
  });

  it('renders an explicit failure section and never a reconciled table when invalid', () => {
    const markdown = renderProducerInterviewReconciliationMarkdown(
      reconcileProducerInterviewBatch(happyInput({ answers: [] })),
    );

    expect(markdown).toContain('### Reconciliation failures (1)');
    expect(markdown).toContain('`cleared_without_answer` `WL-A`');
    expect(markdown).not.toContain('cleared against an answer (1)');
  });

  it('renders the no-change assertion command and its output', () => {
    const markdown = renderProducerInterviewReconciliationMarkdown(
      reconcileProducerInterviewBatch(happyInput()),
      {
        changedRange: 'ea549e293..HEAD',
        changedPaths: [
          'packages/herdr/src/producer-interview-reconcile.ts',
          'packages/herdr/src/producer-interview-reconcile.test.ts',
        ],
      },
    );

    expect(markdown).toContain('git diff --name-only ea549e293..HEAD');
    expect(markdown).toContain('packages/herdr/src/producer-interview-reconcile.ts');
    expect(markdown).toContain('protected paths changed: none');
  });

  it('renders a protected-path change as a failure in the markdown', () => {
    const markdown = renderProducerInterviewReconciliationMarkdown(
      reconcileProducerInterviewBatch(happyInput()),
      {
        changedRange: 'ea549e293..HEAD',
        changedPaths: ['packages/herdr/src/downtime-worker.ts'],
        protectedChanged: ['packages/herdr/src/downtime-worker.ts'],
      },
    );

    expect(markdown).toContain('protected paths changed: **1**');
    expect(markdown).toContain('packages/herdr/src/downtime-worker.ts');
  });

  it('is deterministic for the JSON payload and carries the marker', () => {
    const result = reconcileProducerInterviewBatch(happyInput());
    const first = renderProducerInterviewReconciliationJson(result);
    const second = renderProducerInterviewReconciliationJson(result);
    expect(first).toBe(second);
    const parsed = JSON.parse(first);
    expect(parsed.batchId).toBe(BEFORE_AT);
    expect(parsed.valid).toBe(true);
    expect(parsed.marker).toBe(producerInterviewReconciliationMarker(BEFORE_AT));
  });
});

describe('producer-interview-reconcile CLI', () => {
  const BEFORE_PATH = '/tmp/producer-interview-snapshot-before.json';
  const APPLIED_PATH = '/tmp/producer-applied-answers.json';

  function beforeText(): string {
    return JSON.stringify(HAPPY_BEFORE);
  }

  function appliedText(links: ReadonlyArray<ProducerInterviewAnswerLink> = HAPPY_ANSWERS): string {
    return JSON.stringify({ batchId: BEFORE_AT, rows: links });
  }

  interface FakeReconcileCli {
    io: ProducerInterviewReconcileCliIo;
    stdout: string[];
    stderr: string[];
    comments: Map<string, Array<{ id: string; comment: string }>>;
    calls: string[];
  }

  function fakeReconcileCli(
    options: {
      files?: Record<string, string>;
      after?: ProducerInterviewSnapshot;
      flaggedIds?: string[];
      changedPaths?: string[];
      roots?: string[];
      comments?: Record<string, Array<{ id: string; comment: string }>>;
    } = {},
  ): FakeReconcileCli {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls: string[] = [];
    const comments = new Map<string, Array<{ id: string; comment: string }>>(
      Object.entries(options.comments ?? {}),
    );
    const files: Record<string, string> = {
      [BEFORE_PATH]: beforeText(),
      ...(options.files ?? {}),
    };
    let nextId = 900;

    const io: ProducerInterviewReconcileCliIo = {
      async readFile(path) {
        const text = files[path];
        if (text === undefined) throw new Error(`no such file: ${path}`);
        return text;
      },
      cwd: () => CONTEXT_HUB,
      loadRoots: () => options.roots ?? [CONTEXT_HUB, SORRA_AGENTS],
      nowMs: () => Date.parse(AFTER_AT),
      collectSnapshot: async () => options.after ?? HAPPY_AFTER,
      readFlaggedIds: async () =>
        new Set(
          options.flaggedIds ?? ['WL-B', 'SA-C', 'SA-D', 'SA-E'],
        ),
      runGitDiffNames: async (range) => {
        calls.push(`git diff --name-only ${range}`);
        return options.changedPaths ?? ['packages/herdr/src/producer-interview-reconcile.ts'];
      },
      async listComments(root, itemId) {
        return comments.get(`${root}\u0000${itemId}`) ?? [];
      },
      async addComment({ root, itemId, body }) {
        const key = `${root}\u0000${itemId}`;
        const entry = { id: `NEW-${nextId++}`, comment: body };
        const existing = comments.get(key) ?? [];
        comments.set(key, [...existing, entry]);
        return entry;
      },
      async updateComment({ root, commentId, body }) {
        for (const [key, entries] of comments) {
          if (!key.startsWith(`${root}\u0000`)) continue;
          const index = entries.findIndex((entry) => entry.id === commentId);
          if (index >= 0) {
            const updated = { id: commentId, comment: body };
            entries[index] = updated;
            return updated;
          }
        }
        throw new Error(`unknown comment ${commentId}`);
      },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    };

    return { io, stdout, stderr, comments, calls };
  }

  it('parses defaults and requires --before', () => {
    const parsed = parseProducerInterviewReconcileArgs([
      '--before',
      BEFORE_PATH,
      '--applied',
      APPLIED_PATH,
      '--changed-range',
      'ea549e293..HEAD',
      '--root',
      CONTEXT_HUB,
    ]);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.args).toMatchObject({
      beforePath: BEFORE_PATH,
      appliedPath: APPLIED_PATH,
      changedRange: 'ea549e293..HEAD',
      roots: [CONTEXT_HUB],
      summaryItem: PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM,
      author: 'implement',
      post: false,
      json: false,
      dryRun: false,
    });
    expect(parseProducerInterviewReconcileArgs([])).toEqual({ error: '--before is required' });
    expect(parseProducerInterviewReconcileArgs(['--before', 'x', '--nope'])).toEqual({
      error: 'unknown argument: --nope',
    });
    expect(
      parseProducerInterviewReconcileArgs(['--before', 'x', '--json', '--dry-run']),
    ).toHaveProperty('error');
  });

  it('prints the help text on --help', async () => {
    const cli = fakeReconcileCli();
    const code = await runProducerInterviewReconcile(['--help'], cli.io);
    expect(code).toBe(0);
    expect(cli.stdout.join('')).toBe(PRODUCER_INTERVIEW_RECONCILE_USAGE);
  });

  it('reconciles, asserts no dispatcher change and records the table once', async () => {
    const cli = fakeReconcileCli({
      files: { [APPLIED_PATH]: appliedText() },
    });

    const code = await runProducerInterviewReconcile(
      [
        '--before',
        BEFORE_PATH,
        '--applied',
        APPLIED_PATH,
        '--changed-range',
        'ea549e293..HEAD',
        '--post',
      ],
      cli.io,
    );

    expect(code).toBe(0);
    expect(cli.stderr.join('')).toBe('');
    expect(cli.stdout.join('')).toContain('### Per-root reconciliation');
    expect(cli.stdout.join('')).toContain('git diff --name-only ea549e293..HEAD');
    expect(cli.stdout.join('')).toContain('protected paths changed: none');
    expect(cli.calls).toContain('git diff --name-only ea549e293..HEAD');

    const posted = cli.comments.get(
      `${CONTEXT_HUB}\u0000${PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM}`,
    );
    expect(posted).toHaveLength(1);
    expect(posted?.[0].comment).toContain(
      producerInterviewReconciliationMarker(BEFORE_AT),
    );
  });

  it('updates an existing reconciliation comment instead of posting a second one', async () => {
    const marker = producerInterviewReconciliationMarker(BEFORE_AT);
    const cli = fakeReconcileCli({
      files: { [APPLIED_PATH]: appliedText() },
      comments: {
        [`${CONTEXT_HUB}\u0000${PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM}`]: [
          { id: 'OLD-1', comment: `stale\n${marker}` },
        ],
      },
    });

    const code = await runProducerInterviewReconcile(
      ['--before', BEFORE_PATH, '--applied', APPLIED_PATH, '--post'],
      cli.io,
    );

    expect(code).toBe(0);
    const posted = cli.comments.get(
      `${CONTEXT_HUB}\u0000${PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM}`,
    );
    expect(posted).toHaveLength(1);
    expect(posted?.[0].id).toBe('OLD-1');
    expect(posted?.[0].comment).toContain('### Per-root reconciliation');
    expect(cli.stdout.join('')).toContain('updated');
  });

  it('prints the machine result with --json and never posts', async () => {
    const cli = fakeReconcileCli({ files: { [APPLIED_PATH]: appliedText() } });

    const code = await runProducerInterviewReconcile(
      ['--before', BEFORE_PATH, '--applied', APPLIED_PATH, '--json'],
      cli.io,
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(cli.stdout.join(''));
    expect(parsed.valid).toBe(true);
    expect(parsed.noChange).toEqual({});
    expect(cli.comments.size).toBe(0);
  });

  it('records the failure table and exits 1 on a protected dispatcher path change', async () => {
    const cli = fakeReconcileCli({
      files: { [APPLIED_PATH]: appliedText() },
      changedPaths: [
        'packages/herdr/src/downtime-worker.ts',
        'packages/herdr/src/producer-interview-reconcile.ts',
      ],
    });

    const code = await runProducerInterviewReconcile(
      [
        '--before',
        BEFORE_PATH,
        '--applied',
        APPLIED_PATH,
        '--changed-range',
        'ea549e293..HEAD',
        '--post',
      ],
      cli.io,
    );

    expect(code).toBe(1);
    expect(cli.stderr.join('')).toMatch(/protected dispatcher path/i);
    expect(cli.stdout.join('')).toContain('protected paths changed: **1**');
    const posted = cli.comments.get(
      `${CONTEXT_HUB}\u0000${PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM}`,
    );
    expect(posted).toHaveLength(1);
    expect(posted?.[0].comment).toContain('**Validity:** FAILED');
    expect(posted?.[0].comment).toContain('protected paths changed: **1**');
  });

  it('records the failure table and exits 1 on an orphan clear', async () => {
    const cli = fakeReconcileCli({
      files: { [APPLIED_PATH]: appliedText([HAPPY_ANSWERS[1]]) },
    });

    const code = await runProducerInterviewReconcile(
      ['--before', BEFORE_PATH, '--applied', APPLIED_PATH, '--post'],
      cli.io,
    );

    expect(code).toBe(1);
    expect(cli.stderr.join('')).toContain('cleared_without_answer');
    expect(cli.stdout.join('')).toContain('### Reconciliation failures (1)');
    const posted = cli.comments.get(
      `${CONTEXT_HUB}\u0000${PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM}`,
    );
    expect(posted).toHaveLength(1);
    expect(posted?.[0].comment).toContain('**Validity:** FAILED');
    expect(posted?.[0].comment).toContain('cleared_without_answer');
  });

  it('writes nothing with --dry-run', async () => {
    const cli = fakeReconcileCli({ files: { [APPLIED_PATH]: appliedText() } });

    const code = await runProducerInterviewReconcile(
      ['--before', BEFORE_PATH, '--applied', APPLIED_PATH, '--dry-run'],
      cli.io,
    );

    expect(code).toBe(0);
    expect(cli.comments.size).toBe(0);
    expect(cli.stdout.join('')).toContain('### Per-root reconciliation');
  });

  it('exits 2 when the applied batch id disagrees with the snapshot', async () => {
    const cli = fakeReconcileCli({
      files: {
        [APPLIED_PATH]: JSON.stringify({ batchId: '2026-11-26T00:00:00.000Z', rows: [] }),
      },
    });

    const code = await runProducerInterviewReconcile(
      ['--before', BEFORE_PATH, '--applied', APPLIED_PATH],
      cli.io,
    );

    expect(code).toBe(2);
    expect(cli.stderr.join('')).toMatch(/does not match/i);
  });

  it('exits 2 on a malformed applied-answers payload', async () => {
    const cli = fakeReconcileCli({
      files: { [APPLIED_PATH]: JSON.stringify({ batchId: BEFORE_AT, rows: [{ itemId: 'X' }] }) },
    });

    const code = await runProducerInterviewReconcile(
      ['--before', BEFORE_PATH, '--applied', APPLIED_PATH],
      cli.io,
    );

    expect(code).toBe(2);
    expect(cli.stderr.join('')).toMatch(/applied-answers row is malformed/);
  });
});
