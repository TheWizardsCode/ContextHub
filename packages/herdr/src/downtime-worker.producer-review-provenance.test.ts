/**
 * packages/herdr/src/downtime-worker.producer-review-provenance.test.ts — the
 * fixture-driven pin for the producer-review provenance rule
 * (WL-0MWTBJAV7002ZZQI, child 4 of WL-0MWTAD1KM0081UUD).
 *
 * The `needsProducerReview` flag is the dispatcher's only persistent hold, and
 * nothing records where it came from. This suite pins the RULE — which evidence
 * field wins, how the flag age is measured, when a row may be called
 * "can clear now" and when it must fail closed — before any audit table is
 * produced from it, so the recorded provenance cannot be re-worded to fit.
 *
 * Every fixture is inline JSON: no live worklog, no `wl` subprocess, no
 * filesystem state, no sleeps. The canonical rule text lives in
 * `docs/dev/downtime-dispatcher.md` → *Producer-review provenance*; that table
 * is asserted here, so a rename in only one place fails the suite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PRODUCER_REVIEW_GROUPS,
  PRODUCER_REVIEW_SOURCES,
  assembleProducerReviewProvenance,
  classifyProducerReviewProvenance,
  formatProducerReviewAge,
  isProducerReviewAnswer,
  isProducerReviewQuestion,
  type ProducerReviewComment,
  type ProducerReviewProvenanceInput,
} from './downtime-worker.producer-review-provenance.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Frozen evaluation instant for every fixture. */
const NOW = Date.parse('2026-11-23T12:00:00.000Z');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function comment(
  id: string,
  createdAt: string,
  body: string,
  author = 'agent',
): ProducerReviewComment {
  return { id, author, comment: body, createdAt };
}

/** Build a provenance input with only the fields the case exercises. */
function input(overrides: Partial<ProducerReviewProvenanceInput> = {}): ProducerReviewProvenanceInput {
  return {
    now: NOW,
    item: { id: 'XX-1', stage: 'intake_complete', status: 'open' },
    comments: [],
    ...overrides,
  };
}

describe('isProducerReviewQuestion / isProducerReviewAnswer', () => {
  it('recognises every documented question marker', () => {
    const markers = [
      'question: which option?',
      'OPEN QUESTIONS for producer review: 1. ...',
      'Questions for producer: 1. was it deleted?',
      'Producer decision required — DTZ007',
      'awaiting producer approval',
      'this ruling remains open for the producer',
      'Producer review required — please confirm or reject option (c).',
      '**OPEN QUESTION** — no answer yet',
    ];
    for (const body of markers) expect(isProducerReviewQuestion(body), body).toBe(true);
  });

  it('does not treat ordinary lifecycle comments as questions', () => {
    const notQuestions = [
      'Auto-dispatched by the herdr downtime worker at 2026-11-14T21:19:35.675Z — running /skill:intake XX-1.',
      'Implementation aborted.',
      'Intake auto-complete: work item already sufficiently defined.',
      'released because no matching pane; previous assignee: (none)',
      'Effort and Risk Report',
    ];
    for (const body of notQuestions) expect(isProducerReviewQuestion(body), body).toBe(false);
  });

  it('recognises an recorded answer, and not a decision that still asks for review', () => {
    expect(isProducerReviewAnswer('Answer: option (c).')).toBe(true);
    expect(isProducerReviewAnswer('**Answer (producer):** (a)')).toBe(true);
    expect(isProducerReviewAnswer('producer answer: (b)')).toBe(true);
    // An agent recording its own recommendation is NOT an answer.
    expect(isProducerReviewAnswer('**Intake decision recorded.** Recommendation: Option (c)')).toBe(
      false,
    );
  });
});

