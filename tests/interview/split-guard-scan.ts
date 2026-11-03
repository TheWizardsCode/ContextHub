/**
 * tests/interview/split-guard-scan.ts — static scanners and gate predicates for
 * the `src/commands/interview.ts` split invariants.
 *
 * Parent: WL-0MVGKGXN80006V9P (decompose the `src/commands/interview.ts` god
 * class). Guard item: WL-0MVXY34A900816MN — child 1 of 7, lands before any
 * production code moves.
 *
 * The gates are pure predicates over parsed modules so the test suite can prove
 * each one fails on deliberately broken input. Parsing uses the TypeScript
 * compiler API (syntax only — no program, no type checker, no new dependency)
 * because value vs type exports and value vs type imports cannot be told apart
 * by text matching.
 *
 *   npx tsx tests/interview/split-guard-scan.ts --write-baseline
 *
 * regenerates the frozen public-surface baseline. Re-run it only when the
 * surface is *deliberately* changed.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every consumer imports. */
export const INTERVIEW_BARREL = 'src/commands/interview.ts';

/** Directory extracted interview modules live in. */
export const INTERVIEW_SPLIT_DIR = 'src/interview';

/** Repository-relative path of the committed public-surface baseline (AC2). */
export const BASELINE_PATH = 'tests/interview/interview.split-baseline.json';

/** Per-module line ceiling (AC1). */
export const MAX_MODULE_LINES = 1000;

/**
 * Family modules currently exempt from the size gate.
 *
 * A *shrink-only* allowlist: it may only ever lose entries. It started with
 * the 1,630-line monolith and the closeout child removed that entry once
 * `src/commands/interview.ts` became a thin registration + barrel module
 * (WL-0MVXY39OF009S3V0), so every family module must stay under
 * {@link MAX_MODULE_LINES} with no exemptions.
 */
export const SPLIT_ALLOWLIST: readonly string[] = [];

/** The allowlist as it stood at plan time; the live list must be a subset. */
export const SPLIT_ALLOWLIST_CEILING: readonly string[] = ['commands/interview.ts'];

/** Roots scanned for barrel consumers (static and dynamic imports). */
export const CONSUMER_ROOTS: readonly string[] = ['src', 'tests', 'scripts'];

/** Roots scanned for the live interview family (graph and size gates). */
export const FAMILY_ROOTS: readonly string[] = ['src'];

/** Generation command recorded in the baseline provenance (AC2). */
export const BASELINE_GENERATION_COMMAND =
  'npx tsx tests/interview/split-guard-scan.ts --write-baseline';

// ── Parsed-module model ───────────────────────────────────────────────

export type ExportKind = 'value' | 'type';

export interface ParsedImportName {
  name: string;
  typeOnly: boolean;
}

export interface ParsedImport {
  specifier: string;
  target: string | null;
  typeOnly: boolean;
  hasDefault: boolean;
  namespace: boolean;
  names: ParsedImportName[];
}

export interface ParsedReexport {
  specifier: string;
  target: string | null;
  all: boolean;
  typeOnly: boolean;
  names: string[];
}

export interface LocalExportClause {
  local: string;
  exported: string;
  typeOnly: boolean;
}

export interface ParsedModule {
  file: string;
  /** `wc -l` semantics: the number of newline characters. */
  lineCount: number;
  declarations: Map<string, ExportKind>;
  localExports: string[];
  localExportClauses: LocalExportClause[];
  reexports: ParsedReexport[];
  imports: ParsedImport[];
}

export interface ModuleIndex {
  repoRoot: string;
  byFile: Map<string, ParsedModule>;
}

export interface SplitBaseline {
  version: number;
  provenance: {
    generatedBy: string;
    sourceCommit: string;
    generatedAt: string;
    barrel: string;
    consumerGlobs: string[];
  };
  symbols: { value: string[]; type: string[] };
}

// ── Parsing ───────────────────────────────────────────────────────────

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === kind)
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function declarationName(node: ts.Node): string | null {
  const name = (node as { name?: ts.Node }).name;
  return name && ts.isIdentifier(name) ? name.text : null;
}

