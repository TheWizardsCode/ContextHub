#!/usr/bin/env node
/**
 * scripts/producer-interview-reconcile.ts — the thin CLI wrapper for the
 * post-batch reconciliation and no-change verification (WL-0MWVMRYL60019FD1,
 * child 5 of WL-0MWTVPK65009NTER).
 *
 * The rule lives in
 * `packages/herdr/src/producer-interview-reconcile.ts`; this file owns only
 * argument parsing, the fresh snapshot re-run, the git diff assertion, output
 * and the idempotent recording of the table on the batch item.
 *
 *     npx tsx scripts/producer-interview-snapshot.ts --root … --json \
 *       > /tmp/producer-interview-snapshot-before.json
 *     # … deliver the batch, collect answers, apply them …
 *     npx tsx scripts/producer-interview-reconcile.ts \
 *       --before /tmp/producer-interview-snapshot-before.json \
 *       --applied /tmp/producer-applied-answers.json \
 *       --root ... --changed-range <before-batch>..HEAD \
 *       [--summary-item WL-0MWTVPK65009NTER] [--post] [--json|--dry-run]
 *
 * The command re-runs the snapshot LIVE (the AFTER state), diffs it against the
 * frozen BEFORE snapshot, checks every cleared row links to its answer entry and
 * clear comment, asserts every unanswered row still carries
 * `needsProducerReview=true` and still groups `needs-producer-input`, and
 * asserts the batch's change set never touched dispatcher gating, audit budget
 * or dispatcher-selection code paths.
 *
 * It is verification and reporting only: no flag is cleared and no item is
 * re-created. When the producer has not answered, it legitimately reports
 * "0 cleared, N still flagged".
 *
 * Exit codes: 0 reconciled (or dry-run), 1 reconciliation failure or protected
 * path change, 2 usage error or an unreadable/mismatched input.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CLI_BINARIES,
  DEFAULT_CLI_TIMEOUT_MS,
  spawnCliStdout,
} from '../packages/herdr/src/cli-spawn.js';
import { buildWlArgsForRoot, getExecFileAsync } from '../packages/herdr/src/fetcher.args.js';
import {
  collectProducerInterviewSnapshot,
  createProducerInterviewSnapshotIo,
  type ProducerInterviewSnapshot,
} from '../packages/herdr/src/producer-interview-snapshot.js';
import {
  findDispatcherProtectedChanges,
  PRODUCER_INTERVIEW_RECONCILE_AUTHOR,
  PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM,
  reconcileProducerInterviewBatch,
  renderProducerInterviewReconciliationJson,
  renderProducerInterviewReconciliationMarkdown,
  type ProducerInterviewAnswerLink,
  type ProducerInterviewNoChangeRecord,
  type ProducerInterviewReconciliation,
} from '../packages/herdr/src/producer-interview-reconcile.js';
import { parseCommentListOutput } from '../packages/herdr/src/producer-interview-snapshot.js';
import { loadSettings } from '../packages/herdr/src/settings.js';
import { parseProducerInterviewSnapshotPayload } from './producer-interview-batch-doc.js';

/** Upper bound for one `wl` read (a long comment trail can exceed 1 MB). */
export const PRODUCER_INTERVIEW_RECONCILE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** The `--help` text (also printed on a usage error). */
export const PRODUCER_INTERVIEW_RECONCILE_USAGE = `Producer-interview reconciliation — verify the batch and assert no dispatcher change

usage: producer-interview-reconcile --before <snapshot.json> [--applied <answers.json>]
       [--root <path>]... [--now <iso>] [--changed-range <git-range>]
       [--summary-item <id>] [--summary-root <path>] [--author <name>]
       [--post] [--json|--dry-run]

Reads the batch's frozen BEFORE snapshot and re-runs the LIVE snapshot command
as the AFTER state. It diffs the two grouped sets and records, per root:
flagged before, cleared against an answer, still flagged and the total invited.

options:
  --before <path>         The frozen BEFORE snapshot JSON (required).
  --applied <path>        The apply-answers machine result (--json) carrying the
                          answer-entry and clear-comment links per answered row.
                          Omit it to assert a no-answer run (0 cleared).
  --root <path>           Worklog root to re-read (repeatable; defaults to the
                          \`downtimeWorklogRoots\` registry).
  --now <iso>             Frozen evaluation instant for the AFTER re-run.
  --changed-range <range> Git range (for example <before-batch>..HEAD) over
                          which the protected-path no-change assertion runs.
  --summary-item <id>     Item the reconciliation comment is recorded on
                          (default: ${PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM}).
  --summary-root <path>   Root of the summary item (default: cwd).
  --author <name>         Comment author (default: ${PRODUCER_INTERVIEW_RECONCILE_AUTHOR}).
  --post                  Record/update the reconciliation comment on the
                          summary item (idempotent by batch id).
  --json                  Print the machine result instead of the markdown.
  --dry-run               Print the markdown and write nothing.
  -h, --help              Print this help.

A row that left needs-producer-input with no answer link FAILS the check rather
than being reported as reconciled. Exit 1 on any reconciliation failure or
protected-path change.`;

