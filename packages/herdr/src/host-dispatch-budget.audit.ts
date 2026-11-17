/**
 * packages/herdr/src/host-dispatch-budget.audit.ts — append-only audit trail
 * for host dispatch-budget ledger mutations (WL-0MWFJDGXQ001OXP8, parent
 * WL-0MWFJD1RV008FCCR).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `dispatch-budget.json` is rewritten wholesale on every mutation and keeps no
 * history, so during the 2026-11-13 RCA it was impossible to establish *which*
 * code path deleted six confirmed entries: the ledger records current state
 * only, the dispatch log records dispatches, and nothing recorded reserve /
 * confirm / release / reap / sweep / repair events. This module is that
 * missing record.
 *
 * ## Contract
 *
 * One JSONL line per ledger mutation, in `<machine dir>/dispatch-budget.log`
 * (the machine coordination dir, `~/.herdr/downtime` by default — see
 * `machine-coordination.ts`). Every line carries at least:
 *
 *     { "at": "<ISO-8601>", "op": "reserve" | "confirm" | "release" | "reap"
 *                                   | "sweep" | "repair",
 *       "kind": "implement" | "audit" | "all",
 *       "itemId": "<work item id, '' when the mutation is not per-entry>",
 *       "paneId": "<pane id when known>",
 *       "instanceId": "<herdr instance or actor process>",
 *       "reason": "<why this mutation happened>",
 *       "actor": "<who performed it>",
 *       "liveBefore": <count before, -1 when unknowable>,
 *       "liveAfter":  <count after,  -1 when unknowable> }
 *
 * `liveBefore`/`liveAfter` are per-tick entry counts for the line's `kind`
 * (`kind: "all"` counts the whole document), so a reader can see the figure
 * the operator-facing counter was quoting move as a result of exactly one
 * operation. `-1` is the explicit "cannot be determined" value — used by
 * `repair`, which overwrites a ledger it may have been unable to read.
 *
 * Which mutations emit which lines:
 *
 *  - `reserve` / `confirm` — exactly one line (the entry written).
 *  - `release` — one line, and ONLY when an entry was actually removed; the
 *    line names the removed entry's kind, item id, pane and owning instance,
 *    so a deletion is attributable to the entry it destroyed.
 *  - `reap` / `sweep` — one line per removed entry (deliberately per-entry:
 *    "which six confirmed entries vanished?" is the question this trail has
 *    to answer).
 *  - `repair` — one line, `kind: "all"`, `itemId: ""`.
 *
 * ## Rotation and retention
 *
 * The trail reuses the coordination-log retention policy
 * (`downtime-log-storage.ts`: per-file cap plus numbered siblings, bounded
 * disk) through the shared pure planner `planRollingJsonl`, so the trail's
 * bound can never drift from the decision log's. The default policy is
 * {@link resolveCoordinationLogPolicy}'s (500 entries per file, 3 rotated
 * siblings ⇒ 1 501–2 000 retained lines).
 *
 * ## Fail-open by contract
 *
 * A logging failure NEVER throws, NEVER blocks a dispatch and NEVER changes an
 * admission/refusal decision: {@link appendBudgetAuditLine} returns a result
 * object and every caller ignores it. The write is synchronous so it lands
 * inside the ledger lock that produced the mutation (no interleaved lines from
 * two writers) — and a slow or failing trail therefore still cannot extend the
 * lock beyond one small file write.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  planRollingJsonl,
  resolveCoordinationLogPolicy,
  type CoordinationLogPolicy,
} from './downtime-log-storage.js';

// ── Contract constants ─────────────────────────────────────────────────

/** Audit-trail file name inside the machine coordination dir. */
export const DISPATCH_BUDGET_LOG_FILE = 'dispatch-budget.log';

/** Operations the trail records. */
export type BudgetAuditOp =
  | 'reserve'
  | 'confirm'
  | 'release'
  | 'reap'
  | 'sweep'
  | 'repair';

/** Entry kind of the mutation; `all` is a whole-document mutation (repair). */
export type BudgetAuditKind = 'implement' | 'audit' | 'all';

/** Sentinel for a count that cannot be determined (a repair over bad bytes). */
export const BUDGET_AUDIT_UNKNOWN_COUNT = -1;

