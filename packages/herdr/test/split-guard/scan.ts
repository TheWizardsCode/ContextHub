/**
 * packages/herdr/test/split-guard/scan.ts — static scanners and gate predicates
 * shared by the split guards (`downtime-worker.ts`, `index.ts`,
 * `worklist.ts`).
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Guard item: WL-0MVLIHWOY003IP5E (this file's owning work item).
 *
 * ## Parameterisation (WL-0MVND6BL30066V6B)
 *
 * The predicates were originally hard-wired to the `downtime-worker` family.
 * Every family-specific input now travels in a {@link SplitFamilyConfig}
 * (barrel path, family predicate, baseline path, line-ceiling allowlist and its
 * plan-time ceiling, cycle baselines, and the single-owner declaration name).
 * Each parameterised function defaults to {@link DOWNTIME_CONFIG}, so the
 * original downtime guard keeps compiling and passing with **no edits** — the
 * worklist guard (WL-0MVND6BL30066V6B) supplies its own config from
 * `worklist-family.ts`.
 *
 * ## Why this module exists
 *
 * The parent epic requires four behaviour-preserving invariants that the repo
 * has no tooling for (`madge`/`dependency-cruiser` are absent; `vitest` is the
 * only test runner):
 *
 * 1. the public surface at `./downtime-worker.js` is unchanged,
 * 2. `dispatchInFlightCount` stays a single module-scope declaration,
 * 3. no extracted module imports the barrel at runtime and no new import cycle
 *    appears — in particular the pre-existing `stalled-work → downtime-worker`
 *    value import / `downtime-worker → stalled-work` type import must not widen
 *    into a runtime cycle,
 * 4. every `downtime-worker*.ts` production module stays ≤ 1,000 lines, with a
 *    shrink-only allowlist for the not-yet-split monolith.
 *
 * The gates live here as **pure predicates over parsed modules** rather than as
 * assertions over the live tree, so the test file can prove each gate actually
 * fails on a deliberately broken input (AC7) — an untested guard is a guard
 * that silently rots.
 *
 * Parsing uses the TypeScript compiler API (syntax only — no program, no type
 * checker, no network) because the gates must distinguish runtime imports from
 * type-only ones, follow `export *` re-export chains and read multi-line
 * import/export clauses. Text matching cannot do that reliably.
 *
 * ## Baseline generation (AC2 provenance)
 *
 *   npx tsx packages/herdr/test/split-guard/scan.ts --write-baseline
 *
 * writes `packages/herdr/src/downtime-worker.split-baseline.json` with the
 * sorted, deduplicated set of symbols consumers import from the barrel plus
 * provenance (generation command, source commit, timestamp, scanned globs).
 * Re-run it only when the consumer surface is *deliberately* changed; the
 * committed file is the frozen contract the public-surface gate enforces.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every consumer imports. */
export const BARREL = 'packages/herdr/src/downtime-worker.ts';

/** Directory the split's modules live in. */
export const SPLIT_FAMILY_DIR = 'packages/herdr/src';

/** Repository-relative path of the committed consumer-symbol baseline. */
export const BASELINE_PATH = 'packages/herdr/src/downtime-worker.split-baseline.json';

/** Per-module line ceiling (parent AC1). */
export const MAX_MODULE_LINES = 1000;

/**
 * Files that are currently exempt from the size gate.
 *
 * This is a *shrink-only* allowlist: it may only ever lose entries, never gain
 * them. The final barrel child (WL-0MVLII2OY004S3BN) emptied it once the
 * monolith was fully decomposed, so every `downtime-worker*.ts` production
 * module — the barrel included — is now held to {@link MAX_MODULE_LINES}.
 */
export const SPLIT_ALLOWLIST: readonly string[] = [];

/**
 * The allowlist as it stood at plan time. {@link SPLIT_ALLOWLIST} must remain a
 * subset of this, which makes "grows back into a collection of oversized
 * modules" a test failure rather than a review finding.
 */
