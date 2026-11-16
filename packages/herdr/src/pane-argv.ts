/**
 * packages/herdr/src/pane-argv.ts — canonical pane-spawn argv builders
 * (WL-0MWHWGZI4007D911)
 *
 * Map pointer: the single pane-creation architecture map + naming contract
 * lives in `docs/dev/downtime-dispatcher.md` → *Pane creation architecture*.
 *
 * ONE canonical argument-vector builder per pane-spawn script — 
 * `send-to-pi.sh` (agent panes) and `run-in-pane.sh` (shell-output panes),
 * plus the downtime dispatcher's `send-to-pi.sh` invocation — mirroring the
 * `pane-title.ts` unified pattern, so a new pane flag (e.g.
 * `--local-preference`, `--reservation-ticket`, `--request-priority`) is
 * added ONCE here and applies to every spawn path.
 *
 * The three pre-refactor builders — `buildDowntimePaneArgs`
 * (`downtime-worker.pane.ts`), `buildSendToPiArgs` and `buildRunInPaneArgs`
 * (`index.commands.ts`) — are thin compatibility wrappers over this module
 * (or direct re-exports): they keep their public signatures and do no option
 * assembly of their own. The pinned spread-arg characterisation suite
 * (`dispatched-pane-spawn.pin.test.ts`, WL-0MWHWGN23001KMQW) keeps the
 * byte-exact behaviour frozen through those public surfaces.
 *
 * ── Pivot table: the deliberate flag-vocabulary divergences ──────────────
 * (decided by pin item WL-0MWHWGN23001KMQW AC3; enforced by its AC3 tests —
 * each builder below may only emit its own column of the table)
 *
 * | Flag | buildDowntimePaneArgs | buildSendToPiArgs | buildRunInPaneArgs |
 * | --- | --- | --- | --- |
 * | focus | always `--no-focus` — no opt-in (unattended background dispatch is invisible) | `--focus` when `focus:true`, else `--no-focus` | `--focus` when `focus:true`, else `--no-focus` |
 * | `--cwd` | after the optional flags, before `--model` | immediately after the focus flag | immediately after the focus flag |
 * | `--pane-name` | yes; defaults to `buildDowntimePaneTitle(...)` | yes, optional (script default "Pi Agent") | yes, optional (script default "Command Output") |
 * | `--model` | yes — always (`opts.model` is required for downtime dispatch) | yes, optional | **no** — shell panes have no model |
 * | `--anchor` | yes | yes | yes |
 * | `--pane-id-file` | **no** — downtime never captures the work-item↔pane association | yes — agent commands carrying an item id | yes — split-confirmation channel |
 * | `--request-priority` | **no** — downtime conveys priority via env only | yes — placed before the final command | **no** |
 * | `--reservation-ticket` | yes — local-reservation fail-open contract (C2) | **no** | **no** |
 * | `--local-preference` | yes — per-turn locality fail-open contract (C4) | **no** | **no** |
 * | terminal token | prompt | prompt | command |
 *
 * Why: downtime dispatch is unattended background work — it never steals
 * focus, never captures a pane id file, and carries its priority through the
 * spawn env; the reservation ticket and locality preference are
 * downtime-only contracts. `send-to-pi.sh` panes are interactive agent
 * sessions — they take the full interactive flag set (`--model`,
 * `--pane-id-file`, `--request-priority`, focus opt-in) but never a local
 * reservation. `run-in-pane.sh` panes run shell output — no model, no
 * request priority, no reservation; `--pane-id-file` is their split
 * confirmation channel only.
 *
 * Option ORDER is part of the pinned contract: every builder below assembles
 * its flags in exactly the order the pin suite asserts (`toEqual`), so the
 * output is byte-identical to the pre-refactor builders. Option order
 * therefore deliberately differs between scripts where the pinned contract
 * says it does (e.g. downtime places `--cwd` between the optionals and
 * `--model`; the interactive builders place it directly after the focus
 * flag).
 */

import type { DowntimeSkillKind } from './downtime-worker.types.js';
import type { LocalPreference } from './local-preference.js';
import { buildDowntimePaneTitle, stripAgentPromptPrefix } from './pane-title.js';
import type { RequestPriority } from './request-priority.js';

/**
 * Optional flags for a `send-to-pi.sh` agent-pane spawn.
 *
 * Every member is optional; an absent member simply omits the corresponding
 * flag (byte-identical to the pre-refactor `buildSendToPiArgs` with the
 * argument left undefined).
 */
