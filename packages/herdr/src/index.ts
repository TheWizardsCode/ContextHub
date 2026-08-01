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
import { checkWlAvailable, fetchNextItems, fetchItemsByStage, setWorklogDir, claimWorkItem } from './fetcher.js';
import { runWorklistTui, getTermSize } from './worklist.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { loadSettings, getDefaultSettingsPath, clampBrowseItemCount, defaultSettings } from './settings.js';

// Resolve path to the send-to-pi.sh script (relative to this source file)
// At runtime (tsx or dist), __dirname equivalent from import.meta.url
const _currentDir = dirname(fileURLToPath(import.meta.url));
const SEND_TO_PI_SCRIPT = resolve(_currentDir, '..', 'scripts', 'send-to-pi.sh');
const RUN_IN_PANE_SCRIPT = resolve(_currentDir, '..', 'scripts', 'run-in-pane.sh');

/**
 * Routes a resolved command to its execution channel.
 *
 * - `'agent'` — agent workflow commands (`/skill:*`, `/intake`, `/plan`)
 *   are sent to a new pi agent pane via `send-to-pi.sh`.
 * - `'pane'` — commands prefixed with `!!` or `!` (shell-executed commands
 *   such as the audit/review/priority shortcuts) are run visibly in a new
 *   herdr pane via `run-in-pane.sh`.
 * - `'stdout'` — everything else falls back to the `CMD:` stdout protocol.
 */
export type CommandRoute = 'agent' | 'pane' | 'stdout';

export function routeCommand(command: string): CommandRoute {
  if (isAgentCommand(command)) {
    return 'agent';
  }
  if (command.startsWith('!!') || command.startsWith('!')) {
    return 'pane';
  }
  return 'stdout';
}

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
 * Work-item ID format: a prefix (e.g. `WL`, `SA`) followed by a hash,
 * e.g. `WL-0MS9NPHQU005Y3VE`.
 */
const WORK_ITEM_ID_PATTERN = /^[A-Z]+-\w+$/;

/**
 * Assignee used when the plugin claims a work-item (sets status to
 * in_progress) before dispatching an agent command. Matches the agent
 * handle used across the worklog (see AGENTS.md claim pattern).
 */
const AGENT_ASSIGNEE = 'Map';

/**
 * Extract the work-item ID from an agent command string.
 *
 * Agent commands are typically `/intake <id>`, `/plan <id>`, or
 * `/skill:<name> <id>` with the ID as the last argument. All tokens are
 * scanned for the work-item ID pattern and the last match is returned.
 * Commands without an ID (e.g. `/intake` alone) return `undefined` and
 * skip the status update gracefully.
 */
export function extractWorkItemId(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (WORK_ITEM_ID_PATTERN.test(tokens[i])) {
      return tokens[i];
    }
  }
  return undefined;
}

/**
 * Claim the work-item referenced by an agent command (set its status to
 * in_progress) before the agent pane is spawned.
 *
 * Non-blocking: never throws. Failures are logged to stderr and must not
 * prevent the agent pane from opening (AC2). Commands without a work-item
 * ID (e.g. `/intake` alone) are skipped silently.
 */
export async function claimItemForAgentCommand(command: string): Promise<void> {
  const itemId = extractWorkItemId(command);
  if (!itemId) {
    return;
  }
  const result = await claimWorkItem(itemId, AGENT_ASSIGNEE);
  if (!result.success) {
    process.stderr.write(
      `[worklog-plugin] Failed to set ${itemId} status to in_progress: ${result.error ?? 'unknown error'}\n`,
    );
  }
}

/**
 * Check whether a path is inside a git worktree managed by the worklog
 * system, i.e., its path contains `.worklog/worktrees/`.
 */
function isInsideWorktree(dir: string): boolean {
  return dir.includes(join('.worklog', 'worktrees'));
}

/**
 * Check whether a `.worklog/` directory is a leftover worktree container
 * rather than a real project worklog.
 *
 * The implement tool's worktree lifecycle creates `.worklog/worktrees/`
 * directories (e.g. inside `packages/herdr` when the tool runs with that
 * CWD). After worktrees are cleaned up, an empty `worktrees/` subdirectory
 * may remain. Such a stub has no `config.yaml`, `initialized` marker, or
 * `worklog.db` — it is NOT a project worklog and must not block upward
 * resolution to the real project root.
 */
