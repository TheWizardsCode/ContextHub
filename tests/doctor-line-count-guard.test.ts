/**
 * `tests/doctor-line-count-guard.test.ts` — additive line-count guard for the
 * `wl doctor` module family.
 *
 * Parent: WL-0MVGKH1770008MNU (decompose the `src/commands/doctor.ts` god
 * class). Guard item: WL-0MW084U88004DRWJ, the closing child of the split.
 *
 * The deliverable of a move-only refactor is the module *layout*, and the
 * parent's hard invariant is "no doctor file exceeds 1,000 lines". This file
 * is the standing gate for that invariant: it discovers the family from the
 * filesystem (so a newly added module is covered automatically) and enforces
 * three structural criteria:
 *
 * | Gate | Acceptance criterion |
 * |---|---|
 * | every family module is ≤ 1,000 lines | AC1, AC2 |
 * | `src/commands/doctor.ts` stays a thin registrar | AC2 |
 * | the registrar header and `docs/ARCHITECTURE.md` state the module layout | AC3, AC4 |
 *
 * Additive only: it asserts the post-split layout and touches no existing test.
 * The behaviour of every subcommand stays locked by the untouched
 * `tests/doctor-*.test.ts` / `tests/cli/doctor-*.test.ts` suites.
 *
 * Mirrors the `tests/interview/split-guard.test.ts` precedent
 * (WL-0MVXY34A900816MN): the live-tree gates are paired with negative cases
 * that run the *same* helper functions on deliberately oversized input, so a
 * guard that could never fail is itself caught.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/** The maintainability ceiling adopted for the doctor split. */
const MAX_MODULE_LINES = 1000;

/**
 * Thin-registrar target for AC2. The registrar wires the root command and
 * twelve per-subcommand registrars; the split left it at ~60 lines. 300 keeps
 * an order of magnitude of headroom while still failing long before the
 * 1,000-line ceiling makes the "thin" property meaningless.
 */
const REGISTRAR_LINE_TARGET = 300;

/** The stable entry point of the family (`src/command-registry.ts` imports it). */
const REGISTRAR = 'src/commands/doctor.ts';

/** Sibling directory holding one single-concern module per doctor subcommand. */
const FAMILY_DIR = 'src/commands/doctor';

/** Repository root — vitest runs with the repo root as cwd. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface ModuleSize {
  file: string;
  lineCount: number;
}

/**
 * Content lines, at least as strict as `wc -l`: a trailing newline terminates
 * the last line instead of starting another one.
 */
function countLines(source: string): number {
  if (source.length === 0) return 0;
  const terminators = source.split('\n').length - 1;
  return source.endsWith('\n') ? terminators : terminators + 1;
}

/** True for the registrar and any `.ts` module directly under the family dir. */
function isDoctorFamilyFile(relPath: string): boolean {
  const normalised = relPath.split(path.sep).join('/');
  if (normalised === REGISTRAR) return true;
  if (!normalised.startsWith(`${FAMILY_DIR}/`)) return false;
  const rest = normalised.slice(FAMILY_DIR.length + 1);
  return rest.endsWith('.ts') && !rest.includes('/');
}

/** Every family module present on disk, registrar first, then alphabetical. */
function doctorFamilyModules(root: string): string[] {
  const dir = path.join(root, FAMILY_DIR);
  const extracted = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => `${FAMILY_DIR}/${entry.name}`)
        .filter(isDoctorFamilyFile)
        .sort()
    : [];
  return [REGISTRAR, ...extracted].filter((file) => fs.existsSync(path.join(root, file)));
}

/** Modules strictly above the ceiling (the guard predicate itself). */
function findOversizedModules(
  modules: readonly ModuleSize[],
  max: number = MAX_MODULE_LINES,
): ModuleSize[] {
  return modules.filter((module) => module.lineCount > max);
}

