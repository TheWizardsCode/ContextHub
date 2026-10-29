/**
 * packages/herdr/src/index.split-guard.test.ts — automated gate for the
 * `packages/herdr/src/index.ts` split invariants.
 *
 * Parent: WL-0MVGKGFFN009UCM6 (decompose the `index.ts` god module).
 * Work item: WL-0MVOA0FN3000ND4J (test-first guard, lands before any code
 * moves).
 *
 * ## What this file protects
 *
 * Every extraction child moves code out of `packages/herdr/src/index.ts`
 * without touching a single test file. That makes the unchanged suite
 * (`index.test.ts`, `claim.test.ts`, `fetchAuditItemById.test.ts`, `start.ts`)
 * the behaviour-preservation gate — but nothing in the repository enforces the
 * *structural* half of the contract (unchanged public surface, single
 * `loadSettings()` side effect, no barrel/cycle regressions, module line
 * ceiling, entry guard placement). These tests are that enforcement.
 *
 * The gates are **additive** and read-only: they scan the module tree with the
 * TypeScript parser (via `../test/split-guard/index-family.js`, which reuses
 * the generic predicates from `scan.js` without editing it) and assert.
 * Nothing here modifies the tree, the barrel or any other test file.
 *
 * ## Gate → parent acceptance criterion mapping
 *
 * | Gate | Parent AC |
 * |---|---|
 * | baseline + current-consumer public surface | AC2, AC3 |
 * | single `loadSettings()` call + single shared constants | AC5 |
 * | no runtime barrel import / no new or runtime cycle | AC4, AC5, AC6 |
 * | entry guard declared in the barrel | AC3 |
 * | ≤ 1,000 lines per module, shrink-only allowlist | AC1 |
 *
 * ## Re-baselining
 *
 * `packages/herdr/src/index.split-baseline.json` is a *frozen* contract:
 * regenerate it deliberately, never to make a red gate green.
 *
 *   npx tsx packages/herdr/test/split-guard/index-family.ts --write-baseline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  ENTRY_GUARD_NAME,
  INDEX_BARREL,
  INDEX_BASELINE_PATH,
  INDEX_CYCLE_BASELINE,
  INDEX_FAMILY_PATTERN,
  INDEX_SPLIT_ALLOWLIST,
  INDEX_SPLIT_ALLOWLIST_CEILING,
  INDEX_TYPE_ONLY_EDGES,
  MAX_MODULE_LINES,
  SINGLE_CALLSITE_CALLEES,
  collectExportedNames,
  countModuleScopeCalls,
  dynamicImportNames,
  findAbsentBaselineEdges,
  findAllowlistViolations,
  findBarrelValueImports,
  findCycleBaselineViolations,
  findDuplicateConstantDeclarations,
  findEntryGuardModules,
  findEntryGuardViolations,
  findIndexFamilyCycles,
  findMissingExports,
  findOversizedModules,
  findRuntimeIndexFamilyCycles,
  findSingleCallsiteViolations,
  findSingleDeclarationViolations,
  findWidenedBaselineEdges,
  indexConsumerImportNames,
  indexFamilyModules,
  indexFromSources,
  loadIndexFamilyFacts,
  loadIndexSources,
  loadModuleIndex,
  parseIndexModuleFacts,
  readIndexBaseline,
} from '../test/split-guard/index-family.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `'// pad\n'.repeat(n)` yields a file whose `wc -l` is exactly `n`. */
function lines(n: number): string {
  return '// pad\n'.repeat(n);
}

// ── Gates against the live tree ───────────────────────────────────────

