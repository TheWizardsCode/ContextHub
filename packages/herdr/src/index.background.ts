/**
 * packages/herdr/src/index.background.ts — background (no-pane) dispatch
 * for the Herdr Worklog plugin.
 *
 * Runs the `open_pane: false` execution channel for shortcut commands:
 * `spawnBackgroundShell` (`!!`/`!` shell commands) and `spawnBackgroundPi`
 * (agent commands `/skill:*`, `/intake`, `/plan`, `/prompt:`) spawn detached
 * children with output redirected to a per-run log file under
 * `BACKGROUND_LOG_DIR`; `formatBackgroundFailure` builds the operator toast
 * when a background run exits non-zero. Extracted verbatim from
 * `packages/herdr/src/index.ts` (move-only, WL-0MVOA0K6T009KTN1, parent
 * WL-0MVGKGFFN009UCM6); the barrel re-exports the consumed symbols.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { dirname, join } from 'path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { showToast } from './notify.js';
import {
  INTERACTIVE_DEFAULT_REQUEST_PRIORITY,
  REQUEST_PRIORITY_ENV_VAR,
  type RequestPriority,
} from './request-priority.js';
import {
  BACKGROUND_LOCAL_PREFERENCE,
  LOCAL_PREFERENCE_ENV_VAR,
  type LocalPreference,
} from './local-preference.js';

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
 * Build the operator-facing toast content for a background (`open_pane: false`)
 * dispatch that exited non-zero. Returns null for a clean (exit 0) run. Pure so
 * it can be unit-tested without spawning a process (WL-0MUEBQLRD00288VV AC4).
 *
 * @param command - the dispatched command (shown so the operator knows what failed)
 * @param code - process exit code (null when terminated by a signal)
 * @param signal - termination signal (null when exited normally)
 * @param logPath - the per-run log file holding the full output
 * @param excerpt - optional short excerpt of the command's output (e.g. stderr tail)
 */
export function formatBackgroundFailure(
  command: string,
  code: number | null,
  signal: string | null,
  logPath: string,
  excerpt?: string | null,
): { title: string; body: string } | null {
  if (code === 0) return null;
  const reason =
    code !== null ? `exit ${code}` : signal ? `signal ${signal}` : 'unknown failure';
  const short = (excerpt ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  return {
    title: 'Background command failed',
    body: short
      ? `${command} (${reason}) — ${short}`
      : `${command} (${reason}) — see ${logPath}`,
  };
}

/**
 * Read a short tail of a background log file for inclusion in a failure toast
 * (never throws; returns null when the file is unreadable).
 */
function readBackgroundLogExcerpt(logPath: string, maxChars = 400): string | null {
  try {
    if (!existsSync(logPath)) return null;
    return readFileSync(logPath, 'utf8').slice(-maxChars);
  } catch {
    return null;
  }
}

/**
 * Surface a non-zero background dispatch exit as a Herdr toast so failures are
 * not visible only in a log file (WL-0MUEBQLRD00288VV AC4).
 */
function notifyBackgroundFailure(
  command: string,
  code: number | null,
  signal: string | null,
  logPath: string,
): void {
  const failure = formatBackgroundFailure(command, code, signal, logPath, readBackgroundLogExcerpt(logPath));
  if (failure) showToast(failure.title, { body: failure.body });
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
  /**
   * Already-mapped request priority for the dispatched item
   * (WL-0MVE1NZ4J000H5NH AC2). Defaults to the interactive default (`high`)
   * when omitted.
   */
  requestPriority?: RequestPriority;
  /**
   * Per-turn locality preference for background (no-pane) work
   * (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4). Defaults to
   * `remote-ok` — unattended background work must never queue local capacity
   * the operator may need for interactive work.
   */
  localPreference?: LocalPreference;
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
    env: {
      ...process.env,
      HERDR_RESOLVED_CWD: targetCwd,
      [REQUEST_PRIORITY_ENV_VAR]:
        deps.requestPriority ?? INTERACTIVE_DEFAULT_REQUEST_PRIORITY,
      // Per-turn locality preference (C4-AC1): background work defaults to
      // `remote-ok` so it never waits on contended local capacity. The
      // Worklog pi extension turns this into `X-Local-Preference`.
      [LOCAL_PREFERENCE_ENV_VAR]: deps.localPreference ?? BACKGROUND_LOCAL_PREFERENCE,
    },
  });
  child.unref(); // Allow the parent to exit independently

  // On exit, fire the refresh callback (fire-and-forget — never blocks).
  if (deps.onExit) {
    child.on('exit', deps.onExit);
  }

  return child;
}

// Exported for the barrel-internal dispatch path (index.ts TUI main());
// never re-exported by the barrel — stays out of the consumed public surface.
export { notifyBackgroundFailure };
