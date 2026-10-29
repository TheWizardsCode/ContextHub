/**
 * packages/herdr/test/split-guard/worklist-family.ts — config, dynamic-import
 * scanner and baseline producer for the `packages/herdr/src/worklist.ts` split
 * guard.
 *
 * Parent: WL-0MVGKGD2Y0038S6B (decompose the `worklist.ts` god class).
 * Guard item: WL-0MVND6BL30066V6B (this file's owning work item).
 *
 * ## Why this module exists
 *
 * Every extraction child moves code out of `packages/herdr/src/worklist.ts`
 * without touching a single test file. The 24 unchanged `worklist*.test.ts`
 * suites are the behaviour-preservation gate — but nothing in the repository
 * enforces the *structural* half of the contract (unchanged public surface, a
 * single `WorkItemListState` owner, no new barrel/cycle regressions, a module
 * line ceiling). Those gates are supplied by the parameterised predicates in
 * the sibling `scan.ts` (see {@link WORKLIST_CONFIG}); this module holds only
 * worklist-specific data plus the two things `scan.ts` cannot express:
 *
 * 1. the **dynamic-import** consumer scan — `worklist.test.ts` and
 *    `tests/herdr/shortcuts.test.ts` reach the barrel through
 *    `const wl = await import('./worklist.js')` and then `wl.symbol`. A
 *    static-only baseline would miss `applyNoteEditToFile`, so extracting it
 *    without a barrel re-export would pass the structural guard and fail only
 *    the full suite.
 * 2. the **split baseline** — symbols consumers actually import, split into the
 *    ones the barrel exports (the frozen contract) and the pre-existing gaps it
 *    never exported (recorded reality, shrink-only).
 *
 * ## Baseline generation (provenance)
 *
 *   npx tsx packages/herdr/test/split-guard/worklist-family.ts --write-baseline
 *
 * writes `packages/herdr/src/worklist.split-baseline.json`. Re-run it only when
 * the consumer surface is *deliberately* changed; the committed file is the
 * frozen contract the public-surface gate enforces.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  CONSUMER_ROOTS,
  MAX_MODULE_LINES,
  collectExportedNames,
  consumerImportNames,
  loadConsumerSources,
  loadModuleIndex,
  resolveImportTarget,
  type ModuleIndex,
  type SplitFamilyConfig,
} from './scan.js';

// ── Contract constants ────────────────────────────────────────────────

/** Repository-relative path of the barrel every worklist consumer imports. */
export const WORKLIST_BARREL = 'packages/herdr/src/worklist.ts';

/** Directory the split's modules live in. */
export const WORKLIST_FAMILY_DIR = 'packages/herdr/src';

/**
 * A worklist-family file: `worklist.ts` plus any `worklist.<slice>.ts`
 * extracted module. Test/fixture files (`worklist.split-guard.test.ts`, …) match
 * too but are excluded by `productionModules` when the gates run.
 */
export const WORKLIST_FAMILY_PATTERN = /^worklist[^/]*\.ts$/;

/** Repository-relative path of the committed consumer-symbol baseline. */
export const WORKLIST_BASELINE_PATH = 'packages/herdr/src/worklist.split-baseline.json';

/** Per-module line ceiling (parent AC1). Re-exported from `scan.ts`. */
export { MAX_MODULE_LINES };

/**
 * Files currently exempt from the size gate.
 *
 * This is a *shrink-only* allowlist: it may only ever lose entries, never gain
 * them. `worklist.ts` is the not-yet-split monolith; the final barrel child
 * empties the list once the split is complete.
 */
export const WORKLIST_SPLIT_ALLOWLIST: readonly string[] = ['worklist.ts'];

/**
 * The allowlist as it stood at plan time. {@link WORKLIST_SPLIT_ALLOWLIST} must
 * remain a subset of this, which makes "grows back into a collection of
 * oversized modules" a test failure rather than a review finding.
 */
export const WORKLIST_SPLIT_ALLOWLIST_CEILING: readonly string[] = ['worklist.ts'];

/**
 * Pre-existing import cycles involving a worklist-family module, recorded at
 * guard-creation time (`dev` @ guard creation).
 *
 * `packages/herdr/src/worklist.ts` already sits inside one mixed value/type
 * component: it imports values from `fetcher.ts`, and `fetcher.ts` imports
 * `STAGES` (a value) back from the barrel. That cycle predates this epic; the
 * gate forbids *new* members or components (AC3), not the recorded one.
 */
