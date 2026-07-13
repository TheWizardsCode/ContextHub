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
  epicIcon,
  epicLabel,
  epicFallback,
  riskIcon,
  riskFallback,
  riskLabel,
  effortIcon,
  effortFallback,
  effortLabel,
  iconsEnabled,
  needsProducerReviewIcon,
  needsProducerReviewLabel,
  needsProducerReviewFallback,
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
    expect(auditIcon(null)).toBe('\u{2754}'); // ❔
  });

  it('returns emoji for unknown (undefined)', () => {
    expect(auditIcon(undefined)).toBe('\u{2754}'); // ❔
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

// ─── Producer Review Icons ───────────────────────────────────────────────

describe('needsProducerReviewIcon', () => {
  it('returns ❌ for true (needs review)', () => {
    expect(needsProducerReviewIcon(true)).toBe('\u{274C}'); // ❌
  });

  it('returns ✅ for false (review complete)', () => {
    expect(needsProducerReviewIcon(false)).toBe('\u{2705}'); // ✅
  });

  it('returns ✅ for null (defaults to not needed)', () => {
    expect(needsProducerReviewIcon(null)).toBe('\u{2705}'); // ✅
  });

  it('returns ✅ for undefined (defaults to not needed)', () => {
    expect(needsProducerReviewIcon(undefined)).toBe('\u{2705}'); // ✅
  });

  describe('with noIcons option', () => {
    it('returns text fallback for true', () => {
      expect(needsProducerReviewIcon(true, { noIcons: true })).toBe('[NEEDS_PRODUCER]');
    });

    it('returns text fallback for false', () => {
      expect(needsProducerReviewIcon(false, { noIcons: true })).toBe('[PRODUCER_OK]');
    });

    it('returns text fallback for null', () => {
      expect(needsProducerReviewIcon(null, { noIcons: true })).toBe('[PRODUCER_OK]');
    });

    it('returns text fallback for undefined', () => {
      expect(needsProducerReviewIcon(undefined, { noIcons: true })).toBe('[PRODUCER_OK]');
    });
  });
});

describe('needsProducerReviewFallback', () => {
  it('returns bracketed text for true', () => {
    expect(needsProducerReviewFallback(true)).toBe('[NEEDS_PRODUCER]');
  });

  it('returns bracketed text for false', () => {
    expect(needsProducerReviewFallback(false)).toBe('[PRODUCER_OK]');
  });

  it('returns bracketed text for null', () => {
    expect(needsProducerReviewFallback(null)).toBe('[PRODUCER_OK]');
  });

  it('returns bracketed text for undefined', () => {
    expect(needsProducerReviewFallback(undefined)).toBe('[PRODUCER_OK]');
  });
});

describe('needsProducerReviewLabel', () => {
  it('returns label for true', () => {
    expect(needsProducerReviewLabel(true)).toBe('Needs producer review');
  });

  it('returns label for false', () => {
    expect(needsProducerReviewLabel(false)).toBe('Producer review complete');
  });

  it('returns label for null', () => {
    expect(needsProducerReviewLabel(null)).toBe('Producer review complete');
  });

  it('returns label for undefined', () => {
    expect(needsProducerReviewLabel(undefined)).toBe('Producer review complete');
  });
});

describe('epicIcon', () => {
  it('returns castle emoji for epic', () => {
    expect(epicIcon()).toBe('\u{1F3F0}'); // 🏰
  });

  describe('with noIcons option', () => {
    it('returns text fallback for epic', () => {
      expect(epicIcon({ noIcons: true })).toBe('[EPIC]');
    });
  });
});

describe('epicLabel', () => {
  it('returns label for epic', () => {
    expect(epicLabel()).toBe('Issue Type: Epic');
  });
});

describe('epicFallback', () => {
  it('returns bracketed text for epic', () => {
    expect(epicFallback()).toBe('[EPIC]');
  });
});

// ─── Risk Icons ──────────────────────────────────────────────────────────

describe('riskIcon', () => {
  it('returns emoji for Low risk', () => {
    expect(riskIcon('Low')).toBe('\u{1F331}'); // 🌱
  });

  it('returns emoji for Medium risk', () => {
    expect(riskIcon('Medium')).toBe('\u{26A0}\u{FE0F}'); // ⚠️
  });

  it('returns emoji for High risk', () => {
    expect(riskIcon('High')).toBe('\u{1F525}'); // 🔥
  });

  it('returns emoji for Severe risk', () => {
    expect(riskIcon('Severe')).toBe('\u{1F6A8}'); // 🚨
  });

  it('returns empty string for unknown risk', () => {
    expect(riskIcon('unknown')).toBe('');
    expect(riskIcon('')).toBe('');
  });

  it('returns empty string for null/undefined risk', () => {
    expect(riskIcon(null as any)).toBe('');
    expect(riskIcon(undefined as any)).toBe('');
  });

  it('is case-insensitive', () => {
    expect(riskIcon('low')).toBe('\u{1F331}');
    expect(riskIcon('MEDIUM')).toBe('\u{26A0}\u{FE0F}');
  });

  describe('with noIcons option', () => {
    it('returns text fallback for Low', () => {
      expect(riskIcon('Low', { noIcons: true })).toBe('[LOW]');
    });

    it('returns text fallback for Medium', () => {
      expect(riskIcon('Medium', { noIcons: true })).toBe('[MED]');
    });

    it('returns text fallback for High', () => {
      expect(riskIcon('High', { noIcons: true })).toBe('[HIGH]');
    });

    it('returns text fallback for Severe', () => {
      expect(riskIcon('Severe', { noIcons: true })).toBe('[SEV]');
    });

    it('returns empty string for unknown risk with noIcons', () => {
      expect(riskIcon('unknown', { noIcons: true })).toBe('');
    });
  });
});

describe('riskFallback', () => {
  it('returns bracketed text for Low', () => {
    expect(riskFallback('Low')).toBe('[LOW]');
  });

  it('returns bracketed text for Medium', () => {
    expect(riskFallback('Medium')).toBe('[MED]');
  });

  it('returns bracketed text for High', () => {
    expect(riskFallback('High')).toBe('[HIGH]');
  });

  it('returns bracketed text for Severe', () => {
    expect(riskFallback('Severe')).toBe('[SEV]');
  });

  it('returns empty string for unknown risk', () => {
    expect(riskFallback('unknown')).toBe('');
  });
});

describe('riskLabel', () => {
  it('returns label for Low', () => {
    expect(riskLabel('Low')).toBe('Risk: Low');
  });

  it('returns label for Medium', () => {
    expect(riskLabel('Medium')).toBe('Risk: Medium');
  });

  it('returns label for High', () => {
    expect(riskLabel('High')).toBe('Risk: High');
  });

  it('returns label for Severe', () => {
    expect(riskLabel('Severe')).toBe('Risk: Severe');
  });

  it('returns empty string for unknown risk', () => {
    expect(riskLabel('unknown')).toBe('');
  });

  it('is case-insensitive', () => {
    expect(riskLabel('LOW')).toBe('Risk: Low');
  });
});

// ─── Effort Icons ────────────────────────────────────────────────────────

describe('effortIcon', () => {
  it('returns emoji for XS effort', () => {
    expect(effortIcon('XS')).toBe('\u{1F41C}'); // 🐜
  });

  it('returns emoji for S effort', () => {
    expect(effortIcon('S')).toBe('\u{1F407}'); // 🐇
  });

  it('returns emoji for M effort', () => {
    expect(effortIcon('M')).toBe('\u{1F415}'); // 🐕
  });

  it('returns emoji for L effort', () => {
    expect(effortIcon('L')).toBe('\u{1F418}'); // 🐘
  });

  it('returns emoji for XL effort', () => {
    expect(effortIcon('XL')).toBe('\u{1F40B}'); // 🐋
  });

  it('returns empty string for unknown effort', () => {
    expect(effortIcon('unknown')).toBe('');
    expect(effortIcon('')).toBe('');
  });

  it('returns empty string for null/undefined effort', () => {
    expect(effortIcon(null as any)).toBe('');
    expect(effortIcon(undefined as any)).toBe('');
  });

  it('is case-insensitive', () => {
    expect(effortIcon('xs')).toBe('\u{1F41C}');
    expect(effortIcon('s')).toBe('\u{1F407}');
    expect(effortIcon('m')).toBe('\u{1F415}');
    expect(effortIcon('l')).toBe('\u{1F418}');
    expect(effortIcon('xl')).toBe('\u{1F40B}');
  });

  describe('with noIcons option', () => {
    it('returns text fallback for XS', () => {
      expect(effortIcon('XS', { noIcons: true })).toBe('[XS]');
    });

    it('returns text fallback for S', () => {
      expect(effortIcon('S', { noIcons: true })).toBe('[S]');
    });

    it('returns text fallback for M', () => {
      expect(effortIcon('M', { noIcons: true })).toBe('[M]');
    });

    it('returns text fallback for L', () => {
      expect(effortIcon('L', { noIcons: true })).toBe('[L]');
    });

    it('returns text fallback for XL', () => {
      expect(effortIcon('XL', { noIcons: true })).toBe('[XL]');
    });

    it('returns empty string for unknown effort with noIcons', () => {
      expect(effortIcon('unknown', { noIcons: true })).toBe('');
    });
  });
});

describe('effortFallback', () => {
  it('returns bracketed text for XS', () => {
    expect(effortFallback('XS')).toBe('[XS]');
  });

  it('returns bracketed text for S', () => {
    expect(effortFallback('S')).toBe('[S]');
  });

  it('returns bracketed text for M', () => {
    expect(effortFallback('M')).toBe('[M]');
  });

  it('returns bracketed text for L', () => {
    expect(effortFallback('L')).toBe('[L]');
  });

  it('returns bracketed text for XL', () => {
    expect(effortFallback('XL')).toBe('[XL]');
  });

  it('returns empty string for unknown effort', () => {
    expect(effortFallback('unknown')).toBe('');
  });
});

describe('effortLabel', () => {
  it('returns label for XS', () => {
    expect(effortLabel('XS')).toBe('Effort: XS (extra small)');
  });

  it('returns label for S', () => {
    expect(effortLabel('S')).toBe('Effort: S (small)');
  });

  it('returns label for M', () => {
    expect(effortLabel('M')).toBe('Effort: M (medium)');
  });

  it('returns label for L', () => {
    expect(effortLabel('L')).toBe('Effort: L (large)');
  });

  it('returns label for XL', () => {
    expect(effortLabel('XL')).toBe('Effort: XL (extra large)');
  });

  it('returns empty string for unknown effort', () => {
    expect(effortLabel('unknown')).toBe('');
  });

  it('is case-insensitive', () => {
    expect(effortLabel('xs')).toBe('Effort: XS (extra small)');
  });

  // ─── Full-text effort values ────────────────────────────────────────

  describe('full-text effort values', () => {
    it('effortIcon returns correct emoji for "Small"', () => {
      expect(effortIcon('Small')).toBe('\u{1F407}'); // 🐇
    });

    it('effortIcon returns correct emoji for "Medium"', () => {
      expect(effortIcon('Medium')).toBe('\u{1F415}'); // 🐕
    });

    it('effortIcon returns correct emoji for "Large"', () => {
      expect(effortIcon('Large')).toBe('\u{1F418}'); // 🐘
    });

    it('effortIcon returns correct emoji for "Extra Small"', () => {
      expect(effortIcon('Extra Small')).toBe('\u{1F41C}'); // 🐜
    });

    it('effortIcon returns correct emoji for "Extra Large"', () => {
      expect(effortIcon('Extra Large')).toBe('\u{1F40B}'); // 🐋
    });

    it('effortIcon returns correct emoji for "XLarge" (variant)', () => {
      expect(effortIcon('XLarge')).toBe('\u{1F40B}'); // 🐋
    });

    it('effortFallback returns bracketed text for "Small"', () => {
      expect(effortFallback('Small')).toBe('[S]');
    });

    it('effortFallback returns bracketed text for "Medium"', () => {
      expect(effortFallback('Medium')).toBe('[M]');
    });

    it('effortFallback returns bracketed text for "Large"', () => {
      expect(effortFallback('Large')).toBe('[L]');
    });

    it('effortFallback returns bracketed text for "Extra Small"', () => {
      expect(effortFallback('Extra Small')).toBe('[XS]');
    });

    it('effortFallback returns bracketed text for "Extra Large"', () => {
      expect(effortFallback('Extra Large')).toBe('[XL]');
    });

    it('effortFallback returns bracketed text for "XLarge" (variant)', () => {
      expect(effortFallback('XLarge')).toBe('[XL]');
    });

    it('effortLabel returns label for "Small"', () => {
      expect(effortLabel('Small')).toBe('Effort: S (small)');
    });

    it('effortLabel returns label for "Medium"', () => {
      expect(effortLabel('Medium')).toBe('Effort: M (medium)');
    });

    it('effortLabel returns label for "Large"', () => {
      expect(effortLabel('Large')).toBe('Effort: L (large)');
    });

    it('effortLabel returns label for "Extra Small"', () => {
      expect(effortLabel('Extra Small')).toBe('Effort: XS (extra small)');
    });

    it('effortLabel returns label for "Extra Large"', () => {
      expect(effortLabel('Extra Large')).toBe('Effort: XL (extra large)');
    });

    it('effortLabel returns label for "XLarge" (variant)', () => {
      expect(effortLabel('XLarge')).toBe('Effort: XL (extra large)');
    });

    it('full-text values are case-insensitive', () => {
      expect(effortIcon('small')).toBe('\u{1F407}');
      expect(effortIcon('EXTRA SMALL')).toBe('\u{1F41C}');
      expect(effortIcon('Extra Large')).toBe('\u{1F40B}');
    });

    it('existing abbreviated values still work after adding full-text aliases', () => {
      expect(effortIcon('XS')).toBe('\u{1F41C}');
      expect(effortIcon('S')).toBe('\u{1F407}');
      expect(effortIcon('M')).toBe('\u{1F415}');
      expect(effortIcon('L')).toBe('\u{1F418}');
      expect(effortIcon('XL')).toBe('\u{1F40B}');
    });
  });
});
