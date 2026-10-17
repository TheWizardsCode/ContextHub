/**
 * packages/herdr/src/downtime-worker.sprint-view.test.ts — Herdr-head
 * critical-first scan and sprint-view dispatch-window tests.
 *
 * Split out of the monolithic `downtime-worker.test.ts`
 * (WL-0MV28X3SL005R5KX / WL-0MV4VMEHO005X1QQ) to keep each test file focused
 * on one concern and under the 2,000-line cap. Covers:
 *   - the critical-first scan on the live Herdr-head dispatch path
 *     (`WL-0MU6UL3XY001M3VT`),
 *   - `needsProducerReview` threading on the Herdr-head dispatch path
 *     (`WL-0MU72WJ8C0005GIE`),
 *   - RCA in-flight critical re-dispatch and one-dispatch-per-in-flight
 *     guarantees (`WL-0MUBEZ6PE002WLP4`, `WL-0MUBVKS5I007LSWB`),
 *   - the sprint-view-only dispatch window (`WL-0MUNS8X97007C9H9`),
 *   - dispatched success-marker staleness (`WL-0MU6UL0RJ008IHGT`), and
 *   - the non-terminal pane-close cooldown (`WL-0MUKYERLZ006ELL5`).
 *
 * Shared scaffolding (`makeDeps` and the other fixtures) is imported from
 * `downtime-worker.fixtures.ts`; no setup logic is re-implemented here.
 * The critical selection / review-queue tests live in
 * `downtime-worker.critical-first.test.ts`.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  computeMostImportantItem,
  dispatchDowntimeWork,
  fetchExtendedHerdrItems,
  selectCriticalFirstCandidates,
  DOWNTIME_DISPATCH_EXTEND_MAX,
  DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS,
  type DowntimeHerdrItem,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import {
  ago,
  createTempDirTracker,
  makeDeps,
  writeDowntimeLog,
} from './downtime-worker.fixtures.js';

// ── Critical-first scan on Herdr-head path (WL-0MU6UL3XY001M3VT) ──────
// Regression tests for the critical-first scan that bypasses non-safety
// filters (dispatched-marker, review-queue gate) for critical items on
// the Herdr-head dispatch path.

describe('critical-first scan on Herdr-head path (WL-0MU6UL3XY001M3VT)', () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();

  const criticalPlanned = (id: string): DowntimeHerdrItem => ({
    id, title: `Critical plan ${id}`, status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'critical',
    sortIndex: 10,
  });
  const criticalIdea = (id: string): DowntimeHerdrItem => ({
    id, title: `Critical idea ${id}`, status: 'open', stage: 'idea',
    priority: 'critical',
    sortIndex: 20,
  });
  const criticalIntake = (id: string): DowntimeHerdrItem => ({
    id, title: `Critical intake ${id}`, status: 'open', stage: 'intake_complete',
    priority: 'critical',
    sortIndex: 30,
  });
  const nonCriticalImplement = (id: string): DowntimeHerdrItem => ({
    id, title: `Implement ${id}`, status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'medium',
    sortIndex: 100,
  });

  describe('AC4(a) — critical item bypasses non-safety filters', () => {
    it('a critical item with a stale dispatched marker dispatches ahead of a non-critical item', async () => {
      // End-to-end incident simulation: a critical plan item carries a
      // STANDING implement dispatch marker in the rolling log (its
      // implementation aborted → status reset to open, marker never
      // cleared). The normal loop would skip it forever; the critical-first
      // scan must bypass the marker and escalate it ahead of the
      // non-critical item.
      const root = mkdtempSync(join(tmpdir(), 'herdr-crit-scan-marker-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date(now - 3_600_000).toISOString(),
          cwd: root,
          kind: 'implement',
          itemId: 'CR-1',
          stage: 'plan_complete',
          dispatchedAt: new Date(now - 3_600_000).toISOString(),
          message: 'Dispatched CR-1',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
            criticalPlanned('CR-1'),
            nonCriticalImplement('IMP-1'),
          ]}),
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
        });

        const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        expect(outcome.dispatched).toBe(true);
        expect(outcome.kind).toBe('implement');
        expect(outcome.candidate?.id).toBe('CR-1');
        // Observable contract: claimItem boundary CAS call
        expect(deps.claimItem).toHaveBeenCalledWith(
          'CR-1', { status: 'open', stage: 'plan_complete' }, root,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('critical item dispatches via risk-effort tier when stage is in_progress', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          {
            id: 'CR-2', title: 'Critical retired stage', status: 'open',
            stage: 'in_progress', priority: 'critical',
            risk: 'Low', effort: 'S', sortIndex: 10,
          },
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('risk-effort');
      expect(outcome.candidate?.id).toBe('CR-2');
    });

    it('a critical plan item dispatches via the plan tier (intake_complete stage)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalIntake('CR-PLAN'),
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('CR-PLAN');
    });

    it('a critical idea item dispatches via the intake tier', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalIdea('CR-INTAKE'),
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('intake');
      expect(outcome.candidate?.id).toBe('CR-INTAKE');
    });
  });

  describe('AC4(b) — safety gates block critical escalation', () => {
    it('needsProducerReview === true blocks a critical item from critical-first scan', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          {
            ...criticalPlanned('CR-PR'),
            needsProducerReview: true,
          },
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      // Safety gate blocks critical → falls through to non-critical.
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('IMP-1');
    });

    it('code-freeze blocks critical implement but allows critical plan/intake', async () => {
      const freezeDeps = makeDeps({
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalPlanned('CR-FREEZE-IMP'),
          criticalIntake('CR-FREEZE-PLAN'),
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(freezeDeps, { model: 'plan', cwd: '/repo' });

      // Critical implement is freeze-blocked; critical plan dispatches.
      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('CR-FREEZE-PLAN');
    });

    it('active-audit single-flight is audit-tier scoped: an in-flight audit does not block open critical escalation', async () => {
      // The active-audit single-flight gate filters AUDIT-kind candidates
      // (a second audit pane must not start). An OPEN critical item is never
      // audit-kind, so — matching the legacy critical-tier ordering — it is
      // escalated even while an audit is in flight.
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalPlanned('CR-AUDIT'),
          nonCriticalImplement('IMP-1'),
        ]}),
        getActiveAudit: vi.fn().mockResolvedValue({ ok: true, active: true }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('CR-AUDIT');
    });
  });

  describe('lowest sortIndex wins when multiple critical items exist', () => {
    it('dispatches the lowest-sortIndex critical item first', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          criticalPlanned('CR-2'),  // sortIndex: 10
          criticalIdea('CR-1'),    // sortIndex: 20
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      // CR-2 has lower sortIndex (10) than CR-1 (20).
      expect(outcome.candidate?.id).toBe('CR-2');
    });
  });

  describe('no critical items — normal processing unchanged', () => {
    it('non-critical items dispatch as usual when no critical items exist', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [
          nonCriticalImplement('IMP-1'),
        ]}),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('IMP-1');
    });
  });
});

// ── Herdr-head dispatch threads needsProducerReview (WL-0MU72WJ8C0005GIE) ──
//
// The live Herdr-head dispatch path (`dispatchFromHerdrList` → normal scan)
// builds its `classifyItemForDispatch` input from the Herdr item fields. Before
// the fix (022f1b24) it OMITTED `needsProducerReview`, so a non-critical item
// flagged for producer review was dispatched anyway — even though the offer
// path (`computeMostImportantItem`, which passes the item object directly)
// already honoured the flag. These tests pin AC1–AC3: the flag blocks a
// non-critical plan_complete / idea candidate, the direct path agrees with the
// offer path, and clearing the flag restores dispatchability.

describe('Herdr-head dispatch threads needsProducerReview (WL-0MU72WJ8C0005GIE)', () => {
  const implementItem = (id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem => ({
    id,
    title: `Non-critical ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'medium',
    risk: 'Low',
    effort: 'S',
    sortIndex: 10,
    ...overrides,
  });

  const intakeItem = (id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem => ({
    id,
    title: `Idea ${id}`,
    status: 'open',
    stage: 'idea',
    priority: 'medium',
    sortIndex: 10,
    ...overrides,
  });

  const dispatchDeps = (items: DowntimeHerdrItem[]): DowntimeWorkerDeps => makeDeps({
    getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items }),
    claimItem: vi.fn().mockResolvedValue({ ok: true }),
    spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
    recordDispatch: vi.fn().mockResolvedValue(true),
  });

  describe('AC2 — the flag blocks a non-critical candidate on dispatchDowntimeWork', () => {
    it('blocks a plan_complete item (implement) and dispatches the next eligible item', async () => {
      const deps = dispatchDeps([
        implementItem('NPR-GATED', { needsProducerReview: true, sortIndex: 1 }),
        implementItem('NPR-ALLOWED', { needsProducerReview: false, sortIndex: 2 }),
      ]);

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('NPR-ALLOWED');
      // The gated item was never claimed.
      // Observable contract: negative boundary assertion — proves claimItem NOT called for blocked items; unique NOP coverage
      expect(deps.claimItem).not.toHaveBeenCalledWith('NPR-GATED', expect.any(Object), '/repo');
    });

    it('blocks an idea item (intake) and dispatches the next eligible item', async () => {
      const deps = dispatchDeps([
        intakeItem('NPR-IDEA-GATED', { needsProducerReview: true, sortIndex: 1 }),
        intakeItem('NPR-IDEA-ALLOWED', { needsProducerReview: false, sortIndex: 2 }),
      ]);

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('intake');
      expect(outcome.candidate?.id).toBe('NPR-IDEA-ALLOWED');
      // Observable contract: negative boundary assertion — proves claimItem NOT called for blocked items; unique NOP coverage
      expect(deps.claimItem).not.toHaveBeenCalledWith('NPR-IDEA-GATED', expect.any(Object), '/repo');
    });

    it('dispatches nothing when every candidate is review-gated', async () => {
      const deps = dispatchDeps([
        implementItem('NPR-ONLY', { needsProducerReview: true }),
      ]);

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(deps.claimItem).not.toHaveBeenCalled();
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    });

    it('clearing the flag restores dispatchability (same item shape)', async () => {
      const gated = implementItem('NPR-CLEAR', { needsProducerReview: true });
      const blocked = await dispatchDowntimeWork(dispatchDeps([gated]), { model: 'plan', cwd: '/repo' });
      expect(blocked.dispatched).toBe(false);

      gated.needsProducerReview = false;
      const released = await dispatchDowntimeWork(dispatchDeps([gated]), { model: 'plan', cwd: '/repo' });
      expect(released.dispatched).toBe(true);
      expect(released.candidate?.id).toBe('NPR-CLEAR');
    });
  });

  describe('AC3 — direct and offer paths agree on the producer-review gate', () => {
    it('both the direct dispatch and the offer skip the gated item and pick the same next item', async () => {
      const items = [
        implementItem('NPR-PARITY-GATED', { needsProducerReview: true, sortIndex: 1 }),
        implementItem('NPR-PARITY-ALLOWED', { needsProducerReview: false, sortIndex: 2 }),
      ];

      const direct = await dispatchDowntimeWork(dispatchDeps(items), { model: 'plan', cwd: '/repo' });
      const offer = await computeMostImportantItem(dispatchDeps(items), '/repo');

      expect(direct.dispatched).toBe(true);
      expect(direct.candidate?.id).toBe('NPR-PARITY-ALLOWED');
      expect(offer).toMatchObject({ ok: true, candidate: { id: 'NPR-PARITY-ALLOWED' } });
    });

    it('the offer reports no candidate when every candidate is review-gated', async () => {
      const offer = await computeMostImportantItem(
        dispatchDeps([implementItem('NPR-OFFER-ONLY', { needsProducerReview: true })]),
        '/repo',
      );

      expect(offer).toMatchObject({ ok: true, noCandidate: true });
    });
  });
});

// ── RCA: duplicate re-dispatch of a critical in-flight item ─────────────
// Parent WL-0MUBEZ6PE002WLP4 / F1 WL-0MUBVKPLP006RRDJ (AC1.1).
//
// RED WITNESS (pre-fix). The critical-first scan
// (`dispatchFromHerdrList` → `selectCriticalFirstCandidates`) bypasses the
// dispatched-marker exclusion UNCONDITIONALLY, so the only thing preventing a
// second dispatch is the CAS claim inside `dispatchClaimedTier`. When the
// item's status has reverted to `open` at its marker's stage (H5 — e.g. an
// aborted `implement.py start` reset it, or `wl reviewed <id> true` released
// it) while the first dispatch's pane is still live, the CAS succeeds and a
// SECOND pane is spawned for the same in-flight item. H1 (marker bypass)
// therefore cannot duplicate on its own; H1+H5 is the confirmed pair.
//
// The item is modelled as `open` at `plan_complete` on BOTH cycles (the
// status revert) with a live `working` downtime pane whose label suffix is
// the item id (the in-flight signal F3 consumes) and a fresh marker in the
// rolling log (written by cycle 1's dispatch). The claim is stubbed to
// succeed on both cycles, matching the genuine DB `open` state.
//
// `it.fails` keeps the suite green while the defect is open: the test body
// asserts the FIXED behaviour and therefore fails pre-fix. F3
// (WL-0MUBVKXQJ000L8EO) flips it to `it` once the item-scoped in-flight
// guard lands; the RED→GREEN transition is the AC5.5 dependency evidence.
describe('RCA: critical in-flight re-dispatch with a live pane (WL-0MUBEZ6PE002WLP4 / AC1.1)', () => {
  const criticalInFlight = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Critical in-flight ${id}`,
    status: 'open',
    stage: 'plan_complete',
    risk: 'Low',
    effort: 'S',
    priority: 'critical',
    sortIndex: 10,
  });

  it(
    'two idle cycles over a critical item open at its marker stage with a live pane dispatch exactly once (RED pre-fix)',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'herdr-crit-inflight-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      // A fresh implement marker written by cycle 1's dispatch — the item is
      // STILL at the marker's dispatched-at stage (`plan_complete`) on cycle 2.
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date().toISOString(),
          cwd: root,
          kind: 'implement',
          itemId: 'CR-DUP',
          stage: 'plan_complete',
          dispatchedAt: new Date().toISOString(),
          message: 'Dispatched CR-DUP',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          // The item is re-observed OPEN at its marker's stage on every cycle
          // (the status revert, H5). The critical-first scan re-selects it.
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalInFlight('CR-DUP')] }),
          // The CAS claim succeeds on both cycles because the DB genuinely
          // says `open` at `plan_complete` (H5 is the necessary partner of H1).
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
          // Cycle 1 sees NO pane (the dispatch has not happened yet); by cycle
          // 2 the spawned pane is live and `working`. Pre-fix
          // `dispatchFromHerdrList` never consults this, so cycle 2 duplicates.
          getRunningDowntimePanes: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
            .mockResolvedValue({
              ok: true,
              count: 1,
              paneIds: ['w1:p1'],
              records: [
                {
                  paneId: 'w1:p1',
                  label: 'Downtime triggered implement Critical in-flight CR-DUP - CR-DUP',
                  agent: 'pi',
                  agentStatus: 'working',
                },
              ],
            }),
        });

        const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });
        const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        // Cycle 1 dispatches the critical item.
        expect(first.dispatched).toBe(true);
        expect(first.candidate?.id).toBe('CR-DUP');
        // Cycle 2 must NOT dispatch: a live working pane for the item exists.
        // Pre-fix this observes 2 spawns (the duplicate); post-fix exactly 1.
        expect(second.dispatched).toBe(false);
        expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

// ── Regression: one dispatch per in-flight critical item (F2) ──────────
// Parent WL-0MUBEZ6PE002WLP4 / F2 WL-0MUBVKS5I007LSWB (AC5.1, AC5.3,
// AC5.4, AC5.6). Promotes F1's RED witness
// (WL-0MUBVKPLP006RRDJ) into the permanent, path-covering suite.
//
// The critical-first scan bypasses the dispatched-marker exclusion
// UNCONDITIONALLY and the CAS claim succeeds when the item's status has
// reverted to `open` at its marker's stage (H5), so a live pane does not
// currently prevent a second dispatch. These cases are RED for the in-flight
// variants before F3 (WL-0MUBVKXQJ000L8EO) lands and GREEN after.

describe('one dispatch per in-flight critical item (WL-0MUBVKS5I007LSWB / AC5)', () => {
  const criticalPlannedInFlight = (id: string): DowntimeHerdrItem => ({
    id, title: `Critical in-flight ${id}`, status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'critical', sortIndex: 10,
  });
  const nonCriticalStale = (id: string): DowntimeHerdrItem => ({
    id, title: `Stale ${id}`, status: 'open', stage: 'plan_complete',
    risk: 'Low', effort: 'S', priority: 'medium', sortIndex: 100,
  });

  /** A `herdr pane list` record set with one pane for *itemId* at *status*. */
  const paneRecord = (itemId: string, agentStatus: string) => ({
    paneId: 'w1:p1',
    label: `Downtime triggered implement Critical in-flight ${itemId} - ${itemId}`,
    agent: 'pi',
    agentStatus,
  });

  /**
   * A live working pane result. `records` is the item-scoped signal F3
   * consumes (additive on RunningPanesResult); `count` stays the owner-lease
   * qualifier only — never a dispatch limit (WL-0MU2EP6JL006A1U3).
   */
  const liveWorkingPane = (itemId: string) => ({
    ok: true as const,
    count: 1,
    paneIds: ['w1:p1'],
    records: [paneRecord(itemId, 'working')],
  });

  describe('AC5.1 — Herdr-head path: two cycles, exactly one dispatch', () => {
    it('two idle cycles over a critical item open at its marker stage with a live working pane dispatch once (RED pre-fix)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'herdr-head-inflight-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date().toISOString(), cwd: root, kind: 'implement', itemId: 'CR-INFLIGHT',
          stage: 'plan_complete', dispatchedAt: new Date().toISOString(), message: 'Dispatched CR-INFLIGHT',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-INFLIGHT')] }),
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
          // Cycle 1: no pane yet. Cycle 2: the spawned pane is live and working.
          getRunningDowntimePanes: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
            .mockResolvedValue(liveWorkingPane('CR-INFLIGHT')),
        });

        const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });
        const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        expect(first.dispatched).toBe(true);
        expect(second.dispatched).toBe(false);
        expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC5.4 — live-pane variants', () => {
    it('a live `working` pane blocks the second cycle (stage advancement irrelevant while open)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-W')] }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
        // Cycle 1: no pane yet. Cycle 2: the spawned pane is live and working.
        getRunningDowntimePanes: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
          .mockResolvedValue(liveWorkingPane('CR-W')),
      });

      const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });
      const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(first.dispatched).toBe(true);
      expect(second.dispatched).toBe(false);
      expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
    });

    it('a `done` pane does NOT block dispatch (no idle-pane deadlock, AC2.3)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-DONE')] }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true, count: 0, paneIds: [], records: [paneRecord('CR-DONE', 'done')],
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('CR-DONE');
    });

    it('an `exited` pane does NOT block dispatch (no idle-pane deadlock, AC2.3)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-EXIT')] }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true, count: 0, paneIds: [], records: [paneRecord('CR-EXIT', 'exited')],
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('CR-EXIT');
    });

    it('a failed/unparseable pane query never duplicating: the fresh marker still holds the second cycle (AC2.2/AC3.3)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'herdr-head-panefail-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date().toISOString(), cwd: root, kind: 'implement', itemId: 'CR-PANEFAIL',
          stage: 'plan_complete', dispatchedAt: new Date().toISOString(), message: 'Dispatched CR-PANEFAIL',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [criticalPlannedInFlight('CR-PANEFAIL')] }),
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
          // Cycle 1: pane query succeeds (none) so the dispatch proceeds.
          // Cycle 2: herdr is unavailable — the in-flight state cannot be
          // proven, so the fresh marker must hold the second dispatch.
          getRunningDowntimePanes: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, count: 0, paneIds: [], records: [] })
            .mockResolvedValue({ ok: false, error: 'herdr down' }),
        });

        const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });
        const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        expect(first.dispatched).toBe(true);
        expect(second.dispatched).toBe(false);
        expect(deps.spawnAgentPane).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC5.3 — stale-marker coverage beyond the critical tier', () => {
    it('a non-critical item at the same stage with a fresh marker and a live pane is not re-dispatched', async () => {
      const root = mkdtempSync(join(tmpdir(), 'herdr-head-noncrit-'));
      mkdirSync(join(root, '.worklog'), { recursive: true });
      writeFileSync(
        join(root, '.worklog', 'downtime-dispatches.log'),
        JSON.stringify({
          at: new Date().toISOString(), cwd: root, kind: 'implement', itemId: 'IMP-STALE',
          stage: 'plan_complete', dispatchedAt: new Date().toISOString(), message: 'Dispatched IMP-STALE',
        }) + '\n',
      );
      try {
        const deps = makeDeps({
          getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [nonCriticalStale('IMP-STALE')] }),
          claimItem: vi.fn().mockResolvedValue({ ok: true }),
          spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
          recordDispatch: vi.fn().mockResolvedValue(true),
          getRunningDowntimePanes: vi.fn().mockResolvedValue({
            ok: true, count: 1, paneIds: ['w1:p1'],
            records: [{ paneId: 'w1:p1', label: 'Downtime triggered implement Stale IMP-STALE - IMP-STALE', agent: 'pi', agentStatus: 'working' }],
          }),
        });

        const first = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });
        const second = await dispatchDowntimeWork(deps, { model: 'plan', cwd: root });

        expect(first.dispatched).toBe(false);
        expect(second.dispatched).toBe(false);
        expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('AC5.6 — no idle-pane deadlock: a completed skill still advances to its next tier', () => {
    it('an item whose previous skill completed (pane present, agent not working) still dispatches its next tier', async () => {
      // The pane for the item is still OPEN but its agent is `done`: the item
      // is at intake_complete with a completed intake pane. It must dispatch
      // the plan tier, not deadlock on the stale pane.
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({
          ok: true,
          items: [{ id: 'WL-NEXT', title: 'Next tier', status: 'open', stage: 'intake_complete', priority: 'high', risk: 'Low', effort: 'S', sortIndex: 10 }],
        }),
        claimItem: vi.fn().mockResolvedValue({ ok: true }),
        spawnAgentPane: vi.fn().mockResolvedValue({ ok: true }),
        recordDispatch: vi.fn().mockResolvedValue(true),
        getRunningDowntimePanes: vi.fn().mockResolvedValue({
          ok: true, count: 0, paneIds: [],
          records: [{ paneId: 'w1:p1', label: 'Downtime triggered intake Next tier - WL-NEXT', agent: 'pi', agentStatus: 'done' }],
        }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('plan');
      expect(outcome.candidate?.id).toBe('WL-NEXT');
    });
  });
});

