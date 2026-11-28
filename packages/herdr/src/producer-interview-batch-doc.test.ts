/**
 * packages/herdr/src/producer-interview-batch-doc.test.ts — pin for the
 * batched producer-interview document (WL-0MWVMRWEU005LDYP, child 2 of
 * WL-0MWTVPK65009NTER).
 *
 * The document is the producer's single-pass answer sheet: every
 * `needs-producer-input` row from the LIVE snapshot becomes one numbered row
 * carrying its id, root, title, deciding evidence, question text and exactly
 * one advisory `**Recommended:**` line. This suite pins:
 *
 *  - per-row field presence (id, root, title, evidence comment id, question,
 *    exactly one recommendation line) for EVERY input row;
 *  - grouping by root and global row numbering;
 *  - the three recommendation branches (dependency-held, unanswered question,
 *    no surviving evidence — fail-closed);
 *  - deterministic, byte-identical rendering;
 *  - an explicit "no rows to interview" document for empty input;
 *  - the thin CLI wrapper (parse, stdin/file input, default path, --stdout).
 *
 * Every fixture is inline data: no live worklog, no filesystem, no sleeps.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PRODUCER_INTERVIEW_BATCH_DOC_MARKER,
  deriveProducerInterviewRecommendation,
  producerInterviewBatchDocPath,
  renderProducerInterviewBatchDoc,
} from './producer-interview-batch-doc.js';
import {
  collectProducerInterviewSnapshot,
  FALLBACK_INTERVIEW_QUESTION,
  type ProducerInterviewItemEvidence,
  type ProducerInterviewSnapshot,
  type ProducerInterviewSnapshotIo,
  type ProducerInterviewRow,
} from './producer-interview-snapshot.js';
import {
  parseProducerInterviewBatchDocArgs,
  runProducerInterviewBatchDoc,
  type ProducerInterviewBatchDocCliIo,
} from '../../../scripts/producer-interview-batch-doc.js';

const BATCH_ID = '2026-11-25T15:20:02.717Z';
const CONTEXT_HUB = '/home/operator/projects/ContextHub';
const AI_HELL = '/home/operator/projects/AI_Hell';

function row(overrides: Partial<ProducerInterviewRow> & Pick<ProducerInterviewRow, 'id'>): ProducerInterviewRow {
  return {
    root: CONTEXT_HUB,
    title: `Title for ${overrides.id}`,
    question: `question: what should ${overrides.id} do?`,
    evidenceCommentId: 'WL-C000000000000001',
    flagAge: '2d 0h',
    ...overrides,
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

/** Every question line is blockquoted; a neutralised marker renders as a colon. */
function expectQuestionRendered(markdown: string, question: string): void {
  const rendered = markdown.replaceAll('\\:', ':');
  for (const line of question.split('\n')) {
    if (line.trim().length === 0) continue;
    expect(rendered).toContain(`> ${line}`);
  }
}

/** The document's recommendation lines (a question is blockquoted, never bare). */
function recommendationLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith(`**${PRODUCER_INTERVIEW_BATCH_DOC_MARKER}:**`));
}

