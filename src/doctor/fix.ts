import type { DoctorFinding } from './status-stage-check.js';
import type { WorklogDatabase } from '../database.js';
import { loadStatusStageRules } from '../status-stage-rules.js';

type PromptFn = (promptText: string) => Promise<boolean>;

/**
 * Apply safe fixes automatically and interactively prompt for non-safe findings.
 * Returns the (possibly updated) findings after attempted fixes.
 */
export async function applyDoctorFixes(db: WorklogDatabase, findings: DoctorFinding[], promptFn: PromptFn): Promise<DoctorFinding[]> {
  // Heuristic: if a finding indicates an empty-string stage is invalid, propose a sensible default
  // Prefer a default derived from configured status/stage rules; fall back to 'idea'
  let defaultStage = 'idea';
  try {
    const rules = loadStatusStageRules();
    // Prefer the first stage that allows the common 'open' status, otherwise the first configured stage
    defaultStage = (rules.stageValues.find(s => (rules.stageStatusCompatibility[s] || []).includes('open')))
      || rules.stageValues[0]
      || defaultStage;
  } catch (e) {
    // If loading rules fails, keep the hard-coded fallback
  }

  for (const f of findings) {
    try {
      if (f.type === 'invalid-stage' && f.context && (f.context as any).stage === '') {
        const current = (f.proposedFix && typeof f.proposedFix === 'object') ? (f.proposedFix as Record<string, unknown>) : {};
        f.proposedFix = Object.assign({}, current, { stage: defaultStage }) as Record<string, unknown>;
        f.safe = true;
      }
    } catch (e) {
      // ignore errors while patching findings
    }
  }

  const remainingFindings: DoctorFinding[] = [];

  // First, apply all safe fixes
  for (const f of findings) {
    if (f.safe && f.proposedFix && typeof f.proposedFix === 'object') {
      try {
        // handle simple status/stage fixes for work items
        const itemId = f.itemId;
        const item = db.get(itemId);
        if (!item) {
          remainingFindings.push(f);
          continue;
        }
        const update: any = {};
        if ((f.proposedFix as any).status) update.status = (f.proposedFix as any).status;
        if ((f.proposedFix as any).stage) update.stage = (f.proposedFix as any).stage;
        if (Object.keys(update).length > 0) {
          db.update(itemId, update);
          // after applying, re-validate later by skipping adding this finding
          continue;
        }
      } catch (err) {
        remainingFindings.push(f);
        continue;
      }
    }
    // Non-safe findings are handled interactively below
    remainingFindings.push(f);
  }

  const finalFindings: DoctorFinding[] = [];

  for (const f of remainingFindings) {
    if (f.safe) {
      // safe but no actionable proposedFix - keep for report
      finalFindings.push(f);
      continue;
    }

    // If there's no concrete proposedFix (no status/stage), mark as requiring manual fix
    const hasActionableFix = f.proposedFix && typeof f.proposedFix === 'object' && (
      Object.prototype.hasOwnProperty.call(f.proposedFix, 'status') ||
      Object.prototype.hasOwnProperty.call(f.proposedFix, 'stage')
    );

    if (!hasActionableFix) {
      // annotate the finding so doctor output can list it as requiring manual intervention
      try {
        f.context = { ...(f.context || {}), requiresManualFix: true } as Record<string, unknown>;
      } catch (e) {
        // ignore
      }
      finalFindings.push(f);
      continue;
    }

    // Ask user per non-safe finding that has an actionable proposedFix
    const shouldApply = await promptFn(`${f.itemId}: ${f.message}`);
    if (shouldApply && f.proposedFix && typeof f.proposedFix === 'object') {
      try {
        const item = db.get(f.itemId);
        if (item) {
          const update: any = {};
          if ((f.proposedFix as any).status) update.status = (f.proposedFix as any).status;
          if ((f.proposedFix as any).stage) update.stage = (f.proposedFix as any).stage;
          if (Object.keys(update).length > 0) {
            db.update(f.itemId, update);
            // record note that we applied it by omitting from final findings
            continue;
          }
        }
      } catch (err) {
        // fall through to keep in report
      }
    }

    // If declined or failed to apply, keep in final report
    finalFindings.push(f);
  }

  return finalFindings;
}

export default { applyDoctorFixes };
