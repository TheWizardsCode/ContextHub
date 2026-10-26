/**
 * packages/herdr/src/index.commands.ts — command routing, routing-prefix
 * stripping and pane-argument builders for the Herdr Worklog plugin.
 *
 * Classifies a resolved shortcut command into its execution channel
 * (`routeCommand`), strips the `!!`/`!` and `/prompt:` routing prefixes
 * (`stripCommandPrefix` / `stripAgentPromptPrefix`), builds the argv vectors
 * for `send-to-pi.sh` (agent pane) and `run-in-pane.sh` (shell-output pane),
 * and parses the pane-id file both scripts write after a split. Extracted
 * verbatim from `packages/herdr/src/index.ts` (move-only, WL-0MVOA0HYY005RG06,
 * parent WL-0MVGKGFFN009UCM6); the barrel re-exports these symbols.
 */

import { isAgentCommand, stripAgentPromptPrefix } from './pane-title.js';
import type { RequestPriority } from './request-priority.js';

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
export { stripAgentPromptPrefix };

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
 * When `paneName` is provided, it is forwarded via `--pane-name` so the new
 * pane gets a descriptive title (WL-0MSJ4E8UA005KG9Y). Without the flag the
 * script falls back to its default "Pi Agent".
 *
 * Focus control (WL-0MT70LC6B009TL3Q): when `focus` is `true`, `--focus`
 * is passed so send-to-pi.sh zooms the new pane. When `focus` is `false`
 * or `undefined`, `--no-focus` is passed so the selection list keeps focus
 * (the default for most shortcuts). The shared script's own default
 * (focus=true) is unchanged for its other consumers.
 *
 * Interactive item-ID tab placement (WL-0MUYI3JAO002BTNL, parent
 * WL-0MUKZGEQ2007FECS): when `anchor` is a non-empty pane id, `--anchor
 * <paneId>` is forwarded so send-to-pi.sh splits that pane instead of the
 * current pane, placing the new pi pane in the work-item-ID tab. An
 * absent/empty anchor omits the flag, keeping the legacy current-pane split
 * (no-ID commands and the fail-open fallback, AC4/AC5).
 *
 * Request priority (WL-0MVE1NZ4J000H5NH AC2): when `requestPriority` is
 * supplied, `--request-priority <low|medium|high>` is forwarded so
 * send-to-pi.sh injects `HERDR_REQUEST_PRIORITY` into the pane process'
 * environment. An absent value omits the flag (backward compatible — the
 * Worklog pi extension then leaves the request headers untouched).
 */
export function buildSendToPiArgs(
  command: string,
  targetCwd: string,
  model?: string,
  paneIdFile?: string,
  paneName?: string,
  focus?: boolean,
  anchor?: string,
  requestPriority?: RequestPriority,
): string[] {
  const agentPrompt = stripAgentPromptPrefix(command);
  const args = [focus ? '--focus' : '--no-focus', '--cwd', targetCwd];
  if (paneName) {
    args.push('--pane-name', paneName);
  }
  if (model) {
    args.push('--model', model);
  }
  if (paneIdFile) {
    args.push('--pane-id-file', paneIdFile);
  }
  if (anchor) {
    args.push('--anchor', anchor);
  }
  // Request priority: placed before the command, which must stay the final
  // argv token (send-to-pi.sh treats everything after its options as the
  // command).
  if (requestPriority) {
    args.push('--request-priority', requestPriority);
  }
  args.push(agentPrompt);
  return args;
}

/**
 * Build the argument vector for spawning `scripts/run-in-pane.sh` for a
 * command-output pane (`!!`/`!`-prefixed pane route and plain shell stdout
 * route). Mirrors `buildSendToPiArgs`: `--no-focus` (WL-0MSHIA53D009DJOT) is
 * passed by default so opening the command-output pane does not steal focus
 * from the selection list, followed by `--cwd <targetCwd>` so the pane starts
 * in the resolved project root. `run-in-pane.sh` parses all three options at
 * the head of argv; everything else is the command itself.
 *
 * Focus control (WL-0MT70LC6B009TL3Q): when `focus` is `true`, `--focus`
 * is passed so run-in-pane.sh zooms the new pane. When `focus` is `false`
 * or `undefined`, `--no-focus` is passed (the default for most shortcuts).
 *
 * When `paneName` is provided, `--pane-name <paneName>` replaces the
 * script's default "Command Output" (WL-0MSJ4E8UA005KG9Y).
 *
 * Interactive item-ID tab placement (WL-0MUYI3JAO002BTNL, parent
 * WL-0MUKZGEQ2007FECS): when `anchor` is a non-empty pane id, `--anchor
 * <paneId>` is forwarded so run-in-pane.sh splits that pane instead of the
 * current one, placing the command-output pane in the work-item-ID tab. An
 * absent/empty anchor omits the flag, keeping the legacy current-pane split
 * (no-ID commands and the fail-open fallback, AC4/AC5).
 *
 * When `paneIdFile` is provided, `--pane-id-file <path>` is forwarded so
 * run-in-pane.sh writes the new pane id immediately after the split succeeds
 * (mirroring send-to-pi.sh). The interactive dispatch path uses this as a
 * split-confirmation channel to gate the fail-safe placeholder root-pane
 * cleanup (WL-0MUYI3K8H007MPKF, AC7). An absent value omits the flag.
 */
export function buildRunInPaneArgs(
  command: string,
  targetCwd: string,
  paneName?: string,
  focus?: boolean,
  anchor?: string,
  paneIdFile?: string,
): string[] {
  const args = [focus ? '--focus' : '--no-focus', '--cwd', targetCwd];
  if (paneName) {
    args.push('--pane-name', paneName);
  }
  if (anchor) {
    args.push('--anchor', anchor);
  }
  if (paneIdFile) {
    args.push('--pane-id-file', paneIdFile);
  }
  args.push(command);
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
