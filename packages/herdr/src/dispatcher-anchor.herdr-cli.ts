/**
 * packages/herdr/src/dispatcher-anchor.herdr-cli.ts — `herdr` CLI subprocess
 * helpers and the production dispatcher-anchor deps factory.
 *
 * Single responsibility: run the `herdr` binary and read a pane's process
 * environment — `execFileStdout` (module-local normaliser),
 * `listMachinePanes`, `getPaneProcessInfo`, `readProcEnvironFile`,
 * `listTabsInWorkspace`, `listPanesInWorkspace`, `createTabInWorkspace` — and
 * build the production deps object over them
 * (`createDispatcherAnchorDeps`).
 *
 * Moved verbatim out of `dispatcher-anchor.ts` (parent WL-0MVGKHCP9005SJPZ;
 * child WL-0MW0JHALU00928SX). No behaviour change: the same signatures, the
 * same exported names and the same fail-closed `null` semantics.
 *
 * Layering: imports the output parsers from
 * `dispatcher-anchor.cli-parsers.js` and types from
 * `dispatcher-anchor.contract.js`; `resolveHerdrBin` still comes from
 * `./herdr-bin.js`. It never imports the `dispatcher-anchor.js` barrel, so the
 * barrel can re-export these symbols without creating a cycle.
 * `execFileStdout` stays module-local.
 */

import * as fs from 'node:fs';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveHerdrBin } from './herdr-bin.js';
import type {
  DispatcherAnchorDeps,
  DispatcherTabInfo,
  DispatcherPaneInfo,
  MachinePaneInfo,
  PaneProcessInfo,
  ItemTabAnchor,
} from './dispatcher-anchor.contract.js';
import {
  parseTabListOutput,
  parseTabCreateOutput,
  parsePaneListOutput,
  parseMachinePaneListOutput,
  parsePaneProcessInfoOutput,
} from './dispatcher-anchor.cli-parsers.js';

const execFile = promisify(_execFile);

// ── herdr CLI helpers and production deps factory ──────────────────────

