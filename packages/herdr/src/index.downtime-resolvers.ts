/**
 * packages/herdr/src/index.downtime-resolvers.ts — default herdr-backed
 * liveness, stalled-pane and pane-close seams for the downtime worker.
 *
 * Extracted verbatim from `packages/herdr/src/index.ts` (move-only,
 * WL-0MVOA0U84003EXVK, parent WL-0MVGKGFFN009UCM6): the running-pane
 * liveness resolver, the stalled-work resume seams (prompt/start), the
 * machine-wide pane lister, the pi-session-log → worklog-root decoder, the
 * stalled-pane root resolver and the closed-pane log reader. Function
 * bodies, JSDoc and provenance comments are unchanged.
 *
 * Barrel surface (AC2): `defaultStalledPaneRootResolver`,
 * `defaultStalledPanesLister` and `worklogRootFromPiSessionPath` are
 * re-exported by the barrel (consumed by `index.test.ts`).
 * `defaultRunningDowntimePanesResolver`, `defaultStalledResumePromptAgent`
 * and `defaultStalledResumeStartAgent` stay out of the barrel's public
 * surface — `createDowntimeDeps` and the pane-close reaper value-import them
 * (and `readClosedPaneIds`) as internal defaults from this module, while
 * `herdrAgentErrorText` is private here. Imports are concrete siblings only
 * (`./downtime-worker.js`, `./stalled-work.js`, `./downtime-log.js`,
 * `./fetcher.js`, `@worklog/shared/worklog-paths`); no barrel value
 * imports, no new cycles. Signatures and exported names must not change —
 * behaviour-preservation gate for the unchanged `index.test.ts` suite.
 */

import { resolveWorklogRoot } from '@worklog/shared/worklog-paths';
import { getExecFileAsync } from './fetcher.js';
import {
  countRunningDowntimePanes,
  DOWNTIME_WL_TIMEOUT_MS,
  parseHerdrPaneListOutput,
  type HerdrPaneRecord,
  type RunningPanesResult,
} from './downtime-worker.js';
import { readDowntimeLogEntries } from './downtime-log.js';
import {
  buildStalledResumeStartArgs,
  classifyHerdrAgentFailure,
  type StalledResumeCliResult,
  type StalledResumeStartOptions,
} from './stalled-work.js';

/**
 * Default running-downtime-panes liveness resolver (AC1/AC3, parent
 * WL-0MTYZXSLN008HZOW): counts live dispatched downtime panes from
 * `herdr pane list` — the machine-wide pane inventory — so the running-pane
 * bound holds across roots and leader/instance restarts. A pane counts as a
 * running downtime pane when its label starts with `Downtime` (set by
 * send-to-pi.sh via `herdr pane rename`) and it hosts a live pi agent
 * (status not `done`/`exited`).
 *
 * Fail-closed: any herdr failure (missing binary, timeout, unparseable
 * output) resolves `{ok:false}`, which the worker treats as the bound being
 * reached (no dispatch) rather than over-dispatching on unknown state.
 */
