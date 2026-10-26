/**
 * packages/herdr/src/downtime-worker.pane.ts — Herdr pane identity, in-flight
 * resolution, spawn invocation and the pane-lifecycle monitor.
 *
 * Single responsibility: everything the downtime dispatcher knows about Herdr
 * panes — the downtime label prefix and record parsing, the safe-close and
 * item-scoped in-flight predicates, the `send-to-pi.sh` invocation (pane args,
 * spawn options/env) and the dispatched-pane lifecycle monitor.
 *
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * child WL-0MVLIHZBT006B1UI). No behaviour change: the pane label prefix,
 * spawn flags (`--pane-name`, `--no-focus`, `--cwd`, `--model`, `--anchor`,
 * `--reservation-ticket`, `--local-preference`), the detached/unref'd spawn
 * semantics, the `AUDIT_PHASE2_PARALLELISM=1` audit fan-out bound and the
 * pane-close safety rules are all unchanged. Every work-item provenance
 * comment below travels with the code it documents.
 *
 * Layering: this module imports only concrete siblings (constants, types,
 * `downtime-log`, `pane-lifecycle`, `pane-close-herdr`, `pane-title`,
 * `request-priority`, `local-preference`), never `./downtime-worker.js` — the
 * barrel re-exports it, so an edge back would invert the layering. It also
 * performs no value import of `./stalled-work.js` (the pre-existing
 * `stalled-work ↔ downtime-worker` cycle stays type-only), so no runtime cycle
 * can form.
 */

import { spawn } from 'node:child_process';
import { LOCAL_RESERVATION_TICKET_ENV } from './downtime-worker.constants.js';
import type {
  DowntimeSkillKind,
  HerdrPaneRecord,
  InFlightPanes,
  RunningPanesResult,
} from './downtime-worker.types.js';
import {
  appendPaneCloseLogEntry,
  readDowntimeLogEntries,
  type PaneCloseLogEntry,
  type PaneLifecycleKind,
} from './downtime-log.js';
import { LOCAL_PREFERENCE_ENV_VAR, type LocalPreference } from './local-preference.js';
import { parseHerdrPaneCloseList } from './pane-close-herdr.js';
import { buildDowntimePaneTitle } from './pane-title.js';
import {
  classifyPaneLifecycle,
  collectDispatchedPanes,
  loggedPaneLifecycleKeys,
  paneLifecycleKey,
  type PaneItemState,
} from './pane-lifecycle.js';
import {
  REQUEST_PRIORITY_ENV_VAR,
  mapDowntimeRequestPriority,
} from './request-priority.js';

/**
 * The pane-facing slice of `DowntimeWorkerDeps` — the only dependency
 * boundaries the helpers below touch, named structurally so this module never
 * imports the barrel (`DowntimeWorkerDeps` lives in `downtime-worker.ts`).
 *
 * Every member is the same optional method `DowntimeWorkerDeps` declares, so
 * callers keep passing the full deps object unchanged: the monitor's
 * `deps.getItemLifecycleState` / `deps.getRunningDowntimePanes` /
 * `deps.closePane` / `deps.recordPaneClose` and the in-flight resolver's
 * `deps.getRunningDowntimePanes`. Naming only what is called here keeps the
 * layering acyclic without changing any call site or any runtime behaviour.
 */
export interface DowntimePaneDeps {
  /** Running-downtime-panes liveness query (see `DowntimeWorkerDeps`). */
  getRunningDowntimePanes?(cwd: string): Promise<RunningPanesResult>;
  /** Item lifecycle-state lookup for the pane-lifecycle monitor. */
  getItemLifecycleState?(itemId: string, cwd: string): Promise<PaneItemState | null>;
  /** Close a dispatched pane (see `DowntimeWorkerDeps.closePane`). */
  closePane?(
    paneId: string,
    cwd: string,
    expected?: { itemId: string; kind: PaneLifecycleKind },
  ): Promise<boolean>;
  /** Record a pane-close lifecycle entry (see `DowntimeWorkerDeps.recordPaneClose`). */
  recordPaneClose?(entry: PaneCloseLogEntry, cwd: string): Promise<void>;
}

