/**
 * Unit tests for buildSelectionWidget.
 *
 * Verifies that the selection preview widget renders a single-line summary
 * with: title (stage-coloured), ID, status icon, priority icon+text, stage,
 * and risk/effort — in that order.
 *
 * Run: npx vitest run packages/tui/tests/build-selection-widget.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
};

describe('buildSelectionWidget', () => {
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.WL_NO_ICONS;
    delete process.env.WL_NO_ICONS;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.WL_NO_ICONS;
    } else {
      process.env.WL_NO_ICONS = origEnv;
    }
  });

  it('returns a single rendered line', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const lines = widget.render(120);
    expect(lines).toHaveLength(1);
  });

  it('includes stage and audit icons alongside status, priority, stage, and risk/effort in order', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Title (stage-coloured)
    expect(line).toContain('[warning]Implement chat pane[/warning]');
    // Status icon (in_progress → 🔄)
    expect(line).toContain('🔄');
    // Stage icon (in_progress → 🛠️)
    expect(line).toContain('🛠️');
    // Audit icon (undefined → ❓ unknown)
    expect(line).toContain('❓');
    // Priority icon+text (high → ⭐HIGH)
    expect(line).toContain('⭐HIGH');
    // Stage text
    expect(line).toContain('in_progress');
    // Risk/Effort
    expect(line).toContain('Medium/Small');

    // Verify icons come before title
    const statusIdx = line.indexOf('🔄');
    const titleIdx = line.indexOf('Implement chat pane');
    expect(statusIdx).toBeLessThan(titleIdx);
  });

  it('applies stage colour to the title', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Title should be wrapped in warning colour for in_progress stage
    expect(line).toContain('[warning]Implement chat pane[/warning]');
  });

  it('uses error colour for blocked status', () => {
    const blockedItem: WorklogBrowseItem = {
      ...mockItem,
      status: 'blocked',
    };
    const factory = buildSelectionWidget(blockedItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    expect(line).toContain('[error]Implement chat pane[/error]');
  });

  it('truncates line when it exceeds width', () => {
    const longTitleItem: WorklogBrowseItem = {
      ...mockItem,
      title: 'A'.repeat(200),
    };
    const factory = buildSelectionWidget(longTitleItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(50)[0];
    // Should be truncated with ellipsis
    expect(line.length).toBeLessThanOrEqual(55); // 50 + icon prefix + '…'
    expect(line).toContain('…');
  });

  it('returns plain text when no theme is provided', () => {
    const factory = buildSelectionWidget(mockItem);
    const widget = factory(null, undefined);
    const line = widget.render(120)[0];

    expect(line).toContain('Implement chat pane');
    // No colour tags should be present
    expect(line).not.toContain('[warning]');
    expect(line).not.toContain('[/warning]');
  });

  it('uses fallback dash values for missing metadata', () => {
    const minimalItem: WorklogBrowseItem = {
      id: 'WL-000',
      title: 'Minimal',
      status: 'open',
    };
    const factory = buildSelectionWidget(minimalItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // '—' for missing priority, stage, risk, effort
    expect(line).toContain('—');
    // Status icon for 'open' should be present
    expect(line).toContain('🔓');
  });

  it('uses text fallback icons when icons are disabled', () => {
    process.env.WL_NO_ICONS = '1';
    try {
      const factory = buildSelectionWidget(mockItem);
      const widget = factory(null, mockTheme);
      const line = widget.render(120)[0];

      // Status fallback for in_progress
      expect(line).toContain('[INPR]');
      // Stage fallback for in_progress
      expect(line).toContain('[PROG]');
      // Audit fallback for unknown
      expect(line).toContain('[UNKN]');
      // Priority fallback for high
      expect(line).toContain('[HIGH]');
      // No emoji should be present
      expect(line).not.toContain('🔄');
      expect(line).not.toContain('🛠️');
      expect(line).not.toContain('❓');
      expect(line).not.toContain('⭐');
    } finally {
      delete process.env.WL_NO_ICONS;
    }
  });

  it('handles unknown priority gracefully', () => {
    const unknownItem: WorklogBrowseItem = {
      ...mockItem,
      priority: 'unknown',
    };
    const factory = buildSelectionWidget(unknownItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Unknown priority should have no icon and show UNKNOWN
    expect(line).toContain('UNKNOWN');
  });

  it('handles unknown status gracefully', () => {
    const unknownItem: WorklogBrowseItem = {
      ...mockItem,
      status: 'florg',
    };
    const factory = buildSelectionWidget(unknownItem);
    const widget = factory(null, mockTheme);
    const line = widget.render(120)[0];

    // Unknown status should have no icon (empty string)
    // The line should still contain all other metadata
    expect(line).toContain('Implement chat pane');
    expect(line).toContain('⭐HIGH');
  });
});