describe('classifyProducerReviewProvenance — sources', () => {
  it('keys on the stored audit record: an explicit readyToClose=false is an audit reject', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        audit: { readyToClose: false, generatedAt: '2026-11-20T10:00:00.000Z' },
      }),
    );
    expect(verdict.source).toBe('audit-reject');
    expect(verdict.evidence.kind).toBe('audit');
    expect(verdict.evidence.at).toBe('2026-11-20T10:00:00.000Z');
    expect(verdict.evidence.reference).toContain('2026-11-20T10:00:00.000Z');
    expect(verdict.flagAgeMs).toBe(3 * DAY + 2 * HOUR);
    expect(verdict.openQuestion).toBe(false);
    expect(verdict.group).toBe('can-clear-now');
  });

  it('falls back to the stored auditedAt when the audit report timestamp is absent', () => {
    const verdict = classifyProducerReviewProvenance(
      input({ audit: { readyToClose: false, generatedAt: null, auditedAt: '2026-11-22T00:00:00.000Z' } }),
    );
    expect(verdict.source).toBe('audit-reject');
    expect(verdict.flagAgeMs).toBe(DAY + 12 * HOUR);
  });

  it('treats a PASSING audit as no flag evidence (a pass never sets the flag)', () => {
    const verdict = classifyProducerReviewProvenance(
      input({ audit: { readyToClose: true, generatedAt: '2026-11-20T10:00:00.000Z' } }),
    );
    expect(verdict.source).toBe('manual');
    expect(verdict.flagAgeMs).toBeNull();
    expect(verdict.group).toBe('needs-producer-input');
  });

  it('keys on the attempt budget: the Nth dispatch marker at the CURRENT stage', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        item: { id: 'XX-1', stage: 'intake_complete' },
        attempts: [
          { kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-11-21T00:00:00.000Z' },
          { kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-11-22T00:00:00.000Z' },
          { kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-11-23T00:00:00.000Z' },
          // Wrong stage, enrichment pass and spawn-failed never count.
          { kind: 'intake', stage: 'idea', dispatchedAt: '2026-11-23T06:00:00.000Z' },
          { kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-11-23T07:00:00.000Z', enrichment: true },
          { kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-11-23T08:00:00.000Z', outcome: 'spawn-failed' },
        ],
      }),
    );
    expect(verdict.source).toBe('attempt-budget-exhaustion');
    expect(verdict.evidence.kind).toBe('dispatch-marker');
    // Measured from the marker that exhausted the cap, not the newest entry.
    expect(verdict.evidence.at).toBe('2026-11-23T00:00:00.000Z');
    expect(verdict.flagAgeMs).toBe(DAY / 2);
    expect(verdict.group).toBe('can-clear-now');
  });

  it('does not claim the attempt budget below the cap (2 of 3)', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        attempts: [
          { kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-11-21T00:00:00.000Z' },
          { kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-11-22T00:00:00.000Z' },
        ],
      }),
    );
    expect(verdict.source).toBe('manual');
  });

  it('keys on the newest question comment: an unanswered producer question', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        comments: [
          comment('C1', '2026-11-18T00:00:00.000Z', 'Auto-dispatched — running /skill:intake XX-1.'),
          comment('C2', '2026-11-19T00:00:00.000Z', 'question: Q1 — which option? **Recommended:** (a)'),
        ],
      }),
    );
    expect(verdict.source).toBe('question-loop');
    expect(verdict.evidence.kind).toBe('comment');
    expect(verdict.evidence.reference).toBe('comment:C2');
    expect(verdict.flagAgeMs).toBe(4 * DAY + 12 * HOUR);
    expect(verdict.openQuestion).toBe(true);
    expect(verdict.openQuestionEvidence).toBe('comment:C2');
    expect(verdict.group).toBe('needs-producer-input');
  });

  it('records a later answer as closed, so the stale flag can clear', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        comments: [
          comment('C2', '2026-11-19T00:00:00.000Z', 'question: Q1 — which option?'),
          comment('C3', '2026-11-20T00:00:00.000Z', '**Answer (producer):** (a) — do it.', 'Map'),
        ],
      }),
    );
    expect(verdict.source).toBe('question-loop');
    expect(verdict.openQuestion).toBe(false);
    expect(verdict.group).toBe('can-clear-now');
    expect(verdict.reason).toContain('answered');
  });

  it('keys on the description Appendix when no question comment survives', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        item: {
          id: 'XX-1',
          stage: 'intake_complete',
          description: '### Q1 (scope) — OPEN QUESTION (needs producer)\n- **Answer:** _OPEN QUESTION_',
        },
      }),
    );
    expect(verdict.source).toBe('question-loop');
    expect(verdict.evidence.kind).toBe('description');
    expect(verdict.flagAgeMs).toBeNull();
    expect(verdict.openQuestion).toBe(true);
    expect(verdict.group).toBe('needs-producer-input');
    expect(verdict.reason).toContain('age unknown');
  });

  it('does not let a description marker override a recorded answer to the newest question', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        item: {
          id: 'XX-1',
          stage: 'intake_complete',
          description: '### Q1 — OPEN QUESTION (needs producer)',
        },
        comments: [
          comment('C2', '2026-11-19T00:00:00.000Z', 'question: Q1 — which option?'),
          comment('C3', '2026-11-20T00:00:00.000Z', 'Answer: option (a).'),
        ],
      }),
    );
    expect(verdict.openQuestion).toBe(false);
    expect(verdict.group).toBe('can-clear-now');
  });

  it('keys on a ship escalation comment', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        comments: [
          comment(
            'C9',
            '2026-11-08T00:00:00.000Z',
            'Producer-review flag escalated to the nearest in_review ancestor; needsProducerReview=true for child XX-2.',
            'ship',
          ),
        ],
      }),
    );
    expect(verdict.source).toBe('ship-escalation');
    expect(verdict.flagAgeMs).toBe(15 * DAY + 12 * HOUR);
    expect(verdict.group).toBe('can-clear-now');
  });
});

