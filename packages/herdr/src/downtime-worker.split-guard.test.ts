/**
 * packages/herdr/src/downtime-worker.split-guard.test.ts — automated gate for
 * the `downtime-worker.ts` split invariants.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Work item: WL-0MVLIHWOY003IP5E (test-first guard, landed before any code
 * moves).
 *
 * ## What this file protects
 *
 * Every extraction child moves code out of `packages/herdr/src/downtime-worker.ts`
 * without touching a single test file. That makes the 15 existing
 * `downtime-worker.*` suites the behaviour-preservation gate — but nothing in
 * the repository enforced the *structural* half of the contract (unchanged
 * public surface, one `dispatchInFlightCount`, no new/barrel runtime imports,
 * no oversized modules). These tests are that enforcement.
 *
 * The gates are **additive** and read-only: they scan the module tree with the
 * TypeScript parser (via `../test/split-guard/scan.js`) and assert. Nothing
 * here modifies the tree, the barrel or any other test file.
 *
 * ## Gate → parent acceptance criterion mapping
 *
 * | Gate | Parent AC |
 * |---|---|
 * | baseline + current-consumer public surface | AC2, AC3 |
 * | single `dispatchInFlightCount` declaration | AC5 |
 * | no runtime barrel import / no new or runtime cycle | AC4, AC5 |
 * | ≤ 1,000 lines per module, shrink-only allowlist | AC1 |
 *
 * ## Re-baselining
 *
 * `packages/herdr/src/downtime-worker.split-baseline.json` is a *frozen*
 * contract: regenerate it deliberately, never to make a red gate green.
 *
 *   npx tsx packages/herdr/test/split-guard/scan.ts --write-baseline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BARREL,
  BASELINE_PATH,
  CYCLE_BASELINE,
  CYCLE_BASELINE_TYPE_ONLY_EDGES,
  MAX_MODULE_LINES,
  SPLIT_ALLOWLIST,
  SPLIT_ALLOWLIST_CEILING,
  basename,
  collectExportedNames,
  consumerImportNames,
  countDispatchInFlightDeclarations,
  findAbsentBaselineEdges,
  findAllowlistViolations,
  findBarrelValueImports,
  findCycleBaselineViolations,
  findDispatchInFlightDeclarations,
  findMissingExports,
  findOversizedModules,
  findRuntimeCycles,
  findSplitFamilyCycles,
  findWidenedBaselineEdges,
  indexFromSources,
  loadModuleIndex,
  readBaseline,
  splitFamilyModules,
} from '../test/split-guard/scan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `'// pad\n'.repeat(n)` yields a file whose `wc -l` is exactly `n`. */
function lines(n: number): string {
  return '// pad\n'.repeat(n);
}

// ── Gates against the live tree ───────────────────────────────────────

