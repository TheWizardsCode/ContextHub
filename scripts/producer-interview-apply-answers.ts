#!/usr/bin/env node
/**
 * scripts/producer-interview-apply-answers.ts — the thin CLI wrapper for
 * applying the producer's batched answers (WL-0MWVMRXUZ0031P1S, child 4 of
 * WL-0MWTVPK65009NTER).
 *
 * The mechanism lives in
 * `packages/herdr/src/producer-answer-capture.ts`; this file owns only argument
 * parsing, the batch answer file, row-number mapping and output.
 *
 * The producer replies once to the batch document. That single reply is
 * transcribed into a batch answer file (row number → answer), then applied
 * deterministically here:
 *
 *     npx tsx scripts/producer-interview-snapshot.ts \
 *       --root … --json > /tmp/producer-interview-snapshot.json
 *     npx tsx scripts/producer-interview-apply-answers.ts \
 *       --snapshot /tmp/producer-interview-snapshot.json \
 *       --answers /tmp/producer-answers.json [--dry-run|--json]
 *
 * Row numbers are the ones in the batch document: roots in codepoint order and
 * the snapshot order within a root. An unanswered row is skipped and stays
 * flagged; a deferral answer ("keep waiting" / "do not proceed") is recorded
 * and the row stays flagged. Nothing is cleared without a recorded answer.
 *
 * Usage, documentation and the recorded live run live in
 * `docs/dev/downtime-dispatcher.md` → *Producer-interview answers*.
 *
 * Exit codes: 0 applied (or dry-run), 1 a mutation was refused/failed, 2 usage
 * error or a payload/answer file that cannot be applied.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  applyProducerAnswer,
  composeProducerAnswerAppendix,
  composeProducerAnswerSummary,
  createProducerAnswerCaptureIo,
  isDeferralAnswer,
  PRODUCER_ANSWER_AUTHOR,
  PRODUCER_ANSWER_DEFAULT_CLEARING_AGENT,
  ProducerAnswerCaptureError,
  recordAppliedAnswersSummary,
  type ProducerAnswerApplyResult,
  type ProducerAnswerCaptureIo,
  type ProducerAnswerSummaryRow,
} from '../packages/herdr/src/producer-answer-capture.js';
import { orderProducerInterviewRowsByRoot } from '../packages/herdr/src/producer-interview-batch-doc.js';
import type {
  ProducerInterviewRow,
  ProducerInterviewSnapshot,
} from '../packages/herdr/src/producer-interview-snapshot.js';
import { parseProducerInterviewSnapshotPayload } from './producer-interview-batch-doc.js';

/** The batch item that records the applied-answers summary by default. */
export const PRODUCER_INTERVIEW_ANSWER_BATCH_ITEM = 'WL-0MWTVPK65009NTER';

/** The `--help` text (also printed on a usage error). */
export const PRODUCER_INTERVIEW_APPLY_ANSWERS_USAGE = `Producer-interview answers — record answers and clear answered holds

usage: producer-interview-apply-answers --answers <path> [--snapshot <path>|-]
       [--summary-item <id>] [--summary-root <path>] [--author <name>]
       [--clearing-agent <name>] [--dry-run|--json]

Reads the machine JSON payload of the read-only snapshot command
(scripts/producer-interview-snapshot.ts --json) and a batch answer file
(row number → answer), records each answer in that row's own worklog
Appendix, and — unless the answer defers — releases the row's
needsProducerReview hold with an audit comment naming the answer.

The batch answer file is JSON:

  {
    "batchId": "<the snapshot generatedAt>",
    "documentPath": "docs/dev/producer-interview-batch-<date>.md",
    "answeringParty": "Map",
    "clearingAgent": "Map",
    "author": "implement",
    "answers": {
      "1": "clear it",
      "3": "keep waiting because the design is not settled",
      "7": { "answer": "clear it", "answerCommentId": "AI-C0..." }
    }
  }

Unanswered rows are skipped and stay flagged. "keep waiting" /
"do not proceed" answers are recorded and leave the row flagged.

options:
  --answers <path>        The batch answer file (required).
  --snapshot <path>       Snapshot JSON file; \`-\` (or omitting) reads stdin.
  --summary-item <id>     Batch item for the applied-answers summary
                          (default: ${PRODUCER_INTERVIEW_ANSWER_BATCH_ITEM}).
  --summary-root <path>   Root of the summary item (default: cwd).
  --author <name>         Comment author (default: ${PRODUCER_ANSWER_AUTHOR}).
  --clearing-agent <name> Agent recorded on each clear (default:
                          ${PRODUCER_ANSWER_DEFAULT_CLEARING_AGENT}).
  --dry-run               Print the plan and compose bodies; write nothing.
  --json                  Print the machine result.
  -h, --help              Print this help.`;

