/**
 * packages/herdr/src/downtime-log.split-guard.test.ts — automated gate for the
 * `packages/herdr/src/downtime-log.ts` split invariants.
 *
 * Parent: WL-0MVGKHFT4003X6JW (decompose the `downtime-log.ts` god class).
 *
 * ## What this file protects
 *
 * The extraction moved ~1,400 lines out of `packages/herdr/src/downtime-log.ts`
 * into six single-responsibility siblings without touching a single test file.
 * The unchanged `downtime-log.test.ts` suite (and the ~30 worker suites that
 * consume the log) is the behaviour-preservation gate — but nothing in the
 * repository enforced the *structural* half of the contract. These tests are
 * that enforcement.
 *
 * | Gate | Parent AC |
 * |---|---|
 * | frozen public surface at `./downtime-log.js` (names + consumer subset) | AC2, AC3 |
 * | thin barrel: re-export statements only, no behaviour | AC2 |
 * | no family module imports the barrel; no new (or runtime) import cycle | AC4 |
 * | ≤ 1,000 lines per production family module; shrink-only allowlist | AC1 |
 * | responsibility doc on every extracted module, named in the barrel header | AC4 |
 * | the module layout is documented in `docs/dev/downtime-dispatcher.md` | AC5 |
 *
 * The gates are additive and read-only: they scan the module tree with the
 * TypeScript parser (via `../test/split-guard/scan.js` and the family config in
 * `../test/split-guard/downtime-log-family.js`) and assert. Nothing here
 * modifies the tree, the barrel or any other test file.
 *
 * ## Line-ceiling scope
 *
 * `downtime-log.test.ts` stays a single large suite on purpose. The ceiling
 * applies to the modules the split *ships* — `splitFamilyModules` filters test
 * and fixture files out, exactly as every other split guard in this package
 * does (`downtime-worker.test.ts` is 2,200+ lines and is likewise out of
 * scope). Splitting the suites would change the move-only contract AC3 locks.
 *
 * ## Re-baselining
 *
 * `packages/herdr/src/downtime-log.split-baseline.json` is a *frozen* contract:
 * regenerate it deliberately, never to make a red gate green.
 *
 *   npx tsx packages/herdr/test/split-guard/downtime-log-family.ts \
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
  DOWNTIME_LOG_BASELINE_PATH,
  DOWNTIME_LOG_BARREL,
  DOWNTIME_LOG_CONFIG,
  DOWNTIME_LOG_CYCLE_BASELINE,
  DOWNTIME_LOG_RUNTIME_CYCLE_BASELINE,
  DOWNTIME_LOG_SPLIT_ALLOWLIST,
  DOWNTIME_LOG_SPLIT_ALLOWLIST_CEILING,
  SINGLE_OWNER_DECLARATION,
  barrelSymbols,
  consumerSymbols,
  findMissingResponsibilityDocs,
  leadingBlockComment,
  readDowntimeLogBaseline,
} from '../test/split-guard/downtime-log-family.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `'// pad\n'.repeat(n)` yields a file whose `wc -l` is exactly `n`. */
function lines(n: number): string {
  return '// pad\n'.repeat(n);
}

const index = loadModuleIndex(repoRoot, DOWNTIME_LOG_CONFIG.consumerRoots);
const familySources = loadConsumerSources(repoRoot, [DOWNTIME_LOG_CONFIG.familyDir]);
const familyModules = splitFamilyModules(index, DOWNTIME_LOG_CONFIG);
const barrelModule = index.byFile.get(DOWNTIME_LOG_BARREL);

/** The `## Module layout (WL-0MVGKHFT4003X6JW)` section of the dispatcher docs. */
function moduleLayoutSection(docs: string): string {
  const header = '### downtime-log module layout (WL-0MVGKHFT4003X6JW)';
  const start = docs.indexOf(header);
  if (start === -1) return '';
  const next = docs.indexOf('\n### ', start + header.length);
  return next === -1 ? docs.slice(start) : docs.slice(start, next);
}

// ── Gates against the live tree ───────────────────────────────────────

