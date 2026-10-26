/**
 * packages/herdr/src/index.settings.ts — settings bootstrap and worklog-target
 * configuration for the Herdr Worklog plugin.
 *
 * Extracted verbatim from `packages/herdr/src/index.ts` (move-only,
 * WL-0MVOA0W1P000IZKK, parent WL-0MVGKGFFN009UCM6): the single module-level
 * `const settings = loadSettings()` side effect and the two worklog-target
 * bootstrap functions moved here so the settings singleton lives in exactly
 * one module (parent AC5). Function bodies, JSDoc and provenance comments are
 * unchanged.
 *
 * ## Single-instance rule
 *
 * `settings` is evaluated **exactly once** at module load — duplicating
 * `const settings = loadSettings()` into another index-family module would
 * load settings twice with potentially different results. `index.ts` imports
 * `settings` from this module (via `./index.settings.js`) so
 * `createDowntimeDeps` (phase 10) and `main` (phase 11) keep sharing the one
 * instance, and re-exports `configureWorklogTarget` / `uninitializedReport`
 * for `index.test.ts`'s dynamic `import('./index.js')` consumers. `settings`
 * itself is NOT re-exported by the barrel (no consumer imports it from there,
 * AC2).
 *
 * The resolved script paths `SEND_TO_PI_SCRIPT` / `RUN_IN_PANE_SCRIPT` stay
 * in `index.ts` for the same reason — they depend on `import.meta.url`
 * resolving relative to `packages/herdr/src/`.
 *
 * Imports are concrete siblings only (`./settings.js`, `./fetcher.js`,
 * `@worklog/shared/worklog-paths`); no barrel value imports, no new cycles.
 */

import { join } from 'path';
import { resolveWorklogRoot } from '@worklog/shared/worklog-paths';
import { setWorklogDir } from './fetcher.js';
import { loadSettings } from './settings.js';

// Load settings
const settings = loadSettings();

/**
 * Resolve the worklog root starting from the given directory (or the
 * process CWD when not provided) and configure the fetcher so every child
 * `wl` invocation targets that root's database via `--worklog-dir`.
 *
 * The resolution itself is delegated to the shared
 * `resolveWorklogRoot()` (packages/shared/src/worklog-paths.ts) — the same
 * strategy the `wl` CLI uses — so the plugin and the CLI can never disagree
 * about what constitutes the project root.
 *
 * Returns the resolved project root, or undefined when no valid `.worklog/`
 * is found (in which case the fetcher falls back to default resolution).
 */
export function configureWorklogTarget(startDir?: string): string | undefined {
  if (startDir) {
    process.stderr.write(`[worklog-plugin] resolving worklog root from HERDR_RESOLVED_CWD: ${startDir}\n`);
  }
  const wlRoot = resolveWorklogRoot(startDir);
  if (wlRoot) {
    setWorklogDir(join(wlRoot, '.worklog'));
  }
  return wlRoot;
}

/**
 * Report text emitted when no valid `.worklog/` directory is found in or
 * above the given start directory. Extracted so tests can assert the
 * uninitialized reporting without launching the full TUI.
 */
export function uninitializedReport(startDir: string): string {
  return [
    `[worklog-plugin] No valid .worklog/ directory found in or above '${startDir}'`,
    `[worklog-plugin] Showing empty worklist. Navigate to a project with 'worklog init' to see items.`,
  ].join('\n') + '\n';
}

export { settings };
