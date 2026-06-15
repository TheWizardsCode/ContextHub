import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import {
  priorityIcon,
  statusIcon,
  priorityLabel,
  statusLabel,
  priorityFallback,
  statusFallback,
  stageIcon,
  stageLabel,
  stageFallback,
  auditIcon,
  auditLabel,
  auditFallback,
  iconsEnabled,
} from '../../src/icons.js';

describe('priorityIcon', () => {
  it('returns emoji for critical priority', () => {
    expect(priorityIcon('critical')).toBe('\u{1F6A8}'); // 🚨
  });

  it('returns emoji for high priority', () => {
    expect(priorityIcon('high')).toBe('\u{2B50}'); // ⭐
  });

  it('returns emoji for medium priority', () => {
    expect(priorityIcon('medium')).toBe('\u{1F4CB}'); // 📋
  });

  it('returns emoji for low priority', () => {
    expect(priorityIcon('low')).toBe('\u{1F422}'); // 🐢
  });

  it('returns empty string for unknown priority', () => {
    expect(priorityIcon('unknown')).toBe('');
    expect(priorityIcon('')).toBe('');
  });

  it('returns empty string for null/undefined priority', () => {
    expect(priorityIcon(null as any)).toBe('');
    expect(priorityIcon(undefined as any)).toBe('');
  });

  it('is case-insensitive', () => {
    expect(priorityIcon('CRITICAL')).toBe('\u{1F6A8}');
    expect(priorityIcon('High')).toBe('\u{2B50}');
    expect(priorityIcon('MEDIUM')).toBe('\u{1F4CB}');
  });

  describe('with noIcons option', () => {
    it('returns text fallback for critical', () => {
      expect(priorityIcon('critical', { noIcons: true })).toBe('[CRIT]');
    });

    it('returns text fallback for high', () => {
      expect(priorityIcon('high', { noIcons: true })).toBe('[HIGH]');
    });

    it('returns text fallback for medium', () => {
      expect(priorityIcon('medium', { noIcons: true })).toBe('[MED ]');
    });

    it('returns text fallback for low', () => {
      expect(priorityIcon('low', { noIcons: true })).toBe('[LOW ]');
    });

    it('returns empty string for unknown priority with noIcons', () => {
      expect(priorityIcon('unknown', { noIcons: true })).toBe('');
    });
  });
});

describe('statusIcon', () => {
  it('returns emoji for open status', () => {
    expect(statusIcon('open')).toBe('\u{1F513}'); // 🔓
  });

  it('returns emoji for in-progress status', () => {
    expect(statusIcon('in-progress')).toBe('\u{1F504}'); // 🔄
  });

  it('returns emoji for completed status', () => {
    expect(statusIcon('completed')).toBe('\u{2714}\u{FE0F}'); // ✔️
  });

  it('returns emoji for blocked status', () => {
    expect(statusIcon('blocked')).toBe('\u{26D4}'); // ⛔
  });

  it('returns emoji for deleted status', () => {
    expect(statusIcon('deleted')).toBe('\u{1F5D1}\u{FE0F}'); // 🗑️
  });

  it('returns emoji for input_needed status', () => {
    expect(statusIcon('input_needed')).toBe('\u{1F4AC}'); // 💬
  });

  it('returns empty string for unknown status', () => {
    expect(statusIcon('unknown')).toBe('');
    expect(statusIcon('')).toBe('');
  });

  it('returns empty string for null/undefined status', () => {
    expect(statusIcon(null as any)).toBe('');
    expect(statusIcon(undefined as any)).toBe('');
  });

  it('is case-insensitive', () => {
    expect(statusIcon('OPEN')).toBe('\u{1F513}');
    expect(statusIcon('In-Progress')).toBe('\u{1F504}');
    expect(statusIcon('COMPLETED')).toBe('\u{2714}\u{FE0F}');
  });

  describe('with noIcons option', () => {
    it('returns text fallback for open', () => {
      expect(statusIcon('open', { noIcons: true })).toBe('[OPEN]');
    });

    it('returns text fallback for in-progress', () => {
      expect(statusIcon('in-progress', { noIcons: true })).toBe('[INPR]');
    });

    it('returns text fallback for completed', () => {
      expect(statusIcon('completed', { noIcons: true })).toBe('[DONE]');
    });

    it('returns text fallback for blocked', () => {
      expect(statusIcon('blocked', { noIcons: true })).toBe('[BLKD]');
    });

    it('returns text fallback for deleted', () => {
      expect(statusIcon('deleted', { noIcons: true })).toBe('[DEL ]');
    });

    it('returns text fallback for input_needed', () => {
      expect(statusIcon('input_needed', { noIcons: true })).toBe('[HELP]');
    });

    it('returns empty string for unknown status with noIcons', () => {
      expect(statusIcon('unknown', { noIcons: true })).toBe('');
    });
  });
});

