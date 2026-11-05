/**
 * packages/herdr/src/fetcher.split-guard.test.ts — automated gate for the
 * `packages/herdr/src/fetcher.ts` split invariants.
 *
 * Parent: WL-0MVGKH47T007GKN1 (decompose the `fetcher.ts` god class).
 * Work item: WL-0MW08VST6005NDME (test-first guard, lands before any code
 * moves).
 *
 * ## What this file protects
 *
 * Every extraction child (2–7) moves code out of
 * `packages/herdr/src/fetcher.ts` without touching a single test file. The
 * unchanged suites are the behaviour-preservation gate — but nothing in the
 * repository enforced the *structural* half of the contract (unchanged public
 * surface **and export kind**, no barrel runtime import, no new cycle, module
 * line ceiling, a responsibility doc per extracted module, single-owner module
 * state). These tests are that enforcement.
 *
 * The gates are **additive** and read-only: they scan the module tree with the
 * TypeScript parser (via `../test/split-guard/scan.js` and the family config in
 * `../test/split-guard/fetcher-family.js`) and assert. Nothing here modifies
 * the tree, the barrel or any other test file.
 *
 * ## Gate → acceptance criterion mapping
 *
 * | Gate | Child / parent AC |
 * |---|---|
 * | baseline + live public surface (names and kinds) | child AC3, parent AC2 |
 * | frozen consumer surface | child AC2, parent AC2 |
 * | no runtime barrel import / no new or runtime cycle | child AC5/AC6, parent AC4 |
 * | ≤ 1,000 lines per module, shrink-only allowlist | child AC4, parent AC1 |
 * | responsibility doc on every extracted family module | parent AC5 |
 * | single-owner module state | parent AC3 (behaviour preserved) |
 *
 * ## Re-baselining
 *
 * `packages/herdr/src/fetcher.split-baseline.json` is a *frozen* contract:
 * regenerate it deliberately, never to make a red gate green.
 *
 *   npx tsx packages/herdr/test/split-guard/fetcher-family.ts --write-baseline
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
  findAllowlistViolations,
  findBarrelValueImports,
  findCycleBaselineViolations,
  findMissingExports,
  findOversizedModules,
  findRuntimeCycles,
  findSplitFamilyCycles,
  findUnexportedConsumerImports,
  indexFromSources,
  loadConsumerSources,
  loadModuleIndex,
} from '../test/split-guard/scan.js';
import {
  FETCHER_BARREL,
  FETCHER_BASELINE_PATH,
  FETCHER_CONFIG,
  FETCHER_CONSUMER_ROOTS,
  FETCHER_CYCLE_BASELINE,
  FETCHER_FAMILY_PATTERN,
  FETCHER_RUNTIME_CYCLE_BASELINE,
  FETCHER_SINGLE_OWNER_DECLARATIONS,
  FETCHER_SPLIT_ALLOWLIST,
  FETCHER_SPLIT_ALLOWLIST_CEILING,
  FETCHER_TYPE_ONLY_EDGES,
  SINGLE_OWNER_DECLARATION,
  collectExportKinds,
  fetcherFamilyModules,
  findExportKindViolations,
  findMissingResponsibilityDocs,
  findSingleOwnerViolations,
  readFetcherBaseline,
} from '../test/split-guard/fetcher-family.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `'// pad\n'.repeat(n)` yields a file whose `wc -l` is exactly `n`. */
function lines(n: number): string {
  return '// pad\n'.repeat(n);
}

const index = loadModuleIndex(repoRoot, FETCHER_CONSUMER_ROOTS);
const familySources = loadConsumerSources(repoRoot, [FETCHER_CONFIG.familyDir]);
const familyModules = fetcherFamilyModules(index);

// ── Gates against the live tree ───────────────────────────────────────