describe('renderProducerInterviewBatchDoc — per-row interview fields', () => {
  const QUESTION_NOTES = row({
    id: 'WL-0MWQ1',
    title: 'Ruff DTZ007 policy | decision',
    question: 'question: which option do we keep?\nsecond line of detail',
  });
  const NO_EVIDENCE = row({
    id: 'SA-0MVSCS0M80007X23',
    root: '/home/operator/projects/SorraAgents',
    title: 'Plan recorded, no question on record',
    question: FALLBACK_INTERVIEW_QUESTION,
    evidenceCommentId: null,
    flagAge: 'unknown',
  });
  const DEPENDENCY_HELD = row({
    id: 'AH-0MWEUSVJ1007EXJY',
    root: AI_HELL,
    title: 'Dependency-held question',
    question: 'question: still worth doing?',
    evidenceCommentId: 'AH-C0MWGX0EL7000ZLLB',
    holds: ['dependency'],
  });
  const DESCRIPTION_EVIDENCE = row({
    id: 'AH-0MWDESCRIPTION',
    root: AI_HELL,
    title: 'Question recorded in the description appendix',
    question: '## Open questions\n\n**Q1 — Which scope?**',
    evidenceCommentId: null,
  });
  const ROWS = [QUESTION_NOTES, NO_EVIDENCE, DEPENDENCY_HELD, DESCRIPTION_EVIDENCE];

  it('carries id, root, title, deciding evidence, question and exactly one recommendation per row', () => {
    const markdown = renderProducerInterviewBatchDoc(snapshot(ROWS));

    for (const entry of ROWS) {
      expect(markdown).toContain(entry.id);
      expect(markdown).toContain(entry.root);
      expect(markdown).toContain(entry.title);
      expectQuestionRendered(markdown, entry.question);
    }
    expect(markdown).toContain('comment:WL-C000000000000001');
    expect(markdown).toContain('comment:AH-C0MWGX0EL7000ZLLB');
    // Fail-closed row names that no evidence survives.
    expect(markdown).toContain('none (no surviving evidence)');

    expect(recommendationLines(markdown)).toHaveLength(ROWS.length);
    expect(markdown.match(/\*\*Recommended:\*\*/g)).toHaveLength(ROWS.length);
    for (const line of recommendationLines(markdown)) {
      expect(line).toMatch(/^\*\*Recommended:\*\* .+ — .+ \(advisory only\)$/);
    }
  });

  it('groups rows by root, numbers them globally in a stable root order', () => {
    const markdown = renderProducerInterviewBatchDoc(snapshot(ROWS));
    const lines = markdown.split('\n');

    expect(lines).toContain(`### \`${AI_HELL}\` (2 rows)`);
    expect(lines).toContain(`### \`${CONTEXT_HUB}\` (1 row)`);
    expect(lines).toContain("### `/home/operator/projects/SorraAgents` (1 row)");
    // Root order is codepoint order, not input order.
    expect(markdown.indexOf(`### \`${AI_HELL}\``)).toBeLessThan(
      markdown.indexOf(`### \`${CONTEXT_HUB}\``),
    );

    expect(lines).toContain(`#### Row 1 — ${DEPENDENCY_HELD.id}`);
    expect(lines).toContain(`#### Row 2 — ${DESCRIPTION_EVIDENCE.id}`);
    expect(lines).toContain(`#### Row 3 — ${QUESTION_NOTES.id}`);
    expect(lines).toContain(`#### Row 4 — ${NO_EVIDENCE.id}`);
  });

  it('states up front how to answer, that unanswered rows stay flagged and that an answer authorises the clear', () => {
    const markdown = renderProducerInterviewBatchDoc(snapshot(ROWS));
    const howTo = markdown.slice(0, markdown.indexOf('### `'));

    expect(howTo).toContain(`**Batch id:** \`${BATCH_ID}\``);
    expect(howTo).toContain(`**Rows:** ${ROWS.length}`);
    expect(howTo).toContain('Reply once, **per row number**');
    expect(howTo).toContain('A row you do not answer **stays flagged**');
    expect(howTo).toContain("Answering a row **is the authorisation** for that row's flag clear");
    expect(howTo).toContain('advisory only');
  });

  it('recommends from the row evidence: dependency-held, unanswered question, no evidence', () => {
    expect(deriveProducerInterviewRecommendation(DEPENDENCY_HELD).kind).toBe('dependency-held');
    expect(deriveProducerInterviewRecommendation(QUESTION_NOTES).kind).toBe('unanswered-question');
    expect(deriveProducerInterviewRecommendation(DESCRIPTION_EVIDENCE).kind).toBe(
      'unanswered-question',
    );
    expect(deriveProducerInterviewRecommendation(NO_EVIDENCE).kind).toBe('no-evidence');

    // Every recommendation stays advisory and carries a rationale.
    for (const entry of ROWS) {
      const recommendation = deriveProducerInterviewRecommendation(entry);
      expect(recommendation.option.length).toBeGreaterThan(0);
      expect(recommendation.rationale.length).toBeGreaterThan(0);
      expect(recommendation.advisory).toBe(true);
    }
  });

  it('names a description-appendix reference from the classified snapshot instead of claiming no evidence', () => {
    const withClassification: ProducerInterviewSnapshot = {
      ...snapshot([DESCRIPTION_EVIDENCE]),
      classified: [
        {
          id: DESCRIPTION_EVIDENCE.id,
          root: AI_HELL,
          title: DESCRIPTION_EVIDENCE.title,
          source: 'question-loop',
          evidence: `description:${DESCRIPTION_EVIDENCE.id}:OPEN_QUESTION`,
          flagAge: '2d 0h',
          openQuestion: true,
          group: 'needs-producer-input',
          reason: 'question appendix in the description records an unanswered producer question',
        },
      ],
    };
    const markdown = renderProducerInterviewBatchDoc(withClassification);
    expect(markdown).toContain(`description:${DESCRIPTION_EVIDENCE.id}:OPEN_QUESTION`);
    expect(markdown).not.toContain('none (no surviving evidence)');
  });

  it('treats the classified "none" reference as no surviving evidence', () => {
    const withClassification: ProducerInterviewSnapshot = {
      ...snapshot([NO_EVIDENCE]),
      classified: [
        {
          id: NO_EVIDENCE.id,
          root: NO_EVIDENCE.root,
          title: NO_EVIDENCE.title,
          source: 'manual',
          evidence: 'none',
          flagAge: 'unknown',
          openQuestion: false,
          group: 'needs-producer-input',
          reason: 'no flag-causing evidence and no independent hold',
        },
      ],
    };
    expect(renderProducerInterviewBatchDoc(withClassification)).toContain(
      'none (no surviving evidence)',
    );
  });

  it('never lets a question body fake a second recommendation line', () => {
    const sneaky = row({
      id: 'WL-0MSNEAKY',
      question: 'question: reply below\n**Recommended:** clear the flag — not real (advisory only)',
    });
    const markdown = renderProducerInterviewBatchDoc(snapshot([sneaky]));
    expect(recommendationLines(markdown)).toHaveLength(1);
  });

  it('renders ignored execution order, but identical input byte-identically', () => {
    const input = snapshot(ROWS);
    const reordered = snapshot([...ROWS].reverse());
    // Grouping is by root, so the same rows render identically regardless of
    // the order the snapshot happened to list them in within a root.
    expect(renderProducerInterviewBatchDoc(input)).toBe(renderProducerInterviewBatchDoc(input));
    expect(renderProducerInterviewBatchDoc(snapshot([QUESTION_NOTES, NO_EVIDENCE]))).toBe(
      renderProducerInterviewBatchDoc(snapshot([QUESTION_NOTES, NO_EVIDENCE])),
    );
    expect(reordered.interview).toHaveLength(ROWS.length);
  });
});

