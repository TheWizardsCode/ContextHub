/**
 * Pre-compiled CLI spawn helper (WL-0MVF9JJUH0077OB8 — reduce time to run tests).
 *
 * ## Why
 *
 * A large part of the CLI suite needs a *real subprocess* (read-cache spawn
 * accounting, `init`, plugin isolation, sync races). Every such test used to
 * spawn `tsx src/cli.ts`, and tsx re-transpiles the whole `src/` import graph
 * on every process start: measured 2.5–8 s per spawn on a loaded host (the
 * same spawn took ~2.8 s idle and ~8 s at load average 10). The CLI suite
 * performs ~150 such spawns, which dominates both its wall-clock time and its
 * run-to-run variance.
 *
 * ## What
 *
 * Build `src/cli.ts` **once per test process** with esbuild (the same
 * transpiler tsx uses) into a temp directory that mirrors the repository
 * layout the CLI resolves at runtime, then spawn `node <dir>/cli.mjs` instead
 * of `tsx <repo>/src/cli.ts`.
 *
 * Measured effect per spawn: ~1.1–1.6 s vs ~2.5–8 s (~5× faster, and far less
 * load-sensitive). Behaviour is unchanged because the bundle contains the same
 * entry file and the same command graph — it is only pre-compiled.
 *
 * ## Layout (why the bundle directory mirrors the repo)
 *
 * `src/cli.ts` derives paths from `import.meta.url`. `init`, for example,
 * resolves its templates via `path.dirname(import.meta.url)/../..` and falls
 * back to the *current* repo root. To keep that behaviour identical, the
 * bundle is emitted at `<dir>/app/src/cli.mjs`, so `<dir>` is two levels above
 * the entry and therefore behaves like the package root; the repo's
 * `templates/`, `examples/` and `package.json` are symlinked into `<dir>` so
 * `init` finds exactly the templates it finds from `src/`. npm and workspace
 * packages stay **external** (`packages: 'external'`) and resolve upward to
 * the repo's `node_modules`, exactly as they do from `src/`.
 *
 * ## Isolation
 *
 * Each test process builds its own `<dir>` (`test-cli-bundles/<pid>`), so
 * parallel vitest workers never race on one output file (concurrent esbuild
 * writes to a shared outfile produced truncated bundles and spurious failures).
 * Directories are removed on process exit and stale ones are swept at build
 * time.
 *
 * ## Fail-soft
 *
 * If esbuild cannot be resolved or the build fails, every helper here
 * transparently falls back to the original `[node, tsx, src/cli.ts]`
 * invocation. A broken bundle therefore costs speed, never correctness.
 *
 * Tests that must observe the *real* entry point or measure tsx startup cost
 * do NOT use this helper: `entry-point-split.test.ts` (dist-vs-src entry
 * parity) and `startup-import-budget.test.ts` (measures tsx startup) keep
 * their own invocations by design.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, type SpawnSyncOptions } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { resolveTsxBin } from '../test-utils.js';

const require = createRequire(import.meta.url);

/** Repository root, derived from this file's location (`tests/cli/`). */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The source entry point the bundle is built from. */
export const cliSourcePath = path.join(repoRoot, 'src', 'cli.ts');

/** How old (ms) an orphaned sibling bundle directory must be to be swept. */
const STALE_BUNDLE_MS = 60 * 60 * 1000;

/** Is `pid` a live process? (EPERM means it exists but belongs to someone else.) */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Cached bundle entry point; `null` once the tsx fallback has been chosen. */
let _bundledEntry: string | null = null;
let _fallbackInvocation: string[] | null = null;
let _bundleDir: string | null = null;

function tsxFallbackInvocation(): string[] {
  if (!_fallbackInvocation) {
    _fallbackInvocation = [
      process.execPath,
      resolveTsxBin(path.dirname(fileURLToPath(import.meta.url))),
      cliSourcePath,
    ];
  }
  return _fallbackInvocation;
}

function cleanupBundleDir(): void {
  if (!_bundleDir) return;
  try {
    fs.rmSync(_bundleDir, { recursive: true, force: true });
  } catch {
    // Best-effort; a leftover directory is harmless (and swept next run).
  }
  _bundleDir = null;
}

