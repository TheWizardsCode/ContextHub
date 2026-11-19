/**
 * Unit tests for the `startOn` claim guard and its audited override
 * (WL-0MWMGEUT10056MUI, parent WL-0MWM0FDZK007BAD0; parent AC5, AC7).
 *
 * The guard reads a comparison instant, so every assertion here is driven by
 * the shared **frozen clock** — nothing depends on the wall clock. The CLI
 * integration half of the contract (JSON refusal shape, non-zero exit, the
 * comment surviving export/import) is covered in
 * `tests/cli/claim-start-on.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { createFrozenClock } from '../helpers/frozen-clock.js';
import {
  START_ON_NOT_REACHED_REASON,
  FORCE_START_ON_FLAG,
  isClaimAttempt,
  evaluateClaimStartOn,
  formatDurationUntil,
  buildStartOnOverrideComment,
} from '../../src/claim-start-on.js';

/** Frozen "now" for every assertion in this file. */
const clock = createFrozenClock('2026-11-19T09:00:00.000Z');

/** The instant a scheduled item becomes claimable (+2 h from the frozen now). */
const START_ON = clock.isoAt(2 * 3_600_000);

/** An explicit future scheduled item (created in the past). */
const FUTURE_ITEM = { id: 'TEST-FUTURE', createdAt: clock.isoAt(-86_400_000), startOn: START_ON };

describe('isClaimAttempt', () => {
  it('treats an in-progress status flip as a claim', () => {
    expect(isClaimAttempt({ status: 'in-progress' })).toBe(true);
    expect(isClaimAttempt({ status: 'in_progress' })).toBe(true);
    expect(isClaimAttempt({ status: 'IN-PROGRESS' })).toBe(true);
  });

  it('treats a non-empty assignee (status-neutral claim) as a claim', () => {
    expect(isClaimAttempt({ assignee: 'Map' })).toBe(true);
    expect(isClaimAttempt({ assignee: 'audit-tier' })).toBe(true);
  });

  it('does not treat a release, a non-claim status or an empty update as a claim', () => {
    expect(isClaimAttempt({ assignee: '' })).toBe(false);
    expect(isClaimAttempt({ assignee: '   ' })).toBe(false);
    expect(isClaimAttempt({ status: 'open' })).toBe(false);
    expect(isClaimAttempt({ status: 'completed' })).toBe(false);
    expect(isClaimAttempt({ status: 'blocked', assignee: '' })).toBe(false);
    expect(isClaimAttempt({})).toBe(false);
  });
});

describe('evaluateClaimStartOn — refusal', () => {
  it('refuses an in-progress claim before the instant is reached', () => {
    const result = evaluateClaimStartOn({
      item: FUTURE_ITEM,
      intent: { status: 'in-progress', assignee: 'implement' },
      now: clock.now(),
    });

    expect(result.refused).toBe(true);
    expect(result.reason).toBe(START_ON_NOT_REACHED_REASON);
    expect(result.startOn).toBe(START_ON);
    expect(result.msUntilStart).toBe(2 * 3_600_000);
  });

  it('names the effective startOn and how long until it is reached in the message', () => {
    const result = evaluateClaimStartOn({
      item: FUTURE_ITEM,
      intent: { status: 'in-progress' },
      now: clock.now(),
    });

    expect(result.message).toContain(START_ON);
    expect(result.message).toContain('2 hours');
    expect(result.message).toContain(FORCE_START_ON_FLAG);
    expect(result.message).toContain('TEST-FUTURE');
  });

  it('refuses a status-neutral assignee-only claim (Herdr audit tier shape)', () => {
    const result = evaluateClaimStartOn({
      item: FUTURE_ITEM,
      intent: { assignee: 'audit-tier' },
      now: clock.now(),
    });

    expect(result.refused).toBe(true);
    expect(result.reason).toBe(START_ON_NOT_REACHED_REASON);
  });

  it('rounds a long wait into the two most significant units', () => {
    const farFuture = {
      createdAt: clock.isoAt(-86_400_000),
      // 2 days, 3 hours and 30 minutes ahead.
      startOn: clock.isoAt(((2 * 24 + 3) * 60 + 30) * 60_000),
    };
    const result = evaluateClaimStartOn({
      item: farFuture,
      intent: { status: 'in-progress' },
      now: clock.now(),
    });
    expect(result.message).toContain('2 days 3 hours');
  });
});

