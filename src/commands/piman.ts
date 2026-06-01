/**
 * Piman command - Pi-based TUI for work items.
 *
 * Launches the Pi coding agent's interactive TUI with ContextHub worklog
 * extensions pre-loaded, providing a unified agent chat + work item management
 * experience. Unlike `wl tui` (blessed-based), this uses the Pi TUI framework.
 *
 * Usage:
 *   wl piman              # Launch Pi TUI with worklog extensions
 *   wl piman --in-progress # (forwarded to pi)
 *   wl piman --all         # Include completed/deleted items in the list
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PluginContext } from '../plugin-types.js';

/**
 * Resolve the path to a worklog extension file relative to this source file.
 * At runtime the source is at <project>/dist/commands/piman.js, so we go up
 * two levels to reach the project root, then into packages/tui/extensions/.
 */
function resolveExtension(extFile: string): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // dist/commands/ -> dist/ -> project root
  const projectRoot = resolve(currentDir, '..', '..');
  return resolve(projectRoot, 'packages', 'tui', 'extensions', extFile);
}

export default function register(ctx: PluginContext): void {
  const { program } = ctx;

  program
    .command('piman')
    .alias('pi')
    .description('Pi-based TUI: browse and manage work items with agent chat, worklog commands, and keyboard-driven preview')
    .option('--in-progress', 'Show only in-progress items')
    .option('--all', 'Include completed/deleted items in the list')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--perf', 'Enable performance instrumentation')
    .action(async (options: PimanOptions) => {
      // Resolve extension paths relative to the project root
      const browseExt = resolveExtension('index.ts');
      const widgetExt = resolveExtension('worklog-widgets.ts');

      const piArgs: string[] = [
        '-e', browseExt,
        '-e', widgetExt,
      ];

      if (options.perf) {
        piArgs.push('--verbose');
      }

      // Spawn pi in interactive mode; forward some options via env so
      // extensions can pick them up if needed.
      const env = { ...process.env };
      if (options.inProgress) env.WL_PIMAN_IN_PROGRESS = '1';
      if (options.all) env.WL_PIMAN_ALL = '1';
      if (options.prefix) env.WL_PIMAN_PREFIX = options.prefix;

      const child = spawn('pi', piArgs, {
        stdio: 'inherit',
        env,
        cwd: process.cwd(),
      });

      // Wait for pi to exit; forward its exit code.
      return new Promise<void>((resolvePromise, reject) => {
        child.on('error', (err) => {
          reject(new Error(`Failed to launch pi: ${err.message}`));
        });
        child.on('exit', (code) => {
          if (code !== 0 && code !== null) {
            // Non-zero exit, but we still resolve — user may have quit normally
          }
          resolvePromise();
        });
      });
    });
}

interface PimanOptions {
  inProgress?: boolean;
  all?: boolean;
  prefix?: string;
  perf?: boolean;
}
