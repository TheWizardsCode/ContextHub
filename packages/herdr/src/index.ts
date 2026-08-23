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

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
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
import { HerdrEventSubscriber, resolveSocketPath } from './events.js';
import { runWorklistTui, getTermSize } from './worklist.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { readCodeFreezeStatusForRoot } from './code-freeze.js';
import { loadSettings, getDefaultSettingsPath, clampBrowseItemCount, defaultSettings } from './settings.js';
import {
  createDowntimeWorker,
  createDowntimePoller,
  buildDowntimePaneArgs,
  spawnDowntimePane,
  parseNextCandidatesOutput,
  parseAuditCandidatesOutput,
  parseImplementCandidatesOutput,
  parseCriticalCandidatesOutput,
  parseDepListBlockersOutput,
  parseShownWorkItem,
  selectAuditCandidate,
  selectImplementCandidate,
  selectCriticalCandidate,
  selectNextCandidate,
  resolveDependencyFrontier,
  toDowntimeCandidate,
  toImplementCandidate,
  skillKindFromPrompt,
  type DowntimeWorker,
  type DowntimeWorkerDeps,
  type DowntimeStage,
  type CriticalCandidate,
  type DowntimeCandidate,
  type DowntimeDispatchEvent,
  type DowntimeDispatchFailureEvent,
  type DowntimeErrorEvent,
  type DowntimeNextResult,
  type DowntimeClaimExpected,
  type DowntimeClaimResult,
  type DowntimeSpawn,
  type DowntimeSpawnResult,
  type ScheduledPrompt,
  defaultDowntimeSpawn,
  buildDowntimeDispatchComment,
  DOWNTIME_WL_TIMEOUT_MS,
  DOWNTIME_AUDIT_STALE_WINDOW_MS,
  parseInProgressOutput,
  type DowntimeActiveAuditResult,
} from './downtime-worker.js';
import {
  createModeSwitchWorker,
  type ModeSwitchWorker,
} from './mode-switch-worker.js';
import { createRoundRobinRegistry, type RoundRobinRegistry } from './downtime-round-robin.js';
import {
  appendDowntimeLogEntry,
  auditDispatchedItemIds,
  implementDispatchedItemIds,
  planDispatchedItemStages,
  intakeDispatchedItemStages,
  dispatchedItemStages,
  readDowntimeLogEntries,
  recentAuditDispatchedItemIds,
} from './downtime-log.js';
import {
  getDueScheduledPrompt as getFirstDuePrompt,
  loadScheduledPrompts,
  updateScheduledPromptLastTriggered,
} from './scheduled-prompts.js';

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
 *
 * Every selection-list agent dispatch passes `--no-focus` (WL-0MSHIA53D009DJOT)
 * so shared/send-to-pi.sh skips its final zoom and the selection list keeps
 * focus while the pi agent pane opens in the background. The shared script's
 * own default (focus on) is unchanged for its other consumers.
 */
export function buildSendToPiArgs(
  command: string,
  targetCwd: string,
  model?: string,
  paneIdFile?: string,
): string[] {
  const agentPrompt = stripAgentPromptPrefix(command);
  const args = ['--no-focus', '--cwd', targetCwd];
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
 * Build the argument vector for spawning `scripts/run-in-pane.sh` for a
 * command-output pane (`!!`/`!`-prefixed pane route and plain shell stdout
 * route). Mirrors `buildSendToPiArgs`: `--no-focus` (WL-0MSHIA53D009DJOT) is
 * always passed so opening the command-output pane does not steal focus from
 * the selection list, followed by `--cwd <targetCwd>` so the pane starts in
 * the resolved project root. `run-in-pane.sh` parses both options at the
 * head of argv; everything else is the command itself.
 */
export function buildRunInPaneArgs(command: string, targetCwd: string): string[] {
  return ['--no-focus', '--cwd', targetCwd, command];
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

// ── Background (no-pane) dispatch (WL-0MSJLD1I70045ZUL) ────────────────

/**
 * Directory (under the OS tmpdir) holding per-run background-dispatch logs.
 * A single known directory so logs can be located for inspection; cleanup
 * of old logs is out of scope (each filename carries a timestamp + pid).
 */
export const BACKGROUND_LOG_DIR = 'herdr-background-logs';

/**
 * Build a per-run log file path for a background (no-pane) shortcut
 * dispatch (WL-0MSJLD1I70045ZUL).
 *
 * Returns `<tmpdir>/herdr-background-logs/herdr-<timestamp>-<pid>-<slug>.log`
 * where the slug is a sanitised prefix of the command — concurrent
 * dispatches never collide (timestamp + pid) and each run is individually
 * inspectable. The caller logs the returned path to stderr so the user can
 * locate the file.
 */
export function buildBackgroundLogPath(command: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug =
    command.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) ||
    'command';
  return join(tmpdir(), BACKGROUND_LOG_DIR, `herdr-${stamp}-${process.pid}-${slug}.log`);
}

/**
 * Injectable spawn/filesystem dependencies for the background spawn
 * helpers (tests replace these so no real subprocess or log file is needed).
 */
export interface BackgroundSpawnDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  openSync?: (path: string, flags: string) => number;
  /** Called when the background child process exits — triggers a TUI refresh. */
  onExit?: (exitCode: number | null, signal: string | null) => void;
}

