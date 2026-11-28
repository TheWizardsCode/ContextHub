#!/usr/bin/env node
/**
 * scripts/producer-interview-batch-doc.ts — the thin CLI wrapper for the
 * batched producer-interview document (WL-0MWVMRWEU005LDYP, child 2 of
 * WL-0MWTVPK65009NTER).
 *
 * The renderer and its contract live in
 * `packages/herdr/src/producer-interview-batch-doc.ts`; this file owns only
 * argument parsing, snapshot input and output.
 *
 * Input is the machine payload of the read-only snapshot command, so the
 * document always renders from the live list rather than a hand-copied one:
 *
 *     npx tsx scripts/producer-interview-snapshot.ts --json \
 *       | npx tsx scripts/producer-interview-batch-doc.ts
 *
 * Usage, documentation and the recorded live run live in
 * `docs/dev/downtime-dispatcher.md` → *Producer-interview batch document*.
 *
 * Exit codes: 0 success, 1 an input/output failure, 2 usage error or a
 * payload that is not a producer-interview snapshot.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  producerInterviewBatchDocPath,
  renderProducerInterviewBatchDoc,
} from '../packages/herdr/src/producer-interview-batch-doc.js';
import type {
  ProducerInterviewRow,
  ProducerInterviewSnapshot,
} from '../packages/herdr/src/producer-interview-snapshot.js';

/** The `--help` text (also printed on a usage error). */
export const PRODUCER_INTERVIEW_BATCH_DOC_USAGE = `Producer-interview batch document — render the producer's answer sheet

usage: producer-interview-batch-doc [--snapshot <path>|-] [--out <path>] [--stdout|--json]

Reads the machine JSON payload of the read-only snapshot command
(scripts/producer-interview-snapshot.ts --json), renders one deterministic
markdown document with every needs-producer-input row grouped by root and
numbered, and writes it to docs/dev/producer-interview-batch-<UTC date>.md.

Per row the document carries the open question text, the deciding evidence
comment id, the item's root and title, and exactly one
\`**Recommended:** <option> — <one-line rationale>\` line marked advisory only.
Rows with no surviving evidence render the fail-closed question instead of
being dropped.

options:
  --snapshot <path>  Snapshot JSON file; \`-\` (or omitting the flag) reads stdin.
  --out <path>       Write here instead of the documented default path.
  --stdout           Print the markdown to stdout and write no file.
  --json             Write the file and print { documentPath, rows, roots }.
  -h, --help         Print this help.

The document states up front how to answer (reply per row number), that
unanswered rows stay flagged and that answering a row authorises its clear.`;

export interface ProducerInterviewBatchDocCliArgs {
  snapshotPath?: string;
  outPath?: string;
  stdout: boolean;
  json: boolean;
  help: boolean;
}

export interface ProducerInterviewBatchDocCliIo {
  readStdin(): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  cwd(): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Parse the argument vector (`--flag value` and `--flag=value` accepted). */
export function parseProducerInterviewBatchDocArgs(
  argv: ReadonlyArray<string>,
): { args: ProducerInterviewBatchDocCliArgs } | { error: string } {
  let snapshotPath: string | undefined;
  let outPath: string | undefined;
  let stdout = false;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--stdout') {
      stdout = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--snapshot' || arg.startsWith('--snapshot=')) {
      const value = arg.startsWith('--snapshot=') ? arg.slice('--snapshot='.length) : argv[++index];
      if (value === undefined || value.length === 0) return { error: '--snapshot needs a value' };
      snapshotPath = value;
      continue;
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg.startsWith('--out=') ? arg.slice('--out='.length) : argv[++index];
      if (value === undefined || value.length === 0) return { error: '--out needs a value' };
      outPath = value;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }

  if (stdout && json) {
    return { error: '--stdout and --json are mutually exclusive' };
  }
  return { args: { snapshotPath, outPath, stdout, json, help } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function invalidPayload(): Error {
  return new Error('not a producer-interview snapshot payload');
}

/**
 * Accept exactly the renderer's input: the snapshot payload's `generatedAt`
 * and `interview` rows. The remaining snapshot fields are filled with neutral
 * values when absent, so a trimmed payload still renders.
 */
export function parseProducerInterviewSnapshotPayload(text: string): ProducerInterviewSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidPayload();
  }
  const record = asRecord(parsed);
  if (record === null) throw invalidPayload();
  if (typeof record.generatedAt !== 'string' || record.generatedAt.length === 0) {
    throw invalidPayload();
  }
  if (!Array.isArray(record.interview)) throw invalidPayload();

