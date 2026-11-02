/**
 * packages/herdr/src/downtime-worker.orchestrator-signals.ts — the downtime
 * worker's orchestrator-level signal writers.
 *
 * Single responsibility: the two OBSERVATION/STATE writers the dispatch
 * orchestrator composes — the three-strike persistent-error pause
 * (`pauseAfterPersistentErrors`, WL-0MSI7DQL10016QYX) and the continuous
 * capacity-starvation observation (`writeCapacityStarvationSignal`,
 * WL-0MVKNC2N50025HXE AC3). Both are fail-closed side channels: a logging or
 * scan failure never changes a dispatch decision.
 *
 * Extracted verbatim from `downtime-worker.orchestrator-dispatch.ts` by
 * WL-0MVV1F0HK009JQAP (leaf-aware tick admission, C4) so that module stays
 * inside the split guard's 1,000-line ceiling
 * (`downtime-worker.split-guard.test.ts`) while the leaf-audit admission
 * threads one more field through it. Moved blocks are verbatim: no decision,
 * threshold, ordering or log message changed.
 *
 * Layering: imports only concrete siblings plus a TYPE-ONLY `OrchestratorContext`
 * edge back to the orchestrator-dispatch module, so no runtime cycle can form
 * (the split guard's cycle gates stay satisfied).
 */

import { appendCoordinationLogEntry, type CoordinationLogEntry } from './downtime-log.js';
import {
  DOWNTIME_ERROR_STRIKE_LIMIT,
  type DecisionEntryFields,
} from './downtime-worker.constants.js';
import type { CapacityStarvationObservation } from './capacity-starvation.js';
import type {
  IdleTracker,
  LongRunningPaneObservation,
  PerSlotIdleTracker,
} from './downtime-worker.types.js';
import type { DowntimeWorkerConfig } from './downtime-worker.worker-contract.js';

/**
 * The slice of the orchestrator context these signal writers touch.
 *
 * Declared structurally instead of importing `OrchestratorContext` from
 * `downtime-worker.orchestrator-dispatch.ts`: that module imports these
 * writers as VALUES, so a type import back would form a new
 * `dispatch ↔ signals` cycle in the split guard's module graph
 * (WL-0MVV1F0HK009JQAP C4). Structural typing still accepts the real context
 * at every call site, so the writers stay interchangeable with it.
 */
export interface SignalWriterContext {
  readonly opts: DowntimeWorkerConfig;
  readonly tracker: IdleTracker;
  readonly perSlotTracker: PerSlotIdleTracker;
  readonly instanceId: string;
  errorStrikes: number;
  cooldownUntil: number | null;
  longRunningThresholdMs: number;
}

// Three-strike pause (WL-0MSI7DQL10016QYX; shared by the CLI-error path
// and the coordination probe-failure path, WL-0MTEZ4XZJ006Y9U7): N
// consecutive failures pause the worker entirely and log the persistent
// error so it is auditable. A single transient failure does NOT pause —
// it retries on the next idle period. Fail-closed: error logging must
// never crash the worker.
// WL-0MTJPYM53003ORCV: log on EVERY strike (not just 3) with structured
// fields for debuggability.
export async function pauseAfterPersistentErrors(
  ctx: SignalWriterContext,
  message: string,
  error?: string,
  extra?: {
    workItemId?: string;
    command?: string;
    stderrExcerpt?: string;
    exitCode?: number | null;
    timeoutMs?: number;
    probeContext?: string;
  },
): Promise<void> {
  ctx.errorStrikes += 1;
  const attempt = ctx.errorStrikes;
  // Enrich stderr: the explicit stderr excerpt wins; otherwise fall back
  // to the plain error string (fetcher.ts builds it from
  // `stderr || stdout || error.message`, so it IS the stderr in most
  // wl-error cases). Truncate to 200 chars with [truncated] marker
  // (WL-0MTJPYM53003ORCV).
  const rawStderr = extra?.stderrExcerpt ?? error ?? '';
  const stderrExcerpt =
    rawStderr.length > 0
      ? rawStderr.length > 200
        ? rawStderr.slice(0, 200) + '[truncated]'
        : rawStderr
      : undefined;
  try {
    await ctx.opts.deps.recordError({
      cwd: ctx.opts.config().cwd,
      at: new Date().toISOString(),
      message,
      ...(error ? { error } : {}),
      ...(stderrExcerpt ? { stderrExcerpt } : {}),
      ...(extra?.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
      ...(extra?.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
      ...(extra?.workItemId ? { workItemId: extra.workItemId } : {}),
      ...(extra?.command ? { command: extra.command } : {}),
      attempt,
      ...(extra?.probeContext ? { probeContext: extra.probeContext } : {}),
    });
  } catch {
    // fail-closed: error logging must never crash the worker
  }
  if (ctx.errorStrikes >= DOWNTIME_ERROR_STRIKE_LIMIT) {
    ctx.cooldownUntil = Date.now() + ctx.opts.config().noCandidateCooldownMs;
    ctx.errorStrikes = 0;
    ctx.tracker.record(false);
    ctx.perSlotTracker.record([]);
  }
}

// ── Capacity-starvation observation (WL-0MVKNC2N50025HXE AC3) ──
// Write ONE observation entry for a capacity-refusal episode that has
// outlasted the configured window. It reuses the refusal's evidence fields
// (same schema), adds the episode length and — when the long-running scan
// is wired — names the panes holding the model. Observation only: it does
// not set the header blocking token, never gates dispatch, and a logging
// failure is swallowed (fail-closed).
export async function writeCapacityStarvationSignal(
  ctx: SignalWriterContext,
  cwd: string,
  starvation: CapacityStarvationObservation,
  fields: DecisionEntryFields,
  now: number,
): Promise<void> {
  let longRunningPanes: LongRunningPaneObservation[] | undefined;
  if (typeof ctx.opts.deps.scanLongRunningPanes === 'function') {
    try {
      const observed = await ctx.opts.deps.scanLongRunningPanes(cwd, {
        thresholdMs: ctx.longRunningThresholdMs,
        now,
      });
      if (Array.isArray(observed) && observed.length > 0) {
        longRunningPanes = observed;
      }
    } catch {
      // fail-safe: an unreadable scan must never suppress the signal
    }
  }
  const entry: CoordinationLogEntry = {
    kind: 'decision',
    operation: 'no-dispatch',
    instanceId: ctx.instanceId,
    reason: 'capacity-starved',
    ...fields,
    starvedSince: new Date(starvation.starvedSince).toISOString(),
    starvedMs: starvation.starvedMs,
    consecutiveCapacityRefusals: starvation.consecutiveRefusals,
    lastCapacityReason: starvation.lastReason,
    ...(longRunningPanes !== undefined ? { longRunningPanes } : {}),
    at: new Date(now).toISOString(),
  };
  try {
    if (typeof ctx.opts.deps.recordDecision === 'function') {
      await ctx.opts.deps.recordDecision(entry, cwd);
    } else {
      await appendCoordinationLogEntry(cwd, entry);
    }
  } catch {
    // fail-closed: observation logging must never affect dispatch
  }
}
