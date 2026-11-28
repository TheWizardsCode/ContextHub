#!/usr/bin/env node
/**
 * packages/herdr/src/prep-supply-report-cli.ts — the read-only per-root
 * prep-supply report command (WL-0MWTBJ7G1004Y29B, child 2 of
 * WL-0MWTAD1KM0081UUD).
 *
 * Usage, documentation and the bucket table live in
 * `docs/dev/downtime-dispatcher.md` → *Prep-supply report command*; this file
 * owns only argument parsing, root resolution and output.
 *
 * ## Replayable
 *
 * `--now <iso>` freezes the evaluation instant, so a past dispatch window (the
 * root's rolling dispatch log plus the item state read at that `--now`) can be
 * reproduced and diffed. `--root <path>` is repeatable; when it is omitted the
 * `downtimeWorklogRoots` active-root registry is used.
 *
 * ## Read-only
 *
 * Every operation is a read: `wl worklist --json`, the per-root fallback
 * `wl list --json`, dependency edges (in-process or `wl dep list`) and the
 * rolling dispatch log. No `wl` write, no marker/flag/assignee mutation, no
 * dispatch decision. The settings path is resolved WITHOUT calling
 * `getDefaultSettingsPath()` (which creates `~/.config/herdr`), so even a
 * missing config is a pure read.
 *
 * Exit codes: 0 success, 1 one or more roots failed to read (the other roots
 * are still reported), 2 usage error / no roots.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectPrepSupplyReport,
  renderPrepSupplyReportJson,
  renderPrepSupplyReportTable,
  type PrepSupplyReportDeps,
} from './downtime-worker.prep-supply-report.js';
import {
  PREP_SUPPLY_FALLBACK_STATUSES,
  createPrepSupplyReportDeps,
} from './downtime-worker.prep-supply-source.js';
import { loadSettings } from './settings.js';

/** The `--help` text (also printed on a usage error). */
export const PREP_SUPPLY_USAGE = `Prep-supply report — read-only per-root plan/intake supply (WL-0MWTBJ7G1004Y29B)

usage: worklog-prep-supply [--root <path>]... [--now <iso>] [--json]

Reports, for each worklog root, how much PREP work (stages \`idea\` and
\`intake_complete\`) the downtime dispatcher could actually offer, split into
one bucket per primary cause and listing the genuinely offerable item ids.

options:
  --root <path>   Worklog root to report (the directory CONTAINING .worklog/).
                  Repeatable. When omitted, the \`downtimeWorklogRoots\`
                  active-root registry is used (see below).
  --now <iso>     Frozen evaluation instant (ISO-8601). Required for an exact
                  replay of a past window; defaults to the wall clock.
  --json          Emit the machine payload only. Without it the human table is
                  printed first, followed by the same payload.
  -h, --help      Print this help.

DATA SOURCES (the gap and its fallback)
  \`wl worklist --json\` is read first: it is the consolidated read the Herdr
  worklist already issues. It has NO prep-stage subset, so it only covers prep
  items inside its browse feed (default 20) and its critical / review-queue /
  in-progress-root / blocked-root subsets.
  The gap is closed by a full per-root fallback read, one \`wl list --json\` per
  prep stage:
    wl list --json --status ${PREP_SUPPLY_FALLBACK_STATUSES}
      --stage idea|intake_complete --include-not-started
  The report merges both reads by item id: the worklist read wins on item
  fields, the fallback supplies the dependency edges (read in-process, with a
  per-item \`wl dep list\` fallback). The per-root coverage counts are emitted
  so the gap is measured, never assumed.

OUTPUT
  Stable and diffable: roots sorted by path, buckets alphabetical, item ids
  lexicographic within a bucket. Two runs of the same window are identical.
  Bucket definitions: docs/dev/downtime-dispatcher.md → *Prep-supply buckets*.

ACTIVE-ROOT REGISTRY
  When --root is omitted the roots come from the \`downtimeWorklogRoots\` setting
  in ~/.config/herdr/worklog-plugin.json. The command is read-only: it never
  writes \`wl\`, never sets or clears a marker, flag or assignee, and never
  changes a dispatch decision.`;

/** Parsed CLI arguments. */
export interface PrepSupplyCliArgs {
  roots: string[];
  nowIso?: string;
  json: boolean;
  help: boolean;
}

/** Injected I/O (the production wiring is {@link defaultPrepSupplyCliIo}). */
export interface PrepSupplyCliIo {
  deps: PrepSupplyReportDeps;
  loadRoots(): string[];
  nowMs(): number;
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * Parse the argument vector. `--root` is repeatable (duplicates collapse,
 * first-seen order kept); both `--flag value` and `--flag=value` are accepted.
 */
export function parsePrepSupplyArgs(
  argv: ReadonlyArray<string>,
): { args: PrepSupplyCliArgs } | { error: string } {
  const roots: string[] = [];
  let nowIso: string | undefined;
  let json = false;
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

  return { args: { roots, nowIso, json, help } };
}

/**
 * Resolve the settings file WITHOUT `getDefaultSettingsPath()`, whose
 * `mkdirSync` would be a write in a read-only command. A missing file makes
 * `loadSettings` return the fresh defaults (empty registry).
 */
function defaultSettingsPath(): string {
  return join(homedir(), '.config', 'herdr', 'worklog-plugin.json');
}

/** The production wiring: real reads, real output, registry roots. */
export function defaultPrepSupplyCliIo(): PrepSupplyCliIo {
  return {
    deps: createPrepSupplyReportDeps(),
    loadRoots: () => loadSettings(defaultSettingsPath()).downtimeWorklogRoots,
    nowMs: () => Date.now(),
    stdout: (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
    stderr: (text: string) => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  };
}

/** Run the command; resolves the process exit code. */
export async function main(
  argv: ReadonlyArray<string>,
  io: PrepSupplyCliIo = defaultPrepSupplyCliIo(),
): Promise<number> {
  const parsed = parsePrepSupplyArgs(argv);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n\n${PREP_SUPPLY_USAGE}`);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    io.stdout(PREP_SUPPLY_USAGE);
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
      'No roots to report: pass --root <path> (repeatable) or register the active roots in the `downtimeWorklogRoots` setting of ~/.config/herdr/worklog-plugin.json.\n',
    );
    return 2;
  }

  const report = await collectPrepSupplyReport(io.deps, roots, { now });
  if (args.json) {
    io.stdout(renderPrepSupplyReportJson(report));
  } else {
    io.stdout(`${renderPrepSupplyReportTable(report)}\n\n${renderPrepSupplyReportJson(report)}`);
  }

  const failed = report.roots.filter((root) => root.error !== undefined);
  if (failed.length > 0) {
    io.stderr(
      `prep-supply report: ${failed.length} root(s) failed to read:\n${failed
        .map((root) => `- ${root.root}: ${root.error}`)
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
        `prep-supply-report-cli: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
