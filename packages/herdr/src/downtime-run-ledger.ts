/**
 * packages/herdr/src/downtime-run-ledger.ts — machine-scoped consecutive-run
 * ledger for the downtime dispatcher's "no project more than twice in
 * succession" bound.
 *
 * Work item: WL-0MWT3Z9M9002Z9BF (make run-length accounting
 * leadership-independent and auditable; parent WL-0MWKE9VF800101V9 AC1).
 * Introduced to replace the previous per-leader-root decision-log source.
 *
 * ## Why this file exists (the defect it fixes)
 *
 * The run length used to be DERIVED FROM THE TAIL OF THE LEADER'S OWN
 * `<leader-root>/.worklog/downtime-coordination.log`. Decision rows are
 * appended with the *leader's* `cwd`, so after a leadership hand-off to a
 * different root the new leader's log held no dispatch rows from the previous
 * leader: `previousDispatchRun` returned `null` and the bound failed **open**
 * — silently disabled — for the first two dispatches of the new leadership.
 * A live measurement (WL-0MWNN84HO004DXQU) caught two runs of 3 against a
 * ceiling of 2 for exactly this reason.
 *
 * ## The chosen source (decision + cost/lock trade-off, parent AC1)
 *
 * A single machine-scoped record in the coordination directory the dispatcher
 * already trusts (`~/.herdr/downtime/`, `opts.coordinationDir`):
 *
 *     { "root": "<worklogRoot>", "runLength": N, "at": "<ISO-8601>" }
 *
 * - **Leadership-independent.** One record any leader on this host reads and
 *   writes, so a hand-off between roots cannot reset a live run to `1`.
 * - **Keyed on the same project identity as the round-robin cursor**
 *   (`worklogRoot`), so a future remote-host ledger (WL-0MWNYIL3Y0093GY0) can
 *   key it on the same identity.
 * - **One small JSON record, not a per-root map.** A per-root map cannot
 *   express dispatch ORDER, so it could not answer "what was the last
 *   dispatch?", which the current run's identity depends on.
 * - **Cost: one read-modify-write under the EXISTING coordination lock**
 *   (`tryAcquireCoordLock`, the same lock `advanceRoot` uses for the cursor).
 *   It is a separate acquisition from the cursor charge (the charge happens in
 *   the leader before the decision is recorded; this ledger is written when
 *   the dispatch is recorded), but it never nests inside another lock and
 *   dispatches are bounded (~60/hour), so the cost is negligible.
 *
 * Alternatives considered and rejected on the work item: a cross-generation
 * read of the leader's own log (still per-leader-root — cannot satisfy
 * leadership-independence) and a pure durable per-root cursor (the round-robin
 * cursor already stores last-dispatch time; a second cursor for the run
 * duplicates a source of truth — this single record is the minimal durable
 * state the log tail used to provide).
 *
 * ## Fail-open (unchanged contract)
 *
 * Every reader/writer here is total and never throws: a missing, unreadable or
 * corrupt ledger degrades to "no previous dispatch" (run length `1`), and a
 * failed write is swallowed. Nothing here can block, fail or delay a dispatch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { tryAcquireCoordLock } from './coordination.js';

// ── Constants ──────────────────────────────────────────────────────────

/** Run-ledger file name (inside the machine coordination directory). */
export const RUN_LEDGER_FILE_NAME = 'downtime-run-by-root.json';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * The last consumed dispatch's run state.
 *
 * `root` is the `worklogRoot` whose offer was consumed, `runLength` is how
 * many dispatches in succession went to that root INCLUDING this one (`>= 1`),
 * and `at` is when it happened. Only `dispatched` outcomes are recorded (a
 * consumed-but-not-dispatched claim keeps the cursor charge but, as before,
 * neither extends nor breaks a run).
 */
export interface DispatchRunRecord {
  root: string;
  runLength: number;
  at: string;
}

// ── Path resolution ────────────────────────────────────────────────────

/** Resolve the ledger file path inside the coordination directory. */
function ledgerFilePath(coordinationDir: string): string {
  return path.join(coordinationDir, RUN_LEDGER_FILE_NAME);
}

// ── Load / Save ────────────────────────────────────────────────────────

