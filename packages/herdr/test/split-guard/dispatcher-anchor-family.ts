/**
 * packages/herdr/test/split-guard/dispatcher-anchor-family.ts — config,
 * export-kind scanner, responsibility-doc gate and baseline producer for the
 * `packages/herdr/src/dispatcher-anchor.ts` split guard.
 *
 * Parent: WL-0MVGKHCP9005SJPZ (decompose the `dispatcher-anchor.ts` god class).
 * Guard item: WL-0MW0JH7TK008UP0M (this file's owning work item).
 *
 * ## Why this module exists
 *
 * Every extraction child (2–8) moves code out of
 * `packages/herdr/src/dispatcher-anchor.ts` without touching a single test
 * file, so the unchanged suites are the behaviour gate. Nothing in the
 * repository enforces the *structural* half of the contract (unchanged public
 * surface and export kind, no barrel runtime import, no new cycle, a module
 * line ceiling, a responsibility doc per extracted module).
 *
 * It deliberately **reuses** the generic, family-agnostic predicates exported
 * by the sibling `scan.ts` (`SplitFamilyConfig`, `collectExportedNames`,
 * `consumerImportNames`, `findMissingExports`, `findBarrelValueImports`,
 * `findSplitFamilyCycles`, `findRuntimeCycles`, `findCycleBaselineViolations`,
 * `findOversizedModules`, `findAllowlistViolations`, …) and never edits it.
 * Only the three family-specific gaps live here:
 *
 * 1. **export kind** — the parent AC2 freezes all 32 exports *with their
 *    value/type kind*, which `scan.ts`'s name-only export collector cannot
 *    express. {@link collectExportKinds} parses declarations and follows
 *    `export … from` chains so the gate keeps working once the barrel becomes
 *    a thin re-export shell.
 * 2. **responsibility doc** — every extracted `dispatcher-anchor.*` module
 *    must carry a top-level doc comment (parent AC5).
 * 3. **constrained consumer set** — the barrel is imported by a fixed set of
 *    files, and the baseline must be scanned from exactly those roots so an
 *    unrelated import elsewhere cannot silently change the frozen surface.
 *
 * ## Baseline generation (provenance)
 *
 *   npx tsx packages/herdr/test/split-guard/dispatcher-anchor-family.ts \
 *     --write-baseline
 *
 * writes `packages/herdr/src/dispatcher-anchor.split-baseline.json`: the
 * frozen 32-symbol export surface with its value/type partition, the symbols
 * the recorded importers actually consume, and provenance (generation command,
 * source commit, timestamp, scanned globs). Re-run it only when the consumer
 * surface is *deliberately* changed; the committed file is the contract.
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
  loadConsumerSources,
  loadModuleIndex,
  resolveImportTarget,
  type ModuleIndex,
  type SplitFamilyConfig,
} from './scan.js';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every consumer imports. */
export const DISPATCHER_ANCHOR_BARREL = 'packages/herdr/src/dispatcher-anchor.ts';

/** Directory the split's modules live in. */
export const DISPATCHER_ANCHOR_FAMILY_DIR = 'packages/herdr/src';

/** A family file: the barrel plus any `dispatcher-anchor.<slice>.ts` module. */
export const DISPATCHER_ANCHOR_FAMILY_PATTERN = /^dispatcher-anchor[^/]*\.ts$/;

/** Repository-relative path of the committed consumer-symbol baseline. */
export const DISPATCHER_ANCHOR_BASELINE_PATH =
  'packages/herdr/src/dispatcher-anchor.split-baseline.json';

/** Per-module line ceiling (parent AC1). Re-exported from `scan.ts`. */
export { MAX_MODULE_LINES };

/**
 * Files currently exempt from the size gate.
 *
 * This is a *shrink-only* allowlist: it may only ever lose entries, never gain
 * them. `dispatcher-anchor.ts` is the not-yet-split monolith (1,333 lines); the
 * final barrel child empties the list once the split is complete.
 */
export const DISPATCHER_ANCHOR_SPLIT_ALLOWLIST: readonly string[] = ['dispatcher-anchor.ts'];

/**
 * The allowlist as it stood at plan time. {@link
 * DISPATCHER_ANCHOR_SPLIT_ALLOWLIST} must remain a subset of this, which makes
 * "grows back into a collection of oversized modules" a test failure rather
 * than a review finding.
 */
export const DISPATCHER_ANCHOR_SPLIT_ALLOWLIST_CEILING: readonly string[] = [
  'dispatcher-anchor.ts',
];

/**
 * Pre-existing import cycles involving a dispatcher-anchor module, recorded at
 * guard-creation time (`dev` @ guard creation).
 *
 * There is currently no cycle that contains a `dispatcher-anchor*.ts`
 * production module, so any cycle among the family's modules is automatically
 * a violation. Recorded reality is therefore the empty list.
 */