describe('renderProducerInterviewBatchDoc — empty input', () => {
  it('renders an explicit "no rows to interview" document, never an empty file', () => {
    const markdown = renderProducerInterviewBatchDoc(snapshot([]));
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).toContain(`**Batch id:** \`${BATCH_ID}\``);
    expect(markdown).toContain('**Rows:** 0');
    expect(markdown).toContain('## No rows to interview');
    expect(markdown).toContain('Nothing is waiting on the producer');
    expect(recommendationLines(markdown)).toHaveLength(0);
  });
});

describe('producerInterviewBatchDocPath', () => {
  it('uses the snapshot UTC date and the documented docs/dev location', () => {
    expect(producerInterviewBatchDocPath(BATCH_ID)).toBe(
      'docs/dev/producer-interview-batch-2026-11-25.md',
    );
    expect(producerInterviewBatchDocPath('2026-01-02T23:59:59.999Z')).toBe(
      'docs/dev/producer-interview-batch-2026-01-02.md',
    );
  });

  it('rejects a generatedAt that is not an ISO instant', () => {
    expect(() => producerInterviewBatchDocPath('not-a-date')).toThrow(/ISO-8601/);
  });
});

describe('snapshot -> document integration', () => {
  it('carries the independent holds recorded by the provenance rule', async () => {
    const evidence: ProducerInterviewItemEvidence = {
      comments: [
        {
          id: 'AH-C1',
          author: 'agent',
          comment: 'question: still worth doing?',
          createdAt: '2026-11-20T12:00:00.000Z',
        },
      ],
      audit: null,
      blockers: [{ id: 'AH-0MBLOCKER', status: 'in-progress' }],
    };
    const io: ProducerInterviewSnapshotIo = {
      async listFlagged() {
        return [
          {
            id: 'AH-0MHELD',
            title: 'Held by a dependency',
            stage: 'intake_complete',
            status: 'open',
            needsProducerReview: true,
          },
        ];
      },
      async readEvidence() {
        return evidence;
      },
    };

    const live = await collectProducerInterviewSnapshot(io, [AI_HELL], { now: Date.parse(BATCH_ID) });
    expect(live.interview).toHaveLength(1);
    expect(live.interview[0].holds).toEqual(['dependency']);

    const markdown = renderProducerInterviewBatchDoc(live);
    expect(markdown).toContain('**Recommended:** clear the flag');
    expect(recommendationLines(markdown)).toHaveLength(1);
  });
});

