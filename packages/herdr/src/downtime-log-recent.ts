/**
 * packages/herdr/src/downtime-log-recent.ts — the "recent dispatches" view
 * projection and its 4-hour time blocks (WL-0MVGKHFT4003X6JW, split out of
 * `downtime-log.ts`).
 *
 * Single responsibility: turn the local dispatch log into the read-only rows
 * the Herdr recent-dispatches view renders — one synthetic row per work item,
 * annotated by pane-close lifecycle entries, grouped into 4-hour UTC blocks
 * with their heading labels. Derived from the LOCAL log only, never from
 * `wl list`, so an item that has since been auto-closed or deleted still
 * appears with its id/title.
 *
 * Extracted verbatim from `downtime-log.ts`; behaviour is unchanged.
 */

import { isDispatchMarkerEntry, readDowntimeLogEntries } from './downtime-log-entries.js';

/**
 * Hours per recent-dispatch time block (WL-0MUMM9NED009TLL3). The recent
 * dispatches view groups items into 4-hour UTC blocks per day, labelled
 * `HH:00–HH:00` (00:00–04:00, 04:00–08:00, …, 20:00–24:00).
 */
export const DISPATCH_TIME_BLOCK_HOURS = 4;

/** Heading label for recent-dispatch rows with no parseable timestamp. */
export const UNKNOWN_TIME_BLOCK_LABEL = 'Unknown time';

/** Placeholder title for a log-derived row whose entry carried no title. */
export const UNKNOWN_DISPATCH_TITLE = '[unknown]';

/**
 * One synthetic work-item row projected from the rolling dispatch log for the
 * Herdr "recent dispatches" view (WL-0MUL2IX6H001YHDO, parent
 * WL-0MUGLL9SS002E1D2). Rows are derived from the LOCAL log only — never from
 * `wl list` — so an item that has since been auto-closed or deleted still
 * appears with its id/title.
 */
export interface RecentDispatchRow {
  /** Work item id the log entries refer to. */
  itemId: string;
  /** Title from the log; `[unknown]` when the log carried none. */
  title: string;
  /** Dispatch kind (plan/intake/audit/risk-effort/implement) when present. */
  kind?: string;
  /**
   * Worklog stage the item reached, derived from the log: the dispatch
   * marker's dispatched-at `stage`, overridden by a stage-advancing
   * pane-close outcome (see `PANE_CLOSE_OUTCOME_STAGE`). Rendered through the
   * same stage/audit icon logic as a live row so the dispatches view shows the
   * SAME icons as every other view (WL-0MUGLL9SS002E1D2 audit fix). Unset when
   * the log carried no usable stage.
   */
  stage?: string;
  /**
   * Audit verdict implied by an audit pane-close outcome
   * (`audit-passed` → `true`, `audit-failed` → `false`). Unset for non-audit
   * outcomes.
   */
  auditResult?: boolean;
  /** Latest pane-close outcome, when a pane-close entry exists for the item. */
  latestOutcome?: string;
  /**
   * ISO-8601 timestamp of the item's most recent log entry (dispatch marker
   * `dispatchedAt`, or pane-close `timestamp`). `undefined` when no entry
   * carried a parseable timestamp.
   */
  latestTimestamp?: string;
}

/**
 * Stage a pane-close outcome indicates the item reached
 * (WL-0MUGLL9SS002E1D2 audit fix). Outcomes that do not imply a canonical
 * stage (`requires-attention`) are absent so the row keeps the marker's
 * dispatched-at stage. `audit-passed`/`audit-failed` are audit-tier closes on
 * `in_review` items, so they map to `in_review`.
 */
const PANE_CLOSE_OUTCOME_STAGE: Record<string, string> = {
  'closed-as-intake-complete': 'intake_complete',
  'closed-as-plan-complete': 'plan_complete',
  'audit-passed': 'in_review',
  'audit-failed': 'in_review',
};

/**
 * Audit verdict implied by an audit pane-close outcome, or `undefined` for a
 * non-audit outcome. Drives the audit-aware `in_review` icon so a log-derived
 * audit row renders ✅/❌ exactly like a freshly audited live row.
 */
