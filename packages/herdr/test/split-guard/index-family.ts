/**
 * packages/herdr/test/split-guard/index-family.ts — config, scanners and
 * baseline producer for the `packages/herdr/src/index.ts` split guard.
 *
 * Parent: WL-0MVGKGFFN009UCM6 (decompose the `index.ts` god module).
 * Guard item: WL-0MVOA0FN3000ND4J (this file's owning work item).
 *
 * ## Why this module exists
 *
 * The parent epic moves ~2,940 lines out of `packages/herdr/src/index.ts`
 * across eleven extraction children without touching a single test file. The
 * behaviour gate is the unchanged suite; nothing in the repository enforces
 * the *structural* half of the contract. This module supplies the predicates
 * and the frozen baseline those gates need.
 *
 * It deliberately **reuses** the generic predicates exported by the sibling
 * `scan.ts` (`loadModuleIndex`, `consumerImportNames`, `findMissingExports`,
 * `resolveImportTarget`, `isTypeOnlyImport`, `findCycleBaselineViolations`,
 * `findOversizedModules`, `findAllowlistViolations`, …) and never edits it —
 * plan decision Q2 → A. Only the two index-specific gaps live here:
 *
 * 1. **barrel-value-import scan** — `scan.ts`'s version is hard-wired to the
 *    `downtime-worker` family, so the index family needs its own thin loop.
 * 2. **single-callsite scan** — the index barrel's single module-level side
 *    effect is a *call* (`const settings = loadSettings()`), which
 *    `scan.ts`'s `dispatchInFlightCount` declaration counter cannot express.
 *    This module parses module-scope calls and shared-constant declarations
 *    with the TypeScript parser (syntax only — no program, no type checker).
 *
 * It also augments consumer discovery with **dynamic** `import('./index.js')`
 * usage, which `scan.ts`'s `consumerImportNames` does not model: six of the
 * intake Appendix's 26 consumed symbols are reached only through dynamic
 * imports in `index.test.ts`, so a static-only baseline would under-freeze
 * the public surface.
 *
 * ## Baseline generation (provenance)
 *
 *   npx tsx packages/herdr/test/split-guard/index-family.ts --write-baseline
 *
 * writes `packages/herdr/src/index.split-baseline.json` with the sorted,
 * deduplicated set of symbols consumers reach through the barrel, the
 * recorded pre-existing cross-module cycle, and provenance (generation
 * command, source commit, timestamp, scanned globs). Re-run it only when the
 * consumer surface is *deliberately* changed; the committed file is the
 * frozen contract the public-surface gate enforces.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  CYCLE_BASELINE,
  CYCLE_BASELINE_TYPE_ONLY_EDGES,
  CONSUMER_ROOTS,
  MAX_MODULE_LINES,
  basename,
  buildImportGraph,
  collectExportedNames,
  consumerImportNames,
  findAbsentBaselineEdges,
  findAllowlistViolations,
  findCycleBaselineViolations,
  findMissingExports,
  findOversizedModules,
  findWidenedBaselineEdges,
  indexFromSources,
  isTestOrFixture,
  isTypeOnlyImport,
  loadModuleIndex,
  productionModules,
  resolveImportTarget,
  findStronglyConnectedComponents,
  type ModuleIndex,
  type ParsedModule,
} from './scan.js';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every index consumer imports. */
export const INDEX_BARREL = 'packages/herdr/src/index.ts';

/** Directory the split's modules live in. */
export const INDEX_FAMILY_DIR = 'packages/herdr/src';

/**
 * An index-family file: `index.ts` plus any `index.<slice>.ts` extracted
 * module. Test/fixture files (`index.split-guard.test.ts`, …) are excluded by
 * the family scanner but are still scanned as *consumers*.
 */
export const INDEX_FAMILY_PATTERN = /^index(\.[\w-]+)?\.ts$/;

/** Repository-relative path of the committed consumer-symbol baseline. */
export const INDEX_BASELINE_PATH = 'packages/herdr/src/index.split-baseline.json';

/** Per-module line ceiling (parent AC1). Re-exported from `scan.ts`. */
export { MAX_MODULE_LINES };

