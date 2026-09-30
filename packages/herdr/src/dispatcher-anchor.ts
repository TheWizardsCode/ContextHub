/**
 * packages/herdr/src/dispatcher-anchor.ts — Dispatcher anchors and project-workspace resolution
 *
 * Parent: WL-0MU321YK70035AYT — Downtime dispatcher should dispatch into the
 * project workspace.
 *
 * Two placement strategies live here:
 *
 * 1. **Project workspace + item-ID tab (primary path).**
 *    `resolveProjectWorkspace` maps a worklog root `R` to the herdr plugin
 *    pane (`label == "Work Items"`) whose logical project root (read from
 *    `HERDR_RESOLVED_CWD` via `herdr pane process-info` + `/proc/<pid>/environ`)
 *    equals `R`. `getItemTabAnchor` then finds-or-creates a tab labelled with
 *    the exact work-item id inside that workspace and returns its root pane,
 *    so automated panes are co-located with the project and grouped per item.
 *
 * 2. **Machine-wide Dispatcher fallback (retained).**
 *    `getDispatcherAnchor` provisions one dedicated "Dispatcher" workspace
 *    with a persisted anchor pane (`downtime-dispatch-anchor.json`), used only
 *    when no project plugin pane can be resolved (AC4) and by scheduled
 *    prompts (which have no work-item id).
 *
 * The retired per-prefix routing (`getDispatcherTabAnchor`, `<PREFIX>` tab
 * labels and `downtime-dispatch-tab-anchors.json`) is gone: tabs are keyed by
 * the full work-item id in the resolved project workspace.
 *
 * Provisioning: workspace create --label Dispatcher (no-focus); the workspace
 *               root pane is then adopted into a "Downtime" tab
 *               (pane move <id> --new-tab --tab-label Downtime --no-focus) so
 *               it is never left blank (WL-0MU2EOHK900425VU);
 *               tab create --workspace <id> --label <ITEM-ID> --no-focus.
 * Validation: pane RPC aliveness check detects closed anchor; re-provisions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getMachineCoordinationDir,
  ensureMachineCoordinationDir,
} from './machine-coordination.js';
import { tryAcquireCoordLock } from './coordination.js';

const execFile = promisify(_execFile);

// ── Constants ──────────────────────────────────────────────────────────

export const DISPATCHER_ANCHOR_FILE = 'downtime-dispatch-anchor.json';
export const DISPATCHER_WORKSPACE_LABEL = 'Dispatcher';
/**
 * Tab label of the herdr worklog plugin pane (from `herdr-plugin.toml`).
 * Project workspaces are discovered by enumerating machine-wide panes with
 * this exact label and reading each one's logical project root (AC1/AC3).
 */
export const PLUGIN_PANE_LABEL = 'Work Items';
/**
 * Label of the tab that adopts the workspace's initial root pane
 * (WL-0MU2EOHK900425VU) so it is never left blank/unused. The root pane is
 * the split anchor for scheduled-prompt dispatches, so keeping it alive in a
 * labelled tab preserves `send-to-pi.sh --anchor <paneId>` semantics.
 */
export const DISPATCHER_ROOT_TAB_LABEL = 'Downtime';

// ── Types ──────────────────────────────────────────────────────────────

export interface DispatcherAnchor {
  paneId: string;
  workspaceId: string;
}