describe('fetcher split guard — live tree', () => {
  const exported = collectExportedNames(index, FETCHER_BARREL);
  const liveKinds = collectExportKinds(familySources, FETCHER_BARREL);

  it('keeps every baseline symbol exported by the barrel (public surface)', () => {
    const baseline = readFetcherBaseline(repoRoot);

    expect(exported.size).toBe(47);
    // A lost re-export is exactly the failure a move-only split invites.
    expect(findMissingExports(baseline.symbols, exported)).toEqual([]);
  });

  it('keeps every baseline symbol at the same value/type kind', () => {
    const baseline = readFetcherBaseline(repoRoot);

    // `collectExportKinds` resolves `export { x } from` / `export *` chains, so
    // this keeps holding once the barrel becomes a thin re-export shell.
    expect(findExportKindViolations(liveKinds, baseline)).toEqual([]);

    // The live surface and the frozen kinds must describe the same names: a
    // symbol the kind scanner cannot classify would silently escape the gate.
    expect([...liveKinds.keys()].sort()).toEqual(baseline.symbols);
  });

  it('exports every symbol a live consumer imports from the barrel', () => {
    expect(findUnexportedConsumerImports(index, FETCHER_BARREL, [])).toEqual([]);
  });

  it('freezes the consumer surface the importing files actually use', () => {
    const baseline = readFetcherBaseline(repoRoot);
    const live = [...consumerImportNames(index, FETCHER_BARREL).keys()].sort();

    // 40 symbols are consumed by the 16 production + 52 test files inside
    // `packages/herdr/src`; the three external importers
    // (`tests/herdr/fetcher*.test.ts`) add `WlError`, `formatWlError` and
    // `_fetchMemoSize`. The parent plan's "42" is stale prose (its own explicit
    // list has 40 entries); the measured live surface is 43.
    expect(baseline.consumerSymbols).toEqual(live);
    expect(baseline.consumerSymbols.length).toBe(43);
    for (const name of baseline.consumerSymbols) {
      expect(baseline.symbols).toContain(name);
    }
  });

  it('has no fetcher module importing the barrel at runtime', () => {
    // Extracted modules import concrete siblings; the barrel is a downstream
    // consumer of them, so a value import of the barrel inverts the layering.
    expect(findBarrelValueImports(index, FETCHER_CONFIG)).toEqual([]);
  });

  it('adds no import cycle outside the recorded baseline', () => {
    expect(FETCHER_CYCLE_BASELINE.length).toBeGreaterThan(0);
    const cycles = findSplitFamilyCycles(index, FETCHER_CONFIG);
    expect(findCycleBaselineViolations(cycles, FETCHER_CYCLE_BASELINE)).toEqual([]);
  });

  it('adds no runtime (value) import cycle outside the recorded baseline', () => {
    // `fetcher ↔ hydrator` already exists in the emitted JavaScript and is
    // recorded; any further runtime cycle is a violation (parent AC4).
    expect(FETCHER_RUNTIME_CYCLE_BASELINE.length).toBeGreaterThan(0);
    const cycles = findRuntimeCycles(index, FETCHER_CONFIG);
    expect(findCycleBaselineViolations(cycles, FETCHER_RUNTIME_CYCLE_BASELINE)).toEqual([]);
  });

  it('keeps every fetcher production module within the line ceiling', () => {
    // `fetcher.ts` is exempt only while the split is in flight (allowlist).
    const oversized = findOversizedModules(familyModules, FETCHER_SPLIT_ALLOWLIST);
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
  });

  it('only ever shrinks the fetcher split allowlist', () => {
    expect(
      findAllowlistViolations(FETCHER_SPLIT_ALLOWLIST, FETCHER_SPLIT_ALLOWLIST_CEILING),
    ).toEqual([]);
    // The ceiling itself is the plan-time list: the monolith and nothing else.
    expect([...FETCHER_SPLIT_ALLOWLIST_CEILING]).toEqual([basename(FETCHER_BARREL)]);
  });

  it('documents a single responsibility on every extracted module', () => {
    // Vacuously green on the pre-split tree (no extracted module exists yet);
    // from child 2 onwards every `fetcher.*` module must carry a top-level doc.
    expect(
      findMissingResponsibilityDocs(
        familySources,
        familyModules.map((m) => m.file),
        FETCHER_BARREL,
      ),
    ).toEqual([]);
  });

  it('declares each single-owner piece of module state exactly once', () => {
    // A copy-paste extraction that redeclares one of these silently defeats its
    // setter (`setExecFileAsync`, `setWorklogDir`) or its cache.
    expect(SINGLE_OWNER_DECLARATION).toBe('execFileAsync');
    expect(FETCHER_SINGLE_OWNER_DECLARATIONS).toHaveLength(7);
    expect(findSingleOwnerViolations(familyModules)).toEqual([]);
  });
});

// ── The committed baseline artefact ───────────────────────────────────

