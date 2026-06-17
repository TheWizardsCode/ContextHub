/**
 * TUI command - alias for `wl piman`.
 *
 * Launches the Pi coding agent's interactive TUI with ContextHub worklog
 * extensions pre-loaded. This is identical to `wl piman` — the commands
 * are aliases for each other.
 *
 * Usage:
 *   wl tui                # Launch Pi TUI → worklog browse flow
 *   wl tui --in-progress  # Show only in-progress items
 *   wl tui --all          # Include completed/deleted items
 *   wl tui --prefix <p>   # Override default prefix
 *   wl tui --perf         # Enable performance instrumentation
 */

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PluginContext } from '../plugin-types.js';

/**
 * Resolve the path to a worklog extension file relative to this source file.
 * At runtime the source is at <project>/dist/commands/tui.js, so we go up
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
    .command('tui')
    .description('Pi-based TUI: browse and manage work items (alias for wl piman)')
    .option('--in-progress', 'Show only in-progress items')
    .option('--all', 'Include completed/deleted items in the list')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--perf', 'Enable performance instrumentation')
    .action(async (options: PimanOptions) => {
      const browseExt = resolveExtension('index.ts');

      const piArgs: string[] = [
        '-e', browseExt,
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
