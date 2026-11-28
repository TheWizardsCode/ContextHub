/**
 * packages/herdr/src/producer-interview-snapshot.test.ts — fixture-driven pin
 * for the LIVE producer-interview snapshot (WL-0MWVMRVOV0026OWM, child 1 of
 * WL-0MWTVPK65009NTER).
 *
 * The parent interview must invite exactly TODAY's `needs-producer-input` prep
 * rows, not the 2026-11-23 snapshot. This suite pins:
 *
 *  - the three documented shapes (a `question-loop` row with an unanswered
 *    question; a `manual` fail-closed row with no surviving evidence; a row
 *    cleared after an earlier snapshot, absent from live output);
 *  - the exact interview payload (id, root, title, question text, deciding
 *    evidence comment id, flag age);
 *  - the READ-ONLY guarantee (no `wl update` / `comment add` / `reviewed` /
 *    `audit-set` path is ever reached) and the non-prep exclusion.
 *
 * Every fixture is inline data: no live worklog, no filesystem, no sleeps.
 * The production `wl` wiring is exercised through an injected exec seam, so the
 * read-only assertion runs against the real argument vector.
 */

import { describe, expect, it } from 'vitest';
import {
  FALLBACK_INTERVIEW_QUESTION,
  assertReadOnlyWlArgs,
  collectProducerInterviewSnapshot,
  createProducerInterviewSnapshotIo,
  deriveProducerInterviewHolds,
  extractDescriptionQuestion,
  extractQuestionText,
  interviewQuestionFor,
  parseAuditShowOutput,
  parseBlockerListOutput,
  parseCommentListOutput,
  parseFlaggedListOutput,
  renderProducerInterviewSnapshotJson,
  renderProducerInterviewSnapshotMarkdown,
  type ProducerInterviewFlaggedItem,
  type ProducerInterviewItemEvidence,
  type ProducerInterviewSnapshotIo,
} from './producer-interview-snapshot.js';
import type { CliExecFile } from './cli-spawn.js';
import type { ProducerReviewComment } from './downtime-worker.producer-review-provenance.js';
import {
  parseProducerInterviewArgs,
  renderProducerInterviewOutput,
} from '../../../scripts/producer-interview-snapshot.js';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');

const CONTEXT_HUB = '/home/operator/projects/ContextHub';
const SORRA_AGENTS = '/home/operator/projects/SorraAgents';

function comment(
  id: string,
  createdAt: string,
  body: string,
  author = 'agent',
): ProducerReviewComment {
  return { id, author, comment: body, createdAt };
}

interface RootFixture {
  flagged: ProducerInterviewFlaggedItem[];
  evidence: Record<string, ProducerInterviewItemEvidence>;
}

/** Build an io from fixtures; a missing evidence entry is a hard error. */
function fixtureIo(
  fixtures: Record<string, RootFixture>,
  options: { failRoots?: ReadonlyArray<string> } = {},
): ProducerInterviewSnapshotIo {
  const failed = new Set(options.failRoots ?? []);
  return {
    async listFlagged(root) {
      if (failed.has(root)) throw new Error(`cannot read ${root}`);
      const fixture = fixtures[root];
      if (fixture === undefined) throw new Error(`no fixture for ${root}`);
      return fixture.flagged;
    },
    async readEvidence(root, item) {
      const fixture = fixtures[root];
      const evidence = fixture?.evidence[item.id];
      if (evidence === undefined) {
        throw new Error(`readEvidence reached for unexpected item ${item.id} on ${root}`);
      }
      return evidence;
    },
  };
}

const EMPTY_EVIDENCE: ProducerInterviewItemEvidence = {
  comments: [],
  audit: null,
  blockers: [],
};