function isWorktreeContainerStub(wlDir: string): boolean {
  return (
    existsSync(join(wlDir, 'worktrees')) &&
    !existsSync(join(wlDir, 'config.yaml')) &&
    !existsSync(join(wlDir, 'initialized')) &&
    !existsSync(join(wlDir, 'worklog.db'))
  );
}

/**
 * Find the project root containing a valid `.worklog/` directory.
 *
 * Walks up from the current working directory. When a `.worklog/` directory
 * is found but is NOT valid (lacks `worklog.db` or `initialized` marker):
 * - If it is a leftover worktree container stub (contains only a
 *   `worktrees/` subdirectory and no config markers), skip past it and
 *   continue walking up. Such stubs are created by the implement tool's
 *   worktree lifecycle (e.g. inside `packages/herdr`) and are not real
 *   project worklogs.
 * - If we are inside a worktree (path contains `.worklog/worktrees/`), skip
 *   past the invalid `.worklog/` and continue walking up.  Worktree
 *   `.worklog/` directories may be incomplete stubs left by `git worktree`
 *   setup; the real project root is above them.
 * - Otherwise, stop walking and return `undefined`.  This prevents the
 *   plugin from silently picking up an unrelated project's `.worklog/`
 *   higher up the tree when the calling framework sets CWD to a project
 *   that has no `.worklog/` of its own.
 *
 * Returns the project root path, or `undefined` if no valid `.worklog/` can
 * be found. The caller should handle the `undefined` case by reporting the
 * uninitialized state to the user.
 */
