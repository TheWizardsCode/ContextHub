/**
 * packages/herdr/src/fetcher.args.ts — `wl` CLI argument and exec-seam primitives.
 *
 * Single responsibility: the module-level `--worklog-dir` override, the
 * `--worklog-dir` argument builders and the injectable `execFile` seam every
 * `wl` spawn goes through. Leaf module: it imports only `node:` builtins and
 * types from `./fetcher.types.js` (`import type`), never the `./fetcher.js`
 * barrel (parent AC4). Moved verbatim out of `fetcher.ts` (parent
 * WL-0MVGKH47T007GKN1; extraction WL-0MW08VTPK006U01L). No behaviour change.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { WlError } from './fetcher.types.js';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Format a wl error into a user-facing message.
 */
export function formatWlError(err: WlError): string {
  if (err.initialized === false) {
    return 'Worklog not initialized. Run "worklog init" first.';
  }
  if (err.error) {
    return `Worklog error: ${err.error}`;
  }
  return 'Unknown worklog error';
}

/**
 * Injectable exec function for testing. Tests can replace this with
 * a mock to avoid calling the real wl CLI. See setExecFileAsync().
 */
let execFileAsync = promisify(execFile);

/**
 * Module-level --worklog-dir override used when the parent process
 * (e.g. herdr) has resolved the worklog root and wants all child wl CLI
 * invocations to target that specific directory without relying on CWD.
 */
let _worklogDir: string | undefined;

/**
 * Cache invalidation run on every worklog-dir change.
 *
 * The in-flight fetch memo and the worklist-bundle snapshot live in modules
 * layered ABOVE this leaf and must drop their entries when the override moves
 * (F4: reads racing against the old dir must never be shared with the new
 * one). This leaf may not import the `./fetcher.js` barrel (parent AC4), so
 * the owning module registers its invalidation here instead.
 */
let worklogDirChanged: (() => void) | undefined;

/**
 * Register the invalidation run on every worklog-dir change. Single owner: a
 * second registration replaces the first.
 */
export function setWorklogDirChangedHandler(handler: () => void): void {
  worklogDirChanged = handler;
}

/**
 * Set the worklog directory path to pass as --worklog-dir to every wl CLI
 * invocation. The path should point to the .worklog/ subdirectory itself
 * (e.g. /path/to/project/.worklog).
 * Pass undefined to clear the override.
 */
export function setWorklogDir(dir: string | undefined): void {
  _worklogDir = dir;
  // Switching worklog dirs invalidates any in-flight fetch memo (F4): reads
  // racing against the old dir must never be shared with the new one.
  worklogDirChanged?.();
}

/**
 * Return the current --worklog-dir override (if any). Used by other modules
 * (e.g. auto-sync) so their `wl` invocations target the same worklog.
 */
export function getWorklogDir(): string | undefined {
  return _worklogDir;
}

/**
 * Build the argument vector for a wl CLI invocation, prepending the
 * `--worklog-dir` override when set (it is a global option that must appear
 * BEFORE the subcommand). Callers that invoke wl directly via
 * `getExecFileAsync()` (e.g. the downtime worker's `wl next` and
 * `wl comment add`) use this so their commands resolve against the same
 * worklog root as the worklist — without the override the argument vector is
 * returned unchanged (current behavior preserved).
 *
 * `dirOverride` (the `.worklog/` directory itself, e.g.
 * `/project/.worklog`) wins over the module-level override for THIS call
 * only — the module state is never mutated (see `buildWlArgsForRoot` for the
 * root-accepting convenience form).
 */
export function buildWlArgs(args: string[], dirOverride?: string): string[] {
  const dir = dirOverride ?? _worklogDir;
  if (dir !== undefined) {
    return ['--worklog-dir', dir, ...args];
  }
  return args;
}

/**
 * Build wl args targeting a SPECIFIC worklog root's database — stateless,
 * per-call `--worklog-dir <root>/.worklog` targeting that never mutates the
 * module-level override (WL-0MTQ14W7L003II5A). `root` is the project
 * directory that CONTAINS `.worklog/` (e.g. `/home/user/projects/AI_Hell`),
 * the convention every downtime/coordination caller passes as `cwd`.
 *
 * The downtime leader uses this for every per-entry wl invocation on a
 * coordination offer: the offer's item lives in ITS OWN instance's worklog
 * root, which may differ from the leader pane's resolved root — resolving
 * against the module override instead fired `wl show`/`update` at the wrong
 * database ("Work item not found" → 3 strikes → 60-minute pause).
 */
export function buildWlArgsForRoot(root: string, args: string[]): string[] {
  return ['--worklog-dir', join(root, '.worklog'), ...args];
}

/**
 * Reset the worklog directory override.
 */
export function resetWorklogDir(): void {
  _worklogDir = undefined;
  worklogDirChanged?.();
}

/**
 * Replace the execFileAsync implementation. Used by tests to inject
 * mock implementations without mocking the child_process module.
 */
export function setExecFileAsync(mock: typeof execFileAsync): void {
  execFileAsync = mock;
}

/**
 * Return the current execFileAsync implementation. Lets other modules
 * (e.g. visibility.ts) share the same injectable exec seam used by tests,
 * so mocks installed via setExecFileAsync() apply to those modules too.
 */
export function getExecFileAsync(): typeof execFileAsync {
  return execFileAsync;
}

/**
 * Reset execFileAsync to the real implementation.
 */
export function resetExecFileAsync(): void {
  execFileAsync = promisify(execFile);
}
