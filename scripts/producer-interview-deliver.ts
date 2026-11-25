#!/usr/bin/env node
/**
 * scripts/producer-interview-deliver.ts — the thin CLI wrapper for the
 * once-only delivery of the batched producer interview
 * (WL-0MWVMRX4X003DKCT, child 3 of WL-0MWTVPK65009NTER).
 *
 * Delivery semantics live in
 * `packages/herdr/src/producer-interview-delivery.ts`; this file owns only
 * argument parsing, snapshot/document input and output.
 *
 * Usage, documentation and the recorded live run live in
 * `docs/dev/downtime-dispatcher.md` → *Producer-interview delivery*.
 *
 * Exit codes: 0 delivered (or already delivered), 1 the delivery was refused
 * or `wl` rejected a comment, 2 usage error or a payload that is not a
 * producer-interview snapshot.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  createProducerInterviewDeliveryIo,
  deliverProducerInterviewBatch,
  prepareProducerInterviewDelivery,
  PRODUCER_INTERVIEW_BATCH_ITEM,
  PRODUCER_INTERVIEW_DELIVERY_AUTHOR,
  PRODUCER_INTERVIEW_REMEDIATION_ITEM,
  ProducerInterviewDeliveryError,
  type ProducerInterviewDeliveryIo,
  type ProducerInterviewDeliveryResult,
} from '../packages/herdr/src/producer-interview-delivery.js';
import {
  parseProducerInterviewSnapshotPayload,
} from './producer-interview-batch-doc.js';
import { producerInterviewBatchDocPath } from '../packages/herdr/src/producer-interview-batch-doc.js';
import type { ProducerInterviewSnapshot } from '../packages/herdr/src/producer-interview-snapshot.js';

/** The `--help` text (also printed on a usage error). */
export const PRODUCER_INTERVIEW_DELIVERY_USAGE = `Producer-interview delivery — send the batch once and record the reference

usage: producer-interview-deliver [--snapshot <path>|-] [--document <path>]
       [--root <path>] [--remediation <id>] [--batch-item <id>]
       [--author <name>] [--dry-run|--json]

Reads the machine JSON payload of the read-only snapshot command
(scripts/producer-interview-snapshot.ts --json), validates that the rendered
batch document (default: docs/dev/producer-interview-batch-<UTC date>.md) is
the artefact for THIS batch, then posts the delivery comment ONCE on the
originating remediation item and ONCE on the batch item.

The comment quotes the batch id (snapshot timestamp), the document path, the
row count, the per-root counts and every invited item id, and states how to
answer (per row number in-session, or on the row's own item), that unanswered
rows stay flagged and that an answer is the authorisation for that row's
clear.

Delivery is idempotent: the comment carries [producer-interview-batch:<id>],
so re-running for the same batch id posts nothing and reports "already
delivered". A document written BEFORE the snapshot it claims is refused as
stale, as is a document for a different batch id or row count.

options:
  --snapshot <path>   Snapshot JSON file; \`-\` (or omitting the flag) reads stdin.
  --document <path>   The rendered batch document (default: from the batch id).
  --root <path>       Worklog root for both recipients (default: cwd).
  --remediation <id>  Originating remediation item (default: ${PRODUCER_INTERVIEW_REMEDIATION_ITEM}).
  --batch-item <id>   Batch item, posted second (default: ${PRODUCER_INTERVIEW_BATCH_ITEM}).
  --author <name>     Comment author (default: ${PRODUCER_INTERVIEW_DELIVERY_AUTHOR}).
  --dry-run           Print the composed comment and post nothing.
  --json              Print the machine delivery result (comment ids, counts).
  -h, --help          Print this help.`;

