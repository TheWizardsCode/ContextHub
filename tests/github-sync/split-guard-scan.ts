/**
 * tests/github-sync/split-guard-scan.ts — static scanners and gate predicates
 * for the `src/github-sync.ts` split invariants.
 *
 * Parent: WL-0MVGKH9Z900178UF (decompose the `src/github-sync.ts` god class).
 * Guard item: WL-0MW0JF51F009HNWN — child 1 of 8, lands **before** any
 * production code moves.
 *
 * ## Module responsibility
 *
 * Every extraction child (2–8) moves code out of `src/github-sync.ts` into
 * `src/github-sync/*` modules without touching a single existing test file, so
 * the unchanged suite is the behaviour gate. Nothing in the repository enforces
 * the *structural* half of that contract — a frozen public surface at
 * `./github-sync.js`, a 1,000-line ceiling, an acyclic import graph and a
 * documented module family. This module provides the enforcement:
 *
 * 1. **Public surface (AC2/AC6).** The committed baseline freezes the barrel's
 *    exported symbol names, split into value exports (resolvable at runtime)
 *    and type exports (present in the emitted declaration). A move-only split
 *    may re-home a symbol but may never drop or reclassify one.
 * 2. **Module size (AC4).** Every family module stays ≤ {@link MAX_MODULE_LINES};
 *    {@link GITHUB_SYNC_SPLIT_ALLOWLIST} is shrink-only against a plan-time
 *    ceiling and holds only the 1,339-line barrel while the split is in flight.
 * 3. **Import graph (AC7).** The static and runtime import graphs of the family
 *    are acyclic and no family module imports the barrel at runtime.
 * 4. **Documentation (AC5/AC7).** Every family module carries a leading JSDoc
 *    header naming its concern; while the oversized barrel stays allowlisted it
 *    is exempt, and the exemption disappears with the entry.
 *
 * The gates live here as **pure predicates over parsed modules** rather than as
 * assertions over the live tree, so `split-guard.test.ts` can prove each gate
 * actually fails on a deliberately broken input (AC3) — an untested guard is a
 * guard that silently rots.
 *
 * ## Reuse, not duplication (AC1)
 *
 * The parser, export-kind resolution, consumer scanning, import-graph builder,
 * cycle finder and barrel-import scanner are **imported** from
 * `../sync/split-guard-scan.js`. That scanner's family predicate and barrel are
 * optional parameters defaulting to the sync values (`splitFamilyModules`,
 * `buildImportGraph` → `GraphOptions.family` / `.barrel` / `.allowlist`,
 * `findStaticCycles`, `findUnexplainedStaticCycles`, `findRuntimeCycles`,
 * `findBarrelImports`), so this guard reuses them with the github-sync values.
 * The sync guard's defaults preserve its behaviour byte-for-byte.
 *
 * ## Baseline generation (AC2 provenance)
 *
 *   npx tsx tests/github-sync/split-guard-scan.ts --write-baseline
 *
 * writes `tests/github-sync/github-sync.split-baseline.json` with the barrel's
 * exported symbol names split into `value` and `type` plus provenance (command,
 * source commit, timestamp, barrel path, consumer globs). Re-run it only when
 * the public surface is *deliberately* changed; the committed file is the
 * frozen contract the public-surface gate enforces.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSUMER_ROOTS,
  FAMILY_ROOTS,
  MAX_MODULE_LINES,
  basename,
  buildImportGraph,
  collectExportKinds,
  consumerImportNames,
  dynamicImportNames,
  findAllowlistViolations,
  findBarrelImports,
  findMissingExports,
  findOversizedModules,
  findRuntimeCycles,
  findStaticCycles,
  findUnexplainedStaticCycles,
  hasLeadingJsDoc,
  indexFromSources,
  isTypeOnlyImport,
  liveConsumerImportNames,
  loadConsumerSources,
  loadModuleIndex,
  namesOfKind,
  parseModuleSource,
  resolveImportTarget,
  splitFamilyModules,
  type BarrelImport,
  type ExportKind,
  type GraphEdge,
  type GraphOptions,
  type ModuleIndex,
  type ParsedModule,
  type SplitBaseline,
} from '../sync/split-guard-scan.js';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every consumer imports. */
export const GITHUB_SYNC_BARREL = 'src/github-sync.ts';

