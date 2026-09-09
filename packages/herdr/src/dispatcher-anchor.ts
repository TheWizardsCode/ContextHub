/**
 * packages/herdr/src/dispatcher-anchor.ts — Dedicated Dispatcher workspace anchor provisioning
 *
 * Parent: WL-0MTR01EU7005SYZG (Dispatcher anchor-by-ID). Child F1 WL-0MTR2CD4X006XI7U.
 *
 * Provisions a dedicated "Dispatcher" workspace with a persisted anchor pane,
 * guarded by the coordination lock for concurrency safety.
 *
 * Persistence: machine-coordination dir / downtime-dispatch-anchor.json — { paneId, workspaceId }.
 * Provisioning: workspace create --label Dispatcher (no-focus) + anchor pane.
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
  };
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
