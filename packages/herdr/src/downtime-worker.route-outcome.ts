/**
 * packages/herdr/src/downtime-worker.route-outcome.ts — observed routing
 * outcome for a dispatched pane (WL-0MVWEZF4Z004UNYT AC10).
 *
 * The dispatch record must carry the OBSERVED local/remote split of the work
 * a dispatched session actually did — sourced from the bounded route log
 * (`.worklog/local-route.log`, written ONE line per admitted provider
 * response by the Worklog pi extension at
 * `packages/tui/extensions/local-preference/local-preference.ts`), NEVER
 * inferred from the reservation ticket (a granted ticket says nothing about
 * where the turns ran).
 *
 * Attribution: route-log lines carry the pi `sessionId` and, when a ticket
 * was forwarded, the reservation `ticket` (C4-AC4). A dispatch's outcome is
 * therefore computed over the entries whose `ticket` matches the marker's
 * `reservationTicketId` (unambiguous, present only when a ticket existed) or
 * whose `sessionId` matches the pane's session. When neither key is available
 * — or the session made no classifiable requests — the outcome is recorded
 * as `notObserved` (never as healthy).
 *
 * The outcome is written as a `entryType: 'route-outcome'` line in the
 * rolling `.worklog/downtime-dispatches.log` at the pane's work-window close
 * (the pane-close reaper), so a green dispatch record can never hide a
 * 0 %-local run. Fail-open at every boundary: an unreadable route log,
 * missing marker or a malformed line never throws and never blocks a pane
 * close.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  appendDowntimeLogEntry,
  readDowntimeLogEntries,
  type DowntimeLogEntry,
} from './downtime-log.js';

/** File name of the bounded route log inside `.worklog/`. */
export const LOCAL_ROUTE_LOG_FILE = 'local-route.log';

/**
 * One parsed line of the bounded route log (`.worklog/local-route.log`).
 * All fields optional so malformed or foreign lines never break parsing.
 */
export interface RouteLogLine {
  /** ISO-8601 UTC timestamp of the response. */
  at?: string;
  /** Pi session id that produced the response. */
  sessionId?: string;
  /** Preference actually sent (`local-preferred` / `remote-ok`). */
  preference?: string;
  /** Route reported by the proxy (`X-Local-Route`): `local` / `remote:<provider>`. */
  route?: string;
  /** Why the request left the local route (`X-Local-Fallback-Reason`). */
  fallbackReason?: string;
  /** Reservation ticket forwarded to this pane, when one was (C4-AC4). */
  ticket?: string;
  /** Model id the response was produced with, when available. */
  model?: string;
  [extra: string]: unknown;
}

/** True when a route means the request was served by the local backend. */
export function isLocalRoute(route: unknown): boolean {
  return route === 'local';
}

/** True when a route means the request left the local backend (`remote:<provider>`). */
export function isRemoteRoute(route: unknown): boolean {
  return typeof route === 'string' && route.startsWith('remote');
}

/**
 * Read the bounded route log at `<cwd>/.worklog/local-route.log`.
 * FAIL-SAFE by the same contract as `readDowntimeLogEntries`: a missing or
 * unreadable log yields `[]` (a missing log is the normal state for a pane
 * that made no requests), malformed JSONL lines are skipped, and the function
 * never throws.
 */
export async function readLocalRouteLogEntries(cwd: string): Promise<RouteLogLine[]> {
  const file = join(cwd, '.worklog', LOCAL_ROUTE_LOG_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return []; // missing or unreadable → empty (fail-safe)
  }
  const entries: RouteLogLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        entries.push(parsed as RouteLogLine);
      }
    } catch {
      // malformed line → skip (fail-safe)
    }
  }
  return entries;
}

/**
 * The AC10 observed-outcome surface for one dispatch:
 *   - `{ observed: true, localStreams, remoteStreams }` — the session made
 *     requests and their routes were classifiable;
 *   - `{ observed: false }` — NOTHING classifiable was seen (no requests at
 *     all, unclassifiable routes, or no attribution key) — recorded as
 *     `notObserved`, never as healthy.
 */
export type RouteSplitOutcome =
  | { observed: true; localStreams: number; remoteStreams: number }
  | { observed: false };

