/**
 * packages/herdr/scripts/leaf-audit-decision-log-scenario.ts — the C8
 * end-to-end verification scenario for leaf-aware downtime dispatch.
 *
 * Parent: WL-0MSORQ8Y4004YT63 (leaf-aware downtime dispatch: leaf audits
 * dispatch on fewer free slots). Verification slice: WL-0MVV1F2W5001883R
 * (C8). This is the "scripted scenario" the closing slice requires: it drives
 * the REAL worker tick against three fixed payloads and captures the decision
 * log each one writes, so the evidence attached to the parent work item can be
 * reproduced by anyone:
 *
 *   npx tsx packages/herdr/scripts/leaf-audit-decision-log-scenario.ts
 *
 * The three scenarios (parent AC6 / C8 acceptance criteria):
 *
 *   a. 1 free slot + a LEAF audit candidate      → dispatch (audit tier),
 *      decision log: `leaf-audit-admission`.
 *   b. 1 free slot + a PARENT audit candidate    → no dispatch (fail-closed),
 *      decision log: `audit-tier-budget-skipped`.
 *   c. 1 free slot + `slots_stale: true`         → no dispatch (unusable
 *      availability signal), decision log: `slots-unavailable`.
 *
 * Determinism: the proxy poll is a fixed per-slot 3-slot payload, every `wl`
 * seam is a stub, and `thresholdMs` is 0 so the single free slot has
 * trivially been free for the "full" threshold on the first poll. Nothing
 * touches the real worklog, a real proxy or a real pane: the decision log is
 * written to a throwaway temp directory (the production
 * `appendCoordinationLogEntry` path, not a mock), then read back.
 *
 * Waiting for the log is event-driven, never a fixed sleep. The worker
 * writes decisions fire-and-forget (`void recordDecision(...)`), so `tick()`
 * can resolve before the append lands. A fixed "give it 25 ms" sleep lost
 * that race on a saturated host (load avg 14–23: the same tree that was red
 * passed on `--rerun-failures`, WL-0MW0YD2T6004FRDJ). The scenario therefore
 * tracks every append the worker starts and AWAITS the in-flight writes
 * before reading the log back, so a slow append only makes the run slower —
 * every scenario still has a green tree of decisions at any host load.
 *
 * The same `runLeafAuditDecisionLogScenario()` is asserted by
 * `src/downtime-worker.leaf-audit.test.ts` (the "scripted decision-log
 * scenario" group), so the evidence in the parent work item is pinned by the
 * suite rather than by a one-off manual run.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  appendCoordinationLogEntry,
  readCoordinationLogEntries,
  type CoordinationLogEntry,
} from '../src/downtime-log.js';
import type { AuditCandidateScopeResult } from '../src/downtime-worker.gates.js';
import {
  createDowntimePoller,
  createDowntimeWorker,
  type DowntimeWorkerDeps,
  type LlamaStatus,
} from '../src/downtime-worker.js';

/** A decision-log line reduced to the fields the scenarios assert/print. */
export interface ScenarioDecisionEntry {
  reason?: string;
  freeSlots?: number;
  totalSlots?: number;
  thresholdMetCount?: number;
  requiredFreeSlots?: number;
  leafAuditItemId?: string;
  leafAuditScope?: string;
  leafAuditImmediate?: boolean;
  skippedTier?: string;
}

/** One captured scenario: the dispatch outcome and the decisions it logged. */
export interface ScenarioCapture {
  name: string;
  expectation: string;
  dispatched: boolean;
  /** The tier the spawned pane was launched for, or `none` when nothing ran. */
  tier: 'audit' | 'plan' | 'implement' | 'none';
  /** Work item id parsed out of the spawned prompt (`/skill:<tier> <id>`). */
  spawnedItemId: string | null;
  /** The herdr header blocking token this tick left behind (null = none). */
  blockReason: string | null;
  decisions: ScenarioDecisionEntry[];
}

/** 3-slot per-slot payload: `freeSlots` trailing slots free, the rest busy. */
function threeSlotPool(freeSlots: 1 | 2 | 3): LlamaStatus {
  const processing = 3 - freeSlots;
  return {
    llama_server_running: true,
    local_active_query: false,
    model_switch_in_progress: false,
    local_lease_active: false,
    available_slots: freeSlots,
    total_slots: 3,
    current_model: 'qwen3-8b',
    slots: Array.from({ length: 3 }, (_unused, i) => ({
      slot_id: `slot-${i + 1}`,
      is_processing: i < processing,
    })),
    local_owner_session_ids: [],
  } as LlamaStatus;
}