// ── Pane records, labels and item-scoped in-flight resolution ──────────
// Moved from the dispatch section of `downtime-worker.ts`; consumed by the
// dispatch loops (in-flight guard), the pane-close paths and `stalled-work.ts`.

/**
 * Prefix of every downtime dispatched pane label (`buildDowntimePaneTitle`
 * produces `Downtime triggered <kind> …` / `Downtime <kind>`). Pane labels
 * are set by send-to-pi.sh via `herdr pane rename`.
 */
export const DOWNTIME_PANE_LABEL_PREFIX = 'Downtime';

/**
 * Parse `herdr pane list` JSON output into records. Thin adapter over the
 * shared {@link parseHerdrPaneCloseList} contract (WL-0MUYMBMCG000Z4WP): the
 * reaper and the dispatcher must never drift into two parsers. Tolerates log
 * lines/prefixes before the JSON envelope, the `{result:{panes:[…]}}` /
 * `{panes:[…]}` shapes and a bare array. Returns `null` when no pane array can
 * be found (the caller treats this as a failed liveness query → fail-closed).
 *
 * Records carry the pane's `cwd` and raw `agent_session` alongside
 * `paneId`/`label`/`agent`/`agentStatus` so a stalled pane for an item in
 * another worklog root can be resumed against that root.
 */
export function parseHerdrPaneListOutput(raw: string): HerdrPaneRecord[] | null {
  const parsed = parseHerdrPaneCloseList(raw);
  if (parsed === null) return null;
  return parsed.map((pane) => ({
    paneId: pane.paneId,
    label: pane.label,
    agent: pane.agent,
    agentStatus: pane.agentStatus,
    cwd: pane.cwd,
    agentSession: pane.agentSession,
  }));
}

/**
 * Count LIVE downtime dispatched panes in a `herdr pane list` record set: a
 * pane is a running downtime pane when its label starts with the downtime
 * prefix AND it currently hosts a live agent (`agent` present, status not
 * terminal). Terminal agent statuses (`done` / `exited`) and panes whose
 * agent has already left are NOT counted.
 *
 * IMPORTANT (WL-0MU2EP6JL006A1U3): this count is NOT a dispatch limit. It
 * feeds only the owner-lease qualifier (`slotOwned` — "does this worker have
 * a pane of its own?") so an operator's own lease does not block
 * spare-capacity dispatch. Dispatched panes stay open until an operator
 * closes them, so gating dispatch on this count stalls the dispatcher
 * permanently (one dispatch per pane-close). Capacity is limited by the local
 * LLM idle / free-slot check alone.
 */
export function countRunningDowntimePanes(panes: HerdrPaneRecord[]): string[] {
  const running: string[] = [];
  for (const pane of panes) {
    if (typeof pane.label !== 'string') continue;
    if (!pane.label.startsWith(DOWNTIME_PANE_LABEL_PREFIX)) continue;
    if (typeof pane.agent !== 'string' || pane.agent.length === 0) continue;
    const status = (pane.agentStatus ?? '').toLowerCase();
    if (status === 'done' || status === 'exited') continue;
    running.push(pane.paneId);
  }
  return running;
}

/**
 * Trailing work-item id in a downtime pane label (WL-0MUBEZ6PE002WLP4).
 *
 * `buildDowntimePaneTitle` preserves the item id as a SUFFIX
 * (`Downtime triggered <kind> <title> - <ITEM-ID>`, via
 * `truncatePaneTitlePreservingSuffix`), so the id is the token after the last
 * ` - `. A manually-named pane (`Downtime <kind>`) has no id → `null`.
 *
 * Exported (not module-private) so the coordination offer path (F4,
 * WL-0MUBVKYH5009CGBI) reuses exactly this parse — no logic duplication.
 */
export function paneLabelItemId(label: string | undefined): string | null {
  if (typeof label !== 'string' || label === '') return null;
  const idx = label.lastIndexOf(' - ');
  if (idx < 0) return null;
  const id = label.slice(idx + 3).trim();
  return id === '' ? null : id;
}

