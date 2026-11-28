/**
 * packages/herdr/src/producer-interview-reconcile.ts — the post-batch
 * reconciliation and no-change verification (WL-0MWVMRYL60019FD1, child 5 of
 * WL-0MWTVPK65009NTER).
 *
 * ## Why this module exists
 *
 * Children 1–4 re-read the live flagged set, rendered and delivered the batched
 * answer sheet, then applied the producer's answers. The operator still needs
 * to see, after the run, exactly what changed per root — and to be able to
 * prove that the run touched **nothing** except the answered rows' flags.
 *
 * This module diffs the batch's BEFORE snapshot (the frozen document input)
 * against a FRESH re-run of the same snapshot command (AFTER), keyed on the
 * two groups the snapshot already emits. It never mutates a flag: it is
 * verification and reporting only.
 *
 * ## The reconciliation rule
 *
 * Every row invited by the batch (BEFORE `interview`) must end in exactly one
 * of two states:
 *
 *  - **cleared against an answer** — the row left the `needs-producer-input`
 *    group AND has a recorded non-deferral answer entry with a clear-comment
 *    link;
 *  - **still flagged** — the row still groups `needs-producer-input` in the
 *    fresh re-run, either because the producer left it unanswered or because
 *    the answer was a deferral ("keep waiting").
 *
 * Anything else is a **failure**, never a silent reconciliation:
 *
 *  - a row that left the group with no answer (`cleared_without_answer`);
 *  - a row whose answer has no clear comment (`cleared_without_clear_comment`);
 *  - a deferral row that was cleared anyway (`deferral_row_cleared`);
 *  - an answered row whose clear did not take (`answer_clear_did_not_take`);
 *  - an unanswered/deferred row still flagged but regrouped away from
 *    `needs-producer-input` (`unanswered_row_regrouped` /
 *    `deferral_row_regrouped`);
 *  - a fresh flag read that contradicts the grouping
 *    (`unanswered_row_not_flagged` / `deferred_row_not_flagged`).
 *
 * ## The explicit unanswered-row assertion
 *
 * The parent acceptance criterion says an unanswered row must still carry
 * `needsProducerReview=true` and still group `needs-producer-input` in the
 * fresh re-run — asserted, not eyeballed. {@link reconcileProducerInterviewBatch}
 * checks both against the caller's fresh `afterFlags` read and the AFTER
 * snapshot's grouped interview set, and records `unanswered` so the renderer
 * can show the proof. A still-flagged unanswered row is itself the dispatch
 * guard: the producer-review gate refuses to dispatch it.
 *
 * ## The no-change assertion
 *
 * {@link findDispatcherProtectedChanges} asserts the batch's change set never
 * touches dispatcher gating (`downtime-worker.ts`), audit budget
 * (`downtime-log-budget.ts`) or dispatcher selection
 * (`downtime-round-robin*.ts`). The CLI runs `git diff --name-only <range>`
 * over the batch's diff range and records both the command and its output.
 *
 * ## Pure and deterministic
 *
 * The reconcile core takes plain payloads and returns plain data. No I/O, no
 * clock, no locale-dependent collation: identical input yields identical
 * output, so the recorded table can be regenerated and compared.
 */

import type {
  ProducerInterviewSnapshot,
} from './producer-interview-snapshot.js';

/** The default author recorded on the reconciliation comment. */
export const PRODUCER_INTERVIEW_RECONCILE_AUTHOR = 'implement';

/** The batch item the reconciliation table is recorded on. */
export const PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM = 'WL-0MWTVPK65009NTER';

/**
 * The dispatcher paths the batch must never modify: gating
 * (`downtime-worker.ts`), audit budget (`downtime-log-budget.ts`) and
 * dispatcher selection (`downtime-round-robin*.ts`).
 */
export const DISPATCHER_PROTECTED_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /^packages\/herdr\/src\/downtime-worker\.ts$/,
  /^packages\/herdr\/src\/downtime-log-budget\.ts$/,
  /^packages\/herdr\/src\/downtime-round-robin[^/]*\.ts$/,
];

/**
 * The stable marker identifying the reconciliation comment for one batch, so a
 * re-run updates the table instead of posting a second one.
 */
