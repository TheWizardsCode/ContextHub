/**
 * local-preference.ts — per-turn local preference and route logging
 * (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4, slice C4).
 *
 * The llama-proxy honours a per-request locality preference and reports the
 * route it took:
 *
 *   request:  `X-Local-Preference: local-preferred | remote-ok`
 *               local-preferred → the prompt stays local while it fits and is
 *               deferred with a retryable 429 + `Retry-After` when the local
 *               slot is contended (never a silent remote fallback);
 *               remote-ok       → background work may go remote without queuing
 *               local capacity.
 *   response: `X-Local-Route`            (e.g. `local`, `remote:<provider>`)
 *             `X-Local-Fallback-Reason`  (why the request left the local route)
 *
 * The retired `local-only` spelling (WL-0MVSI1S5P003UAMB, following herdr
 * WL-0MVSI1RX2005O9NE) is **not** an alias and is **not** normalised: it is
 * handled like any other invalid value — no header, no route log (fail-open).
 * Migration is a one-line setting change,
 * `HERDR_LOCAL_PREFERENCE=local-preferred` (herdr `downtimeLocalPreference:
 * local-preferred`).
 *
 * Herdr conveys the policy per spawn as the pane-launch environment variable
 * `HERDR_LOCAL_PREFERENCE` (`--local-preference` in send-to-pi.sh); this
 * module turns it into the request header on EVERY request and appends one
 * bounded JSONL route-log line per response to
 * `<cwd>/.worklog/local-route.log`, carrying the pi session id and the
 * forwarded reservation ticket so a dispatcher decision can be correlated
 * with the turns it produced (C4-AC4).
 *
 * Fail-open is mandatory (C4-AC3):
 *   - an unset/empty/invalid knob injects no header and writes no log —
 *     requests are byte-identical to today;
 *   - absent/malformed route headers write no entry;
 *   - a capture or write failure never throws into the turn.
 *
 * No new polling loop: the route log is written per response only.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** The proxy's per-turn locality preference alphabet (fixed wire contract). */
export type LocalPreference = 'local-preferred' | 'remote-ok';

/** The pane-launch environment variable herdr sets for a dispatched pane. */
export const LOCAL_PREFERENCE_ENV_VAR = 'HERDR_LOCAL_PREFERENCE';

/** The provider request header consumed by the proxy (C1-pinned). */
export const LOCAL_PREFERENCE_HEADER = 'X-Local-Preference';

/** The response header reporting the route the proxy actually took. */
export const LOCAL_ROUTE_HEADER = 'X-Local-Route';

/** The response header reporting why a request left the local route. */
export const LOCAL_FALLBACK_REASON_HEADER = 'X-Local-Fallback-Reason';

/** Pane-launch env var carrying a granted reservation ticket (slice C2). */
export const LOCAL_RESERVATION_TICKET_ENV_VAR = 'PI_LOCAL_RESERVATION_TICKET';

/** File name of the bounded route log inside `.worklog/`. */
export const LOCAL_ROUTE_LOG_FILE = 'local-route.log';

/**
 * Rolling bound: keep at most this many entries in the route log
 * (C4-AC2 — same rolling convention as the downtime logs, larger because a
 * busy pane writes one line per provider response).
 */
export const LOCAL_ROUTE_LOG_MAX_ENTRIES = 2000;

const VALID_PREFERENCES: readonly LocalPreference[] = ['local-preferred', 'remote-ok'];

/**
 * Validate a raw `HERDR_LOCAL_PREFERENCE` value.
 *
 * Strict by design: the retired `local-only` spelling is not accepted and is
 * not normalised onto `local-preferred` — it resolves exactly like any other
 * unknown value.
 *
 * @param env - Environment mapping to read (defaults to `process.env`).
 * @returns The accepted preference, or `undefined` when absent/empty/invalid.
 */
