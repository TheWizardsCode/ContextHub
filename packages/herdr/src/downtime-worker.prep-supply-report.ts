/**
 * packages/herdr/src/downtime-worker.prep-supply-report.ts — the per-root
 * prep-supply REPORT: source merge, deterministic assembly and rendering
 * (WL-0MWTBJ7G1004Y29B, child 2 of WL-0MWTAD1KM0081UUD).
 *
 * ## Why this module exists
 *
 * The 2026-11-22/23 overnight run burned 873 refusals (588
 * `audit-budget-saturated`) with an empty prep bucket, and diagnosing it
 * required classifying items by hand. Child 1
 * (`downtime-worker.prep-supply.ts`) pinned the classification vocabulary; this
 * module is the layer above it: it turns the two read sources and a root's
 * rolling dispatch log into ONE repeatable, read-only per-root answer — the
 * counts per bucket plus the genuinely offerable item ids — and renders it as a
 * machine payload and a human table.
 *
 * ## Sources: the worklist covers part of the item set, the fallback the rest
 *
 * `wl worklist --json` is the consolidated read the Herdr worklist already
 * issues: the browse feed (default 20 items) plus the critical /
 * review-queue / in-progress-root / blocked-root subsets. It has **no
 * prep-stage subset**, so a prep item outside that coverage is invisible to
 * it. The gap is closed by the full per-root fallback read (`wl list --json`
 * per prep stage — see `downtime-worker.prep-supply-source.ts`). The merge is
 * by item id: the worklist read wins on item fields (it is the dispatcher's
 * own read), the fallback supplies the dependency edges the worklist payload
 * does not carry. {@link PrepSupplyCoverage} makes the gap measurable instead
 * of implicit.
 *
 * ## Read-only by construction
 *
 * This module performs no I/O at all: the reads arrive through the injected
 * {@link PrepSupplyReportDeps} seam (the CLI wires the real `wl`/log/edge
 * reads, tests wire fakes). Its import list is therefore the read-only
 * boundary: pure predicates only — no `node:fs`, no `node:child_process`, no
 * spawn seam. Nothing here mutates an item, a marker, a flag or an assignee,
 * and no dispatch decision is taken: the per-item classification is delegated
 * to `classifyPrepSupplyWindow`, which reuses the dispatcher's own gates.
 *
 * ## Stable and diffable
 *
 * Roots are sorted lexicographically, buckets alphabetically (the *primary
 * cause precedence* lives in the classifier and its documented table, not in
 * this output's key order) and item ids lexicographically within a bucket, so
 * two runs — even with the inputs in a different order — are byte-identical.
 * With `--now` frozen (see the CLI) a past window replays deterministically.
 *
 * Canonical bucket definitions and usage:
 * `docs/dev/downtime-dispatcher.md` → *Prep-supply report command*.
 */

import type { DowntimeLogEntry } from './downtime-log-entries.js';
import {
  PREP_SUPPLY_BUCKETS,
  classifyPrepSupplyWindow,
  type PrepSupplyBucket,
  type PrepSupplyContext,
  type PrepSupplyExclusion,
  type PrepSupplyItem,
  type PrepSupplyVerdict,
} from './downtime-worker.prep-supply.js';

/** Payload schema version — bump when a consumer-visible shape changes. */
export const PREP_SUPPLY_REPORT_SCHEMA_VERSION = 1;

/**
 * The report's bucket order: **alphabetical**, so the output is "sorted by
 * root, then bucket, then item id" as documented. The classifier's own
 * precedence order remains `PREP_SUPPLY_BUCKETS` (documented, tested there).
 */
export const PREP_SUPPLY_REPORT_BUCKET_ORDER: readonly PrepSupplyBucket[] = Object.freeze(
  [...PREP_SUPPLY_BUCKETS].sort(),
);

/** The exclusion reasons, alphabetical (the table's summary line order). */
const PREP_SUPPLY_EXCLUSION_ORDER: readonly PrepSupplyExclusion[] = Object.freeze(
  ['not-prep-stage', 'terminal-status', 'soft-deleted'].sort() as PrepSupplyExclusion[],
);

/**
 * Measurable source coverage per root. `worklistOnly` items (known to the
 * consolidated read, absent from the fallback) and `fullOnly` items (the
 * prep-subset gap the worklist cannot see) are both reported, so the fallback
 * is never an invisible assumption.
 */