describe('fetcher split baseline', () => {
  const baseline = readFetcherBaseline(repoRoot);

  it('records the frozen 47-symbol surface, sorted and deduplicated', () => {
    expect(baseline.symbols).toHaveLength(47);
    expect(baseline.symbols).toEqual([...baseline.symbols].sort());
    expect(new Set(baseline.symbols).size).toBe(baseline.symbols.length);
    for (const symbol of baseline.symbols) expect(symbol).toMatch(/^[\w$]+$/);
  });

  it('partitions the surface into value and type symbols', () => {
    const kinds = new Map<string, 'value' | 'type'>([
      ...baseline.valueSymbols.map((name) => [name, 'value'] as const),
      ...baseline.typeSymbols.map((name) => [name, 'type'] as const),
    ]);
    expect(kinds.size).toBe(baseline.symbols.length);
    expect([...kinds.keys()].sort()).toEqual(baseline.symbols);
    // 39 functions/constants are values; 8 interfaces/types are type-only.
    expect(baseline.valueSymbols).toHaveLength(39);
    expect(baseline.typeSymbols).toHaveLength(8);
  });

  it('records provenance that makes the baseline reproducible', () => {
    expect(baseline.provenance.generatedBy).toContain('--write-baseline');
    expect(baseline.provenance.generatedBy).toContain('fetcher-family.ts');
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.barrel).toBe(FETCHER_BARREL);
    expect(baseline.provenance.consumerGlobs).toContain('packages/herdr/src/**/*.ts');
    expect(baseline.provenance.consumerGlobs).toContain('tests/**/*.ts');
  });

  it('is committed where the guard loads it from', () => {
    expect(fs.existsSync(path.join(repoRoot, FETCHER_BASELINE_PATH))).toBe(true);
    expect(FETCHER_BASELINE_PATH).toBe('packages/herdr/src/fetcher.split-baseline.json');
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });

  it('records a representative slice of the current surface', () => {
    // A stub or wrongly-scoped baseline would pass the size/format checks.
    expect(baseline.valueSymbols).toContain('fetchNextItems');
    expect(baseline.valueSymbols).toContain('claimWorkItem');
    expect(baseline.valueSymbols).toContain('buildWlArgs');
    expect(baseline.valueSymbols).toContain('DEFAULT_WL_SPAWN_CAP');
    expect(baseline.typeSymbols).toContain('WorkItem');
    expect(baseline.typeSymbols).toContain('BlockerRef');
    expect(baseline.typeSymbols).toContain('ReviewQueueState');
    expect(baseline.consumerSymbols).toContain('fetchNextItems');
    expect(baseline.consumerSymbols).toContain('WlError');
  });
});

// ── Negative cases: each gate must fail on broken input (child AC7) ───