describe('index split guard — live tree', () => {
  const index = loadModuleIndex(repoRoot);
  const sources = loadIndexSources(repoRoot);
  const facts = loadIndexFamilyFacts(repoRoot, sources);
  const consumers = indexConsumerImportNames(index, sources);
  const exported = collectExportedNames(index, INDEX_BARREL);

  it('keeps every baseline symbol exported by the barrel (public surface)', () => {
    const baseline = readIndexBaseline(repoRoot);

    expect(exported.size).toBeGreaterThan(0);
    // A lost re-export is exactly the failure a move-only split invites.
    expect(findMissingExports(baseline.symbols, exported)).toEqual([]);
  });

  it('exports every symbol the current consumers import from the barrel', () => {
    // Live counterpart of the frozen baseline: it catches a consumer that
    // starts importing a symbol the barrel never re-exports (e.g. a symbol
    // that stayed behind in an extracted module as internal-only).
    expect(findMissingExports(consumers.keys(), exported)).toEqual([]);
  });

  it('discovers the dynamic-import consumers too (not just static imports)', () => {
    // `consumerImportNames` (scan.js) models static + type imports only; six
    // of the intake Appendix's 26 symbols are reached through `import()`
    // in index.test.ts. A static-only baseline would under-freeze the barrel.
    for (const symbol of [
      'configureWorklogTarget',
      'uninitializedReport',
      'defaultInteractiveLiveTrackedPanesResolver',
      'resolveInteractiveWorkspaceId',
      'resolveInteractiveItemAnchor',
      'closeInteractiveTabRootPane',
    ]) {
      expect(consumers.has(symbol)).toBe(true);
    }
  });

  it('calls loadSettings at module scope exactly once, in exactly one module', () => {
    // Parent AC5: `const settings = loadSettings()` evaluates settings exactly
    // once at module load; duplicating it loads settings twice with
    // potentially different results.
    expect(SINGLE_CALLSITE_CALLEES).toEqual(['loadSettings']);
    expect(countModuleScopeCalls(facts, 'loadSettings')).toBe(1);
    expect(findSingleCallsiteViolations(facts)).toEqual([]);
  });

  it('declares each shared constant in exactly one module', () => {
    expect(findSingleDeclarationViolations(facts)).toEqual([]);
    // Generic half of the gate: no UPPER_SNAKE constant (a
    // `CONFIGURED_WORKLOG_TARGET`-style name) is duplicated across modules.
    expect(findDuplicateConstantDeclarations(facts)).toEqual([]);
  });

  it('has no index-family module importing the barrel at runtime', () => {
    // Extracted modules import concrete siblings; the barrel is a downstream
    // consumer of them, so a value import of the barrel inverts the layering.
    expect(findBarrelValueImports(index)).toEqual([]);
  });

  it('adds no import cycle outside the recorded baseline', () => {
    const cycles = findIndexFamilyCycles(index);
    expect(findCycleBaselineViolations(cycles, INDEX_CYCLE_BASELINE)).toEqual([]);
  });

  it('adds no runtime (value) import cycle', () => {
    // Type-only cycles are erased at runtime; value cycles are not.
    expect(findRuntimeIndexFamilyCycles(index)).toEqual([]);
  });

  it('keeps the pre-existing stalled-work ↔ downtime-worker edge type-only', () => {
    // The existing type-only cycle is recorded in the baseline and must not
    // widen into a runtime cycle (parent AC6, phase-5 constraint).
    expect(INDEX_TYPE_ONLY_EDGES.length).toBeGreaterThan(0);
    expect(INDEX_TYPE_ONLY_EDGES[0].to).toBe('packages/herdr/src/stalled-work.ts');
    expect(findAbsentBaselineEdges(index, INDEX_TYPE_ONLY_EDGES)).toEqual([]);
    expect(findWidenedBaselineEdges(index, INDEX_TYPE_ONLY_EDGES)).toEqual([]);
  });

  it('declares the entry guard in the barrel itself', () => {
    expect(ENTRY_GUARD_NAME).toBe('isEntryPoint');
    expect(findEntryGuardModules(facts)).toEqual([INDEX_BARREL]);
    expect(findEntryGuardViolations(facts)).toEqual([]);
  });

  it('keeps every index-family production module within the line ceiling', () => {
    const oversized = findOversizedModules(indexFamilyModules(index), INDEX_SPLIT_ALLOWLIST);
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
    // The 2,946-line monolith is exempt only while the split is in flight.
    expect([...INDEX_SPLIT_ALLOWLIST]).toEqual(['index.ts']);
  });

  it('only ever shrinks the index split allowlist', () => {
    expect(findAllowlistViolations(INDEX_SPLIT_ALLOWLIST, INDEX_SPLIT_ALLOWLIST_CEILING)).toEqual([]);
    expect([...INDEX_SPLIT_ALLOWLIST_CEILING]).toEqual(['index.ts']);
  });
});

// ── The committed baseline artefact ───────────────────────────────────