/**
 * Open a background log file for append, creating the directory first.
 * Returns the fd, or -1 when the log cannot be opened (caller falls back to
 * 'ignore' stdio so a logging failure never blocks dispatch).
 */
function openBackgroundLog(logPath: string, open: (path: string, flags: string) => number): number {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    return open(logPath, 'a');
  } catch (err) {
    process.stderr.write(
      `[worklog-plugin] Could not open background log ${logPath}: ${(err as Error).message}\n`,
    );
    return -1;
  }
}

/**
 * Spawn a shell command detached with stdout/stderr redirected to a log
 * file — the `open_pane: false` execution path for `!!`/`!` shell commands
 * (WL-0MSJLD1I70045ZUL).
 *
 * Mirrors the existing pane-spawn pattern (`detached: true` + `unref()`)
 * so the TUI event loop and process lifecycle are unaffected: the parent
 * exits independently while the child runs to completion, appending its
 * output to the log. When the log file cannot be opened, stdio falls back
 * to 'ignore' (logged) — a logging failure never blocks dispatch.
 */
export function spawnBackgroundShell(
  command: string,
  targetCwd: string,
  logPath: string,
  deps: BackgroundSpawnDeps = {},
): ChildProcess {
  const spawnFn = deps.spawn ?? spawn;
  const open = deps.openSync ?? openSync;
  const fd = openBackgroundLog(logPath, open);
  const child = spawnFn('bash', ['-c', command], {
    detached: true,
    stdio: fd >= 0 ? (['ignore', fd, fd] as const) : 'ignore',
    cwd: targetCwd,
    env: { ...process.env, HERDR_RESOLVED_CWD: targetCwd },
  });
  child.unref(); // Allow the parent to exit independently

  // On exit, fire the refresh callback (fire-and-forget — never blocks).
  if (deps.onExit) {
    child.on('exit', deps.onExit);
  }

  return child;
}

/**
 * Spawn a headless pi run detached with stdout/stderr redirected to a log
 * file — the `open_pane: false` execution path for agent commands
 * (`/skill:*`, `/intake`, `/plan`, `/prompt:`) (WL-0MSJLD1I70045ZUL).
 *
 * Uses the established headless pattern `pi -p --mode json` (see
 * `~/.pi/agent/skills/audit/scripts/audit_runner.py`, WL-0MSG4VSP10020NL7):
 * no pane is created, so the work-item ↔ pane association
 * (WL-0MSBQUJQX005RAT9) is skipped. The entry's `model` is honored via
 * `--model <pattern>`; free-form `/prompt:` commands have their routing
 * prefix stripped so pi receives only the prompt text. Detached + unref'd
 * like the pane-spawn paths; log open failure falls back to 'ignore'.
 */
