/**
 * packages/herdr/test/split-guard/fetcher-family.ts — config, export-kind
 * scanner, responsibility-doc gate and baseline producer for the
 * `packages/herdr/src/fetcher.ts` split guard.
 *
 * Parent: WL-0MVGKH47T007GKN1 (decompose the `fetcher.ts` god class).
 * Guard item: WL-0MW08VST6005NDME (this file's owning work item).
 *
 * ## Why this module exists
 *
 * Every extraction child (2–7) moves code out of
 * `packages/herdr/src/fetcher.ts` without touching a single test file, so the
 * unchanged suites are the behaviour gate. Nothing in the repository enforces
 * the *structural* half of the contract (unchanged public surface and export
 * kind, no barrel runtime import, no new cycle, a module line ceiling, a
 * responsibility doc per extracted module, single-owner module state).
 *
 * It deliberately **reuses** the generic, family-agnostic predicates exported
 * by the sibling `scan.ts` (`SplitFamilyConfig`, `collectExportedNames`,
 * `consumerImportNames`, `findMissingExports`, `findBarrelValueImports`,
 * `findSplitFamilyCycles`, `findRuntimeCycles`, `findCycleBaselineViolations`,
 * `findOversizedModules`, `findAllowlistViolations`, …
 * ) and never edits it. Only the fetcher-specific gaps live here:
 *
 * 1. **export kind** — the parent AC2 freezes the public surface *with* its
 *    value/type kind, which `scan.ts`'s name-only export collector cannot
 *    express. {@link collectExportKinds} parses declarations and follows
 *    `export … from` chains so the gate keeps working once the barrel becomes
 *    a thin re-export shell.
 * 2. **responsibility doc** — every extracted `fetcher.*` module must carry a
 *    top-level doc comment (parent AC5).
 * 3. **single-owner module state** — the worklog-dir/exec-seam overrides, the
 *    spawn cap and the fetch/worklist-bundle memo maps must each stay declared
 *    in exactly one family module; a copy-paste extraction that duplicates one
 *    silently breaks test mocks or memoisation.
 *
 * The two scanner helpers are local copies of the same predicates in
 * `dispatcher-anchor-family.ts` rather than a cross-family import: each guard
 * family owns its gaps, `scan.ts` is read-only, and a family must not break
 * because a sibling family's guard file is reorganised.
 *
 * ## Consumer surface scoping
 *
 * The parent plan counted "68 consumer files importing `./fetcher.js`" — the
 * 16 production + 52 test files inside `packages/herdr/src`. External
 * importers (`tests/herdr/fetcher*.test.ts`, `scripts/…`, `bench/…`) reach the
 * barrel through a repo-relative specifier, and three symbols are consumed
 * **only** from there (`WlError`, `formatWlError`, `_fetchMemoSize`). The
 * baseline therefore scans all four roots so the frozen surface cannot miss a
 * consumer that a move-only split would break.
 *
 * ## Baseline generation (provenance)
 *
 *   npx tsx packages/herdr/test/split-guard/fetcher-family.ts --write-baseline
 *
 * writes `packages/herdr/src/fetcher.split-baseline.json`: the frozen export
 * surface with its value/type partition, the symbols the recorded importers
 * actually consume, and provenance (generation command, source commit,
 * timestamp, scanned globs). Re-run it only when the consumer surface is
 * *deliberately* changed; the committed file is the contract the guard
 * enforces.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  MAX_MODULE_LINES,
  basename,
  collectExportedNames,
  consumerImportNames,
  countDeclarations,
  findDeclarationModules,
  loadConsumerSources,
  loadModuleIndex,
  resolveImportTarget,
  splitFamilyModules,
  type ModuleIndex,
  type ParsedModule,
  type SplitFamilyConfig,
} from './scan.js';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every fetcher consumer imports. */
export const FETCHER_BARREL = 'packages/herdr/src/fetcher.ts';

/** Directory the split's modules live in. */
export const FETCHER_FAMILY_DIR = 'packages/herdr/src';

