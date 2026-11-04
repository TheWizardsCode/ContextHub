/**
 * tests/interview/split-guard.test.ts — automated gate for the
 * `src/commands/interview.ts` split invariants.
 *
 * Parent: WL-0MVGKGXN80006V9P (decompose the `src/commands/interview.ts` god
 * class). Guard item: WL-0MVXY34A900816MN — child 1 of 7, lands **before** any
 * production code moves.
 *
 * The extraction children move code out of the 1,630-line monolith without
 * touching a single existing expectation, so the unchanged suite is the
 * behaviour oracle. These tests enforce the *structural* half of the contract:
 *
 * | Gate | Acceptance criterion |
 * |---|---|
 * | baseline value + type surface still exported | AC2 |
 * | value exports resolvable at runtime / `default` stays a function | AC2 |
 * | no family module imports the barrel; acyclic, cycle-free graph | AC4 |
 * | ≤ 1,000 lines per family module, shrink-only allowlist | AC1 |
 * | every family module opens with a one-line responsibility JSDoc | AC4 |
 * | every gate fails on deliberately broken input | AC5 |
 *
 * `tests/interview/interview.split-baseline.json` is a frozen contract:
 * regenerate it deliberately, never to make a red gate green.
 *
 *   npx tsx tests/interview/split-guard-scan.ts --write-baseline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BASELINE_GENERATION_COMMAND,
  BASELINE_PATH,
  FAMILY_ROOTS,
  INTERVIEW_BARREL,
  MAX_MODULE_LINES,
  SPLIT_ALLOWLIST,
  SPLIT_ALLOWLIST_CEILING,
  collectExportKinds,
  findAllowlistViolations,
  findBarrelImports,
  findMissingExports,
  findOversizedModules,
  findRuntimeCycles,
  findStaticCycles,
  hasLeadingJsDoc,
  indexFromSources,
  isInterviewFamilyFile,
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

function liveSurface(index = loadModuleIndex(repoRoot, FAMILY_ROOTS)) {
  const kinds = collectExportKinds(index, INTERVIEW_BARREL);
  return {
    kinds,
    values: namesOfKind(kinds, 'value'),
    types: namesOfKind(kinds, 'type'),
  };
}

// ── Gates against the live tree ───────────────────────────────────────

describe('interview split guard — live tree', () => {
  const index = loadModuleIndex(repoRoot, FAMILY_ROOTS);
  const surface = liveSurface(index);

  it('keeps every baseline value export on the barrel (public surface)', () => {
    expect(findMissingExports(readBaseline(repoRoot).symbols.value, surface.values)).toEqual([]);
  });

  it('keeps every baseline type export on the barrel (public surface)', () => {
    expect(findMissingExports(readBaseline(repoRoot).symbols.type, surface.types)).toEqual([]);
  });

  it('classifies every baseline symbol exactly once (no value/type drift)', () => {
    const baseline = readBaseline(repoRoot);
    const expected = [...baseline.symbols.value, ...baseline.symbols.type, 'default'].sort();
    expect([...surface.values, ...surface.types].sort()).toEqual(expected);
    expect(surface.values).toContain('default');
    expect(surface.values).toContain('defaultClearPrompt');
  });

  it('resolves every baseline value export from the barrel at runtime', async () => {
    const baseline = readBaseline(repoRoot);
    const barrel = (await import('../../src/commands/interview.js')) as Record<string, unknown>;
    const missing = baseline.symbols.value.filter(
      (name) => !(name in barrel) || barrel[name] === undefined,
    );
    expect(missing).toEqual([]);
    // The default export is the command registration function.
    expect(typeof barrel.default).toBe('function');
    expect(typeof barrel.runInterview).toBe('function');
    expect(typeof barrel.defaultClearPrompt).toBe('function');
  });

  it('has an acyclic interview-family import graph (static and runtime)', () => {
    expect(findStaticCycles(index)).toEqual([]);
    expect(findRuntimeCycles(index)).toEqual([]);
  });

  it('has no interview-family module importing the barrel (AC4)', () => {
    // Type-only edges are erased at runtime but are still layering violations:
    // the dependency direction is `commands/interview.ts` → `interview/*`.
    expect(findBarrelImports(index)).toEqual([]);
    expect(findBarrelImports(index, true)).toEqual([]);
  });

  it('keeps every interview-family production module within the line ceiling', () => {
    const modules = splitFamilyModules(index);
    expect(modules.map((m) => m.file)).toContain(INTERVIEW_BARREL);
    const oversized = findOversizedModules(modules, SPLIT_ALLOWLIST);
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
    // The allowlist was emptied at closeout: every family module, including
    // the entry, must stay under the ceiling with no exemptions.
    expect(SPLIT_ALLOWLIST).toEqual([]);
    expect(findAllowlistViolations(SPLIT_ALLOWLIST)).toEqual([]);
    expect([...SPLIT_ALLOWLIST_CEILING]).toEqual(['commands/interview.ts']);
  });

  it('documents every interview-family module with a top-level JSDoc header (AC4)', () => {
    const missing = splitFamilyModules(index)
      .filter((m) => !hasLeadingJsDoc(fs.readFileSync(path.join(repoRoot, m.file), 'utf-8')))
      .map((m) => m.file);
    expect(missing).toEqual([]);
  });

  it('documents the guard suite and its scanner with a top-level JSDoc header', () => {
    for (const rel of ['tests/interview/split-guard.test.ts', 'tests/interview/split-guard-scan.ts']) {
      const source = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      expect(hasLeadingJsDoc(source), `${rel} lacks a top-level JSDoc header`).toBe(true);
      expect(source.slice(0, source.indexOf('*/'))).toMatch(/guard/i);
    }
  });
});