export const SPLIT_ALLOWLIST_CEILING: readonly string[] = ['downtime-worker.ts'];

/**
 * Pre-existing import cycles that involve a split-family module, recorded at
 * guard-creation time. Members are repository-relative paths.
 *
 * Recorded reality (2026-10-24, `dev` @ guard creation): the static import
 * graph already contains one large component that reaches the barrel through a
 * mix of value and type-only edges — `downtime-worker.ts` imports values from
 * `stalled-work.ts`, `settings.ts`, `fetcher.ts`, `worklist.ts`,
 * `long-running-panes.ts` and `ship-guard.ts` import values back from the
 * barrel, and their own type imports close the loop. That component is
 * pre-existing and out of scope for this refactor; what the gate forbids is
 * *new* cycle members or *new* runtime cycles (AC5).
 */
export const CYCLE_BASELINE: readonly (readonly string[])[] = [
  [
    'packages/herdr/src/agent-tracker.ts',
    'packages/herdr/src/code-freeze.ts',
    'packages/herdr/src/dispatch-view.ts',
    'packages/herdr/src/downtime-worker.ts',
    'packages/herdr/src/fetcher.ts',
    'packages/herdr/src/hydrator.ts',
    'packages/herdr/src/long-running-panes.ts',
    'packages/herdr/src/md-note-edit.ts',
    'packages/herdr/src/settings.ts',
    'packages/herdr/src/ship-guard.ts',
    'packages/herdr/src/smart-selection.ts',
    'packages/herdr/src/stalled-work.ts',
    'packages/herdr/src/visibility.ts',
    'packages/herdr/src/worklist.ts',
  ],
];

/**
 * Directed edges of the baselined cycle that are allowed to exist **only** as
 * type imports. If this becomes a runtime (value) edge together with its
 * return path, the module graph has a genuine runtime cycle — the split's
 * fail mode.
 */
export const CYCLE_BASELINE_TYPE_ONLY_EDGES: readonly { from: string; to: string }[] = [
  { from: BARREL, to: 'packages/herdr/src/stalled-work.ts' },
];

/** Source roots scanned for consumers and for the module graph. */
export const SCAN_ROOTS: readonly string[] = ['src', 'packages/herdr/src'];

/**
 * Every root scanned for barrel CONSUMERS.
 *
 * The repository also imports the barrel from the root `tests/` tree and from
 * `scripts/`. Those imports are part of the public-surface contract — the root
 * `tests/unit/downtime-worker-*.test.ts` suites are behaviour gates — so
 * leaving them out let a dropped export (`isSoftDeleted`) pass this guard and
 * fail only the full suite (WL-0MVLII2OY004S3BN). Test/fixture files are still
 * excluded from the module-graph gates by `productionModules`, and the split
 * family is still limited to `packages/herdr/src`, so widening the scan here
 * only affects consumer discovery.
 */
export const CONSUMER_ROOTS: readonly string[] = [...SCAN_ROOTS, 'tests', 'scripts'];

/** Generation command recorded in the baseline provenance (AC10). */
export const BASELINE_COMMAND =
  'npx tsx packages/herdr/test/split-guard/scan.ts --write-baseline';

/**
 * Every family-specific input a split guard needs.
 *
 * Predicates take one of these as their last argument and default to
 * {@link DOWNTIME_CONFIG}; a new guard supplies its own (see
 * `worklist-family.ts`). Keeping the family's shape in data rather than in
 * `if` branches is what lets one scanner serve several refactor epics without
 * forking the gate logic.
 */
