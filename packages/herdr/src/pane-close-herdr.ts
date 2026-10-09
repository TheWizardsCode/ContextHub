/**
 * packages/herdr/src/pane-close-herdr.ts — Production reaper deps wiring
 *
 * Bridges the injectable `ReaperDeps` interface to real herdr CLI + pi
 * session-log I/O (WL-0MUJW9FFW009008M / WL-0MUJL1NAH0042GOS).
 *
 * The pure parsing/mapping helpers (`parseHerdrPaneCloseList`,
 * `paneKindFromLabel`, `readFinalAssistantEntries`) are exported and tested;
 * the I/O shell is thin and fail-closed (never throws into the worker).
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { PaneStatus, ReaperDeps } from './pane-close-reaper.js';
import { terminateProcessGroup } from './process-group.js';

// ── Raw herdr pane-list shape ─────────────────────────────────────────

/** The `agent_session` field of a `herdr pane list` record. */
export interface HerdrAgentSession {
  agent?: string;
  kind?: string;
  source?: string;
  value?: string;
}

/** One raw `herdr pane list` record (only the fields the reaper needs). */
export interface HerdrPaneCloseRecord {
  pane_id?: string;
  paneId?: string;
  label?: string;
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
}

/** A parsed pane record normalised for the reaper. */
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
 * Shared `herdr pane list` parser — the single parse contract used by both the
 * pane-closure reaper ({@link createHerdrReaperDeps}) and the downtime
 * dispatcher (`parseHerdrPaneListOutput`). Tolerates log lines before the JSON
 * envelope, the `{result:{panes:[…]}}` / `{panes:[…]}` shapes and a bare
 * array; returns `null` when no pane array can be found (caller fails closed).
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
      label: typeof rec.label === 'string' ? rec.label : '',
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
    });
  }
  return parsed;
}

// ── Label → kind / item id ────────────────────────────────────────────

const PANE_KINDS = ['implement', 'risk-effort', 'intake', 'audit', 'plan'] as const;
export type ReaperPaneKind = PaneStatus['kind'];

/**
 * Derive the pane kind from its label. Scans for the skill keyword the
 * launcher embeds (`Downtime triggered <kind> …`, `Manually triggered
 * <kind> …`, or a bare `<skill> …`). Unknown labels classify as `unknown`
 * (fail-closed: the classifier never auto-closes `unknown` unless the marker
 * or dead-agent/idle rules apply — and those are still bounded by the guards).
 */
export function paneKindFromLabel(label: string): ReaperPaneKind {
  const lower = (label ?? '').toLowerCase();
  for (const kind of PANE_KINDS) {
    if (lower.includes(kind)) return kind;
  }
  return 'unknown';
}

/**
 * Trailing work-item id in a pane label (`… - WL-XXXX`). Reuses the same
 * suffix convention as the downtime pane titles. Returns `''` when absent.
 */
export function paneItemIdFromLabel(label: string): string {
  if (typeof label !== 'string' || label === '') return '';
  const idx = label.lastIndexOf(' - ');
  if (idx < 0) return '';
  const id = label.slice(idx + 3).trim();
  // Work-item ids are single tokens like WL-0ABC123 or CG-0ABC123.
  return /^[A-Z]{2,}-[A-Z0-9]+$/.test(id) ? id : '';
}

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

  return {
    async listPanes(): Promise<PaneStatus[]> {
      let raw: string;
      try {
        raw = await io.listPanesRaw();
      } catch {
        return []; // fail-closed: no evidence, no action
      }
      const panes = parseHerdrPaneCloseList(raw);
      if (panes === null) return [];

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
        const status = (pane.agentStatus ?? '').toLowerCase();
        const agentProcessAlive = status !== 'done' && status !== 'exited' && status !== '';

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

    terminateProcessGroup,
  };
}
