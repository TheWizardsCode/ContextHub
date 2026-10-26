/**
 * Structural gate for the sort/audit-cluster extraction
 * (WL-0MVOBP2Q2002ZYCF, parent WL-0MVGKGHNR0019OLT).
 *
 * The deliverable of a move-only refactor *is* the module layout, so the
 * contract is asserted structurally:
 *
 *   - `sort.ts` and `audit.ts` exist;
 *   - every method of this slice lives in exactly one of them, as a top-level
 *     exported function (no class members, no `this.` inside the modules);
 *   - the `database.ts` façade keeps a member with the same name for each of
 *     them and that member really delegates to the extracted function;
 *   - each extracted module stays inside the slice's ≤ 700-line target and
 *     documents its responsibility (parent AC on module boundaries).
 *
 * Acyclicity, the unchanged public surface and the 1,000-line hard ceiling are
 * already enforced by `packages/shared/src/database/decomposition-guard.test.ts`
 * (slice 0), and the *behaviour* is locked by the untouched
 * `database.test.ts` / `audit-fingerprint-repair.test.ts` /
 * `dirty-tracking.test.ts` oracles — this file adds only the placement
 * contract that neither of those covers.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** Repository root — vitest runs with the worktree root as cwd. */
const ROOT = process.cwd();
const SPLIT_DIR = 'packages/shared/src/database';
const FACADE = 'packages/shared/src/database.ts';

/** Slice-1 line target from the parent plan (hard ceiling is 1,000). */
const SLICE_LINE_TARGET = 700;

/** The slice's module → method ownership map (parent Context section). */
const OWNERSHIP: ReadonlyArray<{ module: string; methods: readonly string[] }> = [
  {
    module: 'sort.ts',
    methods: [
      'sortItemsByScore',
      'computeScore',
      'compareAuditNotReadyTier',
      'orderBySortIndex',
      'selectBySortIndex',
      'computeSortIndexOrder',
      'assignSortIndexValues',
      'reSort',
      'assignSortIndexValuesForItems',
      'previewSortIndexOrder',
      'previewSortIndexOrderForItems',
      'getAllOrderedByScore',
    ],
  },
  {
    module: 'audit.ts',
    methods: [
      'isAuditNotReadyFresh',
      'buildAuditMapForItems',
      'saveAuditResult',
      'reconcileAuditInvalidation',
      'getAuditResult',
      'deleteAuditResult',
      'setAuditWaiver',
      'clearAuditWaiver',
      'getAllAuditResults',
      'importAuditResults',
    ],
  },
];

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** Names declared by `export function <name>(` in a module. */
function exportedFunctions(source: string): string[] {
  const found: string[] = [];
  const re = /^export function ([A-Za-z0-9_]+)\(/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) found.push(match[1]);
  return found;
}

/** Index of the façade member declaration (`name(` or `private name(`). */
function facadeMemberIndex(facade: string, name: string): number {
  const re = new RegExp(`^  (?:private )?${name}\\(`, 'm');
  const match = re.exec(facade);
  return match ? match.index : -1;
}

