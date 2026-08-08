/**
 * wl CLI read-cache wiring (F2 — WL-0MSGAEC5N006W5QA).
 *
 * Routes `list`, `next`, `show`, `search`, `status` (JSON mode only) through
 * the shared on-disk read cache so herdr panes / pi-agent polling don't
 * re-query the SQLite DB for byte-identical invocations.
 *
 * Fingerprint model (see read-cache.ts): the SQLite files are rewritten by
 * the app on every open/close (`journal_mode = WAL` + schema init touch the
 * header), so file-based fingerprints are not stable across processes. The
 * CLI therefore fingerprints DB state with a monotonic per-worklog-dir write
 * counter in the cache dir: stable across reads, bumped on every write.
 *
 * Orchestration model (see src/cli.ts for the hook wiring):
 *   1. preAction — for a cacheable read invocation, `lookup()` serves the
 *      cached payload (if fresh) or arms a backfill that records the state
 *      counter captured *before* the action reads the DB.
 *   2. post-output — the JSON payload each command emits via `output.json`
 *      is routed through `onJsonOutput()`, which stores it keyed by
 *      (worklog-dir, argv) only if the state counter is unchanged since the
 *      lookup (a concurrent write would have bumped it).
 *   3. write commands — `invalidateOnWrite()` bumps the state counter (and
 *      drops entry files), so no stale result can be served after a mutation.
 *   4. read write-byproducts (`next`'s auto re-sort) — `invalidateCacheForWrite()`
 *      bumps the counter when the byproduct lands (see src/commands/next.ts).
 *
 * The TTL safety net bounds staleness from writes the counter misses (e.g.
 * external tools writing the DB directly).
 */

import {
  ReadCache,
  bumpStateCounter,
  counterFingerprint,
  fingerprintsEqual,
  resolveCacheDir,
  type DbFingerprint,
} from './read-cache.js';
import { resolveWorklogDir } from './worklog-paths.js';
import { recordSpawn } from './spawn-counter.js';
import * as path from 'path';

/** Commands whose JSON output is a deterministic function of (DB state, argv). */
export const READ_CACHE_COMMANDS: ReadonlySet<string> = new Set(['list', 'next', 'show', 'search', 'status']);

/**
 * Read-command flags that make an invocation non-cacheable:
 *   - `--rebuild-index` (search): rebuilds the FTS index — a write.
 *   - `--semantic` / `--semantic-only` (search): external embedding API,
 *     non-deterministic output.
 */
const NON_CACHEABLE_READ_FLAGS: ReadonlySet<string> = new Set(['--rebuild-index', '--semantic', '--semantic-only']);

/** True when the command is one of the read commands covered by the cache. */
export function isCacheableReadCommand(command: string): boolean {
  return READ_CACHE_COMMANDS.has(command);
}

/** True when the raw argv requests JSON output. */
export function argvIsJsonMode(argv: string[]): boolean {
  return argv.includes('--json');
}

/** True when the argv contains a flag that makes a read non-cacheable. */
export function hasNonCacheableReadFlags(argv: string[]): boolean {
  return argv.some((a) => NON_CACHEABLE_READ_FLAGS.has(a));
}

/**
 * True when a (command, argv) invocation should be served from / backfilled
 * into the read cache. Requires a covered command, JSON mode, and no
 * write-byproduct / non-deterministic flags.
 */
export function shouldCacheReadInvocation(command: string, argv: string[]): boolean {
  if (!isCacheableReadCommand(command)) return false;
  if (!argvIsJsonMode(argv)) return false;
  if (hasNonCacheableReadFlags(argv)) return false;
  return true;
}

/** Canonical argv for cache keys: process.argv minus the node + script prefix. */
export function cacheKeyArgv(): string[] {
  return process.argv.slice(2);
}

/** Program-level options that take a value (skipped with their value). */
const GLOBAL_VALUE_OPTS = new Set(['--worklog-dir', '--format', '-F']);

/**
 * Extract the subcommand name from raw argv, skipping program-level options
 * and their values (`--json`, `--verbose`, `-F/--format <v>`, `--worklog-dir
 * <v>`, help/version flags). Returns null when no command token is found
 * (bare `wl`, `wl --json`, etc.).
 */
