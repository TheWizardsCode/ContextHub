/**
 * tests/github/github-split-guard.test.ts — automated gate for the
 * `src/github.ts` split invariants.
 *
 * Parent: WL-0MVGKGR2H006MNVG (decompose the `src/github.ts` god class).
 * Guard item: WL-0MVVLXSQX0031IB3 — child 1 of 8, lands **before** any
 * production code moves.
 *
 * ## What this file protects
 *
 * Every extraction child (2–8) moves code out of `src/github.ts` into
 * `src/github/*` modules without touching a single existing test file, so the
 * unchanged suite (including the nine `vi.mock('../src/github.js', …)` full
 * replacement factories) is the behaviour gate. These tests enforce the
 * *structural* half of the contract:
 *
 * | Gate | Acceptance criterion (this item) |
 * |---|---|
 * | baseline value + type surface still exported | AC2 |
 * | value exports resolvable at runtime / type exports in the declaration | AC2 |
 * | no family module imports the barrel; no static/runtime cycle | AC4 |
 * | ≤ 1,000 lines per family module, shrink-only allowlist | AC1 |
 * | every family module documented with a JSDoc header | AC5 |
 * | guard suite documented like the modules it protects | AC5 |
 * | every gate fails on deliberately broken input | AC7 |
 *
 * The gates are **additive and read-only**: they parse the module tree with the
 * TypeScript parser (via `./github-split-guard-scan.js`; no program, no type
 * checker, no new dependency) and assert. Nothing here modifies the tree, the
 * barrel or any other test file.
 *
 * ## Re-baselining
 *
 * `tests/github/github.split-baseline.json` is a *frozen contract*: regenerate
 * it deliberately, never to make a red gate green.
 *
 *   npx tsx tests/github/github-split-guard-scan.ts --write-baseline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BASELINE_GENERATION_COMMAND,
  BASELINE_PATH,
  FAMILY_ROOTS,
  GITHUB_BARREL,
  GITHUB_SPLIT_ALLOWLIST,
  GITHUB_SPLIT_ALLOWLIST_CEILING,
  MAX_MODULE_LINES,
  TYPE_ONLY_BARREL_ALLOWLIST,
  buildGithubImportGraph,
  collectExportKinds,
  consumerImportNames,
  dynamicImportNames,
  findAbsentAllowlistedGithubBarrelImports,
  findAllowlistViolations,
  findGithubBarrelImports,
  findGithubBarrelTypeOnlyImportsOutsideAllowlist,
  findMissingExports,
  findOversizedModules,
  findRuntimeCyclesForGithub,
  findStaleAllowlistEntries,
  findUnexplainedStaticCyclesForGithub,
  githubFamilyModules,
  githubFamilyModulesRequiringJsDoc,
  hasLeadingJsDoc,
  indexFromSources,
  isGithubFamilyFile,
  liveConsumerImportNames,
  loadConsumerSources,
  loadModuleIndex,
  namesOfKind,
  readBaseline,
} from './github-split-guard-scan.js';

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
  const kinds = collectExportKinds(index, GITHUB_BARREL);
  const values = namesOfKind(kinds, 'value');
  const types = namesOfKind(kinds, 'type');
  return { kinds, values, types, all: new Set([...values, ...types]) };
}

// ── Gates against the live tree ───────────────────────────────────────

describe('github split guard — live tree', () => {
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

  it('resolves every baseline value export from ./github.js at runtime', async () => {
    const baseline = readBaseline(repoRoot);
    const barrel = (await import('../../src/github.js')) as Record<string, unknown>;
    const missing = baseline.symbols.value.filter(
      (name) => !(name in barrel) || barrel[name] === undefined,
    );
    expect(missing).toEqual([]);
    // Prove the runtime check is not trivially satisfied by an empty module.
    expect(Object.keys(barrel).length).toBeGreaterThanOrEqual(baseline.symbols.value.length);
    expect(typeof barrel.createGithubIssueAsync).toBe('function');
    expect(typeof barrel.issueToWorkItemFields).toBe('function');
  });

  it('keeps every baseline type export in the emitted declaration when a build exists', () => {
    const baseline = readBaseline(repoRoot);
    const declarationPath = path.join('dist', 'github.d.ts');
    const absolute = path.join(repoRoot, declarationPath);
    if (!fs.existsSync(absolute)) {
      // `dist/` is a gitignored artefact absent in a fresh worktree; the
      // TypeScript source the declaration is emitted from is the always-present
      // equivalent, and the source gate above already checked it. Assert the
      // barrel itself is present so this branch is never a silent no-op.
      expect(fs.existsSync(path.join(repoRoot, GITHUB_BARREL))).toBe(true);
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
      GITHUB_BARREL,
    );
    expect(findMissingExports(consumers.keys(), surface.all)).toEqual([]);
    // The suite really reaches the barrel through both shapes, so a scanner
    // that silently drops one would be caught here.
    expect(consumers.has('issueToWorkItemFields')).toBe(true);
    expect(consumers.has('createGithubIssueAsync')).toBe(true);
  });

  it('has an acyclic static import graph apart from the recorded type-only edge', () => {
    expect(findUnexplainedStaticCyclesForGithub(index)).toEqual([]);
  });

  it('adds no runtime (value) import cycle', () => {
    // Type-only cycles are erased at runtime; value cycles are load-order bugs.
    expect(findRuntimeCyclesForGithub(index)).toEqual([]);
  });

  it('has no github-family module importing the barrel at runtime', () => {
    expect(findGithubBarrelImports(index, true)).toEqual([]);
  });

  it('allows no github-family module to import the barrel (allowlist empty)', () => {
    expect([...TYPE_ONLY_BARREL_ALLOWLIST]).toEqual([]);
    // No module may type-import the barrel…
    expect(findGithubBarrelTypeOnlyImportsOutsideAllowlist(index)).toEqual([]);
    // …and no stale exemption may remain recorded.
    expect(findAbsentAllowlistedGithubBarrelImports(index)).toEqual([]);
  });

  it('keeps every github-family production module within the line ceiling', () => {
    const modules = githubFamilyModules(index);
    const files = modules.map((m) => m.file);
    expect(files).toContain(GITHUB_BARREL);
    const oversized = findOversizedModules(modules, GITHUB_SPLIT_ALLOWLIST);
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
    // The monolith began over the ceiling and is exempt only while in flight;
    // the final barrel child removes the entry once it is a thin façade.
    const barrel = modules.find((m) => m.file === GITHUB_BARREL)!;
    if (barrel.lineCount > MAX_MODULE_LINES) {
      expect([...GITHUB_SPLIT_ALLOWLIST]).toContain('github.ts');
    }
  });

  it('documents every github-family module with a top-level JSDoc header (AC5)', () => {
    const modules = githubFamilyModulesRequiringJsDoc(index);
    // The in-flight monolith is exempt only while it remains the oversized
    // allowlisted barrel; every module under src/github/ is always covered.
    const barrel = index.byFile.get(GITHUB_BARREL)!;
    const covered = modules.map((m) => m.file);
    if (barrel.lineCount > MAX_MODULE_LINES) {
      expect(covered).not.toContain(GITHUB_BARREL);
    } else {
      expect(covered).toContain(GITHUB_BARREL);
    }
    const missing = modules
      .filter((m) => !hasLeadingJsDoc(fs.readFileSync(path.join(repoRoot, m.file), 'utf-8')))
      .map((m) => m.file);
    expect(missing).toEqual([]);
  });

  it('only ever shrinks the github split allowlist', () => {
    expect(findAllowlistViolations(GITHUB_SPLIT_ALLOWLIST, GITHUB_SPLIT_ALLOWLIST_CEILING)).toEqual(
      [],
    );
    expect([...GITHUB_SPLIT_ALLOWLIST_CEILING]).toEqual(['github.ts']);
  });

  it('exempts the monolith while in flight but no stale allowlist entry lingers', () => {
    const modules = githubFamilyModules(index);
    // Every allowlisted file must still be oversized; an entry that no longer
    // covers an oversized module must be removed (allowlist may only shrink).
    expect(findStaleAllowlistEntries(modules, GITHUB_SPLIT_ALLOWLIST)).toEqual([]);
  });

  it('documents the guard suite and its scanner with a top-level JSDoc header', () => {
    // AC5: the standard is established before the extraction children land, so
    // every extracted module is expected to carry the same kind of header.
    for (const rel of [
      'tests/github/github-split-guard.test.ts',
      'tests/github/github-split-guard-scan.ts',
    ]) {
      const source = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      expect(hasLeadingJsDoc(source), `${rel} lacks a top-level JSDoc header`).toBe(true);
      expect(source.slice(0, source.indexOf('*/'))).toMatch(/guard/i);
    }
  });
});