export interface DispatcherAnchorDeps {
  /** Create a workspace. Resolves to { workspaceId, paneId } or throws. */
  createWorkspace(label: string): Promise<{ workspaceId: string; paneId: string }>;
  /**
   * Move `paneId` into a new tab labelled `label`. Returns true on success,
   * false on CLI failure (the raw error is logged). Used to adopt the
   * workspace's initial root pane so it is never left blank
   * (WL-0MU2EOHK900425VU). Optional; when absent, adoption is skipped and the
   * pre-fix layout is retained (legacy/test callers).
   */
  movePaneToNewTab?(paneId: string, label: string): Promise<boolean>;
  /** True when the pane for `paneId` is alive (RPC pane.get succeeds). */
  isPaneAlive(paneId: string): Promise<boolean>;
  /**
   * List tabs in a workspace (optional; production supplies it). Returns
   * `null` on CLI/parse failure so a caller can fail closed.
   */
  listTabs?(workspaceId: string): Promise<DispatcherTabInfo[] | null>;
  /**
   * Create a tab labelled `label` and return its `{ tabId, paneId }`, or
   * `null` on failure (optional; production supplies it).
   */
  createTab?(workspaceId: string, label: string): Promise<ItemTabAnchor | null>;
  /**
   * List live panes in a workspace as `{ paneId, tabId }` (optional;
   * production supplies it). Returns `null` on CLI/parse failure.
   */
  listPanes?(workspaceId: string): Promise<DispatcherPaneInfo[] | null>;
  /**
   * Machine-wide `herdr pane list` records (project-workspace resolution).
   * `null` on CLI/parse failure → the resolver fails closed (AC3). Optional;
   * production supplies it.
   */
  listMachinePanes?(): Promise<MachinePaneInfo[] | null>;
  /**
   * `herdr pane process-info --pane <id>` → `{ shellPid }`, or `null` on any
   * CLI/parse failure or missing `shell_pid` (fail-closed, AC3). Optional;
   * production supplies it.
   */
  getPaneProcessInfo?(paneId: string): Promise<PaneProcessInfo | null>;
  /**
   * Read `/proc/<shellPid>/environ` (null-delimited) or `null` when it is
   * missing/unreadable (non-Linux, dead process) — fail-closed (AC3).
   * Optional; production supplies it.
   */
  readProcEnviron?(shellPid: string): Promise<string | null>;
}

/** One parsed `herdr tab list` record (id + label). */
export interface DispatcherTabInfo {
  tabId: string;
  label: string;
}

/** One parsed workspace-scoped `herdr pane list` record (tab routing). */
export interface DispatcherPaneInfo {
  paneId: string;
  tabId: string;
}

/** One parsed machine-wide `herdr pane list` record (project-workspace resolution). */
export interface MachinePaneInfo {
  paneId: string;
  workspaceId: string;
  tabId: string;
  label?: string;
  /** True when the pane is focused in its workspace (AC3 ambiguity rule). */
  focused: boolean;
}

/** `herdr pane process-info` result — the pane's shell process id. */
export interface PaneProcessInfo {
  shellPid: string;
}

/** A resolved tab anchor: the tab's id and its root (anchor) pane id. */
export interface ItemTabAnchor {
  tabId: string;
  paneId: string;
}

/** Resolved project workspace hosting the plugin pane for a worklog root (AC1/AC3). */
export interface ProjectWorkspaceTarget {
  paneId: string;
  workspaceId: string;
  tabId: string;
}

/** Build real deps exec'd against the herdr CLI (used in production). */
export function createDispatcherAnchorDeps(
  cwd: string,
  herdrBin: string = process.env.HERDR_BIN_PATH ?? 'herdr',
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

// ── herdr tab/pane CLI helpers (per-prefix tab anchors) ────────────────

/**
 * Parse `herdr tab list` JSON output into `{ tabId, label }` records.
 *
 * Tolerates log lines before the JSON envelope (scan for the first `{`), the
 * `{ result: { tabs: [...] } }` envelope, a bare `{ tabs: [...] }` shape, and
 * the `tab_id` / `tabId` / `id` key variants plus `label` / `title`.
 * Returns `null` when no tab array can be found (caller fails closed — never
 * treat an unparseable list as "no tab exists", which would duplicate tabs).
 */
export function parseTabListOutput(raw: string): DispatcherTabInfo[] | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const tabs = Array.isArray(result.tabs) ? result.tabs : Array.isArray(obj.tabs) ? obj.tabs : null;
  if (tabs === null) return null;

  const out: DispatcherTabInfo[] = [];
  for (const entry of tabs) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const tabId = rec.tab_id ?? rec.tabId ?? rec.id;
    const label = rec.label ?? rec.title;
    if (typeof tabId === 'string' && tabId !== '' && typeof label === 'string') {
      out.push({ tabId, label });
    }
  }
  return out;
}

