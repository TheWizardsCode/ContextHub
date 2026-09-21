/**
 * Automation-authored work-item detection.
 *
 * Bot telemetry children — the test skill's `check_or_create.py` test-failure
 * items and triage-bot items — report on a parent's existing code rather than
 * introducing new planned scope. They are attached as children so the failure
 * remains discoverable, but they must not rewind a completed/in_review parent's
 * lifecycle (WL-0MTWU4XUD0001ALR, parent epic WL-0MTWU13SU008VLW9).
 *
 * Detection is intentionally conservative and based on markers the automation
 * actually writes today:
 *   - the `test-failure` tag (written by `check_or_create.py`), and
 *   - the `[test-failure]` title prefix used by triage tooling, and
 *   - a small allow-list of automation `createdBy` identities.
 *
 * Human-authored children (including a genuinely missed subtask that happens
 * to touch tests) are NOT matched by the tag/prefix/identity rules, so the
 * original demotion intent (WL-0MSJL00P5004Y0L6) is preserved.
 */

import type { WorkItem } from './types.js';

/** Tag applied by the triage helper (`check_or_create.py`) to test failures. */
export const AUTOMATION_TEST_FAILURE_TAG = 'test-failure';

/** Title prefix convention used by triage tooling for test failures. */
export const AUTOMATION_TEST_FAILURE_TITLE_PREFIX = '[test-failure]';

/**
 * `createdBy` identities recognised as automation (case-insensitive).
 *
 * Kept as an explicit allow-list rather than a heuristic so a human whose
 * name merely contains "bot" is never treated as automation.
 */
export const AUTOMATION_IDENTITIES: ReadonlySet<string> = new Set([
  'triage',
  'triage-bot',
  'test',
  'test-bot',
  'test-failure',
  'ci',
  'github-actions',
  'dependabot',
  'herdr',
  'herdr-downtime',
  'downtime',
  'automation',
  'bot',
]);

/** Minimal shape needed for automation detection. */
export type AutomationActorFields = Pick<WorkItem, 'title' | 'tags' | 'createdBy'>;

/**
 * Whether a work item was authored by automation (a bot/telemetry producer).
 *
 * @param item - the candidate child (only title/tags/createdBy are consulted)
 * @returns `true` when the item carries an automation marker
 */
export function isAutomationAuthoredChild(item: AutomationActorFields): boolean {
  const createdBy = (item.createdBy ?? '').trim().toLowerCase();
  if (createdBy && AUTOMATION_IDENTITIES.has(createdBy)) {
    return true;
  }

  const tags = item.tags ?? [];
  if (tags.some((tag) => String(tag).trim().toLowerCase() === AUTOMATION_TEST_FAILURE_TAG)) {
    return true;
  }

  const title = (item.title ?? '').trimStart().toLowerCase();
  return title.startsWith(AUTOMATION_TEST_FAILURE_TITLE_PREFIX);
}
