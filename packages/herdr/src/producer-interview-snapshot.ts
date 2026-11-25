/**
 * packages/herdr/src/producer-interview-snapshot.ts — the read-only LIVE
 * producer-interview snapshot (WL-0MWVMRVOV0026OWM, child 1 of
 * WL-0MWTVPK65009NTER).
 *
 * ## Why this module exists
 *
 * The 2026-11-23 provenance audit grouped 17 prep items `needs-producer-input`
 * from a *snapshot* of the flag set. By the time the batched interview is
 * written, some of those rows may have been cleared externally, and new rows
 * may have appeared. Inviting the frozen list would interview the wrong items.
 * This module re-reads the **live** `needsProducerReview === true` prep set on
 * every configured active root and classifies it through the ONE provenance
 * rule (`classifyProducerReviewProvenance` + `assembleProducerReviewProvenance`
 * in `downtime-worker.producer-review-provenance.ts`) — never a second,
 * hand-rolled rule.
 *
 * ## What it emits
 *
 * For every row grouped `needs-producer-input` it emits the interview payload
 * the next child needs: item id, root, title, the open question text, the
 * deciding evidence comment id and the flag age (`formatProducerReviewAge`).
 * JSON is the machine path; a markdown table is the human path.
 *
 * ## Read-only by construction
 *
 * The only `wl` invocations this module can issue are the four documented
 * evidence reads (`docs/dev/downtime-dispatcher.md` → *Evidence commands
 * (read-only)*):
 *
 *     wl --worklog-dir <root>/.worklog list --json --needs-producer-review
 *        --include-not-started
 *     wl --worklog-dir <root>/.worklog comment list <id> --json
 *     wl --worklog-dir <root>/.worklog audit-show <id> --json
 *     wl --worklog-dir <root>/.worklog dep list <id> --json
 *
 * Every command passes through {@link assertReadOnlyWlArgs}, which throws on
 * anything else (`update`, `comment add`, `reviewed`, `audit-set`, …). The flag
 * is never cleared, an item is never reassigned and no dispatch marker is
 * written.
 *
 * ## Prep scope
 *
 * The parent interview is for PREP items (`idea` / `intake_complete`), so the
 * live flagged read is filtered to `PREP_SUPPLY_STAGES`. Flagged items in any
 * other stage are counted as `skippedNotPrep` so the exclusion is measured,
 * never silent.
 */

import {
  CLI_BINARIES,
  DEFAULT_CLI_TIMEOUT_MS,
  spawnCliStdout,
  type CliExecFile,
} from './cli-spawn.js';
import {
  assembleProducerReviewProvenance,
  classifyProducerReviewProvenance,
  formatProducerReviewAge,
  isProducerReviewQuestion,
  type ProducerReviewAuditRecord,
  type ProducerReviewComment,
  type ProducerReviewGroup,
  type ProducerReviewProvenanceKind,
  type ProducerReviewProvenanceVerdict,
  type ProducerReviewProvenanceItem,
} from './downtime-worker.producer-review-provenance.js';
import { PREP_SUPPLY_STAGES } from './downtime-worker.prep-supply.js';
import { parseDepListBlockersOutput } from './downtime-worker.parsers.js';
import { buildWlArgsForRoot, getExecFileAsync } from './fetcher.args.js';

/** Upper bound for one `wl` read (a large root's `list` can exceed 1 MB). */
export const PRODUCER_INTERVIEW_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * The canonical fail-closed interview question: used for a `manual` row whose
 * flag has no surviving evidence (e.g. `SA-0MVSCS0M80007X23`). The producer is
 * asked whether the item still needs attention instead of the flag being
 * cleared silently.
 */
export const FALLBACK_INTERVIEW_QUESTION = 'does it still need producer attention?';

/** The read-only `wl` invocation shapes this module is allowed to issue. */
export const READ_ONLY_WL_INVOCATIONS: ReadonlyArray<ReadonlyArray<string>> = [
  ['list'],
  ['comment', 'list'],
  ['audit-show'],
  ['dep', 'list'],
];

