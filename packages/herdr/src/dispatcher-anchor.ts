/**
 * packages/herdr/src/dispatcher-anchor.ts — Dedicated Dispatcher workspace anchor provisioning
 *
 * Parent: WL-0MTR01EU7005SYZG (Dispatcher anchor-by-ID). Child F1 WL-0MTR2CD4X006XI7U.
 *
 * Provisions a dedicated "Dispatcher" workspace with a persisted anchor pane,
 * guarded by the coordination lock for concurrency safety.
 *
 * Per-prefix tabs (parent WL-0MTRQT482001SNXC, C1): `getDispatcherTabAnchor`
 * additionally routes each work-item prefix (`WL`, `TCE`, `CG`, …) to its own
 * tab inside the Dispatcher workspace, creating it on first use and persisting
 * a `{ workspaceId, byPrefix: { <PREFIX>: { tabId, paneId } } }` map.
 *
 * Persistence: machine-coordination dir / downtime-dispatch-anchor.json — { paneId, workspaceId }.
 *              machine-coordination dir / downtime-dispatch-tab-anchors.json — per-prefix map.
 * Provisioning: workspace create --label Dispatcher (no-focus) + anchor pane;
 *               tab create --workspace <id> --label <PREFIX> --no-focus.
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
export const DISPATCHER_TAB_ANCHOR_FILE = 'downtime-dispatch-tab-anchors.json';
export const DISPATCHER_WORKSPACE_LABEL = 'Dispatcher';

// ── Types ──────────────────────────────────────────────────────────────

export interface DispatcherAnchor {
  paneId: string;
  workspaceId: string;
}

export interface DispatcherAnchorDeps {
  /** Create a workspace. Resolves to { workspaceId, paneId } or throws. */
  createWorkspace(label: string): Promise<{ workspaceId: string; paneId: string }>;
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
  createTab?(workspaceId: string, label: string): Promise<DispatcherTabAnchorEntry | null>;
  /**
   * List live panes in a workspace as `{ paneId, tabId }` (optional;
   * production supplies it). Returns `null` on CLI/parse failure.
   */
  listPanes?(workspaceId: string): Promise<DispatcherPaneInfo[] | null>;
}

/** One parsed `herdr tab list` record (id + label). */
export interface DispatcherTabInfo {
  tabId: string;
  label: string;
}

/** One parsed `herdr pane list` record (only the fields tab-anchor resolution needs). */
export interface DispatcherPaneInfo {
  paneId: string;
  tabId: string;
}

/** Per-prefix tab anchor entry — one prefix maps to a tab + anchor pane. */
export interface DispatcherTabAnchorEntry {
  tabId: string;
  paneId: string;
}

/** Full per-prefix tab anchor map: workspaceId + map of prefix → tab/pane. */
export interface DispatcherTabAnchor {
  workspaceId: string;
  byPrefix: Record<string, DispatcherTabAnchorEntry>;
}

