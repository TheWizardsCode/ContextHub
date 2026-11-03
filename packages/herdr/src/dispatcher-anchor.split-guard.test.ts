/**
 * packages/herdr/src/dispatcher-anchor.split-guard.test.ts — automated gate
 * for the `packages/herdr/src/dispatcher-anchor.ts` split invariants.
 *
 * Parent: WL-0MVGKHCP9005SJPZ (decompose the `dispatcher-anchor.ts` god class).
 * Work item: WL-0MW0JH7TK008UP0M (test-first guard, lands before any code
 * moves).
 *
 * ## What this file protects
 *
 * Every extraction child (2–8) moves code out of
 * `packages/herdr/src/dispatcher-anchor.ts` without touching a single test
 * file. The unchanged `dispatcher-anchor.test.ts` and
 * `tests/herdr/dispatcher-anchor.integration.test.ts` suites are the
 * behaviour-preservation gate — but nothing in the repository enforced the
 * *structural* half of the contract (unchanged public surface **and export
 * kind**, no barrel runtime import, no new cycle, module line ceiling, a
 * responsibility doc per extracted module). These tests are that enforcement.
 *
 * The gates are **additive** and read-only: they scan the module tree with the
 * TypeScript parser (via `../test/split-guard/scan.js` and the family config in
 * `../test/split-guard/dispatcher-anchor-family.js`) and assert. Nothing here
 * modifies the tree, the barrel or any other test file.
 *
 * ## Gate → acceptance criterion mapping
 *
 * | Gate | Child AC |
 * |---|---|
 * | baseline + live public surface (names and kinds) | AC1, AC3 |
 * | no runtime barrel import / no new or runtime cycle | AC1 |
 * | ≤ 1,000 lines per module, shrink-only allowlist | AC1 |
 * | responsibility doc on every extracted family module | AC1 |
 * | frozen consumer/importer set (constrained consumer roots) | AC2, AC3 |
 *
 * ## Re-baselining
 *
 * `packages/herdr/src/dispatcher-anchor.split-baseline.json` is a *frozen*
 * contract: regenerate it deliberately, never to make a red gate green.
 *
 *   npx tsx packages/herdr/test/split-guard/dispatcher-anchor-family.ts \
 *     --write-baseline
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
  DISPATCHER_ANCHOR_BARREL,
  DISPATCHER_ANCHOR_BASELINE_PATH,
  DISPATCHER_ANCHOR_CONFIG,
  DISPATCHER_ANCHOR_CONSUMER_ROOTS,
  DISPATCHER_ANCHOR_CYCLE_BASELINE,
  DISPATCHER_ANCHOR_RUNTIME_CYCLE_BASELINE,
  DISPATCHER_ANCHOR_SPLIT_ALLOWLIST,
  DISPATCHER_ANCHOR_SPLIT_ALLOWLIST_CEILING,
  KNOWN_CONSUMER_FILES,
  SINGLE_OWNER_DECLARATION,
  collectExportKinds,
  findBarrelConsumers,
  findExportKindViolations,
  findMissingResponsibilityDocs,
  findUnknownConsumers,
  readDispatcherAnchorBaseline,
} from '../test/split-guard/dispatcher-anchor-family.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `'// pad\n'.repeat(n)` yields a file whose `wc -l` is exactly `n`. */
function lines(n: number): string {
  return '// pad\n'.repeat(n);
}

const index = loadModuleIndex(repoRoot, DISPATCHER_ANCHOR_CONSUMER_ROOTS);
const familySources = loadConsumerSources(repoRoot, [DISPATCHER_ANCHOR_CONFIG.familyDir]);
const familyModules = splitFamilyModules(index, DISPATCHER_ANCHOR_CONFIG);

// ── Gates against the live tree ───────────────────────────────────────

