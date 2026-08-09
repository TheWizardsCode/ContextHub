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
 *   HERDR_TAB_ID   - Set by Herdr when running in a pane; the tab-focus
 *                    visibility signal for pause-when-hidden (optional)
 *   WL_COUNT       - Number of items to fetch (default: 20, now superseded by browseItemCount setting)
 *
 * Exit codes:
 *   0 - Normal exit (user quit or selected an item)
 *   1 - wl CLI not found
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolveWorklogRoot } from '@worklog/shared/worklog-paths';
import {
  checkWlAvailable,
  fetchNextItems,
  fetchItemsByStage,
  setWorklogDir,
  claimWorkItem,
  getExecFileAsync,
  buildWlArgs,
} from './fetcher.js';
import { AgentTracker, AGENT_PANES_FILE, mergeAgentStates } from './agent-tracker.js';
import { runWorklistTui, getTermSize } from './worklist.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { loadSettings, getDefaultSettingsPath, clampBrowseItemCount, defaultSettings } from './settings.js';
import {
  createDowntimeWorker,
  createDowntimePoller,
  buildDowntimePaneArgs,
  spawnDowntimePane,
  parseNextItemOutput,
  parseAuditCandidatesOutput,
  selectAuditCandidate,
  toDowntimeCandidate,
  skillKindFromPrompt,
  type DowntimeWorker,
  type DowntimeWorkerDeps,
  type DowntimeStage,
  type DowntimeCandidate,
  type DowntimeDispatchEvent,
  type DowntimeErrorEvent,
  type DowntimeNextResult,
  type DowntimeSpawn,
  defaultDowntimeSpawn,
  buildDowntimeDispatchComment,
  DOWNTIME_WL_TIMEOUT_MS,
} from './downtime-worker.js';
import { appendDowntimeLogEntry, auditDispatchedItemIds, readDowntimeLogEntries } from './downtime-log.js';

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
 * Strip the `/prompt:` routing prefix from a free-form prompt command.
 *
 * `/prompt:` commands are routed to the agent channel (a new pi pane) so the
 * user can inject an arbitrary prompt, not just skill/workflow invocations.
 * The prefix is a routing signal only — pi must receive the bare prompt text
 * (e.g. `Review the current work item and suggest next steps`), not the
 * prefix itself.
 *
 * @param command - Raw command string, possibly starting with `/prompt:`.
 * @returns The prompt text with the `/prompt:` prefix removed; unchanged
 *          commands (no `/prompt:` prefix) are returned as-is.
 */
export function stripAgentPromptPrefix(command: string): string {
  if (command.startsWith('/prompt:')) {
    return command.substring('/prompt:'.length);
  }
  return command;
}

/**
 * Build the argument vector for spawning `send-to-pi.sh` for an agent
 * command.
 *
 * The resolved project root is passed via `--cwd`. When the shortcut entry
 * carries a `model` (WL-0MSD48ZFC0043AO3), `--model <pattern>` is forwarded
 * so the pi CLI opens with the requested model (e.g. `pi --model code
 * '/skill:implement <id>'`). Free-form `/prompt:` commands have their routing
 * prefix stripped here so pi receives only the prompt text. Commands without
 * a model get no `--model` flag.
 *
 * When `paneIdFile` is provided (agent commands carrying a work-item ID,
 * WL-0MSBQUJQX005RAT9), `--pane-id-file <path>` is forwarded so the script
 * writes the new pane ID immediately after the split succeeds — the plugin
 * reads it back to record the work-item ↔ pane association.
 */
export function buildSendToPiArgs(
  command: string,
  targetCwd: string,
  model?: string,
  paneIdFile?: string,
): string[] {
  const agentPrompt = stripAgentPromptPrefix(command);
  const args = ['--cwd', targetCwd];
  if (model) {
    args.push('--model', model);
  }
  if (paneIdFile) {
    args.push('--pane-id-file', paneIdFile);
  }
  args.push(agentPrompt);
  return args;
}

/**
 * Parse the pane-ID file written by send-to-pi.sh (`--pane-id-file`).
 *
 * The script writes `{"pane_id": "<id>"}` immediately after the pane split
 * succeeds. Tolerates log lines prefixed before the JSON envelope.
 * Returns undefined when the file is absent, unparseable, or has no pane id.
 */
export function parsePaneIdFile(raw: string): string | undefined {
  const start = raw.indexOf('{');
  if (start < 0) return undefined;
  try {
    const obj = JSON.parse(raw.slice(start)) as Record<string, unknown>;
    const paneId = obj?.pane_id ?? obj?.paneId;
    return typeof paneId === 'string' && paneId !== '' ? paneId : undefined;
  } catch {
    return undefined;
  }
}

// ── Pane-ID capture (WL-0MSBQUJQX005RAT9) ─────────────────────────────

