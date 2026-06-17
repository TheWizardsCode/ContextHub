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
import { type Settings } from '../extensions/settings-config.js';

const mockTheme: PiTheme = {
  fg: (color, text) => `[${color}]${text}[/${color}]`,
  bold: (text) => `**${text}**`,
};

const mockSettings: Settings = {
  browseItemCount: 5,
  showIcons: true,
};

const mockItem: WorklogBrowseItem = {
  id: 'WL-001',
  title: 'Implement chat pane',
  status: 'in_progress',
  priority: 'high',
  stage: 'in_progress',
  risk: 'Medium',
  effort: 'S',
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

  it('displays ID, tags, GitHub issue number, and effort/risk icons in the expected format', () => {
    const factory = buildSelectionWidget(mockItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Expected format: WL-123456 | tags: tui, ui | GH #608 | 🐇 🌱
    expect(line).toContain('WL-001');
    expect(line).toContain('tags: tui, ui');
    expect(line).toContain('GH #608');
    // Effort (S) and risk (Medium) icons
    expect(line).toContain('🐇');  // S effort
    expect(line).toContain('\u{26A0}\u{FE0F}');  // ⚠️ Medium risk
  });

  it('includes pipe separators between all segments including effort/risk', () => {
    const factory = buildSelectionWidget(mockItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Should have three pipe separators for four segments (ID | tags | GH | effort_risk)
    const pipeCount = (line.match(/\|/g) || []).length;
    expect(pipeCount).toBe(3);
  });

  it('shows "tags: —" when tags array is empty', () => {
    const noTagsItem: WorklogBrowseItem = {
      ...mockItem,
      tags: [],
    };
    const factory = buildSelectionWidget(noTagsItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('tags: —');
    expect(line).toContain('GH #608');
    expect(line).toContain('WL-001');
    // Still shows effort/risk icons
    expect(line).toContain('🐇');
    expect(line).toContain('\u{26A0}\u{FE0F}');
  });

  it('shows "tags: —" when tags is undefined', () => {
    const noTagsItem: WorklogBrowseItem = {
      ...mockItem,
      tags: undefined,
    };
    const factory = buildSelectionWidget(noTagsItem, mockSettings);
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
    const factory = buildSelectionWidget(noGithubItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('WL-001');
    expect(line).toContain('tags: tui, ui');
    expect(line).not.toContain('GH #');
    // Still shows effort/risk icons
    expect(line).toContain('🐇');
    expect(line).toContain('\u{26A0}\u{FE0F}');
  });

  it('omits the GH # segment when githubIssueNumber is 0', () => {
    const zeroGithubItem: WorklogBrowseItem = {
      ...mockItem,
      githubIssueNumber: 0,
    };
    const factory = buildSelectionWidget(zeroGithubItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('WL-001');
    expect(line).toContain('tags: tui, ui');
    expect(line).not.toContain('GH #');
    // Still shows effort/risk icons
    expect(line).toContain('🐇');
    expect(line).toContain('\u{26A0}\u{FE0F}');
  });

  it('shows only ID, tags, and effort/risk when both tags and githubIssueNumber are missing', () => {
    const minimalItem: WorklogBrowseItem = {
      id: 'WL-000',
      title: 'Minimal',
      status: 'open',
      risk: 'Low',
      effort: 'M',
      tags: undefined,
      githubIssueNumber: undefined,
    };
    const factory = buildSelectionWidget(minimalItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('WL-000');
    expect(line).toContain('tags: —');
    expect(line).not.toContain('GH #');
    // Should still show effort/risk
    expect(line).toContain('🐕');  // M effort
    expect(line).toContain('🌱');  // Low risk
    // Two pipe separators (ID | tags | effort+risk)
    const pipeCount = (line.match(/\|/g) || []).length;
    expect(pipeCount).toBe(2);
  });

  it('handles a single tag correctly', () => {
    const singleTagItem: WorklogBrowseItem = {
      ...mockItem,
      tags: ['bug'],
    };
    const factory = buildSelectionWidget(singleTagItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('tags: bug');
  });

  it('truncates line when it exceeds width', () => {
    const factory = buildSelectionWidget(mockItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(15)[0];
    // Should be truncated with ellipsis
    expect(line.length).toBeLessThanOrEqual(20); // 15 + '…'
    expect(line).toContain('…');
  });

  it('does not wrap content in theme colours', () => {
    const factory = buildSelectionWidget(mockItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // The new preview is plain text — no colour tags
    expect(line).not.toContain('[warning]');
    expect(line).not.toContain('[error]');
    expect(line).not.toContain('[/warning]');
    expect(line).not.toContain('[/error]');
  });

  it('does not include status icons, stage icons, priority text, or stage', () => {
    const factory = buildSelectionWidget(mockItem, mockSettings);
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
    const factory = buildSelectionWidget(mockItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // The title should NOT appear in the preview (only ID, tags, GH, effort/risk)
    expect(line).not.toContain('Implement chat pane');
  });

  // ─── Risk/Effort icon tests ────────────────────────────────────────────

  it('shows effort icon before risk icon in the combined segment', () => {
    const factory = buildSelectionWidget(mockItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    const effortIndex = line.indexOf('🐇');
    const riskIndex = line.indexOf('\u{26A0}\u{FE0F}');
    expect(effortIndex).toBeGreaterThan(0);
    expect(riskIndex).toBeGreaterThan(effortIndex);
  });

  it('omits effort segment when effort is missing', () => {
    const noEffortItem: WorklogBrowseItem = {
      ...mockItem,
      effort: undefined,
    };
    const factory = buildSelectionWidget(noEffortItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Risk icon should still appear
    expect(line).toContain('\u{26A0}\u{FE0F}');  // ⚠️ Medium risk
    // No effort icon
    expect(line).not.toContain('🐇');
  });

  it('omits risk segment when risk is missing', () => {
    const noRiskItem: WorklogBrowseItem = {
      ...mockItem,
      risk: undefined,
    };
    const factory = buildSelectionWidget(noRiskItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Effort icon should still appear
    expect(line).toContain('🐇');  // S effort
    // No risk icon
    expect(line).not.toContain('\u{26A0}\u{FE0F}');
  });

  it('omits both effort and risk segments when both are missing', () => {
    const noEffortRiskItem: WorklogBrowseItem = {
      ...mockItem,
      effort: undefined,
      risk: undefined,
    };
    const factory = buildSelectionWidget(noEffortRiskItem, mockSettings);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Should have only two pipes (ID | tags | GH) = 2 pipes
    expect(line).not.toContain('🐇');
    expect(line).not.toContain('\u{26A0}\u{FE0F}');
    const pipeCount = (line.match(/\|/g) || []).length;
    expect(pipeCount).toBe(2);
  });

  it('shows text fallback when icons are disabled', () => {
    const settingsNoIcons: Settings = {
      browseItemCount: 5,
      showIcons: false,
    };
    const factory = buildSelectionWidget(mockItem, settingsNoIcons);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Should show fallback text instead of emoji
    expect(line).toContain('[S]');   // S effort fallback
    expect(line).toContain('[MED]'); // Medium risk fallback
    // Should NOT contain emoji
    expect(line).not.toContain('🐇');
    expect(line).not.toContain('\u{26A0}\u{FE0F}');
  });
});