// ── Argument parsing ────────────────────────────────────────────────

export interface ProducerInterviewReconcileCliArgs {
  beforePath: string;
  appliedPath?: string;
  roots: string[];
  nowIso?: string;
  changedRange?: string;
  summaryItem: string;
  summaryRoot?: string;
  author: string;
  post: boolean;
  json: boolean;
  dryRun: boolean;
  help: boolean;
}

function inlineArg(arg: string, name: string): string | undefined {
  return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
}

/** Parse the argument vector (`--flag value` and `--flag=value` accepted). */
export function parseProducerInterviewReconcileArgs(
  argv: ReadonlyArray<string>,
): { args: ProducerInterviewReconcileCliArgs } | { error: string } {
  const roots: string[] = [];
  let beforePath: string | undefined;
  let appliedPath: string | undefined;
  let nowIso: string | undefined;
  let changedRange: string | undefined;
  let summaryItem = PRODUCER_INTERVIEW_RECONCILE_SUMMARY_ITEM;
  let summaryRoot: string | undefined;
  let author = PRODUCER_INTERVIEW_RECONCILE_AUTHOR;
  let post = false;
  let json = false;
  let dryRun = false;
  let help = false;

  const take = (arg: string, name: string, index: number): string | undefined =>
    inlineArg(arg, name) ?? argv[index];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--post') {
      post = true;
      continue;
    }
    if (arg === '--before' || arg.startsWith('--before=')) {
      const value = take(arg, '--before', ++index);
      if (value === undefined || value.length === 0) return { error: '--before needs a value' };
      beforePath = value;
      continue;
    }
    if (arg === '--applied' || arg.startsWith('--applied=')) {
      const value = take(arg, '--applied', ++index);
      if (value === undefined || value.length === 0) return { error: '--applied needs a value' };
      appliedPath = value;
      continue;
    }
    if (arg === '--root' || arg.startsWith('--root=')) {
      const value = take(arg, '--root', ++index);
      if (value === undefined || value.length === 0) return { error: '--root needs a value' };
      if (!roots.includes(value)) roots.push(value);
      continue;
    }
    if (arg === '--now' || arg.startsWith('--now=')) {
      const value = take(arg, '--now', ++index);
      if (value === undefined || value.length === 0) {
        return { error: '--now needs an ISO-8601 instant' };
      }
      nowIso = value;
      continue;
    }
    if (arg === '--changed-range' || arg.startsWith('--changed-range=')) {
      const value = take(arg, '--changed-range', ++index);
      if (value === undefined || value.length === 0) {
        return { error: '--changed-range needs a git range' };
      }
      changedRange = value;
      continue;
    }
    if (arg === '--summary-item' || arg.startsWith('--summary-item=')) {
      const value = take(arg, '--summary-item', ++index);
      if (value === undefined || value.length === 0) {
        return { error: '--summary-item needs a value' };
      }
      summaryItem = value;
      continue;
    }
    if (arg === '--summary-root' || arg.startsWith('--summary-root=')) {
      const value = take(arg, '--summary-root', ++index);
      if (value === undefined || value.length === 0) {
        return { error: '--summary-root needs a value' };
      }
      summaryRoot = value;
      continue;
    }
    if (arg === '--author' || arg.startsWith('--author=')) {
      const value = take(arg, '--author', ++index);
      if (value === undefined || value.length === 0) return { error: '--author needs a value' };
      author = value;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }

  if (json && dryRun) return { error: '--json and --dry-run are mutually exclusive' };
  if (post && json) return { error: '--post and --json are mutually exclusive' };
  if (post && dryRun) return { error: '--post and --dry-run are mutually exclusive' };
  if (!help && (beforePath === undefined || beforePath.length === 0)) {
    return { error: '--before is required' };
  }

  return {
    args: {
      beforePath: beforePath as string,
      ...(appliedPath === undefined ? {} : { appliedPath }),
      roots,
      ...(nowIso === undefined ? {} : { nowIso }),
      ...(changedRange === undefined ? {} : { changedRange }),
      summaryItem,
      ...(summaryRoot === undefined ? {} : { summaryRoot }),
      author,
      post,
      json,
      dryRun,
      help,
    },
  };
}

