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
import { isAuditFresh } from '@worklog/shared/icons';
import {
  checkWlAvailable,
  fetchNextItems,
  fetchItemsByStage,
  claimWorkItem,
  rollbackClaimWorkItem,
  markNeedsProducerReviewWorkItem,
  getExecFileAsync,
  buildWlArgs,
  buildWlArgsForRoot,
  extractJson,
  extractItems,
} from './fetcher.js';
import { REQUEST_PRIORITY_ENV_VAR } from './request-priority.js';
import type { LocalPreference } from './local-preference.js';
import { AgentTracker, AGENT_PANES_FILE } from './agent-tracker.js';
import {
  buildManuallyTriggeredPaneTitle,
  buildShellPaneTitle,
  stripSkillName,
} from './pane-title.js';
import { applyActivePaneMarkers, createProductionHydratorDeps } from './hydrator.js';
import { HerdrEventSubscriber, resolveSocketPath } from './events.js';
import { runWorklistTui, getTermSize } from './worklist.js';
import { loadShortcutConfig } from './shortcut-config.js';
import { readCodeFreezeStatusForRoot } from './code-freeze.js';
import {
  getMachineCoordinationDir,
  isHostAuditActive,
  writeActiveAuditMarker,
  removeActiveAuditMarker,
  readStoredModelCooldowns,
  clearStoredModelCooldown,
} from './machine-coordination.js';
import { loadSettings, getDefaultSettingsPath, clampBrowseItemCount, defaultSettings } from './settings.js';
import {
  countSpawnedChildProcesses,
  createHerdrReaperDeps,
  dirHasRecentModifications,
  parsePaneProcessInfo,
} from './pane-close-herdr.js';
import { runScheduledPaneClose } from './pane-close-scheduler.js';
import {
  createDowntimeWorker,
  createDowntimePoller,
  buildDowntimePaneArgs,
  spawnDowntimePane,
  parseNextCandidatesOutput,
  parseAuditCandidatesOutput,
  parseImplementCandidatesOutput,
  parseCriticalCandidatesOutput,
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
  type DowntimeCandidate,
  type DowntimeDispatchEvent,
  type DowntimeDispatchFailureEvent,
  type DowntimeDispatchEnrichmentEvent,
  type DowntimeErrorEvent,
  type DowntimeNextResult,
  type DowntimeClaimExpected,
  type DowntimeClaimResult,
  type DowntimeSpawn,
  type DowntimeSpawnResult,
  type ScheduledPrompt,
  type DowntimeItemResult,
  parseShowItemOutput,
  defaultDowntimeSpawn,
  buildDowntimeDispatchComment,
  DOWNTIME_WL_TIMEOUT_MS,
  DOWNTIME_AUDIT_STALE_WINDOW_MS,
  parseInProgressOutput,
  type DowntimeActiveAuditResult,
  withTransientRetry,
  parseHerdrPaneListOutput,
  isSafeDowntimePaneToClose,
  createLocalReserver,
} from './downtime-worker.js';
import { createRoundRobinRegistry, type RoundRobinRegistry } from './downtime-round-robin.js';
import {
  appendDowntimeLogEntry,
  appendPaneCloseLogEntry,
  auditDispatchedItemIds,
  implementDispatchedItemIds,
  planDispatchedItemStages,
  intakeDispatchedItemStages,
  dispatchedItemStages,
  readDowntimeLogEntries,
  recentAuditDispatchedItemIds,
} from './downtime-log.js';
import {
  resumeStalledPane,
  scanStalledPanes,
  type StalledPaneCandidate,
  type StalledScanOptions,
} from './stalled-work.js';
import {
  scanLongRunningPanes,
  type LongRunningPaneObservation,
  type LongRunningScanOptions,
} from './long-running-panes.js';
import {
  getDueScheduledPrompt as getFirstDuePrompt,
  loadScheduledPrompts,
  updateScheduledPromptLastTriggered,
} from './scheduled-prompts.js';
import type { ItemTabAnchor } from './dispatcher-anchor.js';
import {
  buildRunInPaneArgs,
  buildSendToPiArgs,
  parsePaneIdFile,
  routeCommand,
  stripAgentPromptPrefix,
  stripCommandPrefix,
} from './index.commands.js';

// Resolve path to the send-to-pi.sh script (relative to this source file)
// At runtime (tsx or dist), __dirname equivalent from import.meta.url
const _currentDir = dirname(fileURLToPath(import.meta.url));
const SEND_TO_PI_SCRIPT = resolve(_currentDir, '..', 'scripts', 'send-to-pi.sh');
const RUN_IN_PANE_SCRIPT = resolve(_currentDir, '..', 'scripts', 'run-in-pane.sh');

// ── Command routing and pane-argument builders (index.commands.ts) ─────
// Extracted verbatim (move-only, WL-0MVOA0HYY005RG06): re-exported so the
// barrel keeps the surface index.test.ts and other consumers import.

export {
  buildRunInPaneArgs,
  buildSendToPiArgs,
  parsePaneIdFile,
  routeCommand,
  stripAgentPromptPrefix,
  stripCommandPrefix,
} from './index.commands.js';

// ── Background (no-pane) dispatch (index.background.ts) ──────────────
// Extracted verbatim (move-only, WL-0MVOA0K6T009KTN1): re-exported so the
// barrel keeps the surface index.test.ts and other consumers import. The
// TUI dispatch path (`main()`) also imports the helpers directly for its
// internal calls (same pattern as the index.commands.js value import above).

import {
  buildBackgroundLogPath,
  notifyBackgroundFailure,
  spawnBackgroundPi,
  spawnBackgroundShell,
} from './index.background.js';

export {
  buildBackgroundLogPath,
  formatBackgroundFailure,
  spawnBackgroundPi,
  spawnBackgroundShell,
} from './index.background.js';

// ── Pane-ID capture + work-item extraction (index.pane-capture.ts) ──
// Extracted verbatim (move-only, WL-0MVOA0MBH004KKL0): the pane-ID
// association capture and work-item extraction helpers moved to
// `index.pane-capture.ts`. Re-exported so the barrel keeps the surface
// index.test.ts/claim.test.ts import (`CAPTURE_TIMEOUT_MS`,
// `capturePaneIdFromFile`, `extractWorkItemId`); `CAPTURE_POLL_INTERVAL_MS`
// and `PaneIdFileDeps` become internal to the new module. The dispatch
// paths below value-import the helpers (same pattern as the
// index.commands.js import above). `AGENT_ASSIGNEE` moved with the claim
// section (phase 5, `index.claim.ts`).

import {
  capturePaneIdFromFile,
  extractWorkItemId,
} from './index.pane-capture.js';

export {
  CAPTURE_TIMEOUT_MS,
  capturePaneIdFromFile,
  extractWorkItemId,
} from './index.pane-capture.js';

// ── Claim + interactive priority (index.claim.ts) ────────────────────
// Extracted verbatim (move-only, WL-0MVOA0ODW002W5C4): the claim and
// interactive-priority section (AGENT_ASSIGNEE, claimItemForAgentCommand,
// lookupWorkItemPriority, resolveInteractiveDispatchPriority,
// fetchCriticalBlockers) moved to `index.claim.ts`. Value-imported so
// the barrel's dispatch paths / createDowntimeDeps can keep calling the
// helpers internally (same pattern as the index.background.js
// `notifyBackgroundFailure` value import; AC6 — the claim module imports
// only concrete siblings). Re-exported so the barrel keeps the surface
// index.test.ts/claim.test.ts import (`claimItemForAgentCommand`,
// `resolveInteractiveDispatchPriority`); `AGENT_ASSIGNEE` and
// `fetchCriticalBlockers` stay OUT of the consumed public surface.

import {
  AGENT_ASSIGNEE,
  claimItemForAgentCommand,
  fetchCriticalBlockers,
  resolveInteractiveDispatchPriority,
} from './index.claim.js';

