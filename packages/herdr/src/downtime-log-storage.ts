/**
 * packages/herdr/src/downtime-log-storage.ts — rolling JSONL storage engine
 * for the downtime dispatch and coordination logs
 * (WL-0MVGKHFT4003X6JW, split out of `downtime-log.ts`).
 *
 * Single responsibility: **where** the two rolling logs live, **how many**
 * entries they retain, and **how** one line is appended atomically (temp
 * sibling file + `rename(2)`) with bounded trimming or size-based rotation.
 * It owns no entry shape and no reader semantics — those live in
 * `downtime-log-entries.ts` (dispatch log) and
 * `downtime-log-coordination.ts` (coordination/decision log).
 *
 * Extracted verbatim from `downtime-log.ts`; behaviour is unchanged.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** File name of the downtime dispatch audit log inside `.worklog/`. */
export const DOWNTIME_LOG_FILE = 'downtime-dispatches.log';

/**
 * File name of the coordination ops log inside `.worklog/` — a separate
 * rolling log for leader-election / coordination-file operations
 * (WL-0MSXHAE290067VAL, parent WL-0MST3OJ8S0001ROL): check-ins,
 * elections/re-elections, and stale-entry pruning. Kept SEPARATE from the
 * dispatch log so the dispatch-marker readers (which scan
 * `downtime-dispatches.log` by kind) never see coordination entries.
 */
export const COORDINATION_LOG_FILE = 'downtime-coordination.log';

/** Rolling bound for the DISPATCH log only: keep at most this many entries. */
export const DOWNTIME_LOG_MAX_ENTRIES = 100;

/**
 * Per-file entry cap for the COORDINATION log before it rotates to a
 * numbered sibling (WL-0MVKNC28B003UOLX AC2). The dispatch log keeps its
 * smaller single-file bound (`DOWNTIME_LOG_MAX_ENTRIES`); only the
 * coordination/decision log carries the 24 h retention. Default: 500
 * entries per file.
 */
export const COORDINATION_LOG_MAX_ENTRIES = 500;

/**
 * Number of rotated coordination-log siblings kept (WL-0MVKNC28B003UOLX
 * AC2). Together with `COORDINATION_LOG_MAX_ENTRIES` the retained window is
 * bounded by `maxEntries × (1 + maxRotatedFiles)` entries and never falls
 * below `maxEntries × maxRotatedFiles + 1` — the documented default (500
 * per file, 3 rotated) therefore always holds 1,501–2,000 entries, covering
 * ≥ 25 h at the observed ≥ 60 decision entries/hour (a full overnight
 * post-mortem window) while bounding disk use to ~2,000 JSONL lines.
 */
export const COORDINATION_LOG_MAX_ROTATED_FILES = 3;

/** Floor for the per-file coordination-log cap (clamped, AC2). */
export const COORDINATION_LOG_MIN_ENTRIES = 10;
/** Ceiling for the per-file coordination-log cap (bounded disk, AC2). */
export const COORDINATION_LOG_MAX_ENTRIES_CEILING = 10_000;
/** Ceiling for rotated coordination-log siblings (bounded disk, AC2). */
export const COORDINATION_LOG_MAX_ROTATED_FILES_CEILING = 20;

/**
 * Resolved coordination-log retention/rotation policy
 * (WL-0MVKNC28B003UOLX AC2) — see {@link resolveCoordinationLogPolicy}.
 */
export interface CoordinationLogPolicy {
  /** Per-file entry cap before rotation; clamped to [10, 10 000]. */
  maxEntries: number;
  /**
   * Rotated siblings kept; `0` disables rotation (single-file trim at the
   * cap). Clamped to [0, 20].
   */
  maxRotatedFiles: number;
}