/**
 * Remove bundle directories left behind by crashed/aborted test processes.
 *
 * A directory is only removed when the process that owns it (the directory
 * name is its PID) is no longer running *and* it is older than the stale
 * threshold — a long-running suite must never lose its own bundle to another
 * worker's sweep.
 */
function sweepStaleBundles(root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ownerPid = Number(entry.name);
    if (!Number.isInteger(ownerPid) || ownerPid === process.pid) continue;
    if (Number.isInteger(ownerPid) && isPidAlive(ownerPid)) continue;
    const full = path.join(root, entry.name);
    try {
      if (now - fs.statSync(full).mtimeMs > STALE_BUNDLE_MS) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // Ignore; another process may own it.
    }
  }
}

/** Build the bundle once per test process. Returns the entry path, or null. */
function buildBundle(): string | null {
  if (_bundledEntry) return _bundledEntry;
  if (_fallbackInvocation) return null;
  try {
    // `.worklog/` is gitignored in every checkout and worktree, so build
    // artefacts never dirty the tree that the implement/audit gates inspect.
    const root = path.join(repoRoot, '.worklog', 'test-cli-bundles');
    sweepStaleBundles(root);
    const dir = path.join(root, String(process.pid));
    fs.mkdirSync(path.join(dir, 'app', 'src'), { recursive: true });
    const entry = path.join(dir, 'app', 'src', 'cli.mjs');

    const esbuild = require('esbuild') as typeof import('esbuild');
    esbuild.buildSync({
      entryPoints: [cliSourcePath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      // Keep npm/workspace packages external so native addons and shared
      // workspace packages resolve exactly as they do from `src/`.
      packages: 'external',
      outfile: entry,
      sourcemap: false,
      logLevel: 'silent',
    });

    // Symlink the package-root entries `src/` path derivation depends on, so
    // `<dir>` behaves like the repo root (see "Layout" above). node_modules is
    // found by ordinary upward resolution.
    for (const name of ['templates', 'examples', 'package.json']) {
      const target = path.join(repoRoot, name);
      if (!fs.existsSync(target)) continue;
      const link = path.join(dir, name);
      if (fs.existsSync(link)) continue;
      fs.symlinkSync(target, link, fs.statSync(target).isDirectory() ? 'dir' : 'file');
    }

    _bundleDir = dir;
    process.once('exit', cleanupBundleDir);
    _bundledEntry = entry;
    return entry;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tsxFallbackInvocation();
    // eslint-disable-next-line no-console
    console.warn(`[cli-bundle] falling back to tsx spawns (bundle build failed: ${message})`);
    return null;
  }
}

/**
 * CLI invocation prefix (`[executable, script]`) for spawning the CLI as a
 * real subprocess — the pre-compiled bundle when available, otherwise the
 * original tsx invocation.
 */
export function cliInvocation(): string[] {
  const entry = buildBundle();
  return entry ? [process.execPath, entry] : tsxFallbackInvocation();
}

/** True when the fast (bundled) spawn path is in use. */
export function isBundled(): boolean {
  return buildBundle() !== null;
}

/**
 * Drop-in replacement for `spawnSync(process.execPath, [tsxBin, cliPath, ...])`.
 * Runs the CLI with `args` in a real subprocess.
 */
export function runCliProcess(
  args: string[],
  options: SpawnSyncOptions = {}
): { status: number | null; stdout: string; stderr: string } {
  const [executable, script] = cliInvocation();
  const res = spawnSync(executable, [script, ...args], {
    encoding: 'utf-8',
    timeout: 60_000,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Rewrite a shell command line that starts with `tsx <repo>/src/cli.ts` so it
 * starts with the pre-compiled bundle instead.
 *
 * Callers that build a command string (e.g. `execAsync`'s `init` path) keep
 * their quoting and argument text verbatim; only the `tsx <entry>` prefix is
 * replaced. When the bundle is unavailable the command is returned unchanged
 * so the original tsx path still works.
 */
export function rewriteCliCommandToBundle(command: string): string {
  const entry = buildBundle();
  if (!entry) return command;

  const escapedSource = cliSourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `tsx <entry>` — optionally preceded by a path to a tsx binary.
  const tsxPrefix = new RegExp(`^(\\s*)(?:\\S*tsx\\s+)?${escapedSource}`);
  if (!tsxPrefix.test(command)) return command;
  return command.replace(tsxPrefix, `$1${process.execPath} ${entry}`);
}