describe('index split baseline', () => {
  const baseline = readIndexBaseline(repoRoot);

  it('records a sorted, deduplicated symbol list of the consumed surface', () => {
    // Intake Appendix: 24–26 consumed symbols including the dynamic-import
    // ones. Regeneration must keep the list in this band or the baseline is
    // no longer the audited surface.
    expect(baseline.symbols.length).toBeGreaterThanOrEqual(24);
    expect(baseline.symbols.length).toBeLessThanOrEqual(26);
    expect(baseline.symbols).toEqual([...baseline.symbols].sort());
    expect(new Set(baseline.symbols).size).toBe(baseline.symbols.length);
    for (const symbol of baseline.symbols) expect(symbol).toMatch(/^[\w$]+$/);
  });

  it('records the static and dynamic consumer surface, not a stub', () => {
    for (const symbol of [
      'createDowntimeDeps',
      'setHostCpuSamplerForTests',
      'configureWorklogTarget',
      'uninitializedReport',
      'resolveInteractiveWorkspaceId',
      'closeInteractiveTabRootPane',
    ]) {
      expect(baseline.symbols).toContain(symbol);
    }
  });

  it('records provenance that makes the baseline reproducible', () => {
    expect(baseline.provenance.generatedBy).toContain('--write-baseline');
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.barrel).toBe(INDEX_BARREL);
    expect(baseline.provenance.consumerGlobs).toContain('packages/herdr/src/**/*.ts');
  });

  it('records the pre-existing type-only cycle it must not widen', () => {
    // Parent AC6: the existing `stalled-work ↔ downtime-worker` cycle is part
    // of the frozen contract; deleting it from the baseline is a red gate.
    expect(baseline.typeOnlyEdges.length).toBeGreaterThan(0);
    expect(baseline.typeOnlyEdges[0]).toEqual({
      from: 'packages/herdr/src/downtime-worker.ts',
      to: 'packages/herdr/src/stalled-work.ts',
    });
    expect(baseline.cycles.length).toBeGreaterThan(0);
  });

  it('is committed where the guard loads it from', () => {
    expect(fs.existsSync(path.join(repoRoot, INDEX_BASELINE_PATH))).toBe(true);
    expect(INDEX_BASELINE_PATH).toBe('packages/herdr/src/index.split-baseline.json');
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });
});

// ── Negative cases: each gate must fail on broken input (AC7) ─────────