/**
 * Safe-close predicate (WL-0MU4US5MP001JFEN AC7): true ONLY when a LIVE herdr
 * pane record exists for `paneId`, its label is a downtime pane label
 * (`DOWNTIME_PANE_LABEL_PREFIX`) AND its item-id suffix equals `itemId`.
 *
 * Guarding the close with this predicate means a stale dispatch-log entry can
 * never close an unrelated/operator pane whose pane id happens to collide with
 * the recorded dispatched pane (pane ids may be reused after a pane closes).
 * A missing record (the pane is already gone) returns false — there is nothing
 * to close.
 */
export function isSafeDowntimePaneToClose(
  records: HerdrPaneRecord[],
  paneId: string,
  itemId: string,
): boolean {
  const rec = records.find((p) => p.paneId === paneId);
  if (rec === undefined) return false;
  const label = rec.label ?? '';
  if (!label.startsWith(DOWNTIME_PANE_LABEL_PREFIX)) return false;
  return paneLabelItemId(label) === itemId;
}

/**
 * Item ids that currently have a LIVE `working` downtime pane
 * (WL-0MUBEZ6PE002WLP4, the in-flight guard).
 *
 * This is the ITEM-SCOPED counterpart of {@link countRunningDowntimePanes},
 * which answers a different question ("does THIS worker own a pane?" for the
 * owner-lease qualifier) and is explicitly NOT a dispatch limit
 * (WL-0MU2EP6JL006A1U3). A pane counts as in-flight for an item when:
 *
 *  - its label starts with the downtime prefix (`Downtime`),
 *  - it hosts a live agent (agent present, status not `done`/`exited`),
 *  - its agent status is `working` — the agent is actively running the
 *    dispatch. Idle/blank/unknown statuses are NOT treated as working: a
 *    pane that spawned but whose agent has not yet started (or has finished
 *    but not exited) must never deadlock the item's next tier,
 *  - and its label suffix parses to a work-item id.
 *
 * Consumed ONLY by the critical-first in-flight guard: it prevents a duplicate
 * dispatch for an item whose pane is already working — never a capacity gate.
 */
export function runningDowntimePaneItemIds(panes: HerdrPaneRecord[]): Set<string> {
  const inFlight = new Set<string>();
  for (const pane of panes) {
    if (typeof pane.label !== 'string') continue;
    if (!pane.label.startsWith(DOWNTIME_PANE_LABEL_PREFIX)) continue;
    if (typeof pane.agent !== 'string' || pane.agent.length === 0) continue;
    const status = (pane.agentStatus ?? '').toLowerCase();
    if (status !== 'working') continue;
    const itemId = paneLabelItemId(pane.label);
    if (itemId !== null) inFlight.add(itemId);
  }
  return inFlight;
}

/**
 * Resolve the item-scoped in-flight set for one dispatch cycle.
 *
 * Never throws: any failure (missing dep, thrown resolver, `{ok:false}` from
 * `herdr pane list`) resolves `{available:false}` so the dispatch loop's
 * decision table degrades to the marker-TTL fallback rather than crashing or
 * over-dispatching. A resolved result WITHOUT `records` (legacy callers that
 * only supply `count`) is treated as unavailable — the records are the
 * item-scoped signal, and guessing from a bare count would be a global limit
 * (the WL-0MU2EP6JL006A1U3 anti-pattern).
 */
export async function resolveInFlightPanes(
  deps: DowntimePaneDeps,
  cwd: string,
): Promise<InFlightPanes> {
  if (typeof deps.getRunningDowntimePanes !== 'function') {
    return { available: false, itemIds: new Set() };
  }
  try {
    const result = await deps.getRunningDowntimePanes(cwd);
    if (!result.ok) return { available: false, itemIds: new Set() };
    if (!Array.isArray(result.records)) return { available: false, itemIds: new Set() };
    return { available: true, itemIds: runningDowntimePaneItemIds(result.records) };
  } catch {
    return { available: false, itemIds: new Set() };
  }
}

// ── Pane spawn (send-to-pi.sh) ─────────────────────────────────────────