/** Terminal dependency statuses — anything else is an unmet blocker. */
const TERMINAL_DEPENDENCY_STATUSES: ReadonlySet<string> = new Set(['completed', 'deleted']);

/** One live flagged prep item, reduced to the fields the rule reads. */
export interface ProducerInterviewFlaggedItem extends ProducerReviewProvenanceItem {
  needsProducerReview?: boolean;
}

/** One dependency edge read from `wl dep list`. */
export interface ProducerInterviewBlocker {
  id: string;
  status?: string;
}

/** The evidence one flagged item contributes to the rule. */
export interface ProducerInterviewItemEvidence {
  comments: ReadonlyArray<ProducerReviewComment>;
  audit: ProducerReviewAuditRecord | null;
  /** Outbound `depends-on` blockers (the dispatcher's dependency gate). */
  blockers: ReadonlyArray<ProducerInterviewBlocker>;
}

/**
 * Injectable I/O, so the snapshot's acquisition is exercised without real
 * processes. The production wiring is
 * {@link createProducerInterviewSnapshotIo}.
 */
export interface ProducerInterviewSnapshotIo {
  /** `wl list --json --needs-producer-review --include-not-started`. */
  listFlagged(root: string): Promise<ReadonlyArray<ProducerInterviewFlaggedItem>>;
  /** `comment list` + `audit-show` + `dep list` for one flagged item. */
  readEvidence(
    root: string,
    item: ProducerInterviewFlaggedItem,
  ): Promise<ProducerInterviewItemEvidence>;
}

/** The exact interview payload (parent AC: the list to be interviewed). */
export interface ProducerInterviewRow {
  id: string;
  root: string;
  title: string;
  /** The open question text, or the fail-closed fallback question. */
  question: string;
  /** The deciding evidence's comment id, or `null` when it is not a comment. */
  evidenceCommentId: string | null;
  /** `formatProducerReviewAge` of the deciding evidence. */
  flagAge: string;
}

/** One classified row (every flagged prep item, both groups). */
export interface ProducerInterviewClassifiedRow {
  id: string;
  root: string;
  title: string;
  source: ProducerReviewProvenanceKind;
  /** The deciding evidence reference (`comment:<id>`, `audit:<iso>`, `none`, …). */
  evidence: string;
  flagAge: string;
  openQuestion: boolean;
  group: ProducerReviewGroup;
  reason: string;
}

/** Per-root summary, including the measured non-prep exclusion. */
export interface ProducerInterviewRootSummary {
  root: string;
  /** Flagged PREP items (what the rule classified for this root). */
  flagged: number;
  /** Flagged items excluded because their stage is not a prep stage. */
  skippedNotPrep: number;
  needsProducerInput: number;
  canClearNow: number;
  error?: string;
}

export interface ProducerInterviewSnapshot {
  /** The frozen evaluation instant, ISO-8601. */
  generatedAt: string;
  roots: ProducerInterviewRootSummary[];
  counts: Record<ProducerReviewGroup, number>;
  /** Flagged prep items classified (both groups). */
  flaggedTotal: number;
  /** Flagged items across all roots excluded as non-prep. */
  skippedNotPrep: number;
  classified: ProducerInterviewClassifiedRow[];
  /** Rows grouped `needs-producer-input` — the exact list to be interviewed. */
  interview: ProducerInterviewRow[];
  errors: Array<{ root: string; error: string }>;
}

// ── The read-only guard ──────────────────────────────────────────────

/**
 * Throw unless `args` is one of {@link READ_ONLY_WL_INVOCATIONS}. Flags are
 * ignored (their values are not command tokens); a mutating subcommand
 * (`update`, `comment add`, `reviewed`, `audit-set`, `create`, `close`,
 * `delete`, `sync`, …) never matches an allowed prefix and is refused.
 */
export function assertReadOnlyWlArgs(args: ReadonlyArray<string>): void {
  const tokens = args.filter((arg) => !arg.startsWith('-'));
  const allowed = READ_ONLY_WL_INVOCATIONS.some((prefix) =>
    prefix.every((token, index) => tokens[index] === token),
  );
  if (!allowed) {
    throw new Error(
      `producer-interview-snapshot is read-only: refusing wl ${args.join(' ')}`,
    );
  }
}

