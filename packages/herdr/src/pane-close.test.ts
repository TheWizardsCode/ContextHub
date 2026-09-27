/**
 * packages/herdr/src/pane-close.test.ts — table-driven tests for the shared
 * pane-closure classifier (WL-0MUJW9CV5005XAZX / WL-0MUJL1NAH0042GOS).
 *
 * These tests pin down the `classifySession` contract before the
 * implementation exists (TDD). They import the pure interface and assert on
 * `CloseDecision { close, reasonCode }` for every classification row.
 *
 * Classification cases (parent AC1-AC4):
 *  1. `</end_session>` marker at the very end → close, reason `marker`
 *  2. `</end_session>` quoted mid-message → no close
 *  3. `</end_session>` followed only by whitespace/newlines → close
 *  4. No marker, agent alive, idle < 30 min → no close, reason `active`
 *  5. No marker, agent alive, idle >= 30 min → close, reason `idle-threshold`
 *  6. No marker, agent process gone → close, reason `dead-agent`
 *  7. `kind: 'implement'` → never close, reason `implement`
 *  8. `needsProducerReview: true` → never close, reason `producer-review`
 *  9. `isInvokingPane: true` → never close, reason `invoking-pane`
 * 10. `childProcessCount > 0` → never close, reason `live-children`
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

describe('classifySession — dead agent (AC3, parent)', () => {
  it('closes when the agent process is gone', () => {
    const result = classifySession(sample({
      lastAssistantText: '',
      agentProcessAlive: false,
    }));
    expect(result).toEqual({ close: true, reasonCode: 'dead-agent' });
  });

  it('closes a dead agent even if idle is zero', () => {
    const result = classifySession(sample({
      lastAssistantText: '',
      agentProcessAlive: false,
      idleMs: 0,
    }));
    expect(result).toEqual({ close: true, reasonCode: 'dead-agent' });
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

    it(`closes a ${kind} pane when agent is dead`, () => {
      const result = classifySession(sample({
        kind,
        agentProcessAlive: false,
      }));
      expect(result).toEqual({ close: true, reasonCode: 'dead-agent' });
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
