/**
 * packages/herdr/src/agent-tracker.ts — Work-item ↔ agent-pane association
 * tracker (WL-0MSBQUJQX005RAT9)
 *
 * Records which work-item each worklist-spawned pi agent pane is working on
 * (along with the dispatched command), persists the mapping to a gitignored
 * JSON state file (`.worklog/agent-panes.json`), and resolves each pane's
 * current agent state (`idle` / `working` / `blocked` / `done`) via the
 * herdr CLI so the worklist can render an agent-status icon per row.
 *
 * Design notes:
 *  - Only worklist-spawned agent commands are tracked (the association is
 *    recorded at dispatch time when the new pane ID is captured).
 *  - The state file is shared across worklist panes/tabs: each refresh
 *    re-reads the file (last-writer-wins) before querying herdr.
 *  - Status lookup fails open: when the herdr CLI is unavailable or its
 *    output is unparseable, `refreshStates()` returns an empty map (no
 *    icons) and existing entries are kept so icons reappear when the CLI
 *    returns.
 *  - Entries whose pane is gone (no longer in `herdr agent list`) or whose
 *    agent reports `done` are pruned so the icon disappears.
 *  - The `herdr agent list` query is memoized within a TTL (PollGate
 *    pattern from visibility.ts) to avoid CLI spawn churn on every refresh
 *    tick.
 *
 * The implementation is self-contained and portable (pure functions where
 * feasible) to ease the planned Rust migration (WL-0MS8XGSE400374VS).
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { getExecFileAsync } from './fetcher.js';
import type { WorkItem } from './fetcher.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Agent states mirrored from the herdr sidebar protocol
 * (packages/herdr/shared/herdr-agent-state-protocol.md): `idle`, `working`,
 * `blocked` plus the CLI-terminal `done` and the catch-all `unknown`.
 */
export type AgentState = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/** One recorded work-item ↔ pane association. */
export interface AgentPaneEntry {
  workItemId: string;
  paneId: string;
  /** ISO timestamp of when the association was recorded. */
  recordedAt: string;
  /** The command dispatched to this pane (e.g. "/skill:implement WL-123"). */
  command?: string;
}

/** A parsed `herdr agent list` record. */
export interface AgentListRecord {
  paneId: string;
  status: string;
}

// ── Constants ────────────────────────────────────────────────────────

/** Name of the state file inside the project's `.worklog/` directory. */
export const AGENT_PANES_FILE = 'agent-panes.json';

/** Default TTL for the refreshStates memoizer (mirrors visibility.ts). */
export const AGENT_STATE_TTL_MS = 2000;

// ── Pure helpers ─────────────────────────────────────────────────────

/**
 * Normalize a raw agent-status string from the herdr CLI into an AgentState.
 * Unknown/empty values map to `unknown`.
 */
export function normalizeAgentState(status: string | undefined): AgentState {
  const key = (status || '').toLowerCase().trim();
  if (key === 'idle' || key === 'working' || key === 'blocked' || key === 'done') {
    return key;
  }
  return 'unknown';
}

/**
 * Parse `herdr agent list` output into pane → status records.
 *
 * Tolerates log lines prefixed before the JSON envelope (scan for the first
 * `{`, like fetcher.ts), multiple envelope shapes, and snake_case/camelCase
 * field aliases. Returns null when no agent array can be found (the caller
 * treats this as fail-open).
 */
export function parseAgentListOutput(raw: string): AgentListRecord[] | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }

  let agents: unknown = null;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const result = obj.result;
    const resultObj = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
    if (Array.isArray(resultObj?.agents)) {
      agents = resultObj.agents;
    } else if (Array.isArray(obj.agents)) {
      agents = obj.agents;
    } else if (Array.isArray(result)) {
      agents = result;
    } else if (Array.isArray(obj)) {
      agents = obj;
    }
  }

  if (!Array.isArray(agents)) return null;

  const records: AgentListRecord[] = [];
  for (const entry of agents) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const paneId = rec.pane_id ?? rec.paneId;
    const status = rec.agent_status ?? rec.agentStatus ?? rec.status;
    if (typeof paneId === 'string' && paneId !== '' && typeof status === 'string') {
      records.push({ paneId, status });
    }
  }
  return records;
}

