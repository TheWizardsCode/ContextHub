/**
 * tests/herdr/icons.test.ts — Tests for Herdr icon system
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  statusIcon,
  stageIcon,
  priorityIcon,
  auditIcon,
  epicIcon,
  riskIcon,
  effortIcon,
  needsProducerReviewIcon,
  auditStaleIcon,
  iconsEnabled,
  getIconPrefix,
  stageColor,
  stringDisplayWidth,
} from '@worklog/shared/icons';

import type { WorkItem } from '../../packages/herdr/src/fetcher.js';

// ── Tests ─────────────────────────────────────────────────────────────

describe('iconsEnabled', () => {
  it('returns true by default', () => {
    expect(iconsEnabled()).toBe(true);
  });

  it('returns false when noIcons is true', () => {
    expect(iconsEnabled({ noIcons: true })).toBe(false);
  });

  it('returns true when noIcons is false', () => {
    expect(iconsEnabled({ noIcons: false })).toBe(true);
  });
});

describe('statusIcon', () => {
  it('returns open icon for open status', () => {
    expect(statusIcon('open')).toBeTruthy();
    expect(statusIcon('open', { noIcons: true })).toMatch(/open/i);
  });

  it('returns completed icon for completed status', () => {
    expect(statusIcon('completed')).toBeTruthy();
    expect(statusIcon('completed', { noIcons: true })).toMatch(/done/i);
  });

  it('handles in-progress status', () => {
    expect(statusIcon('in-progress')).toBeTruthy();
    expect(statusIcon('in-progress', { noIcons: true })).toMatch(/inpr/i);
  });

  it('handles blocked status', () => {
    expect(statusIcon('blocked')).toBeTruthy();
    expect(statusIcon('blocked', { noIcons: true })).toMatch(/blkd/i);
  });

  it('returns fallback for unknown status', () => {
    const result = statusIcon('unknown');
    expect(result).toBeTruthy();
  });

  it('is case-insensitive', () => {
    expect(statusIcon('OPEN')).toBe(statusIcon('open'));
  });
});

describe('stageIcon', () => {
  it('returns an icon for each known stage', () => {
    const stages = ['idea', 'intake_complete', 'plan_complete', 'in_progress', 'in_review', 'completed'];
    for (const s of stages) {
      expect(stageIcon(s)).toBeTruthy();
    }
  });

  it('returns fallback for unknown stage', () => {
    const result = stageIcon('unknown');
    expect(result).toBeTruthy();
  });

  it('returns text fallback in noIcons mode', () => {
    expect(stageIcon('in_review', { noIcons: true })).toMatch(/review/i);
  });
});

describe('priorityIcon', () => {
  it('returns icon for each priority level', () => {
    ['critical', 'high', 'medium', 'low'].forEach((p) => {
      expect(priorityIcon(p)).toBeTruthy();
    });
  });

  it('returns text fallback in noIcons mode', () => {
    expect(priorityIcon('high', { noIcons: true })).toMatch(/high/i);
  });

  it('is case-insensitive', () => {
    expect(priorityIcon('HIGH')).toBe(priorityIcon('high'));
  });
});

describe('auditIcon', () => {
  it('returns ready icon for true', () => {
    const result = auditIcon(true);
    expect(result).toBeTruthy();
  });

  it('returns not-ready icon for false', () => {
    const result = auditIcon(false);
    expect(result).toBeTruthy();
  });

  it('returns question mark for null', () => {
    const result = auditIcon(null);
    expect(result).toBeTruthy();
  });
});

describe('auditStaleIcon', () => {
  it('returns stale-passed icon for true', () => {
    const result = auditStaleIcon(true);
    expect(result).toBeTruthy();
  });

  it('returns stale icon for false/null', () => {
    expect(auditStaleIcon(false)).toBeTruthy();
  });
});

describe('epicIcon', () => {
  it('returns epic icon', () => {
    expect(epicIcon()).toBeTruthy();
  });

  it('returns text fallback in noIcons mode', () => {
    expect(epicIcon({ noIcons: true })).toMatch(/epic/i);
  });
});

describe('riskIcon', () => {
  it('returns icon for known risk levels', () => {
    ['low', 'medium', 'high', 'critical'].forEach((r) => {
      expect(riskIcon(r)).toBeTruthy();
    });
  });

  it('returns empty for unknown risk', () => {
    expect(riskIcon('unknown')).toBe('');
  });
});

describe('effortIcon', () => {
  it('returns icon for known effort levels', () => {
    ['small', 'medium', 'large', 'xlarge'].forEach((e) => {
      expect(effortIcon(e)).toBeTruthy();
    });
  });

  it('returns empty for unknown effort', () => {
    expect(effortIcon('unknown')).toBe('');
  });
});

describe('needsProducerReviewIcon', () => {
  it('returns needs-review icon when true', () => {
    const result = needsProducerReviewIcon(true);
    expect(result).toBeTruthy();
  });

  it('returns done icon when false', () => {
    const result = needsProducerReviewIcon(false);
    expect(result).toBeTruthy();
  });

  it('returns empty when undefined', () => {
    expect(needsProducerReviewIcon(undefined)).toBe('');
  });
});

describe('stageColor', () => {
  it('returns a color for each known stage', () => {
    const stages = ['idea', 'intake_complete', 'plan_complete', 'in_progress', 'in_review', 'completed'];
    for (const s of stages) {
      const color = stageColor(s);
      expect(typeof color).toBe('number');
      expect(color).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns default color for unknown stage', () => {
    expect(stageColor('unknown')).toBe(241);
  });
});

describe('getIconPrefix', () => {
  it('returns icon string for an open item', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open' };
    const prefix = getIconPrefix(item);
    expect(prefix).toBeTruthy();
    expect(prefix.length).toBeGreaterThan(0);
  });

  it('includes audit icon for in_review items', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'in_progress', stage: 'in_review' };
    const prefix = getIconPrefix(item);
    expect(prefix).toBeTruthy();
  });

  it('includes producer review icon', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open', needsProducerReview: true };
    const prefix = getIconPrefix(item);
    expect(prefix).toBeTruthy();
  });

  it('does not include child count in prefix', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open', childCount: 3 };
    const prefix = getIconPrefix(item);
    expect(prefix).not.toMatch(/\(3\)/);
  });

  it('includes epic icon for epic type', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open', issueType: 'epic' };
    const prefix = getIconPrefix(item);
    expect(prefix).toBeTruthy();
  });

  it('pads icon-mode prefixes to the fixed width and shows fallbacks in noIcons mode', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open', priority: 'high' };
    const withIcons = getIconPrefix(item, { noIcons: false });
    const withoutIcons = getIconPrefix(item, { noIcons: true });
    // Icon mode is padded to the fixed ICON_PREFIX_WIDTH (13 cells) so the
    // item-ID column aligns. noIcons mode renders text fallbacks, which are
    // wider than a single glyph, so its width is a >= floor rather than an
    // exact match (WL-0MTQYTA20009YXBT).
    expect(stringDisplayWidth(withIcons)).toBe(13);
    expect(withoutIcons).not.toMatch(/\p{Emoji}/u);
    expect(stringDisplayWidth(withoutIcons)).toBeGreaterThanOrEqual(13);
  });

  it('produces a prefix with no spaces between consecutive icons', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open', stage: 'in_progress' };
    const prefix = getIconPrefix(item);

    // Extract emoji characters and check they are adjacent (no space between)
    const emojiRegex = /\p{Emoji}/gu;
    const emojis = [...prefix.matchAll(emojiRegex)];
    if (emojis.length >= 2) {
      const first = emojis[0][0];
      const second = emojis[1][0];
      const firstIdx = prefix.indexOf(first);
      const secondIdx = prefix.indexOf(second, firstIdx + first.length);
      expect(secondIdx - (firstIdx + first.length)).toBe(0);
    }
  });

  it('all icon prefixes have the same display width regardless of icons', () => {
    const items: WorkItem[] = [
      { id: 'T1', title: 'T', status: 'open', stage: 'idea', issueType: 'task' as const },
      { id: 'T2', title: 'T', status: 'in-progress', stage: 'in_review', issueType: 'epic' as const, childCount: 3 },
      { id: 'T3', title: 'T', status: 'completed', stage: 'plan_complete', needsProducerReview: true },
      { id: 'T4', title: 'T', status: 'blocked', stage: 'intake_complete', issueType: 'task' as const },
      { id: 'T5', title: 'T', status: 'open', stage: 'in_progress', issueType: 'epic' as const },
    ];

    const widths = items.map((item) => stringDisplayWidth(getIconPrefix(item)));

    // All widths should be identical
    const allSame = widths.every((w) => w === widths[0]);
    expect(allSame).toBe(true);
  });

  it('prefixes with different icon counts align to the same column width', () => {
    // Item with only status icon
    const minimal: WorkItem = { id: 'T1', title: 'T', status: 'open', stage: 'idea', childCount: 0 };
    // Item with status + stage + review + epic icon (child count removed from prefix)
    const maximal: WorkItem = {
      id: 'T2', title: 'T', status: 'completed', stage: 'in_review',
      needsProducerReview: true, issueType: 'epic' as const, childCount: 5,
    };

    const minimalPrefix = getIconPrefix(minimal);
    const maximalPrefix = getIconPrefix(maximal);

    expect(stringDisplayWidth(minimalPrefix)).toBe(stringDisplayWidth(maximalPrefix));
  });

  it('handles audit-aware in_review items consistently', () => {
    const freshAudit: WorkItem = {
      id: 'T1', title: 'T', status: 'completed', stage: 'in_review',
      auditResult: true, auditedAt: '2025-01-02T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z', childCount: 0,
    };
    const staleAudit: WorkItem = {
      id: 'T2', title: 'T', status: 'completed', stage: 'in_review',
      auditResult: true, auditedAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z', childCount: 0,
    };

    const freshWidth = stringDisplayWidth(getIconPrefix(freshAudit));
    const staleWidth = stringDisplayWidth(getIconPrefix(staleAudit));
    expect(freshWidth).toBe(staleWidth);
  });

  it('handles items with and without producer review consistently', () => {
    const withReview: WorkItem = { id: 'T1', title: 'T', status: 'open', stage: 'idea', needsProducerReview: true };
    const withoutReview: WorkItem = { id: 'T2', title: 'T', status: 'open', stage: 'idea' };

    const withWidth = stringDisplayWidth(getIconPrefix(withReview));
    const withoutWidth = stringDisplayWidth(getIconPrefix(withoutReview));
    expect(withWidth).toBe(withoutWidth);
  });

  // ── Priority icon in the prefix (WL-0MUBEDFLC004JN86) ─────────────

  it('includes a priority icon for each priority level', () => {
    const expected: Record<string, string> = {
      critical: '\u{1F6A8}', // 🚨
      high: '\u{2B50}',      // ⭐
      medium: '\u{1F4CB}',   // 📋
      low: '\u{1F422}',      // 🐢
    };
    for (const [priority, glyph] of Object.entries(expected)) {
      const prefix = getIconPrefix({ id: 'T1', title: 'T', status: 'open', priority });
      expect(prefix.startsWith(glyph)).toBe(true);
    }
  });

  it('renders the PRIORITY_FALLBACK text first when noIcons is enabled', () => {
    const item: WorkItem = { id: 'T1', title: 'T', status: 'open', priority: 'high' };
    const prefix = getIconPrefix(item, { noIcons: true });
    expect(prefix.startsWith('[HIGH]')).toBe(true);
    expect(prefix).not.toContain('\u{2B50}');
  });

  it('reserves an empty priority cell when priority is missing', () => {
    const undefinedPriority: WorkItem = { id: 'T1', title: 'T', status: 'open' };
    const nullPriority = { id: 'T2', title: 'T', status: 'open', priority: null } as unknown as WorkItem;

    const undefinedPrefix = getIconPrefix(undefinedPriority);
    const nullPrefix = getIconPrefix(nullPriority);

    // No stray priority glyph or fallback text appears, and both cases align
    // identically (the fixed-width padding absorbs the empty cell).
    expect(undefinedPrefix).not.toMatch(/\u{1F6A8}|\u{2B50}|\u{1F4CB}|\u{1F422}/u);
    expect(nullPrefix).toBe(undefinedPrefix);
  });

  it('places the priority icon before the agent status slot', () => {
    const item: WorkItem = {
      id: 'T1', title: 'T', status: 'open', priority: 'critical', agentState: 'working',
    };
    const prefix = getIconPrefix(item);
    // Priority glyph (🚨) must come before the agent-status glyph (🟢).
    expect(prefix.indexOf('\u{1F6A8}')).toBeLessThan(prefix.indexOf('\u{1F7E2}'));
  });

  it('keeps the prefix width fixed at 13 cells with and without a priority', () => {
    const withPriority: WorkItem = { id: 'T1', title: 'T', status: 'open', priority: 'high' };
    const withoutPriority: WorkItem = { id: 'T2', title: 'T', status: 'open' };

    expect(stringDisplayWidth(getIconPrefix(withPriority))).toBe(13);
    expect(stringDisplayWidth(getIconPrefix(withoutPriority))).toBe(13);
  });

  it('keeps the prefix width aligned across all priority/anchor combinations', () => {
    const items: WorkItem[] = [
      { id: 'T1', title: 'T', status: 'open', priority: 'critical' },
      { id: 'T2', title: 'T', status: 'open', priority: 'high', stage: 'in_review' },
      { id: 'T3', title: 'T', status: 'completed', stage: 'in_review', needsProducerReview: true },
      { id: 'T4', title: 'T', status: 'blocked', issueType: 'epic' as const, priority: 'low' },
      { id: 'T5', title: 'T', status: 'open' },
    ];
    const widths = items.map((item) => stringDisplayWidth(getIconPrefix(item)));
    expect(widths.every((w) => w === 13)).toBe(true);
  });

  it('renders the priority icon in noIcons mode as the fallback text', () => {
    const item: WorkItem = { id: 'T1', title: 'T', status: 'open', priority: 'medium', agentState: 'idle' };
    const withIcons = getIconPrefix(item, { noIcons: false });
    const withoutIcons = getIconPrefix(item, { noIcons: true });

    expect(withIcons).toContain('\u{1F4CB}');
    expect(withoutIcons).not.toContain('\u{1F4CB}');
    // The priority fallback is prepended (before the agent fallback).
    expect(withoutIcons).toContain('[MED ]');
    expect(withoutIcons.indexOf('[MED ]')).toBeLessThan(withoutIcons.indexOf('[IDLE]'));
  });
});
