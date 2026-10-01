#!/usr/bin/env node
/**
 * packages/herdr/src/pane-close-cli.ts — Standalone pane-close CLI
 *
 * Wires the production `ReaperDeps` (herdr pane listing + close, `wl show`
 * producer-review lookup, process-group teardown) and invokes the shared
 * `runReaperCli`. This is the cross-language bridge consumed by the Python
 * `pane-triage` skill (`WL-0MUJMXVPO0016DZM`, intake Q-OPEN-1 Option 2):
 * the skill shells out to this compiled CLI with `--json` and parses the
 * classification report, so the idle-state logic is never reimplemented.
 *
 * Offline mode: `--fixture <path>` supplies a raw `herdr pane list` JSON
 * document instead of shelling out to herdr. This lets the skill's offline
 * fixture tests exercise the *shared* classifier end-to-end without a live
 * herdr or wl. In fixture mode the producer-review lookup defaults to false
 * and closing is a recorded no-op.
 *
 * Exit code mirrors `runReaperCli`: 0 on success, 1 on any close failure.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { createHerdrReaperDeps } from './pane-close-herdr.js';
import type { ReaperDeps } from './pane-close-reaper.js';
import { runReaperCli } from './pane-close-reaper.js';

const execFileAsync = promisify(execFile);

/** Default per-command timeout for herdr / wl calls (60 s). */
export const CLI_COMMAND_TIMEOUT_MS = 60 * 1000;

/** Injectable I/O, so tests can exercise the CLI without real processes. */
export interface PaneCloseCliIo {
  execFileAsync: typeof execFileAsync;
  readFile(path: string): string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Split `--fixture <path>` out of argv; the remainder is passed through. */
export function extractFixtureArg(argv: string[]): { fixture?: string; rest: string[] } {
  const rest: string[] = [];
  let fixture: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixture') {
      fixture = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  return { fixture, rest };
}

/**
 * Extract the first JSON value from a string that may be prefixed by log
 * lines (herdr/wl occasionally emit non-JSON before the payload).
 */
export function extractJsonValue(raw: string): unknown {
  const brace = raw.indexOf('{');
  const bracket = raw.indexOf('[');
  let start: number;
  if (brace < 0 && bracket < 0) return null;
  else if (brace < 0) start = bracket;
  else if (bracket < 0) start = brace;
  else start = Math.min(brace, bracket);
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

/**
 * Build the production `ReaperDeps`. When `fixtureRaw` is supplied the herdr
 * and wl calls are replaced by offline stubs so tests exercise the shared
 * classifier without side effects.
 */
export function createPaneCloseCliDeps(io: PaneCloseCliIo, fixtureRaw?: string): ReaperDeps {
  const herdrBin = io.env.HERDR_BIN_PATH ?? 'herdr';
  const invokingPaneId = io.env.HERDR_PANE_ID ?? io.env.HERDR_PANE ?? undefined;

  if (fixtureRaw !== undefined) {
    return createHerdrReaperDeps({
      listPanesRaw: async () => fixtureRaw,
      closePane: async () => true, // offline: recorded no-op
      invokingPaneId,
    });
  }

  return createHerdrReaperDeps({
    listPanesRaw: async () => {
      const { stdout } = await io.execFileAsync(herdrBin, ['pane', 'list'], {
        encoding: 'utf8',
        timeout: CLI_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        cwd: io.cwd,
      });
      return stdout;
    },
    closePane: async (paneId: string) => {
      try {
        await io.execFileAsync(herdrBin, ['pane', 'close', paneId], {
          encoding: 'utf8',
          timeout: CLI_COMMAND_TIMEOUT_MS,
          cwd: io.cwd,
        });
        return true;
      } catch {
        return false; // fail-closed: a failed close is recorded, never thrown
      }
    },
    invokingPaneId,
    getNeedsProducerReview: async (itemId: string) => {
      const { stdout } = await io.execFileAsync('wl', ['show', itemId, '--json'], {
        encoding: 'utf8',
        timeout: CLI_COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        cwd: io.cwd,
      });
      const parsed = extractJsonValue(stdout) as {
        workItem?: { needsProducerReview?: boolean };
      };
      // Fail-closed: an unreadable item is treated as review-blocked.
      return parsed?.workItem?.needsProducerReview === true;
    },
  });
}

/** Entry point. Returns the process exit code. */
export async function main(
  argv: string[] = process.argv.slice(2),
  io?: Partial<PaneCloseCliIo>,
): Promise<number> {
  const { fixture, rest } = extractFixtureArg(argv);
  const resolvedIo: PaneCloseCliIo = {
    execFileAsync: io?.execFileAsync ?? execFileAsync,
    readFile: io?.readFile ?? ((path: string) => readFileSync(path, 'utf8')),
    env: io?.env ?? process.env,
    cwd: io?.cwd ?? process.cwd(),
  };
  const fixtureRaw = fixture !== undefined ? resolvedIo.readFile(fixture) : undefined;
  // Surface the invoking pane id in the JSON envelope so the Python skill can
  // exclude it even though the classifier also computes `isInvokingPane`.
  const invoking = resolvedIo.env.HERDR_PANE_ID ?? resolvedIo.env.HERDR_PANE;
  const args = [...rest];
  if (invoking && !args.includes('--invoking-pane')) {
    args.push('--invoking-pane', invoking);
  }
  const deps = createPaneCloseCliDeps(resolvedIo, fixtureRaw);
  return runReaperCli(deps, args);
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`pane-close-cli: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