// ── The batch answer file ────────────────────────────────────────────

/** One row's answer: a string, or an object carrying an evidence comment id. */
export type ProducerAnswerValue = string | { answer: string; answerCommentId?: string };

/** The parsed batch answer file. */
export interface ProducerAnswersFile {
  batchId: string;
  documentPath: string;
  answeringParty: string;
  clearingAgent?: string;
  author?: string;
  answers: Record<number, ProducerAnswerValue>;
}

export type ProducerAnswerFileFailureCode =
  | 'answer_file_invalid'
  | 'batch_id_missing'
  | 'batch_id_mismatch'
  | 'document_path_missing'
  | 'answering_party_missing'
  | 'answers_missing'
  | 'row_number_invalid'
  | 'answer_empty'
  | 'row_number_out_of_range';

/** A batch answer file that cannot be applied. */
export class ProducerAnswerFileError extends Error {
  readonly code: ProducerAnswerFileFailureCode;

  constructor(code: ProducerAnswerFileFailureCode, message: string) {
    super(message);
    this.name = 'ProducerAnswerFileError';
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function requiredString(record: Record<string, unknown>, field: string, code: ProducerAnswerFileFailureCode): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProducerAnswerFileError(code, `batch answer file: ${field} is required`);
  }
  return value;
}

/**
 * Parse the batch answer file. Row numbers are 1-based positive integers; the
 * answer text may be a string or `{ answer, answerCommentId? }`.
 */
