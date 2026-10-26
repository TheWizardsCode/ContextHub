/**
 * packages/shared/src/database/decomposition-guard.test.ts — automated gate for
 * the `packages/shared/src/database.ts` split invariants.
 *
 * Parent: WL-0MVGKGHNR0019OLT (decompose the `database.ts` god class).
 * Guard item: WL-0MVOBOX1U0013HNF — lands **before** any production code moves.
 *
 * ## What this file protects
 *
 * Every extraction child moves code out of `packages/shared/src/database.ts`
 * without touching a single existing test file, so those suites are the
 * behaviour gate. Nothing in the repository enforced the *structural* half of
 * the contract — an unchanged public surface at the package entry
 * (`dist/database.js`), an acyclic extracted-module graph, no module importing
 * the façade, and a 1,000-line ceiling — and the previous attempt at this
 * decomposition silently regrew (WL-0MQJK4UJD0028IRO). These tests are that
 * enforcement.
 *
 * The gates are **additive and read-only**: they parse the module tree with the
 * TypeScript syntax API (no program, no type checker, no new dependency) and
 * assert. Nothing here modifies the tree, the package entry or any other test.
 *
 * ## Gate → acceptance criterion mapping
 *
 * | Gate | AC |
 * |---|---|
 * | baseline symbol list is still exported by the package entry | AC2, AC3 |
 * | no new public export beyond the baseline | AC3 |
 * | extracted-module graph acyclic + no façade import + context module | AC4 |
 * | ≤ 1,000 lines per module, shrink-only allowlist | AC5 |
 * | every gate fails on deliberately broken input | AC6 |
 *
 * ## Why the public-surface scan reads the entry's TypeScript source
 *
 * `packages/shared/package.json` points `main`/`exports["."]` at
 * `./dist/database.js`, which `tsc` emits from `src/database.ts` (rootDir
 * `src`, outDir `dist` — both asserted below). Four of the seven baseline
 * symbols are **interfaces**, which are erased from the JavaScript emit, and
 * `dist/` is a gitignored build artefact that is absent in a fresh worktree.
 * The authoritative, always-present surface is therefore the entry source that
 * compiles to that path; the runtime half of the contract is covered
 * separately against the built package (`@worklog/shared`).
 *
 * ## Re-baselining
 *
 * `decomposition-baseline.json` is a *frozen contract*: regenerate it
 * deliberately, never to make a red gate green.
 *
 *   npx tsx packages/shared/src/database/decomposition-guard.test.ts --write-baseline
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

// ── Contract constants ────────────────────────────────────────────────

/** The unchanged specifier every consumer imports (parent AC2). */
export const PACKAGE_SPECIFIER = '@worklog/shared';

/** Package entry (`main` / `exports["."].import`) — never renamed. */
export const PACKAGE_ENTRY_DIST = 'packages/shared/dist/database.js';

/** The TypeScript source that compiles to {@link PACKAGE_ENTRY_DIST}. */
export const ENTRY_SOURCE = 'packages/shared/src/database.ts';

/** Directory the extracted modules live in. */
export const SPLIT_FAMILY_DIR = 'packages/shared/src/database';

/** The shared-types context module every extracted module may import (AC4). */
export const CONTEXT_MODULE = `${SPLIT_FAMILY_DIR}/context.ts`;

/** Repository-relative path of the committed public-surface baseline (AC2). */
export const BASELINE_PATH = `${SPLIT_FAMILY_DIR}/decomposition-baseline.json`;

/** Per-module line ceiling (parent AC1). */
export const MAX_MODULE_LINES = 1000;

/**
 * Files currently exempt from the size gate.
 *
 * This is a *shrink-only* allowlist: it may only ever lose entries. It starts
 * with the monolith, which is over the ceiling until the split completes; the
 * closeout child empties it in one line.
 */
export const SPLIT_ALLOWLIST: readonly string[] = ['database.ts'];

/**
 * The allowlist as it stood at plan time. {@link SPLIT_ALLOWLIST} must remain a
 * subset of this, so "the split regrows into a collection of oversized modules"
 * is a test failure rather than a review finding.
 */
export const SPLIT_ALLOWLIST_CEILING: readonly string[] = ['database.ts'];

/**
 * Baseline symbols that exist at runtime (the rest are erased interfaces), so
 * the built package entry can be checked without a TypeScript compiler.
 */
