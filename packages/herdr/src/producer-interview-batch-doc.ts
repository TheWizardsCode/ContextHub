/**
 * packages/herdr/src/producer-interview-batch-doc.ts — the pure renderer for
 * the batched producer-interview document (WL-0MWVMRWEU005LDYP, child 2 of
 * WL-0MWTVPK65009NTER).
 *
 * ## Why this module exists
 *
 * The producer answers one batched interview instead of one item at a time, so
 * the document must be a single self-contained answer sheet: every
 * `needs-producer-input` row from the live snapshot
 * (`producer-interview-snapshot.ts`) grouped by root, numbered, and carrying
 * the row's id, root, title, deciding evidence comment id, question text and
 * exactly one advisory `**Recommended:**` line.
 *
 * ## Pure by construction
 *
 * The renderer takes the snapshot payload and returns a markdown string. It
 * performs no I/O, reads no clock and sorts no locale-dependent collation, so
 * identical input yields byte-identical output. Root groups are ordered by
 * codepoint; within a root the live snapshot order is preserved (the producer
 * answers by row number, so the numbering is the stable interface).
 *
 * ## Advisory only
 *
 * A recommendation is derived from the row's own evidence — a dependency hold,
 * an unanswered question, or no surviving evidence (fail-closed) — and never
 * decides the row's fate. The producer may answer any way; the document says so
 * up front and on every recommendation line.
 */

import {
  FALLBACK_INTERVIEW_QUESTION,
  type ProducerInterviewRow,
  type ProducerInterviewSnapshot,
} from './producer-interview-snapshot.js';

/** The marker that leads every recommendation line. */
export const PRODUCER_INTERVIEW_BATCH_DOC_MARKER = 'Recommended';

/** The directory the generated document lives in, relative to the repo root. */
export const PRODUCER_INTERVIEW_BATCH_DOC_DIR = 'docs/dev';

/** The evidence category a recommendation is derived from. */
export type ProducerInterviewRecommendationKind =
  | 'dependency-held'
  | 'unanswered-question'
  | 'no-evidence';

export interface ProducerInterviewRecommendation {
  kind: ProducerInterviewRecommendationKind;
  /** The option the agent prefers; advisory, never auto-applied. */
  option: string;
  /** One-line reason for the preference. */
  rationale: string;
  /** Always true — the producer's answer wins. */
  advisory: true;
}

/**
 * Recommend one option for a row from that row's own evidence, in a fixed
 * decision order:
 *
 * 1. a recorded independent `dependency` hold — clearing cannot cause a
 *    dispatch, so the flag adds nothing;
 * 2. no deciding evidence at all — the fail-closed question, only the
 *    producer can say whether the flag is still needed;
 * 3. a deciding question (comment or description appendix) — still unanswered.
 */
export function deriveProducerInterviewRecommendation(
  row: ProducerInterviewRow,
): ProducerInterviewRecommendation {
  if ((row.holds ?? []).includes('dependency')) {
    return {
      kind: 'dependency-held',
      option: 'clear the flag',
      rationale: 'an outbound dependency already gates dispatch, so this flag adds nothing',
      advisory: true,
    };
  }
  if (
    row.evidenceCommentId === null &&
    row.question === FALLBACK_INTERVIEW_QUESTION
  ) {
    return {
      kind: 'no-evidence',
      option: 'confirm whether it still needs producer attention',
      rationale: 'no deciding evidence survives, so only you can say whether the flag is still needed',
      advisory: true,
    };
  }
  return {
    kind: 'unanswered-question',
    option: 'answer the question, then clear the flag',
    rationale: 'the deciding question on record is still unanswered — I cannot answer it for you',
    advisory: true,
  };
}

/**
 * The documented document path for one batch:
 * `docs/dev/producer-interview-batch-<UTC date>.md`.
 */
export function producerInterviewBatchDocPath(generatedAt: string): string {
  const instant = Date.parse(generatedAt);
  if (!Number.isFinite(instant)) {
    throw new Error(`producer-interview-batch-doc: generatedAt is not an ISO-8601 instant: ${generatedAt}`);
  }
  const date = new Date(instant).toISOString().slice(0, 10);
  return `${PRODUCER_INTERVIEW_BATCH_DOC_DIR}/producer-interview-batch-${date}.md`;
}

interface GroupedRows {
  root: string;
  rows: ProducerInterviewRow[];
}

/**
 * Group rows by root, ordering roots by codepoint and preserving the snapshot
 * order within each root (the numbering is the producer's answer interface).
 */