describe('downtime-worker split guard — live tree', () => {
  const index = loadModuleIndex(repoRoot);

  it('keeps every baseline symbol exported by the barrel (public surface)', () => {
    const baseline = readBaseline(repoRoot);
    const exported = collectExportedNames(index, BARREL);

    expect(exported.size).toBeGreaterThan(0);
    // A lost re-export is exactly the failure a move-only split invites.
    expect(findMissingExports(baseline.symbols, exported)).toEqual([]);
  });

  it('exports every symbol the current consumers import from the barrel', () => {
    // Live counterpart of the frozen baseline: it catches a consumer that
    // starts importing a symbol the barrel never re-exports (e.g. a symbol
    // that stayed behind in an extracted module as internal-only).
    const exported = collectExportedNames(index, BARREL);
    expect(findMissingExports(consumerImportNames(index).keys(), exported)).toEqual([]);
  });

  it('discovers consumers in the root tests/ and scripts/ trees too', () => {
    // `isSoftDeleted` is imported only by
    // `tests/unit/downtime-worker-soft-delete.test.ts`, and
    // `scripts/downtime-agreement-sample.ts` imports the barrel as well.
    // Scanning consumers only under `src/` + `packages/herdr/src` let a
    // dropped export pass this guard and fail the full suite instead
    // (WL-0MVLII2OY004S3BN).
    const consumers = consumerImportNames(index);
    expect(consumers.has('isSoftDeleted')).toBe(true);
    expect(consumers.has('isAssigneeHeld')).toBe(true);
  });

  it('declares the single-flight counter in exactly one production module', () => {
    const modules = splitFamilyModules(index);
    expect(modules.length).toBeGreaterThan(0);
    expect(findDispatchInFlightDeclarations(modules)).toHaveLength(1);
    expect(countDispatchInFlightDeclarations(modules)).toBe(1);
  });

  it('has no split-family module importing the barrel at runtime', () => {
    // Extracted modules import concrete siblings; the barrel is a downstream
    // consumer of them, so a value import of the barrel inverts the layering.
    expect(findBarrelValueImports(index)).toEqual([]);
  });

  it('adds no import cycle outside the recorded baseline', () => {
    expect(findCycleBaselineViolations(findSplitFamilyCycles(index))).toEqual([]);
  });

  it('adds no runtime (value) import cycle', () => {
    // Type-only cycles are erased at runtime; value cycles are not. The
    // recorded baseline has no runtime cycle, so any is a regression.
    expect(findRuntimeCycles(index)).toEqual([]);
  });

  it('keeps the pre-existing cycle edges type-only', () => {
    // `stalled-work.ts` imports values from the barrel; the reverse edge
    // (`downtime-worker.ts` → `stalled-work.ts`) must stay a type import —
    // present, and never widened into a value import.
    expect(CYCLE_BASELINE_TYPE_ONLY_EDGES.length).toBeGreaterThan(0);
    expect(findAbsentBaselineEdges(index)).toEqual([]);
    expect(findWidenedBaselineEdges(index)).toEqual([]);
  });

  it('keeps every split-family production module within the line ceiling', () => {
    const oversized = findOversizedModules(splitFamilyModules(index));
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
  });

  it('only ever shrinks the split allowlist', () => {
    expect(findAllowlistViolations(SPLIT_ALLOWLIST)).toEqual([]);
    // The ceiling itself is the plan-time list: the monolith and nothing else.
    expect([...SPLIT_ALLOWLIST_CEILING]).toEqual([basename(BARREL)]);
  });
});

// ── The committed baseline artefact (AC2) ─────────────────────────────

describe('downtime-worker split baseline', () => {
  const baseline = readBaseline(repoRoot);

  it('records a sorted, deduplicated symbol list', () => {
    expect(baseline.symbols.length).toBeGreaterThan(100);
    expect(baseline.symbols).toEqual([...baseline.symbols].sort());
    expect(new Set(baseline.symbols).size).toBe(baseline.symbols.length);
    for (const symbol of baseline.symbols) expect(symbol).toMatch(/^[\w$]+$/);
  });

  it('records provenance that makes the baseline reproducible', () => {
    expect(baseline.provenance.generatedBy).toContain('--write-baseline');
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.barrel).toBe(BARREL);
    expect(baseline.provenance.consumerGlobs).toContain('packages/herdr/src/**/*.ts');
  });

  it('is committed where the guard loads it from', () => {
    expect(fs.existsSync(path.join(repoRoot, BASELINE_PATH))).toBe(true);
    expect(BASELINE_PATH).toBe('packages/herdr/src/downtime-worker.split-baseline.json');
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });

  it('records a representative slice of the current surface', () => {
    // A stub or wrongly-scoped baseline would pass the size/format checks.
    expect(baseline.symbols).toContain('createDowntimeWorker');
    expect(baseline.symbols).toContain('DEFAULT_DOWNTIME_POLL_INTERVAL_MS');
    expect(baseline.symbols).toContain('clampDowntimePollInterval');
    expect(baseline.symbols).toContain('DowntimeCandidate');
  });
});

// ── Negative cases: each gate must fail on broken input (AC7) ─────────