export interface SplitFamilyConfig {
  /** Repository-relative path of the barrel every consumer imports. */
  readonly barrel: string;
  /** Directory the split's modules live in. */
  readonly familyDir: string;
  /** Filename predicate selecting the family's modules (test files included). */
  readonly familyPattern: RegExp;
  /** Repository-relative path of the committed consumer-symbol baseline. */
  readonly baselinePath: string;
  /** Files currently exempt from the size gate (shrink-only). */
  readonly allowlist: readonly string[];
  /** The allowlist as recorded at plan time (the shrink-only ceiling). */
  readonly allowlistCeiling: readonly string[];
  /** Recorded pre-existing import cycles the family participates in. */
  readonly cycleBaseline: readonly (readonly string[])[];
  /** Recorded edges of those cycles that must stay type-only. */
  readonly typeOnlyEdges: readonly { readonly from: string; readonly to: string }[];
  /** Recorded pre-existing **runtime** (value-only) cycles. */
  readonly runtimeCycleBaseline: readonly (readonly string[])[];
  /** Module-scope declaration that must live in exactly one family module. */
  readonly singleOwnerDeclaration: string;
  /** Generation command recorded in the baseline provenance. */
  readonly baselineCommand: string;
  /** Roots scanned for barrel consumers. */
  readonly consumerRoots: readonly string[];
}

/**
 * Defaults preserved byte-for-byte from the original downtime guard, so
 * `downtime-worker.split-guard.test.ts` and `index-family.ts` keep working
 * untouched.
 */
export const DOWNTIME_CONFIG: SplitFamilyConfig = {
  barrel: BARREL,
  familyDir: SPLIT_FAMILY_DIR,
  familyPattern: /^downtime-worker[^/]*\.ts$/,
  baselinePath: BASELINE_PATH,
  allowlist: SPLIT_ALLOWLIST,
  allowlistCeiling: SPLIT_ALLOWLIST_CEILING,
  cycleBaseline: CYCLE_BASELINE,
  typeOnlyEdges: CYCLE_BASELINE_TYPE_ONLY_EDGES,
  runtimeCycleBaseline: [],
  singleOwnerDeclaration: 'dispatchInFlightCount',
  baselineCommand: BASELINE_COMMAND,
  consumerRoots: CONSUMER_ROOTS,
};

// ── Parsed-module model ───────────────────────────────────────────────

export interface ParsedImportName {
  /** The imported (exported-by-target) name, not the local alias. */
  name: string;
  typeOnly: boolean;
}

export interface ParsedImport {
  specifier: string;
  /** Whole-clause `import type { … }`. */
  typeOnly: boolean;
  hasDefault: boolean;
  namespace: boolean;
  names: ParsedImportName[];
}

export interface ParsedReexport {
  specifier: string;
  /** `export * from '…'` */
  all: boolean;
  typeOnly: boolean;
  /** Exported names for `export { a as b } from '…'`. */
  names: string[];
}

export interface ParsedModule {
  /** Repository-relative POSIX path, e.g. `packages/herdr/src/downtime-worker.ts`. */
  file: string;
  /** `wc -l` semantics: the number of newline characters. */
  lineCount: number;
  /** Names this module exports (declarations plus explicit re-export names). */
  exportedNames: string[];
  reexports: ParsedReexport[];
  imports: ParsedImport[];
  /**
   * Every name declared at module scope (variables, functions, classes,
   * interfaces, type aliases, enums, modules), with its declaration count.
   * Backs the generic single-owner gate (e.g. `WorkItemListState`).
   */
  declarations: Map<string, number>;
  /** Module-scope `let`/`const`/`var dispatchInFlightCount` declarations. */
  dispatchInFlightDeclarations: number;
}

export interface ModuleIndex {
  repoRoot: string;
  /** Repository-relative POSIX path → parsed module. */
  byFile: Map<string, ParsedModule>;
}

export interface SplitBaseline {
  provenance: {
    generatedBy: string;
    sourceCommit: string;
    generatedAt: string;
    barrel: string;
    consumerGlobs: string[];
  };
  symbols: string[];
}

// ── Parsing ───────────────────────────────────────────────────────────

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

