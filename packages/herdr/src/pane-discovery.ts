/**
 * packages/herdr/src/pane-discovery.ts — canonical dispatched-pane discovery
 * (WL-0MWHWH6XL0025YX2)
 *
 * Map pointer: the single pane-creation architecture map + naming contract
 * lives in `docs/dev/downtime-dispatcher.md` → *Pane creation architecture*.
 *
 * The single shared discovery module for dispatched-pane "list panes → filter
 * label → classify agent status" pipelines. Prior to this module the same
 * pipeline existed in four partial copies: `downtime-worker.pane.ts` (parse +
 * live count + item-scoped in-flight set + safe-close predicate),
 * `pane-close-herdr.ts` (the raw parse), `ship-guard.ts` (a blocking-pane
 * filter with its own liveness check) and `long-running-panes.ts`
 * (agent-presence + item-id discovery). A span of behaviour change (e.g. the
 * hydrator evidence fix, WL-0MWH56SWX004HSKQ) therefore touched four modules.
 *
 * What this module owns (AC1):
 *   - the raw `herdr pane list` JSON parse → per-pane record
 *     (`parseHerdrPaneCloseList` — the shared contract) and the
 *     discovery-facing record mapping (`parseHerdrPaneListOutput`);
 *   - the live/working predicates over a parsed record (`hasPaneAgent`,
 *     `isTerminalAgentStatus`, `isPaneAgentLive`, `isPaneWorking`) — the ONE
 *     liveness vocabulary shared by the in-flight resolution, the reaper and
 *     the ship guard (AC3);
 *   - the item-scoped in-flight item-id set (`runningDowntimePaneItemIds`);
 *   - the safe-close predicate (`isSafeDowntimePaneToClose`);
 *   - the blocking-pane filter (`findBlockingPanes`).
 *
 * Consumers delegate here: `downtime-worker.pane.ts` re-exports the
 * discovery surface (its call sites resolve through one name),
 * `pane-close-herdr.ts` parses + derives liveness from this module,
 * `ship-guard.ts` filters blocking panes here and `long-running-panes.ts`
 * uses `hasPaneAgent`. No consumer re-implements any discovery predicate.
 *
 * Pure: no filesystem, no herdr CLI, no wl — every input is injected, so the
 * predicates are trivially testable. Parse failures return `null` (callers
 * fail closed).
 */

import {
  extractWorkItemIdsFromText,
  isDowntimePaneLabel,
  paneItemIdFromLabel,
} from './pane-label.js';

// ── Raw herdr pane-list shape ─────────────────────────────────────────

/** The `agent_session` field of a `herdr pane list` record. */
export interface HerdrAgentSession {
  agent?: string;
  kind?: string;
  source?: string;
  value?: string;
}

/** One raw `herdr pane list` record (only the fields the consumers need). */
export interface HerdrPaneCloseRecord {
  pane_id?: string;
  paneId?: string;
  label?: string;
  /** `title` is accepted as a label fallback (camelCase herdr variant). */
  title?: string;
  agent?: string;
  agent_status?: string;
  agentStatus?: string;
  workspace_id?: string;
  workspaceId?: string;
  tab_id?: string;
  tabId?: string;
  agent_session?: HerdrAgentSession;
  agentSession?: HerdrAgentSession;
  cwd?: string;
  foreground_cwd?: string;
  foregroundCwd?: string;
  /** Focused flag (ambiguity signal for the anchor family). */
  focused?: boolean;
  is_focused?: boolean;
  isFocused?: boolean;
}

/** A parsed pane record normalised for the reaper and discovery consumers. */
export interface ParsedHerdrPane {
  paneId: string;
  label: string;
  agent?: string;
  agentStatus?: string;
  /** Session log path derived from `agent_session.value` (when present). */
  sessionPath?: string;
  /** Raw `agent_session` field (session log path + agent metadata). */
  agentSession?: HerdrAgentSession;
  workspaceId?: string;
  tabId?: string;
  /** Pane working directory, when reported (activity-probe input). */
  cwd?: string;
  /** Foreground process working directory, when reported. */
  foregroundCwd?: string;
  /** True when the pane is focused (ambiguity signal for the anchor family). */
  focused?: boolean;
}