export function parseProducerAnswerFile(text: string): ProducerAnswersFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProducerAnswerFileError(
      'answer_file_invalid',
      `batch answer file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new ProducerAnswerFileError('answer_file_invalid', 'batch answer file must be a JSON object');
  }

  const batchId = requiredString(record, 'batchId', 'batch_id_missing');
  const documentPath = requiredString(record, 'documentPath', 'document_path_missing');
  const answeringParty = requiredString(record, 'answeringParty', 'answering_party_missing');

  const rawAnswers = asRecord(record.answers);
  if (rawAnswers === null) {
    throw new ProducerAnswerFileError('answers_missing', 'batch answer file: answers must be an object');
  }

  const answers: Record<number, ProducerAnswerValue> = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    const rowNumber = Number(key);
    if (!Number.isInteger(rowNumber) || rowNumber < 1) {
      throw new ProducerAnswerFileError(
        'row_number_invalid',
        `batch answer file: answer key ${JSON.stringify(key)} is not a positive row number`,
      );
    }
    if (typeof value === 'string') {
      if (value.trim().length === 0) {
        throw new ProducerAnswerFileError('answer_empty', `batch answer file: row ${rowNumber} has an empty answer`);
      }
      answers[rowNumber] = value;
      continue;
    }
    const objectValue = asRecord(value);
    if (objectValue === null) {
      throw new ProducerAnswerFileError(
        'answer_file_invalid',
        `batch answer file: row ${rowNumber} must be a string or { answer, answerCommentId? }`,
      );
    }
    const answer = objectValue.answer;
    if (typeof answer !== 'string' || answer.trim().length === 0) {
      throw new ProducerAnswerFileError('answer_empty', `batch answer file: row ${rowNumber} has an empty answer`);
    }
    const mapped: { answer: string; answerCommentId?: string } = { answer };
    const sourceId = objectValue.answerCommentId;
    if (sourceId !== undefined) {
      if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
        throw new ProducerAnswerFileError(
          'answer_file_invalid',
          `batch answer file: row ${rowNumber} answerCommentId must be a non-empty string`,
        );
      }
      mapped.answerCommentId = sourceId;
    }
    answers[rowNumber] = mapped;
  }

  const result: ProducerAnswersFile = {
    batchId,
    documentPath,
    answeringParty,
    answers,
  };
  if (typeof record.clearingAgent === 'string') result.clearingAgent = record.clearingAgent;
  if (typeof record.author === 'string') result.author = record.author;
  return result;
}

// ── Argument parsing ─────────────────────────────────────────────────

export interface ProducerInterviewApplyAnswersCliArgs {
  answersPath?: string;
  snapshotPath?: string;
  summaryItem: string;
  summaryRoot?: string;
  author: string;
  clearingAgent: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

export type ParseArgsResult =
  | { args: ProducerInterviewApplyAnswersCliArgs }
  | { error: string };

/** Parse the argument vector (`--flag value` and `--flag=value` accepted). */
export function parseProducerInterviewApplyAnswersArgs(
  argv: ReadonlyArray<string>,
): ParseArgsResult {
  let answersPath: string | undefined;
  let snapshotPath: string | undefined;
  let summaryItem = PRODUCER_INTERVIEW_ANSWER_BATCH_ITEM;
  let summaryRoot: string | undefined;
  let author = PRODUCER_ANSWER_AUTHOR;
  let clearingAgent = PRODUCER_ANSWER_DEFAULT_CLEARING_AGENT;
  let dryRun = false;
  let json = false;
  let help = false;

  const inline = (arg: string, name: string): string | undefined =>
    arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--answers' || arg.startsWith('--answers=')) {
      const next = inline(arg, '--answers') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--answers needs a value' };
      answersPath = next;
      continue;
    }
    if (arg === '--snapshot' || arg.startsWith('--snapshot=')) {
      const next = inline(arg, '--snapshot') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--snapshot needs a value' };
      snapshotPath = next;
      continue;
    }
    if (arg === '--summary-item' || arg.startsWith('--summary-item=')) {
      const next = inline(arg, '--summary-item') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--summary-item needs a value' };
      summaryItem = next;
      continue;
    }
    if (arg === '--summary-root' || arg.startsWith('--summary-root=')) {
      const next = inline(arg, '--summary-root') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--summary-root needs a value' };
      summaryRoot = next;
      continue;
    }
    if (arg === '--author' || arg.startsWith('--author=')) {
      const next = inline(arg, '--author') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--author needs a value' };
      author = next;
      continue;
    }
    if (arg === '--clearing-agent' || arg.startsWith('--clearing-agent=')) {
      const next = inline(arg, '--clearing-agent') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--clearing-agent needs a value' };
      clearingAgent = next;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }

  if (dryRun && json) {
    return { error: '--dry-run and --json are mutually exclusive' };
  }
  if (!help && answersPath === undefined) {
    return { error: '--answers is required' };
  }
  return {
    args: {
      answersPath,
      snapshotPath,
      summaryItem,
      summaryRoot,
      author,
      clearingAgent,
      dryRun,
      json,
      help,
    },
  };
}

// ── Applying the file ────────────────────────────────────────────────

/** One answered row resolved to its snapshot row and answer. */
export interface ResolvedAnswer {
  rowNumber: number;
  row: ProducerInterviewRow;
  answer: string;
  sourceAnswerCommentId?: string;
}

/**
 * Resolve answer-file row numbers against the snapshot rows, refusing an
 * out-of-range number (the document would then be stale) rather than silently
 * dropping the producer's answer.
 */
export function resolveAnswers(
  answers: ProducerAnswersFile,
  snapshot: ProducerInterviewSnapshot,
): ResolvedAnswer[] {
  const ordered = orderProducerInterviewRowsByRoot(snapshot.interview);
  const resolved: ResolvedAnswer[] = [];
  for (const [key, value] of Object.entries(answers.answers)) {
    const rowNumber = Number(key);
    const row = ordered[rowNumber - 1];
    if (row === undefined) {
      throw new ProducerAnswerFileError(
        'row_number_out_of_range',
        `batch answer file row ${rowNumber} is out of range: the snapshot carries ${ordered.length} rows`,
      );
    }
    const isObject = typeof value === 'object';
    const answer = isObject ? value.answer : value;
    const resolvedAnswer: ResolvedAnswer = { rowNumber, row, answer };
    if (isObject && value.answerCommentId !== undefined) {
      resolvedAnswer.sourceAnswerCommentId = value.answerCommentId;
    }
    resolved.push(resolvedAnswer);
  }
  return resolved.sort((left, right) => left.rowNumber - right.rowNumber);
}

/** The machine result of one CLI run. */
export interface ProducerAnswerApplyCliResult {
  batchId: string;
  documentPath: string;
  answered: number;
  cleared: number;
  deferred: number;
  summaryCommentId: string | null;
  rows: Array<{
    rowNumber: number;
    itemId: string;
    root: string;
    answerCommentId: string;
    clearCommentId: string | null;
    deferral: boolean;
  }>;
}

export interface ProducerInterviewApplyAnswersCliIo {
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
  cwd(): string;
  createIo(): ProducerAnswerCaptureIo;
  stdout(text: string): void;
  stderr(text: string): void;
}

async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The production wiring: real files, real `wl`, real streams. */
export function defaultProducerInterviewApplyAnswersCliIo(): ProducerInterviewApplyAnswersCliIo {
  return {
    readStdin: () => readStdin(),
    readFile: (path) => readFile(path, 'utf8'),
    cwd: () => process.cwd(),
    createIo: () => createProducerAnswerCaptureIo(),
    stdout: (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    stderr: (text: string) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  };
}

/** Render the human-readable run report. */
export function renderProducerAnswerApplyReport(result: ProducerAnswerApplyCliResult): string {
  const lines: string[] = [];
  lines.push(
    `Applied producer answers for batch ${result.batchId}: ${result.answered} answered, ${result.cleared} cleared, ${result.deferred} left flagged.`,
  );
  for (const row of result.rows) {
    lines.push(
      `- row ${row.rowNumber} ${row.itemId} (${row.root}): answer ${row.answerCommentId}${
        row.clearCommentId === null ? ' — left flagged' : ` → clear ${row.clearCommentId}`
      }`,
    );
  }
  if (result.summaryCommentId !== null) {
    lines.push(`Summary recorded: ${result.summaryCommentId}`);
  }
  return lines.join('\n');
}

/**
 * Plan one row without writing: compose the Appendix body and report whether
 * the answer defers. Used by `--dry-run`.
 */
export function planProducerAnswer(resolved: ResolvedAnswer, file: ProducerAnswersFile): {
  rowNumber: number;
  itemId: string;
  root: string;
  deferral: boolean;
  body: string;
} {
  const deferral = isDeferralAnswer(resolved.answer);
  return {
    rowNumber: resolved.rowNumber,
    itemId: resolved.row.id,
    root: resolved.row.root,
    deferral,
    body: composeProducerAnswerAppendix({
      root: resolved.row.root,
      itemId: resolved.row.id,
      batchId: file.batchId,
      question: resolved.row.question,
      answer: resolved.answer,
      answeringParty: file.answeringParty,
      documentPath: file.documentPath,
      ...(resolved.sourceAnswerCommentId === undefined
        ? {}
        : { sourceAnswerCommentId: resolved.sourceAnswerCommentId }),
    }),
  };
}

/** Run the command; resolves the process exit code. */
export async function runProducerInterviewApplyAnswers(
  argv: ReadonlyArray<string>,
  io: ProducerInterviewApplyAnswersCliIo = defaultProducerInterviewApplyAnswersCliIo(),
): Promise<number> {
  const parsed = parseProducerInterviewApplyAnswersArgs(argv);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${PRODUCER_INTERVIEW_APPLY_ANSWERS_USAGE}`);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    io.stdout(PRODUCER_INTERVIEW_APPLY_ANSWERS_USAGE);
    return 0;
  }

  // Read the snapshot and the answer file before any write.
  let snapshotRaw: string;
  let answersRaw: string;
  try {
    snapshotRaw =
      args.snapshotPath === undefined || args.snapshotPath === '-'
        ? await io.readStdin()
        : await io.readFile(args.snapshotPath);
    answersRaw = await io.readFile(args.answersPath as string);
  } catch (error) {
    io.stderr(
      `producer-interview-apply-answers: cannot read input: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }

  let snapshot: ProducerInterviewSnapshot;
  let answers: ProducerAnswersFile;
  try {
    snapshot = parseProducerInterviewSnapshotPayload(snapshotRaw);
    answers = parseProducerAnswerFile(answersRaw);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (answers.batchId !== snapshot.generatedAt) {
    io.stderr(
      `producer-interview-apply-answers: answer file batch id ${answers.batchId} does not match the snapshot generatedAt (${snapshot.generatedAt})\n`,
    );
    return 2;
  }

  let resolved: ResolvedAnswer[];
  try {
    resolved = resolveAnswers(answers, snapshot);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // Dry-run: compose and print, write nothing.
  if (args.dryRun) {
    const plans = resolved.map((entry) => planProducerAnswer(entry, answers));
    const summary = composeProducerAnswerSummary({
      batchId: answers.batchId,
      documentPath: answers.documentPath,
      rows: plans.map((plan) => ({
        itemId: plan.itemId,
        root: plan.root,
        answerCommentId: '(dry-run)',
        clearCommentId: plan.deferral ? null : '(dry-run)',
        deferral: plan.deferral,
      })),
    });
    io.stdout(
      plans
        .map(
          (plan) =>
            `--- row ${plan.rowNumber} ${plan.itemId} (${plan.root}) — ${
              plan.deferral ? 'left flagged' : 'clear'
            }\n\n${plan.body}`,
        )
        .join('\n'),
    );
    io.stdout(`\n${summary}`);
    return 0;
  }

  const captureIo = io.createIo();
  const applied: Array<{ resolved: ResolvedAnswer; result: ProducerAnswerApplyResult }> = [];
  for (const entry of resolved) {
    try {
      const result = await applyProducerAnswer(captureIo, {
        root: entry.row.root,
        itemId: entry.row.id,
        batchId: answers.batchId,
        question: entry.row.question,
        answer: entry.answer,
        answeringParty: answers.answeringParty,
        documentPath: answers.documentPath,
        clearingAgent: args.clearingAgent,
        author: args.author,
        ...(entry.sourceAnswerCommentId === undefined
          ? {}
          : { sourceAnswerCommentId: entry.sourceAnswerCommentId }),
      });
      applied.push({ resolved: entry, result });
    } catch (error) {
      // Report what was recorded before the failure; a re-run is idempotent.
      for (const done of applied) {
        io.stderr(
          `recorded: row ${done.resolved.rowNumber} ${done.resolved.row.id} — answer ${done.result.record.commentId}${
            done.result.clear === null ? '' : ` → clear ${done.result.clear.clearCommentId}`
          }\n`,
        );
      }
      if (error instanceof ProducerAnswerCaptureError) {
        io.stderr(`producer-interview-apply-answers: ${error.message}\n`);
      } else {
        io.stderr(
          `producer-interview-apply-answers: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      return 1;
    }
  }

  const summaryRows: ProducerAnswerSummaryRow[] = applied.map(({ resolved: entry, result }) => ({
    itemId: entry.row.id,
    root: entry.row.root,
    answerCommentId: result.record.commentId,
    clearCommentId: result.clear === null ? null : result.clear.clearCommentId,
    deferral: result.deferral,
  }));

  let summaryCommentId: string | null = null;
  try {
    const summary = await recordAppliedAnswersSummary(captureIo, {
      root: args.summaryRoot ?? io.cwd(),
      batchItemId: args.summaryItem,
      batchId: answers.batchId,
      documentPath: answers.documentPath,
      rows: summaryRows,
      author: args.author,
    });
    summaryCommentId = summary.id;
  } catch (error) {
    if (error instanceof ProducerAnswerCaptureError) {
      io.stderr(`producer-interview-apply-answers: ${error.message}\n`);
    } else {
      io.stderr(
        `producer-interview-apply-answers: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return 1;
  }

  const cliResult: ProducerAnswerApplyCliResult = {
    batchId: answers.batchId,
    documentPath: answers.documentPath,
    answered: applied.length,
    cleared: applied.filter((entry) => !entry.result.deferral).length,
    deferred: applied.filter((entry) => entry.result.deferral).length,
    summaryCommentId,
    rows: applied.map(({ resolved: entry, result }) => ({
      rowNumber: entry.rowNumber,
      itemId: entry.row.id,
      root: entry.row.root,
      answerCommentId: result.record.commentId,
      clearCommentId: result.clear === null ? null : result.clear.clearCommentId,
      deferral: result.deferral,
    })),
  };

  io.stdout(args.json ? JSON.stringify(cliResult, null, 2) : renderProducerAnswerApplyReport(cliResult));
  return 0;
}

/** `main` alias for the direct-invocation entry point. */
export const main = runProducerInterviewApplyAnswers;

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runProducerInterviewApplyAnswers(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `producer-interview-apply-answers: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