export interface PrepSupplyCoverage {
  /** Items the consolidated `wl worklist --json` read returned. */
  worklistItems: number;
  /** Items the full per-root prep read returned. */
  fullItems: number;
  /** Distinct items after the merge. */
  mergedItems: number;
  /** Items only the worklist read knew about. */
  worklistOnly: number;
  /** Items only the full per-root read knew about (the worklist gap). */
  fullOnly: number;
}

/** The full per-root fallback read (items + the dependency blocker statuses). */
export interface PrepSupplyFullRead {
  items: ReadonlyArray<PrepSupplyItem>;
  /**
   * Status of every blocker referenced by a dependency edge of a prep item.
   * An absent entry is treated as UNMET by the classifier (fail-closed).
   */
  blockerStatusById?: Readonly<Record<string, string | undefined>>;
}

/** One root's assembled inputs. */
export interface PrepSupplyRootInputs {
  root: string;
  /** Items from the consolidated `wl worklist --json` read. */
  worklist: ReadonlyArray<PrepSupplyItem>;
  /** The full per-root prep read; absent when unavailable. */
  full?: PrepSupplyFullRead;
  /** The root's rolling dispatch-log entries (markers, pane closes). */
  logEntries?: ReadonlyArray<DowntimeLogEntry>;
  /**
   * A read failure for this root. Reported as an entry in the payload (never a
   * silent empty bucket set) so one broken root cannot look like zero supply.
   */
  error?: string;
}

/** One root's report. */
export interface PrepSupplyRootReport {
  root: string;
  /** A read failure for this root; every count is zero when set. */
  error?: string;
  coverage: PrepSupplyCoverage;
  /** Bucket counts, alphabetical key order. */
  counts: Record<PrepSupplyBucket, number>;
  /** Item ids per bucket, lexicographic within each bucket. */
  buckets: Record<PrepSupplyBucket, string[]>;
  /** The `offerable` bucket, named for readability. */
  offerable: string[];
  /** Out-of-scope items: they appear in no bucket, by construction. */
  excluded: Array<{ id: string; reason: PrepSupplyExclusion }>;
  /** Every window item's verdict (id-sorted), quoting the classifier's gate. */
  verdicts: PrepSupplyVerdict[];
}

/** The whole report: per root, plus cross-root totals and offerable ids. */
export interface PrepSupplyReport {
  schemaVersion: number;
  /** The frozen evaluation instant, ISO-8601 (`--now` or the wall clock). */
  now: string;
  /** Per-root reports, sorted by root. */
  roots: PrepSupplyRootReport[];
  /** Bucket counts summed across roots. */
  totals: Record<PrepSupplyBucket, number>;
  /** Every offerable id, grouped by root in root order. */
  offerable: Array<{ root: string; id: string }>;
}

/** Assembly options. `now` is REQUIRED: a replay needs a frozen clock. */
export interface PrepSupplyReportOptions {
  /** Frozen evaluation instant (ms since epoch). */
  now: number;
  /** Optional dispatcher-limit overrides (tests / replays), never gates. */
  maxAttempts?: number;
  markerStalenessMs?: number;
  cooldownMs?: number;
}

/**
 * The read seam the report is assembled from. Read-only by shape: there is no
 * write, marker, comment or assignee operation here.
 */
export interface PrepSupplyReportDeps {
  readWorklist(root: string): Promise<{ items: ReadonlyArray<PrepSupplyItem> }>;
  readFull(root: string): Promise<PrepSupplyFullRead>;
  readLogEntries(root: string): Promise<ReadonlyArray<DowntimeLogEntry>>;
}

type BucketMap<T> = Record<PrepSupplyBucket, T>;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyBuckets(): BucketMap<string[]> {
  const buckets = {} as BucketMap<string[]>;
  for (const bucket of PREP_SUPPLY_REPORT_BUCKET_ORDER) buckets[bucket] = [];
  return buckets;
}

function emptyCounts(): BucketMap<number> {
  const counts = {} as BucketMap<number>;
  for (const bucket of PREP_SUPPLY_REPORT_BUCKET_ORDER) counts[bucket] = 0;
  return counts;
}

function emptyCoverage(): PrepSupplyCoverage {
  return {
    worklistItems: 0,
    fullItems: 0,
    mergedItems: 0,
    worklistOnly: 0,
    fullOnly: 0,
  };
}

