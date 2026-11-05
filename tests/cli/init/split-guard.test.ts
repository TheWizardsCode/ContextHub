/**
 * tests/cli/init/split-guard.test.ts — automated gate for the
 * `src/commands/init.ts` split invariants.
 *
 * Parent: WL-0MVGKH6Z1000XWGJ (decompose the `src/commands/init.ts` god class).
 * Guard item: WL-0MW0KDJ20002MV7T — child 1 of 7, lands **before** any
 * production code moves.
 *
 * The extraction children move code out of the 1,521-line monolith without
 * touching a single existing expectation, so the unchanged suite is the
 * behaviour oracle. These tests enforce the *structural* half of the contract:
 *
 * | Gate | Acceptance criterion |
 * |---|---|
 * | baseline value + default surface still exported | AC2 / AC3 |
 * | surface resolvable at runtime from ./init.js | AC3 |
 * | no family module runtime-imports the barrel; acyclic graph | AC5 |
 * | ≤ 1,000 lines per family module, shrink-only allowlist | AC1 / AC4 |
 * | every family module opens with a responsibility JSDoc | AC5 |
 * | hook content survives in the concatenated init*.ts family | AC6 |
 * | every gate fails on deliberately broken input | AC8 |
 *
 * `tests/cli/init/init.split-baseline.json` is a frozen contract: regenerate
 * it deliberately, never to make a red gate green.
 *
 *   npx tsx tests/cli/init/split-guard-scan.ts --write-baseline
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BASELINE_GENERATION_COMMAND,
  BASELINE_PATH,
  CENTRAL_SCRIPT_MARKER,
  FAMILY_ROOTS,
  INIT_BARREL,
  MAX_MODULE_LINES,
  POST_CHECKOUT_MARKER,
  REQUIRED_CENTRAL_SCRIPT_OCCURRENCES,
  REQUIRED_HOOK_STRINGS,
  SPLIT_ALLOWLIST,
  SPLIT_ALLOWLIST_CEILING,
  collectExportKinds,
  countOccurrences,
  findAllowlistViolations,
  findBarrelImports,
  findHookContentViolations,
  findMissingExports,
  findMissingHookContent,
  findOversizedModules,
  findRuntimeCycles,
  findStaticCycles,
  hasLeadingJsDoc,
  indexFromSources,
  initFamilyFiles,
  isInitFamilyFile,
  loadModuleIndex,
  namesOfKind,
  readBaseline,
  readInitFamilySource,
  splitFamilyModules,
} from './split-guard-scan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** `'// pad\n'.repeat(n)` yields a module whose `wc -l` is exactly `n`. */
function lines(n: number): string {
  return '// pad\n'.repeat(n);
}

/** The live barrel surface, classified into value and type exports. */
function liveSurface(index = loadModuleIndex(repoRoot, FAMILY_ROOTS)): {
  kinds: Map<string, 'value' | 'type'>;
  values: string[];
  types: string[];
} {
  const kinds = collectExportKinds(index, INIT_BARREL);
  return { kinds, values: namesOfKind(kinds, 'value'), types: namesOfKind(kinds, 'type') };
}

// ── Gates against the live tree ───────────────────────────────────────

