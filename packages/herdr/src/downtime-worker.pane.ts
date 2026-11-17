/**
 * packages/herdr/src/downtime-worker.pane.ts — Herdr pane identity, in-flight
 * resolution, spawn invocation and the pane-lifecycle monitor.
 *
 * Map pointer: the single pane-creation architecture map + naming contract
 * lives in `docs/dev/downtime-dispatcher.md` → *Pane creation architecture*.
 *
 * Single responsibility: everything the downtime dispatcher knows about Herdr
 * panes — the deps-wiring in-flight resolution, the `send-to-pi.sh` invocation
 * (spawn options/env — the pane argv itself is canonical in `pane-argv.ts`)
 * and the dispatched-pane lifecycle monitor. The pane-discovery surface
 * (parse, live/working predicates, item-scoped in-flight set, safe-close
 * predicate, blocking-pane filter) is delegated to the canonical
 * `pane-discovery.ts` module (WL-0MWHWH6XL0025YX2) and re-exported here for
 * backward compatibility.
 *
 * Moved verbatim out of `downtime-worker.ts` (parent WL-0MVF3F9A7000HKP7;
 * child WL-0MVLIHZBT006B1UI). No behaviour change: the pane label prefix,
 * spawn flags (`--pane-name`, `--no-focus`, `--cwd`, `--model`, `--anchor`,
 * `--reservation-ticket`, `--local-preference`), the detached/unref'd spawn
 * semantics, the `AUDIT_PHASE2_PARALLELISM=1` audit fan-out bound and the
 * pane-close safety rules are all unchanged; the argv assembly itself moved
 * to the canonical `pane-argv.ts` module (WL-0MWHWGZI4007D911). Every
 * work-item provenance comment below travels with the code it documents.
 *
 * Layering: this module imports only concrete siblings (constants, types,
 * `downtime-log`, `pane-lifecycle`, `pane-argv`, `pane-discovery`,
 * `request-priority`, `local-preference`), never
 * `./downtime-worker.js` — the barrel re-exports it, so an edge back would
 * invert the layering. It also performs no value import of `./stalled-work.js`
 * (the pre-existing `stalled-work ↔ downtime-worker` cycle stays type-only),
 * so no runtime cycle can form.
 */

import { spawn } from 'node:child_process';
import { LOCAL_RESERVATION_TICKET_ENV } from './downtime-worker.constants.js';
import type {
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
import { runningDowntimePaneItemIds } from './pane-discovery.js';
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
// Canonical home of the whole discovery surface is `pane-discovery.ts`
// (WL-0MWHWH6XL0025YX2) — one list→filter→classify pipeline instead of four
// partial copies; re-exported here so the barrel and every existing call site
// keep resolving these names through this module.

/**
 * Prefix of every downtime dispatched pane label (`buildDowntimePaneTitle`
 * produces `Downtime triggered <kind> …` / `Downtime <kind>`). Pane labels
 * are set by send-to-pi.sh via `herdr pane rename`.
 *
 * Canonical home is `pane-label.ts` (WL-0MWHWH1HV009C46C) — re-exported
 * here for backward compatibility with callers that import the prefix from
 * the pane module; prefix matching itself goes through
 * {@link isDowntimePaneLabel}.
 */
export { DOWNTIME_PANE_LABEL_PREFIX } from './pane-label.js';

/**
 * The pane-discovery surface (WL-0MWHWH6XL0025YX2): the `herdr pane list`
 * parse (`parseHerdrPaneListOutput`), the shared live/working predicates
 * (`hasPaneAgent`, `isTerminalAgentStatus`, `isPaneAgentLive`, `isPaneWorking`),
 * the live-pane count (`countRunningDowntimePanes`), the safe-close predicate
 * (`isSafeDowntimePaneToClose`), the item-scoped in-flight set
 * (`runningDowntimePaneItemIds`) and the blocking-pane filter
 * (`findBlockingPanes` / `BlockingPane`) — all canonical in `pane-discovery.ts`
 * and re-exported so the barrel and existing call sites resolve them through
 * this module unchanged.
 */
export {
  countRunningDowntimePanes,
  findBlockingPanes,
  hasPaneAgent,
  isPaneAgentLive,
  isPaneWorking,
  isSafeDowntimePaneToClose,
  isTerminalAgentStatus,
  parseHerdrPaneListOutput,
  runningDowntimePaneItemIds,
  type BlockingPane,
} from './pane-discovery.js';

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
 * Canonical downtime `send-to-pi.sh` argument builder — assembled in
 * `pane-argv.ts` (WL-0MWHWGZI4007D911) so one canonical builder serves every
 * pane-spawn path; this module re-exports it under its public name. Visible
 * pane named `Downtime <kind>` (`paneName` overrides it — the
 * scheduled-prompts tier passes `Downtime <entryId>`, WL-0MSS1Q5ER007QDKX),
 * `--no-focus` (visible but never steals focus), `--cwd <wlRoot>`, `--model
 * <downtimeModel>`, then the prompt — with the optional `--anchor`,
 * `--reservation-ticket` and `--local-preference` flags defined by the
 * canonical module.
 *
 * When `opts.itemTitle`/`opts.itemId` are present (dispatch tiers,
 * WL-0MSJ4E8UA005KG9Y), the pane is named in the full format
 * `Downtime triggered <kind> <title> - <id>` so downtime panes follow the
 * same descriptive convention as manually-triggered panes. Titles are
 * bounded by `MAX_PANE_TITLE_LENGTH`.
 */
export { buildDowntimePaneArgs } from './pane-argv.js';

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
 *
 * The two pane-launch knobs — `HERDR_LOCAL_PREFERENCE` and
 * `PI_LOCAL_RESERVATION_TICKET` — come from `opts` **only** and are stripped
 * from the inherited environment (WL-0MVP643Q4007BZJ8). The downtime worker
 * can itself run inside a `local-preferred` pane that exports
 * `HERDR_LOCAL_PREFERENCE`; inheriting that value would (a) violate the
 * fail-open contract that an absent preference leaves the pane env
 * byte-identical (C4-AC3) and (b) bypass the resolved dispatch decision, so a
 * `local-preferred` leader would force every child — including `critical` work —
 * local-preferred. Interactive panes are not built here, so an operator who
 * exports the variable still gets it in their own panes.
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
  const env: NodeJS.ProcessEnv = {
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
  };
  // Pane-launch knobs are never inherited from the launcher
  // (WL-0MVP643Q4007BZJ8): the resolved dispatch decision is their only source.
  delete env[LOCAL_RESERVATION_TICKET_ENV];
  delete env[LOCAL_PREFERENCE_ENV_VAR];
  // Granted reservation ticket (slice C2 AC1): belt-and-braces beside the
  // `--reservation-ticket` arg — the pane process reads this env var on its
  // first request (the Worklog pi extension turns it into
  // `X-Local-Reservation`). Absent on a fail-open dispatch, so the child env
  // stays byte-identical to today.
  if (opts?.reservationTicketId) {
    env[LOCAL_RESERVATION_TICKET_ENV] = opts.reservationTicketId;
  }
  // Per-turn locality preference (parent AC4, slice C4): belt-and-braces
  // beside the `--local-preference` arg. The Worklog pi extension turns this
  // into the `X-Local-Preference` header on every provider request. Absent
  // leaves the child env byte-identical to today (fail-open).
  if (opts?.localPreference) {
    env[LOCAL_PREFERENCE_ENV_VAR] = opts.localPreference;
  }
  return {
    detached: true,
    stdio: 'ignore',
    cwd,
    env,
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
