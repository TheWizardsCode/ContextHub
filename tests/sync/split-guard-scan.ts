/**
 * tests/sync/split-guard-scan.ts — static scanners and gate predicates for the
 * `src/sync.ts` split invariants.
 *
 * Parent: WL-0MVGKGMU400631VZ (decompose the `src/sync.ts` god class).
 * Guard item: WL-0MVP9MSJO0099V0G — child 1 of 6, lands **before** any
 * production code moves.
 *
 * ## Module responsibility
 *
 * Every extraction child (2–6) moves code out of `src/sync.ts` without touching
 * a single existing test file, so the unchanged suite (77 files) is the
 * behaviour gate. Nothing in the repository enforced the *structural* half of
 * the contract — an unchanged public surface at `./sync.js`, a 1,000-line
 * ceiling, and an acyclic import graph — and the only existing split guards
 * (`packages/herdr`, `packages/shared`) are scoped to their own packages. This
 * module provides the root-package enforcement:
 *
 * 1. **Public surface (AC2).** The committed baseline freezes the barrel's
 *    exported symbol names, split into value exports (resolvable at runtime)
 *    and type exports (present in the emitted declaration). A move-only split
 *    may re-home a symbol but may never drop one.
 * 2. **Module size (AC1).** Every top-level `src/sync*.ts` module and every
 *    module under `src/sync/` stays ≤ {@link MAX_MODULE_LINES};
 *    {@link SPLIT_ALLOWLIST}
 *    is shrink-only against a plan-time ceiling.
 * 3. **Import graph (AC4).** The static import graph of the sync family is
 *    acyclic, no family module imports the barrel at runtime, and the single
 *    pre-existing `merge-utils.ts` type-only barrel import sits in
 *    {@link TYPE_ONLY_BARREL_ALLOWLIST} for child 2 to remove.
 *
 * The gates live here as **pure predicates over parsed modules** rather than as
 * assertions over the live tree, so `split-guard.test.ts` can prove each gate
 * actually fails on a deliberately broken input (AC7) — an untested guard is a
 * guard that silently rots.
 *
 * Parsing uses the TypeScript compiler API (syntax only — no program, no type
 * checker, no network) because the gates must distinguish runtime (value)
 * imports from type-only ones, classify exports as values vs types, follow
 * `export *` re-export chains and read multi-line import/export clauses. Text
 * matching cannot do that reliably.
 *
 * ## Baseline generation (AC2 provenance)
 *
 *   npx tsx tests/sync/split-guard-scan.ts --write-baseline
 *
 * writes `tests/sync/sync.split-baseline.json` with the barrel's exported
 * symbol names split into `value` and `type` plus provenance (generation
 * command, source commit, timestamp, barrel path, consumer globs). Re-run it
 * only when the public surface is *deliberately* changed; the committed file is
 * the frozen contract the public-surface gate enforces.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every consumer imports. */
export const SYNC_BARREL = 'src/sync.ts';

/** Directory extracted sync modules live in. */
export const SYNC_SPLIT_DIR = 'src/sync';

/** Repository-relative path of the committed public-surface baseline (AC2). */
export const BASELINE_PATH = 'tests/sync/sync.split-baseline.json';

/** Per-module line ceiling (AC1). */
export const MAX_MODULE_LINES = 1000;

/**
 * Family modules currently exempt from the size gate.
 *
 * A *shrink-only* allowlist: it may only ever lose entries. It starts with the
 * 1,867-line monolith; the final barrel child removes it once `src/sync.ts` is
 * a thin re-export façade.
 */
export const SPLIT_ALLOWLIST: readonly string[] = ['sync.ts'];

/**
 * The allowlist as it stood at plan time. {@link SPLIT_ALLOWLIST} must remain a
 * subset of this, so "the split regrows into a collection of oversized modules"
 * is a test failure rather than a review finding.
 */
export const SPLIT_ALLOWLIST_CEILING: readonly string[] = ['sync.ts'];

