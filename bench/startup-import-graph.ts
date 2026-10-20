/**
 * Static import-graph walker for the startup import budget
 * (F2 — WL-0MVFRRAXD001E7AN).
 *
 * Walks the *runtime* static imports reachable from an entry module so the
 * startup budget can ratchet the fast path's import graph (parent AC1:
 * cache hits and `--version` must not load command modules, the DB runtime or
 * plugins). The walk is deliberately narrow:
 *
 *   - followed: `import ... from '…'`, `export ... from '…'`,
 *     `import x = require('…')` (value imports only);
 *   - ignored: `import type` / `export type` (erased by tsc, so they cost
 *     nothing at runtime) and dynamic `import('…')` / `require('…')` calls
 *     (deferring those is exactly what the split entry point relies on);
 *   - bare specifiers (`fs`, `commander`, `@worklog/shared`, …) are recorded
 *     separately as `external` — the ratchet tracks repository modules, whose
 *     import graph is what the startup work controls;
 *   - a relative specifier that cannot be resolved is a hard error: a silently
 *     incomplete graph would let a module slip past the ratchet.
 *
 * NodeNext ESM specifiers end in `.js` while the source is `.ts`, so the
 * resolver maps `.js` → `.ts`/`.tsx`/`.mts`/`.cts` first.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as ts from 'typescript';

/** The entry module whose static imports define the startup graph. */
export const CLI_ENTRY = 'src/cli.ts';

/** Repository-relative module list plus the external packages it imports. */
export interface ImportGraph {
  /** Entry module, repository-relative (`src/cli.ts`). */
  entry: string;
  /** Sorted, de-duplicated repository-relative module files (includes the entry). */
  modules: string[];
  /** Sorted bare specifiers encountered (`node:*`, packages, builtins). */
  external: string[];
}

export interface ImportGraphOptions {
  /** Entry module, repository-relative. Defaults to `src/cli.ts`. */
  entry?: string;
  /** Repository root. Defaults to the parent of this module's directory. */
  repoRoot?: string;
}

/** Repository-relative POSIX path (stable across platforms and in diffs). */
function relativeTo(repoRoot: string, absolute: string): string {
  return path.relative(repoRoot, absolute).split(path.sep).join('/');
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** TypeScript script kind for a source file extension. */
function scriptKindFor(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/** Resolve a relative specifier to an existing file, or `null`. */
export function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const extension = path.extname(base);
  const candidates: string[] = [];

  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    // NodeNext ESM: a `.js` specifier refers to the TypeScript source.
    const stem = base.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, base);
  } else if (extension === '.ts' || extension === '.tsx' || extension === '.json') {
    candidates.push(base);
  } else {
    for (const ext of SOURCE_EXTENSIONS) candidates.push(`${base}${ext}`);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Static, runtime import specifiers of one source file.
 *
 * Exported for the ratchet test's focused unit coverage.
 */
export function staticImportSpecifiers(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(file)
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      // `import type { X } from '…'` is erased and costs nothing at runtime.
      if ((!clause || !clause.isTypeOnly) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(reference) &&
        reference.expression &&
        ts.isStringLiteral(reference.expression)
      ) {
        specifiers.push(reference.expression.text);
      }
    }
    // Dynamic `import()` / `require()` are intentionally not followed: keeping
    // them out of the startup graph is the point of the split entry point.
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

/**
 * Walk the transitive static (runtime) import graph of `entry`.
 *
 * @throws when a relative import cannot be resolved, so an incomplete graph
 *   can never be mistaken for a compliant one.
 */
export function walkStaticImportGraph(options: ImportGraphOptions = {}): ImportGraph {
  const repoRoot = path.resolve(
    options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  );
  const entryAbsolute = path.resolve(repoRoot, options.entry ?? CLI_ENTRY);
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue: string[] = [entryAbsolute];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    // JSON imports are statically loaded but cannot import anything further.
    if (!SOURCE_EXTENSIONS.includes(path.extname(file))) continue;

    let source: string;
    try {
      source = fs.readFileSync(file, 'utf-8');
    } catch (error) {
      throw new Error(
        `startup import graph: cannot read ${relativeTo(repoRoot, file)}: ${(error as Error).message}`
      );
    }

    for (const specifier of staticImportSpecifiers(file, source)) {
      if (!specifier.startsWith('.')) {
        external.add(specifier);
        continue;
      }
      const resolved = resolveRelativeImport(file, specifier);
      if (resolved === null) {
        throw new Error(
          `startup import graph: unresolved relative import '${specifier}' in ` +
            `${relativeTo(repoRoot, file)} — update bench/startup-import-graph.ts if this ` +
            'module uses a non-standard extension'
        );
      }
      if (resolved.startsWith(`${repoRoot}${path.sep}`)) {
        queue.push(resolved);
      } else {
        // Relative import escaping the repository: record it as external.
        external.add(specifier);
      }
    }
  }

  const modules = [...seen].map((file) => relativeTo(repoRoot, file)).sort();
  return {
    entry: relativeTo(repoRoot, entryAbsolute),
    modules,
    external: [...external].sort(),
  };
}