export const WORKLIST_CYCLE_BASELINE: readonly (readonly string[])[] = [
  [
    'packages/herdr/src/agent-tracker.ts',
    'packages/herdr/src/code-freeze.ts',
    'packages/herdr/src/dispatch-view.ts',
    'packages/herdr/src/downtime-worker.ts',
    'packages/herdr/src/fetcher.ts',
    'packages/herdr/src/hydrator.ts',
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
 * Pre-existing **runtime** (value-only) cycles.
 *
 * The `worklist → fetcher → worklist` edges are both value imports, so the
 * component above is a genuine runtime cycle today. The split must not add a
 * member or a new runtime cycle; shrinking this component is always allowed.
 */
export const WORKLIST_RUNTIME_CYCLE_BASELINE: readonly (readonly string[])[] =
  WORKLIST_CYCLE_BASELINE;

/** Edges of the recorded cycle that must stay type-only (none today). */
export const WORKLIST_TYPE_ONLY_EDGES: readonly { from: string; to: string }[] = [];

/**
 * The mutable list state must live in exactly one production module at all
 * times (parent AC5). Duplicating it would fork the source of truth.
 */
export const SINGLE_OWNER_DECLARATION = 'WorkItemListState';

/**
 * Symbols consumers import from the barrel that it does **not** export today.
 *
 * Recorded reality, not a target: four test files use
 * `import type { WorkItem } from './worklist.js'` even though `worklist.ts`
 * only imports `WorkItem` from `./fetcher.js`. Vitest does not typecheck and the
 * herdr tsconfig excludes test files, so the gap has never failed a gate. The
 * guard records it (and forbids *new* gaps) rather than widening the barrel
 * during a move-only refactor.
 */
export const KNOWN_MISSING_CONSUMER_EXPORTS: readonly string[] = ['WorkItem'];

/** The pre-existing gap list as recorded at guard creation (shrink-only). */
export const KNOWN_MISSING_CONSUMER_EXPORTS_CEILING: readonly string[] = ['WorkItem'];

/** Generation command recorded in the baseline provenance. */
export const WORKLIST_BASELINE_COMMAND =
  'npx tsx packages/herdr/test/split-guard/worklist-family.ts --write-baseline';

/** The worklist split's inputs to the shared, family-agnostic gate predicates. */
export const WORKLIST_CONFIG: SplitFamilyConfig = {
  barrel: WORKLIST_BARREL,
  familyDir: WORKLIST_FAMILY_DIR,
  familyPattern: WORKLIST_FAMILY_PATTERN,
  baselinePath: WORKLIST_BASELINE_PATH,
  allowlist: WORKLIST_SPLIT_ALLOWLIST,
  allowlistCeiling: WORKLIST_SPLIT_ALLOWLIST_CEILING,
  cycleBaseline: WORKLIST_CYCLE_BASELINE,
  typeOnlyEdges: WORKLIST_TYPE_ONLY_EDGES,
  runtimeCycleBaseline: WORKLIST_RUNTIME_CYCLE_BASELINE,
  singleOwnerDeclaration: SINGLE_OWNER_DECLARATION,
  baselineCommand: WORKLIST_BASELINE_COMMAND,
  consumerRoots: CONSUMER_ROOTS,
};

// ── Dynamic-import consumer scan ──────────────────────────────────────

export interface ConsumerUsage {
  value: boolean;
  typeOnly: boolean;
}

function mergeUsage(
  ...maps: Map<string, ConsumerUsage>[]
): Map<string, ConsumerUsage> {
  const merged = new Map<string, ConsumerUsage>();
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

/** `import('<barrel>')` unwrapped from `await`, parentheses and casts. */
function unwrapDynamicImport(expr: ts.Expression | undefined): ts.CallExpression | null {
  let node: ts.Expression | undefined = expr;
  while (
    node &&
    (ts.isAwaitExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node))
  ) {
    node = node.expression;
  }
  if (node && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return node;
  }
  return null;
}

/**
 * Symbols reached through a dynamic `import('<barrel>')` call.
 *
 * Covers the shapes the existing suites use:
 *
 *   const wl = await import('./worklist.js'); wl.symbol
 *   const { a, b } = await import('./worklist.js');
 *   (await import('./worklist.js')).symbol
 *
 * The static scanner (`consumerImportNames`) cannot see any of these, so a
 * symbol reachable only this way would silently fall out of the frozen surface.
 */
export function dynamicImportNames(
  sources: Map<string, string> | Record<string, string>,
  barrel: string = WORKLIST_BARREL,
): Map<string, ConsumerUsage> {
  const entries = sources instanceof Map ? [...sources] : Object.entries(sources);
  const usage = new Map<string, ConsumerUsage>();
  const add = (name: string): void => {
    usage.set(name, { value: true, typeOnly: false });
  };

  for (const [file, source] of entries) {
    // `setParentNodes: true` — the scan reads `.parent` to classify each
    // `import(barrel)` call by the binding/property context that consumes it.
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const targetsBarrel = (call: ts.CallExpression): boolean => {
      const arg = call.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) return false;
      return resolveImportTarget(file, arg.text) === barrel;
    };

    // Module aliases: `const wl = await import('./worklist.js')`.
    //
    // Tracked per identifier, not per declaration: `alias` only counts when
    // *every* declaration of that identifier in the file is a barrel alias.
    // Files routinely reuse a name (`mod` aliases `worklist.js` in one test and
    // `shortcut-config.js` in another), and treating such a name as an alias
    // would attribute unrelated property accesses to the barrel.
    const aliasCandidates = new Map<string, boolean>();
    const visitAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const call = unwrapDynamicImport(node.initializer);
        const isBarrelAlias = call !== null && targetsBarrel(call);
        const previous = aliasCandidates.get(node.name.text);
        aliasCandidates.set(
          node.name.text,
          previous === undefined ? isBarrelAlias : previous && isBarrelAlias,
        );
      }
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(sf);
    const aliases = new Set(
      [...aliasCandidates].filter(([, isAlias]) => isAlias).map(([name]) => name),
    );

    // Alias property access, immediate property access and destructuring.
    const visitUsage = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        if (ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) {
          add(node.name.text);
        } else {
          const call = unwrapDynamicImport(node.expression);
          if (call && targetsBarrel(call)) add(node.name.text);
        }
      }

      if (ts.isVariableDeclaration(node) && node.initializer) {
        const call = unwrapDynamicImport(node.initializer);
        if (call && targetsBarrel(call) && ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isIdentifier(el.name)) {
              const imported = el.propertyName;
              add(imported && ts.isIdentifier(imported) ? imported.text : el.name.text);
            }
          }
        }
      }

      ts.forEachChild(node, visitUsage);
    };
    visitUsage(sf);
  }

  return usage;
}

