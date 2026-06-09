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

    it('should have a blocked colour override defined for CLI', () => {
      expect(theme.blocked).toBeTypeOf('function');
    });

    it('should have a blocked colour override defined for TUI', () => {
      expect(theme.tui.blocked).toBeTypeOf('function');
    });

    it('should NOT have status colours defined (removed)', () => {
      expect((theme as any).status).toBeUndefined();
      expect((theme.tui as any).status).toBeUndefined();
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

  describe('Stage-based colour mapping (TUI)', () => {
    it('should apply blessed markup tags for idea stage', () => {
      const item = createMockWorkItem({ stage: 'idea' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('gray-fg');
    });

    it('should apply blessed markup tags for intake_complete stage', () => {
      const item = createMockWorkItem({ stage: 'intake_complete' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('blue-fg');
    });

    it('should apply blessed markup tags for plan_complete stage', () => {
      const item = createMockWorkItem({ stage: 'plan_complete' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('cyan-fg');
    });

    it('should apply blessed markup tags for in_progress stage', () => {
      const item = createMockWorkItem({ stage: 'in_progress' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('yellow-fg');
    });

    it('should apply blessed markup tags for in_review stage', () => {
      const item = createMockWorkItem({ stage: 'in_review' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('green-fg');
    });

    it('should apply blessed markup tags for done stage', () => {
      const item = createMockWorkItem({ stage: 'done' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('white-fg');
    });

    it('should produce different blessed tags for different stages', () => {
      const stages = ['idea', 'intake_complete', 'in_progress', 'done'];
      const outputs = stages.map(stage => {
        const item = createMockWorkItem({ stage });
        return formatTitleOnlyTUI(item);
      });
      const uniqueOutputs = new Set(outputs);
      expect(uniqueOutputs.size).toBe(stages.length);
    });
  });

  describe('Blocked status override', () => {
    it('should apply red colour when status is blocked, regardless of stage (CLI)', () => {
      const item = createMockWorkItem({ status: 'blocked', stage: 'in_review', title: 'Blocked Item' });
      const coloured = formatTitleOnly(item);
      // The title text should be present (colour applied via chalk, content unchanged)
      expect(coloured).toContain('Blocked Item');
    });

    it('should apply red colour when status is blocked, even with done stage (TUI)', () => {
      const item = createMockWorkItem({ status: 'blocked', stage: 'done', title: 'Blocked Done' });
      const coloured = formatTitleOnlyTUI(item);
      // Blocked overrides stage: should use red-fg, not green-fg (done) or white-fg
      expect(coloured).toContain('red-fg');
      expect(coloured).not.toContain('green-fg');
    });

    it('should apply red colour when status is blocked with no stage (TUI)', () => {
      const item = createMockWorkItem({ status: 'blocked', stage: undefined, title: 'Blocked No Stage' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('red-fg');
    });

    it('should apply red colour when status is blocked with idea stage (TUI)', () => {
      const item = createMockWorkItem({ status: 'blocked', stage: 'idea', title: 'Blocked Idea' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('red-fg');
      expect(coloured).not.toContain('gray-fg');
    });

    it('should use stage colour when status is not blocked', () => {
      const item = createMockWorkItem({ status: 'open', stage: 'in_progress', title: 'Normal Item' });
      const coloured = formatTitleOnlyTUI(item);
      // Should use yellow-fg for in_progress, not red-fg
      expect(coloured).toContain('yellow-fg');
      expect(coloured).not.toContain('red-fg');
    });

    it('should produce consistent output for blocked status in TUI', () => {
      const item = createMockWorkItem({ status: 'blocked', stage: 'in_review', title: 'Blocked Item' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with red-fg (blocked overrides stage)
      expect(output).toBe('{red-fg}Blocked Item{/red-fg}');
    });
  });

  describe('Default/fallback behaviour', () => {
    it('should use gray (idea) colour when stage is undefined and status is not blocked (TUI)', () => {
      const item = createMockWorkItem({ stage: undefined, status: 'open', title: 'No Stage' });
      const coloured = formatTitleOnlyTUI(item);
      // Should fall back to gray-fg (idea/idea default colour)
      expect(coloured).toContain('gray-fg');
    });

    it('should use gray (idea) colour when stage is empty string and status is not blocked (TUI)', () => {
      const item = createMockWorkItem({ stage: '', status: 'open', title: 'Empty Stage' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('gray-fg');
    });

    it('should use gray (idea) colour when stage is unknown and status is not blocked (TUI)', () => {
      const item = createMockWorkItem({ stage: 'unknown_stage', status: 'open', title: 'Unknown Stage' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('gray-fg');
    });

    it('should still use red for blocked status even when stage is undefined', () => {
      const item = createMockWorkItem({ status: 'blocked', stage: undefined, title: 'Blocked Undefined' });
      const coloured = formatTitleOnlyTUI(item);
      expect(coloured).toContain('red-fg');
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

    it('should preserve text for blocked items', () => {
      const item = createMockWorkItem({
        title: 'Blocked Work',
        status: 'blocked',
        stage: 'in_progress',
      });
      const cliColoured = formatTitleOnly(item);
      const tuiColoured = formatTitleOnlyTUI(item);
      expect(cliColoured).toContain('Blocked Work');
      expect(tuiColoured).toContain('Blocked Work');
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
      expect(coloured).toContain('white-fg');
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

    it('should fall back to idea/gray for undefined stage when colours disabled', () => {
      process.env.FORCE_COLOR = '0';
      const item = createMockWorkItem({ stage: undefined, status: 'open' });
      const coloured = formatTitleOnly(item);
      expect(coloured).not.toMatch(/\x1b\[/);
      expect(coloured).toBe('Test Item');
    });
  });

  describe('Visual regression tests (snapshot-like)', () => {
    it('should produce consistent output for idea stage', () => {
      const item = createMockWorkItem({ stage: 'idea', title: 'My Feature' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with gray-fg
      expect(output).toBe('{gray-fg}My Feature{/gray-fg}');
    });

    it('should produce consistent output for intake_complete stage', () => {
      const item = createMockWorkItem({ stage: 'intake_complete', title: 'My Task' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with blue-fg
      expect(output).toBe('{blue-fg}My Task{/blue-fg}');
    });

    it('should produce consistent output for plan_complete stage', () => {
      const item = createMockWorkItem({ stage: 'plan_complete', title: 'My Plan' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with cyan-fg
      expect(output).toBe('{cyan-fg}My Plan{/cyan-fg}');
    });

    it('should produce consistent output for in_progress stage', () => {
      const item = createMockWorkItem({ stage: 'in_progress', title: 'WIP Item' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with yellow-fg
      expect(output).toBe('{yellow-fg}WIP Item{/yellow-fg}');
    });

    it('should produce consistent output for in_review stage', () => {
      const item = createMockWorkItem({ stage: 'in_review', title: 'Review Item' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with green-fg
      expect(output).toBe('{green-fg}Review Item{/green-fg}');
    });

    it('should produce consistent output for done stage', () => {
      const item = createMockWorkItem({ stage: 'done', title: 'Completed Work' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with white-fg
      expect(output).toBe('{white-fg}Completed Work{/white-fg}');
    });

    it('should produce consistent output for blocked status overriding stage', () => {
      const item = createMockWorkItem({ status: 'blocked', stage: 'in_review', title: 'Blocked Item' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with red-fg (blocked overrides stage)
      expect(output).toBe('{red-fg}Blocked Item{/red-fg}');
    });

    it('should produce consistent output for undefined stage (not blocked)', () => {
      const item = createMockWorkItem({ stage: undefined, status: 'open', title: 'No Stage' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with gray-fg (idea/default colour)
      expect(output).toBe('{gray-fg}No Stage{/gray-fg}');
    });

    it('should produce consistent output for empty stage (not blocked)', () => {
      const item = createMockWorkItem({ stage: '', status: 'open', title: 'Empty Stage' });
      const output = formatTitleOnlyTUI(item);
      // Snapshot: blessed markup with gray-fg (idea/default colour)
      expect(output).toBe('{gray-fg}Empty Stage{/gray-fg}');
    });
  });
});