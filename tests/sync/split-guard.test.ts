/**
 * tests/sync/split-guard.test.ts — automated gate for the `src/sync.ts` split
 * invariants.
 *
 * Parent: WL-0MVGKGMU400631VZ (decompose the `src/sync.ts` god class).
 * Guard item: WL-0MVP9MSJO0099V0G — child 1 of 6, lands **before** any
 * production code moves.
 *
 * ## What this file protects
 *
 * Every extraction child (2–6) moves code out of `src/sync.ts` without touching
 * a single existing test file, so the unchanged suite is the behaviour gate.
 * These tests enforce the *structural* half of the contract:
 *
 * | Gate | Acceptance criterion (this item) |
 * |---|---|
 * | baseline value + type surface still exported | AC2 |
 * | value exports resolvable at runtime / type exports in the declaration | AC2 |
 * | no family module imports the barrel at runtime; no new cycle | AC4 |
 * | ≤ 1,000 lines per family module, shrink-only allowlist | AC1 |
 * | guard suite documented like the modules it protects | AC5 |
 * | every gate fails on deliberately broken input | AC7 |
 *
 * The gates are **additive and read-only**: they parse the module tree with the
 * TypeScript parser (via `./split-guard-scan.js`; no program, no type checker,
 * no new dependency) and assert. Nothing here modifies the tree, the barrel or
 * any other test file.
 *
 * ## Re-baselining
 *
 * `tests/sync/sync.split-baseline.json` is a *frozen contract*: regenerate it
 * deliberately, never to make a red gate green.
 *
 *   npx tsx tests/sync/split-guard-scan.ts --write-baseline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BASELINE_GENERATION_COMMAND,
  BASELINE_PATH,
  FAMILY_ROOTS,
  MAX_MODULE_LINES,
  SPLIT_ALLOWLIST,
  SPLIT_ALLOWLIST_CEILING,
  SYNC_BARREL,
  TYPE_ONLY_BARREL_ALLOWLIST,
  collectExportKinds,
  consumerImportNames,
  dynamicImportNames,
  findAbsentAllowlistedBarrelImports,
  findAllowlistViolations,
  findBarrelImports,
  findBarrelTypeOnlyImportsOutsideAllowlist,
  findMissingExports,
  findOversizedModules,
  findRuntimeCycles,
  findUnexplainedStaticCycles,
  hasLeadingJsDoc,
  indexFromSources,
  isSyncFamilyFile,
  liveConsumerImportNames,
  loadConsumerSources,
  loadModuleIndex,
  namesOfKind,
  readBaseline,
  splitFamilyModules,
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
  const kinds = collectExportKinds(index, SYNC_BARREL);
  const values = namesOfKind(kinds, 'value');
  const types = namesOfKind(kinds, 'type');
  return { kinds, values, types, all: new Set([...values, ...types]) };
}

// ── Gates against the live tree ───────────────────────────────────────

describe('sync split guard — live tree', () => {
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

  it('classifies every baseline symbol exactly once (no value/type drift)', () => {
    // A symbol that quietly flips from an erased type to a runtime value (or
    // the reverse) is a surface change the move-only split must not make.
    const baseline = readBaseline(repoRoot);
    const baselineAll = [...baseline.symbols.value, ...baseline.symbols.type].sort();
    expect([...surface.all].sort()).toEqual(baselineAll);
    expect(surface.all.size).toBe(surface.values.length + surface.types.length);
  });

  it('resolves every baseline value export from ./sync.js at runtime', async () => {
    const baseline = readBaseline(repoRoot);
    const barrel = (await import('../../src/sync.js')) as Record<string, unknown>;
    const missing = baseline.symbols.value.filter(
      (name) => !(name in barrel) || barrel[name] === undefined,
    );
    expect(missing).toEqual([]);
    // Prove the runtime check is not trivially satisfied by an empty module.
    expect(Object.keys(barrel).length).toBeGreaterThanOrEqual(baseline.symbols.value.length);
    expect(typeof barrel.gitPushDataFileToBranch).toBe('function');
    expect(typeof barrel.mergeWorkItems).toBe('function');
  });

  it('keeps every baseline type export in the emitted declaration when a build exists', () => {
    const baseline = readBaseline(repoRoot);
    const declarationPath = path.join('dist', 'sync.d.ts');
    const absolute = path.join(repoRoot, declarationPath);
    if (!fs.existsSync(absolute)) {
      // `dist/` is a gitignored artefact absent in a fresh worktree; the
      // TypeScript source the declaration is emitted from is the always-present
      // equivalent, and the source gate above already checked it. Assert the
      // barrel itself is present so this branch is never a silent no-op.
      expect(fs.existsSync(path.join(repoRoot, SYNC_BARREL))).toBe(true);
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
    const consumers = liveConsumerImportNames(consumerIndex, loadConsumerSources(repoRoot));
    expect(findMissingExports(consumers.keys(), surface.all)).toEqual([]);
    // The suite really reaches the barrel through both shapes, so a scanner
    // that silently drops one would be caught here.
    expect(consumers.has('mergeWorkItems')).toBe(true);
    expect(consumers.has('mergeAuditResults')).toBe(true);
  });

  it('has an acyclic static import graph apart from the recorded type-only edge', () => {
    expect(findUnexplainedStaticCycles(index)).toEqual([]);
  });

  it('adds no runtime (value) import cycle', () => {
    // Type-only cycles are erased at runtime; value cycles are load-order bugs.
    expect(findRuntimeCycles(index)).toEqual([]);
  });

  it('has no sync-family module importing the barrel at runtime', () => {
    expect(findBarrelImports(index, true)).toEqual([]);
  });

  it('allows no sync-family module to import the barrel (allowlist emptied)', () => {
    // Child 2 re-pointed merge-utils.ts at ./types.js, so the allowlist is
    // empty and no family module may hold a type-only — or runtime — barrel
    // edge (WL-0MVP9PCOU004L8HN AC4).
    expect([...TYPE_ONLY_BARREL_ALLOWLIST]).toEqual([]);
    // No module may type-import the barrel…
    expect(findBarrelTypeOnlyImportsOutsideAllowlist(index)).toEqual([]);
    // …and no stale exemption may remain recorded.
    expect(findAbsentAllowlistedBarrelImports(index)).toEqual([]);
    expect(index.byFile.has('src/sync/merge-utils.ts')).toBe(true);
  });

  it('keeps every sync-family production module within the line ceiling', () => {
    const modules = splitFamilyModules(index);
    const files = modules.map((m) => m.file);
    expect(files).toEqual(expect.arrayContaining([SYNC_BARREL, 'src/sync/merge-utils.ts']));
    const oversized = findOversizedModules(modules);
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
    // The monolith began over the ceiling and was exempt only while in
    // flight. With the merge region extracted (WL-0MVP9QLWU003NV41) the barrel
    // is under the ceiling like every other family module; the exemption can
    // therefore never cover a newly oversized module (child 6 empties the
    // allowlist once the barrel is reduced to a thin facade).
    const barrel = modules.find((m) => m.file === SYNC_BARREL)!;
    if (barrel.lineCount > MAX_MODULE_LINES) {
      expect([...SPLIT_ALLOWLIST]).toContain('sync.ts');
    }
  });

  it('documents every sync-family module with a top-level JSDoc header (AC5)', () => {
    // AC5 covers the whole family, not only the files an extraction child
    // created: `src/sync/merge-utils.ts` predates the split but must still
    // open with a header naming its concern, so a reader landing in any
    // sync-family module knows what it owns without reading the body.
    const modules = splitFamilyModules(index);
    expect(modules.map((m) => m.file)).toEqual(
      expect.arrayContaining([SYNC_BARREL, 'src/sync/merge-utils.ts']),
    );
    const missing = modules
      .filter((m) => !hasLeadingJsDoc(fs.readFileSync(path.join(repoRoot, m.file), 'utf-8')))
      .map((m) => m.file);
    expect(missing).toEqual([]);
  });

  it('only ever shrinks the sync split allowlist', () => {
    expect(findAllowlistViolations(SPLIT_ALLOWLIST)).toEqual([]);
    expect([...SPLIT_ALLOWLIST_CEILING]).toEqual(['sync.ts']);
  });

  it('documents the guard suite and its scanner with a top-level JSDoc header', () => {
    // AC5: the standard is established before the extraction children land, so
    // every extracted module is expected to carry the same kind of header.
    for (const rel of ['tests/sync/split-guard.test.ts', 'tests/sync/split-guard-scan.ts']) {
      const source = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      expect(hasLeadingJsDoc(source), `${rel} lacks a top-level JSDoc header`).toBe(true);
      expect(source.slice(0, source.indexOf('*/'))).toMatch(/guard/i);
    }
  });
});

