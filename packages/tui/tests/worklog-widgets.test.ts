/**
 * Unit tests for worklog widget helper functions.
 *
 * Run: npx vitest run packages/tui/tests/worklog-widgets.test.ts
 */

import { describe, it, expect } from 'vitest';

// Import the widget helper functions
import {
  buildWorklogWidgetLines,
  buildWorklogDetailsLines,
  getStatusIcon,
  truncate,
  stageColourToken,
  applyStageColour,
  type WorkItem,
  type PiTheme,
} from '../extensions/worklog-helpers.js';

const mockItems = [
  {
    id: 'WL-001',
    title: 'Implement chat pane',
    status: 'in_progress',
    priority: 'high',
    assignee: 'alice',
    stage: 'in_progress',
    issueType: 'feature',
    description: 'Build the chat pane UI component',
  },
  {
    id: 'WL-002',
    title: 'Fix bug in action palette',
    status: 'open',
    priority: 'medium',
    assignee: 'bob',
    issueType: 'bug',
    description: 'The action palette crashes when there are no items',
  },
  {
    id: 'WL-003',
    title: 'Update documentation',
    status: 'open',
    priority: 'low',
    issueType: 'task',
    description: '',
  },
];

describe('buildWorklogWidgetLines', () => {
  it('returns a no-items message when given an empty array', () => {
    const lines = buildWorklogWidgetLines(80, [], 0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('No work items');
  });

  it('renders items with numbered indices', () => {
    const lines = buildWorklogWidgetLines(80, mockItems, 0);
    expect(lines.some(l => l.includes('1:'))).toBe(true);
    expect(lines.some(l => l.includes('2:'))).toBe(true);
    expect(lines.some(l => l.includes('3:'))).toBe(true);
  });

  it('marks the selected item with a pointer', () => {
    const lines = buildWorklogWidgetLines(80, mockItems, 1);
    const selectedIndexLine = lines.find(l => l.includes('2:'));
    expect(selectedIndexLine).toBeDefined();
    expect(selectedIndexLine).toContain('▸');
    // Non-selected items should not have the pointer
    const nonSelectedLine = lines.find(l => l.includes('1:') && !l.includes('▸'));
    expect(nonSelectedLine).toBeDefined();
  });

  it('includes status icons', () => {
    const lines = buildWorklogWidgetLines(80, mockItems, 0);
    const joined = lines.join('\n');
    expect(joined).toContain('🔄'); // in_progress
    expect(joined).toContain('🔓'); // open
  });

  it('truncates long titles', () => {
    const longItem = {
      ...mockItems[0],
      title: 'This is an extremely long work item title that should be truncated to fit the available width of the terminal',
    };
    const lines = buildWorklogWidgetLines(40, [longItem], 0);
    const titleLine = lines.find(l => l.includes('1:'));
    expect(titleLine).toBeDefined();
    expect(titleLine!.length).toBeLessThanOrEqual(40);
    expect(titleLine).toContain('...');
  });

  it('limits display to 9 items with a "more" note', () => {
    const manyItems = Array.from({ length: 15 }, (_, i) => ({
      ...mockItems[0],
      id: `WL-${i + 1}`,
      title: `Item ${i + 1}`,
    }));
    const lines = buildWorklogWidgetLines(80, manyItems, 0);
    // Should have header + 9 items + "more" note
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.some(l => l.includes('more'))).toBe(true);
  });

  it('handles narrow width constraints by truncating titles', () => {
    const lines = buildWorklogWidgetLines(30, mockItems, 0);
    // Item lines (not header) should be truncated to fit
    const itemLines = lines.filter(l => l.match(/^\s+\d:/));
    for (const line of itemLines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });
});

describe('buildWorklogDetailsLines', () => {
  it('returns a no-selection message when given null', () => {
    const lines = buildWorklogDetailsLines(80, null as any);
    expect(lines.some(l => l.includes('No item selected'))).toBe(true);
  });

  it('renders item id, title, status, and priority', () => {
    const lines = buildWorklogDetailsLines(80, mockItems[0]);
    const joined = lines.join('\n');
    expect(joined).toContain('WL-001');
    expect(joined).toContain('Implement chat pane');
    expect(joined).toContain('in_progress');
    expect(joined).toContain('high');
  });

  it('includes optional fields when present', () => {
    const lines = buildWorklogDetailsLines(80, mockItems[0]);
    const joined = lines.join('\n');
    expect(joined).toContain('alice');
    expect(joined).toContain('feature');
  });

  it('omits optional fields when not present', () => {
    const lines = buildWorklogDetailsLines(80, mockItems[2]);
    const joined = lines.join('\n');
    expect(joined).not.toContain('Assignee:');
    expect(joined).not.toContain('Stage:');
  });

  it('includes description summary when present', () => {
    const lines = buildWorklogDetailsLines(80, mockItems[0]);
    expect(lines.some(l => l.includes('Summary:'))).toBe(true);
  });

  it('truncates long descriptions', () => {
    const longDescItem = {
      ...mockItems[0],
      description: 'A'.repeat(500),
    };
    const lines = buildWorklogDetailsLines(40, longDescItem);
    const summaryLine = lines.find(l => l.includes('Summary:'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine!.length).toBeLessThanOrEqual(40);
  });

  it('handles empty description gracefully', () => {
    const lines = buildWorklogDetailsLines(80, mockItems[2]);
    expect(lines.some(l => l.includes('Summary:'))).toBe(false);
  });
});

describe('getStatusIcon', () => {
  it('returns a progress icon for in_progress', () => {
    expect(getStatusIcon('in_progress')).toBe('🔄');
  });

  it('returns a check icon for completed', () => {
    expect(getStatusIcon('completed')).toBe('✔️');
  });

  it('returns a blocked icon for blocked', () => {
    expect(getStatusIcon('blocked')).toBe('⛔');
  });

  it('returns a circle icon for unknown statuses', () => {
    expect(getStatusIcon('unknown')).toBe('○');
    expect(getStatusIcon('open')).toBe('🔓');
  });
});

describe('truncate', () => {
  it('returns the original text when it fits', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('truncates and adds ellipsis when text is too long', () => {
    const result = truncate('hello world', 8);
    expect(result).toBe('hello...');
    expect(result.length).toBe(8);
  });

  it('handles exact length match', () => {
    expect(truncate('exact', 5)).toBe('exact');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });
});

describe('stageColourToken', () => {
  it('returns dim for idea stage', () => {
    expect(stageColourToken('idea')).toBe('dim');
  });

  it('returns mdLink for intake_complete stage (blue-like)', () => {
    expect(stageColourToken('intake_complete')).toBe('mdLink');
  });

  it('returns accent for plan_complete stage (cyan-like)', () => {
    expect(stageColourToken('plan_complete')).toBe('accent');
  });

  it('returns warning for in_progress stage', () => {
    expect(stageColourToken('in_progress')).toBe('warning');
  });

  it('returns success for in_review stage', () => {
    expect(stageColourToken('in_review')).toBe('success');
  });

  it('returns text for done stage', () => {
    expect(stageColourToken('done')).toBe('text');
  });

  it('returns dim for undefined stage', () => {
    expect(stageColourToken(undefined)).toBe('dim');
  });

  it('returns dim for empty stage', () => {
    expect(stageColourToken('')).toBe('dim');
  });

  it('returns dim for unknown stage', () => {
    expect(stageColourToken('unknown')).toBe('dim');
  });

  it('handles case-insensitive stage values', () => {
    expect(stageColourToken('IN_PROGRESS')).toBe('warning');
    expect(stageColourToken('In_Progress')).toBe('warning');
  });

  it('handles whitespace in stage values', () => {
    expect(stageColourToken('  in_progress  ')).toBe('warning');
  });
});

describe('applyStageColour', () => {
  const mockTheme: PiTheme = {
    fg: (color, text) => `[${color}]${text}[/${color}]`,
    bold: (text) => `**${text}**`,
  };

  it('returns plain text when no theme is provided', () => {
    expect(applyStageColour('Test', 'in_progress', 'open', undefined)).toBe('Test');
  });

  it('applies error colour for blocked status regardless of stage', () => {
    const result = applyStageColour('Test Title', 'in_progress', 'blocked', mockTheme);
    expect(result).toBe('[error]Test Title[/error]');
  });

  it('applies dim colour for idea stage', () => {
    const result = applyStageColour('Test Title', 'idea', 'open', mockTheme);
    expect(result).toBe('[dim]Test Title[/dim]');
  });

  it('applies mdLink colour (blue-like) for intake_complete stage', () => {
    const result = applyStageColour('Test Title', 'intake_complete', 'open', mockTheme);
    expect(result).toBe('[mdLink]Test Title[/mdLink]');
  });

  it('applies accent colour (cyan-like) for plan_complete stage', () => {
    const result = applyStageColour('Test Title', 'plan_complete', 'open', mockTheme);
    expect(result).toBe('[accent]Test Title[/accent]');
  });

  it('applies warning colour for in_progress stage', () => {
    const result = applyStageColour('Test Title', 'in_progress', 'open', mockTheme);
    expect(result).toBe('[warning]Test Title[/warning]');
  });

  it('applies success colour for in_review stage', () => {
    const result = applyStageColour('Test Title', 'in_review', 'open', mockTheme);
    expect(result).toBe('[success]Test Title[/success]');
  });

  it('applies text colour for done stage', () => {
    const result = applyStageColour('Test Title', 'done', 'open', mockTheme);
    expect(result).toBe('[text]Test Title[/text]');
  });

  it('applies dim colour for undefined stage', () => {
    const result = applyStageColour('Test Title', undefined, 'open', mockTheme);
    expect(result).toBe('[dim]Test Title[/dim]');
  });
});
