/**
 * packages/herdr/src/worklist.split-guard.test.ts — automated gate for the
 * `packages/herdr/src/worklist.ts` split invariants.
 *
 * Parent: WL-0MVGKGD2Y0038S6B (decompose the `worklist.ts` god class).
 * Work item: WL-0MVND6BL30066V6B (test-first guard, landed before any code
 * moves).
 *
 * ## What this file protects
 *
 * Every extraction child moves code out of `packages/herdr/src/worklist.ts`
 * without touching a single test file. That makes the 24 `worklist*.test.ts`
 * suites the behaviour-preservation gate — but nothing in the repository
 * enforced the *structural* half of the contract (unchanged public surface, a
 * single `WorkItemListState`, no new barrel runtime import / cycle, module line
 * ceiling). These tests are that enforcement.
 *
 * The gates are **additive** and read-only: they scan the module tree with the
 * TypeScript parser (via `../test/split-guard/scan.js` and the worklist config
 * in `../test/split-guard/worklist-family.js`) and assert. Nothing here
 * modifies the tree, the barrel or any other test file.
 *
 * ## Gate → parent acceptance criterion mapping
 *
 * | Gate | Parent AC |
 * |---|---|
 * | baseline + current-consumer public surface | AC2, AC3 |
 * | single `WorkItemListState` declaration | AC5 |
 * | no runtime barrel import / no new or runtime cycle | AC4, AC5 |
 * | ≤ 1,000 lines per module, shrink-only allowlist | AC1 |
 *
 * ## Re-baselining
 *
 * `packages/herdr/src/worklist.split-baseline.json` is a *frozen* contract:
 * regenerate it deliberately, never to make a red gate green.
 *
 *   npx tsx packages/herdr/test/split-guard/worklist-family.ts --write-baseline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  MAX_MODULE_LINES,
  basename,
  collectExportedNames,
  consumerImportNames,
  countDeclarations,
  findAllowlistViolations,
  findBarrelValueImports,
  findCycleBaselineViolations,
  findDeclarationModules,
  findMissingExports,
  findOversizedModules,
  findRuntimeCycles,
  findSplitFamilyCycles,
  findUnexportedConsumerImports,
  indexFromSources,
  loadConsumerSources,
  loadModuleIndex,
  splitFamilyModules,
} from '../test/split-guard/scan.js';
import {
  KNOWN_MISSING_CONSUMER_EXPORTS,
  KNOWN_MISSING_CONSUMER_EXPORTS_CEILING,
  SINGLE_OWNER_DECLARATION,
  WORKLIST_BARREL,
  WORKLIST_BASELINE_PATH,
  WORKLIST_CONFIG,
  WORKLIST_CYCLE_BASELINE,
  WORKLIST_RUNTIME_CYCLE_BASELINE,
  WORKLIST_SPLIT_ALLOWLIST,
  WORKLIST_SPLIT_ALLOWLIST_CEILING,
  dynamicImportNames,
  readWorklistBaseline,
  worklistConsumerImportNames,
} from '../test/split-guard/worklist-family.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `'// pad\n'.repeat(n)` yields a file whose `wc -l` is exactly `n`. */
function lines(n: number): string {
  return '// pad\n'.repeat(n);
}

// ── Gates against the live tree ───────────────────────────────────────