/**
 * Compute the local/remote split over route-log entries, attributed to one
 * dispatch. Attribution precedence:
 *   1. `ticket` — entries carrying the dispatched pane's reservation ticket
 *      (unambiguous single-session correlation, C4-AC4);
 *   2. `sessionId` — entries from the pane's pi session;
 *   3. neither — every entry in the log (used only when the caller can prove
 *      the log is session-scoped; never the production default).
 * Entries with no classifiable route are ignored for the split; when no
 * classifiable entry remains the outcome is `observed: false` (notObserved).
 */
export function computeRouteSplit(
  entries: RouteLogLine[],
  opts: { sessionId?: string; ticket?: string } = {},
): RouteSplitOutcome {
  let local = 0;
  let remote = 0;
  for (const entry of entries) {
    if (opts.ticket !== undefined && entry.ticket !== opts.ticket) continue;
    if (opts.ticket === undefined && opts.sessionId !== undefined && entry.sessionId !== opts.sessionId) {
      continue;
    }
    if (isLocalRoute(entry.route)) local += 1;
    else if (isRemoteRoute(entry.route)) remote += 1;
    // Unclassifiable route → ignored for the split (never counted either way).
  }
  if (local + remote === 0) return { observed: false };
  return { observed: true, localStreams: local, remoteStreams: remote };
}

/**
 * Derive the pi session id from a session-log path. pi stores session logs as
 * `<root>/<--encoded-cwd-->//<timestamp>_<sessionId>.jsonl` (e.g.
 * `2026-10-29T00-44-13-965Z_herdr-1793234652-1770391-437.jsonl`), and the
 * route log's `sessionId` field is that same `<sessionId>`. Returns
 * `undefined` for anything that does not look like that shape (fail-safe).
 */
export function sessionIdFromSessionPath(sessionPath: string): string | undefined {
  if (typeof sessionPath !== 'string' || sessionPath === '') return undefined;
  const fileName = sessionPath.split(/[\\/]/).pop() ?? '';
  const withoutExt = fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length) : fileName;
  const idx = withoutExt.indexOf('_');
  if (idx < 0) return undefined;
  const sessionId = withoutExt.slice(idx + 1);
  return sessionId === '' ? undefined : sessionId;
}

/**
 * One `route-outcome` entry in the rolling dispatch log, written when a
 * dispatched pane's work window closes (AC10). `entryType: 'route-outcome'`
 * keeps it invisible to the dispatched-marker readers (they skip every
 * typed entry) while sharing the item's identity with the dispatch marker.
 */
export interface RouteOutcomeEntry {
  entryType: 'route-outcome';
  itemId: string;
  paneId: string;
  kind?: string;
  /** Dispatch marker's `dispatchedAt` (correlation key with the marker). */
  dispatchedAt?: string;
  /** ISO-8601 UTC timestamp of the observation (the window close). */
  timestamp: string;
  /** Reservation ticket the pane was given, when one existed (attribution key). */
  ticket?: string;
  /** Pi session id the split was attributed to, when known. */
  sessionId?: string;
  /** Observed local streams (count of `route: 'local'` responses). */
  localStreams?: number;
  /** Observed remote streams (count of `route: 'remote:*'` responses). */
  remoteStreams?: number;
  /** True when observed requests consumed 0 local capacity (AC10). */
  localStarved?: boolean;
  /** True when NO classifiable route evidence was observed (never healthy). */
  notObserved?: boolean;
  /** Distinct `X-Local-Fallback-Reason` values observed (proxy `local_route_reason`). */
  fallbackReasons?: string[];
  /** Preference the dispatched pane actually used, when known. */
  preference?: string;
}

/**
 * Build a route-outcome entry from a computed split and the dispatch's
 * identity. Never throws; returns the entry (callers append it to the
 * rolling dispatch log).
 */
export function buildRouteOutcomeEntry(opts: {
  itemId: string;
  paneId: string;
  kind?: string;
  dispatchedAt?: string;
  ticket?: string;
  sessionId?: string;
  split: RouteSplitOutcome;
  preference?: string;
  fallbackReasons?: string[];
  timestamp?: string;
}): RouteOutcomeEntry {
  const base: RouteOutcomeEntry = {
    entryType: 'route-outcome',
    itemId: opts.itemId,
    paneId: opts.paneId,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.dispatchedAt !== undefined ? { dispatchedAt: opts.dispatchedAt } : {}),
    ...(opts.ticket !== undefined ? { ticket: opts.ticket } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts.preference !== undefined ? { preference: opts.preference } : {}),
    ...(opts.fallbackReasons !== undefined && opts.fallbackReasons.length > 0
      ? { fallbackReasons: opts.fallbackReasons }
      : {}),
  };
  if (!opts.split.observed) return { ...base, notObserved: true };
  return {
    ...base,
    localStreams: opts.split.localStreams,
    remoteStreams: opts.split.remoteStreams,
    localStarved: opts.split.localStreams === 0,
  };
}

