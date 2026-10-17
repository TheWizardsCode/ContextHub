/**
 * cleanup-assignee-residue — clear stale assignee holds on audit-hold items
 *
 * One-time cleanup that clears non-empty `assignee` fields on:
 *   - completed items (status: 'completed')
 *   - audit-hold items (stage: 'in_review')
 *
 * It deliberately skips in-flight items (open, in-progress, blocked,
 * input_needed) because those assignees are active scheduling holds.
 *
 * Ordering: this script runs AFTER the status-neutral claim + assignee-based
 * selection change ships (C4/C6), because it relies on `assignee` being the
 * scheduling hold rather than the removed `needsProducerReview` flag.
 *
 * Usage:
 *   npx tsx scripts/cleanup-assignee-residue.ts [--worklog-dir PATH] [--dry-run] [--json]
 *
 * --dry-run       Print what would change without writing anything.
 * --worklog-dir   Explicit .worklog directory (defaults to resolution from cwd).
 * --json          Emit a machine-readable JSON report.
 *
 * Exit: 0 on success; non-zero only on unexpected errors.
 */

import * as path from 'path';
import { existsSync } from 'node:fs';
import { WorklogDatabase } from '../src/database.js';
import type { WorkItem, WorkItemStatus } from '@worklog/shared/types';

// ── Types ───────────────────────────────────────────────────────────────

/** Statuses considered "in-flight" — their assignee is an active hold. */
export const IN_FLIGHT_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>([
  'open',
  'in-progress',
  'blocked',
  'input_needed',
]);

export interface ResidueEntry {
  id: string;
  title: string;
  assignee: string;
}

export interface SkippedEntry {
  id: string;
  title: string;
  reason: string;
}

export interface CleanupReport {
  totalItems: number;
  /** Items whose assignee was (or would be) cleared. */
  cleared: ResidueEntry[];
  /** In-flight items deliberately left untouched. */
  skipped: SkippedEntry[];
  /** Items whose assignee was already empty. */
  alreadyClean: number;
  /** True when no writes were performed. */
  dryRun: boolean;
}

// ── Core logic ──────────────────────────────────────────────────────────

/**
 * Decide whether a work item is a cleanup target.
 *
 * A target is any item with a non-empty assignee that is NOT in-flight and
 * is either completed or in the `in_review` stage (audit-hold).
 */
export function isResidueTarget(item: WorkItem): boolean {
  if (!item.assignee) return false;
  // Never touch deleted items, even when they carry a residual stage.
  if (item.status === 'deleted') return false;
  // In-flight items are active scheduling holds — never a target.
  if (IN_FLIGHT_STATUSES.has(item.status)) return false;
  return item.status === 'completed' || item.stage === 'in_review';
}

/**
 * Scan the database for assignee residue.
 *
 * When `dryRun` is false, qualifying items are updated to clear their
 * assignee. The operation is idempotent: a second run finds no residue
 * (every previously-cleared item now has an empty assignee) and performs
 * no further writes.
 */
export function runCleanup(db: WorklogDatabase, dryRun: boolean): CleanupReport {
  const items = db.list();
  const report: CleanupReport = {
    totalItems: items.length,
    cleared: [],
    skipped: [],
    alreadyClean: 0,
    dryRun,
  };

  for (const item of items) {
    // Already clean — nothing to do.
    if (!item.assignee) {
      report.alreadyClean++;
      continue;
    }

    // In-flight items are deliberately left alone: their assignee is an
    // active scheduling hold.
    if (IN_FLIGHT_STATUSES.has(item.status)) {
      report.skipped.push({
        id: item.id,
        title: item.title,
        reason: `in-flight (status: ${item.status})`,
      });
      continue;
    }

    if (!isResidueTarget(item)) {
      report.skipped.push({
        id: item.id,
        title: item.title,
        reason: `not an audit-hold (status: ${item.status}, stage: ${item.stage})`,
      });
      continue;
    }

    if (!dryRun) {
      // CAS-guarded clear: only clears if the assignee still matches what
      // was scanned, so a concurrent claim can never be clobbered.
      db.updateIfMatches(item.id, { assignee: '' }, { assignee: item.assignee });
    }
    report.cleared.push({
      id: item.id,
      title: item.title,
      assignee: item.assignee,
    });
  }

  return report;
}

// ── Reporting ───────────────────────────────────────────────────────────

/** Format the cleanup report for human-readable console output. */
export function formatReport(report: CleanupReport): string {
  const label = report.dryRun ? 'WOULD CLEAR' : 'CLEARED';
  const inFlight = report.skipped.filter((s) => s.reason.startsWith('in-flight')).length;
  const other = report.skipped.length - inFlight;

  const lines: string[] = [];
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push(`  Assignee Residue Cleanup ${report.dryRun ? '(DRY RUN)' : ''}`);
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Total items scanned: ${report.totalItems}`);
  lines.push(`  ${label}: ${report.cleared.length}`);
  lines.push(`  Already clean:       ${report.alreadyClean}`);
  lines.push(`  Skipped (in-flight): ${inFlight}`);
  lines.push(`  Skipped (other):     ${other}`);
  lines.push('');

  if (report.cleared.length > 0) {
    lines.push('  ── Items with assignee cleared ───────────────────────');
    for (const c of report.cleared) {
      lines.push(`    ${c.id}: ${c.title} (assignee: "${c.assignee}")`);
    }
    lines.push('');
  }

  if (report.skipped.length > 0) {
    const shown = report.skipped.slice(0, 20);
    lines.push('  ── Skipped items ─────────────────────────────────────');
    for (const s of shown) {
      lines.push(`    ${s.id}: ${s.title} — ${s.reason}`);
    }
    if (report.skipped.length > shown.length) {
      lines.push(`    ... and ${report.skipped.length - shown.length} more`);
    }
    lines.push('');
  }

  lines.push('═══════════════════════════════════════════════════════════');
  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────

interface CliOptions {
  worklogDir: string;
  dryRun: boolean;
  json: boolean;
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): CliOptions {
  let worklogDir = '';
  let dryRun = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if (argv[i] === '--json') {
      json = true;
    } else if (argv[i] === '--worklog-dir' && argv[i + 1]) {
      worklogDir = argv[++i];
    }
  }

  if (!worklogDir) {
    worklogDir = resolveWorklogDir(cwd);
  }

  return { worklogDir, dryRun, json };
}

/**
 * Resolve the `.worklog` directory by walking up from `startDir`.
 * Falls back to `<startDir>/.worklog` when none is found.
 */
export function resolveWorklogDir(startDir: string): string {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, '.worklog');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.join(path.resolve(startDir), '.worklog');
    }
    dir = parent;
  }
}

function main(): void {
  const { worklogDir, dryRun, json } = parseArgs(process.argv.slice(2));
  const dbPath = path.join(worklogDir, 'worklog.db');
  const jsonlPath = path.join(worklogDir, 'worklog-data.jsonl');

  if (!existsSync(dbPath)) {
    console.error(`ERROR: Database not found at ${dbPath}`);
    console.error('Ensure the worklog directory exists and is initialized.');
    process.exit(1);
  }

  const db = new WorklogDatabase('WL', dbPath, jsonlPath, false, false);

  try {
    const report = runCleanup(db, dryRun);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
      if (dryRun && report.cleared.length > 0) {
        console.log('\n  Rerun without --dry-run to apply the changes.');
      }
    }
  } finally {
    db.close();
  }
}

// Only run when executed directly (not when imported by tests).
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /cleanup-assignee-residue\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (isDirectRun) {
  main();
}
