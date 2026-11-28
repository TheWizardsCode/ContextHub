#!/usr/bin/env node
/**
 * scripts/producer-interview-snapshot.ts — the thin read-only CLI wrapper for
 * the live producer-interview snapshot (WL-0MWVMRVOV0026OWM, child 1 of
 * WL-0MWTVPK65009NTER).
 *
 * Usage, documentation and the recorded live run live in
 * `docs/dev/downtime-dispatcher.md` → *Producer-interview snapshot*. This file
 * owns only argument parsing, root resolution and output; the rule and the
 * evidence reads live in
 * `packages/herdr/src/producer-interview-snapshot.ts`.
 *
 * ## Read-only
 *
 * Every operation is a read: `wl list --needs-producer-review`,
 * `wl comment list`, `wl audit-show`, `wl dep list`. No `wl` write, no flag or
 * assignee mutation, no dispatch marker. The settings path is resolved WITHOUT
 * calling `getDefaultSettingsPath()` (which creates `~/.config/herdr`), so even
 * a missing config is a pure read.
 *
 * ## Output
 *
 * JSON goes to stdout (the machine path for the next child); the markdown table
 * goes to stderr by default. `--markdown` moves the markdown to stdout;
 * `--json` suppresses the markdown.
 *
 * Exit codes: 0 success, 1 one or more roots failed to read (the other roots
 * are still reported), 2 usage error / no roots.
 *
 * Run: `npx tsx scripts/producer-interview-snapshot.ts --now 2026-11-25T12:00:00Z`
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectProducerInterviewSnapshot,
  createProducerInterviewSnapshotIo,
  renderProducerInterviewSnapshotJson,
  renderProducerInterviewSnapshotMarkdown,
  type ProducerInterviewSnapshot,
  type ProducerInterviewSnapshotIo,
} from '../packages/herdr/src/producer-interview-snapshot.js';
import { loadSettings } from '../packages/herdr/src/settings.js';

/** The `--help` text (also printed on a usage error). */
export const PRODUCER_INTERVIEW_USAGE = `Producer-interview snapshot — read-only LIVE producer-review interview list

usage: producer-interview-snapshot [--root <path>]... [--now <iso>] [--json|--markdown]

Re-reads, on every configured active root, each PREP item (stage \`idea\` or
\`intake_complete\`) carrying \`needsProducerReview=true\`, classifies it through
the ONE provenance rule (classifyProducerReviewProvenance +
assembleProducerReviewProvenance), and emits the exact list grouped
\`needs-producer-input\` — item id, root, title, open question text, deciding
evidence comment id and flag age.

options:
  --root <path>   Worklog root to read (the directory CONTAINING .worklog/).
                  Repeatable. When omitted, the \`downtimeWorklogRoots\`
                  active-root registry is used.
  --now <iso>     Frozen evaluation instant (ISO-8601); defaults to the wall
                  clock. The snapshot is LIVE: a row cleared after an earlier
                  snapshot is absent.
  --json          Emit the machine JSON payload only (on stdout).
  --markdown      Emit the markdown table on stdout instead of stderr.
  -h, --help      Print this help.

READ-ONLY
  The only commands issued are the four documented evidence reads:
    wl --worklog-dir <root>/.worklog list --json --needs-producer-review
       --include-not-started
    wl --worklog-dir <root>/.worklog comment list <id> --json
    wl --worklog-dir <root>/.worklog audit-show <id> --json
    wl --worklog-dir <root>/.worklog dep list <id> --json
  No flag is cleared, no item is reassigned and no dispatch marker is written.`;

export interface ProducerInterviewCliArgs {
  roots: string[];
  nowIso?: string;
  json: boolean;
  markdown: boolean;
  help: boolean;
}

export interface ProducerInterviewCliIo {
  createIo(): ProducerInterviewSnapshotIo;
  loadRoots(): string[];
  nowMs(): number;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Parse the argument vector (`--flag value` and `--flag=value` accepted). */
export function parseProducerInterviewArgs(
  argv: ReadonlyArray<string>,
): { args: ProducerInterviewCliArgs } | { error: string } {
  const roots: string[] = [];
  let nowIso: string | undefined;
  let json = false;
  let markdown = false;
  let help = false;

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
    if (arg === '--markdown' || arg === '--md') {
      markdown = true;
      continue;
    }
    if (arg === '--root' || arg.startsWith('--root=')) {
      const value = arg.startsWith('--root=') ? arg.slice('--root='.length) : argv[++index];
      if (value === undefined || value.length === 0) return { error: '--root needs a value' };
      if (!roots.includes(value)) roots.push(value);
      continue;
    }
    if (arg === '--now' || arg.startsWith('--now=')) {
      const value = arg.startsWith('--now=') ? arg.slice('--now='.length) : argv[++index];
      if (value === undefined || value.length === 0) {
        return { error: '--now needs an ISO-8601 instant' };
      }
      nowIso = value;
      continue;
    }
    return { error: `unknown argument: ${arg}` };
  }

  if (json && markdown) {
    return { error: '--json and --markdown are mutually exclusive' };
  }
  return { args: { roots, nowIso, json, markdown, help } };
}

/**
 * Resolve the settings file WITHOUT `getDefaultSettingsPath()`, whose
 * `mkdirSync` would be a write in a read-only command.
 */
function defaultSettingsPath(): string {
  return join(homedir(), '.config', 'herdr', 'worklog-plugin.json');
}

/** The production wiring: real reads, real output, registry roots. */
export function defaultProducerInterviewCliIo(): ProducerInterviewCliIo {
  return {
    createIo: () => createProducerInterviewSnapshotIo(),
    loadRoots: () => loadSettings(defaultSettingsPath()).downtimeWorklogRoots,
    nowMs: () => Date.now(),
    stdout: (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    stderr: (text: string) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  };
}

/** Render the chosen output for one snapshot. */
export function renderProducerInterviewOutput(
  snapshot: ProducerInterviewSnapshot,
  args: Pick<ProducerInterviewCliArgs, 'json' | 'markdown'>,
): { stdout: string; stderr: string } {
  const json = renderProducerInterviewSnapshotJson(snapshot);
  const markdown = renderProducerInterviewSnapshotMarkdown(snapshot);
  if (args.json) return { stdout: json, stderr: '' };
  if (args.markdown) return { stdout: markdown, stderr: '' };
  return { stdout: json, stderr: markdown };
}

/** Run the command; resolves the process exit code. */
export async function main(
  argv: ReadonlyArray<string>,
  io: ProducerInterviewCliIo = defaultProducerInterviewCliIo(),
): Promise<number> {
  const parsed = parseProducerInterviewArgs(argv);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${PRODUCER_INTERVIEW_USAGE}`);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    io.stdout(PRODUCER_INTERVIEW_USAGE);
    return 0;
  }

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
      'No roots to read: pass --root <path> (repeatable) or register the active roots in the `downtimeWorklogRoots` setting of ~/.config/herdr/worklog-plugin.json.\n',
    );
    return 2;
  }

  const snapshot = await collectProducerInterviewSnapshot(io.createIo(), roots, { now });
  const output = renderProducerInterviewOutput(snapshot, args);
  if (output.stdout.length > 0) io.stdout(output.stdout);
  if (output.stderr.length > 0) io.stderr(output.stderr);

  if (snapshot.errors.length > 0) {
    io.stderr(
      `producer-interview snapshot: ${snapshot.errors.length} root(s) failed to read:\n${snapshot.errors
        .map((error) => `- ${error.root}: ${error.error}`)
        .join('\n')}\n`,
    );
    return 1;
  }
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `producer-interview-snapshot: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