describe('collectProducerInterviewSnapshot — the three documented shapes', () => {
  // Shape 1: question-loop with an unanswered question.
  const QUESTION_ITEM: ProducerInterviewFlaggedItem = {
    id: 'WL-0MWQ1',
    title: 'Ruff DTZ007 question',
    stage: 'intake_complete',
    status: 'open',
    needsProducerReview: true,
  };
  // Shape 2: manual fail-closed row, no surviving evidence.
  const MANUAL_ITEM: ProducerInterviewFlaggedItem = {
    id: 'SA-0MVSCS0M80007X23',
    title: 'Plan recorded, no question on record',
    stage: 'intake_complete',
    status: 'open',
    needsProducerReview: true,
  };
  // Not invited: the question was answered, so the flag is stale.
  const ANSWERED_ITEM: ProducerInterviewFlaggedItem = {
    id: 'SA-0MANSWERED',
    title: 'Answered question',
    stage: 'idea',
    status: 'open',
    needsProducerReview: true,
  };
  // Shape 3: cleared after the earlier snapshot instant. The LIVE read never
  // returns it, so it must be absent and its evidence never read.
  const CLEARED_ITEM: ProducerInterviewFlaggedItem = {
    id: 'WL-0MWCLEARED',
    title: 'Cleared after the snapshot',
    stage: 'intake_complete',
    status: 'open',
    needsProducerReview: true,
  };

  const fixtures: Record<string, RootFixture> = {
    [CONTEXT_HUB]: {
      // The live read must not return the cleared row.
      flagged: [QUESTION_ITEM],
      evidence: {
        [QUESTION_ITEM.id]: {
          comments: [
            comment(
              'WL-C1',
              '2026-11-20T12:00:00.000Z',
              'question: Q1 — which option?\n**Recommended:** (a), because it is smaller.',
            ),
          ],
          audit: null,
          blockers: [],
        },
      },
    },
    [SORRA_AGENTS]: {
      flagged: [MANUAL_ITEM, ANSWERED_ITEM],
      evidence: {
        [MANUAL_ITEM.id]: EMPTY_EVIDENCE,
        [ANSWERED_ITEM.id]: {
          comments: [
            comment('SA-C1', '2026-11-19T00:00:00.000Z', 'question: Q1 — which option?'),
            comment(
              'SA-C2',
              '2026-11-20T00:00:00.000Z',
              'Answer: option (a).',
              'producer',
            ),
          ],
          audit: null,
          blockers: [],
        },
      },
    },
  };

  it('interviews only the live needs-producer-input rows, with the exact payload', async () => {
    const snapshot = await collectProducerInterviewSnapshot(
      fixtureIo(fixtures),
      [CONTEXT_HUB, SORRA_AGENTS],
      { now: NOW },
    );

    // Both roots are reported; the manual row sorts before the WL row by id.
    expect(snapshot.interview.map((row) => row.id)).toEqual([
      'SA-0MVSCS0M80007X23',
      'WL-0MWQ1',
    ]);
    expect(snapshot.counts).toEqual({ 'can-clear-now': 1, 'needs-producer-input': 2 });
    expect(snapshot.flaggedTotal).toBe(3);

    const questionRow = snapshot.interview.find((row) => row.id === 'WL-0MWQ1');
    expect(questionRow).toEqual({
      id: 'WL-0MWQ1',
      root: CONTEXT_HUB,
      title: 'Ruff DTZ007 question',
      question: 'question: Q1 — which option?\n**Recommended:** (a), because it is smaller.',
      evidenceCommentId: 'WL-C1',
      flagAge: '5d 0h',
    });

    // The manual row has no surviving evidence: fail-closed question, no
    // deciding comment and an unknown flag age.
    const manualRow = snapshot.interview.find((row) => row.id === 'SA-0MVSCS0M80007X23');
    expect(manualRow).toEqual({
      id: 'SA-0MVSCS0M80007X23',
      root: SORRA_AGENTS,
      title: 'Plan recorded, no question on record',
      question: FALLBACK_INTERVIEW_QUESTION,
      evidenceCommentId: null,
      flagAge: 'unknown',
    });
  });

  it('records the answered row can-clear-now instead of inviting it', async () => {
    const snapshot = await collectProducerInterviewSnapshot(
      fixtureIo(fixtures),
      [CONTEXT_HUB, SORRA_AGENTS],
      { now: NOW },
    );

    const answered = snapshot.classified.find((row) => row.id === 'SA-0MANSWERED');
    expect(answered?.group).toBe('can-clear-now');
    expect(snapshot.interview.map((row) => row.id)).not.toContain('SA-0MANSWERED');
    expect(snapshot.classified).toHaveLength(3);
  });

  it('omits a row cleared after the snapshot instant without reading its evidence', async () => {
    // The live read returns only the still-flagged row: WL-0MWCLEARED is gone.
    // If the snapshot read evidence for it, `readEvidence` would throw.
    const snapshot = await collectProducerInterviewSnapshot(
      fixtureIo(fixtures),
      [CONTEXT_HUB, SORRA_AGENTS],
      { now: NOW },
    );

    const serialised = JSON.stringify(snapshot);
    expect(serialised).not.toContain(CLEARED_ITEM.id);
    expect(snapshot.classified.map((row) => row.id)).not.toContain(CLEARED_ITEM.id);
    expect(snapshot.interview.map((row) => row.id)).not.toContain(CLEARED_ITEM.id);
  });

  it('measures and excludes flagged non-prep items instead of classifying them', async () => {
    const inReview: ProducerInterviewFlaggedItem = {
      id: 'WL-0MREVIEW',
      title: 'Already in review',
      stage: 'in_review',
      status: 'completed',
      needsProducerReview: true,
    };
    const io = fixtureIo({
      [CONTEXT_HUB]: {
        flagged: [QUESTION_ITEM, inReview],
        evidence: fixtures[CONTEXT_HUB].evidence,
      },
    });

    const snapshot = await collectProducerInterviewSnapshot(io, [CONTEXT_HUB], { now: NOW });

    expect(snapshot.flaggedTotal).toBe(1);
    expect(snapshot.skippedNotPrep).toBe(1);
    expect(snapshot.roots[0]).toEqual({
      root: CONTEXT_HUB,
      flagged: 1,
      skippedNotPrep: 1,
      needsProducerInput: 1,
      canClearNow: 0,
    });
    expect(snapshot.classified.map((row) => row.id)).toEqual(['WL-0MWQ1']);
  });

  it('reports a root read failure without hiding the other roots', async () => {
    const snapshot = await collectProducerInterviewSnapshot(
      fixtureIo(fixtures, { failRoots: [SORRA_AGENTS] }),
      [CONTEXT_HUB, SORRA_AGENTS],
      { now: NOW },
    );

    expect(snapshot.errors).toEqual([
      { root: SORRA_AGENTS, error: `cannot read ${SORRA_AGENTS}` },
    ]);
    expect(snapshot.roots.find((root) => root.root === SORRA_AGENTS)?.error).toBe(
      `cannot read ${SORRA_AGENTS}`,
    );
    expect(snapshot.interview.map((row) => row.id)).toEqual(['WL-0MWQ1']);
  });

  it('is deterministic and freezes the evaluation instant', async () => {
    const first = await collectProducerInterviewSnapshot(fixtureIo(fixtures), [CONTEXT_HUB], {
      now: NOW,
    });
    const second = await collectProducerInterviewSnapshot(fixtureIo(fixtures), [CONTEXT_HUB], {
      now: NOW,
    });
    expect(renderProducerInterviewSnapshotJson(first)).toBe(
      renderProducerInterviewSnapshotJson(second),
    );
    expect(first.generatedAt).toBe('2026-11-25T12:00:00.000Z');
  });
});

