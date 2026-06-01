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

      // Pipe stdin so we can inject the /wl command after startup;
      // stdout/stderr are inherited so the user sees and interacts with Pi's
      // TUI directly.
      const child = spawn('pi', piArgs, {
        stdio: ['pipe', 'inherit', 'inherit'],
        env,
        cwd: process.cwd(),
      });

      // Once Pi's TUI has initialised and loaded extensions, /wl triggers the
      // worklog browse flow automatically so the user lands directly in the
      // item browser without having to type the command.
      const INIT_DELAY_MS = 1500;
      const autoBrowseTimer = setTimeout(() => {
        if (child.stdin && !child.killed) {
          child.stdin.write('/wl\n');

          // After injecting the command, forward all further terminal input
          // to the child so the user can interact normally.
          process.stdin.pipe(child.stdin);
        }
      }, INIT_DELAY_MS);

      // Wait for pi to exit.
      return new Promise<void>((resolvePromise, reject) => {
        child.on('error', (err) => {
          clearTimeout(autoBrowseTimer);
          reject(new Error(`Failed to launch pi: ${err.message}`));
        });
        child.on('exit', (code) => {
          clearTimeout(autoBrowseTimer);
          // Unpipe terminal input when child exits
          try { process.stdin.unpipe(child.stdin!); } catch { /* ignore */ }
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
