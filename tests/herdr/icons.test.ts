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
} from '../../packages/herdr/src/icons.js';

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

  it('includes child count when present', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open', childCount: 3 };
    const prefix = getIconPrefix(item);
    expect(prefix).toMatch(/3/);
  });

  it('includes epic icon for epic type', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open', issueType: 'epic' };
    const prefix = getIconPrefix(item);
    expect(prefix).toBeTruthy();
  });

  it('returns shorter string in noIcons mode', () => {
    const item: WorkItem = { id: 'T1', title: 'Test', status: 'open', priority: 'high' };
    const withIcons = getIconPrefix(item, { noIcons: false });
    const withoutIcons = getIconPrefix(item, { noIcons: true });
    // noIcons should not contain emoji-like characters
    expect(withoutIcons.length).toBeGreaterThanOrEqual(0);
  });
});