// ── Parsers ──────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse `wl list --json` for the flagged read. Malformed JSON or a payload
 * without a `workItems` array yields `null` (fail-closed); a valid empty list
 * yields `[]`. A record without a non-empty id is not an item.
 */
export function parseFlaggedListOutput(
  stdout: string,
): ProducerInterviewFlaggedItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null || !Array.isArray(record.workItems)) return null;

  const items: ProducerInterviewFlaggedItem[] = [];
  for (const raw of record.workItems) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const id = optionalString(entry.id);
    if (id === undefined || id.length === 0) continue;
    const item: ProducerInterviewFlaggedItem = { id };
    const title = optionalString(entry.title);
    if (title !== undefined) item.title = title;
    const stage = optionalString(entry.stage);
    if (stage !== undefined) item.stage = stage;
    const status = optionalString(entry.status);
    if (status !== undefined) item.status = status;
    const description = optionalString(entry.description);
    if (description !== undefined) item.description = description;
    const assignee = optionalString(entry.assignee);
    if (assignee !== undefined) item.assignee = assignee;
    const startOn = optionalString(entry.startOn);
    if (startOn !== undefined) item.startOn = startOn;
    if (typeof entry.needsProducerReview === 'boolean') {
      item.needsProducerReview = entry.needsProducerReview;
    }
    items.push(item);
  }
  return items;
}

/**
 * Parse `wl comment list --json`. Malformed JSON or a payload without a
 * `comments` array yields `null` (fail-closed); a valid empty list yields `[]`.
 */
export function parseCommentListOutput(stdout: string): ProducerReviewComment[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null || !Array.isArray(record.comments)) return null;

  const comments: ProducerReviewComment[] = [];
  for (const raw of record.comments) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const id = optionalString(entry.id);
    const comment = optionalString(entry.comment);
    const createdAt = optionalString(entry.createdAt);
    if (id === undefined || comment === undefined || createdAt === undefined) continue;
    const mapped: ProducerReviewComment = { id, comment, createdAt };
    const author = optionalString(entry.author);
    if (author !== undefined) mapped.author = author;
    comments.push(mapped);
  }
  return comments;
}

/**
 * Parse `wl audit-show --json`. The outer `null` is a parse failure
 * (fail-closed); a structurally valid payload with `audit: null` returns
 * `{ audit: null }` — "no stored audit" is data, not an error.
 */
export function parseAuditShowOutput(
  stdout: string,
): { audit: ProducerReviewAuditRecord | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null || !('audit' in record)) return null;

  const audit = asRecord(record.audit);
  if (audit === null) return { audit: null };

  const mapped: ProducerReviewAuditRecord = {};
  if (typeof audit.readyToClose === 'boolean' || audit.readyToClose === null) {
    mapped.readyToClose = audit.readyToClose;
  }
  const generatedAt = audit.generatedAt;
  if (typeof generatedAt === 'string' || generatedAt === null) {
    mapped.generatedAt = generatedAt;
  }
  const auditedAt = audit.auditedAt;
  if (typeof auditedAt === 'string' || auditedAt === null) {
    mapped.auditedAt = auditedAt;
  }
  return { audit: mapped };
}

/** Parse `wl dep list --json` into outbound `depends-on` blockers. */
export function parseBlockerListOutput(stdout: string): ProducerInterviewBlocker[] | null {
  const blockers = parseDepListBlockersOutput(stdout);
  if (blockers === null) return null;
  return blockers.map((blocker) => {
    const mapped: ProducerInterviewBlocker = { id: blocker.id };
    if (typeof blocker.status === 'string') mapped.status = blocker.status;
    return mapped;
  });
}

// ── Question text ────────────────────────────────────────────────────

/**
 * The open question text from a question comment: the WHOLE body when the
 * marker leads it, otherwise the body from the first question-bearing line —
 * an agent's preamble above the question is not part of the question.
 */
