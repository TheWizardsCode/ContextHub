/**
 * packages/herdr/src/machine-coordination.ts — Machine-wide coordination dir resolver
 *
 * Parent: WL-0MTF0KLO10043YAN (Single machine-wide downtime leader).
 * Child: WL-0MTII3QI9001GUUK (F1: Machine coordination dir resolver).
 *
 * Resolves the single machine-wide downtime coordination directory that
 * replaces the legacy per-worklog `<worklog>/.worklog/` dirs.
 *
 *  - Default: `~/.herdr/downtime/` (home directory, `~/.herdr/downtime`).
 *  - Override: `HERDR_COORDINATION_DIR` environment variable (absolute or
 *    `~`-prefixed paths, the tilde is expanded).
 *  - The directory is provisioned on first access (`mkdir -p` idempotent).
 *  - When the resolved path is missing and cannot be created, the module
 *    returns `null` — callers degrade to "no dispatch this cycle" rather
 *    than throwing or crashing (fail-safe contract).
 *
 * All coordination, leader-election, worker, and log modules import from
 * this module instead of hard-coding paths, so the machine dir is a single
 * source of truth.
 *
 * Single-machine v1 only; multi-machine (flock/NFS) is out of scope.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Constants ──────────────────────────────────────────────────────────

/** Machine-wide coordination dir default: `~/.herdr/downtime`. */
export const DEFAULT_MACHINE_COORDINATION_DIR = '.herdr/downtime';

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Resolve the machine-wide coordination directory.
 *
 * Resolution order:
 *  1. `HERDR_COORDINATION_DIR` environment variable (if set and non-empty).
 *     If the value starts with `~`, it is expanded to the user's home
 *     directory (`os.homedir()`).
 *  2. Default: `~/.herdr/downtime` (resolved lazily at call time).
 *
 * Dir provisioning (idempotent mkdir -p) is deferred until the directory
 * is actually needed (coordination file I/O). This function only resolves
 * the path string.
 *
 * **Fail-safe contract:** when neither the env var nor the default
 * resolves to a usable path (e.g., `homedir()` throws, env var points
 * to an absolute path outside the user's home that cannot exist), returns
 * `null`. The caller must treat this as "no dispatch this cycle".
 *
 * @returns The resolved absolute path, or `null` when unresolvable.
 */
export function getMachineCoordinationDir(): string | null {
  // 1. Environment override (highest priority)
  const envDir = process.env.HERDR_COORDINATION_DIR;
  if (envDir && envDir.length > 0) {
    // Expand ~ to homedir()
    if (envDir.startsWith('~')) {
      const home = os.homedir();
      if (home) {
        return path.join(home, envDir.slice(1));
      }
      // homedir() failed — env var is unusable, fall through to default
    } else {
      // Absolute path — use as-is
      return envDir;
    }
  }

  // 2. Default (~/.herdr/downtime) — resolved lazily at call time so
  //    tests that mutate process.env.HOME can affect the result.
  try {
    const home = os.homedir();
    if (!home) return null; // homedir() returned empty string — fail-safe
    return path.join(home, DEFAULT_MACHINE_COORDINATION_DIR);
  } catch {
    // homedir() threw — fail-safe
  }

  // 3. Both env and default failed — return null (fail-safe)
  return null;
}

/**
 * Ensure the machine coordination directory exists on disk.
 *
 * Creates the directory (and parents) idempotently via `mkdir -p`.
 * Returns `true` when the directory exists/is created, `false` when
 * provisioning fails (returns false — never throws — and the caller
 * degrades to "no dispatch this cycle").
 *
 * This function is safe to call multiple times; it is a no-op when the
 * directory already exists.
 *
 * @returns `true` on success (dir exists after call), `false` on I/O failure.
 */
export function ensureMachineCoordinationDir(dir: string | null): boolean {
  if (dir === null) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    // I/O failure (permission denied, read-only fs, etc.) — fail-safe
    return false;
  }
}

/**
 * Check whether the machine coordination directory exists and is readable.
 *
 * @returns `true` when the directory exists and is readable, `false` otherwise.
 */
export function machineCoordinationDirExists(dir: string | null): boolean {
  if (dir === null) return false;
  try {
    const stats = fs.statSync(dir);
    return stats.isDirectory() && fs.accessSync(dir, fs.constants.R_OK) === undefined;
  } catch {
    return false;
  }
}

// ── Host-wide audit serialisation (WL-0MUIVE0YG000UVIA) ─────────────────