describe('init split guard — live tree', () => {
  const index = loadModuleIndex(repoRoot, FAMILY_ROOTS);
  const surface = liveSurface(index);

  it('keeps every baseline value export on the barrel (public surface)', () => {
    expect(findMissingExports(readBaseline(repoRoot).symbols.value, surface.values)).toEqual([]);
  });

  it('keeps every baseline type export on the barrel (public surface)', () => {
    expect(findMissingExports(readBaseline(repoRoot).symbols.type, surface.types)).toEqual([]);
  });

  it('keeps the default export and classifies every baseline symbol exactly once', () => {
    const baseline = readBaseline(repoRoot);
    expect(surface.values).toContain('default');
    expect(baseline.defaultExport).toBe(true);
    const expected = [...baseline.symbols.value, ...baseline.symbols.type, 'default'].sort();
    expect([...surface.values, ...surface.types].sort()).toEqual(expected);
  });

  it('resolves the public surface from ./init.js at runtime', async () => {
    const barrel = (await import('../../../src/commands/init.js')) as Record<string, unknown>;
    // AC3: both public exports must remain importable from the original path.
    expect(typeof barrel.isSorraAgentsInstalled).toBe('function');
    expect(typeof barrel.default).toBe('function');
    const baseline = readBaseline(repoRoot);
    const missing = baseline.symbols.value.filter(
      (name) => !(name in barrel) || barrel[name] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('has an acyclic init-family import graph (static and runtime)', () => {
    expect(findStaticCycles(index)).toEqual([]);
    expect(findRuntimeCycles(index)).toEqual([]);
  });

  it('has no init-family module importing the barrel at runtime (AC5)', () => {
    // The dependency direction is `commands/init.ts` → `init.<concern>.ts`, so
    // a concern module must never reach back into the barrel at runtime.
    expect(findBarrelImports(index, true)).toEqual([]);
  });

  it('keeps every init-family production module within the line ceiling (AC1)', () => {
    const modules = splitFamilyModules(index);
    expect(modules.map((m) => m.file)).toContain(INIT_BARREL);
    const oversized = findOversizedModules(modules);
    expect(oversized.map((m) => `${m.file}: ${m.lineCount} lines`)).toEqual([]);
    // The monolith is exempt only while the split is in flight (AC4).
    const barrel = modules.find((m) => m.file === INIT_BARREL)!;
    if (barrel.lineCount > MAX_MODULE_LINES) {
      expect([...SPLIT_ALLOWLIST]).toContain('init.ts');
    }
  });

  it('documents every init-family module with a top-level JSDoc header (AC5)', () => {
    const missing = splitFamilyModules(index)
      .filter((m) => !hasLeadingJsDoc(fs.readFileSync(path.join(repoRoot, m.file), 'utf-8')))
      .map((m) => m.file);
    expect(missing).toEqual([]);
  });

  it('only ever shrinks the init split allowlist (AC4)', () => {
    expect(findAllowlistViolations(SPLIT_ALLOWLIST)).toEqual([]);
    expect([...SPLIT_ALLOWLIST_CEILING]).toEqual(['init.ts']);
  });

  it('keeps the hook content in the concatenated init*.ts family (AC6)', () => {
    const familySource = readInitFamilySource(repoRoot);
    expect(findHookContentViolations(familySource)).toEqual([]);
    // Prove the family read is not an empty string that trivially passes.
    expect(familySource).toContain('tmp-worktree');
    expect(familySource).toContain(POST_CHECKOUT_MARKER);
    expect(countOccurrences(familySource, CENTRAL_SCRIPT_MARKER)).toBeGreaterThanOrEqual(
      REQUIRED_CENTRAL_SCRIPT_OCCURRENCES,
    );
    // And the family really is the on-disk init*.ts set.
    expect(initFamilyFiles(repoRoot)).toContain(INIT_BARREL);
  });

  it('documents the guard suite and its scanner with a top-level JSDoc header', () => {
    for (const rel of ['tests/cli/init/split-guard.test.ts', 'tests/cli/init/split-guard-scan.ts']) {
      const source = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      expect(hasLeadingJsDoc(source), `${rel} lacks a top-level JSDoc header`).toBe(true);
      expect(source.slice(0, source.indexOf('*/'))).toMatch(/guard/i);
    }
  });
});

// ── The committed baseline artefact (AC2) ─────────────────────────────

describe('init split baseline', () => {
  const baseline = readBaseline(repoRoot);

  it('records the two plan-time public exports (value + default flagged separately)', () => {
    expect(baseline.symbols.value).toEqual(['isSorraAgentsInstalled']);
    expect(baseline.symbols.type).toEqual([]);
    expect(baseline.defaultExport).toBe(true);
    // `default` is flagged separately, never as a named value export.
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

  it('records provenance that makes the baseline reproducible (AC2)', () => {
    expect(baseline.version).toBe(1);
    expect(baseline.provenance.generatedBy).toBe(BASELINE_GENERATION_COMMAND);
    expect(baseline.provenance.generatedBy).toContain('--write-baseline');
    expect(baseline.provenance.sourceCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isNaN(Date.parse(baseline.provenance.generatedAt))).toBe(false);
    expect(baseline.provenance.barrel).toBe(INIT_BARREL);
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

// ── Negative cases: each gate must fail on broken input (AC8) ─────────

describe('init split guard — gates fail on broken input', () => {
  it('identifies the init family by the top-level init*.ts predicate', () => {
    expect(isInitFamilyFile('src/commands/init.ts')).toBe(true);
    expect(isInitFamilyFile('src/commands/init.hooks.ts')).toBe(true);
    expect(isInitFamilyFile('src/commands/init.agent-template.ts')).toBe(true);
    expect(isInitFamilyFile('src/commands/init/x.ts')).toBe(false);
    expect(isInitFamilyFile('src/commands/initialise.ts')).toBe(false);
    expect(isInitFamilyFile('tests/cli/init/split-guard.test.ts')).toBe(false);
  });

  it('reports a dropped value export and a dropped type export', () => {
    const broken = indexFromSources({
      [INIT_BARREL]: `export function keptValue() {}\nexport interface KeptType {}\n`,
    });
    const kinds = collectExportKinds(broken, INIT_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['keptValue']);
    expect(namesOfKind(kinds, 'type')).toEqual(['KeptType']);
    expect(findMissingExports(['keptValue', 'isSorraAgentsInstalled'], namesOfKind(kinds, 'value'))).toEqual([
      'isSorraAgentsInstalled',
    ]);
    expect(findMissingExports(['KeptType', 'SomeType'], namesOfKind(kinds, 'type'))).toEqual([
      'SomeType',
    ]);
  });

  it('does not let a type export satisfy a value baseline entry', () => {
    const broken = indexFromSources({ [INIT_BARREL]: `export interface SomeType {}\n` });
    const kinds = collectExportKinds(broken, INIT_BARREL);
    expect(findMissingExports(['SomeType'], namesOfKind(kinds, 'value'))).toEqual(['SomeType']);
    expect(findMissingExports(['SomeType'], namesOfKind(kinds, 'type'))).toEqual([]);
  });

  it('follows export * re-export chains and preserves each symbol kind', () => {
    const split = indexFromSources({
      [INIT_BARREL]: `export * from './init.constants.js';\nexport * from './init.types.js';\n`,
      'src/commands/init.constants.ts': `export const WORKLOG_MARKER = 'x';\nexport function helper() {}\n`,
      'src/commands/init.types.ts': `export interface InitOptions {}\nexport type Marker = string;\n`,
    });
    const kinds = collectExportKinds(split, INIT_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['WORKLOG_MARKER', 'helper']);
    expect(namesOfKind(kinds, 'type')).toEqual(['InitOptions', 'Marker']);
  });

  it('follows a `export { default } from` barrel re-export', () => {
    const split = indexFromSources({
      [INIT_BARREL]: `export { isSorraAgentsInstalled } from './init.sorra-agents.js';\nexport { default } from './init.register.js';\n`,
      'src/commands/init.sorra-agents.ts': `export function isSorraAgentsInstalled() { return true; }\n`,
      'src/commands/init.register.ts': `export default function register() {}\n`,
    });
    const kinds = collectExportKinds(split, INIT_BARREL);
    expect(namesOfKind(kinds, 'value')).toEqual(['default', 'isSorraAgentsInstalled']);
  });

  it('reports a synthetic import cycle between two extracted modules', () => {
    const broken = indexFromSources({
      [INIT_BARREL]: `export * from './init.a.js';\nexport * from './init.b.js';\n`,
      'src/commands/init.a.ts': `import { b } from './init.b.js';\nexport function a() { return b(); }\n`,
      'src/commands/init.b.ts': `import { a } from './init.a.js';\nexport function b() { return a(); }\n`,
    });
    expect(findStaticCycles(broken)).toEqual([
      ['src/commands/init.a.ts', 'src/commands/init.b.ts'],
    ]);
    expect(findRuntimeCycles(broken)).toHaveLength(1);
  });

  it('reports a runtime barrel import from a family module', () => {
    const runtime = indexFromSources({
      [INIT_BARREL]: `import { x } from './init.hooks.js';\nexport { x };\n`,
      'src/commands/init.hooks.ts': `import { shared } from './init.js';\nexport const x = shared;\n`,
    });
    expect(findBarrelImports(runtime, true)).toEqual([
      { file: 'src/commands/init.hooks.ts', specifier: './init.js', typeOnly: false },
    ]);
    expect(findRuntimeCycles(runtime)).toHaveLength(1);

    // A type-only barrel edge is erased at runtime and so is not a *runtime*
    // import; the AC5 gate only forbids runtime barrel imports.
    const typeOnly = indexFromSources({
      [INIT_BARREL]: `export interface InitOptions {}\n`,
      'src/commands/init.hooks.ts': `import type { InitOptions } from './init.js';\nexport const x = (o: InitOptions) => o;\n`,
    });
    expect(findBarrelImports(typeOnly, true)).toEqual([]);
    expect(findBarrelImports(typeOnly)).toHaveLength(1);
  });

  it('reports a module one line over the ceiling and passes at the ceiling', () => {
    const over = indexFromSources({ 'src/commands/init.huge.ts': lines(MAX_MODULE_LINES + 1) });
    expect(findOversizedModules(splitFamilyModules(over), [], MAX_MODULE_LINES)).toEqual([
      { file: 'src/commands/init.huge.ts', lineCount: MAX_MODULE_LINES + 1 },
    ]);
    const atCeiling = indexFromSources({ 'src/commands/init.huge.ts': lines(MAX_MODULE_LINES) });
    expect(findOversizedModules(splitFamilyModules(atCeiling), [], MAX_MODULE_LINES)).toEqual([]);
  });

  it('exempts the monolith while in flight but rejects allowlist growth', () => {
    const oversized = indexFromSources({ [INIT_BARREL]: lines(MAX_MODULE_LINES * 2) });
    // `init.ts` is exempt while the split is in flight…
    expect(findOversizedModules(splitFamilyModules(oversized), ['init.ts'])).toEqual([]);
    // …but the allowlist can never be extended to cover a new module.
    expect(findAllowlistViolations(['init.ts', 'init.hooks.ts'])).toEqual(['init.hooks.ts']);
    expect(findAllowlistViolations(['init.ts', 'init.ts'])).toEqual(['init.ts']);
    expect(findAllowlistViolations(['init.ts'])).toEqual([]);
    expect(findAllowlistViolations([])).toEqual([]);
  });

  it('counts lines exactly like wc -l', () => {
    const count = (source: string): number =>
      indexFromSources({ 'src/commands/init.x.ts': source }).byFile.get('src/commands/init.x.ts')!
        .lineCount;
    expect(count('')).toBe(0);
    expect(count('one line')).toBe(0);
    expect(count('one line\n')).toBe(1);
    expect(count('a\nb\n')).toBe(2);
    expect(count(lines(MAX_MODULE_LINES))).toBe(MAX_MODULE_LINES);
  });

  it('reports a removed hook-content string, marker or central block (AC6/AC8)', () => {
    const complete =
      REQUIRED_HOOK_STRINGS.join('\n') +
      `\n${POST_CHECKOUT_MARKER}\n` +
      `${CENTRAL_SCRIPT_MARKER}\n${CENTRAL_SCRIPT_MARKER}\n`;
    expect(findHookContentViolations(complete)).toEqual([]);

    // A dropped string is reported.
    expect(findMissingHookContent(`${POST_CHECKOUT_MARKER}\ngit-dir\n`)).toEqual([
      'tmp-worktree',
      'git-common-dir',
    ]);

    // A dropped post-checkout marker is reported.
    const noPostCheckout =
      REQUIRED_HOOK_STRINGS.join('\n') +
      `\n${CENTRAL_SCRIPT_MARKER}\n${CENTRAL_SCRIPT_MARKER}\n`;
    expect(findHookContentViolations(noPostCheckout)).toContain(
      `missing marker: ${POST_CHECKOUT_MARKER}`,
    );

    // A missing second central script block is reported.
    const oneCentral = REQUIRED_HOOK_STRINGS.join('\n') + `\n${POST_CHECKOUT_MARKER}\n${CENTRAL_SCRIPT_MARKER}\n`;
    expect(findHookContentViolations(oneCentral).some((v) => v.includes(CENTRAL_SCRIPT_MARKER))).toBe(
      true,
    );
  });

  it('requires a top-level JSDoc header on the modules the split extracts (AC5)', () => {
    expect(hasLeadingJsDoc('/**\n * src/commands/init.hooks.ts — installs hooks.\n */\nexport const x = 1;\n')).toBe(true);
    expect(hasLeadingJsDoc('// no JSDoc header\nexport const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('export const x = 1;\n')).toBe(false);
    expect(hasLeadingJsDoc('/** */\nexport const x = 1;\n')).toBe(false);
  });
});