export function extractQuestionText(body: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => isProducerReviewQuestion(line));
  const text = (start > 0 ? lines.slice(start) : lines).join('\n').trim();
  return text.length > 0 ? text : body.trim();
}

/** The question recorded in a description's `OPEN QUESTION` appendix. */
export function extractDescriptionQuestion(description: string | undefined): string | null {
  if (typeof description !== 'string') return null;
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((line) => /OPEN QUESTION/i.test(line));
  if (start < 0) return null;
  const collected: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    // The appendix ends at the next heading (level 1-3) after its first line.
    if (index > start && /^#{1,3}\s/.test(line)) break;
    collected.push(line);
  }
  const text = collected.join('\n').trim();
  return text.length > 0 ? text : null;
}

/** The comment id a reference string points at (`comment:<id>`), else null. */
function commentIdFromReference(reference: string | null | undefined): string | null {
  if (typeof reference !== 'string') return null;
  return reference.startsWith('comment:') ? reference.slice('comment:'.length) : null;
}

/** The interview question for one verdict, falling back fail-closed. */
export function interviewQuestionFor(
  verdict: ProducerReviewProvenanceVerdict,
  item: ProducerReviewProvenanceItem,
  comments: ReadonlyArray<ProducerReviewComment>,
): string {
  const openReference = verdict.openQuestionEvidence;
  const commentId = commentIdFromReference(openReference);
  if (commentId !== null) {
    const comment = comments.find((entry) => entry.id === commentId);
    if (comment !== undefined) return extractQuestionText(comment.comment);
  }
  if (typeof openReference === 'string' && openReference.startsWith('description:')) {
    const fromDescription = extractDescriptionQuestion(item.description);
    if (fromDescription !== null) return fromDescription;
  }
  return FALLBACK_INTERVIEW_QUESTION;
}

// ── Hold derivation (the dispatcher predicates, read-only) ───────────

/**
 * Derive the independent dispatcher holds the rule may name. Only holds that
 * PROVE clearing cannot cause a dispatch are included, and they are never
 * relaxed — a spurious hold would wrongly move a `manual`/`ambiguous` row out
 * of the interview, so each predicate mirrors the dispatcher exactly:
 * an outbound `depends-on` edge to a non-terminal blocker, a non-`dispatcher`
 * assignee, or a future `startOn`.
 */
export function deriveProducerInterviewHolds(
  item: ProducerReviewProvenanceItem,
  blockers: ReadonlyArray<ProducerInterviewBlocker>,
  now: number,
): string[] {
  const holds: string[] = [];
  const dependencyHeld = blockers.some(
    (blocker) => !TERMINAL_DEPENDENCY_STATUSES.has(blocker.status ?? ''),
  );
  if (dependencyHeld) holds.push('dependency');
  if (
    typeof item.assignee === 'string' &&
    item.assignee.length > 0 &&
    item.assignee !== 'dispatcher'
  ) {
    holds.push('assignee-hold');
  }
  if (typeof item.startOn === 'string' && item.startOn.length > 0) {
    const startOn = Date.parse(item.startOn);
    if (Number.isFinite(startOn) && startOn > now) holds.push('startOn');
  }
  return holds;
}

function isPrepStageItem(item: ProducerInterviewFlaggedItem): boolean {
  const stage = typeof item.stage === 'string' ? item.stage : '';
  return (PREP_SUPPLY_STAGES as ReadonlyArray<string>).includes(stage);
}

// ── The snapshot core ────────────────────────────────────────────────

interface RowContext {
  root: string;
  item: ProducerReviewProvenanceItem;
  comments: ReadonlyArray<ProducerReviewComment>;
  verdict: ProducerReviewProvenanceVerdict;
}

/**
 * Read and classify the LIVE flagged prep set on every root. A root that fails
 * to read is reported in `errors` (the other roots are still reported) — an
 * unreadable root must never look like "no flagged items".
 */
