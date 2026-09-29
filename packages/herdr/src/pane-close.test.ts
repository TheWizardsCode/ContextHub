/**
 * packages/herdr/src/pane-close.test.ts — table-driven tests for the shared
 * pane-closure classifier (WL-0MUJW9CV5005XAZX / WL-0MUJL1NAH0042GOS / WL-0MUMEJHT9004EQPI).
 *
 * These tests pin down the `classifySession` contract before the
 * implementation exists (TDD). They import the pure interface and assert on
 * `CloseDecision { close, reasonCode }` for every classification row.
 *
 * Classification cases (parent AC1-AC4, WL-0MUMEJHT9004EQPI AC1-AC2):
 *  1. `</end_session>` marker at the very end → close, reason `marker`
 *  2. `</end_session>` quoted mid-message → no close
 *  3. `</end_session>` followed only by whitespace/newlines → close
 *  4. No marker, agent alive, idle < 30 min → no close, reason `active`
 *  5. No marker, agent alive, idle >= 30 min → close, reason `idle-threshold`
 *  6. No marker, agent process gone → **no close**, reason `dead-agent` (AC1)
 *  7. `kind: 'implement'` → never close, reason `implement`
 *  8. `needsProducerReview: true` → never close, reason `producer-review`
 *  9. `isInvokingPane: true` → never close, reason `invoking-pane`
 * 10. `childProcessCount > 0` → never close, reason `live-children`
 * 11. idle threshold ≤ 0 → never close on idle (AC2)
 */
import { describe, expect, it } from 'vitest';

import type { SessionSample, CloseDecision } from './pane-close';
import { classifySession, extractFinalAssistantText } from './pane-close';

// ── Fixture helpers ───────────────────────────────────────────────────

const THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function sample(overrides: Partial<SessionSample> = {}): SessionSample {
  return {
    lastAssistantText: '',
    agentProcessAlive: true,
    idleMs: 0,
    kind: 'unknown',
    needsProducerReview: false,
    isInvokingPane: false,
    childProcessCount: 0,
    ...overrides,
  };
}

// ── Test cases ────────────────────────────────────────────────────────

describe('classifySession — marker detection (AC1, AC2)', () => {
  it('closes when the marker is at the very end (after rstrip)', () => {
    const result = classifySession(sample({
      lastAssistantText: 'All done here.\n\n</end_session>',
    }));
    expect(result).toEqual({ close: true, reasonCode: 'marker' });
  });

  it('closes when the marker is followed only by whitespace / newlines', () => {
    const result = classifySession(sample({
      lastAssistantText: 'Session complete.\n\n</end_session>\n\n',
    }));
    expect(result).toEqual({ close: true, reasonCode: 'marker' });
  });

  it('does NOT close when the marker is quoted mid-message', () => {
    const result = classifySession(sample({
      lastAssistantText: 'I wrote the report (see </end_session> example) and saved it.',
    }));
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });

  it('does NOT close when non-whitespace follows the marker', () => {
    const result = classifySession(sample({
      lastAssistantText: 'Done</end_session> please review my work',
    }));
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });

  it('does NOT close when there is no marker at all', () => {
    const result = classifySession(sample({
      lastAssistantText: 'I am still working on this task...',
    }));
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });
});

describe('classifySession — live agent, below threshold (AC3, parent)', () => {
  it('does not close when the agent is alive and idle is below the threshold', () => {
    const result = classifySession(sample({
      lastAssistantText: '',
      agentProcessAlive: true,
      idleMs: 60 * 1000, // 1 minute
    }));
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });
});

