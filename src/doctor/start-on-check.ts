/**
 * `start-on.*` — `wl doctor` checks for the stored `startOn` scheduling field
 * (WL-0MWMGEPY2004EDZ8, parent WL-0MWM0FDZK007BAD0).
 *
 * ## What is checked
 *
 * `startOn` has one storage invariant: **the column is always populated with
 * the effective instant** (`startOn ?? createdAt`). Two conditions break it, and
 * each gets its own check id so the report can explain the difference:
 *
 * | Check id | Condition | Shape | Remediation |
 * |---|---|---|---|
 * | `startOn.missing` | live rows whose stored `startOn` is `NULL`/blank — the back-fill migration has not run (or a row was written by a build that predates it) | one **global** finding (`itemId: null`) with a count and a sample of ids | `wl doctor upgrade --confirm` |
 * | `startOn.invalid` | a stored `startOn` that is present but not a parseable ISO-8601 instant | one per-item finding | set a valid instant, or clear it back to `createdAt` |
 *
 * ## Why `missing` is global and `invalid` is per item
 *
 * A `NULL`-`startOn` store is one *migration* problem affecting N rows — a
 * per-row finding would drown every other doctor finding (a 2,600-item store
 * yields 2,600 lines) and would duplicate the pending-upgrade notice. An
 * unparseable value is one *data* problem on one row, so it is reported against
 * that item, exactly like the other per-item checks.
 *
 * Neither check mutates the store, touches the cache, or changes the exit
 * status: they are warning-level reports, and `wl doctor --fix` leaves them to
 * an operator because the migration (not a per-row write) is the safe repair.
 *
 * Soft-deleted rows are skipped: the findings are for live, actionable rows
 * (the same rule the status/stage check applies, WL-0MW7S20IC001F3AP).
 */

import type { WorkItem } from '../types.js';
import { isSoftDeleted } from '@worklog/shared/predicates';
import type { DoctorFinding, DoctorSeverity } from './status-stage-check.js';

/** Stable identifier for the "column not back-filled" finding. */
export const START_ON_MISSING_CHECK_ID = 'startOn.missing';

/** Stable identifier for the "stored value is not an instant" finding. */
export const START_ON_INVALID_CHECK_ID = 'startOn.invalid';

/** Finding `type` used for the human "manual fixes" grouping. */
export const START_ON_MISSING_TYPE = 'start-on-missing';
export const START_ON_INVALID_TYPE = 'start-on-invalid';

const MISSING_SEVERITY: DoctorSeverity = 'warning';
const INVALID_SEVERITY: DoctorSeverity = 'warning';

/** The command that applies the documented back-fill migration. */
export const START_ON_REMEDIATION =
  "run 'wl doctor upgrade --confirm' to apply the 20261118-add-start-on migration " +
  '(sets startOn = createdAt for every row without one); see docs/migrations/start_on.md';

/** How many ids the global finding lists before it summarises the rest. */
export const MISSING_SAMPLE_LIMIT = 10;

/**
 * A doctor finding that is not attached to a single work item.
 *
 * Structurally the per-item {@link DoctorFinding} with `itemId: null` — the
 * convention `wl doctor` already renders under a `(global)` heading (see the
 * audit-fingerprint schema-skew finding).
 */
export interface GlobalDoctorFinding {
  checkId: string;
  type: string;
  severity: DoctorSeverity;
  itemId: null;
  message: string;
  proposedFix: null;
  safe: false;
  context: Record<string, unknown>;
}

/** True when a stored value is present but not a readable ISO-8601 instant. */
export function isUnparseableStartOn(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const trimmed = String(value).trim();
  if (trimmed === '') return false;
  return !Number.isFinite(Date.parse(trimmed));
}

/**
 * Report the live rows whose stored `startOn` is missing.
 *
 * Takes the **ids of rows whose stored column is NULL/blank**
 * (`WorklogDatabase.getItemIdsMissingStartOn()`) rather than work items: the
 * read path deliberately falls back to `createdAt` for a `NULL` row, so an
 * item loaded through `getAll()` can no longer reveal whether its value was
 * stored or defaulted. Reading the raw column is the only way to see a
 * back-fill that has not run.
 *
 * @param missingIds - Ids from {@link WorklogDatabase.getItemIdsMissingStartOn}.
 * @returns One global finding, or `null` when no live row needs a back-fill.
 */
export function summariseMissingStartOn(
  missingIds: readonly string[],
): GlobalDoctorFinding | null {
  if (missingIds.length === 0) return null;

  const ids = [...missingIds].sort();
  const sample = ids.slice(0, MISSING_SAMPLE_LIMIT);
  const remainder = ids.length - sample.length;
  const listed = remainder > 0 ? `${sample.join(', ')} (+${remainder} more)` : sample.join(', ');

  return {
    checkId: START_ON_MISSING_CHECK_ID,
    type: START_ON_MISSING_TYPE,
    severity: MISSING_SEVERITY,
    itemId: null,
    message:
      `${ids.length} live work item(s) have no stored startOn, so the column does not hold ` +
      `the effective instant (startOn ?? createdAt) these rows read as: ${listed}. ` +
      `Remediation: ${START_ON_REMEDIATION}.`,
    proposedFix: null,
    safe: false,
    context: {
      missingCount: ids.length,
      sampleIds: sample,
      ...(remainder > 0 ? { omittedIds: remainder } : {}),
      remediation: START_ON_REMEDIATION,
    },
  };
}

/**
 * Report live rows whose stored `startOn` cannot be read as an instant.
 *
 * A scheduled item whose value is unreadable fails open (it reads as started),
 * so it is never hidden — but the stored value is still wrong, and only a
 * human can decide what the intended instant was.
 *
 * @param items - Every stored work item (the check filters to live rows).
 * @returns One finding per affected item, ordered by id.
 */
export function validateStartOnInstants(items: readonly WorkItem[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    if (isSoftDeleted(item)) continue;
    if (!isUnparseableStartOn(item.startOn)) continue;
    findings.push({
      checkId: START_ON_INVALID_CHECK_ID,
      type: START_ON_INVALID_TYPE,
      severity: INVALID_SEVERITY,
      itemId: item.id,
      message:
        `startOn "${String(item.startOn)}" is not a parseable ISO-8601 instant; the item is ` +
        'treated as already started (fail-open) until it is corrected.',
      proposedFix: null,
      safe: false,
      context: {
        startOn: item.startOn ?? null,
        createdAt: item.createdAt,
        requiresManualFix: true,
        remediation:
          'set a valid ISO-8601 instant for this item, or clear startOn back to createdAt',
      },
    });
  }
  return findings;
}
