/**
 * `wl sync` persist-phase probe (F2 — WL-0MVJV2NNG00771C6).
 *
 * `wl sync` is a black box: one wall-clock number and no phase attribution.
 * The F2 profile needs to know whether the ~36 s the operator observes is
 * network, JSONL export, DB work or CLI start-up, so this probe replays the
 * EXACT persist pipeline `performSync` runs (`src/commands/sync.ts`) on a
 * disposable copy of a real worklog store and times each phase:
 *
 *   open → read-local → parse-jsonl → merge → persist-items →
 *   persist-comments → export-jsonl
 *
 * Measured on the F1 full-scale fixture (2,600 items / 26,000 comments,
 * 123.7 MB DB), the persist phases account for essentially the whole
 * non-network sync time: `db.import` ≈ 14 s and `db.importComments` ≈ 43 s,
 * with 78–90 % of that CPU inside `upsertFtsEntry` — the FTS row of EVERY item
 * is rebuilt for a comment import. The separate `wl sync` perf work item
 * (WL-0MVK3WRY9009KV6P) owns the fix and uses this probe for before/after
 * numbers.
 *
 * Safety: the store is copied into a throwaway temp directory before any write,
 * so the input worklog is never modified. The copy (and the exported JSONL)
 * are removed afterwards unless `--keep` is passed.
 *
 * Usage:
 *
 *   # Export a JSONL from the store first, then profile the phases
 *   npx tsx packages/herdr/test/perf/wl-sync-phase-probe.ts --worklog-dir <dir>/.worklog
 *
 *   # Profile against an existing JSONL (e.g. one `wl export` wrote)
 *   npx tsx packages/herdr/test/perf/wl-sync-phase-probe.ts \
 *     --worklog-dir <dir>/.worklog --jsonl /tmp/worklog-data.jsonl --json
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorklogDatabase } from '../../../../src/database.js';
import { importFromJsonlContent } from '../../../../src/jsonl.js';
import {
  mergeAuditResults,
  mergeComments,
  mergeDependencyEdges,
  mergeWorkItems,
} from '../../../../src/sync.js';

/** One measured phase of the sync persist pipeline. */
export interface SyncPhaseSample {
  phase: string;
  label: string;
  wallMs: number;
  cpuMs: number;
  note: string;
}

/** Whole probe result. */
export interface SyncPhaseReport {
  capturedAt: string;
  host: string;
  node: string;
  dataset: {
    items: number;
    comments: number;
    dependencyEdges: number;
    auditResults: number;
    jsonlBytes: number;
    dbSizeMb: number;
  };
  phases: SyncPhaseSample[];
  /** Sum of every phase's wall time (the pipeline in isolation). */
  totalWallMs: number;
}

