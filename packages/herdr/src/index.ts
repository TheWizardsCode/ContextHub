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
 *   WL_COUNT       - Number of items to fetch (default: 20, now superseded by browseItemCount setting)
 *
 * Exit codes:
 *   0 - Normal exit (user quit or selected an item)
 *   1 - wl CLI not found
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, parse } from 'path';
import { existsSync } from 'fs';
import { checkWlAvailable, fetchNextItems, fetchItemsByStage, setWorklogDir } from './fetcher.js';
import { runWorklistTui, getTermSize } from './worklist.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { loadSettings, getDefaultSettingsPath } from './settings.js';

// Resolve path to the send-to-pi.sh script (relative to this source file)
// At runtime (tsx or dist), __dirname equivalent from import.meta.url
const _currentDir = dirname(fileURLToPath(import.meta.url));
const SEND_TO_PI_SCRIPT = resolve(_currentDir, '..', 'scripts', 'send-to-pi.sh');

/**
 * Strip bash history-expansion prefixes (`!!` or `!`) from command strings.
 *
 * Commands stored in shortcuts.json may be prefixed with `!!` or `!` to
 * signal that the `wl` command should be executed via a shell.  Herdr does
 * not understand these prefixes, so they must be stripped before the
 * `CMD:` prefix is added.
 *
 * @param command - Raw command string (possibly prefixed).
 * @returns The command with any leading `!!` or `!` prefix removed.
 */
export function stripCommandPrefix(command: string): string {
  if (command.startsWith('!!')) {
    return command.substring(2);
  }
  if (command.startsWith('!')) {
    return command.substring(1);
  }
  return command;
}

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

/**
 * Check whether a path is inside a git worktree managed by the worklog
 * system, i.e., its path contains `.worklog/worktrees/`.
 */
function isInsideWorktree(dir: string): boolean {
  return dir.includes(join('.worklog', 'worktrees'));
}

/**
 * Find the project root containing a valid `.worklog/` directory.
 *
 * Walks up from the current working directory. When a `.worklog/` directory
 * is found but is NOT valid (lacks `worklog.db` or `initialized` marker):
 * - If we are inside a worktree (path contains `.worklog/worktrees/`), skip
 *   past the invalid `.worklog/` and continue walking up.  Worktree
 *   `.worklog/` directories may be incomplete stubs left by `git worktree`
 *   setup; the real project root is above them.
 * - If we are NOT inside a worktree, stop walking and return `undefined`.
 *   This prevents the plugin from silently picking up an unrelated
 *   project's `.worklog/` higher up the tree when the calling framework
 *   sets CWD to a project that has no `.worklog/` of its own.
 *
 * Returns the project root path, or `undefined` if no valid `.worklog/` can
 * be found. The caller should handle the `undefined` case by reporting the
 * uninitialized state to the user.
 */
export function findWorklogRoot(): string | undefined {
  let dir = process.cwd();
  const root = parse(dir).root;

  while (true) {
    const wlDir = join(dir, '.worklog');
    if (existsSync(wlDir)) {
      if (existsSync(join(wlDir, 'worklog.db')) || existsSync(join(wlDir, 'initialized'))) {
        // Found a valid .worklog/ — use this directory
        return dir;
      }
      // Found .worklog/ but it is NOT valid.
      // Only walk past it when inside a worktree; otherwise stop here.
      if (!isInsideWorktree(dir)) {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }

  return undefined;
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

  // Resolve the worklog root based on the current working directory.
  // findWorklogRoot() will only walk up from a worktree; in all other
  // cases it returns undefined if CWD has no valid `.worklog/`.
  const wlRoot = findWorklogRoot();

  // Debug: log the resolved working directory for troubleshooting.
  // This is written before the TUI starts so it appears in the Herdr
  // pane scrollback when the plugin is invoked.
  process.stderr.write(`[worklog-plugin] cwd: ${process.cwd()}\n`);
  if (wlRoot) {
    process.stderr.write(`[worklog-plugin] worklog root: ${wlRoot}\n`);
  }

  if (!wlRoot) {
    // No valid .worklog/ found in the tab's working directory.
    // Don't crash — log the issue and show an empty worklist so the
    // user can close the pane gracefully and navigate to a project
    // that has an initialized Worklog database.
    process.stderr.write(`[worklog-plugin] No valid .worklog/ directory found in or above ${process.cwd()}\n`);
    process.stderr.write(`[worklog-plugin] Showing empty worklist. Navigate to a project with 'worklog init' to see items.\n`);
  }

  if (wlRoot && wlRoot !== process.cwd()) {
    // We're in a worktree — pass the resolved worklog root explicitly
    // via --worklog-dir so child `wl` processes find the correct data.
    // This avoids a fragile process.chdir() and works reliably even when
    // the CWD is inside a different git repo or worktree.
    setWorklogDir(join(wlRoot, '.worklog'));
  }

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
          // Strip `!!` / `!` bash history-expansion prefixes from shortcuts,
          // then write to stdout with CMD: prefix so Herdr executes them.
          const clean = stripCommandPrefix(command);
          process.stdout.write(`CMD:${clean}\n`);
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