describe('dispatcher-anchor split guard — live tree', () => {
  const exported = collectExportedNames(index, DISPATCHER_ANCHOR_BARREL);
  const liveKinds = collectExportKinds(familySources, DISPATCHER_ANCHOR_BARREL);

  it('keeps every baseline symbol exported by the barrel (public surface)', () => {
    const baseline = readDispatcherAnchorBaseline(repoRoot);

    expect(exported.size).toBe(32);
    // A lost re-export is exactly the failure a move-only split invites.
    expect(findMissingExports(baseline.symbols, exported)).toEqual([]);
  });

  it('keeps every baseline symbol at the same value/type kind', () => {
    const baseline = readDispatcherAnchorBaseline(repoRoot);

    // `collectExportKinds` resolves `export { x } from` / `export *` chains, so
    // this keeps holding once the barrel becomes a thin re-export shell.
    expect(findExportKindViolations(liveKinds, baseline)).toEqual([]);

    // The live surface and the frozen kinds must describe the same names: a
    // symbol the kind scanner cannot classify would silently escape the gate.
    expect([...liveKinds.keys()].sort()).toEqual(baseline.symbols);
  });

  it('exports every symbol a live consumer imports', () => {
    expect(findUnexportedConsumerImports(index, DISPATCHER_ANCHOR_BARREL, [])).toEqual([]);
  });

  it('confines consumer discovery to the recorded importer set', () => {
    // Parent AC2: all importing files compile with no import edits. Freezing the
    // importer list (and rejecting unknown consumers) keeps the scanned surface
    // from drifting as modules are extracted.
    expect(findBarrelConsumers(index, DISPATCHER_ANCHOR_BARREL)).toEqual([...KNOWN_CONSUMER_FILES]);
    expect(findUnknownConsumers(index, DISPATCHER_ANCHOR_BARREL)).toEqual([]);
  });

  it('has no dispatcher-anchor module importing the barrel at runtime', () => {
    // Extracted modules import concrete siblings; the barrel is a downstream
    // consumer of them, so a value import of the barrel inverts the layering.
    expect(findBarrelValueImports(index, DISPATCHER_ANCHOR_CONFIG)).toEqual([]);
  });

  it('adds no import cycle outside the recorded baseline', () => {
    expect(DISPATCHER_ANCHOR_CYCLE_BASELINE).toEqual([]);
    expect(findSplitFamilyCycles(index, DISPATCHER_ANCHOR_CONFIG)).toEqual([]);
    expect(
      findCycleBaselineViolations(
        findSplitFamilyCycles(index, DISPATCHER_ANCHOR_CONFIG),
        DISPATCHER_ANCHOR_CYCLE_BASELINE,
      ),
    ).toEqual([]);
  });

  it('adds no runtime (value) import cycle outside the recorded baseline', () => {
    expect(DISPATCHER_ANCHOR_RUNTIME_CYCLE_BASELINE).toEqual([]);
    expect(findRuntimeCycles(index, DISPATCHER_ANCHOR_CONFIG)).toEqual([]);
    expect(
      findCycleBaselineViolations(
        findRuntimeCycles(index, DISPATCHER_ANCHOR_CONFIG),
        DISPATCHER_ANCHOR_RUNTIME_CYCLE_BASELINE,
      ),
    ).toEqual([]);
  });

  it('keeps every dispatcher-anchor production module within the line ceiling', () => {
    const oversized = findOversizedModules(
      familyModules,
      DISPATCHER_ANCHOR_SPLIT_ALLOWLIST,
    );
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
  });

  it('only ever shrinks the split allowlist', () => {
    expect(
      findAllowlistViolations(
        DISPATCHER_ANCHOR_SPLIT_ALLOWLIST,
        DISPATCHER_ANCHOR_SPLIT_ALLOWLIST_CEILING,
      ),
    ).toEqual([]);
    // The ceiling itself is the plan-time list: the monolith and nothing else.
    expect([...DISPATCHER_ANCHOR_SPLIT_ALLOWLIST_CEILING]).toEqual([basename(DISPATCHER_ANCHOR_BARREL)]);
  });

  it('documents a single responsibility on every extracted module', () => {
    // Vacuously green on the pre-split tree (no extracted module exists yet);
    // from child 2 onwards every `dispatcher-anchor.*` module must carry a
    // top-level doc comment.
    expect(
      findMissingResponsibilityDocs(
        familySources,
        familyModules.map((m) => m.file),
        DISPATCHER_ANCHOR_BARREL,
      ),
    ).toEqual([]);
  });

  it('declares no module-scope mutable state (no-op single-owner slot)', () => {
    // `SplitFamilyConfig` requires a single-owner declaration; this module has
    // none, so the field names a sentinel that must never be declared.
    expect(SINGLE_OWNER_DECLARATION).toBe('DISPATCHER_ANCHOR_NO_SHARED_MODULE_STATE');
    expect(findDeclarationModules(familyModules, SINGLE_OWNER_DECLARATION)).toEqual([]);
    expect(countDeclarations(familyModules, SINGLE_OWNER_DECLARATION)).toBe(0);
  });
});