/**
 * One parsed `herdr pane list` discovery record (only the fields liveness
 * needs). Canonical home of the discovery-facing record (WL-0MWHWH6XL0025YX2);
 * `downtime-worker.types.ts` re-exports it for consumers that import the
 * record from the types module.
 */
export interface HerdrPaneRecord {
  paneId: string;
  label?: string;
  agent?: string;
  agentStatus?: string;
  /**
   * Tab the pane lives in (from `tab_id` / `tabId`). Carried so consumers can
   * scope a liveness check to one tab without a second pane read — the ship
   * guard uses it to reject a second Ship command while a live pane occupies
   * the `Ship` tab (WL-0MW6FIZYI0003QEU).
   */
  tabId?: string;
  /** Pane working directory (worklog-root hint for cross-root resume). */
  cwd?: string;
  /** Raw `agent_session` field (session log path + agent metadata). */
  agentSession?: HerdrAgentSession;
}

/**
 * Locate the pane array in a raw `herdr pane list` response. Tolerates log
 * lines before the JSON envelope — including a bracketed prefix such as
 * `[herdr] starting` — the `{result:{panes:[…]}}` shape, a top-level `{panes}`
 * object and a bare array. Tries each plausible JSON start (`{` then `[`) and
 * returns the first payload that yields a pane array, so callers fail closed
 * (`null`) only when none does.
 */
function extractPaneArray(raw: string): unknown[] | null {
  const candidates: number[] = [];
  const brace = raw.indexOf('{');
  const bracket = raw.indexOf('[');
  if (brace >= 0) candidates.push(brace);
  if (bracket >= 0 && bracket !== brace) candidates.push(bracket);
  candidates.sort((a, b) => a - b);

  for (const start of candidates) {
    let payload: unknown;
    try {
      payload = JSON.parse(raw.slice(start));
    } catch {
      continue;
    }
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      const result = obj.result;
      const resultObj =
        result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
      if (Array.isArray(resultObj?.panes)) return resultObj.panes;
      if (Array.isArray(obj.panes)) return obj.panes;
    }
  }
  return null;
}

/**
 * Shared `herdr pane list` parser — the single parse contract used by the
 * pane-closure reaper (`pane-close-herdr.ts`), the downtime dispatcher
 * (`parseHerdrPaneListOutput` below) and every other discovery consumer
 * (WL-0MUYMBMCG000Z4WP; moved verbatim from `pane-close-herdr.ts` by
 * WL-0MWHWH6XL0025YX2 so the parse lives beside the predicates that consume
 * it). Tolerates log lines before the JSON envelope, the
 * `{result:{panes:[…]}}` / `{panes:[…]}` shapes and a bare array; returns
 * `null` when no pane array can be found (caller fails closed).
 */
export function parseHerdrPaneCloseList(raw: string): ParsedHerdrPane[] | null {
  const panes = extractPaneArray(raw);
  if (panes === null) return null;

  const parsed: ParsedHerdrPane[] = [];
  for (const entry of panes) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as HerdrPaneCloseRecord;
    const paneId = rec.pane_id ?? rec.paneId;
    if (typeof paneId !== 'string' || paneId === '') continue;
    const agentStatus =
      typeof rec.agent_status === 'string'
        ? rec.agent_status
        : typeof rec.agentStatus === 'string'
          ? rec.agentStatus
          : undefined;
    const session = rec.agent_session ?? rec.agentSession;
    const agentSession =
      session && typeof session === 'object' && !Array.isArray(session)
        ? (session as HerdrAgentSession)
        : undefined;
    const sessionPath =
      typeof agentSession?.value === 'string' && agentSession.value !== ''
        ? agentSession.value
        : undefined;
    parsed.push({
      paneId,
      label:
        typeof rec.label === 'string'
          ? rec.label
          : typeof rec.title === 'string'
            ? rec.title
            : '',
      agent: typeof rec.agent === 'string' ? rec.agent : undefined,
      agentStatus,
      sessionPath,
      agentSession,
      workspaceId:
        typeof rec.workspace_id === 'string'
          ? rec.workspace_id
          : typeof rec.workspaceId === 'string'
            ? rec.workspaceId
            : undefined,
      tabId:
        typeof rec.tab_id === 'string'
          ? rec.tab_id
          : typeof rec.tabId === 'string'
            ? rec.tabId
            : undefined,
      cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
      foregroundCwd:
        typeof rec.foreground_cwd === 'string'
          ? rec.foreground_cwd
          : typeof rec.foregroundCwd === 'string'
            ? rec.foregroundCwd
            : undefined,
      focused:
        rec.focused === true || rec.is_focused === true || rec.isFocused === true,
    });
  }
  return parsed;
}