/**
 * Argument vector for spawning `send-to-pi.sh`: visible pane named
 * `Downtime <kind>` (`paneName` overrides it — the scheduled-prompts tier
 * passes `Downtime <entryId>`, WL-0MSS1Q5ER007QDKX), `--no-focus` (visible but
 * never steals focus), `--cwd <wlRoot>`, `--model <downtimeModel>`, then the
 * prompt.
 *
 * When `opts.itemTitle`/`opts.itemId` are present (dispatch tiers,
 * WL-0MSJ4E8UA005KG9Y), the pane is named in the full format
 * `Downtime triggered <kind> <title> - <id>` so downtime panes follow the
 * same descriptive convention as manually-triggered panes. Titles are
 * bounded by {@link MAX_PANE_TITLE_LENGTH}.
 */
export function buildDowntimePaneArgs(
  kind: DowntimeSkillKind,
  prompt: string,
  opts: {
    model: string;
    cwd: string;
    paneName?: string;
    itemTitle?: string;
    itemId?: string;
    anchorId?: string;
    /**
     * Granted local-reservation ticket id (parent WL-0MVIKRFP0005JDL8 AC1,
     * slice C2): forwarded as `--reservation-ticket <id>` so send-to-pi.sh
     * passes `PI_LOCAL_RESERVATION_TICKET` into the pane process. Absent on
     * a fail-open dispatch — the launch args stay byte-identical to today.
     */
    reservationTicketId?: string;
    /**
     * Per-turn locality preference (parent AC4, slice C4): forwarded as
     * `--local-preference <local-only|remote-ok>` so send-to-pi.sh passes
     * `HERDR_LOCAL_PREFERENCE` into the pane process. Absent leaves the launch
     * args byte-identical (fail-open C4-AC3).
     */
    localPreference?: LocalPreference;
  },
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

/**
 * Minimal spawn handle: the caller unrefs so the parent can exit first, and
 * registers `error` + `exit` listeners so a spawn failure or non-zero script
 * exit is observable instead of crashing the plugin process with an
 * unhandled 'error' event (WL-0MSLWJ3I70031Z8U absorbed).
 */
export interface DowntimeSpawnHandle {
  unref(): void;
  once(event: 'error', listener: (err: Error) => void): void;
  once(event: 'exit', listener: (code: number | null) => void): void;
}

/**
 * Result of one pane-spawn attempt. `ok: true` means the pane opened (or
 * the probe window elapsed with no failure — fire-and-forget); `ok: false`
 * means the spawn errored (`error`, e.g. ENOENT) or the script exited
 * non-zero (`exitCode`, null when killed by a signal) within the probe
 * window. The failure details are the error/exit trace recorded in the
 * dispatch audit log (WL-0MSLWJ3I70031Z8U AC2) so a pane that never
 * appeared is never logged as a success.
 */
export type DowntimeSpawnResult =
  | { ok: true }
  | { ok: false; error?: string; exitCode?: number | null };

/** Injectable spawn boundary (matches the repo's injectable-seam pattern). */
export type DowntimeSpawn = (
  scriptPath: string,
  args: string[],
  opts: {
    cwd: string;
    priority?: string | null;
    reservationTicketId?: string;
    /** Per-turn locality preference (parent AC4, slice C4). */
    localPreference?: LocalPreference;
  },
) => DowntimeSpawnHandle;

/**
 * Spawn options for `send-to-pi.sh`: detached, stdio ignored, resolved cwd
 * forwarded so the pane opens in the right project root.
 *
 * `AUDIT_PHASE2_PARALLELISM` is fixed at `'1'`: audit Phase 2 child
 * deep-analysis runs strictly sequentially, so a parent audit needs exactly
 * two local slots (the parent plus one child). The former mode-aware
 * `'2'` selection (WL-0MT50S9JW001DHME) was retired with the proxy's
 * fast/cheap operating mode (WL-0MVE1NZ4J000H5NH). The audit skill honours
 * the env var (integer >= 1); interactive (non-downtime) panes are
 * unaffected.
 */
export function buildDowntimeSpawnOptions(
  cwd: string,
  opts?: { priority?: string | null; reservationTicketId?: string; localPreference?: LocalPreference },
): {
  detached: boolean;
  stdio: 'ignore';
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: {
      ...scrubRepositoryOverrides(process.env),
      HERDR_RESOLVED_CWD: cwd,
      // Phase 2 child deep-analysis is always serial (parent + one child =
      // two local slots).
      AUDIT_PHASE2_PARALLELISM: '1',
      // Convey the selected candidate's priority to the launched pi session
      // (the Worklog pi extension turns it into the `X-Priority` header).
      // Mapped through the downtime table; defaults to `medium` for an
      // unknown/absent priority (parent WL-0MVE1NZ4J000H5NH AC3).
      [REQUEST_PRIORITY_ENV_VAR]: mapDowntimeRequestPriority(opts?.priority),
      // Granted reservation ticket (slice C2 AC1): belt-and-braces beside
      // the `--reservation-ticket` arg — the pane process reads this env var
      // on its first request (the Worklog pi extension turns it into
      // `X-Local-Reservation`). Absent on a fail-open dispatch, so the child
      // env stays byte-identical to today.
      ...(opts?.reservationTicketId
        ? { [LOCAL_RESERVATION_TICKET_ENV]: opts.reservationTicketId }
        : {}),
      // Per-turn locality preference (parent AC4, slice C4): belt-and-braces
      // beside the `--local-preference` arg. The Worklog pi extension turns
      // this into the `X-Local-Preference` header on every provider request.
      // Absent leaves the child env byte-identical to today (fail-open).
      ...(opts?.localPreference
        ? { [LOCAL_PREFERENCE_ENV_VAR]: opts.localPreference }
        : {}),
    },
  };
}

