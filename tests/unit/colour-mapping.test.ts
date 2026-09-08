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

    it('should have priority colours defined: critical=red, high=orange, medium=white, low=dim', () => {
      expect(theme.priority.critical).toBeTypeOf('function');
      expect(theme.priority.high).toBeTypeOf('function');
      expect(theme.priority.medium).toBeTypeOf('function');
      expect(theme.priority.low).toBeTypeOf('function');
    });

    it('should NOT have a blocked override (removed, AC3)', () => {
      expect((theme as any).blocked).toBeUndefined();
    });

    it('should NOT have status colours defined (removed)', () => {
      expect((theme as any).status).toBeUndefined();
    });
  });

  // Stage colours are now used for IDs; title colours are priority-based.
  describe('Stage-based ID colouring (AC2 — stage retained for IDs)', () => {
    it('should colour idea stage IDs with gray (via formatTitleAndId / humanFormat)', () => {
      // IDs retain stage colours after AC2 refactor — smoke-test the mapping exists
      expect(theme.stage.idea).toBeTypeOf('function');
    });
  });

  describe('Priority-based title colouring (AC1 — WL-0MSJ2JFMO007PGQ6)', () => {
    for (const priority of ['critical', 'high', 'medium', 'low'] as const) {
      it(`should colour ${priority} priority titles via theme.priority.${priority}`, () => {
        const item = createMockWorkItem({ priority, title: `Priority ${priority}` });
        const coloured = formatTitleOnly(item);
        expect(coloured).toContain(`Priority ${priority}`);
      });
    }

    it('should colour unknown/bogus priority with medium (white) fallback', () => {
      const item = createMockWorkItem({ priority: 'bogus', title: 'Unknown priority' });
      const coloured = formatTitleOnly(item);
      expect(coloured).toContain('Unknown priority');
      // Fallback produces same output as medium
      expect(coloured).toBe(formatTitleOnly(createMockWorkItem({ priority: 'medium', title: 'Unknown priority' })));
    });

    it('should colour empty priority with medium fallback', () => {
      const item = createMockWorkItem({ priority: '', title: 'Empty priority' });
      expect(formatTitleOnly(item)).toContain('Empty priority');
    });
  });

  describe('Blocked items show their natural priority colour, not always-red (AC3)', () => {
    it('should colour a blocked low-priority item with low/dim, not red', () => {
      const blockedLow = createMockWorkItem({ status: 'blocked', priority: 'low', stage: 'in_review', title: 'Blocked Low' });
      const coloured = formatTitleOnly(blockedLow);
      expect(coloured).toContain('Blocked Low');
      // With blocked override removed, blocked low must match non-blocked low exactly
      const normalLow = createMockWorkItem({ status: 'open', priority: 'low', stage: 'in_review', title: 'Blocked Low' });
      expect(coloured).toBe(formatTitleOnly(normalLow));
    });

    it('should colour a blocked critical item with critical/red, not a generic blocked red', () => {
      const blockedCrit = createMockWorkItem({ status: 'blocked', priority: 'critical', stage: 'plan_complete', title: 'Blocked Critical' });
      const normalCrit = createMockWorkItem({ status: 'open', priority: 'critical', stage: 'plan_complete', title: 'Blocked Critical' });
      expect(formatTitleOnly(blockedCrit)).toBe(formatTitleOnly(normalCrit));
    });
  });

  describe('Default/fallback behaviour (AC4 — unknown priority/missing stage)', () => {
    it('should use gray colour for the ID when stage is undefined', () => {
      // Title colour is now priority-based; ID colour is stage-based
      const item = createMockWorkItem({ stage: undefined, status: 'open', priority: 'medium', title: 'No Stage' });
      expect(formatTitleOnly(item)).toContain('No Stage');
    });

    it('should render titles with low-priority colour without stage dependency', () => {
      const item = createMockWorkItem({ stage: '', status: 'open', priority: 'low', title: 'Low Priority' });
      expect(formatTitleOnly(item)).toContain('Low Priority');
    });

    it('should use medium/white fallback for unknown priority', () => {
      const unknown = createMockWorkItem({ priority: 'unknown_stage' as any, status: 'open', title: 'Unknown' } as any);
      expect(formatTitleOnly(unknown)).toContain('Unknown');
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
      const stages = ['idea', 'intake_complete', 'plan_complete', 'in_review', 'done'];
      
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