/**
 * Files currently exempt from the size gate.
 *
 * This is a *shrink-only* allowlist: it may only ever lose entries, never gain
 * them. `index.ts` is the not-yet-split monolith; the final barrel child
 * (phase 12) empties the list once the split is complete.
 */
export const INDEX_SPLIT_ALLOWLIST: readonly string[] = ['index.ts'];

/**
 * The allowlist as it stood at plan time. {@link INDEX_SPLIT_ALLOWLIST} must
 * remain a subset of this, which makes "grows back into a collection of
 * oversized modules" a test failure rather than a review finding.
 */
export const INDEX_SPLIT_ALLOWLIST_CEILING: readonly string[] = ['index.ts'];

/**
 * Pre-existing import cycles recorded at guard-creation time.
 *
 * There is currently no cycle that contains an `index*.ts` production module,
 * so the index-family cycle gate starts from the recorded repository reality:
 * the pre-existing `downtime-worker` component. A cycle among index-family
 * modules is therefore automatically a violation (AC6 layering gate).
 */
export const INDEX_CYCLE_BASELINE: readonly (readonly string[])[] = CYCLE_BASELINE;

/**
 * Directed edges of the recorded cycle that must stay **type-only**. This is
 * the existing `stalled-work ↔ downtime-worker` cycle; the guard records it so
 * an extraction cannot widen it into a runtime cycle (parent AC6).
 */
export const INDEX_TYPE_ONLY_EDGES: readonly { from: string; to: string }[] =
  CYCLE_BASELINE_TYPE_ONLY_EDGES;

/**
 * Callees that must run as a module-scope side effect in exactly one
 * index-family production module. `const settings = loadSettings()` is the
 * parent AC5 single-settings instance; duplicating it into two extracted
 * modules would load settings twice with potentially different results.
 */
export const SINGLE_CALLSITE_CALLEES: readonly string[] = ['loadSettings'];

/**
 * Shared constants that must each be declared in exactly one index-family
 * production module. `SEND_TO_PI_SCRIPT` / `RUN_IN_PANE_SCRIPT` resolve
 * relative to `import.meta.url` and therefore depend on staying in one place;
 * a `CONFIGURED_WORKLOG_TARGET`-style constant gets the same single-declaration
 * treatment via {@link SHARED_CONSTANT_PATTERN}.
 */
export const SINGLE_DECLARATION_NAMES: readonly string[] = [
  'SEND_TO_PI_SCRIPT',
  'RUN_IN_PANE_SCRIPT',
];

/**
 * Upper-snake-case module-scope constant names are treated as shared
 * constants: duplicating one across two index-family modules is a violation
 * even when it is not listed in {@link SINGLE_DECLARATION_NAMES}. This is the
 * `CONFIGURED_WORKLOG_TARGET`-style half of the single-side-effect gate.
 */
export const SHARED_CONSTANT_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Entry guard that must stay declared in the barrel itself (parent AC3). */
export const ENTRY_GUARD_NAME = 'isEntryPoint';

/** Generation command recorded in the baseline provenance. */
export const INDEX_BASELINE_COMMAND =
  'npx tsx packages/herdr/test/split-guard/index-family.ts --write-baseline';

// ── Family selection ──────────────────────────────────────────────────

/** True for `packages/herdr/src/index*.ts` (the split's own family). */
export function isIndexFamilyFile(file: string): boolean {
  return (
    path.posix.dirname(file) === INDEX_FAMILY_DIR &&
    INDEX_FAMILY_PATTERN.test(basename(file))
  );
}

/** Production `index*.ts` modules (tests/fixtures excluded). */
export function indexFamilyModules(index: ModuleIndex): ParsedModule[] {
  return productionModules(index).filter((m) => isIndexFamilyFile(m.file));
}

export { indexFromSources, collectExportedNames, findMissingExports, loadModuleIndex };

// ── Module-scope facts (single-side-effect gates) ─────────────────────

