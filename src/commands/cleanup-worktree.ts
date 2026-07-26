/**
 * cleanup-worktree command - Kill tracked processes for a worktree path
 *
 * Usage:
 *   wl cleanup-worktree <path>         Kill tracked processes for <path>
 *   wl cleanup-worktree --all           Kill tracked processes for all worktrees
 *   wl cleanup-worktree <path> --force  Use SIGKILL instead of SIGTERM
 *
 * This is safe to run even when no processes are tracked (no-op, exit 0).
 */

import type { PluginContext } from '../plugin-types.js';
import { killProcessesForWorktree, killAllTracked, getTrackedProcesses } from '../process-lifecycle.js';

interface CleanupWorktreeOptions {
  all?: boolean;
  force?: boolean;
}

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('cleanup-worktree')
    .description('Kill tracked processes for a worktree path')
    .argument('[path]', 'Path to the worktree to clean up')
    .option('--all', 'Kill tracked processes for all worktrees')
    .option('--force', 'Use SIGKILL instead of SIGTERM')
    .action((pathArg: string | undefined, options: CleanupWorktreeOptions) => {
      const { all, force } = options;
      const signal = force ? 'SIGKILL' : 'SIGTERM';
      const jsonMode = utils.isJsonMode();

      // Validate: require either a path or --all
      if (!pathArg && !all) {
        if (jsonMode) {
          output.json({ success: false, error: 'Either a worktree path or --all is required' });
        } else {
          console.error('Error: Either specify a worktree path or use --all');
          console.error('Usage: wl cleanup-worktree <path> [--force]');
          console.error('       wl cleanup-worktree --all [--force]');
        }
        return;
      }

      if (pathArg && all) {
        if (jsonMode) {
          output.json({ success: false, error: 'Cannot specify both a path and --all' });
        } else {
          console.error('Error: Cannot specify both a path and --all');
        }
        return;
      }

      if (all) {
        // Kill all tracked processes
        const tracked = getTrackedProcesses();
        const worktreeCount = Object.keys(tracked).length;

        killAllTracked(signal);

        if (jsonMode) {
          output.json({
            success: true,
            mode: 'all',
            signal,
            worktreesCleaned: worktreeCount,
          });
        } else {
          if (worktreeCount === 0) {
            console.log('No tracked processes found. Nothing to clean up.');
          } else {
            console.log(`Cleaned up tracked processes for ${worktreeCount} worktree(s) using ${signal}.`);
          }
        }
        return;
      }

      // Single worktree path
      const normalizedPath = pathArg!.replace(/\/$/, ''); // strip trailing slash

      // Check if any processes are tracked for this path
      const tracked = getTrackedProcesses();
      const hasProcesses = tracked[normalizedPath] && tracked[normalizedPath].length > 0;

      if (!hasProcesses) {
        if (jsonMode) {
          output.json({
            success: true,
            mode: 'single',
            path: normalizedPath,
            signal,
            processesKilled: 0,
          });
        } else {
          console.log(`No tracked processes for ${normalizedPath}. Nothing to clean up.`);
        }
        return;
      }

      killProcessesForWorktree(normalizedPath, signal);

      if (jsonMode) {
        output.json({
          success: true,
          mode: 'single',
          path: normalizedPath,
          signal,
          processesKilled: tracked[normalizedPath].length,
        });
      } else {
        console.log(`Cleaned up ${tracked[normalizedPath].length} process(es) for ${normalizedPath} using ${signal}.`);
      }
    });
}