/**
 * Parse `herdr tab create` JSON output for the new tab id and its root
 * (anchor) pane id.
 *
 * Live herdr 0.7.5 shape:
 * `{ result: { tab: { tab_id, label, … }, root_pane: { pane_id, tab_id, … } } }`.
 * Tolerates the `tab_id` / `tabId` / `id` and `pane_id` / `paneId` / `id` key
 * variants plus a flat (non-nested) result. Returns `null` on any parse
 * failure so a caller can abort before persisting a bogus anchor.
 */
export function parseTabCreateOutput(raw: string): ItemTabAnchor | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const tab = (result.tab ?? {}) as Record<string, unknown>;
  const rootPane = (result.root_pane ?? result.rootPane ?? {}) as Record<string, unknown>;
  const tabId = tab.tab_id ?? tab.tabId ?? tab.id ?? result.tab_id ?? result.tabId;
  const paneId =
    rootPane.pane_id ?? rootPane.paneId ?? rootPane.id ?? result.pane_id ?? result.paneId;
  if (typeof tabId !== 'string' || tabId === '' || typeof paneId !== 'string' || paneId === '') {
    return null;
  }
  return { tabId, paneId };
}

/** Parse `herdr pane list` records down to `{ paneId, tabId }` (tab routing). */
export function parsePaneListOutput(raw: string): DispatcherPaneInfo[] | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const panes = Array.isArray(result.panes) ? result.panes : Array.isArray(obj.panes) ? obj.panes : null;
  if (panes === null) return null;

  const out: DispatcherPaneInfo[] = [];
  for (const entry of panes) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const paneId = rec.pane_id ?? rec.paneId;
    const tabId = rec.tab_id ?? rec.tabId;
    if (typeof paneId === 'string' && paneId !== '' && typeof tabId === 'string' && tabId !== '') {
      out.push({ paneId, tabId });
    }
  }
  return out;
}

/**
 * Parse machine-wide `herdr pane list` JSON into records used for
 * project-workspace resolution.
 *
 * Tolerates log lines before the JSON envelope, the
 * `{ result: { panes: [...] } }` envelope and the bare-array shape, plus
 * `pane_id`/`paneId`, `workspace_id`/`workspaceId`, `tab_id`/`tabId`.
 * `label`/`title` supply the plugin-pane label and `focused`/`is_focused` the
 * ambiguity signal. Returns `null` when no pane array can be found (caller
 * fails closed).
 */
export function parseMachinePaneListOutput(raw: string): MachinePaneInfo[] | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const panes = Array.isArray(result.panes) ? result.panes : Array.isArray(obj.panes) ? obj.panes : null;
  if (panes === null) return null;

  const out: MachinePaneInfo[] = [];
  for (const entry of panes) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const paneId = rec.pane_id ?? rec.paneId;
    const workspaceId = rec.workspace_id ?? rec.workspaceId;
    const tabId = rec.tab_id ?? rec.tabId;
    if (typeof paneId !== 'string' || paneId === '') continue;
    if (typeof workspaceId !== 'string' || workspaceId === '') continue;
    if (typeof tabId !== 'string' || tabId === '') continue;
    const label =
      typeof rec.label === 'string'
        ? rec.label
        : typeof rec.title === 'string'
          ? rec.title
          : undefined;
    const focused =
      rec.focused === true || rec.is_focused === true || rec.isFocused === true;
    out.push({ paneId, workspaceId, tabId, ...(label !== undefined ? { label } : {}), focused });
  }
  return out;
}

/**
 * Parse `herdr pane process-info` JSON for the pane's shell pid.
 *
 * Tolerates log lines, the `{ result: { process_info: { shell_pid } } }`
 * envelope and the `shell_pid`/`shellPid` key variants. Returns `null` on any
 * parse failure or a missing/empty pid (caller fails closed).
 */