describe('fetcher split guard — gates fail on broken input', () => {
  it('identifies the fetcher family by the /^fetcher(\.[\w-]+)?\.ts$/ predicate', () => {
    expect(FETCHER_FAMILY_PATTERN.test('fetcher.ts')).toBe(true);
    expect(FETCHER_FAMILY_PATTERN.test('fetcher.types.ts')).toBe(true);
    expect(FETCHER_FAMILY_PATTERN.test('fetcher.root-substitution.ts')).toBe(true);
    // Existing hyphenated suites are consumers, never split modules.
    expect(FETCHER_FAMILY_PATTERN.test('fetcher-blockers.test.ts')).toBe(false);
    expect(FETCHER_FAMILY_PATTERN.test('fetcher.split-guard.test.ts')).toBe(false);
    expect(FETCHER_FAMILY_PATTERN.test('hydrator.ts')).toBe(false);
  });

  it('reports a dropped export, and follows export * re-export chains', () => {
    const broken = indexFromSources({
      [FETCHER_BARREL]: `export * from './fetcher.types.js';\n`,
      'packages/herdr/src/fetcher.types.ts': `export const kept = 1;\nexport interface AlsoKept {}\n`,
    });
    const exported = collectExportedNames(broken, FETCHER_BARREL);
    expect(findMissingExports(['kept', 'AlsoKept'], exported)).toEqual([]);
    expect(findMissingExports(['kept', 'Dropped'], exported)).toEqual(['Dropped']);
  });

  it('reports a symbol a consumer imports but the barrel no longer exports', () => {
    const broken = indexFromSources({
      [FETCHER_BARREL]: `export const kept = 1;\n`,
      'packages/herdr/src/hydrator.ts': `import { kept, gone } from './fetcher.js';\nexport const x = [kept, gone];\n`,
    });
    expect(consumerImportNames(broken, FETCHER_BARREL).has('gone')).toBe(true);
    expect(findUnexportedConsumerImports(broken, FETCHER_BARREL, [])).toEqual(['gone']);
    expect(findUnexportedConsumerImports(broken, FETCHER_BARREL, ['gone'])).toEqual([]);
  });

  it('reports a symbol whose value/type kind changed', () => {
    const sources = {
      [FETCHER_BARREL]: [
        `export const DEFAULT_WL_SPAWN_CAP = 1;`,
        `export interface WorkItem { id: string }`,
        `export * from './fetcher.cli.js';`,
        ``,
      ].join('\n'),
      'packages/herdr/src/fetcher.cli.ts': `export function fetchNextItems(): void {}\n`,
    };
    const kinds = collectExportKinds(sources, FETCHER_BARREL);
    expect(Object.fromEntries(kinds)).toEqual({
      DEFAULT_WL_SPAWN_CAP: 'value',
      WorkItem: 'type',
      fetchNextItems: 'value',
    });

    const baseline = {
      provenance: {
        generatedBy: 'test',
        sourceCommit: '0'.repeat(40),
        generatedAt: new Date(0).toISOString(),
        barrel: FETCHER_BARREL,
        consumerGlobs: [],
      },
      symbols: ['DEFAULT_WL_SPAWN_CAP', 'WorkItem', 'fetchNextItems'],
      valueSymbols: ['DEFAULT_WL_SPAWN_CAP', 'WorkItem'],
      typeSymbols: ['fetchNextItems'],
      consumerSymbols: [],
    };
    const violations = findExportKindViolations(kinds, baseline);
    // Order is locale-dependent; assert the membership and the reason.
    expect(violations).toHaveLength(2);
    expect(violations).toEqual(
      expect.arrayContaining([
        { name: 'WorkItem', expected: 'value', actual: 'type' },
        { name: 'fetchNextItems', expected: 'type', actual: 'value' },
      ]),
    );
  });

  it('resolves kinds through export type and named re-exports', () => {
    const sources = {
      [FETCHER_BARREL]: [
        `export type { WorkItem } from './fetcher.types.js';`,
        `export { DEFAULT_WL_SPAWN_CAP as SPAWN_CAP } from './fetcher.types.js';`,
        `export * from './fetcher.cli.js';`,
        ``,
      ].join('\n'),
      'packages/herdr/src/fetcher.types.ts': [
        `export interface WorkItem { id: string }`,
        `export const DEFAULT_WL_SPAWN_CAP = 1;`,
        ``,
      ].join('\n'),
      'packages/herdr/src/fetcher.cli.ts': `export function runWlSync(): void {}\n`,
    };
    expect(Object.fromEntries(collectExportKinds(sources, FETCHER_BARREL))).toEqual({
      WorkItem: 'type',
      SPAWN_CAP: 'value',
      runWlSync: 'value',
    });
  });

  it('reports a runtime import of the barrel from a family module', () => {
    const broken = indexFromSources({
      [FETCHER_BARREL]: `export const shared = 1;\n`,
      'packages/herdr/src/fetcher.api.ts': `import { shared } from './fetcher.js';\nexport const local = shared;\n`,
    });
    expect(findBarrelValueImports(broken, FETCHER_CONFIG)).toEqual([
      { file: 'packages/herdr/src/fetcher.api.ts', specifier: './fetcher.js' },
    ]);
  });

  it('permits a type-only import of the barrel (no runtime cycle)', () => {
    const allowed = indexFromSources({
      [FETCHER_BARREL]: `export * from './fetcher.types.js';\nexport const shared = 1;\n`,
      'packages/herdr/src/fetcher.types.ts': `export interface Shared {}\n`,
      'packages/herdr/src/fetcher.api.ts': `import type { Shared } from './fetcher.js';\nexport const use = (s: Shared) => s;\n`,
    });
    expect(findBarrelValueImports(allowed, FETCHER_CONFIG)).toEqual([]);
    expect(findRuntimeCycles(allowed, FETCHER_CONFIG)).toEqual([]);
  });

  it('reports a new cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [FETCHER_BARREL]: `export * from './fetcher.cli.js';\nexport * from './fetcher.json.js';\n`,
      'packages/herdr/src/fetcher.cli.ts': `import { parse } from './fetcher.json.js';\nexport const run = () => parse;\n`,
      'packages/herdr/src/fetcher.json.ts': `import { run } from './fetcher.cli.js';\nexport const parse = () => run;\n`,
    });
    const cycles = findSplitFamilyCycles(broken, FETCHER_CONFIG);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual([
      'packages/herdr/src/fetcher.cli.ts',
      'packages/herdr/src/fetcher.json.ts',
    ]);
    expect(findCycleBaselineViolations(cycles, FETCHER_CYCLE_BASELINE)).toHaveLength(1);
    expect(findRuntimeCycles(broken, FETCHER_CONFIG)).toHaveLength(1);
    expect(
      findCycleBaselineViolations(
        findRuntimeCycles(broken, FETCHER_CONFIG),
        FETCHER_RUNTIME_CYCLE_BASELINE,
      ),
    ).toHaveLength(1);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({
      'packages/herdr/src/fetcher.huge.ts': lines(MAX_MODULE_LINES + 1),
    });
    expect(
      findOversizedModules(fetcherFamilyModules(over), [], MAX_MODULE_LINES),
    ).toEqual([
      { file: 'packages/herdr/src/fetcher.huge.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);

    const atCeiling = indexFromSources({
      'packages/herdr/src/fetcher.huge.ts': lines(MAX_MODULE_LINES),
    });
    expect(
      findOversizedModules(fetcherFamilyModules(atCeiling), [], MAX_MODULE_LINES),
    ).toEqual([]);
  });

  it('exempts the allowlisted monolith but rejects allowlist growth', () => {
    const oversized = indexFromSources({
      [FETCHER_BARREL]: lines(MAX_MODULE_LINES * 3),
    });
    // The pre-split tree exempts exactly the 2,365-line monolith.
    expect(
      findOversizedModules(
        fetcherFamilyModules(oversized),
        [basename(FETCHER_BARREL)],
        MAX_MODULE_LINES,
      ),
    ).toEqual([]);
    // A module the ceiling never allowed cannot be added to the allowlist.
    expect(
      findAllowlistViolations(
        ['fetcher.ts', 'fetcher.api.ts'],
        FETCHER_SPLIT_ALLOWLIST_CEILING,
      ),
    ).toEqual(['fetcher.api.ts']);
    expect(
      findAllowlistViolations(['fetcher.ts'], FETCHER_SPLIT_ALLOWLIST_CEILING),
    ).toEqual([]);
  });

  it('reports an extracted module without a top-level responsibility doc', () => {
    const sources = {
      [FETCHER_BARREL]: `/** Barrel. */\nexport * from './fetcher.types.js';\n`,
      'packages/herdr/src/fetcher.types.ts': `export const x = 1;\n`,
      'packages/herdr/src/fetcher.cli.ts': `/**\n * wl CLI execution.\n */\nexport const y = 1;\n`,
    };
    expect(
      findMissingResponsibilityDocs(
        sources,
        [
          FETCHER_BARREL,
          'packages/herdr/src/fetcher.types.ts',
          'packages/herdr/src/fetcher.cli.ts',
        ],
        FETCHER_BARREL,
      ),
    ).toEqual(['packages/herdr/src/fetcher.types.ts']);
  });

  it('reports single-owner module state dropped or duplicated', () => {
    const dropped = indexFromSources({
      'packages/herdr/src/fetcher.args.ts': `let _worklogDir: string | undefined;\nexport const a = _worklogDir;\n`,
    });
    expect(
      findSingleOwnerViolations(fetcherFamilyModules(dropped), ['execFileAsync']),
    ).toEqual([{ name: 'execFileAsync', files: [], total: 0 }]);

    const duplicated = indexFromSources({
      'packages/herdr/src/fetcher.ts': `let execFileAsync = 1;\nexport const base = execFileAsync;\n`,
      'packages/herdr/src/fetcher.args.ts': `let execFileAsync = 2;\nexport const copy = execFileAsync;\n`,
    });
    expect(
      findSingleOwnerViolations(fetcherFamilyModules(duplicated), ['execFileAsync']),
    ).toEqual([
      {
        name: 'execFileAsync',
        files: [
          'packages/herdr/src/fetcher.args.ts',
          'packages/herdr/src/fetcher.ts',
        ],
        total: 2,
      },
    ]);
  });

  it('keeps the recorded type-only cycle edges from widening into runtime', () => {
    // The pre-existing `fetcher → agent-tracker` edge is type-only today; a
    // value import would widen the recorded cycle.
    expect(FETCHER_TYPE_ONLY_EDGES).toContainEqual({
      from: 'packages/herdr/src/fetcher.ts',
      to: 'packages/herdr/src/agent-tracker.ts',
    });
  });
});
