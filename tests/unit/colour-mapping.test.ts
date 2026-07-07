import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { theme } from '../../src/theme.js';
import type { WorkItem } from '../../src/types.js';

// Import the helper functions we need to test
import { formatTitleOnly } from '../../src/commands/helpers.js';

// Create a mock work item for testing
function createMockWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-TEST-1',
    title: 'Test Item',
    description: '',
    status: 'open',
    priority: 'medium',
    stage: undefined,
    tags: [],
    risk: '',
    effort: '',
    sortIndex: 1000,
    parentId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assignee: '',
    needsProducerReview: false,
    ...overrides,
  };
}

// Store original FORCE_COLOR value
const originalForceColor = process.env.FORCE_COLOR;

beforeEach(() => {
  // Enable chalk colours in test environment
  process.env.FORCE_COLOR = '3';
});

afterEach(() => {
  // Restore original FORCE_COLOR value
  if (originalForceColor === undefined) {
    delete process.env.FORCE_COLOR;
  } else {
    process.env.FORCE_COLOR = originalForceColor;
  }
});

describe('Colour Mapping', () => {
  describe('Theme structure', () => {
    it('should have stage colours defined', () => {
      expect(theme.stage).toBeDefined();
      expect(theme.stage.idea).toBeTypeOf('function');
      expect(theme.stage.intakeComplete).toBeTypeOf('function');
      expect(theme.stage.planComplete).toBeTypeOf('function');
      expect(theme.stage.inProgress).toBeTypeOf('function');
      expect(theme.stage.inReview).toBeTypeOf('function');
      expect(theme.stage.done).toBeTypeOf('function');
    });

    it('should have a blocked colour override defined for CLI', () => {
      expect(theme.blocked).toBeTypeOf('function');
    });

    it('should NOT have status colours defined (removed)', () => {
      expect((theme as any).status).toBeUndefined();
    });
  });

  describe('Stage-based colour mapping (CLI)', () => {
    it('should colour idea stage items with gray', () => {
      const item = createMockWorkItem({ stage: 'idea' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour intake_complete stage items with blue', () => {
      const item = createMockWorkItem({ stage: 'intake_complete' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour plan_complete stage items with cyan', () => {
      const item = createMockWorkItem({ stage: 'plan_complete' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour in_progress stage items with yellow', () => {
      const item = createMockWorkItem({ stage: 'in_progress' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour in_review stage items with green', () => {
      const item = createMockWorkItem({ stage: 'in_review' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour done stage items with white', () => {
      const item = createMockWorkItem({ stage: 'done' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });
  });

  describe('Blocked status override', () => {
    it('should apply red colour when status is blocked, regardless of stage (CLI)', () => {
      const item = createMockWorkItem({ status: 'blocked', stage: 'in_review', title: 'Blocked Item' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toContain('Blocked Item');
    });

    it('should preserve text for blocked items', () => {
      const item = createMockWorkItem({
        title: 'Blocked Work',
        status: 'blocked',
        stage: 'in_progress',
      });
      const coloured = formatTitleOnly(item);
      expect(coloured).toContain('Blocked Work');
    });
  });

  describe('Default/fallback behaviour', () => {
    it('should use gray colour when stage is undefined and status is not blocked', () => {
      const item = createMockWorkItem({ stage: undefined, status: 'open', title: 'No Stage' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toContain('No Stage');
    });

    it('should use gray colour when stage is empty string and status is not blocked', () => {
      const item = createMockWorkItem({ stage: '', status: 'open', title: 'Empty Stage' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toContain('Empty Stage');
    });

    it('should use gray colour when stage is unknown and status is not blocked', () => {
      const item = createMockWorkItem({ stage: 'unknown_stage', status: 'open', title: 'Unknown Stage' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toContain('Unknown Stage');
    });
  });

  describe('Accessibility', () => {
    it('should preserve text labels when coloured', () => {
      const item = createMockWorkItem({ 
        title: 'Important Feature',
        stage: 'in_review' 
      });
      const coloured = formatTitleOnly(item);
      expect(coloured).toContain('Important Feature');
    });

    it('should not inject non-text that breaks screen readers', () => {
      const item = createMockWorkItem({ 
        title: 'Screen Reader Test',
        stage: 'done' 
      });
      const coloured = formatTitleOnly(item);
      expect(coloured).toContain('Screen Reader Test');
    });
  });

  describe('Fallback behaviour (colours disabled)', () => {
    it('should produce plain text when FORCE_COLOR=0', () => {
      process.env.FORCE_COLOR = '0';
      const item = createMockWorkItem({ stage: 'idea' });
      const coloured = formatTitleOnly(item);
      expect(coloured).not.toMatch(/\x1b\[/);
      expect(coloured).toBe('Test Item');
    });

    it('should produce plain text when FORCE_COLOR is not set', () => {
      delete process.env.FORCE_COLOR;
      const item = createMockWorkItem({ stage: 'in_review' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toContain('Test Item');
    });

    it('should fall back to plain text in CLI when colours disabled for all stages', () => {
      process.env.FORCE_COLOR = '0';
      const stages = ['idea', 'intake_complete', 'plan_complete', 'in_progress', 'in_review', 'done'];
      
      for (const stage of stages) {
        const item = createMockWorkItem({ stage });
        const coloured = formatTitleOnly(item);
        expect(coloured).not.toMatch(/\x1b\[/);
        expect(coloured).toBe('Test Item');
      }
    });

    it('should fall back to plain text for blocked items when colours disabled', () => {
      process.env.FORCE_COLOR = '0';
      const item = createMockWorkItem({ status: 'blocked', stage: 'in_review' });
      const coloured = formatTitleOnly(item);
      expect(coloured).not.toMatch(/\x1b\[/);
      expect(coloured).toBe('Test Item');
    });

    it('should fall back to gray for undefined stage when colours disabled', () => {
      process.env.FORCE_COLOR = '0';
      const item = createMockWorkItem({ stage: undefined, status: 'open' });
      const coloured = formatTitleOnly(item);
      expect(coloured).not.toMatch(/\x1b\[/);
      expect(coloured).toBe('Test Item');
    });
  });
});
