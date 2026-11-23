/**
 * packages/herdr/src/downtime-worker.producer-review-provenance.ts — the
 * provenance RULE for the `needsProducerReview` flag (WL-0MWTBJAV7002ZZQI,
 * child 4 of WL-0MWTAD1KM0081UUD).
 *
 * ## Why this module exists
 *
 * `needsProducerReview === true` is the dispatcher's only persistent hold, but
 * nothing records where the flag came from: the intake/plan/interview question
 * loop, an audit rejection, attempt-budget exhaustion, a release escalation or
 * a hand-written `wl reviewed` all write the same boolean. A stale flag is
 * therefore indistinguishable from a live producer question — which is what
 * starved the prep fallback in the 2026-11-22/23 run (parent
 * WL-0MWTAD1KM0081UUD). This module turns the surviving evidence into one
 * auditable verdict per item: **what set the flag, from which evidence, how old
 * it is, whether a question is still unanswered, and therefore whether the flag
 * can be cleared now.**
 *
 * ## The rule (documented canonically in `docs/dev/downtime-dispatcher.md`)
 *
 * 1. A flag source is only claimed from durable evidence: the stored audit
 *    record (`readyToClose === false`), the dispatch attempt markers at the
 *    item's CURRENT stage (count >= the per-item cap), a question/approval
 *    comment (or the description's `OPEN QUESTION` appendix), a release
 *    escalation comment, or an explicit `wl reviewed … true` comment.
 * 2. The **newest** such evidence wins; ties break by authority order
 *    (audit > attempt budget > question > escalation > manual). A passing audit
 *    is never a flag source — a pass does not set the flag.
 * 3. The flag age is measured from THAT evidence's own timestamp. A description
 *    appendix carries no timestamp, so its age is `null` (age unknown) — the
 *    item's `updatedAt` is deliberately NOT used: bulk worklog operations move
 *    it without touching the flag (the 2026-11-23 bulk updates are the
 *    counter-example that motivated this rule).
 * 4. **Fail-closed.** No evidence at all, an untimeable evidence timestamp, a
 *    passing-only audit history, or evidence that postdates the evaluation
 *    instant all yield `ambiguous`/`manual` with an unknown age, and the row is
 *    grouped `needs-producer-input` — clearing is not provably safe. The ONE
 *    exception is an independent dispatcher hold (dependency / assignee /
 *    startOn / attempt budget): with such a hold, clearing the flag cannot
 *    cause a dispatch, so the row may be `can-clear-now` with the hold named.
 * 5. An unanswered producer question always groups `needs-producer-input`,
 *    holds or not.
 *
 * ## Read-only
 *
 * Pure functions over plain data: no `wl`, no subprocess, no filesystem, no
 * mutation of the input. This module never clears a flag or reassigns an item —
 * clearing is a separate, producer-authorised follow-up.
 */

import { DEFAULT_DOWNTIME_MAX_ATTEMPTS } from './downtime-worker.constants.js';

/**
 * The flag sources, in **authority order** (used only to break a timestamp
 * tie). Documented once, in this order, in `docs/dev/downtime-dispatcher.md` →
 * *Producer-review provenance*; the suite asserts the two agree.
 */
export const PRODUCER_REVIEW_SOURCES = [
  'audit-reject',
  'attempt-budget-exhaustion',
  'question-loop',
  'ship-escalation',
  'manual',
] as const;

export type ProducerReviewSource = (typeof PRODUCER_REVIEW_SOURCES)[number];

/** A verdict is `ambiguous` when the evidence cannot be trusted or timed. */
export type ProducerReviewProvenanceKind = ProducerReviewSource | 'ambiguous';

/** The two audit groups (parent AC2). */
export const PRODUCER_REVIEW_GROUPS = ['can-clear-now', 'needs-producer-input'] as const;

export type ProducerReviewGroup = (typeof PRODUCER_REVIEW_GROUPS)[number];

/** One worklog comment (the only fields the rule reads). */
export interface ProducerReviewComment {
  id: string;
  author?: string;
  comment: string;
  createdAt: string;
}