describe('downtime-worker split guard — gates fail on broken input', () => {
  it('reports a dropped export, and follows export * re-export chains', () => {
    const broken = indexFromSources({
      [BARREL]: `export * from './downtime-worker.types.js';\n`,
      'packages/herdr/src/downtime-worker.types.ts': `export interface Kept {}\nexport type AlsoKept = 1;\n`,
    });
    expect(findMissingExports(['Kept', 'AlsoKept'], collectExportedNames(broken, BARREL))).toEqual(
      [],
    );
    expect(
      findMissingExports(['Kept', 'Dropped'], collectExportedNames(broken, BARREL)),
    ).toEqual(['Dropped']);
  });

  it('reports a symbol a consumer imports but the barrel no longer exports', () => {
    const broken = indexFromSources({
      [BARREL]: `export const kept = 1;\n`,
      'src/cli.ts': `import { kept, gone } from '../packages/herdr/src/downtime-worker.js';\nexport const x = [kept, gone];\n`,
    });
    expect(consumerImportNames(broken).has('gone')).toBe(true);
    expect(findMissingExports(consumerImportNames(broken).keys(), collectExportedNames(broken, BARREL)))
      .toEqual(['gone']);
  });

  it('distinguishes type-only consumer imports from value imports', () => {
    const index = indexFromSources({
      [BARREL]: `export interface T {}\nexport const v = 1;\n`,
      'src/consumer.ts': `import { type T, v } from '../packages/herdr/src/downtime-worker.js';\nimport type { T as T2 } from '../packages/herdr/src/downtime-worker.js';\nexport const x = v;\nexport type Y = T | T2;\n`,
    });
    const usage = consumerImportNames(index);
    expect(usage.get('T')).toEqual({ value: false, typeOnly: true });
    expect(usage.get('v')).toEqual({ value: true, typeOnly: false });
  });

  it('reports a duplicated single-flight counter declaration', () => {
    const broken = indexFromSources({
      'packages/herdr/src/downtime-worker.dispatch.ts': `let dispatchInFlightCount = 0;\nexport const dispatch = () => dispatchInFlightCount;\n`,
      'packages/herdr/src/downtime-worker.orchestrator.ts': `let dispatchInFlightCount = 0;\nexport const tick = () => dispatchInFlightCount;\n`,
    });
    const modules = splitFamilyModules(broken);
    expect(countDispatchInFlightDeclarations(modules)).toBe(2);
    expect(findDispatchInFlightDeclarations(modules)).toHaveLength(2);
  });

  it('reports a runtime import of the barrel from a split module', () => {
    const broken = indexFromSources({
      [BARREL]: `export const shared = 1;\n`,
      'packages/herdr/src/downtime-worker.dispatch.ts': `import { shared } from './downtime-worker.js';\nexport const local = shared;\n`,
    });
    expect(findBarrelValueImports(broken)).toEqual([
      {
        file: 'packages/herdr/src/downtime-worker.dispatch.ts',
        specifier: './downtime-worker.js',
      },
    ]);
  });

  it('permits a type-only import of the barrel (no runtime cycle)', () => {
    const allowed = indexFromSources({
      [BARREL]: `export * from './downtime-worker.types.js';\nexport const shared = 1;\n`,
      'packages/herdr/src/downtime-worker.types.ts': `export interface Shared {}\n`,
      'packages/herdr/src/downtime-worker.dispatch.ts': `import type { Shared } from './downtime-worker.js';\nexport const use = (s: Shared) => s;\n`,
    });
    expect(findBarrelValueImports(allowed)).toEqual([]);
    expect(findRuntimeCycles(allowed)).toEqual([]);
  });

  it('reports a new cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [BARREL]: `export * from './downtime-worker.a.js';\nexport * from './downtime-worker.b.js';\n`,
      'packages/herdr/src/downtime-worker.a.ts': `import { b } from './downtime-worker.b.js';\nexport const a = () => b;\n`,
      'packages/herdr/src/downtime-worker.b.ts': `import { a } from './downtime-worker.a.js';\nexport const b = () => a;\n`,
    });
    const cycles = findSplitFamilyCycles(broken);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual([
      'packages/herdr/src/downtime-worker.a.ts',
      'packages/herdr/src/downtime-worker.b.ts',
    ]);
    // Not in the baseline, and it is a genuine runtime cycle.
    expect(findCycleBaselineViolations(cycles)).toHaveLength(1);
    expect(findRuntimeCycles(broken)).toHaveLength(1);
  });

  it('reports a baselined cycle edge widened into a runtime import', () => {
    const broken = indexFromSources({
      [BARREL]: `import { stalled } from './stalled-work.js';\nexport const shared = stalled;\n`,
      'packages/herdr/src/stalled-work.ts': `import { shared } from './downtime-worker.js';\nexport const stalled = shared;\n`,
    });
    // The value edge is caught both directly and as a runtime cycle.
    expect(findWidenedBaselineEdges(broken)).toEqual([
      { from: BARREL, to: 'packages/herdr/src/stalled-work.ts' },
    ]);
    expect(findRuntimeCycles(broken)).toHaveLength(1);
  });

  it('reports a baselined edge that disappeared instead of staying type-only', () => {
    const deleted = indexFromSources({
      [BARREL]: `export const shared = 1;\n`,
      'packages/herdr/src/stalled-work.ts': `import { shared } from './downtime-worker.js';\nexport const stalled = shared;\n`,
    });
    // No widened edge (the import is gone) — but the dependency must exist.
    expect(findWidenedBaselineEdges(deleted)).toEqual([]);
    expect(findAbsentBaselineEdges(deleted)).toEqual([
      { from: BARREL, to: 'packages/herdr/src/stalled-work.ts' },
    ]);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({
      'packages/herdr/src/downtime-worker.huge.ts': lines(MAX_MODULE_LINES + 1),
    });
    expect(findOversizedModules(splitFamilyModules(over), [], MAX_MODULE_LINES)).toEqual([
      { file: 'packages/herdr/src/downtime-worker.huge.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);

    const atCeiling = indexFromSources({
      'packages/herdr/src/downtime-worker.huge.ts': lines(MAX_MODULE_LINES),
    });
    expect(findOversizedModules(splitFamilyModules(atCeiling), [], MAX_MODULE_LINES)).toEqual([]);
  });

  it('exempts allowlisted modules but rejects allowlist growth', () => {
    const oversized = indexFromSources({
      'packages/herdr/src/downtime-worker.ts': lines(MAX_MODULE_LINES * 5),
    });
    // The monolith is exempt while the split is in flight…
    expect(
      findOversizedModules(splitFamilyModules(oversized), ['downtime-worker.ts'], MAX_MODULE_LINES),
    ).toEqual([]);
    // …but the allowlist can never be extended to cover a new module.
    expect(findAllowlistViolations(['downtime-worker.ts', 'downtime-worker.dispatch.ts'])).toEqual([
      'downtime-worker.dispatch.ts',
    ]);
    expect(findAllowlistViolations(['downtime-worker.ts'])).toEqual([]);
    expect(findAllowlistViolations([])).toEqual([]);
  });

  it('records a baseline cycle only for the modules actually in it', () => {
    // A component contained by the baseline passes; a grown component does not.
    expect(findCycleBaselineViolations([CYCLE_BASELINE[0]], CYCLE_BASELINE)).toEqual([]);
    const grown = [...CYCLE_BASELINE[0], 'packages/herdr/src/newcomer.ts'];
    expect(findCycleBaselineViolations([grown], CYCLE_BASELINE)).toEqual([grown.sort()]);
    // Shrinking a cycle is always allowed.
    expect(
      findCycleBaselineViolations([CYCLE_BASELINE[0].filter((f) => f !== BARREL)], CYCLE_BASELINE),
    ).toEqual([]);
  });
});
