/**
 * Regression test for WL-0MQMFMACS0059UUC: Extension loads but cannot find icons.js.
 *
 * The Worklog Pi extension at ~/.pi/agent/extensions/worklog is a symlink to
 * packages/tui/extensions/. When Pi loads packages/tui/extensions/index.ts,
 * the import `../../../src/icons.js` resolves to <project>/src/icons.js which
 * does NOT exist (only src/icons.ts exists). The fix changes the import to
 * point to the compiled output at `../../../dist/icons.js`.
 *
 * This test verifies that the extension module can be loaded and that icon
 * functions (used internally via the import chain) work correctly.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/home/test-user/.pi/agent',
}));

import { getIconPrefix, createWorklogBrowseExtension, STAGE_MAP } from '../extensions/Worklog/index.js';

describe('extension module loads with valid icons import (regression: WL-0MQMFMACS0059UUC)', () => {
  it('extension module exports expected symbols', () => {
    // If the icons import in index.ts fails, the entire module won't load.
    // These exports verify the module loaded successfully.
    expect(STAGE_MAP).toBeDefined();
    expect(typeof STAGE_MAP).toBe('object');
    expect(STAGE_MAP.idea).toBe('idea');
    expect(typeof createWorklogBrowseExtension).toBe('function');
    expect(typeof getIconPrefix).toBe('function');
  });

  it('getIconPrefix uses icon functions without errors', () => {
    // getIconPrefix internally calls priorityIcon, statusIcon, stageIcon,
    // auditIcon, epicIcon, iconsEnabled, riskIcon, effortIcon — all imported
    // via the icons.js path. If the import resolves incorrectly, this will fail.
    const mockItem = {
      id: 'TEST-001',
      title: 'Test item',
      status: 'open',
      stage: 'idea',
      priority: 'high',
    };
    const result = getIconPrefix(mockItem as any, false);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    // Should contain icons (emoji) or text fallbacks
    expect(result.length).toBeGreaterThan(0);
  });
});
