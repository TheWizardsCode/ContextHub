/**
 * tests/github-sync/split-guard.test.ts — automated gate for the
 * `src/github-sync.ts` split invariants.
 *
 * Parent: WL-0MVGKH9Z900178UF (decompose the `src/github-sync.ts` god class).
 * Guard item: WL-0MW0JF51F009HNWN — child 1 of 8, lands **before** any
 * production code moves.
 *
 * ## What this file protects
 *
 * Every extraction child (2–8) moves code out of `src/github-sync.ts` into
 * `src/github-sync/*` modules without touching a single existing test file, so
 * the unchanged suite is the behaviour gate. These tests enforce the
 * *structural* half of the contract:
 *
 * | Gate | Acceptance criterion |
 * |---|---|
 * | baseline value + type surface still exported | AC2, AC6 |
 * | no symbol dropped **or** reclassified (value ↔ type) | AC2, AC3, AC6 |
 * | value exports resolvable from `./github-sync.js` at runtime | AC2, AC6 |
 * | no family module imports the barrel; no static/runtime cycle | AC7 |
 * | ≤ 1,000 lines per family module, shrink-only allowlist | AC4 |
 * | every family module documented with a JSDoc header | AC5, AC7 |
 * | guard suite documented like the modules it protects | AC5 |
 * | every gate fails on deliberately broken input | AC3 |
 *
 * The gates are **additive and read-only**: they parse the module tree with the
 * TypeScript parser (via `./split-guard-scan.js`; no program, no type checker,
 * no new dependency) and assert. Nothing here modifies the tree, the barrel or
 * any other test file.
 *
 * ## Re-baselining
 *
 * `tests/github-sync/github-sync.split-baseline.json` is a *frozen contract*:
 * regenerate it deliberately, never to make a red gate green.
 *
 *   npx tsx tests/github-sync/split-guard-scan.ts --write-baseline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BASELINE_GENERATION_COMMAND,
  BASELINE_PATH,
  FAMILY_ROOTS,
  GITHUB_SYNC_BARREL,
  GITHUB_SYNC_SPLIT_ALLOWLIST,
  GITHUB_SYNC_SPLIT_ALLOWLIST_CEILING,
  MAX_MODULE_LINES,
  TYPE_ONLY_BARREL_ALLOWLIST,
  buildGithubSyncImportGraph,
  collectExportKinds,
  consumerImportNames,
  dynamicImportNames,
  findAbsentAllowlistedGithubSyncBarrelImports,
  findAllowlistViolations,
  findGithubSyncBarrelImports,
  findGithubSyncBarrelTypeOnlyImportsOutsideAllowlist,
  findMissingExports,
  findOversizedModules,
  findRuntimeCyclesForGithubSync,
  findStaleAllowlistEntries,
  findSurfaceDrift,
  findUnexplainedStaticCyclesForGithubSync,
  githubSyncFamilyModules,
  githubSyncFamilyModulesRequiringJsDoc,
  hasLeadingJsDoc,
  indexFromSources,
  isGithubSyncFamilyFile,
  liveConsumerImportNames,
  loadConsumerSources,
  loadModuleIndex,
  namesOfKind,
  readBaseline,
} from './split-guard-scan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `'// pad\n'.repeat(n)` yields a module whose `wc -l` is exactly `n`. */
function lines(n: number): string {
  return '// pad\n'.repeat(n);
}

/** The live barrel surface, classified into value and type exports. */
function liveSurface(index = loadModuleIndex(repoRoot, FAMILY_ROOTS)): {
  kinds: Map<string, 'value' | 'type'>;
  values: string[];
  types: string[];
  all: Set<string>;
} {
  const kinds = collectExportKinds(index, GITHUB_SYNC_BARREL);
  const values = namesOfKind(kinds, 'value');
  const types = namesOfKind(kinds, 'type');
  return { kinds, values, types, all: new Set([...values, ...types]) };
}

// ── Gates against the live tree ───────────────────────────────────────

