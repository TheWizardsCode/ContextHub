import { loadStatusStageRules } from './status-stage-rules.js';

export interface StatusStageValidationRules {
  statusStage?: Record<string, readonly string[]>;
  stageStatus?: Record<string, readonly string[]>;
}

const resolveStatusStageRules = (rules?: StatusStageValidationRules) =>
  rules?.statusStage ?? loadStatusStageRules().statusStageCompatibility;

const resolveStageStatusRules = (rules?: StatusStageValidationRules) =>
  rules?.stageStatus ?? loadStatusStageRules().stageStatusCompatibility;

export const getAllowedStagesForStatus = (
  status?: string,
  rules?: StatusStageValidationRules
): readonly string[] => {
  if (!status) return [];
  const statusStageRules = resolveStatusStageRules(rules);
  return statusStageRules[status] ?? [];
};

export const getAllowedStatusesForStage = (
  stage?: string,
  rules?: StatusStageValidationRules
): readonly string[] => {
  if (stage === undefined) return [];
  const stageStatusRules = resolveStageStatusRules(rules);
  // If a stage has no explicit reverse mapping but the 'deleted' status is configured
  // to allow all stages, we should not surface 'deleted' here unless it's present
  // in the derived stageStatus rules. Return the configured mapping as-is.
  return stageStatusRules[stage] ?? [];
};

export const isStatusStageCompatible = (
  status?: string,
  stage?: string,
  rules?: StatusStageValidationRules
): boolean => {
  if (!status || stage === undefined) return true;

  // Allow common transitional combinations used by the audit runner and
  // batch automation (PlanAll, etc.) even when they are not enumerated in
  // the compatibility tables.
  //
  // WHY THIS EXISTS:
  // The audit runner (skill/audit/scripts/audit_runner.py) implements a
  // status lifecycle that temporarily sets `--status in_progress` to claim
  // a work item, then restores the original status after the audit completes.
  // This may be called on items in any non-done stage (e.g. a
  // `completed/in_review` item being re-audited). The config-defined
  // compatibility table only maps `in-progress` status to stages
  // `intake_complete`, `plan_complete`, and `in_progress` — which would
  // reject `in-progress`/`in_review`. This exception bridges that gap.
  //
  // RISK: This exception allows potentially invalid state combinations
  // (e.g. `in-progress`/`in_review`, `in-progress`/`idea`) to persist in
  // the data store. If the audit process is interrupted after setting
  // `in-progress` but before restoring the original status, the work item
  // will remain in a hybrid state until manually corrected. The
  // `update.ts` guard (skip db.update() when no fields changed) mitigates
  // accidental stage advancement from `--audit-text`-only calls, and the
  // try/finally block in audit_runner.py ensures the original status is
  // restored even on failure.
  const statusNorm = status;
  const stageNorm = stage;
  if ((statusNorm === 'in-progress' || statusNorm === 'in_progress') &&
      (stageNorm === 'in_review' || stageNorm === 'in-review' || stageNorm === 'idea' || stageNorm === 'in_progress' || stageNorm === 'in-progress' || stageNorm === 'intake_complete' || stageNorm === 'plan_complete')) {
    return true;
  }
  const allowedStages = getAllowedStagesForStatus(status, rules);
  if (allowedStages.length > 0 && !allowedStages.includes(stage)) return false;
  const allowedStatuses = getAllowedStatusesForStage(stage, rules);
  if (allowedStatuses.length > 0 && !allowedStatuses.includes(status)) return false;
  return true;
};