describe('deriveProducerInterviewHolds — the dispatcher predicates', () => {
  const item: ProducerInterviewFlaggedItem = { id: 'XX-1', stage: 'intake_complete' };

  it('names an outbound depends-on blocker that is not terminal', () => {
    expect(deriveProducerInterviewHolds(item, [{ id: 'XX-2', status: 'open' }], NOW)).toContain(
      'dependency',
    );
    expect(
      deriveProducerInterviewHolds(item, [{ id: 'XX-2', status: 'completed' }], NOW),
    ).not.toContain('dependency');
    // An edge with no status stays unresolved (fail-closed).
    expect(deriveProducerInterviewHolds(item, [{ id: 'XX-2' }], NOW)).toContain('dependency');
  });

  it('names a non-dispatcher assignee and a future startOn only', () => {
    expect(
      deriveProducerInterviewHolds({ ...item, assignee: 'producer' }, [], NOW),
    ).toContain('assignee-hold');
    expect(
      deriveProducerInterviewHolds({ ...item, assignee: 'dispatcher' }, [], NOW),
    ).not.toContain('assignee-hold');
    expect(
      deriveProducerInterviewHolds(
        { ...item, startOn: '2026-11-26T00:00:00.000Z' },
        [],
        NOW,
      ),
    ).toContain('startOn');
    expect(
      deriveProducerInterviewHolds(
        { ...item, startOn: '2026-11-24T00:00:00.000Z' },
        [],
        NOW,
      ),
    ).not.toContain('startOn');
  });

  it('keeps a manual row clearable only when an independent hold proves it', async () => {
    const manual: ProducerInterviewFlaggedItem = {
      id: 'XX-1',
      title: 'manual',
      stage: 'intake_complete',
      needsProducerReview: true,
    };
    const io = fixtureIo({
      [CONTEXT_HUB]: {
        flagged: [manual],
        evidence: {
          'XX-1': { comments: [], audit: null, blockers: [{ id: 'XX-2', status: 'open' }] },
        },
      },
    });
    const snapshot = await collectProducerInterviewSnapshot(io, [CONTEXT_HUB], { now: NOW });
    expect(snapshot.classified[0].group).toBe('can-clear-now');
    expect(snapshot.classified[0].reason).toContain('dependency');
    expect(snapshot.interview).toEqual([]);
  });
});