export function producerInterviewReconciliationMarker(batchId: string): string {
  return `[producer-interview-reconciliation:${batchId}]`;
}

// ── Types ────────────────────────────────────────────────────────────

/** A recorded answer entry, with its clear comment link when one was posted. */
export interface ProducerInterviewAnswerLink {
  itemId: string;
  root: string;
  /** The Appendix answer entry's comment id. */
  answerCommentId: string;
  /** The clear audit comment's id; `null` for a deferral or a missing clear. */
  clearCommentId: string | null;
  /** True when the answer asked to keep waiting / not proceed. */
  deferral: boolean;
}

/** Everything the reconciliation needs. */
export interface ProducerInterviewReconcileInput {
  /** The batch document's snapshot (the frozen BEFORE state). */
  before: ProducerInterviewSnapshot;
  /** A fresh re-run of the same snapshot command (the AFTER state). */
  after: ProducerInterviewSnapshot;
  /** The recorded answer entries, keyed by row id through the array. */
  answers: ReadonlyArray<ProducerInterviewAnswerLink>;
  /**
   * The fresh `needsProducerReview` read for the rows under check. `true` =
   * still carries the flag; `false` = explicitly released; an absent id falls
   * back to the AFTER interview grouping. This is a separate read so a row
   * whose STAGE moved out of prep is still checked for its flag.
   */
  afterFlags: ReadonlyMap<string, boolean>;
}

export type ProducerInterviewReconcileErrorCode =
  | 'cleared_without_answer'
  | 'cleared_without_clear_comment'
  | 'deferral_row_cleared'
  | 'deferral_row_regrouped'
  | 'unanswered_row_regrouped'
  | 'unanswered_row_not_flagged'
  | 'deferred_row_not_flagged'
  | 'answer_clear_did_not_take';

/** One reconciliation failure (a row that cannot be reported as reconciled). */
export interface ProducerInterviewReconcileError {
  code: ProducerInterviewReconcileErrorCode;
  itemId: string;
  root: string;
  message: string;
}

/** One per-root table row. */
export interface ProducerInterviewReconcileRootRow {
  root: string;
  flaggedBefore: number;
  clearedAgainstAnswer: number;
  stillFlagged: number;
  totalInvited: number;
}

/** One cleared row, linked to the answer that authorised it. */
export interface ProducerInterviewReconcileClearedRow {
  id: string;
  root: string;
  answerCommentId: string;
  clearCommentId: string;
}

/** The reason a row is still flagged. */
export type ProducerInterviewStillFlaggedReason =
  | 'unanswered'
  | 'deferred'
  | 'answer-not-applied';

/** One still-flagged row with its fresh-read assertion. */
export interface ProducerInterviewReconcileStillFlaggedRow {
  id: string;
  root: string;
  reason: ProducerInterviewStillFlaggedReason;
  answerCommentId: string | null;
  needsProducerReview: boolean;
  groupedNeedsProducerInput: boolean;
}

/** The whole reconciliation result. */
export interface ProducerInterviewReconciliation {
  batchId: string;
  beforeGeneratedAt: string;
  afterGeneratedAt: string;
  marker: string;
  totals: {
    flaggedBefore: number;
    clearedAgainstAnswer: number;
    stillFlagged: number;
    totalInvited: number;
    appearedAfter: number;
  };
  roots: ProducerInterviewReconcileRootRow[];
  cleared: ProducerInterviewReconcileClearedRow[];
  stillFlagged: ProducerInterviewReconcileStillFlaggedRow[];
  /** The unanswered rows (a subset of `stillFlagged`), in BEFORE order. */
  unanswered: string[];
  /** Rows newly flagged after the batch, not invited by it. */
  appearedAfter: string[];
  errors: ProducerInterviewReconcileError[];
  valid: boolean;
}

// ── The reconcile core ───────────────────────────────────────────────

function byCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Diff the BEFORE and AFTER snapshots over the batch's invited rows and
 * classify every row as cleared-against-an-answer or still-flagged. Any row
 * that fits neither is recorded as a failure and makes the result invalid.
 */