/** Directory extracted github-sync modules live in. */
export const GITHUB_SYNC_SPLIT_DIR = 'src/github-sync';

/** Repository-relative path of the committed public-surface baseline (AC2). */
export const BASELINE_PATH = 'tests/github-sync/github-sync.split-baseline.json';

/**
 * Family modules currently exempt from the size gate (AC4).
 *
 * A *shrink-only* allowlist: it may only ever lose entries. It started with
 * the 1,339-line monolith; the push-flow child (WL-0MW0JF9QG008E791) dropped
 * `src/github-sync.ts` to 663 lines, so the entry is now stale and has been
 * removed — every family module must stay under {@link MAX_MODULE_LINES} with
 * no exemptions. No other module may ever be added.
 */
export const GITHUB_SYNC_SPLIT_ALLOWLIST: readonly string[] = [];

/**
 * The allowlist as it stood at plan time. {@link GITHUB_SYNC_SPLIT_ALLOWLIST}
 * must remain a subset of this, so "the split regrows into a collection of
 * oversized modules" is a test failure rather than a review finding.
 */
export const GITHUB_SYNC_SPLIT_ALLOWLIST_CEILING: readonly string[] = ['github-sync.ts'];

/**
 * Family modules permitted to import the barrel with a (type-only) edge.
 *
 * Empty at plan time: the extraction children must import sibling modules and
 * the `./github.js` barrel, never `../github-sync.js`, so any family module
 * importing the barrel — type-only or runtime — is a layering violation.
 */
export const TYPE_ONLY_BARREL_ALLOWLIST: readonly string[] = [];

/** Generation command recorded in the baseline provenance (AC2). */
export const BASELINE_GENERATION_COMMAND =
  'npx tsx tests/github-sync/split-guard-scan.ts --write-baseline';

/**
 * Defaults that point the shared sync scanners at the github-sync family.
 *
 * Spread into a {@link GraphOptions} so callers may still override individual
 * knobs (e.g. `runtimeOnly`) while the family/barrel/allowlist stay github-sync.
 */
const GITHUB_SYNC_GRAPH_DEFAULTS: GraphOptions = {
  family: isGithubSyncFamilyFile,
  barrel: GITHUB_SYNC_BARREL,
  allowlist: TYPE_ONLY_BARREL_ALLOWLIST,
};

// ── Re-exported pure parsers ──────────────────────────────────────────
//
// The guard reuses (never copies) the sync scanner's pure parsers. They are
// re-exported here so the guard suite imports everything from one module.

export {
  CONSUMER_ROOTS,
  FAMILY_ROOTS,
  MAX_MODULE_LINES,
  basename,
  collectExportKinds,
  consumerImportNames,
  dynamicImportNames,
  findAllowlistViolations,
  findMissingExports,
  findOversizedModules,
  hasLeadingJsDoc,
  indexFromSources,
  isTypeOnlyImport,
  liveConsumerImportNames,
  loadConsumerSources,
  loadModuleIndex,
  namesOfKind,
  parseModuleSource,
  resolveImportTarget,
  splitFamilyModules,
};
export type {
  BarrelImport,
  ExportKind,
  GraphEdge,
  GraphOptions,
  ModuleIndex,
  ParsedModule,
  SplitBaseline,
};

// ── Family identification (AC1) ───────────────────────────────────────

/**
 * True for a module of the github-sync family: the `src/github-sync.ts` barrel
 * and anything under `src/github-sync/`.
 *
 * Note the flat siblings `src/github-sync-*.ts` are **not** part of the family;
 * the predicate is the exact barrel path plus the split directory, so a
 * coincidental filename prefix can never widen the gates.
 */
export function isGithubSyncFamilyFile(file: string): boolean {
  if (file === GITHUB_SYNC_BARREL) return true;
  return file === GITHUB_SYNC_SPLIT_DIR || file.startsWith(`${GITHUB_SYNC_SPLIT_DIR}/`);
}