describe('worklist split guard — live tree', () => {
  const index = loadModuleIndex(repoRoot);
  const consumers = worklistConsumerImportNames(index, loadConsumerSources(repoRoot));
  const exported = collectExportedNames(index, WORKLIST_BARREL);

  it('keeps every baseline symbol exported by the barrel (public surface)', () => {
    const baseline = readWorklistBaseline(repoRoot);

    expect(exported.size).toBeGreaterThan(0);
    // A lost re-export is exactly the failure a move-only split invites.
    expect(findMissingExports(baseline.symbols, exported)).toEqual([]);
  });

  it('exports every symbol the current consumers import, bar recorded gaps', () => {
    // Live counterpart of the frozen baseline: it catches a consumer that
    // starts importing a symbol the barrel never re-exports (e.g. a symbol
    // that stayed behind in an extracted module as internal-only).
    expect(findUnexportedConsumerImports(index, WORKLIST_BARREL, KNOWN_MISSING_CONSUMER_EXPORTS)).toEqual([]);
    // The pre-existing gap list is recorded reality and only ever shrinks.
    for (const name of KNOWN_MISSING_CONSUMER_EXPORTS) {
      expect(KNOWN_MISSING_CONSUMER_EXPORTS_CEILING).toContain(name);
    }
  });

  it('discovers symbols reached only through a dynamic import()', () => {
    // `applyNoteEditToFile` is never imported statically: `worklist.test.ts`
    // reaches it through `const wl = await import('./worklist.js')`. A
    // static-only surface would let an extraction drop it from the barrel.
    const dynamic = dynamicImportNames(loadConsumerSources(repoRoot), WORKLIST_BARREL);
    expect(dynamic.has('applyNoteEditToFile')).toBe(true);
    expect(dynamic.has('WorkItemListState')).toBe(true);
    expect(consumers.has('applyNoteEditToFile')).toBe(true);
  });

  it('declares the list state in exactly one production module', () => {
    const modules = splitFamilyModules(index, WORKLIST_CONFIG);
    expect(modules.length).toBeGreaterThan(0);
    expect(findDeclarationModules(modules, SINGLE_OWNER_DECLARATION)).toHaveLength(1);
    expect(countDeclarations(modules, SINGLE_OWNER_DECLARATION)).toBe(1);
  });

  it('has no worklist-family module importing the barrel at runtime', () => {
    // Extracted modules import concrete siblings; the barrel is a downstream
    // consumer of them, so a value import of the barrel inverts the layering.
    expect(findBarrelValueImports(index, WORKLIST_CONFIG)).toEqual([]);
  });

  it('adds no import cycle outside the recorded baseline', () => {
    expect(
      findCycleBaselineViolations(
        findSplitFamilyCycles(index, WORKLIST_CONFIG),
        WORKLIST_CYCLE_BASELINE,
      ),
    ).toEqual([]);
  });

  it('adds no runtime (value) import cycle outside the recorded baseline', () => {
    // The recorded `worklist ↔ fetcher` value cycle predates the split; any
    // component beyond it (or any new member) is a regression.
    expect(WORKLIST_RUNTIME_CYCLE_BASELINE.length).toBeGreaterThan(0);
    expect(
      findCycleBaselineViolations(
        findRuntimeCycles(index, WORKLIST_CONFIG),
        WORKLIST_RUNTIME_CYCLE_BASELINE,
      ),
    ).toEqual([]);
  });

  it('keeps every worklist production module within the line ceiling', () => {
    const oversized = findOversizedModules(
      splitFamilyModules(index, WORKLIST_CONFIG),
      WORKLIST_SPLIT_ALLOWLIST,
    );
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
  });

  it('only ever shrinks the split allowlist', () => {
    expect(
      findAllowlistViolations(WORKLIST_SPLIT_ALLOWLIST, WORKLIST_SPLIT_ALLOWLIST_CEILING),
    ).toEqual([]);
    // The ceiling itself is the plan-time list: the monolith and nothing else.
    expect([...WORKLIST_SPLIT_ALLOWLIST_CEILING]).toEqual([basename(WORKLIST_BARREL)]);
  });
});

// ── The committed baseline artefact ───────────────────────────────────

describe('worklist split baseline', () => {
  const baseline = readWorklistBaseline(repoRoot);
  const index = loadModuleIndex(repoRoot);

  it('records a sorted, deduplicated symbol list', () => {
    expect(baseline.symbols.length).toBeGreaterThan(50);
    expect(baseline.symbols).toEqual([...baseline.symbols].sort());
    expect(new Set(baseline.symbols).size).toBe(baseline.symbols.length);
    for (const symbol of baseline.symbols) expect(symbol).toMatch(/^[\w$]+$/);
  });

  it('records provenance that makes the baseline reproducible', () => {
    expect(baseline.provenance.generatedBy).toContain('--write-baseline');
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.barrel).toBe(WORKLIST_BARREL);
    expect(baseline.provenance.consumerGlobs).toContain('packages/herdr/src/**/*.ts');
  });

  it('is committed where the guard loads it from', () => {
    expect(fs.existsSync(path.join(repoRoot, WORKLIST_BASELINE_PATH))).toBe(true);
    expect(WORKLIST_BASELINE_PATH).toBe('packages/herdr/src/worklist.split-baseline.json');
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });

  it('freezes every symbol a live consumer imports, exported or not', () => {
    const frozen = new Set([...baseline.symbols, ...baseline.unexportedConsumerSymbols]);
    const live = [...worklistConsumerImportNames(index, loadConsumerSources(repoRoot)).keys()];
    expect(live.filter((name) => !frozen.has(name))).toEqual([]);
  });

  it('records the pre-existing unexported consumer imports', () => {
    // Recorded reality, shrink-only: the list may lose `WorkItem` once the
    // barrel exports it, but it may never gain another gap.
    for (const name of baseline.unexportedConsumerSymbols) {
      expect(KNOWN_MISSING_CONSUMER_EXPORTS_CEILING).toContain(name);
    }
    expect(baseline.unexportedConsumerSymbols).toContain('WorkItem');
  });

  it('records a representative slice of the current surface', () => {
    // A stub or wrongly-scoped baseline would pass the size/format checks.
    expect(baseline.symbols).toContain('runWorklistTui');
    expect(baseline.symbols).toContain('WorkItemListState');
    expect(baseline.symbols).toContain('ANSI');
    expect(baseline.symbols).toContain('formatItemLine');
    // Reached only dynamically — the reason this baseline is not static-only.
    expect(baseline.symbols).toContain('applyNoteEditToFile');
  });
});