/**
 * Options for {@link runLeafAuditDecisionLogScenario}.
 */
export interface ScenarioOptions {
  /**
   * Test seam (WL-0MW0YD2T6004FRDJ): delay every decision-log append by this
   * many milliseconds to simulate a saturated host. The scenario must still
   * capture every decision, because it awaits the in-flight appends instead
   * of sleeping a fixed amount before reading the log.
   */
  decisionLogDelayMs?: number;
}

/**
 * The stub `wl`/pane seams the scenario needs; nothing hits a real backend.
 *
 * `recordDecision` is injected so the scenario can observe the worker's
 * fire-and-forget appends (see `settleDecisionWrites`). It delegates to the
 * SAME production append the worker's default path uses — only the optional
 * `decisionLogDelayMs` simulation differs.
 */
function scenarioDeps(opts: {
  auditCandidate: { id: string } | null;
  scope: AuditCandidateScopeResult;
  spawned: string[];
  decisionLogDelayMs: number;
  decisionWrites: Array<Promise<void>>;
}): DowntimeWorkerDeps {
  const planCandidate = { id: 'WL-PLAN', title: 'Prep task', stage: 'intake_complete', status: 'open' };
  return {
    // Empty Herdr head → the legacy tier chain runs, exactly as the existing
    // per-tier suites exercise it (production only reaches this path with an
    // empty head; the decision tokens are shared by both paths).
    getHerdrListHead: async () => ({ ok: true, items: [] }),
    getNextAuditCandidate: async () => ({ ok: true, candidate: opts.auditCandidate }),
    getAuditCandidateScope: async () => opts.scope,
    getActiveAudit: async () => ({ ok: true, active: false }),
    getNextItem: async () => ({ ok: true, candidate: planCandidate }),
    getNextImplementCandidate: async () => null,
    getNextCriticalCandidate: async () => ({ ok: true, candidate: null }),
    getReviewQueueCount: async () => 0,
    hasFreshAudit: async () => false,
    readCodeFreezeStatus: () => 'not-frozen',
    claimItem: async () => ({ ok: true }),
    recordDecision: async (entry, dir) => {
      const write = (async () => {
        if (opts.decisionLogDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, opts.decisionLogDelayMs));
        }
        // No policy argument: the scenario config sets no retention override,
        // so the documented default policy the worker's own fallback resolves
        // to is exactly what this append uses.
        await appendCoordinationLogEntry(dir, entry);
      })();
      opts.decisionWrites.push(write);
      await write;
    },
    spawnAgentPane: async (prompt) => {
      opts.spawned.push(prompt);
      return { ok: true };
    },
    recordDispatch: async () => true,
    recordDispatchFailure: async () => undefined,
    rollbackClaim: async () => true,
    recordError: async () => undefined,
    getDueScheduledPrompt: async () => null,
    recordScheduledPromptTrigger: async () => true,
  };
}

/** The three fixed scenarios, driven through the real worker tick. */
const SCENARIOS = [
  {
    name: '1-free-slot-leaf',
    expectation: 'dispatch the leaf audit (audit tier)',
    status: () => threeSlotPool(1),
    auditCandidate: { id: 'WL-LEAF', title: 'Leaf audit', stage: 'audit' as const },
    scope: { ok: true, scope: 'leaf' } as AuditCandidateScopeResult,
  },
  {
    name: '1-free-slot-parent',
    expectation: 'no dispatch; audit-tier-budget-skipped (fail-closed)',
    status: () => threeSlotPool(1),
    auditCandidate: { id: 'WL-PARENT', title: 'Parent audit', stage: 'audit' as const },
    scope: { ok: true, scope: 'parent' } as AuditCandidateScopeResult,
  },
  {
    name: '1-free-slot-slots-stale',
    expectation: 'no dispatch; slots-unavailable (untrustworthy availability)',
    status: () => ({ ...threeSlotPool(1), slots_stale: true }),
    auditCandidate: { id: 'WL-LEAF', title: 'Leaf audit', stage: 'audit' as const },
    scope: { ok: true, scope: 'leaf' } as AuditCandidateScopeResult,
  },
] as const;