describe('downtime-log split guard — live tree', () => {
  it('discovers the whole family (guards against a silently empty scan)', () => {
    const files = familyModules.map((module) => module.file).sort();
    expect(files).toContain(DOWNTIME_LOG_BARREL);
    // The barrel plus the six extracted modules. A discovery regression must
    // not turn the ceiling gate into a no-op.
    expect(files).toEqual(
      [
        'packages/herdr/src/downtime-log-budget.ts',
        'packages/herdr/src/downtime-log-coordination.ts',
        'packages/herdr/src/downtime-log-entries.ts',
        'packages/herdr/src/downtime-log-markers.ts',
        'packages/herdr/src/downtime-log-recent.ts',
        'packages/herdr/src/downtime-log-storage.ts',
        DOWNTIME_LOG_BARREL,
      ].sort(),
    );
  });

  it('keeps every downtime-log production module within the line ceiling', () => {
    const oversized = findOversizedModules(familyModules, DOWNTIME_LOG_SPLIT_ALLOWLIST);
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
  });

  it('grants no size exemption and only ever shrinks the allowlist', () => {
    // The split landed complete in this item, so nothing is exempt.
    expect(DOWNTIME_LOG_SPLIT_ALLOWLIST).toEqual([]);
    expect(
      findAllowlistViolations(
        DOWNTIME_LOG_SPLIT_ALLOWLIST,
        DOWNTIME_LOG_SPLIT_ALLOWLIST_CEILING,
      ),
    ).toEqual([]);
    expect([...DOWNTIME_LOG_SPLIT_ALLOWLIST_CEILING]).toEqual([
      basename(DOWNTIME_LOG_BARREL),
    ]);
  });

  it('keeps every baseline symbol exported by the barrel (public surface)', () => {
    const baseline = readDowntimeLogBaseline(repoRoot);
    const exported = collectExportedNames(index, DOWNTIME_LOG_BARREL);

    expect(baseline.symbols).toHaveLength(55);
    expect(findMissingExports(baseline.symbols, exported)).toEqual([]);
  });

  it('adds no name the pre-split module did not already export', () => {
    // AC2 is "unchanged", not "at least as large": a barrel that quietly grows
    // the public surface still breaks the move-only contract.
    const baseline = readDowntimeLogBaseline(repoRoot);
    expect(barrelSymbols(index)).toEqual(baseline.symbols);
  });

  it('exports every symbol a live consumer imports', () => {
    expect(findUnexportedConsumerImports(index, DOWNTIME_LOG_BARREL, [])).toEqual([]);
  });

  it('freezes the consumer surface', () => {
    const baseline = readDowntimeLogBaseline(repoRoot);
    expect(consumerSymbols(index)).toEqual(baseline.consumerSymbols);
    expect([...consumerImportNames(index, DOWNTIME_LOG_BARREL).keys()].sort()).toEqual(
      baseline.consumerSymbols,
    );
    // Every consumed symbol must also be part of the declared public surface.
    for (const name of baseline.consumerSymbols) expect(baseline.symbols).toContain(name);
  });

  it('keeps the barrel behaviour-free (re-export statements only)', () => {
    expect(barrelModule).toBeDefined();
    // No declaration of any kind — no helper, no constant, no type. Re-exports
    // are not declarations, so a thin barrel has none.
    expect([...barrelModule!.declarations.keys()]).toEqual([]);
    expect(barrelModule!.exportedNames.length).toBeGreaterThan(0);
    expect(barrelModule!.reexports.length).toBeGreaterThan(0);
  });

  it('has no family module importing the barrel at runtime', () => {
    // Extracted modules import concrete siblings; the barrel is a downstream
    // consumer of them, so a value import of the barrel inverts the layering.
    expect(findBarrelValueImports(index, DOWNTIME_LOG_CONFIG)).toEqual([]);
  });

  it('adds no import cycle outside the recorded baseline', () => {
    expect(DOWNTIME_LOG_CYCLE_BASELINE).toEqual([]);
    expect(findSplitFamilyCycles(index, DOWNTIME_LOG_CONFIG)).toEqual([]);
    expect(
      findCycleBaselineViolations(
        findSplitFamilyCycles(index, DOWNTIME_LOG_CONFIG),
        DOWNTIME_LOG_CYCLE_BASELINE,
      ),
    ).toEqual([]);
  });

  it('adds no runtime (value) import cycle outside the recorded baseline', () => {
    expect(DOWNTIME_LOG_RUNTIME_CYCLE_BASELINE).toEqual([]);
    expect(findRuntimeCycles(index, DOWNTIME_LOG_CONFIG)).toEqual([]);
    expect(
      findCycleBaselineViolations(
        findRuntimeCycles(index, DOWNTIME_LOG_CONFIG),
        DOWNTIME_LOG_RUNTIME_CYCLE_BASELINE,
      ),
    ).toEqual([]);
  });

  it('documents a single responsibility on every extracted module', () => {
    expect(
      findMissingResponsibilityDocs(
        familySources,
        familyModules.map((module) => module.file),
      ),
    ).toEqual([]);
  });

  it('names every extracted module in the barrel header', () => {
    const header = leadingBlockComment(fs.readFileSync(
      path.join(repoRoot, DOWNTIME_LOG_BARREL),
      'utf-8',
    ));
    expect(header).toContain('Module layout');
    for (const module of familyModules) {
      if (module.file === DOWNTIME_LOG_BARREL) continue;
      expect(header, `barrel header does not mention ${module.file}`).toContain(
        basename(module.file),
      );
    }
  });

  it('documents the module layout in docs/dev/downtime-dispatcher.md (AC5)', () => {
    const section = moduleLayoutSection(
      fs.readFileSync(path.join(repoRoot, 'docs/dev/downtime-dispatcher.md'), 'utf-8'),
    );
    expect(section).not.toBe('');
    // The section names each module by its bare filename, matching the
    // sibling `dispatcher-anchor module layout` table in the same document.
    for (const module of familyModules) {
      expect(section, `docs do not name ${basename(module.file)}`).toContain(
        basename(module.file),
      );
    }
    // The documented guard test is this file.
    expect(section).toContain('downtime-log.split-guard.test.ts');
  });

  it('declares no module-scope mutable state (no-op single-owner slot)', () => {
    // `SplitFamilyConfig` requires a single-owner declaration; this family has
    // none, so the field names a sentinel that must never be declared.
    expect(SINGLE_OWNER_DECLARATION).toBe('DOWNTIME_LOG_NO_SHARED_MODULE_STATE');
    expect(findDeclarationModules(familyModules, SINGLE_OWNER_DECLARATION)).toEqual([]);
    expect(countDeclarations(familyModules, SINGLE_OWNER_DECLARATION)).toBe(0);
  });
});