export interface ProducerInterviewDeliverCliArgs {
  snapshotPath?: string;
  documentPath?: string;
  root?: string;
  remediationItem: string;
  batchItem: string;
  author: string;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

export interface ProducerInterviewDeliverCliIo {
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
  cwd(): string;
  createIo(): ProducerInterviewDeliveryIo;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Parse the argument vector (`--flag value` and `--flag=value` accepted). */
export function parseProducerInterviewDeliverArgs(
  argv: ReadonlyArray<string>,
): { args: ProducerInterviewDeliverCliArgs } | { error: string } {
  let snapshotPath: string | undefined;
  let documentPath: string | undefined;
  let root: string | undefined;
  let remediationItem = PRODUCER_INTERVIEW_REMEDIATION_ITEM;
  let batchItem = PRODUCER_INTERVIEW_BATCH_ITEM;
  let author = PRODUCER_INTERVIEW_DELIVERY_AUTHOR;
  let dryRun = false;
  let json = false;
  let help = false;

  const value = (arg: string, name: string): string | undefined => {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    return undefined;
  };

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
    if (arg === '--snapshot' || arg.startsWith('--snapshot=')) {
      const next = value(arg, '--snapshot') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--snapshot needs a value' };
      snapshotPath = next;
      continue;
    }
    if (arg === '--document' || arg.startsWith('--document=')) {
      const next = value(arg, '--document') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--document needs a value' };
      documentPath = next;
      continue;
    }
    if (arg === '--root' || arg.startsWith('--root=')) {
      const next = value(arg, '--root') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--root needs a value' };
      root = next;
      continue;
    }
    if (arg === '--remediation' || arg.startsWith('--remediation=')) {
      const next = value(arg, '--remediation') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--remediation needs a value' };
      remediationItem = next;
      continue;
    }
    if (arg === '--batch-item' || arg.startsWith('--batch-item=')) {
      const next = value(arg, '--batch-item') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--batch-item needs a value' };
      batchItem = next;
      continue;
    }
    if (arg === '--author' || arg.startsWith('--author=')) {
      const next = value(arg, '--author') ?? argv[++index];
      if (next === undefined || next.length === 0) return { error: '--author needs a value' };
      author = next;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }

  if (dryRun && json) {
    return { error: '--dry-run and --json are mutually exclusive' };
  }
  return {
    args: {
      snapshotPath,
      documentPath,
      root,
      remediationItem,
      batchItem,
      author,
      dryRun,
      json,
      help,
    },
  };
}

async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The production wiring: real files, real `wl`, real streams. */
export function defaultProducerInterviewDeliverCliIo(): ProducerInterviewDeliverCliIo {
  return {
    readStdin: () => readStdin(),
    readFile: (path) => readFile(path, 'utf8'),
    cwd: () => process.cwd(),
    createIo: () => createProducerInterviewDeliveryIo(),
    stdout: (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    stderr: (text: string) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  };
}

/** The human-readable delivery report (comment ids included). */
export function renderProducerInterviewDeliveryReport(
  result: ProducerInterviewDeliveryResult,
): string {
  const lines: string[] = [];
  if (result.alreadyDelivered) {
    lines.push(
      `Already delivered producer interview batch ${result.batchId} — no comments posted.`,
    );
  } else {
    const posted = result.comments.filter((comment) => comment.posted).length;
    lines.push(
      `Delivered producer interview batch ${result.batchId} (${result.rows} row${
        result.rows === 1 ? '' : 's'
      }, ${posted} comment${posted === 1 ? '' : 's'} posted).`,
    );
  }
  for (const comment of result.comments) {
    lines.push(
      `- ${comment.itemId}: ${
        comment.posted ? 'posted comment' : 'comment already present'
      } ${comment.commentId}`,
    );
  }
  return lines.join('\n');
}

/** Run the command; resolves the process exit code. */
export async function runProducerInterviewDeliver(
  argv: ReadonlyArray<string>,
  io: ProducerInterviewDeliverCliIo = defaultProducerInterviewDeliverCliIo(),
): Promise<number> {
  const parsed = parseProducerInterviewDeliverArgs(argv);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${PRODUCER_INTERVIEW_DELIVERY_USAGE}`);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    io.stdout(PRODUCER_INTERVIEW_DELIVERY_USAGE);
    return 0;
  }

  let raw: string;
  try {
    raw =
      args.snapshotPath === undefined || args.snapshotPath === '-'
        ? await io.readStdin()
        : await io.readFile(args.snapshotPath);
  } catch (error) {
    io.stderr(
      `producer-interview-deliver: cannot read snapshot: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }

  let snapshot: ProducerInterviewSnapshot;
  try {
    snapshot = parseProducerInterviewSnapshotPayload(raw);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const root = args.root ?? io.cwd();
  // The default document reference stays repo-relative (it is quoted verbatim
  // in the delivery comment); the IO resolves it against the process cwd.
  const documentPath =
    args.documentPath ?? producerInterviewBatchDocPath(snapshot.generatedAt);
  const deliveryIo = io.createIo();
  const request = {
    batchId: snapshot.generatedAt,
    documentPath,
    snapshot,
    targets: [
      { itemId: args.remediationItem, root },
      { itemId: args.batchItem, root },
    ],
    author: args.author,
  };

  if (args.dryRun) {
    try {
      const prepared = await prepareProducerInterviewDelivery(deliveryIo, request);
      io.stdout(prepared.body);
      return 0;
    } catch (error) {
      return reportFailure(io, error);
    }
  }

  try {
    const result = await deliverProducerInterviewBatch(deliveryIo, request);
    io.stdout(
      args.json ? JSON.stringify(result, null, 2) : renderProducerInterviewDeliveryReport(result),
    );
    return 0;
  } catch (error) {
    return reportFailure(io, error);
  }
}

function reportFailure(io: ProducerInterviewDeliverCliIo, error: unknown): number {
  if (error instanceof ProducerInterviewDeliveryError) {
    io.stderr(`producer-interview-deliver: ${error.message}\n`);
    return 1;
  }
  io.stderr(
    `producer-interview-deliver: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  return 1;
}

/** `main` alias for the direct-invocation entry point. */
export const main = runProducerInterviewDeliver;

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runProducerInterviewDeliver(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `producer-interview-deliver: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