  const interview: ProducerInterviewRow[] = [];
  for (const raw of record.interview) {
    const entry = asRecord(raw);
    if (entry === null) throw invalidPayload();
    const { id, root, title, question, evidenceCommentId, flagAge, holds } = entry;
    if (
      typeof id !== 'string' ||
      typeof root !== 'string' ||
      typeof title !== 'string' ||
      typeof question !== 'string' ||
      !(typeof evidenceCommentId === 'string' || evidenceCommentId === null) ||
      typeof flagAge !== 'string'
    ) {
      throw invalidPayload();
    }
    const row: ProducerInterviewRow = {
      id,
      root,
      title,
      question,
      evidenceCommentId,
      flagAge,
    };
    if (Array.isArray(holds) && holds.every((value) => typeof value === 'string')) {
      row.holds = [...holds];
    }
    interview.push(row);
  }

  const roots = Array.isArray(record.roots)
    ? (record.roots as ProducerInterviewSnapshot['roots'])
    : [];
  const counts = asRecord(record.counts);
  return {
    generatedAt: record.generatedAt,
    roots,
    counts: {
      'needs-producer-input':
        typeof counts?.['needs-producer-input'] === 'number'
          ? counts['needs-producer-input']
          : interview.length,
      'can-clear-now': typeof counts?.['can-clear-now'] === 'number' ? counts['can-clear-now'] : 0,
    },
    flaggedTotal: typeof record.flaggedTotal === 'number' ? record.flaggedTotal : interview.length,
    skippedNotPrep: typeof record.skippedNotPrep === 'number' ? record.skippedNotPrep : 0,
    classified: Array.isArray(record.classified)
      ? (record.classified as ProducerInterviewSnapshot['classified'])
      : [],
    interview,
    errors: Array.isArray(record.errors)
      ? (record.errors as ProducerInterviewSnapshot['errors'])
      : [],
  };
}

/** The grouped roots in the document's rendering order. */
function documentRoots(snapshot: ProducerInterviewSnapshot): string[] {
  return [...new Set(snapshot.interview.map((row) => row.root))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The production wiring: real files, real streams. */
export function defaultProducerInterviewBatchDocCliIo(): ProducerInterviewBatchDocCliIo {
  return {
    readStdin: () => readStdin(),
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    },
    cwd: () => process.cwd(),
    stdout: (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    stderr: (text: string) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  };
}

/** Run the command; resolves the process exit code. */
export async function runProducerInterviewBatchDoc(
  argv: ReadonlyArray<string>,
  io: ProducerInterviewBatchDocCliIo = defaultProducerInterviewBatchDocCliIo(),
): Promise<number> {
  const parsed = parseProducerInterviewBatchDocArgs(argv);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${PRODUCER_INTERVIEW_BATCH_DOC_USAGE}`);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    io.stdout(PRODUCER_INTERVIEW_BATCH_DOC_USAGE);
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
      `producer-interview-batch-doc: cannot read snapshot: ${
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

  const markdown = renderProducerInterviewBatchDoc(snapshot);
  if (args.stdout) {
    io.stdout(markdown);
    return 0;
  }

  const documentPath =
    args.outPath ?? join(io.cwd(), producerInterviewBatchDocPath(snapshot.generatedAt));
  try {
    await io.writeFile(documentPath, markdown);
  } catch (error) {
    io.stderr(
      `producer-interview-batch-doc: cannot write ${documentPath}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }

  const rows = snapshot.interview.length;
  if (args.json) {
    io.stdout(
      JSON.stringify({ documentPath, rows, roots: documentRoots(snapshot) }, null, 2),
    );
  } else {
    io.stdout(`Wrote ${documentPath} (${rows} row${rows === 1 ? '' : 's'})`);
  }
  return 0;
}

/** `main` alias for the direct-invocation entry point. */
export const main = runProducerInterviewBatchDoc;

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runProducerInterviewBatchDoc(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `producer-interview-batch-doc: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