// ── The committed baseline artefact (AC2) ─────────────────────────────

describe('github split baseline', () => {
  const baseline = readBaseline(repoRoot);

  it('records the 58 plan-time symbols: 52 value exports + 6 type exports', () => {
    expect(baseline.symbols.value).toHaveLength(52);
    expect(baseline.symbols.type).toHaveLength(6);
    expect([...baseline.symbols.value, ...baseline.symbols.type]).toHaveLength(58);
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
      'createGithubIssueAsync',
      'updateGithubIssueAsync',
      'getIssueHierarchyAsync',
      'issueToWorkItemFields',
      'parseRepoSlug',
      'SecondaryRateLimitError',
    ]) {
      expect(baseline.symbols.value).toContain(symbol);
      expect(baseline.symbols.type).not.toContain(symbol);
    }
  });

  it('flags the erased interfaces as type exports', () => {
    for (const symbol of [
      'GithubConfig',
      'GithubIssueRecord',
      'GithubIssueComment',
      'IssueHierarchy',
      'AssignGithubIssueResult',
      'LabelEvent',
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
    expect(baseline.provenance.barrel).toBe(GITHUB_BARREL);
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
    expect(BASELINE_PATH).toBe('tests/github/github.split-baseline.json');
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });
});

// ── Negative cases: each gate must fail on broken input (AC7) ─────────