describe('question text extraction', () => {
  it('drops agent preamble above the first question-bearing line', () => {
    expect(
      extractQuestionText('Auto-dispatched — running /skill:intake XX-1.\nquestion: Q1 — which option?'),
    ).toBe('question: Q1 — which option?');
    // A single-line body is returned whole.
    expect(extractQuestionText('question: which option?')).toBe('question: which option?');
  });

  it('extracts the description OPEN QUESTION appendix up to the next heading', () => {
    const description = [
      '# Brief',
      '',
      '### Q1 (scope) — OPEN QUESTION (needs producer)',
      '- which of (a) or (b)?',
      '',
      '## Key Files',
      '- src/x.ts',
    ].join('\n');
    expect(extractDescriptionQuestion(description)).toContain('which of (a) or (b)?');
    expect(extractDescriptionQuestion(description)).not.toContain('src/x.ts');
    expect(extractDescriptionQuestion('no appendix here')).toBeNull();
  });

  it('falls back to the fail-closed question when no open-question reference survives', () => {
    expect(
      interviewQuestionFor(
        {
          id: 'XX-1',
          title: '',
          source: 'manual',
          evidence: { kind: 'none', reference: 'none', at: null },
          flagAgeMs: null,
          openQuestion: false,
          openQuestionEvidence: null,
          holds: [],
          group: 'needs-producer-input',
          reason: '',
        },
        { id: 'XX-1' },
        [],
      ),
    ).toBe(FALLBACK_INTERVIEW_QUESTION);
  });
});

describe('assertReadOnlyWlArgs — no write path is reachable', () => {
  it('allows exactly the four documented evidence reads', () => {
    expect(() =>
      assertReadOnlyWlArgs(['list', '--json', '--needs-producer-review', 'true', '--include-not-started']),
    ).not.toThrow();
    expect(() => assertReadOnlyWlArgs(['comment', 'list', 'XX-1', '--json'])).not.toThrow();
    expect(() => assertReadOnlyWlArgs(['audit-show', 'XX-1', '--json'])).not.toThrow();
    expect(() => assertReadOnlyWlArgs(['dep', 'list', 'XX-1', '--json'])).not.toThrow();
  });

  it('refuses every flag/assignee mutation and unrelated write', () => {
    const writes = [
      ['update', 'XX-1', '--needs-producer-review', 'false'],
      ['comment', 'add', 'XX-1', '--comment', 'cleared'],
      ['reviewed', 'XX-1'],
      ['audit-set', 'XX-1', '--ready-to-close', 'yes'],
      ['create', '-t', 'x'],
      ['close', 'XX-1'],
      ['delete', 'XX-1'],
      ['sync'],
    ];
    for (const args of writes) {
      expect(() => assertReadOnlyWlArgs(args), args.join(' ')).toThrow(/read-only/);
    }
  });
});