describe('index split guard — gates fail on broken input', () => {
  it('identifies the index family by the /^index(\.[\w-]+)?\.ts$/ predicate', () => {
    expect(INDEX_FAMILY_PATTERN.test('index.ts')).toBe(true);
    expect(INDEX_FAMILY_PATTERN.test('index.commands.ts')).toBe(true);
    expect(INDEX_FAMILY_PATTERN.test('index.background.ts')).toBe(true);
    expect(INDEX_FAMILY_PATTERN.test('index.split-guard.test.ts')).toBe(false);
    expect(INDEX_FAMILY_PATTERN.test('start.ts')).toBe(false);
  });

  it('reports a dropped export, and follows export * re-export chains', () => {
    const broken = indexFromSources({
      [INDEX_BARREL]: `export * from './index.commands.js';\n`,
      'packages/herdr/src/index.commands.ts': `export const kept = 1;\nexport const dropped = 2;\n`,
    });
    expect(
      findMissingExports(['kept', 'dropped'], collectExportedNames(broken, INDEX_BARREL)),
    ).toEqual([]);
    expect(findMissingExports(['kept', 'gone'], collectExportedNames(broken, INDEX_BARREL))).toEqual([
      'gone',
    ]);
  });

  it('reports a symbol a consumer imports but the barrel no longer exports', () => {
    const broken = indexFromSources({
      [INDEX_BARREL]: `export const kept = 1;\n`,
      'src/cli.ts': `import { kept, gone } from '../packages/herdr/src/index.js';\nexport const x = [kept, gone];\n`,
    });
    const consumers = indexConsumerImportNames(broken, {});
    expect(consumers.has('gone')).toBe(true);
    expect(findMissingExports(consumers.keys(), collectExportedNames(broken, INDEX_BARREL))).toEqual([
      'gone',
    ]);
  });

  it('reports a dynamic-import consumer of a dropped export', () => {
    const usage = dynamicImportNames({
      'src/cli.ts': `const { gone } = await import('../packages/herdr/src/index.js');\nexport const x = gone;\n`,
    });
    expect(usage.has('gone')).toBe(true);
    const broken = indexFromSources({ [INDEX_BARREL]: `export const kept = 1;\n` });
    expect(
      findMissingExports(usage.keys(), collectExportedNames(broken, INDEX_BARREL)),
    ).toEqual(['gone']);
  });

  it('reports the settings call duplicated across two modules', () => {
    const facts = [
      parseIndexModuleFacts(
        'packages/herdr/src/index.commands.ts',
        `const settings = loadSettings();\nexport const a = settings;\n`,
      ),
      parseIndexModuleFacts(
        'packages/herdr/src/index.background.ts',
        `const settings = loadSettings();\nexport const b = settings;\n`,
      ),
    ];
    expect(findSingleCallsiteViolations(facts)).toEqual([
      { callee: 'loadSettings', files: [
        'packages/herdr/src/index.background.ts',
        'packages/herdr/src/index.commands.ts',
      ], total: 2 },
    ]);
  });

  it('reports the settings call twice inside a single module', () => {
    const facts = [
      parseIndexModuleFacts(
        'packages/herdr/src/index.ts',
        `const a = loadSettings();\nconst b = loadSettings();\nexport { a, b };\n`,
      ),
    ];
    expect(findSingleCallsiteViolations(facts)).toEqual([
      { callee: 'loadSettings', files: ['packages/herdr/src/index.ts'], total: 2 },
    ]);
  });

  it('does not count calls inside function bodies as module scope', () => {
    const facts = [
      parseIndexModuleFacts(
        'packages/herdr/src/index.ts',
        `const f = async () => loadSettings();\nfunction g() { loadSettings(); }\nconst h = () => loadSettings();\nexport { f, g, h };\n`,
      ),
    ];
    expect(countModuleScopeCalls(facts, 'loadSettings')).toBe(0);
  });

  it('reports a shared constant declared in two modules', () => {
    const facts = [
      parseIndexModuleFacts(
        'packages/herdr/src/index.ts',
        `const SEND_TO_PI_SCRIPT = '/a';\nexport const a = SEND_TO_PI_SCRIPT;\n`,
      ),
      parseIndexModuleFacts(
        'packages/herdr/src/index.commands.ts',
        `const SEND_TO_PI_SCRIPT = '/b';\nexport const b = SEND_TO_PI_SCRIPT;\n`,
      ),
    ];
    expect(findDuplicateConstantDeclarations(facts)).toEqual([
      { name: 'SEND_TO_PI_SCRIPT', files: [
        'packages/herdr/src/index.commands.ts',
        'packages/herdr/src/index.ts',
      ] },
    ]);
    expect(findSingleDeclarationViolations(facts, ['SEND_TO_PI_SCRIPT'])).toEqual([
      { name: 'SEND_TO_PI_SCRIPT', files: [
        'packages/herdr/src/index.commands.ts',
        'packages/herdr/src/index.ts',
      ] },
    ]);
  });

  it('reports a CONFIGURED_WORKLOG_TARGET-style constant duplicated by an extraction', () => {
    const facts = [
      parseIndexModuleFacts('packages/herdr/src/index.ts', `const CONFIGURED_WORKLOG_TARGET = 1;\nexport const a = 1;\n`),
      parseIndexModuleFacts('packages/herdr/src/index.settings.ts', `const CONFIGURED_WORKLOG_TARGET = 2;\nexport const b = 2;\n`),
    ];
    expect(findDuplicateConstantDeclarations(facts)).toEqual([
      { name: 'CONFIGURED_WORKLOG_TARGET', files: [
        'packages/herdr/src/index.settings.ts',
        'packages/herdr/src/index.ts',
      ] },
    ]);
  });

  it('reports a runtime import of the barrel from a split module', () => {
    const broken = indexFromSources({
      [INDEX_BARREL]: `export const shared = 1;\n`,
      'packages/herdr/src/index.commands.ts': `import { shared } from './index.js';\nexport const local = shared;\n`,
    });
    expect(findBarrelValueImports(broken)).toEqual([
      { file: 'packages/herdr/src/index.commands.ts', specifier: './index.js' },
    ]);
  });

  it('permits a type-only import of the barrel (no runtime cycle)', () => {
    const allowed = indexFromSources({
      [INDEX_BARREL]: `export * from './index.types.js';\nexport const shared = 1;\n`,
      'packages/herdr/src/index.types.ts': `export interface Shared {}\n`,
      'packages/herdr/src/index.commands.ts': `import type { Shared } from './index.js';\nexport const use = (s: Shared) => s;\n`,
    });
    expect(findBarrelValueImports(allowed)).toEqual([]);
    expect(findRuntimeIndexFamilyCycles(allowed)).toEqual([]);
  });

  it('reports a new cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [INDEX_BARREL]: `export * from './index.a.js';\nexport * from './index.b.js';\n`,
      'packages/herdr/src/index.a.ts': `import { b } from './index.b.js';\nexport const a = () => b;\n`,
      'packages/herdr/src/index.b.ts': `import { a } from './index.a.js';\nexport const b = () => a;\n`,
    });
    const cycles = findIndexFamilyCycles(broken);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual([
      'packages/herdr/src/index.a.ts',
      'packages/herdr/src/index.b.ts',
    ]);
    // Not in the baseline, and it is a genuine runtime cycle.
    expect(findCycleBaselineViolations(cycles, INDEX_CYCLE_BASELINE)).toHaveLength(1);
    expect(findRuntimeIndexFamilyCycles(broken)).toHaveLength(1);
  });

  it('reports a baselined cycle edge widened into a runtime import', () => {
    const broken = indexFromSources({
      'packages/herdr/src/downtime-worker.ts': `import { stalled } from './stalled-work.js';\nexport const shared = stalled;\n`,
      'packages/herdr/src/stalled-work.ts': `import { shared } from './downtime-worker.js';\nexport const stalled = shared;\n`,
    });
    expect(findWidenedBaselineEdges(broken, INDEX_TYPE_ONLY_EDGES)).toEqual([
      { from: 'packages/herdr/src/downtime-worker.ts', to: 'packages/herdr/src/stalled-work.ts' },
    ]);
  });

  it('reports a baselined edge that disappeared instead of staying type-only', () => {
    const deleted = indexFromSources({
      'packages/herdr/src/downtime-worker.ts': `export const shared = 1;\n`,
      'packages/herdr/src/stalled-work.ts': `import { shared } from './downtime-worker.js';\nexport const stalled = shared;\n`,
    });
    expect(findWidenedBaselineEdges(deleted, INDEX_TYPE_ONLY_EDGES)).toEqual([]);
    expect(findAbsentBaselineEdges(deleted, INDEX_TYPE_ONLY_EDGES)).toEqual([
      { from: 'packages/herdr/src/downtime-worker.ts', to: 'packages/herdr/src/stalled-work.ts' },
    ]);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({
      'packages/herdr/src/index.commands.ts': lines(MAX_MODULE_LINES + 1),
    });
    expect(
      findOversizedModules(indexFamilyModules(over), [], MAX_MODULE_LINES),
    ).toEqual([
      { file: 'packages/herdr/src/index.commands.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);

    const atCeiling = indexFromSources({
      'packages/herdr/src/index.commands.ts': lines(MAX_MODULE_LINES),
    });
    expect(
      findOversizedModules(indexFamilyModules(atCeiling), [], MAX_MODULE_LINES),
    ).toEqual([]);
  });

  it('exempts the monolith while in flight but rejects allowlist growth', () => {
    const oversized = indexFromSources({
      'packages/herdr/src/index.ts': lines(MAX_MODULE_LINES * 5),
    });
    // The monolith is exempt while the split is in flight…
    expect(
      findOversizedModules(indexFamilyModules(oversized), ['index.ts'], MAX_MODULE_LINES),
    ).toEqual([]);
    // …but the allowlist can never be extended to cover new modules.
    expect(
      findAllowlistViolations(['index.ts', 'index.commands.ts'], INDEX_SPLIT_ALLOWLIST_CEILING),
    ).toEqual(['index.commands.ts']);
    expect(findAllowlistViolations(['index.ts'], INDEX_SPLIT_ALLOWLIST_CEILING)).toEqual([]);
    expect(findAllowlistViolations([], INDEX_SPLIT_ALLOWLIST_CEILING)).toEqual([]);
  });

  it('reports the entry guard moved out of the barrel', () => {
    const facts = [
      parseIndexModuleFacts(INDEX_BARREL, `export const main = () => 1;\n`),
      parseIndexModuleFacts(
        'packages/herdr/src/index.main.ts',
        `const isEntryPoint = true;\nexport const x = isEntryPoint;\n`,
      ),
    ];
    expect(findEntryGuardModules(facts)).toEqual(['packages/herdr/src/index.main.ts']);
    expect(findEntryGuardViolations(facts)).toEqual([
      { expected: INDEX_BARREL, declaring: ['packages/herdr/src/index.main.ts'] },
    ]);
  });

  it('records a baseline cycle only for the modules actually in it', () => {
    // A component contained by the recorded baseline passes; a grown one fails.
    expect(findCycleBaselineViolations([INDEX_CYCLE_BASELINE[0]], INDEX_CYCLE_BASELINE)).toEqual([]);
    const grown = [...INDEX_CYCLE_BASELINE[0], 'packages/herdr/src/newcomer.ts'];
    expect(findCycleBaselineViolations([grown], INDEX_CYCLE_BASELINE)).toEqual([grown.sort()]);
  });
});