/**
 * Git environment variables that override the repository a `git` command
 * operates on. Git honours these over `cwd`, so a value leaked into a
 * spawned pane can redirect a `git` command into a live checkout
 * (SA-0MUIZSXEY008NGR8 / WL-0MV0TZEWZ003ZXEB). Mirrors the canonical list in
 * `skill/shared/git_sandbox.py::REPOSITORY_OVERRIDE_ENV_VARS`.
 */
export const REPOSITORY_OVERRIDE_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

/**
 * Return a copy of *env* with every repository-override git variable removed.
 * The input mapping is never mutated. Used by
 * {@link buildDowntimeSpawnOptions} so a launcher-side leak cannot be
 * forwarded to the spawned pane and its descendants (test subprocesses).
 */
export function scrubRepositoryOverrides(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = { ...env };
  for (const name of REPOSITORY_OVERRIDE_ENV_VARS) {
    delete cleaned[name];
  }
  return cleaned;
}

/** Default spawn: detached, stdio ignored, resolved cwd forwarded. */
export const defaultDowntimeSpawn: DowntimeSpawn = (
  scriptPath,
  args,
  opts,
) =>
  spawn(scriptPath, args, buildDowntimeSpawnOptions(opts.cwd, opts));

/**
 * Default probe window for {@link spawnDowntimePane} — how long to wait for a
 * spawn-level `error` event or an immediate non-zero script `exit` before
 * assuming the pane started (an ENOENT/EACCES error fires on the next
 * event-loop tick; a failing script exits within milliseconds). The probe
 * keeps the failure observable without delaying the poll loop. Overridable
 * per call via the `probeMs` option — a caller that spawns a real interpreter
 * under load must not race the 500 ms default (the real-spawn characterisation
 * suite passes a generous window, WL-0MVOTIJ2U000JI44).
 */
export const DOWNTIME_SPAWN_PROBE_MS = 500;

/**
 * Spawn `send-to-pi.sh` detached with stdio ignored, then unref so the
 * parent (plugin) process can exit independently — same pattern as the
 * TUI's existing agent dispatches. `error` and `exit` listeners are ALWAYS
 * attached (a spawn failure must not crash the plugin with an unhandled
 * 'error' event, WL-0MSLWJ3I70031Z8U): a spawn `error` (ENOENT/EACCES) or a
 * non-zero script exit within the probe window resolves `{ok:false}` with
 * the failure trace so the dispatch outcome is not a false success; exit 0
 * (script ran to completion — pane opened) and the probe timeout (pane
 * still alive) resolve `{ok:true}`.
 */
