/**
 * Structural gate for the dependency/comment-cluster extraction
 * (WL-0MVOBP6K0007574C, parent WL-0MVGKGHNR0019OLT).
 *
 * The deliverable of a move-only refactor *is* the module layout, so the
 * contract is asserted structurally:
 *
 *   - `dependencies.ts` and `comments.ts` exist;
 *   - every method of this slice lives in exactly one of them, as a top-level
 *     exported function (no class members, no `this.` inside the modules);
 *   - the `database.ts` façade keeps a member with the same name for each of
 *     them and that member really delegates to the extracted function;
 *   - dependency direction is enforced at the slice level: the modules import
 *     only `context.ts` (+ `../types.js` / `../persistent-store.js`) and never
 *     `next-pipeline.ts` / `priority.ts` — the dependency↔priority coupling is
 *     expressed through `SelectionHooks`, which is what keeps the extracted
 *     graph acyclic;
 *   - each extracted module stays inside the slice's ≤ 700-line target and
 *     documents its responsibility (parent AC on module boundaries).
 *
 * Acyclicity, the unchanged public surface and the 1,000-line hard ceiling are
 * already enforced by `packages/shared/src/database/decomposition-guard.test.ts`
 * (slice 0), and the *behaviour* is locked by the untouched
 * `tests/database.test.ts` / `tests/regression-auto-unblock.test.ts` oracles —
 * this file adds only the placement contract that neither of those covers.
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

/**
 * The slice's module → method ownership map (parent Context section).
 *
 * `members` maps the façade member name to the exported module function that
 * implements it. They are equal throughout this slice (no reserved-word
 * rename is needed here, unlike `delete` → `deleteWorkItem` in the
 * work-item/hierarchy slice).
 */
const OWNERSHIP: ReadonlyArray<{
  module: string;
  members: ReadonlyArray<readonly [member: string, fn: string]>;
}> = [
  {
    module: 'dependencies.ts',
    members: [
      ['addDependencyEdge', 'addDependencyEdge'],
      ['removeDependencyEdge', 'removeDependencyEdge'],
      ['listDependencyEdgesFrom', 'listDependencyEdgesFrom'],
      ['listDependencyEdgesTo', 'listDependencyEdgesTo'],
      ['getAllDependencyEdges', 'getAllDependencyEdges'],
      ['isDependencyActive', 'isDependencyActive'],
      ['getActiveDependencyBlockers', 'getActiveDependencyBlockers'],
      ['getInboundDependents', 'getInboundDependents'],
      ['hasActiveBlockers', 'hasActiveBlockers'],
      ['reconcileBlockedStatus', 'reconcileBlockedStatus'],
      ['reconcileDependentStatus', 'reconcileDependentStatus'],
      ['reconcileDependentsForTarget', 'reconcileDependentsForTarget'],
    ],
  },
  {
    module: 'comments.ts',
    members: [
      ['createComment', 'createComment'],
      ['getComment', 'getComment'],
      ['updateComment', 'updateComment'],
      ['deleteComment', 'deleteComment'],
      ['getCommentsForWorkItem', 'getCommentsForWorkItem'],
      ['getAllComments', 'getAllComments'],
      ['upsertComments', 'upsertComments'],
      ['importComments', 'importComments'],
      ['hasCommentChanged', 'hasCommentChanged'],
      ['touchWorkItemActivityAt', 'touchWorkItemActivityAt'],
    ],
  },
];

/**
 * Modules this slice must never import: the `database.ts` façade (parent AC4)
 * and the `wl next` cluster, whose dependency↔priority coupling is resolved
 * through `SelectionHooks` rather than an import (AC5). A direct import of
 * either would close a cycle through the façade wiring.
 */
const FORBIDDEN_SLICE_IMPORTS: readonly string[] = [
  './next-pipeline.js',
  './priority.js',
  '../database.js',
  './database.js',
];

/** The only in-directory modules a slice module may import. */
const ALLOWED_SPLIT_IMPORTS: readonly string[] = ['./context.js'];

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