export interface IndexModuleFacts {
  /** Repository-relative POSIX path. */
  file: string;
  /** Module-scope call expressions, by callee identifier. */
  moduleScopeCalls: Map<string, number>;
  /** Every name declared at module scope (variables, functions, types, …). */
  moduleScopeDeclarations: Set<string>;
  /** Module-scope `const`/`let`/`var` identifiers, by declaration count. */
  moduleScopeConstants: Map<string, number>;
}

const FUNCTION_LIKE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
]);

interface NamedNode extends ts.Node {
  name?: ts.Node;
}

function declarationName(node: ts.Node): string | null {
  const name = (node as NamedNode).name;
  return name && ts.isIdentifier(name) ? name.text : null;
}

/**
 * Collect call expressions that execute at module load.
 *
 * Descends through blocks, `if`/`for` statements and expression initialisers,
 * but stops at function-like boundaries: a call inside an arrow/function body
 * runs later, not when the module is evaluated, so it is not a module-scope
 * side effect.
 */
function collectModuleScopeCalls(node: ts.Node, counts: Map<string, number>): void {
  if (FUNCTION_LIKE.has(node.kind)) return;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    counts.set(node.expression.text, (counts.get(node.expression.text) ?? 0) + 1);
  }
  ts.forEachChild(node, (child) => collectModuleScopeCalls(child, counts));
}

/**
 * Parse one module's module-scope facts.
 *
 * Pure: `file` is used only for labelling, so synthetic in-memory modules are
 * parsed exactly like real ones (negative-case tests).
 */
export function parseIndexModuleFacts(file: string, source: string): IndexModuleFacts {
  const facts: IndexModuleFacts = {
    file,
    moduleScopeCalls: new Map(),
    moduleScopeDeclarations: new Set(),
    moduleScopeConstants: new Map(),
  };
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          facts.moduleScopeDeclarations.add(decl.name.text);
          facts.moduleScopeConstants.set(
            decl.name.text,
            (facts.moduleScopeConstants.get(decl.name.text) ?? 0) + 1,
          );
        }
        if (decl.initializer) collectModuleScopeCalls(decl.initializer, facts.moduleScopeCalls);
      }
      continue;
    }

    const name = declarationName(stmt);
    if (name) facts.moduleScopeDeclarations.add(name);

    // Function/class/type declarations are not evaluated at load; other
    // statements (expression, if, for, try, …) are.
    if (!FUNCTION_LIKE.has(stmt.kind)) {
      collectModuleScopeCalls(stmt, facts.moduleScopeCalls);
    }
  }

  return facts;
}

