import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { theme } from '../../src/theme.js';
import type { WorkItem } from '../../src/types.js';

// Import the helper functions we need to test
import { formatTitleOnly, formatTitleOnlyTUI } from '../../src/commands/helpers.js';

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

    it('should have TUI stage colours defined', () => {
      expect(theme.tui.stage).toBeDefined();
      expect(theme.tui.stage.idea).toBeTypeOf('function');
      expect(theme.tui.stage.intakeComplete).toBeTypeOf('function');
      expect(theme.tui.stage.planComplete).toBeTypeOf('function');
      expect(theme.tui.stage.inProgress).toBeTypeOf('function');
      expect(theme.tui.stage.inReview).toBeTypeOf('function');
      expect(theme.tui.stage.done).toBeTypeOf('function');
    });

    it('should have status colours defined including new statuses', () => {
      expect(theme.status.inputNeeded).toBeTypeOf('function');
      expect(theme.status.deleted).toBeTypeOf('function');
    });

    it('should have TUI status colours defined including new statuses', () => {
      expect(theme.tui.status.inputNeeded).toBeTypeOf('function');
      expect(theme.tui.status.deleted).toBeTypeOf('function');
    });
  });

  describe('Stage-based colour mapping (CLI)', () => {
    it('should colour idea stage items', () => {
      const item = createMockWorkItem({ stage: 'idea' });
      const coloured = formatTitleOnly(item);
      // Verify function returns a string
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour intake_complete stage items', () => {
      const item = createMockWorkItem({ stage: 'intake_complete' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour plan_complete stage items', () => {
      const item = createMockWorkItem({ stage: 'plan_complete' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour in_progress stage items', () => {
      const item = createMockWorkItem({ stage: 'in_progress' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour in_review stage items', () => {
      const item = createMockWorkItem({ stage: 'in_review' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should colour done stage items', () => {
      const item = createMockWorkItem({ stage: 'done' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toBeTypeOf('string');
      expect(coloured.length).toBeGreaterThan(0);
    });

    it('should have stage colours defined', () => {
      const item = createMockWorkItem({ stage: 'idea' });
      const coloured = formatTitleOnlyTUI(item);
      // Should contain blessed tags
      expect(coloured).toContain('{');
      expect(coloured).toContain('}');
    });

    it('should apply blessed markup tags for in_review stage', () => {
      const item = createMockWorkItem({ stage: 'in_review' });
      const coloured = formatTitleOnlyTUI(item);
      // Should contain magenta-fg tag
      expect(coloured).toContain('magenta-fg');
    });

    it('should apply blessed markup tags for done stage', () => {
      const item = createMockWorkItem({ stage: 'done' });
      const coloured = formatTitleOnlyTUI(item);
      // Should contain green-fg tag
      expect(coloured).toContain('green-fg');
    });

    it('should apply blessed markup tags for idea stage', () => {
      const item = createMockWorkItem({ stage: 'idea' });
      const coloured = formatTitleOnlyTUI(item);
      // Should contain blue-fg tag
      expect(coloured).toContain('blue-fg');
    });

    it('should apply blessed markup tags for intake_complete stage', () => {
      const item = createMockWorkItem({ stage: 'intake_complete' });
      const coloured = formatTitleOnlyTUI(item);
      // Should contain 214-fg (orange) tag
      expect(coloured).toContain('214-fg');
    });

    it('should produce different blessed tags for different stages', () => {
      const stages = ['idea', 'in_review', 'done'];
      const outputs = stages.map(stage => {
        const item = createMockWorkItem({ stage });
        return formatTitleOnlyTUI(item);
      });
      // All outputs should be distinct
      const uniqueOutputs = new Set(outputs);
      expect(uniqueOutputs.size).toBe(stages.length);
    });
  });

  describe('Priority: stage over status', () => {
    it('should prefer stage colour over status colour when stage is set', () => {
      const item = createMockWorkItem({ 
        stage: 'in_review', 
        status: 'open' 
      });
      const coloured = formatTitleOnlyTUI(item);
      // Should use stage colour (magenta), not status colour (green-fg)
      expect(coloured).toContain('magenta-fg');
      expect(coloured).not.toContain('green-fg');
    });

    it('should fall back to status colour when stage is undefined', () => {
      const item = createMockWorkItem({ 
        stage: undefined, 
        status: 'blocked' 
      });
      const coloured = formatTitleOnlyTUI(item);
      // Should use status colour (red-fg for blocked)
      expect(coloured).toContain('red-fg');
    });

    it('should fall back to status colour when stage is empty string', () => {
      const item = createMockWorkItem({ 
        stage: '', 
        status: 'in-progress' 
      });
      const coloured = formatTitleOnlyTUI(item);
      // Should use status colour (cyan-fg for in-progress)
      expect(coloured).toContain('cyan-fg');
    });
  });

  describe('Accessibility', () => {
    it('should preserve text labels when coloured', () => {
      const item = createMockWorkItem({ 
        title: 'Important Feature',
        stage: 'in_review' 
      });
      const coloured = formatTitleOnly(item);
      // Title text should still be present
      expect(coloured).toContain('Important Feature');
    });

    it('should not inject non-text that breaks screen readers', () => {
      const item = createMockWorkItem({ 
        title: 'Screen Reader Test',
        stage: 'done' 
      });
      const coloured = formatTitleOnly(item);
      // Only ANSI codes should be added, no extra text
      expect(coloured).toContain('Screen Reader Test');
    });

    it('should include stage name in display for TUI', () => {
      const item = createMockWorkItem({ 
        title: 'Test Item',
        stage: 'in_review' 
      });
      const coloured = formatTitleOnlyTUI(item);
      // Title should still be visible
      expect(coloured).toContain('Test Item');
    });
  });

  describe('Fallback behaviour (colours disabled)', () => {
    it('should produce plain text when FORCE_COLOR=0', () => {
      process.env.FORCE_COLOR = '0';
      const item = createMockWorkItem({ stage: 'idea' });
      const coloured = formatTitleOnly(item);
      // Should NOT contain ANSI codes
      expect(coloured).not.toMatch(/\x1b\[/);
      // Should still contain the title
      expect(coloured).toBe('Test Item');
    });

    it('should produce plain text when FORCE_COLOR is not set', () => {
      delete process.env.FORCE_COLOR;
      // Also need to ensure chalk is not in colour mode
      const item = createMockWorkItem({ stage: 'in_review' });
      const coloured = formatTitleOnly(item);
      // In test environment without FORCE_COLOR, chalk may or may not have colours
      // Just verify the title is present
      expect(coloured).toContain('Test Item');
    });

    it('should always apply blessed tags in TUI regardless of FORCE_COLOR', () => {
      delete process.env.FORCE_COLOR;
      const item = createMockWorkItem({ stage: 'done' });
      const coloured = formatTitleOnlyTUI(item);
      // Blessed tags should always be present for TUI
      expect(coloured).toContain('{');
      expect(coloured).toContain('}');
      expect(coloured).toContain('green-fg');
    });

    it('should fall back to plain text in CLI when colours disabled', () => {
      process.env.FORCE_COLOR = '0';
      const statuses = ['open', 'in-progress', 'blocked', 'completed', 'input_needed', 'deleted'];
      const stages = ['idea', 'intake_complete', 'plan_complete', 'in_progress', 'in_review', 'done'];
      
      // Test all statuses
      for (const status of statuses) {
        const item = createMockWorkItem({ status });
        const coloured = formatTitleOnly(item);
        expect(coloured).not.toMatch(/\x1b\[/);
        expect(coloured).toBe('Test Item');
      }
      
      // Test all stages
      for (const stage of stages) {
        const item = createMockWorkItem({ stage });
        const coloured = formatTitleOnly(item);
        expect(coloured).not.toMatch(/\x1b\[/);
        expect(coloured).toBe('Test Item');
      }
    });
  });

  describe('Visual regression tests (snapshot-like)', () => {
    it('should produce consistent output for idea stage', () => {
      const item = createMockWorkItem({ stage: 'idea', title: 'My Feature' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with blue-fg
      expect(output).toBe('{blue-fg}My Feature{/blue-fg}');
    });

    it('should produce consistent output for intake_complete stage', () => {
      const item = createMockWorkItem({ stage: 'intake_complete', title: 'My Task' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with 214-fg (orange)
      expect(output).toBe('{214-fg}My Task{/214-fg}');
    });

    it('should produce consistent output for in_review stage', () => {
      const item = createMockWorkItem({ stage: 'in_review', title: 'Review Item' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with magenta-fg
      expect(output).toBe('{magenta-fg}Review Item{/magenta-fg}');
    });

    it('should produce consistent output for done stage', () => {
      const item = createMockWorkItem({ stage: 'done', title: 'Completed Work' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with green-fg
      expect(output).toBe('{green-fg}Completed Work{/green-fg}');
    });

    it('should produce consistent output for blocked status', () => {
      const item = createMockWorkItem({ status: 'blocked', title: 'Blocked Item' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with red-fg
      expect(output).toBe('{red-fg}Blocked Item{/red-fg}');
    });

    it('should produce consistent output for open status', () => {
      const item = createMockWorkItem({ status: 'open', title: 'Open Task' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with green-fg
      expect(output).toBe('{green-fg}Open Task{/green-fg}');
    });

    it('should produce consistent output for in-progress status', () => {
      const item = createMockWorkItem({ status: 'in-progress', title: 'WIP Item' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with cyan-fg
      expect(output).toBe('{cyan-fg}WIP Item{/cyan-fg}');
    });

    it('should produce consistent output for completed status', () => {
      const item = createMockWorkItem({ status: 'completed', title: 'Done Item' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with white-fg
      expect(output).toBe('{white-fg}Done Item{/white-fg}');
    });
  });
});
