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

import { closeSync, openSync, readSync, statSync } from 'node:fs';

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
}

/** A parsed pane record normalised for the reaper. */
export interface ParsedHerdrPane {
  paneId: string;
  label: string;
  agent?: string;
  agentStatus?: string;
  sessionPath?: string;
  workspaceId?: string;
  tabId?: string;
}

/**
 * Parse `herdr pane list` output into normalised records. Tolerates log lines
 * before the JSON envelope and the `{result:{panes:[…]}}` / bare-array shapes.
 * Returns `null` when no pane array can be found (caller fails closed).
 */
export function parseHerdrPaneCloseList(raw: string): ParsedHerdrPane[] | null {
  const brace = raw.indexOf('{');
  const bracket = raw.indexOf('[');
  let start: number;
  if (brace < 0 && bracket < 0) return null;
  else if (brace < 0) start = bracket;
  else if (bracket < 0) start = brace;
  else start = Math.min(brace, bracket);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }

  let panes: unknown = null;
  if (Array.isArray(payload)) {
    panes = payload;
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const result = obj.result;
    const resultObj =
      result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
    if (Array.isArray(resultObj?.panes)) panes = resultObj.panes;
    else if (Array.isArray(obj.panes)) panes = obj.panes;
  }
  if (!Array.isArray(panes)) return null;

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
    const sessionPath =
      session && typeof session.value === 'string' && session.value !== ''
        ? session.value
        : undefined;
    parsed.push({
      paneId,
      label: typeof rec.label === 'string' ? rec.label : '',
      agent: typeof rec.agent === 'string' ? rec.agent : undefined,
      agentStatus,
      sessionPath,
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
  /** Count session-scoped child processes; absent → 0. */
  childProcessCount?(paneId: string): number;
  /**
   * Recent file-modification probe (parent AC3); absent → false (no
   * activity). Kept injectable because workspace scanning is platform- and
   * cost-sensitive.
   */
  hasRecentFileModifications?(paneId: string): boolean;
  /**
   * Active network-connection probe (parent AC3); absent → false (no
   * activity). Kept injectable for the same reason.
   */
  hasActiveNetworkConnections?(paneId: string): boolean;
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

        let needsProducerReview = false;
        if (itemId !== '' && typeof io.getNeedsProducerReview === 'function') {
          try {
            needsProducerReview = await io.getNeedsProducerReview(itemId);
          } catch {
            // fail-closed: an unreadable item must never be closed without
            // evidence — treat as review-blocked (never auto-close).
            needsProducerReview = true;
          }
        }

        result.push({
          id: pane.paneId,
          kind: paneKindFromLabel(pane.label),
          itemId,
          title: pane.label || pane.paneId,
          workspaceId: pane.workspaceId,
          tabId: pane.tabId,
          lastAssistantText: '',
          sessionEntries: entries,
          agentProcessAlive,
          idleMs,
          needsProducerReview,
          isInvokingPane: pane.paneId === io.invokingPaneId,
          childProcessCount: io.childProcessCount?.(pane.paneId) ?? 0,
          ageSinceDispatchMs,
          hasRecentFileModifications: io.hasRecentFileModifications?.(pane.paneId) ?? false,
          hasActiveNetworkConnections: io.hasActiveNetworkConnections?.(pane.paneId) ?? false,
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
