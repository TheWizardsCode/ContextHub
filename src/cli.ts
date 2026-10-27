#!/usr/bin/env node
/**
 * Thin CLI fast path (F4 — WL-0MVFRRKKN00544PQ).
 *
 * Start-up architecture (see docs/dev/wl-startup-import-budget.md):
 *
 *   fast path (this file)   argv normalisation, `--worklog-dir` override,
 *                           worktree process registration, read-cache lookup,
 *                           `--version`
 *   heavy graph             `src/cli-main.ts` — Commander, the command modules,
 *                           the plugin loader and the SQLite runtime, loaded
 *                           through a dynamic import only when the invocation
 *                           was not served from the cache.
 *
 * The static import allowlist here is the parent AC1 budget: adding an import
 * to this file fails `tests/cli/startup-import-budget.test.ts` until the
 * recorded ratchet is deliberately tightened.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname as pathDirname, join as pathJoin, sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFieldsArgv, extractCommandFromArgv } from './argv-normalize.js';
import { recordSpawn } from './spawn-counter.js';
import { WORKLOG_VERSION } from './version.js';

// ── Shared workspace build-output preflight (WL-0MVPADZ1Z000FOSG AC4) ──────
//
// `@worklog/shared/*` resolves through the workspace link into
// `packages/shared/dist` — gitignored build output. When a concurrent actor
// wipes it, every command used to die with a bare `ERR_MODULE_NOT_FOUND`
// stack trace naming a path nobody recognises. The helpers below turn that
// into one actionable line naming the missing artifact and the exact
// remediation (`npm run build:shared`).
//
// The check mirrors the runtime resolution (`import.meta.resolve` from THIS
// module, then an existence check) rather than guessing a repo root, so a
// linked worktree without its own `dist/` — where the runtime resolves the
// main checkout's build output through the symlinked `node_modules` — never
// sees a false positive.
//
// The helpers live in this file (rather than a new module) because the
// startup import budget forbids growing the fast path's boot graph, and they
// are exported so the resolver can be unit-tested without spawning the CLI
// (see the import-safe invocation guard below).

/** Package specifier whose build output the preflight checks. */
export const SHARED_DIST_SPECIFIER = '@worklog/shared/worklog-paths';

/** Package-relative artifact path, for diagnostics and tests. */
export const SHARED_DIST_ARTIFACT_RELPATH = 'packages/shared/dist/worklog-paths.js';

/** Maximum ancestor levels walked when locating the repository root. */
const REPO_ROOT_SEARCH_DEPTH = 8;

/**
 * Best-effort absolute path of the artifact the runtime would load.
 *
 * Walks up from the module's directory (bounded) to the repository root (the
 * nearest directory owning `packages/shared/package.json`). Returns `null`
 * when no such root exists (a relocated bundle), so callers never invent a
 * path.
 *
 * @param moduleUrl - module URL to anchor the search (defaults to this module)
 */