function declarationName(node: ts.Node): string | null {
  const name = (node as { name?: ts.Node }).name;
  return name && ts.isIdentifier(name) ? name.text : null;
}

/** Every module-scope name a statement declares (variables, functions, types, …). */
function declarationNames(stmt: ts.Statement): string[] {
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations
      .map((decl) => (ts.isIdentifier(decl.name) ? decl.name.text : null))
      .filter((name): name is string => name !== null);
  }
  if (DECLARATION_KINDS.has(stmt.kind)) {
    const name = declarationName(stmt);
    return name ? [name] : [];
  }
  return [];
}

const DECLARATION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
]);

/**
 * Parse one module's source into the model the gates consume.
 *
 * Pure: `file` is used only for labelling and relative-specifier resolution, so
 * synthetic in-memory modules are parsed exactly like real ones (AC7).
 */
export function parseModuleSource(file: string, source: string): ParsedModule {
  const parsed: ParsedModule = {
    file,
    lineCount: (source.match(/\n/g) ?? []).length,
    exportedNames: [],
    reexports: [],
    imports: [],
    declarations: new Map(),
    dispatchInFlightDeclarations: 0,
  };

  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

  // `import('./downtime-worker.js').Foo` type positions are consumer usages too.
  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      const specifier =
        ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal) ? arg.literal.text : null;
      if (specifier) {
        const names: ParsedImportName[] = [];
        const qualifier = node.qualifier;
        if (qualifier) {
          const text = ts.isQualifiedName(qualifier) ? qualifier.right.text : qualifier.text;
          names.push({ name: text, typeOnly: true });
        }
        parsed.imports.push({
          specifier,
          typeOnly: true,
          hasDefault: false,
          namespace: false,
          names,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (!clause || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const names: ParsedImportName[] = [];
      let namespace = false;
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          namespace = true;
        } else {
          for (const el of clause.namedBindings.elements) {
            const imported = el.propertyName ?? el.name;
            names.push({ name: imported.text, typeOnly: el.isTypeOnly });
          }
        }
      }
      parsed.imports.push({
        specifier: stmt.moduleSpecifier.text,
        typeOnly: clause.isTypeOnly,
        hasDefault: Boolean(clause.name),
        namespace,
        names,
      });
      continue;
    }

    if (ts.isExportDeclaration(stmt)) {
      const specifier =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : null;
      const names: string[] = [];
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) names.push(el.name.text);
      } else if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        names.push(stmt.exportClause.name.text);
      }
      parsed.exportedNames.push(...names);
      if (specifier) {
        parsed.reexports.push({
          specifier,
          all: !stmt.exportClause,
          typeOnly: stmt.isTypeOnly,
          names,
        });
      }
      continue;
    }

    if (ts.isExportAssignment(stmt)) {
      parsed.exportedNames.push('default');
      continue;
    }

    // Record module-scope declarations (exported or not) for the generic
    // single-owner gate. Imports/exports have already been handled above.
    for (const name of declarationNames(stmt)) {
      parsed.declarations.set(name, (parsed.declarations.get(name) ?? 0) + 1);
    }

    if (!hasExportModifier(stmt)) continue;
    if (hasDefaultModifier(stmt)) parsed.exportedNames.push('default');

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) parsed.exportedNames.push(decl.name.text);
      }
      continue;
    }

    if (DECLARATION_KINDS.has(stmt.kind)) {
      const name = declarationName(stmt);
      if (name) parsed.exportedNames.push(name);
    }
  }

  // Module-scope `dispatchInFlightCount` declarations, exported or not.
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === 'dispatchInFlightCount') {
        parsed.dispatchInFlightDeclarations += 1;
      }
    }
  }

  return parsed;
}