/** Every symbol a consumer reaches through the barrel (static + dynamic). */
export function worklistConsumerImportNames(
  index: ModuleIndex,
  sources: Map<string, string> | Record<string, string>,
  barrel: string = WORKLIST_BARREL,
): Map<string, ConsumerUsage> {
  return mergeUsage(consumerImportNames(index, barrel), dynamicImportNames(sources, barrel));
}

// ── Baseline ──────────────────────────────────────────────────────────

export interface WorklistSplitBaseline {
  provenance: {
    generatedBy: string;
    sourceCommit: string;
    generatedAt: string;
    barrel: string;
    consumerGlobs: string[];
  };
  /** Consumed symbols the barrel exports: the frozen public surface. */
  symbols: string[];
  /** Consumed symbols the barrel does not export (pre-existing gaps). */
  unexportedConsumerSymbols: string[];
}

/** Build the baseline payload from the live tree. */
export function buildWorklistBaseline(repoRoot: string): WorklistSplitBaseline {
  const index = loadModuleIndex(repoRoot, WORKLIST_CONFIG.consumerRoots);
  const consumed = [...worklistConsumerImportNames(index, loadConsumerSources(repoRoot)).keys()].sort();
  const exported = collectExportedNames(index, WORKLIST_BARREL);
  return {
    provenance: {
      generatedBy: WORKLIST_BASELINE_COMMAND,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      generatedAt: new Date().toISOString(),
      barrel: WORKLIST_BARREL,
      consumerGlobs: WORKLIST_CONFIG.consumerRoots.map((root) => `${root}/**/*.ts`),
    },
    symbols: consumed.filter((name) => exported.has(name)),
    unexportedConsumerSymbols: consumed.filter((name) => !exported.has(name)),
  };
}

/** Read + parse the committed baseline. */
export function readWorklistBaseline(repoRoot: string): WorklistSplitBaseline {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, WORKLIST_BASELINE_PATH), 'utf-8'),
  ) as WorklistSplitBaseline;
}

/** Write the baseline to {@link WORKLIST_BASELINE_PATH}; returns the payload written. */
export function writeWorklistBaseline(repoRoot: string): WorklistSplitBaseline {
  const baseline = buildWorklistBaseline(repoRoot);
  fs.writeFileSync(
    path.join(repoRoot, WORKLIST_BASELINE_PATH),
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
    console.error(`usage: ${WORKLIST_BASELINE_COMMAND}`);
    process.exit(2);
  }
  const baseline = writeWorklistBaseline(repoRoot);
  console.log(
    `wrote ${WORKLIST_BASELINE_PATH}: ${baseline.symbols.length} symbols ` +
      `(+${baseline.unexportedConsumerSymbols.length} unexported) ` +
      `@ ${baseline.provenance.sourceCommit.slice(0, 8)}`,
  );
}