/** Build real deps exec'd against the herdr CLI (used in production). */
export function createDispatcherAnchorDeps(
  cwd: string,
  herdrBin: string = process.env.HERDR_BIN_PATH ?? 'herdr',
): DispatcherAnchorDeps {
  return {
    async createWorkspace(label: string) {
      const { stdout } = await execFile(herdrBin, ['workspace', 'create', '--label', label, '--no-focus'], { cwd, maxBuffer: 1024 * 1024 });
      const out = stdout.toString();
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
export function parseTabCreateOutput(raw: string): DispatcherTabAnchorEntry | null {
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
 * List the tabs of one workspace via `herdr tab list --workspace <id>`.
 * Returns `null` on CLI error or unparseable output (caller fails closed).
 */
export async function listTabsInWorkspace(
  cwd: string,
  workspaceId: string,
  herdrBin: string = process.env.HERDR_BIN_PATH ?? 'herdr',
): Promise<DispatcherTabInfo[] | null> {
  try {
    const { stdout } = await execFile(
      herdrBin,
      ['tab', 'list', '--workspace', workspaceId],
      { cwd, maxBuffer: 1024 * 1024 },
    );
    return parseTabListOutput(stdout.toString());
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
    const { stdout } = await execFile(
      herdrBin,
      ['pane', 'list', '--workspace', workspaceId],
      { cwd, maxBuffer: 1024 * 1024 },
    );
    return parsePaneListOutput(stdout.toString());
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
): Promise<DispatcherTabAnchorEntry | null> {
  let out: string;
  try {
    const { stdout } = await execFile(
      herdrBin,
      ['tab', 'create', '--workspace', workspaceId, '--label', label, '--no-focus'],
      { cwd, maxBuffer: 1024 * 1024 },
    );
    out = stdout.toString();
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

// ── Per-prefix tab anchor persistence ─────────────────────────────────

function tabAnchorFilePath(dir: string): string {
  return path.join(dir, DISPATCHER_TAB_ANCHOR_FILE);
}

/**
 * Read the per-prefix tab anchor map.
 *
 * - Missing file → an empty map (`{ workspaceId, byPrefix: {} }`), inheriting
 *   the `workspaceId` from the legacy single-anchor file when present so a
 *   pre-tab deployment upgrades in place; the caller provisions as needed.
 * - Corrupt/unreadable JSON → null (the caller handles re-provisioning).
 * - Tolerates herdr key-shape variants (`tabId`/`tab_id`/`id`,
 *   `paneId`/`pane_id`/`id`) so parser drift never silently drops entries.
 */
export function readTabAnchors(dir: string): DispatcherTabAnchor | null {
  const fp = tabAnchorFilePath(dir);
  if (!fs.existsSync(fp)) {
    // Missing file: backward-compatible upgrade. The legacy single-anchor
    // file (when present) supplies the workspaceId; otherwise the caller
    // resolves the workspace on first provisioning.
    const legacy = readAnchor(dir);
    return { workspaceId: legacy?.workspaceId ?? '', byPrefix: {} };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf-8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null; // corrupt JSON → caller re-provisions
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;

  const workspaceId = o.workspaceId ?? o.workspace_id;
  if (typeof workspaceId !== 'string') return null;

  const byPrefixRaw = o.byPrefix;
  const byPrefix: Record<string, DispatcherTabAnchorEntry> = {};
  if (byPrefixRaw !== undefined) {
    if (typeof byPrefixRaw !== 'object' || byPrefixRaw === null || Array.isArray(byPrefixRaw)) {
      return null;
    }
    for (const [prefix, entry] of Object.entries(byPrefixRaw as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const tabId = e.tabId ?? e.tab_id ?? e.id ?? '';
      const paneId = e.paneId ?? e.pane_id ?? e.id ?? '';
      if (typeof tabId === 'string' && tabId && typeof paneId === 'string' && paneId) {
        byPrefix[prefix] = { tabId, paneId };
      }
    }
  }

  return { workspaceId, byPrefix };
}

/**
 * Write the per-prefix tab anchor map. Uses atomic tmp+rename for safety.
 * Returns true on success, false on I/O error.
 */
export function writeTabAnchors(dir: string, anchors: DispatcherTabAnchor): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fp = tabAnchorFilePath(dir);
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(anchors), 'utf-8');
    fs.renameSync(tmp, fp);
    return true;
  } catch {
    return false;
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
    const anchor: DispatcherAnchor = { paneId: created.paneId, workspaceId: created.workspaceId };
    if (!writeAnchor(dir, anchor)) return null;
    return anchor;
  } finally {
    release();
  }
}

/**
 * Resolve the Dispatcher workspace id for per-prefix tab provisioning.
 *
 * Reuses the workspace recorded in the per-prefix tab-anchor file when it is
 * still alive (`herdr tab list` succeeds), so a pre-provisioned workspace is
 * never duplicated. Otherwise falls back to the legacy single-anchor
 * provisioning (`getDispatcherAnchor`) which creates the workspace once,
 * lock-guarded. Returns `null` (fail-closed) when the workspace cannot be
 * resolved.
 */
async function resolveDispatcherWorkspaceId(
  cwd: string,
  deps: DispatcherAnchorDeps,
  dir: string,
): Promise<string | null> {
  const listTabs =
    deps.listTabs ?? ((workspaceId: string) => listTabsInWorkspace(cwd, workspaceId));
  const persisted = readTabAnchors(dir);
  const persistedWs = persisted?.workspaceId ?? '';
  if (persistedWs !== '') {
    const tabs = await listTabs(persistedWs);
    if (tabs !== null) return persistedWs; // workspace still reachable → reuse
    // Workspace gone → fall through and (re)provision.
  }
  const anchor = await getDispatcherAnchor(cwd, deps);
  return anchor?.workspaceId ?? null;
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

/**
 * Return the anchor pane for the per-prefix tab `<PREFIX>` inside the single
 * machine-wide Dispatcher workspace, creating the tab on first use.
 *
 * Algorithm (fail-closed at every boundary):
 *  1. Fast path — a persisted `<prefix>` entry whose pane is alive is reused.
 *  2. Resolve the Dispatcher workspace (reuse the persisted workspace id,
 *     else provision it once via {@link getDispatcherAnchor}).
 *  3. Under the coordination lock, double-check the persisted entry; then
 *     look for a matching tab label via `herdr tab list` (adopting it with a
 *     live pane when found) to avoid duplicates; otherwise `herdr tab create`.
 *  4. Persist the merged `{ workspaceId, byPrefix }` map and return
 *     `{ workspaceId, tabId, paneId }`.
 *
 * Returns `null` on any failure (missing machine dir, provisioning error,
 * unparseable CLI output, lock contention with no persisted entry, or a
 * matching tab whose anchor pane cannot be resolved) so the caller degrades
 * to `anchor-unavailable` — never a wrong-tab or leader-workspace fallback.
 */
export async function getDispatcherTabAnchor(
  cwd: string,
  deps: DispatcherAnchorDeps,
  prefix: string,
): Promise<DispatcherTabAnchorEntry & { workspaceId: string } | null> {
  if (prefix === '') return null;
  const dir = getMachineCoordinationDir();
  if (dir === null) return null;
  if (!ensureMachineCoordinationDir(dir)) return null;

  // 1. Fast path: persisted entry whose anchor pane is still alive.
  const initial = readTabAnchors(dir);
  const fastEntry = initial?.byPrefix?.[prefix];
  if (fastEntry !== undefined) {
    try {
      if (await deps.isPaneAlive(fastEntry.paneId)) {
        return {
          workspaceId: initial.workspaceId,
          tabId: fastEntry.tabId,
          paneId: fastEntry.paneId,
        };
      }
    } catch {
      return null; // fail-closed on an aliveness probe error
    }
    // Stale → re-provision below.
  }

  // 2. Resolve (or provision) the Dispatcher workspace id.
  const workspaceId = await resolveDispatcherWorkspaceId(cwd, deps, dir);
  if (workspaceId === null) return null;

  // 3. Provision the tab under the coordination lock.
  const release = tryAcquireCoordLock(dir);
  if (release === null) {
    // Another holder is provisioning — re-read whatever they wrote, or fail.
    const racedAnchors = readTabAnchors(dir);
    const raced = racedAnchors?.byPrefix?.[prefix];
    if (raced !== undefined) {
      try {
        if (await deps.isPaneAlive(raced.paneId)) {
          return {
            workspaceId: racedAnchors?.workspaceId ?? workspaceId,
            tabId: raced.tabId,
            paneId: raced.paneId,
          };
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  try {
    // Double-check inside the lock: another instance may have written between
    // our earlier read and acquiring the lock.
    const inside = readTabAnchors(dir);
    const insideEntry = inside?.byPrefix?.[prefix];
    if (insideEntry !== undefined) {
      try {
        if (await deps.isPaneAlive(insideEntry.paneId)) {
          return { workspaceId, tabId: insideEntry.tabId, paneId: insideEntry.paneId };
        }
      } catch {
        return null;
      }
      // stale inside-lock → re-provision below
    }

    // Look for an existing tab with this exact label (raw prefix, case
    // preserved) to avoid creating a duplicate when the persisted map was
    // lost but the tab survives. `tab list` parse failure → fail closed
    // (a null list must never be read as "no tab exists").
    const listTabs =
      deps.listTabs ?? ((ws: string) => listTabsInWorkspace(cwd, ws));
    let tabs: DispatcherTabInfo[] | null;
    try {
      tabs = await listTabs(workspaceId);
    } catch {
      return null;
    }
    if (tabs === null) return null;
    const match = tabs.find((tab) => tab.label === prefix);
    if (match !== undefined) {
      const resolution = await resolveLivePaneInTab(cwd, deps, workspaceId, match.tabId);
      if (resolution.status === 'unknown') {
        // Cannot determine whether the existing tab is usable — fail closed
        // rather than risk a duplicate label.
        return null;
      }
      if (resolution.status === 'found') {
        const entry: DispatcherTabAnchorEntry = { tabId: match.tabId, paneId: resolution.paneId };
        if (!persistTabAnchor(dir, inside, workspaceId, prefix, entry)) return null;
        return { workspaceId, tabId: entry.tabId, paneId: entry.paneId };
      }
      // resolution.status === 'none' → the matching tab has no live pane; it
      // is dead, so fall through and create a replacement tab.
    }

    // Create the tab (never focus-stealing).
    const createTab =
      deps.createTab ?? ((ws: string, label: string) => createTabInWorkspace(cwd, ws, label));
    let created: DispatcherTabAnchorEntry | null;
    try {
      created = await createTab(workspaceId, prefix);
    } catch {
      return null;
    }
    if (created === null) return null;

    if (!persistTabAnchor(dir, inside, workspaceId, prefix, created)) return null;
    return { workspaceId, tabId: created.tabId, paneId: created.paneId };
  } finally {
    release();
  }
}

/**
 * Merge one prefix entry into the persisted map (preserving other prefixes)
 * and write it atomically. Returns `false` on write failure.
 */
function persistTabAnchor(
  dir: string,
  existing: DispatcherTabAnchor | null,
  workspaceId: string,
  prefix: string,
  entry: DispatcherTabAnchorEntry,
): boolean {
  const byPrefix: Record<string, DispatcherTabAnchorEntry> = {
    ...(existing?.byPrefix ?? {}),
    [prefix]: entry,
  };
  return writeTabAnchors(dir, { workspaceId, byPrefix });
}