// ── The applied-answers file ────────────────────────────────────────

/** The subset of the apply-answers machine result the reconciliation reads. */
export interface ProducerAppliedAnswersFile {
  batchId: string;
  rows: ProducerInterviewAnswerLink[];
}

export class ProducerAppliedAnswersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProducerAppliedAnswersError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Parse the `producer-interview-apply-answers --json` payload into the answer
 * links the reconciliation needs. A malformed payload is a hard error: a
 * reconciliation computed from half-read links would be worse than none.
 */
export function parseProducerAppliedAnswers(text: string): ProducerAppliedAnswersFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProducerAppliedAnswersError('applied-answers file is not valid JSON');
  }
  const record = asRecord(parsed);
  if (record === null || typeof record.batchId !== 'string' || !Array.isArray(record.rows)) {
    throw new ProducerAppliedAnswersError(
      'applied-answers file must carry batchId and a rows array',
    );
  }
  const rows: ProducerInterviewAnswerLink[] = [];
  for (const raw of record.rows) {
    const entry = asRecord(raw);
    if (
      entry === null ||
      typeof entry.itemId !== 'string' ||
      typeof entry.root !== 'string' ||
      typeof entry.answerCommentId !== 'string' ||
      !(typeof entry.clearCommentId === 'string' || entry.clearCommentId === null) ||
      typeof entry.deferral !== 'boolean'
    ) {
      throw new ProducerAppliedAnswersError('applied-answers row is malformed');
    }
    rows.push({
      itemId: entry.itemId,
      root: entry.root,
      answerCommentId: entry.answerCommentId,
      clearCommentId: entry.clearCommentId,
      deferral: entry.deferral,
    });
  }
  return { batchId: record.batchId, rows };
}

// ── IO seam ─────────────────────────────────────────────────────────

export interface ProducerInterviewReconcileCommentRef {
  id: string;
  comment: string;
}

export interface ProducerInterviewReconcileCliIo {
  readFile(path: string): Promise<string>;
  cwd(): string;
  loadRoots(): string[];
  nowMs(): number;
  collectSnapshot(roots: string[], now: number): Promise<ProducerInterviewSnapshot>;
  /** Every id still carrying `needsProducerReview=true` across the roots. */
  readFlaggedIds(roots: string[]): Promise<Set<string>>;
  /** `git diff --name-only <range>`. */
  runGitDiffNames(range: string): Promise<string[]>;
  listComments(root: string, itemId: string): Promise<ReadonlyArray<ProducerInterviewReconcileCommentRef>>;
  addComment(input: {
    root: string;
    itemId: string;
    body: string;
    author: string;
  }): Promise<ProducerInterviewReconcileCommentRef>;
  updateComment(input: {
    root: string;
    commentId: string;
    body: string;
  }): Promise<ProducerInterviewReconcileCommentRef>;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Resolve the settings file WITHOUT creating `~/.config/herdr`. */
function defaultSettingsPath(): string {
  return join(homedir(), '.config', 'herdr', 'worklog-plugin.json');
}

function parseAddedComment(stdout: string): ProducerInterviewReconcileCommentRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const comment = record === null ? null : asRecord(record.comment);
  if (comment === null || typeof comment.id !== 'string' || comment.id.length === 0) {
    return null;
  }
  return { id: comment.id, comment: typeof comment.comment === 'string' ? comment.comment : '' };
}