/** Measured sizes of the family modules on disk. */
function measureFamily(root: string): ModuleSize[] {
  return doctorFamilyModules(root).map((file) => ({
    file,
    lineCount: countLines(fs.readFileSync(path.join(root, file), 'utf8')),
  }));
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

/** The leading `/** … *\/` block comment of a source file, or `''`. */
function leadingBlockComment(source: string): string {
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  return match ? match[1] : '';
}

/** The `## Doctor Module Layout` section of `docs/ARCHITECTURE.md`, or `''`. */
function doctorLayoutSection(architecture: string): string {
  const header = '## Doctor Module Layout';
  const start = architecture.indexOf(header);
  if (start === -1) return '';
  const next = architecture.indexOf('\n## ', start + header.length);
  return next === -1 ? architecture.slice(start) : architecture.slice(start, next);
}

const family = measureFamily(repoRoot);

// ── Live tree ─────────────────────────────────────────────────────────

describe('doctor line-count guard — live tree', () => {
  it('finds the whole doctor family (guards against a silently empty scan)', () => {
    const files = family.map((module) => module.file);
    expect(files).toContain(REGISTRAR);
    // One module per subcommand plus the shared notices module: the split
    // produced 13 extracted modules. A discovery regression must not turn the
    // ceiling gate into a no-op.
    expect(files.filter((file) => file !== REGISTRAR).length).toBeGreaterThanOrEqual(10);
    expect(files).toContain(`${FAMILY_DIR}/notices.ts`);
    expect(files).toContain(`${FAMILY_DIR}/validate.ts`);
    for (const file of files) expect(isDoctorFamilyFile(file)).toBe(true);
  });

  it(`keeps every doctor module at or under ${MAX_MODULE_LINES} lines`, () => {
    const oversized = findOversizedModules(family).map(
      (module) => `${module.file}: ${module.lineCount} lines`,
    );
    expect(oversized).toEqual([]);
  });

  it('keeps src/commands/doctor.ts a thin registrar', () => {
    const registrar = family.find((module) => module.file === REGISTRAR);
    expect(registrar).toBeDefined();
    expect(registrar!.lineCount).toBeLessThanOrEqual(REGISTRAR_LINE_TARGET);

    // A registrar only defines the root command and delegates registration:
    // action bodies live in the per-subcommand modules.
    const source = read(REGISTRAR);
    expect(source).not.toMatch(/\.action\(/);
    expect(source).toMatch(/export default function register\(/);
  });

  it('states the module layout in the registrar header (AC3)', () => {
    const header = leadingBlockComment(read(REGISTRAR));
    expect(header).not.toBe('');
    expect(header).toContain('Module layout');
    expect(header).toContain(`${FAMILY_DIR}/`);
    // The header must name every extracted module, so adding a module without
    // documenting it fails this gate.
    const documented = family
      .filter((module) => module.file !== REGISTRAR)
      .map((module) => path.basename(module.file, '.ts'));
    expect(documented.length).toBeGreaterThan(0);
    for (const name of documented) {
      expect(header, `${REGISTRAR} header does not mention ${name}.ts`).toContain(name);
    }
  });

  it('keeps the docs/ARCHITECTURE.md doctor layout section accurate (AC4)', () => {
    const section = doctorLayoutSection(read('docs/ARCHITECTURE.md'));
    expect(section).not.toBe('');
    // Every family module on disk must be named in the documented layout.
    for (const module of family) {
      expect(section, `docs/ARCHITECTURE.md does not name ${module.file}`).toContain(module.file);
    }
    // The documented guard test is this file.
    expect(section).toContain('tests/doctor-line-count-guard.test.ts');
  });
});

// ── The guard fails on broken input ───────────────────────────────────

describe('doctor line-count guard — gates fail on broken input', () => {
  it('counts content lines like `wc -l`, including a missing trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one line\n')).toBe(1);
    expect(countLines('one line')).toBe(1);
    expect(countLines('a\nb\nc\n')).toBe(3);
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('// pad\n'.repeat(MAX_MODULE_LINES))).toBe(MAX_MODULE_LINES);
  });

  it('reports a module that exceeds the ceiling', () => {
    const oversized = findOversizedModules([
      { file: `${FAMILY_DIR}/validate.ts`, lineCount: MAX_MODULE_LINES + 1 },
      { file: `${FAMILY_DIR}/cache.ts`, lineCount: 10 },
    ]);
    expect(oversized).toEqual([{ file: `${FAMILY_DIR}/validate.ts`, lineCount: MAX_MODULE_LINES + 1 }]);
  });

  it('accepts the exact ceiling and reports the first line over it', () => {
    expect(findOversizedModules([{ file: REGISTRAR, lineCount: MAX_MODULE_LINES }])).toEqual([]);
    expect(
      findOversizedModules([{ file: REGISTRAR, lineCount: MAX_MODULE_LINES + 1 }]).map((m) => m.file),
    ).toEqual([REGISTRAR]);
  });

  it('flags the registrar itself, not only the extracted modules', () => {
    const oversized = findOversizedModules([
      { file: REGISTRAR, lineCount: MAX_MODULE_LINES * 2 },
      { file: `${FAMILY_DIR}/upgrade.ts`, lineCount: 20 },
    ]);
    expect(oversized.map((module) => module.file)).toEqual([REGISTRAR]);
  });

  it('scopes discovery to the doctor family and ignores neighbouring files', () => {
    expect(isDoctorFamilyFile(REGISTRAR)).toBe(true);
    expect(isDoctorFamilyFile(`${FAMILY_DIR}/prune.ts`)).toBe(true);
    // CLI-agnostic validators under `src/doctor/` are a different family.
    expect(isDoctorFamilyFile('src/doctor/file-paths-check.ts')).toBe(false);
    // Siblings sharing a prefix are not part of the family.
    expect(isDoctorFamilyFile('src/commands/doctor-helpers.ts')).toBe(false);
    expect(isDoctorFamilyFile('src/commands/doctor/notices.js')).toBe(false);
    expect(isDoctorFamilyFile('src/commands/doctor/nested/deep.ts')).toBe(false);
    expect(isDoctorFamilyFile('tests/doctor-line-count-guard.test.ts')).toBe(false);
  });

  it('detects an oversized family member discovered on disk', () => {
    // The live measurement and the ceiling predicate must be the same pair, so
    // a re-implementation drift in the helper is caught here.
    const measured = measureFamily(repoRoot);
    expect(measured.map((module) => module.lineCount)).toEqual(family.map((m) => m.lineCount));
    expect(findOversizedModules(measured, MAX_MODULE_LINES)).toEqual([]);
    // Feeding the same predicate a one-line-over copy of the largest module
    // proves the live gate would reject it.
    const largest = [...family].sort((a, b) => b.lineCount - a.lineCount)[0];
    expect(findOversizedModules([{ ...largest, lineCount: MAX_MODULE_LINES + 1 }])).toHaveLength(1);
  });
});