function declaredNames(stmt: ts.Statement): { name: string; kind: ExportKind }[] {
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations
      .filter((decl) => ts.isIdentifier(decl.name))
      .map((decl) => ({ name: (decl.name as ts.Identifier).text, kind: 'value' as const }));
  }
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
    const name = declarationName(stmt);
    return name ? [{ name, kind: 'value' }] : [];
  }
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
    const name = declarationName(stmt);
    return name ? [{ name, kind: 'type' }] : [];
  }
  return [];
}

function dynamicImportSpecifier(node: ts.ImportTypeNode): string | null {
  const arg = node.argument;
  if (!ts.isLiteralTypeNode(arg) || !ts.isStringLiteral(arg.literal)) return null;
  return arg.literal.text;
}

/**
 * Parse one module's source into the model the gates consume. Synthetic
 * in-memory modules are parsed exactly like real ones (AC5 negative cases).
 */
export function parseModuleSource(file: string, source: string): ParsedModule {
  const parsed: ParsedModule = {
    file,
    lineCount: (source.match(/\n/g) ?? []).length,
    declarations: new Map(),
    localExports: [],
    localExportClauses: [],
    reexports: [],
    imports: [],
  };

  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

  const visitImportTypes = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) {
      const specifier = dynamicImportSpecifier(node);
      if (specifier) {
        const names: ParsedImportName[] = [];
        const qualifier = node.qualifier;
        if (qualifier) {
          const text = ts.isQualifiedName(qualifier) ? qualifier.right.text : qualifier.text;
          names.push({ name: text, typeOnly: true });
        }
        parsed.imports.push({
          specifier,
          target: resolveImportTarget(file, specifier),
          typeOnly: true,
          hasDefault: false,
          namespace: false,
          names,
        });
      }
    }
    ts.forEachChild(node, visitImportTypes);
  };
  visitImportTypes(sf);

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (!clause || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const specifier = stmt.moduleSpecifier.text;
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
        specifier,
        target: resolveImportTarget(file, specifier),
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
      let all = false;
      if (stmt.exportClause) {
        if (ts.isNamespaceExport(stmt.exportClause)) {
          names.push(stmt.exportClause.name.text);
        } else {
          for (const el of stmt.exportClause.elements) names.push(el.name.text);
        }
      } else {
        all = true;
      }
      if (specifier) {
        parsed.reexports.push({
          specifier,
          target: resolveImportTarget(file, specifier),
          all,
          typeOnly: stmt.isTypeOnly,
          names,
        });
      } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          parsed.localExportClauses.push({
            local: el.propertyName?.text ?? el.name.text,
            exported: el.name.text,
            typeOnly: el.isTypeOnly || stmt.isTypeOnly,
          });
        }
      }
      continue;
    }

    const declared = declaredNames(stmt);
    for (const { name, kind } of declared) {
      if (!parsed.declarations.has(name)) parsed.declarations.set(name, kind);
    }
    if (!hasExportModifier(stmt)) continue;
    if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
      // `export default function register()` exposes only `default`; the
      // function's local name is NOT a named export.
      parsed.localExports.push('default');
    } else {
      for (const { name } of declared) parsed.localExports.push(name);
    }
  }

  return parsed;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Resolve a relative import/export specifier to an indexed module file. */
export function resolveImportTarget(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const withoutExt = specifier.replace(/\.(js|mjs|cjs)$/, '.ts');
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), withoutExt));
}

/** True when every imported part of an import is erased at runtime. */
export function isTypeOnlyImport(imp: ParsedImport): boolean {
  if (imp.typeOnly) return true;
  if (imp.hasDefault || imp.namespace) return false;
  return !imp.names.some((n) => !n.typeOnly);
}

// ── Loading ───────────────────────────────────────────────────────────

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
  for (const root of roots) {
    for (const abs of collectSourceFiles(path.join(repoRoot, root))) {
      const rel = toPosix(path.relative(repoRoot, abs));
      byFile.set(rel, parseModuleSource(rel, fs.readFileSync(abs, 'utf-8')));
    }
  }
  return { repoRoot, byFile };
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

/**
 * True for a module of the interview family: the entry barrel and anything
 * under `src/interview/`.
 */
export function isInterviewFamilyFile(file: string): boolean {
  if (file === INTERVIEW_BARREL) return true;
  return file === INTERVIEW_SPLIT_DIR || file.startsWith(`${INTERVIEW_SPLIT_DIR}/`);
}

