/**
 * packages/herdr/src/downtime-worker.prep-supply-source.ts — the ACQUISITION
 * half of the prep-supply report (WL-0MWTBJ7G1004Y29B, child 2 of
 * WL-0MWTAD1KM0081UUD).
 *
 * Single responsibility: turn a worklog root into the plain data the pure
 * report core (`downtime-worker.prep-supply-report.ts`) classifies. It is the
 * ONLY place in the report path that spawns `wl` or reads a log — the core
 * imports no I/O, which is what keeps the measurement read-only by
 * construction.
 *
 * ## The two reads (AC2: the gap and its fallback)
 *
 * 1. `wl worklist --json` — the consolidated read the Herdr worklist already
 *    issues (browse feed + critical / review-queue / in-progress-root /
 *    blocked-root subsets). It has **NO prep-stage subset**, so it only covers
 *    prep items that happen to be in those subsets.
 * 2. `wl list --json --status open,blocked,in-progress,input-needed,completed
 *    --stage <idea|intake_complete> --include-not-started` — one full per-root
 *    read per prep stage. `--include-not-started` is required: the CLI's
 *    default search hides future `startOn` items, and hiding them would
 *    silently empty the report's `startOn` bucket.
 *
 * The report core merges the two by item id and records the coverage counts.
 *
 * ## Dependency edges
 *
 * `wl list --json` carries no dependency edges, so they are read separately for
 * the prep-scope ids: the hydrator's batched in-process reader first
 * (`withInProcessDb` + `readOutboundDepsInProcess`, F4 lineage — one pass, no
 * per-item spawn), falling back to one `wl dep list <id> --json` spawn per item
 * when the in-process read is unavailable. A missing target keeps the CLI's
 * `deleted` status semantics; an edge WITHOUT a status stays unresolved, which
 * the classifier treats as an unmet blocker (fail-closed).
 *
 * ## Read-only
 *
 * Every operation here is a read: no `wl update`, no marker append, no flag or
 * assignee mutation, and the in-process connection is opened READONLY by the
 * shared leaf. Setting the query scope per root is done with the per-call
 * `--worklog-dir` argument vector (never the module-global override), so
 * reading one root can never redirect another root's read.
 */

import { join } from 'node:path';

import {
  CLI_BINARIES,
  DEFAULT_CLI_TIMEOUT_MS,
  spawnCliStdout,
  type CliExecFile,
} from './cli-spawn.js';
import { readDowntimeLogEntries, type DowntimeLogEntry } from './downtime-log-entries.js';
import { PREP_SUPPLY_STAGES, type PrepSupplyItem } from './downtime-worker.prep-supply.js';
import type {
  PrepSupplyFullRead,
  PrepSupplyReportDeps,
} from './downtime-worker.prep-supply-report.js';
import { parseDepListBlockersOutput } from './downtime-worker.parsers.js';
import { buildWlArgsForRoot, getExecFileAsync } from './fetcher.args.js';
import { readOutboundDepsInProcess, withInProcessDb } from './fetcher.inprocess.js';
import type { DependencyTargetRef } from './fetcher.types.js';

/**
 * Statuses the full per-root read requests. `completed` is included so a
 * terminal prep-stage item is reported as an exclusion instead of silently
 * missing; `deleted`/soft-deleted items are deliberately NOT requested (they
 * are never prep supply and the soft-delete predicate owns that verdict).
 */
export const PREP_SUPPLY_FALLBACK_STATUSES =
  'open,blocked,in-progress,input-needed,completed';

/** Upper bound for one `wl` read (`wl list` over a large root can exceed 1 MB). */
export const PREP_SUPPLY_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Injectable I/O, so tests exercise the acquisition without real processes. */
export interface PrepSupplySourceIo {
  exec: CliExecFile;
  readLogEntries(root: string): Promise<ReadonlyArray<DowntimeLogEntry>>;
  /**
   * Batched outbound dependency targets per item; `undefined` means "not
   * available in-process" and triggers the `wl dep list` fallback.
   */
  readDependencyTargets(
    root: string,
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, DependencyTargetRef[]> | undefined>;
}

const STRING_FIELDS = [
  'title',
  'status',
  'stage',
  'priority',
  'risk',
  'effort',
  'assignee',
  'updatedAt',
  'deletedBy',
  'startOn',
  'createdAt',
] as const;

/**
 * Map one `wl` JSON record onto the classifier's item shape. Unknown fields
 * are dropped (the report measures a fixed vocabulary) and a record without a
 * non-empty id is not an item.
 */
export function toPrepSupplyItem(raw: unknown): PrepSupplyItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;