export function extractCommandFromArgv(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--verbose' || a === '--version' || a === '-h' || a === '--help' || a === '-w' || a === '--watch') {
      continue;
    }
    if (GLOBAL_VALUE_OPTS.has(a)) {
      i++; // skip the option's value
      continue;
    }
    if (a.startsWith('--format=') || a.startsWith('--worklog-dir=')) {
      continue;
    }
    if (a.startsWith('-')) {
      continue; // unknown/other flag — skip
    }
    return a;
  }
  return null;
}

/** State captured when a read lookup arms a backfill. */
interface BackfillInfo {
  worklogDir: string;
  argv: string[];
  fpBefore: DbFingerprint;
}

/**
 * Invalidate the read cache after a write that happens outside the normal
 * write-command flow (e.g. `next`'s auto re-sort byproduct). Bumps the state
 * counter so every previously cached entry for the worklog dir goes stale.
 * Uses the env-resolved cache dir, so it is safe to call from command
 * modules that never constructed a ReadCacheCli.
 */
export function invalidateCacheForWrite(): void {
  try {
    bumpStateCounter(resolveCacheDir(), resolveWorklogDir());
  } catch {
    // Best-effort: the TTL safety net bounds any missed invalidation.
  }
}

/**
 * Stateful cache orchestration for one CLI process: one shared cache, one
 * armed backfill at a time (a CLI process runs exactly one command).
 */
export class ReadCacheCli {
  private readonly cacheDir: string;
  private readonly cache: ReadCache;
  private backfill: BackfillInfo | null = null;

  constructor(options: { ttlMs?: number; maxEntries?: number; cacheDir?: string } = {}) {
    this.cacheDir = options.cacheDir ? path.resolve(options.cacheDir) : resolveCacheDir();
    this.cache = new ReadCache({
      cacheDir: this.cacheDir,
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      fingerprint: (worklogDir) => counterFingerprint(this.cacheDir, worklogDir),
    });
  }

  /**
   * Attempt to serve a cacheable read from cache; otherwise arm a backfill.
   *
   * Returns `{ served: true, value }` when a fresh cached payload exists
   * (the caller prints it and exits without any DB work), or
   * `{ served: false }` otherwise (the command runs normally and its JSON
   * output is routed through `onJsonOutput()` for backfill).
   */
  lookup(command: string, argv: string[]): { served: boolean; value?: unknown } {
    const worklogDir = resolveWorklogDir();
    if (!shouldCacheReadInvocation(command, argv)) {
      return { served: false };
    }
    const fpBefore = this.cache.fingerprintFor(worklogDir);
    const cached = this.cache.get(worklogDir, argv);
    if (cached !== null) {
      recordSpawn('cache-hit');
      return { served: true, value: cached };
    }
    recordSpawn('read-work');
    this.backfill = { worklogDir, argv, fpBefore };
    return { served: false };
  }

  /**
   * Route a produced JSON payload into the cache.
   *
   * Called from the wrapped `output.json`. Caches only when a backfill was
   * armed by `lookup()` AND the state counter is unchanged since then (a
   * mid-action write — e.g. `next`'s re-sort — means the payload is not
   * representative of a single stable DB state, so it is skipped).
   */
  onJsonOutput(data: unknown): void {
    const b = this.backfill;
    this.backfill = null;
    if (b === null || data === null || typeof data !== 'object') return;
    const fpNow = this.cache.fingerprintFor(b.worklogDir);
    if (!fingerprintsEqual(fpNow, b.fpBefore)) return;
    try {
      this.cache.set(b.worklogDir, b.argv, data, { dbFingerprint: b.fpBefore });
    } catch {
      // The cache must never break the CLI.
    }
  }

  /**
   * Drop every cached entry for the current worklog dir (after a write):
   * bumps the state counter (freshness) and removes entry files (tidiness).
   */
  invalidateOnWrite(): void {
    const worklogDir = resolveWorklogDir();
    try {
      bumpStateCounter(this.cacheDir, worklogDir);
    } catch {
      // Best-effort.
    }
    try {
      this.cache.invalidate(worklogDir);
    } catch {
      // Best-effort.
    }
  }

  /** Hit/miss counters (spawn-reduction reporting). */
  stats(): { hits: number; misses: number } {
    return this.cache.stats();
  }
}