/** Unresolved (partial) coordination-log policy; missing fields take the documented defaults. */
export interface CoordinationLogPolicyInput {
  maxEntries?: number;
  maxRotatedFiles?: number;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Resolve a (partial) coordination-log retention policy to its clamped,
 * defaulted form (WL-0MVKNC28B003UOLX AC2). Missing fields fall back to
 * `COORDINATION_LOG_MAX_ENTRIES` / `COORDINATION_LOG_MAX_ROTATED_FILES`;
 * out-of-range values are clamped to `[COORDINATION_LOG_MIN_ENTRIES,
 * COORDINATION_LOG_MAX_ENTRIES_CEILING]` / `[0,
 * COORDINATION_LOG_MAX_ROTATED_FILES_CEILING]` so disk growth stays bounded.
 * Pure and total: never throws.
 */
export function resolveCoordinationLogPolicy(
  input?: CoordinationLogPolicyInput,
): CoordinationLogPolicy {
  return {
    maxEntries: clampInt(
      input?.maxEntries ?? COORDINATION_LOG_MAX_ENTRIES,
      COORDINATION_LOG_MIN_ENTRIES,
      COORDINATION_LOG_MAX_ENTRIES_CEILING,
    ),
    maxRotatedFiles: clampInt(
      input?.maxRotatedFiles ?? COORDINATION_LOG_MAX_ROTATED_FILES,
      0,
      COORDINATION_LOG_MAX_ROTATED_FILES_CEILING,
    ),
  };
}

/**
 * Resolve the coordination-log retention policy from the worker's live
 * config slice (WL-0MVKNC28B003UOLX AC2): `coordinationLogMaxEntries` /
 * `coordinationLogMaxRotatedFiles` from `DowntimeWorkerConfig.config()`,
 * falling back to (and clamped like) {@link resolveCoordinationLogPolicy}.
 */
export function coordinationLogPolicyFromConfig(cfg: {
  coordinationLogMaxEntries?: number;
  coordinationLogMaxRotatedFiles?: number;
}): CoordinationLogPolicy {
  return resolveCoordinationLogPolicy({
    maxEntries: cfg.coordinationLogMaxEntries,
    maxRotatedFiles: cfg.coordinationLogMaxRotatedFiles,
  });
}

/**
 * Tolerantly parse the JSONL lines of a raw log file content into objects:
 * malformed lines are skipped, an empty/whitespace-only file yields `[]`,
 * and non-object JSON values are ignored. Used by every rolling-log reader
 * (fail-safe, never throws).
 *
 * Exported for the sibling readers only — deliberately not part of the
 * `downtime-log.js` public surface.
 */
export function parseJsonlLines(raw: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        entries.push(parsed as Record<string, unknown>);
      }
    } catch {
      // malformed line → skip (fail-safe)
    }
  }
  return entries;
}

/**
 * Bounded JSONL append shared by the dispatch and coordination logs.
 *
 * DISPATCH log (no `rotate` policy, `appendDowntimeLogEntry`/
 * `appendPaneCloseLogEntry`): write `line` to `<cwd>/.worklog/<file>`, creating
 * `.worklog` if needed and trimming to the most recent DOWNTIME_LOG_MAX_ENTRIES
 * lines (unchanged behaviour — the dispatched-marker readers depend on it).
 *
 * COORDINATION log (a `rotate` policy, `appendCoordinationLogEntry`):
 * size-based rotation with N kept (WL-0MVKNC28B003UOLX AC2). The current file
 * holds up to `rotate.maxEntries`; when the next append would exceed it the
 * whole current file rotates to `.1` (older siblings shift down; the oldest
 * beyond `rotate.maxRotatedFiles` is dropped) and a fresh current file — with
 * just the new line — starts, so the entry that triggers the rotation is
 * never lost (AC4). A pre-existing oversized current file (e.g. from the old
 * 100-entry era) is healed on the next append: it rotates wholesale before
 * the new line lands, so nothing is discarded.
 *
 * ATOMIC (WL-0MUBVL1FI0071WN3 / F5): every file write — current AND rotated
 * siblings — goes to a temporary sibling file and is `rename`d over the
 * target, so a concurrent reader can never observe a truncated, empty, or
 * partially written file. Rotation orders the writes so the CURRENT path
 * always exists with a complete snapshot: the full old content is written to
 * `.1` BEFORE the current file is replaced with the fresh single-line file.
 * `rename(2)` is atomic within a filesystem, so the temp file is created in
 * the SAME directory as the target. The temp file is removed on failure
 * before the error is rethrown (and the target is left untouched). Throws on
 * I/O failure — callers must catch (fail-closed).
 *
 * Exported for the sibling appenders only — deliberately not part of the
 * `downtime-log.js` public surface.
 */
export async function appendRollingJsonl(
  cwd: string,
  file: string,
  line: string,
  rotate?: CoordinationLogPolicy,
): Promise<void> {
  const dir = join(cwd, '.worklog');
  const filePath = join(dir, file);
  await mkdir(dir, { recursive: true });

  let lines: string[] = [];
  try {
    const existing = await readFile(filePath, 'utf8');
    lines = existing.split('\n').filter((ln) => ln.trim() !== '');
  } catch {
    lines = []; // first entry or unreadable file → start fresh
  }

  const plan = planRollingJsonl(lines, line, rotate);
  await applyRollingPlan(dir, file, plan, async (target, contents) => {
    await atomicWriteJsonl(dir, target, contents);
  });
}

/** One file a rolling append writes, in application order. */
export interface RollingJsonlWrite {
  /** Suffix appended to the base file name (``'.1'`` for the newest sibling). */
  suffix: string;
  /** Complete replacement content for that file. */
  lines: string[];
}