/** The stored audit record (`wl audit-show`) reduced to the fields that matter. */
export interface ProducerReviewAuditRecord {
  /** `true` = pass, `false` = reject, absent/`null` = unknown. */
  readyToClose?: boolean | null;
  /** The audit report's own instant. */
  generatedAt?: string | null;
  /** The worklog's audit timestamp (fallback when `generatedAt` is absent). */
  auditedAt?: string | null;
}

/**
 * One dispatch attempt (a rolling-log marker, or the durable worklog comment
 * the worker writes). Eligibility mirrors `countAttempts`: spawn-failed and
 * enrichment passes never count, and only the item's CURRENT stage counts.
 */
export interface ProducerReviewDispatchAttempt {
  kind?: string;
  stage?: string;
  dispatchedAt?: string;
  enrichment?: boolean;
  outcome?: string;
}

/** The item fields the rule reads. Nothing here is mutated. */
export interface ProducerReviewProvenanceItem {
  id: string;
  title?: string;
  stage?: string;
  status?: string;
  description?: string;
  assignee?: string;
  startOn?: string;
}

/** Everything one verdict needs. `now` is REQUIRED: age needs a clock. */
export interface ProducerReviewProvenanceInput {
  item: ProducerReviewProvenanceItem;
  comments?: ReadonlyArray<ProducerReviewComment>;
  audit?: ProducerReviewAuditRecord | null;
  attempts?: ReadonlyArray<ProducerReviewDispatchAttempt>;
  /**
   * Independent dispatcher holds already applied to the item (gate tokens:
   * `dependency`, `assignee-hold`, `startOn`, `attempt-budget`, `cooldown`,
   * `dispatch-marker`). Used ONLY to prove that clearing the flag cannot cause
   * a dispatch; the rule never relaxes a hold.
   */
  holds?: ReadonlyArray<string>;
  /** Frozen evaluation instant (ms since epoch). */
  now: number;
  /** Per-item/per-kind attempt cap (defaults to the dispatcher's own). */
  maxAttempts?: number;
}

/** Which evidence field the verdict keys on. */
export interface ProducerReviewEvidence {
  kind: 'audit' | 'dispatch-marker' | 'comment' | 'description' | 'none';
  /** A stable locator: `audit:<iso>`, `comment:<id>`, `dispatch:<kind>@<iso>#<n>`. */
  reference: string;
  /** The evidence's own timestamp (ISO-8601), or `null` when it has none. */
  at: string | null;
}

export interface ProducerReviewProvenanceVerdict {
  id: string;
  title: string;
  source: ProducerReviewProvenanceKind;
  evidence: ProducerReviewEvidence;
  /** Age measured from `evidence.at`; `null` = unknown (fail-closed). */
  flagAgeMs: number | null;
  /** An unanswered producer question is recorded (description or comment). */
  openQuestion: boolean;
  /** The reference of the open question / appendix marker. */
  openQuestionEvidence: string | null;
  holds: string[];
  group: ProducerReviewGroup;
  reason: string;
}

/** The audit table: rows plus the two AC2 groups and their counts. */
export interface ProducerReviewProvenanceTable {
  rows: ProducerReviewProvenanceVerdict[];
  groups: Record<ProducerReviewGroup, string[]>;
  counts: Record<ProducerReviewGroup, number>;
  total: number;
}

/**
 * Question markers, matched case-insensitively against one comment body or the
 * item description. Every documented call site is represented:
 * intake/plan/interview (`question:`, `OPEN QUESTIONS`, `Questions for
 * producer`, `awaiting producer`, `Producer decision required`, `please
 * confirm`), the audit-independent-failure note (`remains open for the
 * producer`) and the Appendix convention (`OPEN QUESTION`).
 */
const QUESTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bquestions?:/i,
  /\bopen questions?\b/i,
  /\bquestions for (the )?producer\b/i,
  /\bproducer decision required\b/i,
  /\bawaiting producer\b/i,
  /\bremains open for the producer\b/i,
  /\bneeds? (the )?producer(?:'s)? (?:input|review|decision)\b/i,
  /\bplease (?:confirm|approve|answer|reject|choose)\b/i,
];

