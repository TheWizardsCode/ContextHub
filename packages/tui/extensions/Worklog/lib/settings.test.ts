/**
 * Unit tests for lib/settings.ts — configuration management and settings
 * overlay for the Worklog extension.
 *
 * Run: npx vitest run packages/tui/extensions/lib/settings.test.ts
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
  getSettingsListTheme: () => ({}),
}));

describe('lib/settings exports', () => {
  it('should export settings state and helpers', async () => {
    const mod = await import('./settings.js');
    // State
    expect(mod.currentSettings).toBeDefined();
    expect(typeof mod.STAGE_MAP).toBe('object');
    expect(mod.VALID_STAGES).toBeDefined();
    expect(mod.VALID_STAGES instanceof Set).toBe(true);

    // Functions
    expect(typeof mod.updateSettings).toBe('function');
    expect(typeof mod.openSettingsOverlay).toBe('function');
  });
});

describe('STAGE_MAP', () => {
  it('should map shorthand stages to canonical names', async () => {
    const { STAGE_MAP } = await import('./settings.js');
    expect(STAGE_MAP.intake).toBe('intake_complete');
    expect(STAGE_MAP.plan).toBe('plan_complete');
    expect(STAGE_MAP.progress).toBe('in_progress');
    expect(STAGE_MAP.review).toBe('in_review');
  });

  it('should map canonical names to themselves', async () => {
    const { STAGE_MAP } = await import('./settings.js');
    expect(STAGE_MAP.idea).toBe('idea');
    expect(STAGE_MAP.intake_complete).toBe('intake_complete');
    expect(STAGE_MAP.plan_complete).toBe('plan_complete');
    expect(STAGE_MAP.in_progress).toBe('in_progress');
    expect(STAGE_MAP.in_review).toBe('in_review');
  });
});

describe('VALID_STAGES', () => {
  it('should contain all stage keys', async () => {
    const { VALID_STAGES, STAGE_MAP } = await import('./settings.js');
    const keys = Object.keys(STAGE_MAP);
    for (const key of keys) {
      expect(VALID_STAGES.has(key)).toBe(true);
    }
  });
});

describe('updateSettings', () => {
  it('should update partial settings and return merged result', async () => {
    const { updateSettings } = await import('./settings.js');
    const result = updateSettings({ browseItemCount: 15 });
    expect(result.browseItemCount).toBe(15);
  });
});