export async function collectProducerInterviewSnapshot(
  io: ProducerInterviewSnapshotIo,
  roots: ReadonlyArray<string>,
  options: { now: number },
): Promise<ProducerInterviewSnapshot> {
  const generatedAt = new Date(options.now).toISOString();
  const uniqueRoots = [...new Set(roots)];
  const summaries: ProducerInterviewRootSummary[] = [];
  const errors: Array<{ root: string; error: string }> = [];
  const verdicts: ProducerReviewProvenanceVerdict[] = [];
  const rowContexts = new Map<string, RowContext>();

  for (const root of uniqueRoots) {
    const summary: ProducerInterviewRootSummary = {
      root,
      flagged: 0,
      skippedNotPrep: 0,
      needsProducerInput: 0,
      canClearNow: 0,
    };
    try {
      const flagged = await io.listFlagged(root);
      const prepItems = flagged.filter(isPrepStageItem);
      summary.flagged = prepItems.length;
      summary.skippedNotPrep = flagged.length - prepItems.length;

      for (const item of prepItems) {
        const evidence = await io.readEvidence(root, item);
        const holds = deriveProducerInterviewHolds(item, evidence.blockers, options.now);
        const verdict = classifyProducerReviewProvenance({
          item,
          comments: evidence.comments,
          audit: evidence.audit,
          holds,
          now: options.now,
        });
        verdicts.push(verdict);
        rowContexts.set(verdict.id, { root, item, comments: evidence.comments, verdict });
      }
    } catch (error) {
      summary.error = error instanceof Error ? error.message : String(error);
      errors.push({ root, error: summary.error });
    }
    summaries.push(summary);
  }

  const table = assembleProducerReviewProvenance(verdicts);

  const classified: ProducerInterviewClassifiedRow[] = table.rows.map((verdict) => {
    const context = rowContexts.get(verdict.id);
    return {
      id: verdict.id,
      root: context?.root ?? '',
      title: verdict.title,
      source: verdict.source,
      evidence: verdict.evidence.reference,
      flagAge: formatProducerReviewAge(verdict.flagAgeMs),
      openQuestion: verdict.openQuestion,
      group: verdict.group,
      reason: verdict.reason,
    };
  });

  for (const verdict of table.rows) {
    const context = rowContexts.get(verdict.id);
    if (context === undefined) continue;
    const summary = summaries.find((entry) => entry.root === context.root);
    if (summary === undefined) continue;
    if (verdict.group === 'needs-producer-input') summary.needsProducerInput += 1;
    else summary.canClearNow += 1;
  }

  const interview: ProducerInterviewRow[] = table.rows
    .filter((verdict) => verdict.group === 'needs-producer-input')
    .map((verdict) => {
      const context = rowContexts.get(verdict.id);
      return {
        id: verdict.id,
        root: context?.root ?? '',
        title: verdict.title,
        question: context
          ? interviewQuestionFor(verdict, context.item, context.comments)
          : FALLBACK_INTERVIEW_QUESTION,
        evidenceCommentId: commentIdFromReference(verdict.evidence.reference),
        flagAge: formatProducerReviewAge(verdict.flagAgeMs),
      };
    });

  return {
    generatedAt,
    roots: summaries,
    counts: table.counts,
    flaggedTotal: table.total,
    skippedNotPrep: summaries.reduce((total, entry) => total + entry.skippedNotPrep, 0),
    classified,
    interview,
    errors,
  };
}

// ── Rendering ────────────────────────────────────────────────────────