/** Validate a parsed JSON value as a `DispatchRunRecord`. */
function isValidRecord(value: unknown): value is DispatchRunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.root === 'string' &&
    record.root.length > 0 &&
    typeof record.runLength === 'number' &&
    Number.isFinite(record.runLength) &&
    record.runLength >= 1 &&
    typeof record.at === 'string' &&
    Number.isFinite(Date.parse(record.at))
  );
}

/**
 * Load the current run record from disk.
 *
 * **Fail-open:** missing file, empty file, corrupt JSON or a malformed record
 * all resolve `null` ("no previous dispatch"). Never throws.
 */
export function loadDispatchRun(coordinationDir: string): DispatchRunRecord | null {
  try {
    const raw = fs.readFileSync(ledgerFilePath(coordinationDir), 'utf-8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidRecord(parsed)) return null;
    return {
      root: parsed.root,
      runLength: Math.trunc(parsed.runLength),
      at: parsed.at,
    };
  } catch {
    return null; // missing / unreadable / corrupt → no history (fail-open)
  }
}

/**
 * Atomically write the run record (tmp+rename, same pattern as the cursor).
 *
 * **Fail-open:** an I/O failure is silently tolerated — the ledger keeps its
 * previous value and dispatch is not blocked.
 */
function saveDispatchRun(coordinationDir: string, record: DispatchRunRecord): void {
  try {
    const fp = ledgerFilePath(coordinationDir);
    const tmpPath = `${fp}.tmp`;
    fs.mkdirSync(coordinationDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(record), 'utf-8');
    fs.renameSync(tmpPath, fp);
  } catch {
    // I/O failure — fail-open, dispatch continues.
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * The current run as `{ root, length }`, or `null` when the ledger holds no
 * usable history.
 *
 * This is the **ordering** read (used by `readPreviousDispatchRun`): at
 * ordering time this tick has not yet dispatched, so the record describes the
 * PREVIOUS dispatch — exactly the value the run-length ceiling rule needs.
 * Pure read, never throws.
 */
export function readCurrentDispatchRun(
  coordinationDir: string,
): { root: string; length: number } | null {
  const record = loadDispatchRun(coordinationDir);
  return record === null ? null : { root: record.root, length: record.runLength };
}

/**
 * The run length a dispatch to `root` WOULD record, derived from the current
 * ledger without mutating it. `1` on a missing/corrupt ledger or a root change.
 *
 * Used for the fail-open value when the ledger cannot be advanced (lock
 * contention or a skipped write), so the recorded figure stays consistent with
 * what the ledger says. Pure read, never throws.
 */
export function peekNextRunLength(coordinationDir: string, root: string): number {
  if (root.length === 0) return 1;
  const previous = loadDispatchRun(coordinationDir);
  if (previous === null || previous.root !== root) return 1;
  return previous.runLength + 1;
}

/**
 * Record a consumed dispatch to `root` and return its new run length.
 *
 * Read-modify-write under the coordination lock: the previous record extends
 * the run when it names the same root, otherwise a fresh run of `1` starts.
 * The returned value is written to the decision entry as
 * `consecutiveRunLength`, so the log and the ledger name the same number.
 *
 * **Fail-open:** lock contention or a failed write leaves the ledger
 * unchanged and returns {@link peekNextRunLength} (never throws, never blocks).
 *
 * @param coordinationDir — The machine coordination directory.
 * @param root — The `worklogRoot` whose offer was consumed.
 * @param now — Current timestamp (ms).
 * @returns The run length to record (`>= 1`).
 */
export function recordDispatchRun(
  coordinationDir: string,
  root: string,
  now: number = Date.now(),
): number {
  if (root.length === 0) return 1;
  const release = tryAcquireCoordLock(coordinationDir);
  if (release === null) {
    // Lock contention — leave the ledger untouched and report the value the
    // ledger already implies (fail-open, never blocks the dispatch).
    return peekNextRunLength(coordinationDir, root);
  }
  try {
    const previous = loadDispatchRun(coordinationDir);
    const runLength = previous !== null && previous.root === root ? previous.runLength + 1 : 1;
    saveDispatchRun(coordinationDir, {
      root,
      runLength,
      at: new Date(now).toISOString(),
    });
    return runLength;
  } finally {
    release();
  }
}