// ── The committed baseline artefact (AC2) ─────────────────────────────

describe('interview split baseline', () => {
  const baseline = readBaseline(repoRoot);

  it('records the plan-time surface: 28 named value exports + 12 type exports', () => {
    expect(baseline.symbols.value).toHaveLength(28);
    expect(baseline.symbols.type).toHaveLength(12);
    // `export default function register()` exposes only `default`, so the
    // default export is asserted separately and kept out of the named lists
    // (28 + 12 = 40 named symbols, 41 including the default export).
    expect(baseline.symbols.value).not.toContain('default');
    expect(baseline.symbols.value).not.toContain('register');
  });

  it('records sorted, deduplicated symbol lists', () => {
    for (const list of [baseline.symbols.value, baseline.symbols.type]) {
      expect(list).toEqual([...list].sort());
      expect(new Set(list).size).toBe(list.length);
      for (const symbol of list) expect(symbol).toMatch(/^[\w$]+$/);
    }
  });

  it('flags runtime symbols as value exports and erased types as type exports', () => {
    for (const symbol of ['runInterview', 'defaultClearPrompt', 'parseQAPairs', 'rebuildDescription']) {
      expect(baseline.symbols.value).toContain(symbol);
      expect(baseline.symbols.type).not.toContain(symbol);
    }
    for (const symbol of [
      'ClarifyingSection',
      'ClarifyingQAPair',
      'InterviewStore',
      'ProducerReviewExplanationResult',
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
    expect(baseline.provenance.barrel).toBe(INTERVIEW_BARREL);
    expect(baseline.provenance.consumerGlobs).toContain('src/**/*.ts');
    expect(baseline.provenance.consumerGlobs).toContain('tests/**/*.ts');
  });

  it('matches the live barrel surface exactly and is committed', () => {
    const surface = liveSurface();
    expect(baseline.symbols.value).toEqual(surface.values.filter((n) => n !== 'default'));
    expect(baseline.symbols.type).toEqual(surface.types);
    expect(fs.existsSync(path.join(repoRoot, BASELINE_PATH))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, baseline.provenance.barrel))).toBe(true);
  });
});

// ── Negative cases: each gate must fail on broken input (AC5) ─────────

