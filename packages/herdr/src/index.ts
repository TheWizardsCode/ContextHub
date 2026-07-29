/**
 * packages/herdr/src/index.ts — Herdr Worklog plugin entry point
 *
 * This is the main program for the Herdr work item selection list pane.
 * It is invoked as a pane command by Herdr and provides a keyboard-navigable
 * TUI for browsing, filtering, and selecting Worklog work items.
 *
 * Usage:
 *   npx tsx packages/herdr/src/index.ts
 *   node packages/herdr/dist/index.js
 *
 * Environment:
 *   HERDR_PANE_ID  - Set by Herdr when running in a pane (optional)
 *   WL_COUNT       - Number of items to fetch (default: 20)
 *
 * Exit codes:
 *   0 - Normal exit (user quit or selected an item)
 *   1 - wl CLI not found
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { checkWlAvailable, fetchNextItems, fetchItemsByStage } from './fetcher.js';
import { runWorklistTui, getTermSize } from './worklist.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { loadSettings, getDefaultSettingsPath } from './settings.js';

// Resolve path to the send-to-pi.sh script (relative to this source file)
// At runtime (tsx or dist), __dirname equivalent from import.meta.url
const _currentDir = dirname(fileURLToPath(import.meta.url));
const SEND_TO_PI_SCRIPT = resolve(_currentDir, '..', 'scripts', 'send-to-pi.sh');

/**
 * Check if a command is an agent command that should be sent to a pi pane.
 * Agent commands are those starting with /skill:, /intake, or /plan.
 */
function isAgentCommand(command: string): boolean {
  return (
    command.startsWith('/skill:') ||
    command.startsWith('/intake') ||
    command.startsWith('/plan')
  );
}

// Load settings
const settings = loadSettings();

async function main(): Promise<void> {
  // Check if wl is available
  const wlAvailable = await checkWlAvailable();
  if (!wlAvailable) {
    console.error('');
    console.error('  ⚠ Worklog CLI (wl) not found on PATH');
    console.error('');
    console.error('  The Worklog Herdr plugin requires the `wl` CLI to be installed');
    console.error('  and accessible from the Herdr pane environment.');
    console.error('');
    console.error('  Install it with: npm install -g worklog');
    console.error('  Or ensure it is in your PATH.');
    console.error('');
    process.exit(1);
  }

  // Load shortcut config
  const shortcutRegistry = loadShortcutConfig();

  // Create a fetcher that loads items using the current browseItemCount setting
  // Each call reads from settings so changes take effect on next auto-refresh
  const fetcher = async () => {
    try {
      const currentSettings = loadSettings();
      const count = Math.min(Math.max(currentSettings.browseItemCount ?? 10, 1), 50);
      return await fetchNextItems(count);
    } catch {
      return [];
    }
  };

  // Run the TUI with settings
  // onCommand is invoked when a command resolves to a non-/wl command,
  // with <id> placeholders replaced by the selected item's ID.
  // The command is written to stdout with a CMD: prefix so the calling
  // framework (Herdr) can execute it. The TUI stays alive after sending
  // the command — the user can continue browsing or quit normally.
  const selectedItem = await runWorklistTui(
    fetcher,
    undefined,
    shortcutRegistry,
    {
      autoRefresh: settings.autoRefresh,
      refreshIntervalMs: settings.refreshIntervalMs,
      autoSync: settings.autoSync,
      syncIntervalMs: settings.syncIntervalMs,
      showHelpText: settings.showHelpText,
      onCommand: (command: string) => {
        // Agent commands (/skill:*, /intake, /plan) are routed to a new pi agent
        // pane opened to the right. Other commands are written to stdout with the
        // CMD: prefix for the calling framework (Herdr) to execute.
        if (isAgentCommand(command)) {
          // Spawn send-to-pi.sh asynchronously — detached and with stdio ignored
          // so the TUI loop is not blocked or affected by the script's output.
          const child = spawn(
            SEND_TO_PI_SCRIPT,
            [command],
            {
              detached: true,
              stdio: 'ignore',
              cwd: process.cwd(),
              env: { ...process.env },
            },
          );
          child.unref(); // Allow the parent to exit independently
        } else {
          // Non-agent commands: write to stdout with CMD: prefix so Herdr executes them
          process.stdout.write(`CMD:${command}\n`);
        }
      },
    },
  );

  if (selectedItem) {
    // Print the selected item ID to stdout for use by scripts/actions
    console.log(selectedItem.id);
  }
}

main().catch((err) => {
  console.error('Worklog plugin error:', err);
  process.exit(1);
});