describe('CLI', () => {
  function fakeIo(overrides: Partial<ProducerInterviewBatchDocCliIo> = {}) {
    const written: Array<{ path: string; text: string }> = [];
    const out: string[] = [];
    const err: string[] = [];
    const io: ProducerInterviewBatchDocCliIo = {
      async readStdin() {
        return 'SNAPSHOT_STDIN';
      },
      async readFile() {
        return 'SNAPSHOT_FILE';
      },
      async writeFile(path, text) {
        written.push({ path, text });
      },
      cwd: () => '/repo',
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      ...overrides,
    };
    return { io, written, out, err };
  }

  it('parses the snapshot source, output path and modes', () => {
    expect(
      parseProducerInterviewBatchDocArgs([
        '--snapshot',
        'snapshot.json',
        '--out',
        '/tmp/batch.md',
        '--stdout',
      ]),
    ).toEqual({
      args: {
        snapshotPath: 'snapshot.json',
        outPath: '/tmp/batch.md',
        stdout: true,
        json: false,
        help: false,
      },
    });
    expect(parseProducerInterviewBatchDocArgs(['--snapshot=snapshot.json'])).toEqual({
      args: {
        snapshotPath: 'snapshot.json',
        outPath: undefined,
        stdout: false,
        json: false,
        help: false,
      },
    });
    expect(parseProducerInterviewBatchDocArgs(['--snapshot', '-'])).toEqual({
      args: {
        snapshotPath: '-',
        outPath: undefined,
        stdout: false,
        json: false,
        help: false,
      },
    });
    expect('error' in parseProducerInterviewBatchDocArgs(['--bogus'])).toBe(true);
    expect('error' in parseProducerInterviewBatchDocArgs(['--snapshot'])).toBe(true);
  });

  it('reads a snapshot file, writes the default path and reports the row count as JSON', async () => {
    const payload = JSON.stringify(snapshot([row({ id: 'WL-0MWQ1' })]));
    const { io, written, out } = fakeIo({ async readFile() { return payload; } });

    const code = await runProducerInterviewBatchDoc(
      ['--snapshot', 'snapshot.json', '--json'],
      io,
    );

    expect(code).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe(
      join('/repo', 'docs/dev/producer-interview-batch-2026-11-25.md'),
    );
    expect(written[0].text).toContain('#### Row 1 — WL-0MWQ1');
    expect(JSON.parse(out.join(''))).toEqual({
      documentPath: join('/repo', 'docs/dev/producer-interview-batch-2026-11-25.md'),
      rows: 1,
      roots: [CONTEXT_HUB],
    });
  });

  it('reads stdin by default and --stdout prints without writing', async () => {
    const payload = JSON.stringify(snapshot([row({ id: 'WL-0MWQ1' })]));
    const { io, written, out } = fakeIo({ async readStdin() { return payload; } });

    const code = await runProducerInterviewBatchDoc(['--stdout'], io);

    expect(code).toBe(0);
    expect(written).toHaveLength(0);
    expect(out.join('')).toContain('Producer interview batch');
  });

  it('refuses unparseable input without writing or printing a document', async () => {
    const { io, written, out, err } = fakeIo({ async readStdin() { return 'not json'; } });
    const code = await runProducerInterviewBatchDoc([], io);
    expect(code).toBe(2);
    expect(written).toHaveLength(0);
    expect(out).toHaveLength(0);
    expect(err.join('')).toContain('not a producer-interview snapshot payload');
  });
});