/** Module-scope call sites of `callee`, per declaring module. */
export function findModuleScopeCalls(
  facts: readonly IndexModuleFacts[],
  callee: string,
): { file: string; count: number }[] {
  return facts
    .filter((f) => (f.moduleScopeCalls.get(callee) ?? 0) > 0)
    .map((f) => ({ file: f.file, count: f.moduleScopeCalls.get(callee)! }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Total module-scope calls of `callee` across `facts`. */
export function countModuleScopeCalls(facts: readonly IndexModuleFacts[], callee: string): number {
  return findModuleScopeCalls(facts, callee).reduce((total, f) => total + f.count, 0);
}

/**
 * Callees that are not called exactly once, in exactly one module.
 *
 * Both the module count and the total call count must be 1: two top-level
 * `loadSettings()` calls in the *same* module still evaluate settings twice.
 */
export function findSingleCallsiteViolations(
  facts: readonly IndexModuleFacts[],
  callees: readonly string[] = SINGLE_CALLSITE_CALLEES,
): { callee: string; files: string[]; total: number }[] {
  return callees
    .map((callee) => {
      const sites = findModuleScopeCalls(facts, callee);
      return {
        callee,
        files: sites.map((s) => s.file),
        total: sites.reduce((total, s) => total + s.count, 0),
      };
    })
    .filter((v) => v.files.length !== 1 || v.total !== 1);
}

/** Modules declaring a module-scope constant `name`. */
export function findConstantDeclarationModules(
  facts: readonly IndexModuleFacts[],
  name: string,
): string[] {
  return facts
    .filter((f) => f.moduleScopeConstants.has(name))
    .map((f) => f.file)
    .sort();
}

/** Required shared constants that are not declared in exactly one module. */
export function findSingleDeclarationViolations(
  facts: readonly IndexModuleFacts[],
  names: readonly string[] = SINGLE_DECLARATION_NAMES,
): { name: string; files: string[] }[] {
  return names
    .map((name) => ({ name, files: findConstantDeclarationModules(facts, name) }))
    .filter((v) => v.files.length !== 1);
}

/**
 * Shared (`UPPER_SNAKE_CASE`) constants declared in more than one module.
 *
 * This is the generic half of the single-declaration gate: it catches a
 * `CONFIGURED_WORKLOG_TARGET`-style constant duplicated by an extraction even
 * when nobody remembered to add it to {@link SINGLE_DECLARATION_NAMES}.
 */
export function findDuplicateConstantDeclarations(
  facts: readonly IndexModuleFacts[],
): { name: string; files: string[] }[] {
  const byName = new Map<string, string[]>();
  for (const f of facts) {
    for (const name of f.moduleScopeConstants.keys()) {
      if (!SHARED_CONSTANT_PATTERN.test(name) && !SINGLE_DECLARATION_NAMES.includes(name)) {
        continue;
      }
      const files = byName.get(name) ?? [];
      files.push(f.file);
      byName.set(name, files);
    }
  }
  return [...byName]
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => ({ name, files: [...files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Modules declaring the entry guard. */
export function findEntryGuardModules(facts: readonly IndexModuleFacts[]): string[] {
  return facts
    .filter((f) => f.moduleScopeDeclarations.has(ENTRY_GUARD_NAME))
    .map((f) => f.file)
    .sort();
}

/**
 * Entry-guard placement violations: the guard must be declared in the barrel
 * itself and nowhere else in the family, so `process.argv[1]` identity checks
 * keep their current meaning (parent AC3).
 */
export function findEntryGuardViolations(
  facts: readonly IndexModuleFacts[],
  barrel: string = INDEX_BARREL,
): { expected: string; declaring: string[] }[] {
  const declaring = findEntryGuardModules(facts);
  if (declaring.length === 1 && declaring[0] === barrel) return [];
  return [{ expected: barrel, declaring }];
}

// ── Barrel value imports (layering gate) ──────────────────────────────

/**
 * Index-family modules that reference the barrel with runtime semantics.
 *
 * Extracted modules import concrete siblings; the barrel is a downstream
 * consumer of them, so a value import of the barrel inverts the layering and
 * creates a runtime cycle.
 */
export function findBarrelValueImports(
  index: ModuleIndex,
  barrel: string = INDEX_BARREL,
): { file: string; specifier: string }[] {
  const violations: { file: string; specifier: string }[] = [];
  for (const mod of indexFamilyModules(index)) {
    if (mod.file === barrel) continue;
    for (const imp of mod.imports) {
      if (resolveImportTarget(mod.file, imp.specifier) !== barrel) continue;
      if (!isTypeOnlyImport(imp)) violations.push({ file: mod.file, specifier: imp.specifier });
    }
  }
  return violations;
}

// ── Cycle gates ───────────────────────────────────────────────────────

function isIndexCycle(component: readonly string[]): boolean {
  return component.length > 1 && component.some((file) => isIndexFamilyFile(file));
}

/** Cyclic components of the full (value + type) static graph involving the family. */
export function findIndexFamilyCycles(index: ModuleIndex): string[][] {
  return findStronglyConnectedComponents(buildImportGraph(index)).filter(isIndexCycle);
}

/** Cyclic components of the runtime (value-only) graph involving the family. */
export function findRuntimeIndexFamilyCycles(index: ModuleIndex): string[][] {
  const runtime = new Map<string, { to: string; typeOnly: boolean }[]>();
  for (const [file, edges] of buildImportGraph(index)) {
    runtime.set(file, edges.filter((e) => !e.typeOnly));
  }
  return findStronglyConnectedComponents(runtime).filter(isIndexCycle);
}

export {
  findAbsentBaselineEdges,
  findAllowlistViolations,
  findCycleBaselineViolations,
  findOversizedModules,
  findWidenedBaselineEdges,
};

// ── Size / allowlist gates ────────────────────────────────────────────

// `findOversizedModules` / `findAllowlistViolations` are re-exported above.

// ── Consumer surface (static + dynamic) ───────────────────────────────

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
    if (entry.isDirectory()) collectSourceFiles(full, found);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Every scanned consumer source, keyed by repository-relative POSIX path. */
export function loadIndexSources(repoRoot: string): Map<string, string> {
  const sources = new Map<string, string>();
  for (const root of CONSUMER_ROOTS) {
    for (const abs of collectSourceFiles(path.join(repoRoot, root))) {
      sources.set(toPosix(path.relative(repoRoot, abs)), fs.readFileSync(abs, 'utf-8'));
    }
  }
  return sources;
}

/** `(await import('./index.js')) as unknown as T` unwrapped to the import call. */
function unwrapDynamicImport(expr: ts.Expression | undefined): ts.CallExpression | null {
  let node: ts.Expression | undefined = expr;
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isTypeAssertionExpression(node))
  ) {
    node = node.expression;
  }
  if (node && ts.isAwaitExpression(node)) node = node.expression;
  if (node && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return node;
  }
  return null;
}

function dynamicImportSpecifier(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  return arg && ts.isStringLiteral(arg) ? arg.text : null;
}

/**
 * Symbols reached through dynamic `import('./index.js')` calls.
 *
 * Covers the three shapes the existing suites use:
 *
 *   const { a, b } = await import('./index.js');
 *   (await import('./index.js')).c
 *   const helpers = await loadHelpers(); helpers.d   // helper returns the module
 *
 * The last shape is why a static-only, or even a naive dynamic-destructuring,
 * scan under-freezes the surface: `index.test.ts` reaches
 * `resolveInteractiveWorkspaceId`, `resolveInteractiveItemAnchor` and
 * `closeInteractiveTabRootPane` through a helper that returns the barrel cast
 * to a local type.
 */
export function dynamicImportNames(
  sources: Map<string, string> | Record<string, string>,
  barrel: string = INDEX_BARREL,
): Map<string, { value: boolean; typeOnly: boolean }> {
  const entries = sources instanceof Map ? [...sources] : Object.entries(sources);
  const usage = new Map<string, { value: boolean; typeOnly: boolean }>();
  const add = (name: string): void => {
    usage.set(name, { value: true, typeOnly: false });
  };

  for (const [file, source] of entries) {
    // `setParentNodes: true` — the dynamic-import scan climbs `.parent` to
    // find the binding/property context of each `import(barrel)` call.
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const targetsBarrel = (call: ts.CallExpression): boolean => {
      const specifier = dynamicImportSpecifier(call);
      return specifier !== null && resolveImportTarget(file, specifier) === barrel;
    };

    // Functions whose body simply returns `import(barrel)`.
    const barrelHelpers = new Set<string>();
    const helperAliases = new Set<string>();

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        for (const stmt of node.body.statements) {
          if (ts.isReturnStatement(stmt)) {
            const call = unwrapDynamicImport(stmt.expression);
            if (call && targetsBarrel(call)) barrelHelpers.add(node.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    const visitAliases = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isAwaitExpression(node.initializer) &&
        ts.isCallExpression(node.initializer.expression) &&
        ts.isIdentifier(node.initializer.expression.expression) &&
        barrelHelpers.has(node.initializer.expression.expression.text)
      ) {
        helperAliases.add(node.name.text);
      }
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(sf);

    const visitNames = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (!targetsBarrel(node)) {
          ts.forEachChild(node, visitNames);
          return;
        }
        let parent: ts.Node = node;
        while (parent.parent && ts.isAwaitExpression(parent.parent)) parent = parent.parent;
        while (parent.parent && ts.isParenthesizedExpression(parent.parent)) parent = parent.parent;
        const holder = parent.parent;
        if (holder && ts.isPropertyAccessExpression(holder) && holder.expression === parent) {
          add(holder.name.text);
        } else if (holder && ts.isVariableDeclaration(holder) && ts.isObjectBindingPattern(holder.name)) {
          for (const el of holder.name.elements) {
            if (ts.isIdentifier(el.name)) {
              const imported = el.propertyName;
              add(imported && ts.isIdentifier(imported) ? imported.text : el.name.text);
            }
          }
        }
      }

      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        helperAliases.has(node.expression.text) &&
        ts.isIdentifier(node.name)
      ) {
        add(node.name.text);
      }

      ts.forEachChild(node, visitNames);
    };
    visitNames(sf);
  }

  return usage;
}

function mergeUsage(
  ...maps: Map<string, { value: boolean; typeOnly: boolean }>[]
): Map<string, { value: boolean; typeOnly: boolean }> {
  const merged = new Map<string, { value: boolean; typeOnly: boolean }>();
  for (const map of maps) {
    for (const [name, usage] of map) {
      const prev = merged.get(name) ?? { value: false, typeOnly: false };
      merged.set(name, {
        value: prev.value || usage.value,
        typeOnly: prev.typeOnly || usage.typeOnly,
      });
    }
  }
  return merged;
}

/** Every symbol a consumer reaches through the barrel (static + dynamic). */
export function indexConsumerImportNames(
  index: ModuleIndex,
  sources: Map<string, string> | Record<string, string>,
  barrel: string = INDEX_BARREL,
): Map<string, { value: boolean; typeOnly: boolean }> {
  return mergeUsage(consumerImportNames(index, barrel), dynamicImportNames(sources, barrel));
}

// ── Baseline ──────────────────────────────────────────────────────────

export interface IndexSplitBaseline {
  provenance: {
    generatedBy: string;
    sourceCommit: string;
    generatedAt: string;
    barrel: string;
    consumerGlobs: string[];
  };
  symbols: string[];
  /** Recorded pre-existing cycles that must not grow. */
  cycles: string[][];
  /** Recorded cycle edges that must stay type-only. */
  typeOnlyEdges: { from: string; to: string }[];
}

/** Build the baseline payload from the live tree. */
export function buildIndexBaseline(repoRoot: string): IndexSplitBaseline {
  const index = loadModuleIndex(repoRoot);
  const consumers = indexConsumerImportNames(index, loadIndexSources(repoRoot));
  return {
    provenance: {
      generatedBy: INDEX_BASELINE_COMMAND,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      generatedAt: new Date().toISOString(),
      barrel: INDEX_BARREL,
      consumerGlobs: CONSUMER_ROOTS.map((root) => `${root}/**/*.ts`),
    },
    symbols: [...consumers.keys()].sort(),
    cycles: INDEX_CYCLE_BASELINE.map((cycle) => [...cycle]),
    typeOnlyEdges: INDEX_TYPE_ONLY_EDGES.map((edge) => ({ ...edge })),
  };
}

/** Read + parse the committed baseline. */
export function readIndexBaseline(repoRoot: string): IndexSplitBaseline {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, INDEX_BASELINE_PATH), 'utf-8'),
  ) as IndexSplitBaseline;
}

/** Write the baseline to {@link INDEX_BASELINE_PATH}; returns the payload written. */
export function writeIndexBaseline(repoRoot: string): IndexSplitBaseline {
  const baseline = buildIndexBaseline(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, INDEX_BASELINE_PATH),
    `${JSON.stringify({ version: 1, ...baseline }, null, 2)}\n`,
    'utf-8',
  );
  return baseline;
}

/** Convenience: parsed facts for every live index-family module. */
export function loadIndexFamilyFacts(
  repoRoot: string,
  sources: Map<string, string> = loadIndexSources(repoRoot),
): IndexModuleFacts[] {
  return [...sources]
    .filter(([file]) => isIndexFamilyFile(file) && !isTestOrFixture(file))
    .map(([file, source]) => parseIndexModuleFacts(file, source));
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
    console.error(`usage: ${INDEX_BASELINE_COMMAND}`);
    process.exit(2);
  }
  const baseline = writeIndexBaseline(repoRoot);
  console.log(
    `wrote ${INDEX_BASELINE_PATH}: ${baseline.symbols.length} symbols @ ${baseline.provenance.sourceCommit.slice(0, 8)}`,
  );
}