const PROMPT_ITEM_RE = /\/skill:(audit|plan|implement)\s+(\S+)/;

/**
 * Await every decision-log append the worker started, including writes queued
 * while an earlier write was still in flight (the worker fires them with
 * `void recordDecision(...)`, so they are not part of the `tick()` promise).
 *
 * Re-checking the backlog after each settle is what makes this deterministic:
 * once no new append appears, the log is complete. A fixed sleep cannot give
 * that guarantee and loses the race on a saturated host
 * (WL-0MW0YD2T6004FRDJ).
 */
async function settleDecisionWrites(writes: Array<Promise<void>>): Promise<void> {
  let settled = 0;
  while (settled < writes.length) {
    const pending = writes.slice(settled);
    settled = writes.length;
    await Promise.allSettled(pending);
  }
}

/**
 * Run all three scenarios and return the captured decision-log excerpts. Each
 * scenario gets its own throwaway worklog root so its log is exactly the
 * entries that scenario produced.
 */
export async function runLeafAuditDecisionLogScenario(
  options: ScenarioOptions = {},
): Promise<ScenarioCapture[]> {
  const decisionLogDelayMs = options.decisionLogDelayMs ?? 0;
  const captures: ScenarioCapture[] = [];
  for (const scenario of SCENARIOS) {
    const cwd = mkdtempSync(join(tmpdir(), 'leaf-audit-scenario-'));
    try {
      const spawned: string[] = [];
      const decisionWrites: Array<Promise<void>> = [];
      const fetcher = async () => ({ ok: true, status: 200, json: async () => scenario.status() });
      const poller = createDowntimePoller('http://proxy.invalid:8000', fetcher);
      const worker = createDowntimeWorker({
        poller,
        deps: scenarioDeps({
          auditCandidate: scenario.auditCandidate,
          scope: scenario.scope,
          spawned,
          decisionLogDelayMs,
          decisionWrites,
        }),
        config: () => ({
          enabled: true,
          // 0 ms: the single free slot has trivially been free for the "full"
          // threshold on the first poll. The scenario verifies the DECISION
          // tokens, not the duration wait (which the suite pins separately).
          thresholdMs: 0,
          requiredFreeSlots: 2,
          model: 'plan',
          cwd,
          noCandidateCooldownMs: 3_600_000,
          browseItemCount: 20,
          leafAuditImmediate: false,
        }),
      });

      const tick = await worker.tick();
      // Decision entries are written fire-and-forget (`void recordDecision`):
      // await the appends the tick started instead of sleeping a fixed 25 ms
      // (a fixed sleep is the race that produced WL-0MW0YD2T6004FRDJ).
      await settleDecisionWrites(decisionWrites);
      const prompt = spawned[0];
      const match = prompt === undefined ? null : PROMPT_ITEM_RE.exec(prompt);

      const decisions = (await readCoordinationLogEntries(cwd))
        .filter((entry: CoordinationLogEntry) => entry.kind === 'decision')
        .map<ScenarioDecisionEntry>((entry) => ({
          reason: entry.reason,
          freeSlots: entry.freeSlots,
          totalSlots: entry.totalSlots,
          thresholdMetCount: entry.thresholdMetCount,
          requiredFreeSlots: entry.requiredFreeSlots,
          leafAuditItemId: entry.leafAuditItemId,
          leafAuditScope: entry.leafAuditScope,
          leafAuditImmediate: entry.leafAuditImmediate,
          skippedTier: entry.skippedTier,
        }));

      captures.push({
        name: scenario.name,
        expectation: scenario.expectation,
        dispatched: tick.dispatched,
        tier: match === null ? 'none' : (match[1] as 'audit' | 'plan' | 'implement'),
        spawnedItemId: match?.[2] ?? null,
        blockReason: worker.blockReason,
        decisions,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  return captures;
}

async function main(): Promise<void> {
  const captures = await runLeafAuditDecisionLogScenario();
  process.stdout.write(`${JSON.stringify(captures, null, 2)}\n`);
}

// Run only when executed directly (never when imported by the test suite).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`leaf-audit scenario failed: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
