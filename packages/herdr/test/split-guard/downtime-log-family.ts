/**
 * packages/herdr/test/split-guard/downtime-log-family.ts — config and baseline
 * producer for the `packages/herdr/src/downtime-log.ts` split guard.
 *
 * Parent: WL-0MVGKHFT4003X6JW (decompose the `downtime-log.ts` god class).
 *
 * ## Why this module exists
 *
 * The extraction moved ~1,400 lines out of `packages/herdr/src/downtime-log.ts`
 * into six single-responsibility siblings while leaving every consumer import
 * untouched. The unchanged `downtime-log.test.ts` suite (plus the ~30 worker
 * suites that consume the log) is the behaviour-preservation gate — but nothing
 * in the repository enforced the *structural* half of the contract: an
 * unchanged public surface, a thin barrel, no new barrel/cycle regressions, and
 * a module line ceiling.
 *
 * The gates themselves are the family-agnostic predicates in the sibling
 * `scan.ts`; this module supplies only the family-specific data
 * ({@link DOWNTIME_LOG_CONFIG}) plus the frozen baseline.
 *
 * ## Baseline generation (provenance)
 *
 *   npx tsx packages/herdr/test/split-guard/downtime-log-family.ts \
 *     --write-baseline
 *
 * writes `packages/herdr/src/downtime-log.split-baseline.json`. Re-run it only
 * when the consumer surface is *deliberately* changed; the committed file is
 * the frozen contract the public-surface gate enforces.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSUMER_ROOTS,
  MAX_MODULE_LINES,
  collectExportedNames,
  consumerImportNames,
  loadModuleIndex,
  type ModuleIndex,
  type SplitFamilyConfig,
} from './scan.js';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every downtime-log consumer imports. */
export const DOWNTIME_LOG_BARREL = 'packages/herdr/src/downtime-log.ts';

/** Directory the split's modules live in. */
export const DOWNTIME_LOG_FAMILY_DIR = 'packages/herdr/src';

/**
 * A downtime-log family file: `downtime-log.ts` plus any
 * `downtime-log.<slice>.ts` extracted module. Test/fixture files
 * (`downtime-log.test.ts`, `downtime-log.split-guard.test.ts`) match too but
 * are filtered out by `productionModules`, exactly like every other split
 * family in this package: the 1,000-line ceiling applies to the modules the
 * split ships, not to their tests.
 */
export const DOWNTIME_LOG_FAMILY_PATTERN = /^downtime-log[^/]*\.ts$/;

/** Repository-relative path of the committed consumer-symbol baseline. */
export const DOWNTIME_LOG_BASELINE_PATH =
  'packages/herdr/src/downtime-log.split-baseline.json';

/** Per-module line ceiling (parent AC1). Re-exported from `scan.ts`. */
export { MAX_MODULE_LINES };

/**
 * Files currently exempt from the size gate.
 *
 * Empty by design: the split landed in a single item, so from the first commit
 * onwards every `downtime-log*.ts` production module — the barrel included —
 * is held to {@link MAX_MODULE_LINES}. The list stays shrink-only, which makes
 * "grows back into a collection of oversized modules" a test failure rather
 * than a review finding.
 */
export const DOWNTIME_LOG_SPLIT_ALLOWLIST: readonly string[] = [];

/**
 * The allowlist as it stood at plan time. {@link DOWNTIME_LOG_SPLIT_ALLOWLIST}
 * must remain a subset of this.
 */
export const DOWNTIME_LOG_SPLIT_ALLOWLIST_CEILING: readonly string[] = [
  'downtime-log.ts',
];

/**
 * Pre-existing import cycles involving a downtime-log family module.
 *
 * Empty: the family was acyclic before the split and stays acyclic after it.
 * `downtime-log.ts` imports only `node:` builtins and a type from
 * `pane-close.ts`, and nothing imports it back at runtime — so any entry here
 * would be a regression, not recorded reality.
 */
export const DOWNTIME_LOG_CYCLE_BASELINE: readonly (readonly string[])[] = [];

/** Pre-existing **runtime** (value-only) cycles — likewise none. */
export const DOWNTIME_LOG_RUNTIME_CYCLE_BASELINE: readonly (readonly string[])[] = [];

/** Edges of the recorded cycle that must stay type-only (none today). */
export const DOWNTIME_LOG_TYPE_ONLY_EDGES: readonly {
  readonly from: string;
  readonly to: string;
}[] = [];

/**
 * The family declares no module-scope mutable state, so the mandatory
 * single-owner slot names a sentinel that must never be declared
 * (`dispatcher-anchor-family.ts` precedent).
 */
export const SINGLE_OWNER_DECLARATION = 'DOWNTIME_LOG_NO_SHARED_MODULE_STATE';