// ── Dispatch-window extension — Herdr head-cap starvation (WL-0MU6UL3GQ0015AA5) ──
// The dispatcher iterates the Herdr list head, which is windowed: mandatory
// items (critical + completed/in_review) are always included and consume
// slots, so when they are numerous the first genuinely dispatchable candidate
// can fall beyond the window. These tests reproduce the 2026-09-18 starvation
// (a 30-item head, all blocked; the only dispatchable item was the 22nd
// "other", cut off by the cap) and assert the bounded window extension finds
// it in the SAME ranking order.
//
// Blocking is done by CLASSIFICATION SHAPE (a non-dispatchable stage for
// open items, out-of-recency for completed/in_review) rather than by the
// `needsProducerReview` flag: the window-extension tests deliberately isolate
// the window mechanism from the review gate. (The flag now blocks on this
// path too — the field is threaded into `classifyItemForDispatch` as of
// WL-0MU72WJ8C0005GIE / 022f1b24.)

describe('sprint-view-only dispatch window (WL-0MUNS8X97007C9H9; supersedes WL-0MU6UL3GQ0015AA5 AC1/AC4)', () => {
  const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  /**
   * A non-dispatchable filler item: `open` status but a stage with no dispatch
   * kind (`in_review`). Previously these filler items were made
   * non-dispatchable by an above-cap risk, but the implement risk cap was
   * removed (WL-0MUBUA9C8009N0K5); the non-dispatchable stage is now the
   * stable filler shape.
   */
  const blockedImplement = (id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem => ({
    id,
    title: `Blocked ${id}`,
    status: 'open',
    stage: 'in_review',
    priority: 'medium',
    risk: 'High',
    effort: 'S',
    sortIndex: 100,
    ...overrides,
  });

  /** A completed/in_review item outside the audit recency window (never dispatchable). */
  const blockedReview = (id: string, overrides: Partial<DowntimeHerdrItem> = {}): DowntimeHerdrItem => ({
    id,
    title: `Blocked review ${id}`,
    status: 'completed',
    stage: 'in_review',
    priority: 'medium',
    updatedAt: OLD,
    sortIndex: 2,
    ...overrides,
  });

  /** 1 blocked critical + 8 blocked completed/in_review = the 9 mandatory slots. */
  const mandatorySet = (): DowntimeHerdrItem[] => [
    blockedImplement('CG-CRIT', { priority: 'critical', sortIndex: 1 }),
    ...Array.from({ length: 8 }, (_, i) => blockedReview(`CG-REV${i + 1}`, { sortIndex: 2 + i })),
  ];

  /** 21 blocked "other" items fill the remaining window slots (total head = 30). */
  const blockedOthers = (): DowntimeHerdrItem[] =>
    Array.from({ length: 21 }, (_, i) => blockedImplement(`CG-BLK${i + 1}`, { sortIndex: 20 + i }));

  /** The only genuinely dispatchable item (high, idea, no markers, not review-gated). */
  const dispatchableIntake = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Dispatchable ${id}`,
    status: 'open',
    stage: 'idea',
    priority: 'high',
    sortIndex: 999,
  });

  /** A dispatchable CRITICAL implement item (the AC4 escape-hatch shape). */
  const dispatchableCriticalImplement = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Critical ${id}`,
    status: 'open',
    stage: 'plan_complete',
    priority: 'critical',
    risk: 'Low',
    effort: 'S',
    sortIndex: 500,
  });

  const fullHead = (): DowntimeHerdrItem[] => [...mandatorySet(), ...blockedOthers()];

  describe('AC1 — head limit equals the live sprint-view browseItemCount', () => {
    it('direct dispatch passes the effective browseItemCount to getHerdrListHead', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

      // Observable contract: getHerdrListHead boundary dep — count arg proves effective browseItemCount is forwarded
      expect(getHerdrListHead).toHaveBeenCalledWith('/repo', 20);
    });

    it('clamps an out-of-range browseItemCount to the supported [1, 50] range', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 999 });
      expect(getHerdrListHead).toHaveBeenLastCalledWith('/repo', 50);

      getHerdrListHead.mockClear();
      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 0 });
      expect(getHerdrListHead).toHaveBeenLastCalledWith('/repo', 1);
    });

    it('defaults to the sprint-view default (20) when browseItemCount is undefined', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      // Observable contract: getHerdrListHead boundary dep — count arg proves effective browseItemCount is forwarded
      expect(getHerdrListHead).toHaveBeenCalledWith('/repo', 20);
    });

    it('computeMostImportantItem passes the effective browseItemCount to getHerdrListHead', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await computeMostImportantItem(deps, '/repo', Date.now(), 33);

      // Observable contract: getHerdrListHead boundary dep — count arg proves effective browseItemCount is forwarded
      expect(getHerdrListHead).toHaveBeenCalledWith('/repo', 33);
    });

    it('re-reads the live browseItemCount on every dispatch cycle (settings change applies without restart)', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [dispatchableIntake('CG-INWINDOW')] });
      const deps = makeDeps({ getHerdrListHead });

      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 15 });
      await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 40 });

      // Observable contract: Nth ordering assertion — proves browseItemCount re-read per dispatch cycle; outcome cannot prove the per-cycle sequence
      expect(getHerdrListHead).toHaveBeenNthCalledWith(1, '/repo', 15);
      // Observable contract: Nth ordering assertion — proves browseItemCount re-read per dispatch cycle; outcome cannot prove the per-cycle sequence
      expect(getHerdrListHead).toHaveBeenNthCalledWith(2, '/repo', 40);
    });
  });

  describe('AC3 — regression: the dispatchable item beyond the window cap is found', () => {
    it('regression (WL-0MU6UL3GQ0015AA5 updated): a non-critical item beyond the sprint view is NOP, not dispatched', async () => {
      const initialHead = fullHead();
      const target = dispatchableIntake('CG-0MTZO0YIM000VAIQ');
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: initialHead })
        .mockResolvedValueOnce({ ok: true, items: [...initialHead, target] });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

      // The out-of-window item is NON-critical: the sprint-view-only contract
      // reports no-candidate instead of dispatching hidden backlog work
      // (supersedes WL-0MU6UL3GQ0015AA5 for non-critical work).
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      expect(deps.claimItem).not.toHaveBeenCalled();
      // The critical-only extension still consulted the SAME ranking path
      // (never a second ranking).
      expect(getHerdrListHead).toHaveBeenCalledTimes(2);
      // Observable contract: Nth ordering assertion — proves browseItemCount re-read per dispatch cycle; outcome cannot prove the per-cycle sequence
      expect(getHerdrListHead).toHaveBeenNthCalledWith(
        2,
        '/repo',
        initialHead.length + DOWNTIME_DISPATCH_EXTEND_MAX,
      );
    });

    it('the coordination check-in offer (computeMostImportantItem) also no-ops on a non-critical out-of-window item', async () => {
      const initialHead = fullHead();
      const target = dispatchableIntake('CG-OFFER');
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: initialHead })
        .mockResolvedValueOnce({ ok: true, items: [...initialHead, target] });
      const deps = makeDeps({ getHerdrListHead });

      const result = await computeMostImportantItem(deps, '/repo');

      expect(result).toMatchObject({ ok: true, noCandidate: true });
      expect(getHerdrListHead).toHaveBeenCalledTimes(2);
    });

    it('prefers an in-window candidate over the extended window (no extra lookup when the head suffices)', async () => {
      const inWindow = dispatchableIntake('CG-INWINDOW');
      const getHerdrListHead = vi.fn().mockResolvedValue({ ok: true, items: [inWindow, ...blockedOthers()] });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.candidate?.id).toBe('CG-INWINDOW');
      // The head already yielded a candidate — the extension never runs.
      expect(getHerdrListHead).toHaveBeenCalledTimes(1);
    });

    it('stays code-freeze under a freeze even when a non-critical item lies beyond the window', async () => {
      // Under a freeze, audit/implement candidates are paused; a non-critical
      // item beyond the sprint view is not an escape hatch, so the terminal
      // reason stays derived from the in-view flags.
      const initialHead = fullHead();
      const target = dispatchableIntake('CG-FROZEN-OUT-OF-WINDOW');
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: initialHead })
        .mockResolvedValueOnce({ ok: true, items: [...initialHead, target] });
      const deps = makeDeps({
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
        getHerdrListHead,
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('code-freeze');
    });
  });

  describe('AC2 — bounded extension, no worklist regression, terminal reasons preserved', () => {
    it('stays no-candidate when the extended window adds nothing (mock ignores the limit)', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: fullHead() }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(deps.spawnAgentPane).not.toHaveBeenCalled();
      expect(deps.claimItem).not.toHaveBeenCalled();
    });

    it('reports code-freeze when a frozen head plus extension still yields no candidate', async () => {
      const deps = makeDeps({
        readCodeFreezeStatus: vi.fn().mockReturnValue('frozen'),
        // Both the head and the extension return the same blocked items.
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: fullHead() }),
      });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('code-freeze');
    });

    it('the extension never invents a new failure: a failed extended lookup degrades to no-candidate', async () => {
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: fullHead() })
        .mockResolvedValueOnce({ ok: false, error: 'boom' });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo' });

      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe('no-candidate');
      expect(getHerdrListHead).toHaveBeenCalledTimes(2);
    });
  });

  describe('AC4 — critical items remain dispatchable', () => {
    it('a critical item in the head still dispatches while every non-critical item is filtered', async () => {
      const getHerdrListHead = vi.fn().mockResolvedValue({
        ok: true,
        items: [dispatchableCriticalImplement('CG-CRIT-DISPATCH'), ...blockedOthers()],
      });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('CG-CRIT-DISPATCH');
    });

    it('the critical-only extension still reaches an out-of-window critical item', async () => {
      const initialHead = fullHead();
      const target = dispatchableCriticalImplement('CG-CRIT-OUT-OF-WINDOW');
      const getHerdrListHead = vi.fn()
        .mockResolvedValueOnce({ ok: true, items: initialHead })
        .mockResolvedValueOnce({ ok: true, items: [...initialHead, target] });
      const deps = makeDeps({ getHerdrListHead });

      const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd: '/repo', browseItemCount: 20 });

      expect(outcome.dispatched).toBe(true);
      expect(outcome.kind).toBe('implement');
      expect(outcome.candidate?.id).toBe('CG-CRIT-OUT-OF-WINDOW');
    });
  });

  describe('fetchExtendedHerdrItems — critical-only escape hatch primitive', () => {
    const item = (id: string, priority = 'medium'): DowntimeHerdrItem => ({
      id,
      title: `Item ${id}`,
      status: 'open',
      stage: 'idea',
      priority,
    });

    it('returns only newly visible CRITICAL items, preserving the canonical order', async () => {
      const current = [item('A')];
      const dep = vi.fn().mockResolvedValue({
        ok: true,
        items: [item('A'), item('B'), item('C', 'critical'), item('D'), item('E', 'critical')],
      });
      const deps = makeDeps({ getHerdrListHead: dep });

      const extended = await fetchExtendedHerdrItems(deps, '/repo', current);

      expect(extended.map((i) => i.id)).toEqual(['C', 'E']);
      expect(extended.every((i) => i.priority === 'critical')).toBe(true);
      // Observable contract: `dep` injected boundary adapter — proves extended-window count forwarded
      expect(dep).toHaveBeenCalledWith('/repo', 1 + DOWNTIME_DISPATCH_EXTEND_MAX);
    });

    it('never returns a non-critical item beyond the sprint view (AC4)', async () => {
      const current = [item('A')];
      const dep = vi.fn().mockResolvedValue({
        ok: true,
        items: [item('A'), item('B', 'high'), item('C'), item('D', 'low')],
      });
      const deps = makeDeps({ getHerdrListHead: dep });

      expect(await fetchExtendedHerdrItems(deps, '/repo', current)).toEqual([]);
    });

    it('returns [] when the extended head adds nothing (limit-ignoring dep)', async () => {
      const current = [item('A')];
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [item('A')] }),
      });

      expect(await fetchExtendedHerdrItems(deps, '/repo', current)).toEqual([]);
    });

    it('fails open to [] on a {ok:false} extended lookup', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
      });

      expect(await fetchExtendedHerdrItems(deps, '/repo', [item('A')])).toEqual([]);
    });

    it('fails open to [] when the extended lookup throws', async () => {
      const deps = makeDeps({
        getHerdrListHead: vi.fn().mockRejectedValue(new Error('boom')),
      });

      expect(await fetchExtendedHerdrItems(deps, '/repo', [item('A')])).toEqual([]);
    });
  });
});

