/**
 * packages/herdr/src/pane-close-reaper.ts — Closure reaper orchestration
 *
 * Scans herdr panes, classifies each via the shared `classifySession`
 * classifier, closes eligible panes, and writes a per-run ledger.
 *
 * I/O is injected via the `ReaperDeps` interface so the core logic is fully
 * testable without real herdr calls.
 *
 * The reaper is idempotent against the existing `pane-lifecycle.ts` dispatch
 * monitor: a pane already closed by the dispatch monitor is simply gone from
 * `listPanes()` and is skipped. Both mechanisms use the same classifier,
 * so decisions cannot diverge (parent AC6). The dispatch monitor itself is
 * currently DISABLED (WL-0MUMEKDK0008LKH8), so the reaper is the only active
 * auto-close path; the `alreadyClosedPaneIds` guard remains for historical
 * monitor entries and a possible future re-enable.
 */

import { classifySession, extractFinalAssistantText } from './pane-close.js';
import type { CloseDecision, SessionSample } from './pane-close.js';
import type { TerminateResult } from './process-group.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────

/**
 * The injectable I/O interface for the reaper. Tests provide fakes;
 * production code provides real herdr/wl integrations.
 */
export interface ReaperDeps {
  /** List all currently active panes with their session state. */
  listPanes(): Promise<PaneStatus[]>;
  /** Close a pane by ID. Returns a result indicating success/failure. */
  closePane(paneId: string): Promise<{ success: boolean; error?: string }>;
  /** Terminate the session-scoped process group for a pane. */
  terminateProcessGroup(pid: number, opts?: { graceMs?: number }): Promise<TerminateResult>;
}

/**
 * The state of one pane as seen by the reaper. Populated from herdr's
 * agent list and session log.
 */
export interface PaneStatus {
  id: string;
  kind: 'plan' | 'intake' | 'audit' | 'risk-effort' | 'implement' | 'unknown';
  itemId: string;
  title: string;
  /** Concatenated text of the final assistant message. */
  lastAssistantText: string;
  /**
   * Raw session-log entries. When provided, the reaper derives the final
   * assistant text via the shared `extractFinalAssistantText` helper
   * (parent AC6) instead of trusting `lastAssistantText`.
   */
  sessionEntries?: { type?: string; text?: string }[];
  /** Whether the agent process is alive. */
  agentProcessAlive: boolean;
  /** Idle time in milliseconds. */
  idleMs: number;
  /** Whether the work item needs producer review. */
  needsProducerReview: boolean;
  /** Whether this pane is the invoking/launching pane. */
  isInvokingPane: boolean;
  /** Number of child processes spawned by this session. */
  childProcessCount: number;
  /**
   * Age since the pane's first dispatch, in milliseconds (parent AC5).
   * Optional/tolerant: when absent the grace-period guard cannot apply.
   */
  ageSinceDispatchMs?: number;
  /**
   * Active-agent signal (parent AC3): the pane shows recent file
   * modifications. Optional/tolerant: absent = no activity.
   */
  hasRecentFileModifications?: boolean;
  /**
   * Active-agent signal (parent AC3): the pane has active network
   * connections. Optional/tolerant: absent = no activity.
   */
  hasActiveNetworkConnections?: boolean;
  /** The PID of the agent process (for process-group teardown). */
  pid?: number;
}

/** The result of classifying one pane. */
export interface ReaperResult {
  paneId: string;
  paneTitle: string;
  decision: CloseDecision;
  success: boolean;
  error?: string;
}

/** Options for the reaper run. */
export interface ReaperOptions {
  /** Idle threshold in milliseconds (default: 30 minutes). */
  idleThresholdMs?: number;
  /**
   * Grace period in milliseconds (parent AC5): no pane is eligible for close
   * within this window of its first dispatch. `0`/absent disables the guard
   * (backwards compatible). */
  gracePeriodMs?: number;
  /** If true, report decisions but do not close any panes. */
  dryRun?: boolean;
  /**
   * Ledger path (JSONL). When set, one row per pane is appended after each
   * run. When omitted, no ledger is written (keeps the pure tests honest).
   */
  ledgerPath?: string;
  /**
   * Pane ids already recorded as closed by the dispatch monitor
   * (`pane-lifecycle.ts`) — skipped so the two mechanisms never double-handle
   * the same pane (parent constraint). The monitor is currently disabled
   * (WL-0MUMEKDK0008LKH8), so this normally stays empty; it remains for
   * historical entries and a possible future re-enable.
   */
  alreadyClosedPaneIds?: ReadonlySet<string>;
}

// ── Ledger ────────────────────────────────────────────────────────────

/** Default ledger path inside `.worklog/`. */
export const DEFAULT_LEDGER_PATH = '.worklog/pane-close-ledger.jsonl';

/**
 * One row in the closure ledger (JSONL format).
 */
export interface LedgerEntry {
  timestamp: string;
  paneId: string;
  paneTitle: string;
  decision: CloseDecision;
  success: boolean;
  error?: string;
}

/**
 * Write a ledger row to a JSONL file. Creates parent directories if needed.
 * Fail-closed: never throws — a write failure is logged to stderr.
 */