describe('github-sync split guard — live tree', () => {
  const index = loadModuleIndex(repoRoot, FAMILY_ROOTS);
  const surface = liveSurface(index);

  it('keeps every baseline value export on the barrel (public surface)', () => {
    const baseline = readBaseline(repoRoot);
    // A lost re-export is exactly the failure a move-only split invites.
    expect(findMissingExports(baseline.symbols.value, surface.values)).toEqual([]);
  });

  it('keeps every baseline type export on the barrel (public surface)', () => {
    const baseline = readBaseline(repoRoot);
    expect(findMissingExports(baseline.symbols.type, surface.types)).toEqual([]);
  });

  it('keeps the public surface exactly as baselined (no drop, no reclassification)', () => {
    const baseline = readBaseline(repoRoot);
    expect(findSurfaceDrift(baseline.symbols, surface.kinds)).toEqual({
      missingValue: [],
      missingType: [],
      reclassified: [],
      unexpected: [],
    });
    expect(surface.all.size).toBe(surface.values.length + surface.types.length);
  });

  it('resolves every baseline value export from ./github-sync.js at runtime', async () => {
    const baseline = readBaseline(repoRoot);
    const barrel = (await import('../../src/github-sync.js')) as Record<string, unknown>;
    const missing = baseline.symbols.value.filter(
      (name) => !(name in barrel) || barrel[name] === undefined,
    );
    expect(missing).toEqual([]);
    // Prove the runtime check is not trivially satisfied by an empty module.
    expect(Object.keys(barrel).length).toBeGreaterThanOrEqual(baseline.symbols.value.length);
    expect(typeof barrel.upsertIssuesFromWorkItems).toBe('function');
    expect(typeof barrel.importIssuesToWorkItems).toBe('function');
    expect(typeof barrel.resolveLabelField).toBe('function');
    expect(typeof barrel.resolveAllLabelFields).toBe('function');
  });

  it('keeps every baseline type export in the emitted declaration when a build exists', () => {
    const baseline = readBaseline(repoRoot);
    const declarationPath = path.join('dist', 'github-sync.d.ts');
    const absolute = path.join(repoRoot, declarationPath);
    if (!fs.existsSync(absolute)) {
      // `dist/` is a gitignored artefact absent in a fresh worktree; the
      // TypeScript source the declaration is emitted from is the always-present
      // equivalent, and the source gate above already checked it. Assert the
      // barrel itself is present so this branch is never a silent no-op.
      expect(fs.existsSync(path.join(repoRoot, GITHUB_SYNC_BARREL))).toBe(true);
      return;
    }
    const declaration = indexFromSources({
      [declarationPath]: fs.readFileSync(absolute, 'utf-8'),
    });
    const declaredTypes = namesOfKind(collectExportKinds(declaration, declarationPath), 'type');
    expect(findMissingExports(baseline.symbols.type, declaredTypes)).toEqual([]);
  });

  it('exports every symbol consumers import from the barrel (static + dynamic)', () => {
    const consumerIndex = loadModuleIndex(repoRoot);
    const consumers = liveConsumerImportNames(
      consumerIndex,
      loadConsumerSources(repoRoot),
      GITHUB_SYNC_BARREL,
    );
    expect(findMissingExports(consumers.keys(), surface.all)).toEqual([]);
    // The suite really reaches the barrel through both shapes, so a scanner
    // that silently drops one would be caught here.
    expect(consumers.has('upsertIssuesFromWorkItems')).toBe(true);
    expect(consumers.has('importIssuesToWorkItems')).toBe(true);
  });

  it('has an acyclic static import graph apart from the recorded type-only edge', () => {
    // The pre-split family is a single module, so this is trivially green today
    // — and every extraction child must keep it green.
    expect(findUnexplainedStaticCyclesForGithubSync(index)).toEqual([]);
  });

  it('adds no runtime (value) import cycle', () => {
    // Type-only cycles are erased at runtime; value cycles are load-order bugs.
    expect(findRuntimeCyclesForGithubSync(index)).toEqual([]);
  });

  it('has no github-sync-family module importing the barrel at runtime', () => {
    expect(findGithubSyncBarrelImports(index, true)).toEqual([]);
  });

  it('allows no github-sync-family module to import the barrel (allowlist empty)', () => {
    expect([...TYPE_ONLY_BARREL_ALLOWLIST]).toEqual([]);
    // No module may type-import the barrel…
    expect(findGithubSyncBarrelTypeOnlyImportsOutsideAllowlist(index)).toEqual([]);
    // …and no stale exemption may remain recorded.
    expect(findAbsentAllowlistedGithubSyncBarrelImports(index)).toEqual([]);
  });

  it('keeps every github-sync-family production module within the line ceiling', () => {
    const modules = githubSyncFamilyModules(index);
    const files = modules.map((m) => m.file);
    expect(files).toContain(GITHUB_SYNC_BARREL);
    const oversized = findOversizedModules(modules, GITHUB_SYNC_SPLIT_ALLOWLIST);
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
    // The monolith began over the ceiling and is exempt only while in flight;
    // the barrel close-out child removes the entry once it is a thin façade.
    const barrel = modules.find((m) => m.file === GITHUB_SYNC_BARREL)!;
    if (barrel.lineCount > MAX_MODULE_LINES) {
      expect([...GITHUB_SYNC_SPLIT_ALLOWLIST]).toContain('github-sync.ts');
    }
  });

  it('documents every github-sync family module with a top-level JSDoc header', () => {
    const modules = githubSyncFamilyModulesRequiringJsDoc(index);
    // The in-flight monolith is exempt only while it remains the oversized
    // allowlisted barrel; every module under src/github-sync/ is always covered.
    const barrel = index.byFile.get(GITHUB_SYNC_BARREL)!;
    const covered = modules.map((m) => m.file);
    if (barrel.lineCount > MAX_MODULE_LINES) {
      expect(covered).not.toContain(GITHUB_SYNC_BARREL);
    } else {
      expect(covered).toContain(GITHUB_SYNC_BARREL);
    }
    const missing = modules
      .filter((m) => !hasLeadingJsDoc(fs.readFileSync(path.join(repoRoot, m.file), 'utf-8')))
      .map((m) => m.file);
    expect(missing).toEqual([]);
  });

  it('only ever shrinks the github-sync split allowlist', () => {
    expect(
      findAllowlistViolations(GITHUB_SYNC_SPLIT_ALLOWLIST, GITHUB_SYNC_SPLIT_ALLOWLIST_CEILING),
    ).toEqual([]);
    expect([...GITHUB_SYNC_SPLIT_ALLOWLIST_CEILING]).toEqual(['github-sync.ts']);
    // The push-flow child (WL-0MW0JF9QG008E791) dropped the barrel under the
    // ceiling, so the shrink-only entry was removed and no exemption remains.
    expect([...GITHUB_SYNC_SPLIT_ALLOWLIST]).toEqual([]);
  });

  it('exempts the monolith while in flight but no stale allowlist entry lingers', () => {
    const modules = githubSyncFamilyModules(index);
    // Every allowlisted file must still be oversized; an entry that no longer
    // covers an oversized module must be removed (allowlist may only shrink).
    expect(findStaleAllowlistEntries(modules, GITHUB_SYNC_SPLIT_ALLOWLIST)).toEqual([]);
  });

  it('documents the guard suite and its scanner with a top-level JSDoc header', () => {
    // AC5: the standard is established before the extraction children land, so
    // every extracted module is expected to carry the same kind of header.
    for (const rel of [
      'tests/github-sync/split-guard.test.ts',
      'tests/github-sync/split-guard-scan.ts',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      expect(hasLeadingJsDoc(source), `${rel} lacks a top-level JSDoc header`).toBe(true);
      expect(source.slice(0, source.indexOf('*/'))).toMatch(/guard/i);
    }
  });
});

// ── The committed baseline artefact (AC2, AC6) ────────────────────────

describe('github-sync split baseline', () => {
  const baseline = readBaseline(repoRoot);

  it('records the 10 plan-time symbols: 4 value exports + 6 type exports', () => {
    expect(baseline.symbols.value).toHaveLength(4);
    expect(baseline.symbols.type).toHaveLength(6);
    expect([...baseline.symbols.value, ...baseline.symbols.type]).toHaveLength(10);
  });

  it('records sorted, deduplicated symbol lists', () => {
    for (const list of [baseline.symbols.value, baseline.symbols.type]) {
      expect(list).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
      for (const symbol of list) expect(symbol).toMatch(/^[\w$]+$/);
    }
  });

  it('freezes the four value exports consumers call (AC6)', () => {
    expect(baseline.symbols.value).toEqual([
      'importIssuesToWorkItems',
      'resolveAllLabelFields',
      'resolveLabelField',
      'upsertIssuesFromWorkItems',
    ]);
    for (const symbol of baseline.symbols.value) {
      expect(baseline.symbols.type).not.toContain(symbol);
    }
  });

  it('freezes the six erased type exports (AC2)', () => {
    expect(baseline.symbols.type).toEqual([
      'FieldChange',
      'GithubProgress',
      'GithubSyncResult',
      'GithubSyncTiming',
      'SyncErrorItem',
      'SyncedItem',
    ]);
    for (const symbol of baseline.symbols.type) {
      expect(baseline.symbols.value).not.toContain(symbol);
    }
  });

  it('records provenance that makes the baseline reproducible', () => {
    expect(baseline.version).toBe(1);
    expect(baseline.provenance.generatedBy).toBe(BASELINE_GENERATION_COMMAND);
    expect(baseline.provenance.generatedBy).toContain('--write-baseline');
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.barrel).toBe(GITHUB_SYNC_BARREL);
    expect(baseline.provenance.consumerGlobs).toContain('src/**/*.ts');
    expect(baseline.provenance.consumerGlobs).toContain('tests/**/*.ts');
  });

  it('matches the live barrel surface exactly', () => {
    const surface = liveSurface();
    expect(baseline.symbols.value).toEqual(surface.values);
    expect(baseline.symbols.type).toEqual(surface.types);
  });

  it('is committed where the guard loads it from', () => {
    expect(fs.existsSync(path.join(repoRoot, BASELINE_PATH))).toBe(true);
    expect(BASELINE_PATH).toBe('tests/github-sync/github-sync.split-baseline.json');
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });
});

