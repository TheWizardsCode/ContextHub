/**
 * src/validators/start-on.ts — validation and normalisation of the
 * `--start-on` CLI flag (WL-0MWMGEREG002L2YA, parent WL-0MWM0FDZK007BAD0).
 *
 * ## Why the authoring path is strict
 *
 * The stored value is a *scheduling gate*: an item whose `startOn` is in the
 * future is filtered out of every search surface and refused by every claim
 * path, so a mis-read instant silently delays work by hours (or fires a
 * measurement window early). An ambiguous input is therefore rejected rather
 * than guessed at:
 *
 * - a **bare date** (`2026-11-19`) is not a date/time, and the midnight it
 *   would imply is ambiguous across timezones (AC2 requirement);
 * - a **time with no timezone designator** has the same problem — it is only
 *   meaningful relative to the machine's local zone;
 * - an **unparseable** value has no instant at all.
 *
 * Everything that survives validation is normalised to canonical UTC `Z` form
 * (`new Date(ms).toISOString()`) so the export bytes are stable and the stored
 * instant is identical no matter which offset the author typed.
 *
 * A blank value is *not* an error: it is the documented **clear** form, which
 * stores the item's `createdAt` as the effective instant
 * (`normalizeStartOn('', createdAt)`).
 */

/** The CLI flag this validator guards (named in every error message). */
export const START_ON_FLAG = '--start-on';

/** Accepted-example shown in every rejection: canonical UTC form. */
export const START_ON_UTC_EXAMPLE = '2026-11-19T10:25:00Z';

/** Accepted-example shown in every rejection: the same instant as an offset. */
export const START_ON_TIMEZONE_EXAMPLE = '2026-11-19T11:25:00+01:00';

/** Why a value was rejected — machine-readable for tests and callers. */
export type StartOnRejectionReason =
  | 'bare-date'
  | 'missing-time'
  | 'missing-timezone'
  | 'unparseable';

/** A successfully parsed `--start-on` value. */
export interface StartOnOptionAccepted {
  ok: true;
  /**
   * The canonical UTC `Z` instant to store (AC2 offset acceptance), or the
   * empty string for the clear form — the caller stores `createdAt` then.
   */
  value: string;
  /** True when the input was blank, i.e. "clear back to `createdAt`". */
  clear: boolean;
}

/** A rejected `--start-on` value with an actionable message. */
export interface StartOnOptionRejected {
  ok: false;
  reason: StartOnRejectionReason;
  /** The received value (trimmed), echoed in the message. */
  value: string;
  /** Actionable message naming the flag, the value and an accepted example. */
  message: string;
}

export type StartOnOptionResult = StartOnOptionAccepted | StartOnOptionRejected;

/** `YYYY-MM-DD` — a date with no time component. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `YYYY-MM-DDTHH:MM…` — the shape whose timezone designator we then inspect. */
const DATE_WITH_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/i;
/** Trailing `Z` or `±HH:MM` / `±HHMM` — an explicit (non-ambiguous) offset. */
const EXPLICIT_TIMEZONE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * Validate and normalise a `--start-on` value.
 *
 * @param raw - The flag value as typed (may be empty for the clear form).
 * @param flag - The flag name to name in the error message (defaults to
 *   `--start-on`; a sibling option can reuse the same contract).
 * @returns The canonical UTC instant to store, or an actionable rejection.
 */
export function parseStartOnOption(
  raw: string,
  flag: string = START_ON_FLAG,
): StartOnOptionResult {
  const value = raw === undefined || raw === null ? '' : String(raw).trim();

  // The documented clear form: `--start-on ""` stores the item's createdAt.
  if (value === '') {
    return { ok: true, value: '', clear: true };
  }

  const reject = (reason: StartOnRejectionReason): StartOnOptionRejected => ({
    ok: false,
    reason,
    value,
    message: formatRejection(flag, value, reason),
  });

  if (BARE_DATE.test(value)) return reject('bare-date');
  if (!DATE_WITH_TIME.test(value)) return reject('missing-time');
  if (!EXPLICIT_TIMEZONE.test(value)) return reject('missing-timezone');

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return reject('unparseable');

  return { ok: true, value: new Date(ms).toISOString(), clear: false };
}

/**
 * Build the actionable rejection message: it names the flag, echoes the
 * received value, explains why the value is unusable, shows an accepted
 * example (both UTC and offset forms) and offers the clear form.
 */
function formatRejection(flag: string, value: string, reason: StartOnRejectionReason): string {
  const explanation: Record<StartOnRejectionReason, string> = {
    'bare-date':
      'it is a bare date, not a date/time, and the midnight it would imply is ambiguous across timezones',
    'missing-time':
      'it has no ISO-8601 time component (expected the form YYYY-MM-DDTHH:MM:SS)',
    'missing-timezone':
      'it has no timezone designator (Z or an offset such as +01:00), so the instant is ambiguous',
    unparseable: 'it is not a parseable ISO-8601 timestamp',
  };

  return (
    `Invalid ${flag} value "${value}": ${explanation[reason]}. ` +
    `Expected a full ISO-8601 timestamp with an explicit timezone, ` +
    `e.g. "${START_ON_UTC_EXAMPLE}" or "${START_ON_TIMEZONE_EXAMPLE}". ` +
    `Pass ${flag} "" to clear the value back to the item's createdAt.`
  );
}