function groupRowsByRoot(rows: ReadonlyArray<ProducerInterviewRow>): GroupedRows[] {
  const groups = new Map<string, ProducerInterviewRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.root);
    if (bucket === undefined) groups.set(row.root, [row]);
    else bucket.push(row);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([root, grouped]) => ({ root, rows: grouped }));
}

function recommendationLine(row: ProducerInterviewRow): string {
  const recommendation = deriveProducerInterviewRecommendation(row);
  return `**${PRODUCER_INTERVIEW_BATCH_DOC_MARKER}:** ${recommendation.option} — ${recommendation.rationale} (advisory only)`;
}

/**
 * The deciding evidence reference from the snapshot: the classified row's own
 * reference (comment, description appendix, audit, …) when present, otherwise
 * the row's comment id. `null` means no evidence survives.
 */
function decidingEvidence(
  snapshot: ProducerInterviewSnapshot,
  row: ProducerInterviewRow,
): string | null {
  const classified = snapshot.classified.find((entry) => entry.id === row.id);
  if (classified !== undefined) {
    return classified.evidence === 'none' ? null : classified.evidence;
  }
  return row.evidenceCommentId === null ? null : `comment:${row.evidenceCommentId}`;
}

/**
 * Quote the question verbatim in a blockquote, neutralising its own
 * `**Recommended:**` text (an inert backslash escape the renderer strips) so
 * a question can never read as this document's advisory line.
 */
function quoteQuestion(question: string): string[] {
  return question.split('\n').map((line) => {
    const neutralised = line.replace(/\*\*Recommended:\*\*/g, '**Recommended\\:**');
    return neutralised.length === 0 ? '>' : `> ${neutralised}`;
  });
}

function pluralRows(count: number): string {
  return count === 1 ? '1 row' : `${count} rows`;
}

function recommendationsSuffix(): string {
  return 'Recommendations below are **advisory only** — answer however you prefer and your answer is what gets applied.';
}

/**
 * Render the batched interview document from the snapshot payload. Pure and
 * deterministic: identical input yields a byte-identical string.
 */
export function renderProducerInterviewBatchDoc(snapshot: ProducerInterviewSnapshot): string {
  const groups = groupRowsByRoot(snapshot.interview);
  const total = snapshot.interview.length;
  const lines: string[] = [];

  lines.push(`# Producer interview batch — ${snapshot.generatedAt}`);
  lines.push('');
  lines.push(
    `**Batch id:** \`${snapshot.generatedAt}\` · **Rows:** ${total} · **Roots:** ${groups.length}`,
  );
  lines.push('');

  if (total === 0) {
    lines.push('## No rows to interview');
    lines.push('');
    lines.push(
      `The live snapshot groups **0** prep items \`needs-producer-input\` at \`${snapshot.generatedAt}\`.`,
    );
    lines.push('Nothing is waiting on the producer and no question is open in this batch.');
    return `${lines.join('\n')}\n`;
  }

  const perRoot = groups
    .map((group) => `\`${group.root}\` ${pluralRows(group.rows.length)}`)
    .join(' · ');
  lines.push(`**Per-root counts:** ${perRoot}`);
  lines.push('');

  lines.push('## How to answer');
  lines.push('');
  lines.push('Reply once, **per row number** (for example `1: clear it`, `2: keep waiting because …`).');
  lines.push('A row you do not answer **stays flagged** and remains grouped `needs-producer-input`.');
  lines.push(
    "Answering a row **is the authorisation** for that row's flag clear — no answer, no clear.",
  );
  lines.push('');
  lines.push(recommendationsSuffix());
  lines.push('');

  let number = 0;
  for (const group of groups) {
    lines.push(`### \`${group.root}\` (${pluralRows(group.rows.length)})`);
    lines.push('');
    for (const row of group.rows) {
      number += 1;
      lines.push(`#### Row ${number} — ${row.id}`);
      lines.push('');
      lines.push(`- **Root:** \`${row.root}\``);
      lines.push(`- **Title:** ${row.title}`);
      const evidence = decidingEvidence(snapshot, row);
      lines.push(
        evidence === null
          ? '- **Deciding evidence:** none (no surviving evidence)'
          : `- **Deciding evidence:** \`${evidence}\``,
      );
      lines.push(`- **Flag age:** ${row.flagAge}`);
      lines.push('');
      lines.push('**Question**');
      lines.push('');
      lines.push(...quoteQuestion(row.question));
      lines.push('');
      lines.push(recommendationLine(row));
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