// ── Negative cases: each gate must fail on broken input (AC3) ─────────

describe('github-sync split guard — gates fail on broken input', () => {
  it('identifies the github-sync family by the barrel and split-directory predicates', () => {
    expect(isGithubSyncFamilyFile('src/github-sync.ts')).toBe(true);
    expect(isGithubSyncFamilyFile('src/github-sync/types.ts')).toBe(true);
    expect(isGithubSyncFamilyFile('src/github-sync/deep/nested.ts')).toBe(true);
    // Flat siblings are unrelated modules and must NOT be treated as family.
    expect(isGithubSyncFamilyFile('src/github-sync-labels.ts')).toBe(false);
    expect(isGithubSyncFamilyFile('src/github.ts')).toBe(false);
    expect(isGithubSyncFamilyFile('src/sync.ts')).toBe(false);
    expect(isGithubSyncFamilyFile('tests/github-sync/split-guard.test.ts')).toBe(false);
  });

  it('reports a dropped value export and a dropped type export', () => {
    const broken = indexFromSources({
      [GITHUB_SYNC_BARREL]: `export function keptValue() {}\nexport interface KeptType {}\n`,
    });
    const kinds = collectExportKinds(broken, GITHUB_SYNC_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['keptValue']);
    expect(namesOfKind(kinds, 'type')).toEqual(['KeptType']);
    expect(
      findMissingExports(['keptValue', 'upsertIssuesFromWorkItems'], namesOfKind(kinds, 'value')),
    ).toEqual(['upsertIssuesFromWorkItems']);
    expect(findMissingExports(['KeptType', 'GithubProgress'], namesOfKind(kinds, 'type'))).toEqual([
      'GithubProgress',
    ]);
  });

  it('does not let a type export satisfy a value baseline entry', () => {
    const broken = indexFromSources({
      [GITHUB_SYNC_BARREL]: `export interface SyncedItem {}\n`,
    });
    const kinds = collectExportKinds(broken, GITHUB_SYNC_BARREL);
    // SyncedItem is erased at runtime, so it must not pass as a value export.
    expect(findMissingExports(['SyncedItem'], namesOfKind(kinds, 'value'))).toEqual(['SyncedItem']);
    expect(findMissingExports(['SyncedItem'], namesOfKind(kinds, 'type'))).toEqual([]);
  });

  it('reports a reclassified export separately from a missing one (AC3)', () => {
    // The symbol still exists, but it flipped from an erased type to a runtime
    // value — a surface change a move-only split must never make.
    const broken = indexFromSources({
      [GITHUB_SYNC_BARREL]: [
        `export const SyncedItem = { action: 'created' };`,
        `export function upsertIssuesFromWorkItems() {}`,
      ].join('\n'),
    });
    const kinds = collectExportKinds(broken, GITHUB_SYNC_BARREL);
    const drift = findSurfaceDrift(
      { value: ['upsertIssuesFromWorkItems'], type: ['SyncedItem'] },
      kinds,
    );
    expect(drift).toEqual({
      missingValue: [],
      missingType: [],
      reclassified: [{ name: 'SyncedItem', expected: 'type', actual: 'value' }],
      unexpected: [],
    });

    // The reverse direction (value → type) is reported the same way.
    const flipped = indexFromSources({
      [GITHUB_SYNC_BARREL]: `export interface upsertIssuesFromWorkItems {}\n`,
    });
    expect(
      findSurfaceDrift(
        { value: ['upsertIssuesFromWorkItems'], type: [] },
        collectExportKinds(flipped, GITHUB_SYNC_BARREL),
      ).reclassified,
    ).toEqual([
      { name: 'upsertIssuesFromWorkItems', expected: 'value', actual: 'type' },
    ]);
  });

  it('reports an unexpected export the baseline never recorded', () => {
    const grown = indexFromSources({
      [GITHUB_SYNC_BARREL]: `export function upsertIssuesFromWorkItems() {}\nexport function sneakedIn() {}\n`,
    });
    expect(
      findSurfaceDrift(
        { value: ['upsertIssuesFromWorkItems'], type: [] },
        collectExportKinds(grown, GITHUB_SYNC_BARREL),
      ).unexpected,
    ).toEqual(['sneakedIn']);
  });

  it('follows export * re-export chains and preserves each symbol kind', () => {
    const split = indexFromSources({
      [GITHUB_SYNC_BARREL]: `export * from './github-sync/push.js';\nexport * from './github-sync/types.js';\n`,
      'src/github-sync/push.ts': `export function upsertIssuesFromWorkItems() {}\nexport const resolveLabelField = () => {};\n`,
      'src/github-sync/types.ts': `export interface SyncedItem {}\nexport type FieldChange = string;\n`,
    });
    const kinds = collectExportKinds(split, GITHUB_SYNC_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual([
      'resolveLabelField',
      'upsertIssuesFromWorkItems',
    ]);
    expect(namesOfKind(kinds, 'type')).toEqual(['FieldChange', 'SyncedItem']);
  });

  it('reports a consumer import the barrel no longer exports', () => {
    const broken = indexFromSources({
      [GITHUB_SYNC_BARREL]: `export function keptValue() {}\n`,
      'src/consumer.ts': `import { keptValue, gone } from './github-sync.js';\nexport const x = [keptValue, gone];\n`,
    });
    const consumers = consumerImportNames(broken, GITHUB_SYNC_BARREL);
    expect(consumers.has('gone')).toBe(true);
    expect(
      findMissingExports(
        consumers.keys(),
        namesOfKind(collectExportKinds(broken, GITHUB_SYNC_BARREL), 'value'),
      ),
    ).toEqual(['gone']);
  });

  it('reports a dynamic-import consumer of a dropped export', () => {
    const usage = dynamicImportNames(
      {
        'tests/x.test.ts': `const { gone } = await import('../src/github-sync.js');\nexport const x = gone;\n`,
      },
      GITHUB_SYNC_BARREL,
    );
    expect(usage.has('gone')).toBe(true);
    const broken = indexFromSources({ [GITHUB_SYNC_BARREL]: `export function keptValue() {}\n` });
    expect(
      findMissingExports(
        usage.keys(),
        namesOfKind(collectExportKinds(broken, GITHUB_SYNC_BARREL), 'value'),
      ),
    ).toEqual(['gone']);
  });

  it('reports a synthetic static import cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [GITHUB_SYNC_BARREL]: `export * from './github-sync/a.js';\nexport * from './github-sync/b.js';\n`,
      'src/github-sync/a.ts': `import { b } from './b.js';\nexport function a() { return b(); }\n`,
      'src/github-sync/b.ts': `import { a } from './a.js';\nexport function b() { return a(); }\n`,
    });
    expect(findUnexplainedStaticCyclesForGithubSync(broken)).toEqual([
      ['src/github-sync/a.ts', 'src/github-sync/b.ts'],
    ]);
    expect(findRuntimeCyclesForGithubSync(broken)).toHaveLength(1);
  });

  it('reports a type-only barrel edge and a runtime barrel edge', () => {
    const typeOnly = indexFromSources({
      [GITHUB_SYNC_BARREL]: `export interface SyncedItem {}\n`,
      'src/github-sync/util.ts': `import type { SyncedItem } from '../github-sync.js';\nexport const x = (o: SyncedItem) => o;\n`,
    });
    // The type-only edge is erased at runtime…
    expect(findGithubSyncBarrelImports(typeOnly, true)).toEqual([]);
    // …but with an empty allowlist it is still a layering violation.
    expect(findGithubSyncBarrelTypeOnlyImportsOutsideAllowlist(typeOnly)).toEqual([
      { file: 'src/github-sync/util.ts', specifier: '../github-sync.js', typeOnly: true },
    ]);
    expect(findUnexplainedStaticCyclesForGithubSync(typeOnly)).toEqual([]);

    const runtime = indexFromSources({
      [GITHUB_SYNC_BARREL]: `import { x } from './github-sync/util.js';\nexport { x };\n`,
      'src/github-sync/util.ts': `import { shared } from '../github-sync.js';\nexport const x = shared;\n`,
    });
    expect(findGithubSyncBarrelImports(runtime, true)).toEqual([
      { file: 'src/github-sync/util.ts', specifier: '../github-sync.js', typeOnly: false },
    ]);
    expect(findUnexplainedStaticCyclesForGithubSync(runtime)).toEqual([
      [GITHUB_SYNC_BARREL, 'src/github-sync/util.ts'].sort(),
    ]);
    expect(findRuntimeCyclesForGithubSync(runtime)).toHaveLength(1);
  });

  it('reports an allowlist entry whose type-only barrel import disappeared', () => {
    const stale = indexFromSources({
      [GITHUB_SYNC_BARREL]: `export interface SyncedItem {}\n`,
      'src/github-sync/util.ts': `export const x = 1;\n`,
    });
    expect(findAbsentAllowlistedGithubSyncBarrelImports(stale, ['src/github-sync/util.ts'])).toEqual(
      ['src/github-sync/util.ts'],
    );
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({ 'src/github-sync/huge.ts': lines(MAX_MODULE_LINES + 1) });
    expect(findOversizedModules(githubSyncFamilyModules(over), [], MAX_MODULE_LINES)).toEqual([
      { file: 'src/github-sync/huge.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);

    const atCeiling = indexFromSources({ 'src/github-sync/huge.ts': lines(MAX_MODULE_LINES) });
    expect(findOversizedModules(githubSyncFamilyModules(atCeiling), [], MAX_MODULE_LINES)).toEqual(
      [],
    );
  });

  it('exempts the monolith while in flight but rejects allowlist growth', () => {
    const oversized = indexFromSources({
      [GITHUB_SYNC_BARREL]: lines(MAX_MODULE_LINES * 2),
    });
    // The monolith is exempt while the split is in flight…
    expect(findOversizedModules(githubSyncFamilyModules(oversized), ['github-sync.ts'])).toEqual(
      [],
    );
    // …but the allowlist can never be extended to cover a new module.
    expect(
      findAllowlistViolations(['github-sync.ts', 'push.ts'], ['github-sync.ts']),
    ).toEqual(['push.ts']);
    expect(
      findAllowlistViolations(['github-sync.ts', 'github-sync.ts'], ['github-sync.ts']),
    ).toEqual(['github-sync.ts']);
    expect(findAllowlistViolations(['github-sync.ts'], ['github-sync.ts'])).toEqual([]);
    expect(findAllowlistViolations([], ['github-sync.ts'])).toEqual([]);
  });

  it('reports a stale allowlist entry whose module is no longer oversized', () => {
    const shrunk = indexFromSources({ [GITHUB_SYNC_BARREL]: lines(MAX_MODULE_LINES) });
    // An entry covering a module at/under the ceiling must be removed.
    expect(findStaleAllowlistEntries(githubSyncFamilyModules(shrunk), ['github-sync.ts'])).toEqual(
      ['github-sync.ts'],
    );
    // A missing allowlisted file is stale too.
    expect(findStaleAllowlistEntries([], ['github-sync.ts'])).toEqual(['github-sync.ts']);

    const oversized = indexFromSources({
      [GITHUB_SYNC_BARREL]: lines(MAX_MODULE_LINES + 1),
    });
    expect(
      findStaleAllowlistEntries(githubSyncFamilyModules(oversized), ['github-sync.ts']),
    ).toEqual([]);
  });

  it('builds an import graph only over the github-sync family', () => {
    const graph = buildGithubSyncImportGraph(
      indexFromSources({
        [GITHUB_SYNC_BARREL]: `export * from './github-sync/a.js';\n`,
        'src/github-sync/a.ts': `export const a = 1;\n`,
        // A non-family file importing a family file must not appear in the graph.
        'src/github-sync-extra.ts': `import { a } from './github-sync/a.js';\nexport const x = a;\n`,
      }),
    );
    expect([...graph.keys()].sort()).toEqual([GITHUB_SYNC_BARREL, 'src/github-sync/a.ts']);
    expect(graph.get(GITHUB_SYNC_BARREL)).toEqual([
      { to: 'src/github-sync/a.ts', typeOnly: false },
    ]);
  });

  it('counts lines exactly like wc -l', () => {
    const count = (source: string): number =>
      indexFromSources({ 'src/github-sync/x.ts': source }).byFile.get('src/github-sync/x.ts')!
        .lineCount;
    expect(count('')).toBe(0);
    expect(count('one line')).toBe(0);
    expect(count('one line\n')).toBe(1);
    expect(count('a\nb\n')).toBe(2);
    expect(count(lines(MAX_MODULE_LINES))).toBe(MAX_MODULE_LINES);
  });

  it('reports a missing top-level JSDoc header (AC5, AC7)', () => {
    expect(
      hasLeadingJsDoc(
        '/**\n * src/github-sync/push.ts — issue upsert flow.\n */\nexport const x = 1;\n',
      ),
    ).toBe(true);
    expect(hasLeadingJsDoc('// no JSDoc header\nexport const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('export const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('/** */\nexport const x = 1;\n')).toBe(false);
  });

  it('covers every family module with the JSDoc gate once the allowlist is empty', () => {
    // The push-flow child (WL-0MW0JF9QG008E791) dropped the barrel under the
    // ceiling and so removed the last size exemption: module size no longer
    // exempts anything from the header gate, oversized or not.
    expect([...GITHUB_SYNC_SPLIT_ALLOWLIST]).toEqual([]);

    const oversized = indexFromSources({ [GITHUB_SYNC_BARREL]: lines(MAX_MODULE_LINES + 1) });
    expect(githubSyncFamilyModulesRequiringJsDoc(oversized).map((m) => m.file)).toEqual([
      GITHUB_SYNC_BARREL,
    ]);

    const shrunk = indexFromSources({ [GITHUB_SYNC_BARREL]: lines(MAX_MODULE_LINES) });
    expect(githubSyncFamilyModulesRequiringJsDoc(shrunk).map((m) => m.file)).toEqual([
      GITHUB_SYNC_BARREL,
    ]);

    const extracted = indexFromSources({
      [GITHUB_SYNC_BARREL]: lines(MAX_MODULE_LINES + 1),
      'src/github-sync/push.ts': `export const x = 1;\n`,
    });
    expect(githubSyncFamilyModulesRequiringJsDoc(extracted).map((m) => m.file)).toEqual([
      GITHUB_SYNC_BARREL,
      'src/github-sync/push.ts',
    ]);
  });
});