export interface SendToPiArgsOptions {
  /** Pi model pattern, forwarded as `--model <pattern>` (WL-0MSD48ZFC0043AO3). */
  model?: string;
  /**
   * Pane-id file forwarded as `--pane-id-file <path>` so the script writes
   * the new pane id immediately after the split succeeds (WL-0MSBQUJQX005RAT9).
   */
  paneIdFile?: string;
  /** Descriptive pane title forwarded as `--pane-name` (WL-0MSJ4E8UA005KG9Y). */
  paneName?: string;
  /**
   * Focus control (WL-0MT70LC6B009TL3Q): `true` passes `--focus` so the
   * script zooms the new pane; `false`/absent passes `--no-focus` so the
   * selection list keeps focus (the default for most shortcuts).
   */
  focus?: boolean;
  /**
   * Interactive item-ID tab placement (WL-0MUYI3JAO002BTNL): a non-empty
   * pane id is forwarded as `--anchor <id>` so the new pane splits off that
   * pane; absent/empty omits the flag (legacy current-pane split).
   */
  anchor?: string;
  /**
   * Request priority (WL-0MVE1NZ4J000H5NH AC2), forwarded as
   * `--request-priority <low|medium|high>`. Absent omits the flag.
   */
  requestPriority?: RequestPriority;
}

/**
 * Canonical `send-to-pi.sh` argument builder (agent-pane spawn).
 *
 * The resolved project root is passed via `--cwd`. Free-form `/prompt:`
 * commands have their routing prefix stripped here so pi receives only the
 * prompt text. The prompt is always the FINAL argv token — the script treats
 * everything after its options as the command.
 *
 * @param command - The agent command (e.g. `/skill:implement <id>`).
 * @param targetCwd - Resolved project root for the new pane.
 * @param opts - Optional flags (see {@link SendToPiArgsOptions}).
 */
export function buildSendToPiArgs(
  command: string,
  targetCwd: string,
  opts: SendToPiArgsOptions = {},
): string[] {
  const agentPrompt = stripAgentPromptPrefix(command);
  const args = [opts.focus ? '--focus' : '--no-focus', '--cwd', targetCwd];
  if (opts.paneName) {
    args.push('--pane-name', opts.paneName);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.paneIdFile) {
    args.push('--pane-id-file', opts.paneIdFile);
  }
  if (opts.anchor) {
    args.push('--anchor', opts.anchor);
  }
  // Request priority: placed before the command, which must stay the final
  // argv token (send-to-pi.sh treats everything after its options as the
  // command).
  if (opts.requestPriority) {
    args.push('--request-priority', opts.requestPriority);
  }
  args.push(agentPrompt);
  return args;
}

/**
 * Optional flags for a `run-in-pane.sh` shell-output pane spawn.
 */
export interface RunInPaneArgsOptions {
  /**
   * Pane title forwarded as `--pane-name`, replacing the script's default
   * "Command Output" (WL-0MSJ4E8UA005KG9Y).
   */
  paneName?: string;
  /**
   * Focus control (WL-0MT70LC6B009TL3Q): `true` passes `--focus`; `false`/
   * absent passes `--no-focus` (the default — the selection list keeps focus).
   */
  focus?: boolean;
  /**
   * Interactive item-ID tab placement (WL-0MUYI3JAO002BTNL): a non-empty
   * pane id is forwarded as `--anchor <id>`; absent/empty omits the flag.
   */
  anchor?: string;
  /**
   * Split-confirmation channel (WL-0MUYI3K8H007MPKF): forwarded as
   * `--pane-id-file <path>` so run-in-pane.sh writes the new pane id; absent
   * omits the flag.
   */
  paneIdFile?: string;
}

/**
 * Canonical `run-in-pane.sh` argument builder (shell-output pane).
 *
 * `run-in-pane.sh` parses its options at the head of argv; everything else
 * is the command itself, so the command is always the FINAL argv token.
 * Mirrors {@link buildSendToPiArgs}: `--no-focus` is the default so opening
 * the command-output pane does not steal focus from the selection list
 * (WL-0MSHIA53D009DJOT).
 *
 * @param command - The shell command to run in the new pane.
 * @param targetCwd - Resolved project root for the new pane.
 * @param opts - Optional flags (see {@link RunInPaneArgsOptions}).
 */
