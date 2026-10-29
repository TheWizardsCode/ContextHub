/**
 * Structural gate for the `wl next` selection-cluster extraction
 * (WL-0MVOBP0U5007BAZD, parent WL-0MVGKGHNR0019OLT).
 *
 * The deliverable of a move-only refactor *is* the module layout, so the
 * contract is asserted structurally:
 *
 *   - `priority.ts`, `next-pipeline.ts` and `critical-escalation.ts` exist;
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
 * `tests/next-regression.test.ts` oracle — this file adds only the placement
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
    module: 'priority.ts',
    methods: [
      'getPriorityValue',
      'riskOrdinal',
      'effortOrdinal',
      'matchesRiskEffort',
      'computeEffectivePriority',
    ],
  },
  {
    module: 'next-pipeline.ts',
    methods: [
      'findNextWorkItem',
      'findNextWorkItemFromItems',
      'findNextWorkItems',
      'applyFilters',
      'filterCandidates',
      'resolveBlockerToRoot',
      'selectHighestPriorityBlocking',
    ],
  },
  {
    module: 'critical-escalation.ts',
    methods: ['handleCriticalEscalation'],
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

describe('wl next selection extraction — module layout', () => {
  for (const { module, methods } of OWNERSHIP) {
    it(`${module} exists and exports exactly the methods this slice owns`, () => {
      const relPath = `${SPLIT_DIR}/${module}`;
      expect(fs.existsSync(path.join(ROOT, relPath))).toBe(true);

      const exported = exportedFunctions(read(relPath));
      expect([...new Set(exported)].sort()).toEqual([...methods].sort());
    });
  }

  it('owns every method exactly once across the three modules', () => {
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

  it('extracts the pipeline as pure functions, not class members', () => {
    for (const { module } of OWNERSHIP) {
      const source = read(`${SPLIT_DIR}/${module}`);
      // `this.` cannot be resolved in a top-level function — a leftover would
      // mean the move was botched rather than a style problem.
      expect(source.includes('this.'), `${module} still uses \`this.\``).toBe(false);
      expect(/\bclass\s+WorklogDatabase\b/.test(source)).toBe(false);
    }
  });

  it('keeps every extracted module within the slice line target', () => {
    for (const { module } of OWNERSHIP) {
      const lines = read(`${SPLIT_DIR}/${module}`).split('\n').length;
      expect(lines, `${module}: ${lines} lines`).toBeLessThanOrEqual(SLICE_LINE_TARGET);
    }
  });

  it('documents each module responsibility and boundary in its header', () => {
    for (const { module } of OWNERSHIP) {
      const source = read(`${SPLIT_DIR}/${module}`);
      const header = source.slice(0, source.indexOf('*/'));
      expect(source.startsWith('/**'), `${module} has no header comment`).toBe(true);
      expect(header).toContain('## Responsibility');
      expect(header).toContain('## Boundary');
    }
  });
});

describe('wl next selection extraction — façade delegation', () => {
  const facade = read(FACADE);

  it('keeps a single façade member per extracted method', () => {
    const missing: string[] = [];
    const duplicated: string[] = [];
    for (const { methods } of OWNERSHIP) {
      for (const method of methods) {
        const re = new RegExp(`^  (?:private )?${method}\\(`, 'gm');
        const count = (facade.match(re) ?? []).length;
        if (count === 0) missing.push(method);
        if (count > 1) duplicated.push(`${method} x${count}`);
      }
    }
    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
  });

  it('delegates every façade member to the extracted function', () => {
    const nonDelegating: string[] = [];
    for (const { methods } of OWNERSHIP) {
      for (const method of methods) {
        const start = facadeMemberIndex(facade, method);
        if (start < 0) {
          nonDelegating.push(`${method}: no member`);
          continue;
        }
        const body = facade.slice(start).split('\n').slice(1, 30).join('\n');
        // The member body must call the imported function of the same name.
        if (!new RegExp(`(?:return|=|\\()\\s*${method}\\(`).test(body)) {
          nonDelegating.push(`${method}: body does not call ${method}(...)`);
        }
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
