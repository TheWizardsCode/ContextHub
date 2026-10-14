/**
 * packages/herdr/src/downtime-worker.assignee-claim.test.ts — dispatch/claim
 * contracts for the status-neutral audit-tier claim (epic WL-0MV82CHGQ000HAZZ,
 * test-first child WL-0MV85WARS000THEC; implementation child C4
 * WL-0MV85WCJJ0087VMP).
 *
 * The audit-tier claim must be STATUS-NEUTRAL: it changes only the assignee
 * (CAS-guarded), so an audited `completed`/`in_review` item never enters the
 * `in-progress`/`in_review` hybrid that stranding autocracies were built on
 * (root cause WL-0MV7W77AY005MGBL). Tests here pin:
 *
 *   AC1/AC5 — herdr dispatch claim → simulated audit Phase-2 failure → item
 *             back at completed/in_review, re-selectable (no
 *             needsProducerReview-column dependency).
 *   C4 AC    — `claimWorkItem` is status-neutral for the audit tier (writes
 *             NO --status/--stage); `rollbackClaimWorkItem` clears the
 *             assignee guarded by `--if-assignee <agent>`.
 *   C4 AC    — `selectAuditCandidate` excludes audit candidates with a
 *             non-empty assignee (the scheduling hold).
 *
 * The dispatch-level claim→failure→rollback→re-selection WIRING is already
 * covered by the existing audit-tier suite (WL-0MT32F908002YFFA /
 * WL-0MSRBFFLN005W3VT markers + rollbacks); this file pins the parts that
 * CHANGE under Option A — the fetcher command shape and the assignee-based
 * selection exclusion — plus one cross-seam regression that runs the real
 * fetcher against a real shared DB through a small wl-command interpreter
 * (a harness that maps emitted CLI args onto `updateIfMatches`; the CAS
 * primitive itself is the production code under test).
 *
 * Test-first discipline: specs that pin the TARGET (unimplemented) behaviour
 * are committed under vitest `it.fails(...)` (expected-failure) so the
 * suite stays green while the contract is red; C4 flips `it.fails(` → `it(`
 * as it lands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorklogDatabase } from '@worklog/shared';
import { claimWorkItem, rollbackClaimWorkItem, setExecFileAsync, resetExecFileAsync } from './fetcher.js';
import { selectAuditCandidate, type AuditCandidate } from './downtime-worker.js';

// ── Test seam: a minimal wl-command interpreter over a real shared DB ──
//
// `claimWorkItem`/`rollbackClaimWorkItem` shell out to the `wl` CLI through
// `execFileAsync`. This harness replaces that seam with an interpreter that
// maps the emitted CLI args onto the shared DB's `updateIfMatches` CAS
// primitive — so the spec exercises the real fetcher arg construction and
// the real database semantics without subprocess latency. It covers only
// the update surface the contracts above rely on.
type FakeExecResult = { stdout: string; stderr?: string };
function makeWlInterpreter(db: WorklogDatabase) {
  return async (_binary: string, args: string[]): Promise<FakeExecResult> => {
    // Args arrive as [<global...>, 'update', <id>, <key>, <value>...] with a
    // trailing '--json'. Normalise by locating the 'update' token.
    const cmdIdx = args.findIndex((a) => a === 'update');
    if (cmdIdx === -1) {
      throw new Error(JSON.stringify({ success: false, error: 'unsupported-command', args }));
    }
    const id = args[cmdIdx + 1];
    const opts: Record<string, string> = {};
    for (let i = cmdIdx + 2; i < args.length; i += 1) {
      if (args[i].startsWith('--') && i + 1 < args.length) {
        opts[args[i].slice(2)] = args[i + 1];
        i += 1;
      }
    }

    const input: Record<string, string> = {};
    if (opts.assignee !== undefined) input.assignee = opts.assignee;
    if (opts.status !== undefined) input.status = opts.status;
    if (opts.stage !== undefined) input.stage = opts.stage;

    const expected: Record<string, string> = {};
    if (opts['if-status'] !== undefined) expected.status = opts['if-status'];
    if (opts['if-stage'] !== undefined) expected.stage = opts['if-stage'];
    if (opts['if-assignee'] !== undefined) expected.assignee = opts['if-assignee'];

    const result = db.updateIfMatches(id, input, expected);
    if (result.ok) {
      return { stdout: JSON.stringify({ success: true, workItem: result.item }) };
    }
    if (result.reason === 'stale') {
      throw new Error(JSON.stringify({ success: false, error: 'stale' }));
    }
    throw new Error(JSON.stringify({ success: false, error: 'not-found' }));
  };
}

const FIXED_TS = '2026-01-01T00:00:00.000Z';

function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'WL-AUD',
    title: 'Review me',
    description: 'needs audit',
    status: 'completed',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
    tags: [],
    assignee: '',
    stage: 'in_review',
    issueType: 'task',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    needsProducerReview: false,
    ...overrides,
  };
}

describe('status-neutral audit-tier claim (WL-0MV85WARS000THEC)', () => {
  beforeEach(() => {
    resetExecFileAsync();
  });

  afterEach(() => {
    resetExecFileAsync();
  });

  // ── C4 AC: claimWorkItem command shape ────────────────────────────

  it.fails('claimWorkItem for the audit tier is status-neutral: assignee CAS only, no --status/--stage', async () => {
    const recorded: string[][] = [];
    setExecFileAsync((async (_b: string, args: string[]) => {
      recorded.push(args);
      return { stdout: '{"success":true}' };
    }) as any);

    const result = await claimWorkItem('WL-AUD', 'audit-tier', { status: 'completed', stage: 'in_review' });
    expect(result.success).toBe(true);

    const callArgs = recorded[0];
    // The audit tier must NOT flip the item to in_progress (the hybrid the
    // failure-restore path could not represent) — no status/stage writes.
    expect(callArgs).not.toContain('--status');
    expect(callArgs).not.toContain('--stage');
    // The claim IS a guarded assignee write: the item is only claimed while
    // it is still audit-bucket AND still unassigned.
    expect(callArgs[callArgs.indexOf('--assignee') + 1]).toBe('audit-tier');
    expect(callArgs[callArgs.indexOf('--if-status') + 1]).toBe('completed');
    expect(callArgs[callArgs.indexOf('--if-stage') + 1]).toBe('in_review');
    expect(callArgs[callArgs.indexOf('--if-assignee') + 1]).toBe('');
  });

  it('non-audit tiers keep the status-flip claim (in_progress) — unchanged behaviour', async () => {
    const recorded: string[][] = [];
    setExecFileAsync((async (_b: string, args: string[]) => {
      recorded.push(args);
      return { stdout: '{"success":true}' };
    }) as any);

    await claimWorkItem('WL-IMP', 'Map', { status: 'open', stage: 'plan_complete' });

    const callArgs = recorded[0];
    expect(callArgs[callArgs.indexOf('--status') + 1]).toBe('in_progress');
    expect(callArgs).not.toContain('--if-assignee');
  });

  // ── C4 AC: rollbackClaimWorkItem command shape ────────────────────

  it.fails('rollbackClaimWorkItem for the audit tier clears the assignee guarded by --if-assignee <agent>', async () => {
    const recorded: string[][] = [];
    setExecFileAsync((async (_b: string, args: string[]) => {
      recorded.push(args);
      return { stdout: '{"success":true}' };
    }) as any);

    const ok = await rollbackClaimWorkItem(
      'WL-AUD',
      // Contract: the claimed agent rides on the original expected state;
      // only THIS claim's assignee may be cleared (no clobbering).
      { status: 'completed', stage: 'in_review', assignee: 'audit-tier' } as any,
    );
    expect(ok).toBe(true);

    const callArgs = recorded[0];
    expect(callArgs).toContain('update');
    expect(callArgs).toContain('--assignee');
    expect(callArgs[callArgs.indexOf('--assignee') + 1]).toBe('');
    expect(callArgs[callArgs.indexOf('--if-assignee') + 1]).toBe('audit-tier');
    // Status-neutral rollback: never rewrites status/stage (keeps the item
    // at completed/in_review without a hybrid write).
    expect(callArgs).not.toContain('--status');
    expect(callArgs).not.toContain('--stage');
  });

  // ── AC1/AC5 regression: claim → simulated audit Phase-2 failure ─────
  // The item must read back completed/in_review (never a hybrid) and be
  // RE-SELECTABLE by the audit tier without any needsProducerReview column.

  it.fails('dispatch claim → simulated audit Phase-2 failure → completed/in_review again, re-selectable', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'wl-herdr-assignee-'));
    const db = new WorklogDatabase('TEST', join(tempDir, 'worklog.db'), join(tempDir, 'data.jsonl'), true);
    try {
      db.import([makeItem()] as any);

      setExecFileAsync(makeWlInterpreter(db) as any);

      // Phase 1: the herdr audit dispatcher claims the item.
      const claim = await claimWorkItem('WL-AUD', 'audit-tier', { status: 'completed', stage: 'in_review' });
      expect(claim.success).toBe(true);

      // Between claim and Phase-2 completion the item stays in the audit
      // bucket — never in-progress/in_review.
      let stored = db.get('WL-AUD');
      expect(stored?.status).toBe('completed');
      expect(stored?.stage).toBe('in_review');
      expect(stored?.assignee).toBe('audit-tier');

      // Phase 2 FAILS (timeout/infra) → the guarded rollback releases the
      // claim.
      const rollbackOk = await rollbackClaimWorkItem(
        'WL-AUD',
        { status: 'completed', stage: 'in_review', assignee: 'audit-tier' } as any,
      );
      expect(rollbackOk).toBe(true);

      // The item is back at completed/in_review — and the claim residue is
      // gone (assignee cleared) — no needsProducerReview involvement.
      stored = db.get('WL-AUD');
      expect(stored?.status).toBe('completed');
      expect(stored?.stage).toBe('in_review');
      expect(stored?.assignee).toBe('');
      expect(stored?.needsProducerReview).toBe(false);

      // Re-selectable: the audit tier's own selector picks it again.
      const candidate: AuditCandidate = {
        id: 'WL-AUD',
        title: 'Review me',
        auditedAt: null, // missing → not fresh → eligible for re-dispatch
        updatedAt: new Date().toISOString(),
        sortIndex: 0,
      };
      expect(selectAuditCandidate([candidate], Date.now())?.id).toBe('WL-AUD');
    } finally {
      resetExecFileAsync();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ── C4 AC: scheduling hold — assigned items are not audit-selected ──

  it.fails('selectAuditCandidate excludes audit candidates with a non-empty assignee', () => {
    const now = Date.now();
    const due: AuditCandidate = {
      id: 'WL-FREE',
      title: 'Free to audit',
      auditedAt: null,
      updatedAt: new Date(now - 3600_000).toISOString(),
      sortIndex: 1,
    };
    // The producer-hold item would win on sortIndex but must be excluded.
    const held = {
      ...due,
      id: 'WL-HELD',
      assignee: 'producer',
      sortIndex: 0,
    } as AuditCandidate;

    const selected = selectAuditCandidate([held, due], now);
    expect(selected?.id).toBe('WL-FREE');
  });
});