export async function spawnDowntimePane(
  scriptPath: string,
  args: string[],
  opts: {
    cwd: string;
    priority?: string | null;
    reservationTicketId?: string;
    /** Per-turn locality preference (parent AC4, slice C4). */
    localPreference?: LocalPreference;
    /**
     * Probe window override (ms); defaults to
     * {@link DOWNTIME_SPAWN_PROBE_MS}. Bounds only how long the caller waits
     * for a spawn `error` / non-zero `exit` before assuming the pane
     * started; it is NOT forwarded to the spawn boundary. Real-spawn tests
     * pass a generous value so a slow interpreter startup under host load
     * cannot race the default window (WL-0MVOTIJ2U000JI44).
     */
    probeMs?: number;
  },
  spawnFn: DowntimeSpawn = defaultDowntimeSpawn,
): Promise<DowntimeSpawnResult> {
  const { probeMs = DOWNTIME_SPAWN_PROBE_MS, ...spawnOpts } = opts;
  const child = spawnFn(scriptPath, args, spawnOpts);
  child.unref();
  return new Promise<DowntimeSpawnResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: DowntimeSpawnResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => settle({ ok: true }), probeMs);
    child.once('error', (err: Error) => {
      process.stderr.write(
        `[worklog-plugin] Downtime pane spawn failed: ${err.message}\n`,
      );
      settle({ ok: false, error: err.message });
    });
    child.once('exit', (code: number | null) => {
      // A non-zero exit (or null — killed by a signal) within the probe
      // window means the script failed to open the pane (e.g. send-to-pi.sh
      // errored); exit 0 means it ran to completion — the pane opened.
      if (code !== 0) {
        process.stderr.write(
          `[worklog-plugin] Downtime pane script exited non-zero ` +
            `(code ${String(code)}) before the probe window elapsed\n`,
        );
        settle({ ok: false, exitCode: code });
      } else {
        settle({ ok: true });
      }
    });
  });
}

// ── Pane-lifecycle monitor (WL-0MU308WSF0002JWN) ──────────────────────

/** Summary of one pane-lifecycle monitor pass. */
export interface PaneLifecycleMonitorResult {
  /** Number of dispatched panes inspected. */
  checked: number;
  /** Number of panes actually closed this pass. */
  closed: number;
  /** Number of lifecycle outcomes logged this pass. */
  logged: number;
  /** Number of per-pane failures swallowed (fail-closed). */
  errors: number;
}

/**
 * Inspect every dispatched pane recorded in the rolling log and, for each
 * one that has reached a terminal or attention state, log a pane-close
 * lifecycle entry and (except `implement`) close the pane
 * (WL-0MU308WSF0002JWN).
 *
 * Fail-closed at every boundary (AC7): a missing log, an unreadable item, a
 * failed pane close, or a failed log write is swallowed and never crashes
 * the worker or blocks the remaining panes. Idempotent: a `(pane, outcome,
 * reason)` triple already recorded in the log is never written twice, so
 * repeated ticks (and multiple instances sharing a root) do not duplicate
 * entries — while a genuine state CHANGE produces a new entry (intake Q&A).
 *
 * The monitor performs NO work when the deps are absent (legacy/test
 * callers): with no `getItemLifecycleState` every pane classifies to null,
 * so the pass is a cheap no-op.
 */
/**
 * Warn-level observability for pane-lifecycle failures
 * (WL-0MU4USJ07009JYL8 AC2). Fail-closed: a stderr write failure is
 * swallowed — observability must never crash the worker.
 */
export function paneLifecycleWarn(message: string): void {
  try {
    process.stderr.write(`[worklog-plugin] Downtime pane-lifecycle: ${message}\n`);
  } catch {
    // fail-closed: logging must never crash the worker
  }
}