export const RUNTIME_BASELINE_SYMBOLS: readonly string[] = [
  'WorklogDatabase',
  'normalizeTitleForMatch',
];

/** Generation command recorded in the baseline provenance. */
const GENERATE_FLAG = '--write-baseline';

/** How this baseline is regenerated (also the `generatedBy` provenance field). */
export const BASELINE_GENERATION_COMMAND =
  'npx tsx packages/shared/src/database/decomposition-guard.test.ts --write-baseline';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

// ── Static scanners (pure predicates over parsed modules) ─────────────

export interface ImportEdge {
  from: string;
  specifier: string;
  /** Repo-relative `.ts` path, or `null` for a bare package specifier. */
  to: string | null;
  /** True when the whole statement is erased at runtime (type-only import). */
  typeOnly: boolean;
  names: string[];
}

export interface ReExport {
  specifier: string;
  to: string | null;
  names: string[];
  star: boolean;
  typeOnly: boolean;
}

export interface ParsedModule {
  file: string;
  lineCount: number;
  imports: ImportEdge[];
  localExports: string[];
  reExports: ReExport[];
}

export interface ModuleIndex {
  modules: Map<string, ParsedModule>;
}

/** `wc -l` semantics: count newline-terminated lines. */
export function countLines(source: string): number {
  if (source.length === 0) return 0;
  const newlines = source.split('\n').length - 1;
  return source.endsWith('\n') ? newlines : newlines + 1;
}

/** Resolve a relative specifier to the repo-relative TypeScript file it names. */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier),
  );
  if (joined.endsWith('.js')) return `${joined.slice(0, -3)}.ts`;
  if (joined.endsWith('.ts')) return joined;
  return `${joined}.ts`;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

/** Exported names declared directly by a top-level statement. */
function declaredExportNames(statement: ts.Statement): string[] {
  if (!hasExportModifier(statement)) return [];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((d) => (ts.isIdentifier(d.name) ? d.name.text : ''))
      .filter(Boolean);
  }
  if (ts.isExportAssignment(statement)) return ['default'];
  const named = statement as ts.Statement & { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) return [named.name.text];
  return ['default'];
}

function parseImport(file: string, statement: ts.ImportDeclaration): ImportEdge {
  const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
  const clause = statement.importClause;
  const names: string[] = [];
  let hasValueBinding = clause === undefined; // side-effect import: runtime edge
  if (clause) {
    if (clause.name) {
      names.push('default');
      hasValueBinding = true;
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        names.push('*');
        hasValueBinding = true;
      } else {
        for (const element of clause.namedBindings.elements) {
          names.push(element.propertyName?.text ?? element.name.text);
          if (!element.isTypeOnly) hasValueBinding = true;
        }
      }
    }
  }
  return {
    from: file,
    specifier,
    to: resolveRelative(file, specifier),
    // `import type {...}` or an all-`type` named clause is erased at runtime.
    typeOnly: clause ? clause.isTypeOnly || !hasValueBinding : false,
    names,
  };
}

function parseExport(
  file: string,
  statement: ts.ExportDeclaration,
): { reExport: ReExport | null; localNames: string[] } {
  const clause = statement.exportClause;
  const names: string[] = [];
  let star = false;
  if (clause === undefined) {
    // `export * from './x.js'` (values are re-exported => runtime edge).
    star = true;
  } else if (ts.isNamespaceExport(clause)) {
    names.push(clause.name.text);
  } else {
    for (const element of clause.elements) names.push(element.name.text);
  }

  if (!statement.moduleSpecifier) {
    // Local `export { a, b }` — surface names, no graph edge.
    return { reExport: null, localNames: names };
  }

  const allTypeOnly =
    clause !== undefined &&
    ts.isNamedExports(clause) &&
    clause.elements.every((element) => element.isTypeOnly);
  return {
    reExport: {
      specifier: (statement.moduleSpecifier as ts.StringLiteral).text,
      to: resolveRelative(file, (statement.moduleSpecifier as ts.StringLiteral).text),
      names,
      star,
      typeOnly: statement.isTypeOnly || allTypeOnly,
    },
    localNames: [],
  };
}

/** Parse one module into the shape the gates reason about. */
export function parseModule(file: string, source: string): ParsedModule {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const parsed: ParsedModule = {
    file,
    lineCount: countLines(source),
    imports: [],
    localExports: [],
    reExports: [],
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      parsed.imports.push(parseImport(file, statement));
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const { reExport, localNames } = parseExport(file, statement);
      if (reExport) parsed.reExports.push(reExport);
      parsed.localExports.push(...localNames);
      continue;
    }
    parsed.localExports.push(...declaredExportNames(statement));
  }
  parsed.localExports = [...new Set(parsed.localExports)];
  return parsed;
}