// ── Tracker ──────────────────────────────────────────────────────────

export interface AgentTrackerOptions {
  /** Path to the persisted state file (`.worklog/agent-panes.json`). */
  stateFile?: string;
  /** TTL for refreshStates memoization (PollGate pattern). */
  ttlMs?: number;
}

/**
 * In-memory + persisted mapping from work item ID → agent pane ID, with
 * herdr-backed state refresh. Never throws on herdr/fs errors (fail-open).
 */
export class AgentTracker {
  private readonly stateFile?: string;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, AgentPaneEntry>();
  private cachedStates = new Map<string, AgentState>();
  private cachedAt = 0;

  constructor(opts: AgentTrackerOptions = {}) {
    this.stateFile = opts.stateFile;
    this.ttlMs = opts.ttlMs ?? AGENT_STATE_TTL_MS;
    this.loadFromDisk();
  }

  /** Number of tracked associations. */
  get size(): number {
    return this.entries.size;
  }

  /** Snapshot of the tracked entries (read-only for callers). */
  snapshot(): AgentPaneEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Record (or overwrite) the association for a work item and persist it.
   * Persistence failures are swallowed (fail-open).
   *
   * @param workItemId - The work item ID.
   * @param paneId - The agent pane ID.
   * @param command - Optional command dispatched to this pane (e.g. "/skill:implement WL-123").
   */
  async recordAgentForWorkItem(workItemId: string, paneId: string, command?: string): Promise<void> {
    this.entries.set(workItemId, { workItemId, paneId, recordedAt: new Date().toISOString(), command });
    this.persist();
  }

  /** Remove a single association and persist the change. */
  async pruneEntry(workItemId: string): Promise<void> {
    if (this.entries.delete(workItemId)) {
      this.persist();
    }
  }

  /** Return the pane ID recorded for a work item, or undefined. */
  getPaneId(workItemId: string): string | undefined {
    return this.entries.get(workItemId)?.paneId;
  }

  /**
   * Return the command recorded for a work item, or undefined when none
   * was recorded (e.g. pre-command entries loaded from disk).
   */
  getCommand(workItemId: string): string | undefined {
    return this.entries.get(workItemId)?.command;
  }

  /**
   * Return the full entry recorded for a work item (pane ID, recordedAt,
   * command), or undefined when the item is not associated with a pane.
   */
  getEntry(workItemId: string): AgentPaneEntry | undefined {
    return this.entries.get(workItemId);
  }

  /**
   * Refresh the agent states for all tracked panes, memoized within the TTL.
   *
   * On a cache miss: re-reads the shared state file (so associations
   * recorded by other panes/tabs are picked up), queries `herdr agent list`
   * once, prunes entries whose pane is gone or whose agent reports `done`,
   * persists any pruning, and returns the resulting
   * `Map<workItemId, AgentState>`.
   *
   * Fail-open: a herdr CLI error or unparseable output yields an empty map
   * (no icons) and keeps all entries.
   */
  async refreshStates(): Promise<Map<string, AgentState>> {
    const now = Date.now();
    if (now - this.cachedAt < this.ttlMs) {
      return this.cachedStates;
    }

    // Re-read the shared file so other worklist panes/tabs are reflected.
    this.loadFromDisk();

    const bin = process.env.HERDR_BIN_PATH ?? 'herdr';
    try {
      const execFileAsync = getExecFileAsync();
      const result = await execFileAsync(bin, ['agent', 'list'], { maxBuffer: 1024 * 1024 });
      const records = parseAgentListOutput(result.stdout);
      if (!records) {
        throw new Error('Unparseable herdr agent list output');
      }

      const statusByPane = new Map<string, string>();
      for (const rec of records) {
        statusByPane.set(rec.paneId, rec.status);
      }

      const states = new Map<string, AgentState>();
      let pruned = false;
      for (const [workItemId, entry] of [...this.entries]) {
        const status = statusByPane.get(entry.paneId);
        if (status === undefined) {
          // Pane is gone (closed/exited) or no longer an agent — prune so
          // the icon disappears on the next refresh cycle (AC5).
          this.entries.delete(workItemId);
          pruned = true;
        } else {
          const state = normalizeAgentState(status);
          if (state === 'done') {
            // Agent finished; the pane may still be open but no icon is
            // shown. Prune now — a re-dispatch records a fresh association.
            this.entries.delete(workItemId);
            pruned = true;
          } else {
            states.set(workItemId, state);
          }
        }
      }
      if (pruned) {
        this.persist();
      }

      this.cachedStates = states;
      this.cachedAt = Date.now();
      return states;
    } catch {
      // Fail-open: keep entries, render no icons this cycle.
      this.cachedStates = new Map();
      this.cachedAt = Date.now();
      return this.cachedStates;
    }
  }