export function parsePaneProcessInfoOutput(raw: string): PaneProcessInfo | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result =
    obj.result !== null && typeof obj.result === 'object'
      ? (obj.result as Record<string, unknown>)
      : obj;
  const info =
    result.process_info !== null && typeof result.process_info === 'object'
      ? (result.process_info as Record<string, unknown>)
      : result.processInfo !== null && typeof result.processInfo === 'object'
        ? (result.processInfo as Record<string, unknown>)
        : result;
  const shellPid = info.shell_pid ?? info.shellPid;
  if (typeof shellPid !== 'string' && typeof shellPid !== 'number') return null;
  const asString = String(shellPid);
  if (asString === '') return null;
  return { shellPid: asString };
}

/**
 * Parse a null-delimited `/proc/<pid>/environ` blob into a variable map.
 * Splits on NUL (tolerating a trailing newline), keeping the LAST value of a
 * duplicated key (process env is last-wins). Malformed entries without `=`
 * are skipped; values may legitimately contain `=`.
 */
export function parseProcEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    if (entry === '') continue;
    const idx = entry.indexOf('=');
    if (idx <= 0) continue;
    env[entry.slice(0, idx).trim()] = entry.slice(idx + 1).replace(/\n$/, '');
  }
  return env;
}

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
  herdrBin: string = process.env.HERDR_BIN_PATH ?? 'herdr',
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
  herdrBin: string = process.env.HERDR_BIN_PATH ?? 'herdr',
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
  herdrBin: string = process.env.HERDR_BIN_PATH ?? 'herdr',
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
  herdrBin: string = process.env.HERDR_BIN_PATH ?? 'herdr',
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
  herdrBin: string = process.env.HERDR_BIN_PATH ?? 'herdr',
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

// ── Persistence helpers ────────────────────────────────────────────────

function anchorFilePath(dir: string): string {
  return path.join(dir, DISPATCHER_ANCHOR_FILE);
}

function readAnchor(dir: string): DispatcherAnchor | null {
  try {
    const raw = fs.readFileSync(anchorFilePath(dir), 'utf-8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    const paneId = o.paneId ?? o.pane_id;
    const workspaceId = o.workspaceId ?? o.workspace_id;
    if (typeof paneId !== 'string' || !paneId || typeof workspaceId !== 'string' || !workspaceId) return null;
    return { paneId, workspaceId };
  } catch {
    return null;
  }
}

function writeAnchor(dir: string, anchor: DispatcherAnchor): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fp = anchorFilePath(dir);
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(anchor), 'utf-8');
    fs.renameSync(tmp, fp);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adopt the workspace's initial root pane into a labelled tab so it is never
 * left blank/unused (WL-0MU2EOHK900425VU). `herdr workspace create` always
 * provisions a root pane, which was previously persisted as the anchor but
 * never surfaced in any tab — leaving a blank pane alongside the per-prefix
 * tabs. Moving it into a {@link DISPATCHER_ROOT_TAB_LABEL} tab keeps the pane
 * (and therefore `send-to-pi.sh --anchor <paneId>` dispatch) alive while
 * giving it a productive home.
 *
 * Best-effort: a `false`/throwing `movePaneToNewTab` leaves the pane where it
 * is and the caller still persists the anchor, so dispatch degrades to the
 * pre-fix layout rather than entering a re-provision loop. Deps without
 * `movePaneToNewTab` (legacy/test callers) skip adoption entirely.
 */