describe('priorityLabel', () => {
  it('returns label for critical', () => {
    expect(priorityLabel('critical')).toBe('Critical priority');
  });

  it('returns label for high', () => {
    expect(priorityLabel('high')).toBe('High priority');
  });

  it('returns label for medium', () => {
    expect(priorityLabel('medium')).toBe('Medium priority');
  });

  it('returns label for low', () => {
    expect(priorityLabel('low')).toBe('Low priority');
  });

  it('returns empty string for unknown priority', () => {
    expect(priorityLabel('unknown')).toBe('');
  });

  it('is case-insensitive', () => {
    expect(priorityLabel('CRITICAL')).toBe('Critical priority');
  });
});

describe('statusLabel', () => {
  it('returns label for open', () => {
    expect(statusLabel('open')).toBe('Status: Open');
  });

  it('returns label for in-progress', () => {
    expect(statusLabel('in-progress')).toBe('Status: In progress');
  });

  it('returns label for completed', () => {
    expect(statusLabel('completed')).toBe('Status: Completed');
  });

  it('returns label for blocked', () => {
    expect(statusLabel('blocked')).toBe('Status: Blocked');
  });

  it('returns label for deleted', () => {
    expect(statusLabel('deleted')).toBe('Status: Deleted');
  });

  it('returns label for input_needed', () => {
    expect(statusLabel('input_needed')).toBe('Status: Input needed');
  });

  it('returns empty string for unknown status', () => {
    expect(statusLabel('unknown')).toBe('');
  });
});

describe('priorityFallback', () => {
  it('returns bracketed text for critical', () => {
    expect(priorityFallback('critical')).toBe('[CRIT]');
  });

  it('returns bracketed text for high', () => {
    expect(priorityFallback('high')).toBe('[HIGH]');
  });

  it('returns bracketed text for medium', () => {
    expect(priorityFallback('medium')).toBe('[MED ]');
  });

  it('returns bracketed text for low', () => {
    expect(priorityFallback('low')).toBe('[LOW ]');
  });

  it('returns empty string for unknown priority', () => {
    expect(priorityFallback('unknown')).toBe('');
  });
});

describe('statusFallback', () => {
  it('returns bracketed text for open', () => {
    expect(statusFallback('open')).toBe('[OPEN]');
  });

  it('returns bracketed text for in-progress', () => {
    expect(statusFallback('in-progress')).toBe('[INPR]');
  });

  it('returns bracketed text for completed', () => {
    expect(statusFallback('completed')).toBe('[DONE]');
  });

  it('returns bracketed text for blocked', () => {
    expect(statusFallback('blocked')).toBe('[BLKD]');
  });

  it('returns bracketed text for deleted', () => {
    expect(statusFallback('deleted')).toBe('[DEL ]');
  });

  it('returns bracketed text for input_needed', () => {
    expect(statusFallback('input_needed')).toBe('[HELP]');
  });

  it('returns empty string for unknown status', () => {
    expect(statusFallback('unknown')).toBe('');
  });
});

describe('iconsEnabled', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env for each test
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  it('returns true by default when no option or env set', () => {
    delete process.env.WL_NO_ICONS;
    expect(iconsEnabled()).toBe(true);
  });

  it('returns false when noIcons option is true', () => {
    expect(iconsEnabled({ noIcons: true })).toBe(false);
  });

  it('returns false when WL_NO_ICONS env var is 1', () => {
    process.env.WL_NO_ICONS = '1';
    expect(iconsEnabled()).toBe(false);
  });

  it('returns true when WL_NO_ICONS env var is unset', () => {
    delete process.env.WL_NO_ICONS;
    expect(iconsEnabled()).toBe(true);
  });

  it('noIcons option takes precedence over env var', () => {
    process.env.WL_NO_ICONS = '1';
    expect(iconsEnabled({ noIcons: false })).toBe(true);
  });
});

describe('stageIcon', () => {
  it('returns emoji for idea stage', () => {
    expect(stageIcon('idea')).toBe('\u{1F4A1}'); // 💡
  });

  it('returns emoji for intake_complete stage', () => {
    expect(stageIcon('intake_complete')).toBe('\u{1F4E5}'); // 📥
  });

  it('returns emoji for plan_complete stage', () => {
    expect(stageIcon('plan_complete')).toBe('\u{1F4CB}'); // 📋
  });

  it('returns emoji for in_progress stage', () => {
    expect(stageIcon('in_progress')).toBe('\u{1F6E0}\u{FE0F}'); // 🛠️
  });

  it('returns emoji for in_review stage', () => {
    expect(stageIcon('in_review')).toBe('\u{1F50D}'); // 🔍
  });

  it('returns emoji for done stage', () => {
    expect(stageIcon('done')).toBe('\u{1F3C1}'); // 🏁
  });

  it('returns empty string for unknown stage', () => {
    expect(stageIcon('unknown')).toBe('');
    expect(stageIcon('')).toBe('');
  });

  it('returns empty string for null/undefined stage', () => {
    expect(stageIcon(null as any)).toBe('');
    expect(stageIcon(undefined as any)).toBe('');
  });

  it('is case-insensitive', () => {
    expect(stageIcon('IDEA')).toBe('\u{1F4A1}');
    expect(stageIcon('In_Progress')).toBe('\u{1F6E0}\u{FE0F}');
  });

  describe('with noIcons option', () => {
    it('returns text fallback for idea', () => {
      expect(stageIcon('idea', { noIcons: true })).toBe('[IDEA]');
    });

    it('returns text fallback for intake_complete', () => {
      expect(stageIcon('intake_complete', { noIcons: true })).toBe('[INTAKE]');
    });

    it('returns text fallback for plan_complete', () => {
      expect(stageIcon('plan_complete', { noIcons: true })).toBe('[PLAN]');
    });

    it('returns text fallback for in_progress', () => {
      expect(stageIcon('in_progress', { noIcons: true })).toBe('[PROG]');
    });

    it('returns text fallback for in_review', () => {
      expect(stageIcon('in_review', { noIcons: true })).toBe('[REVIEW]');
    });

    it('returns text fallback for done', () => {
      expect(stageIcon('done', { noIcons: true })).toBe('[DONE]');
    });

    it('returns empty string for unknown stage with noIcons', () => {
      expect(stageIcon('unknown', { noIcons: true })).toBe('');
    });
  });
});