export {
  claimItemForAgentCommand,
  resolveInteractiveDispatchPriority,
} from './index.claim.js';

import {
  defaultDispatcherAnchorResolver,
  defaultDispatcherTabAnchorResolver,
  defaultItemTabAnchorResolver,
  defaultProjectWorkspaceResolver,
} from './index.anchor-resolvers.js';

// ── Interactive placement + root-pane cleanup (index.interactive.ts) ──
// Extracted verbatim (move-only, WL-0MVOA0S1E0022UV7): the interactive
// workspace/item-anchor resolution and fail-safe tab root-pane cleanup
// moved to `index.interactive.ts`. Value-imported so `main()` can keep
// calling the helpers internally (same pattern as the index.claim.js
// value import; AC6 — the interactive module imports only concrete
// siblings). Re-exported so the barrel keeps the surface index.test.ts
// imports via dynamic `import('./index.js')` casts
// (`resolveInteractiveWorkspaceId`, `resolveInteractiveItemAnchor`,
// `closeInteractiveTabRootPane`, `defaultInteractiveLiveTrackedPanesResolver`);
// `InteractiveLiveTrackedPanesResult`, `InteractiveRootPaneCleanupDeps`,
// `isLiveTrackedPane` and `defaultInteractiveClosePane` stay OUT of the
// consumed public surface — `main` (phase 11) imports the internal defaults
// directly from `index.interactive.ts`.

import {
  closeInteractiveTabRootPane,
  defaultInteractiveClosePane,
  defaultInteractiveLiveTrackedPanesResolver,
  resolveInteractiveItemAnchor,
  resolveInteractiveWorkspaceId,
} from './index.interactive.js';

export {
  closeInteractiveTabRootPane,
  defaultInteractiveLiveTrackedPanesResolver,
  resolveInteractiveItemAnchor,
  resolveInteractiveWorkspaceId,
} from './index.interactive.js';

// ── Downtime resolvers (index.downtime-resolvers.ts) ─────────────────
// Extracted verbatim (move-only, WL-0MVOA0U84003EXVK): the running-pane
// liveness resolver, the stalled-work resume seams, the pane lister, the
// pi-session-log root decoder and the closed-pane log reader moved to
// `index.downtime-resolvers.ts`. Value-imported so `createDowntimeDeps` and
// the pane-close reaper keep calling the helpers internally (same pattern as
// the index.claim.js value import; AC6 — the module imports only concrete
// siblings). Re-exported so the barrel keeps the surface index.test.ts
// imports (`defaultStalledPaneRootResolver`, `defaultStalledPanesLister`,
// `worklogRootFromPiSessionPath`); `defaultRunningDowntimePanesResolver`,
// `defaultStalledResumePromptAgent`, `defaultStalledResumeStartAgent` and
// `readClosedPaneIds` stay OUT of the consumed public surface.

import {
  defaultRunningDowntimePanesResolver,
  defaultStalledPaneRootResolver,
  defaultStalledPanesLister,
  defaultStalledResumePromptAgent,
  defaultStalledResumeStartAgent,
  readClosedPaneIds,
} from './index.downtime-resolvers.js';

export {
  defaultStalledPaneRootResolver,
  defaultStalledPanesLister,
  worklogRootFromPiSessionPath,
} from './index.downtime-resolvers.js';

// ── Host-CPU sampler (index.host-cpu.ts) ─────────────────────────────
// Extracted verbatim (move-only, WL-0MVOA0U84003EXVK): the module-level
// host-CPU sampler and its test seam moved to `index.host-cpu.js` so the
// singleton state lives in exactly one module (AC5). `readHostCpu` is the
// internal read path `createDowntimeDeps` wires into the worker;
// `setHostCpuSamplerForTests` is re-exported for `index.test.ts`.

import { readHostCpu } from './index.host-cpu.js';

export { setHostCpuSamplerForTests } from './index.host-cpu.js';

// ── Settings bootstrap + worklog-target (index.settings.ts) ─────────
// Extracted verbatim (move-only, WL-0MVOA0W1P000IZKK): the single module-level
// `const settings = loadSettings()` side effect and the two worklog-target
// bootstrap functions moved to `index.settings.ts` so the settings singleton
// lives in exactly one module (AC5). Value-imported so `createDowntimeDeps` and
// `main()` keep sharing the same instance (settings is NOT re-exported — no
// consumer imports it from the barrel, AC2). Re-exported so the barrel keeps
// the surface index.test.ts imports via dynamic `import('./index.js')` casts
// (`configureWorklogTarget`, `uninitializedReport`).

import {
  configureWorklogTarget,
  settings,
  uninitializedReport,
} from './index.settings.js';

export { configureWorklogTarget, uninitializedReport };

/**
 * Build the real downtime-worker dependencies (WL-0MSF49FMW009M06K):
 * `wl next --stage <stage> --json` for dispatch selection, `wl update
 * <id> --status in_progress` for the pre-dispatch claim, and
 * `send-to-pi.sh` for the visible (non-focus-stealing) agent pane. Every
 * boundary is fail-closed: a wl failure yields no candidate (no dispatch)
 * rather than an exception.
 *
 * @param anchorResolver Dispatcher-anchor resolver (C0 WL-0MTR01EU7005SYZG).
 *   Defaults to the real herdr-CLI-backed resolver; injectable for tests that
 *   build real deps without a live herdr session. Retained as the AC4
 *   fallback (no project workspace) and for scheduled-prompt spawns.
 * @param projectWorkspaceResolver Project-workspace resolver
 *   (WL-0MU321YK70035AYT). Defaults to the real herdr-CLI-backed resolver;
 *   injectable for tests.
 * @param itemTabAnchorResolver Item-ID tab-anchor resolver
 *   (WL-0MU321YK70035AYT). Defaults to the real herdr-CLI-backed resolver;
 *   injectable for tests.
 * @param dispatcherTabAnchorResolver Per-prefix Dispatcher tab-anchor
 *   resolver (C1, WL-0MTRQT482001SNXC). Defaults to the real herdr-CLI-backed
 *   resolver; injectable for tests. This is the FALLBACK placement path, used
 *   only when no project workspace resolves for the item's root
 *   (WL-0MUR5FUWD00024XN).
 */
