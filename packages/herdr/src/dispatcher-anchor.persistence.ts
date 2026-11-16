/**
 * packages/herdr/src/dispatcher-anchor.persistence.ts — anchor and tab-anchor
 * file persistence helpers.
 *
 * Single responsibility: persist and read back the dispatcher anchor state —
 * the legacy single-anchor file (`DISPATCHER_ANCHOR_FILE`) and the per-prefix
 * tab-anchors map (`DISPATCHER_TAB_ANCHORS_FILE`) — in the machine
 * coordination directory. Writes are atomic (tmp + rename); reads fail closed
 * (`null` on absent, empty or structurally invalid JSON).
 *
 * Moved verbatim out of `dispatcher-anchor.ts` (parent WL-0MVGKHCP9005SJPZ;
 * child WL-0MW0JHBFX006GMBQ). No behaviour change: the same signatures, the
 * same fail-closed `null`/`false` return semantics and the same atomic write
 * order. These helpers are exports for sibling use only and are **not** added
 * to the `dispatcher-anchor.js` barrel, so the public surface is unchanged.
 *
 * Layering: imports the filenames from `dispatcher-anchor.contract.js` and
 * `getMachineCoordinationDir` from `./machine-coordination.js`. It never
 * imports the `dispatcher-anchor.js` barrel, so the barrel can import these
 * helpers without creating a cycle. `anchorFilePath` and `tabAnchorsFilePath`
 * stay module-local.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getMachineCoordinationDir } from './machine-coordination.js';
import {
  DISPATCHER_ANCHOR_FILE,
  DISPATCHER_PROJECT_WORKSPACES_FILE,
  DISPATCHER_TAB_ANCHORS_FILE,
} from './dispatcher-anchor.contract.js';
import type {
  DispatcherAnchor,
  DispatcherTabAnchors,
  ProjectWorkspaceRecord,
  ProjectWorkspacesByRoot,
} from './dispatcher-anchor.contract.js';

// ── Persistence helpers ────────────────────────────────────────────────

function anchorFilePath(dir: string): string {
  return path.join(dir, DISPATCHER_ANCHOR_FILE);
}

export function readAnchor(dir: string): DispatcherAnchor | null {
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

export function writeAnchor(dir: string, anchor: DispatcherAnchor): boolean {
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

// ── Per-prefix tab-anchor persistence (C1) ─────────────────────────────

/** Path to the per-prefix tab-anchors persistence file. */
function tabAnchorsFilePath(dir: string): string {
  return path.join(dir, DISPATCHER_TAB_ANCHORS_FILE);
}

/**
 * Read the per-prefix tab-anchors map. Returns `null` when absent, empty, or
 * structurally invalid (caller treats as "no anchors yet").
 */