export function reconcileProducerInterviewBatch(
  input: ProducerInterviewReconcileInput,
): ProducerInterviewReconciliation {
  const { before, after, afterFlags } = input;
  const batchId = before.generatedAt;

  const answerById = new Map(input.answers.map((entry) => [entry.itemId, entry]));
  const afterInterviewIds = new Set(after.interview.map((row) => row.id));
  const beforeIds = new Set(before.interview.map((row) => row.id));

  const cleared: ProducerInterviewReconcileClearedRow[] = [];
  const stillFlagged: ProducerInterviewReconcileStillFlaggedRow[] = [];
  const unanswered: string[] = [];
  const errors: ProducerInterviewReconcileError[] = [];

  const pushError = (
    code: ProducerInterviewReconcileErrorCode,
    itemId: string,
    root: string,
    message: string,
  ): void => {
    errors.push({ code, itemId, root, message });
  };

  for (const row of before.interview) {
    const { id, root } = row;
    const answer = answerById.get(id);
    const inInterview = afterInterviewIds.has(id);
    const explicitFlag = afterFlags.has(id) ? afterFlags.get(id) : undefined;
    // An explicit fresh read wins; otherwise the grouped interview is the read.
    const flagged = explicitFlag === undefined ? inInterview : explicitFlag;

    if (answer !== undefined && !answer.deferral) {
      // An answered non-deferral row must have left the group.
      if (inInterview) {
        stillFlagged.push({
          id,
          root,
          reason: 'answer-not-applied',
          answerCommentId: answer.answerCommentId,
          needsProducerReview: flagged,
          groupedNeedsProducerInput: true,
        });
        pushError(
          'answer_clear_did_not_take',
          id,
          root,
          `${id} has a clear-authorising answer (${answer.answerCommentId}) but still groups needs-producer-input in the fresh re-run`,
        );
        continue;
      }
      if (answer.clearCommentId === null || answer.clearCommentId.length === 0) {
        pushError(
          'cleared_without_clear_comment',
          id,
          root,
          `${id} left the group but its answer (${answer.answerCommentId}) has no clear-comment link`,
        );
        continue;
      }
      cleared.push({
        id,
        root,
        answerCommentId: answer.answerCommentId,
        clearCommentId: answer.clearCommentId,
      });
      continue;
    }

    if (answer !== undefined && answer.deferral) {
      // A deferral row must stay flagged and grouped.
      if (!inInterview) {
        if (flagged === true) {
          pushError(
            'deferral_row_regrouped',
            id,
            root,
            `${id} was deferred ("keep waiting") but the fresh re-run no longer groups it needs-producer-input`,
          );
        } else {
          pushError(
            'deferral_row_cleared',
            id,
            root,
            `${id} was deferred ("keep waiting") but its needsProducerReview flag is gone`,
          );
        }
        continue;
      }
      if (explicitFlag === false) {
        pushError(
          'deferred_row_not_flagged',
          id,
          root,
          `${id} was deferred but the fresh flag read says needsProducerReview=false while the snapshot groups it needs-producer-input`,
        );
      }
      stillFlagged.push({
        id,
        root,
        reason: 'deferred',
        answerCommentId: answer.answerCommentId,
        needsProducerReview: flagged,
        groupedNeedsProducerInput: true,
      });
      continue;
    }

    // Unanswered: the row must still carry the flag AND group needs-producer-input.
    if (!inInterview) {
      if (flagged === true) {
        pushError(
          'unanswered_row_regrouped',
          id,
          root,
          `${id} was not answered but the fresh re-run no longer groups it needs-producer-input (it is still flagged)`,
        );
      } else {
        pushError(
          'cleared_without_answer',
          id,
          root,
          `${id} left needs-producer-input with no recorded answer — a silent clear is never reconciled`,
        );
      }
      continue;
    }
    if (explicitFlag === false) {
      pushError(
        'unanswered_row_not_flagged',
        id,
        root,
        `${id} was not answered and the snapshot groups it needs-producer-input, but the fresh flag read says needsProducerReview=false`,
      );
    }
    unanswered.push(id);
    stillFlagged.push({
      id,
      root,
      reason: 'unanswered',
      answerCommentId: null,
      needsProducerReview: flagged,
      groupedNeedsProducerInput: true,
    });
  }

  // Rows that appeared after the batch are reported for completeness; they were
  // never invited, so they cannot be a reconciliation failure.
  const appearedAfter = after.interview
    .map((row) => row.id)
    .filter((id) => !beforeIds.has(id))
    .sort(byCodepoint);

  // Per-root table, union of roots that held an invited row.
  const rootNames = [...new Set(before.interview.map((row) => row.root))].sort(byCodepoint);
  const roots: ProducerInterviewReconcileRootRow[] = rootNames.map((root) => ({
    root,
    flaggedBefore: before.interview.filter((row) => row.root === root).length,
    clearedAgainstAnswer: cleared.filter((row) => row.root === root).length,
    stillFlagged: stillFlagged.filter((row) => row.root === root).length,
    totalInvited: before.interview.filter((row) => row.root === root).length,
  }));

  return {
    batchId,
    beforeGeneratedAt: before.generatedAt,
    afterGeneratedAt: after.generatedAt,
    marker: producerInterviewReconciliationMarker(batchId),
    totals: {
      flaggedBefore: before.interview.length,
      clearedAgainstAnswer: cleared.length,
      stillFlagged: stillFlagged.length,
      totalInvited: before.interview.length,
      appearedAfter: appearedAfter.length,
    },
    roots,
    cleared,
    stillFlagged,
    unanswered,
    appearedAfter,
    errors,
    valid: errors.length === 0,
  };
}

