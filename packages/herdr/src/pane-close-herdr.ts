/**
 * packages/herdr/src/pane-close-herdr.ts — Production reaper deps wiring
 *
 * Bridges the injectable `ReaperDeps` interface to real herdr CLI + pi
 * session-log I/O (WL-0MUJW9FFW009008M / WL-0MUJL1NAH0042GOS).
 *
 * The raw `herdr pane list` parse and the shared liveness vocabulary live in
 * the canonical discovery module `pane-discovery.ts` (WL-0MWHWH6XL0025YX2);
 * this module re-exports the parse for backward compatibility and derives the
 * per-pane `agentProcessAlive` from the shared `isPaneAgentLive` predicate
 * (AC3: one liveness definition). The remaining pure helpers
 * (`paneKindFromLabel`, `readFinalAssistantEntries`, …) are exported and
 * tested; the I/O shell is thin and fail-closed (never throws into the worker).
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { PaneStatus, ReaperDeps } from './pane-close-reaper.js';
import { sessionIdFromSessionPath } from './downtime-worker.route-outcome.js';
import { terminateProcessGroup } from './process-group.js';
// Canonical label→id / label→kind parsing lives in `pane-label.ts`
// (WL-0MWHWH1HV009C46C); imported for the deps factory below and
// re-exported so this module's public surface is unchanged — every call site
// (including the tests) resolves the canonical implementation through one
// name.
import { paneItemIdFromLabel, paneKindFromLabel } from './pane-label.js';
export { paneItemIdFromLabel, paneKindFromLabel } from './pane-label.js';
export type { PaneLabelKind as ReaperPaneKind } from './pane-label.js';
// Canonical discovery (WL-0MWHWH6XL0025YX2): the raw pane-list parse and the
// shared liveness predicate live in `pane-discovery.ts`. The parse is
// re-exported so existing importers keep resolving it through this module;
// the liveness predicate is consumed below so the reaper shares ONE "live"
// definition with the in-flight resolution (AC3).
import {
  isPaneAgentLive,
  parseHerdrPaneCloseList,
  type ParsedHerdrPane,
} from './pane-discovery.js';
export { parseHerdrPaneCloseList } from './pane-discovery.js';
export type { HerdrAgentSession } from './pane-discovery.js';

// ── Raw herdr pane-list shape ─────────────────────────────────────────
// The raw `HerdrPaneCloseRecord` / `ParsedHerdrPane` shapes, the
// JSON-envelope-tolerant `extractPaneArray` and the shared
// `parseHerdrPaneCloseList` contract all moved to `pane-discovery.ts`
// (WL-0MWHWH6XL0025YX2) so the parse lives beside the predicates that
// consume it; re-exported above for backward compatibility.

// ── Label → kind / item id ────────────────────────────────────────────
// Canonical: `pane-label.ts` (WL-0MWHWH1HV009C46C). `paneKindFromLabel`
// (loose keyword scan over PANE_KINDS, `unknown` when absent) and
// `paneItemIdFromLabel` (validated ` - ` suffix, `''` when absent) are
// re-exported above and consumed below — one parse for the reaper and the
// dispatcher.

// ── Session-log tail reading ──────────────────────────────────────────

/** Normalised session entry for `extractFinalAssistantText`. */
export interface SessionEntry {
  type?: string;
  text?: string;
}

/** Default tail window when reading a session log (512 KiB). */
export const SESSION_TAIL_BYTES = 512 * 1024;

/** Default number of tail lines surfaced to the pane-triage skill. */
export const DEFAULT_SESSION_TAIL_LINES = 20;

/**
 * Read the final assistant message from a pi session JSONL file by reading
 * only the tail of the file. Parses the pi entry shape: each line is a JSON
 * object; assistant text lives in `message.content[]` (type `text`). Also
 * tolerates the simplified `{type, text}` shape used by tests.
 *
 * Returns the entries needed by `extractFinalAssistantText` in order.
 * Fail-closed: an unreadable/malformed file yields `[]`.
 */