/** One audit-trail line, exactly the on-disk shape. */
export interface BudgetAuditLine {
  /** ISO-8601 timestamp of the mutation. */
  at: string;
  op: BudgetAuditOp;
  kind: BudgetAuditKind;
  /** Work item the mutation concerned; `''` for a whole-document mutation. */
  itemId: string;
  /** Pane id when one was known at mutation time. */
  paneId?: string;
  /** herdr instance (or actor process) that owned the affected entry. */
  instanceId: string;
  /** Why the mutation happened (`pane-close`, `reap-stale`, …). */
  reason: string;
  /** Who performed it — the dispatching process by default. */
  actor: string;
  /** Entries of `kind` before the mutation; `-1` when unknowable. */
  liveBefore: number;
  /** Entries of `kind` after the mutation; `-1` when unknowable. */
  liveAfter: number;
}

/** Outcome of one append. Never thrown — inspect it if you care. */
export type BudgetAuditAppendResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'io-error' };

// ── Paths ──────────────────────────────────────────────────────────────

/** Absolute audit-trail path inside a machine coordination `dir`. */
export function budgetAuditTrailPath(dir: string): string {
  return path.join(dir, DISPATCH_BUDGET_LOG_FILE);
}

/** The trail's retention policy (the coordination-log policy). */
export function budgetAuditTrailPolicy(
  input?: { maxEntries?: number; maxRotatedFiles?: number },
): CoordinationLogPolicy {
  return resolveCoordinationLogPolicy(input);
}

// ── Sync storage (mirrors the async rolling appender) ──────────────────

function readTrailLines(file: string): string[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((ln) => ln.trim() !== '');
  } catch {
    return []; // first entry, or unreadable file → start a fresh one
  }
}

/**
 * Atomic JSONL write: a temporary sibling file + `rename(2)`, so a concurrent
 * reader never observes a truncated or partially written trail.
 */
function writeTrailFileSync(dir: string, file: string, lines: string[]): void {
  const target = path.join(dir, file);
  const tmp = path.join(dir, `.${file}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort — the rename never happened
    }
    throw err;
  }
}

/**
 * Append one line to `<dir>/dispatch-budget.log`, bounded by the
 * coordination-log policy.
 *
 * Never throws: a missing directory, a read-only filesystem, an unwritable
 * file or a malformed existing line all resolve to `{ ok: false }` and leave
 * the caller's dispatch (or refusal) decision untouched — logging is not a
 * gate. Malformed existing lines are tolerated (they re-serialise as-is, since
 * the trail is a rolling line buffer, not a re-parsed document).
 */
export function appendBudgetAuditLine(
  dir: string,
  line: BudgetAuditLine,
  policy: CoordinationLogPolicy = budgetAuditTrailPolicy(),
): BudgetAuditAppendResult {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = budgetAuditTrailPath(dir);
    const serialised = JSON.stringify(line);
    const plan = planRollingJsonl(readTrailLines(file), serialised, policy);
    for (const k of plan.shifts) {
      try {
        fs.renameSync(
          path.join(dir, `${DISPATCH_BUDGET_LOG_FILE}.${k}`),
          path.join(dir, `${DISPATCH_BUDGET_LOG_FILE}.${k + 1}`),
        );
      } catch {
        // ENOENT: no sibling at this level yet — nothing to shift.
      }
    }
    for (const write of plan.writes) {
      writeTrailFileSync(dir, `${DISPATCH_BUDGET_LOG_FILE}${write.suffix}`, write.lines);
    }
    return { ok: true, path: file };
  } catch {
    return { ok: false, reason: 'io-error' };
  }
}

/**
 * Read the trail back (tests and the documented RCA procedure).
 *
 * Fail-safe by construction: a missing file is `[]` and malformed lines are
 * skipped, so a damaged trail never breaks the diagnostic that needs it.
 * Rotated siblings are NOT read here — the operator's procedure greps the
 * current file plus its `.1`…`.N` siblings with the same reader
 * (`dispatch-budget.log*`); returning the live file keeps this helper's
 * semantics obvious.
 */
export function readBudgetAuditTrail(dir: string): BudgetAuditLine[] {
  const raw = readTrailLines(budgetAuditTrailPath(dir));
  const lines: BudgetAuditLine[] = [];
  for (const line of raw) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        lines.push(parsed as BudgetAuditLine);
      }
    } catch {
      // malformed line → skip (fail-safe)
    }
  }
  return lines;
}

/** Rotated trail file names present in `dir`, newest first (`.1`, `.2`, …). */
export function budgetAuditRotatedFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${DISPATCH_BUDGET_LOG_FILE}.`))
      .sort((a, b) => {
        const na = Number(a.slice(DISPATCH_BUDGET_LOG_FILE.length + 1));
        const nb = Number(b.slice(DISPATCH_BUDGET_LOG_FILE.length + 1));
        return na - nb;
      });
  } catch {
    return [];
  }
}