// ── Dispatched success-marker staleness — live Herdr-head path
//    (WL-0MU6UL0RJ008IHGT AC1/AC2/AC4) ─────────────────────────────
//
// A SUCCESS dispatch marker (no `outcome`) historically excluded its item
// forever: a pane that spawned but whose agent never advanced the item
// (crash, manual close, silent failure) stranded it permanently — the item
// was invisible to the tier that would retry it. These tests pin the live
// `dispatchFromHerdrList`/`computeMostImportantItem` marker filter: a marker
// excludes ONLY while the item is STILL at the marker's dispatched-at stage
// AND the marker is fresh (age <= the configured staleness window). The
// times are relative to REAL `Date.now()` because the dispatch path reads
// the clock itself. Items here are NON-critical so they exercise the normal
// (non-critical-first) filter path.
describe('dispatched success-marker staleness on the live path (WL-0MU6UL0RJ008IHGT)', () => {
  const WINDOW_MS = 24 * 60 * 60 * 1000; // default 24h
  const tempCwds = createTempDirTracker();

  afterEach(() => {
    tempCwds.cleanup();
  });

  function makeCwd(): string {
    return tempCwds.make('dt-stale-marker-');
  }

  const writeLog = writeDowntimeLog;

  const planHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'medium',
    sortIndex: 30,
  });
  const implementHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Implement ${id}`,
    status: 'open',
    stage: 'plan_complete',
    risk: 'Low',
    effort: 'S',
    priority: 'medium',
    sortIndex: 20,
  });

  it('AC1: a stale success marker at the unchanged stage no longer excludes — the item is re-dispatched', async () => {
    const cwd = makeCwd();
    // Plan marker written >24h ago for an item STILL at intake_complete — the
    // pane spawned but never advanced it. Must be released on the live path.
    writeLog(cwd, [
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(WINDOW_MS + 60_000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('PLN-1');
    // Observable contract: spawnAgentPane boundary call
    expect(deps.spawnAgentPane).toHaveBeenCalledWith(
      expect.stringContaining('/skill:plan PLN-1'),
      expect.anything(),
    );
  });

  it('a FRESH success marker at the unchanged stage still excludes (no double dispatch)', async () => {
    const cwd = makeCwd();
    // Plan marker 1h ago for an item still at intake_complete → genuinely
    // in-flight; the tier must skip it and report the neutral no-candidate.
    writeLog(cwd, [
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(60 * 60 * 1000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('AC2: an item that ADVANCED past the marker stage is released regardless of age', async () => {
    const cwd = makeCwd();
    // Marker says intake_complete but the item is now at plan_complete — the
    // history released it via the change-guard; it must still release today.
    writeLog(cwd, [
      { itemId: 'IMP-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(60 * 1000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('IMP-1');
  });

  it('id-guard tier: a stale IMPLEMENT marker at the unchanged stage is released', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'IMP-1', kind: 'implement', stage: 'plan_complete', dispatchedAt: ago(WINDOW_MS + 60_000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('implement');
    expect(outcome.candidate?.id).toBe('IMP-1');
  });

  it('id-guard tier: a fresh IMPLEMENT marker still excludes (duplicate-dispatch protection)', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'IMP-1', kind: 'implement', stage: 'plan_complete', dispatchedAt: ago(60 * 60 * 1000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.reason).toBe('no-candidate');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
  });

  it('id-guard tier: a legacy implement marker WITHOUT a stage keeps excluding while fresh, releases when stale', async () => {
    const cwd = makeCwd();
    // Fresh legacy marker (no stage field — pre-change-guard entry): the
    // id-guard must NOT weaken protection → still excluded.
    writeLog(cwd, [{ itemId: 'IMP-1', kind: 'implement', dispatchedAt: ago(60 * 60 * 1000) }]);
    const freshDeps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const freshOutcome = await dispatchDowntimeWork(freshDeps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(freshOutcome.dispatched).toBe(false);
    expect(freshOutcome.reason).toBe('no-candidate');

    // Same legacy marker but stale → the age TTL releases it.
    writeLog(cwd, [{ itemId: 'IMP-1', kind: 'implement', dispatchedAt: ago(WINDOW_MS + 60_000) }]);
    const staleDeps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [implementHead('IMP-1')] }),
    });
    const staleOutcome = await dispatchDowntimeWork(staleDeps, { model: 'plan', cwd, markerStaleWindowMs: WINDOW_MS });
    expect(staleOutcome.dispatched).toBe(true);
    expect(staleOutcome.kind).toBe('implement');
  });

  it('computeMostImportantItem releases a stale marker at the unchanged stage (offers re-triable item)', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(WINDOW_MS + 60_000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });
    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, WINDOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok && 'candidate' in result) {
      expect(result.candidate.id).toBe('PLN-1');
      expect(result.kind).toBe('plan');
    } else {
      throw new Error(`expected a candidate offer, got ${JSON.stringify(result)}`);
    }
  });

  it('computeMostImportantItem keeps excluding a FRESH marker at the unchanged stage (no offer)', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [
      { itemId: 'PLN-1', kind: 'plan', stage: 'intake_complete', dispatchedAt: ago(60 * 60 * 1000) },
    ]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });
    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, WINDOW_MS);
    expect(result.ok).toBe(true);
    if (result.ok) expect('noCandidate' in result).toBe(true);
  });
});

// ── Non-terminal pane-close cooldown — live paths (WL-0MUKYERLZ006ELL5) ──

describe('non-terminal pane-close cooldown on the live paths (WL-0MUKYERLZ006ELL5)', () => {
  const COOLDOWN_MS = DEFAULT_DOWNTIME_NON_TERMINAL_COOLDOWN_MS;
  const tempCwds = createTempDirTracker();

  afterEach(() => {
    tempCwds.cleanup();
  });

  function makeCwd(): string {
    return tempCwds.make('dt-nonterminal-cooldown-');
  }

  const writeLog = writeDowntimeLog;

  const planHead = (id: string): DowntimeHerdrItem => ({
    id,
    title: `Plan ${id}`,
    status: 'open',
    stage: 'intake_complete',
    priority: 'medium',
    sortIndex: 30,
  });

  /** A non-terminal pane-close entry for the plan candidate. */
  function closeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      entryType: 'pane-close',
      itemId: 'PLN-1',
      kind: 'plan',
      stage: 'intake_complete',
      reasonCode: 'agent-ended-no-terminal',
      outcome: 'requires-attention',
      timestamp: ago(60_000),
      closed: true,
      ...overrides,
    };
  }

  it('AC1: a recent non-terminal close holds re-dispatch with the neutral cooldown reason', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry()]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(false);
    // Distinguishable from 'no-candidate' so the no-candidate cooldown is
    // not entered and no strike is recorded (AC3/AC5).
    expect(outcome.reason).toBe('non-terminal-cooldown');
    expect(deps.spawnAgentPane).not.toHaveBeenCalled();
    expect(deps.claimItem).not.toHaveBeenCalled();
    expect(deps.recordError).not.toHaveBeenCalled();
    expect(deps.recordDispatchFailure).not.toHaveBeenCalled();
  });

  it('AC2: a close older than cooldownMs releases the item (dispatches normally)', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry({ timestamp: ago(COOLDOWN_MS + 1) })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
    expect(outcome.candidate?.id).toBe('PLN-1');
  });

  it('AC3: stage advancement mid-cooldown releases the item immediately', async () => {
    const cwd = makeCwd();
    // Dispatched at `idea`; the item has since advanced to `intake_complete`.
    writeLog(cwd, [closeEntry({ stage: 'idea' })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.candidate?.id).toBe('PLN-1');
  });

  it('AC4: a terminal close (reasonCode none) does not apply the cooldown', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry({ reasonCode: 'none', outcome: 'closed-as-plan-complete' })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(true);
  });

  it('applies the cooldown per-kind: an intake close does not hold a plan re-dispatch', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry({ kind: 'intake', itemId: 'PLN-1' })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const outcome = await dispatchDowntimeWork(deps, { model: 'plan', cwd, nonTerminalCooldownMs: COOLDOWN_MS });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.kind).toBe('plan');
  });

  it('AC7: computeMostImportantItem reports a distinct cooldown hold, never noCandidate', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry()]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, undefined, COOLDOWN_MS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('nonTerminalCooldownHold' in result).toBe(true);
      expect('noCandidate' in result).toBe(false);
      // The offer-computation hold is NOT a candidate offer.
      expect('candidate' in result).toBe(false);
    }
  });

  it('AC7: computeMostImportantItem offers a cooldown-elapsed item normally', async () => {
    const cwd = makeCwd();
    writeLog(cwd, [closeEntry({ timestamp: ago(COOLDOWN_MS + 1) })]);
    const deps = makeDeps({
      getHerdrListHead: vi.fn().mockResolvedValue({ ok: true, items: [planHead('PLN-1')] }),
    });

    const result = await computeMostImportantItem(deps, cwd, Date.now(), undefined, undefined, COOLDOWN_MS);

    expect(result.ok).toBe(true);
    if (result.ok && 'candidate' in result) {
      expect(result.candidate.id).toBe('PLN-1');
      expect(result.kind).toBe('plan');
    } else {
      throw new Error(`expected a candidate offer, got ${JSON.stringify(result)}`);
    }
  });
});