export function resolveLocalPreference(
  env: Record<string, string | undefined> = process.env,
): LocalPreference | undefined {
  const raw = env[LOCAL_PREFERENCE_ENV_VAR];
  if (typeof raw !== 'string' || raw === '') return undefined;
  return (VALID_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as LocalPreference)
    : undefined;
}

/** Trim a header value, treating blank values as absent. */
function headerValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parse the proxy's route headers from an `after_provider_response` header
 * map. Header names are matched case-insensitively (pi normalises to
 * lower-case, but a provider may pass the canonical form through).
 *
 * Malformed/blank values are treated as absent — never as a partial entry.
 */
export function readRouteHeaders(headers: Record<string, string>): {
  route?: string;
  fallbackReason?: string;
} {
  // Match by lower-cased name so every casing a provider may pass through
  // (`x-local-route`, `X-Local-Route`, …) is found.
  const source = headers ?? {};
  const found = new Map<string, string>();
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string') found.set(name.toLowerCase(), value);
  }
  const route = headerValue(found.get(LOCAL_ROUTE_HEADER.toLowerCase()));
  const fallbackReason = headerValue(
    found.get(LOCAL_FALLBACK_REASON_HEADER.toLowerCase()),
  );
  return {
    ...(route !== undefined ? { route } : {}),
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
  };
}

/** One route-log line: the per-response route evidence (C4-AC2/AC4). */
export interface RouteLogEntry {
  /** ISO-8601 UTC timestamp of the response. */
  at: string;
  /** Pi session id, so dispatcher decisions correlate with turns (C4-AC4). */
  sessionId?: string;
  /** Preference actually sent (present only when the knob was set). */
  preference?: LocalPreference;
  /** Route reported by the proxy (`X-Local-Route`). */
  route?: string;
  /** Why the request left the local route (`X-Local-Fallback-Reason`). */
  fallbackReason?: string;
  /** Model id the response was produced with, when available. */
  model?: string;
  /** Reservation ticket forwarded to this pane, when one was (C4-AC4). */
  ticket?: string;
}

/**
 * Build a route-log entry from one response's parsed headers.
 *
 * Returns `null` when NO usable route evidence is present — an older proxy
 * (no route headers) writes no entry (C4-AC2), and C4-AC3 requires no
 * behaviour change for requests that carry no preference.
 */
export function buildRouteLogEntry(opts: {
  sessionId?: string;
  preference?: LocalPreference;
  model?: string;
  ticket?: string;
  at?: string;
  route?: string;
  fallbackReason?: string;
}): RouteLogEntry | null {
  const route = headerValue(opts.route);
  const fallbackReason = headerValue(opts.fallbackReason);
  if (route === undefined && fallbackReason === undefined) return null;
  return {
    at: opts.at ?? new Date().toISOString(),
    ...(opts.sessionId !== undefined && opts.sessionId !== ''
      ? { sessionId: opts.sessionId }
      : {}),
    ...(opts.preference !== undefined ? { preference: opts.preference } : {}),
    ...(route !== undefined ? { route } : {}),
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
    ...(opts.model !== undefined && opts.model !== ''
      ? { model: opts.model }
      : {}),
    ...(opts.ticket !== undefined && opts.ticket !== '' ? { ticket: opts.ticket } : {}),
  };
}

/**
 * Append one entry to `<cwd>/.worklog/local-route.log`, bounded to the most
 * recent {@link LOCAL_ROUTE_LOG_MAX_ENTRIES} entries.
 *
 * ATOMIC: the new content is written to a temporary sibling and renamed over
 * the target, so a concurrent reader never observes a truncated log.
 * Throws on I/O failure — callers on the turn path must catch (see
 * {@link recordRouteEntry}).
 */
