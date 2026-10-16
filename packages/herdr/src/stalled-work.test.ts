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

import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyStalledPane,
  stalledPaneKindFromLabel,
  resumeStalledPane,
  scanStalledPanes,
  buildStalledResumeStartArgs,
  classifyHerdrAgentFailure,
  _resetStalledResumeInFlight,
  STALLED_RESUME_PROMPT,
  type ResumeStalledPaneDeps,
  type StalledResumeStartOptions,
  type StalledPaneGuards,
  type StalledScanDeps,
  type StalledScanOptions,
} from './stalled-work.js';
import type { DowntimeItemInfo, HerdrPaneRecord } from './downtime-worker.js';
import { countAttempts, type DowntimeLogEntry } from './downtime-log.js';
import type { ModelCooldownEntry } from '@worklog/shared/model-cooldown';

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

/** A machine-wide model-cooldown entry; default DUE (already expired). */
function cooldown(overrides: Partial<ModelCooldownEntry> = {}): ModelCooldownEntry {
  return {
    paneId: 'pane-1',
    sessionId: null,
    itemId: ITEM_ID,
    kind: 'implement',
    reason: 'all providers exhausted',
    createdAt: NOW - 30 * 1000,
    cooldownUntil: NOW - 1,
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

// ── Model cooldown (WL-0MV5639GG00085Q7) ───────────────────────────────

describe('classifyStalledPane — model cooldown (WL-0MV5639GG00085Q7)', () => {
  it('a DUE (expired) cooldown is the wake trigger and bypasses the stall threshold', () => {
    // The item has only been quiet for 1 s — the generic 5-min threshold has
    // NOT elapsed — but the expired cooldown makes it resumable.
    const info = item({ updatedAt: new Date(NOW - 1000).toISOString() });
    expect(classify(pane(), info, guards({ modelCooldown: cooldown() }))).toEqual({
      stalled: true,
      kind: 'implement',
    });
  });

  it('strictness: an ACTIVE (unexpired) cooldown never wakes a pane, even past the threshold', () => {
    expect(
      classify(pane(), item(), guards({ modelCooldown: cooldown({ cooldownUntil: NOW + 60 * 1000 }) })),
    ).toEqual({ stalled: false, reason: 'model-cooldown-active' });
  });

  it('a due cooldown candidate is still excluded by the needsProducerReview flag', () => {
    expect(
      classify(pane(), item({ needsProducerReview: true }), guards({ modelCooldown: cooldown() })),
    ).toEqual({ stalled: false, reason: 'needs-producer-review' });
  });

  it('a due cooldown candidate is still excluded by the attempt cap', () => {
    const entries: DowntimeLogEntry[] = Array.from({ length: 3 }, () => ({
      itemId: ITEM_ID,
      kind: 'implement',
      stage: 'plan_complete',
      dispatchedAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    }));
    expect(classify(pane(), item(), guards({ entries, maxAttempts: 3, modelCooldown: cooldown() }))).toEqual({
      stalled: false,
      reason: 'attempt-cap-exhausted',
    });
  });

  it('has no effect when the pane has no matching cooldown entry', () => {
    expect(classify(pane(), item(), guards())).toEqual({ stalled: true, kind: 'implement' });
  });
});

// ── In-place resume orchestrator (WL-0MUYMBPZ5004LBFX) ──────────────────

interface ResumeSpies {
  deps: ResumeStalledPaneDeps;
  promptCalls: Array<[string, string]>;
  startCalls: Array<[string, StalledResumeStartOptions]>;
  recorded: DowntimeLogEntry[];
  flagged: string[];
}

/**
 * Build a fully-stubbed {@link ResumeStalledPaneDeps} controller. The default
 * seams succeed; `overrides` inject a failure/observation. `promptGate` lets a
 * concurrency test hold the first prompt open.
 */
function resumeController(
  overrides: Partial<ResumeStalledPaneDeps> = {},
  promptGate?: Promise<void>,
): ResumeSpies {
  const promptCalls: Array<[string, string]> = [];
  const startCalls: Array<[string, StalledResumeStartOptions]> = [];
  const recorded: DowntimeLogEntry[] = [];
  const flagged: string[] = [];
  const cleared: string[] = [];
  const deps: ResumeStalledPaneDeps = {
    promptAgent: async (paneId, text) => {
      promptCalls.push([paneId, text]);
      if (promptGate !== undefined) await promptGate;
      return { ok: true };
    },
    startAgent: async (paneId, opts) => {
      startCalls.push([paneId, opts]);
      return { ok: true };
    },
    readEntries: async () => [],
    recordAttempt: async (_cwd, entry) => {
      recorded.push(entry);
    },
    markNeedsProducerReview: async (itemId) => {
      flagged.push(itemId);
      return true;
    },
    clearCooldown: async (paneId) => {
      cleared.push(paneId);
      return true;
    },
    maxAttempts: 3,
    now: () => NOW,
    ...overrides,
  };
  return { deps, promptCalls, startCalls, recorded, flagged, cleared };
}

function resumeInput(
  paneOverrides: Partial<HerdrPaneRecord> = {},
  itemOverrides: Partial<DowntimeItemInfo> = {},
  modelCooldown: ModelCooldownEntry | null = null,
) {
  return {
    pane: pane(paneOverrides),
    item: item(itemOverrides),
    cwd: '/worklog/root',
    nonTerminalCooldownMs: 10 * 60 * 1000,
    thresholdMs: THRESHOLD,
    kind: 'implement' as const,
    modelCooldown,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('buildStalledResumeStartArgs (WL-0MUYMBPZ5004LBFX)', () => {
  it('continues a named session with --session <path>', () => {
    expect(buildStalledResumeStartArgs('pane-1', { sessionPath: '/s/abc.jsonl' })).toEqual([
      'agent', 'start', 'pi', '--kind', 'pi', '--pane', 'pane-1', '--', '--session', '/s/abc.jsonl',
    ]);
  });

  it('falls back to pi --continue when no session path is recorded', () => {
    expect(buildStalledResumeStartArgs('pane-1')).toEqual([
      'agent', 'start', 'pi', '--kind', 'pi', '--pane', 'pane-1', '--', '--continue',
    ]);
    expect(buildStalledResumeStartArgs('pane-1', { sessionPath: '' })).toEqual([
      'agent', 'start', 'pi', '--kind', 'pi', '--pane', 'pane-1', '--', '--continue',
    ]);
  });
});

describe('classifyHerdrAgentFailure (WL-0MUYMBPZ5004LBFX)', () => {
  it('maps the documented CLI codes to neutral reasons', () => {
    expect(classifyHerdrAgentFailure('error: agent_blocked')).toBe('agent-blocked');
    expect(classifyHerdrAgentFailure('agent_prompt_stalled after 5000ms')).toBe('agent-prompt-stalled');
    expect(classifyHerdrAgentFailure('pane 3 not found')).toBe('pane-vanished');
    expect(classifyHerdrAgentFailure('unknown pane id')).toBe('pane-vanished');
  });

  it('maps anything unrecognised (and absence) to cli-error', () => {
    expect(classifyHerdrAgentFailure('boom')).toBe('cli-error');
    expect(classifyHerdrAgentFailure(undefined)).toBe('cli-error');
  });
});

describe('resumeStalledPane — in-place resume (WL-0MUYMBPZ5004LBFX)', () => {
  beforeEach(() => {
    _resetStalledResumeInFlight();
  });

  it('prompts a live agent with the literal continue and records an attempt', async () => {
    const { deps, promptCalls, startCalls, recorded } = resumeController();
    const out = await resumeStalledPane(resumeInput({ agentStatus: 'idle' }), deps);

    expect(out).toEqual({
      resumed: true,
      via: 'prompt',
      paneId: 'pane-1',
      itemId: ITEM_ID,
      kind: 'implement',
    });
    expect(promptCalls).toEqual([['pane-1', STALLED_RESUME_PROMPT]]);
    expect(startCalls).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      itemId: ITEM_ID,
      kind: 'implement',
      stage: 'plan_complete',
      cwd: '/worklog/root',
    });
    expect(recorded[0].dispatchedAt).toBe(new Date(NOW).toISOString());
  });

  it('relaunches pi in the same pane continuing the session, then submits continue', async () => {
    const sessionPath = '/sessions/abc.jsonl';
    const { deps, promptCalls, startCalls, recorded } = resumeController();
    const out = await resumeStalledPane(
      resumeInput({ agentStatus: 'done', agentSession: { value: sessionPath } }),
      deps,
    );

    expect(out).toMatchObject({ resumed: true, via: 'start', paneId: 'pane-1' });
    expect(startCalls).toEqual([['pane-1', { sessionPath }]]);
    expect(promptCalls).toEqual([['pane-1', STALLED_RESUME_PROMPT]]);
    expect(recorded).toHaveLength(1);
  });

  it('relaunches an exited agent and continues the latest session without a path', async () => {
    const { deps, startCalls } = resumeController();
    const out = await resumeStalledPane(resumeInput({ agentStatus: 'exited' }), deps);
    expect(out).toMatchObject({ resumed: true, via: 'start' });
    expect(startCalls).toEqual([['pane-1', { sessionPath: undefined }]]);
  });

  it('records the attempt in the normal bookkeeping so the cap counts it', async () => {
    const { deps, recorded } = resumeController();
    await resumeStalledPane(resumeInput(), deps);
    expect(countAttempts(recorded, ITEM_ID, 'implement', 'plan_complete')).toBe(1);
  });

  it('escalates via needsProducerReview when the attempt cap is exhausted, without resuming', async () => {
    const entries: DowntimeLogEntry[] = Array.from({ length: 3 }, () => ({
      itemId: ITEM_ID,
      kind: 'implement',
      stage: 'plan_complete',
      dispatchedAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    }));
    const { deps, promptCalls, recorded, flagged } = resumeController({
      readEntries: async () => entries,
    });
    const out = await resumeStalledPane(resumeInput(), deps);

    expect(out).toMatchObject({ resumed: false, reason: 'attempt-cap-exhausted' });
    expect(flagged).toEqual([ITEM_ID]);
    expect(promptCalls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('prevents a concurrent resume of the same pane/item', async () => {
    const gate = deferred();
    const { deps, promptCalls } = resumeController({}, gate.promise);
    const first = resumeStalledPane(resumeInput(), deps);
    const second = resumeStalledPane(resumeInput(), deps);

    expect(await second).toEqual({
      resumed: false,
      reason: 'concurrent-resume',
      paneId: 'pane-1',
      itemId: ITEM_ID,
      kind: 'implement',
    });
    await expect.poll(() => promptCalls.length).toBe(1);
    gate.resolve();
    expect(await first).toMatchObject({ resumed: true });
    expect(promptCalls).toHaveLength(1);
  });

  it('is fail-safe: every neutral failure returns without a strike or a record', async () => {
    const cases: Array<[Partial<ResumeStalledPaneDeps>, Partial<HerdrPaneRecord>, string]> = [
      [{ promptAgent: async () => ({ ok: false, reason: 'agent-blocked' }) }, {}, 'agent-blocked'],
      [{ promptAgent: async () => ({ ok: false, reason: 'agent-prompt-stalled' }) }, {}, 'agent-prompt-stalled'],
      [
        { startAgent: async () => ({ ok: false, reason: 'pane-vanished' }) },
        { agentStatus: 'done' },
        'pane-vanished',
      ],
      [
        { promptAgent: async () => { throw new Error('herdr exploded'); } },
        {},
        'cli-error',
      ],
      [{}, { agentStatus: 'blocked' }, 'agent-blocked'],
      [{}, { agentStatus: 'working' }, 'agent-working'],
    ];

    for (const [overrides, paneOverrides, reason] of cases) {
      const { deps, recorded } = resumeController(overrides);
      const out = await resumeStalledPane(resumeInput(paneOverrides), deps);
      expect(out).toMatchObject({ resumed: false, reason });
      expect(recorded).toEqual([]);
    }
  });

  it('does not relaunch a live agent (only done/exited panes are relaunched)', async () => {
    const { deps, startCalls } = resumeController();
    await resumeStalledPane(resumeInput({ agentStatus: 'unknown' }), deps);
    expect(startCalls).toEqual([]);
  });
});

// ── Model-cooldown wake (WL-0MV5639GG00085Q7) ──────────────────────────

describe('resumeStalledPane — model-cooldown wake (WL-0MV5639GG00085Q7)', () => {
  beforeEach(() => {
    _resetStalledResumeInFlight();
  });

  it('resumes a due cooldown candidate even before the generic stall threshold', async () => {
    const { deps, promptCalls } = resumeController();
    const out = await resumeStalledPane(
      resumeInput({}, { updatedAt: new Date(NOW - 1000).toISOString() }, cooldown()),
      deps,
    );
    expect(out).toMatchObject({ resumed: true, via: 'prompt', paneId: 'pane-1' });
    expect(promptCalls).toEqual([['pane-1', STALLED_RESUME_PROMPT]]);
  });

  it('strictness: an active cooldown blocks a resume that would otherwise be stalled', async () => {
    const { deps, promptCalls } = resumeController();
    const out = await resumeStalledPane(
      resumeInput({}, {}, cooldown({ cooldownUntil: NOW + 60 * 1000 })),
      deps,
    );
    expect(out).toMatchObject({ resumed: false, reason: 'model-cooldown-active' });
    expect(promptCalls).toEqual([]);
  });

  it('consumes the model-cooldown marker on a successful resume', async () => {
    const { deps, cleared, recorded } = resumeController();
    const out = await resumeStalledPane(resumeInput({}, {}, cooldown()), deps);
    expect(out).toMatchObject({ resumed: true });
    expect(cleared).toEqual(['pane-1']);
    expect(recorded).toHaveLength(1);
  });

  it('a failed resume does not consume the marker and records no attempt', async () => {
    const { deps, cleared, recorded } = resumeController({
      promptAgent: async () => ({ ok: false, reason: 'agent-prompt-stalled' }),
    });
    const out = await resumeStalledPane(resumeInput({}, {}, cooldown()), deps);
    expect(out).toMatchObject({ resumed: false, reason: 'agent-prompt-stalled' });
    expect(cleared).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

// ── Machine-wide scan (WL-0MUYMBSA90092QV2) ───────────────────────────

describe('scanStalledPanes — machine-wide scan (WL-0MUYMBSA90092QV2)', () => {
  const OPTS: StalledScanOptions = {
    enabled: true,
    frozen: false,
    thresholdMs: THRESHOLD,
    nonTerminalCooldownMs: 10 * 60 * 1000,
    maxAttempts: 3,
    now: NOW,
  };

  function scanStage(id: string): string {
    if (id === 'WL-PLAN') return 'intake_complete';
    if (id === 'WL-INTAKE') return 'idea';
    if (id === 'WL-AUDIT') return 'in_review';
    return 'plan_complete';
  }

  function scanDeps(overrides: Partial<StalledScanDeps> = {}): StalledScanDeps {
    return {
      listPanes: async () => [],
      fetchItem: async (id) => ({ ok: true, info: item({ id, stage: scanStage(id) }) }),
      readEntries: async () => [],
      resolveRoot: () => '/worklog/root',
      ...overrides,
    };
  }

  it('returns stalled candidates in pane-list order, carrying each candidate kind', async () => {
    const panes: HerdrPaneRecord[] = [
      pane({ paneId: 'p1', label: `Downtime triggered plan Plan me - WL-PLAN`, agentStatus: 'idle' }),
      pane({ paneId: 'p2', label: `Downtime triggered intake Intake me - WL-INTAKE`, agentStatus: 'done' }),
      pane({ paneId: 'p3', label: `Downtime triggered implement Implement me - WL-IMP`, agentStatus: 'working' }),
    ];
    const out = await scanStalledPanes(scanDeps({ listPanes: async () => panes }), '/leader', OPTS);

    expect(out.map((c) => [c.pane.paneId, c.kind])).toEqual([
      ['p1', 'plan'],
      ['p2', 'intake'],
    ]);
  });

  it('resolves each pane to its OWN root and fetches the item against that root (cross-root)', async () => {
    const fetched: Array<[string, string]> = [];
    const panes: HerdrPaneRecord[] = [
      pane({ paneId: 'p1', label: `Downtime triggered implement Implement me - WL-A`, cwd: '/root-a' }),
      pane({ paneId: 'p2', label: `Downtime triggered implement Implement me - WL-B`, cwd: '/root-b' }),
    ];
    const out = await scanStalledPanes(
      scanDeps({
        listPanes: async () => panes,
        resolveRoot: (p) => (p.cwd === '/root-a' ? '/root-a' : '/root-b'),
        fetchItem: async (id, cwd) => {
          fetched.push([id, cwd]);
          return { ok: true, info: item({ id, stage: scanStage(id) }) };
        },
      }),
      '/leader-root',
      OPTS,
    );

    expect(out.map((c) => c.cwd)).toEqual(['/root-a', '/root-b']);
    expect(fetched).toEqual([['WL-A', '/root-a'], ['WL-B', '/root-b']]);
  });

  it('is inert when the scan is disabled (never lists panes)', async () => {
    let listed = false;
    const out = await scanStalledPanes(
      scanDeps({ listPanes: async () => { listed = true; return [pane()]; } }),
      '/leader',
      { ...OPTS, enabled: false },
    );
    expect(out).toEqual([]);
    expect(listed).toBe(false);
  });

  it('fails safe to no stalled resume on an unreadable/thrown pane list', async () => {
    expect(await scanStalledPanes(scanDeps({ listPanes: async () => null }), '/leader', OPTS)).toEqual([]);
    expect(
      await scanStalledPanes(
        scanDeps({ listPanes: async () => { throw new Error('herdr down'); } }),
        '/leader',
        OPTS,
      ),
    ).toEqual([]);
  });

  it('skips unresolvable-root and failed-fetch panes without aborting the scan', async () => {
    const panes: HerdrPaneRecord[] = [
      pane({ paneId: 'p1', label: `Downtime triggered implement Implement me - WL-A` }),
      pane({ paneId: 'p2', label: `Downtime triggered implement Implement me - WL-B` }),
      pane({ paneId: 'p3', label: `Downtime triggered implement Implement me - WL-C` }),
    ];
    const out = await scanStalledPanes(
      scanDeps({
        listPanes: async () => panes,
        resolveRoot: (p) => (p.paneId === 'p1' ? null : '/root'),
        fetchItem: async (id) => (id === 'WL-B' ? { ok: false } : { ok: true, info: item({ id, stage: scanStage(id) }) }),
      }),
      '/leader',
      OPTS,
    );
    expect(out.map((c) => c.pane.paneId)).toEqual(['p3']);
  });

  it('treats a thrown readEntries as an empty log (fail-open) and still classifies', async () => {
    const out = await scanStalledPanes(
      scanDeps({
        listPanes: async () => [pane({ paneId: 'p1', label: `Downtime triggered implement Implement me - WL-A` })],
        readEntries: async () => { throw new Error('log unreadable'); },
      }),
      '/leader',
      OPTS,
    );
    expect(out.map((c) => c.pane.paneId)).toEqual(['p1']);
  });

  it('skips audit/implement panes while frozen (split-by-skill) but keeps plan/intake', async () => {
    const panes: HerdrPaneRecord[] = [
      pane({ paneId: 'p1', label: `Downtime triggered audit Audit me - WL-AUDIT` }),
      pane({ paneId: 'p2', label: `Downtime triggered implement Implement me - WL-IMP` }),
      pane({ paneId: 'p3', label: `Downtime triggered plan Plan me - WL-PLAN` }),
      pane({ paneId: 'p4', label: `Downtime triggered intake Intake me - WL-INTAKE` }),
    ];
    const out = await scanStalledPanes(
      scanDeps({ listPanes: async () => panes }),
      '/leader',
      { ...OPTS, frozen: true },
    );
    expect(out.map((c) => c.kind)).toEqual(['plan', 'intake']);
  });

  it('ignores panes with no agent, no item id or no dispatch kind', async () => {
    const panes: HerdrPaneRecord[] = [
      pane({ paneId: 'p1', agent: undefined, label: `Downtime triggered plan Plan me - WL-A` }),
      pane({ paneId: 'p2', label: 'Downtime plan (no item id)' }),
      pane({ paneId: 'p3', label: `Manually triggered prompt hello - WL-C` }),
    ];
    let fetched = 0;
    const out = await scanStalledPanes(
      scanDeps({ listPanes: async () => panes, fetchItem: async (id) => { fetched += 1; return { ok: true, info: item({ id, stage: scanStage(id) }) }; } }),
      '/leader',
      OPTS,
    );
    expect(out).toEqual([]);
    expect(fetched).toBe(0);
  });

  // ── Model-cooldown candidate source (WL-0MV5639GG00085Q7) ──────────

  it('adds a DUE model-cooldown pane as a candidate before the generic stall threshold', async () => {
    const fresh = new Date(NOW - 1000).toISOString();
    const out = await scanStalledPanes(
      scanDeps({
        listPanes: async () => [pane({ paneId: 'p-cool' })],
        fetchItem: async (id) => ({ ok: true, info: item({ id, stage: 'plan_complete', updatedAt: fresh }) }),
        readStoredModelCooldowns: async () => [cooldown({ paneId: 'p-cool' })],
      }),
      '/leader',
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].pane.paneId).toBe('p-cool');
    expect(out[0].modelCooldown).toMatchObject({ paneId: 'p-cool', cooldownUntil: NOW - 1 });
  });

  it('strictness: an UNEXPIRED cooldown yields no candidate even past the generic threshold', async () => {
    const out = await scanStalledPanes(
      scanDeps({
        listPanes: async () => [pane({ paneId: 'p-cool' })],
        readStoredModelCooldowns: async () => [cooldown({ paneId: 'p-cool', cooldownUntil: NOW + 60 * 1000 })],
      }),
      '/leader',
      OPTS,
    );
    expect(out).toEqual([]);
  });

  it('prefers a due cooldown candidate over a generic stall candidate', async () => {
    const panes: HerdrPaneRecord[] = [
      pane({ paneId: 'p-stall', label: `Downtime triggered implement A - WL-STALL` }),
      pane({ paneId: 'p-cool', label: `Downtime triggered implement B - WL-COOL` }),
    ];
    const out = await scanStalledPanes(
      scanDeps({
        listPanes: async () => panes,
        readStoredModelCooldowns: async () => [cooldown({ paneId: 'p-cool' })],
      }),
      '/leader',
      OPTS,
    );
    expect(out.map((c) => [c.pane.paneId, c.modelCooldown !== null])).toEqual([
      ['p-cool', true],
      ['p-stall', false],
    ]);
  });

  it('fail-safe: a thrown/absent cooldown reader leaves the generic stall scan unchanged', async () => {
    const panes: HerdrPaneRecord[] = [
      pane({ paneId: 'p1', label: `Downtime triggered implement A - WL-A` }),
    ];
    const thrown = await scanStalledPanes(
      scanDeps({
        listPanes: async () => panes,
        readStoredModelCooldowns: async () => {
          throw new Error('cooldown unreadable');
        },
      }),
      '/leader',
      OPTS,
    );
    expect(thrown.map((c) => c.pane.paneId)).toEqual(['p1']);
    expect(thrown[0].modelCooldown).toBeNull();

    const absent = await scanStalledPanes(scanDeps({ listPanes: async () => panes }), '/leader', OPTS);
    expect(absent.map((c) => c.pane.paneId)).toEqual(['p1']);
    expect(absent[0].modelCooldown).toBeNull();
  });

  it('consumption: a successful resume clears the marker so the next scan does not re-wake it', async () => {
    const panes: HerdrPaneRecord[] = [pane({ paneId: 'p-cool' })];
    let cooldowns: ModelCooldownEntry[] = [cooldown({ paneId: 'p-cool' })];
    const fresh = new Date(NOW - 1000).toISOString();
    const deps = scanDeps({
      listPanes: async () => panes,
      fetchItem: async (id) => ({ ok: true, info: item({ id, stage: 'plan_complete', updatedAt: fresh }) }),
      readStoredModelCooldowns: async () => cooldowns,
    });

    const first = await scanStalledPanes(deps, '/leader', OPTS);
    expect(first.map((c) => c.pane.paneId)).toEqual(['p-cool']);

    // The resume consumes the marker (as the production clear seam does).
    const { deps: resumeDeps } = resumeController({
      clearCooldown: async () => {
        cooldowns = [];
        return true;
      },
    });
    const outcome = await resumeStalledPane(
      resumeInput({}, { updatedAt: fresh }, first[0].modelCooldown),
      resumeDeps,
    );
    expect(outcome).toMatchObject({ resumed: true });

    const second = await scanStalledPanes(deps, '/leader', OPTS);
    expect(second).toEqual([]);
  });
});