/** Distinct non-empty fallback reasons across attributed route entries. */
function fallbackReasonsOf(
  entries: RouteLogLine[],
  opts: { sessionId?: string; ticket?: string },
): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (opts.ticket !== undefined && entry.ticket !== opts.ticket) continue;
    if (opts.ticket === undefined && opts.sessionId !== undefined && entry.sessionId !== opts.sessionId) {
      continue;
    }
    if (typeof entry.fallbackReason === 'string' && entry.fallbackReason !== '') {
      seen.add(entry.fallbackReason);
    }
  }
  return [...seen];
}

/** WARN line (AC10): the dispatched work was prefer-local yet consumed 0 local. */
function warnLocalStarved(entry: RouteOutcomeEntry): void {
  try {
    process.stderr.write(
      `[worklog-plugin] Downtime local-starved: dispatch ${entry.itemId} (pane ${entry.paneId}) ` +
        `was prefer-local but consumed 0 local / ${entry.remoteStreams ?? 0} remote streams` +
        (entry.fallbackReasons !== undefined && entry.fallbackReasons.length > 0
          ? ` (local_route_reason: ${entry.fallbackReasons.join(', ')})`
          : '') +
        '\n',
    );
  } catch {
    // fail-closed: the WARN line must never crash the worker
  }
}

/**
 * Observe one dispatched pane's routing outcome at its work-window close and
 * append the `route-outcome` entry to `<cwd>/.worklog/downtime-dispatches.log`
 * (AC10, WL-0MVWEZF4Z004UNYT).
 *
 * Attribution: the dispatch marker's `reservationTicketId` (when present) or
 * the pane's `sessionId`. A missing marker or an unattributable/unobserved
 * session records `notObserved: true` — the honest answer, never healthy.
 * Emits a WARNING line when the pane was `local-preferred` and consumed
 * 0 local streams.
 *
 * FAIL-OPEN: any failure (unreadable log, missing marker, append error) is
 * swallowed — route-outcome observability must never block or crash a pane
 * close.
 */
export async function observeDispatchedPaneOutcome(
  cwd: string,
  opts: { itemId: string; paneId: string; sessionId?: string; kind?: string },
): Promise<void> {
  try {
    const entries = await readDowntimeLogEntries(cwd);
    // The marker (or its post-spawn enrichment copy) for this item: the LAST
    // untyped entry carrying a dispatchedAt. Typed entries (pane-close,
    // route-outcome, error) are never markers.
    let marker: DowntimeLogEntry & {
      reservationTicketId?: unknown;
      localPreference?: unknown;
    } | undefined;
    for (const e of entries) {
      if (e.entryType !== undefined) continue;
      if (e.itemId !== opts.itemId) continue;
      if (typeof e.dispatchedAt !== 'string') continue;
      marker = e as DowntimeLogEntry & {
        reservationTicketId?: unknown;
        localPreference?: unknown;
      };
    }
    if (marker === undefined) return; // never dispatched from this log — nothing to observe

    const ticket =
      typeof marker.reservationTicketId === 'string' && marker.reservationTicketId !== ''
        ? marker.reservationTicketId
        : undefined;
    const preference =
      typeof marker.localPreference === 'string' ? (marker.localPreference as string) : undefined;

    const routeEntries = await readLocalRouteLogEntries(cwd);
    const attributed = { ticket, sessionId: ticket === undefined ? opts.sessionId : undefined };
    const split = computeRouteSplit(routeEntries, attributed);
    const entry = buildRouteOutcomeEntry({
      itemId: opts.itemId,
      paneId: opts.paneId,
      kind: typeof marker.kind === 'string' ? marker.kind : opts.kind,
      dispatchedAt: marker.dispatchedAt,
      ticket,
      sessionId: attributed.sessionId,
      split,
      preference,
      fallbackReasons: fallbackReasonsOf(routeEntries, attributed),
    });
    await appendDowntimeLogEntry(cwd, JSON.stringify(entry));

    if (entry.localStarved === true && preference === 'local-preferred') {
      warnLocalStarved(entry);
    }
  } catch {
    // fail-open: observability must never crash the worker
  }
}
