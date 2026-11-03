/**
 * tests/github/github-split-guard-scan.ts — static scanners and gate predicates
 * for the `src/github.ts` split invariants.
 *
 * Parent: WL-0MVGKGR2H006MNVG (decompose the `src/github.ts` god class).
 * Guard item: WL-0MVVLXSQX0031IB3 — child 1 of 8, lands **before** any
 * production code moves.
 *
 * ## Module responsibility
 *
 * Every extraction child (2–8) moves code out of `src/github.ts` into
 * `src/github/*` modules without touching a single existing test file, so the
 * unchanged suite is the behaviour gate. This module enforces the *structural*
 * half of the contract, mirroring the shipped `src/sync.ts` split guard
 * (`tests/sync/split-guard-scan.ts`, WL-0MVP9MSJO0099V0G):
 *
 * 1. **Public surface (AC2).** The committed baseline freezes the barrel's
 *    exported symbol names, split into value exports (resolvable at runtime)
 *    and type exports (present in the emitted declaration). A move-only split
 *    may re-home a symbol but may never drop or reclassify one.
 * 2. **Module size (AC1).** Every github-family module stays ≤
 *    {@link MAX_MODULE_LINES}; {@link GITHUB_SPLIT_ALLOWLIST} is shrink-only
 *    against {@link GITHUB_SPLIT_ALLOWLIST_CEILING} and must empty once
 *    `src/github.ts` becomes a thin re-export façade.
 * 3. **Import graph (AC4).** The static and runtime import graphs of the github
 *    family are acyclic and no family module imports the barrel.
 * 4. **Documentation (AC5).** Every github-family production module opens with
 *    a top-level JSDoc header naming its concern.
 *
 * The gates are **pure predicates over parsed modules** rather than assertions
 * over the live tree, so `github-split-guard.test.ts` can prove each gate
 * actually fails on deliberately broken input (AC7) — an untested guard is a
 * guard that silently rots.
 *
 * ## Reuse, not duplication
 *
 * The parser, export-kind resolution, consumer scanning, import-graph builder,
 * cycle finder and barrel-import scanner are **imported** from
 * `../sync/split-guard-scan.js`. That scanner's family predicate and barrel are
 * optional parameters defaulting to the sync values (`splitFamilyModules`,
 * `buildImportGraph` → `GraphOptions.family` / `.barrel` / `.allowlist`,
 * `findStaticCycles`, `findUnexplainedStaticCycles`, `findRuntimeCycles`,
 * `findBarrelImports`), so this guard reuses them with the github values. The
 * sync guard's defaults preserve its behaviour byte-for-byte.
 *
 * ## Baseline generation (AC2 provenance)
 *
 *   npx tsx tests/github/github-split-guard-scan.ts --write-baseline
 *
 * writes `tests/github/github.split-baseline.json` with the barrel's exported
 * symbol names split into `value` and `type` plus provenance. Re-run it only
 * when the public surface is *deliberately* changed; the committed file is the
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
  type GraphEdge,
  type GraphOptions,
  type ModuleIndex,
  type ParsedModule,
  type SplitBaseline,
} from '../sync/split-guard-scan.js';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every consumer imports. */
export const GITHUB_BARREL = 'src/github.ts';

/** Directory extracted github modules live in. */
export const GITHUB_SPLIT_DIR = 'src/github';

/** Repository-relative path of the committed public-surface baseline (AC2). */
export const BASELINE_PATH = 'tests/github/github.split-baseline.json';

/**
 * Family modules currently exempt from the size gate.
 *
 * A *shrink-only* allowlist: it may only ever lose entries. It starts with the
 * 1,755-line monolith; the final barrel child removes that entry once
 * `src/github.ts` is a thin re-export façade, so every family module must then
 * stay under {@link MAX_MODULE_LINES} with no exemptions.
 */
export const GITHUB_SPLIT_ALLOWLIST: readonly string[] = ['github.ts'];

/**
 * The allowlist as it stood at plan time. {@link GITHUB_SPLIT_ALLOWLIST} must
 * remain a subset of this, so "the split regrows into a collection of oversized
 * modules" is a test failure rather than a review finding.
 */
export const GITHUB_SPLIT_ALLOWLIST_CEILING: readonly string[] = ['github.ts'];

/**
 * Family modules permitted to import the barrel with a (type-only) edge.
 *
 * Empty at plan time: the extraction children must not introduce any barrel
 * import, so any family module importing the barrel — type-only or runtime — is
 * a layering violation.
 */
export const TYPE_ONLY_BARREL_ALLOWLIST: readonly string[] = [];

/** Generation command recorded in the baseline provenance (AC2). */
export const BASELINE_GENERATION_COMMAND =
  'npx tsx tests/github/github-split-guard-scan.ts --write-baseline';

/**
 * Defaults that point the shared sync scanners at the github family.
 *
 * Spread into a {@link GraphOptions} so callers may still override individual
 * knobs (e.g. `runtimeOnly`) while the family/barrel/allowlist stay github.
 */
const GITHUB_GRAPH_DEFAULTS: GraphOptions = {
  family: isGithubFamilyFile,
  barrel: GITHUB_BARREL,
  allowlist: TYPE_ONLY_BARREL_ALLOWLIST,
};

// ── Re-exported pure parsers ──────────────────────────────────────────
//
// The github guard reuses (never copies) the sync scanner's pure parsers. They
// are re-exported here so the guard suite imports everything from one module.

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
};
export type { BarrelImport, GraphEdge, GraphOptions, ModuleIndex, ParsedModule, SplitBaseline };