/**
 * A fetcher-family file: the `fetcher.ts` barrel plus any `fetcher.<slice>.ts`
 * extracted module. Existing hyphenated suites (`fetcher-blockers.test.ts`,
 * `fetcher-inprocess.test.ts`, …) do **not** match, so they stay ordinary
 * consumers and are never treated as split modules.
 */
export const FETCHER_FAMILY_PATTERN = /^fetcher(\.[\w-]+)?\.ts$/;

/** Repository-relative path of the committed consumer-symbol baseline. */
export const FETCHER_BASELINE_PATH = 'packages/herdr/src/fetcher.split-baseline.json';

/** Per-module line ceiling (parent AC1). Re-exported from `scan.ts`. */
export { MAX_MODULE_LINES };

/**
 * Files currently exempt from the size gate.
 *
 * This is a *shrink-only* allowlist: it may only ever lose entries, never gain
 * them. The split is complete, so it is now empty and the size gate covers
 * every `fetcher*.ts` production module — including the barrel — with no
 * exemptions (close-out child WL-0MW08VZ5M003OK2X).
 */
export const FETCHER_SPLIT_ALLOWLIST: readonly string[] = [];

/**
 * The allowlist as it stood at plan time. {@link FETCHER_SPLIT_ALLOWLIST} must
 * remain a subset of this, which makes "grows back into a collection of
 * oversized modules" a test failure rather than a review finding.
 */
export const FETCHER_SPLIT_ALLOWLIST_CEILING: readonly string[] = ['fetcher.ts'];

/**
 * Pre-existing import cycles involving a `fetcher*.ts` production module,
 * recorded at guard-creation time (`dev` @ guard creation).
 *
 * Recorded reality: one large component reaches the barrel through a mix of
 * value and type-only edges. A cycle among the split's own modules is
 * therefore automatically a violation (any component not contained by this
 * baseline fails {@link findCycleBaselineViolations}).
 */
export const FETCHER_CYCLE_BASELINE: readonly (readonly string[])[] = [
  [
    'packages/herdr/src/agent-tracker.ts',
    'packages/herdr/src/downtime-worker.ts',
    'packages/herdr/src/fetcher.ts',
    'packages/herdr/src/hydrator.ts',
    'packages/herdr/src/smart-selection.ts',
    'packages/herdr/src/stalled-work.ts',
  ],
];

/**
 * Directed edges of the recorded cycle that must stay **type-only**. An
 * extraction must not widen one into a runtime import (parent AC4).
 *
 * The `fetcher.ts → agent-tracker.ts` edge moved to `fetcher.types.ts`
 * together with the type declarations that carry it (`WorkItem.agentState`),
 * which also removed it from the cycle itself (WL-0MW08VTPK006U01L); both the
 * historical entry and the current edge are recorded here.
 */
export const FETCHER_TYPE_ONLY_EDGES: readonly { from: string; to: string }[] = [
  { from: 'packages/herdr/src/downtime-worker.ts', to: 'packages/herdr/src/stalled-work.ts' },
  { from: 'packages/herdr/src/fetcher.ts', to: 'packages/herdr/src/agent-tracker.ts' },
  { from: 'packages/herdr/src/smart-selection.ts', to: 'packages/herdr/src/fetcher.ts' },
  { from: 'packages/herdr/src/fetcher.types.ts', to: 'packages/herdr/src/agent-tracker.ts' },
];

/**
 * Recorded pre-existing **runtime** (value-only) cycles involving the family.
 *
 * `fetcher.ts ↔ hydrator.ts` already exists in the emitted JavaScript (both
 * directions are value imports), so it is recorded rather than forbidden; a
 * new runtime cycle is still a violation (parent AC4).
 */
export const FETCHER_RUNTIME_CYCLE_BASELINE: readonly (readonly string[])[] = [
  ['packages/herdr/src/fetcher.ts', 'packages/herdr/src/hydrator.ts'],
];