// ── The committed baseline artefact ───────────────────────────────────

describe('downtime-log split baseline', () => {
  const baseline = readDowntimeLogBaseline(repoRoot);

  it('records a sorted, deduplicated, identifier-shaped surface', () => {
    expect(baseline.symbols).toEqual([...baseline.symbols].sort());
    expect(new Set(baseline.symbols).size).toBe(baseline.symbols.length);
    for (const symbol of baseline.symbols) expect(symbol).toMatch(/^[\w$]+$/);
    expect(baseline.consumerSymbols).toEqual([...baseline.consumerSymbols].sort());
    expect(new Set(baseline.consumerSymbols).size).toBe(baseline.consumerSymbols.length);
  });

  it('records provenance that makes the baseline reproducible', () => {
    expect(baseline.provenance.generatedBy).toContain('--write-baseline');
    expect(baseline.provenance.generatedBy).toContain('downtime-log-family.ts');
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.barrel).toBe(DOWNTIME_LOG_BARREL);
    expect(baseline.provenance.consumerGlobs).toContain('packages/herdr/src/**/*.ts');
    expect(baseline.provenance.consumerGlobs).toContain('tests/**/*.ts');
  });

  it('is committed where the guard loads it from', () => {
    expect(fs.existsSync(path.join(repoRoot, DOWNTIME_LOG_BASELINE_PATH))).toBe(true);
    expect(DOWNTIME_LOG_BASELINE_PATH).toBe(
      'packages/herdr/src/downtime-log.split-baseline.json',
    );
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });

  it('records a representative slice of the pre-split surface', () => {
    // A stub or wrongly-scoped baseline would pass the size/format checks.
    for (const name of [
      'DOWNTIME_LOG_FILE',
      'COORDINATION_LOG_FILE',
      'DOWNTIME_LOG_MAX_ENTRIES',
      'HOST_BUDGET_IMPLEMENT_REASON',
      'CoordinationLogEntry',
      'DowntimeLogEntry',
      'PaneCloseLogEntry',
      'appendDowntimeLogEntry',
      'readDowntimeLogEntries',
      'hourlyReasonTally',
      'markerStillExcludes',
      'countAttempts',
      'isNonTerminalCooldownActive',
      'recentDispatchedItems',
      'groupRecentDispatchesByTimeBlock',
    ]) {
      expect(baseline.symbols).toContain(name);
    }
    for (const name of [
      'appendPaneCloseLogEntry',
      'auditDispatchedItemIds',
      'planDispatchedItemStages',
      'recentAuditDispatchedItemIds',
    ]) {
      expect(baseline.consumerSymbols).toContain(name);
    }
  });
});

