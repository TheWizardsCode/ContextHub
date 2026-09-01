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