/** Build an index from in-memory sources (used by the negative fixtures). */
export function indexFromSources(sources: Record<string, string>): ModuleIndex {
  const modules = new Map<string, ParsedModule>();
  for (const [file, source] of Object.entries(sources)) {
    modules.set(file, parseModule(file, source));
  }
  return { modules };
}

function listTypeScriptFiles(root: string, relativeDir: string): string[] {
  const absolute = path.join(root, relativeDir);
  if (!fs.existsSync(absolute)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) found.push(...listTypeScriptFiles(root, relative));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(relative);
  }
  return found.sort();
}

/** Parse the live tree: the façade plus everything under the split directory. */
export function readLiveIndex(root: string = repoRoot): ModuleIndex {
  const sources: Record<string, string> = {
    [ENTRY_SOURCE]: fs.readFileSync(path.join(root, ENTRY_SOURCE), 'utf8'),
  };
  for (const file of listTypeScriptFiles(root, SPLIT_FAMILY_DIR)) {
    sources[file] = fs.readFileSync(path.join(root, file), 'utf8');
  }
  return indexFromSources(sources);
}

/** True for a module extracted into the split directory (tests excluded). */
export function isExtractedModule(file: string): boolean {
  return file.startsWith(`${SPLIT_FAMILY_DIR}/`) && !file.endsWith('.test.ts');
}

/** Follow `export … from` chains and collect everything a module exports. */
export function collectExportedNames(
  index: ModuleIndex,
  file: string,
  seen: Set<string> = new Set(),
): Set<string> {
  const parsed = index.modules.get(file);
  if (!parsed || seen.has(file)) return new Set();
  seen.add(file);
  const names = new Set(parsed.localExports);
  for (const reExport of parsed.reExports) {
    for (const name of reExport.names) names.add(name);
    if (reExport.star && reExport.to) {
      for (const name of collectExportedNames(index, reExport.to, seen)) names.add(name);
    }
  }
  return names;
}

/** Names in `expected` that `actual` does not export (sorted). */
export function findMissingExports(
  expected: Iterable<string>,
  actual: Iterable<string>,
): string[] {
  const present = new Set(actual);
  return [...new Set(expected)].filter((name) => !present.has(name)).sort();
}

/** Extracted modules that import the façade (all import kinds — AC4). */
export function findFacadeImports(
  index: ModuleIndex,
): { file: string; specifier: string; typeOnly: boolean }[] {
  const found: { file: string; specifier: string; typeOnly: boolean }[] = [];
  for (const parsed of index.modules.values()) {
    if (!isExtractedModule(parsed.file)) continue;
    for (const edge of parsed.imports) {
      if (edge.to === ENTRY_SOURCE) {
        found.push({ file: parsed.file, specifier: edge.specifier, typeOnly: edge.typeOnly });
      }
    }
    for (const reExport of parsed.reExports) {
      if (reExport.to === ENTRY_SOURCE) {
        found.push({
          file: parsed.file,
          specifier: reExport.specifier,
          typeOnly: reExport.typeOnly,
        });
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier));
}

/** Adjacency of the split family (façade + extracted modules). */
function familyGraph(
  index: ModuleIndex,
  runtimeOnly: boolean,
): { nodes: string[]; adjacency: Map<string, string[]> } {
  const nodes = new Set<string>([ENTRY_SOURCE]);
  for (const parsed of index.modules.values()) {
    if (isExtractedModule(parsed.file)) nodes.add(parsed.file);
  }
  const adjacency = new Map<string, Set<string>>([...nodes].map((n) => [n, new Set<string>()]));
  for (const parsed of index.modules.values()) {
    const targets = adjacency.get(parsed.file);
    if (!targets) continue;
    const edges = [
      ...parsed.imports.map((e) => ({ to: e.to, typeOnly: e.typeOnly })),
      ...parsed.reExports.map((r) => ({ to: r.to, typeOnly: r.typeOnly })),
    ];
    for (const edge of edges) {
      if (!edge.to || edge.to === parsed.file || !nodes.has(edge.to)) continue;
      if (runtimeOnly && edge.typeOnly) continue;
      targets.add(edge.to);
    }
  }
  return {
    nodes: [...nodes].sort(),
    adjacency: new Map([...adjacency].map(([node, targets]) => [node, [...targets].sort()])),
  };
}

/** Tarjan's strongly connected components over the split-family graph. */
function stronglyConnectedComponents(
  nodes: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, indices.get(target)!));
      }
    }
    if (lowLink.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component);
  };

  for (const node of nodes) if (!indices.has(node)) visit(node);
  return components;
}