/** Build real deps exec'd against the herdr CLI (used in production). */
export function createDispatcherAnchorDeps(
  cwd: string,
  herdrBin: string = resolveHerdrBin(),
): DispatcherAnchorDeps {
  return {
    async createWorkspace(label: string) {
      const out = await execFileStdout(
        herdrBin,
        ['workspace', 'create', '--label', label, '--no-focus'],
        { cwd, maxBuffer: 1024 * 1024 },
      );
      const start = out.indexOf('{');
      const payload = start >= 0 ? JSON.parse(out.slice(start)) as Record<string, unknown> : ({} as Record<string, unknown>);
      const res = (payload.result ?? payload) as Record<string, unknown>;
      const ws = res.workspace as Record<string, unknown> | undefined;
      const rootPane = res.root_pane as Record<string, unknown> | undefined;
      // herdr 0.7.5 shape: { result: { workspace: {workspace_id}, root_pane: {pane_id} } }
      // alt key forms: workspace_id / workspaceId / id
      const workspaceId = (ws?.workspace_id ?? ws?.workspaceId ?? ws?.id ?? res.workspace_id ?? '') as string;
      const paneId = (rootPane?.pane_id ?? rootPane?.paneId ?? rootPane?.id ?? res.pane_id ?? res.paneId ?? '') as string;
      if (typeof workspaceId !== 'string' || !workspaceId || typeof paneId !== 'string' || !paneId) {
        throw new Error(`Cannot parse workspace create output: ${out.slice(0, 400)}`);
      }
      return { workspaceId, paneId };
    },
    async movePaneToNewTab(paneId: string, label: string) {
      try {
        await execFile(
          herdrBin,
          ['pane', 'move', paneId, '--new-tab', '--tab-label', label, '--no-focus'],
          { cwd, maxBuffer: 1024 * 1024 },
        );
        return true;
      } catch (err) {
        process.stderr.write(
          `[worklog-plugin] Dispatcher root-pane adoption failed (pane ${paneId}, label ${label}): ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        return false;
      }
    },
    async isPaneAlive(paneId: string) {
      try {
        await execFile(herdrBin, ['pane', 'get', paneId], { cwd, maxBuffer: 1024 * 1024 });
        return true;
      } catch {
        return false;
      }
    },
    listTabs: (workspaceId: string) => listTabsInWorkspace(cwd, workspaceId, herdrBin),
    createTab: (workspaceId: string, label: string) =>
      createTabInWorkspace(cwd, workspaceId, label, herdrBin),
    listPanes: (workspaceId: string) => listPanesInWorkspace(cwd, workspaceId, herdrBin),
    listMachinePanes: () => listMachinePanes(cwd, herdrBin),
    getPaneProcessInfo: (paneId: string) => getPaneProcessInfo(cwd, paneId, herdrBin),
    readProcEnviron: async (shellPid: string) => readProcEnvironFile(shellPid),
  };
}

// ── herdr CLI output parsers ────────────────────────────────────────────
//
// Moved verbatim to `dispatcher-anchor.cli-parsers.ts`
// (WL-0MW0JH9QP00131ZJ), a pure leaf module that imports only the result
// types from `dispatcher-anchor.contract.js`. Re-exported here unchanged so
// every consumer of `./dispatcher-anchor.js` (including `hydrator.ts`) keeps
// compiling with no import edits.

export {
  parseTabListOutput,
  parseTabCreateOutput,
  parsePaneListOutput,
  parseMachinePaneListOutput,
  parsePaneProcessInfoOutput,
  parseProcEnviron,
} from './dispatcher-anchor.cli-parsers.js';

/**
 * Run a herdr CLI command and resolve its stdout as a string.
 *
 * Node's `util.promisify(execFile)` resolves `{ stdout, stderr }` in
 * production, but the test harness's global `child_process` wrapper loses the
 * `promisify.custom` symbol so the generic callback shape resolves to the raw
 * stdout value instead. Normalise both shapes so behaviour is identical in
 * tests and production.
 */
async function execFileStdout(
  herdrBin: string,
  args: string[],
  opts: { cwd: string; maxBuffer: number },
): Promise<string> {
  const res = (await execFile(herdrBin, args, opts)) as unknown;
  if (typeof res === 'string') return res;
  if (Buffer.isBuffer(res)) return res.toString();
  const out = (res as { stdout?: unknown } | null | undefined)?.stdout;
  return out === undefined || out === null ? '' : out.toString();
}

/** List machine-wide panes via `herdr pane list` (null on CLI/parse failure). */
export async function listMachinePanes(
  cwd: string,
  herdrBin: string = resolveHerdrBin(),
): Promise<MachinePaneInfo[] | null> {
  let out: string;
  try {
    out = await execFileStdout(herdrBin, ['pane', 'list'], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const parsed = parseMachinePaneListOutput(out);
  if (parsed === null) {
    process.stderr.write(
      `[worklog-plugin] herdr pane list unparseable output: ${out.slice(0, 400)}\n`,
    );
  }
  return parsed;
}

/**
 * Resolve a pane's shell pid via `herdr pane process-info --pane <id>`.
 * Returns `null` on CLI error / unparseable output (caller fails closed).
 */
export async function getPaneProcessInfo(
  cwd: string,
  paneId: string,
  herdrBin: string = resolveHerdrBin(),
): Promise<PaneProcessInfo | null> {
  let out: string;
  try {
    out = await execFileStdout(
      herdrBin,
      ['pane', 'process-info', '--pane', paneId],
      { cwd, maxBuffer: 1024 * 1024 },
    );
  } catch {
    return null;
  }
  const parsed = parsePaneProcessInfoOutput(out);
  if (parsed === null) {
    process.stderr.write(
      `[worklog-plugin] herdr pane process-info unparseable output: ${out.slice(0, 400)}\n`,
    );
  }
  return parsed;
}

/**
 * Read `/proc/<shellPid>/environ` (null on a missing/unreadable file — e.g.
 * non-Linux hosts or a dead process). Linux-only, matching the mechanism
 * already used by `packages/herdr/scripts/open.sh`.
 */
export function readProcEnvironFile(shellPid: string): string | null {
  try {
    return fs.readFileSync(`/proc/${shellPid}/environ`, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * List the tabs of one workspace via `herdr tab list --workspace <id>`.
 * Returns `null` on CLI error or unparseable output (caller fails closed).
 */
export async function listTabsInWorkspace(
  cwd: string,
  workspaceId: string,
  herdrBin: string = resolveHerdrBin(),
): Promise<DispatcherTabInfo[] | null> {
  try {
    const out = await execFileStdout(
      herdrBin,
      ['tab', 'list', '--workspace', workspaceId],
      { cwd, maxBuffer: 1024 * 1024 },
    );
    return parseTabListOutput(out);
  } catch {
    return null;
  }
}

/**
 * List the panes of one workspace via `herdr pane list --workspace <id>`.
 * Returns `null` on CLI error or unparseable output (caller fails closed).
 */
export async function listPanesInWorkspace(
  cwd: string,
  workspaceId: string,
  herdrBin: string = resolveHerdrBin(),
): Promise<DispatcherPaneInfo[] | null> {
  try {
    const out = await execFileStdout(
      herdrBin,
      ['pane', 'list', '--workspace', workspaceId],
      { cwd, maxBuffer: 1024 * 1024 },
    );
    return parsePaneListOutput(out);
  } catch {
    return null;
  }
}

/**
 * Create a tab labelled `label` in `workspaceId` via
 * `herdr tab create --workspace <id> --label <label> --no-focus`.
 *
 * Returns `{ tabId, paneId }` (the tab's root anchor pane) or `null` on CLI
 * error / unparseable output. Raw output is logged on a parse failure
 * (never silently swallowed) so CLI shape drift is diagnosable.
 */
export async function createTabInWorkspace(
  cwd: string,
  workspaceId: string,
  label: string,
  herdrBin: string = resolveHerdrBin(),
): Promise<ItemTabAnchor | null> {
  let out: string;
  try {
    out = await execFileStdout(
      herdrBin,
      ['tab', 'create', '--workspace', workspaceId, '--label', label, '--no-focus'],
      { cwd, maxBuffer: 1024 * 1024 },
    );
  } catch (err) {
    process.stderr.write(
      `[worklog-plugin] Dispatcher tab create failed (workspace ${workspaceId}, label ${label}): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return null;
  }
  const parsed = parseTabCreateOutput(out);
  if (parsed === null) {
    process.stderr.write(
      `[worklog-plugin] Dispatcher tab create unparseable output: ${out.slice(0, 400)}\n`,
    );
    return null;
  }
  return parsed;
}