/** Relative `./x.js` imports of a module. */
function relativeImportTargets(source: string): string[] {
  const targets: string[] = [];
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) targets.push(match[1]);
  return targets;
}

describe('dependency/comment extraction — module layout', () => {
  for (const { module, members } of OWNERSHIP) {
    it(`${module} exists and exports exactly the functions this slice owns`, () => {
      const relPath = `${SPLIT_DIR}/${module}`;
      expect(fs.existsSync(path.join(ROOT, relPath))).toBe(true);

      const exported = exportedFunctions(read(relPath));
      const expected = members.map(([, fn]) => fn);
      expect([...new Set(exported)].sort()).toEqual([...expected].sort());
    });
  }

  it('owns every method exactly once across the two modules', () => {
    const owners = new Map<string, string[]>();
    for (const { module, members } of OWNERSHIP) {
      for (const [, fn] of members) {
        owners.set(fn, [...(owners.get(fn) ?? []), module]);
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
});

describe('dependency/comment extraction — dependency direction', () => {
  it('imports only the context module from the split directory', () => {
    for (const { module } of OWNERSHIP) {
      const targets = relativeImportTargets(read(`${SPLIT_DIR}/${module}`)).filter(
        (t) => !t.startsWith('../'),
      );
      const unexpected = targets.filter((t) => !ALLOWED_SPLIT_IMPORTS.includes(t));
      expect(unexpected, `${module} imports sibling modules`).toEqual([]);
    }
  });

  it('never imports the façade or the wl next cluster', () => {
    for (const { module } of OWNERSHIP) {
      const targets = relativeImportTargets(read(`${SPLIT_DIR}/${module}`));
      const forbidden = targets.filter((t) => FORBIDDEN_SLICE_IMPORTS.includes(t));
      expect(forbidden, `${module} imports a forbidden module`).toEqual([]);
    }
  });

  it('resolves the dependency↔priority coupling through context hooks', () => {
    // `getActiveDependencyBlockers` / `isDependencyActive` are consumed by the
    // `wl next` pipeline through `SelectionHooks` (wired by the façade). If
    // dependencies.ts imported next-pipeline.ts or priority.ts, the extracted
    // graph would close back on itself.
    const source = read(`${SPLIT_DIR}/dependencies.ts`);
    expect(source.includes("from './next-pipeline.js'")).toBe(false);
    expect(source.includes("from './priority.js'")).toBe(false);
    // The write side (auto-sync) comes from the shared context, never from a
    // façade import.
    expect(source).toContain('ctx.writeHooks');
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
      // specifier; one with no icons dependency is not forced to import it.
      if (/\bicons\b/.test(source)) {
        expect(source, `${module} uses icons without the canonical specifier`)
          .toContain("@worklog/shared/icons");
      }
    }
  });
});

describe('dependency/comment extraction — façade delegation', () => {
  const facade = read(FACADE);

  it('keeps a single façade member per extracted method (identical signature)', () => {
    const missing: string[] = [];
    const duplicated: string[] = [];
    for (const { members } of OWNERSHIP) {
      for (const [member] of members) {
        const re = new RegExp(`^  (?:private )?${member}\\(`, 'gm');
        const count = (facade.match(re) ?? []).length;
        if (count === 0) missing.push(member);
        if (count > 1) duplicated.push(`${member} x${count}`);
      }
    }
    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
  });

  it('delegates every façade member to the extracted function', () => {
    const nonDelegating: string[] = [];
    for (const { members } of OWNERSHIP) {
      for (const [member, fn] of members) {
        const start = facadeMemberIndex(facade, member);
        if (start < 0) {
          nonDelegating.push(`${member}: no member`);
          continue;
        }
        const body = facade.slice(start).split('\n').slice(1, 30).join('\n');
        // The member body must call the imported module function of the same
        // name (through the `dependenciesModule.` / `commentsModule.`
        // namespace imports).
        if (!new RegExp(`(?:dependenciesModule|commentsModule)\\.${fn}\\(`).test(body)) {
          nonDelegating.push(`${member}: body does not delegate to ${fn}(...)`);
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