export function readFinalAssistantEntries(
  sessionPath: string,
  maxBytes = SESSION_TAIL_BYTES,
): SessionEntry[] {
  let raw: string;
  try {
    const size = statSync(sessionPath).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const fd = openSync(sessionPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      raw = buffer.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return []; // fail-closed
  }

  const entries: SessionEntry[] = [];
  const lines = raw.split('\n');
  // When the window starts mid-line, the first line is partial — drop it
  // unless the read reached the very start of the file.
  const startIndex = raw.length >= maxBytes ? 1 : 0;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip partial/malformed lines
    }
    if (!obj || typeof obj !== 'object') continue;
    const rec = obj as Record<string, unknown>;
    // Simplified shape.
    if (typeof rec.type === 'string' && typeof rec.text === 'string') {
      entries.push({ type: rec.type, text: rec.text });
      continue;
    }
    // pi shape: { message: { role, content: [{type,text},…] } }
    const message = rec.message;
    if (!message || typeof message !== 'object') continue;
    const msg = message as Record<string, unknown>;
    if (msg.role !== 'assistant') continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (c): c is { type?: string; text?: string } =>
          !!c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text ?? '')
      .join('');
    if (text !== '') entries.push({ type: 'assistant', text });
  }
  return entries;
}

/**
 * Read the last *tailLines* human-readable lines from a pi session JSONL file.
 *
 * Populates the per-pane `sessionTail` in the JSON report so the pane-triage
 * skill can show the producer the last 20 lines under the
 * "<pane title> Needs Review <true|false>" heading
 * (`WL-0MUJMXVPO0016DZM`). Fail-closed: an unreadable file yields `[]`.
 */
export function readSessionTailLines(
  sessionPath: string,
  tailLines = DEFAULT_SESSION_TAIL_LINES,
  maxBytes = SESSION_TAIL_BYTES,
): string[] {
  let raw: string;
  try {
    const size = statSync(sessionPath).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const fd = openSync(sessionPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      raw = buffer.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return []; // fail-closed
  }

  const lines = raw.split('\n');
  const startIndex = raw.length >= maxBytes ? 1 : 0;
  const output: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip partial/malformed lines
    }
    if (!obj || typeof obj !== 'object') continue;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.type === 'string' && typeof rec.text === 'string') {
      output.push(rec.text);
      continue;
    }
    const message = rec.message;
    if (!message || typeof message !== 'object') continue;
    const msg = message as Record<string, unknown>;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (c): c is { type?: string; text?: string } =>
          !!c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text ?? '')
      .join('')
      .trim();
    if (text !== '') output.push(text);
  }
  return output.slice(-tailLines);
}

// ── Production activity probes (parent AC3) ────────────────────────────

/** Default recent-modification window for the file activity probe (2 min). */
export const RECENT_FILE_ACTIVITY_WINDOW_MS = 2 * 60 * 1000;

/** Maximum directory entries inspected by the activity scan (cost bound). */
export const RECENT_FILE_SCAN_MAX_ENTRIES = 2000;

/**
 * Best-effort check for recently modified files under `dir` (parent AC3).
 *
 * Walks the directory tree breadth-first (bounded to `maxEntries` entries,
 * skipping VCS/dependency noise) and returns true as soon as a regular file
 * with an mtime within `windowMs` is found. Fail-closed and never throws:
 * an absent/unreadable directory or a stat failure yields no activity.
 */
export function dirHasRecentModifications(
  dir: string | undefined,
  opts?: { windowMs?: number; nowMs?: number; maxEntries?: number; ignore?: string[] },
): boolean {
  if (typeof dir !== 'string' || dir === '') return false;
  const windowMs = opts?.windowMs ?? RECENT_FILE_ACTIVITY_WINDOW_MS;
  const nowMs = opts?.nowMs ?? Date.now();
  const maxEntries = opts?.maxEntries ?? RECENT_FILE_SCAN_MAX_ENTRIES;
  const cutoff = nowMs - windowMs;
  const ignore = new Set(opts?.ignore ?? ['node_modules', '.git', '.worklog', 'dist']);
  let visited = 0;
  const stack: string[] = [dir];
  while (stack.length > 0 && visited < maxEntries) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // fail-closed on unreadable directories
    }
    for (const entry of entries) {
      visited++;
      if (visited > maxEntries) break;
      if (ignore.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          if (statSync(full).mtimeMs >= cutoff) return true;
        } catch {
          // ignore an unreadable file
        }
      }
    }
  }
  return false;
}

