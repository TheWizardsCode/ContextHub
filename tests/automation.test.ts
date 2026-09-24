/**
 * Tests for automation-authored work-item detection.
 *
 * Bot telemetry children (e.g. `[test-failure]` items created by the test
 * skill's `check_or_create.py`, or triage-bot items) must be identifiable so
 * that attaching one to a completed/in_review parent does not rewind the
 * parent's lifecycle (WL-0MTWU4XUD0001ALR).
 *
 * Work item: WL-0MTWU4XUD0001ALR (parent WL-0MTWU13SU008VLW9).
 */

import { describe, it, expect } from 'vitest';
import {
  isAutomationAuthoredChild,
  AUTOMATION_TEST_FAILURE_TAG,
} from '../src/automation.js';

function makeItem(overrides: Partial<{ title: string; tags: string[]; createdBy: string }> = {}) {
  return {
    title: overrides.title ?? 'Ordinary task',
    tags: overrides.tags ?? [],
    createdBy: overrides.createdBy ?? '',
  };
}

describe('isAutomationAuthoredChild', () => {
  it('detects items tagged test-failure (the triage/test-skill marker)', () => {
    expect(isAutomationAuthoredChild(makeItem({ tags: ['test-failure'] }))).toBe(true);
    expect(isAutomationAuthoredChild(makeItem({ tags: ['regression', 'test-failure'] }))).toBe(true);
    // Case/whitespace insensitive
    expect(isAutomationAuthoredChild(makeItem({ tags: [' TEST-FAILURE '] }))).toBe(true);
  });

  it('detects [test-failure]-prefixed titles even without the tag', () => {
    expect(isAutomationAuthoredChild(makeItem({ title: '[test-failure] suite exited 1' }))).toBe(true);
    expect(isAutomationAuthoredChild(makeItem({ title: '  [TEST-FAILURE] suite exited 1' }))).toBe(true);
  });

  it('detects known automation identities in createdBy', () => {
    expect(isAutomationAuthoredChild(makeItem({ createdBy: 'triage-bot' }))).toBe(true);
    expect(isAutomationAuthoredChild(makeItem({ createdBy: 'test' }))).toBe(true);
    expect(isAutomationAuthoredChild(makeItem({ createdBy: 'herdr-downtime' }))).toBe(true);
    expect(isAutomationAuthoredChild(makeItem({ createdBy: 'TRIAGE-BOT' }))).toBe(true);
  });

  it('treats ordinary human-authored items as non-automation', () => {
    expect(isAutomationAuthoredChild(makeItem())).toBe(false);
    expect(isAutomationAuthoredChild(makeItem({ title: 'Failing login flow', tags: ['bug'] }))).toBe(false);
    expect(isAutomationAuthoredChild(makeItem({ createdBy: 'rgardler' }))).toBe(false);
    // A tag/title that merely mentions tests is not automation telemetry
    expect(isAutomationAuthoredChild(makeItem({ title: 'test the parser', tags: ['tests'] }))).toBe(false);
  });

  it('matches the canonical tag constant used by the triage helper', () => {
    expect(AUTOMATION_TEST_FAILURE_TAG).toBe('test-failure');
  });
});
