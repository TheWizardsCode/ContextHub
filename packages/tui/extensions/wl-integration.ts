// wl-integration.ts
// Integration layer for executing wl CLI commands safely and providing
// direct database access via the shared WorklogDatabase.
//
// Provides a spawn wrapper, JSON parsing, timeout handling, direct SQLite
// access, and event emitter for UI consumers.

import { EventEmitter } from "events";
import * as fs from 'node:fs';
import * as path from 'node:path';
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Use createRequire with realpath-resolved path for symlink-safe imports.
const _require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const { runWlCommand, wlEvents, WlError } = _require("../../../dist/wl-integration/spawn.js");

// ── Direct database access ────────────────────────────────────────────

let _db: any = null;

/**
 * Walk up from cwd to find the .worklog directory.
 * Returns null when not found (no graceful fallback — caller shows a message).
 */
function findWorklogDir(): string | null {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    // Check both .worklog directory and the old config pattern
    const dotWorklog = path.join(dir, '.worklog');
    if (fs.existsSync(dotWorklog) && fs.statSync(dotWorklog).isDirectory()) {
      return dotWorklog;
    }
    dir = path.dirname(dir);
  }
  // One last check at root
  const rootDir = path.join(dir, '.worklog');
  if (fs.existsSync(rootDir) && fs.statSync(rootDir).isDirectory()) {
    return rootDir;
  }
  return null;
}

/**
 * Create and return a shared WorklogDatabase instance for direct SQLite access.
 * Caches the instance so multiple callers share the same connection.
 *
 * Returns null when the .worklog directory cannot be found, allowing callers
 * to degrade gracefully (e.g. fall back to CLI or show a message).
 */
/**
 * Global test override: when set, `getWorklogDb()` returns this value
 * instead of attempting to open a real database. Set in test setup/mocks.
 *
 * ```ts
 * import { __testDbOverride } from './wl-integration.js';
 * __testDbOverride.value = fakeDb;
 * ```
 */
export const __testDbOverride: { value: any | null } = { value: undefined };

/**
 * Whether direct database access is disabled (e.g. in tests).
 * When true, `getWorklogDb()` always returns `null`.
 */
function isDirectDbDisabled(): boolean {
  if (__testDbOverride.value !== undefined) return false; // override set, check it
  return process.env.WL_TUI_DISABLE_DIRECT_DB === '1';
}

/**
 * Create and return a shared WorklogDatabase instance for direct SQLite access.
 * Caches the instance so multiple callers share the same connection.
 *
 * Returns null when:
 * - The .worklog directory cannot be found
 * - The SQLite database file doesn't exist
 * - `WL_TUI_DISABLE_DIRECT_DB=1` is set (used in tests)
 * - The @worklog/shared package is not available
 * - `__testDbOverride.value` is explicitly set to `null`
 *
 * Callers should gracefully fall back to CLI when this returns null.
 */
export function getWorklogDb(): any | null {
  // Test override takes highest priority
  if (__testDbOverride.value !== undefined) return __testDbOverride.value;
  if (isDirectDbDisabled()) return null;

  if (_db) return _db;

  try {
    const worklogDir = findWorklogDir();
    if (!worklogDir) return null;

    const dbPath = path.join(worklogDir, 'worklog.db');
    if (!fs.existsSync(dbPath)) return null;

    // Lazy-import WorklogDatabase — the shared package must be available
    // (installed via npm; if not, direct DB access degrades gracefully).
    const { WorklogDatabase: SharedDb } = _require('@worklog/shared');
    // Use the file: dependency resolution to find the package
    _db = new SharedDb('WI', dbPath, undefined, true);
    return _db;
  } catch {
    return null;
  }
}

/**
 * Release the shared database connection.
 */
export function closeWorklogDb(): void {
  _db = null;
}

/**
 * Options for running a wl command.
 */
export interface RunWlOptions {
  /** Timeout in milliseconds. Defaults to 5000ms. */
  timeout?: number;
  /** Working directory for the command. */
  cwd?: string;
  /** Environment overrides. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Executes a wl CLI command and returns the parsed JSON output.
 * Emits events using the shared wlEvents emitter:
 *   - "command:start"
 *   - "command:success"
 *   - "command:error"
 */

export async function runWl(
  command: string,
  args: string[] = [],
  options: RunWlOptions = {}
): Promise<any> {
  // Forward options to the lower-level runner
  // Ensure JSON output is requested for parsing
  const cmdArgs = [command, ...args];
  if (!cmdArgs.includes("--json")) {
    cmdArgs.push("--json");
  }
  const result = await runWlCommand(cmdArgs, {
    ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
    cwd: options.cwd,
    env: options.env,
  });
  // If there was an error, re-throw it for the caller to handle
  if (result.error) {
    // The lower-level already emitted "command:error"
    throw result.error;
  }
  // If JSON parse failed but exit code was 0, still return the raw stdout
  if (!result.json && result.stdout) {
    try {
      result.json = JSON.parse(result.stdout);
    } catch {
      // Return whatever we could parse
    }
  }
  // Successful result contains parsed JSON in result.json.  For commands
  // that return an envelope with `workItem`, unwrap it so TUI callers can
  // consume the actual item directly while still allowing list/show commands
  // to return their original shapes.
  if (result.json && typeof result.json === 'object') {
    const payload = (result.json as any).workItem ?? result.json;
    return payload;
  }
  return result.json;
}

export { wlEvents };