// ── The committed baseline artefact ───────────────────────────────────

describe('dispatcher-anchor split baseline', () => {
  const baseline = readDispatcherAnchorBaseline(repoRoot);

  it('records the frozen 32-symbol surface, sorted and deduplicated', () => {
    expect(baseline.symbols).toHaveLength(32);
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
    // 5 constants + 17 functions are values; 10 interfaces/types are types.
    expect(baseline.valueSymbols).toHaveLength(22);
    expect(baseline.typeSymbols).toHaveLength(10);
  });

  it('records provenance that makes the baseline reproducible', () => {
    expect(baseline.provenance.generatedBy).toContain('--write-baseline');
    expect(baseline.provenance.generatedBy).toContain('dispatcher-anchor-family.ts');
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.barrel).toBe(DISPATCHER_ANCHOR_BARREL);
    expect(baseline.provenance.consumerGlobs).toContain('packages/herdr/src/**/*.ts');
    expect(baseline.provenance.consumerGlobs).toContain('tests/herdr/**/*.ts');
  });

  it('is committed where the guard loads it from', () => {
    expect(fs.existsSync(path.join(repoRoot, DISPATCHER_ANCHOR_BASELINE_PATH))).toBe(true);
    expect(DISPATCHER_ANCHOR_BASELINE_PATH).toBe(
      'packages/herdr/src/dispatcher-anchor.split-baseline.json',
    );
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });

  it('freezes the consumer surface (the symbols importing files actually use)', () => {
    const live = [...consumerImportNames(index, DISPATCHER_ANCHOR_BARREL).keys()].sort();
    expect(baseline.consumerSymbols).toEqual(live);
    for (const name of baseline.consumerSymbols) {
      expect(baseline.symbols).toContain(name);
    }
  });

  it('records a representative slice of the current surface', () => {
    // A stub or wrongly-scoped baseline would pass the size/format checks.
    expect(baseline.valueSymbols).toContain('getDispatcherAnchor');
    expect(baseline.valueSymbols).toContain('createDispatcherAnchorDeps');
    expect(baseline.valueSymbols).toContain('parseTabListOutput');
    expect(baseline.typeSymbols).toContain('DispatcherAnchor');
    expect(baseline.typeSymbols).toContain('ItemTabAnchor');
    expect(baseline.consumerSymbols).toContain('getItemTabAnchor');
    expect(baseline.consumerSymbols).toContain('resolveProjectWorkspace');
  });
});

// ── Negative cases: each gate must fail on broken input (AC4) ─────────

