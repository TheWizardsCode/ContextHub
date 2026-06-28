/**
 * Tests for status/stage compatibility validation.
 *
 * Verifies that `in-progress` (or `in_progress`) status is compatible
 * with `intake_complete` and `plan_complete` stages — combinations that
 * must work for PlanAll and other batch automation to claim work items.
 * See SA-0MQUQZMWB0067UCR for the full context of the bug.
 */

import { describe, it, expect } from 'vitest';
import {
  isStatusStageCompatible,
  getAllowedStagesForStatus,
} from '../src/status-stage-validation.js';

describe('Status/stage compatibility', () => {
  describe('isStatusStageCompatible', () => {
    // -----------------------------------------------------------------------
    // Positive — combinations that MUST be allowed (the core bug fix)
    // -----------------------------------------------------------------------
    it('should allow in-progress status with intake_complete stage', () => {
      expect(isStatusStageCompatible('in-progress', 'intake_complete')).toBe(true);
    });

    it('should allow in_progress status with intake_complete stage', () => {
      expect(isStatusStageCompatible('in_progress', 'intake_complete')).toBe(true);
    });

    it('should allow in-progress status with plan_complete stage', () => {
      expect(isStatusStageCompatible('in-progress', 'plan_complete')).toBe(true);
    });

    it('should allow in_progress status with plan_complete stage', () => {
      expect(isStatusStageCompatible('in_progress', 'plan_complete')).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Positive — combinations that were already allowed (regression guard)
    // -----------------------------------------------------------------------
    it('should allow in-progress status with in_progress stage', () => {
      expect(isStatusStageCompatible('in-progress', 'in_progress')).toBe(true);
    });

    it('should allow in-progress status with in_review stage', () => {
      expect(isStatusStageCompatible('in-progress', 'in_review')).toBe(true);
    });

    it('should allow in-progress status with idea stage', () => {
      expect(isStatusStageCompatible('in-progress', 'idea')).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Negative — should NOT allow in-progress with explicitly invalid stages
    // -----------------------------------------------------------------------
    it('should not allow in-progress status with done stage', () => {
      expect(isStatusStageCompatible('in-progress', 'done')).toBe(false);
    });
  });

  describe('getAllowedStagesForStatus', () => {
    it('should include intake_complete for in-progress status', () => {
      const stages = getAllowedStagesForStatus('in-progress');
      expect(stages).toContain('intake_complete');
    });

    it('should include plan_complete for in-progress status', () => {
      const stages = getAllowedStagesForStatus('in-progress');
      expect(stages).toContain('plan_complete');
    });

    it('should include in_progress for in-progress status', () => {
      const stages = getAllowedStagesForStatus('in-progress');
      expect(stages).toContain('in_progress');
    });
  });
});