/** Normalised subset of `herdr pane process-info` used by the reaper. */
export interface PaneProcessInfo {
  /** Foreground process-group leader id, when reported. */
  foregroundProcessGroupId?: number;
  /** PIDs of the pane's foreground processes. */
  foregroundPids: number[];
}

/**
 * Parse `herdr pane process-info --pane <id>` output. Tolerates log lines
 * before the JSON envelope and the `{result:{process_info:{…}}}` shape.
 * Returns `null` when no process-info can be found (caller fails closed).
 */
export function parsePaneProcessInfo(raw: string): PaneProcessInfo | null {
  const brace = raw.indexOf('{');
  if (brace < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(brace));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const result = obj.result;
  const resultObj =
    result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
  const info = resultObj?.process_info ?? obj.process_info;
  if (!info || typeof info !== 'object') return null;
  const rec = info as Record<string, unknown>;
  const group = rec.foreground_process_group_id;
  const procs = rec.foreground_processes;
  const foregroundPids: number[] = [];
  if (Array.isArray(procs)) {
    for (const proc of procs) {
      if (!proc || typeof proc !== 'object') continue;
      const pid = (proc as Record<string, unknown>).pid;
      if (typeof pid === 'number' && Number.isFinite(pid)) foregroundPids.push(pid);
    }
  }
  return {
    foregroundProcessGroupId:
      typeof group === 'number' && Number.isFinite(group) ? group : undefined,
    foregroundPids,
  };
}

/**
 * Count processes in the pane *spawned by* the agent — i.e. foreground
 * processes other than the foreground process-group leader (the agent
 * itself). Excluding the leader is essential: counting the agent's own
 * process would make the classifier's `live-children` guard fire for every
 * live pane and prevent all auto-close (parent AC1).
 *
 * Absent/unparsable process-info yields 0 (no activity).
 */
export function countSpawnedChildProcesses(info: PaneProcessInfo | null): number {
  if (!info) return 0;
  const leader = info.foregroundProcessGroupId;
  return info.foregroundPids.filter((pid) => leader === undefined || pid !== leader).length;
}

// ── Production deps factory ───────────────────────────────────────────

