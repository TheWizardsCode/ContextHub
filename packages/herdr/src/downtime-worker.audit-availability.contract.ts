/**
 * packages/herdr/src/downtime-worker.audit-availability.contract.ts — the
 * proxy audit-availability read's WIRE types and tolerant parser (parent
 * WL-0MW95GBEG005ERHS, child WL-0MWAMS1PW000O3OS).
 *
 * Single responsibility: pin the client-side contract of the proxy's
 * audit-availability endpoint BEFORE the server exists — the typed
 * {@link AuditAvailability} result, the canonical refusal-reason token and the
 * fail-closed parser. The HTTP client (WL-0MWAMSCOP003R837) and the audit gate
 * (WL-0MWAMSDNW000SL0E) are built against this; NOTHING here is called on the
 * dispatch path yet (no behaviour change), exactly as the reserve-handshake
 * slice C1 did (`downtime-worker.local-reservation.ts`).
 *
 * ## Why the contract is pinned to the shipped wire shape
 *
 * The proxy side is sibling llm item LP-0MW95FYMH006XYNK, which has SHIPPED:
 * validated 2026-11-13 against the live proxy (`http://192.168.0.199:8000`),
 * `GET /llama/local/audit/availability` answers `200`
 * `{"cap":1,"live":0,"available":1,"leases":[],"max_audits":1}` while
 * `/llama/local/audit/status` answers `404`. The path is therefore the one
 * constant `AUDIT_AVAILABILITY_PATH` (overridable through
 * `HERDR_AUDIT_AVAILABILITY_PATH`) in `downtime-worker.constants.ts`, the
 * shipped `available` verdict is the NUMBER `0`/`1` (coerced by the parser),
 * and the field names whose spelling may still evolve are read through a
 * small alias set so a rename on either side stays a one-line change.
 *
 * ## Trust rules
 *
 * The parser is fail-closed: a payload is usable only when `cap`, `live` and
 * the proxy's OWN `available` verdict are all trustworthy, and every other
 * outcome is `null`. In particular `available` is never derived from `cap` /
 * `live` — a missing verdict is unusable, never "available". The only values
 * accepted as a verdict are a real boolean and the proxy's shipped numeric
 * `0`/`1`; `2`, `-1`, a string, `null` or an object fails closed. Additive
 * proxy fields are ignored, so the contract can evolve without breaking this
 * reader.
 */

// ── Wire vocabulary ───────────────────────────────────────────────────

/**
 * The proxy's canonical refusal-reason token for a saturated audit budget
 * (parent AC2, "one vocabulary, no disagreement"): a dispatcher admission and
 * a proxy refusal must quote the same token, so a divergence is attributable
 * rather than a silent policy split. The parsed `reason` field stays an OPEN
 * vocabulary — consumers never branch on an unknown token.
 */
export const AUDIT_BUDGET_SATURATED_REASON = 'audit-budget-saturated';

/**
 * The audit gate's canonical fail-closed token (parent AC3, WL-0MWAMSDNW000SL0E):
 * the proxy could not answer (absent endpoint, unreachable, or an unparsable
 * body), so availability is UNKNOWN and audit dispatch stops. Defined here
 * beside {@link AUDIT_BUDGET_SATURATED_REASON} so the audit gate and the
 * decision log share the proxy's own vocabulary instead of inventing a local
 * spelling.
 */
export const AUDIT_BUDGET_UNKNOWN_REASON = 'audit-budget-unknown';

/**
 * One live audit lease on the proxy. `expiresAt` is the only substantive
 * field: a lease with no usable expiry cannot be reasoned about, so a
 * malformed entry makes the whole payload unusable (fail-closed).
 *
 * The shipped proxy serves `leases: []` while the budget is idle. The expiry
 * is pinned as epoch MILLISECONDS; a proxy that serves epoch seconds (or an
 * ISO-8601 string) is handled by the string form below. Lease acquisition and
 * expiry semantics are deferred to WL-0MWFJH3NW006F5GN, so this reader only
 * reports what the availability observation serves.
 */
export interface AuditAvailabilityLease {
  /** Proxy lease identity when served (open vocabulary; never branched on). */
  id?: string;
  /** Absolute lease expiry as epoch milliseconds. */
  expiresAt: number;
}

/**
 * Parsed audit availability: the proxy's audit cap, its live lease count, its
 * OWN availability verdict and the optional supporting detail. Every number
 * here is finite and non-negative; `available` is always the proxy's field,
 * never a locally derived guess.
 */
export interface AuditAvailability {
  /** Proxy-reported audit cap (finite, >= 0). */
  cap: number;
  /** Proxy-reported live audit leases (finite, >= 0). */
  live: number;
  /** The proxy's availability verdict, taken verbatim from its payload. */
  available: boolean;
  /** Live leases with their expiry, when the proxy serves the array. */
  leases?: AuditAvailabilityLease[];
  /** Leases the proxy reclaimed for this read (finite, >= 0), when served. */
  reclaimed?: number;
  /** The proxy's refusal reason when it serves one (open vocabulary). */
  reason?: string;
}

// ── Alias sets (names the proxy has not fixed yet) ────────────────────