export function writeLedgerRow(ledgerPath: string, result: ReaperResult): void {
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const entry: LedgerEntry = {
      timestamp: new Date().toISOString(),
      paneId: result.paneId,
      paneTitle: result.paneTitle,
      decision: result.decision,
      success: result.success,
      error: result.error,
    };
    appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Fail-closed: never crash the worker.
    console.error(
      `reaper: failed to write ledger row for ${result.paneId}: ${err}`,
    );
  }
}

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: ReaperOptions = {
  idleThresholdMs: 30 * 60 * 1000,
  gracePeriodMs: 0,
  dryRun: false,
};

// ── Classification ────────────────────────────────────────────────────

/**
 * Build a `SessionSample` from a `PaneStatus` for classification.
 */
function toSessionSample(ps: PaneStatus): SessionSample {
  const lastAssistantText =
    Array.isArray(ps.sessionEntries)
      ? extractFinalAssistantText(ps.sessionEntries)
      : ps.lastAssistantText;
  return {
    lastAssistantText,
    agentProcessAlive: ps.agentProcessAlive,
    idleMs: ps.idleMs,
    kind: ps.kind,
    needsProducerReview: ps.needsProducerReview,
    isInvokingPane: ps.isInvokingPane,
    childProcessCount: ps.childProcessCount,
    ageSinceDispatchMs: ps.ageSinceDispatchMs,
    hasRecentFileModifications: ps.hasRecentFileModifications,
    hasActiveNetworkConnections: ps.hasActiveNetworkConnections,
  };
}

// ── Orchestration ─────────────────────────────────────────────────────

/**
 * Run the closure reaper: enumerate panes, classify each, close eligible
 * panes, and return a ledger of results.
 *
 * A single pane close failure is recorded but does not abort the run.
 *
 * In dry-run mode, decisions are computed but no panes are closed.
 */
export async function runReaper(
  deps: ReaperDeps,
  opts?: ReaperOptions,
): Promise<ReaperResult[]> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const results: ReaperResult[] = [];

  const panes = await deps.listPanes();

  for (const pane of panes) {
    // Coexistence with the dispatch monitor (parent constraint): a pane the
    // `pane-lifecycle.ts` monitor already recorded as closed is never handled
    // again. The monitor is currently disabled (WL-0MUMEKDK0008LKH8); the
    // guard is retained for historical entries.
    if (options.alreadyClosedPaneIds?.has(pane.id)) {
      continue;
    }

    const sample = toSessionSample(pane);
    const decision = classifySession(sample, {
      idleThresholdMs: options.idleThresholdMs,
      gracePeriodMs: options.gracePeriodMs,
    });

    let success = true;
    let error: string | undefined;

    if (decision.close && !options.dryRun) {
      try {
        // Terminate child processes first (AC5).
        if (pane.pid) {
          await deps.terminateProcessGroup(pane.pid, { graceMs: 5_000 });
        }
        await deps.closePane(pane.id);
      } catch (err) {
        success = false;
        error = err instanceof Error ? err.message : String(err);
      }
    }

    const result: ReaperResult = {
      paneId: pane.id,
      paneTitle: pane.title,
      decision,
      success,
      error,
    };
    results.push(result);

    if (options.ledgerPath) {
      writeLedgerRow(options.ledgerPath, result);
    }
  }

  return results;
}

// ── CLI ───────────────────────────────────────────────────────────────

/**
 * Parse the reaper CLI arguments into `ReaperOptions`.
 *
 * Supported flags:
 *  - `--dry-run`                report only, close nothing
 *  - `--threshold-minutes <n>`  idle threshold in minutes (default 30)
 *  - `--ledger <path>`          ledger output path (default `.worklog/pane-close-ledger.jsonl`)
 */
export function parseReaperArgs(argv: string[]): ReaperOptions {
  const options: ReaperOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--threshold-minutes') {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 0) {
        options.idleThresholdMs = value * 60 * 1000;
      }
    } else if (arg === '--ledger') {
      options.ledgerPath = argv[++i];
    }
  }
  return options;
}

/**
 * CLI entrypoint. Wires the real `ReaperDeps` (herdr pane listing, pane
 * close, process-group teardown) and runs the reaper. Returns the process
 * exit code: 0 on success, 1 on any partial failure.
 *
 * The real `ReaperDeps` implementation lives in the scheduling/wiring item
 * (WL-0MUJW9FFW009008M); this entrypoint accepts deps so the caller can
 * inject them and keeps the module free of direct herdr imports.
 */
export async function runReaperCli(
  deps: ReaperDeps,
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseReaperArgs(argv);
  const ledgerPath =
    options.ledgerPath ?? process.env.WORKLOG_PANE_CLOSE_LEDGER ?? DEFAULT_LEDGER_PATH;
  const results = await runReaper(deps, { ...options, ledgerPath });

  const failures = results.filter((r) => !r.success);
  if (options.dryRun) {
    console.log(`reaper (dry-run): ${results.length} pane(s) evaluated, ${results.filter((r) => r.decision.close).length} would close`);
  } else {
    console.log(`reaper: ${results.length} pane(s) evaluated, ${results.filter((r) => r.decision.close).length} closed, ${failures.length} failed`);
  }
  return failures.length > 0 ? 1 : 0;
}