/** Injectable I/O for the production deps (tests/other callers may override). */
export interface HerdrReaperIo {
  /** Run `herdr pane list` and return stdout. */
  listPanesRaw(): Promise<string>;
  /** Close a pane by id. Returns true on success. */
  closePane(paneId: string): Promise<boolean>;
  /** Resolve the invoking pane id (never closed). */
  invokingPaneId?: string;
  /** Optional producer-review lookup; absent → false (fail-closed default). */
  getNeedsProducerReview?(itemId: string): Promise<boolean>;
  /**
   * Optional combined item-info lookup (parent AC6). When supplied it
   * supersedes `getNeedsProducerReview` and additionally populates
   * `PaneStatus.itemStage` so the close-decision snapshot records the
   * work-item stage. Absent → falls back to `getNeedsProducerReview`.
   */
  getItemInfo?(itemId: string): Promise<{ needsProducerReview: boolean; stage?: string }>;
  /**
   * Count session-scoped child processes for a pane (parent AC1/AC3);
   * absent → 0. Receives the parsed pane so callers can probe by session
   * path / cwd rather than pane id alone.
   */
  childProcessCount?(pane: ParsedHerdrPane): number | Promise<number>;
  /**
   * Recent file-modification probe (parent AC3); absent → false (no
   * activity). Receives the parsed pane so callers can scan its workspace.
   */
  hasRecentFileModifications?(pane: ParsedHerdrPane): boolean;
  /**
   * Active network-connection probe (parent AC3); absent → false (no
   * activity). Platform-specific and kept injectable.
   */
  hasActiveNetworkConnections?(pane: ParsedHerdrPane): boolean;
  /**
   * Observed-routing-outcome recorder (WL-0MVWEZF4Z004UNYT AC10): called
   * once per pane after a successful close so the dispatch record gains its
   * observed local/remote split. Absent → the outcome record is skipped
   * (legacy callers keep today's behaviour). Must never throw into the close
   * loop (the reaper wraps it fail-open).
   */
  recordDispatchedPaneOutcome?(pane: PaneStatus): Promise<void>;
  /**
   * Host-wide dispatch-budget release (WL-0MW5KC8J300942EA): called once per
   * pane after a successful close so the pane's machine-scoped ledger entry is
   * released immediately. Idempotent and best-effort (the reaper wraps it
   * fail-open). Absent → legacy callers skip the release.
   */
  releasePaneBudget?(pane: PaneStatus): Promise<void>;
  /**
   * Proxy audit-lease release (WL-0MWJ7QONS0052HXX): called once per closed
   * AUDIT pane after a successful close so the shared GPU lease a completed
   * audit still holds is returned immediately. Wired by `index.ts` to the
   * worker's existing `releaseAuditLease` (item-id-derived session id) — the
   * release `recordPaneClose` performs lives behind the disabled
   * pane-lifecycle monitor and never runs in production. Idempotent and
   * best-effort. Absent → legacy callers skip the release.
   */
  releaseAuditLease?(pane: PaneStatus): Promise<void>;
  /**
   * Dead-pane ledger sweep (WL-0MW5KC8J300942EA): called once per reaper run
   * with the RAW parsed pane list of that run. Receives `ParsedHerdrPane[]`
   * (not the session-filtered `PaneStatus[]`) so a dispatch pane whose session
   * file is unreadable is still treated as live and never over-reaped. Absent
   * → legacy callers skip the sweep.
   */
  sweepBudgetLedger?(panes: readonly ParsedHerdrPane[]): Promise<void>;
  /** Clock (injectable for tests). */
  now?(): number;
}

/**
 * Build real `ReaperDeps` from herdr + pi session-log I/O.
 *
 * Fail-closed at every boundary: an unreadable pane list yields no panes; a
 * pane with no resolvable session file is skipped entirely (never closed on
 * ambiguous evidence); `needsProducerReview` defaults to false only when the
 * lookup is absent.
 */