function paneCloseAuditResult(outcome: string | undefined): boolean | undefined {
  if (outcome === 'audit-passed') return true;
  if (outcome === 'audit-failed') return false;
  return undefined;
}

/** Numeric sort key for a row timestamp; missing/unparseable sorts oldest. */
function dispatchTimestampValue(ts: string | undefined): number {
  if (ts === undefined) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Project the rolling dispatch log into recent dispatched work items
 * (WL-0MUL2IX6H001YHDO). Reads the LOCAL log via the fail-safe
 * `readDowntimeLogEntries(cwd)` — a missing/unreadable/empty/malformed log
 * yields `[]` and this function never throws.
 *
 * Rows are deduplicated by work item id (one row per id), using that item's
 * most recent log entry for ordering and metadata; pane-close lifecycle
 * entries annotate an existing row's `latestOutcome`/timestamp (a pane-close
 * for an item that was never dispatched does not create a row). Rows are
 * ordered newest-first by their latest timestamp. There is no result cap
 * (WL-0MUMM9NED009TLL3): the log itself is bounded to
 * `DOWNTIME_LOG_MAX_ENTRIES`, so every item retained in the log is shown.
 * The projection is read-only.
 */
export async function recentDispatchedItems(cwd: string): Promise<RecentDispatchRow[]> {
  const entries = await readDowntimeLogEntries(cwd);
  const rows = new Map<string, RecentDispatchRow>();

  for (const e of entries) {
    if (typeof e.itemId !== 'string' || e.itemId.length === 0) continue;

    if (e.entryType === 'pane-close') {
      // Pane-close entries annotate an EXISTING dispatched row; they never
      // introduce a row of their own (an item that was never dispatched is
      // not a recent dispatch).
      const row = rows.get(e.itemId);
      if (row === undefined) continue;
      if (typeof e.outcome === 'string' && e.outcome.length > 0) {
        row.latestOutcome = e.outcome;
        // A stage-advancing close overrides the dispatched-at stage so the
        // row's stage icon reflects where the item ended up, not where it
        // started (WL-0MUGLL9SS002E1D2 audit fix).
        const reachedStage = PANE_CLOSE_OUTCOME_STAGE[e.outcome];
        if (reachedStage !== undefined) {
          row.stage = reachedStage;
        }
        const auditResult = paneCloseAuditResult(e.outcome);
        if (auditResult !== undefined) {
          row.auditResult = auditResult;
        }
      }
      if (typeof e.timestamp === 'string' && e.timestamp.length > 0) {
        row.latestTimestamp = e.timestamp;
      }
      // Backfill a placeholder title from the pane-close itemTitle.
      if (
        row.title === UNKNOWN_DISPATCH_TITLE &&
        typeof e.itemTitle === 'string' &&
        e.itemTitle.length > 0
      ) {
        row.title = e.itemTitle;
      }
      continue;
    }

    if (!isDispatchMarkerEntry(e)) continue; // future typed entries are not dispatch markers

    const existing = rows.get(e.itemId);
    const title =
      typeof e.title === 'string' && e.title.length > 0
        ? e.title
        : existing?.title ?? UNKNOWN_DISPATCH_TITLE;
    const kind = typeof e.kind === 'string' ? e.kind : existing?.kind;
    const stage =
      (typeof e.stage === 'string' && e.stage.length > 0 ? e.stage : undefined) ?? existing?.stage;
    const latestTimestamp =
      (typeof e.dispatchedAt === 'string' ? e.dispatchedAt : undefined) ?? existing?.latestTimestamp;

    rows.set(e.itemId, {
      itemId: e.itemId,
      title,
      kind,
      stage,
      auditResult: existing?.auditResult,
      latestOutcome: existing?.latestOutcome,
      latestTimestamp,
    });
  }

  const list = [...rows.values()];
  list.sort(
    (a, b) => dispatchTimestampValue(b.latestTimestamp) - dispatchTimestampValue(a.latestTimestamp),
  );
  return list;
}

/**
 * One 4-hour UTC time block of recent-dispatch rows
 * (WL-0MUMM9NED009TLL3). Blocks are produced by
 * `groupRecentDispatchesByTimeBlock`, ordered newest-first (most recent block
 * first) with the synthetic "Unknown time" block always last
 * (WL-0MVLEM606008UAL1).
 */