/**
 * Family modules permitted to import the barrel with a (type-only) edge.
 *
 * Was `['src/sync/merge-utils.ts']` while that module still imported
 * `type { MergeOptions } from '../sync.js'` (recorded 2026-10-26, `dev` @
 * `f40fcd7a`). Child 2 re-pointed it at `src/sync/types.ts`, removing the
 * entry and the import together (WL-0MVP9PCOU004L8HN AC4). Any family module
 * importing the barrel — type-only or runtime — is a layering violation.
 */
export const TYPE_ONLY_BARREL_ALLOWLIST: readonly string[] = [];

/** Roots scanned for barrel consumers (static and dynamic imports). */
export const CONSUMER_ROOTS: readonly string[] = ['src', 'tests', 'scripts'];

/** Roots scanned for the live sync family (the graph and size gates). */
export const FAMILY_ROOTS: readonly string[] = ['src'];

/** Generation command recorded in the baseline provenance (AC2). */
export const BASELINE_GENERATION_COMMAND =
  'npx tsx tests/sync/split-guard-scan.ts --write-baseline';

// ── Parsed-module model ───────────────────────────────────────────────

/** Whether an exported symbol exists at runtime (`value`) or is erased (`type`). */
export type ExportKind = 'value' | 'type';

export interface ParsedImportName {
  /** The imported (exported-by-target) name, not the local alias. */
  name: string;
  typeOnly: boolean;
}

export interface ParsedImport {
  specifier: string;
  /** Repository-relative `.ts` path, or `null` for a bare specifier. */
  target: string | null;
  /** Whole-clause `import type { … }` or `import type X`. */
  typeOnly: boolean;
  hasDefault: boolean;
  namespace: boolean;
  names: ParsedImportName[];
}

export interface ParsedReexport {
  specifier: string;
  target: string | null;
  /** `export * from '…'` */
  all: boolean;
  typeOnly: boolean;
  /** Exported names for `export { a as b } from '…'`. */
  names: string[];
}

export interface LocalExportClause {
  local: string;
  exported: string;
  /** `export { type Foo }` — the clause marks the binding as type-only. */
  typeOnly: boolean;
}

export interface ParsedModule {
  /** Repository-relative POSIX path, e.g. `src/sync.ts`. */
  file: string;
  /** `wc -l` semantics: the number of newline characters. */
  lineCount: number;
  /** Module-scope declared names → kind, used to resolve local re-exports. */
  declarations: Map<string, ExportKind>;
  /** Names exported directly by an `export`-modified declaration. */
  localExports: string[];
  /** Local `export { a as b }` clauses (no module specifier). */
  localExportClauses: LocalExportClause[];
  reexports: ParsedReexport[];
  imports: ParsedImport[];
}

export interface ModuleIndex {
  repoRoot: string;
  /** Repository-relative POSIX path → parsed module. */
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
  symbols: {
    value: string[];
    type: string[];
  };
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

/** Names a top-level declaration statement introduces, with their export kind. */
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
 * Parse one module's source into the model the gates consume.
 *
 * `file` is used only for labelling and relative-specifier resolution, so
 * synthetic in-memory modules are parsed exactly like real ones (AC7).
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

  // `import('./sync.js').Foo` type positions are consumer usages too.
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
        // Local `export { a, b as c, type D }` — resolved against declarations.
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

    // Record every module-scope declaration (exported or not) so a local
    // re-export clause can resolve the kind of the name it forwards.
    const declared = declaredNames(stmt);
    for (const { name, kind } of declared) {
      if (!parsed.declarations.has(name)) parsed.declarations.set(name, kind);
    }

    if (!hasExportModifier(stmt)) continue;
    if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) parsed.localExports.push('default');
    for (const { name } of declared) parsed.localExports.push(name);
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

/** Raw consumer sources, keyed by repository-relative POSIX path. */
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

/**
 * True for a module of the sync family: the barrel, any top-level
 * `src/sync*.ts`, and anything under `src/sync/`.
 */
export function isSyncFamilyFile(file: string): boolean {
  const dir = path.posix.dirname(file);
  if (dir === 'src') return /^sync[^/]*\.ts$/.test(basename(file));
  return dir === SYNC_SPLIT_DIR || dir.startsWith(`${SYNC_SPLIT_DIR}/`);
}