export async function appendRouteLogEntry(cwd: string, entry: RouteLogEntry): Promise<void> {
  const dir = join(cwd, '.worklog');
  const filePath = join(dir, LOCAL_ROUTE_LOG_FILE);
  await mkdir(dir, { recursive: true });

  let lines: string[] = [];
  try {
    const existing = await readFile(filePath, 'utf8');
    lines = existing.split('\n').filter((ln) => ln.trim() !== '');
  } catch {
    lines = []; // first entry or unreadable file → start fresh
  }

  lines.push(JSON.stringify(entry));
  if (lines.length > LOCAL_ROUTE_LOG_MAX_ENTRIES) {
    lines = lines.slice(lines.length - LOCAL_ROUTE_LOG_MAX_ENTRIES);
  }

  // Temp name carries pid + a random suffix so two concurrent writers never
  // collide on the same temp path. Same directory → same filesystem, so the
  // rename is atomic.
  const tmpPath = join(dir, `.${LOCAL_ROUTE_LOG_FILE}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Fail-open wrapper around {@link appendRouteLogEntry}: a capture or write
 * failure must never break a turn (C4-AC3). Resolves to whether the entry
 * was written (observability only — callers never branch on it).
 */
export async function recordRouteEntry(
  cwd: string,
  entry: RouteLogEntry,
): Promise<boolean> {
  try {
    await appendRouteLogEntry(cwd, entry);
    return true;
  } catch {
    return false;
  }
}

/** Minimal shape of the header map mutated by the `before_provider_headers` hook. */
type MutableHeaders = Record<string, string | null | undefined>;

/** The extension context fields this module reads (kept loose for tests). */
interface RouteContext {
  cwd?: string;
  model?: { id?: string };
  sessionManager?: { getSessionId?: () => string };
}

/** Read the pi session id from a context, never throwing. */
function safeSessionId(ctx: RouteContext | undefined): string | undefined {
  try {
    return ctx?.sessionManager?.getSessionId?.() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register the per-turn local-preference hooks on a pi extension instance.
 *
 * - `before_provider_headers` — inject `X-Local-Preference` from
 *   `HERDR_LOCAL_PREFERENCE` on every request (read per request, never
 *   cached, so a re-launched session is never stale);
 * - `after_provider_response` — parse `X-Local-Route` /
 *   `X-Local-Fallback-Reason` and append one bounded route-log line,
 *   carrying the session id, model and forwarded reservation ticket.
 *
 * Both hooks are no-ops when the knob is unset (byte-identical requests, no
 * log) and never throw. @param pi - The pi extension API.
 */
export function registerLocalPreference(pi: ExtensionAPI): void {
  pi.on('before_provider_headers', (event) => {
    try {
      const preference = resolveLocalPreference();
      if (preference === undefined) return;
      (event.headers as MutableHeaders)[LOCAL_PREFERENCE_HEADER] = preference;
    } catch {
      // fail-open: a broken header hook must never break a request (C4-AC3)
    }
  });

  pi.on('after_provider_response', (event, ctx) => {
    try {
      const preference = resolveLocalPreference();
      // No knob → no header was sent, so there is no per-turn preference
      // evidence to record (C4-AC3: no behaviour change).
      if (preference === undefined) return;

      const headers = (event.headers ?? {}) as Record<string, string>;
      const { route, fallbackReason } = readRouteHeaders(headers);
      const routeCtx = ctx as unknown as RouteContext | undefined;
      const cwd = routeCtx?.cwd;
      if (cwd === undefined || cwd === '') return;

      const entry = buildRouteLogEntry({
        sessionId: safeSessionId(routeCtx),
        preference,
        model: routeCtx?.model?.id,
        ticket: process.env[LOCAL_RESERVATION_TICKET_ENV_VAR],
        route,
        fallbackReason,
      });
      if (entry === null) return;

      // Fire-and-forget: the response stream must never wait on the log, and
      // a write failure is swallowed (fail-open).
      void recordRouteEntry(cwd, entry);
    } catch {
      // fail-open: route capture must never break a turn (C4-AC3)
    }
  });
}
