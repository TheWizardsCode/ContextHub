/**
 * packages/herdr/src/stalled-work.test.ts — unit tests for the pure
 * stalled-pane classifier (WL-0MUYMBO9X000WDF6, parent WL-0MUMA5OMH0024PN1).
 *
 * `classifyStalledPane` is a pure function: it maps a `herdr pane list`
 * record + the pane's work-item info + guard inputs to either
 * `{ stalled: true, kind }` or `{ stalled: false, reason }`. Every stall
 * condition and every safety/no-progress exclusion has a dedicated test
 * asserting its machine-readable reason code.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyStalledPane,
  stalledPaneKindFromLabel,
  type StalledPaneGuards,
} from './stalled-work.js';
import type { DowntimeItemInfo, HerdrPaneRecord } from './downtime-worker.js';
import type { DowntimeLogEntry } from './downtime-log.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const THRESHOLD = 5 * 60 * 1000;
const ITEM_ID = 'WL-0ABCDEF123456789';

function pane(overrides: Partial<HerdrPaneRecord> = {}): HerdrPaneRecord {
  return {
    paneId: 'pane-1',
    label: `Downtime triggered implement Fix the widget - ${ITEM_ID}`,
    agent: 'pi',
    agentStatus: 'idle',
    ...overrides,
  };
}

function item(overrides: Partial<DowntimeItemInfo> = {}): DowntimeItemInfo {
  return {
    id: ITEM_ID,
    status: 'open',
    stage: 'plan_complete',
    risk: 'low',
    effort: 'small',
    // Default: the item has not progressed for 10 minutes → past the 5-min
    // threshold (a genuine stall).
    updatedAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function guards(overrides: Partial<StalledPaneGuards> = {}): StalledPaneGuards {
  return {
    entries: [],
    nonTerminalCooldownMs: 10 * 60 * 1000,
    maxAttempts: 3,
    ...overrides,
  };
}

function classify(
  p: HerdrPaneRecord = pane(),
  i: DowntimeItemInfo = item(),
  g: StalledPaneGuards = guards(),
) {
  return classifyStalledPane(p, i, g, NOW, THRESHOLD);
}

describe('stalledPaneKindFromLabel (WL-0MUYMBO9X000WDF6)', () => {
  it('derives the kind from a Downtime-triggered label', () => {
    expect(stalledPaneKindFromLabel(`Downtime triggered implement Title - ${ITEM_ID}`)).toBe('implement');
    expect(stalledPaneKindFromLabel(`Downtime triggered plan Title - ${ITEM_ID}`)).toBe('plan');
    expect(stalledPaneKindFromLabel(`Downtime triggered intake Title - ${ITEM_ID}`)).toBe('intake');
    expect(stalledPaneKindFromLabel(`Downtime triggered audit Title - ${ITEM_ID}`)).toBe('audit');
    expect(stalledPaneKindFromLabel(`Downtime triggered risk-effort Title - ${ITEM_ID}`)).toBe('risk-effort');
  });

  it('derives the kind from a Manually-triggered label', () => {
    expect(stalledPaneKindFromLabel(`Manually triggered plan Title - ${ITEM_ID}`)).toBe('plan');
  });

  it('returns null for a non-skill label, a free-form prompt or a truncated/absent label', () => {
    expect(stalledPaneKindFromLabel('Downtime implement')).toBeNull();
    expect(stalledPaneKindFromLabel(`Manually triggered prompt hello - ${ITEM_ID}`)).toBeNull();
    expect(stalledPaneKindFromLabel('some operator pane')).toBeNull();
    expect(stalledPaneKindFromLabel(undefined)).toBeNull();
    expect(stalledPaneKindFromLabel('')).toBeNull();
  });
});

describe('classifyStalledPane — stall detection (WL-0MUYMBO9X000WDF6)', () => {
  it('classifies a non-working pane past the threshold as stalled, with the label kind', () => {
    expect(classify()).toEqual({ stalled: true, kind: 'implement' });
  });

  it('resumes both idle and exited (done) agents — done is not a stall exclusion', () => {
    expect(classify(pane({ agentStatus: 'idle' }))).toEqual({ stalled: true, kind: 'implement' });
    expect(classify(pane({ agentStatus: 'done' }))).toEqual({ stalled: true, kind: 'implement' });
    expect(classify(pane({ agentStatus: 'exited' }))).toEqual({ stalled: true, kind: 'implement' });
  });

  it('uses the dispatch marker (not the item updatedAt alone) as the stall anchor', () => {
    // Item last updated 3 days ago but the pane was only dispatched 1 min
    // ago — it cannot be a stalled pane yet.
    const dispatchedAt = new Date(NOW - 60 * 1000).toISOString();
    const entries: DowntimeLogEntry[] = [
      { itemId: ITEM_ID, kind: 'implement', stage: 'plan_complete', dispatchedAt },
    ];
    const info = item({ updatedAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString() });
    expect(classify(pane(), info, guards({ entries }))).toEqual({
      stalled: false,
      reason: 'stall-threshold-not-elapsed',
    });
  });

  it('no-agent: excludes a pane with no live pi agent', () => {
    expect(classify(pane({ agent: undefined }))).toEqual({ stalled: false, reason: 'no-agent' });
    expect(classify(pane({ agent: '' }))).toEqual({ stalled: false, reason: 'no-agent' });
  });

  it('no-item-id: excludes a pane whose label has no parseable item-id suffix', () => {
    expect(classify(pane({ label: 'Downtime triggered implement No id' }))).toEqual({
      stalled: false,
      reason: 'no-item-id',
    });
    expect(classify(pane({ label: undefined }))).toEqual({ stalled: false, reason: 'no-item-id' });
  });

  it('item-terminal: excludes completed/deleted items and in_review/done stages', () => {
    expect(classify(pane(), item({ status: 'completed', stage: 'in_review' }))).toEqual({
      stalled: false,
      reason: 'item-terminal',
    });
    expect(classify(pane(), item({ status: 'deleted' }))).toEqual({
      stalled: false,
      reason: 'item-terminal',
    });
    expect(classify(pane(), item({ stage: 'done' }))).toEqual({
      stalled: false,
      reason: 'item-terminal',
    });
  });

  it('needs-producer-review: excludes an item flagged for producer review', () => {
    expect(classify(pane(), item({ needsProducerReview: true }))).toEqual({
      stalled: false,
      reason: 'needs-producer-review',
    });
  });

  it('agent-working: a working agent is actively running, never a stall candidate', () => {
    expect(classify(pane({ agentStatus: 'working' }))).toEqual({
      stalled: false,
      reason: 'agent-working',
    });
    expect(classify(pane({ agentStatus: 'busy' }))).toEqual({
      stalled: false,
      reason: 'agent-working',
    });
  });

  it('agent-blocked: a blocked agent is never hijacked by the scan', () => {
    expect(classify(pane({ agentStatus: 'blocked' }))).toEqual({
      stalled: false,
      reason: 'agent-blocked',
    });
  });

  it('stall-threshold-not-elapsed: excludes a pane that went not-working too recently', () => {
    const info = item({ updatedAt: new Date(NOW - 60 * 1000).toISOString() });
    expect(classify(pane(), info)).toEqual({
      stalled: false,
      reason: 'stall-threshold-not-elapsed',
    });
  });

  it('last-activity-unknown: cannot prove a stall without any activity timestamp', () => {
    const info = item({ updatedAt: undefined });
    expect(classify(pane(), info)).toEqual({
      stalled: false,
      reason: 'last-activity-unknown',
    });
  });
});

describe('classifyStalledPane — safety / no-progress exclusions (WL-0MUYMBO9X000WDF6)', () => {
  it('kind-unknown: excludes a pane with no dispatch kind in its label', () => {
    expect(classify(pane({ label: `Manually triggered prompt hello - ${ITEM_ID}` }))).toEqual({
      stalled: false,
      reason: 'kind-unknown',
    });
  });

  it('kind-stale: excludes a pane whose kind the item has already advanced past', () => {
    // The item has advanced from `idea` (intake) to `intake_complete`, so the
    // pane's dispatched `intake` kind is no longer current.
    const info = item({ stage: 'intake_complete' });
    expect(classify(pane({ label: `Downtime triggered intake Title - ${ITEM_ID}` }), info)).toEqual({
      stalled: false,
      reason: 'kind-stale',
    });
  });

  it('does not treat a still-current kind as stale (in-progress implement pane)', () => {
    const info = item({ status: 'in-progress', stage: 'plan_complete' });
    expect(classify(pane(), info)).toEqual({ stalled: true, kind: 'implement' });
  });

  it('cooldown-active: excludes an item held by the non-terminal pane-close cooldown', () => {
    const entries: DowntimeLogEntry[] = [
      {
        entryType: 'pane-close',
        itemId: ITEM_ID,
        kind: 'implement',
        reasonCode: 'agent-idle',
        stage: 'plan_complete',
        timestamp: new Date(NOW - 60 * 1000).toISOString(),
      },
    ];
    expect(classify(pane(), item(), guards({ entries }))).toEqual({
      stalled: false,
      reason: 'cooldown-active',
    });
  });

  it('attempt-cap-exhausted: excludes an item at/over the per-item/per-kind attempt cap', () => {
    const entries: DowntimeLogEntry[] = Array.from({ length: 3 }, () => ({
      itemId: ITEM_ID,
      kind: 'implement',
      stage: 'plan_complete',
      dispatchedAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    }));
    expect(classify(pane(), item(), guards({ entries, maxAttempts: 3 }))).toEqual({
      stalled: false,
      reason: 'attempt-cap-exhausted',
    });
  });
});