/** Production modules of the interview family (the modules the gates cover). */
export function splitFamilyModules(index: ModuleIndex): ParsedModule[] {
  return [...index.byFile.values()]
    .filter((m) => isInterviewFamilyFile(m.file) && !isTestOrFixture(m.file))
    .sort((a, b) => a.file.localeCompare(b.file));
}

// ── Documentation standard (AC4) ─────────────────────────────────────

/** True when a module opens with a top-level JSDoc block naming its concern. */
export function hasLeadingJsDoc(source: string): boolean {
  const trimmed = source.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed.startsWith('/**')) return false;
  const end = trimmed.indexOf('*/');
  return end > 20;
}

// ── Gate 1: public surface (values + types) ──────────────────────────

/**
 * Resolve the kind of every name `entry` exports, following `export … from`
 * chains transitively (the post-split barrel is a chain of re-exports).
 */
export function collectExportKinds(
  index: ModuleIndex,
  entry: string,
  memo: Map<string, Map<string, ExportKind>> = new Map(),
  seen: Set<string> = new Set(),
): Map<string, ExportKind> {
  const cached = memo.get(entry);
  if (cached) return cached;
  if (seen.has(entry)) return new Map();
  seen.add(entry);

  const out = new Map<string, ExportKind>();
  const mod = index.byFile.get(entry);
  if (mod) {
    for (const name of mod.localExports) {
      out.set(name, mod.declarations.get(name) ?? 'value');
    }
    for (const clause of mod.localExportClauses) {
      out.set(
        clause.exported,
        clause.typeOnly ? 'type' : (mod.declarations.get(clause.local) ?? 'value'),
      );
    }
    for (const re of mod.reexports) {
      const targetKinds =
        re.target !== null && index.byFile.has(re.target)
          ? collectExportKinds(index, re.target, memo, seen)
          : undefined;
      if (re.all) {
        for (const [name, kind] of targetKinds ?? []) {
          out.set(name, re.typeOnly ? 'type' : kind);
        }
      } else {
        for (const name of re.names) {
          out.set(name, re.typeOnly ? 'type' : (targetKinds?.get(name) ?? 'value'));
        }
      }
    }
  }

  seen.delete(entry);
  memo.set(entry, out);
  return out;
}

/** Names of one kind from a {@link collectExportKinds} map, sorted. */
export function namesOfKind(kinds: Map<string, ExportKind>, kind: ExportKind): string[] {
  return [...kinds]
    .filter(([, k]) => k === kind)
    .map(([name]) => name)
    .sort();
}

/** Names in `expected` that `actual` does not contain (sorted). */
export function findMissingExports(
  expected: Iterable<string>,
  actual: Iterable<string> | ReadonlySet<string>,
): string[] {
  const present = actual instanceof Set ? actual : new Set(actual);
  return [...new Set(expected)].filter((name) => !present.has(name)).sort();
}

// ── Gate 2: module size and shrink-only allowlist ────────────────────

/** Family modules exceeding `max` lines and not allowlisted. */
export function findOversizedModules(
  modules: readonly ParsedModule[],
  allowlist: readonly string[] = SPLIT_ALLOWLIST,
  max: number = MAX_MODULE_LINES,
): { file: string; lineCount: number }[] {
  const allowed = new Set(allowlist);
  return modules
    .filter((m) => !allowed.has(moduleAllowlistKey(m.file)))
    .filter((m) => m.lineCount > max)
    .map((m) => ({ file: m.file, lineCount: m.lineCount }));
}

/**
 * Allowlist keys are paths relative to `src/` (e.g. `commands/interview.ts`),
 * so the same shape works for the entry and for `src/interview/*` modules.
 */