// ── The committed baseline artefact (AC2) ─────────────────────────────

describe('sync split baseline', () => {
  const baseline = readBaseline(repoRoot);

  it('records the 34 plan-time symbols: 25 value exports + 9 type exports', () => {
    expect(baseline.symbols.value).toHaveLength(25);
    expect(baseline.symbols.type).toHaveLength(9);
    expect([...baseline.symbols.value, ...baseline.symbols.type]).toHaveLength(34);
  });

  it('records sorted, deduplicated symbol lists', () => {
    for (const list of [baseline.symbols.value, baseline.symbols.type]) {
      expect(list).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
      for (const symbol of list) expect(symbol).toMatch(/^[\w$]+$/);
    }
  });

  it('flags the runtime symbols consumers call as value exports', () => {
    for (const symbol of [
      'mergeWorkItems',
      'mergeAuditResults',
      'gitPushDataFileToBranch',
      'rewriteAndForcePushDataFile',
      '_testOnly_getRemoteTrackingRef',
    ]) {
      expect(baseline.symbols.value).toContain(symbol);
      expect(baseline.symbols.type).not.toContain(symbol);
    }
  });

  it('flags the erased interfaces and type alias as type exports', () => {
    for (const symbol of [
      'GitTarget',
      'SyncResult',
      'MergeOptions',
      'IncomingCommit',
      'SyncAllowedAuthors',
      'AuthorIdentityOptions',
      'AuthorIdentityViolation',
      'AuthorIdentityResult',
      'DeltaReplayResult',
    ]) {
      expect(baseline.symbols.type).toContain(symbol);
      expect(baseline.symbols.value).not.toContain(symbol);
    }
  });

  it('records provenance that makes the baseline reproducible', () => {
    expect(baseline.version).toBe(1);
    expect(baseline.provenance.generatedBy).toBe(BASELINE_GENERATION_COMMAND);
    expect(baseline.provenance.generatedBy).toContain('--write-baseline');
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.barrel).toBe(SYNC_BARREL);
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
    expect(BASELINE_PATH).toBe('tests/sync/sync.split-baseline.json');
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });
});