/** The machine path: the snapshot as pretty-printed JSON. */
export function renderProducerInterviewSnapshotJson(snapshot: ProducerInterviewSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/** Collapse a value to one markdown table cell (whitespace + pipe safe). */
function markdownCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * The human path: a markdown table of the exact interview list, followed by
 * per-root counts and any read errors. Deterministic — the same snapshot
 * renders identically.
 */
export function renderProducerInterviewSnapshotMarkdown(
  snapshot: ProducerInterviewSnapshot,
): string {
  const lines: string[] = [];
  lines.push(`## Producer interview snapshot — ${snapshot.generatedAt}`);
  lines.push('');
  lines.push(
    `**${snapshot.counts['needs-producer-input']}** needs-producer-input · ` +
      `${snapshot.counts['can-clear-now']} can-clear-now · ` +
      `${snapshot.flaggedTotal} flagged prep item(s) · ` +
      `${snapshot.skippedNotPrep} flagged non-prep item(s) skipped`,
  );
  lines.push('');

  lines.push('| root | id | title | evidence comment | flag age | question |');
  lines.push('|---|---|---|---|---|---|');
  if (snapshot.interview.length === 0) {
    lines.push('| _(none)_ | | | | | |');
  } else {
    for (const row of snapshot.interview) {
      lines.push(
        `| ${markdownCell(row.root)} | ${markdownCell(row.id)} | ${markdownCell(
          row.title,
        )} | ${markdownCell(row.evidenceCommentId ?? 'none')} | ${markdownCell(
          row.flagAge,
        )} | ${markdownCell(row.question)} |`,
      );
    }
  }

  lines.push('');
  lines.push('### Per-root counts');
  lines.push('');
  lines.push('| root | flagged prep | non-prep skipped | needs-producer-input | can-clear-now |');
  lines.push('|---|---|---|---|---|');
  for (const root of snapshot.roots) {
    lines.push(
      `| ${markdownCell(root.root)} | ${root.flagged} | ${root.skippedNotPrep} | ${root.needsProducerInput} | ${root.canClearNow} |`,
    );
  }

  if (snapshot.errors.length > 0) {
    lines.push('');
    lines.push('### Read errors');
    lines.push('');
    for (const error of snapshot.errors) {
      lines.push(`- ${markdownCell(error.root)}: ${markdownCell(error.error)}`);
    }
  }

  return lines.join('\n');
}

// ── Production wiring ────────────────────────────────────────────────

export interface ProducerInterviewSnapshotSourceIo {
  exec: CliExecFile;
}

/**
 * Wire the four read-only `wl` evidence commands into
 * {@link ProducerInterviewSnapshotIo}. Every spawn passes through
 * {@link assertReadOnlyWlArgs} first, so this wiring cannot issue a write.
 */
export function createProducerInterviewSnapshotIo(
  io: Partial<ProducerInterviewSnapshotSourceIo> = {},
): ProducerInterviewSnapshotIo {
  const exec = io.exec ?? getExecFileAsync();

  async function runReadOnly(root: string, args: string[]): Promise<string> {
    assertReadOnlyWlArgs(args);
    return spawnCliStdout(exec, CLI_BINARIES, buildWlArgsForRoot(root, args), {
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
      maxBuffer: PRODUCER_INTERVIEW_MAX_BUFFER_BYTES,
    });
  }

  return {
    async listFlagged(root: string) {
      const stdout = await runReadOnly(root, [
        'list',
        '--json',
        '--needs-producer-review',
        'true',
        '--include-not-started',
      ]);
      const items = parseFlaggedListOutput(stdout);
      if (items === null) {
        throw new Error(`unparseable wl list --json output for ${root}`);
      }
      return items;
    },

    async readEvidence(root: string, item: ProducerInterviewFlaggedItem) {
      const commentsStdout = await runReadOnly(root, ['comment', 'list', item.id, '--json']);
      const comments = parseCommentListOutput(commentsStdout);
      if (comments === null) {
        throw new Error(`unparseable wl comment list output for ${root} (item ${item.id})`);
      }

      const auditStdout = await runReadOnly(root, ['audit-show', item.id, '--json']);
      const audit = parseAuditShowOutput(auditStdout);
      if (audit === null) {
        throw new Error(`unparseable wl audit-show output for ${root} (item ${item.id})`);
      }

      const depStdout = await runReadOnly(root, ['dep', 'list', item.id, '--json']);
      const blockers = parseBlockerListOutput(depStdout);
      if (blockers === null) {
        throw new Error(`unparseable wl dep list output for ${root} (item ${item.id})`);
      }

      return { comments, audit: audit.audit, blockers };
    },
  };
}