export function paneLifecycleErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function monitorDispatchedPanes(
  deps: DowntimePaneDeps,
  cwd: string,
): Promise<PaneLifecycleMonitorResult> {
  const result: PaneLifecycleMonitorResult = { checked: 0, closed: 0, logged: 0, errors: 0 };

  // Strict no-op for legacy callers: without an item-state resolver the
  // monitor cannot distinguish a terminal stage from "unknown", so taking
  // any action (e.g. flagging requires-attention on agent-done alone) would
  // be guesswork. Production wiring always provides the dep.
  if (typeof deps.getItemLifecycleState !== 'function') return result;

  // Read the rolling log (fail-safe: unreadable → []).
  let entries: Awaited<ReturnType<typeof readDowntimeLogEntries>>;
  try {
    entries = await readDowntimeLogEntries(cwd);
  } catch (err) {
    paneLifecycleWarn(`could not read the dispatch log — skipping this pass: ${paneLifecycleErrMsg(err)}`);
    return result; // fail-closed: no evidence, no action
  }

  const panes = collectDispatchedPanes(entries);
  if (panes.length === 0) return result;
  const loggedKeys = loggedPaneLifecycleKeys(entries);

  // Running-pane liveness: `null` when unknown (fail-open — an unknown
  // liveness must never be read as "agent done", which would close a live
  // pane). When known, a dispatched pane absent from the live set has ended.
  let livePanes: Set<string> | null = null;
  if (typeof deps.getRunningDowntimePanes === 'function') {
    try {
      const running = await deps.getRunningDowntimePanes(cwd);
      if (running.ok && Array.isArray(running.records)) {
        livePanes = new Set(running.records.map((rec) => rec.paneId));
      } else if (!running.ok) {
        paneLifecycleWarn('live-pane query failed — skipping agent-done detection this pass');
      }
    } catch (err) {
      paneLifecycleWarn(`live-pane query threw — skipping agent-done detection this pass: ${paneLifecycleErrMsg(err)}`);
      livePanes = null; // fail-open — never close on unknown liveness
    }
  }

  for (const pane of panes) {
    result.checked += 1;
    try {
      let item: PaneItemState | null = null;
      try {
        item = await deps.getItemLifecycleState(pane.itemId, cwd);
      } catch (err) {
        paneLifecycleWarn(`item lookup failed for ${pane.itemId} (pane ${pane.paneId}): ${paneLifecycleErrMsg(err)}`);
        result.errors += 1;
        continue; // fail-closed: no evidence → take no action for this pane
      }
      const agentDone = livePanes !== null && !livePanes.has(pane.paneId);
      const decision = classifyPaneLifecycle(pane, item, agentDone);
      if (decision === null) continue;

      const key = paneLifecycleKey(pane.paneId, decision.outcome, decision.reasonCode);
      if (loggedKeys.has(key)) continue; // already recorded — idempotent

      // Close the pane (except `implement`, which is never auto-closed —
      // AC6). A failed/absent close is recorded with `closed:false` and
      // never blocks the log entry or the remaining panes (AC7).
      let closed = false;
      if (decision.close && typeof deps.closePane === 'function') {
        try {
          closed = await deps.closePane(pane.paneId, cwd, { itemId: pane.itemId, kind: pane.kind });
        } catch (err) {
          paneLifecycleWarn(`pane close failed for ${pane.paneId} (${pane.itemId}): ${paneLifecycleErrMsg(err)}`);
          closed = false; // fail-closed
        }
      }

      const entry: PaneCloseLogEntry = {
        entryType: 'pane-close',
        timestamp: new Date().toISOString(),
        itemId: pane.itemId,
        itemTitle: item?.title ?? pane.itemTitle,
        paneId: pane.paneId,
        kind: pane.kind,
        outcome: decision.outcome,
        reason: decision.reason,
        reasonCode: decision.reasonCode,
        // Dispatched-at stage, so the non-terminal cooldown can be released
        // when the item advances (WL-0MUKYERLZ006ELL5 parent AC4).
        stage: pane.stage,
        closed,
      };
      try {
        if (typeof deps.recordPaneClose === 'function') {
          await deps.recordPaneClose(entry, cwd);
        } else {
          await appendPaneCloseLogEntry(cwd, entry);
        }
        loggedKeys.add(key);
        result.logged += 1;
        if (closed) result.closed += 1;
      } catch (err) {
        paneLifecycleWarn(`pane-close log write failed for ${pane.paneId} (${pane.itemId}): ${paneLifecycleErrMsg(err)}`);
        result.errors += 1; // fail-closed: logging must never crash the worker
      }
    } catch (err) {
      paneLifecycleWarn(`lifecycle pass failed for pane ${pane.paneId}: ${paneLifecycleErrMsg(err)}`);
      result.errors += 1; // fail-closed: one bad pane never blocks the rest
    }
  }

  return result;
}