// ── Loading ───────────────────────────────────────────────────────────

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, found);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Parse every `.ts` file under `roots` (default {@link CONSUMER_ROOTS}). */
export function loadModuleIndex(
  repoRoot: string,
  roots: readonly string[] = CONSUMER_ROOTS,
): ModuleIndex {
  const byFile = new Map<string, ParsedModule>();
  const files = roots.flatMap((root) => collectSourceFiles(path.join(repoRoot, root)));
  for (const abs of files) {
    const rel = toPosix(path.relative(repoRoot, abs));
    byFile.set(rel, parseModuleSource(rel, fs.readFileSync(abs, 'utf-8')));
  }
  return { repoRoot, byFile };
}

/**
 * Every scanned consumer source, keyed by repository-relative POSIX path.
 *
 * The dynamic-import scanner needs the raw text (it walks parent pointers), so
 * it cannot reuse the lighter {@link ParsedModule} model.
 */
export function loadConsumerSources(
  repoRoot: string,
  roots: readonly string[] = CONSUMER_ROOTS,
): Map<string, string> {
  const sources = new Map<string, string>();
  for (const root of roots) {
    for (const abs of collectSourceFiles(path.join(repoRoot, root))) {
      sources.set(toPosix(path.relative(repoRoot, abs)), fs.readFileSync(abs, 'utf-8'));
    }
  }
  return sources;
}

/** Index built from in-memory sources — used by the negative-case tests. */
export function indexFromSources(sources: Record<string, string>): ModuleIndex {
  const byFile = new Map<string, ParsedModule>();
  for (const [file, source] of Object.entries(sources)) {
    byFile.set(file, parseModuleSource(file, source));
  }
  return { repoRoot: '', byFile };
}

export function basename(file: string): string {
  return path.posix.basename(file);
}

export function isTestOrFixture(file: string): boolean {
  const base = basename(file);
  return base.endsWith('.test.ts') || base.endsWith('.fixtures.ts');
}

/** Every module that is not a test or fixture (the code the split ships). */
export function productionModules(index: ModuleIndex): ParsedModule[] {
  return [...index.byFile.values()].filter((m) => !isTestOrFixture(m.file));
}

/** True for a module in the configured split family (e.g. `downtime-worker*.ts`). */
export function isSplitFamilyFile(
  file: string,
  config: SplitFamilyConfig = DOWNTIME_CONFIG,
): boolean {
  return path.posix.dirname(file) === config.familyDir && config.familyPattern.test(basename(file));
}

/** Production modules of the configured family. */
export function splitFamilyModules(
  index: ModuleIndex,
  config: SplitFamilyConfig = DOWNTIME_CONFIG,
): ParsedModule[] {
  return productionModules(index).filter((m) => isSplitFamilyFile(m.file, config));
}

/** Resolve a relative import/export specifier to an indexed module file. */
export function resolveImportTarget(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const withoutExt = specifier.replace(/\.(js|mjs|cjs)$/, '.ts');
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), withoutExt));
}

/** True when every imported part of an import is type-only. */
export function isTypeOnlyImport(imp: ParsedImport): boolean {
  if (imp.typeOnly) return true;
  if (imp.hasDefault || imp.namespace) return false;
  return !imp.names.some((n) => !n.typeOnly);
}

// ── Gate 1: public surface ────────────────────────────────────────────

/**
 * Resolve the names exported by `entry`, following `export … from` chains
 * transitively (the post-split barrel is a chain of `export * from '…'`).
 */
export function collectExportedNames(
  index: ModuleIndex,
  entry: string,
  seen: Set<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  if (seen.has(entry)) return out;
  seen.add(entry);
  const mod = index.byFile.get(entry);
  if (!mod) return out;
  for (const name of mod.exportedNames) out.add(name);
  for (const re of mod.reexports) {
    if (!re.all) continue;
    const target = resolveImportTarget(mod.file, re.specifier);
    if (!target) continue;
    for (const name of collectExportedNames(index, target, seen)) out.add(name);
  }
  return out;
}