/**
 * Overlay the worklist item onto the fallback item: defined worklist fields
 * win (the worklist read is the dispatcher's own), while the fallback's
 * dependency edges are kept because the worklist payload carries none.
 */
function overlayItem(base: PrepSupplyItem, overlay: PrepSupplyItem): PrepSupplyItem {
  const merged = { ...base } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) merged[key] = value;
  }
  const dependencies = base.dependencies ?? overlay.dependencies;
  if (dependencies === undefined) delete merged.dependencies;
  else merged.dependencies = dependencies;
  return merged as unknown as PrepSupplyItem;
}

/**
 * Union the consolidated worklist read with the full per-root read, deduped by
 * item id (see {@link overlayItem} for the field authority).
 */
export function mergePrepSupplySources(input: PrepSupplyRootInputs): {
  items: PrepSupplyItem[];
  blockerStatusById: Record<string, string | undefined>;
  coverage: PrepSupplyCoverage;
} {
  const fullItems = input.full?.items ?? [];
  const byId = new Map<string, PrepSupplyItem>();
  const fullIds = new Set<string>();
  for (const item of fullItems) {
    byId.set(item.id, item);
    fullIds.add(item.id);
  }

  const worklistIds = new Set<string>();
  for (const item of input.worklist) {
    worklistIds.add(item.id);
    const base = byId.get(item.id);
    byId.set(item.id, base === undefined ? item : overlayItem(base, item));
  }

  const blockerStatusById: Record<string, string | undefined> = {};
  for (const [id, status] of Object.entries(input.full?.blockerStatusById ?? {})) {
    if (status !== undefined) blockerStatusById[id] = status;
  }

  let worklistOnlyCount = 0;
  for (const id of worklistIds) if (!fullIds.has(id)) worklistOnlyCount += 1;
  let fullOnlyCount = 0;
  for (const id of fullIds) if (!worklistIds.has(id)) fullOnlyCount += 1;

  const items = [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
  return {
    items,
    blockerStatusById,
    coverage: {
      worklistItems: input.worklist.length,
      fullItems: fullItems.length,
      mergedItems: items.length,
      worklistOnly: worklistOnlyCount,
      fullOnly: fullOnlyCount,
    },
  };
}

function rootContext(
  input: PrepSupplyRootInputs,
  merged: { blockerStatusById: Record<string, string | undefined> },
  options: PrepSupplyReportOptions,
): PrepSupplyContext {
  const ctx: PrepSupplyContext = {
    now: options.now,
    logEntries: input.logEntries ?? [],
    blockerStatusById: merged.blockerStatusById,
  };
  if (options.maxAttempts !== undefined) ctx.maxAttempts = options.maxAttempts;
  if (options.markerStalenessMs !== undefined) ctx.markerStalenessMs = options.markerStalenessMs;
  if (options.cooldownMs !== undefined) ctx.cooldownMs = options.cooldownMs;
  return ctx;
}

function errorRoot(root: string, error: string): PrepSupplyRootReport {
  return {
    root,
    error,
    coverage: emptyCoverage(),
    counts: emptyCounts(),
    buckets: emptyBuckets(),
    offerable: [],
    excluded: [],
    verdicts: [],
  };
}

/**
 * Build ONE root's report: merge the sources, classify the merged window with
 * the frozen clock, and re-order the buckets alphabetically for stable output.
 */
function buildRootReport(
  input: PrepSupplyRootInputs,
  options: PrepSupplyReportOptions,
): PrepSupplyRootReport {
  if (input.error !== undefined) return errorRoot(input.root, input.error);
  const merged = mergePrepSupplySources(input);
  const window = classifyPrepSupplyWindow(
    input.root,
    merged.items,
    rootContext(input, merged, options),
  );

  const counts = emptyCounts();
  const buckets = emptyBuckets();
  for (const bucket of PREP_SUPPLY_REPORT_BUCKET_ORDER) {
    counts[bucket] = window.counts[bucket];
    buckets[bucket] = [...window.buckets[bucket]].sort(compareIds);
  }

  return {
    root: input.root,
    coverage: merged.coverage,
    counts,
    buckets,
    offerable: buckets.offerable,
    excluded: window.excluded,
    verdicts: window.verdicts,
  };
}

/**
 * Assemble the report from the already-read per-root inputs. Pure: no I/O, no
 * mutation of `inputs` (the fixture suite freezes them to prove it). Roots are
 * emitted sorted by path; the totals sum the per-root counts.
 */
export function buildPrepSupplyReport(
  inputs: ReadonlyArray<PrepSupplyRootInputs>,
  options: PrepSupplyReportOptions,
): PrepSupplyReport {
  if (!Number.isFinite(options.now)) {
    throw new Error('prep-supply report: `now` must be a finite epoch-ms instant');
  }
  const roots = inputs.map((input) => buildRootReport(input, options));
  roots.sort((a, b) => compareIds(a.root, b.root));

  const totals = emptyCounts();
  for (const root of roots) {
    for (const bucket of PREP_SUPPLY_REPORT_BUCKET_ORDER) totals[bucket] += root.counts[bucket];
  }

  const offerable: Array<{ root: string; id: string }> = [];
  for (const root of roots) {
    for (const id of root.offerable) offerable.push({ root: root.root, id });
  }

  return {
    schemaVersion: PREP_SUPPLY_REPORT_SCHEMA_VERSION,
    now: new Date(options.now).toISOString(),
    roots,
    totals,
    offerable,
  };
}

/**
 * Collect the report through the read-only seam. A root whose read throws is
 * reported as an {@link PrepSupplyRootReport} with `error` set (and zero
 * counts) — never as an empty, healthy-looking bucket set — while the other
 * roots still report.
 */
export async function collectPrepSupplyReport(
  deps: PrepSupplyReportDeps,
  roots: ReadonlyArray<string>,
  options: PrepSupplyReportOptions,
): Promise<PrepSupplyReport> {
  const uniqueRoots = [...new Set(roots)];
  const inputs: PrepSupplyRootInputs[] = [];
  for (const root of uniqueRoots) {
    try {
      const [worklist, full, logEntries] = await Promise.all([
        deps.readWorklist(root),
        deps.readFull(root),
        deps.readLogEntries(root),
      ]);
      inputs.push({ root, worklist: worklist.items, full, logEntries });
    } catch (error) {
      inputs.push({
        root,
        worklist: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return buildPrepSupplyReport(inputs, options);
}

/** The machine payload: stable JSON, key order fixed by construction. */
export function renderPrepSupplyReportJson(report: PrepSupplyReport): string {
  return JSON.stringify(report, null, 2);
}

function exclusionSummary(excluded: PrepSupplyRootReport['excluded']): string {
  const parts: string[] = [];
  for (const reason of PREP_SUPPLY_EXCLUSION_ORDER) {
    const count = excluded.filter((entry) => entry.reason === reason).length;
    if (count > 0) parts.push(`${reason} ${count}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/**
 * The human rendering: one section per root with a row per bucket (count +
 * item ids), the source coverage, the exclusion summary, and a totals block.
 * Deterministic — same report in, same text out.
 */
export function renderPrepSupplyReportTable(report: PrepSupplyReport): string {
  const lines: string[] = [
    `# Prep-supply report — now ${report.now} — ${report.roots.length} root(s)`,
  ];

  for (const root of report.roots) {
    lines.push('', `## ${root.root}`);
    if (root.error !== undefined) {
      lines.push(`ERROR ${root.error}`);
      continue;
    }
    lines.push(
      `items ${root.coverage.mergedItems} (worklist ${root.coverage.worklistItems}, full read ${root.coverage.fullItems}; worklist-only ${root.coverage.worklistOnly}, full-only ${root.coverage.fullOnly}); offerable ${root.counts.offerable}`,
    );
    lines.push('| bucket | count | item ids |', '|---|---|---|');
    for (const bucket of PREP_SUPPLY_REPORT_BUCKET_ORDER) {
      const ids = root.buckets[bucket].join(', ');
      lines.push(`| ${bucket} | ${root.counts[bucket]} | ${ids.length > 0 ? ids : '—'} |`);
    }
    lines.push(`excluded: ${exclusionSummary(root.excluded)}`);
  }

  lines.push('', `## Totals (${report.roots.length} root(s))`, '| bucket | count |', '|---|---|');
  for (const bucket of PREP_SUPPLY_REPORT_BUCKET_ORDER) {
    lines.push(`| ${bucket} | ${report.totals[bucket]} |`);
  }
  lines.push('', `offerable ids: ${report.offerable.map((entry) => `${entry.root} ${entry.id}`).join(', ') || 'none'}`);

  return lines.join('\n');
}
