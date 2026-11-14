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
 * Ledger repair mode: `--repair-budget-ledger` (WL-0MWFJD8ZO000J1R8) is the
 * EXPLICIT operator recovery for a corrupt/unreadable dispatch-budget ledger.
 * An admission read never rewrites the ledger, so this is how an operator
 * rebuilds it from the live pane list: every dispatcher label form is decoded
 * (decoration stripped, `Manually triggered` accepted), and the write is
 * refused while any live dispatcher pane cannot be accounted for. The
 * reconstructed set is printed as JSON.
 *
 * Exit code mirrors `runReaperCli`: 0 on success, 1 on any close failure (or a
 * refused/failed ledger repair).
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  countSpawnedChildProcesses,
  createHerdrReaperDeps,
  dirHasRecentModifications,
  parsePaneProcessInfo,
} from './pane-close-herdr.js';
import { resolveHerdrBin } from './herdr-bin.js';
import { releaseHostDispatch } from './host-dispatch-budget.admission.js';
import {
  decodeBudgetPaneLabel,
  repairBudgetLedgerFromPanes,
} from './host-dispatch-budget.repair.js';
import { sweepClosedPanes, type HostBudgetLivePane } from './host-dispatch-budget.js';
import { parseHerdrPaneListOutput } from './downtime-worker.pane.js';
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

/**
 * Split `--repair-budget-ledger` out of argv (WL-0MWFJD8ZO000J1R8).
 *
 * Mutually exclusive with the reaper's own flags: the repair prints its own
 * JSON report and exits, so the remaining argv is irrelevant when it is set.
 */
export function extractRepairArg(argv: string[]): { repair: boolean; rest: string[] } {
  const rest: string[] = [];
  let repair = false;
  for (const arg of argv) {
    if (arg === '--repair-budget-ledger') repair = true;
    else rest.push(arg);
  }
  return { repair, rest };
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
  const herdrBin = resolveHerdrBin(io.env);
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
    // Host-wide dispatch budget (WL-0MW5KC8J300942EA): a closed pane releases
    // its machine-scoped ledger slot, and the once-per-run sweep drops
    // CONFIRMED entries whose pane the trusted read no longer lists. Both are
    // best-effort and never change the reaper outcome.
    releasePaneBudget: async (pane) => {
      // The CLOSED PANE is the identity (WL-0MWFJD5T4003OM91): a sibling pane
      // close for the same item must not release a live dispatch's entry.
      if (pane.itemId === '') return;
      releaseHostDispatch({
        itemId: pane.itemId,
        ...(pane.kind === 'implement' || pane.kind === 'audit' ? { kind: pane.kind } : {}),
        paneId: pane.id,
      });
    },
    sweepBudgetLedger: async (parsedPanes) => {
      sweepClosedPanes(parsedPanes.map((pane) => ({ paneId: pane.paneId })));
    },
    invokingPaneId,
    // Item lookup (parent AC2/AC6): producer-review flag + work-item stage.
    getItemInfo: async (itemId: string) => {
      const { stdout } = await io.execFileAsync('wl', ['show', itemId, '--json'], {
        encoding: 'utf8',
        timeout: CLI_COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        cwd: io.cwd,
      });
      const parsed = extractJsonValue(stdout) as {
        workItem?: { needsProducerReview?: boolean; stage?: string };
      };
      // Fail-closed: an unreadable item is treated as review-blocked.
      return {
        needsProducerReview: parsed?.workItem?.needsProducerReview === true,
        stage: parsed?.workItem?.stage,
      };
    },
    // Live-child probe (parent AC1/AC3): count foreground processes other
    // than the agent itself. Fail-closed to 0.
    childProcessCount: async (pane) => {
      try {
        const { stdout } = await io.execFileAsync(
          herdrBin,
          ['pane', 'process-info', '--pane', pane.paneId],
          {
            encoding: 'utf8',
            timeout: CLI_COMMAND_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
            cwd: io.cwd,
          },
        );
        return countSpawnedChildProcesses(parsePaneProcessInfo(stdout));
      } catch {
        return 0;
      }
    },
    // Recent file-modification probe (parent AC3). Fail-closed.
    hasRecentFileModifications: (pane) =>
      dirHasRecentModifications(pane.foregroundCwd ?? pane.cwd),
  });
}

/**
 * Run one EXPLICIT ledger repair from the machine-wide live pane list
 * (WL-0MWFJD8ZO000J1R8).
 *
 * Prints a JSON report — the reconstructed entries, the panes accounted for and
 * (on a refusal) the panes that blocked the write — and returns the exit code:
 * 0 repaired, 1 refused/failed. A failed `herdr pane list` is a refusal (an
 * unknown pane list must never be treated as "no panes": that would write an
 * empty ledger over live work).
 */
export async function runBudgetLedgerRepair(
  io: PaneCloseCliIo,
  fixtureRaw: string | undefined,
  invokingPaneId: string | undefined,
): Promise<number> {
  const herdrBin = resolveHerdrBin(io.env);
  let raw: string;
  if (fixtureRaw !== undefined) {
    raw = fixtureRaw;
  } else {
    try {
      const { stdout } = await io.execFileAsync(herdrBin, ['pane', 'list'], {
        encoding: 'utf8',
        timeout: CLI_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        cwd: io.cwd,
      });
      raw = stdout;
    } catch (err) {
      process.stderr.write(
        `[worklog-plugin] budget-ledger repair refused: "herdr pane list" failed ` +
          `(${err instanceof Error ? err.message : String(err)}) — an unknown pane list ` +
          'must never be repaired as empty\n',
      );
      return 1;
    }
  }
  const records = parseHerdrPaneListOutput(raw);
  if (records === null) {
    process.stderr.write(
      '[worklog-plugin] budget-ledger repair refused: the pane list could not be parsed\n',
    );
    return 1;
  }
  const panes: HostBudgetLivePane[] = records.map((record) => ({
    paneId: record.paneId,
    ...(typeof record.label === 'string' ? { title: record.label } : {}),
  }));

  const result = repairBudgetLedgerFromPanes(panes, {
    instanceId: `herdr:${process.pid}`,
    root: io.cwd,
  });

  if (!result.ok) {
    process.stderr.write(`[worklog-plugin] budget-ledger repair: ${result.message}\n`);
    console.log(
      JSON.stringify(
        {
          repaired: false,
          reason: result.reason,
          unaccounted: result.unaccounted ?? [],
          // Per-pane decode evidence, so the operator can see WHY a pane was
          // not accounted for.
          panes: panes.map((pane) => ({
            paneId: pane.paneId,
            label: pane.title ?? '',
            decoded: decodeBudgetPaneLabel(pane.title),
          })),
        },
        null,
        2,
      ),
    );
    return 1;
  }

  console.log(
    JSON.stringify(
      {
        repaired: true,
        invokingPaneId: invokingPaneId ?? null,
        count: result.count,
        entries: result.entries,
        accountedPaneIds: result.accountedPaneIds,
      },
      null,
      2,
    ),
  );
  return 0;
}

/** Entry point. Returns the process exit code. */
export async function main(
  argv: string[] = process.argv.slice(2),
  io?: Partial<PaneCloseCliIo>,
): Promise<number> {
  const { repair, rest: withoutRepair } = extractRepairArg(argv);
  const { fixture, rest } = extractFixtureArg(withoutRepair);
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
  if (repair) {
    return runBudgetLedgerRepair(resolvedIo, fixtureRaw, invoking);
  }
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
