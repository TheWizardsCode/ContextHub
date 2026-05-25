/**
 * Piman command - Pi-based TUI for work items.
 *
 * This is the Pi-native entry point for the TUI. Unlike `wl tui` which
 * was the original entry point, `wl piman` explicitly signals the Pi-based
 * implementation that uses the wl CLI for all database operations (no direct
 * SQLite access).
 *
 * Usage:
 *   wl piman              # Launch TUI with all items
 *   wl piman --in-progress # Show only in-progress items
 *   wl piman --all         # Include completed/deleted items
 */

import type { PluginContext } from '../plugin-types.js';
import { TuiController } from '../tui/controller.js';

export default function register(ctx: PluginContext): void {
  const controller = new TuiController(ctx);
  const { program } = ctx;

  program
    .command('piman')
    .alias('pi')
    .description('Pi-based TUI: browse and manage work items with agent chat and action palette')
    .option('--in-progress', 'Show only in-progress items')
    .option('--all', 'Include completed/deleted items in the list')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--perf', 'Enable performance instrumentation')
    .action(async (options: PimanOptions) => {
      await controller.start({
        inProgress: options.inProgress,
        all: options.all,
        prefix: options.prefix,
        perf: options.perf,
      });
    });
}

interface PimanOptions {
  inProgress?: boolean;
  all?: boolean;
  prefix?: string;
  perf?: boolean;
}