describe('github split guard — gates fail on broken input', () => {
  it('identifies the github family by the barrel and src/github/ predicates', () => {
    expect(isGithubFamilyFile('src/github.ts')).toBe(true);
    expect(isGithubFamilyFile('src/github/transport.ts')).toBe(true);
    expect(isGithubFamilyFile('src/github/deep/nested.ts')).toBe(true);
    // Flat siblings are unrelated modules and must NOT be treated as family.
    expect(isGithubFamilyFile('src/github-sync.ts')).toBe(false);
    expect(isGithubFamilyFile('src/github-throttler.ts')).toBe(false);
    expect(isGithubFamilyFile('src/github-metrics.ts')).toBe(false);
    expect(isGithubFamilyFile('src/github-pre-filter.ts')).toBe(false);
    expect(isGithubFamilyFile('src/types.ts')).toBe(false);
    expect(isGithubFamilyFile('tests/github/github-split-guard.test.ts')).toBe(false);
  });

  it('reports a dropped value export and a dropped type export', () => {
    const broken = indexFromSources({
      [GITHUB_BARREL]: `export function keptValue() {}\nexport interface KeptType {}\n`,
    });
    const kinds = collectExportKinds(broken, GITHUB_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['keptValue']);
    expect(namesOfKind(kinds, 'type')).toEqual(['KeptType']);
    expect(findMissingExports(['keptValue', 'createGithubIssueAsync'], namesOfKind(kinds, 'value'))).toEqual([
      'createGithubIssueAsync',
    ]);
    expect(findMissingExports(['KeptType', 'GithubConfig'], namesOfKind(kinds, 'type'))).toEqual([
      'GithubConfig',
    ]);
  });

  it('does not let a type export satisfy a value baseline entry', () => {
    const broken = indexFromSources({ [GITHUB_BARREL]: `export interface GithubConfig {}\n` });
    const kinds = collectExportKinds(broken, GITHUB_BARREL);
    // GithubConfig is erased at runtime, so it must not pass as a value export.
    expect(findMissingExports(['GithubConfig'], namesOfKind(kinds, 'value'))).toEqual([
      'GithubConfig',
    ]);
    expect(findMissingExports(['GithubConfig'], namesOfKind(kinds, 'type'))).toEqual([]);
  });

  it('follows export * re-export chains and preserves each symbol kind', () => {
    const split = indexFromSources({
      [GITHUB_BARREL]: `export * from './github/issues.js';\nexport * from './github/types.js';\n`,
      'src/github/issues.ts': `export function createGithubIssueAsync() {}\nexport const issueToWorkItemFields = () => {};\n`,
      'src/github/types.ts': `export interface GithubConfig {}\nexport type LabelEvent = string;\n`,
    });
    const kinds = collectExportKinds(split, GITHUB_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['createGithubIssueAsync', 'issueToWorkItemFields']);
    expect(namesOfKind(kinds, 'type')).toEqual(['GithubConfig', 'LabelEvent']);
  });

  it('reports a consumer import the barrel no longer exports', () => {
    const broken = indexFromSources({
      [GITHUB_BARREL]: `export function keptValue() {}\n`,
      'src/consumer.ts': `import { keptValue, gone } from './github.js';\nexport const x = [keptValue, gone];\n`,
    });
    const consumers = consumerImportNames(broken, GITHUB_BARREL);
    expect(consumers.has('gone')).toBe(true);
    expect(
      findMissingExports(consumers.keys(), namesOfKind(collectExportKinds(broken, GITHUB_BARREL), 'value')),
    ).toEqual(['gone']);
  });

  it('reports a dynamic-import consumer of a dropped export', () => {
    const usage = dynamicImportNames(
      {
        'tests/x.test.ts': `const { gone } = await import('../src/github.js');\nexport const x = gone;\n`,
      },
      GITHUB_BARREL,
    );
    expect(usage.has('gone')).toBe(true);
    const broken = indexFromSources({ [GITHUB_BARREL]: `export function keptValue() {}\n` });
    expect(
      findMissingExports(usage.keys(), namesOfKind(collectExportKinds(broken, GITHUB_BARREL), 'value')),
    ).toEqual(['gone']);
  });

  it('reports a synthetic import cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [GITHUB_BARREL]: `export * from './github/a.js';\nexport * from './github/b.js';\n`,
      'src/github/a.ts': `import { b } from './b.js';\nexport function a() { return b(); }\n`,
      'src/github/b.ts': `import { a } from './a.js';\nexport function b() { return a(); }\n`,
    });
    expect(findUnexplainedStaticCyclesForGithub(broken)).toEqual([
      ['src/github/a.ts', 'src/github/b.ts'],
    ]);
    expect(findRuntimeCyclesForGithub(broken)).toHaveLength(1);
  });

  it('reports a type-only barrel edge and a runtime barrel edge', () => {
    const typeOnly = indexFromSources({
      [GITHUB_BARREL]: `export interface GithubConfig {}\n`,
      'src/github/transport.ts': `import type { GithubConfig } from '../github.js';\nexport const x = (o: GithubConfig) => o;\n`,
    });
    // The type-only edge is erased at runtime…
    expect(findGithubBarrelImports(typeOnly, true)).toEqual([]);
    // …but with an empty allowlist it is still a layering violation.
    expect(findGithubBarrelTypeOnlyImportsOutsideAllowlist(typeOnly)).toEqual([
      { file: 'src/github/transport.ts', specifier: '../github.js', typeOnly: true },
    ]);
    expect(findUnexplainedStaticCyclesForGithub(typeOnly)).toEqual([]);

    const runtime = indexFromSources({
      [GITHUB_BARREL]: `import { x } from './github/transport.js';\nexport { x };\n`,
      'src/github/transport.ts': `import { shared } from '../github.js';\nexport const x = shared;\n`,
    });
    expect(findGithubBarrelImports(runtime, true)).toEqual([
      { file: 'src/github/transport.ts', specifier: '../github.js', typeOnly: false },
    ]);
    expect(findUnexplainedStaticCyclesForGithub(runtime)).toEqual([
      [GITHUB_BARREL, 'src/github/transport.ts'].sort(),
    ]);
    expect(findRuntimeCyclesForGithub(runtime)).toHaveLength(1);
  });

  it('reports an allowlist entry whose type-only barrel import disappeared', () => {
    const stale = indexFromSources({
      [GITHUB_BARREL]: `export interface GithubConfig {}\n`,
      'src/github/transport.ts': `export const x = 1;\n`,
    });
    expect(
      findAbsentAllowlistedGithubBarrelImports(stale, ['src/github/transport.ts']),
    ).toEqual(['src/github/transport.ts']);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({ 'src/github/huge.ts': lines(MAX_MODULE_LINES + 1) });
    expect(findOversizedModules(githubFamilyModules(over), [], MAX_MODULE_LINES)).toEqual([
      { file: 'src/github/huge.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);

    const atCeiling = indexFromSources({ 'src/github/huge.ts': lines(MAX_MODULE_LINES) });
    expect(findOversizedModules(githubFamilyModules(atCeiling), [], MAX_MODULE_LINES)).toEqual([]);
  });

  it('exempts the monolith while in flight but rejects allowlist growth', () => {
    const oversized = indexFromSources({ [GITHUB_BARREL]: lines(MAX_MODULE_LINES * 2) });
    // The monolith is exempt while the split is in flight…
    expect(findOversizedModules(githubFamilyModules(oversized), ['github.ts'])).toEqual([]);
    // …but the allowlist can never be extended to cover a new module.
    expect(findAllowlistViolations(['github.ts', 'issues.ts'], ['github.ts'])).toEqual([
      'issues.ts',
    ]);
    expect(findAllowlistViolations(['github.ts', 'github.ts'], ['github.ts'])).toEqual([
      'github.ts',
    ]);
    expect(findAllowlistViolations(['github.ts'], ['github.ts'])).toEqual([]);
    expect(findAllowlistViolations([], ['github.ts'])).toEqual([]);
  });

  it('reports a stale allowlist entry whose module is no longer oversized', () => {
    const shrunk = indexFromSources({
      [GITHUB_BARREL]: lines(MAX_MODULE_LINES),
    });
    // An entry covering a module at/under the ceiling must be removed.
    expect(findStaleAllowlistEntries(githubFamilyModules(shrunk), ['github.ts'])).toEqual([
      'github.ts',
    ]);
    // A missing allowlisted file is stale too.
    expect(findStaleAllowlistEntries([], ['github.ts'])).toEqual(['github.ts']);

    const oversized = indexFromSources({ [GITHUB_BARREL]: lines(MAX_MODULE_LINES + 1) });
    expect(findStaleAllowlistEntries(githubFamilyModules(oversized), ['github.ts'])).toEqual([]);
  });

  it('builds an import graph only over the github family', () => {
    const graph = buildGithubImportGraph(
      indexFromSources({
        [GITHUB_BARREL]: `export * from './github/a.js';\n`,
        'src/github/a.ts': `export const a = 1;\n`,
        // A non-family file importing a family file must not appear in the graph.
        'src/github-sync.ts': `import { a } from './github/a.js';\nexport const x = a;\n`,
      }),
    );
    expect([...graph.keys()].sort()).toEqual([GITHUB_BARREL, 'src/github/a.ts']);
    expect(graph.get(GITHUB_BARREL)).toEqual([{ to: 'src/github/a.ts', typeOnly: false }]);
  });

  it('counts lines exactly like wc -l', () => {
    const count = (source: string): number =>
      indexFromSources({ 'src/github/x.ts': source }).byFile.get('src/github/x.ts')!.lineCount;
    expect(count('')).toBe(0);
    expect(count('one line')).toBe(0);
    expect(count('one line\n')).toBe(1);
    expect(count('a\nb\n')).toBe(2);
    expect(count(lines(MAX_MODULE_LINES))).toBe(MAX_MODULE_LINES);
  });

  it('requires a top-level JSDoc header on the modules the split extracts (AC5)', () => {
    expect(
      hasLeadingJsDoc('/**\n * src/github/issues.ts — issue CRUD.\n */\nexport const x = 1;\n'),
    ).toBe(true);
    expect(hasLeadingJsDoc('// no JSDoc header\nexport const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('export const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('/** */\nexport const x = 1;\n')).toBe(false);
  });

  it('exempts only the oversized allowlisted barrel from the JSDoc gate', () => {
    const oversized = indexFromSources({ [GITHUB_BARREL]: lines(MAX_MODULE_LINES + 1) });
    // The monolith has no header yet, but is size-allowlisted while in flight.
    expect(githubFamilyModulesRequiringJsDoc(oversized).map((m) => m.file)).toEqual([]);

    const shrunk = indexFromSources({ [GITHUB_BARREL]: lines(MAX_MODULE_LINES) });
    // Once the barrel is a façade it must carry a header like every other module.
    expect(githubFamilyModulesRequiringJsDoc(shrunk).map((m) => m.file)).toEqual([
      GITHUB_BARREL,
    ]);
  });
});