describe('classifyProducerReviewProvenance — precedence and fail-closed behaviour', () => {
  it('takes the NEWEST evidence, not a fixed source order', () => {
    const audit = { readyToClose: false, generatedAt: '2026-11-10T00:00:00.000Z' };
    const question = comment('C2', '2026-11-20T00:00:00.000Z', 'question: Q1 — which option?');

    const questionNewer = classifyProducerReviewProvenance(
      input({ audit, comments: [question] }),
    );
    expect(questionNewer.source).toBe('question-loop');

    const auditNewer = classifyProducerReviewProvenance(
      input({
        audit: { readyToClose: false, generatedAt: '2026-11-21T00:00:00.000Z' },
        comments: [question],
      }),
    );
    expect(auditNewer.source).toBe('audit-reject');
  });

  it('breaks a timestamp tie with the authority order (audit > attempt > question > escalation)', () => {
    const at = '2026-11-20T00:00:00.000Z';
    const verdict = classifyProducerReviewProvenance(
      input({
        audit: { readyToClose: false, generatedAt: at },
        comments: [comment('C2', at, 'question: Q1 — which option?')],
      }),
    );
    expect(verdict.source).toBe('audit-reject');
    expect(verdict.openQuestion).toBe(true);
    expect(verdict.group).toBe('needs-producer-input');
  });

  it('fails closed with no evidence at all: manual, unknown age, needs producer input', () => {
    const verdict = classifyProducerReviewProvenance(input());
    expect(verdict.source).toBe('manual');
    expect(verdict.evidence.kind).toBe('none');
    expect(verdict.evidence.at).toBeNull();
    expect(verdict.flagAgeMs).toBeNull();
    expect(verdict.group).toBe('needs-producer-input');
    expect(verdict.reason).toContain('not provably safe');
  });

  it('allows clearing an evidence-less flag ONLY when an independent hold proves no dispatch can follow', () => {
    const verdict = classifyProducerReviewProvenance(
      input({ holds: ['dependency'] }),
    );
    expect(verdict.source).toBe('manual');
    expect(verdict.flagAgeMs).toBeNull();
    expect(verdict.holds).toEqual(['dependency']);
    expect(verdict.group).toBe('can-clear-now');
    expect(verdict.reason).toContain('dependency');
  });

  it('still requires producer input for an open question even when the item is independently held', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        holds: ['dependency', 'startOn'],
        comments: [comment('C2', '2026-11-19T00:00:00.000Z', 'question: Q1 — which option?')],
      }),
    );
    expect(verdict.group).toBe('needs-producer-input');
  });

  it('fails closed when a flag-causing evidence timestamp is missing', () => {
    const verdict = classifyProducerReviewProvenance(
      input({ audit: { readyToClose: false, generatedAt: null, auditedAt: null } }),
    );
    expect(verdict.source).toBe('ambiguous');
    expect(verdict.flagAgeMs).toBeNull();
    expect(verdict.group).toBe('needs-producer-input');
  });

  it('fails closed when the evidence lies after the evaluation instant (not visible in a replay)', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        now: Date.parse('2026-11-01T00:00:00.000Z'),
        audit: { readyToClose: false, generatedAt: '2026-11-20T00:00:00.000Z' },
      }),
    );
    expect(verdict.source).toBe('ambiguous');
    expect(verdict.group).toBe('needs-producer-input');
  });

  it('recognises an explicit manual flag comment and measures its age from it', () => {
    const verdict = classifyProducerReviewProvenance(
      input({
        comments: [
          comment('C7', '2026-11-12T00:00:00.000Z', 'Flagged via wl reviewed XX-1 true after triage.', 'Map'),
        ],
      }),
    );
    expect(verdict.source).toBe('manual');
    expect(verdict.evidence.reference).toBe('comment:C7');
    expect(verdict.flagAgeMs).toBe(11 * DAY + 12 * HOUR);
    expect(verdict.group).toBe('can-clear-now');
  });

  it('never mutates its input (read-only rule)', () => {
    const fixture = input({
      comments: [comment('C2', '2026-11-19T00:00:00.000Z', 'question: Q1?')],
      attempts: [{ kind: 'plan', stage: 'intake_complete', dispatchedAt: '2026-11-20T00:00:00.000Z' }],
      holds: ['assignee'],
      audit: { readyToClose: true, generatedAt: '2026-11-18T00:00:00.000Z' },
    });
    const before = JSON.stringify(fixture);
    classifyProducerReviewProvenance(fixture);
    expect(JSON.stringify(fixture)).toBe(before);
  });
});

