/**
 * src/claim-start-on.ts — the `startOn` **claim guard** and its audited
 * override (WL-0MWMGEUT10056MUI, parent WL-0MWM0FDZK007BAD0).
 *
 * ## Why
 *
 * The default read filter (WL-0MWMGET8N009KG33) hides not-yet-started items
 * from every search surface, but that is only defence in depth: a direct
 * `wl update <id> --status in_progress`, an id-targeted assignee claim, the
 * Herdr claim path and the `StatusLifecycle` claim helper all bypass the read
 * filter and would happily claim work whose `startOn` has not been reached.
 * This module is the write-side gate that makes such a claim structurally
 * impossible — with one deliberate, auditable escape hatch.
 *
 * ## Semantics
 *
 * - A **claim attempt** is an update that either sets the status to
 *   `in-progress`/`in_progress` or sets a non-empty `assignee` (the Herdr
 *   audit tier's status-neutral claim is assignee-only, so both shapes must be
 *   recognised). Clearing an assignee (`""`) is a release, never a claim.
 * - The guard fires **only** for an **explicit future** `startOn`. A
 *   `createdAt`-defaulted item can never be refused (the epic's AC1
 *   back-compat rule) — even in the pathological case where its `createdAt`
 *   lies in the future — and an item whose effective instant is at or before
 *   `now` is always claimable (the boundary is inclusive: `startOn == now`
 *   counts as started).
 * - The guard is an **additional** sequential refusal: it never replaces the
 *   `assignee` hold, dependency readiness or `needsProducerReview`. It simply
 *   runs before the claim write, alongside them.
 * - `now` is an explicit parameter (defaulting to `Date.now()`), so tests
 *   inject a frozen clock from `tests/helpers/frozen-clock.ts` and the
 *   comparison is deterministic.
 *
 * ## The audited override
 *
 * `wl update <id> --force-start-on "<reason>"` proceeds with the claim and
 * records a comment naming the actor, the reason and the overridden `startOn`
 * (see {@link buildStartOnOverrideComment}). The override is only honoured —
 * and only recorded — when it actually bypasses a not-yet-reached instant, so
 * passing the flag on an already-started item produces no spurious audit
 * entry.
 *
 * Kept in the CLI layer (not `@worklog/shared`) because worktrees resolve
 * `@worklog/shared` to the main checkout's built `dist`, so shared changes are
 * invisible to the worktree test suite; the CLI layer is fully testable here.
 */

import { effectiveStartOn, isNotStarted } from '@worklog/shared/predicates';

/** Machine-readable refusal token (AC5). */
export const START_ON_NOT_REACHED_REASON = 'start_on_not_reached';

/** The audited-override flag the CLI exposes. */
export const FORCE_START_ON_FLAG = '--force-start-on';

/** The item fields the guard reads (structural, so tests can use literals). */
export interface ClaimGuardItem {
  /** Work-item id — only used to name the item in the refusal message. */
  id?: string;
  /** Creation instant (ISO-8601). Absent/unreadable reads as "started". */
  createdAt?: string | null;
  /** Earliest instant the item may proceed (ISO-8601). */
  startOn?: string | null;
}

/** What an `wl update` is about to write, as far as claims are concerned. */
export interface ClaimIntent {
  /** The status the update will write (canonical, e.g. `in-progress`). */
  status?: string | null;
  /** The assignee the update will write (`undefined` = not written). */
  assignee?: string | null;
}

/**
 * True when this update is a **claim attempt**.
 *
 * Covers both claim shapes the workflow uses: the status-flip claim
 * (`status: in-progress`) and the status-neutral assignee-only claim used by
 * the Herdr audit tier (`--assignee <agent> --if-assignee ""`). A blank or
 * omitted assignee is not a claim — clearing an assignee is a release.
 */
export function isClaimAttempt(intent: ClaimIntent): boolean {
  if (!intent) return false;
  const status = String(intent.status ?? '').trim().toLowerCase();
  if (status === 'in-progress' || status === 'in_progress') return true;
  return typeof intent.assignee === 'string' && intent.assignee.trim() !== '';
}

/** Options for {@link evaluateClaimStartOn}. */
export interface ClaimGuardOptions {
  /** The item being claimed (its current stored state). */
  item: ClaimGuardItem;
  /** What the update is about to write. */
  intent: ClaimIntent;
  /**
   * The `--force-start-on` reason, when supplied. A non-blank reason bypasses
   * a not-yet-reached refusal (and is recorded by the caller).
   */
  overrideReason?: string | null;
  /** Comparison instant in epoch milliseconds (default: `Date.now()`). */
  now?: number;
}

/** The result of evaluating the guard for one claim attempt. */
export interface ClaimGuardEvaluation {
  /** True when the claim must be refused. */
  refused: boolean;
  /** Machine-readable reason — present only when `refused`. */
  reason?: typeof START_ON_NOT_REACHED_REASON;
  /** The item's effective `startOn` (canonical UTC) when the guard engaged. */
  startOn?: string;
  /** Milliseconds from `now` until the instant is reached (positive). */
  msUntilStart?: number;
  /** Actionable refusal message — present only when `refused`. */
  message?: string;
  /** True when a supplied override bypassed a not-yet-reached instant. */
  overridden?: boolean;
  /** The override reason that bypassed the refusal (trimmed). */
  overrideReason?: string;
}

