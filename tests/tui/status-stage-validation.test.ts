import { describe, it, expect } from 'vitest';
import {
  getAllowedStagesForStatus,
  getAllowedStatusesForStage,
  isStatusStageCompatible,
} from '../../src/tui/status-stage-validation.js';
import { loadStatusStageRules, normalizeStageValue, normalizeStatusValue } from '../../src/status-stage-rules.js';

describe('Status/Stage Validation Helper', () => {
  const rulesConfig = loadStatusStageRules();
  const rules = {
    statusStage: rulesConfig.statusStageCompatibility,
    stageStatus: rulesConfig.stageStatusCompatibility,
  };

  it('returns allowed stages for status', () => {
    expect(getAllowedStagesForStatus('open', rules)).toEqual([
      'idea',
      'intake_complete',
      'plan_complete',
      'in_progress',
    ]);
  });

  it('returns allowed statuses for stage', () => {
    expect(getAllowedStatusesForStage('in_review', rules)).toEqual(['completed']);
  });

  it('accepts valid status/stage pairs', () => {
    expect(isStatusStageCompatible('completed', 'done', rules)).toBe(true);
    expect(isStatusStageCompatible('blocked', 'idea', rules)).toBe(true);
  });

  it('rejects invalid status/stage pairs', () => {
    expect(isStatusStageCompatible('completed', 'idea', rules)).toBe(false);
    expect(isStatusStageCompatible('deleted', 'in_review', rules)).toBe(false);
  });

  it('covers compatibility permutations for all statuses', () => {
    rulesConfig.statusValues.forEach((status) => {
      const allowedStages = new Set(rulesConfig.statusStageCompatibility[status]);
      rulesConfig.stageValues.forEach((stage) => {
        const compatible = isStatusStageCompatible(status, stage, rules);
        // Mirror the special-case logic in isStatusStageCompatible which
        // treats the combination of 'in-progress' status with 'in_review'
        // stage as compatible by default (handles both underscore/hyphen forms).
        const specialCase = (
          (status === 'in-progress' || status === 'in_progress') &&
          (stage === 'in_review' || stage === 'in-review')
        );
        const expected = allowedStages.has(stage) || specialCase;
        if (compatible !== expected) {
          // Diagnostic logging to help debug unexpected permutations
          // eslint-disable-next-line no-console
          console.error('compatibility mismatch', { status, stage, allowed: Array.from(allowedStages), compatible });
        }
        expect(compatible).toBe(expected);
      });
    });
  });

  it('matches allowed statuses for each stage', () => {
    rulesConfig.stageValues.forEach((stage) => {
      const expected = [...(rulesConfig.stageStatusCompatibility[stage] ?? [])].sort();
      const actual = [...getAllowedStatusesForStage(stage, rules)].sort();
      expect(actual).toEqual(expected);
    });
  });

  it('normalizes status values by replacing underscores', () => {
    expect(normalizeStatusValue('in_progress')).toBe('in-progress');
    expect(normalizeStatusValue('open')).toBe('open');
    expect(normalizeStatusValue(undefined)).toBeUndefined();
  });

  it('normalizes stage values by replacing hyphens', () => {
    expect(normalizeStageValue('in-progress')).toBe('in_progress');
    expect(normalizeStageValue('idea')).toBe('idea');
    expect(normalizeStageValue(undefined)).toBeUndefined();
  });
});
