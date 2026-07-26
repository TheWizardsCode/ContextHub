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
// ── In-memory cache for frequent queries (Phase 5) ───────────────

interface CacheEntry {
  value: any;
  expiresAt: number;
}

const _queryCache = new Map<string, CacheEntry>();

/** Default cache TTL in milliseconds (5 seconds). Set to 0 to disable caching. */
const DEFAULT_CACHE_TTL_MS = 5000;

/**
 * Current cache TTL. Can be overridden via `setCacheTtlMs()`.
 */
let _cacheTtlMs = DEFAULT_CACHE_TTL_MS;

/**
 * Override the global cache TTL. Set to 0 to disable caching entirely.
 */
export function setCacheTtlMs(ms: number): void {
  _cacheTtlMs = Math.max(0, ms);
}

/**
 * Clear all cached query results. Called automatically on write operations.
 */
export function clearQueryCache(): void {
  _queryCache.clear();
}

/**
 * Get a cached value, or undefined if not cached / expired.
 */
function cacheGet<T>(key: string): T | undefined {
  if (_cacheTtlMs === 0) return undefined;
  const entry = _queryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _queryCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

/**
 * Set a cached value with the configured TTL.
 */
function cacheSet<T>(key: string, value: T): void {
  if (_cacheTtlMs === 0) return;
  _queryCache.set(key, { value, expiresAt: Date.now() + _cacheTtlMs });
}

/**
 * Wrap a database instance with query caching.
 * Intercepts getAll() for reads and invalidates cache on writes.
 */
function withCache(db: any): any {
  return new Proxy(db, {
    get(target: any, prop: string | symbol, receiver: any) {
      const key = String(prop);

      // getAll() with cache
      if (key === 'getAll') {
        return (...args: any[]) => {
          const cacheKey = 'getAll';
          const cached = cacheGet<any[]>(cacheKey);
          if (cached !== undefined) return cached;
          const result = Reflect.apply(target.getAll, target, args);
          if (Array.isArray(result)) cacheSet(cacheKey, result);
          return result;
        };
      }

      // Write operations invalidate cache
      if (key === 'create' || key === 'update' || key === 'delete'
          || key === 'createComment' || key === 'close'
          || key === 'importData' || key === 'upsertItems'
          || key === 'saveDependencyEdge' || key === 'saveAuditResults' || key === 'saveAuditResult') {
        return (...args: any[]) => {
          clearQueryCache();
          return Reflect.apply((target as any)[key], target, args);
        };
      }

      // Pass through all other methods
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
    const rawDb = new SharedDb('WI', dbPath, undefined, true);
    _db = withCache(rawDb); // Phase 5: wrap with query cache
    return _db;
  } catch {
    return null;
  }
}

/**
 * Release the shared database connection and clear all caches.
 */
export function closeWorklogDb(): void {
  if (_db) {
    try {
      // Attempt to close the underlying SQLite connection
      const inner = _db.store || _db;
      if (typeof inner.close === 'function') inner.close();
    } catch {
      // Best-effort cleanup
    }
  }
  _db = null;
  clearQueryCache();
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

