import type { WorkItem } from '../types.js';
import type { DoctorFinding, DoctorSeverity } from './status-stage-check.js';

const CHECK_ID_MISSING_PARENT = 'parent.missing-endpoint';
const TYPE_MISSING_PARENT = 'missing-parent';
const SEVERITY_MISSING_PARENT: DoctorSeverity = 'warning';

/**
 * Detect work items whose `parentId` references a work item that does not
 * exist — for example the legacy `WL-NULL` artifact produced by
 * `wl update <id> --parent null` before `normalizeParentId` mapped the
 * sentinel to a detach (WL-0MUJM2LV1000IHKR).
 *
 * The reference is repairable and safe: the item is detached by setting
 * `parentId` to `null`, which is why the finding carries a safe
 * `proposedFix`.
 */
export function validateParentReferences(items: WorkItem[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const itemIds = new Set(items.map(item => item.id));

  for (const item of items) {
    if (!item.parentId) {
      continue;
    }
    if (itemIds.has(item.parentId)) {
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