// ── Discovery-facing record mapping ───────────────────────────────────

/**
 * Parse `herdr pane list` JSON output into the discovery-facing records.
 * Thin adapter over the shared {@link parseHerdrPaneCloseList} contract: the
 * reaper and the dispatcher must never drift into two parsers. Tolerates log
 * lines/prefixes before the JSON envelope, the `{result:{panes:[…]}}` /
 * `{panes:[…]}` shapes and a bare array. Returns `null` when no pane array can
 * be found (the caller treats this as a failed liveness query → fail-closed).
 *
 * Records carry the pane's `cwd` and raw `agent_session` alongside
 * `paneId`/`label`/`agent`/`agentStatus` so a stalled pane for an item in
 * another worklog root can be resumed against that root.
 *
 * Moved verbatim out of `downtime-worker.pane.ts` (WL-0MWHWH6XL0025YX2).
 */
export function parseHerdrPaneListOutput(raw: string): HerdrPaneRecord[] | null {
  const parsed = parseHerdrPaneCloseList(raw);
  if (parsed === null) return null;
  return parsed.map((pane) => ({
    paneId: pane.paneId,
    label: pane.label,
    agent: pane.agent,
    agentStatus: pane.agentStatus,
    // Only present when herdr reported a tab id; omitting it keeps the record
    // shape byte-identical for every existing consumer/test (WL-0MW6FIZYI0003QEU).
    ...(pane.tabId !== undefined ? { tabId: pane.tabId } : {}),
    cwd: pane.cwd,
    agentSession: pane.agentSession,
  }));
}

// ── Live / working predicates (AC3: ONE liveness vocabulary) ─────────

/**
 * True when the record carries a non-empty `agent` (a pi session is attached
 * to the pane). The agent-presence half of the shared liveness check —
 * shared with `long-running-panes.ts` and `stalled-work.ts`, whose
 * "no-agent" guards are exactly `!hasPaneAgent`.
 */
export function hasPaneAgent(rec: { agent?: string }): boolean {
  return typeof rec.agent === 'string' && rec.agent.length > 0;
}

/**
 * True when an agent status means the agent session has ended
 * (`done` / `exited`). The shared terminal-status vocabulary: every
 * consumer's "is the agent still live?" check uses this so a new terminal
 * status lands once (AC3). An empty/unknown status is NOT terminal — the
 * consumers decide how to treat "unknown" (see {@link isPaneAgentLive}).
 */
export function isTerminalAgentStatus(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase();
  return s === 'done' || s === 'exited';
}

/**
 * Shared liveness predicate (AC3): a pane is LIVE when it hosts a present
 * agent whose status is not terminal. Empty/unknown status counts as LIVE
 * (fail-open for the dispatch/ship consumers: never over-dispatch on a
 * duplicate, never enter ship mode against a possibly-live pane).
 *
 * This is the single "live" definition the in-flight resolution, the reaper
 * and the ship guard share. The reaper additionally treats an EMPTY status as
 * not-alive (its own deliberate fail-closed guard — see
 * `pane-close-herdr.ts::createHerdrReaperDeps`); every other consumer uses
 * this predicate unchanged.
 */
export function isPaneAgentLive(rec: { agent?: string; agentStatus?: string }): boolean {
  return hasPaneAgent(rec) && !isTerminalAgentStatus(rec.agentStatus);
}

/**
 * Working predicate: a pane whose agent is present AND currently `working`
 * (the agent is actively running its dispatch). An idle/blank/unknown status
 * is NOT working — the item-scoped in-flight guard must never deadlock the
 * item's next tier on a pane that spawned but whose agent has not started (or
 * has finished but not exited). Shared by {@link runningDowntimePaneItemIds}
 * (the in-flight set) and available to any consumer that needs the working
 * boundary.
 */
export function isPaneWorking(rec: { agent?: string; agentStatus?: string }): boolean {
  return hasPaneAgent(rec) && (rec.agentStatus ?? '').toLowerCase() === 'working';
}