describe('production io — the real argument vector is read-only', () => {
  it('issues only the four evidence reads, never a write', async () => {
    const calls: string[][] = [];
    const exec: CliExecFile = async (_file, args) => {
      calls.push([...args]);
      const [, , command, second] = args;
      if (command === 'list') {
        return {
          stdout: JSON.stringify({
            workItems: [
              {
                id: 'WL-0MWQ1',
                title: 'Ruff DTZ007 question',
                stage: 'intake_complete',
                needsProducerReview: true,
              },
            ],
          }),
        };
      }
      if (command === 'comment' && second === 'list') {
        return {
          stdout: JSON.stringify({
            comments: [
              { id: 'WL-C1', author: 'agent', comment: 'question: which?', createdAt: '2026-11-20T12:00:00.000Z' },
            ],
          }),
        };
      }
      if (command === 'audit-show') return { stdout: JSON.stringify({ audit: null }) };
      if (command === 'dep' && second === 'list') {
        return { stdout: JSON.stringify({ outbound: [] }) };
      }
      throw new Error(`unexpected wl invocation: ${args.join(' ')}`);
    };

    const snapshot = await collectProducerInterviewSnapshot(
      createProducerInterviewSnapshotIo({ exec }),
      [CONTEXT_HUB],
      { now: NOW },
    );

    expect(snapshot.interview.map((row) => row.id)).toEqual(['WL-0MWQ1']);

    const commands = calls.map((args) => args.slice(2).join(' '));
    expect(commands).toEqual([
      'list --json --needs-producer-review true --include-not-started',
      'comment list WL-0MWQ1 --json',
      'audit-show WL-0MWQ1 --json',
      'dep list WL-0MWQ1 --json',
    ]);
    for (const command of commands) {
      expect(command).not.toMatch(/\bupdate\b|\breviewed\b|\bcomment add\b|\baudit-set\b|\bcreate\b/);
      // Every invocation is scoped to its own root.
      for (const args of calls) expect(args[0]).toBe('--worklog-dir');
    }
  });
});