export function findWorklogRoot(startDir?: string): string | undefined {
  let dir = startDir ?? process.cwd();
  if (startDir) {
    process.stderr.write(`[worklog-plugin] findWorklogRoot starting from HERDR_RESOLVED_CWD: ${startDir}\n`);
  }
  const root = parse(dir).root;

  while (true) {
    const wlDir = join(dir, '.worklog');
    if (existsSync(wlDir)) {
      if (existsSync(join(wlDir, 'worklog.db')) || existsSync(join(wlDir, 'initialized'))) {
        // Found a valid .worklog/ — use this directory
        return dir;
      }
      // Found .worklog/ but it is NOT valid.
      // Only walk past it when it is a leftover worktree container stub or
      // when inside a worktree; otherwise stop here.
      if (!isWorktreeContainerStub(wlDir) && !isInsideWorktree(dir)) {
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

/**
 * Resolve the worklog root starting from the given directory (or the
 * process CWD when not provided) and configure the fetcher so every child
 * `wl` invocation targets that root's database via `--worklog-dir`.
 *
 * Returns the resolved project root, or undefined when no valid `.worklog/`
 * is found (in which case the fetcher falls back to default resolution).
 */
export function configureWorklogTarget(startDir?: string): string | undefined {
  const wlRoot = findWorklogRoot(startDir);
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

  // Use HERDR_RESOLVED_CWD when set (passed via --env from open.sh)
  // as the starting directory for worklog discovery. The resolved root
  // is passed to child `wl` processes via --worklog-dir (setWorklogDir),
  // so we do NOT rely on a fragile process.chdir().
  const resolvedCwd = process.env.HERDR_RESOLVED_CWD;
  process.stderr.write(`[worklog-plugin] HERDR_RESOLVED_CWD='${resolvedCwd ?? '(not set)'}'\n`);

  const wlRoot = configureWorklogTarget(resolvedCwd ?? process.cwd());
  if (wlRoot) {
    process.stderr.write(`[worklog-plugin] wlRoot resolved: ${wlRoot}\n`);
  } else {
    process.stderr.write(uninitializedReport(resolvedCwd ?? process.cwd()));
  }

  // Create a fetcher that loads items using the current browseItemCount setting
  // Each call reads from settings so changes take effect on next auto-refresh
  // Smart selection (see fetchNextItems) guarantees all critical and
  // completed/in_review items are always shown, regardless of the count.
  const fetcher = async () => {
    // When no valid .worklog/ exists in the tab directory, do NOT fetch from
    // the plugin's own CWD (which would show an unrelated project's items).
    // Return an empty list so the TUI shows the uninitialized/empty state.
    if (!wlRoot) {
      return [];
    }
    try {
      const currentSettings = loadSettings();
      const count = clampBrowseItemCount(currentSettings.browseItemCount ?? defaultSettings.browseItemCount);
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
  // Settings are re-read so browseItemCount (per fetch) and showHelpText
  // (per render) changes apply without a plugin restart.
  const runSettings = loadSettings();
  const selectedItem = await runWorklistTui(
    fetcher,
    undefined,
    shortcutRegistry,
    {
      autoRefresh: runSettings.autoRefresh,
      refreshIntervalMs: runSettings.refreshIntervalMs,
      autoSync: runSettings.autoSync,
      syncIntervalMs: runSettings.syncIntervalMs,
      showHelpText: runSettings.showHelpText,
      // Re-read on every render so a showHelpText change applies on the next
      // refresh (no plugin restart needed), matching browseItemCount behavior.
      getShowHelpText: () => loadSettings().showHelpText ?? true,
      onCommand: async (command: string) => {
        // Agent commands (/skill:*, /intake, /plan) are routed to a new pi agent
        // pane opened to the right. Commands prefixed with `!!`/`!` (shell-executed
        // shortcuts like audit approve/reject, priority updates, close/delete) are
        // routed to a new herdr pane that runs them visibly; the wrapper keeps
        // the pane's process alive so the pane stays open for inspection — the
        // user dismisses it with Enter or herdr prefix+x (close_pane).
        // Everything else is written to stdout with the CMD: prefix for
        // the calling framework (Herdr) to execute.
        const route = routeCommand(command);
        // The new pane must start in the correct project root.  herdr's
        // "follow" CWD policy would otherwise inherit the source pane's CWD
        // (the plugin directory), so we pass the resolved project root
        // (wlRoot) explicitly to the pane-spawning scripts via --cwd.
        const targetCwd = wlRoot ?? resolvedCwd ?? process.cwd();
        if (route === 'agent') {
          // Claim the referenced work-item BEFORE spawning the agent pane so it
          // appears in_progress immediately. Non-blocking: failures are logged
          // to stderr and never prevent the pane from opening (AC2).
          try {
            await claimItemForAgentCommand(command);
          } catch {
            // Belt-and-suspenders: a claim failure must never block the pane.
          }
          // Spawn send-to-pi.sh asynchronously — detached and with stdio ignored
          // so the TUI loop is not blocked or affected by the script's output.
          const child = spawn(
            SEND_TO_PI_SCRIPT,
            ['--cwd', targetCwd, command],
            {
              detached: true,
              stdio: 'ignore',
              cwd: targetCwd,
              env: { ...process.env, HERDR_RESOLVED_CWD: targetCwd },
            },
          );
          child.unref(); // Allow the parent to exit independently
        } else if (route === 'pane') {
          // Strip `!!` / `!` bash history-expansion prefixes, then run the
          // command visibly in a new herdr pane via run-in-pane.sh.
          const clean = stripCommandPrefix(command);
          const child = spawn(
            RUN_IN_PANE_SCRIPT,
            ['--cwd', targetCwd, clean],
            {
              detached: true,
              stdio: 'ignore',
              cwd: targetCwd,
              env: { ...process.env, HERDR_RESOLVED_CWD: targetCwd },
            },
          );
          child.unref(); // Allow the parent to exit independently
        } else {
          // Plain (non-!!) shell commands: run them visibly in a new herdr pane
          // from the resolved project root so they always execute in the tab's
          // working directory (herdr v0.7.5 has no CMD: handling, so the stdout
          // CMD: protocol is not a reliable execution path).
          const child = spawn(
            RUN_IN_PANE_SCRIPT,
            ['--cwd', targetCwd, command],
            {
              detached: true,
              stdio: 'ignore',
              cwd: targetCwd,
              env: { ...process.env, HERDR_RESOLVED_CWD: targetCwd },
            },
          );
          child.unref();
        }
      },
    },
  );

  if (selectedItem) {
    // Print the selected item ID to stdout for use by scripts/actions
    console.log(selectedItem.id);
  }
}

// Only auto-run main() when this module is the entry point (launched directly
// by herdr/tsx), not when it is imported by tests or other modules. Without
// this guard, importing index.js in a vitest worker triggers the TUI and can
// call process.exit(1) (e.g. wl not on PATH in CI), crashing the test runner.
const isEntryPoint = (() => {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().catch((err) => {
    console.error('Worklog plugin error:', err);
    process.exit(1);
  });
}