/**
 * File name of the host-wide active-audit serialisation marker inside the
 * machine coordination directory (`~/.herdr/downtime/`).
 *
 * This file is a simple, single-writer serialisation mechanism: at most one
 * audit-tier `/skill:audit` run should be actively executing per host —
 * across herdr instances and projects. The downtime worker writes this file
 * when an audit is dispatched and removes it when the audit completes or
 * times out (staleness window). Other instances check this file before
 * dispatching an audit and defer/skip when a non-stale marker is present.
 *
 * The file contains a JSON object with `instanceId` and `dispatchedAt` fields.
 * A marker older than `DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS` is treated as stale
 * (the audit pane may have crashed without cleanup) and ignored.
 *
 * Single-machine v1 only; multi-machine (flock/NFS) is out of scope.
 */
export const DOWNTIME_HOST_AUDIT_MARKER_FILE = 'active-audit';

/**
 * Staleness window for the host-wide active-audit marker
 * (WL-0MUIVE0YG000UVIA): a marker older than this is treated as stale —
 * the audit pane may have crashed without removing the marker. Default 2 hours,
 * matching `DOWNTIME_AUDIT_STALE_WINDOW_MS` so that stale audits are released
 * consistently across the per-worklog and host-wide checks.
 */
export const DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Shape of the host-wide active-audit serialisation marker file.
 */
export interface ActiveAuditMarker {
  /** The instance id that holds the audit slot. */
  instanceId: string;
  /** ISO-8601 UTC timestamp when the audit was dispatched. */
  dispatchedAt: string;
}

/**
 * Read the host-wide active-audit serialisation marker.
 *
 * Returns `null` when the file does not exist, is unreadable, or cannot be
 * parsed — the caller treats this as "no active audit" (fail-safe).
 *
 * @param dir The machine coordination directory (must be non-null).
 * @returns The parsed marker, or `null` when absent/unreadable.
 */
export function readActiveAuditMarker(dir: string): ActiveAuditMarker | null {
  const filePath = path.join(dir, DOWNTIME_HOST_AUDIT_MARKER_FILE);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const marker = parsed as Record<string, unknown>;
    if (typeof marker.instanceId !== 'string' || marker.instanceId.length === 0) return null;
    if (typeof marker.dispatchedAt !== 'string') return null;
    // Validate the timestamp is parseable
    const t = Date.parse(marker.dispatchedAt);
    if (Number.isNaN(t)) return null;
    return {
      instanceId: marker.instanceId,
      dispatchedAt: marker.dispatchedAt,
    };
  } catch {
    // File missing or unreadable → no active audit (fail-safe)
    return null;
  }
}

/**
 * Write the host-wide active-audit serialisation marker.
 *
 * Creates the machine coordination directory if needed. Overwrites any
 * existing marker (single-writer: the writer is expected to be the only
 * one writing).
 *
 * @param dir The machine coordination directory (must be non-null).
 * @param instanceId The instance id claiming this audit slot.
 * @returns `true` on success, `false` on I/O failure (fail-safe).
 */
export function writeActiveAuditMarker(
  dir: string,
  instanceId: string,
): boolean {
  if (!ensureMachineCoordinationDir(dir)) return false;
  const filePath = path.join(dir, DOWNTIME_HOST_AUDIT_MARKER_FILE);
  const marker: ActiveAuditMarker = {
    instanceId,
    dispatchedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(marker), 'utf8');
    return true;
  } catch {
    // I/O failure → fail-safe: no marker written, caller can proceed
    return false;
  }
}

/**
 * Remove the host-wide active-audit serialisation marker.
 *
 * Called when an audit completes (success, failure, or abort) to release
 * the host-wide slot for other instances.
 *
 * @param dir The machine coordination directory (must be non-null).
 * @returns `true` when the marker existed and was removed, `false` otherwise.
 */
export function removeActiveAuditMarker(dir: string): boolean {
  const filePath = path.join(dir, DOWNTIME_HOST_AUDIT_MARKER_FILE);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    // File already gone or unreadable → marker is effectively released
    return false;
  }
}

/**
 * Check whether a host-wide active-audit marker is present and non-stale.
 *
 * Returns `true` when a valid marker exists whose age is within the stale
 * window (`DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS`), meaning an audit is
 * actively running on the host and new audits must be deferred.
 *
 * A stale marker (older than the window) is treated as released — the audit
 * pane may have crashed without cleanup — and `false` is returned so new
 * audits can proceed.
 *
 * @param dir The machine coordination directory (must be non-null).
 * @param now Optional timestamp in ms (defaults to `Date.now()`).
 * @returns `true` when a non-stale marker is present.
 */
export function isHostAuditActive(
  dir: string,
  now: number = Date.now(),
): boolean {
  const marker = readActiveAuditMarker(dir);
  if (marker === null) return false;
  const dispatched = Date.parse(marker.dispatchedAt);
  if (Number.isNaN(dispatched)) return false;
  return now - dispatched < DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS;
}