describe('dispatcher-anchor split guard — gates fail on broken input', () => {
  it('reports a dropped export, and follows export * re-export chains', () => {
    const broken = indexFromSources({
      [DISPATCHER_ANCHOR_BARREL]: `export * from './dispatcher-anchor.contract.js';\n`,
      'packages/herdr/src/dispatcher-anchor.contract.ts': `export const kept = 1;\nexport interface AlsoKept {}\n`,
    });
    const exported = collectExportedNames(broken, DISPATCHER_ANCHOR_BARREL);
    expect(findMissingExports(['kept', 'AlsoKept'], exported)).toEqual([]);
    expect(findMissingExports(['kept', 'Dropped'], exported)).toEqual(['Dropped']);
  });

  it('reports a symbol a consumer imports but the barrel no longer exports', () => {
    const broken = indexFromSources({
      [DISPATCHER_ANCHOR_BARREL]: `export const kept = 1;\n`,
      'packages/herdr/src/hydrator.ts': `import { kept, gone } from './dispatcher-anchor.js';\nexport const x = [kept, gone];\n`,
    });
    expect(consumerImportNames(broken, DISPATCHER_ANCHOR_BARREL).has('gone')).toBe(true);
    expect(findUnexportedConsumerImports(broken, DISPATCHER_ANCHOR_BARREL, [])).toEqual(['gone']);
    expect(findUnexportedConsumerImports(broken, DISPATCHER_ANCHOR_BARREL, ['gone'])).toEqual([]);
  });

  it('reports a symbol whose value/type kind changed', () => {
    const sources = {
      [DISPATCHER_ANCHOR_BARREL]: [
        `export const DISPATCHER_ANCHOR_FILE = 'x';`,
        `export interface DispatcherAnchor { id: string }`,
        `export * from './dispatcher-anchor.cli-parsers.js';`,
        ``,
      ].join('\n'),
      'packages/herdr/src/dispatcher-anchor.cli-parsers.ts': `export function parseTabListOutput(): void {}\n`,
    };
    const kinds = collectExportKinds(sources, DISPATCHER_ANCHOR_BARREL);
    expect(Object.fromEntries(kinds)).toEqual({
      DISPATCHER_ANCHOR_FILE: 'value',
      DispatcherAnchor: 'type',
      parseTabListOutput: 'value',
    });

    const baseline = {
      provenance: {
        generatedBy: 'test',
        sourceCommit: '0'.repeat(40),
        generatedAt: new Date(0).toISOString(),
        barrel: DISPATCHER_ANCHOR_BARREL,
        consumerGlobs: [],
      },
      symbols: ['DISPATCHER_ANCHOR_FILE', 'DispatcherAnchor', 'parseTabListOutput'],
      valueSymbols: ['DISPATCHER_ANCHOR_FILE', 'DispatcherAnchor'],
      typeSymbols: ['parseTabListOutput'],
      consumerSymbols: [],
    };
    expect(findExportKindViolations(kinds, baseline)).toEqual([
      { name: 'DispatcherAnchor', expected: 'value', actual: 'type' },
      { name: 'parseTabListOutput', expected: 'type', actual: 'value' },
    ]);
  });

  it('resolves kinds through export type and named re-exports', () => {
    const sources = {
      [DISPATCHER_ANCHOR_BARREL]: [
        `export type { DispatcherAnchor } from './dispatcher-anchor.contract.js';`,
        `export { DISPATCHER_ANCHOR_FILE as ANCHOR_FILE } from './dispatcher-anchor.contract.js';`,
        `export * from './dispatcher-anchor.persistence.js';`,
        ``,
      ].join('\n'),
      'packages/herdr/src/dispatcher-anchor.contract.ts': [
        `export interface DispatcherAnchor { id: string }`,
        `export const DISPATCHER_ANCHOR_FILE = 'x';`,
        ``,
      ].join('\n'),
      'packages/herdr/src/dispatcher-anchor.persistence.ts': `export function readAnchor(): void {}\n`,
    };
    expect(
      Object.fromEntries(collectExportKinds(sources, DISPATCHER_ANCHOR_BARREL)),
    ).toEqual({
      DispatcherAnchor: 'type',
      ANCHOR_FILE: 'value',
      readAnchor: 'value',
    });
  });

  it('reports a runtime import of the barrel from a family module', () => {
    const broken = indexFromSources({
      [DISPATCHER_ANCHOR_BARREL]: `export const shared = 1;\n`,
      'packages/herdr/src/dispatcher-anchor.persistence.ts': `import { shared } from './dispatcher-anchor.js';\nexport const local = shared;\n`,
    });
    expect(findBarrelValueImports(broken, DISPATCHER_ANCHOR_CONFIG)).toEqual([
      {
        file: 'packages/herdr/src/dispatcher-anchor.persistence.ts',
        specifier: './dispatcher-anchor.js',
      },
    ]);
  });

  it('permits a type-only import of the barrel (no runtime cycle)', () => {
    const allowed = indexFromSources({
      [DISPATCHER_ANCHOR_BARREL]: `export * from './dispatcher-anchor.contract.js';\nexport const shared = 1;\n`,
      'packages/herdr/src/dispatcher-anchor.contract.ts': `export interface Shared {}\n`,
      'packages/herdr/src/dispatcher-anchor.persistence.ts': `import type { Shared } from './dispatcher-anchor.js';\nexport const use = (s: Shared) => s;\n`,
    });
    expect(findBarrelValueImports(allowed, DISPATCHER_ANCHOR_CONFIG)).toEqual([]);
    expect(findRuntimeCycles(allowed, DISPATCHER_ANCHOR_CONFIG)).toEqual([]);
  });

  it('reports a new cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [DISPATCHER_ANCHOR_BARREL]: `export * from './dispatcher-anchor.a.js';\nexport * from './dispatcher-anchor.b.js';\n`,
      'packages/herdr/src/dispatcher-anchor.a.ts': `import { b } from './dispatcher-anchor.b.js';\nexport const a = () => b;\n`,
      'packages/herdr/src/dispatcher-anchor.b.ts': `import { a } from './dispatcher-anchor.a.js';\nexport const b = () => a;\n`,
    });
    const cycles = findSplitFamilyCycles(broken, DISPATCHER_ANCHOR_CONFIG);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual([
      'packages/herdr/src/dispatcher-anchor.a.ts',
      'packages/herdr/src/dispatcher-anchor.b.ts',
    ]);
    expect(findCycleBaselineViolations(cycles, DISPATCHER_ANCHOR_CYCLE_BASELINE)).toHaveLength(1);
    expect(findRuntimeCycles(broken, DISPATCHER_ANCHOR_CONFIG)).toHaveLength(1);
    expect(
      findCycleBaselineViolations(
        findRuntimeCycles(broken, DISPATCHER_ANCHOR_CONFIG),
        DISPATCHER_ANCHOR_RUNTIME_CYCLE_BASELINE,
      ),
    ).toHaveLength(1);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({
      'packages/herdr/src/dispatcher-anchor.huge.ts': lines(MAX_MODULE_LINES + 1),
    });
    expect(
      findOversizedModules(splitFamilyModules(over, DISPATCHER_ANCHOR_CONFIG), [], MAX_MODULE_LINES),
    ).toEqual([
      { file: 'packages/herdr/src/dispatcher-anchor.huge.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);

    const atCeiling = indexFromSources({
      'packages/herdr/src/dispatcher-anchor.huge.ts': lines(MAX_MODULE_LINES),
    });
    expect(
      findOversizedModules(
        splitFamilyModules(atCeiling, DISPATCHER_ANCHOR_CONFIG),
        [],
        MAX_MODULE_LINES,
      ),
    ).toEqual([]);
  });

  it('exempts the allowlisted monolith but rejects allowlist growth', () => {
    const oversized = indexFromSources({
      [DISPATCHER_ANCHOR_BARREL]: lines(MAX_MODULE_LINES * 2),
    });
    expect(
      findOversizedModules(
        splitFamilyModules(oversized, DISPATCHER_ANCHOR_CONFIG),
        DISPATCHER_ANCHOR_SPLIT_ALLOWLIST,
        MAX_MODULE_LINES,
      ),
    ).toEqual([]);
    expect(
      findAllowlistViolations(
        ['dispatcher-anchor.ts', 'dispatcher-anchor.placement.ts'],
        DISPATCHER_ANCHOR_SPLIT_ALLOWLIST_CEILING,
      ),
    ).toEqual(['dispatcher-anchor.placement.ts']);
    expect(
      findAllowlistViolations(
        ['dispatcher-anchor.ts'],
        DISPATCHER_ANCHOR_SPLIT_ALLOWLIST_CEILING,
      ),
    ).toEqual([]);
  });

  it('reports an extracted module without a top-level responsibility doc', () => {
    const sources = {
      [DISPATCHER_ANCHOR_BARREL]: `/** Barrel. */\nexport * from './dispatcher-anchor.contract.js';\n`,
      'packages/herdr/src/dispatcher-anchor.contract.ts': `export const x = 1;\n`,
      'packages/herdr/src/dispatcher-anchor.persistence.ts': `/**\n * Anchor/tab-anchor persistence.\n */\nexport const y = 1;\n`,
    };
    expect(
      findMissingResponsibilityDocs(
        sources,
        [
          DISPATCHER_ANCHOR_BARREL,
          'packages/herdr/src/dispatcher-anchor.contract.ts',
          'packages/herdr/src/dispatcher-anchor.persistence.ts',
        ],
        DISPATCHER_ANCHOR_BARREL,
      ),
    ).toEqual(['packages/herdr/src/dispatcher-anchor.contract.ts']);
  });

  it('reports a consumer outside the frozen importer set', () => {
    const broken = indexFromSources({
      [DISPATCHER_ANCHOR_BARREL]: `export const shared = 1;\n`,
      'packages/herdr/src/index.ts': `import { shared } from './dispatcher-anchor.js';\nexport const a = shared;\n`,
      'packages/herdr/src/unexpected-consumer.ts': `import { shared } from './dispatcher-anchor.js';\nexport const b = shared;\n`,
      'packages/herdr/src/dispatcher-anchor.persistence.ts': `import type { X } from './dispatcher-anchor.js';\nexport type Y = X;\n`,
    });
    expect(findBarrelConsumers(broken, DISPATCHER_ANCHOR_BARREL)).toEqual([
      'packages/herdr/src/index.ts',
      'packages/herdr/src/unexpected-consumer.ts',
    ]);
    expect(
      findUnknownConsumers(broken, DISPATCHER_ANCHOR_BARREL, ['packages/herdr/src/index.ts']),
    ).toEqual(['packages/herdr/src/unexpected-consumer.ts']);
  });
});
