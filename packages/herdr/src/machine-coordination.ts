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
 * The resolver itself now lives in the shared package
 * (`@worklog/shared/model-cooldown`, WL-0MV563825002R9Y1) so the TUI recovery
 * loop (which writes the model-cooldown marker) and herdr (which reads it)
 * cannot drift. This module re-exports the shared constant and delegates
 * `getMachineCoordinationDir()` to `resolveMachineCoordinationDir()`.
 *
 * Single-machine v1 only; multi-machine (flock/NFS) is out of scope.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveMachineCoordinationDir,
  readModelCooldowns,
  clearModelCooldown,
  DEFAULT_MACHINE_COORDINATION_DIR,
  type ModelCooldownEntry,
} from '@worklog/shared/model-cooldown';

// ── Constants ──────────────────────────────────────────────────────────

/** Machine-wide coordination dir default: `~/.herdr/downtime`. */
export { DEFAULT_MACHINE_COORDINATION_DIR };

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
  return resolveMachineCoordinationDir();
}

/**
 * Read EVERY stored machine-wide model-cooldown entry — active AND
 * expired/due — for the dispatcher's bounded-wake path
 * (WL-0MV5639GG00085Q7).
 *
 * The cheap-switch gate reads only *active* entries (`readModelCooldowns`
 * with the current time). The wake path needs the opposite view: a marker
 * whose `cooldownUntil` has just passed is exactly the pane the dispatcher
 * must wake. Passing `now = 0` returns every stored entry (all markers have
 * `cooldownUntil > 0`); the stalled scan then distinguishes active (skip)
 * from due (wake) against its own injected clock.
 *
 * Returns `null` when the coordination directory is unresolvable or the file
 * is unreadable/corrupt — fail-safe (the scan then has no cooldown
 * candidates). A missing file is `[]` (nothing recorded). Never throws.
 */
export function readStoredModelCooldowns(): ModelCooldownEntry[] | null {
  return readModelCooldowns(getMachineCoordinationDir(), 0);
}

/**
 * Consume a pane's machine-wide model-cooldown marker after a SUCCESSFUL
 * in-place resume (WL-0MV5639GG00085Q7), so the same pane is not woken
 * repeatedly. Best-effort: a missing/unreadable marker returns `false`; never
 * throws.
 */
export function clearStoredModelCooldown(paneId: string): boolean {
  return clearModelCooldown(getMachineCoordinationDir(), paneId);
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
//
// STATUS: READ-COMPATIBILITY ONLY (WL-0MVXY0XPF006YUHA F2 AC2).
//
// Decision. The `active-audit` marker file is RETIRED in favour of the
// machine-scoped dispatch-budget ledger (`host-dispatch-budget.ts`, kind
// `audit`, cap `maxAudit`). The ledger is the single authority for in-flight
// audits because it is count-aware (a marker is single-flight by
// construction) and carries the same release points and 2 h staleness rule.
//
// Read-compatibility (exactly ONE release). A non-stale `active-audit` file
// is still READ: `host-dispatch-budget.ts`'s `freshCount('audit')` counts it as
// ONE synthetic audit entry, so a mixed-version host — an older herdr
// instance still writing the marker — can never be double-dispatched against.
// The file is NEVER created and NEVER removed by this version: the writers
// (`writeActiveAuditMarker` / `removeActiveAuditMarker`) were deleted with this
// change, so no code path can resurrect the marker or mask a ledger bug.
//
// Removal schedule. The readers below (and the synthetic-entry count) are
// removed in the release AFTER the host-wide budget generalisation ships —
// once every instance on the host is expected to run a budget-aware version.
// The schedule and the mixed-version rationale are documented for operators in
// F6 (docs: gate table, machine-dir files, fail directions).
//
// Everything below is read-only; nothing here writes to the coordination dir.

/**
 * File name of the RETIRED host-wide active-audit serialisation marker inside
 * the machine coordination directory (`~/.herdr/downtime/`).
 *
 * Read-only since WL-0MVXY0XPF006YUHA F2: a non-stale file written by an older
 * instance is counted as one synthetic audit entry by the dispatch-budget
 * ledger; this version never creates or removes it.
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
 * Shape of the RETIRED host-wide active-audit serialisation marker file.
 */
export interface ActiveAuditMarker {
  /** The instance id that held the audit slot. */
  instanceId: string;
  /** ISO-8601 UTC timestamp when the audit was dispatched. */
  dispatchedAt: string;
}

/**
 * Read the RETIRED host-wide active-audit serialisation marker.
 *
 * Kept for one release of read-compatibility (WL-0MVXY0XPF006YUHA F2 AC2): a
 * non-stale marker written by an older instance is counted as one synthetic
 * audit entry by the dispatch-budget ledger. Returns `null` when the file does
 * not exist, is unreadable, or cannot be parsed — the caller treats this as
 * "no legacy audit" (fail-safe).
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
 * Check whether a host-wide active-audit marker is present and non-stale.
 *
 * Kept for one release of read-compatibility (WL-0MVXY0XPF006YUHA F2 AC2).
 * The ledger is the authority for audit admission; this reader remains only so
 * operators/tests can inspect a legacy file, and so a mixed-version host's
 * marker is still recognised as one synthetic audit entry.
 *
 * Returns `true` when a valid marker exists whose age is within the stale
 * window (`DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS`), meaning an audit dispatched
 * by an older instance may still be running on the host.
 *
 * A stale marker (older than the window) is treated as released — the audit
 * pane may have crashed without cleanup — and `false` is returned.
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
