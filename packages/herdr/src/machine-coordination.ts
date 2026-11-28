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
 * Coordination scope. This resolver, and the local ledger it locates, is
 * single-machine: flock/NFS coordination across machines is NOT used. The
 * cross-machine mechanism for the one resource that actually needs it — the
 * audit budget — is the PROXY's audit budget and live audit-lease registry,
 * queried by herdr over HTTP (`GET {proxyUrl}/llama/local/audit/availability`). See
 * `docs/dev/downtime-dispatcher.md` → "Proxy-derived audit admission". This
 * supersedes the older "multi-machine is out of scope" note.
 */

import * as fs from 'node:fs';
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
 * Read the machine-wide model cooldowns ACTIVE at `now` for budget relief
 * (WL-0MWTAD9NV000IVK5). The dispatch budget reads this once per dispatch
 * attempt and threads the result into admission, so a tick cannot observe two
 * different relief caps.
 *
 * Delegates to {@link readModelCooldowns}: returns only active entries
 * (`cooldownUntil > now`), `[]` when nothing is recorded, and `null` when the
 * coordination dir is unresolvable or the file is unreadable/corrupt. Relief
 * treats `null` as fail-closed (no relief) — the deliberate opposite of the
 * reader's own "assume active" convention. Never throws.
 */
export function readActiveModelCooldowns(now: number = Date.now()): ModelCooldownEntry[] | null {
  return readModelCooldowns(getMachineCoordinationDir(), now);
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