/** The production wiring: real files, real `wl`, real git, real streams. */
export function defaultProducerInterviewReconcileCliIo(): ProducerInterviewReconcileCliIo {
  const exec = getExecFileAsync();

  async function runWl(root: string, args: string[]): Promise<string> {
    return spawnCliStdout(exec, CLI_BINARIES, buildWlArgsForRoot(root, args), {
      timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
      maxBuffer: PRODUCER_INTERVIEW_RECONCILE_MAX_BUFFER_BYTES,
    });
  }

  return {
    readFile: (path) => readFile(path, 'utf8'),
    cwd: () => process.cwd(),
    loadRoots: () => loadSettings(defaultSettingsPath()).downtimeWorklogRoots,
    nowMs: () => Date.now(),
    collectSnapshot: (roots, now) =>
      collectProducerInterviewSnapshot(createProducerInterviewSnapshotIo(), roots, { now }),
    async readFlaggedIds(roots) {
      const snapshotIo = createProducerInterviewSnapshotIo();
      const ids = new Set<string>();
      for (const root of roots) {
        const flagged = await snapshotIo.listFlagged(root);
        for (const item of flagged) ids.add(item.id);
      }
      return ids;
    },
    async runGitDiffNames(range) {
      const stdout = await spawnCliStdout(exec, ['git'], ['diff', '--name-only', range], {
        timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
        maxBuffer: PRODUCER_INTERVIEW_RECONCILE_MAX_BUFFER_BYTES,
      });
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },
    async listComments(root, itemId) {
      const stdout = await runWl(root, ['comment', 'list', itemId, '--json']);
      const comments = parseCommentListOutput(stdout);
      if (comments === null) {
        throw new Error(`unparseable wl comment list --json output for ${itemId}`);
      }
      return comments.map((comment) => ({ id: comment.id, comment: comment.comment }));
    },
    async addComment({ root, itemId, body, author }) {
      const stdout = await runWl(root, [
        'comment',
        'add',
        itemId,
        '--comment',
        body,
        '--author',
        author,
        '--json',
      ]);
      const created = parseAddedComment(stdout);
      if (created === null) {
        throw new Error(`unparseable wl comment add --json output for ${itemId}`);
      }
      return created;
    },
    async updateComment({ root, commentId, body }) {
      const stdout = await runWl(root, [
        'comment',
        'update',
        commentId,
        '--comment',
        body,
        '--json',
      ]);
      const updated = parseAddedComment(stdout);
      if (updated === null) {
        throw new Error(`unparseable wl comment update --json output for ${commentId}`);
      }
      return updated;
    },
    stdout: (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    stderr: (text) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  };
}

// ── Recording ───────────────────────────────────────────────────────

/**
 * Record the reconciliation comment on the batch item, idempotently. An
 * existing comment carrying this batch's marker is updated in place; a
 * previous batch's comment is left alone.
 */
export async function recordProducerInterviewReconciliation(
  io: ProducerInterviewReconcileCliIo,
  input: {
    root: string;
    itemId: string;
    body: string;
    marker: string;
    author: string;
  },
): Promise<{ commentId: string; posted: boolean }> {
  const comments = await io.listComments(input.root, input.itemId);
  const existing = comments.find((comment) => comment.comment.includes(input.marker));
  if (existing !== undefined) {
    await io.updateComment({
      root: input.root,
      commentId: existing.id,
      body: input.body,
    });
    return { commentId: existing.id, posted: false };
  }
  const created = await io.addComment({
    root: input.root,
    itemId: input.itemId,
    body: input.body,
    author: input.author,
  });
  return { commentId: created.id, posted: true };
}

// ── Run ─────────────────────────────────────────────────────────────

/** The machine result of one CLI run. */
export interface ProducerInterviewReconcileCliResult {
  result: ProducerInterviewReconciliation;
  noChange: ProducerInterviewNoChangeRecord;
  markdown: string;
  commentId: string | null;
  posted: boolean;
}

function noChangeRecord(
  changedRange: string | undefined,
  changedPaths: ReadonlyArray<string>,
): ProducerInterviewNoChangeRecord {
  if (changedRange === undefined) return {};
  return {
    changedRange,
    changedPaths,
    protectedChanged: findDispatcherProtectedChanges(changedPaths),
  };
}

/** Run the command; resolves the process exit code. */
export async function runProducerInterviewReconcile(
  argv: ReadonlyArray<string>,
  io: ProducerInterviewReconcileCliIo = defaultProducerInterviewReconcileCliIo(),
): Promise<number> {
  const parsed = parseProducerInterviewReconcileArgs(argv);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${PRODUCER_INTERVIEW_RECONCILE_USAGE}`);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    io.stdout(PRODUCER_INTERVIEW_RECONCILE_USAGE);
    return 0;
  }

  // Read the frozen BEFORE snapshot and the applied-answers links.
  let beforeRaw: string;
  let applied: ProducerAppliedAnswersFile = { batchId: '', rows: [] };
  try {
    beforeRaw = await io.readFile(args.beforePath);
    if (args.appliedPath !== undefined) {
      applied = parseProducerAppliedAnswers(await io.readFile(args.appliedPath));
    }
  } catch (error) {
    io.stderr(
      `producer-interview-reconcile: cannot read input: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 2;
  }

  let before: ProducerInterviewSnapshot;
  try {
    before = parseProducerInterviewSnapshotPayload(beforeRaw);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (args.appliedPath !== undefined && applied.batchId !== before.generatedAt) {
    io.stderr(
      `producer-interview-reconcile: applied-answers batch id ${applied.batchId} does not match the BEFORE snapshot (${before.generatedAt})\n`,
    );
    return 2;
  }

  // Resolve roots and the AFTER evaluation instant.
  let now = io.nowMs();
  if (args.nowIso !== undefined) {
    now = Date.parse(args.nowIso);
    if (!Number.isFinite(now)) {
      io.stderr(`--now: not an ISO-8601 instant: ${args.nowIso}\n`);
      return 2;
    }
  }
  const roots = args.roots.length > 0 ? args.roots : io.loadRoots();
  if (roots.length === 0) {
    io.stderr(
      'No roots to re-read: pass --root <path> (repeatable) or register the active roots in the `downtimeWorklogRoots` setting of ~/.config/herdr/worklog-plugin.json.\n',
    );
    return 2;
  }

  let after: ProducerInterviewSnapshot;
  let flaggedIds: Set<string>;
  try {
    after = await io.collectSnapshot(roots, now);
    flaggedIds = await io.readFlaggedIds(roots);
  } catch (error) {
    io.stderr(
      `producer-interview-reconcile: the fresh snapshot re-run failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }

  const afterFlags: ReadonlyMap<string, boolean> = new Map(
    [...flaggedIds].map((id) => [id, true] as const),
  );

  const result = reconcileProducerInterviewBatch({
    before,
    after,
    answers: applied.rows,
    afterFlags,
  });

  // The no-change assertion over the batch's diff range.
  let changedPaths: string[] = [];
  if (args.changedRange !== undefined) {
    try {
      changedPaths = await io.runGitDiffNames(args.changedRange);
    } catch (error) {
      io.stderr(
        `producer-interview-reconcile: git diff --name-only ${args.changedRange} failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 1;
    }
  }
  const noChange = noChangeRecord(args.changedRange, changedPaths);
  const protectedChanged = noChange.protectedChanged ?? [];
  const valid = result.valid && protectedChanged.length === 0;

  const markdown = renderProducerInterviewReconciliationMarkdown(result, noChange);
  const json = renderProducerInterviewReconciliationJson(result, noChange);

  // Report every failure on stderr. A failed check is still RECORDED (the body
  // is explicitly marked `Validity: FAILED`), never reported as reconciled.
  if (result.errors.length > 0) {
    io.stderr(
      `producer-interview-reconcile: ${result.errors.length} reconciliation failure(s):\n${result.errors
        .map((error) => `- ${error.code} ${error.itemId}: ${error.message}`)
        .join('\n')}\n`,
    );
  }
  if (protectedChanged.length > 0) {
    io.stderr(
      `producer-interview-reconcile: the batch modified protected dispatcher path(s): ${protectedChanged.join(
        ', ',
      )}\n`,
    );
  }

  if (args.dryRun) {
    io.stdout(markdown);
    return valid ? 0 : 1;
  }

  if (args.json) {
    io.stdout(json);
    return valid ? 0 : 1;
  }

  let commentId: string | null = null;
  let posted = false;
  if (args.post) {
    try {
      const recorded = await recordProducerInterviewReconciliation(io, {
        root: args.summaryRoot ?? io.cwd(),
        itemId: args.summaryItem,
        body: markdown,
        marker: result.marker,
        author: args.author,
      });
      commentId = recorded.commentId;
      posted = recorded.posted;
    } catch (error) {
      io.stderr(
        `producer-interview-reconcile: cannot record the reconciliation on ${args.summaryItem}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 1;
    }
  }

  io.stdout(markdown);
  if (commentId !== null) {
    io.stdout(
      `Reconciliation recorded on ${args.summaryItem}: ${commentId} (${posted ? 'posted' : 'updated'})\n`,
    );
  }
  return valid ? 0 : 1;
}

/** `main` alias for the direct-invocation entry point. */
export const main = runProducerInterviewReconcile;

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runProducerInterviewReconcile(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `producer-interview-reconcile: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
