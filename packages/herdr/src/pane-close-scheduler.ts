/**
 * packages/herdr/src/pane-close-scheduler.ts — Periodic reaper scheduling
 *
 * Wires the closure reaper into the downtime worker's periodic tick
 * (WL-0MUJW9FFW009008M / WL-0MUJL1NAH0042GOS). The reaper runs only when the
 * `paneCloseEnabled` setting is on, on a bounded cadence, and any failure is
 * caught and logged so a reaper exception never crashes the worker.
 *
 * The module is pure orchestration with injected `ReaperDeps` so it is fully
 * unit-testable: settings in, close calls out.
 */

import { runReaper } from './pane-close-reaper.js';
import type { ReaperDeps, ReaperResult } from './pane-close-reaper.js';

// ── Defaults / bounds ─────────────────────────────────────────────────

/** Reaper is on by default (an operator can disable it via settings). */
export const DEFAULT_PANE_CLOSE_ENABLED = true;

/** Default marker-less idle threshold: 30 minutes (producer decision, Q6). */
export const DEFAULT_PANE_CLOSE_IDLE_THRESHOLD_MINUTES = 30;

/** Minimum idle threshold in minutes (1 minute). */
export const MIN_PANE_CLOSE_IDLE_THRESHOLD_MINUTES = 1;

/** Maximum idle threshold in minutes (24 hours). */
export const MAX_PANE_CLOSE_IDLE_THRESHOLD_MINUTES = 24 * 60;

/**
 * Default reaper cadence on the worker tick: 60 s. The reaper is heavier
 * than the pane-lifecycle monitor (it must read every session log), so it
 * runs less often than the ~10 s dispatch tick.
 */
export const PANE_CLOSE_REAPER_INTERVAL_MS = 60_000;

/**
 * Pure cadence predicate for the pane-close reaper: true when the reaper is
 * enabled AND due on this tick. Exported for direct unit testing of the
 * worker wiring (the full worker loop is heavy to construct).
 */
export function paneCloseReaperDue(
  paneClose: { enabled: boolean; intervalMs?: number } | undefined,
  lastRunAt: number,
  now: number,
): boolean {
  if (paneClose?.enabled !== true) return false;
  const interval = paneClose.intervalMs ?? PANE_CLOSE_REAPER_INTERVAL_MS;
  return now - lastRunAt >= interval;
}

/**
 * Clamp a pane-close idle threshold (minutes) into [1, 1440].
 * Non-finite values fall back to the default (30).
 */
export function clampPaneCloseIdleThresholdMinutes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PANE_CLOSE_IDLE_THRESHOLD_MINUTES;
  return Math.min(
    Math.max(Math.round(value), MIN_PANE_CLOSE_IDLE_THRESHOLD_MINUTES),
    MAX_PANE_CLOSE_IDLE_THRESHOLD_MINUTES,
  );
}

// ── Types ─────────────────────────────────────────────────────────────

/** The subset of plugin settings the reaper scheduler consults. */
export interface PaneCloseSettings {
  /** Master on/off switch. */
  paneCloseEnabled: boolean;
  /** Marker-less idle threshold in minutes. */
  paneCloseIdleThresholdMinutes: number;
}

/** Injectable options for one scheduled pass. */
export interface PaneCloseScheduleOptions {
  /** JSONL ledger path. */
  ledgerPath?: string;
  /** Report only — close nothing. */
  dryRun?: boolean;
  /** Pane ids the dispatch monitor already closed — skipped. */
  alreadyClosedPaneIds?: ReadonlySet<string>;
  /** Warning sink (defaults to stderr). Fail-closed: a sink throw is swallowed. */
  onWarn?: (message: string) => void;
}

/** Summary of one scheduled reaper pass. */
export interface PaneCloseScheduleResult {
  /** Whether the reaper was enabled (false → complete no-op). */
  enabled: boolean;
  /** Number of panes classified. */
  evaluated: number;
  /** Number of panes closed. */
  closed: number;
  /** Number of close failures. */
  failed: number;
  /** Error message when the pass threw (worker continues regardless). */
  error?: string;
}

// ── Scheduling ────────────────────────────────────────────────────────

function defaultWarn(message: string): void {
  try {
    process.stderr.write(`[worklog-plugin] Pane-close reaper: ${message}\n`);
  } catch {
    // fail-closed: logging must never crash the worker
  }
}

/**
 * Run one scheduled reaper pass.
 *
 * - When `paneCloseEnabled` is false the pass is a complete no-op (zero
 *   close calls) — the operator can disable auto-close without editing code.
 * - When enabled, `runReaper` classifies and closes eligible panes.
 * - Any throw is caught and logged (via `onWarn`); the returned result has
 *   `error` set and the caller's worker continues.
 */
export async function runScheduledPaneClose(
  deps: ReaperDeps,
  settings: PaneCloseSettings,
  opts?: PaneCloseScheduleOptions,
): Promise<PaneCloseScheduleResult> {
  if (!settings.paneCloseEnabled) {
    return { enabled: false, evaluated: 0, closed: 0, failed: 0 };
  }

  const warn = opts?.onWarn ?? defaultWarn;
  const idleThresholdMinutes = clampPaneCloseIdleThresholdMinutes(
    settings.paneCloseIdleThresholdMinutes,
  );

  try {
    const results: ReaperResult[] = await runReaper(deps, {
      idleThresholdMs: idleThresholdMinutes * 60 * 1000,
      dryRun: opts?.dryRun,
      ledgerPath: opts?.ledgerPath,
      alreadyClosedPaneIds: opts?.alreadyClosedPaneIds,
    });
    const closed = results.filter((r) => r.decision.close && r.success).length;
    const failed = results.filter((r) => !r.success).length;
    return { enabled: true, evaluated: results.length, closed, failed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`scheduled pass threw: ${message}`);
    return { enabled: true, evaluated: 0, closed: 0, failed: 0, error: message };
  }
}