function findCycles(index: ModuleIndex, runtimeOnly: boolean): string[][] {
  const { nodes, adjacency } = familyGraph(index, runtimeOnly);
  return stronglyConnectedComponents(nodes, adjacency)
    .filter((component) => component.length > 1)
    .map((component) => component.sort())
    .sort((a, b) => a.join('\n').localeCompare(b.join('\n')));
}

/** Import cycles anywhere in the split family, including through the façade. */
export function findSplitFamilyCycles(index: ModuleIndex): string[][] {
  return findCycles(index, false);
}

/** Runtime (value-import) cycles only — the graph that can break at load time. */
export function findRuntimeCycles(index: ModuleIndex): string[][] {
  return findCycles(index, true);
}

/** Every `.ts` file the ceiling applies to: the façade and the split directory. */
export function splitFamilyModules(
  index: ModuleIndex,
): { file: string; lineCount: number }[] {
  return [...index.modules.values()]
    .filter((m) => m.file === ENTRY_SOURCE || m.file.startsWith(`${SPLIT_FAMILY_DIR}/`))
    .map((m) => ({ file: m.file, lineCount: m.lineCount }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Modules over the ceiling that the allowlist does not exempt. */
export function findOversizedModules(
  modules: { file: string; lineCount: number }[],
  allowlist: readonly string[] = SPLIT_ALLOWLIST,
  maxLines: number = MAX_MODULE_LINES,
): { file: string; lineCount: number }[] {
  const exempt = new Set(allowlist);
  return modules.filter(
    (m) => m.lineCount > maxLines && !exempt.has(path.posix.basename(m.file)),
  );
}

/** Allowlist entries that are not in the plan-time ceiling (forbidden growth). */
export function findAllowlistViolations(
  allowlist: readonly string[],
  ceiling: readonly string[] = SPLIT_ALLOWLIST_CEILING,
): string[] {
  const permitted = new Set(ceiling);
  return allowlist.filter((entry) => !permitted.has(entry));
}

// ── Baseline artefact ─────────────────────────────────────────────────

export interface Baseline {
  version: number;
  provenance: {
    generatedBy: string;
    sourceCommit: string;
    generatedAt: string;
    packageEntry: string;
    entrySource: string;
    specifier: string;
  };
  symbols: string[];
}

export function readBaseline(root: string = repoRoot): Baseline {
  return JSON.parse(fs.readFileSync(path.join(root, BASELINE_PATH), 'utf8')) as Baseline;
}

/**
 * `--write-baseline` support for deliberate re-baselining (see the header).
 * A no-op under vitest, which never passes the flag.
 */
function writeBaselineIfRequested(): void {
  if (!process.argv.includes(GENERATE_FLAG)) return;
  const index = readLiveIndex(repoRoot);
  const baseline: Baseline = {
    version: 1,
    provenance: {
      generatedBy: BASELINE_GENERATION_COMMAND,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
        .toString()
        .trim(),
      generatedAt: new Date().toISOString(),
      packageEntry: PACKAGE_ENTRY_DIST,
      entrySource: ENTRY_SOURCE,
      specifier: PACKAGE_SPECIFIER,
    },
    symbols: [...collectExportedNames(index, ENTRY_SOURCE)].sort(),
  };
  fs.writeFileSync(path.join(repoRoot, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(
    `wrote ${BASELINE_PATH} (${baseline.symbols.length} symbols)\n`,
  );
  process.exit(0);
}

writeBaselineIfRequested();

// ── Gates against the live tree ───────────────────────────────────────

describe('database split guard — live tree', () => {
  const index = readLiveIndex(repoRoot);

  it('declares the package entry that the public API is measured at', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages/shared/package.json'), 'utf8'),
    );
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages/shared/tsconfig.json'), 'utf8'),
    );
    // The entry path is the contract; a rename here is a consumer-visible break.
    expect(pkg.main).toBe('./dist/database.js');
    expect(pkg.exports['.'].import).toBe('./dist/database.js');
    expect(PACKAGE_ENTRY_DIST).toBe('packages/shared/dist/database.js');
    // …and it is emitted from ENTRY_SOURCE by the package's own build config.
    expect(tsconfig.compilerOptions.outDir).toBe('./dist');
    expect(tsconfig.compilerOptions.rootDir).toBe('./src');
    expect(fs.existsSync(path.join(repoRoot, ENTRY_SOURCE))).toBe(true);
  });

  it('keeps every baseline symbol exported by the package entry (public surface)', () => {
    const baseline = readBaseline(repoRoot);
    const exported = collectExportedNames(index, ENTRY_SOURCE);
    // A lost re-export is exactly the failure a move-only split invites.
    expect(findMissingExports(baseline.symbols, exported)).toEqual([]);
    expect(exported.size).toBeGreaterThanOrEqual(baseline.symbols.length);
  });

  it('adds no public export beyond the baseline', () => {
    // The split is move-only: the public surface may shrink (caught above),
    // but it may never grow.
    const baseline = readBaseline(repoRoot);
    const exported = collectExportedNames(index, ENTRY_SOURCE);
    expect(findMissingExports(exported, baseline.symbols)).toEqual([]);
  });

  it('enumerates the live surface even when it re-exports through the chain', () => {
    // Guards the scanner itself against quietly returning a subset: the seven
    // plan-time symbols are all present on the unsplit façade.
    const exported = collectExportedNames(index, ENTRY_SOURCE);
    for (const symbol of [
      'WorklogDatabase',
      'WorklogDatabaseOptions',
      'WorklogDatabaseServices',
      'JsonlImportResult',
      'GitTarget',
      'UpdateIfMatchesResult',
      'normalizeTitleForMatch',
    ]) {
      expect(exported.has(symbol), `${symbol} missing from ${ENTRY_SOURCE}`).toBe(true);
    }
  });

  it('has no extracted module importing the database.ts façade', () => {
    expect(findFacadeImports(index)).toEqual([]);
  });

  it('has an acyclic extracted-module import graph', () => {
    expect(findSplitFamilyCycles(index)).toEqual([]);
  });

  it('adds no runtime (value) import cycle', () => {
    // Type-only cycles are erased at runtime; value cycles are load-order bugs.
    expect(findRuntimeCycles(index)).toEqual([]);
  });

  it('houses shared types in a context module every extracted module may import', () => {
    // The permitted shape: a context module inside the split directory that any
    // extracted module may import, with no façade import and no cycle.
    const allowed = indexFromSources({
      [ENTRY_SOURCE]: `export const facade = 1;\n`,
      [CONTEXT_MODULE]: `export interface SharedType { a: number }\nexport const sharedValue = 1;\n`,
      [`${SPLIT_FAMILY_DIR}/a.ts`]: `import type { SharedType } from './context.js';\nexport const a = (x: SharedType) => x.a;\n`,
      [`${SPLIT_FAMILY_DIR}/b.ts`]: `import { sharedValue } from './context.js';\nexport const b = sharedValue;\n`,
    });
    expect(findFacadeImports(allowed)).toEqual([]);
    expect(findSplitFamilyCycles(allowed)).toEqual([]);
    expect(findRuntimeCycles(allowed)).toEqual([]);

    // The context module lives in the split directory, so every extracted
    // module can reach it with a plain sibling import.
    expect(CONTEXT_MODULE.startsWith(`${SPLIT_FAMILY_DIR}/`)).toBe(true);
    expect(allowed.modules.has(CONTEXT_MODULE)).toBe(true);

    // Live: as soon as anything is extracted, its shared types module must
    // exist. Before the first move the split directory holds no production
    // modules, so the requirement is vacuous by construction.
    const extracted = [...index.modules.values()].filter((m) => isExtractedModule(m.file));
    if (extracted.length > 0) expect(index.modules.has(CONTEXT_MODULE)).toBe(true);
  });

  it('keeps every module in the split family within the line ceiling', () => {
    const oversized = findOversizedModules(splitFamilyModules(index));
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
  });

  it('only ever shrinks the split allowlist', () => {
    expect(findAllowlistViolations(SPLIT_ALLOWLIST)).toEqual([]);
    // The ceiling itself is the plan-time list: the monolith and nothing else.
    expect([...SPLIT_ALLOWLIST_CEILING]).toEqual(['database.ts']);
  });

  it('still exposes the runtime baseline symbols from the built package entry', async () => {
    // The runtime half of "public API unchanged": the interfaces are erased, so
    // the built entry is checked for the values every consumer calls.
    const entry = (await import('@worklog/shared')) as Record<string, unknown>;
    expect(Object.keys(entry)).toEqual(expect.arrayContaining([...RUNTIME_BASELINE_SYMBOLS]));
    expect(typeof entry.WorklogDatabase).toBe('function');
    expect(typeof entry.normalizeTitleForMatch).toBe('function');
  });
});

// ── The committed baseline artefact (AC2) ─────────────────────────────

describe('database split baseline', () => {
  const baseline = readBaseline(repoRoot);

  it('records the seven plan-time symbols, sorted and deduplicated', () => {
    expect(baseline.symbols).toEqual([
      'GitTarget',
      'JsonlImportResult',
      'UpdateIfMatchesResult',
      'WorklogDatabase',
      'WorklogDatabaseOptions',
      'WorklogDatabaseServices',
      'normalizeTitleForMatch',
    ]);
    expect(baseline.symbols).toEqual([...baseline.symbols].sort());
    expect(new Set(baseline.symbols).size).toBe(baseline.symbols.length);
    for (const symbol of baseline.symbols) expect(symbol).toMatch(/^[\w$]+$/);
  });

  it('records provenance that makes the baseline reproducible', () => {
    expect(baseline.provenance.generatedBy).toBe(BASELINE_GENERATION_COMMAND);
    expect(baseline.provenance.generatedBy).toContain(GENERATE_FLAG);
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.packageEntry).toBe(PACKAGE_ENTRY_DIST);
    expect(baseline.provenance.entrySource).toBe(ENTRY_SOURCE);
    expect(baseline.provenance.specifier).toBe(PACKAGE_SPECIFIER);
  });

  it('is committed where the guard loads it from', () => {
    expect(fs.existsSync(path.join(repoRoot, BASELINE_PATH))).toBe(true);
    expect(BASELINE_PATH).toBe('packages/shared/src/database/decomposition-baseline.json');
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.entrySource))).toBe(true);
  });

  it('records a baseline that matches the live surface exactly', () => {
    const exported = [...collectExportedNames(readLiveIndex(repoRoot), ENTRY_SOURCE)].sort();
    expect(baseline.symbols).toEqual(exported);
  });
});

