import type { WorkItem } from '../types.js';
import { isSoftDeleted } from '@worklog/shared/predicates';
import type { DoctorFinding, DoctorSeverity } from './status-stage-check.js';

const CHECK_ID_MISSING_PARENT = 'parent.missing-endpoint';
const TYPE_MISSING_PARENT = 'missing-parent';
const SEVERITY_MISSING_PARENT: DoctorSeverity = 'warning';

/**
 * A group of live children whose `parentId` no longer resolves, keyed by the
 * lost parent id (R3 / R3b, WL-0MWGRKLLG0035PLG). Carries the lost-parent id,
 * the number of stranded children and their ids.
 */
export interface OrphanGroup {
  parentId: string;
  count: number;
  childIds: string[];
}

/**
 * Detect work items whose `parentId` references a work item that is not
 * resolvable — for example the legacy `WL-NULL` artifact produced by
 * `wl update <id> --parent null` before `normalizeParentId` mapped the
 * sentinel to a detach (WL-0MUJM2LV1000IHKR), a hard-deleted parent, or a
 * **soft-deleted** parent (R3b, WL-0MWGRKLLG0035PLG).
 *
 * A parent reference resolves only when it names a LIVE row: a soft-deleted
 * parent (`status: 'deleted'` or a `deletedBy` identity) is as unreachable as
 * a hard-deleted one for every rollup and report, so its children are orphans
 * too (R3b). Conversely, a soft-deleted child is already retired and must not
 * be re-reported as an orphan — otherwise every recursively deleted subtree,
 * which keeps `parentId` intact on the tombstoned descendants, would surface a
 * wall of spurious findings.
 *
 * The reference is repairable and safe: the item is detached by setting
 * `parentId` to `null`, which is why the finding carries a safe
 * `proposedFix`.
 */
export function validateParentReferences(items: WorkItem[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  // A parent is resolvable only while it is live (R3b).
  const resolvableIds = new Set(
    items.filter(item => !isSoftDeleted(item)).map(item => item.id),
  );

  for (const item of items) {
    if (!item.parentId) {
      continue;
    }
    if (isSoftDeleted(item)) {
      continue;
    }
    if (resolvableIds.has(item.parentId)) {
      continue;
    }

    findings.push({
      checkId: CHECK_ID_MISSING_PARENT,
      type: TYPE_MISSING_PARENT,
      severity: SEVERITY_MISSING_PARENT,
      itemId: item.id,
      message: `Parent reference points to missing work item: ${item.parentId}.`,
      proposedFix: { parentId: null },
      safe: true,
      context: { parentId: item.parentId },
    });
  }

  return findings;
}

/**
 * Group `missing-parent` findings by the lost-parent id (R3,
 * WL-0MWGRKLLG0035PLG) so orphan reporting can summarise "one lost parent
 * strands N children" instead of only listing children individually.
 *
 * Findings of any other type are ignored, so callers may pass a mixed finding
 * set. Group order follows first appearance in the input; child ids keep their
 * input order.
 */
export function groupOrphanFindings(findings: DoctorFinding[]): OrphanGroup[] {
  const groups = new Map<string, OrphanGroup>();

  for (const finding of findings) {
    if (finding.type !== TYPE_MISSING_PARENT) {
      continue;
    }
    const parentId = String(
      (finding.context as { parentId?: unknown } | undefined)?.parentId ?? '',
    );
    if (!parentId) {
      continue;
    }

    const existing = groups.get(parentId);
    if (existing) {
      existing.count += 1;
      existing.childIds.push(finding.itemId);
    } else {
      groups.set(parentId, {
        parentId,
        count: 1,
        childIds: [finding.itemId],
      });
    }
  }

  return Array.from(groups.values());
}

/**
 * Convenience wrapper: validate a full item collection and group the resulting
 * orphans by lost-parent id.
 */
export function groupOrphansByLostParent(items: WorkItem[]): OrphanGroup[] {
  return groupOrphanFindings(validateParentReferences(items));
}
