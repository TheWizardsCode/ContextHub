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

  it('returns same display width in icon and noIcons mode', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open', priority: 'high' };
    const withIcons = getIconPrefix(item, { noIcons: false });
    const withoutIcons = getIconPrefix(item, { noIcons: true });
    expect(stringDisplayWidth(withIcons)).toBe(stringDisplayWidth(withoutIcons));
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
});