// ── Negative cases: each gate must fail on broken input (AC6) ─────────

describe('worklist split guard — gates fail on broken input', () => {
  it('reports a dropped export, and follows export * re-export chains', () => {
    const broken = indexFromSources({
      [WORKLIST_BARREL]: `export * from './worklist.state.js';\n`,
      'packages/herdr/src/worklist.state.ts': `export interface Kept {}\nexport type AlsoKept = 1;\n`,
    });
    expect(findMissingExports(['Kept', 'AlsoKept'], collectExportedNames(broken, WORKLIST_BARREL))).toEqual(
      [],
    );
    expect(
      findMissingExports(['Kept', 'Dropped'], collectExportedNames(broken, WORKLIST_BARREL)),
    ).toEqual(['Dropped']);
  });

  it('reports a symbol a consumer imports but the barrel no longer exports', () => {
    const broken = indexFromSources({
      [WORKLIST_BARREL]: `export const kept = 1;\n`,
      'src/cli.ts': `import { kept, gone } from '../packages/herdr/src/worklist.js';\nexport const x = [kept, gone];\n`,
    });
    expect(consumerImportNames(broken, WORKLIST_BARREL).has('gone')).toBe(true);
    expect(
      findUnexportedConsumerImports(broken, WORKLIST_BARREL, KNOWN_MISSING_CONSUMER_EXPORTS),
    ).toEqual(['gone']);
    // A recorded gap is tolerated, a new one is not.
    expect(
      findUnexportedConsumerImports(broken, WORKLIST_BARREL, ['gone']),
    ).toEqual([]);
  });

  it('discovers a symbol reached only through a module-alias dynamic import', () => {
    const sources = {
      'packages/herdr/src/worklist.test.ts': [
        `export const load = async () => {`,
        `  const wl = await import('./worklist.js');`,
        `  return wl.dynamicallyReached;`,
        `};`,
      ].join('\n'),
    };
    const usage = dynamicImportNames(sources, WORKLIST_BARREL);
    expect(usage.get('dynamicallyReached')).toEqual({ value: true, typeOnly: false });
  });

  it('discovers destructured and immediate dynamic-import property names', () => {
    const sources = {
      'packages/herdr/src/consumer.test.ts': [
        `export const load = async () => {`,
        `  const { destructured } = await import('./worklist.js');`,
        `  const immediate = (await import('./worklist.js')).immediateReached;`,
        `  return [destructured, immediate];`,
        `};`,
      ].join('\n'),
    };
    const usage = dynamicImportNames(sources, WORKLIST_BARREL);
    expect(usage.has('destructured')).toBe(true);
    expect(usage.has('immediateReached')).toBe(true);
  });

  it('reports a duplicated list-state declaration', () => {
    const broken = indexFromSources({
      'packages/herdr/src/worklist.state.ts': `export class WorkItemListState {}\n`,
      'packages/herdr/src/worklist.state-copy.ts': `class WorkItemListState {}\nexport const copy = WorkItemListState;\n`,
    });
    const modules = splitFamilyModules(broken, WORKLIST_CONFIG);
    expect(countDeclarations(modules, SINGLE_OWNER_DECLARATION)).toBe(2);
    expect(findDeclarationModules(modules, SINGLE_OWNER_DECLARATION)).toHaveLength(2);
  });

  it('reports a runtime import of the barrel from a worklist module', () => {
    const broken = indexFromSources({
      [WORKLIST_BARREL]: `export const shared = 1;\n`,
      'packages/herdr/src/worklist.state.ts': `import { shared } from './worklist.js';\nexport const local = shared;\n`,
    });
    expect(findBarrelValueImports(broken, WORKLIST_CONFIG)).toEqual([
      {
        file: 'packages/herdr/src/worklist.state.ts',
        specifier: './worklist.js',
      },
    ]);
  });

  it('permits a type-only import of the barrel (no runtime cycle)', () => {
    const allowed = indexFromSources({
      [WORKLIST_BARREL]: `export * from './worklist.types.js';\nexport const shared = 1;\n`,
      'packages/herdr/src/worklist.types.ts': `export interface Shared {}\n`,
      'packages/herdr/src/worklist.state.ts': `import type { Shared } from './worklist.js';\nexport const use = (s: Shared) => s;\n`,
    });
    expect(findBarrelValueImports(allowed, WORKLIST_CONFIG)).toEqual([]);
    expect(findRuntimeCycles(allowed, WORKLIST_CONFIG)).toEqual([]);
  });

  it('reports a new cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [WORKLIST_BARREL]: `export * from './worklist.a.js';\nexport * from './worklist.b.js';\n`,
      'packages/herdr/src/worklist.a.ts': `import { b } from './worklist.b.js';\nexport const a = () => b;\n`,
      'packages/herdr/src/worklist.b.ts': `import { a } from './worklist.a.js';\nexport const b = () => a;\n`,
    });
    const cycles = findSplitFamilyCycles(broken, WORKLIST_CONFIG);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual([
      'packages/herdr/src/worklist.a.ts',
      'packages/herdr/src/worklist.b.ts',
    ]);
    // Not in the baseline, and it is a genuine runtime cycle.
    expect(findCycleBaselineViolations(cycles, WORKLIST_CYCLE_BASELINE)).toHaveLength(1);
    expect(findRuntimeCycles(broken, WORKLIST_CONFIG)).toHaveLength(1);
    expect(
      findCycleBaselineViolations(
        findRuntimeCycles(broken, WORKLIST_CONFIG),
        WORKLIST_RUNTIME_CYCLE_BASELINE,
      ),
    ).toHaveLength(1);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({
      'packages/herdr/src/worklist.huge.ts': lines(MAX_MODULE_LINES + 1),
    });
    expect(
      findOversizedModules(splitFamilyModules(over, WORKLIST_CONFIG), [], MAX_MODULE_LINES),
    ).toEqual([{ file: 'packages/herdr/src/worklist.huge.ts', lineCount: MAX_MODULE_LINES + 1 }]);

    const atCeiling = indexFromSources({
      'packages/herdr/src/worklist.huge.ts': lines(MAX_MODULE_LINES),
    });
    expect(
      findOversizedModules(splitFamilyModules(atCeiling, WORKLIST_CONFIG), [], MAX_MODULE_LINES),
    ).toEqual([]);
  });

  it('exempts the allowlisted monolith but rejects allowlist growth', () => {
    const oversized = indexFromSources({
      [WORKLIST_BARREL]: lines(MAX_MODULE_LINES * 8),
    });
    // The monolith is exempt while the split is in flight…
    expect(
      findOversizedModules(
        splitFamilyModules(oversized, WORKLIST_CONFIG),
        WORKLIST_SPLIT_ALLOWLIST,
        MAX_MODULE_LINES,
      ),
    ).toEqual([]);
    // …but the allowlist can never be extended to cover a new module.
    expect(
      findAllowlistViolations(
        ['worklist.ts', 'worklist.state.ts'],
        WORKLIST_SPLIT_ALLOWLIST_CEILING,
      ),
    ).toEqual(['worklist.state.ts']);
    expect(findAllowlistViolations(['worklist.ts'], WORKLIST_SPLIT_ALLOWLIST_CEILING)).toEqual([]);
  });

  it('records a baseline cycle only for the modules actually in it', () => {
    // A component contained by the baseline passes; a grown component does not.
    expect(
      findCycleBaselineViolations([WORKLIST_CYCLE_BASELINE[0]], WORKLIST_CYCLE_BASELINE),
    ).toEqual([]);
    const grown = [...WORKLIST_CYCLE_BASELINE[0], 'packages/herdr/src/worklist.state.ts'];
    expect(findCycleBaselineViolations([grown], WORKLIST_CYCLE_BASELINE)).toEqual([grown.sort()]);
    // Shrinking a cycle is always allowed.
    expect(
      findCycleBaselineViolations(
        [WORKLIST_CYCLE_BASELINE[0].filter((f) => f !== WORKLIST_BARREL)],
        WORKLIST_CYCLE_BASELINE,
      ),
    ).toEqual([]);
  });
});