// ── Negative cases: each gate must fail on broken input (AC7) ─────────

describe('sync split guard — gates fail on broken input', () => {
  it('identifies the sync family by the top-level sync*.ts and src/sync/ predicates', () => {
    expect(isSyncFamilyFile('src/sync.ts')).toBe(true);
    expect(isSyncFamilyFile('src/sync-defaults.ts')).toBe(true);
    expect(isSyncFamilyFile('src/sync-phase-timings.ts')).toBe(true);
    expect(isSyncFamilyFile('src/sync/merge-utils.ts')).toBe(true);
    expect(isSyncFamilyFile('src/sync/deep/nested.ts')).toBe(true);
    expect(isSyncFamilyFile('src/types.ts')).toBe(false);
    expect(isSyncFamilyFile('src/github-sync.ts')).toBe(false);
    expect(isSyncFamilyFile('tests/sync/split-guard.test.ts')).toBe(false);
  });

  it('reports a dropped value export and a dropped type export', () => {
    const broken = indexFromSources({
      [SYNC_BARREL]: `export function keptValue() {}\nexport interface KeptType {}\n`,
    });
    const kinds = collectExportKinds(broken, SYNC_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['keptValue']);
    expect(namesOfKind(kinds, 'type')).toEqual(['KeptType']);
    expect(findMissingExports(['keptValue', 'gitPushDataFileToBranch'], namesOfKind(kinds, 'value'))).toEqual([
      'gitPushDataFileToBranch',
    ]);
    expect(findMissingExports(['KeptType', 'SyncResult'], namesOfKind(kinds, 'type'))).toEqual([
      'SyncResult',
    ]);
  });

  it('does not let a type export satisfy a value baseline entry', () => {
    const broken = indexFromSources({ [SYNC_BARREL]: `export interface SyncResult {}\n` });
    const kinds = collectExportKinds(broken, SYNC_BARREL);
    // SyncResult is erased at runtime, so it must not pass as a value export.
    expect(findMissingExports(['SyncResult'], namesOfKind(kinds, 'value'))).toEqual([
      'SyncResult',
    ]);
    expect(findMissingExports(['SyncResult'], namesOfKind(kinds, 'type'))).toEqual([]);
  });

  it('follows export * re-export chains and preserves each symbol kind', () => {
    const split = indexFromSources({
      [SYNC_BARREL]: `export * from './sync/merge.js';\nexport * from './sync/types.js';\n`,
      'src/sync/merge.ts': `export function mergeWorkItems() {}\nexport const mergeAuditResults = () => {};\n`,
      'src/sync/types.ts': `export interface MergeOptions {}\nexport type GitTarget = string;\n`,
    });
    const kinds = collectExportKinds(split, SYNC_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['mergeAuditResults', 'mergeWorkItems']);
    expect(namesOfKind(kinds, 'type')).toEqual(['GitTarget', 'MergeOptions']);
  });

  it('reports a consumer import the barrel no longer exports', () => {
    const broken = indexFromSources({
      [SYNC_BARREL]: `export function keptValue() {}\n`,
      'src/consumer.ts': `import { keptValue, gone } from './sync.js';\nexport const x = [keptValue, gone];\n`,
    });
    const consumers = consumerImportNames(broken, SYNC_BARREL);
    expect(consumers.has('gone')).toBe(true);
    expect(findMissingExports(consumers.keys(), namesOfKind(collectExportKinds(broken, SYNC_BARREL), 'value'))).toEqual([
      'gone',
    ]);
  });

  it('reports a dynamic-import consumer of a dropped export', () => {
    const usage = dynamicImportNames(
      {
        'tests/x.test.ts': `const { gone } = await import('../src/sync.js');\nexport const x = gone;\n`,
      },
      SYNC_BARREL,
    );
    expect(usage.has('gone')).toBe(true);
    const broken = indexFromSources({ [SYNC_BARREL]: `export function keptValue() {}\n` });
    expect(findMissingExports(usage.keys(), namesOfKind(collectExportKinds(broken, SYNC_BARREL), 'value'))).toEqual([
      'gone',
    ]);
  });

  it('reports a synthetic import cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [SYNC_BARREL]: `export * from './sync/a.js';\nexport * from './sync/b.js';\n`,
      'src/sync/a.ts': `import { b } from './b.js';\nexport function a() { return b(); }\n`,
      'src/sync/b.ts': `import { a } from './a.js';\nexport function b() { return a(); }\n`,
    });
    expect(findUnexplainedStaticCycles(broken)).toEqual([['src/sync/a.ts', 'src/sync/b.ts']]);
    expect(findRuntimeCycles(broken)).toHaveLength(1);
  });

  it('reports a type-only barrel edge now the allowlist is empty, and a runtime one', () => {
    const typeOnly = indexFromSources({
      [SYNC_BARREL]: `export interface MergeOptions {}\n`,
      'src/sync/merge-utils.ts': `import type { MergeOptions } from '../sync.js';\nexport const x = (o: MergeOptions) => o;\n`,
    });
    // The type-only edge is erased at runtime…
    expect(findBarrelImports(typeOnly, true)).toEqual([]);
    // …but with no allowlisted module it is still a layering violation
    // (WL-0MVP9PCOU004L8HN AC4 emptied the allowlist).
    expect(findBarrelTypeOnlyImportsOutsideAllowlist(typeOnly)).toEqual([
      { file: 'src/sync/merge-utils.ts', specifier: '../sync.js', typeOnly: true },
    ]);
    expect(findUnexplainedStaticCycles(typeOnly)).toEqual([]);

    const runtime = indexFromSources({
      [SYNC_BARREL]: `import { x } from './sync/merge-utils.js';\nexport { x };\n`,
      'src/sync/merge-utils.ts': `import { shared } from '../sync.js';\nexport const x = shared;\n`,
    });
    expect(findBarrelImports(runtime, true)).toEqual([
      { file: 'src/sync/merge-utils.ts', specifier: '../sync.js', typeOnly: false },
    ]);
    expect(findUnexplainedStaticCycles(runtime)).toEqual([
      [SYNC_BARREL, 'src/sync/merge-utils.ts'].sort(),
    ]);
    expect(findRuntimeCycles(runtime)).toHaveLength(1);
  });

  it('reports a type-only barrel import from a module outside the allowlist', () => {
    const broken = indexFromSources({
      [SYNC_BARREL]: `export interface MergeOptions {}\n`,
      'src/sync/new-module.ts': `import type { MergeOptions } from '../sync.js';\nexport const x = (o: MergeOptions) => o;\n`,
    });
    expect(findBarrelTypeOnlyImportsOutsideAllowlist(broken)).toEqual([
      { file: 'src/sync/new-module.ts', specifier: '../sync.js', typeOnly: true },
    ]);
  });

  it('reports an allowlist entry whose type-only barrel import disappeared', () => {
    const stale = indexFromSources({
      [SYNC_BARREL]: `export interface MergeOptions {}\n`,
      'src/sync/merge-utils.ts': `export const x = 1;\n`,
    });
    // Pass the historical allowlist explicitly: the live one is now empty, but
    // the stale-exemption proof must keep working for any future entry.
    expect(
      findAbsentAllowlistedBarrelImports(stale, ['src/sync/merge-utils.ts']),
    ).toEqual(['src/sync/merge-utils.ts']);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({ 'src/sync/huge.ts': lines(MAX_MODULE_LINES + 1) });
    expect(findOversizedModules(splitFamilyModules(over), [], MAX_MODULE_LINES)).toEqual([
      { file: 'src/sync/huge.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);

    const atCeiling = indexFromSources({ 'src/sync/huge.ts': lines(MAX_MODULE_LINES) });
    expect(findOversizedModules(splitFamilyModules(atCeiling), [], MAX_MODULE_LINES)).toEqual([]);
  });

  it('exempts the monolith while in flight but rejects allowlist growth', () => {
    const oversized = indexFromSources({ [SYNC_BARREL]: lines(MAX_MODULE_LINES * 2) });
    // The monolith is exempt while the split is in flight…
    expect(findOversizedModules(splitFamilyModules(oversized), ['sync.ts'])).toEqual([]);
    // …but the allowlist can never be extended to cover a new module.
    expect(findAllowlistViolations(['sync.ts', 'merge-utils.ts'])).toEqual(['merge-utils.ts']);
    expect(findAllowlistViolations(['sync.ts', 'sync.ts'])).toEqual(['sync.ts']);
    expect(findAllowlistViolations(['sync.ts'])).toEqual([]);
    expect(findAllowlistViolations([])).toEqual([]);
  });

  it('counts lines exactly like wc -l', () => {
    const count = (source: string): number =>
      indexFromSources({ 'src/sync/x.ts': source }).byFile.get('src/sync/x.ts')!.lineCount;
    expect(count('')).toBe(0);
    expect(count('one line')).toBe(0);
    expect(count('one line\n')).toBe(1);
    expect(count('a\nb\n')).toBe(2);
    expect(count(lines(MAX_MODULE_LINES))).toBe(MAX_MODULE_LINES);
  });

  it('requires a top-level JSDoc header on the modules the split extracts (AC5)', () => {
    expect(hasLeadingJsDoc('/**\n * src/sync/merge.ts — merges work items.\n */\nexport const x = 1;\n')).toBe(true);
    expect(hasLeadingJsDoc('// no JSDoc header\nexport const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('export const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('/** */\nexport const x = 1;\n')).toBe(false);
  });
});
