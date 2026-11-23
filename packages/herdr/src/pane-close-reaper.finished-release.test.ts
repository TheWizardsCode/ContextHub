/**
 * packages/herdr/src/pane-close-reaper.finished-release.test.ts — free the
 * host dispatch-budget slot when a dispatch's Pi session is FINISHED
 * (WL-0MWJVY6NR001E0FS).
 *
 * The ledger entry used to be released only on **pane close** (or the 2 h
 * stale reap). A deliberately-open `implement` pane — and a terminal-status
 * `audit` pane caught by the dead-agent guard — therefore kept its tier slot
 * for the whole staleness window after the session had finished. The reaper
 * now releases a finished session's entry on its own cadence, independent of
 * any close, while leaving the pane open.
 *
 * Cases pinned here:
 *  1. `isSessionFinished` — marker OR terminal status; a still-working /
 *     unknown session is never finished.
 *  2. `implement` pane: release fires while the pane stays OPEN (never closed).
 *  3. `audit` pane with a terminal status: release fires though the
 *     dead-agent guard leaves the pane open.
 *  4. A still-working session keeps its entry.
 *  5. An unreadable / UNKNOWN pane read is a no-op (ledger untouched).
 *  6. Dry-run and a throwing release are non-mutating / fail-open.
 *  7. Identity safety + kind-genericity: the release removes only the finished
 *     pane's entry, and keys off the ledger entry's OWN kind.
 */
import { describe, expect, it, vi } from 'vitest';

import { isSessionFinished } from './pane-close.js';
import { createHerdrReaperDeps } from './pane-close-herdr.js';
import {
  finishedSessionReleaseIdentity,
  runReaper,
  type PaneStatus,
  type ReaperDeps,
} from './pane-close-reaper.js';
import {
  freshCount,
  readBudget,
  release,
  reserve,
  type HostBudgetEntry,
} from './host-dispatch-budget.js';
import { withMachineDir } from './host-dispatch-budget.fixtures.js';

const THRESHOLD_MS = 30 * 60 * 1000;

/** Build a minimal `PaneStatus` for fixture construction. */
function pane(overrides: Partial<PaneStatus> = {}): PaneStatus {
  return {
    id: 'pane-001',
    kind: 'plan',
    itemId: 'WL-TEST001',
    title: 'Test pane',
    lastAssistantText: '',
    agentProcessAlive: true,
    idleMs: 0,
    needsProducerReview: false,
    isInvokingPane: false,
    childProcessCount: 0,
    ...overrides,
  };
}

/** `ReaperDeps` returning `panes`, with a spy-free baseline. */
function makeDeps(panes: PaneStatus[]): ReaperDeps {
  return {
    listPanes: vi.fn().mockResolvedValue(panes),
    closePane: vi.fn().mockResolvedValue({ success: true }),
    terminateProcessGroup: vi.fn().mockResolvedValue({ terminated: true }),
  };
}

// ── 1. The shared "session is finished" predicate ─────────────────────

describe('isSessionFinished — marker OR terminal status (WL-0MWJVY6NR001E0FS AC1/AC5/AC6)', () => {
  it('is finished when the final assistant message ends with </end_session>', () => {
    expect(isSessionFinished({ lastAssistantText: 'All done\n\n</end_session>' })).toBe(true);
  });

  it.each(['done', 'exited', 'DONE', 'Exited'])(
    'is finished when the herdr agent status is terminal (%s)',
    (status) => {
      expect(isSessionFinished({ lastAssistantText: '', agentStatus: status })).toBe(true);
    },
  );

  it('is NOT finished when the agent is working and the message lacks the marker', () => {
    expect(isSessionFinished({ lastAssistantText: 'Working…', agentStatus: 'work' })).toBe(false);
  });

  it('is NOT finished for an unknown/empty status with no marker', () => {
    expect(isSessionFinished({ lastAssistantText: 'hello', agentStatus: 'unknown' })).toBe(false);
    expect(isSessionFinished({ lastAssistantText: 'hello', agentStatus: '' })).toBe(false);
    expect(isSessionFinished({ lastAssistantText: '' })).toBe(false);
    expect(isSessionFinished({})).toBe(false);
  });

  it('treats an explicit marker as authoritative even with a working status', () => {
    expect(isSessionFinished({ lastAssistantText: 'done\n</end_session>', agentStatus: 'work' })).toBe(true);
  });
});