  const item: PrepSupplyItem = { id: record.id };
  for (const field of STRING_FIELDS) {
    const value = record[field];
    if (typeof value === 'string') item[field] = value;
  }
  const auditedAt = record.auditedAt;
  if (typeof auditedAt === 'string' || auditedAt === null) item.auditedAt = auditedAt;
  const fingerprint = record.fingerprint;
  if (typeof fingerprint === 'string' || fingerprint === null) item.fingerprint = fingerprint;
  const currentFingerprint = record.currentFingerprint;
  if (typeof currentFingerprint === 'string' || currentFingerprint === null) {
    item.currentFingerprint = currentFingerprint;
  }
  if (typeof record.sortIndex === 'number') item.sortIndex = record.sortIndex;
  if (typeof record.needsProducerReview === 'boolean') {
    item.needsProducerReview = record.needsProducerReview;
  }
  const auditResult = record.auditResult;
  if (typeof auditResult === 'boolean' || auditResult === null) item.auditResult = auditResult;
  return item;
}

/**
 * Parse `wl worklist --json`. Every subset is read (browse entries wrap their
 * item as `{ workItem }`; the four mandatory subsets are bare items), deduped
 * by id. Malformed JSON or a payload without a `subsets` object yields `null`
 * — fail-closed, because an empty report on an unreadable source would read as
 * "no prep supply".
 */
export function parseWorklistItems(stdout: string): PrepSupplyItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const subsets = (parsed as { subsets?: unknown }).subsets;
  if (typeof subsets !== 'object' || subsets === null || Array.isArray(subsets)) return null;

  const byId = new Map<string, PrepSupplyItem>();
  for (const value of Object.values(subsets as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const raw =
        typeof entry === 'object' && entry !== null && 'workItem' in entry
          ? (entry as { workItem: unknown }).workItem
          : entry;
      const item = toPrepSupplyItem(raw);
      if (item !== null) byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}

/**
 * Parse `wl list --json`. Malformed JSON or a payload without a `workItems`
 * array yields `null` (fail-closed); a valid empty list yields `[]`.
 */
export function parseListItems(stdout: string): PrepSupplyItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const workItems = (parsed as { workItems?: unknown }).workItems;
  if (!Array.isArray(workItems)) return null;
  const items: PrepSupplyItem[] = [];
  for (const raw of workItems) {
    const item = toPrepSupplyItem(raw);
    if (item !== null) items.push(item);
  }
  return items;
}

/** True for an item the classifier can put in a bucket (a prep stage). */
function isPrepStageItem(item: PrepSupplyItem): boolean {
  const stage = typeof item.stage === 'string' ? item.stage : '';
  return (PREP_SUPPLY_STAGES as ReadonlyArray<string>).includes(stage);
}

/** The default batched dependency read: one read-only in-process pass. */
async function readDependencyTargetsInProcess(
  root: string,
  ids: ReadonlyArray<string>,
): Promise<Map<string, DependencyTargetRef[]> | undefined> {
  return withInProcessDb(
    (db) => readOutboundDepsInProcess(db, [...ids]),
    join(root, '.worklog'),
  );
}

interface DependencyEdges {
  byItem: Map<string, Array<{ from: string; to: string }>>;
  blockerStatusById: Record<string, string | undefined>;
}

function collectEdges(
  itemIds: ReadonlyArray<string>,
  targets: Map<string, DependencyTargetRef[]>,
): DependencyEdges {
  const byItem = new Map<string, Array<{ from: string; to: string }>>();
  const blockerStatusById: Record<string, string | undefined> = {};
  for (const id of itemIds) {
    const refs = targets.get(id) ?? [];
    const edges: Array<{ from: string; to: string }> = [];
    for (const ref of refs) {
      edges.push({ from: id, to: ref.id });
      if (typeof ref.status === 'string') blockerStatusById[ref.id] = ref.status;
    }
    if (edges.length > 0) byItem.set(id, edges);
  }
  return { byItem, blockerStatusById };
}