describe('interview split guard — gates fail on broken input', () => {
  it('identifies the interview family by the barrel and src/interview/ predicates', () => {
    expect(isInterviewFamilyFile('src/commands/interview.ts')).toBe(true);
    expect(isInterviewFamilyFile('src/interview/qa.ts')).toBe(true);
    expect(isInterviewFamilyFile('src/interview/deep/nested.ts')).toBe(true);
    expect(isInterviewFamilyFile('src/commands/interview-helpers.ts')).toBe(false);
    expect(isInterviewFamilyFile('src/interviewer.ts')).toBe(false);
    expect(isInterviewFamilyFile('tests/interview/split-guard.test.ts')).toBe(false);
  });

  it('reports a dropped value export and a dropped type export', () => {
    const broken = indexFromSources({
      [INTERVIEW_BARREL]: `export function keptValue() {}\nexport interface KeptType {}\n`,
    });
    const kinds = collectExportKinds(broken, INTERVIEW_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['keptValue']);
    expect(namesOfKind(kinds, 'type')).toEqual(['KeptType']);
    expect(findMissingExports(['keptValue', 'runInterview'], namesOfKind(kinds, 'value'))).toEqual([
      'runInterview',
    ]);
    expect(findMissingExports(['KeptType', 'ClarifyingSection'], namesOfKind(kinds, 'type'))).toEqual([
      'ClarifyingSection',
    ]);
  });

  it('does not let a type export satisfy a value baseline entry', () => {
    const broken = indexFromSources({ [INTERVIEW_BARREL]: `export interface ClarifyingSection {}\n` });
    const kinds = collectExportKinds(broken, INTERVIEW_BARREL);
    expect(findMissingExports(['ClarifyingSection'], namesOfKind(kinds, 'value'))).toEqual([
      'ClarifyingSection',
    ]);
    expect(findMissingExports(['ClarifyingSection'], namesOfKind(kinds, 'type'))).toEqual([]);
  });

  it('follows export * re-export chains and preserves each symbol kind', () => {
    const split = indexFromSources({
      [INTERVIEW_BARREL]: `export * from '../interview/qa.js';\nexport * from '../interview/section.js';\n`,
      'src/interview/qa.ts': `export function parseQAPairs() {}\nexport const rebuildQAPairs = () => {};\n`,
      'src/interview/section.ts': `export interface ClarifyingSection {}\nexport function extractClarifyingSection() {}\n`,
    });
    const kinds = collectExportKinds(split, INTERVIEW_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['extractClarifyingSection', 'parseQAPairs', 'rebuildQAPairs']);
    expect(namesOfKind(kinds, 'type')).toEqual(['ClarifyingSection']);
  });

  it('reports a synthetic import cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [INTERVIEW_BARREL]: `export * from '../interview/a.js';\nexport * from '../interview/b.js';\n`,
      'src/interview/a.ts': `import { b } from './b.js';\nexport function a() { return b(); }\n`,
      'src/interview/b.ts': `import { a } from './a.js';\nexport function b() { return a(); }\n`,
    });
    expect(findStaticCycles(broken)).toEqual([['src/interview/a.ts', 'src/interview/b.ts']]);
    expect(findRuntimeCycles(broken)).toHaveLength(1);
  });

  it('reports runtime and type-only barrel imports from a family module', () => {
    const typeOnly = indexFromSources({
      [INTERVIEW_BARREL]: `export interface ClarifyingSection {}\n`,
      'src/interview/qa.ts': `import type { ClarifyingSection } from '../commands/interview.js';\nexport const x = (s: ClarifyingSection) => s;\n`,
    });
    expect(findBarrelImports(typeOnly, true)).toEqual([]);
    expect(findBarrelImports(typeOnly)).toEqual([
      { file: 'src/interview/qa.ts', specifier: '../commands/interview.js', typeOnly: true },
    ]);

    const runtime = indexFromSources({
      [INTERVIEW_BARREL]: `import { x } from '../interview/qa.js';\nexport { x };\n`,
      'src/interview/qa.ts': `import { shared } from '../commands/interview.js';\nexport const x = shared;\n`,
    });
    expect(findBarrelImports(runtime, true)).toEqual([
      { file: 'src/interview/qa.ts', specifier: '../commands/interview.js', typeOnly: false },
    ]);
    expect(findRuntimeCycles(runtime)).toHaveLength(1);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({ 'src/interview/huge.ts': lines(MAX_MODULE_LINES + 1) });
    expect(findOversizedModules(splitFamilyModules(over), [], MAX_MODULE_LINES)).toEqual([
      { file: 'src/interview/huge.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);
    const atCeiling = indexFromSources({ 'src/interview/huge.ts': lines(MAX_MODULE_LINES) });
    expect(findOversizedModules(splitFamilyModules(atCeiling), [], MAX_MODULE_LINES)).toEqual([]);
  });

  it('exempts the monolith while in flight but rejects allowlist growth', () => {
    const oversized = indexFromSources({ [INTERVIEW_BARREL]: lines(MAX_MODULE_LINES * 2) });
    expect(findOversizedModules(splitFamilyModules(oversized), ['commands/interview.ts'])).toEqual([]);
    expect(findAllowlistViolations(['commands/interview.ts', 'qa.ts'])).toEqual(['qa.ts']);
    expect(findAllowlistViolations(['commands/interview.ts', 'commands/interview.ts'])).toEqual([
      'commands/interview.ts',
    ]);
    expect(findAllowlistViolations([])).toEqual([]);
  });

  it('counts lines exactly like wc -l', () => {
    const count = (source: string): number =>
      indexFromSources({ 'src/interview/x.ts': source }).byFile.get('src/interview/x.ts')!.lineCount;
    expect(count('')).toBe(0);
    expect(count('one line')).toBe(0);
    expect(count('one line\n')).toBe(1);
    expect(count(lines(MAX_MODULE_LINES))).toBe(MAX_MODULE_LINES);
  });

  it('requires a top-level JSDoc header on the modules the split extracts (AC4)', () => {
    expect(hasLeadingJsDoc('/**\n * src/interview/qa.ts — parses Q/A pairs.\n */\nexport const x = 1;\n')).toBe(true);
    expect(hasLeadingJsDoc('// no JSDoc header\nexport const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('export const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('/** */\nexport const x = 1;\n')).toBe(false);
  });
});