export const DISPATCHER_ANCHOR_CYCLE_BASELINE: readonly (readonly string[])[] = [];

/** Recorded edges of those cycles that must stay type-only (none today). */
export const DISPATCHER_ANCHOR_TYPE_ONLY_EDGES: readonly { from: string; to: string }[] = [];

/** Recorded pre-existing **runtime** (value-only) cycles (none today). */
export const DISPATCHER_ANCHOR_RUNTIME_CYCLE_BASELINE: readonly (readonly string[])[] = [];

/**
 * The barrel is imported by these files and no others (frozen at guard
 * creation; every one of them must keep compiling with **no import edits**).
 *
 * The parent plan counted "12 importing files (9 production + 3 test)"; the
 * live tree has **10** files with a static import — 7 production, 3 test — and
 * the difference is stale prose, not a missing importer (the two extra
 * mentions of `./dispatcher-anchor.js` are documentation comments in
 * `index.anchor-resolvers.ts` / `index.interactive.ts`). The gate records what
 * the parser actually finds; a genuinely new consumer must be deliberately
 * added here.
 */
export const KNOWN_CONSUMER_FILES: readonly string[] = [
  'packages/herdr/src/dispatcher-anchor.test.ts',
  'packages/herdr/src/downtime-worker.dispatch-claims.ts',
  'packages/herdr/src/downtime-worker.dispatch-contract.ts',
  'packages/herdr/src/downtime-worker.worker-contract.ts',
  'packages/herdr/src/hydrator.ts',
  'packages/herdr/src/index.anchor-resolvers.ts',
  'packages/herdr/src/index.interactive.ts',
  'packages/herdr/src/index.test.ts',
  'packages/herdr/src/index.ts',
  'tests/herdr/dispatcher-anchor.integration.test.ts',
];

/**
 * Roots scanned for barrel consumers: exactly the two directories that hold
 * every known importer. The repository-wide roots (`src`, `scripts`, `tests`)
 * are deliberately excluded so the frozen baseline cannot drift because of an
 * unrelated module elsewhere.
 */
export const DISPATCHER_ANCHOR_CONSUMER_ROOTS: readonly string[] = [
  'packages/herdr/src',
  'tests/herdr',
];

/**
 * `SplitFamilyConfig` requires a single-owner declaration; this module holds no
 * module-scope mutable state, so the field names a sentinel that must never be
 * declared (a deliberate no-op, asserted by the guard).
 */
export const SINGLE_OWNER_DECLARATION = 'DISPATCHER_ANCHOR_NO_SHARED_MODULE_STATE';

/** Generation command recorded in the baseline provenance. */
export const DISPATCHER_ANCHOR_BASELINE_COMMAND =
  'npx tsx packages/herdr/test/split-guard/dispatcher-anchor-family.ts --write-baseline';

/** The dispatcher-anchor split's inputs to the shared gate predicates. */
export const DISPATCHER_ANCHOR_CONFIG: SplitFamilyConfig = {
  barrel: DISPATCHER_ANCHOR_BARREL,
  familyDir: DISPATCHER_ANCHOR_FAMILY_DIR,
  familyPattern: DISPATCHER_ANCHOR_FAMILY_PATTERN,
  baselinePath: DISPATCHER_ANCHOR_BASELINE_PATH,
  allowlist: DISPATCHER_ANCHOR_SPLIT_ALLOWLIST,
  allowlistCeiling: DISPATCHER_ANCHOR_SPLIT_ALLOWLIST_CEILING,
  cycleBaseline: DISPATCHER_ANCHOR_CYCLE_BASELINE,
  typeOnlyEdges: DISPATCHER_ANCHOR_TYPE_ONLY_EDGES,
  runtimeCycleBaseline: DISPATCHER_ANCHOR_RUNTIME_CYCLE_BASELINE,
  singleOwnerDeclaration: SINGLE_OWNER_DECLARATION,
  baselineCommand: DISPATCHER_ANCHOR_BASELINE_COMMAND,
  consumerRoots: DISPATCHER_ANCHOR_CONSUMER_ROOTS,
};

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
  entry: string = DISPATCHER_ANCHOR_BARREL,
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
      // `seen` is a *path* set: a sibling re-export of the same module must
      // still be resolved (two `export … from './x.js'` statements are legal).
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
 * The barrel is excluded (it is the module that gets the split into pieces;
 * the parent AC5 requirement is stated per *extracted* module). A file missing
 * from `sources` is reported — an unreadable module cannot prove its doc.
 */