export function moduleAllowlistKey(file: string): string {
  return file.replace(/^src\//, '');
}

/** Allowlist entries that are not in the shrink-only ceiling (or repeated). */
export function findAllowlistViolations(
  allowlist: readonly string[],
  ceiling: readonly string[] = SPLIT_ALLOWLIST_CEILING,
): string[] {
  const permitted = new Set(ceiling);
  const outside = allowlist.filter((entry) => !permitted.has(entry));
  const duplicates = allowlist.filter((entry, i) => allowlist.indexOf(entry) !== i);
  return [...new Set([...outside, ...duplicates])].sort();
}

// ── Gate 3: barrel imports and cycles ────────────────────────────────

export interface GraphEdge {
  to: string;
  typeOnly: boolean;
}

export interface BarrelImport {
  file: string;
  specifier: string;
  typeOnly: boolean;
}

/**
 * Static import graph over the interview family (imports and re-exports),
 * optionally dropping type-only edges.
 */
export function buildImportGraph(
  index: ModuleIndex,
  options: { runtimeOnly?: boolean } = {},
): Map<string, GraphEdge[]> {
  const family = new Set(splitFamilyModules(index).map((m) => m.file));
  const graph = new Map<string, GraphEdge[]>();

  for (const file of family) {
    const mod = index.byFile.get(file)!;
    const edges: GraphEdge[] = [];
    const push = (to: string | null, typeOnly: boolean): void => {
      if (!to || !family.has(to) || to === file) return;
      if (options.runtimeOnly && typeOnly) return;
      const existing = edges.find((e) => e.to === to);
      if (existing) existing.typeOnly = existing.typeOnly && typeOnly;
      else edges.push({ to, typeOnly });
    };
    for (const imp of mod.imports) push(imp.target, isTypeOnlyImport(imp));
    for (const re of mod.reexports) push(re.target, re.typeOnly);
    graph.set(file, edges);
  }
  return graph;
}

/** Strongly connected components of a module graph (iterative Tarjan). */
export function findStronglyConnectedComponents(
  graph: Map<string, GraphEdge[]>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of graph.keys()) {
    if (index.has(start)) continue;
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

function cyclesOf(graph: Map<string, GraphEdge[]>): string[][] {
  return findStronglyConnectedComponents(graph)
    .filter((component) => component.length > 1)
    .sort((a, b) => a.join('\n').localeCompare(b.join('\n')));
}

/** Cycles in the full (value + type) interview-family import graph. */
export function findStaticCycles(index: ModuleIndex): string[][] {
  return cyclesOf(buildImportGraph(index));
}

/** Cycles in the runtime (value) interview-family import graph. */
export function findRuntimeCycles(index: ModuleIndex): string[][] {
  return cyclesOf(buildImportGraph(index, { runtimeOnly: true }));
}

/** Family modules (excluding the barrel) that import the barrel. */
export function findBarrelImports(
  index: ModuleIndex,
  runtimeOnly: boolean = false,
): BarrelImport[] {
  const found: BarrelImport[] = [];
  for (const mod of splitFamilyModules(index)) {
    if (mod.file === INTERVIEW_BARREL) continue;
    for (const imp of mod.imports) {
      if (imp.target !== INTERVIEW_BARREL) continue;
      const typeOnly = isTypeOnlyImport(imp);
      if (runtimeOnly && typeOnly) continue;
      found.push({ file: mod.file, specifier: imp.specifier, typeOnly });
    }
    for (const re of mod.reexports) {
      if (re.target !== INTERVIEW_BARREL) continue;
      if (runtimeOnly && re.typeOnly) continue;
      found.push({ file: mod.file, specifier: re.specifier, typeOnly: re.typeOnly });
    }
  }
  return found.sort(
    (a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier),
  );
}

// ── Baseline ──────────────────────────────────────────────────────────

/** Build the baseline payload from the live barrel surface. */
export function buildBaseline(
  repoRoot: string,
  barrel: string = INTERVIEW_BARREL,
): SplitBaseline {
  const index = loadModuleIndex(repoRoot, FAMILY_ROOTS);
  const kinds = collectExportKinds(index, barrel);
  return {
    version: 1,
    provenance: {
      generatedBy: BASELINE_GENERATION_COMMAND,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      generatedAt: new Date().toISOString(),
      barrel,
      consumerGlobs: CONSUMER_ROOTS.map((root) => `${root}/**/*.ts`),
    },
    symbols: {
      // `default` is asserted separately (it must stay the command's default
      // export); the named surface is the 29 value + 12 type symbols.
      value: namesOfKind(kinds, 'value').filter((name) => name !== 'default'),
      type: namesOfKind(kinds, 'type'),
    },
  };
}

/** Read + parse a committed baseline ({@link BASELINE_PATH} by default). */
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