// ── Negative cases: each gate must fail on broken input (AC6) ─────────

/** `'// pad\n'.repeat(n)` yields a module whose `wc -l` is exactly `n`. */
function lines(n: number): string {
  return '// pad\n'.repeat(n);
}

describe('database split guard — gates fail on broken input', () => {
  it('reports a dropped export, and follows export * re-export chains', () => {
    const broken = indexFromSources({
      [ENTRY_SOURCE]: `export * from './database/context.js';\nexport * from './database/work-items.js';\n`,
      [`${SPLIT_FAMILY_DIR}/context.ts`]: `export interface Kept {}\nexport type AlsoKept = 1;\n`,
      [`${SPLIT_FAMILY_DIR}/work-items.ts`]: `export const keptValue = 1;\n`,
    });
    const exported = collectExportedNames(broken, ENTRY_SOURCE);
    expect(findMissingExports(['Kept', 'AlsoKept', 'keptValue'], exported)).toEqual([]);
    // A dropped re-export is the failure the gate exists for.
    expect(findMissingExports(['Kept', 'Dropped'], exported)).toEqual(['Dropped']);
  });

  it('reports a façade module that lost an export declaration entirely', () => {
    const broken = indexFromSources({
      [ENTRY_SOURCE]: `import { WorklogDatabase } from './x.js';\nexport const facade = WorklogDatabase;\n`,
    });
    const exported = collectExportedNames(broken, ENTRY_SOURCE);
    expect(findMissingExports(['WorklogDatabase'], exported)).toEqual(['WorklogDatabase']);
    expect(exported.has('facade')).toBe(true);
  });

  it('reports a new public export beyond the baseline', () => {
    const broken = indexFromSources({
      [ENTRY_SOURCE]: `export const original = 1;\nexport const sneakedIn = 2;\n`,
    });
    const exported = collectExportedNames(broken, ENTRY_SOURCE);
    expect(findMissingExports(exported, ['original'])).toEqual(['sneakedIn']);
    expect(findMissingExports(['original', 'sneakedIn'], exported)).toEqual([]);
  });

  it('reports a module importing the database.ts façade (value or type-only)', () => {
    const broken = indexFromSources({
      [ENTRY_SOURCE]: `export class WorklogDatabase {}\nexport interface Ctx {}\n`,
      [`${SPLIT_FAMILY_DIR}/work-items.ts`]: `import { WorklogDatabase } from '../database.js';\nexport const w = WorklogDatabase;\n`,
      [`${SPLIT_FAMILY_DIR}/hierarchy.ts`]: `import type { Ctx } from '../database.js';\nexport const h = (c: Ctx) => c;\n`,
    });
    expect(findFacadeImports(broken)).toEqual([
      { file: `${SPLIT_FAMILY_DIR}/hierarchy.ts`, specifier: '../database.js', typeOnly: true },
      { file: `${SPLIT_FAMILY_DIR}/work-items.ts`, specifier: '../database.js', typeOnly: false },
    ]);
  });

  it('permits sibling and context imports (no false positive)', () => {
    const allowed = indexFromSources({
      [ENTRY_SOURCE]: `export const facade = 1;\n`,
      [CONTEXT_MODULE]: `export interface Ctx {}\n`,
      [`${SPLIT_FAMILY_DIR}/sort.ts`]: `import type { Ctx } from './context.js';\nexport const sort = (c: Ctx) => c;\n`,
    });
    expect(findFacadeImports(allowed)).toEqual([]);
    expect(findSplitFamilyCycles(allowed)).toEqual([]);
  });

  it('reports a synthetic import cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [ENTRY_SOURCE]: `export * from './database/a.js';\nexport * from './database/b.js';\n`,
      [`${SPLIT_FAMILY_DIR}/a.ts`]: `import { b } from './b.js';\nexport const a = () => b;\n`,
      [`${SPLIT_FAMILY_DIR}/b.ts`]: `import { a } from './a.js';\nexport const b = () => a;\n`,
    });
    const cycles = findSplitFamilyCycles(broken);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual([
      `${SPLIT_FAMILY_DIR}/a.ts`,
      `${SPLIT_FAMILY_DIR}/b.ts`,
    ]);
    expect(findRuntimeCycles(broken)).toHaveLength(1);
  });

  it('reports a cycle that only closes through the façade', () => {
    const broken = indexFromSources({
      [ENTRY_SOURCE]: `import { helper } from './database/work-items.js';\nexport const facade = helper;\n`,
      [`${SPLIT_FAMILY_DIR}/work-items.ts`]: `import { facade } from '../database.js';\nexport const helper = facade;\n`,
    });
    expect(findSplitFamilyCycles(broken)).toEqual([
      [ENTRY_SOURCE, `${SPLIT_FAMILY_DIR}/work-items.ts`].sort(),
    ]);
    // The façade import is reported in its own right as well.
    expect(findFacadeImports(broken)).toHaveLength(1);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({ [`${SPLIT_FAMILY_DIR}/huge.ts`]: lines(MAX_MODULE_LINES + 1) });
    expect(findOversizedModules(splitFamilyModules(over), [], MAX_MODULE_LINES)).toEqual([
      { file: `${SPLIT_FAMILY_DIR}/huge.ts`, lineCount: MAX_MODULE_LINES + 1 },
    ]);

    const atCeiling = indexFromSources({ [`${SPLIT_FAMILY_DIR}/huge.ts`]: lines(MAX_MODULE_LINES) });
    expect(findOversizedModules(splitFamilyModules(atCeiling), [], MAX_MODULE_LINES)).toEqual(
      [],
    );
  });

  it('exempts allowlisted modules but rejects allowlist growth', () => {
    const oversized = indexFromSources({ [ENTRY_SOURCE]: lines(MAX_MODULE_LINES * 4) });
    // The monolith is exempt while the split is in flight…
    expect(findOversizedModules(splitFamilyModules(oversized), ['database.ts'])).toEqual([]);
    // …but the allowlist can never be extended to cover a new module.
    expect(findAllowlistViolations(['database.ts', 'work-items.ts'])).toEqual(['work-items.ts']);
    expect(findAllowlistViolations(['database.ts'])).toEqual([]);
    expect(findAllowlistViolations([])).toEqual([]);
  });

  it('counts lines exactly like wc -l', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one line')).toBe(1);
    expect(countLines('one line\n')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
  });
});