/**
 * Module-scope declarations that must each live in exactly one family module.
 *
 * These carry state whose duplication is invisible to the compiler but breaks
 * behaviour: `execFileAsync`/`_worklogDir` back the test seams
 * (`setExecFileAsync`, `setWorklogDir`), `wlSpawnCap`/`activeWlSpawns` back the
 * concurrency limiter, and the memo maps back the in-flight dedupe. A
 * copy-paste extraction that redeclares one of them silently defeats its
 * setter or its cache.
 */
export const FETCHER_SINGLE_OWNER_DECLARATIONS: readonly string[] = [
  'execFileAsync',
  '_worklogDir',
  'wlSpawnCap',
  'activeWlSpawns',
  'inflightFetchMemo',
  'lastWorklistBundle',
  'inflightWorklistBundle',
];

/**
 * `SplitFamilyConfig` requires a single-owner declaration; this is the
 * highest-risk one, so it names the exec seam.
 */
export const SINGLE_OWNER_DECLARATION = 'execFileAsync';

/**
 * Roots scanned for barrel consumers: the in-repo module tree plus the
 * external suites/scripts/bench that import the barrel by repo-relative path.
 */
export const FETCHER_CONSUMER_ROOTS: readonly string[] = [
  'packages/herdr/src',
  'tests',
  'scripts',
  'bench',
];

/** Generation command recorded in the baseline provenance. */
export const FETCHER_BASELINE_COMMAND =
  'npx tsx packages/herdr/test/split-guard/fetcher-family.ts --write-baseline';

/** The fetcher split's inputs to the shared gate predicates. */
export const FETCHER_CONFIG: SplitFamilyConfig = {
  barrel: FETCHER_BARREL,
  familyDir: FETCHER_FAMILY_DIR,
  familyPattern: FETCHER_FAMILY_PATTERN,
  baselinePath: FETCHER_BASELINE_PATH,
  allowlist: FETCHER_SPLIT_ALLOWLIST,
  allowlistCeiling: FETCHER_SPLIT_ALLOWLIST_CEILING,
  cycleBaseline: FETCHER_CYCLE_BASELINE,
  typeOnlyEdges: FETCHER_TYPE_ONLY_EDGES,
  runtimeCycleBaseline: FETCHER_RUNTIME_CYCLE_BASELINE,
  singleOwnerDeclaration: SINGLE_OWNER_DECLARATION,
  baselineCommand: FETCHER_BASELINE_COMMAND,
  consumerRoots: FETCHER_CONSUMER_ROOTS,
};

// ── Family selection ──────────────────────────────────────────────────

/** True for `packages/herdr/src/fetcher.ts` or `fetcher.<slice>.ts`. */
export function isFetcherFamilyFile(file: string): boolean {
  return (
    path.posix.dirname(file) === FETCHER_FAMILY_DIR &&
    FETCHER_FAMILY_PATTERN.test(basename(file))
  );
}

/** Production `fetcher*.ts` modules (tests/fixtures excluded). */
export function fetcherFamilyModules(index: ModuleIndex): ParsedModule[] {
  return splitFamilyModules(index, FETCHER_CONFIG);
}

// ── Export kinds ──────────────────────────────────────────────────────