  // ── Event-applied path (WL-0MSHB7DHO004RHBJ F5) ────────────────────

  /**
   * Snapshot the CURRENT cached agent states WITHOUT the TTL/memo check
   * and without any herdr exec. Used by the event path to re-render icons
   * immediately after an event updates the cache.
   */
  snapshotStates(): Map<string, AgentState> {
    return new Map(this.cachedStates);
  }

  /**
   * Apply a `pane_agent_status_changed` event to the cached state map.
   *
   * Finds every tracked association whose pane matches the event's
   * pane_id and updates its state immediately (no `herdr agent list`
   * exec). A `done` status prunes the entry (mirrors refreshStates).
   * Extends the memo window so the next refreshStates() call returns the
   * event-applied states instead of re-polling.
   *
   * Returns the affected work-item ids (empty when the pane is untracked).
   */
  applyAgentStatusChanged(paneId: string, status: string): string[] {
    const affected: string[] = [];
    const state = normalizeAgentState(status);
    for (const [workItemId, entry] of [...this.entries]) {
      if (entry.paneId !== paneId) continue;
      if (state === 'done') {
        this.entries.delete(workItemId);
        this.cachedStates.delete(workItemId);
      } else {
        this.cachedStates.set(workItemId, state);
      }
      affected.push(workItemId);
    }
    if (affected.length > 0) {
      this.persist();
      this.cachedAt = Date.now();
    }
    return affected;
  }

  /**
   * Apply a `pane_agent_detected` event: re-read the shared
   * `.worklog/agent-panes.json` so associations recorded by OTHER plugin
   * instances (cross-instance coverage, AC3) and late-spawned agents are
   * picked up without waiting for the next refresh cycle.
   *
   * Returns true when the pane set grew (callers should add per-pane
   * subscriptions for the newly tracked panes).
   */
  applyAgentDetected(): boolean {
    const before = this.entries.size;
    this.loadFromDisk();
    this.cachedAt = Date.now();
    return this.entries.size > before;
  }

  /**
   * Apply a `pane_closed` / `pane_exited` event: prune every association
   * whose pane is gone so its icon disappears immediately (no poll wait).
   * Returns the affected work-item ids.
   */
  applyPaneGone(paneId: string): string[] {
    const affected: string[] = [];
    for (const [workItemId, entry] of [...this.entries]) {
      if (entry.paneId !== paneId) continue;
      this.entries.delete(workItemId);
      this.cachedStates.delete(workItemId);
      affected.push(workItemId);
    }
    if (affected.length > 0) {
      this.persist();
      this.cachedAt = Date.now();
    }
    return affected;
  }

  // ── Persistence ────────────────────────────────────────────────────