/** A recorded ANSWER (never an agent's own recommendation). */
const ANSWER_PATTERNS: ReadonlyArray<RegExp> = [
  /^\s*(?:[-*]\s*)?answers?\b\s*[:(]/im,
  /\bproducer (?:answer|decision)\s*[:=]/i,
  /\banswered by\b/i,
];

/** A release escalation comment (ship skill, child override/escalation). */
function isEscalationComment(body: string): boolean {
  return /\bescalat/i.test(body) && /producer/i.test(body);
}

/** An explicit manual flag comment (`wl reviewed <id> true` or equivalent). */
function isManualFlagComment(body: string): boolean {
  return (
    /\bwl reviewed\b[^\n]*\b(?:true|yes)\b/i.test(body) ||
    /\bneeds[- ]producer[- ]review\b\s*(?::|=|to)?\s*(?:true|yes)\b/i.test(body)
  );
}

/** True when the text records a question/approval aimed at the producer. */
export function isProducerReviewQuestion(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** True when the text records an answer to a producer question. */
export function isProducerReviewAnswer(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  // Strip markdown emphasis/quotation markers so `**Answer (producer):**` is
  // recognised the same way as a plain `Answer:` line.
  const normalised = text.replace(/^\s*(?:[*_>#-]+\s*)+/gm, '');
  return ANSWER_PATTERNS.some((pattern) => pattern.test(normalised));
}

function parseInstant(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface Candidate {
  source: ProducerReviewSource;
  evidence: ProducerReviewEvidence;
  atMs: number | null;
}

/**
 * Build the flag-source candidates from durable evidence only. Order is the
 * authority order; the caller sorts by timestamp (newest first).
 */
function collectCandidates(input: ProducerReviewProvenanceInput): Candidate[] {
  const candidates: Candidate[] = [];
  const comments = input.comments ?? [];

  // 1. Audit reject — the stored record's explicit failure verdict.
  const audit = input.audit;
  if (audit && audit.readyToClose === false) {
    const at = audit.generatedAt ?? audit.auditedAt ?? null;
    candidates.push({
      source: 'audit-reject',
      evidence: { kind: 'audit', reference: `audit:${at ?? '(no timestamp)'}`, at },
      atMs: parseInstant(at),
    });
  }

  // 2. Attempt-budget exhaustion — the Nth non-enrichment marker at the
  //    item's CURRENT stage (the same predicate the dispatcher applies).
  const maxAttempts =
    typeof input.maxAttempts === 'number' && Number.isFinite(input.maxAttempts)
      ? input.maxAttempts
      : DEFAULT_DOWNTIME_MAX_ATTEMPTS;
  const stage = input.item.stage ?? '';
  if (maxAttempts >= 1) {
    const atStage = (input.attempts ?? [])
      .filter((attempt) => {
        if (attempt.enrichment === true) return false;
        if (attempt.outcome === 'spawn-failed') return false;
        if ((attempt.stage ?? '') !== stage) return false;
        return parseInstant(attempt.dispatchedAt) !== null;
      })
      .map((attempt) => ({
        kind: attempt.kind ?? 'unknown',
        at: attempt.dispatchedAt as string,
        atMs: parseInstant(attempt.dispatchedAt) as number,
      }))
      .sort((a, b) => a.atMs - b.atMs);
    if (atStage.length >= maxAttempts) {
      const pivot = atStage[maxAttempts - 1];
      candidates.push({
        source: 'attempt-budget-exhaustion',
        evidence: {
          kind: 'dispatch-marker',
          reference: `dispatch:${pivot.kind}@${pivot.at}#${maxAttempts}`,
          at: pivot.at,
        },
        atMs: pivot.atMs,
      });
    }
  }

  // 3. Question loop — the NEWEST question comment.
  const questionComments = comments
    .filter((entry) => isProducerReviewQuestion(entry.comment))
    .map((entry) => ({ entry, atMs: parseInstant(entry.createdAt) }))
    .sort((a, b) => (a.atMs ?? Number.NEGATIVE_INFINITY) - (b.atMs ?? Number.NEGATIVE_INFINITY));
  const newestQuestion = questionComments[questionComments.length - 1];
  if (newestQuestion) {
    candidates.push({
      source: 'question-loop',
      evidence: {
        kind: 'comment',
        reference: `comment:${newestQuestion.entry.id}`,
        at: newestQuestion.entry.createdAt,
      },
      atMs: newestQuestion.atMs,
    });
  }

  // 4. Ship escalation — the newest escalation comment.
  const escalations = comments
    .filter((entry) => isEscalationComment(entry.comment))
    .map((entry) => ({ entry, atMs: parseInstant(entry.createdAt) }))
    .sort((a, b) => (a.atMs ?? Number.NEGATIVE_INFINITY) - (b.atMs ?? Number.NEGATIVE_INFINITY));
  const newestEscalation = escalations[escalations.length - 1];
  if (newestEscalation) {
    candidates.push({
      source: 'ship-escalation',
      evidence: {
        kind: 'comment',
        reference: `comment:${newestEscalation.entry.id}`,
        at: newestEscalation.entry.createdAt,
      },
      atMs: newestEscalation.atMs,
    });
  }

  // 5. Manual — an explicit `wl reviewed … true` comment.
  const manualComments = comments
    .filter((entry) => isManualFlagComment(entry.comment))
    .map((entry) => ({ entry, atMs: parseInstant(entry.createdAt) }))
    .sort((a, b) => (a.atMs ?? Number.NEGATIVE_INFINITY) - (b.atMs ?? Number.NEGATIVE_INFINITY));
  const newestManual = manualComments[manualComments.length - 1];
  if (newestManual) {
    candidates.push({
      source: 'manual',
      evidence: {
        kind: 'comment',
        reference: `comment:${newestManual.entry.id}`,
        at: newestManual.entry.createdAt,
      },
      atMs: newestManual.atMs,
    });
  }

  return candidates;
}

/** Newest first; ties break by authority order (the array's own order). */
function pickNewest(candidates: ReadonlyArray<Candidate>): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const candidateAt = candidate.atMs ?? Number.NEGATIVE_INFINITY;
    const bestAt = best.atMs ?? Number.NEGATIVE_INFINITY;
    if (candidateAt > bestAt) best = candidate;
  }
  return best;
}

/** True when the description's Appendix still marks a producer question open. */
function descriptionHasOpenQuestion(description: string | undefined): boolean {
  if (typeof description !== 'string') return false;
  return /OPEN QUESTION/i.test(description);
}

/**
 * Classify ONE flagged item's provenance. Read-only: the input is never
 * mutated, and no I/O is performed.
 */
export function classifyProducerReviewProvenance(
  input: ProducerReviewProvenanceInput,
): ProducerReviewProvenanceVerdict {
  const item = input.item;
  const comments = input.comments ?? [];
  const holds = [...(input.holds ?? [])];
  const descriptionOpen = descriptionHasOpenQuestion(item.description);

  // Open-question status is independent of which source wins: the newest
  // question comment must be answered by a LATER answer comment, and a
  // description marker counts open unless an answer is on record.
  const questionComments = comments
    .filter((entry) => isProducerReviewQuestion(entry.comment))
    .map((entry) => ({ entry, atMs: parseInstant(entry.createdAt) }))
    .sort((a, b) => (a.atMs ?? Number.NEGATIVE_INFINITY) - (b.atMs ?? Number.NEGATIVE_INFINITY));
  const newestQuestion = questionComments[questionComments.length - 1];
  const answerComments = comments.filter((entry) => isProducerReviewAnswer(entry.comment));
  const answeredAfter = (atMs: number | null): boolean =>
    answerComments.some((entry) => {
      const answerAt = parseInstant(entry.createdAt);
      if (answerAt === null) return false;
      return atMs === null ? true : answerAt > atMs;
    });
  const openQuestion = newestQuestion
    ? !answeredAfter(newestQuestion.atMs)
    : descriptionOpen && !answerComments.some((entry) => parseInstant(entry.createdAt) !== null);

  const candidates = collectCandidates(input);
  const newest = pickNewest(candidates);

  let source: ProducerReviewProvenanceKind;
  let evidence: ProducerReviewEvidence;
  let flagAgeMs: number | null = null;
  let reason: string;

  if (newest === null) {
    if (descriptionOpen) {
      source = 'question-loop';
      evidence = {
        kind: 'description',
        reference: `description:${item.id}:OPEN_QUESTION`,
        at: null,
      };
      reason = 'question appendix in the description records an unanswered producer question';
    } else {
      source = 'manual';
      evidence = { kind: 'none', reference: 'none', at: null };
      reason =
        holds.length === 0
          ? 'no flag-causing evidence and no independent hold — clearing is not provably safe'
          : `no flag-causing evidence, but the item is independently held (${holds.join(
              ', ',
            )}), so clearing cannot cause a dispatch`;
    }
  } else if (newest.atMs === null) {
    source = 'ambiguous';
    evidence = newest.evidence;
    reason = `flag-causing evidence ${newest.source} (${newest.evidence.reference}) has no timestamp — age and ordering are unprovable`;
  } else if (newest.atMs > input.now) {
    source = 'ambiguous';
    evidence = newest.evidence;
    reason = `flag-causing evidence ${newest.source} (${newest.evidence.reference}) postdates the evaluation instant — not visible in this replay`;
  } else {
    source = newest.source;
    evidence = newest.evidence;
    flagAgeMs = Math.max(0, input.now - newest.atMs);
    if (newest.source === 'question-loop') {
      reason = openQuestion
        ? `unanswered producer question recorded in ${newest.evidence.reference}`
        : `producer question in ${newest.evidence.reference} is answered — the flag is stale`;
    } else if (newest.source === 'attempt-budget-exhaustion') {
      reason = `attempt budget exhausted at the current stage — ${newest.evidence.reference}`;
    } else if (newest.source === 'audit-reject') {
      reason = `audit recorded readyToClose=false — ${newest.evidence.reference}`;
    } else if (newest.source === 'ship-escalation') {
      reason = `release escalation recorded for this item — ${newest.evidence.reference}`;
    } else {
      reason = `manual producer-review flag recorded in ${newest.evidence.reference}`;
    }
  }

  if (openQuestion && source !== 'question-loop') {
    // Name the question explicitly when another source set the flag; the
    // producer still owes an answer.
    reason +=
      newestQuestion !== undefined
        ? `; open question comment:${newestQuestion.entry.id}`
        : `; open question description:${item.id}:OPEN_QUESTION`;
  }
  if (source !== 'ambiguous' && flagAgeMs === null) {
    reason += '; flag age unknown (evidence carries no timestamp)';
  }

  // Fail-closed grouping: an unanswered question always needs the producer; an
  // unprovable source does too UNLESS another gate already proves clearing
  // cannot cause a dispatch.
  const unprovable = source === 'ambiguous' || (newest === null && source === 'manual' && evidence.at === null);
  const group: ProducerReviewGroup =
    openQuestion || (unprovable && holds.length === 0) ? 'needs-producer-input' : 'can-clear-now';

  return {
    id: item.id,
    title: item.title ?? '',
    source,
    evidence,
    flagAgeMs,
    openQuestion,
    openQuestionEvidence: openQuestion
      ? newestQuestion
        ? `comment:${newestQuestion.entry.id}`
        : `description:${item.id}:OPEN_QUESTION`
      : null,
    holds,
    group,
    reason,
  };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort rendered rows by id and group them (deterministic audit table). */
export function assembleProducerReviewProvenance(
  rows: ReadonlyArray<ProducerReviewProvenanceVerdict>,
): ProducerReviewProvenanceTable {
  const sorted = [...rows].sort((a, b) => compareIds(a.id, b.id));
  const groups = Object.fromEntries(
    PRODUCER_REVIEW_GROUPS.map((group) => [group, [] as string[]]),
  ) as Record<ProducerReviewGroup, string[]>;
  for (const row of sorted) groups[row.group].push(row.id);
  return {
    rows: sorted,
    groups,
    counts: {
      'can-clear-now': groups['can-clear-now'].length,
      'needs-producer-input': groups['needs-producer-input'].length,
    },
    total: sorted.length,
  };
}

/** Render a flag age for the recorded table; `unknown` when unmeasurable. */
export function formatProducerReviewAge(flagAgeMs: number | null): string {
  if (flagAgeMs === null || !Number.isFinite(flagAgeMs) || flagAgeMs < 0) return 'unknown';
  const totalHours = Math.floor(flagAgeMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}