/** Expected symbols that are no longer exported by the barrel. */
export function findMissingExports(
  expected: Iterable<string>,
  exported: Set<string>,
): string[] {
  return [...new Set(expected)].filter((name) => !exported.has(name)).sort();
}

/**
 * Symbols a live consumer imports that the barrel does not export.
 *
 * `knownMissing` records pre-existing gaps (shrink-only): the guard fails on a
 * *new* consumer import the barrel never provided, but does not demand the
 * repository first fix an inconsistency that predates the split.
 */
export function findUnexportedConsumerImports(
  index: ModuleIndex,
  barrel: string = BARREL,
  knownMissing: readonly string[] = [],
): string[] {
  const exported = collectExportedNames(index, barrel);
  const known = new Set(knownMissing);
  return findMissingExports(consumerImportNames(index, barrel).keys(), exported).filter(
    (name) => !known.has(name),
  );
}

/**
 * All symbols any consumer imports from the barrel, mapped to how they are
 * used. Covers named imports, whole-clause type imports, per-specifier `type`
 * prefixes and `import('./downtime-worker.js').X` type positions.
 */
export function consumerImportNames(
  index: ModuleIndex,
  barrel: string = BARREL,
): Map<string, { value: boolean; typeOnly: boolean }> {
  const usage = new Map<string, { value: boolean; typeOnly: boolean }>();
  for (const mod of index.byFile.values()) {
    if (mod.file === barrel) continue;
    for (const imp of mod.imports) {
      if (resolveImportTarget(mod.file, imp.specifier) !== barrel) continue;
      const clauseTypeOnly = isTypeOnlyImport(imp);
      for (const n of imp.names) {
        const prev = usage.get(n.name) ?? { value: false, typeOnly: false };
        if (clauseTypeOnly || n.typeOnly) prev.typeOnly = true;
        else prev.value = true;
        usage.set(n.name, prev);
      }
    }
  }
  return usage;
}

// ── Gate 2: single-owner state ────────────────────────────────────────