/** Production modules of the github-sync family (the modules the gates cover). */
export function githubSyncFamilyModules(index: ModuleIndex): ParsedModule[] {
  return splitFamilyModules(index, isGithubSyncFamilyFile);
}

/**
 * Family modules the JSDoc-header gate (AC5/AC7) covers.
 *
 * The in-flight monolith is exempt while it is both oversized and allowlisted
 * (AC4 records it at 1,339 lines at plan time); every module under
 * `src/github-sync/` is always covered, and the barrel joins them once the
 * close-out child removes its allowlist entry.
 */
export function githubSyncFamilyModulesRequiringJsDoc(index: ModuleIndex): ParsedModule[] {
  const allowlisted = new Set(GITHUB_SYNC_SPLIT_ALLOWLIST);
  return githubSyncFamilyModules(index).filter(
    (m) => !(allowlisted.has(basename(m.file)) && m.lineCount > MAX_MODULE_LINES),
  );
}

// ── Gate 1: public surface (values + types) ──────────────────────────

/** A frozen public surface, as recorded in the baseline. */
export interface FrozenSurface {
  value: readonly string[];
  type: readonly string[];
}

/** Baseline-vs-live surface differences the public-surface gate reports. */
export interface SurfaceDrift {
  /** Baseline value exports the live barrel no longer exports. */
  missingValue: string[];
  /** Baseline type exports the live barrel no longer exports. */
  missingType: string[];
  /** Baseline symbols whose value/type kind flipped (AC3, AC6). */
  reclassified: Array<{ name: string; expected: ExportKind; actual: ExportKind }>;
  /** Live exports the baseline never recorded (a deliberate surface change?). */
  unexpected: string[];
}

/**
 * Compare the frozen surface with the live export kinds.
 *
 * A symbol that swaps kind is *not* a missing export — it is still exported —
 * so it is reported separately. That distinction is what lets the negative-case
 * suite prove the "reclassified export" gate (AC3) fails independently of the
 * "dropped export" gate.
 */
export function findSurfaceDrift(
  frozen: FrozenSurface,
  kinds: Map<string, ExportKind>,
): SurfaceDrift {
  const expected = new Map<string, ExportKind>();
  for (const name of frozen.value) expected.set(name, 'value');
  for (const name of frozen.type) expected.set(name, 'type');

  const missingValue = findMissingExports(frozen.value, kinds.keys());
  const missingType = findMissingExports(frozen.type, kinds.keys());
  const reclassified: SurfaceDrift['reclassified'] = [];
  for (const [name, kind] of expected) {
    const actual = kinds.get(name);
    if (actual !== undefined && actual !== kind) {
      reclassified.push({ name, expected: kind, actual });
    }
  }
  const unexpected = [...kinds.keys()].filter((name) => !expected.has(name)).sort();
  return {
    missingValue,
    missingType,
    reclassified: reclassified.sort((a, b) => a.name.localeCompare(b.name)),
    unexpected,
  };
}

// ── Gate 2: module size and shrink-only allowlist (AC4) ──────────────

/**
 * Allowlist entries whose module is no longer oversized (or no longer exists).
 *
 * "Allowlist may only shrink": an entry that no longer covers an oversized
 * module is a stale exemption and must be removed, otherwise the ceiling could
 * quietly linger after the monolith has been decomposed.
 */
export function findStaleAllowlistEntries(
  modules: readonly ParsedModule[],
  allowlist: readonly string[] = GITHUB_SYNC_SPLIT_ALLOWLIST,
  max: number = MAX_MODULE_LINES,
): string[] {
  const byBase = new Map(modules.map((m) => [basename(m.file), m] as const));
  return [...new Set(allowlist)]
    .filter((entry) => {
      const mod = byBase.get(entry);
      return !mod || mod.lineCount <= max;
    })
    .sort();
}

// ── Gate 3: barrel imports and cycles (AC7) ──────────────────────────

/** Static import graph over the github-sync family (values + type edges). */
export function buildGithubSyncImportGraph(
  index: ModuleIndex,
  options: GraphOptions = {},
): Map<string, GraphEdge[]> {
  return buildImportGraph(index, { ...GITHUB_SYNC_GRAPH_DEFAULTS, ...options });
}