  /**
   * Load the persisted state file into memory. Missing or corrupt files are
   * tolerated (in-memory entries are left untouched on a parse failure so a
   * half-written file never wipes the live mapping).
   */
  private loadFromDisk(): void {
    if (!this.stateFile) return;
    if (!existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw as { entries?: unknown })?.entries;
      if (!Array.isArray(list)) return;
      const next = new Map<string, AgentPaneEntry>();
      for (const rec of list) {
        if (!rec || typeof rec !== 'object') continue;
        const entry = rec as Record<string, unknown>;
        const workItemId = entry.workItemId ?? entry.workItem ?? entry.id;
        const paneId = entry.paneId;
        if (typeof workItemId === 'string' && workItemId !== '' && typeof paneId === 'string') {
          next.set(workItemId, {
            workItemId,
            paneId,
            recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : new Date().toISOString(),
            command: typeof entry.command === 'string' ? entry.command : undefined,
          });
        }
      }
      this.entries.clear();
      for (const [k, v] of next) this.entries.set(k, v);
    } catch {
      // Corrupt file — keep the current in-memory mapping.
    }
  }

  /**
   * Write the mapping atomically (write-temp-then-rename). Multiple
   * worklist tabs may write concurrently — last-writer-wins is acceptable.
   * Failures are swallowed (fail-open).
   */
  private persist(): void {
    if (!this.stateFile) return;
    try {
      const payload = JSON.stringify([...this.entries.values()], null, 2);
      const tmp = `${this.stateFile}.tmp.${process.pid}`;
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, this.stateFile);
    } catch {
      // Persistence must never break the live tracker.
    }
  }
}

/**
 * Merge the tracker's agent states into a list of work items (recursively
 * into children), setting `agentState` only for states with a rendered icon
 * (`idle` / `working` / `blocked`). `done` / `unknown` / missing states are
 * left unset so no icon renders. Fail-open: never throws.
 */
export async function mergeAgentStates(items: WorkItem[], tracker: AgentTracker): Promise<void> {
  let states: Map<string, AgentState>;
  try {
    states = await tracker.refreshStates();
  } catch {
    return; // fail-open: no icons this cycle
  }
  if (states.size === 0) return;
  const apply = (item: WorkItem): void => {
    const state = states.get(item.id);
    if (state === 'idle' || state === 'working' || state === 'blocked') {
      item.agentState = state;
    }
  };
  const walk = (list: WorkItem[]): void => {
    for (const item of list) {
      apply(item);
      if (item.children && item.children.length > 0) {
        walk(item.children);
      }
    }
  };
  walk(items);
}

/**
 * Merge the CURRENT cached agent states into a list of work items
 * (recursively into children) WITHOUT the TTL/memo check and without any
 * herdr exec (WL-0MSHB7DHO004RHBJ F5).
 *
 * Used by the event path: after a `pane_agent_status_changed` event
 * updates the tracker's cache, this re-applies the updated states to the
 * currently rendered items so their icons flip immediately. Same
 * icon-eligibility rules as mergeAgentStates (`idle`/`working`/`blocked`
 * render; `done`/`unknown`/absent do not). Never throws.
 */
export function mergeAgentStatesCached(items: WorkItem[], tracker: AgentTracker): void {
  try {
    const states = tracker.snapshotStates();
    const apply = (item: WorkItem): void => {
      const state = states.get(item.id);
      if (state === 'idle' || state === 'working' || state === 'blocked') {
        item.agentState = state;
      } else {
        // A state that is no longer icon-eligible (done/unknown/gone)
        // must clear a previously rendered icon. Unlike mergeAgentStates
        // (fresh items never carry stale icons), the event path re-applies
        // to LIVE items, so the walk must always run — even when the
        // tracker currently has no states (all pruned).
        delete item.agentState;
      }
    };
    const walk = (list: WorkItem[]): void => {
      for (const item of list) {
        apply(item);
        if (item.children && item.children.length > 0) {
          walk(item.children);
        }
      }
    };
    walk(items);
  } catch {
    // Fail-open: no icon updates this cycle.
  }
}