/** The downtime-log split's inputs to the shared, family-agnostic predicates. */
export const DOWNTIME_LOG_CONFIG: SplitFamilyConfig = {
  barrel: DOWNTIME_LOG_BARREL,
  familyDir: DOWNTIME_LOG_FAMILY_DIR,
  familyPattern: DOWNTIME_LOG_FAMILY_PATTERN,
  baselinePath: DOWNTIME_LOG_BASELINE_PATH,
  allowlist: DOWNTIME_LOG_SPLIT_ALLOWLIST,
  allowlistCeiling: DOWNTIME_LOG_SPLIT_ALLOWLIST_CEILING,
  cycleBaseline: DOWNTIME_LOG_CYCLE_BASELINE,
  typeOnlyEdges: DOWNTIME_LOG_TYPE_ONLY_EDGES,
  runtimeCycleBaseline: DOWNTIME_LOG_RUNTIME_CYCLE_BASELINE,
  singleOwnerDeclaration: SINGLE_OWNER_DECLARATION,
  baselineCommand:
    'npx tsx packages/herdr/test/split-guard/downtime-log-family.ts --write-baseline',
  consumerRoots: CONSUMER_ROOTS,
};

// ── Responsibility-doc gate ───────────────────────────────────────────

/** The leading `/** … *\/` block comment of a source file, or `''`. */
export function leadingBlockComment(source: string): string {
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  return match ? match[1] : '';
}

/**
 * Extracted family modules whose header does not state their single
 * responsibility.
 *
 * The barrel keeps the family's overview doc, so it is exempt; every
 * *extracted* module must open with a block comment naming a
 * `Single responsibility:` — that sentence is the contract a future reader
 * navigates the family by. Accepting an arbitrary doc comment would let an
 * extracted module ship with a stale copy of the old monolith header.
 */
export function findMissingResponsibilityDocs(
  sources: Map<string, string> | Record<string, string>,
  modules: readonly string[],
  barrel: string = DOWNTIME_LOG_BARREL,
): string[] {
  const entries = sources instanceof Map ? [...sources] : Object.entries(sources);
  const byFile = new Map(entries);
  return modules
    .filter((file) => file !== barrel)
    .filter((file) => {
      const source = byFile.get(file);
      if (source === undefined) return true;
      return !leadingBlockComment(source).includes('Single responsibility:');
    })
    .sort();
}

// ── Baseline ──────────────────────────────────────────────────────────

export interface DowntimeLogSplitBaseline {
  provenance: {
    generatedBy: string;
    sourceCommit: string;
    generatedAt: string;
    barrel: string;
    consumerGlobs: string[];
  };
  /** Every name the barrel exports: the frozen public surface. */
  symbols: string[];
  /** The subset live consumers actually import. */
  consumerSymbols: string[];
}

/** Every name the barrel exports, sorted and deduplicated. */
export function barrelSymbols(index: ModuleIndex): string[] {
  return [...collectExportedNames(index, DOWNTIME_LOG_BARREL)].sort();
}

/** Every symbol a consumer imports from the barrel, sorted. */
export function consumerSymbols(index: ModuleIndex): string[] {
  return [...consumerImportNames(index, DOWNTIME_LOG_BARREL).keys()].sort();
}

/** Build the baseline payload from the live tree. */
export function buildDowntimeLogBaseline(repoRoot: string): DowntimeLogSplitBaseline {
  const index = loadModuleIndex(repoRoot, DOWNTIME_LOG_CONFIG.consumerRoots);
  return {
    provenance: {
      generatedBy: DOWNTIME_LOG_CONFIG.baselineCommand,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      generatedAt: new Date().toISOString(),
      barrel: DOWNTIME_LOG_BARREL,
      consumerGlobs: DOWNTIME_LOG_CONFIG.consumerRoots.map((root) => `${root}/**/*.ts`),
    },
    symbols: barrelSymbols(index),
    consumerSymbols: consumerSymbols(index),
  };
}

/** Read + parse the committed baseline. */
export function readDowntimeLogBaseline(repoRoot: string): DowntimeLogSplitBaseline {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, DOWNTIME_LOG_BASELINE_PATH), 'utf-8'),
  ) as DowntimeLogSplitBaseline;
}

/** Write the baseline to {@link DOWNTIME_LOG_BASELINE_PATH}; returns the payload written. */
export function writeDowntimeLogBaseline(repoRoot: string): DowntimeLogSplitBaseline {
  const baseline = buildDowntimeLogBaseline(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, DOWNTIME_LOG_BASELINE_PATH),
    `${JSON.stringify({ version: 1, ...baseline }, null, 2)}\n`,
    'utf-8',
  );
  return baseline;
}

// ── CLI: baseline producer ────────────────────────────────────────────

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
  );
  if (!process.argv.includes('--write-baseline')) {
    console.error(`usage: ${DOWNTIME_LOG_CONFIG.baselineCommand}`);
    process.exit(2);
  }
  const baseline = writeDowntimeLogBaseline(repoRoot);
  console.log(
    `wrote ${DOWNTIME_LOG_BASELINE_PATH}: ${baseline.symbols.length} symbols ` +
      `(${baseline.consumerSymbols.length} consumed) ` +
      `@ ${baseline.provenance.sourceCommit.slice(0, 8)}`,
  );
}