/** How a symbol is exported: a runtime value or a type-only declaration. */
export type ExportKind = 'value' | 'type';

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function declaredKind(node: ts.Statement): ExportKind | null {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return 'type';
  if (
    ts.isVariableStatement(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return 'value';
  }
  return null;
}

function declaredName(node: ts.Node): string | null {
  const name = (node as { name?: ts.Node }).name;
  return name && ts.isIdentifier(name) ? name.text : null;
}

/**
 * Every name a barrel (transitively) exports, mapped to its value/type kind.
 *
 * Follows `export * from`, `export { a as b } from` and `export type { … }`
 * chains, so the kind of a re-exported symbol is resolved at its declaration.
 * Pure over `sources` (repository-relative POSIX path → source text), which
 * makes it usable both on the live tree (`loadConsumerSources`) and on
 * synthetic inputs in the negative-case tests.
 */
export function collectExportKinds(
  sources: Map<string, string> | Record<string, string>,
  entry: string = FETCHER_BARREL,
  seen: Set<string> = new Set(),
): Map<string, ExportKind> {
  const entries = sources instanceof Map ? sources : new Map(Object.entries(sources));
  const out = new Map<string, ExportKind>();
  if (seen.has(entry)) return out;
  seen.add(entry);

  const source = entries.get(entry);
  if (source === undefined) return out;
  const sf = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      const specifier =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : null;
      if (!specifier) continue;
      const target = resolveImportTarget(entry, specifier);
      if (!target) continue;
      // `seen` is a *path* set: two `export … from './x.js'` statements are
      // legal and must each resolve.
      const inner = collectExportKinds(entries, target, new Set(seen));

      if (!stmt.exportClause) {
        // `export * from '…'` re-exports every symbol, kinds included.
        for (const [name, kind] of inner) out.set(name, kind);
        continue;
      }
      if (!ts.isNamedExports(stmt.exportClause)) continue;
      for (const el of stmt.exportClause.elements) {
        const sourceName = (el.propertyName ?? el.name).text;
        const exportedName = el.name.text;
        const kind: ExportKind | undefined =
          stmt.isTypeOnly || el.isTypeOnly ? 'type' : inner.get(sourceName);
        if (kind) out.set(exportedName, kind);
      }
      continue;
    }

    if (!hasExportModifier(stmt)) continue;
    const kind = declaredKind(stmt);
    if (!kind) continue;
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.set(decl.name.text, kind);
      }
      continue;
    }
    const name = declaredName(stmt);
    if (name) out.set(name, kind);
  }

  return out;
}

/** A baseline symbol whose live export kind differs from (or lost) the frozen one. */
export interface ExportKindViolation {
  name: string;
  expected: ExportKind;
  actual: ExportKind | 'missing';
}

/**
 * Baseline symbols that are no longer exported with the frozen kind.
 *
 * "Still exported but as the wrong kind" — a `const` turned into a `type` (or
 * the reverse) — is invisible to the name-only surface gate but silently breaks
 * every consumer that uses the symbol in a value position.
 */
