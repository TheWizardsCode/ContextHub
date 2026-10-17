/**
 * packages/herdr/src/start.ts — resilient pane entry point
 * (WL-0MVAY631M004RZ3Q).
 *
 * herdr launches the Worklog pane with `npx tsx src/start.ts` (see
 * herdr-plugin.toml). This launcher dynamically imports the real plugin
 * entry (`index.ts`, via its compiled `./index.js` form) so that
 * module-LOAD failures are catchable.
 *
 * Why this exists: the plugin imports named exports from the shared
 * `@worklog/shared/icons` package. When that package's compiled output is
 * STALE (built before the current source — or a vendored copy from before
 * an export was added), the ESM linker throws at instantiation:
 *
 *   SyntaxError: The requested module '@worklog/shared/icons' does not
 *   provide an export named 'needsProducerReviewIcon'
 *
 * A static top-level import crashes the whole pane before `main()` (and its
 * `.catch`) ever runs, so herdr closed the pane with no explanation. By
 * importing the entry dynamically we can catch that failure, print an
 * actionable diagnostic ("run `npm run build`"), and keep the pane open for
 * the user to read when stdin is a TTY.
 *
 * The launcher is transparent on the happy path: it just awaits the real
 * `main()` exactly as index.ts would.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real plugin entry, resolved relative to this file (index.ts under tsx, index.js when compiled). */
const DEFAULT_ENTRY = './index.js';

/**
 * Format a startup failure into an actionable diagnostic.
 *
 * The ESM missing-export case gets an explanation plus the exact rebuild
 * command; every other failure keeps its original message plus the same
 * rebuild hint, so nothing is ever swallowed silently.
 */
export function formatStartupError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const isMissingExport = /does not provide an export named/i.test(detail);
  const lines: string[] = ['', '  ⚠ Worklog plugin failed to start.'];
  if (isMissingExport) {
    lines.push(
      '',
      '  The plugin loaded a STALE copy of the shared Worklog code:',
      `    ${detail}`,
      '',
      '  This usually means `packages/shared/dist` was built before the',
      '  current source. Rebuild and re-link from the repository root:',
      '',
      '      npm run build',
      '',
      '  Then reopen the Worklog tab.',
    );
  } else {
    lines.push('', `  ${detail}`);
    if (!/npm run build/.test(detail)) {
      lines.push(
        '',
        '  Rebuild from the repository root with `npm run build` and reopen',
        '  the Worklog tab. If the problem persists, refresh the plugin',
        '  dependencies with `npm install --prefix packages/herdr`.',
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** When attached to a real terminal, hold the pane open until dismissed. */
async function waitForDismiss(): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stderr.write('\n  [worklog-plugin] Press Enter to close this pane.\n');
  await new Promise<void>((resolve0) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve0());
    process.stdin.once('end', () => resolve0());
  });
}

/**
 * Launch the real plugin entry, surfacing module-load errors.
 *
 * `WORKLOG_PLUGIN_ENTRY` may override the entry (used by tests to point at
 * fixtures); production always uses ./index.js.
 */
export async function launch(entry = process.env.WORKLOG_PLUGIN_ENTRY || DEFAULT_ENTRY): Promise<void> {
  try {
    const mod = (await import(entry)) as { main?: () => Promise<void> | void };
    if (typeof mod.main === 'function') {
      await mod.main();
    } else {
      throw new Error(
        `entry module '${entry}' does not export main() — the plugin build is incomplete; run 'npm run build'.`,
      );
    }
  } catch (err) {
    process.stderr.write(formatStartupError(err));
    process.exitCode = 1;
    await waitForDismiss();
  }
}

// Only auto-run when this module is the entry point (launched directly by
// herdr/tsx), not when imported by tests.
const isEntryPoint = (() => {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  void launch();
}