/** Options accepted by {@link profileSyncPhases}. */
export interface SyncPhaseProfileOptions {
  /** `.worklog` directory of the store to profile (never modified). */
  worklogDir: string;
  /** JSONL snapshot to replay; when absent one is exported from the copy. */
  jsonlPath?: string;
  /** Keep the throwaway copy for inspection. */
  keep?: boolean;
  /** Repository-relative label for the store, recorded in the report. */
  label?: string;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const toMb = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;

/** Copy the SQLite database (and any WAL sidecars) into `targetDir`. */
function copyStore(worklogDir: string, targetDir: string): string {
  const source = path.join(worklogDir, 'worklog.db');
  if (!fs.existsSync(source)) {
    throw new Error(`wl-sync-phase-probe: no worklog.db in ${worklogDir}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'worklog.db');
  fs.copyFileSync(source, target);
  for (const sidecar of ['-wal', '-shm']) {
    const from = `${source}${sidecar}`;
    if (fs.existsSync(from)) fs.copyFileSync(from, `${target}${sidecar}`);
  }
  return target;
}

/**
 * Replay `performSync`'s persist pipeline on a disposable copy of the store and
 * time every phase. Pure measurement: the input `.worklog` is never written.
 */
export async function profileSyncPhases(
  options: SyncPhaseProfileOptions,
): Promise<SyncPhaseReport> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-sync-phase-'));
  const phases: SyncPhaseSample[] = [];

  const record = (
    phase: string,
    label: string,
    note: string,
    wallMs: number,
    cpu: NodeJS.CpuUsage,
  ): SyncPhaseSample => {
    const sample: SyncPhaseSample = {
      phase,
      label,
      wallMs: round1(wallMs),
      cpuMs: round1((cpu.user + cpu.system) / 1000),
      note,
    };
    phases.push(sample);
    return sample;
  };

  const measure = <T>(phase: string, label: string, note: string, fn: () => T): T => {
    const cpuStart = process.cpuUsage();
    const at = performance.now();
    const value = fn();
    record(phase, label, note, performance.now() - at, process.cpuUsage(cpuStart));
    return value;
  };

  const measureAsync = async <T>(
    phase: string,
    label: string,
    note: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const cpuStart = process.cpuUsage();
    const at = performance.now();
    const value = await fn();
    record(phase, label, note, performance.now() - at, process.cpuUsage(cpuStart));
    return value;
  };

  try {
    const dbPath = copyStore(options.worklogDir, tempDir);
    const dataPath = path.join(tempDir, 'worklog-data.jsonl');

    // Phase 0 (only when the caller supplied no JSONL): produce the snapshot
    // the sync would push, so the persist phases below replay a real remote
    // payload. Not recorded as a phase: the pipeline's own export is measured
    // after the persist phases, in `performSync` order.
    let jsonlPath = options.jsonlPath;
    if (jsonlPath === undefined) {
      const exportDb = new WorklogDatabase('WI', dbPath, dataPath, true, false);
      try {
        jsonlPath = (await exportDb.exportForSync({ mode: 'full' })) as string;
      } finally {
        exportDb.close();
      }
    }
    const jsonlBytes = fs.statSync(jsonlPath as string).size;
    const content = fs.readFileSync(jsonlPath as string, 'utf-8');

    const db = measure(
      'sqlite-open',
      'SQLite open',
      'Store open, pragmas, schema and FTS DDL.',
      () => new WorklogDatabase('WI', dbPath, dataPath, true, false),
    );

    try {
      const local = measure(
        'read-local',
        'Read local state (`getAll` + `getAllComments` + edges/audits)',
        'Materialises the whole local store before the merge.',
        () => ({
          items: db.getAll(),
          comments: db.getAllComments(),
          edges: db.getAllDependencyEdges(),
          audits: db.getAllAuditResults(),
        }),
      );

      const remote = measure(
        'parse-jsonl',
        'Parse remote JSONL (`importFromJsonlContent`)',
        'Parses the pulled snapshot (or the export when profiling offline).',
        () => importFromJsonlContent(content),
      );

      const merged = measure(
        'merge',
        'Merge (`mergeWorkItems` + comments + edges + audits)',
        'Computes the merged state; a no-change sync produces the same records back.',
        () => ({
          items: mergeWorkItems(local.items, remote.items),
          comments: mergeComments(local.comments, remote.comments),
          edges: mergeDependencyEdges(local.edges, remote.dependencyEdges ?? []),
          audits: mergeAuditResults(local.audits, remote.auditResults ?? []),
        }),
      );

      measure(
        'persist-items',
        'Persist items (`db.import`)',
        'Writes every merged item and re-indexes its FTS row, even when unchanged.',
        () => db.import(merged.items.merged, merged.edges.merged, merged.audits.merged),
      );

      measure(
        'persist-comments',
        'Persist comments (`db.importComments`)',
        'Clears and re-inserts every comment, then re-indexes EVERY item FTS row.',
        () => db.importComments(merged.comments.merged),
      );

      await measureAsync(
        'export-jsonl',
        'JSONL export (`db.exportForSync` full)',
        'Serialises the whole store to the ephemeral JSONL the push publishes.',
        async () => db.exportForSync({ mode: 'full' }),
      );

      return {
        capturedAt: new Date().toISOString(),
        host: os.hostname(),
        node: process.version,
        dataset: {
          items: local.items.length,
          comments: local.comments.length,
          dependencyEdges: local.edges.length,
          auditResults: local.audits.length,
          jsonlBytes,
          dbSizeMb: toMb(fs.statSync(dbPath).size),
        },
        phases,
        totalWallMs: round1(phases.reduce((total, phase) => total + phase.wallMs, 0)),
      };
    } finally {
      db.close();
    }
  } finally {
    if (!options.keep) fs.rmSync(tempDir, { recursive: true, force: true });
    else process.stderr.write(`wl-sync-phase-probe: kept copy in ${tempDir}\n`);
  }
}

/** Render a {@link SyncPhaseReport} as a readable table. */
export function formatSyncPhaseReport(report: SyncPhaseReport): string {
  const lines = [
    '',
    `wl sync persist-phase profile — ${report.host} / ${report.node} / ${report.capturedAt}`,
    `dataset: ${report.dataset.items} items, ${report.dataset.comments} comments, ` +
      `${report.dataset.dependencyEdges} edges, ${report.dataset.dbSizeMb} MB DB, ` +
      `${toMb(report.dataset.jsonlBytes)} MB JSONL`,
    '',
    'phase            wall(ms)   cpu(ms)  note',
  ];
  for (const phase of report.phases) {
    lines.push(
      `${phase.phase.padEnd(16)} ${String(phase.wallMs).padStart(9)} ${String(phase.cpuMs).padStart(9)}  ${phase.note}`,
    );
  }
  lines.push('', `total: ${report.totalWallMs} ms`, '');
  return lines.join('\n');
}

interface CliOptions {
  worklogDir?: string;
  jsonlPath?: string;
  keep: boolean;
  json: boolean;
}

/** Parse CLI arguments (exported for the contract test). */
export function parseProbeArgs(argv: string[]): CliOptions {
  const options: CliOptions = { keep: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    switch (arg) {
      case '--worklog-dir':
        if (!value || value.startsWith('--')) throw new Error('--worklog-dir requires a path');
        options.worklogDir = value;
        index += 1;
        break;
      case '--jsonl':
        if (!value || value.startsWith('--')) throw new Error('--jsonl requires a path');
        options.jsonlPath = value;
        index += 1;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option '${arg}'`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseProbeArgs(process.argv.slice(2));
  if (!options.worklogDir) {
    throw new Error('--worklog-dir is required (the `.worklog` directory to profile)');
  }
  const report = await profileSyncPhases({
    worklogDir: options.worklogDir,
    jsonlPath: options.jsonlPath,
    keep: options.keep,
  });
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatSyncPhaseReport(report)}\n`,
  );
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  main().catch((error: unknown) => {
    process.stderr.write(`wl-sync-phase-probe failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
