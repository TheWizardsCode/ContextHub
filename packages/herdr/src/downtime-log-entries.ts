/**
 * packages/herdr/src/downtime-log-entries.ts — the downtime **dispatch** log
 * and its pane-close lifecycle entries (WL-0MVGKHFT4003X6JW, split out of
 * `downtime-log.ts`).
 *
 * Single responsibility: the rolling dispatch log's **entry shapes**
 * (`DowntimeLogEntry`, plus the pane-close lifecycle types that share the
 * same file), its fail-closed append helpers, the fail-safe reader, and the
 * single predicate that separates dispatch markers from typed lifecycle
 * entries. Marker/selection semantics live in `downtime-log-markers.ts`; the
 * "recent dispatches" projection lives in `downtime-log-recent.ts`.
 *
 * The log is bounded — only the most recent `DOWNTIME_LOG_MAX_ENTRIES`
 * entries are kept — so it rolls instead of growing unbounded over a
 * long-lived plugin pane. Readers must treat failures as fail-safe; writers
 * are fail-closed (never crash the worker).
 *
 * Extracted verbatim from `downtime-log.ts`; behaviour is unchanged.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CloseReasonSnapshot } from './pane-close.js';
import {
  DOWNTIME_LOG_FILE,
  appendRollingJsonl,
  parseJsonlLines,
} from './downtime-log-storage.js';

// ── Pane-close lifecycle entries (WL-0MU308WSF0002JWN) ─────────────────

/**
 * Outcome for a pane-lifecycle close event, capturing WHY the pane was
 * closed (or, for `requires-attention`, why it was flagged).
 */
export type PaneLifecycleOutcome =
  | 'closed-as-intake-complete'
  | 'closed-as-plan-complete'
  | 'audit-passed'
  | 'audit-failed'
  | 'requires-attention';

/**
 * The dispatch kind that spawned the pane (plan / intake / audit /
 * risk-effort / implement). Re-exports the worker's `DowntimeSkillKind`
 * for the pane-lifecycle module so the worker and log share the same set.
 */
export type PaneLifecycleKind = 'plan' | 'intake' | 'audit' | 'risk-effort' | 'implement';

/**
 * A pane-close lifecycle event recorded in the rolling dispatch log
 * (WL-0MU308WSF0002JWN). These entries are keyed by pane id + outcome so
 * the lifecycle collector can track which outcomes have already been
 * logged and avoid duplicate entries.
 *
 * This entry type uses `entryType: 'pane-close'` as a discriminator so
 * dispatched-marker readers (which filter by `kind === <tier>`) ignore
 * pane-close entries entirely.
 */
export interface PaneCloseLogEntry {
  /** Discriminator — ensures dispatched-marker readers ignore this entry. */
  entryType: 'pane-close';
  /** ISO-8601 UTC timestamp of the pane-close/log event. */
  timestamp: string;
  /** Work item id of the dispatched item. */
  itemId: string;
  /** Work item title at the time the pane was closed. */
  itemTitle: string;
  /** Pane id (unique per pane, e.g. "w2T:p3"). */
  paneId: string;
  /** The dispatch kind that spawned this pane. */
  kind: PaneLifecycleKind;
  /** Why the pane was closed (or flagged). */
  outcome: PaneLifecycleOutcome;
  /** Human-readable reason (required for `requires-attention`). */
  reason?: string;
  /**
   * Stable machine-readable reason code (part of the monitor's idempotency
   * key — see `pane-lifecycle.ts`). `'none'` for clean terminal outcomes.
   */
  reasonCode?: string;
  /**
   * Worklog stage the item was at when the pane was closed
   * (WL-0MUKYERLZ006ELL5), recorded from the dispatched-at marker stage. Lets
   * the non-terminal cooldown be released when the item has since advanced
   * past that stage (parent AC4). Optional for legacy entries.
   */
  stage?: string;
  /** Whether the pane was actually closed (false for informational log-only). */
  closed: boolean;
  /**
   * Optional full close-decision state snapshot (parent AC6 /
   * WL-0MUMM5M22006HDPY AC4.1). Absent on legacy entries — readers ignore
   * unknown/absent fields.
   */
  reasonSnapshot?: CloseReasonSnapshot;
}

/**
 * Append one pane-close lifecycle entry to the rolling dispatch log.
 * Fail-closed: never throws — the lifecycle logger must never crash the
 * worker.
 */
export async function appendPaneCloseLogEntry(
  cwd: string,
  entry: PaneCloseLogEntry,
): Promise<void> {
  try {
    await appendRollingJsonl(cwd, DOWNTIME_LOG_FILE, JSON.stringify(entry));
  } catch {
    // fail-closed: pane-close logging must never crash the worker
  }
}

/**
 * One parsed line of the downtime dispatch log: either a dispatch event
 * (itemId/kind/dispatchedAt/title), a spawn-failure trace
 * (itemId/kind/stage + outcome:'spawn-failed' with error/exitCode —
 * WL-0MSLWJ3I70031Z8U), or a persistent-error event (cwd/at/message,
 * three-strike trail). All fields optional so malformed or foreign lines
 * never break parsing.
 */