/** Cycles in the full (value + type) github-sync family import graph. */
export function findStaticCyclesForGithubSync(index: ModuleIndex): string[][] {
  return findStaticCycles(index, GITHUB_SYNC_GRAPH_DEFAULTS);
}

/**
 * Cycles in the github-sync static graph after removing the github-sync
 * type-only barrel allowlist edges (empty at plan time).
 */
export function findUnexplainedStaticCyclesForGithubSync(index: ModuleIndex): string[][] {
  return findUnexplainedStaticCycles(index, GITHUB_SYNC_GRAPH_DEFAULTS);
}

/** Cycles in the **runtime** github-sync family import graph. */
export function findRuntimeCyclesForGithubSync(index: ModuleIndex): string[][] {
  return findRuntimeCycles(index, GITHUB_SYNC_GRAPH_DEFAULTS);
}

/** Github-sync-family modules (excluding the barrel) that import the barrel. */
export function findGithubSyncBarrelImports(
  index: ModuleIndex,
  runtimeOnly: boolean = false,
): BarrelImport[] {
  return findBarrelImports(index, runtimeOnly, isGithubSyncFamilyFile, GITHUB_SYNC_BARREL);
}

/**
 * Type-only barrel imports from modules that are **not** in the github-sync
 * {@link TYPE_ONLY_BARREL_ALLOWLIST} — the layering violation no extraction
 * child may introduce.
 */
export function findGithubSyncBarrelTypeOnlyImportsOutsideAllowlist(
  index: ModuleIndex,
): BarrelImport[] {
  const allowlisted = new Set(TYPE_ONLY_BARREL_ALLOWLIST);
  return findGithubSyncBarrelImports(index).filter(
    (imp) => imp.typeOnly && !allowlisted.has(imp.file),
  );
}

/** Allowlist entries whose recorded type-only barrel import vanished. */
export function findAbsentAllowlistedGithubSyncBarrelImports(
  index: ModuleIndex,
  allowlist: readonly string[] = TYPE_ONLY_BARREL_ALLOWLIST,
): string[] {
  const present = new Set(
    findGithubSyncBarrelImports(index)
      .filter((imp) => imp.typeOnly)
      .map((imp) => imp.file),
  );
  return allowlist.filter((file) => !present.has(file)).sort();
}

// ── Baseline ──────────────────────────────────────────────────────────

/** Build the baseline payload from the live barrel surface. */
export function buildBaseline(repoRoot: string): SplitBaseline {
  const index = loadModuleIndex(repoRoot, FAMILY_ROOTS);
  const kinds = collectExportKinds(index, GITHUB_SYNC_BARREL);
  return {
    version: 1,
    provenance: {
      generatedBy: BASELINE_GENERATION_COMMAND,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      generatedAt: new Date().toISOString(),
      barrel: GITHUB_SYNC_BARREL,
      consumerGlobs: CONSUMER_ROOTS.map((root) => `${root}/**/*.ts`),
    },
    symbols: {
      value: namesOfKind(kinds, 'value'),
      type: namesOfKind(kinds, 'type'),
    },
  };
}

/** Read + parse the committed baseline ({@link BASELINE_PATH} by default). */
export function readBaseline(repoRoot: string): SplitBaseline {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, BASELINE_PATH), 'utf-8'),
  ) as SplitBaseline;
}

/** Write a baseline to {@link BASELINE_PATH}; returns the payload written. */
export function writeBaseline(repoRoot: string): SplitBaseline {
  const baseline = buildBaseline(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, BASELINE_PATH),
    `${JSON.stringify(baseline, null, 2)}\n`,
    'utf-8',
  );
  return baseline;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (!process.argv.includes('--write-baseline')) {
    console.error(`usage: ${BASELINE_GENERATION_COMMAND}`);
    process.exit(2);
  }
  const baseline = writeBaseline(repoRoot);
  console.log(
    `wrote ${BASELINE_PATH}: ${baseline.symbols.value.length} value + ${baseline.symbols.type.length} type symbols @ ${baseline.provenance.sourceCommit.slice(0, 8)}`,
  );
}