function wlReadArgs(root: string, args: string[]): string[] {
  return buildWlArgsForRoot(root, args);
}

/**
 * The full per-root prep read: two `wl list --json` reads (one per prep stage),
 * deduped by id, enriched with the dependency edges of every prep-stage item.
 * Throws on an unparseable payload — a broken read must surface as this root's
 * error, never as an empty (healthy-looking) bucket set.
 */
async function readFullRoot(
  root: string,
  io: Pick<PrepSupplySourceIo, 'exec' | 'readDependencyTargets'>,
): Promise<PrepSupplyFullRead> {
  const byId = new Map<string, PrepSupplyItem>();
  for (const stage of PREP_SUPPLY_STAGES) {
    const stdout = await spawnCliStdout(
      io.exec,
      CLI_BINARIES,
      wlReadArgs(root, [
        'list',
        '--json',
        '--status',
        PREP_SUPPLY_FALLBACK_STATUSES,
        '--stage',
        stage,
        '--include-not-started',
      ]),
      { timeoutMs: DEFAULT_CLI_TIMEOUT_MS, maxBuffer: PREP_SUPPLY_MAX_BUFFER_BYTES },
    );
    const items = parseListItems(stdout);
    if (items === null) {
      throw new Error(`unparseable wl list --json output for ${root} (stage ${stage})`);
    }
    for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  }

  const all = [...byId.values()];
  const prepIds = all.filter(isPrepStageItem).map((item) => item.id);

  let edges: DependencyEdges = { byItem: new Map(), blockerStatusById: {} };
  if (prepIds.length > 0) {
    const targets = await io.readDependencyTargets(root, prepIds);
    if (targets !== undefined) {
      edges = collectEdges(prepIds, targets);
    } else {
      // Fail-open to the CLI: one `wl dep list <id> --json` per prep item.
      const spawned = new Map<string, DependencyTargetRef[]>();
      for (const id of prepIds) {
        const stdout = await spawnCliStdout(
          io.exec,
          CLI_BINARIES,
          wlReadArgs(root, ['dep', 'list', id, '--json']),
          { timeoutMs: DEFAULT_CLI_TIMEOUT_MS, maxBuffer: PREP_SUPPLY_MAX_BUFFER_BYTES },
        );
        const blockers = parseDepListBlockersOutput(stdout);
        if (blockers === null) {
          throw new Error(`unparseable wl dep list output for ${root} (item ${id})`);
        }
        spawned.set(
          id,
          blockers.map((blocker) => ({ id: blocker.id, status: blocker.status })),
        );
      }
      edges = collectEdges(prepIds, spawned);
    }
  }

  const items = all.map((item) => {
    const itemEdges = edges.byItem.get(item.id);
    return itemEdges === undefined ? item : { ...item, dependencies: itemEdges };
  });
  return { items, blockerStatusById: edges.blockerStatusById };
}

/**
 * Wire the production reads (consolidated worklist, full per-root fallback,
 * batched dependency edges, rolling dispatch log) into the report's read-only
 * seam. Tests override every operation.
 */
export function createPrepSupplyReportDeps(
  io: Partial<PrepSupplySourceIo> = {},
): PrepSupplyReportDeps {
  const exec = io.exec ?? getExecFileAsync();
  const readLogEntries = io.readLogEntries ?? ((root: string) => readDowntimeLogEntries(root));
  const readDependencyTargets = io.readDependencyTargets ?? readDependencyTargetsInProcess;

  return {
    async readWorklist(root: string) {
      const stdout = await spawnCliStdout(
        exec,
        CLI_BINARIES,
        wlReadArgs(root, ['worklist', '--json']),
        { timeoutMs: DEFAULT_CLI_TIMEOUT_MS, maxBuffer: PREP_SUPPLY_MAX_BUFFER_BYTES },
      );
      const items = parseWorklistItems(stdout);
      if (items === null) {
        throw new Error(`unparseable wl worklist --json output for ${root}`);
      }
      return { items };
    },
    readFull: (root: string) => readFullRoot(root, { exec, readDependencyTargets }),
    readLogEntries,
  };
}