export function findMissingResponsibilityDocs(
  sources: Map<string, string> | Record<string, string>,
  files: readonly string[],
  barrel: string = DISPATCHER_ANCHOR_BARREL,
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

// ── Consumer set ──────────────────────────────────────────────────────

function isFamilyModule(file: string): boolean {
  return (
    path.posix.dirname(file) === DISPATCHER_ANCHOR_FAMILY_DIR &&
    DISPATCHER_ANCHOR_FAMILY_PATTERN.test(basename(file))
  );
}

/**
 * Every module that statically imports the barrel, sorted, limited to the
 * modules that count as *consumers*.
 *
 * Family modules are normally excluded: from child 2 onwards an extracted
 * module may import the barrel **type-only**, which the layering gate permits
 * and which must not count as a drift in the frozen *consumer* set. The one
 * exception is a family module recorded in `known` —
 * `dispatcher-anchor.test.ts` is both a family file (its name matches the
 * family pattern) and a frozen importer, so it must stay visible here.
 */
export function findBarrelConsumers(
  index: ModuleIndex,
  barrel: string = DISPATCHER_ANCHOR_BARREL,
  known: readonly string[] = KNOWN_CONSUMER_FILES,
): string[] {
  const allowed = new Set(known);
  const found: string[] = [];
  for (const mod of index.byFile.values()) {
    if (mod.file === barrel) continue;
    // An extracted family module may type-import the barrel (layering gate
    // permits it) without counting as a consumer — unless it is one of the
    // frozen importers (`dispatcher-anchor.test.ts`).
    if (isFamilyModule(mod.file) && !allowed.has(mod.file)) continue;
    if (mod.imports.some((imp) => resolveImportTarget(mod.file, imp.specifier) === barrel)) {
      found.push(mod.file);
    }
  }
  return found.sort();
}

/** Consumers outside the frozen importer set — a new, unreviewed dependency. */
export function findUnknownConsumers(
  index: ModuleIndex,
  barrel: string = DISPATCHER_ANCHOR_BARREL,
  known: readonly string[] = KNOWN_CONSUMER_FILES,
): string[] {
  const allowed = new Set(known);
  return findBarrelConsumers(index, barrel, known).filter((file) => !allowed.has(file));
}

// ── Baseline ──────────────────────────────────────────────────────────

export interface DispatcherAnchorBaseline {
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
export function buildDispatcherAnchorBaseline(repoRoot: string): DispatcherAnchorBaseline {
  const index = loadModuleIndex(repoRoot, DISPATCHER_ANCHOR_CONSUMER_ROOTS);
  const sources = loadConsumerSources(repoRoot, [DISPATCHER_ANCHOR_FAMILY_DIR]);
  const exported = [...collectExportedNames(index, DISPATCHER_ANCHOR_BARREL)].sort();
  const kinds = collectExportKinds(sources, DISPATCHER_ANCHOR_BARREL);

  const unclassified = exported.filter((name) => kinds.get(name) === undefined);
  if (unclassified.length > 0) {
    throw new Error(
      `cannot classify the export kind of: ${unclassified.join(', ')} ` +
        `(expected a declaration or a resolvable re-export in ${DISPATCHER_ANCHOR_BARREL})`,
    );
  }

  return {
    provenance: {
      generatedBy: DISPATCHER_ANCHOR_BASELINE_COMMAND,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      generatedAt: new Date().toISOString(),
      barrel: DISPATCHER_ANCHOR_BARREL,
      consumerGlobs: DISPATCHER_ANCHOR_CONSUMER_ROOTS.map((root) => `${root}/**/*.ts`),
    },
    symbols: exported,
    valueSymbols: exported.filter((name) => kinds.get(name) === 'value'),
    typeSymbols: exported.filter((name) => kinds.get(name) === 'type'),
    consumerSymbols: [...consumerImportNames(index, DISPATCHER_ANCHOR_BARREL).keys()].sort(),
  };
}

/** Read + parse the committed baseline. */
export function readDispatcherAnchorBaseline(repoRoot: string): DispatcherAnchorBaseline {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, DISPATCHER_ANCHOR_BASELINE_PATH), 'utf-8'),
  ) as DispatcherAnchorBaseline;
}

/** Write the baseline to {@link DISPATCHER_ANCHOR_BASELINE_PATH}. */
export function writeDispatcherAnchorBaseline(repoRoot: string): DispatcherAnchorBaseline {
  const baseline = buildDispatcherAnchorBaseline(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, DISPATCHER_ANCHOR_BASELINE_PATH),
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
    console.error(`usage: ${DISPATCHER_ANCHOR_BASELINE_COMMAND}`);
    process.exit(2);
  }
  const baseline = writeDispatcherAnchorBaseline(repoRoot);
  console.log(
    `wrote ${DISPATCHER_ANCHOR_BASELINE_PATH}: ${baseline.symbols.length} symbols ` +
      `(${baseline.valueSymbols.length} value + ${baseline.typeSymbols.length} type, ` +
      `${baseline.consumerSymbols.length} consumed) ` +
      `@ ${baseline.provenance.sourceCommit.slice(0, 8)}`,
  );
}