// ── Negative cases: each gate must fail on broken input ───────────────

describe('downtime-log split guard — gates fail on broken input', () => {
  it('reports a dropped export, and follows export * re-export chains', () => {
    const broken = indexFromSources({
      [DOWNTIME_LOG_BARREL]: `export * from './downtime-log.storage.js';\n`,
      'packages/herdr/src/downtime-log.storage.ts': `export const kept = 1;\nexport interface AlsoKept {}\n`,
    });
    const exported = collectExportedNames(broken, DOWNTIME_LOG_BARREL);
    expect(findMissingExports(['kept', 'AlsoKept'], exported)).toEqual([]);
    expect(findMissingExports(['kept', 'Dropped'], exported)).toEqual(['Dropped']);
  });

  it('reports a symbol a consumer imports but the barrel no longer exports', () => {
    const broken = indexFromSources({
      [DOWNTIME_LOG_BARREL]: `export const kept = 1;\n`,
      'packages/herdr/src/hydrator.ts': `import { kept, gone } from './downtime-log.js';\nexport const x = [kept, gone];\n`,
    });
    expect(consumerImportNames(broken, DOWNTIME_LOG_BARREL).has('gone')).toBe(true);
    expect(findUnexportedConsumerImports(broken, DOWNTIME_LOG_BARREL, [])).toEqual(['gone']);
    expect(findUnexportedConsumerImports(broken, DOWNTIME_LOG_BARREL, ['gone'])).toEqual([]);
  });

  it('reports a thin-barrel regression (behaviour back in the barrel)', () => {
    const broken = indexFromSources({
      [DOWNTIME_LOG_BARREL]: [
        `export * from './downtime-log.storage.js';`,
        `export const DOWNTIME_LOG_EXTRA = 1;`,
        `function helper(): number { return 1; }`,
        ``,
      ].join('\n'),
      'packages/herdr/src/downtime-log.storage.ts': `export const kept = 1;\n`,
    });
    const barrel = broken.byFile.get(DOWNTIME_LOG_BARREL)!;
    expect([...barrel.declarations.keys()].sort()).toEqual(['DOWNTIME_LOG_EXTRA', 'helper']);
    // The live barrel declares nothing; this fixture proves the gate can see it.
    expect([...index.byFile.get(DOWNTIME_LOG_BARREL)!.declarations.keys()]).toEqual([]);
  });

  it('reports a runtime import of the barrel from a family module', () => {
    const broken = indexFromSources({
      [DOWNTIME_LOG_BARREL]: `export const shared = 1;\n`,
      'packages/herdr/src/downtime-log.markers.ts': `import { shared } from './downtime-log.js';\nexport const local = shared;\n`,
    });
    expect(findBarrelValueImports(broken, DOWNTIME_LOG_CONFIG)).toEqual([
      { file: 'packages/herdr/src/downtime-log.markers.ts', specifier: './downtime-log.js' },
    ]);
  });

  it('permits a type-only import of the barrel (no runtime cycle)', () => {
    const allowed = indexFromSources({
      [DOWNTIME_LOG_BARREL]: `export * from './downtime-log.budget.js';\nexport const shared = 1;\n`,
      'packages/herdr/src/downtime-log.budget.ts': `export interface Shared {}\n`,
      'packages/herdr/src/downtime-log.markers.ts': `import type { Shared } from './downtime-log.js';\nexport const use = (s: Shared) => s;\n`,
    });
    expect(findBarrelValueImports(allowed, DOWNTIME_LOG_CONFIG)).toEqual([]);
    expect(findRuntimeCycles(allowed, DOWNTIME_LOG_CONFIG)).toEqual([]);
  });

  it('reports a new cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [DOWNTIME_LOG_BARREL]: `export * from './downtime-log.a.js';\nexport * from './downtime-log.b.js';\n`,
      'packages/herdr/src/downtime-log.a.ts': `import { b } from './downtime-log.b.js';\nexport const a = () => b;\n`,
      'packages/herdr/src/downtime-log.b.ts': `import { a } from './downtime-log.a.js';\nexport const b = () => a;\n`,
    });
    const cycles = findSplitFamilyCycles(broken, DOWNTIME_LOG_CONFIG);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual([
      'packages/herdr/src/downtime-log.a.ts',
      'packages/herdr/src/downtime-log.b.ts',
    ]);
    expect(findCycleBaselineViolations(cycles, DOWNTIME_LOG_CYCLE_BASELINE)).toHaveLength(1);
    expect(findRuntimeCycles(broken, DOWNTIME_LOG_CONFIG)).toHaveLength(1);
    expect(
      findCycleBaselineViolations(
        findRuntimeCycles(broken, DOWNTIME_LOG_CONFIG),
        DOWNTIME_LOG_RUNTIME_CYCLE_BASELINE,
      ),
    ).toHaveLength(1);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({
      'packages/herdr/src/downtime-log.huge.ts': lines(MAX_MODULE_LINES + 1),
    });
    expect(
      findOversizedModules(splitFamilyModules(over, DOWNTIME_LOG_CONFIG), [], MAX_MODULE_LINES),
    ).toEqual([
      { file: 'packages/herdr/src/downtime-log.huge.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);

    const atCeiling = indexFromSources({
      'packages/herdr/src/downtime-log.huge.ts': lines(MAX_MODULE_LINES),
    });
    expect(
      findOversizedModules(
        splitFamilyModules(atCeiling, DOWNTIME_LOG_CONFIG),
        [],
        MAX_MODULE_LINES,
      ),
    ).toEqual([]);
  });

  it('exempts an allowlisted module but rejects allowlist growth', () => {
    const oversized = indexFromSources({
      [DOWNTIME_LOG_BARREL]: lines(MAX_MODULE_LINES * 2),
    });
    // The live allowlist is empty (the split landed complete), so this negative
    // case supplies its own fixture.
    expect(
      findOversizedModules(
        splitFamilyModules(oversized, DOWNTIME_LOG_CONFIG),
        [basename(DOWNTIME_LOG_BARREL)],
        MAX_MODULE_LINES,
      ),
    ).toEqual([]);
    expect(
      findAllowlistViolations(
        ['downtime-log.ts', 'downtime-log.markers.ts'],
        DOWNTIME_LOG_SPLIT_ALLOWLIST_CEILING,
      ),
    ).toEqual(['downtime-log.markers.ts']);
    expect(
      findAllowlistViolations(['downtime-log.ts'], DOWNTIME_LOG_SPLIT_ALLOWLIST_CEILING),
    ).toEqual([]);
  });

  it('reports an extracted module without a stated single responsibility', () => {
    const sources = {
      [DOWNTIME_LOG_BARREL]: `/** Barrel. */\nexport * from './downtime-log.budget.js';\n`,
      'packages/herdr/src/downtime-log.budget.ts': `export const x = 1;\n`,
      'packages/herdr/src/downtime-log.markers.ts': [
        `/**`,
        ` * Markers.`,
        ` *`,
        ` * Single responsibility: marker reads.`,
        ` */`,
        `export const y = 1;`,
        ``,
      ].join('\n'),
      'packages/herdr/src/downtime-log.recent.ts': `/** A doc that never states a responsibility. */\nexport const z = 1;\n`,
    };
    expect(
      findMissingResponsibilityDocs(sources, [
        DOWNTIME_LOG_BARREL,
        'packages/herdr/src/downtime-log.budget.ts',
        'packages/herdr/src/downtime-log.markers.ts',
        'packages/herdr/src/downtime-log.recent.ts',
      ]),
    ).toEqual([
      'packages/herdr/src/downtime-log.budget.ts',
      'packages/herdr/src/downtime-log.recent.ts',
    ]);
  });

  it('reads the leading block comment even with a BOM-free licence preamble', () => {
    expect(leadingBlockComment(`/**\n * Single responsibility: x.\n */\nexport const a = 1;`)).toBe(
      `\n * Single responsibility: x.\n `,
    );
    expect(leadingBlockComment(`// line comment first\nexport const a = 1;`)).toBe('');
  });
});