export interface DispatchTimeBlock {
  /**
   * UTC start of the block as ms since epoch (e.g. 00:00/04:00/…/20:00 UTC),
   * used for newest-first ordering (WL-0MVLEM606008UAL1).
   * `Number.NEGATIVE_INFINITY` for the unknown-time block so it never sorts
   * ahead of a real block.
   */
  startMs: number;
  /** True for the trailing block holding rows without a parseable timestamp. */
  unknownTime: boolean;
  /** Heading label, e.g. `29 Sep 2026, 00:00–04:00` or `Unknown time`. */
  label: string;
  /** Rows in the block, preserving the projection's newest-first ordering. */
  rows: RecentDispatchRow[];
}

/** UTC month abbreviations for the time-block heading (day month year). */
const TIME_BLOCK_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Two-digit zero-pad for a block boundary hour. */
function padHour(hour: number): string {
  return String(hour).padStart(2, '0');
}

/**
 * Heading label for the 4-hour UTC block a timestamp belongs to
 * (WL-0MUMM9NED009TLL3), e.g. `29 Sep 2026, 00:00–04:00`. The end of the
 * day's last block renders as `20:00–24:00`. A missing or unparseable
 * timestamp maps to {@link UNKNOWN_TIME_BLOCK_LABEL}.
 */
export function dispatchTimeBlockLabel(ts: string | undefined): string {
  if (ts === undefined) return UNKNOWN_TIME_BLOCK_LABEL;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return UNKNOWN_TIME_BLOCK_LABEL;
  const d = new Date(t);
  const startHour =
    Math.floor(d.getUTCHours() / DISPATCH_TIME_BLOCK_HOURS) * DISPATCH_TIME_BLOCK_HOURS;
  const endHour = startHour + DISPATCH_TIME_BLOCK_HOURS;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = TIME_BLOCK_MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}, ${padHour(startHour)}:00–${padHour(endHour)}:00`;
}

/**
 * Group projected recent-dispatch rows into 4-hour UTC time blocks
 * (WL-0MUMM9NED009TLL3). Each row is classified by its `latestTimestamp`
 * into the block that starts on the hour boundary (`00:00`, `04:00`, …,
 * `20:00` UTC) on the row's UTC calendar day, so blocks never merge across
 * midnight. Blocks are returned newest-first (most recent block first,
 * WL-0MVLEM606008UAL1); rows within a block keep the projection's
 * newest-first order. Rows with a missing or unparseable timestamp are
 * collected into a single trailing `Unknown time` block.
 *
 * Pure and total: an empty input yields `[]` and the function never throws.
 */
export function groupRecentDispatchesByTimeBlock(rows: RecentDispatchRow[]): DispatchTimeBlock[] {
  const known = new Map<number, DispatchTimeBlock>();
  const unknown: DispatchTimeBlock = {
    startMs: Number.NEGATIVE_INFINITY,
    unknownTime: true,
    label: UNKNOWN_TIME_BLOCK_LABEL,
    rows: [],
  };

  for (const row of rows) {
    const ts = row.latestTimestamp;
    const t = ts === undefined ? NaN : Date.parse(ts);
    if (Number.isNaN(t)) {
      unknown.rows.push(row);
      continue;
    }
    const d = new Date(t);
    const startHour =
      Math.floor(d.getUTCHours() / DISPATCH_TIME_BLOCK_HOURS) * DISPATCH_TIME_BLOCK_HOURS;
    const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), startHour);
    let block = known.get(startMs);
    if (block === undefined) {
      block = {
        startMs,
        unknownTime: false,
        label: dispatchTimeBlockLabel(ts),
        rows: [],
      };
      known.set(startMs, block);
    }
    block.rows.push(row);
  }

  // Newest block first (WL-0MVLEM606008UAL1): a "recent dispatches" view must
  // show the most recent activity at the top. The synthetic unknown-time block
  // has no date to sort by, so it stays last regardless of this sort.
  const blocks = [...known.values()].sort((a, b) => b.startMs - a.startMs);
  if (unknown.rows.length > 0) blocks.push(unknown);
  return blocks;
}