/**
 * The abstract plan for one bounded rolling JSONL append — **pure**, no I/O.
 *
 * Splitting the policy decision (which sibling rotates where, which lines
 * survive) from the write itself is what lets one policy serve two storage
 * back-ends: the async `.worklog` appender below and the budget ledger's
 * synchronous machine-dir appender
 * (`host-dispatch-budget.audit.ts`, WL-0MWFJDGXQ001OXP8), so the retention
 * bound can never drift between them.
 *
 * `shifts` lists the sibling renames to apply **first**, newest-index-last so
 * `.1` ends up holding the previous current content; `writes` then lists the
 * files to replace, rotated sibling before the current file, so the current
 * path always ends up with a complete snapshot (never empty, never partial).
 *
 * The three regimes are exactly {@link appendRollingJsonl}'s documented ones:
 *  - no policy ⇒ the legacy dispatch-log single-file bound
 *    ({@link DOWNTIME_LOG_MAX_ENTRIES});
 *  - `maxRotatedFiles === 0` ⇒ single-file trim at `maxEntries`;
 *  - otherwise ⇒ size-based rotation with N kept. A pre-existing oversized
 *    current file rotates wholesale on the next append, so nothing is
 *    discarded.
 *
 * Pure and total: never throws, never touches the filesystem.
 */
export function planRollingJsonl(
  lines: readonly string[],
  line: string,
  rotate?: CoordinationLogPolicy,
): { shifts: number[]; writes: RollingJsonlWrite[] } {
  const current = [...lines];
  if (rotate === undefined) {
    // Dispatch log: legacy single-file rolling bound (unchanged).
    current.push(line);
    const trimmed =
      current.length > DOWNTIME_LOG_MAX_ENTRIES
        ? current.slice(current.length - DOWNTIME_LOG_MAX_ENTRIES)
        : current;
    return { shifts: [], writes: [{ suffix: '', lines: trimmed }] };
  }

  if (rotate.maxRotatedFiles === 0) {
    // Rotation disabled: single-file trim at the configured per-file cap.
    current.push(line);
    const trimmed =
      current.length > rotate.maxEntries
        ? current.slice(current.length - rotate.maxEntries)
        : current;
    return { shifts: [], writes: [{ suffix: '', lines: trimmed }] };
  }

  if (current.length >= rotate.maxEntries) {
    // Current file is full: rotate it aside BEFORE appending, so the entry
    // that triggers the rotation is never lost (AC4).
    const shifts: number[] = [];
    for (let k = rotate.maxRotatedFiles - 1; k >= 1; k--) shifts.push(k);
    return {
      shifts,
      writes: [
        { suffix: '.1', lines: current },
        { suffix: '', lines: [line] },
      ],
    };
  }

  current.push(line);
  return { shifts: [], writes: [{ suffix: '', lines: current }] };
}

/**
 * Apply a {@link planRollingJsonl} plan through a caller-supplied writer.
 *
 * The shifts run first (skipping a missing sibling at a level — the early
 * rotation case), then the writes in plan order. Exported so a synchronous
 * back-end (the budget audit trail) reuses the identical write ORDER; only
 * the write primitive differs.
 */
export async function applyRollingPlan(
  dir: string,
  file: string,
  plan: { shifts: number[]; writes: RollingJsonlWrite[] },
  write: (target: string, lines: string[]) => Promise<void>,
): Promise<void> {
  for (const k of plan.shifts) {
    try {
      await rename(join(dir, `${file}.${k}`), join(dir, `${file}.${k + 1}`));
    } catch {
      // ENOENT: no sibling at this level yet (early rotations) — nothing to shift.
    }
  }
  for (const writePlan of plan.writes) {
    await write(`${file}${writePlan.suffix}`, writePlan.lines);
  }
}

/**
 * Atomic JSONL file write (WL-0MUBVL1FI0071WN3 / F5): write `lines` to a
 * temporary sibling file (`.<file>.<pid>.<random>.tmp` in the same directory,
 * so the rename stays on one filesystem) and `rename` it over the target. A
 * concurrent reader sees either the whole previous file or the whole new one.
 * The temp name carries pid + a random suffix so two concurrent writers never
 * collide on the same temp path. The temp file is removed on failure before
 * the error is rethrown and the target is left untouched. Throws on I/O
 * failure — callers must catch.
 */
async function atomicWriteJsonl(dir: string, file: string, lines: string[]): Promise<void> {
  const filePath = join(dir, file);
  const tmpPath = join(dir, `.${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
    await rename(tmpPath, filePath);
  } catch (err) {
    // Clean up the temp file (best-effort) and leave the target untouched.
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