export function buildRunInPaneArgs(
  command: string,
  targetCwd: string,
  opts: RunInPaneArgsOptions = {},
): string[] {
  const args = [opts.focus ? '--focus' : '--no-focus', '--cwd', targetCwd];
  if (opts.paneName) {
    args.push('--pane-name', opts.paneName);
  }
  if (opts.anchor) {
    args.push('--anchor', opts.anchor);
  }
  if (opts.paneIdFile) {
    args.push('--pane-id-file', opts.paneIdFile);
  }
  args.push(command);
  return args;
}

/**
 * Optional flags for the downtime dispatcher's `send-to-pi.sh` spawn.
 */
export interface DowntimePaneArgsOptions {
  /** Downtime model — always required (the dispatch pane opens with it). */
  model: string;
  /** Worklog root for the new pane, forwarded as `--cwd`. */
  cwd: string;
  /**
   * Pane-name override. Absent → the kind-derived default via
   * {@link buildDowntimePaneTitle} (`Downtime <kind>` or the full
   * `Downtime triggered <kind> <title> - <id>` format).
   */
  paneName?: string;
  /** Work-item title for the full-format pane name (WL-0MSJ4E8UA005KG9Y). */
  itemTitle?: string;
  /** Work-item id suffix for the full-format pane name. */
  itemId?: string;
  /**
   * Resolved Dispatcher anchor pane id (WL-0MTR2CD4X006XI7U), forwarded as
   * `--anchor <id>` so send-to-pi.sh splits from that pane. Absent → legacy
   * `pane current` behaviour.
   */
  anchorId?: string;
  /**
   * Granted local-reservation ticket id (WL-0MVIKRFP0005JDL8 AC1, slice C2),
   * forwarded as `--reservation-ticket <id>`. Absent on a fail-open dispatch
   * — the launch args stay byte-identical to today.
   */
  reservationTicketId?: string;
  /**
   * Per-turn locality preference (WL-0MVIKRFP0005JDL8 AC4, slice C4),
   * forwarded as `--local-preference <local-preferred|remote-ok>`. Absent
   * leaves the launch args byte-identical (fail-open C4-AC3).
   */
  localPreference?: LocalPreference;
}

/**
 * Canonical downtime `send-to-pi.sh` argument builder.
 *
 * Visible-pane dispatches: `--pane-name <name>` (default built from kind and
 * optional item context), `--no-focus` (visible but never steals focus),
 * optional `--anchor` / `--reservation-ticket` / `--local-preference`,
 * then `--cwd <wlRoot>`, `--model <downtimeModel>` and the prompt as the
 * final token.
 *
 * @param kind - Downtime skill kind (`plan` | `intake` | `audit` |
 *   `implement` | `risk-effort`), used for the default pane name.
 * @param prompt - The prompt the dispatched pane receives.
 * @param opts - Model/cwd are required; the rest are optional flags.
 */
export function buildDowntimePaneArgs(
  kind: DowntimeSkillKind,
  prompt: string,
  opts: DowntimePaneArgsOptions,
): string[] {
  const paneName =
    opts.paneName ??
    buildDowntimePaneTitle(kind, opts.itemTitle, opts.itemId);
  const args = ['--pane-name', paneName, '--no-focus'];
  // Dispatcher anchor (C0 WL-0MTR01EU7005SYZG): when the caller resolved the
  // dedicated Dispatcher anchor pane id (F1 WL-0MTR2CD4X006XI7U), forward it
  // as `--anchor <id>` so send-to-pi.sh splits from THAT pane instead of the
  // leader's current pane. Absent → legacy `pane current` behavior.
  if (opts.anchorId) {
    args.push('--anchor', opts.anchorId);
  }
  // Local reservation ticket (slice C2 AC1): the pane's first request must
  // carry `X-Local-Reservation`, so the id is forwarded explicitly (an env
  // var set on the launching script does NOT reach the herdr pane process).
  if (opts.reservationTicketId) {
    args.push('--reservation-ticket', opts.reservationTicketId);
  }
  // Per-turn locality preference (slice C4 AC1): forwarded explicitly for the
  // same reason as the reservation ticket — an env var set on the launching
  // script does NOT reach the herdr pane process.
  if (opts.localPreference) {
    args.push('--local-preference', opts.localPreference);
  }
  args.push('--cwd', opts.cwd, '--model', opts.model, prompt);
  return args;
}