describe('stageFallback', () => {
  it('returns bracketed text for idea', () => {
    expect(stageFallback('idea')).toBe('[IDEA]');
  });

  it('returns bracketed text for intake_complete', () => {
    expect(stageFallback('intake_complete')).toBe('[INTAKE]');
  });

  it('returns bracketed text for plan_complete', () => {
    expect(stageFallback('plan_complete')).toBe('[PLAN]');
  });

  it('returns bracketed text for in_progress', () => {
    expect(stageFallback('in_progress')).toBe('[PROG]');
  });

  it('returns bracketed text for in_review', () => {
    expect(stageFallback('in_review')).toBe('[REVIEW]');
  });

  it('returns bracketed text for done', () => {
    expect(stageFallback('done')).toBe('[DONE]');
  });

  it('returns empty string for unknown stage', () => {
    expect(stageFallback('unknown')).toBe('');
  });
});

describe('stageLabel', () => {
  it('returns label for idea', () => {
    expect(stageLabel('idea')).toBe('Stage: Idea');
  });

  it('returns label for intake_complete', () => {
    expect(stageLabel('intake_complete')).toBe('Stage: Intake Complete');
  });

  it('returns label for plan_complete', () => {
    expect(stageLabel('plan_complete')).toBe('Stage: Plan Complete');
  });

  it('returns label for in_progress', () => {
    expect(stageLabel('in_progress')).toBe('Stage: In Progress');
  });

  it('returns label for in_review', () => {
    expect(stageLabel('in_review')).toBe('Stage: In Review');
  });

  it('returns label for done', () => {
    expect(stageLabel('done')).toBe('Stage: Done');
  });

  it('returns empty string for unknown stage', () => {
    expect(stageLabel('unknown')).toBe('');
  });

  it('is case-insensitive', () => {
    expect(stageLabel('IDEA')).toBe('Stage: Idea');
  });
});

describe('auditIcon', () => {
  it('returns emoji for yes (true)', () => {
    expect(auditIcon(true)).toBe('\u{2705}'); // ✅
  });

  it('returns emoji for no (false)', () => {
    expect(auditIcon(false)).toBe('\u{274C}'); // ❌
  });

  it('returns emoji for unknown (null)', () => {
    expect(auditIcon(null)).toBe('\u{2753}'); // ❓
  });

  it('returns emoji for unknown (undefined)', () => {
    expect(auditIcon(undefined)).toBe('\u{2753}'); // ❓
  });

  describe('with noIcons option', () => {
    it('returns text fallback for yes', () => {
      expect(auditIcon(true, { noIcons: true })).toBe('[YES]');
    });

    it('returns text fallback for no', () => {
      expect(auditIcon(false, { noIcons: true })).toBe('[NO]');
    });

    it('returns text fallback for unknown (null)', () => {
      expect(auditIcon(null, { noIcons: true })).toBe('[UNKN]');
    });

    it('returns text fallback for unknown (undefined)', () => {
      expect(auditIcon(undefined, { noIcons: true })).toBe('[UNKN]');
    });
  });
});

describe('auditFallback', () => {
  it('returns bracketed text for yes', () => {
    expect(auditFallback(true)).toBe('[YES]');
  });

  it('returns bracketed text for no', () => {
    expect(auditFallback(false)).toBe('[NO]');
  });

  it('returns bracketed text for unknown (null)', () => {
    expect(auditFallback(null)).toBe('[UNKN]');
  });

  it('returns bracketed text for unknown (undefined)', () => {
    expect(auditFallback(undefined)).toBe('[UNKN]');
  });
});

describe('auditLabel', () => {
  it('returns label for yes', () => {
    expect(auditLabel(true)).toBe('Audit: Passed');
  });

  it('returns label for no', () => {
    expect(auditLabel(false)).toBe('Audit: Failed');
  });

  it('returns label for unknown (null)', () => {
    expect(auditLabel(null)).toBe('Audit: Not run');
  });

  it('returns label for unknown (undefined)', () => {
    expect(auditLabel(undefined)).toBe('Audit: Not run');
  });
});