// ── 2/3/4/5/6. Reaper wiring ──────────────────────────────────────────

describe('reaper — finished-session budget release (WL-0MWJVY6NR001E0FS)', () => {
  it('AC1: releases a finished IMPLEMENT pane budget without closing the pane', async () => {
    const panes = [
      pane({
        id: 'p-impl',
        kind: 'implement',
        itemId: 'WL-IMPL',
        lastAssistantText: 'Reached in_review\n\n</end_session>',
      }),
    ];
    const deps = { ...makeDeps(panes), releaseFinishedSessionBudget: vi.fn().mockResolvedValue(undefined) };

    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });

    expect(deps.releaseFinishedSessionBudget).toHaveBeenCalledTimes(1);
    expect(deps.releaseFinishedSessionBudget).toHaveBeenCalledWith(panes[0]);
    // The "never auto-close an implement pane" policy is unchanged.
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.close).toBe(false);
    expect(results[0].decision.reasonCode).toBe('implement');
  });

  it('AC2: releases a finished AUDIT pane whose terminal status leaves it open (dead-agent guard)', async () => {
    const panes = [
      pane({
        id: 'p-audit',
        kind: 'audit',
        itemId: 'WL-AUDIT',
        lastAssistantText: 'Audit complete.',
        agentStatus: 'done',
        agentProcessAlive: false,
        idleMs: 1_000,
      }),
    ];
    const deps = { ...makeDeps(panes), releaseFinishedSessionBudget: vi.fn().mockResolvedValue(undefined) };

    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });

    expect(deps.releaseFinishedSessionBudget).toHaveBeenCalledTimes(1);
    expect(deps.closePane).not.toHaveBeenCalled();
    expect(results[0].decision.close).toBe(false);
    expect(results[0].decision.reasonCode).toBe('dead-agent');
  });

  it('AC5: a still-working session keeps its entry (no release)', async () => {
    const panes = [
      pane({
        id: 'p-live',
        kind: 'implement',
        itemId: 'WL-LIVE',
        lastAssistantText: 'Still working on the task',
        agentStatus: 'work',
        agentProcessAlive: true,
        idleMs: 1_000,
      }),
    ];
    const deps = { ...makeDeps(panes), releaseFinishedSessionBudget: vi.fn().mockResolvedValue(undefined) };

    await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });

    expect(deps.releaseFinishedSessionBudget).not.toHaveBeenCalled();
  });

  it('AC6: an unreadable/UNKNOWN pane read is a no-op — the release never runs', async () => {
    const releaseFinishedSessionBudget = vi.fn().mockResolvedValue(undefined);
    // A failed pane read makes `createHerdrReaperDeps.listPanes()` fail closed
    // to an empty list — no pane is ever classified, so nothing is released.
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockRejectedValue(new Error('herdr unavailable')),
      closePane: vi.fn().mockResolvedValue(true),
      releaseFinishedSessionBudget,
    });

    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });

    expect(results).toHaveLength(0);
    expect(releaseFinishedSessionBudget).not.toHaveBeenCalled();
  });

  it('AC1: does NOT release on a dry run (report-only passes never mutate the ledger)', async () => {
    const panes = [
      pane({ kind: 'implement', lastAssistantText: 'done\n</end_session>' }),
    ];
    const deps = { ...makeDeps(panes), releaseFinishedSessionBudget: vi.fn().mockResolvedValue(undefined) };

    await runReaper(deps, { idleThresholdMs: THRESHOLD_MS, dryRun: true });

    expect(deps.releaseFinishedSessionBudget).not.toHaveBeenCalled();
  });

  it('AC4: a throwing release is fail-open and never changes the run result', async () => {
    const panes = [
      pane({ id: 'p-impl', kind: 'implement', lastAssistantText: 'done\n</end_session>' }),
    ];
    const deps = {
      ...makeDeps(panes),
      releaseFinishedSessionBudget: vi.fn().mockRejectedValue(new Error('ledger down')),
    };

    const results = await runReaper(deps, { idleThresholdMs: THRESHOLD_MS });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('forwards the finished-session release seam through the production deps factory', async () => {
    const releaseFinishedSessionBudget = vi.fn().mockResolvedValue(undefined);
    const deps = createHerdrReaperDeps({
      listPanesRaw: vi.fn().mockResolvedValue(JSON.stringify({ panes: [] })),
      closePane: vi.fn().mockResolvedValue(true),
      releaseFinishedSessionBudget,
    });
    const target = pane({ id: 'p-x', itemId: 'WL-X' });
    await deps.releaseFinishedSessionBudget?.(target);
    expect(releaseFinishedSessionBudget).toHaveBeenCalledWith(target);
  });
});

