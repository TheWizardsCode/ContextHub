/**
 * `wl sync` persist-phase probe (F2 — WL-0MVJV2NNG00771C6).
 *
 * `wl sync` used to be a black box: one wall-clock number and no phase
 * attribution. The F2 profile needed to know whether the ~36 s the operator
 * observes is network, JSONL export, DB work or CLI start-up, so this probe
 * replays the EXACT persist pipeline `performSync` runs (`src/commands/sync.ts`)
 * on a disposable copy of a real worklog store and times each phase.
 *
 * Phase names are shared with the CLI (WL-0MVK6SD5O001K901): `pull`,
 * `persist-items`, `persist-comments`, `export`, `push` — the same names
 * `performSync` reports in its `--json` `summary.phaseTimings` and sync log,
 * so the before/after table lines up with in-CLI timings. `pull` is the
 * offline aggregate of the store open, local read, JSONL parse and merge
 * sub-phases (no network fetch is exercised); `push` is not exercised at all
 * and is reported as 0 so the shape matches.
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
import {
  SYNC_PHASE_NAMES,
  type SyncPhaseName,
} from '../../../../src/sync-phase-timings.js';

/** One measured phase of the sync persist pipeline (name shared with `wl sync`). */
export interface SyncPhaseSample {
  phase: SyncPhaseName;
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

/** Human labels for the contract phase names (kept in step with the CLI). */
const PHASE_LABELS: Record<SyncPhaseName, string> = {
  pull: 'Pull (open, read-local, parse-jsonl, merge — offline replay)',
  'persist-items': 'Persist items (`db.import` / `upsertItems` + audits)',
  'persist-comments': 'Persist comments (`db.importComments` / `upsertComments`)',
  export: 'JSONL export (`db.exportForSync` full)',
  push: 'Git push (`gitPushDataFileToBranch`)',
};

/** Note shown when a phase was never measured (0, but reported for shape). */
const DEFAULT_NOTES: Record<SyncPhaseName, string> = {
  pull: 'offline replay: no network fetch',
  'persist-items': 'not exercised on this store',
  'persist-comments': 'not exercised on this store',
  export: 'not exercised on this store',
  push: 'not exercised: the probe replays the persist pipeline offline (no git push)',
};

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

  // Accumulate wall + CPU time per contract phase. `pull` is measured through
  // its four sub-phases; the other phases through one window each.
  const totals = new Map<SyncPhaseName, { wallMs: number; cpuMs: number; notes: string[] }>();
  for (const phase of SYNC_PHASE_NAMES) {
    totals.set(phase, { wallMs: 0, cpuMs: 0, notes: [] });
  }

  const record = (phase: SyncPhaseName, label: string, wallMs: number, cpu: NodeJS.CpuUsage) => {
    const total = totals.get(phase)!;
    total.wallMs += wallMs;
    total.cpuMs += (cpu.user + cpu.system) / 1000;
    total.notes.push(`${label}: ${round1(wallMs)}ms wall / ${round1((cpu.user + cpu.system) / 1000)}ms cpu`);
  };

  const measure = <T>(phase: SyncPhaseName, label: string, fn: () => T): T => {
    const cpuStart = process.cpuUsage();
    const at = performance.now();
    try {
      return fn();
    } finally {
      record(phase, label, performance.now() - at, process.cpuUsage(cpuStart));
    }
  };

  const measureAsync = async <T>(
    phase: SyncPhaseName,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const cpuStart = process.cpuUsage();
    const at = performance.now();
    try {
      return await fn();
    } finally {
      record(phase, label, performance.now() - at, process.cpuUsage(cpuStart));
    }
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
      'pull',
      'sqlite-open',
      () => new WorklogDatabase('WI', dbPath, dataPath, true, false),
    );

    try {
      const local = measure('pull', 'read-local', () => ({
        items: db.getAll(),
        comments: db.getAllComments(),
        edges: db.getAllDependencyEdges(),
        audits: db.getAllAuditResults(),
      }));

      const remote = measure('pull', 'parse-jsonl', () =>
        importFromJsonlContent(content),
      );

      const merged = measure('pull', 'merge', () => ({
        items: mergeWorkItems(local.items, remote.items),
        comments: mergeComments(local.comments, remote.comments),
        edges: mergeDependencyEdges(local.edges, remote.dependencyEdges ?? []),
        audits: mergeAuditResults(local.audits, remote.auditResults ?? []),
      }));

      measure(
        'persist-items',
        'persist-items',
        () => db.import(merged.items.merged, merged.edges.merged, merged.audits.merged),
      );

      measure(
        'persist-comments',
        'persist-comments',
        () => db.importComments(merged.comments.merged),
      );

      await measureAsync(
        'export',
        'export-jsonl',
        async () => db.exportForSync({ mode: 'full' }),
      );

      const phases: SyncPhaseSample[] = SYNC_PHASE_NAMES.map((phase) => {
        const total = totals.get(phase)!;
        return {
          phase,
          label: PHASE_LABELS[phase],
          wallMs: round1(total.wallMs),
          cpuMs: round1(total.cpuMs),
          note:
            total.notes.length > 0
              ? total.notes.join('; ')
              : DEFAULT_NOTES[phase],
        };
      });

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