describe('sort/audit extraction — module layout', () => {
  for (const { module, methods } of OWNERSHIP) {
    it(`${module} exists and exports exactly the methods this slice owns`, () => {
      const relPath = `${SPLIT_DIR}/${module}`;
      expect(fs.existsSync(path.join(ROOT, relPath))).toBe(true);

      const exported = exportedFunctions(read(relPath));
      expect([...new Set(exported)].sort()).toEqual([...methods].sort());
    });
  }

  it('owns every method exactly once across the two modules', () => {
    const owners = new Map<string, string[]>();
    for (const { module, methods } of OWNERSHIP) {
      for (const method of exportedFunctions(read(`${SPLIT_DIR}/${module}`))) {
        owners.set(method, [...(owners.get(method) ?? []), module]);
      }
    }
    const duplicated = [...owners.entries()]
      .filter(([, modules]) => modules.length > 1)
      .map(([method, modules]) => `${method}: ${modules.join(', ')}`);
    expect(duplicated).toEqual([]);
  });

  it('extracts the modules as pure functions, not class members', () => {
    for (const { module } of OWNERSHIP) {
      const source = read(`${SPLIT_DIR}/${module}`);
      // `this.` cannot be resolved in a top-level function — a leftover would
      // mean the move was botched rather than a style problem.
      expect(source.includes('this.'), `${module} still uses \`this.\``).toBe(false);
      expect(/\bclass\s+WorklogDatabase\b/.test(source)).toBe(false);
    }
  });

  it('declares the module boundary headers (responsibility + boundary)', () => {
    for (const { module } of OWNERSHIP) {
      const source = read(`${SPLIT_DIR}/${module}`);
      const header = source.slice(0, source.indexOf('*/'));
      expect(source.startsWith('/**'), `${module} has no header comment`).toBe(true);
      expect(header).toContain('## Responsibility');
      expect(header).toContain('## Boundary');
    }
  });

  it('keeps every extracted module within the slice line target', () => {
    for (const { module } of OWNERSHIP) {
      const lines = read(`${SPLIT_DIR}/${module}`).split('\n').length;
      expect(lines, `${module}: ${lines} lines`).toBeLessThanOrEqual(SLICE_LINE_TARGET);
    }
  });

  it('imports the shared icons specifier, never a relative icons path', () => {
    for (const { module } of OWNERSHIP) {
      const source = read(`${SPLIT_DIR}/${module}`);
      // The forbidden shape everywhere: a relative icons import trips the
      // repo-wide guard (WL-0MT2GMTAZ003VKVL / WL-0MSJ4BT4Z002HH9B).
      expect(
        /from\s+['"]\.{1,2}[^'"]*icons\.(?:js|ts)['"]/.test(source),
        `${module} imports a relative icons path`,
      ).toBe(false);
      // A module that needs an icons helper must take it from the canonical
      // specifier; one with no icons dependency (sort.ts receives audit
      // freshness through an injected predicate) is not forced to import it.
      if (/\bicons\b/.test(source)) {
        expect(source, `${module} uses icons without the canonical specifier`)
          .toContain("@worklog/shared/icons");
      }
    }
  });
});

describe('sort/audit extraction — façade delegation', () => {
  const facade = read(FACADE);
  const methods = OWNERSHIP.flatMap(({ methods }) => methods);

  it('keeps a single façade member per extracted method (identical signature)', () => {
    const missing: string[] = [];
    const duplicated: string[] = [];
    for (const method of methods) {
      const re = new RegExp(`^  (?:private )?${method}\\(`, 'gm');
      const count = (facade.match(re) ?? []).length;
      if (count === 0) missing.push(method);
      if (count > 1) duplicated.push(`${method} x${count}`);
    }
    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
  });

  it('delegates every façade member to the extracted function', () => {
    const nonDelegating: string[] = [];
    for (const method of methods) {
      const start = facadeMemberIndex(facade, method);
      if (start < 0) {
        nonDelegating.push(`${method}: no member`);
        continue;
      }
      const body = facade.slice(start).split('\n').slice(1, 30).join('\n');
      // The member body must call the imported module function of the same name
      // (through the `sortModule.` / `auditModule.` namespace imports).
      if (!new RegExp(`(?:sortModule|auditModule)\\.${method}\\(`).test(body)) {
        nonDelegating.push(`${method}: body does not delegate to ${method}(...)`);
      }
    }
    expect(nonDelegating).toEqual([]);
  });

  it('declares the façade as a thin façade for this slice', () => {
    // Documentation boundary (parent AC): the façade names the extracted
    // modules so a reader can find the implementation from the class.
    for (const { module } of OWNERSHIP) {
      expect(facade).toContain(`./database/${module.replace(/\.ts$/, '.js')}`);
    }
  });
});