describe('classifySession — idle threshold (AC3, parent)', () => {
  it('closes when the agent is alive but idle beyond the threshold (30 min)', () => {
    const result = classifySession(sample({
      lastAssistantText: '',
      agentProcessAlive: true,
      idleMs: THRESHOLD_MS + 1,
    }));
    expect(result).toEqual({ close: true, reasonCode: 'idle-threshold' });
  });

  it('does not close when the agent is alive and idle is exactly at the threshold', () => {
    const result = classifySession(sample({
      lastAssistantText: '',
      agentProcessAlive: true,
      idleMs: THRESHOLD_MS,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });

  it('does not close when the agent is alive and idle is just below the threshold', () => {
    const result = classifySession(sample(sample({
      lastAssistantText: '',
      agentProcessAlive: true,
      idleMs: THRESHOLD_MS - 1,
    })));
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });
});

describe('classifySession — idle threshold <= 0 never closes (WL-0MUMEJHT9004EQPI AC2)', () => {
  it('does not close when idleThresholdMs is 0, regardless of idleMs', () => {
    const result = classifySession(
      sample({ lastAssistantText: '', agentProcessAlive: true, idleMs: 999999999 }),
      { idleThresholdMs: 0 },
    );
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });

  it('does not close when idleThresholdMs is negative, regardless of idleMs', () => {
    const result = classifySession(
      sample({ lastAssistantText: '', agentProcessAlive: true, idleMs: 999999999 }),
      { idleThresholdMs: -1 },
    );
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });

  it('does not close when idleThresholdMs is 0 and idleMs is also 0', () => {
    const result = classifySession(
      sample({ lastAssistantText: '', agentProcessAlive: true, idleMs: 0 }),
      { idleThresholdMs: 0 },
    );
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });

  it('does not close when idleThresholdMs is negative even if idleMs is zero', () => {
    const result = classifySession(
      sample({ lastAssistantText: '', agentProcessAlive: true, idleMs: 0 }),
      { idleThresholdMs: -5 },
    );
    expect(result).toEqual({ close: false, reasonCode: 'active' });
  });
});

describe('classifySession — dead agent (WL-0MUMEJHT9004EQPI AC1)', () => {
  it('does NOT close when the agent process is gone (operator may need output)', () => {
    const result = classifySession(sample({
      lastAssistantText: '',
      agentProcessAlive: false,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'dead-agent' });
  });

  it('does NOT close a dead agent even if idle is zero', () => {
    const result = classifySession(sample({
      lastAssistantText: '',
      agentProcessAlive: false,
      idleMs: 0,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'dead-agent' });
  });

  it('does NOT close a dead agent even if idle is very large', () => {
    const result = classifySession(sample({
      lastAssistantText: '',
      agentProcessAlive: false,
      idleMs: 999999999,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'dead-agent' });
  });
});

describe('classifySession — never-close guards (AC4, AC3, parent)', () => {
  it('never closes an implement pane (AC4)', () => {
    const result = classifySession(sample({
      kind: 'implement',
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'implement' });
  });

  it('never closes a pane with needsProducerReview = true', () => {
    const result = classifySession(sample({
      needsProducerReview: true,
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'producer-review' });
  });

  it('never closes the invoking pane', () => {
    const result = classifySession(sample({
      isInvokingPane: true,
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'invoking-pane' });
  });

  it('never closes a pane with live child processes (AC5)', () => {
    const result = classifySession(sample({
      childProcessCount: 2,
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'live-children' });
  });
});

describe('classifySession — guard precedence (never-close wins)', () => {
  it('implement guard takes precedence over marker close', () => {
    const result = classifySession(sample({
      kind: 'implement',
      lastAssistantText: '</end_session>',
    }));
    expect(result.close).toBe(false);
    expect(result.reasonCode).toBe('implement');
  });

  it('needsProducerReview guard takes precedence over dead-agent close', () => {
    const result = classifySession(sample({
      needsProducerReview: true,
      agentProcessAlive: false,
    }));
    expect(result.close).toBe(false);
    expect(result.reasonCode).toBe('producer-review');
  });

  it('invoking-pane guard takes precedence over idle-threshold close', () => {
    const result = classifySession(sample({
      isInvokingPane: true,
      idleMs: THRESHOLD_MS + 1,
    }));
    expect(result.close).toBe(false);
    expect(result.reasonCode).toBe('invoking-pane');
  });

  it('live-children guard takes precedence over marker close', () => {
    const result = classifySession(sample({
      childProcessCount: 1,
      lastAssistantText: '</end_session>',
    }));
    expect(result.close).toBe(false);
    expect(result.reasonCode).toBe('live-children');
  });
});

describe('classifySession — kind variants', () => {
  for (const kind of ['plan', 'intake', 'audit', 'risk-effort', 'unknown'] as const) {
    it(`closes a ${kind} pane with marker at the end`, () => {
      const result = classifySession(sample({
        kind,
        lastAssistantText: 'Done\n\n</end_session>',
      }));
      expect(result).toEqual({ close: true, reasonCode: 'marker' });
    });

    it(`does NOT close a ${kind} pane when agent is dead`, () => {
      const result = classifySession(sample({
        kind,
        agentProcessAlive: false,
      }));
      expect(result).toEqual({ close: false, reasonCode: 'dead-agent' });
    });
  }
});

describe('classifySession — producer-review per kind (AC1.1)', () => {
  // Regression: the false-positive closes were observed for intake, plan, audit
  // and risk-effort panes. Each kind must return producer-review even when the
  // pane also has a marker, is dead, and is deeply idle.
  for (const kind of ['intake', 'plan', 'audit', 'risk-effort'] as const) {
    it(`never closes a ${kind} pane with producer-review, even with marker+dead+idle`, () => {
      const result = classifySession(sample({
        kind,
        needsProducerReview: true,
        lastAssistantText: '</end_session>',
        agentProcessAlive: false,
        idleMs: 999999999,
      }));
      expect(result).toEqual({ close: false, reasonCode: 'producer-review' });
    });
  }
});

describe('classifySession — implement pane never closes (AC1.2)', () => {
  it('never closes an implement pane with marker+idle>threshold', () => {
    const result = classifySession(sample({
      kind: 'implement',
      lastAssistantText: '</end_session>',
      agentProcessAlive: true,
      idleMs: 999999999,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'implement' });
  });

  it('never closes an implement pane with marker+dead', () => {
    const result = classifySession(sample({
      kind: 'implement',
      lastAssistantText: '</end_session>',
      agentProcessAlive: false,
      idleMs: 0,
    }));
    expect(result).toEqual({ close: false, reasonCode: 'implement' });
  });
});

describe('classifySession — invoking-pane and live-children guards (AC1.3)', () => {
  it('invoking-pane never closes even with idle>threshold', () => {
    const result = classifySession(sample({
      isInvokingPane: true,
      idleMs: 999999999,
      lastAssistantText: '</end_session>',
    }));
    expect(result).toEqual({ close: false, reasonCode: 'invoking-pane' });
  });

  it('live-children never closes even with idle>threshold', () => {
    const result = classifySession(sample({
      childProcessCount: 5,
      idleMs: 999999999,
      lastAssistantText: '</end_session>',
    }));
    expect(result).toEqual({ close: false, reasonCode: 'live-children' });
  });
});

describe('classifySession — table-driven coverage of every classification path (AC1.6)', () => {
  interface Row {
    name: string;
    sample: Partial<SessionSample>;
    opts?: { idleThresholdMs?: number };
    expected: CloseDecision;
  }

  const rows: Row[] = [
    // Close paths
    {
      name: 'marker at end → marker',
      sample: { lastAssistantText: 'Done\n\n</end_session>' },
      expected: { close: true, reasonCode: 'marker' },
    },
    {
      name: 'alive + idle beyond threshold → idle-threshold',
      sample: { agentProcessAlive: true, idleMs: THRESHOLD_MS + 1 },
      expected: { close: true, reasonCode: 'idle-threshold' },
    },
    // No-close paths
    {
      name: 'marker quoted mid-message → active',
      sample: { lastAssistantText: 'see </end_session> here' },
      expected: { close: false, reasonCode: 'active' },
    },
    {
      name: 'marker followed by non-whitespace → active',
      sample: { lastAssistantText: 'Done</end_session> more' },
      expected: { close: false, reasonCode: 'active' },
    },
    {
      name: 'dead agent → dead-agent',
      sample: { agentProcessAlive: false, idleMs: 999999999 },
      expected: { close: false, reasonCode: 'dead-agent' },
    },
    {
      name: 'idle threshold 0 → active (idle disabled)',
      sample: { agentProcessAlive: true, idleMs: 999999999 },
      opts: { idleThresholdMs: 0 },
      expected: { close: false, reasonCode: 'active' },
    },
    {
      name: 'implement kind → implement',
      sample: { kind: 'implement', lastAssistantText: '</end_session>', agentProcessAlive: false },
      expected: { close: false, reasonCode: 'implement' },
    },
    {
      name: 'needsProducerReview → producer-review',
      sample: { needsProducerReview: true, lastAssistantText: '</end_session>', agentProcessAlive: false },
      expected: { close: false, reasonCode: 'producer-review' },
    },
    {
      name: 'invoking pane → invoking-pane',
      sample: { isInvokingPane: true, idleMs: THRESHOLD_MS + 1 },
      expected: { close: false, reasonCode: 'invoking-pane' },
    },
    {
      name: 'live children → live-children',
      sample: { childProcessCount: 1, lastAssistantText: '</end_session>' },
      expected: { close: false, reasonCode: 'live-children' },
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const result = classifySession(sample(row.sample), row.opts);
      expect(result).toEqual(row.expected);
    });
  }
});

describe('classifySession — grace period table (parent AC5)', () => {
  const GRACE_MS = 5 * 60 * 1000;

  interface Row {
    name: string;
    sample: Partial<SessionSample>;
    opts?: { idleThresholdMs?: number; gracePeriodMs?: number };
    expected: CloseDecision;
  }

  const rows: Row[] = [
    {
      name: 'within grace blocks a marker close',
      sample: { lastAssistantText: '</end_session>', ageSinceDispatchMs: 60_000 },
      opts: { gracePeriodMs: GRACE_MS },
      expected: { close: false, reasonCode: 'grace-period' },
    },
    {
      name: 'within grace blocks a dead-agent close',
      sample: { agentProcessAlive: false, ageSinceDispatchMs: 0 },
      opts: { gracePeriodMs: GRACE_MS },
      expected: { close: false, reasonCode: 'grace-period' },
    },
    {
      name: 'within grace blocks an idle-threshold close',
      sample: { agentProcessAlive: true, idleMs: THRESHOLD_MS + 1, ageSinceDispatchMs: 60_000 },
      opts: { idleThresholdMs: THRESHOLD_MS, gracePeriodMs: GRACE_MS },
      expected: { close: false, reasonCode: 'grace-period' },
    },
    {
      name: 'exactly at the grace boundary still blocks (age == grace)',
      sample: { lastAssistantText: '</end_session>', ageSinceDispatchMs: GRACE_MS },
      opts: { gracePeriodMs: GRACE_MS },
      expected: { close: false, reasonCode: 'grace-period' },
    },
    {
      name: 'past grace closes on the marker',
      sample: { lastAssistantText: '</end_session>', ageSinceDispatchMs: GRACE_MS + 1 },
      opts: { gracePeriodMs: GRACE_MS },
      expected: { close: true, reasonCode: 'marker' },
    },
    {
      name: 'past grace closes on the idle threshold',
      sample: { agentProcessAlive: true, idleMs: THRESHOLD_MS + 1, ageSinceDispatchMs: GRACE_MS + 1 },
      opts: { idleThresholdMs: THRESHOLD_MS, gracePeriodMs: GRACE_MS },
      expected: { close: true, reasonCode: 'idle-threshold' },
    },
    {
      name: 'grace 0 (disabled) does not block a marker close',
      sample: { lastAssistantText: '</end_session>', ageSinceDispatchMs: 1 },
      opts: { gracePeriodMs: 0 },
      expected: { close: true, reasonCode: 'marker' },
    },
    {
      name: 'absent grace option does not block a marker close',
      sample: { lastAssistantText: '</end_session>', ageSinceDispatchMs: 1 },
      expected: { close: true, reasonCode: 'marker' },
    },
    {
      name: 'unknown pane age does not block a marker close',
      sample: { lastAssistantText: '</end_session>' },
      opts: { gracePeriodMs: GRACE_MS },
      expected: { close: true, reasonCode: 'marker' },
    },
    {
      name: 'never-close guards take precedence over the grace window',
      sample: { kind: 'implement', ageSinceDispatchMs: 0 },
      opts: { gracePeriodMs: GRACE_MS },
      expected: { close: false, reasonCode: 'implement' },
    },
    {
      name: 'a grace longer than the idle threshold still blocks an idle close',
      sample: { agentProcessAlive: true, idleMs: 6 * 60 * 1000, ageSinceDispatchMs: 10 * 60 * 1000 },
      opts: { idleThresholdMs: 5 * 60 * 1000, gracePeriodMs: 60 * 60 * 1000 },
      expected: { close: false, reasonCode: 'grace-period' },
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      expect(classifySession(sample(row.sample), row.opts)).toEqual(row.expected);
    });
  }
});

describe('classifySession — extractFinalAssistantText', () => {
  it('returns the final assistant message text, trimEnd-ed (rstrip semantics)', () => {
    const entries = [
      { type: 'user', text: 'Hello' },
      { type: 'assistant', text: '  Hi there!  ' },
    ];
    expect(extractFinalAssistantText(entries)).toBe('  Hi there!');
  });

  it('returns empty string when there is no assistant message', () => {
    const entries = [{ type: 'user', text: 'Hello' }];
    expect(extractFinalAssistantText(entries)).toBe('');
  });
});