// ── The no-change assertion ──────────────────────────────────────────

/**
 * The changed paths that fall in a protected dispatcher family. An empty
 * result is the no-change proof; any entry is a reconciliation failure.
 */
export function findDispatcherProtectedChanges(
  changedPaths: ReadonlyArray<string>,
): string[] {
  return changedPaths.filter((path) =>
    DISPATCHER_PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(path)),
  );
}

/** Options recorded with the reconciliation table. */
export interface ProducerInterviewNoChangeRecord {
  /** The `git diff --name-only <range>` range the batch was asserted over. */
  changedRange?: string;
  /** The command's output: every changed path in the range. */
  changedPaths?: ReadonlyArray<string>;
  /** The protected paths found in the change set (empty = no change). */
  protectedChanged?: ReadonlyArray<string>;
}

// ── Rendering ────────────────────────────────────────────────────────

/** Collapse a value to one markdown table cell (whitespace + pipe safe). */
function markdownCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? `1 ${singular}` : `${count} ${pluralForm}`;
}

/**
 * Render the recorded reconciliation comment. The per-root table is the
 * headline; the cleared-row table is the evidence (answer entry → clear
 * comment), and the still-flagged table carries the fresh-read assertion.
 */
export function renderProducerInterviewReconciliationMarkdown(
  result: ProducerInterviewReconciliation,
  noChange: ProducerInterviewNoChangeRecord = {},
): string {
  const lines: string[] = [];
  lines.push(`## Producer-interview reconciliation — ${result.batchId}`);
  lines.push('');
  lines.push(result.marker);
  lines.push('');
  lines.push(`**Batch id:** \`${result.batchId}\``);
  lines.push(`**Frozen snapshot (before):** \`${result.beforeGeneratedAt}\``);
  lines.push(`**Fresh re-run (after):** \`${result.afterGeneratedAt}\``);
  lines.push(
    `**Result:** ${result.cleared.length} cleared against an answer · ${result.stillFlagged.length} still flagged · ${result.totals.totalInvited} invited`,
  );
  lines.push('');

  lines.push('### Per-root reconciliation');
  lines.push('');
  lines.push('| root | flagged before | cleared against an answer | still flagged | total invited |');
  lines.push('|---|---|---|---|---|');
  for (const root of result.roots) {
    lines.push(
      `| \`${markdownCell(root.root)}\` | ${root.flaggedBefore} | ${root.clearedAgainstAnswer} | ${root.stillFlagged} | ${root.totalInvited} |`,
    );
  }
  lines.push(
    `| **all roots** | ${result.totals.flaggedBefore} | ${result.totals.clearedAgainstAnswer} | ${result.totals.stillFlagged} | ${result.totals.totalInvited} |`,
  );
  lines.push('');

  lines.push(`### Cleared against an answer (${result.cleared.length})`);
  lines.push('');
  if (result.cleared.length === 0) {
    lines.push('_None — no invited row was cleared in this run._');
  } else {
    lines.push('| row | root | answer entry | clear comment |');
    lines.push('|---|---|---|---|');
    for (const row of result.cleared) {
      lines.push(
        `| \`${markdownCell(row.id)}\` | \`${markdownCell(row.root)}\` | \`comment:${markdownCell(
          row.answerCommentId,
        )}\` | \`comment:${markdownCell(row.clearCommentId)}\` |`,
      );
    }
  }
  lines.push('');

  lines.push(`### Still flagged (${result.stillFlagged.length})`);
  lines.push('');
  if (result.stillFlagged.length === 0) {
    lines.push('_None — every invited row was cleared against an answer._');
  } else {
    lines.push(
      '| row | root | reason | answer entry | `needsProducerReview` | grouped `needs-producer-input` |',
    );
    lines.push('|---|---|---|---|---|---|');
    for (const row of result.stillFlagged) {
      lines.push(
        `| \`${markdownCell(row.id)}\` | \`${markdownCell(row.root)}\` | ${row.reason} | ${
          row.answerCommentId === null ? '—' : `\`comment:${markdownCell(row.answerCommentId)}\``
        } | ${row.needsProducerReview ? 'true' : 'false'} | ${
          row.groupedNeedsProducerInput ? 'yes' : 'no'
        } |`,
      );
    }
    const unansweredCount = result.unanswered.length;
    lines.push('');
    lines.push(
      `Every unanswered row (${plural(unansweredCount, 'row')}) is asserted to still carry \`needsProducerReview=true\` and to still be grouped \`needs-producer-input\` in the fresh re-run — proven by the two right-hand columns above, not by eyeball. An unanswered row therefore never dispatches: the producer-review gate refuses it.`,
    );
  }
  lines.push('');

  if (result.appearedAfter.length > 0) {
    lines.push(`### Newly flagged after the batch (${result.appearedAfter.length})`);
    lines.push('');
    lines.push(
      'These rows were not invited by the batch (they appeared in the fresh re-run). They are reported for completeness, never as a reconciliation failure.',
    );
    lines.push('');
    for (const id of result.appearedAfter) {
      lines.push(`- \`${id}\``);
    }
    lines.push('');
  }

  if (result.errors.length > 0) {
    lines.push(`### Reconciliation failures (${result.errors.length})`);
    lines.push('');
    lines.push(
      'A row that cannot be proven cleared-against-an-answer or still-flagged is a **failure**, never a reconciliation.',
    );
    lines.push('');
    for (const error of result.errors) {
      lines.push(`- \`${error.code}\` \`${markdownCell(error.itemId)}\` — ${error.message}`);
    }
    lines.push('');
  }

  if (noChange.changedRange !== undefined) {
    const protectedChanged = noChange.protectedChanged ?? [];
    lines.push('### No-change assertion');
    lines.push('');
    lines.push('```bash');
    lines.push(`git diff --name-only ${noChange.changedRange}`);
    lines.push('```');
    lines.push('');
    const changedPaths = noChange.changedPaths ?? [];
    if (changedPaths.length === 0) {
      lines.push('_(no changed paths in the range)_');
    } else {
      lines.push('```');
      for (const path of changedPaths) lines.push(path);
      lines.push('```');
    }
    lines.push('');
    lines.push(
      protectedChanged.length === 0
        ? 'protected paths changed: none — no dispatcher gating, audit budget or dispatcher-selection change.'
        : `protected paths changed: **${protectedChanged.length}** — ${protectedChanged
            .map((path) => `\`${markdownCell(path)}\``)
            .join(', ')}`,
    );
    lines.push('');
  }

  lines.push(
    `**Validity:** ${
      result.valid && (noChange.protectedChanged ?? []).length === 0
        ? 'OK — every invited row reconciled'
        : `FAILED — ${result.errors.length} reconciliation failure(s)${
            (noChange.protectedChanged ?? []).length > 0
              ? `, ${(noChange.protectedChanged ?? []).length} protected path change(s)`
              : ''
          }`
    }`,
  );
  return `${lines.join('\n')}\n`;
}

/** The machine path: the reconciliation payload plus any no-change record. */
export function renderProducerInterviewReconciliationJson(
  result: ProducerInterviewReconciliation,
  noChange: ProducerInterviewNoChangeRecord = {},
): string {
  return JSON.stringify({ ...result, noChange }, null, 2);
}