/** Poll interval for the pane-ID file capture loop. */
export const CAPTURE_POLL_INTERVAL_MS = 200;
/** Total time budget for the pane-ID file capture loop. */
export const CAPTURE_TIMEOUT_MS = 5000;

/**
 * Injectable filesystem/timer dependencies for {@link capturePaneIdFromFile}
 * (tests replace these so no real polling or temp files are needed).
 */
export interface PaneIdFileDeps {
  existsSync?: (p: string) => boolean;
  readFile?: (p: string) => string;
  unlink?: (p: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll for the pane-ID file written by send-to-pi.sh, record the
 * work-item ↔ pane association, and clean up the temp file.
 *
 * Fire-and-forget (never awaited by the TUI): the loop polls briefly for
 * the file so pane-ID capture never blocks the TUI event loop or changes
 * spawn behavior. A missing file (split failed) is a no-op — no entry is
 * recorded. All failures are swallowed (fail-open).
 *
 * @param workItemId - Work item the agent command was dispatched for.
 * @param paneIdFile - Path passed to send-to-pi.sh via `--pane-id-file`.
 * @param record - Records the association (typically
 *                 `tracker.recordAgentForWorkItem`).
 * @param deps - Injectable fs/timer dependencies (tests).
 * @returns The captured pane ID, or undefined on timeout.
 */
export async function capturePaneIdFromFile(
  workItemId: string,
  paneIdFile: string,
  record: (workItemId: string, paneId: string) => void | Promise<void>,
  deps: PaneIdFileDeps = {},
): Promise<string | undefined> {
  const existsSyncFn = deps.existsSync ?? ((p: string) => existsSync(p));
  const readFileFn = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const unlinkFn = deps.unlink ?? ((p: string) => { try { unlinkSync(p); } catch { /* ignore */ } });
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + CAPTURE_TIMEOUT_MS;

  while (now() < deadline) {
    if (existsSyncFn(paneIdFile)) {
      let raw: string | null = null;
      try {
        raw = readFileFn(paneIdFile);
      } catch {
        raw = null; // file mid-write — keep polling
      }
      const paneId = raw !== null ? parsePaneIdFile(raw) : undefined;
      if (paneId) {
        try {
          await record(workItemId, paneId);
        } catch {
          // Recording must never break dispatch; the temp file is still
          // cleaned up below.
        }
        unlinkFn(paneIdFile);
        return paneId;
      }
    }
    await sleep(CAPTURE_POLL_INTERVAL_MS);
  }
  // Timed out — the split may have failed or the file never appeared.
  return undefined;
}

/**
 * Check if a command is an agent command that should be sent to a pi pane.
 * Agent commands are those starting with /skill:, /intake, /plan, or /prompt:.
 */
function isAgentCommand(command: string): boolean {
  return (
    command.startsWith('/skill:') ||
    command.startsWith('/intake') ||
    command.startsWith('/plan') ||
    command.startsWith('/prompt:')
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
 * Build the real downtime-worker dependencies (WL-0MSF49FMW009M06K):
 * `wl next --stage <stage> --json` for dispatch selection, `wl update
 * <id> --status in_progress` for the pre-dispatch claim, and
 * `send-to-pi.sh` for the visible (non-focus-stealing) agent pane. Every
 * boundary is fail-closed: a wl failure yields no candidate (no dispatch)
 * rather than an exception.
 */
export function createDowntimeDeps(
  scriptPath: string,
  assignee: string,
  spawnFn: DowntimeSpawn = defaultDowntimeSpawn,
): DowntimeWorkerDeps {
  return {
    async getNextItem(stage: DowntimeStage): Promise<DowntimeNextResult> {
      try {
        // buildWlArgs() prepends the tab's resolved --worklog-dir override
        // (WL-0MSI7DQL10016QYX): the downtime worker must select candidates
        // from the SAME worklog root the worklist uses, not the plugin
        // process's own cwd. Without the override the vector is unchanged.
        // The bounded timeout (WL-0MSJIPHD0001L1J9) kills a hung wl child
        // so the lookup fails closed to a strike instead of wedging the
        // dispatch task until the pane restarts.
        const { stdout } = await getExecFileAsync()(
          'wl',
          buildWlArgs(['next', '--stage', stage, '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        );
        return { ok: true, candidate: parseNextItemOutput(stdout, stage) };
      } catch {
        // Transient wl failure → fail closed to busy: no dispatch, and the
        // worker must NOT treat it as an empty backlog (no cooldown).
        return { ok: false };
      }
    },
    async getNextAuditCandidate(cwd: string): Promise<DowntimeCandidate | null> {
      try {
        // Audit tier (WL-0MSI8H3HP000K0RG): select the first completed /
        // in_review item WITHOUT a valid audit so the producer-review queue
        // (the release gate) is drained during idle time. Same fail-closed
        // semantics as getNextItem: a wl failure yields no candidate. The
        // bounded timeout (WL-0MSJIPHD0001L1J9) applies here too.
        const { stdout } = await getExecFileAsync()(
          'wl',
          buildWlArgs(['list', '--status', 'completed', '--stage', 'in_review', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        );
        const candidates = parseAuditCandidatesOutput(stdout);
        if (candidates === null) return null;
        // Dispatched-marker exclusion (WL-0MSLIY8ZR004QUSY): read the shared
        // rolling dispatch log for THIS worklog root (the same <cwd> that
        // recordDispatch writes) and exclude any candidate the downtime
        // worker has already dispatched for /skill:audit unless a fresh
        // audit exists since (the composition lives in selectAuditCandidate).
        // Fail-safe: readDowntimeLogEntries never throws — a missing or
        // unreadable log is treated as empty, so audit-tier dispatch still
        // works on a fresh worklog (a corrupted log cannot silently disable
        // the audit tier).
        const entries = await readDowntimeLogEntries(cwd);
        const dispatchedAuditIds = auditDispatchedItemIds(entries);
        const selected = selectAuditCandidate(candidates, Date.now(), dispatchedAuditIds);
        return selected === null ? null : toDowntimeCandidate(selected);
      } catch {
        // Fail-closed: a wl failure yields no candidate (no dispatch).
        return null;
      }
    },
    async claimItem(itemId: string): Promise<void> {
      // claimWorkItem never throws — failures are returned, but the result is
      // deliberately discarded here: a failed claim must not block the
      // dispatch. Note this path does NOT log the failure (unlike
      // claimItemForAgentCommand), so a claim failure is silent and the
      // dispatch is still recorded as a success (known silent path, follow-up
      // WL-0MSLWJ310000ND0X; see README "Failure-path logging").
      await claimWorkItem(itemId, assignee);
    },
    async spawnAgentPane(prompt: string, opts: { model: string; cwd: string }): Promise<void> {
      const kind = skillKindFromPrompt(prompt);
      spawnDowntimePane(
        scriptPath,
        buildDowntimePaneArgs(kind, prompt, opts),
        { cwd: opts.cwd },
        spawnFn,
      );
    },
    async recordDispatch(event: DowntimeDispatchEvent): Promise<void> {
      // 1. Durable trail: a comment on the item itself (survives wl sync).
      // buildWlArgs() prepends the resolved --worklog-dir override so the
      // comment lands on the item in ITS project's DB, not the plugin
      // process's own cwd (WL-0MSI7DQL10016QYX).
      try {
        await getExecFileAsync()(
          'wl',
          buildWlArgs([
            'comment',
            'add',
            event.itemId,
            '--comment',
            buildDowntimeDispatchComment(event.itemId, event.kind, event.dispatchedAt),
            '--author',
            'herdr-downtime',
            '--json',
          ]),
          { timeout: 5000 },
        );
      } catch {
        // fail-closed: audit logging must never crash the worker
      }
      // 2. Rolling local log (bounded JSONL under <cwd>/.worklog).
      try {
        await appendDowntimeLogEntry(event.cwd, JSON.stringify(event));
      } catch {
        // fail-closed
      }
    },
    async recordError(event: DowntimeErrorEvent): Promise<void> {
      // Persistent CLI-error trail (three-strike rule): rolling JSONL log
      // under <cwd>/.worklog — the same bounded log as dispatch audit
      // entries (WL-0MSGPI4AR000YOK8). Fail-closed: never crash the worker.
      try {
        await appendDowntimeLogEntry(event.cwd, JSON.stringify(event));
      } catch {
        // fail-closed
      }
    },
  };
}

// Load settings
const settings = loadSettings();

/**
 * Resolve the worklog root starting from the given directory (or the
 * process CWD when not provided) and configure the fetcher so every child
 * `wl` invocation targets that root's database via `--worklog-dir`.
 *
 * The resolution itself is delegated to the shared
 * `resolveWorklogRoot()` (packages/shared/src/worklog-paths.ts) — the same
 * strategy the `wl` CLI uses — so the plugin and the CLI can never disagree
 * about what constitutes the project root.
 *
 * Returns the resolved project root, or undefined when no valid `.worklog/`
 * is found (in which case the fetcher falls back to default resolution).
 */
export function configureWorklogTarget(startDir?: string): string | undefined {
  if (startDir) {
    process.stderr.write(`[worklog-plugin] resolving worklog root from HERDR_RESOLVED_CWD: ${startDir}\n`);
  }
  const wlRoot = resolveWorklogRoot(startDir);
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

  // Load shortcut config: bundled defaults merged with a project-local
  // <worklog-root>/shortcuts.json when present (local wins on chord+view,
  // WL-0MSHUMX5C004NC4O). Loaded AFTER configureWorklogTarget so the
  // resolved wlRoot (when found) is available for local override discovery;
  // without a worklog root the registry is the bundled-only default.
  const shortcutRegistry = loadShortcutConfig(wlRoot);

  // Agent tracker (WL-0MSBQUJQX005RAT9): records which worklist-spawned
  // agent pane is attached to each work item. The state file lives in the
  // project's gitignored .worklog/ directory and is shared across worklist
  // panes/tabs. Fail-open: without a valid worklog root the tracker runs
  // in-memory only (no persistence).
  const agentTracker = new AgentTracker({
    stateFile: wlRoot ? join(wlRoot, '.worklog', AGENT_PANES_FILE) : undefined,
  });

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
      const items = await fetchNextItems(count);
      // Merge agent-status state into the fetched items (fail-open: no herdr
      // CLI → no icons, list still works). Also covers the initial load.
      await mergeAgentStates(items, agentTracker);
      return items;
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
  // Downtime worker (local-LLM idle dispatch, WL-0MSF49FMW009M06K): built
  // when enabled; settings are re-read every tick via `config()` so changes
  // apply without a plugin restart. The dispatch panes open in the resolved
  // worklog root (--cwd).
  const targetCwd = wlRoot ?? resolvedCwd ?? process.cwd();
  const downtimeWorker: DowntimeWorker | undefined = runSettings.downtimeEnabled
    ? createDowntimeWorker({
        poller: createDowntimePoller(runSettings.downtimeProxyUrl),
        deps: createDowntimeDeps(SEND_TO_PI_SCRIPT, AGENT_ASSIGNEE),
        config: () => {
          const s = loadSettings();
          return {
            enabled: s.downtimeEnabled,
            thresholdMs: s.downtimeIdleThresholdMs,
            requiredFreeSlots: s.downtimeRequiredFreeSlots,
            model: s.downtimeModel,
            cwd: targetCwd,
            noCandidateCooldownMs: s.downtimeNoCandidateCooldownMs,
          };
        },
      })
    : undefined;
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
      showIcons: runSettings.showIcons,
      downtimeWorker,
      downtimePollIntervalMs: runSettings.downtimePollIntervalMs,
      // Re-read on every render so a showHelpText change applies on the next
      // refresh (no plugin restart needed), matching browseItemCount behavior.
      getShowHelpText: () => loadSettings().showHelpText ?? true,
      // Re-read on every render so a showIcons change applies on the next
      // refresh (no plugin restart needed), matching showHelpText behavior.
      getShowIcons: () => loadSettings().showIcons ?? true,
      // Merge agent-status state into freshly fetched items (top-level +
      // expanded children) on every refresh cycle (WL-0MSBQUJQX005RAT9).
      // Fail-open: herdr errors yield no icons; the list keeps working.
      mergeAgentStates: (items) => mergeAgentStates(items, agentTracker),
      onCommand: async (command: string, model?: string) => {
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
        // Fallback order: resolved worklog root, then HERDR_RESOLVED_CWD
        // (the directory the user ran the plugin from), then process.cwd().
        // resolvedCwd is preferred over process.cwd() because it reflects
        // the user's intended project, which may differ when the plugin
        // process CWD is the herdr extension directory.
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
          // Agent-pane association capture (WL-0MSBQUJQX005RAT9): when the
          // command carries a work-item ID, ask send-to-pi.sh to write the
          // new pane ID to a temp file (--pane-id-file) right after the split
          // succeeds, then record the work-item ↔ pane association
          // fire-and-forget. Commands without an ID are not tracked (AC6).
          const itemId = extractWorkItemId(command);
          const paneIdFile = itemId
            ? join(tmpdir(), `herdr-pane-${process.pid}-${Date.now()}.json`)
            : undefined;
          // Spawn send-to-pi.sh asynchronously — detached and with stdio ignored
          // so the TUI loop is not blocked or affected by the script's output.
          // The `model` from the shortcut entry (if any) is forwarded as
          // `--model <pattern>` so the pi CLI opens with the right model.
          const child = spawn(
            SEND_TO_PI_SCRIPT,
            buildSendToPiArgs(command, targetCwd, model, paneIdFile),
            {
              detached: true,
              stdio: 'ignore',
              cwd: targetCwd,
              env: { ...process.env, HERDR_RESOLVED_CWD: targetCwd },
            },
          );
          child.unref(); // Allow the parent to exit independently
          if (itemId && paneIdFile) {
            // Fire-and-forget: polling must never block the TUI loop. A
            // missing file (split failed) is a no-op — no entry recorded.
            void capturePaneIdFromFile(itemId, paneIdFile, (wid, pid) =>
              agentTracker.recordAgentForWorkItem(wid, pid),
            );
          }
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