describe('parsers', () => {
  it('parses the flagged list, mapping only the fields the rule reads', () => {
    const parsed = parseFlaggedListOutput(
      JSON.stringify({
        workItems: [
          {
            id: 'XX-1',
            title: 'T',
            stage: 'idea',
            status: 'open',
            description: 'D',
            assignee: 'a',
            startOn: '2026-01-01T00:00:00.000Z',
            needsProducerReview: true,
            ignored: 'x',
          },
          { title: 'no id' },
        ],
      }),
    );
    expect(parsed).toEqual([
      {
        id: 'XX-1',
        title: 'T',
        stage: 'idea',
        status: 'open',
        description: 'D',
        assignee: 'a',
        startOn: '2026-01-01T00:00:00.000Z',
        needsProducerReview: true,
      },
    ]);
    expect(parseFlaggedListOutput(JSON.stringify({ workItems: [] }))).toEqual([]);
    expect(parseFlaggedListOutput('not json')).toBeNull();
    expect(parseFlaggedListOutput(JSON.stringify({}))).toBeNull();
  });

  it('parses comments and rejects a malformed payload', () => {
    const parsed = parseCommentListOutput(
      JSON.stringify({
        comments: [{ id: 'C1', author: 'a', comment: 'body', createdAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    expect(parsed).toEqual([
      { id: 'C1', author: 'a', comment: 'body', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(parseCommentListOutput(JSON.stringify({ comments: [] }))).toEqual([]);
    expect(parseCommentListOutput('nope')).toBeNull();
    expect(parseCommentListOutput(JSON.stringify({}))).toBeNull();
  });

  it('distinguishes "no stored audit" from an unparseable audit payload', () => {
    expect(parseAuditShowOutput(JSON.stringify({ audit: null }))).toEqual({ audit: null });
    expect(
      parseAuditShowOutput(
        JSON.stringify({
          audit: { readyToClose: false, auditedAt: '2026-11-20T00:00:00.000Z' },
        }),
      ),
    ).toEqual({ audit: { readyToClose: false, auditedAt: '2026-11-20T00:00:00.000Z' } });
    expect(parseAuditShowOutput('broken')).toBeNull();
    expect(parseAuditShowOutput(JSON.stringify({}))).toBeNull();
  });

  it('parses outbound depends-on blockers and ignores inbound dependents', () => {
    const parsed = parseBlockerListOutput(
      JSON.stringify({
        outbound: [
          { id: 'XX-2', status: 'open', direction: 'depends-on' },
          { id: 'XX-3', status: 'completed', direction: 'depends-on' },
        ],
        inbound: [{ id: 'XX-9', status: 'open', direction: 'depended-on-by' }],
      }),
    );
    expect(parsed).toEqual([
      { id: 'XX-2', status: 'open' },
      { id: 'XX-3', status: 'completed' },
    ]);
    expect(parseBlockerListOutput('broken')).toBeNull();
  });
});

describe('rendering', () => {
  async function sampleSnapshot() {
    return collectProducerInterviewSnapshot(
      fixtureIo({
        [CONTEXT_HUB]: {
          flagged: [
            {
              id: 'WL-0MWQ1',
              title: 'Ruff DTZ007 question',
              stage: 'intake_complete',
              needsProducerReview: true,
            },
          ],
          evidence: {
            'WL-0MWQ1': {
              comments: [
                comment('WL-C1', '2026-11-20T12:00:00.000Z', 'question: which | option?'),
              ],
              audit: null,
              blockers: [],
            },
          },
        },
      }),
      [CONTEXT_HUB],
      { now: NOW },
    );
  }

  it('renders JSON as the full machine snapshot', async () => {
    const snapshot = await sampleSnapshot();
    const parsed = JSON.parse(renderProducerInterviewSnapshotJson(snapshot));
    expect(parsed.interview).toEqual([
      {
        id: 'WL-0MWQ1',
        root: CONTEXT_HUB,
        title: 'Ruff DTZ007 question',
        question: 'question: which | option?',
        evidenceCommentId: 'WL-C1',
        flagAge: '5d 0h',
      },
    ]);
  });

  it('renders the markdown table with the interview fields and escaped cells', async () => {
    const markdown = renderProducerInterviewSnapshotMarkdown(await sampleSnapshot());
    expect(markdown).toContain('| root | id | title | evidence comment | flag age | question |');
    expect(markdown).toContain('| WL-0MWQ1 |');
    expect(markdown).toContain('5d 0h');
    expect(markdown).toContain('question: which \\| option?');
    expect(markdown).toContain('### Per-root counts');
  });

  it('renders an explicit empty interview instead of a silently blank table', async () => {
    const snapshot = await collectProducerInterviewSnapshot(fixtureIo({}), [], { now: NOW });
    const markdown = renderProducerInterviewSnapshotMarkdown(snapshot);
    expect(markdown).toContain('| _(none)_ |');
    expect(snapshot.interview).toEqual([]);
  });
});

describe('CLI', () => {
  it('parses roots, --now and the output modes', () => {
    const parsed = parseProducerInterviewArgs([
      '--root',
      CONTEXT_HUB,
      `--root=${SORRA_AGENTS}`,
      '--root',
      CONTEXT_HUB,
      '--now',
      '2026-11-25T12:00:00Z',
      '--json',
    ]);
    expect(parsed).toEqual({
      args: {
        roots: [CONTEXT_HUB, SORRA_AGENTS],
        nowIso: '2026-11-25T12:00:00Z',
        json: true,
        markdown: false,
        help: false,
      },
    });
  });

  it('rejects --json together with --markdown and unknown arguments', () => {
    expect(parseProducerInterviewArgs(['--json', '--markdown'])).toEqual({
      error: '--json and --markdown are mutually exclusive',
    });
    expect(parseProducerInterviewArgs(['--bogus'])).toEqual({ error: 'unknown argument: --bogus' });
  });

  it('routes JSON to stdout and the markdown to stderr by default', async () => {
    const snapshot = await collectProducerInterviewSnapshot(fixtureIo({}), [], { now: NOW });
    const output = renderProducerInterviewOutput(snapshot, { json: false, markdown: false });
    expect(output.stdout.startsWith('{')).toBe(true);
    expect(output.stderr.startsWith('## Producer interview snapshot')).toBe(true);

    const markdownOnly = renderProducerInterviewOutput(snapshot, { json: false, markdown: true });
    expect(markdownOnly.stdout.startsWith('## Producer interview snapshot')).toBe(true);
    expect(markdownOnly.stderr).toBe('');

    const jsonOnly = renderProducerInterviewOutput(snapshot, { json: true, markdown: false });
    expect(jsonOnly.stderr).toBe('');
  });
});