async function adoptRootPaneIntoNewTab(
  deps: DispatcherAnchorDeps,
  paneId: string,
): Promise<void> {
  if (typeof deps.movePaneToNewTab !== 'function') return;
  try {
    await deps.movePaneToNewTab(paneId, DISPATCHER_ROOT_TAB_LABEL);
  } catch {
    // best-effort — never fail provisioning on an adoption error
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Return the persisted Dispatcher anchor, provisioning it idempotently when
 * absent or stale (closed pane → re-provision). Fail-safe: null on any
 * unrecoverable error (caller degrades to "no dispatch this cycle").
 *
 * Idempotency: the provision path runs under the coordination lock
 * (O_CREAT|O_EXCL), so concurrent first-dispatches produce exactly one
 * workspace/pane.
 */
export async function getDispatcherAnchor(
  cwd: string,
  deps: DispatcherAnchorDeps,
): Promise<DispatcherAnchor | null> {
  const dir = getMachineCoordinationDir();
  if (dir === null) return null;
  if (!ensureMachineCoordinationDir(dir)) return null;

  const existing = readAnchor(dir);
  if (existing !== null) {
    try {
      const alive = await deps.isPaneAlive(existing.paneId);
      if (alive) return existing;
    } catch {
      return null;
    }
    // Stale → re-provision under lock (fall through to provision path)
  }

  // Provision under the coordination lock so concurrent first-dispatches do not duplicate.
  const release = tryAcquireCoordLock(dir);
  if (release === null) {
    // Another holder is provisioning — re-read whatever they wrote, or null.
    const raced = readAnchor(dir);
    if (raced !== null) {
      try {
        const alive = await deps.isPaneAlive(raced.paneId);
        if (alive) return raced;
      } catch { return null; }
    }
    return null;
  }

  try {
    // Double-check inside the lock: another instance may have written between
    // our earlier read and acquiring the lock.
    const inside = readAnchor(dir);
    if (inside !== null) {
      try {
        const alive = await deps.isPaneAlive(inside.paneId);
        if (alive) return inside;
      } catch { return null; }
      // stale inside-lock → re-provision below (overwrite)
    }

    let created: { workspaceId: string; paneId: string };
    try {
      created = await deps.createWorkspace(DISPATCHER_WORKSPACE_LABEL);
    } catch {
      return null;
    }
    // Adopt the freshly-provisioned root pane into its own tab so the
    // workspace never shows a blank pane (WL-0MU2EOHK900425VU).
    await adoptRootPaneIntoNewTab(deps, created.paneId);
    const anchor: DispatcherAnchor = { paneId: created.paneId, workspaceId: created.workspaceId };
    if (!writeAnchor(dir, anchor)) return null;
    return anchor;
  } finally {
    release();
  }
}

/**
 * Outcome of resolving a live anchor pane inside a tab.
 *
 *  - `{ status: 'found', paneId }` — an alive pane was found (adopt the tab).
 *  - `{ status: 'none' }` — the pane list was read but no live pane exists in
 *    the tab (the tab is effectively dead → create a replacement).
 *  - `{ status: 'unknown' }` — the pane list could not be read/parsed (fail
 *    closed — never guess, never duplicate).
 */
type LivePaneResolution =
  | { status: 'found'; paneId: string }
  | { status: 'none' }
  | { status: 'unknown' };

/**
 * Find a LIVE pane inside `tabId` (used to adopt a tab that exists in herdr
 * but is not yet recorded in the persisted map — e.g. the anchor file was
 * lost or the tab was created out-of-band).
 */
async function resolveLivePaneInTab(
  cwd: string,
  deps: DispatcherAnchorDeps,
  workspaceId: string,
  tabId: string,
): Promise<LivePaneResolution> {
  const listPanes =
    deps.listPanes ?? ((ws: string) => listPanesInWorkspace(cwd, ws));
  let panes: DispatcherPaneInfo[] | null;
  try {
    panes = await listPanes(workspaceId);
  } catch {
    return { status: 'unknown' };
  }
  if (panes === null) return { status: 'unknown' };
  for (const pane of panes) {
    if (pane.tabId !== tabId) continue;
    try {
      if (await deps.isPaneAlive(pane.paneId)) {
        return { status: 'found', paneId: pane.paneId };
      }
    } catch {
      return { status: 'unknown' }; // fail-closed on an aliveness probe error
    }
  }
  return { status: 'none' };
}

// ── Project workspace resolution (AC1/AC3) ─────────────────────────────

/**
 * Normalise a path for comparison: resolve `.`/`..`, strip trailing
 * slashes (keeping the filesystem root). Used so `HERDR_RESOLVED_CWD` and the
 * candidate worklog root compare equal modulo a trailing separator.
 */
function normalizeRoot(p: string): string {
  if (p === '') return '';
  const resolved = path.resolve(p);
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

/** Deterministic pane-id ordering — the lower id wins (AC3 ambiguity rule). */
function comparePaneIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Resolve the herdr project workspace that hosts the worklog plugin pane for
 * worklog root `root` (AC1/AC3).
 *
 * Enumerates the machine-wide `herdr pane list`, keeps only plugin panes
 * (`label == PLUGIN_PANE_LABEL`), and reads each candidate's logical project
 * root from `HERDR_RESOLVED_CWD` (via `pane process-info` + `/proc` environ).
 * Matching is on the logical root ONLY — never the pane's reported `cwd`
 * (which is the plugin directory) and never the workspace label.
 *
 * Ambiguity (>=2 matching panes) is deterministic: the focused matching pane
 * wins, else the lowest pane id (AC3). Never selects another root's
 * workspace.
 *
 * Fail-closed `null` on: empty root; `pane list` CLI error / unparseable
 * output; a plugin pane's `process-info` failure or missing `shell_pid`;
 * unreadable/missing `/proc/<pid>/environ`; missing `HERDR_RESOLVED_CWD`; no
 * root match; or a match without a workspace id. A `null` result makes the
 * dispatcher fall back to the Dispatcher anchor (AC4).
 */
export async function resolveProjectWorkspace(
  cwd: string,
  deps: DispatcherAnchorDeps,
  root: string,
): Promise<ProjectWorkspaceTarget | null> {
  const wanted = normalizeRoot(root);
  if (wanted === '') return null;

  const listAllPanes = deps.listMachinePanes ?? (() => listMachinePanes(cwd));
  let panes: MachinePaneInfo[] | null;
  try {
    panes = await listAllPanes();
  } catch {
    return null;
  }
  if (panes === null) return null;

  const candidates = panes.filter((pane) => pane.label === PLUGIN_PANE_LABEL);
  const matches: Array<{ pane: MachinePaneInfo; workspaceId: string }> = [];
  for (const pane of candidates) {
    const getInfo = deps.getPaneProcessInfo ?? ((id: string) => getPaneProcessInfo(cwd, id));
    let info: PaneProcessInfo | null;
    try {
      info = await getInfo(pane.paneId);
    } catch {
      return null;
    }
    if (info === null || info.shellPid === '') return null;

    const readEnv = deps.readProcEnviron ?? ((pid: string) => readProcEnvironFile(pid));
    let rawEnv: string | null;
    try {
      rawEnv = await readEnv(info.shellPid);
    } catch {
      return null;
    }
    if (rawEnv === null) return null;

    const env = parseProcEnviron(rawEnv);
    const resolvedCwd = env.HERDR_RESOLVED_CWD;
    if (typeof resolvedCwd !== 'string' || resolvedCwd === '') return null;
    if (normalizeRoot(resolvedCwd) !== wanted) continue;

    const workspaceId = env.HERDR_WORKSPACE_ID ?? pane.workspaceId;
    if (workspaceId === undefined || workspaceId === '') return null;
    matches.push({ pane, workspaceId });
  }

  if (matches.length === 0) return null;
  // Focused first; then lowest pane id.
  matches.sort((a, b) => {
    if (a.pane.focused !== b.pane.focused) return a.pane.focused ? -1 : 1;
    return comparePaneIds(a.pane.paneId, b.pane.paneId);
  });
  const chosen = matches[0];
  return { paneId: chosen.pane.paneId, workspaceId: chosen.workspaceId, tabId: chosen.pane.tabId };
}

// ── Item-ID tab anchor in a resolved project workspace (AC2/AC5) ────────

/**
 * Return the anchor pane for the tab labelled with the exact work-item id
 * `itemId` inside `workspaceId`, creating it on first use (AC2).
 *
 * Algorithm (fail-closed at every boundary):
 *  1. Fast path — an existing tab whose label equals `itemId` and whose root
 *     pane is alive is adopted.
 *  2. Otherwise, under the coordination lock with a double-check, adopt a
 *     matching tab again (a racing caller may have created it) or
 *     `herdr tab create --workspace <id> --label <itemId> --no-focus`.
 *
 * No persistence file: the tab label IS the key, discovered via `herdr tab
 * list`, so a second dispatch for the same item reuses the same tab (never a
 * duplicate). The retired per-prefix `downtime-dispatch-tab-anchors.json`
 * map is gone (AC5).
 *
 * Returns `null` on any failure (missing machine dir, empty inputs,
 * unparseable `tab list`/`tab create`/`pane list`, or a matching tab whose
 * anchor pane cannot be resolved) — the caller fails closed (never a
 * wrong-project placement).
 */
export async function getItemTabAnchor(
  cwd: string,
  deps: DispatcherAnchorDeps,
  workspaceId: string,
  itemId: string,
): Promise<ItemTabAnchor | null> {
  if (workspaceId === '' || itemId === '') return null;
  const dir = getMachineCoordinationDir();
  if (dir === null) return null;
  if (!ensureMachineCoordinationDir(dir)) return null;

  const listTabs = deps.listTabs ?? ((ws: string) => listTabsInWorkspace(cwd, ws));

  // 1. Fast path: an existing tab with this exact label hosting a live pane.
  const fast = await resolveItemTab(cwd, deps, workspaceId, itemId, listTabs);
  if (fast.status === 'unknown') return null;
  if (fast.status === 'found') return { tabId: fast.tabId, paneId: fast.paneId };

  // 2. Provision under the coordination lock with a double-check.
  const release = tryAcquireCoordLock(dir);
  if (release === null) {
    // Another holder may be creating the same tab; re-check once, else fail.
    const raced = await resolveItemTab(cwd, deps, workspaceId, itemId, listTabs);
    if (raced.status === 'found') return { tabId: raced.tabId, paneId: raced.paneId };
    return null;
  }
  try {
    const inside = await resolveItemTab(cwd, deps, workspaceId, itemId, listTabs);
    if (inside.status === 'unknown') return null;
    if (inside.status === 'found') return { tabId: inside.tabId, paneId: inside.paneId };
    // inside.status === 'none' → create the tab (never focus-stealing).
    const createTab =
      deps.createTab ?? ((ws: string, label: string) => createTabInWorkspace(cwd, ws, label));
    let created: ItemTabAnchor | null;
    try {
      created = await createTab(workspaceId, itemId);
    } catch {
      return null;
    }
    if (created === null) return null;
    return { tabId: created.tabId, paneId: created.paneId };
  } finally {
    release();
  }
}

/** Result of resolving the item-ID tab: found + live pane, absent, or unreadable. */
type ItemTabResolution =
  | { status: 'found'; tabId: string; paneId: string }
  | { status: 'none' }
  | { status: 'unknown' };

/**
 * Resolve the live anchor pane for the tab labelled exactly `itemId`.
 *
 *  - `found` — the tab exists and hosts a live pane (adopt it).
 *  - `none` — `tab list` was read but no matching tab matches, or the
 *    matching tab has no live pane → the caller creates a replacement.
 *  - `unknown` — `tab list`/`pane list` was unreadable → fail closed.
 */
async function resolveItemTab(
  cwd: string,
  deps: DispatcherAnchorDeps,
  workspaceId: string,
  itemId: string,
  listTabs: (workspaceId: string) => Promise<DispatcherTabInfo[] | null>,
): Promise<ItemTabResolution> {
  let tabs: DispatcherTabInfo[] | null;
  try {
    tabs = await listTabs(workspaceId);
  } catch {
    return { status: 'unknown' };
  }
  if (tabs === null) return { status: 'unknown' };
  const match = tabs.find((tab) => tab.label === itemId);
  if (match === undefined) return { status: 'none' };
  const resolution = await resolveLivePaneInTab(cwd, deps, workspaceId, match.tabId);
  if (resolution.status === 'unknown') return { status: 'unknown' };
  if (resolution.status === 'found') {
    return { status: 'found', tabId: match.tabId, paneId: resolution.paneId };
  }
  return { status: 'none' };
}
