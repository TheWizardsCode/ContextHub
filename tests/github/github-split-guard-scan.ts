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
 * 5. **Barrel purity (AC1).** The barrel declares no logic of its own: it may
 *    contain only a header JSDoc and `export … from` statements — no imports
 *    and no local declarations — so a move that leaves a stray helper behind
 *    in `src/github.ts` is a test failure rather than a review finding.
 * 6. **Documentation drift (AC5, WL-0MVVLY0QW007L9ZB).** The
 *    `## GitHub Module Layout` section of `docs/ARCHITECTURE.md` must name
 *    every family module and the public symbols it really documents: every
 *    `` `backticked` `` file path exists, every family module appears in the
 *    responsibilities table, and every symbol in its third column is really
 *    re-exported by the barrel. Docs that drift from the tree fail the suite
 *    rather than a review.
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
 * A *shrink-only* allowlist: it may only ever lose entries. It started with the
 * 1,755-line monolith; the labels child (WL-0MVVLXY42003Q047) dropped
 * `src/github.ts` to 848 lines, so its entry went stale, and the final barrel
 * child (WL-0MVVLY034000MDVA) reduced it to a re-export façade — every family
 * module must stay under {@link MAX_MODULE_LINES} with no exemptions.
 */
export const GITHUB_SPLIT_ALLOWLIST: readonly string[] = [];

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
 * The in-flight monolith (`src/github.ts`) was exempt while it was oversized and
 * allowlisted; the final barrel child (WL-0MVVLY034000MDVA) reduced it to a
 * façade, so it is now covered automatically and must carry a header naming its
 * concern. Every module under `src/github/` is always covered.
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

/**
 * Logic the barrel must not contain (AC1: "`src/github.ts` contains no logic").
 *
 * A pure barrel is a list of `export … from` statements under one header
 * JSDoc: re-exports are parsed into {@link ParsedModule.reexports}, so any
 * entry in {@link ParsedModule.declarations} or
 * {@link ParsedModule.imports} is logic the curtain was supposed to keep out.
 * Pure predicate over a parsed module, so the suite can prove it fails on a
 * barrel that still holds an implementation.
 */
export function findBarrelLocalLogic(mod: ParsedModule): Array<{
  file: string;
  kind: 'declaration' | 'import';
  name: string;
}> {
  const violations: Array<{
    file: string;
    kind: 'declaration' | 'import';
    name: string;
  }> = [];
  for (const name of mod.declarations.keys()) {
    violations.push({ file: mod.file, kind: 'declaration', name });
  }
  for (const imp of mod.imports) {
    violations.push({ file: mod.file, kind: 'import', name: imp.specifier });
  }
  return violations;
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

// ── Gate 4: architecture-doc drift (WL-0MVVLY0QW007L9ZB) ─────────────

/** The document that owns the "GitHub Module Layout" section (AC5). */
export const ARCHITECTURE_DOC_PATH = 'docs/ARCHITECTURE.md';

/** Heading of the github layout section the doc gate reads. */
export const GITHUB_LAYOUT_HEADING = '## GitHub Module Layout';

/** Heading of the responsibilities table inside that section. */
export const RESPONSIBILITIES_HEADING = '### Module responsibilities';

/** A repository-relative file path, as written in the docs. */
// A repo-relative path starts with a word character: module specifiers such
// as `../github.js` are edges, not tree paths, and must not be existence-checked.
const DOC_PATH_PATTERN = /^\w[\w@./-]*\.(?:ts|tsx|js|jsx|json|md|yaml|yml)$/;

/** A bare identifier, as written in the responsibilities table. */
const DOC_SYMBOL_PATTERN = /^[A-Za-z_$][\w$]*$/;

/**
 * Body of the level-2 section under `heading`, excluding the heading itself.
 *
 * Returns `null` when the document has no such section, so a deleted section is
 * a loud failure rather than an empty (trivially green) scan. The scan stops at
 * the next level-2 heading, so the sibling `## Sync Module Layout` and
 * `## Interview Module Layout` sections are never read.
 */
export function extractDocSection(markdown: string, heading: string): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/**
 * Rows of the first markdown table under `heading`, as trimmed cell arrays.
 *
 * Purely structural: the header row and the `|---|` separator are skipped, and
 * the scan stops at the first line that is not a table row after the table has
 * started. Returns `[]` when the heading or its table is missing.
 */
function tableRows(section: string, heading: string): string[][] {
  const lines = section.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];
  const rows: string[][] = [];
  let started = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) {
      if (started) break;
      continue;
    }
    started = true;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * Repository-relative file paths named in `` `backticks` `` inside `section`.
 *
 * Deduplicated and sorted, so a doc gate compares stable lists. Only tokens
 * that look like files are kept — symbol names, prose and `all 58`-style cells
 * are ignored.
 */
export function extractDocumentedPaths(section: string): string[] {
  const paths = new Set<string>();
  for (const match of section.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim();
    if (DOC_PATH_PATTERN.test(token)) paths.add(token);
  }
  return [...paths].sort();
}

/** Documented paths that do not exist in the tree, judged by `exists`. */
export function findMissingDocumentedPaths(
  section: string,
  exists: (relPath: string) => boolean,
): string[] {
  return extractDocumentedPaths(section).filter((relPath) => !exists(relPath));
}

/**
 * Public symbols the responsibilities table claims the barrel re-exports.
 *
 * Reads the third column (`Public symbols re-exported by the barrel`) of the
 * table under {@link RESPONSIBILITIES_HEADING}; `6 types` / `all 58` cells
 * contribute nothing because they carry no `` `backticked` `` identifier.
 */
export function extractResponsibilitySymbols(section: string): string[] {
  const symbols = new Set<string>();
  for (const cells of tableRows(section, RESPONSIBILITIES_HEADING)) {
    for (const match of (cells[2] ?? '').matchAll(/`([^`\n]+)`/g)) {
      const token = match[1].trim();
      if (DOC_SYMBOL_PATTERN.test(token)) symbols.add(token);
    }
  }
  return [...symbols].sort();
}

/** Documented symbols that the barrel does not really re-export. */
export function findMissingDocumentedSymbols(
  section: string,
  exported: Iterable<string>,
): string[] {
  const available = new Set(exported);
  return extractResponsibilitySymbols(section).filter((symbol) => !available.has(symbol));
}

/** Family modules the responsibilities table fails to name. */
export function findUndocumentedModules(
  section: string,
  modules: readonly string[],
): string[] {
  const documented = new Set(extractDocumentedPaths(section));
  return modules.filter((file) => !documented.has(file)).sort();
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