/** Epoch ms of an ISO-8601 string, or `null` when absent/unreadable. */
function parseMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when the item carries an **explicit** `startOn` — i.e. a value that is
 * present and differs from its `createdAt` default.
 *
 * The store always populates the column with the effective instant
 * (`startOn ?? createdAt`, D1), so `startOn === createdAt` is the only signal
 * that the value was *defaulted* rather than scheduled. A defaulted item must
 * never be refused, even if (pathologically) its `createdAt` is in the future.
 * An absent/unreadable `createdAt` with a readable `startOn` counts as
 * explicit (there is nothing to default to).
 */
function hasExplicitStartOn(item: ClaimGuardItem): boolean {
  const startMs = parseMs(item.startOn);
  if (startMs === null) return false; // absent/unreadable → fail open
  const createdMs = parseMs(item.createdAt);
  if (createdMs === null) return true; // no default to compare against
  return startMs !== createdMs;
}

/**
 * Human duration until an instant, e.g. `2 days 3 hours` or `45 minutes`.
 *
 * The two most significant non-zero units are shown, so the message reads
 * naturally at every scale while staying short. Seconds are shown only when
 * nothing larger applies. Always at least `1 second` (the guard never refuses
 * an already-reached instant).
 */
export function formatDurationUntil(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const plural = (value: number, unit: string): string =>
    `${value} ${unit}${value === 1 ? '' : 's'}`;

  const parts: string[] = [];
  if (days > 0) parts.push(plural(days, 'day'));
  if (hours > 0) parts.push(plural(hours, 'hour'));
  if (minutes > 0) parts.push(plural(minutes, 'minute'));
  if (days === 0 && hours === 0) parts.push(plural(seconds, 'second'));

  return parts.slice(0, 2).join(' ');
}

/**
 * Evaluate the `startOn` claim guard for one claim attempt.
 *
 * Returns `refused: false` for anything that is not a claim, for a
 * `createdAt`-defaulted item, for an already-started instant and when an
 * override reason is supplied. Only an explicit, future `startOn` on a claim
 * attempt is refused — with the machine-readable
 * {@link START_ON_NOT_REACHED_REASON} token and a message naming the effective
 * `startOn` and how long until it is reached.
 */
export function evaluateClaimStartOn(options: ClaimGuardOptions): ClaimGuardEvaluation {
  const { item, intent } = options;
  const now = options.now ?? Date.now();

  if (!isClaimAttempt(intent)) return { refused: false };
  if (!hasExplicitStartOn(item)) return { refused: false };

  const startOn = effectiveStartOn(item.startOn, item.createdAt);
  const startMs = parseMs(startOn);
  if (startOn === null || startMs === null) return { refused: false }; // fail open
  if (!isNotStarted(item, now)) return { refused: false }; // inclusive boundary

  const msUntilStart = startMs - now;
  const overrideReason = typeof options.overrideReason === 'string' ? options.overrideReason.trim() : '';
  if (overrideReason !== '') {
    return { refused: false, overridden: true, overrideReason, startOn, msUntilStart };
  }

  const id = item.id ? ` ${item.id}` : '';
  const message =
    `Work item${id} cannot be claimed: its startOn (${startOn}) has not been ` +
    `reached yet — ${formatDurationUntil(msUntilStart)} to go. ` +
    `To start early, pass ${FORCE_START_ON_FLAG} "<reason>" — the override is ` +
    `recorded as a comment naming the actor, the reason and the overridden startOn.`;

  return {
    refused: true,
    reason: START_ON_NOT_REACHED_REASON,
    startOn,
    msUntilStart,
    message,
  };
}

/** Input for {@link buildStartOnOverrideComment}. */
export interface StartOnOverrideCommentInput {
  /** Who performed the claim (the assignee, or the resolved OS user). */
  actor: string;
  /** The reason the actor supplied via `--force-start-on`. */
  reason: string;
  /** The overridden effective `startOn` (canonical UTC). */
  startOn: string;
  /** When the override happened (ISO-8601). Defaults omitted. */
  nowIso?: string;
}

/**
 * Build the audited comment recording a `--force-start-on` override.
 *
 * The comment names the **actor**, the **reason** and the **overridden
 * `startOn`** (AC5), so the deliberate early start is traceable from
 * `wl show <id>` and survives export/import like any other comment.
 */
export function buildStartOnOverrideComment(input: StartOnOverrideCommentInput): string {
  const actor = input.actor.trim() || 'unknown';
  const reason = input.reason.trim();
  const when = input.nowIso ? ` at ${input.nowIso}` : '';
  return (
    `startOn override: ${actor} claimed this item before its startOn ` +
    `(${input.startOn}) was reached${when}. Reason: ${reason}.`
  );
}