export function createHerdrReaperDeps(io: HerdrReaperIo): ReaperDeps {
  const now = io.now ?? (() => Date.now());
  // Trusted live-pane snapshot for the budget sweep (WL-0MW5KC8J300942EA):
  // populated only by a pane read that actually parsed, so a failed/unreadable
  // read never sweeps the ledger (which would over-admit). Kept as the RAW
  // parsed list, not the session-filtered one.
  let lastParsedPanes: ParsedHerdrPane[] | null = null;

  return {
    async listPanes(): Promise<PaneStatus[]> {
      let raw: string;
      try {
        raw = await io.listPanesRaw();
      } catch {
        lastParsedPanes = null;
        return []; // fail-closed: no evidence, no action
      }
      const panes = parseHerdrPaneCloseList(raw);
      if (panes === null) {
        lastParsedPanes = null;
        return [];
      }
      lastParsedPanes = panes;

      const result: PaneStatus[] = [];
      for (const pane of panes) {
        // Only pi agent panes are candidates.
        if (pane.agent !== 'pi' && !pane.sessionPath) continue;
        // A pane with no session file cannot be classified safely — skip.
        if (!pane.sessionPath) continue;

        const entries = readFinalAssistantEntries(pane.sessionPath);
        const sessionTail = readSessionTailLines(pane.sessionPath);
        let idleMs = 0;
        let ageSinceDispatchMs: number | undefined;
        try {
          const st = statSync(pane.sessionPath);
          idleMs = Math.max(0, now() - st.mtimeMs);
          // The session file is created when the pane is first dispatched, so
          // its birthtime is the best available "first dispatch" proxy (fall
          // back to ctime on filesystems that do not expose birthtime).
          const bornMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
          ageSinceDispatchMs = Math.max(0, now() - bornMs);
        } catch {
          idleMs = 0;
          ageSinceDispatchMs = undefined;
        }

        const itemId = paneItemIdFromLabel(pane.label);
        // Shared liveness (WL-0MWHWH6XL0025YX2 AC3): `isPaneAgentLive` is the
        // single "live" definition shared with the in-flight resolution and the
        // ship guard (agent present && status not done/exited). The reaper
        // additionally treats an EMPTY status as not-alive: an unknown liveness
        // must never read as "agent alive → idle-close", and the dead-agent
        // outcome never closes — so the extra guard is fail-closed (deliberate,
        // documented divergence from the dispatch-side fail-open on unknown).
        const agentProcessAlive = isPaneAgentLive(pane) && (pane.agentStatus ?? '') !== '';

        // Producer-review + item-stage lookup (parent AC2/AC6). Prefer the
        // combined `getItemInfo`; fall back to the boolean-only lookup.
        let needsProducerReview = false;
        let itemStage: string | undefined;
        if (itemId !== '' && typeof io.getItemInfo === 'function') {
          try {
            const info = await io.getItemInfo(itemId);
            needsProducerReview = info.needsProducerReview === true;
            itemStage = typeof info.stage === 'string' && info.stage !== '' ? info.stage : undefined;
          } catch {
            // fail-closed: an unreadable item must never be closed without
            // evidence — treat as review-blocked (never auto-close).
            needsProducerReview = true;
          }
        } else if (itemId !== '' && typeof io.getNeedsProducerReview === 'function') {
          try {
            needsProducerReview = await io.getNeedsProducerReview(itemId);
          } catch {
            needsProducerReview = true;
          }
        }

        result.push({
          id: pane.paneId,
          kind: paneKindFromLabel(pane.label),
          itemId,
          itemStage,
          title: pane.label || pane.paneId,
          workspaceId: pane.workspaceId,
          tabId: pane.tabId,
          lastAssistantText: '',
          sessionEntries: entries,
          sessionTail,
          agentProcessAlive,
          agentStatus: pane.agentStatus,
          sessionId: sessionIdFromSessionPath(pane.sessionPath ?? ''),
          idleMs,
          needsProducerReview,
          isInvokingPane: pane.paneId === io.invokingPaneId,
          childProcessCount: (await io.childProcessCount?.(pane)) ?? 0,
          ageSinceDispatchMs,
          hasRecentFileModifications: io.hasRecentFileModifications?.(pane) ?? false,
          hasActiveNetworkConnections: io.hasActiveNetworkConnections?.(pane) ?? false,
        });
      }
      return result;
    },

    async closePane(paneId: string): Promise<{ success: boolean; error?: string }> {
      try {
        const ok = await io.closePane(paneId);
        return ok ? { success: true } : { success: false, error: 'close returned false' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async recordDispatchedPaneOutcome(pane: PaneStatus): Promise<void> {
      if (typeof io.recordDispatchedPaneOutcome !== 'function') return;
      await io.recordDispatchedPaneOutcome(pane);
    },

    async releasePaneBudget(pane: PaneStatus): Promise<void> {
      if (typeof io.releasePaneBudget !== 'function') return;
      await io.releasePaneBudget(pane);
    },

    async releaseAuditLease(pane: PaneStatus): Promise<void> {
      if (typeof io.releaseAuditLease !== 'function') return;
      await io.releaseAuditLease(pane);
    },

    async sweepBudgetLedger(): Promise<void> {
      if (typeof io.sweepBudgetLedger !== 'function') return;
      // Untrusted read (failed/unparseable) → never sweep.
      if (lastParsedPanes === null) return;
      await io.sweepBudgetLedger(lastParsedPanes);
    },

    terminateProcessGroup,
  };
}