/** Modules declaring a module-scope `name`, with per-module counts. */
export function findDeclarationModules(
  modules: readonly ParsedModule[],
  name: string,
): { file: string; count: number }[] {
  return modules
    .filter((m) => (m.declarations.get(name) ?? 0) > 0)
    .map((m) => ({ file: m.file, count: m.declarations.get(name)! }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Total module-scope `name` declarations across `modules`. */
export function countDeclarations(modules: readonly ParsedModule[], name: string): number {
  return modules.reduce((total, m) => total + (m.declarations.get(name) ?? 0), 0);
}

/** Modules declaring the downtime guard's single-flight counter, with counts. */
export function findDispatchInFlightDeclarations(
  modules: readonly ParsedModule[],
): { file: string; count: number }[] {
  return findDeclarationModules(modules, 'dispatchInFlightCount');
}

/** Total module-scope `dispatchInFlightCount` declarations across `modules`. */
export function countDispatchInFlightDeclarations(modules: readonly ParsedModule[]): number {
  return countDeclarations(modules, 'dispatchInFlightCount');
}

// ── Gate 3: barrel imports and cycles ─────────────────────────────────

/** Split-family modules that import the barrel with runtime (value) semantics. */
export function findBarrelValueImports(
  index: ModuleIndex,
  config: SplitFamilyConfig = DOWNTIME_CONFIG,
): { file: string; specifier: string }[] {
  const violations: { file: string; specifier: string }[] = [];
  for (const mod of splitFamilyModules(index, config)) {
    if (mod.file === config.barrel) continue;
    for (const imp of mod.imports) {
      if (resolveImportTarget(mod.file, imp.specifier) !== config.barrel) continue;
      if (!isTypeOnlyImport(imp)) {
        violations.push({ file: mod.file, specifier: imp.specifier });
      }
    }
  }
  return violations;
}

export interface GraphEdge {
  to: string;
  typeOnly: boolean;
}

/**
 * Static import graph over production modules, including re-export edges
 * (`export * from` is treated as runtime — it may re-export values).
 */
export function buildImportGraph(index: ModuleIndex): Map<string, GraphEdge[]> {
  const graph = new Map<string, GraphEdge[]>();
  for (const mod of productionModules(index)) {
    const edges: GraphEdge[] = [];
    const push = (target: string | null, typeOnly: boolean): void => {
      if (target && index.byFile.has(target) && target !== mod.file) {
        const existing = edges.find((e) => e.to === target);
        if (existing) existing.typeOnly = existing.typeOnly && typeOnly;
        else edges.push({ to: target, typeOnly });
      }
    };
    for (const imp of mod.imports) {
      push(resolveImportTarget(mod.file, imp.specifier), isTypeOnlyImport(imp));
    }
    for (const re of mod.reexports) {
      push(resolveImportTarget(mod.file, re.specifier), re.typeOnly);
    }
    graph.set(mod.file, edges);
  }
  return graph;
}

/** Strongly connected components of a module graph (iterative Tarjan). */
export function findStronglyConnectedComponents(graph: Map<string, GraphEdge[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    // Iterative DFS so a large graph cannot blow the stack.
    const work: { node: string; edge: number }[] = [{ node: start, edge: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const edges = graph.get(frame.node) ?? [];
      if (frame.edge < edges.length) {
        const next = edges[frame.edge].to;
        frame.edge += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edge: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component.sort());
      }
    }
  }

  return components;
}

function cycleComponents(
  graph: Map<string, GraphEdge[]>,
  config: SplitFamilyConfig,
): string[][] {
  return findStronglyConnectedComponents(graph).filter(
    (component) =>
      component.length > 1 && component.some((file) => isSplitFamilyFile(file, config)),
  );
}

/** Cyclic components of the full (value + type) static import graph. */
export function findSplitFamilyCycles(
  index: ModuleIndex,
  config: SplitFamilyConfig = DOWNTIME_CONFIG,
): string[][] {
  return cycleComponents(buildImportGraph(index), config);
}

/**
 * Cyclic components of the **runtime** import graph (type-only edges removed).
 *
 * These are the cycles that exist in the emitted JavaScript. The split must not
 * introduce one (AC4/AC5); compare the result against
 * `config.runtimeCycleBaseline` with {@link findCycleBaselineViolations}.
 */
export function findRuntimeCycles(
  index: ModuleIndex,
  config: SplitFamilyConfig = DOWNTIME_CONFIG,
): string[][] {
  const runtime = new Map<string, GraphEdge[]>();
  for (const [file, edges] of buildImportGraph(index)) {
    runtime.set(file, edges.filter((e) => !e.typeOnly));
  }
  return cycleComponents(runtime, config);
}

/**
 * Cycles that fall outside {@link CYCLE_BASELINE}: a component with no
 * baseline entry that contains it (a new cycle), or a component that grew a
 * member the baseline did not record. Shrinking is allowed.
 */
export function findCycleBaselineViolations(
  cycles: readonly (readonly string[])[],
  baseline: readonly (readonly string[])[] = CYCLE_BASELINE,
): string[][] {
  const violations: string[][] = [];
  for (const cycle of cycles) {
    const contained = baseline.some((entry) => {
      const members = new Set(entry);
      return cycle.every((file) => members.has(file));
    });
    if (!contained) violations.push([...cycle].sort());
  }
  return violations;
}

/**
 * Baselined type-only edges that no longer exist in the import graph.
 *
 * Without this check the type-only invariant would be vacuously satisfiable by
 * deleting the import entirely, which would silently drop a dependency the
 * split is supposed to preserve.
 */
export function findAbsentBaselineEdges(
  index: ModuleIndex,
  required: readonly { from: string; to: string }[] = CYCLE_BASELINE_TYPE_ONLY_EDGES,
): { from: string; to: string }[] {
  const graph = buildImportGraph(index);
  return required.filter((req) => !(graph.get(req.from) ?? []).some((e) => e.to === req.to));
}

/**
 * Baselined type-only edges that are now runtime edges. Each entry names the
 * pre-existing cycle direction that must never carry a value import.
 */
export function findWidenedBaselineEdges(
  index: ModuleIndex,
  required: readonly { from: string; to: string }[] = CYCLE_BASELINE_TYPE_ONLY_EDGES,
): { from: string; to: string }[] {
  const graph = buildImportGraph(index);
  const violations: { from: string; to: string }[] = [];
  for (const req of required) {
    const edge = (graph.get(req.from) ?? []).find((e) => e.to === req.to);
    if (!edge) continue; // the cycle no longer exists — nothing to widen
    if (!edge.typeOnly) violations.push(req);
  }
  return violations;
}

// ── Gate 4: module size and shrink-only allowlist ─────────────────────

/** Split-family modules exceeding `max` lines and not allowlisted. */
export function findOversizedModules(
  modules: readonly ParsedModule[],
  allowlist: readonly string[] = SPLIT_ALLOWLIST,
  max: number = MAX_MODULE_LINES,
): { file: string; lineCount: number }[] {
  const allowed = new Set(allowlist);
  return modules
    .filter((m) => !allowed.has(basename(m.file)))
    .filter((m) => m.lineCount > max)
    .map((m) => ({ file: m.file, lineCount: m.lineCount }));
}

/** Allowlist entries that are not in the shrink-only ceiling (or repeated). */
export function findAllowlistViolations(
  allowlist: readonly string[],
  ceiling: readonly string[] = SPLIT_ALLOWLIST_CEILING,
): string[] {
  const allowed = new Set(ceiling);
  const violations = allowlist.filter((entry) => !allowed.has(entry));
  const duplicates = allowlist.filter((entry, i) => allowlist.indexOf(entry) !== i);
  return [...new Set([...violations, ...duplicates])].sort();
}

// ── Baseline ──────────────────────────────────────────────────────────

/** Build the baseline payload from the live tree. */
export function buildBaseline(
  repoRoot: string,
  config: SplitFamilyConfig = DOWNTIME_CONFIG,
): SplitBaseline {
  const index = loadModuleIndex(repoRoot, config.consumerRoots);
  const symbols = [...consumerImportNames(index, config.barrel).keys()].sort();
  return {
    provenance: {
      generatedBy: config.baselineCommand,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      generatedAt: new Date().toISOString(),
      barrel: config.barrel,
      consumerGlobs: config.consumerRoots.map((root) => `${root}/**/*.ts`),
    },
    symbols,
  };
}

/** Read + parse a committed baseline (`config.baselinePath` by default). */
export function readBaseline(
  repoRoot: string,
  config: SplitFamilyConfig = DOWNTIME_CONFIG,
): SplitBaseline {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, config.baselinePath), 'utf-8'),
  ) as SplitBaseline;
}

/** Write a baseline to `config.baselinePath`; returns the payload written. */
export function writeBaseline(
  repoRoot: string,
  config: SplitFamilyConfig = DOWNTIME_CONFIG,
): SplitBaseline {
  const baseline = buildBaseline(repoRoot, config);
  fs.writeFileSync(
    path.join(repoRoot, config.baselinePath),
    `${JSON.stringify({ version: 1, ...baseline }, null, 2)}\n`,
    'utf-8',
  );
  return baseline;
}

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
    console.error(`usage: ${BASELINE_COMMAND}`);
    process.exit(2);
  }
  const baseline = writeBaseline(repoRoot);
  console.log(
    `wrote ${BASELINE_PATH}: ${baseline.symbols.length} symbols @ ${baseline.provenance.sourceCommit.slice(0, 8)}`,
  );
}