// ── Counts / sets (moved from `downtime-worker.pane.ts`) ──────────────

/**
 * Count LIVE downtime dispatched panes in a `herdr pane list` record set: a
 * pane is a running downtime pane when its label starts with the downtime
 * prefix AND it currently hosts a live agent (see {@link isPaneAgentLive}).
 * Terminal agent statuses (`done` / `exited`) and panes whose agent has
 * already left are NOT counted.
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
    if (!isDowntimePaneLabel(pane.label)) continue;
    if (!isPaneAgentLive(pane)) continue;
    running.push(pane.paneId);
  }
  return running;
}

/**
 * Safe-close predicate (WL-0MU4US5MP001JFEN AC7): true ONLY when a LIVE herdr
 * pane record exists for `paneId`, its label is a downtime pane label
 * (the `DOWNTIME_PANE_LABEL_PREFIX` predicate) AND its item-id suffix equals
 * `itemId`.
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
  if (!isDowntimePaneLabel(label)) return false;
  return paneItemIdFromLabel(label) === itemId;
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
 *  - it hosts a live agent (see {@link isPaneAgentLive}),
 *  - its agent status is `working` — the agent is actively running the
 *    dispatch (see {@link isPaneWorking}); idle/blank/unknown statuses are
 *    NOT treated as working, so a pane that spawned but whose agent has not
 *    yet started (or has finished but not exited) must never deadlock the
 *    item's next tier,
 *  - and its label suffix parses to a work-item id.
 *
 * Consumed ONLY by the critical-first in-flight guard: it prevents a duplicate
 * dispatch for an item whose pane is already working — never a capacity gate.
 */
export function runningDowntimePaneItemIds(panes: HerdrPaneRecord[]): Set<string> {
  const inFlight = new Set<string>();
  for (const pane of panes) {
    if (typeof pane.label !== 'string') continue;
    if (!isDowntimePaneLabel(pane.label)) continue;
    if (!isPaneWorking(pane)) continue;
    const itemId = paneItemIdFromLabel(pane.label);
    if (itemId !== '') inFlight.add(itemId);
  }
  return inFlight;
}

// ── Blocking-pane filter (moved from `ship-guard.ts`) ─────────────────

/**
 * One pane that blocks ship mode: it carries a project work-item ID in its
 * label and hosts a live agent. Defined here (not in `ship-guard.ts`) so the
 * filter and its record type live beside the discovery predicates that back
 * them (WL-0MWHWH6XL0025YX2 AC1); `ship-guard.ts` re-exports the type.
 */
export interface BlockingPane {
  /** The pane's unique identifier. */
  paneId: string;
  /** The pane's label (may be undefined). */
  label?: string;
  /** The work-item ID from this pane's label that matches the project. */
  workItemId: string;
}

/**
 * The blocking-pane filter: every parsed pane whose label carries one of
 * `projectIds` (via the shared `extractWorkItemIdsFromText` scan) AND whose
 * agent is live (see {@link isPaneAgentLive}). Panes with no agent, or a
 * terminal agent status (`done` / `exited`), do NOT block.
 *
 * Moved verbatim from `ship-guard.ts::listBlockingPanes`' filter body
 * (WL-0MWHWH6XL0025YX2) — the ship guard now delegates here instead of
 * re-implementing the label scan + liveness check.
 *
 * @param records    Parsed pane records (from `parseHerdrPaneListOutput`).
 * @param projectIds Set of work-item IDs of the current project's worklog.
 */
export function findBlockingPanes(
  records: readonly HerdrPaneRecord[],
  projectIds: ReadonlySet<string>,
): BlockingPane[] {
  const blocking: BlockingPane[] = [];
  for (const rec of records) {
    // Check for a project work-item ID in the pane label.
    const labelIds = extractWorkItemIdsFromText(rec.label ?? '');
    const matchingId = labelIds.find((id) => projectIds.has(id));
    if (matchingId === undefined) continue; // No project ID in this pane.

    // Check agent liveness: the agent must be present and not terminal.
    if (!isPaneAgentLive(rec)) continue;

    blocking.push({
      paneId: rec.paneId,
      label: rec.label,
      workItemId: matchingId,
    });
  }
  return blocking;
}