export function createDowntimeDeps(
  scriptPath: string,
  assignee: string,
  spawnFn: DowntimeSpawn = defaultDowntimeSpawn,
  anchorResolver: DowntimeWorkerDeps['getDispatcherAnchor'] = defaultDispatcherAnchorResolver,
  runningPanesResolver: NonNullable<DowntimeWorkerDeps['getRunningDowntimePanes']> =
    defaultRunningDowntimePanesResolver,
  projectWorkspaceResolver: DowntimeWorkerDeps['resolveProjectWorkspace'] =
    defaultProjectWorkspaceResolver,
  itemTabAnchorResolver: DowntimeWorkerDeps['getItemTabAnchor'] =
    defaultItemTabAnchorResolver,
  dispatcherTabAnchorResolver: DowntimeWorkerDeps['getDispatcherTabAnchor'] =
    defaultDispatcherTabAnchorResolver,
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
  // Leader-coordination item fetch (parent WL-0MST3OJ8S0001ROL AC4):
  // resolve ONE item by id. `wl show` does not serve the audit timestamp, so
  // for completed/in_review items the audit tier's list query (which DOES
  // enrich auditedAt) is run against the worklog root to attach the
  // freshness signal — otherwise an item with a valid audit could be
  // re-audited on classification alone. Fail-closed: {ok:false} on any wl
  // failure or unparseable output.
  //
  // Cross-root (WL-0MTQ14W7L003II5A): BOTH lookups resolve against the
  // PASSED-IN `cwd` (the offer's own worklog root) via stateless
  // `buildWlArgsForRoot` — never the leader pane's module-level
  // `_worklogDir`. The pre-fix code ignored `cwd` and fired `wl show` at
  // the leader's database, so a foreign offer (AH- in AI_Hell, CG- in
  // Tableau-Card-Engine) produced "Work item not found" → 3 strikes →
  // 60-minute pause with idle slots unused.
  const fetchAuditItemById = async (itemId: string, cwd: string): Promise<DowntimeItemResult> => {
    try {
      const { stdout } = await withTransientRetry(() => getExecFileAsync()(
        'wl',
        buildWlArgsForRoot(cwd, ['show', itemId, '--json']),
        { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
      ));
      const info = parseShowItemOutput(stdout);
      if (info === null) return { ok: false, error: 'show parse error' };
      if (info.status === 'completed' && info.stage === 'in_review') {
        const { stdout: listOut } = await withTransientRetry(() => getExecFileAsync()(
          'wl',
          buildWlArgsForRoot(cwd, ['list', '--status', 'completed', '--stage', 'in_review', '--root-only', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        ));
        const audits = parseAuditCandidatesOutput(listOut);
        if (audits === null) return { ok: false, error: 'audit list parse error' };
        const found = audits.find((a) => a.id === itemId);
        info.auditedAt = found?.auditedAt ?? null;
        info.fingerprint = found?.fingerprint ?? null;
        info.currentFingerprint = found?.currentFingerprint ?? null;
      }
      return { ok: true, info };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    // Dispatcher anchor (C0 WL-0MTR01EU7005SYZG): the machine-wide dedicated
    // Dispatcher workspace/pane resolver. Retained ONLY as the AC4 fallback
    // (no resolvable project plugin pane for the item's root,
    // WL-0MU321YK70035AYT) and for scheduled-prompt spawns (no work-item id).
    // Null → dispatch degrades to "no dispatch this cycle". Injected
    // (default = real herdr CLI) so tests can stub it.
    getDispatcherAnchor: anchorResolver,
    // Per-prefix Dispatcher tab (C1, WL-0MTRQT482001SNXC): a FALLBACK worklog
    // placement path, consulted only when `resolveProjectWorkspace` does not
    // resolve a project workspace for the item's root (AC3,
    // WL-0MUR5FUWD00024XN). Resolves/creates the tab labelled with the
    // work-item id prefix (`WL`, `TCE`) inside the machine-wide Dispatcher
    // workspace and anchors the pane to that tab's root pane. A null result
    // fails closed ('anchor-unavailable') — never a legacy fallback. Injected
    // (default = real herdr CLI).
    getDispatcherTabAnchor: dispatcherTabAnchorResolver,
    // Project workspace + item-ID tab (WL-0MU321YK70035AYT): the PRIMARY
    // worklog placement path (AC2, WL-0MUR5FUWD00024XN). When a project
    // plugin pane resolves for the item's root, the pane lands in that
    // project's workspace under the exact work-item id tab; the Dispatcher
    // workspace is not used. Injected (default = real herdr CLI).
    resolveProjectWorkspace: projectWorkspaceResolver,
    getItemTabAnchor: itemTabAnchorResolver,
    // Running-downtime-panes liveness (AC1/AC3, WL-0MTYZXSLN008HZOW): counts
    // live dispatched downtime panes from `herdr pane list` so the
    // running-pane bound is enforced machine-wide (across roots and
    // leader/instance restarts). Injected (default = real herdr CLI) so tests
    // can stub it without a live herdr session.
    getRunningDowntimePanes: runningPanesResolver,
    // Herdr list head (WL-0MTK1ILM2009QYB2): canonical ranking via fetcher → smart-selection → grouping.
    // The dispatcher treats this as the single ranking source; remaining safety gates are filters.
    // Callers pass the live sprint-view window (`browseItemCount`, clamped 1–50) so the head
    // equals the rendered worklist (WL-0MUNS8X97007C9H9 AC1). The fallback applies only to a
    // caller that passes no limit; it defaults to the sprint-view default so an unwindowed head
    // is never produced. `fetchNextItems` applies mandatory-always, browseItemCount windowing,
    // and regroupWorkItems grouping — the sole ranking path.
    getHerdrListHead: async (_cwd: string, limit?: number): Promise<import('./downtime-worker.js').DowntimeHerdrListResult> => {
      try {
        const items = await fetchNextItems(limit ?? defaultSettings.browseItemCount);
        return { ok: true, items };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
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
        const { stdout } = await withTransientRetry(() => getExecFileAsync()(
          'wl',
          buildWlArgs(['next', '--stage', stage, '-n', '10', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        ));
        const candidates = parseNextCandidatesOutput(stdout, stage);
        if (candidates === null) return { ok: false, error: `${stage} parse error` };
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
      } catch (err) {
        // Transient wl failure → fail closed to busy: no dispatch, and the
        // worker must NOT treat it as an empty backlog (no cooldown).
        // Capture error details for the three-strike pause log (WL-0MTL4PC0Y005GXTI).
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    // Code-freeze gate (WL-0MSQ0RPQP00636JY): fresh tri-state read of the
    // ship-it marker at `<cwd>/.worklog/code-freeze.json` on EVERY dispatch
    // (never cached). The dispatcher treats 'frozen' and 'ambiguous'
    // (fail-closed) identically: no audit/implement dispatch during a
    // release; plan/intake continue.
    readCodeFreezeStatus: (cwd: string) => readCodeFreezeStatusForRoot(cwd),
    // Host-CPU gate seam (WL-0MVK0UO3Q002TXW6 AC1/AC2): `/proc/stat` delta
    // utilisation with a 1-min load-average fallback, read fresh on every
    // dispatch tick. Fail-open: an unreadable/unparseable `/proc` resolves
    // `{ ok: false }` (via the sampler), so the gate never blocks a tick it
    // cannot evaluate.
    readHostCpu,
    async getNextAuditCandidate(cwd: string): Promise<DowntimeNextResult> {
      try {
        // Audit tier (WL-0MSI8H3HP000K0RG): select the first completed /
        // in_review item WITHOUT a valid audit so the producer-review queue
        // (the release gate) is drained during idle time. --root-only
        // (WL-0MSTLFW14000KPEC): only PARENT items are audit candidates —
        // completed/in_review children (sub-tasks) are never dispatched
        // independently; the producer reviews deliverable units (parents),
        // whose audits cover their children. Derived coverage
        // (WL-0MUBVH8QG0020H9L) is display-only and computed at read time by
        // isCoveredByParent/stageDisplayIcon; it never relaxes this root-only
        // dispatch contract. selectAuditCandidate adds a belt-and-suspenders
        // parentId exclusion so a leaking response can never dispatch a
        // child either. Same fail-closed semantics as
        // getNextItem, with the same error channel
        // (WL-0MSLWJ2KP0002SV0): a wl/parse failure resolves {ok:false} — a
        // CLI-error strike — NOT a null that is indistinguishable from a
        // genuinely empty audit tier. The bounded timeout
        // (WL-0MSJIPHD0001L1J9) applies here too.
        const { stdout } = await withTransientRetry(() => getExecFileAsync()(
          'wl',
          buildWlArgs(['list', '--status', 'completed', '--stage', 'in_review', '--root-only', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        ));
        const candidates = parseAuditCandidatesOutput(stdout);
        if (candidates === null) return { ok: false, error: `audit parse error` };
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
      } catch (err) {
        // Fail-closed: a wl failure yields a CLI-error outcome, never a
        // candidate and never a null that looks like an empty tier — the
        // caller counts it as a strike (WL-0MSLWJ2KP0002SV0).
        // Capture error details for the three-strike pause log (WL-0MTL4PC0Y005GXTI).
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async getActiveAudit(cwd: string): Promise<DowntimeActiveAuditResult> {
      try {
        // Host-wide audit serialisation (WL-0MUIVE0YG000UVIA): FIRST check
        // the machine-wide active-audit marker at
        // `~/.herdr/downtime/active-audit`. This coordinates audits ACROSS
        // projects and herdr instances on the same host — the per-worklog
        // check below cannot see audits dispatched by other projects'
        // dispatchers, which is what allowed host-wide saturation
        // (2026-09-26 incident). A non-stale marker means an audit is
        // running somewhere on this host; defer this audit. A stale marker
        // (older than DOWNTIME_AUDIT_HOST_STALE_WINDOW_MS) is treated as
        // released. Fail-open: if the coordination dir cannot be resolved
        // the host-wide check is skipped and the per-worklog check below
        // still runs (the legacy behaviour is preserved).
        const coordinationDir = getMachineCoordinationDir();
        if (coordinationDir !== null && isHostAuditActive(coordinationDir)) {
          // Host-wide saturation: an audit is active on this host
          // (dispatched by another instance/project). Report with source
          // so the worker can log 'audit-host-saturated' specifically.
          return { ok: true, active: true, source: 'host-wide' };
        }
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
          // (no worklog query needed). Source is per-worklog.
          return { ok: true, active: false, source: 'per-worklog' };
        }
        // Intersect with the worklog's in_progress items: a marker only
        // counts as an ACTIVE audit while its item is still in_progress
        // (dispatched but not yet completed/reviewed — the audit pane
        // transitions the item when it finishes). The bounded timeout
        // (WL-0MSJIPHD0001L1J9) kills a hung wl child.
        const { stdout } = await withTransientRetry(() => getExecFileAsync()(
          'wl',
          buildWlArgs(['list', '--status', 'in_progress', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        ));
        const inProgress = parseInProgressOutput(stdout);
        if (inProgress === null) {
          // Unparseable query → the check cannot complete → fail-open.
          return { ok: false, error: 'in_progress parse error' } as const;
        }
        const active = [...auditCandidateIds].some((id) => inProgress.has(id));
        return { ok: true, active, source: 'per-worklog' };
      } catch (err) {
        // Fail-open: a wl failure yields {ok:false} — the dispatcher skips
        // the audit tier and falls through to the next tier; dispatch is
        // never blocked by an unanswerable check (fail-safe).
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    async getReviewQueueCount(cwd: string): Promise<number | null> {
      // Review-queue depth gate (WL-0MT2UQWOR007CYY9): count completed/in_review
      // root items via `wl list --status completed --stage in_review
      // --root-only --json`. Bounded by DOWNTIME_WL_TIMEOUT_MS so a hung wl
      // child fails closed (gate active → only critical implements). A
      // failure or unparseable output resolves to null (gate active),
      // consistent with the code-freeze "ambiguous ⇒ frozen" convention.
      //
      // Per-root targeting (WL-0MTTSWC1X005P4VD): the coordination leader
      // applies the gate to EACH offer's OWN worklog root — the count must
      // resolve against `cwd`'s database (stateless buildWlArgsForRoot), the
      // same convention as fetchItem, never the leader pane's module override.
      try {
        const { stdout } = await withTransientRetry(() => getExecFileAsync()(
          'wl',
          buildWlArgsForRoot(cwd, [
            'list',
            '--status',
            'completed',
            '--stage',
            'in_review',
            '--root-only',
            '--json',
          ]),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        ));
        const items = extractItems(extractJson(stdout));
        return items.length;
      } catch {
        // Fail-closed: a wl error means the gate is active (only critical
        // implements remain eligible).
        return null;
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
        const { stdout } = await withTransientRetry(() => getExecFileAsync()(
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
        ));
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
        const { stdout } = await withTransientRetry(() => getExecFileAsync()(
          'wl',
          buildWlArgs(['list', '--priority', 'critical', '--status', 'open', '-n', '10', '--json']),
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        ));
        const candidates = parseCriticalCandidatesOutput(stdout);
        if (candidates === null) return { ok: false, error: `critical parse error` };
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
      } catch (err) {
        // Fail-closed: a wl failure yields a CLI-error outcome, never a
        // candidate and never a null that looks like an empty tier — the
        // caller counts it as a strike. Capture error for pause log.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    // Leader-coordination item fetch (parent WL-0MST3OJ8S0001ROL AC4):
    // resolve ONE item by id for the leader's per-entry tier
    // classification. `wl show` does not serve the audit timestamp, so for
    // completed/in_review items the audit tier's list query (which DOES
    // enrich auditedAt) is run against the entry's worklog root to attach
    // the freshness signal — otherwise an item with a valid audit could
    // be re-audited on classification alone. Fail-closed: {ok:false} on
    // any wl failure or unparseable output — the coordinator treats it as
    // a strike (never a silent skip).
    async fetchItem(itemId: string, cwd: string): Promise<DowntimeItemResult> {
      return fetchAuditItemById(itemId, cwd);
    },
    // Interim freshness re-check (WL-0MT8KSTOE00871E7): fetch the item and
    // check isAuditFresh to detect whether a valid audit was recorded in the
    // interim between candidate selection and dispatch.
    async hasFreshAudit(itemId: string, cwd: string): Promise<boolean> {
      try {
        const result = await fetchAuditItemById(itemId, cwd);
        if (!result.ok || !result.info) return false;
        return isAuditFresh(result.info.auditedAt, result.info.updatedAt);
      } catch {
        // Fail-closed: on any error, treat as "not fresh" (dispatch proceeds).
        return false;
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
    async claimItem(
      itemId: string,
      expected: DowntimeClaimExpected,
      cwd?: string,
      migrateStage?: string,
    ): Promise<DowntimeClaimResult> {
      // CAS claim (RCA WL-0MSRBFFLN005W3VT design point 1): the transition
      // only applies while the item is still in the state the tier selected
      // it in — exactly one concurrent pane wins. A stale result (another
      // pane claimed first) or any other claim failure ABORTS the dispatch
      // (no pane, no marker, no success record) and is never silently
      // discarded (WL-0MSLWJ310000ND0X absorbed): the outcome reason
      // ('claim-failed' / 'wl-error') is the durable observable, and the
      // failure detail is written to stderr like claimItemForAgentCommand.
      //
      // Cross-root (WL-0MTQ14W7L003II5A): `cwd` is the offer's worklog root
      // — the coordination leader claims offers in the offering instance's
      // OWN database. Without it the update fired at the leader's database
      // and a dispatchable foreign offer struck at claim time (the same
      // wrong-root failure as the fetch). Undefined → legacy behavior.
      // Retired-stage migration (WL-0MTYL7DX9000MZOH): `migrateStage`
      // advances a retired `in_progress`-stage item to the tier's target
      // stage atomically with the claim (see claimWorkItem).
      const result = await claimWorkItem(itemId, assignee, expected, cwd, migrateStage);
      if (result.success) return { ok: true };
      process.stderr.write(
        `[worklog-plugin] Downtime claim failed for ${itemId}: ` +
          `${result.error ?? 'unknown error'}` +
          `${result.stale ? ' (another pane won the claim race — dispatch aborted)' : ''}\n`,
      );
      return result.stale
        ? { ok: false, reason: 'stale', error: result.error }
        : { ok: false, reason: 'error', error: result.error ?? 'claim failed' };
    },
    async spawnAgentPane(
      prompt: string,
      opts: {
        model: string;
        cwd: string;
        paneName?: string;
        itemTitle?: string;
        itemId?: string;
        anchorId?: string;
        priority?: string | null;
        reservationTicketId?: string;
        /** Per-turn locality preference forwarded to the pane (C4-AC1). */
        localPreference?: LocalPreference;
      },
    ): Promise<DowntimeSpawnResult> {
      const kind = skillKindFromPrompt(prompt);
      return spawnDowntimePane(
        scriptPath,
        buildDowntimePaneArgs(kind, prompt, opts),
        {
          cwd: opts.cwd,
          priority: opts.priority,
          // Granted reservation ticket (slice C2 AC1): forwarded into the
          // pane process env beside the `--reservation-ticket` arg.
          ...(opts.reservationTicketId !== undefined
            ? { reservationTicketId: opts.reservationTicketId }
            : {}),
        },
        spawnFn,
      );
    },
    async recordDispatch(event: DowntimeDispatchEvent): Promise<boolean> {
      // 1. Durable trail: a comment on the item itself (survives wl sync).
      // The comment lands on the item in ITS OWN project's DB — targeted at
      // `event.cwd` (the dispatch root) via stateless buildWlArgsForRoot
      // (WL-0MTQ14W7L003II5A). The pre-fix code resolved via the module
      // override, so a coordination leader's foreign dispatch (cwd = the
      // offer's root ≠ the leader pane's root) commented the WRONG database
      // — the comment failed silently on a foreign prefix and the durable
      // item trail was lost. A comment failure is tolerated — the comment is
      // the durable cross-machine trail, not the marker. Scheduled-prompt
      // dispatches (noItemComment, AC4) have no work item — the comment is
      // skipped entirely (there is no item to comment on).
      if (!event.noItemComment) {
        try {
          await getExecFileAsync()(
            'wl',
            buildWlArgsForRoot(event.cwd, [
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
      } catch {
        // fail-closed: the marker could not be written → abort the dispatch
        return false;
      }
      // 3. Host-wide audit serialisation (WL-0MUIVE0YG000UVIA): write the
      // machine-wide active-audit marker when the durable per-worklog marker
      // landed. This coordinates audit serialisation ACROSS projects and
      // herdr instances on the same host. Fail-safe: the write is
      // best-effort — a failure does NOT abort the dispatch (the per-worklog
      // marker and stale window still protect against double-dispatch within
      // this project). Written AFTER the marker write so a failed marker
      // never leaves a host-wide lock behind with no corresponding dispatch;
      // a spawn failure releases it via `recordDispatchFailure`.
      if (event.kind === 'audit') {
        try {
          const coordinationDir = getMachineCoordinationDir();
          if (coordinationDir !== null) {
            // Identify the dispatching plugin process for diagnostics; the
            // marker's single-flight semantics do not depend on the id.
            writeActiveAuditMarker(coordinationDir, `herdr:${process.pid}`);
          }
        } catch {
          // fail-safe: marker write failure must never abort dispatch
        }
      }
      return true;
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
      // a pane that never appeared. The trace is a durable record but NOT an
      // exclusion marker: the dispatched-marker readers skip spawn-failed
      // entries (WL-0MT32F908002YFFA AC2), so the item becomes re-eligible
      // once its rolled-back claim lands it back in a selectable state.
      // Fail-closed: never crash the worker.
      try {
        await appendDowntimeLogEntry(
          event.cwd,
          JSON.stringify({ ...event, outcome: 'spawn-failed' }),
        );
      } catch {
        // fail-closed: audit logging must never crash the worker
      }
      // Host-wide audit serialisation (WL-0MUIVE0YG000UVIA): a failed audit
      // spawn never produced a running audit, so release the machine-wide
      // marker immediately instead of stranding the host slot for the full
      // stale window. Best-effort — the stale window remains the backstop.
      if (event.kind === 'audit') {
        try {
          const coordinationDir = getMachineCoordinationDir();
          if (coordinationDir !== null) {
            removeActiveAuditMarker(coordinationDir);
          }
        } catch {
          // fail-safe: marker removal failure must never crash the worker
        }
      }
    },
    async recordDispatchEnrichment(event: DowntimeDispatchEnrichmentEvent): Promise<void> {
      // Post-spawn enrichment (WL-0MUBVL251006JAQ0 / F6): append a second
      // rolling-log entry recording the resolved pane id, copying the marker
      // fields so the dispatched-marker readers see an unchanged marker. A
      // write failure is swallowed (fail-open) — the success marker already
      // stands; enrichment must never block or un-mark a dispatch.
      try {
        const { noItemComment: _omit, ...rest } = event;
        await appendDowntimeLogEntry(event.cwd, JSON.stringify(rest));
      } catch {
        // fail-open: enrichment logging must never crash the worker
      }
    },
    // Pane-lifecycle item state (WL-0MU308WSF0002JWN): resolve the current
    // state of a dispatched pane's item so the monitor can classify its
    // lifecycle outcome. Reuses the enriched `wl show` fetch (which now also
    // carries the top-level audit verdict). Fail-closed: a wl failure or an
    // unparseable item resolves null (the monitor then takes no action for
    // that pane). Never throws.
    async getItemLifecycleState(itemId: string, cwd: string) {
      try {
        const result = await fetchAuditItemById(itemId, cwd);
        if (!result.ok || !result.info) return null;
        const info = result.info;
        return {
          id: info.id,
          title: info.title,
          status: info.status,
          stage: info.stage,
          risk: info.risk,
          effort: info.effort,
          auditedAt: info.auditedAt,
          auditResult: info.auditResult,
          needsProducerReview: info.needsProducerReview,
        };
      } catch {
        return null; // fail-closed: an unreadable item is never acted upon
      }
    },
    // Close a dispatched pane (WL-0MU308WSF0002JWN): `herdr pane close
    // <paneId>`. Fail-closed: any herdr failure resolves false and the
    // monitor still records the lifecycle outcome with `closed:false`.
    //
    // Safety (WL-0MU4US5MP001JFEN AC7): when the dispatch context is
    // supplied, verify the LIVE pane's label is a downtime pane whose
    // item-id suffix matches THIS dispatch BEFORE closing — a stale entry
    // must never close an unrelated/operator pane whose pane id collides.
    async closePane(
      paneId: string,
      _cwd: string,
      expected?: { itemId: string; kind: string },
    ): Promise<boolean> {
      try {
        const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
        if (expected) {
          const { stdout } = await getExecFileAsync()(
            herdrBin,
            ['pane', 'list'],
            { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
          );
          const panes = parseHerdrPaneListOutput(stdout);
          // Only ever close a downtime pane for THIS item (AC7). A missing
          // record (pane already gone) or a mismatched label means we must
          // NOT close (never an unrelated/operator pane id collision).
          if (panes === null || !isSafeDowntimePaneToClose(panes, paneId, expected.itemId)) {
            return false;
          }
        }
        await getExecFileAsync()(
          herdrBin,
          ['pane', 'close', paneId],
          { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS },
        );
        return true;
      } catch {
        return false; // fail-closed: a failed close must never crash the worker
      }
    },
    // Record a pane-close lifecycle entry in the rolling dispatch log
    // (WL-0MU308WSF0002JWN). Fail-closed: `appendPaneCloseLogEntry` never
    // throws.
    async recordPaneClose(entry, cwd: string): Promise<void> {
      // Host-wide audit serialisation (WL-0MUIVE0YG000UVIA): when an audit
      // pane completes (audit-passed or audit-failed), release the
      // machine-wide active-audit marker so other instances can dispatch.
      // Fail-safe: best-effort only — a removal failure must never crash the
      // worker. The stale window provides a safety net if the removal fails.
      if (
        entry.kind === 'audit' &&
        (entry.outcome === 'audit-passed' || entry.outcome === 'audit-failed')
      ) {
        try {
          const coordinationDir = getMachineCoordinationDir();
          if (coordinationDir !== null) {
            removeActiveAuditMarker(coordinationDir);
          }
        } catch {
          // fail-safe: marker removal failure must never crash worker
        }
      }
      await appendPaneCloseLogEntry(cwd, entry);
    },
    // Scheduled pane-close reaper (WL-0MUJL1NAH0042GOS): classify and close
    // settled/abandoned pi panes out-of-process. Fail-closed: the runner
    // never throws (the worker catches anyway); settings gate it upstream.
    async runPaneCloseReaper(
      cwd: string,
      opts: { idleThresholdMinutes: number; ledgerPath?: string },
    ): Promise<void> {
      const herdrBin = process.env.HERDR_BIN_PATH ?? 'herdr';
      const invokingPaneId =
        process.env.HERDR_PANE_ID ?? process.env.HERDR_PANE ?? undefined;
      const deps = createHerdrReaperDeps({
        listPanesRaw: async () => {
          const { stdout } = await getExecFileAsync()(herdrBin, ['pane', 'list'], {
            encoding: 'utf8',
            timeout: DOWNTIME_WL_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
          });
          return stdout;
        },
        closePane: async (paneId: string) => {
          try {
            await getExecFileAsync()(herdrBin, ['pane', 'close', paneId], {
              encoding: 'utf8',
              timeout: DOWNTIME_WL_TIMEOUT_MS,
            });
            return true;
          } catch {
            return false; // fail-closed: a failed close is recorded, never thrown
          }
        },
        invokingPaneId,
        // Item lookup (parent AC2/AC6): fetch both the producer-review flag
        // and the work-item stage so the close-decision snapshot records the
        // stage. Fail-closed: an unreadable item stays review-blocked.
        getItemInfo: async (itemId: string) => {
          const { stdout } = await getExecFileAsync()(
            'wl',
            ['show', itemId, '--json'],
            { encoding: 'utf8', timeout: DOWNTIME_WL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, cwd },
          );
          const parsed = extractJson(stdout) as {
            workItem?: { needsProducerReview?: boolean; stage?: string };
          };
          return {
            needsProducerReview: parsed?.workItem?.needsProducerReview === true,
            stage: parsed?.workItem?.stage,
          };
        },
        // Live-child probe (parent AC1/AC3): count foreground processes in
        // the pane other than the agent itself via `herdr pane process-info`.
        // Fail-closed: an unreadable/failed lookup yields 0.
        childProcessCount: async (pane) => {
          try {
            const { stdout } = await getExecFileAsync()(
              herdrBin,
              ['pane', 'process-info', '--pane', pane.paneId],
              {
                encoding: 'utf8',
                timeout: DOWNTIME_WL_TIMEOUT_MS,
                maxBuffer: 4 * 1024 * 1024,
                cwd,
              },
            );
            return countSpawnedChildProcesses(parsePaneProcessInfo(stdout));
          } catch {
            return 0; // fail-closed: no evidence of spawned children
          }
        },
        // Recent file-modification probe (parent AC3): scan the pane's
        // workspace for files changed within the activity window. Fail-closed
        // on an unreadable directory.
        hasRecentFileModifications: (pane) =>
          dirHasRecentModifications(pane.foregroundCwd ?? pane.cwd),
      });
      const result = await runScheduledPaneClose(
        deps,
        {
          paneCloseEnabled: true,
          paneCloseIdleThresholdMinutes: opts.idleThresholdMinutes,
          paneCloseGracePeriodMinutes: settings.paneCloseGracePeriodMinutes,
        },
        {
          ledgerPath: opts.ledgerPath ?? join(cwd, '.worklog', 'pane-close-ledger.jsonl'),
          // Coexistence with the dispatch monitor (WL-0MU308WSF0002JWN): a
          // pane the monitor already closed (recorded in the rolling log with
          // `closed:true`) is never handled a second time. `readDowntimeLogEntries`
          // is fail-safe (returns [] on any error).
          alreadyClosedPaneIds: await readClosedPaneIds(cwd),
        },
      );
      if (result.error) {
        process.stderr.write(`[worklog-plugin] Pane-close reaper: ${result.error}\n`);
      }
    },
    async rollbackClaim(
      itemId: string,
      original: DowntimeClaimExpected,
      cwd: string,
    ): Promise<boolean> {
      // Marker-write / spawn recovery (WL-0MT32F908002YFFA AC1/AC2): reverse
      // a CAS claim whose dispatch never completed — restore the item to its
      // pre-claim status+stage so a future idle period can re-select it.
      // Race-safe (--if-status in_progress) and fail-closed (never throws).
      //
      // Status-neutral audit-tier rollback (WL-0MV85WCJJ0087VMP): the audit
      // claim never flips status/stage, so the rollback must not rewrite
      // them either — it clears only the claiming agent's assignee, guarded
      // by `--if-assignee <agent>`. Every other tier keeps the legacy
      // status/stage restore and ALSO clears this claim's assignee
      // (WL-0MV85WD400091OZ6), so a failed dispatch never leaves a non-empty
      // assignee (a scheduling hold) behind.
      return rollbackClaimWorkItem(
        itemId,
        { ...original, assignee },
        cwd,
      );
    },
    // Producer-review flag (WL-0MUKYEXMK0033MFK AC3): set
    // `needsProducerReview = true` when an item exhausts its automatic
    // dispatch-attempt budget so it surfaces for human triage. Cross-root
    // (`cwd` is the item's worklog root) and fail-closed (never throws).
    async markNeedsProducerReview(itemId: string, cwd: string): Promise<boolean> {
      return markNeedsProducerReviewWorkItem(itemId, cwd);
    },
    // Stalled-work scan + in-place resume (WL-0MUYMBSA90092QV2): production
    // wiring reuses the machine-wide `herdr pane list` read, the `wl show`
    // fetch and the rolling dispatch log. The scan returns resumable
    // candidates in pane-list order (each carrying its OWN root); the resume
    // prompts/relaunches in place and records an attempt. Both seams are
    // fail-safe — an unreadable scan or a thrown resume degrades to normal
    // dispatch (never a crash, never a duplicate).
    async scanStalledPanes(
      cwd: string,
      opts: StalledScanOptions,
    ): Promise<StalledPaneCandidate[]> {
      return scanStalledPanes(
        {
          listPanes: defaultStalledPanesLister,
          fetchItem: fetchAuditItemById,
          readEntries: readDowntimeLogEntries,
          resolveRoot: defaultStalledPaneRootResolver,
          // Bounded model-cooldown wake (WL-0MV5639GG00085Q7): the machine-wide
          // signal is read once per scan; a due entry lets the scan offer a
          // cooldown candidate that bypasses the generic stall threshold.
          readStoredModelCooldowns: async () => readStoredModelCooldowns(),
        },
        cwd,
        opts,
      );
    },
    // Long-running pane detection (WL-0MVKNC2N50025HXE AC2): reuses the same
    // machine-wide seams as the stalled scan (pane list, wl show, rolling
    // log, root resolver). Used ONLY to annotate a capacity-starvation signal
    // with the panes holding the local model — observation only, never a
    // resume/close. Fail-safe: the scan resolves [] on any failure.
    async scanLongRunningPanes(
      cwd: string,
      opts: LongRunningScanOptions,
    ): Promise<LongRunningPaneObservation[]> {
      return scanLongRunningPanes(
        {
          listPanes: defaultStalledPanesLister,
          fetchItem: fetchAuditItemById,
          readEntries: readDowntimeLogEntries,
          resolveRoot: defaultStalledPaneRootResolver,
        },
        cwd,
        opts,
      );
    },
    async resumeStalledPane(candidate: StalledPaneCandidate, opts: StalledScanOptions) {
      return resumeStalledPane(
        {
          pane: candidate.pane,
          item: candidate.item,
          cwd: candidate.cwd,
          kind: candidate.kind,
          nonTerminalCooldownMs: opts.nonTerminalCooldownMs,
          thresholdMs: opts.thresholdMs,
          modelCooldown: candidate.modelCooldown,
        },
        {
          promptAgent: defaultStalledResumePromptAgent,
          startAgent: defaultStalledResumeStartAgent,
          readEntries: readDowntimeLogEntries,
          recordAttempt: async (root, entry) => {
            await appendDowntimeLogEntry(root, JSON.stringify(entry));
          },
          markNeedsProducerReview: async (itemId, root) =>
            markNeedsProducerReviewWorkItem(itemId, root),
          // Consume the marker on a successful resume so the same pane is
          // not re-woken on the next cycle (WL-0MV5639GG00085Q7).
          clearCooldown: async (paneId) => clearStoredModelCooldown(paneId),
          maxAttempts: opts.maxAttempts,
        },
      );
    },
  };
}

export async function main(): Promise<void> {
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

  // Production deps for the selection list's tab-based active marker
  // (WL-0MV1BWETT005GSUJ): an item with an exact-match tab in this workspace
  // is rendered as in-progress even when its worklog status is still `open`.
  // Uses the same `herdr tab list --workspace <id>` lookup as the hydrator.
  const hydratorDeps = createProductionHydratorDeps();
  const hydratorWorkspaceId = process.env.HERDR_WORKSPACE_ID ?? undefined;

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
  // Smart selection (see fetchNextItems) guarantees all critical,
  // in_review and actively-worked in-progress items are always shown,
  // regardless of the count (WL-0MV6KV22S004NYIU).
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
      // The pane-existence marker (in-progress status + green-circle icon)
      // is applied by the worklist's `applyPaneMarkers` seam on the initial
      // load and every refresh (WL-0MV1BWETT005GSUJ); no separate
      // agent-state merge runs here.
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

  // Machine-wide coordination directory shared by the downtime leader
  // election (WL-0MU6MXCZZ007ZXT9, AC2). HERDR_COORDINATION_DIR override
  // wins; default ~/.herdr/downtime/.
  const coordinationDir = getMachineCoordinationDir() ?? join(targetCwd, '.worklog');

  // Local capacity reservation client (parent WL-0MVIKRFP0005JDL8, slice
  // C2): `POST {proxyUrl}/llama/local/reserve` on the existing poll cadence.
  // Wired here rather than into `createDowntimeDeps` so the proxy URL comes
  // from the SAME `runSettings` snapshot as the status poller (a settings
  // change applies on restart, exactly like the poller). Fail-open by
  // construction: an older proxy answers 404 → the client resolves null and
  // dispatch behaves exactly as before.
  const downtimeDeps = createDowntimeDeps(SEND_TO_PI_SCRIPT, AGENT_ASSIGNEE);
  downtimeDeps.reserveLocalCapacity = createLocalReserver(runSettings.downtimeProxyUrl);

  const downtimeWorker: DowntimeWorker = createDowntimeWorker({
    poller: createDowntimePoller(runSettings.downtimeProxyUrl),
    deps: downtimeDeps,
    registry: createRoundRobinRegistry({
      worklogDir: join(targetCwd, '.worklog'),
    }),
    // Leader-election + coordination refactor (parent WL-0MTF0KLO10043YAN
    // F3): single machine-wide coordination dir — one election, one lease
    // machine-wide. HERDR_COORDINATION_DIR override wins; default is
    // ~/.herdr/downtime/. The per-worklog join(targetCwd, '.worklog')
    // coupling is retired (F6). The instance id is auto-generated at
    // worker construction (stable for the process lifetime).
    coordinationDir,
    config: () => {
      const s = loadSettings();
      return {
        enabled: s.downtimeEnabled,
        thresholdMs: s.downtimeIdleThresholdMs,
        requiredFreeSlots: s.downtimeRequiredFreeSlots,
        // NOTE (WL-0MU2EP6JL006A1U3): no `maxRunningPanes` — there is no
        // client-side cap on dispatched panes. Panes stay open until an
        // operator closes them and the local LLM idle / free-slot check is
        // the concurrency limiter.
        model: s.downtimeModel,
        cwd: targetCwd,
        // Per-turn locality preference (slice C4 AC1), forwarded to every
        // dispatched pane as `HERDR_LOCAL_PREFERENCE`. The extension turns it
        // into the `X-Local-Preference` header and records the route log.
        localPreference: s.downtimeLocalPreference,
        // Locality precedence (WL-0MVNUIW77000VYAX AC2/AC4): an explicitly
        // persisted `downtimeLocalPreference` is the operator's policy and
        // wins for every dispatch; when the key is absent the dispatch
        // boundary may apply the low-priority rule (`low` → `local-preferred`,
        // everything else → the deployment default). Explicitness is derived
        // by `loadSettings` and never persisted (AC3).
        localPreferenceMode: s.downtimeLocalPreferenceExplicit
          ? 'operator-setting'
          : 'priority-rule',
        noCandidateCooldownMs: s.downtimeNoCandidateCooldownMs,
        // Non-terminal pane-close cooldown (WL-0MUKYERLZ006ELL5).
        nonTerminalCooldownMs: s.downtimeNonTerminalCooldownMs,
        // Per-item/per-kind dispatch-attempt cap (WL-0MUKYEXMK0033MFK).
        maxAttempts: s.downtimeMaxAttempts,
        // Depth-aware audit-batch cap (parent WL-0MVEDM8OT007WDRS AC1):
        // re-read each tick like browseItemCount/maxAttempts so a settings
        // change applies without a plugin restart.
        auditBatchMax: s.downtimeAuditBatchMax,
        // Dispatched success-marker staleness window (WL-0MU6UL0RJ008IHGT).
        markerStaleWindowMs: s.downtimeMarkerStaleWindowMs,
        // Stalled-work scan before new-item selection (WL-0MUYMBSA90092QV2).
        stallScanEnabled: s.downtimeStallScanEnabled,
        stallScanThresholdMs: s.downtimeStallThresholdMs,
        // Capacity-starvation observability (WL-0MVKNC2N50025HXE): the window
        // of continuous capacity refusal before a `capacity-starved` signal is
        // written, and the progress window used to name the panes holding the
        // model. Both are re-read each tick (live).
        capacityStarvationAlertMs: s.downtimeCapacityStarvationAlertMs,
        longRunningThresholdMs: s.downtimeLongRunningThresholdMs,
        // Host-CPU dispatch gate (WL-0MVK0UO3Q002TXW6 AC5): re-read each tick
        // like the other downtime settings, so a threshold change (or `0` to
        // disable) applies without a plugin restart.
        cpuGatePercent: s.downtimeCpuGatePercent,
        browseItemCount: s.browseItemCount,
        // Scheduled pane-close reaper (WL-0MUJL1NAH0042GOS): gated by the
        // `paneCloseEnabled` setting (default on) with a configurable
        // `paneCloseIdleThresholdMinutes` (default 30). The worker only
        // invokes the reaper when enabled; disabling yields zero closes.
        paneClose: {
          enabled: s.paneCloseEnabled ?? true,
          idleThresholdMinutes: s.paneCloseIdleThresholdMinutes ?? 30,
        },
      };
    },
  });

  const selectedItem = await runWorklistTui(
    fetcher,
    undefined,
    shortcutRegistry,
    {
      autoRefresh: runSettings.autoRefresh,
      refreshIntervalMs: runSettings.refreshIntervalMs,
      autoSync: runSettings.autoSync,
      syncIntervalMs: runSettings.syncIntervalMs,
      browseItemCount: clampBrowseItemCount(runSettings.browseItemCount ?? defaultSettings.browseItemCount),
      cwd: targetCwd,
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
      // Pane-based active marker (WL-0MV1BWETT005GSUJ): stamp `in-progress`
      // AND the green-circle icon on items whose work-item ID appears in a
      // current-workspace pane title, so the selection list's marker and
      // green circle both reflect pane existence (the producer's rule: a
      // pane with the work item id as the title means the item is being
      // worked; the green circle appears exactly when such a pane is open
      // and never otherwise). The event-driven agent-state merge
      // (WL-0MSBQUJQX005RAT9) is no longer used for row icons. Fail-open.
      applyActivePaneMarkers: (items) =>
        applyActivePaneMarkers(items, hydratorDeps.listActivePanes, hydratorWorkspaceId),
      subscriber: eventSubscriber,
      agentTracker,
      maxSyncStalenessMs: runSettings.maxSyncStalenessMs,
      onCommand: async (command: string, model?: string, openPane?: boolean, onRefresh?: () => Promise<void>, paneTitle?: string, focus?: boolean) => {
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
        // Interactive item-ID tab placement (WL-0MUYI3JAO002BTNL, parent
        // WL-0MUKZGEQ2007FECS): when a pane will open for a command that
        // carries a work-item ID, resolve the item-ID tab anchor ONCE — the
        // tab labelled exactly `<itemId>` in the invoking pane's current
        // workspace — and forward it to the pane-spawning scripts so the pane
        // is co-located with that item's other panes. Resolution is fail-open:
        // no ID, no workspace, or any resolution/creation failure yields
        // `undefined`, so the scripts keep today's current-pane split (AC5).
        const interactiveItemId = shouldOpenPane ? extractWorkItemId(command) : undefined;
        // Create-vs-reuse signal (WL-0MUYI3K8H007MPKF, AC7): populated only
        // when resolveInteractiveItemAnchor PROVISIONED the item tab. A reused
        // tab leaves this null, so a reused live anchor is never considered
        // for cleanup. Combined with the fail-safe liveness gate below, a live
        // pane is never closed.
        let createdItemTabAnchor: ItemTabAnchor | null = null;
        const interactiveAnchor =
          interactiveItemId !== undefined
            ? await resolveInteractiveItemAnchor(
                targetCwd,
                resolveInteractiveWorkspaceId(process.env) ?? '',
                interactiveItemId,
                undefined,
                (anchor) => { createdItemTabAnchor = anchor; },
              )
            : null;
        // Fail-safe placeholder root-pane cleanup (WL-0MUYI3K8H007MPKF, AC7):
        // only ever runs after a CONFIRMED successful split (the spawning
        // script writes its pane-id file right after the split) and only when
        // THIS dispatch provisioned the item tab. All errors are swallowed by
        // closeInteractiveTabRootPane — the dispatch outcome never changes.
        const runInteractiveRootPaneCleanup = (): Promise<void> =>
          createdItemTabAnchor !== null
            ? closeInteractiveTabRootPane(
                createdItemTabAnchor.paneId,
                { cwd: targetCwd },
                {
                  getLiveTrackedPanes: defaultInteractiveLiveTrackedPanesResolver,
                  closePane: defaultInteractiveClosePane,
                },
              )
            : Promise.resolve();
        if (route === 'agent') {
          // Claim the referenced work-item BEFORE dispatching so it appears
          // in_progress immediately — for both the pane and the headless
          // (no-pane) path. Non-blocking: failures are logged to stderr and
          // never prevent the dispatch (AC2).
          try {
            await claimItemForAgentCommand(command);
          } catch {
            // Belt-and-suspenders: a claim failure must never block the pane.
          }
          // Request priority (WL-0MVE1NZ4J000H5NH AC2): resolve the
          // dispatched work item's priority and map it through the
          // interactive table. Fail-open — unresolvable (no id / lookup
          // error / timeout) → `high` — and bounded (2 s max) so a slow wl
          // call can never stall a dispatch.
          const requestPriority = await resolveInteractiveDispatchPriority(
            extractWorkItemId(command),
          );
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
              {
                onExit: (code, signal) => {
                  notifyBackgroundFailure(command, code, signal, logPath);
                  onRefresh?.();
                },
                requestPriority,
              },
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
          // Descriptive pane title (WL-0MSJ4E8UA005KG9Y): build the pane
          // name from the action descriptor + skill + selected item's
          // title/id, then pass it via --pane-name so the pi pane is
          // identifiable among other panes.
          const paneName = buildManuallyTriggeredPaneTitle(command, paneTitle, itemId);
          // Spawn send-to-pi.sh asynchronously — detached and with stdio ignored
          // so the TUI loop is not blocked or affected by the script's output.
          // The `model` from the shortcut entry (if any) is forwarded as
          // `--model <pattern>` so the pi CLI opens with the right model.
          const child = spawn(
            SEND_TO_PI_SCRIPT,
            buildSendToPiArgs(
              command,
              targetCwd,
              model,
              paneIdFile,
              paneName,
              focus,
              interactiveAnchor?.paneId,
              requestPriority,
            ),
            {
              detached: true,
              stdio: 'ignore',
              cwd: targetCwd,
              // The priority is forwarded via `--request-priority` and
              // injected by send-to-pi.sh with `exec env …`; setting it on
              // the script's own env is harmless belt-and-braces.
              env: {
                ...process.env,
                HERDR_RESOLVED_CWD: targetCwd,
                [REQUEST_PRIORITY_ENV_VAR]: requestPriority,
              },
            },
          );
          child.unref(); // Allow the parent to exit independently
          if (itemId && paneIdFile) {
            // Fire-and-forget: polling must never block the TUI loop. A
            // missing file (split failed) is a no-op — no entry recorded.
            // Once the pane id is captured (proving the split succeeded) the
            // freshly-created item tab's placeholder root pane is closed
            // (fail-safe; WL-0MUYI3K8H007MPKF, AC7).
            void capturePaneIdFromFile(itemId, paneIdFile, (wid, pid) =>
              agentTracker.recordAgentForWorkItem(wid, pid, command),
            ).then((capturedPaneId) => {
              if (capturedPaneId !== undefined) return runInteractiveRootPaneCleanup();
            });
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
              {
                onExit: (code, signal) => {
                  notifyBackgroundFailure(clean, code, signal, logPath);
                  onRefresh?.();
                },
              },
            );
            return;
          }
          // Descriptive pane title (WL-0MSJ4E8UA005KG9Y): replace the
          // generic "Command Output" with something identifying the command
          // and its work item.
          const shellItemId = extractWorkItemId(clean);
          const shellPaneName = buildShellPaneTitle(clean, paneTitle, shellItemId);
          // Split-confirmation channel for the cleanup below: only requested
          // when a fresh item tab needs its placeholder root pane closed.
          const shellPaneIdFile = createdItemTabAnchor
            ? join(tmpdir(), `herdr-pane-${process.pid}-${Date.now()}-shell.json`)
            : undefined;
          const child = spawn(
            RUN_IN_PANE_SCRIPT,
            buildRunInPaneArgs(clean, targetCwd, shellPaneName, focus, interactiveAnchor?.paneId, shellPaneIdFile),
            {
              detached: true,
              stdio: 'ignore',
              cwd: targetCwd,
              env: { ...process.env, HERDR_RESOLVED_CWD: targetCwd },
            },
          );
          child.unref(); // Allow the parent to exit independently
          if (shellPaneIdFile) {
            void capturePaneIdFromFile(shellItemId ?? '', shellPaneIdFile, () => {}).then(
              (capturedPaneId) => {
                if (capturedPaneId !== undefined) return runInteractiveRootPaneCleanup();
              },
            );
          }
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
              {
                onExit: (code, signal) => {
                  notifyBackgroundFailure(command, code, signal, logPath);
                  onRefresh?.();
                },
              },
            );
            return;
          }
          const plainItemId = extractWorkItemId(command);
          const plainPaneIdFile = createdItemTabAnchor
            ? join(tmpdir(), `herdr-pane-${process.pid}-${Date.now()}-shell.json`)
            : undefined;
          const child = spawn(
            RUN_IN_PANE_SCRIPT,
            buildRunInPaneArgs(command, targetCwd, buildShellPaneTitle(command, paneTitle, plainItemId), focus, interactiveAnchor?.paneId, plainPaneIdFile),
            {
              detached: true,
              stdio: 'ignore',
              cwd: targetCwd,
              env: { ...process.env, HERDR_RESOLVED_CWD: targetCwd },
            },
          );
          child.unref();
          if (plainPaneIdFile) {
            void capturePaneIdFromFile(plainItemId ?? '', plainPaneIdFile, () => {}).then(
              (capturedPaneId) => {
                if (capturedPaneId !== undefined) return runInteractiveRootPaneCleanup();
              },
            );
          }
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