export async function defaultRunningDowntimePanesResolver(
  _cwd: string,
): Promise<RunningPanesResult> {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
    const { stdout } = await getExecFileAsync()(
      herdrBin,
      ['pane', 'list'],
      { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    const panes = parseHerdrPaneListOutput(stdout);
    if (panes === null) return { ok: false, error: 'herdr pane list parse failure' };
    const paneIds = countRunningDowntimePanes(panes);
    // `records` carries the full parsed pane set so the item-scoped in-flight
    // guard (WL-0MUBEZ6PE002WLP4 / F3) can resolve label suffixes without a
    // second `herdr pane list` call. `count`/`paneIds` keep their existing
    // meaning (owner-lease qualifier ONLY, never a dispatch limit).
    return { ok: true, count: paneIds.length, paneIds, records: panes };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Extract the human-readable failure text from a herdr `execFile` error so
 * {@link classifyHerdrAgentFailure} can map it to a neutral resume reason.
 * Prefers stderr/stdout (where herdr writes its machine-readable codes) over
 * the generic Error message.
 */
function herdrAgentErrorText(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const parts: string[] = [];
    if (typeof e.stderr === 'string' && e.stderr !== '') parts.push(e.stderr);
    if (typeof e.stdout === 'string' && e.stdout !== '') parts.push(e.stdout);
    if (typeof e.message === 'string' && e.message !== '') parts.push(e.message);
    if (parts.length > 0) return parts.join(' ');
  }
  return String(err);
}

/**
 * Default `herdr agent prompt` seam for the stalled-work resume orchestrator
 * (WL-0MUYMBPZ5004LBFX): submit a prompt to a LIVE agent
 * (`herdr agent prompt <paneId> <text>`). Rejects when the agent is blocked
 * (`agent_blocked`) and returns `agent_prompt_stalled` when an accepted
 * submission never reaches `working`/`blocked`. Both map to a NEUTRAL resume
 * failure reason (never a strike). Fail-safe: any herdr failure resolves
 * `{ok:false, reason}` rather than throwing.
 */
export async function defaultStalledResumePromptAgent(
  paneId: string,
  text: string,
): Promise<StalledResumeCliResult> {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
    await getExecFileAsync()(herdrBin, ['agent', 'prompt', paneId, text], {
      encoding: 'utf8',
      timeout: DOWNTIME_WL_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    const raw = herdrAgentErrorText(err);
    return { ok: false, reason: classifyHerdrAgentFailure(raw), error: raw };
  }
}

/**
 * Default `herdr agent start` seam for the stalled-work resume orchestrator
 * (WL-0MUYMBPZ5004LBFX): relaunch pi in an EXISTING pane whose agent has
 * exited, continuing the item's session
 * (`herdr agent start pi --kind pi --pane <paneId> -- --session <path>` or
 * `-- --continue`). Fail-safe: any herdr failure resolves `{ok:false, reason}`
 * (a vanished pane is mapped to `pane-vanished`) rather than throwing.
 */
export async function defaultStalledResumeStartAgent(
  paneId: string,
  opts: StalledResumeStartOptions,
): Promise<StalledResumeCliResult> {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
    await getExecFileAsync()(herdrBin, buildStalledResumeStartArgs(paneId, opts), {
      encoding: 'utf8',
      timeout: DOWNTIME_WL_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    const raw = herdrAgentErrorText(err);
    return { ok: false, reason: classifyHerdrAgentFailure(raw), error: raw };
  }
}

/**
 * Default machine-wide pane lister for the stalled-work scan
 * (WL-0MUYMBSA90092QV2): one `herdr pane list` read shared by the scan. Returns
 * `null` on any herdr failure (missing binary, timeout, unparseable output) so
 * the scan degrades to "no stalled resume" rather than crashing dispatch.
 */
export async function defaultStalledPanesLister(): Promise<HerdrPaneRecord[] | null> {
  try {
    const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
    const { stdout } = await getExecFileAsync()(herdrBin, ['pane', 'list'], {
      encoding: 'utf8',
      timeout: DOWNTIME_WL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseHerdrPaneListOutput(stdout);
  } catch {
    return null; // fail-safe: unreadable pane list → no stalled resume
  }
}

/**
 * Best-effort decode of a pi session-log path back to its working directory.
 *
 * pi encodes the cwd into the session directory name by replacing path
 * separators with `-` and wrapping the result in `--…--` (e.g.
 * `--home-user-projects-app--`). The encoding is lossy for directories whose
 * names contain a literal hyphen, so the decoded path is only a HINT: the
 * caller runs it through `resolveWorklogRoot()`, which walks up to the nearest
 * valid `.worklog/` and returns `undefined` when the hint does not land in a
 * worklog tree. This keeps a wrong decode harmless (the pane is skipped).
 */
export function worklogRootFromPiSessionPath(sessionPath: string): string | undefined {
  if (typeof sessionPath !== 'string' || sessionPath === '') return undefined;
  // Drop the `.jsonl` filename, then take the `--<enc>--` session directory.
  const withoutFile = sessionPath.replace(/[\\/][^\\/]*$/, '');
  const encoded = withoutFile.replace(/^.*[\\/]/, '');
  if (!encoded.startsWith('--') || !encoded.endsWith('--')) return undefined;
  const body = encoded.slice(2, -2);
  if (body === '') return undefined;
  // Leading separator: the body starts with the path without a leading slash
  // (`home-user-…`); re-add `/` and replace the remaining separators.
  const decoded = '/' + body.split('-').join('/');
  return resolveWorklogRoot(decoded);
}

/**
 * Default worklog-root resolver for the stalled-work scan
 * (WL-0MUYMBSA90092QV2 AC5): prefer the pane's reported `cwd` (the pane's
 * working directory), then fall back to the pi session-log path in
 * `agent_session`. Returns `null` when neither resolves to a valid worklog
 * root — the scan then fails closed (skips the pane) rather than resuming
 * against the leader's root.
 */
export function defaultStalledPaneRootResolver(
  pane: HerdrPaneRecord,
  _fallbackCwd: string,
): string | null {
  if (typeof pane.cwd === 'string' && pane.cwd !== '') {
    const fromCwd = resolveWorklogRoot(pane.cwd);
    if (fromCwd) return fromCwd;
  }
  const sessionPath = pane.agentSession?.value;
  if (typeof sessionPath === 'string' && sessionPath !== '') {
    const fromSession = worklogRootFromPiSessionPath(sessionPath);
    if (fromSession) return fromSession;
  }
  return null;
}

/**
 * Collect the pane ids already handled by the dispatch monitor
 * (WL-0MU308WSF0002JWN) from the rolling dispatch log. Used to keep the
 * scheduled pane-close reaper from double-handling a pane the monitor has
 * already processed (parent constraint). Fail-safe: an unreadable log
 * yields an empty set.
 */
export async function readClosedPaneIds(cwd: string): Promise<Set<string>> {
  try {
    const entries = await readDowntimeLogEntries(cwd);
    const ids = new Set<string>();
    for (const entry of entries) {
      if (
        entry.entryType === 'pane-close' &&
        typeof entry.paneId === 'string' &&
        entry.paneId !== ''
      ) {
        ids.add(entry.paneId);
      }
    }
    return ids;
  } catch {
    return new Set<string>();
  }
}