export function expectedSharedDistArtifactPath(
  moduleUrl: string = import.meta.url
): string | null {
  let dir = pathDirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth <= REPO_ROOT_SEARCH_DEPTH; depth++) {
    if (existsSync(pathJoin(dir, 'packages', 'shared', 'package.json'))) {
      return pathJoin(dir, ...SHARED_DIST_ARTIFACT_RELPATH.split('/'));
    }
    const parent = pathDirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The single actionable diagnostic printed when the artifact is missing:
 * the missing artifact, the absolute path checked, and the exact remediation.
 */
export function missingSharedDistDiagnostic(artifactPath: string): string {
  // <repo>/packages/shared/dist/worklog-paths.js → <repo>
  const repoRoot = pathDirname(
    pathDirname(pathDirname(pathDirname(artifactPath)))
  );
  return [
    'wl: cannot start — the shared workspace build output is missing.',
    `  Missing artifact: ${artifactPath}`,
    '  wl resolves @worklog/shared/* from packages/shared/dist, which is',
    '  gitignored build output (a wiped build tree produces this).',
    `  Fix: run \`npm run build:shared\` in ${repoRoot} and retry.`,
  ].join('\n');
}

/** Resolver signature injected by tests (defaults to `import.meta.resolve`). */
export type SharedDistResolver = (specifier: string) => string;

/** Options for {@link sharedDistPreflight} (a test seam only). */
export interface SharedDistPreflightOptions {
  moduleUrl?: string;
  resolve?: SharedDistResolver;
}

function defaultSharedDistResolver(specifier: string): string {
  const resolver = (import.meta as ImportMeta & {
    resolve?: (specifier: string) => string;
  }).resolve;
  if (typeof resolver !== 'function') {
    throw new Error('import.meta.resolve is unavailable in this runtime');
  }
  return resolver(specifier);
}

/**
 * Preflight: return the diagnostic when the shared build output is missing,
 * or `null` when the CLI may proceed.
 *
 * Proceeds when the runtime resolution of {@link SHARED_DIST_SPECIFIER}
 * yields an existing file (a healthy checkout, including a worktree that
 * resolves the main checkout's `dist/` through the symlinked
 * `node_modules`). When resolution fails or the resolved file does not
 * exist, the diagnostic names the absolute path checked. When the path
 * cannot be determined at all, the check stays silent (fail-open — it may
 * only fire for a genuinely missing artifact).
 */
export function sharedDistPreflight(
  options: SharedDistPreflightOptions = {}
): string | null {
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const resolve = options.resolve ?? defaultSharedDistResolver;
  const expected = expectedSharedDistArtifactPath(moduleUrl);

  let resolvedPath: string | null = null;
  try {
    const resolved = resolve(SHARED_DIST_SPECIFIER);
    resolvedPath = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;
  } catch {
    resolvedPath = null;
  }

  if (resolvedPath !== null && existsSync(resolvedPath)) return null;

  const artifactPath = resolvedPath ?? expected;
  if (artifactPath === null) return null; // cannot judge — never guess
  return missingSharedDistDiagnostic(artifactPath);
}

// ── Import-safe invocation guard ──────
// Only a real CLI invocation may run the fast path. Importing this module
// (the preflight resolver's unit tests) must not execute the CLI, so the
// entry point is compared by realpath — which also keeps symlinked launchers
// (`/usr/local/bin/wl -> …/dist/cli.js`) working.
const _invokedAsEntry = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

// Watch flag parsing - supports -w, -wN, --watch, --watch=N
function parseWatchFlag(argv: string[]) {
  const out = argv.slice();
  let enabled = false;
  let seconds = 5;

  for (let i = 2; i < out.length; i++) {
    const v = out[i];
    if (v === '-w' || v === '--watch') {
      enabled = true;
      if (i + 1 < out.length && !out[i + 1].startsWith('-')) {
        const parsed = parseInt(out[i + 1], 10);
        if (!Number.isNaN(parsed) && parsed > 0) seconds = parsed;
        out.splice(i, 2);
      } else {
        out.splice(i, 1);
      }
      break;
    }
    if (v.startsWith('--watch=')) {
      enabled = true;
      const parsed = parseInt(v.split('=', 2)[1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) seconds = parsed;
      out.splice(i, 1);
      break;
    }
    if (v.startsWith('-w') && v.length > 2) {
      const parsed = parseInt(v.slice(2), 10);
      enabled = true;
      if (!Number.isNaN(parsed) && parsed > 0) seconds = parsed;
      out.splice(i, 1);
      break;
    }
  }

  return { enabled, seconds, argvWithoutWatch: out };
}

const _parsedWatch = parseWatchFlag(process.argv);
if (_invokedAsEntry && _parsedWatch.enabled) {
  const freq = _parsedWatch.seconds;
  // Use the cleaned argv (includes node and script) and spawn the same
  // command (node <script> <args...>) but with the watch flag removed.
  const spawnArgs = _parsedWatch.argvWithoutWatch.slice(1);
  const bannerCommand = _parsedWatch.argvWithoutWatch.slice(2).join(' ') || '(no command)';

  const formatWatchTimestamp = (date: Date) => {
    const parts = date.toString().split(' ');
    if (parts.length >= 5) {
      return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[4]} ${parts[3]}`;
    }
    return date.toString();
  };


  let shuttingDown = false;
  let childProcess: any = null;
  const shutdownHandler = () => {
    shuttingDown = true;
    try { process.stdout.write('\x1b[?25h'); } catch (_) {}
    if (!childProcess) {
      process.exit(0);
    }
    if (childProcess && !childProcess.killed) {
      try { childProcess.kill('SIGINT'); } catch (_) {}
      const forceExit = setTimeout(() => process.exit(0), 500);
      try { childProcess.once('exit', () => { clearTimeout(forceExit); process.exit(0); }); } catch (_) {}
    }
  };
  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  // top-level await is allowed in this module — run an async loop and await it
  await (async () => {
    let first = true;
    while (!shuttingDown) {
      if (!first) {
        try { process.stdout.write('\x1b[?25l\x1b[H\x1b[2J'); } catch (_) {}
      }
      first = false;

      const timestamp = formatWatchTimestamp(new Date());
      const leftText = `Every ${freq.toFixed(1)}s: ${bannerCommand}`;
      let banner = `${leftText}  ${timestamp}`;
      const cols = process.stdout.columns || 0;
      if (cols > 0) {
        const minGap = 2;
        const maxLeft = Math.max(0, cols - timestamp.length - minGap);
        const trimmedLeft = leftText.length > maxLeft ? leftText.slice(0, maxLeft) : leftText;
        const gap = Math.max(minGap, cols - timestamp.length - trimmedLeft.length);
        banner = `${trimmedLeft}${' '.repeat(gap)}${timestamp}`;
      }
      try { process.stdout.write(`\x1b[90m${banner}\x1b[0m\n`); } catch (_) {}

      // Spawn using the node executable so the script runs with the same
      // runtime regardless of how it was invoked (shebang, tsx, npm script).
      const spawnArgs = _parsedWatch.argvWithoutWatch.slice(1);

      try {
        const cp = await import('child_process');
        // Preserve any execArgv used to launch this process (e.g. --loader or -r flags
        // from tsx). Prepend them so the child runs with the same Node flags.
        const nodeArgs = [...process.execArgv, ...spawnArgs];
        // `cp` is the namespace object for the child_process module; use its spawn function
        childProcess = cp.spawn(process.execPath, nodeArgs, { stdio: 'inherit' });
      } catch (err: any) {
        childProcess = null;
      }

      await new Promise<void>(resolve => {
        if (!childProcess) return resolve();
        childProcess.on('exit', () => {
          childProcess = null;
          resolve();
        });
        childProcess.on('error', () => {
          childProcess = null;
          resolve();
        });
      });

      if (shuttingDown) break;

      await new Promise(r => setTimeout(r, freq * 1000));
      try { process.stdout.write('\x1b[?25h'); } catch (_) {}
    }
  })();
  // After loop exits, just return so the watcher process ends
  process.exit(0);
}


// Merge space-separated --fields continuations (e.g. `--fields id, title`)
// before Commander parses argv. Without this, the trailing token is mistaken
// for the positional search/query argument and the projection silently drops
// requested fields (WL-0MSLW8GHQ0092PJK).
if (_invokedAsEntry) {
  process.argv = [
    ...process.argv.slice(0, 2),
    ...normalizeFieldsArgv(process.argv.slice(2)),
  ];
}

// ── `--version` fast path (first thing: nothing else is imported) ─────────
// A bare `wl --version` / `-V` prints the version from the generated
// `src/version.ts` (plan decision D5 — no dependency on the current working
// directory's package.json) and exits without importing the cache machinery,
// the worklog resolver, the process-lifecycle module or the heavy graph
// (F7 — WL-0MVFRROLM002K98B). The spawn record lets the startup import-budget
// harness (F2 — WL-0MVFRRAXD001E7AN) read its CPU time and peak RSS from the
// same F1 spawn records as cache hits.
//
// Only a bare `wl --version` takes this path: when a command token is present
// (`wl list --version`) Commander's own option handling must decide, exactly as
// before the split.
const _fastArgv = normalizeFieldsArgv(process.argv.slice(2));
const _wantsVersion =
  extractCommandFromArgv(_fastArgv) === null &&
  (_fastArgv.includes('--version') || _fastArgv.includes('-V'));

if (_invokedAsEntry && _wantsVersion) {
  recordSpawn('version');
  process.stdout.write(`${WORKLOG_VERSION}\n`, () => process.exit(0));
  // Safety net if the flush callback never fires.
  setTimeout(() => process.exit(0), 2000).unref();
} else if (_invokedAsEntry) {

  // ── Shared build-output preflight (WL-0MVPADZ1Z000FOSG AC4) ────────────
  // Runs before the first load of `@worklog/shared/*` (via worklog-paths.js
  // below): a wiped `packages/shared/dist` must produce one actionable line,
  // not an `ERR_MODULE_NOT_FOUND` stack trace.
  const _sharedDistIssue = sharedDistPreflight();
  if (_sharedDistIssue !== null) {
    process.stderr.write(`${_sharedDistIssue}\n`);
    process.exit(1);
  }

  // Apply the --worklog-dir override from argv BEFORE anything resolves a
  // worklog path (the cache key and `ctx.dataPath` both depend on it). The
  // heavy path's preAction hook re-applies/clears the override from Commander's
  // parsed options. Resolving from the process cwd instead would let
  // `wl sync --worklog-dir <proj>/.worklog` fetch the cwd repo's remote ref
  // while writing to <proj>'s database (WL-0MSAH26DD001XXST).
  const { applyWorklogDirOverrideFromArgv } = await import('./worklog-paths.js');
  applyWorklogDirOverrideFromArgv(process.argv.slice(2));

  // If the CLI is running inside a ContextHub-managed worktree, register our
  // PID so `wl cleanup-worktree` can reap it. The check is a cheap path test, so
  // normal invocations never import the process-lifecycle module
  // (F7 — WL-0MVFRROLM002K98B). Behaviour inside a managed worktree is unchanged:
  // both the fast (cache-hit) and heavy paths still register.
  if (process.cwd().includes(`${pathSep}.worklog${pathSep}worktrees${pathSep}`)) {
    const { detectWorktreeFromCwd, registerCurrentProcess } = await import('./process-lifecycle.js');
    const worktreePath = detectWorktreeFromCwd();
    if (worktreePath) {
      registerCurrentProcess(worktreePath);
    }
  }

  // ── Read-cache wiring (F2 — WL-0MSGAEC5N006W5QA) ─────────────────────────
  // Serve repeat JSON read queries (list/next/show/search/status and the
  // consolidated `worklist` bundle) from the shared on-disk cache so herdr
  // panes / pi-agent polling don't re-query the SQLite DB for byte-identical
  // invocations. Env-gated config:
  //   WL_CACHE_DISABLED=1     — bypass the cache entirely (baseline behaviour)
  //   WL_CACHE_TTL_MS=<n>     — override the TTL safety net (tests/ops)
  //   WL_CACHE_DIR=<path>     — override the cache dir (see read-cache.ts)
  //   WL_SPAWN_COUNT_FILE     — spawn instrumentation (see spawn-counter.ts)
  const { ReadCacheCli, shouldCacheReadInvocation } = await import('./read-cache-cli.js');
  const readCacheEnabled = process.env.WL_CACHE_DISABLED !== '1';
  const _cacheTtl = parseInt(process.env.WL_CACHE_TTL_MS ?? '', 10);
  const readCacheCli = new ReadCacheCli({
    ttlMs: Number.isFinite(_cacheTtl) && _cacheTtl > 0 ? _cacheTtl : undefined,
  });

  // Read-cache serve: for a cacheable read invocation, try the cache BEFORE the
  // heavy graph loads. On a hit, print the cached payload (byte-identical to
  // output.json formatting) and exit — so no action runs, no DB is opened and no
  // command module, plugin or Commander instance is imported. The write+callback
  // exit guarantees piped stdout is flushed before the process terminates. When
  // the cache is disabled (baseline), cacheable reads still record a work spawn
  // so the spawn-reduction metric has a denominator.
  let cacheServed = false;
  const cacheArgv = process.argv.slice(2);
  const cacheCommand = extractCommandFromArgv(cacheArgv);
  if (cacheCommand !== null && shouldCacheReadInvocation(cacheCommand, cacheArgv)) {
    if (readCacheEnabled) {
      const { served, value } = readCacheCli.lookup(cacheCommand, cacheArgv);
      if (served) {
        cacheServed = true;
        const text = `${JSON.stringify(value, null, 2)}\n`;
        process.stdout.write(text, () => process.exit(0));
        // Safety net if the flush callback never fires.
        setTimeout(() => process.exit(0), 2000).unref();
      }
    } else {
      recordSpawn('read-work'); // baseline: every read does DB work
    }
  }

  // Slow path: load the heavy graph (Commander, commands, plugins, DB runtime)
  // only now. `readCacheCli` is injected so the JSON-output backfill and the
  // write-invalidation hook keep working exactly as before.
  if (!cacheServed) {
    const { main } = await import('./cli-main.js');
    await main({ cache: readCacheCli, cacheEnabled: readCacheEnabled });
  }
}