describe('evaluateClaimStartOn — allowed', () => {
  it('allows the claim once the frozen clock reaches the instant (inclusive boundary)', () => {
    const result = evaluateClaimStartOn({
      item: FUTURE_ITEM,
      intent: { status: 'in-progress' },
      now: clock.now() + 2 * 3_600_000,
    });
    expect(result.refused).toBe(false);
  });

  it('allows the claim after the instant has passed', () => {
    const result = evaluateClaimStartOn({
      item: FUTURE_ITEM,
      intent: { status: 'in-progress' },
      now: clock.now() + 3 * 3_600_000,
    });
    expect(result.refused).toBe(false);
  });

  it('never refuses a createdAt-defaulted item (startOn === createdAt)', () => {
    const defaulted = {
      id: 'TEST-DEFAULTED',
      createdAt: clock.isoAt(-60_000),
      startOn: clock.isoAt(-60_000),
    };
    const result = evaluateClaimStartOn({
      item: defaulted,
      intent: { status: 'in-progress', assignee: 'implement' },
      now: clock.now(),
    });
    expect(result.refused).toBe(false);
  });

  it('never refuses a createdAt-defaulted item even when its createdAt is in the future', () => {
    const futureCreated = {
      createdAt: clock.isoAt(3_600_000),
      startOn: clock.isoAt(3_600_000),
    };
    const result = evaluateClaimStartOn({
      item: futureCreated,
      intent: { status: 'in-progress' },
      now: clock.now(),
    });
    expect(result.refused).toBe(false);
  });

  it('never refuses when the item has an absent startOn', () => {
    const result = evaluateClaimStartOn({
      item: { createdAt: clock.isoAt(-60_000) },
      intent: { status: 'in-progress' },
      now: clock.now(),
    });
    expect(result.refused).toBe(false);
  });

  it('never refuses a non-claim update on a future item', () => {
    const result = evaluateClaimStartOn({
      item: FUTURE_ITEM,
      intent: { status: 'open', assignee: '' },
      now: clock.now(),
    });
    expect(result.refused).toBe(false);
  });

  it('fails open on an unreadable startOn (never hides an item)', () => {
    const result = evaluateClaimStartOn({
      item: { createdAt: clock.isoAt(-60_000), startOn: 'not-an-instant' },
      intent: { status: 'in-progress' },
      now: clock.now(),
    });
    expect(result.refused).toBe(false);
  });
});

describe('evaluateClaimStartOn — audited override', () => {
  it('proceeds when a reason is supplied and reports the override + instant', () => {
    const result = evaluateClaimStartOn({
      item: FUTURE_ITEM,
      intent: { status: 'in-progress', assignee: 'implement' },
      overrideReason: '  measure now to catch the window  ',
      now: clock.now(),
    });

    expect(result.refused).toBe(false);
    expect(result.overridden).toBe(true);
    expect(result.overrideReason).toBe('measure now to catch the window');
    expect(result.startOn).toBe(START_ON);
  });

  it('does not mark an override on an already-started item (no spurious audit)', () => {
    const result = evaluateClaimStartOn({
      item: FUTURE_ITEM,
      intent: { status: 'in-progress' },
      overrideReason: 'not needed',
      now: clock.now() + 2 * 3_600_000,
    });
    expect(result.refused).toBe(false);
    expect(result.overridden).toBeFalsy();
  });

  it('treats a blank reason as no override', () => {
    const result = evaluateClaimStartOn({
      item: FUTURE_ITEM,
      intent: { status: 'in-progress' },
      overrideReason: '   ',
      now: clock.now(),
    });
    expect(result.refused).toBe(true);
    expect(result.reason).toBe(START_ON_NOT_REACHED_REASON);
  });
});

describe('formatDurationUntil', () => {
  it('never reports less than one second', () => {
    expect(formatDurationUntil(0)).toBe('1 second');
    expect(formatDurationUntil(-500)).toBe('1 second');
  });

  it('formats seconds, minutes, hours and days', () => {
    expect(formatDurationUntil(5_000)).toBe('5 seconds');
    expect(formatDurationUntil(65_000)).toBe('1 minute 5 seconds');
    expect(formatDurationUntil(3_600_000)).toBe('1 hour');
    expect(formatDurationUntil((25 * 3_600 + 60) * 1_000)).toBe('1 day 1 hour');
  });
});

describe('buildStartOnOverrideComment', () => {
  it('names the actor, the reason and the overridden startOn', () => {
    const comment = buildStartOnOverrideComment({
      actor: 'implement',
      reason: 'measurement window must not slip',
      startOn: START_ON,
      nowIso: clock.nowIso(),
    });
    expect(comment).toContain('implement');
    expect(comment).toContain('measurement window must not slip');
    expect(comment).toContain(START_ON);
    expect(comment).toContain(clock.nowIso());
  });

  it('falls back to "unknown" for a blank actor and omits the timestamp when absent', () => {
    const comment = buildStartOnOverrideComment({
      actor: '   ',
      reason: 'early start',
      startOn: START_ON,
    });
    expect(comment).toContain('unknown');
    expect(comment).not.toContain(' at ');
  });
});