/** Audit-cap aliases: `cap` (preferred), `max`, `max_audit`. */
const CAP_KEYS: readonly string[] = ['cap', 'max', 'max_audit'];
/** Live-lease aliases: `live` (preferred), `in_flight`, `live_leases`. */
const LIVE_KEYS: readonly string[] = ['live', 'in_flight', 'live_leases'];
/** Availability-verdict aliases: `available` (preferred), `can_admit`. */
const AVAILABLE_KEYS: readonly string[] = ['available', 'can_admit'];
/** Refusal-reason aliases: `reason` (preferred), `refusal_reason`. */
const REASON_KEYS: readonly string[] = ['reason', 'refusal_reason'];
/** Lease identity aliases (all optional — only the expiry is substantive). */
const LEASE_ID_KEYS: readonly string[] = ['id', 'lease_id', 'ticket_id', 'owner'];
/** Lease expiry aliases (epoch ms number, or a `Date.parse`-able string). */
const LEASE_EXPIRY_KEYS: readonly string[] = [
  'expires_at',
  'expires_at_ms',
  'expiry',
  'expiresAt',
];
/** Reclaimed-lease count key (fixed name, no alias). */
const RECLAIMED_KEYS: readonly string[] = ['reclaimed'];

// ── Tolerant readers ──────────────────────────────────────────────────

/** True for a plain JSON object (not `null`, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The value of the FIRST alias present as a `number` (even if it is
 * `NaN`/`Infinity`/negative — the caller validates it). An alias that is
 * present but non-numeric (`null`, a string, `undefined`) is skipped, so a
 * missing field never shadows a usable documented alias.
 */
function firstNumber(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * The value of the FIRST alias present as a usable availability verdict, else
 * `undefined`.
 *
 * A real `boolean` is taken verbatim. The SHIPPED proxy sends the verdict as
 * the NUMBER `0`/`1` (`{"cap":1,"live":0,"available":1,...}`), so exactly
 * those two numbers are coerced (`0` → `false`, `1` → `true`). Every other
 * value — a string (`"true"`, `"1"`), `null`, an object, an array, `2`, `-1`,
 * `NaN` — is NOT a verdict and is skipped, so the parser stays fail-closed and
 * an unparsable earlier alias never shadows a usable later alias.
 */
function firstBoolean(
  source: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    // Strict equality excludes every non-number (notably `false === 0` is
    // false), so only the proxy's numeric 0/1 verdict is coerced.
    if (value === 0) return false;
    if (value === 1) return true;
  }
  return undefined;
}

/** The value of the FIRST alias present as a non-empty `string`, else `undefined`. */
function firstNonEmptyString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** A usable, non-negative finite count; `undefined` for anything else. */
function nonNegativeFinite(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** Parse one lease expiry: a positive finite epoch-ms number, or an ISO-8601 string. */
function parseLeaseExpiry(source: Record<string, unknown>): number | undefined {
  for (const key of LEASE_EXPIRY_KEYS) {
    const value = source[key];
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value > 0) return value;
      return undefined; // a malformed primary alias fails closed
    }
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      return undefined; // an unparseable primary alias fails closed
    }
  }
  return undefined;
}

/** Parse the optional `leases` array; `undefined` when absent, `null` when unusable. */
function parseLeases(raw: Record<string, unknown>): AuditAvailabilityLease[] | undefined | null {
  if (!('leases' in raw) || raw.leases === undefined) return undefined;
  if (!Array.isArray(raw.leases)) return null;
  const leases: AuditAvailabilityLease[] = [];
  for (const entry of raw.leases) {
    if (!isPlainObject(entry)) return null;
    const expiresAt = parseLeaseExpiry(entry);
    if (expiresAt === undefined) return null;
    const lease: AuditAvailabilityLease = { expiresAt };
    const id = firstNonEmptyString(entry, LEASE_ID_KEYS);
    if (id !== undefined) lease.id = id;
    leases.push(lease);
  }
  return leases;
}

// ── Parser ────────────────────────────────────────────────────────────

/**
 * Fail-closed parse of a proxy audit-availability response. Returns a typed
 * {@link AuditAvailability} only when the payload is usable, and `null` for
 * EVERY other outcome — a non-2xx status, a non-object body, a missing or
 * non-finite/negative `cap` or `live`, a missing/invalid availability
 * verdict (a real boolean or the shipped numeric `0`/`1`), a `leases` value
 * that is not an array, or a malformed lease entry.
 *
 * `available` is copied from the proxy's own field (`available` / `can_admit`)
 * and NEVER derived from `cap` / `live`: a payload without a verdict is
 * unusable rather than optimistically available. This function never throws,
 * so a garbage payload can never crash or admit an audit.
 *
 * `httpStatus` is the status the caller observed; any non-2xx value means
 * "no usable availability response".
 */
export function parseAuditAvailabilityResponse(
  raw: unknown,
  httpStatus: number,
): AuditAvailability | null {
  if (!Number.isFinite(httpStatus) || httpStatus < 200 || httpStatus > 299) return null;
  if (!isPlainObject(raw)) return null;

  const cap = nonNegativeFinite(firstNumber(raw, CAP_KEYS));
  const live = nonNegativeFinite(firstNumber(raw, LIVE_KEYS));
  const available = firstBoolean(raw, AVAILABLE_KEYS);
  if (cap === undefined || live === undefined || available === undefined) return null;

  const result: AuditAvailability = { cap, live, available };

  const leases = parseLeases(raw);
  if (leases === null) return null;
  if (leases !== undefined) result.leases = leases;

  if ('reclaimed' in raw && raw.reclaimed !== undefined) {
    const reclaimed = nonNegativeFinite(firstNumber(raw, RECLAIMED_KEYS));
    if (reclaimed === undefined) return null;
    result.reclaimed = reclaimed;
  }

  const reason = firstNonEmptyString(raw, REASON_KEYS);
  if (reason !== undefined) result.reason = reason;

  return result;
}