// ── Family identification ─────────────────────────────────────────────

/**
 * True for a module of the github family: the `src/github.ts` barrel and
 * anything under `src/github/`.
 *
 * Note the flat siblings `src/github-sync.ts`, `src/github-throttler.ts`,
 * `src/github-metrics.ts` and `src/github-pre-filter.ts` are **unrelated**
 * modules and are deliberately excluded.
 */
export function isGithubFamilyFile(file: string): boolean {
  if (file === GITHUB_BARREL) return true;
  return file === GITHUB_SPLIT_DIR || file.startsWith(`${GITHUB_SPLIT_DIR}/`);
}

/** Production modules of the github family (the modules the gates cover). */
export function githubFamilyModules(index: ModuleIndex): ParsedModule[] {
  return splitFamilyModules(index, isGithubFamilyFile);
}

/**
 * Family modules the JSDoc-header gate (AC5) covers.
 *
 * The in-flight monolith (`src/github.ts`) has no header at plan time and this
 * guard-only item must not modify production code. It is therefore exempt
 * while it remains the *oversized allowlisted barrel*; once the barrel is
 * reduced to a façade (child 7 removes its allowlist entry), the gate covers it
 * automatically and the façade must carry a header naming its concern. Every
 * module under `src/github/` is always covered.
 */
export function githubFamilyModulesRequiringJsDoc(index: ModuleIndex): ParsedModule[] {
  const allowlisted = new Set(GITHUB_SPLIT_ALLOWLIST);
  return githubFamilyModules(index).filter(
    (m) => !(allowlisted.has(basename(m.file)) && m.lineCount > MAX_MODULE_LINES),
  );
}

// ── Gate 2: module size and shrink-only allowlist ────────────────────

/**
 * Allowlist entries whose module is no longer oversized (or no longer exists).
 *
 * "Allowlist may only shrink": an entry that no longer covers an oversized
 * module is a stale exemption and must be removed, otherwise the ceiling could
 * quietly linger after the monolith has been decomposed.
 */
export function findStaleAllowlistEntries(
  modules: readonly ParsedModule[],
  allowlist: readonly string[] = GITHUB_SPLIT_ALLOWLIST,
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

// ── Gate 3: barrel imports and cycles (reused scanners, github family) ─

/** Static import graph over the github family (values + type edges). */
export function buildGithubImportGraph(
  index: ModuleIndex,
  options: GraphOptions = {},
): Map<string, GraphEdge[]> {
  return buildImportGraph(index, { ...GITHUB_GRAPH_DEFAULTS, ...options });
}

/** Cycles in the full (value + type) github-family import graph. */
export function findStaticCyclesForGithub(index: ModuleIndex): string[][] {
  return findStaticCycles(index, GITHUB_GRAPH_DEFAULTS);
}

/**
 * Cycles in the github static graph after removing the github type-only barrel
 * allowlist edges (empty at plan time).
 */
export function findUnexplainedStaticCyclesForGithub(index: ModuleIndex): string[][] {
  return findUnexplainedStaticCycles(index, GITHUB_GRAPH_DEFAULTS);
}

/** Cycles in the **runtime** github-family import graph. */
export function findRuntimeCyclesForGithub(index: ModuleIndex): string[][] {
  return findRuntimeCycles(index, GITHUB_GRAPH_DEFAULTS);
}

/** Github-family modules (excluding the barrel) that import the barrel. */
export function findGithubBarrelImports(
  index: ModuleIndex,
  runtimeOnly: boolean = false,
): BarrelImport[] {
  return findBarrelImports(index, runtimeOnly, isGithubFamilyFile, GITHUB_BARREL);
}

/**
 * Type-only barrel imports from modules that are **not** in the github
 * {@link TYPE_ONLY_BARREL_ALLOWLIST} — the layering violation no extraction
 * child may introduce.
 */
export function findGithubBarrelTypeOnlyImportsOutsideAllowlist(
  index: ModuleIndex,
): BarrelImport[] {
  const allowlisted = new Set(TYPE_ONLY_BARREL_ALLOWLIST);
  return findGithubBarrelImports(index).filter(
    (imp) => imp.typeOnly && !allowlisted.has(imp.file),
  );
}

/** Github allowlist entries whose recorded type-only barrel import vanished. */
export function findAbsentAllowlistedGithubBarrelImports(
  index: ModuleIndex,
  allowlist: readonly string[] = TYPE_ONLY_BARREL_ALLOWLIST,
): string[] {
  const present = new Set(
    findGithubBarrelImports(index)
      .filter((imp) => imp.typeOnly)
      .map((imp) => imp.file),
  );
  return allowlist.filter((file) => !present.has(file)).sort();
}

// ── Baseline ──────────────────────────────────────────────────────────

/** Build the baseline payload from the live barrel surface. */
export function buildBaseline(repoRoot: string): SplitBaseline {
  const index = loadModuleIndex(repoRoot, FAMILY_ROOTS);
  const kinds = collectExportKinds(index, GITHUB_BARREL);
  return {
    version: 1,
    provenance: {
      generatedBy: BASELINE_GENERATION_COMMAND,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      generatedAt: new Date().toISOString(),
      barrel: GITHUB_BARREL,
      consumerGlobs: CONSUMER_ROOTS.map((root) => `${root}/**/*.ts`),
    },
    symbols: {
      value: namesOfKind(kinds, 'value'),
      type: namesOfKind(kinds, 'type'),
    },
  };
}

/** Read + parse the committed baseline ({@link BASELINE_PATH}). */
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