export function readTabAnchors(dir: string): DispatcherTabAnchors | null {
  try {
    const raw = fs.readFileSync(tabAnchorsFilePath(dir), 'utf-8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    const workspaceId = o.workspaceId ?? o.workspace_id;
    const byPrefix = o.byPrefix;
    if (typeof workspaceId !== 'string' || !workspaceId) return null;
    if (
      byPrefix === undefined ||
      byPrefix === null ||
      typeof byPrefix !== 'object' ||
      Array.isArray(byPrefix)
    ) {
      return null;
    }
    const out: DispatcherTabAnchors = { workspaceId, byPrefix: {} };
    for (const [prefix, entry] of Object.entries(byPrefix as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const tabId = rec.tabId ?? rec.tab_id;
      const paneId = rec.paneId ?? rec.pane_id;
      if (typeof tabId === 'string' && tabId !== '' && typeof paneId === 'string' && paneId !== '') {
        out.byPrefix[prefix] = { tabId, paneId };
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Atomically persist the per-prefix tab-anchors map (tmp + rename). */
export function writeTabAnchors(dir: string, anchors: DispatcherTabAnchors): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fp = tabAnchorsFilePath(dir);
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(anchors), 'utf-8');
    fs.renameSync(tmp, fp);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronously read the legacy single-anchor file to obtain the Dispatcher
 * workspace id without launching the herdr CLI. Returns `null` when absent.
 */
export function readDispatcherWorkspaceId(): string | null {
  const dir = getMachineCoordinationDir();
  if (dir === null) return null;
  const existing = readAnchor(dir);
  return existing === null ? null : existing.workspaceId;
}

/**
 * Upsert one prefix → { tabId, paneId } entry in the persisted per-prefix
 * map, keeping the Dispatcher `workspaceId` current. Returns `true` when the
 * map was written.
 *
 * Always writes (even when the entry is unchanged) so a stale entry whose
 * pane was superseded in herdr is corrected rather than left to be
 * re-resolved on every dispatch.
 *
 * Self-pruning (WL-0MWHCUX6A002W8ZG): herdr ids are workspace-scoped with a
 * `<workspaceId>:` prefix, so on every rewrite each carried-over `byPrefix`
 * entry is kept only when BOTH ids start with the workspace being written —
 * an entry pointing into a superseded/dead workspace (or holding an
 * ill-formed id) can never resolve and is dropped, keeping the persisted map
 * truthful without any `wl`/herdr call. The upserted ids are validated the
 * same way: an ill-formed id fails closed with `false` and nothing written.
 */
export function persistPrefixTab(
  dir: string,
  workspaceId: string,
  prefix: string,
  tabId: string,
  paneId: string,
): boolean {
  const current = readTabAnchors(dir);
  const anchors: DispatcherTabAnchors = {
    workspaceId,
    byPrefix: {},
  };
  const wsPrefix = `${workspaceId}:`;
  if (current !== null) {
    for (const [p, entry] of Object.entries(current.byPrefix)) {
      if (entry.tabId.startsWith(wsPrefix) && entry.paneId.startsWith(wsPrefix)) {
        anchors.byPrefix[p] = entry;
      }
    }
  }
  if (!tabId.startsWith(wsPrefix) || !paneId.startsWith(wsPrefix)) return false;
  anchors.byPrefix[prefix] = { tabId, paneId };
  return writeTabAnchors(dir, anchors);
}

// ── Per-root project-workspace map (WL-0MWHW3PKX0048ZYL, AC2) ─────────

/** Path to the per-root project-workspaces persistence file. */
function projectWorkspacesFilePath(dir: string): string {
  return path.join(dir, DISPATCHER_PROJECT_WORKSPACES_FILE);
}

/**
 * Read the per-root project-workspace map. Returns `null` when absent,
 * empty, or structurally invalid (caller treats as "no durable mapping").
 *
 * The map is the DURABLE source for root→workspace resolution: it keeps a
 * root's project workspace resolvable when the plugin pane that advertised
 * it is no longer alive at dispatch time, and it survives the pruning of
 * dead coordination entries (it is not the coordination file).
 */
export function readProjectWorkspaces(dir: string): ProjectWorkspacesByRoot | null {
  try {
    const raw = fs.readFileSync(projectWorkspacesFilePath(dir), 'utf-8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    const byRoot = o.byRoot;
    if (
      byRoot === undefined ||
      byRoot === null ||
      typeof byRoot !== 'object' ||
      Array.isArray(byRoot)
    ) {
      return null;
    }
    const out: ProjectWorkspacesByRoot = { byRoot: {} };
    for (const [root, entry] of Object.entries(byRoot as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const workspaceId = rec.workspaceId ?? rec.workspace_id;
      if (typeof workspaceId !== 'string' || workspaceId === '') continue;
      const record: ProjectWorkspaceRecord = { workspaceId };
      const paneId = rec.paneId ?? rec.pane_id;
      if (typeof paneId === 'string' && paneId !== '') record.paneId = paneId;
      const tabId = rec.tabId ?? rec.tab_id;
      if (typeof tabId === 'string' && tabId !== '') record.tabId = tabId;
      if (typeof rec.updatedAt === 'string' && rec.updatedAt !== '') {
        record.updatedAt = rec.updatedAt;
      }
      out.byRoot[root] = record;
    }
    return out;
  } catch {
    return null;
  }
}

/** Atomically persist the per-root project-workspace map (tmp + rename). */
function writeProjectWorkspaces(dir: string, map: ProjectWorkspacesByRoot): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fp = projectWorkspacesFilePath(dir);
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map), 'utf-8');
    fs.renameSync(tmp, fp);
    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert one root → workspace record in the per-root map (write-through on
 * a live plugin-pane match). Atomic tmp+rename; existing roots are kept.
 * Best-effort: a missing machine dir or an I/O failure returns `false` and
 * never throws — the durable map is a hint, never a hard dependency.
 */
export function upsertProjectWorkspace(
  dir: string,
  root: string,
  record: ProjectWorkspaceRecord,
): boolean {
  if (root === '' || record.workspaceId === '') return false;
  const current = readProjectWorkspaces(dir);
  const byRoot: Record<string, ProjectWorkspaceRecord> = current !== null
    ? { ...current.byRoot }
    : {};
  byRoot[root] = record;
  return writeProjectWorkspaces(dir, { byRoot });
}

/**
 * Remove one root from the per-root map (a durable entry probed MISSING
 * from live herdr state is dropped so it can never route into a dead
 * workspace again). Best-effort: returns `true` when the write happened,
 * `false` on a missing entry / I/O failure — never throws.
 */
export function removeProjectWorkspace(dir: string, root: string): boolean {
  const current = readProjectWorkspaces(dir);
  if (current === null || current.byRoot[root] === undefined) return false;
  const byRoot: Record<string, ProjectWorkspaceRecord> = { ...current.byRoot };
  delete byRoot[root];
  return writeProjectWorkspaces(dir, { byRoot });
}