describe('assembleProducerReviewProvenance', () => {
  it('sorts rows by id stable-lexicographically and counts both groups', () => {
    const rows = [
      classifyProducerReviewProvenance(
        input({ item: { id: 'XX-2' }, comments: [comment('C', '2026-11-19T00:00:00.000Z', 'question: Q?')] }),
      ),
      classifyProducerReviewProvenance(
        input({ item: { id: 'XX-10' }, audit: { readyToClose: false, generatedAt: '2026-11-20T00:00:00.000Z' } }),
      ),
      classifyProducerReviewProvenance(input({ item: { id: 'XX-1' } })),
    ];
    const assembled = assembleProducerReviewProvenance(rows);
    expect(assembled.rows.map((row) => row.id)).toEqual(['XX-1', 'XX-10', 'XX-2']);
    expect(assembled.groups['can-clear-now']).toEqual(['XX-10']);
    expect(assembled.groups['needs-producer-input']).toEqual(['XX-1', 'XX-2']);
    expect(assembled.counts).toEqual({ 'can-clear-now': 1, 'needs-producer-input': 2 });
    expect(assembled.total).toBe(3);
  });

  it('has exactly two documented groups', () => {
    expect([...PRODUCER_REVIEW_GROUPS]).toEqual(['can-clear-now', 'needs-producer-input']);
  });
});

describe('formatProducerReviewAge', () => {
  it('renders a measurable age in days/hours and an unmeasurable one as unknown', () => {
    expect(formatProducerReviewAge(null)).toBe('unknown');
    expect(formatProducerReviewAge(3 * DAY)).toBe('3d 0h');
    expect(formatProducerReviewAge(DAY + 5 * 60 * 60 * 1000)).toBe('1d 5h');
    expect(formatProducerReviewAge(90 * 60 * 1000)).toBe('0d 1h');
  });
});

describe('the rule table is one source of truth in two places', () => {
  it('matches the documented provenance table in docs/dev/downtime-dispatcher.md', () => {
    const doc = fs.readFileSync(
      path.join(REPO_ROOT, 'docs/dev/downtime-dispatcher.md'),
      'utf-8',
    );
    const heading = '### Producer-review provenance';
    const start = doc.indexOf(heading);
    expect(start, `docs/dev/downtime-dispatcher.md has no "${heading}" section`).toBeGreaterThan(-1);
    const rest = doc.slice(start + heading.length);
    const end = rest.indexOf('\n### ');
    const section = end === -1 ? rest : rest.slice(0, end);

    expect(section).toContain('PRODUCER_REVIEW_SOURCES');
    expect(section).toContain('downtime-worker.producer-review-provenance.test.ts');

    // The numbered evidence rows, in document order.
    const rows = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\|\s*\d+\s*\|/.test(line));
    expect(rows.length, 'the documented provenance table has no numbered rows').toBe(
      PRODUCER_REVIEW_SOURCES.length,
    );
    const documented = rows.map((row) => row.split('|')[2].trim().replace(/`/g, ''));
    expect(documented).toEqual([...PRODUCER_REVIEW_SOURCES]);

    // Every row names its evidence field and its fail-closed behaviour.
    for (const row of rows) {
      const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
      expect(cells.length, `row is not a 4-column table row: ${row}`).toBe(4);
      expect(cells[1].length).toBeGreaterThan(0);
      expect(cells[2].length).toBeGreaterThan(0);
      expect(cells[3].length).toBeGreaterThan(0);
    }
  });
});
