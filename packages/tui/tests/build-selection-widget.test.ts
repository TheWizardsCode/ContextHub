/**
 * Unit tests for buildSelectionWidget.
 *
 * Verifies that the selection preview widget renders a single-line summary
 * in the format: WL-123456 | tags: tui, ui | GH #608
 *
 * The existing preview content (icon prefix, coloured title, priority text,
 * stage, risk/effort) is entirely replaced — the preview shows only the new
 * ID/Tags/GitHub ID line.
 *
 * Run: npx vitest run packages/tui/tests/build-selection-widget.test.ts
 */

import { describe, it, expect } from 'vitest';
import { buildSelectionWidget, type WorklogBrowseItem } from '../extensions/index.js';
import { type PiTheme } from '../extensions/worklog-helpers.js';

const mockTheme: PiTheme = {
  fg: (color, text) => `[${color}]${text}[/${color}]`,
  bold: (text) => `**${text}**`,
};

const mockItem: WorklogBrowseItem = {
  id: 'WL-001',
  title: 'Implement chat pane',
  status: 'in_progress',
  priority: 'high',
  stage: 'in_progress',
  risk: 'Medium',
  effort: 'Small',
  tags: ['tui', 'ui'],
  githubIssueNumber: 608,
};

describe('buildSelectionWidget', () => {
  it('returns a single rendered line', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const lines = widget.render(120);
    expect(lines).toHaveLength(1);
  });

  it('displays ID, tags, and GitHub issue number in the expected format', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Expected format: WL-123456 | tags: tui, ui | GH #608
    expect(line).toContain('WL-001');
    expect(line).toContain('tags: tui, ui');
    expect(line).toContain('GH #608');
  });

  it('includes pipe separators between segments', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Should have two pipe separators for three segments
    const pipeCount = (line.match(/\|/g) || []).length;
    expect(pipeCount).toBe(2);
  });

  it('shows "tags: —" when tags array is empty', () => {
    const noTagsItem: WorklogBrowseItem = {
      ...mockItem,
      tags: [],
    };
    const factory = buildSelectionWidget(noTagsItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('tags: —');
    // Should still show GitHub issue number
    expect(line).toContain('GH #608');
    expect(line).toContain('WL-001');
  });

  it('shows "tags: —" when tags is undefined', () => {
    const noTagsItem: WorklogBrowseItem = {
      ...mockItem,
      tags: undefined,
    };
    const factory = buildSelectionWidget(noTagsItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('tags: —');
    expect(line).toContain('GH #608');
  });

  it('omits the GH # segment when githubIssueNumber is undefined', () => {
    const noGithubItem: WorklogBrowseItem = {
      ...mockItem,
      githubIssueNumber: undefined,
    };
    const factory = buildSelectionWidget(noGithubItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('WL-001');
    expect(line).toContain('tags: tui, ui');
    expect(line).not.toContain('GH #');
  });

  it('omits the GH # segment when githubIssueNumber is 0', () => {
    const zeroGithubItem: WorklogBrowseItem = {
      ...mockItem,
      githubIssueNumber: 0,
    };
    const factory = buildSelectionWidget(zeroGithubItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('WL-001');
    expect(line).toContain('tags: tui, ui');
    expect(line).not.toContain('GH #');
  });

  it('shows only ID and tags when both tags and githubIssueNumber are missing', () => {
    const minimalItem: WorklogBrowseItem = {
      id: 'WL-000',
      title: 'Minimal',
      status: 'open',
      tags: undefined,
      githubIssueNumber: undefined,
    };
    const factory = buildSelectionWidget(minimalItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('WL-000');
    expect(line).toContain('tags: —');
    expect(line).not.toContain('GH #');
    // Only one pipe separator (ID | tags)
    const pipeCount = (line.match(/\|/g) || []).length;
    expect(pipeCount).toBe(1);
  });

  it('handles a single tag correctly', () => {
    const singleTagItem: WorklogBrowseItem = {
      ...mockItem,
      tags: ['bug'],
    };
    const factory = buildSelectionWidget(singleTagItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('tags: bug');
  });

  it('truncates line when it exceeds width', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(15)[0];
    // Should be truncated with ellipsis
    expect(line.length).toBeLessThanOrEqual(20); // 15 + '…'
    expect(line).toContain('…');
  });

  it('does not wrap content in theme colours', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // The new preview is plain text — no colour tags
    expect(line).not.toContain('[warning]');
    expect(line).not.toContain('[error]');
    expect(line).not.toContain('[/warning]');
    expect(line).not.toContain('[/error]');
  });

  it('does not include status icons, stage icons, priority text, stage, or risk/effort', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // The old content should not be present
    expect(line).not.toContain('🔄');
    expect(line).not.toContain('🛠️');
    expect(line).not.toContain('❓');
    expect(line).not.toContain('⭐');
    expect(line).not.toContain('HIGH');
    expect(line).not.toContain('Medium/Small');
  });

  it('does not include title text in the preview', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // The title should NOT appear in the preview (only ID, tags, GH)
    expect(line).not.toContain('Implement chat pane');
  });
});
