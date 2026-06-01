/**
 * Piman command - Pi-based TUI for work items.
 *
 * Launches the Pi coding agent's interactive TUI with ContextHub worklog
 * extensions pre-loaded, providing a unified agent chat + work item management
 * experience. The extensions auto-run the /wl browse flow on `session_start`
 * when launched from this command (detected via the WL_PIMAN env var).
 *
 * Usage:
 *   wl piman              # Launch Pi TUI → worklog browse flow
 *   wl piman --in-progress # forwarded via WL_PIMAN_IN_PROGRESS
 *   wl piman --all         # forwarded via WL_PIMAN_ALL
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
      const browseExt = resolveExtension('index.ts');
      const widgetExt = resolveExtension('worklog-widgets.ts');

      const piArgs: string[] = [
        '-e', browseExt,
        '-e', widgetExt,
      ];

      if (options.perf) {
        piArgs.push('--verbose');
      }

      // Signal the extension to auto-run /wl on session_start
      const env: Record<string, string> = { ...process.env, WL_PIMAN: '1' };
      if (options.inProgress) env.WL_PIMAN_IN_PROGRESS = '1';
      if (options.all) env.WL_PIMAN_ALL = '1';
      if (options.prefix) env.WL_PIMAN_PREFIX = options.prefix;

      // Inherit stdio so Pi has direct terminal access for its TUI
      const child = spawn('pi', piArgs, {
        stdio: 'inherit',
        env,
        cwd: process.cwd(),
      });

      return new Promise<void>((resolvePromise, reject) => {
        child.on('error', (err) => reject(new Error(`Failed to launch pi: ${err.message}`)));
        child.on('exit', () => resolvePromise());
      });
    });
}

interface PimanOptions {
  inProgress?: boolean;
  all?: boolean;
  prefix?: string;
  perf?: boolean;
}