export function spawnBackgroundPi(
  prompt: string,
  targetCwd: string,
  model: string | undefined,
  logPath: string,
  deps: BackgroundSpawnDeps = {},
): ChildProcess {
  const spawnFn = deps.spawn ?? spawn;
  const open = deps.openSync ?? openSync;
  const fd = openBackgroundLog(logPath, open);
  const args = ['-p', '--mode', 'json'];
  if (model) {
    args.push('--model', model);
  }
  args.push(prompt);
  const child = spawnFn('pi', args, {
    detached: true,
    stdio: fd >= 0 ? (['ignore', fd, fd] as const) : 'ignore',
    cwd: targetCwd,
    env: { ...process.env, HERDR_RESOLVED_CWD: targetCwd },
  });
  child.unref(); // Allow the parent to exit independently

  // On exit, fire the refresh callback (fire-and-forget — never blocks).
  if (deps.onExit) {
    child.on('exit', deps.onExit);
  }

  return child;
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
 * Resolve the dependency blockers of a work item via `wl dep list`
 * (F3, decision Q3). The outbound `depends-on` edges of the queried item
 * are its blockers; the dep-list edges carry only id/title/status/
 * priority, so each blocker is enriched via `wl show` to obtain the full
 * stage/risk/effort/sortIndex fields the frontier resolution needs
 * (stage→skill mapping + implement caps, Q2). THROWS on a wl or parse
 * failure — the caller's fail-closed catch converts it into a strike
 * (`{ok:false}`), so a dependency look-up failure never masquerades as an
 * empty frontier (AC5: no silent fall-through).
 */
async function fetchCriticalBlockers(cwd: string, itemId: string): Promise<CriticalCandidate[]> {
  const { stdout } = await getExecFileAsync()(
    'wl',
    buildWlArgs(['dep', 'list', itemId, '--json']),
    { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
  );
  const blockerRefs = parseDepListBlockersOutput(stdout);
  if (blockerRefs === null) throw new Error('wl dep list parse failure');
  const blockers: CriticalCandidate[] = [];
  for (const ref of blockerRefs) {
    const { stdout: showOut } = await getExecFileAsync()(
      'wl',
      buildWlArgs(['show', ref.id, '--json']),
      { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
    );
    const full = parseShownWorkItem(showOut);
    if (full === null) throw new Error(`wl show parse failure for ${ref.id}`);
    blockers.push(full);
  }
  return blockers;
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
  // Shared round-robin registry (WL-0MSSRED76008LGB6): one per worklog root
  // (`<cwd>/.worklog/downtime-round-robin.json`), created lazily so each
  // selection re-reads the durable cursor from disk — cross-instance
  // rotation works because the file is the source of truth. Fail-open: a
  // missing/unreadable file degrades to no rotation (cursor 0).
  const registries = new Map<string, RoundRobinRegistry>();
  const registryFor = (cwd: string): RoundRobinRegistry => {
    const worklogDir = join(cwd, '.worklog');
    let registry = registries.get(worklogDir);
    if (!registry) {
      registry = createRoundRobinRegistry({ worklogDir });
      registries.set(worklogDir, registry);
    }
    return registry;
  };
  return {
    async getNextItem(stage: DowntimeStage, cwd: string): Promise<DowntimeNextResult> {
      try {
        // buildWlArgs() prepends the tab's resolved --worklog-dir override
        // (WL-0MSI7DQL10016QYX): the downtime worker must select candidates
        // from the SAME worklog root the worklist uses, not the plugin
        // process's own cwd. Without the override the vector is unchanged.
        // A generous batch (-n 10) is fetched so a marker-excluded top
        // candidate does not starve selection of the next one. The bounded
        // timeout (WL-0MSJIPHD0001L1J9) kills a hung wl child so the lookup
        // fails closed to a strike instead of wedging the dispatch task
        // until the pane restarts.
        const { stdout } = await getExecFileAsync()(
          'wl',
          buildWlArgs(['next', '--stage', stage, '-n', '10', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        );
        const candidates = parseNextCandidatesOutput(stdout, stage);
        if (candidates === null) return { ok: false };
        // Plan/intake dispatched-marker exclusion with change-guard (RCA
        // WL-0MSRBFFLN005W3VT design point 3, RC-2): read the shared rolling
        // dispatch log for THIS worklog root and exclude any candidate the
        // downtime worker already dispatched for its tier (kind plan at
        // intake_complete / kind intake at idea) while the item is still at
        // its dispatched-at stage. A stage advancement releases it (the item
        // leaves the stage filter anyway). Fail-safe: readDowntimeLogEntries
        // never throws — a missing or unreadable log is treated as empty.
        const entries = await readDowntimeLogEntries(cwd);
        const dispatched =
          stage === 'intake_complete'
            ? planDispatchedItemStages(entries)
            : stage === 'idea'
              ? intakeDispatchedItemStages(entries)
              : new Map<string, string>();
        const selected = selectNextCandidate(candidates, dispatched, registryFor(cwd));
        return { ok: true, candidate: selected };
      } catch {
        // Transient wl failure → fail closed to busy: no dispatch, and the
        // worker must NOT treat it as an empty backlog (no cooldown).
        return { ok: false };
      }
    },
    // Code-freeze gate (WL-0MSQ0RPQP00636JY): fresh tri-state read of the
    // ship-it marker at `<cwd>/.worklog/code-freeze.json` on EVERY dispatch
    // (never cached). The dispatcher treats 'frozen' and 'ambiguous'
    // (fail-closed) identically: no audit/implement dispatch during a
    // release; plan/intake continue.
    readCodeFreezeStatus: (cwd: string) => readCodeFreezeStatusForRoot(cwd),
    async getNextAuditCandidate(cwd: string): Promise<DowntimeNextResult> {
      try {
        // Audit tier (WL-0MSI8H3HP000K0RG): select the first completed /
        // in_review item WITHOUT a valid audit so the producer-review queue
        // (the release gate) is drained during idle time. --root-only
        // (WL-0MSTLFW14000KPEC): only PARENT items are audit candidates —
        // completed/in_review children (sub-tasks) are never dispatched
        // independently; the producer reviews deliverable units (parents),
        // whose audits cover their children. Same fail-closed semantics as
        // getNextItem, with the same error channel
        // (WL-0MSLWJ2KP0002SV0): a wl/parse failure resolves {ok:false} — a
        // CLI-error strike — NOT a null that is indistinguishable from a
        // genuinely empty audit tier. The bounded timeout
        // (WL-0MSJIPHD0001L1J9) applies here too.
        const { stdout } = await getExecFileAsync()(
          'wl',
          buildWlArgs(['list', '--status', 'completed', '--stage', 'in_review', '--root-only', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        );
        const candidates = parseAuditCandidatesOutput(stdout);
        if (candidates === null) return { ok: false };
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
        const selected = selectAuditCandidate(candidates, Date.now(), dispatchedAuditIds, registryFor(cwd));
        // Genuinely empty audit tier → ok:true with no candidate (unchanged
        // empty behaviour); a selected item → ok:true with the candidate.
        return selected === null
          ? { ok: true, candidate: null }
          : { ok: true, candidate: toDowntimeCandidate(selected) };
      } catch {
        // Fail-closed: a wl failure yields a CLI-error outcome, never a
        // candidate and never a null that looks like an empty tier — the
        // caller counts it as a strike (WL-0MSLWJ2KP0002SV0).
        return { ok: false };
      }
    },
    async getActiveAudit(cwd: string): Promise<DowntimeActiveAuditResult> {
      try {
        // Active-audit single-flight (WL-0MT3PHW4I002SNOV): does any
        // non-stale kind=audit dispatch marker map to an item still
        // `in_progress`? Dispatch-log-first (per plan decision Q2): read the
        // shared rolling dispatch log — the cross-instance source of truth
        // (an audit dispatched by ANY instance, leader or not, is seen
        // here) — and keep only markers within the 2h stale window
        // (DOWNTIME_AUDIT_STALE_WINDOW_MS). A marker older than the window
        // is treated as stale (the audit pane may have crashed without
        // updating the work item) and ignored. Fail-safe: readDowntimeLog
        // Entries never throws — a missing or unreadable log is empty, so
        // a fresh worklog never reports a phantom active audit.
        const entries = await readDowntimeLogEntries(cwd);
        const auditCandidateIds = recentAuditDispatchedItemIds(
          entries,
          DOWNTIME_AUDIT_STALE_WINDOW_MS,
        );
        if (auditCandidateIds.size === 0) {
          // Cheap fast-path: no non-stale audit markers → no active audit
          // (no worklog query needed).
          return { ok: true, active: false };
        }
        // Intersect with the worklog's in_progress items: a marker only
        // counts as an ACTIVE audit while its item is still in_progress
        // (dispatched but not yet completed/reviewed — the audit pane
        // transitions the item when it finishes). The bounded timeout
        // (WL-0MSJIPHD0001L1J9) kills a hung wl child.
        const { stdout } = await getExecFileAsync()(
          'wl',
          buildWlArgs(['list', '--status', 'in_progress', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        );
        const inProgress = parseInProgressOutput(stdout);
        if (inProgress === null) {
          // Unparseable query → the check cannot complete → fail-open.
          return { ok: false };
        }
        const active = [...auditCandidateIds].some((id) => inProgress.has(id));
        return { ok: true, active };
      } catch {
        // Fail-open: a wl failure yields {ok:false} — the dispatcher skips
        // the audit tier and falls through to the next tier; dispatch is
        // never blocked by an unanswerable check (fail-safe).
        return { ok: false };
      }
    },
    async getNextImplementCandidate(cwd: string): Promise<DowntimeCandidate | null> {
      try {
        // Implement tier (WL-0MSMAYPQP001FLR6): select the highest-priority
        // open plan_complete item with risk ≤ Medium / effort ≤ Medium. The wl
        // next server-side at-most filters (--risk medium --effort medium,
        // delivered by WL-0MSMAIP5F003WAGG) do the heavy lifting; a
        // generous batch (-n 10) is fetched so completed epics (which wl
        // next keeps under a stage filter) can be filtered out client-side
        // without starving selection. The bounded timeout
        // (WL-0MSJIPHD0001L1J9) kills a hung wl child. Fail-closed: a wl
        // failure yields no candidate (no dispatch) and never short-circuits
        // the plan/intake fallback (AC6).
        const { stdout } = await getExecFileAsync()(
          'wl',
          buildWlArgs([
            'next',
            '--stage',
            'plan_complete',
            '--risk',
            'medium',
            '--effort',
            'medium',
            '-n',
            '10',
            '--json',
          ]),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        );
        const candidates = parseImplementCandidatesOutput(stdout);
        if (candidates === null) return null;
        // Dispatched-marker exclusion (AC6): read the shared rolling
        // dispatch log for THIS worklog root and exclude any candidate the
        // downtime worker has already dispatched for /skill:implement
        // (kind implement markers). Fail-safe: readDowntimeLogEntries never
        // throws — a missing or unreadable log is treated as empty, so
        // implement-tier dispatch still works on a fresh worklog.
        const entries = await readDowntimeLogEntries(cwd);
        const dispatchedImplementIds = implementDispatchedItemIds(entries);
        const selected = selectImplementCandidate(candidates, dispatchedImplementIds, registryFor(cwd));
        return selected === null ? null : toImplementCandidate(selected);
      } catch {
        // Fail-closed: a wl failure yields no candidate (no dispatch).
        return null;
      }
    },
    async getNextCriticalCandidate(cwd: string): Promise<DowntimeNextResult> {
      try {
        // Critical-first tier (WL-0MT3FM8VA005XBHE): enumerate open
        // critical items across ALL stages via `wl list --priority critical
        // --status open -n 10 --json`. Unlike `wl next --stage X` (which
        // excludes dependency-blocked items by default), `wl list` returns
        // blocked critical items too — the looked-up candidate may be
        // dependency-blocked, and the frontier resolution (F3) decides the
        // dispatch target if it is. A generous batch (-n 10) is fetched so
        // a change-guard-excluded top candidate does not starve selection
        // of the next one. The bounded timeout (WL-0MSJIPHD0001L1J9) kills
        // a hung wl child so the lookup fails closed to a strike instead
        // of wedging the dispatch task.
        const { stdout } = await getExecFileAsync()(
          'wl',
          buildWlArgs(['list', '--priority', 'critical', '--status', 'open', '-n', '10', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        );
        const candidates = parseCriticalCandidatesOutput(stdout);
        if (candidates === null) return { ok: false };
        // Dispatched-marker change-guard (WL-0MSRBFFLN005W3VT design point
        // 3 semantics): read the shared rolling dispatch log for THIS
        // worklog root and exclude any critical item the downtime worker
        // has already dispatched for its stage-appropriate skill (kind
        // intake/plan/implement markers) while the item is still at its
        // dispatched-at stage; a stage advancement releases it. Fail-safe:
        // readDowntimeLogEntries never throws — a missing or unreadable
        // log is treated as empty.
        const entries = await readDowntimeLogEntries(cwd);
        // Any dispatched kind (intake/plan/implement) guards the critical
        // item while it is still at its dispatched-at stage.
        const dispatched = new Map<string, string>();
        for (const kind of ['intake', 'plan', 'implement'] as const) {
          for (const [id, stageAt] of dispatchedItemStages(entries, kind)) {
            dispatched.set(id, stageAt);
          }
        }
        const selected = selectCriticalCandidate(candidates, dispatched, registryFor(cwd));
        if (selected === null) return { ok: true, candidate: null };
        // Dependency-frontier resolution (F3, decision Q3): when the
        // selected critical candidate is dependency-blocked, the dispatch
        // target is the NEAREST OPEN blocker (with the blocker's own
        // stage-appropriate skill). The lookup returns that frontier
        // blocker — the same contract the dispatch tier already consumes
        // (like getNextItem returns a wl next candidate).
        const frontier = await resolveDependencyFrontier(selected, (itemId) =>
          fetchCriticalBlockers(cwd, itemId),
        );
        if (frontier === null) {
          // Chain bottomed in closed / non-dispatchable items (or a
          // cycle): no critical dispatch this tick — fall through to the
          // normal tier order. A wl failure NEVER lands here: the fetcher
          // throws and the catch below fails closed to a strike.
          return { ok: true, candidate: null };
        }
        return {
          ok: true,
          candidate: {
            id: frontier.id,
            title: frontier.title,
            // The frontier blocker's WORKLOG stage (idea / intake_complete
            // / plan_complete) rides on the field the tier maps through
            // `criticalSkillKind` — the blocker is dispatched with ITS
            // stage-appropriate skill (Q3).
            stage: frontier.stage as DowntimeStage,
          },
        };
      } catch {
        // Fail-closed: a wl failure yields a CLI-error outcome, never a
        // candidate and never a null that looks like an empty tier — the
        // caller counts it as a strike.
        return { ok: false };
      }
    },
    // Scheduled-prompts tier (WL-0MSS1Q5ER007QDKX): read the project-local
    // config at <cwd>/.worklog/scheduled-prompts.json and select the first
    // DUE entry in config order. Fail-closed: an absent or malformed config
    // resolves null (logged notice/error inside loadScheduledPrompts) — no
    // scheduled dispatch and the existing tiers are unaffected; `wl init` is
    // the provisioning path (AC2).
    async getDueScheduledPrompt(cwd: string): Promise<ScheduledPrompt | null> {
      const { entries } = loadScheduledPrompts(cwd);
      return getFirstDuePrompt(entries);
    },
    // Scheduled-prompts persist (WL-0MSS1Q5ER007QDKX): atomic tmp+rename
    // write of the prompt's lastTriggeredAt AFTER a successful dispatch so a
    // delayed dispatch never fires more often than its frequency. Resolves
    // false on any failure (absent/malformed file, unknown id, I/O error) —
    // the dispatcher ABORTS the spawn (an unrecorded dispatch never runs)
    // and the entry stays due for the next idle slot (AC4). Never throws.
    async recordScheduledPromptTrigger(cwd: string, promptId: string, at: string): Promise<boolean> {
      return updateScheduledPromptLastTriggered(cwd, promptId, at);
    },
    async claimItem(itemId: string, expected: DowntimeClaimExpected): Promise<DowntimeClaimResult> {
      // CAS claim (RCA WL-0MSRBFFLN005W3VT design point 1): the transition
      // only applies while the item is still in the state the tier selected
      // it in — exactly one concurrent pane wins. A stale result (another
      // pane claimed first) or any other claim failure ABORTS the dispatch
      // (no pane, no marker, no success record) and is never silently
      // discarded (WL-0MSLWJ310000ND0X absorbed): the outcome reason
      // ('claim-failed' / 'wl-error') is the durable observable, and the
      // failure detail is written to stderr like claimItemForAgentCommand.
      const result = await claimWorkItem(itemId, assignee, expected);
      if (result.success) return { ok: true };
      process.stderr.write(
        `[worklog-plugin] Downtime claim failed for ${itemId}: ` +
          `${result.error ?? 'unknown error'}` +
          `${result.stale ? ' (another pane won the claim race — dispatch aborted)' : ''}\n`,
      );
      return result.stale
        ? { ok: false, reason: 'stale' }
        : { ok: false, reason: 'error' };
    },
    async spawnAgentPane(
      prompt: string,
      opts: { model: string; cwd: string; paneName?: string },
    ): Promise<DowntimeSpawnResult> {
      const kind = skillKindFromPrompt(prompt);
      return spawnDowntimePane(
        scriptPath,
        buildDowntimePaneArgs(kind, prompt, opts),
        { cwd: opts.cwd },
        spawnFn,
      );
    },
    async recordDispatch(event: DowntimeDispatchEvent): Promise<boolean> {
      // 1. Durable trail: a comment on the item itself (survives wl sync).
      // buildWlArgs() prepends the resolved --worklog-dir override so the
      // comment lands on the item in ITS project's DB, not the plugin
      // process's own cwd (WL-0MSI7DQL10016QYX). A comment failure is
      // tolerated — the comment is the durable cross-machine trail, not the
      // marker. Scheduled-prompt dispatches (noItemComment, AC4) have no
      // work item — the comment is skipped entirely (there is no item to
      // comment on).
      if (!event.noItemComment) {
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
      }
      // 2. Rolling local log (bounded JSONL under <cwd>/.worklog) — the
      // dispatched MARKER. Written BEFORE the pane spawns (RCA design point
      // 2): a write failure resolves false so the dispatcher aborts rather
      // than dispatching an unmarked item.
      try {
        await appendDowntimeLogEntry(event.cwd, JSON.stringify(event));
        return true;
      } catch {
        // fail-closed: the marker could not be written → abort the dispatch
        return false;
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
    async recordDispatchFailure(event: DowntimeDispatchFailureEvent): Promise<void> {
      // Spawn-failure trace (WL-0MSLWJ3I70031Z8U AC2): append an
      // outcome:'spawn-failed' entry with the error/exit details to the
      // rolling dispatch log, so the log distinguishes "attempted" (failed
      // spawn) from "opened" (success marker) and never claims success for
      // a pane that never appeared. Mirrors the marker's fields (itemId,
      // kind, stage) so the marker readers keep excluding the item exactly
      // as the standing marker does. Fail-closed: never crash the worker.
      try {
        await appendDowntimeLogEntry(
          event.cwd,
          JSON.stringify({ ...event, outcome: 'spawn-failed' }),
        );
      } catch {
        // fail-closed: audit logging must never crash the worker
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

  // Event subscriber (WL-0MSHB7DHO004RHBJ): subscribes to herdr window
  // events (pane focus/visibility + agent status) over the herdr socket so
  // the worklist reacts immediately instead of polling. Fail-open: an
  // unreachable socket keeps today's polling cadence (the worklist gates
  // the resume-poll and icon updates behind the events-health flag). The
  // subscriber is constructed here (once per plugin instance) and handed to
  // the worklist, which wires the event callbacks to its internal state and
  // closes it on TUI exit. Initial per-pane subscriptions are synced from
  // the tracker's shared state file when the subscription starts.
  const socketPath = resolveSocketPath();
  const eventSubscriber = socketPath
    ? new HerdrEventSubscriber({
        socketPath,
        callbacks: {},
        trackedPaneIds: agentTracker.snapshot().map((e) => e.paneId),
      })
    : null;

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
  // Downtime worker (local-LLM idle dispatch, WL-0MSF49FMW009M06K): created
  // UNCONDITIONALLY (parent WL-0MSZ4NSOE007AQEF) so the `d` shortcut can also
  // force dispatch on for one pane when the global setting is off — the
  // per-instance in-memory override gates the effective enabled state, and
  // `tick()` short-circuits (no proxy polling, no idle tracking, no dispatch)
  // while the effective state is off. Settings are re-read every tick via
  // `config()` so changes apply without a plugin restart. The dispatch panes
  // open in the resolved worklog root (--cwd).
  const targetCwd = wlRoot ?? resolvedCwd ?? process.cwd();
  const downtimeWorker: DowntimeWorker = createDowntimeWorker({
    poller: createDowntimePoller(runSettings.downtimeProxyUrl),
    deps: createDowntimeDeps(SEND_TO_PI_SCRIPT, AGENT_ASSIGNEE),
    registry: createRoundRobinRegistry({
      worklogDir: join(targetCwd, '.worklog'),
    }),
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
  });

  // Mode-switch worker: automatically switches the llama-proxy between fast
  // (cloud) and cheap (local) modes based on operator activity and proxy
  // idle state. Created with settings.downtimeProxyUrl (reuse, no new URL
  // key). Passes `enabled` via the settings flag (modeSwitchEnabled).
  const modeSwitchWorker: ModeSwitchWorker = createModeSwitchWorker();

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
      // Per-instance downtime toggle (`d` shortcut, parent WL-0MSZ4NSOE007AQEF):
      // flips the in-memory worker override; the header re-renders via the
      // worker's enabled state on the next render (internal action, no pane).
      onDowntimeToggle: () => downtimeWorker.toggle(),
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
      subscriber: eventSubscriber,
      agentTracker,
      modeSwitchWorker,
      modeSwitchPollIntervalMs: runSettings.modeSwitchPollIntervalMs,
      modeSwitchEnabled: runSettings.modeSwitchEnabled,
      onCommand: async (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>) => {
        // Agent commands (/skill:*, /intake, /plan) are routed to a new pi agent
        // pane opened to the right. Commands prefixed with `!!`/`!` (shell-executed
        // shortcuts like audit approve/reject, priority updates, close/delete) are
        // routed to a new herdr pane that runs them visibly; the wrapper keeps
        // the pane's process alive so the pane stays open for inspection — the
        // user dismisses it with Enter or herdr prefix+x (close_pane).
        // Everything else is written to stdout with the CMD: prefix for
        // the calling framework (Herdr) to execute.
        //
        // A shortcut entry with `open_pane: false` (WL-0MSJLD1I70045ZUL)
        // opts out of the visible pane entirely: the command runs in the
        // background (headless `pi -p --mode json` for agent commands,
        // `bash -c` for shell commands) with stdout/stderr captured to a
        // per-run log file whose path is logged to stderr for inspection.
        // The work-item ↔ pane association is skipped when no pane opens.
        const shouldOpenPane = openPane ?? true;
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
          // Agent-route hook: record operator activity and fire fast-switch
          // (fail-open: never blocks command dispatch). Only runs for agent
          // commands — /skill:*, /intake, /plan, /prompt:. Shell shortcuts
          // (!!/!) and plain commands do NOT count as operator activity
          // (AC2). The worker's onOperatorCommand updates the idle clock
          // and POSTs mode=fast (when not already fast) fire-and-forget.
          modeSwitchWorker.onOperatorCommand(runSettings.downtimeProxyUrl);
          // Claim the referenced work-item BEFORE dispatching so it appears
          // in_progress immediately — for both the pane and the headless
          // (no-pane) path. Non-blocking: failures are logged to stderr and
          // never prevent the dispatch (AC2).
          try {
            await claimItemForAgentCommand(command);
          } catch {
            // Belt-and-suspenders: a claim failure must never block the pane.
          }
          if (!shouldOpenPane) {
            // Background (no-pane) agent dispatch: run pi headless with the
            // entry's model, output captured to a per-run log file. No pane
            // is created, so the work-item ↔ pane association
            // (WL-0MSBQUJQX005RAT9) is skipped entirely.
            const prompt = stripAgentPromptPrefix(command);
            const logPath = buildBackgroundLogPath(command);
            process.stderr.write(
              `[worklog-plugin] Background dispatch (no pane): ${command}\n` +
                `[worklog-plugin] Log file: ${logPath}\n`,
            );
            spawnBackgroundPi(
              prompt,
              targetCwd,
              model,
              logPath,
              { onExit: () => onRefresh?.() },
            );
            return;
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
          // command visibly in a new herdr pane via run-in-pane.sh. The pane
          // opens WITHOUT stealing focus from the selection list (--no-focus,
          // WL-0MSHIA53D009DJOT) so the user can keep browsing/dispatching;
          // command-send feedback is surfaced via toast notifications.
          // With `open_pane: false` the command instead runs detached in the
          // background with output captured to a log file (no pane).
          const clean = stripCommandPrefix(command);
          if (!shouldOpenPane) {
            const logPath = buildBackgroundLogPath(command);
            process.stderr.write(
              `[worklog-plugin] Background dispatch (no pane): ${command}\n` +
                `[worklog-plugin] Log file: ${logPath}\n`,
            );
            spawnBackgroundShell(
              clean,
              targetCwd,
              logPath,
              { onExit: () => onRefresh?.() },
            );
            return;
          }
          const child = spawn(
            RUN_IN_PANE_SCRIPT,
            buildRunInPaneArgs(clean, targetCwd),
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
          // CMD: protocol is not a reliable execution path). Like the pane
          // route, the command-output pane opens without stealing focus
          // (--no-focus, WL-0MSHIA53D009DJOT). With `open_pane: false` the
          // command runs detached in the background with a log file instead.
          if (!shouldOpenPane) {
            const logPath = buildBackgroundLogPath(command);
            process.stderr.write(
              `[worklog-plugin] Background dispatch (no pane): ${command}\n` +
                `[worklog-plugin] Log file: ${logPath}\n`,
            );
            spawnBackgroundShell(
              command,
              targetCwd,
              logPath,
              { onExit: () => onRefresh?.() },
            );
            return;
          }
          const child = spawn(
            RUN_IN_PANE_SCRIPT,
            buildRunInPaneArgs(command, targetCwd),
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