/** Production modules of the sync family (the modules the size gate covers). */
export function splitFamilyModules(index: ModuleIndex): ParsedModule[] {
  return [...index.byFile.values()]
    .filter((m) => isSyncFamilyFile(m.file) && !isTestOrFixture(m.file))
    .sort((a, b) => a.file.localeCompare(b.file));
}

// ── Documentation standard (AC5) ─────────────────────────────────────

/**
 * True when a module opens with a top-level JSDoc block naming its concern.
 *
 * AC5 sets the standard the extraction children must follow: every extracted
 * module carries a header JSDoc naming its concern. The guard suite itself is
 * documented the same way, so the check is exercised from day one.
 */
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
 *
 * `memo` caches completed modules; `seen` breaks re-export cycles so a
 * pathological graph cannot recurse forever.
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
export function namesOfKind(
  kinds: Map<string, ExportKind>,
  kind: ExportKind,
): string[] {
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

/**
 * All symbols any consumer imports from the barrel, mapped to how it uses
 * them. Covers named imports, whole-clause type imports, per-specifier `type`
 * prefixes and `import('./sync.js').X` type positions.
 */
export function consumerImportNames(
  index: ModuleIndex,
  barrel: string = SYNC_BARREL,
): Map<string, { value: boolean; typeOnly: boolean }> {
  const usage = new Map<string, { value: boolean; typeOnly: boolean }>();
  for (const mod of index.byFile.values()) {
    if (mod.file === barrel) continue;
    for (const imp of mod.imports) {
      if (imp.target !== barrel) continue;
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

function dynamicImportSpecifierFromCall(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  return arg && ts.isStringLiteral(arg) ? arg.text : null;
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

/**
 * Symbols reached through dynamic `import('./sync.js')` calls.
 *
 * Covers the shapes the existing suites use:
 *
 *   const { a, b } = await import('./sync.js');
 *   (await import('./sync.js')).c
 */
export function dynamicImportNames(
  sources: Map<string, string> | Record<string, string>,
  barrel: string = SYNC_BARREL,
): Map<string, { value: boolean; typeOnly: boolean }> {
  const entries = sources instanceof Map ? [...sources] : Object.entries(sources);
  const usage = new Map<string, { value: boolean; typeOnly: boolean }>();
  const add = (name: string): void => {
    usage.set(name, { value: true, typeOnly: false });
  };

  for (const [file, source] of entries) {
    // Cheap pre-filter: a dynamic import of the barrel must mention `sync`.
    if (!source.includes('sync')) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const targetsBarrel = (call: ts.CallExpression): boolean => {
      const specifier = dynamicImportSpecifierFromCall(call);
      return specifier !== null && resolveImportTarget(file, specifier) === barrel;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (targetsBarrel(node)) {
          let parent: ts.Node = node;
          while (parent.parent && ts.isAwaitExpression(parent.parent)) parent = parent.parent;
          while (parent.parent && ts.isParenthesizedExpression(parent.parent)) {
            parent = parent.parent;
          }
          const holder = parent.parent;
          if (holder && ts.isPropertyAccessExpression(holder) && holder.expression === parent) {
            add(holder.name.text);
          } else if (
            holder &&
            ts.isVariableDeclaration(holder) &&
            ts.isObjectBindingPattern(holder.name)
          ) {
            for (const el of holder.name.elements) {
              if (ts.isIdentifier(el.name)) {
                const imported = el.propertyName;
                add(imported && ts.isIdentifier(imported) ? imported.text : el.name.text);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return usage;
}

/** Every symbol a consumer reaches through the barrel (static + dynamic). */
export function liveConsumerImportNames(
  index: ModuleIndex,
  sources: Map<string, string> | Record<string, string>,
  barrel: string = SYNC_BARREL,
): Map<string, { value: boolean; typeOnly: boolean }> {
  return mergeUsage(consumerImportNames(index, barrel), dynamicImportNames(sources, barrel));
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
    .filter((m) => !allowed.has(basename(m.file)))
    .filter((m) => m.lineCount > max)
    .map((m) => ({ file: m.file, lineCount: m.lineCount }));
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

export interface GraphOptions {
  /** Drop the type-only barrel edges declared in {@link TYPE_ONLY_BARREL_ALLOWLIST}. */
  dropAllowlistedTypeOnlyBarrelEdges?: boolean;
  /** Keep only runtime (value) edges. */
  runtimeOnly?: boolean;
}

/**
 * Static import graph over the sync family, including re-export edges
 * (`export * from` is treated as runtime — it may re-export values).
 */
export function buildImportGraph(
  index: ModuleIndex,
  options: GraphOptions = {},
): Map<string, GraphEdge[]> {
  const family = new Set(splitFamilyModules(index).map((m) => m.file));
  const allowlisted = new Set(TYPE_ONLY_BARREL_ALLOWLIST);
  const graph = new Map<string, GraphEdge[]>();

  for (const file of family) {
    const mod = index.byFile.get(file)!;
    const edges: GraphEdge[] = [];
    const push = (to: string | null, typeOnly: boolean): void => {
      if (!to || !family.has(to) || to === file) return;
      if (options.runtimeOnly && typeOnly) return;
      if (
        options.dropAllowlistedTypeOnlyBarrelEdges &&
        typeOnly &&
        to === SYNC_BARREL &&
        allowlisted.has(file)
      ) {
        return;
      }
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

/** Cycles in the full (value + type) sync-family import graph. */
export function findStaticCycles(index: ModuleIndex): string[][] {
  return cyclesOf(buildImportGraph(index));
}

/**
 * Cycles in the static graph after removing the allowlisted type-only barrel
 * edges. This is the gate's acyclicity check: the only tolerated cycle is the
 * one recorded in {@link TYPE_ONLY_BARREL_ALLOWLIST}.
 */
export function findUnexplainedStaticCycles(index: ModuleIndex): string[][] {
  return cyclesOf(buildImportGraph(index, { dropAllowlistedTypeOnlyBarrelEdges: true }));
}

/** Cycles in the **runtime** import graph (type-only edges removed). */
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
    if (mod.file === SYNC_BARREL) continue;
    for (const imp of mod.imports) {
      if (imp.target !== SYNC_BARREL) continue;
      const typeOnly = isTypeOnlyImport(imp);
      if (runtimeOnly && typeOnly) continue;
      found.push({ file: mod.file, specifier: imp.specifier, typeOnly });
    }
    for (const re of mod.reexports) {
      if (re.target !== SYNC_BARREL) continue;
      if (runtimeOnly && re.typeOnly) continue;
      found.push({ file: mod.file, specifier: re.specifier, typeOnly: re.typeOnly });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier));
}

/**
 * Type-only barrel imports from modules that are **not** in
 * {@link TYPE_ONLY_BARREL_ALLOWLIST} — the layering violation child 2 must not
 * leave behind, and no later child may introduce.
 */
export function findBarrelTypeOnlyImportsOutsideAllowlist(
  index: ModuleIndex,
): BarrelImport[] {
  const allowlisted = new Set(TYPE_ONLY_BARREL_ALLOWLIST);
  return findBarrelImports(index).filter(
    (imp) => imp.typeOnly && !allowlisted.has(imp.file),
  );
}

/**
 * Allowlist entries whose recorded type-only barrel import has vanished.
 *
 * Without this, the allowlist could rot into a stale exemption; child 2 removes
 * the import and the entry together.
 */
export function findAbsentAllowlistedBarrelImports(
  index: ModuleIndex,
  allowlist: readonly string[] = TYPE_ONLY_BARREL_ALLOWLIST,
): string[] {
  const present = new Set(
    findBarrelImports(index)
      .filter((imp) => imp.typeOnly)
      .map((imp) => imp.file),
  );
  return allowlist.filter((file) => !present.has(file)).sort();
}

// ── Baseline ──────────────────────────────────────────────────────────

/** Build the baseline payload from the live barrel surface. */
export function buildBaseline(
  repoRoot: string,
  barrel: string = SYNC_BARREL,
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
      value: namesOfKind(kinds, 'value'),
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