// ── 7. Identity safety + kind-genericity ──────────────────────────────

/** Reserve one entry (failing the test when reservation fails). */
function reserveEntry(
  dir: string,
  input: { kind: 'implement' | 'audit'; itemId: string; paneId?: string },
): HostBudgetEntry {
  const result = reserve(
    {
      kind: input.kind,
      itemId: input.itemId,
      instanceId: `instance-${input.kind}`,
      root: '/repo/test',
      ...(input.paneId !== undefined ? { paneId: input.paneId } : {}),
    },
    { dir },
  );
  if (!result.ok) throw new Error(`reserve failed: ${result.reason}`);
  return result.entry;
}

/** The stored entries, for "what survived" assertions. */
function storedEntries(dir: string): HostBudgetEntry[] {
  const read = readBudget({ dir });
  if (!read.ok) throw new Error(`ledger unreadable: ${read.reason}`);
  return read.ledger.entries;
}

describe('finished-session release identity (WL-0MWJVY6NR001E0FS AC3/AC7)', () => {
  it('builds an identity from the finished pane with NO hard-coded kind (kind-generic)', () => {
    const identity = finishedSessionReleaseIdentity({ itemId: 'WL-1', id: 'w1:p9' });
    expect(identity).toEqual({ itemId: 'WL-1', paneId: 'w1:p9' });
    // Keys off the ledger entry's OWN kind: no `kind` field is supplied, so a
    // future capped skill kind is covered with no change here.
    expect(Object.prototype.hasOwnProperty.call(identity, 'kind')).toBe(false);
  });

  it('AC3: removes only the finished pane entry and never a sibling dispatch for the same item', async () => {
    await withMachineDir((dir) => {
      // Same work item dispatched twice: an implement pane and an audit pane.
      reserveEntry(dir, { kind: 'implement', itemId: 'WL-BOTH', paneId: 'w1:p-impl' });
      reserveEntry(dir, { kind: 'audit', itemId: 'WL-BOTH', paneId: 'w1:p-audit' });

      // The implement pane's session finishes first — release ONLY its entry.
      const identity = finishedSessionReleaseIdentity({ itemId: 'WL-BOTH', id: 'w1:p-impl' });
      const result = release(identity, { dir });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.removed).toBe(true);
        expect(result.refused).toBe(false);
      }
      const survivors = storedEntries(dir);
      expect(survivors).toHaveLength(1);
      expect(survivors[0]).toMatchObject({ kind: 'audit', paneId: 'w1:p-audit' });
    });
  });

  it('AC2: the audit tier count drops on session finish (no 2 h staleness wait)', async () => {
    await withMachineDir((dir) => {
      reserveEntry(dir, { kind: 'audit', itemId: 'WL-AUDIT', paneId: 'w1:p-audit' });
      const before = freshCount('audit', { dir });
      expect(before.ok && before.count).toBe(1);

      // The finished session's release runs on the reaper cadence.
      release(finishedSessionReleaseIdentity({ itemId: 'WL-AUDIT', id: 'w1:p-audit' }), { dir });

      const after = freshCount('audit', { dir });
      expect(after.ok && after.count).toBe(0);
    });
  });

  it('AC7: releases either kind identically (kind keys off the entry, not the caller)', async () => {
    for (const finishedKind of ['implement', 'audit'] as const) {
      await withMachineDir((dir) => {
        reserveEntry(dir, { kind: 'implement', itemId: 'WL-K', paneId: 'w1:p-impl' });
        reserveEntry(dir, { kind: 'audit', itemId: 'WL-K', paneId: 'w1:p-audit' });

        const paneId = finishedKind === 'implement' ? 'w1:p-impl' : 'w1:p-audit';
        const result = release(finishedSessionReleaseIdentity({ itemId: 'WL-K', id: paneId }), { dir });

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.removed).toBe(true);
        const survivors = storedEntries(dir);
        expect(survivors).toHaveLength(1);
        expect(survivors[0].kind).toBe(finishedKind === 'implement' ? 'audit' : 'implement');
      });
    }
  });
});