export interface DowntimeLogEntry {
  itemId?: string;
  kind?: string;
  dispatchedAt?: string;
  cwd?: string;
  title?: string;
  /**
   * Worklog stage of the item AT dispatch (set on plan/intake markers,
   * RCA WL-0MSRBFFLN005W3VT design point 3). Powers the change-guard: a
   * candidate is excluded while it is still at its dispatched-at stage; a
   * stage advancement releases it. Absent on legacy entries (backward
   * compatible — a missing stage never suppresses selection).
   */
  stage?: string;
  at?: string;
  message?: string;
  /**
   * Dispatch outcome of a failed pane spawn ('spawn-failed'): the rolling
   * log distinguishes "attempted" from "opened" (WL-0MSLWJ3I70031Z8U AC2).
   * Absent on success markers and legacy entries (backward compatible —
   * marker readers ignore it).
   */
  outcome?: string;
  /** Spawn-level error message (spawn-failed trace, e.g. ENOENT). */
  error?: string;
  /** send-to-pi.sh exit code (non-zero spawn-failed trace; null = signal). */
  exitCode?: number | null;
  /**
   * Entry-type discriminator (WL-0MU308WSF0002JWN): `'pane-close'` marks a
   * pane-lifecycle close event. Absent on dispatch markers, spawn-failure
   * traces, and error entries (backward compatible — marker readers ignore
   * unknown fields).
   */
  entryType?: string;
  /**
   * Resolved pane id for a dispatch (post-spawn enrichment entry,
   * WL-0MUBVL251006JAQ0) or the pane id a pane-close entry refers to. Absent
   * when the pane could not be resolved (backward compatible).
   */
  paneId?: string | null;
  /** Discriminator for a post-spawn enrichment entry. */
  enrichment?: boolean;
  /**
   * Stable machine-readable reason code for a pane-close entry
   * (WL-0MU308WSF0002JWN) — part of the monitor's idempotency key. Absent on
   * legacy/other entries.
   */
  reasonCode?: string;
  /**
   * Optional full close-decision state snapshot on a pane-close entry
   * (parent AC6 / WL-0MUMM5M22006HDPY AC4.1). Absent on legacy/other entries.
   */
  reasonSnapshot?: CloseReasonSnapshot;
  /**
   * ISO-8601 timestamp of a pane-close entry (WL-0MU308WSF0002JWN). Absent on
   * dispatch markers (which carry `dispatchedAt` instead) and legacy entries.
   */
  timestamp?: string;
  /**
   * Item title captured on a pane-close entry (WL-0MU308WSF0002JWN); parallels
   * the dispatch marker's `title`. Absent on dispatch markers and legacy
   * entries.
   */
  itemTitle?: string;
}

/**
 * Read the bounded rolling dispatch log at `<cwd>/.worklog/downtime-dispatches.log`.
 *
 * FAIL-SAFE by contract (WL-0MSLIY8ZR004QUSY): a missing or unreadable log
 * yields `[]` (a missing log is the normal first-run state — treating it as
 * empty keeps audit-tier dispatch working on a fresh worklog, and a
 * corrupted log must not silently disable the audit tier either), and
 * malformed JSONL lines are skipped without throwing. This function never
 * throws.
 */
export async function readDowntimeLogEntries(cwd: string): Promise<DowntimeLogEntry[]> {
  const file = join(cwd, '.worklog', DOWNTIME_LOG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return []; // missing or unreadable → empty (fail-safe)
  }
  return parseJsonlLines(raw) as DowntimeLogEntry[];
}

/**
 * Append one entry (a JSONL line) to `<cwd>/.worklog/downtime-dispatches.log`,
 * creating the `.worklog` directory if needed and trimming the file back to
 * the most recent DOWNTIME_LOG_MAX_ENTRIES entries. Throws on I/O failure —
 * callers must catch (fail-closed).
 */
export async function appendDowntimeLogEntry(cwd: string, entry: string): Promise<void> {
  await appendRollingJsonl(cwd, DOWNTIME_LOG_FILE, entry);
}

/**
 * True for a rolling-log line that participates in the dispatched-marker
 * readers. Pane-lifecycle close entries (`entryType: 'pane-close'`,
 * WL-0MU308WSF0002JWN) reuse `itemId`/`kind` but are NOT dispatch markers —
 * without this guard their missing `stage`/`dispatchedAt` would clobber a
 * standing marker (last-entry-wins). Any future typed entry is likewise
 * excluded; dispatch markers and enrichment entries (no `entryType`) pass.
 *
 * Exported for the sibling marker/projection modules only — deliberately not
 * part of the `downtime-log.js` public surface.
 */
export function isDispatchMarkerEntry(e: DowntimeLogEntry): boolean {
  return e.entryType === undefined;
}