export function findExportKindViolations(
  live: Map<string, ExportKind> | Record<string, ExportKind>,
  baseline: { valueSymbols: readonly string[]; typeSymbols: readonly string[] },
): ExportKindViolation[] {
  const actualMap = live instanceof Map ? live : new Map(Object.entries(live));
  const violations: ExportKindViolation[] = [];
  for (const name of [...baseline.valueSymbols].sort()) {
    const actual = actualMap.get(name) ?? 'missing';
    if (actual !== 'value') violations.push({ name, expected: 'value', actual });
  }
  for (const name of [...baseline.typeSymbols].sort()) {
    const actual = actualMap.get(name) ?? 'missing';
    if (actual !== 'type') violations.push({ name, expected: 'type', actual });
  }
  return violations.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Responsibility docs ───────────────────────────────────────────────

const LEADING_DOC_COMMENT = /^\s*\/\*\*([\s\S]*?)\*\//;

/**
 * Extracted family modules that carry no top-level doc comment.
 *
 * The barrel is excluded (parent AC5 states the requirement per *extracted*
 * module). A file missing from `sources` is reported — an unreadable module
 * cannot prove its doc.
 */
export function findMissingResponsibilityDocs(
  sources: Map<string, string> | Record<string, string>,
  files: readonly string[],
  barrel: string = FETCHER_BARREL,
): string[] {
  const entries = sources instanceof Map ? sources : new Map(Object.entries(sources));
  const missing: string[] = [];
  for (const file of [...files].sort()) {
    if (file === barrel) continue;
    const source = entries.get(file);
    if (source === undefined) {
      missing.push(file);
      continue;
    }
    const match = LEADING_DOC_COMMENT.exec(source);
    const body = match?.[1]?.trim() ?? '';
    // Require more than an empty `/** */` placeholder.
    if (body.length < 10) missing.push(file);
  }
  return missing;
}

// ── Single-owner module state ─────────────────────────────────────────

/**
 * Single-owner names that are declared in zero or several family modules.
 *
 * Each must be declared exactly once (in exactly one module): zero would mean
 * the extraction dropped the state, several would mean a copy-paste
 * duplication that defeats its setter or cache.
 */
export function findSingleOwnerViolations(
  modules: readonly ParsedModule[],
  names: readonly string[] = FETCHER_SINGLE_OWNER_DECLARATIONS,
): { name: string; files: string[]; total: number }[] {
  return names
    .map((name) => ({
      name,
      files: findDeclarationModules(modules, name).map((d) => d.file),
      total: countDeclarations(modules, name),
    }))
    .filter((v) => v.files.length !== 1 || v.total !== 1);
}

// ── Baseline ──────────────────────────────────────────────────────────

export interface FetcherBaseline {
  provenance: {
    generatedBy: string;
    sourceCommit: string;
    generatedAt: string;
    barrel: string;
    consumerGlobs: string[];
  };
  /** The frozen public surface: every symbol the barrel exports, sorted. */
  symbols: string[];
  /** The subset of {@link symbols} that are runtime values. */
  valueSymbols: string[];
  /** The subset of {@link symbols} that are type-only declarations. */
  typeSymbols: string[];
  /** Symbols the recorded importer set actually consumes. */
  consumerSymbols: string[];
}

/** Build the baseline payload from the live tree. */
export function buildFetcherBaseline(repoRoot: string): FetcherBaseline {
  const index = loadModuleIndex(repoRoot, FETCHER_CONSUMER_ROOTS);
  const sources = loadConsumerSources(repoRoot, [FETCHER_FAMILY_DIR]);
  const exported = [...collectExportedNames(index, FETCHER_BARREL)].sort();
  const kinds = collectExportKinds(sources, FETCHER_BARREL);

  const unclassified = exported.filter((name) => kinds.get(name) === undefined);
  if (unclassified.length > 0) {
    throw new Error(
      `cannot classify the export kind of: ${unclassified.join(', ')} ` +
        `(expected a declaration or a resolvable re-export in ${FETCHER_BARREL})`,
    );
  }

  return {
    provenance: {
      generatedBy: FETCHER_BASELINE_COMMAND,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      generatedAt: new Date().toISOString(),
      barrel: FETCHER_BARREL,
      consumerGlobs: FETCHER_CONSUMER_ROOTS.map((root) => `${root}/**/*.ts`),
    },
    symbols: exported,
    valueSymbols: exported.filter((name) => kinds.get(name) === 'value'),
    typeSymbols: exported.filter((name) => kinds.get(name) === 'type'),
    consumerSymbols: [...consumerImportNames(index, FETCHER_BARREL).keys()].sort(),
  };
}

/** Read + parse the committed baseline. */
export function readFetcherBaseline(repoRoot: string): FetcherBaseline {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, FETCHER_BASELINE_PATH), 'utf-8'),
  ) as FetcherBaseline;
}

/** Write the baseline to {@link FETCHER_BASELINE_PATH}. */
export function writeFetcherBaseline(repoRoot: string): FetcherBaseline {
  const baseline = buildFetcherBaseline(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, FETCHER_BASELINE_PATH),
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
    console.error(`usage: ${FETCHER_BASELINE_COMMAND}`);
    process.exit(2);
  }
  const baseline = writeFetcherBaseline(repoRoot);
  console.log(
    `wrote ${FETCHER_BASELINE_PATH}: ${baseline.symbols.length} symbols ` +
      `(${baseline.valueSymbols.length} value + ${baseline.typeSymbols.length} type, ` +
      `${baseline.consumerSymbols.length} consumed) ` +
      `@ ${baseline.provenance.sourceCommit.slice(0, 8)}`,
  );
}
