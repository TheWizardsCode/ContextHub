/**
 * tests/cli/init/init-paths-modules.test.ts — dependency-direction gate for the
 * `init` path/gitignore/scheduled-prompts concern modules.
 *
 * Parent: WL-0MVGKH6Z1000XWGJ (decompose the `src/commands/init.ts` god class).
 * Child: WL-0MW0KDRAS000V2RL — extract `init.paths.ts`, `init.gitignore.ts` and
 * `init.scheduled-prompts.ts`.
 *
 * The parent's structural guard (`tests/cli/init/split-guard.test.ts`) already
 * enforces the family-wide invariants (no concern module imports the barrel, an
 * acyclic graph, a top-level responsibility JSDoc, the 1,000-line ceiling). This
 * file locks the three module-boundary criteria that are specific to this
 * extraction:
 *
 * | Gate | Acceptance criterion |
 * |---|---|
 * | `init.paths.ts` imports only external packages + constants/config/sync-defaults | AC3 |
 * | the two provisioning modules depend on `init.paths.ts` + `init.constants.ts`, never the barrel | AC4 |
 * | the moved declarations are exported from the new modules and gone from `init.ts` | AC1 / AC2 |
 *
 * Move-only means behaviour is unchanged: the existing `tests/cli/init.test.ts`
 * suite stays the oracle for that and is deliberately not duplicated here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  INIT_BARREL,
  findBarrelImports,
  indexFromSources,
  loadModuleIndex,
  type ParsedModule,
} from './split-guard-scan.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PATHS_MODULE = 'src/commands/init.paths.ts';
const GITIGNORE_MODULE = 'src/commands/init.gitignore.ts';
const SCHEDULED_PROMPTS_MODULE = 'src/commands/init.scheduled-prompts.ts';

/** AC3: the only relative modules `init.paths.ts` may reach for. */
const PATHS_ALLOWED_RELATIVE = new Set([
  './init.constants.js',
  '../config.js',
  '../sync-defaults.js',
]);

/** AC4: the only relative modules the provisioning modules may reach for. */
const GITIGNORE_ALLOWED_RELATIVE = new Set(['./init.constants.js', './init.paths.js']);
const SCHEDULED_PROMPTS_ALLOWED_RELATIVE = new Set([
  './init.constants.js',
  './init.paths.js',
  '../worklog-paths.js',
]);

/** Declarations this child moved out of the barrel. */
const MOVED_DECLARATIONS = {
  [PATHS_MODULE]: [
    'getSyncDefaults',
    'resolveRepoRoot',
    'resolveProjectRoot',
    'locateAgentTemplate',
    'locateExampleStatsPlugin',
    'locateWorkflowTemplate',
    'locateGitignoreTemplate',
    'locateScheduledPromptsTemplate',
  ],
  [GITIGNORE_MODULE]: ['ensureGitignore', 'hasWorklogGitignoreSection'],
  [SCHEDULED_PROMPTS_MODULE]: ['ensureScheduledPromptsInstalled'],
} as const;

/** A bare specifier is an external package or a Node built-in, never a sibling. */
function isExternalSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/** Runtime (non-type-only) import specifiers of a parsed module. */
function runtimeSpecifiers(module: ParsedModule): string[] {
  return module.imports
    .filter((imp) => !(imp.typeOnly && imp.names.every((n) => n.typeOnly)))
    .map((imp) => imp.specifier)
    .sort();
}

/**
 * Relative specifiers of a module that fall outside its declared allowlist —
 * i.e. the module reached into a module it is not allowed to depend on.
 */
function relativeImportsOutside(
  module: ParsedModule,
  allowed: ReadonlySet<string>,
): string[] {
  return runtimeSpecifiers(module).filter(
    (specifier) => !isExternalSpecifier(specifier) && !allowed.has(specifier),
  );
}

/** Functions declared with a top-level `function <name>(` in a source file. */
function declaredFunctions(source: string): string[] {
  return [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm)].map(
    (match) => match[1],
  );
}

const index = loadModuleIndex(repoRoot, ['src']);
const moduleAt = (file: string): ParsedModule => {
  const found = index.byFile.get(file);
  if (!found) throw new Error(`${file} was not parsed — the module is missing`);
  return found;
};

// ── Gates against the live tree ───────────────────────────────────────

describe('init paths/gitignore/scheduled-prompts modules — live tree', () => {
  it('exports every moved declaration from its new module at runtime (AC1)', async () => {
    const pathsModule = (await import('../../../src/commands/init.paths.js')) as Record<string, unknown>;
    const gitignoreModule = (await import('../../../src/commands/init.gitignore.js')) as Record<string, unknown>;
    const scheduledPromptsModule = (await import('../../../src/commands/init.scheduled-prompts.js')) as Record<string, unknown>;
    const checks: [string, Record<string, unknown>, readonly string[]][] = [
      ['init.paths.ts', pathsModule, MOVED_DECLARATIONS[PATHS_MODULE]],
      ['init.gitignore.ts', gitignoreModule, MOVED_DECLARATIONS[GITIGNORE_MODULE]],
      ['init.scheduled-prompts.ts', scheduledPromptsModule, MOVED_DECLARATIONS[SCHEDULED_PROMPTS_MODULE]],
    ];
    for (const [label, loaded, names] of checks) {
      for (const name of names) {
        expect(typeof loaded[name], `${label} does not export ${name}`).toBe('function');
      }
    }
  });

  it('keeps init.paths.ts inside its allowed dependency set (AC3)', () => {
    const pathsModule = moduleAt(PATHS_MODULE);
    expect(runtimeSpecifiers(pathsModule)).toContain('./init.constants.js');
    expect(relativeImportsOutside(pathsModule, PATHS_ALLOWED_RELATIVE)).toEqual([]);
    // The module resolves template locations, so it must reach the constants
    // module rather than hard-coding the relative paths.
    expect(runtimeSpecifiers(pathsModule)).toContain('../sync-defaults.js');
  });

  it('makes the provisioning modules depend on paths + constants, never the barrel (AC4)', () => {
    for (const [file, allowed] of [
      [GITIGNORE_MODULE, GITIGNORE_ALLOWED_RELATIVE],
      [SCHEDULED_PROMPTS_MODULE, SCHEDULED_PROMPTS_ALLOWED_RELATIVE],
    ] as const) {
      const parsed = moduleAt(file);
      const specifiers = runtimeSpecifiers(parsed);
      expect(specifiers, `${file} must locate templates via init.paths.ts`).toContain('./init.paths.js');
      expect(specifiers, `${file} must read names via init.constants.ts`).toContain('./init.constants.js');
      expect(specifiers, `${file} must not import the barrel`).not.toContain('./init.js');
      expect(relativeImportsOutside(parsed, allowed), `${file} imports outside its allowlist`).toEqual(
        [],
      );
    }
  });

  it('removes the moved declarations from src/commands/init.ts (AC2)', () => {
    const barrelSource = fs.readFileSync(path.join(repoRoot, INIT_BARREL), 'utf-8');
    const declared = declaredFunctions(barrelSource);
    const stillDeclared = Object.values(MOVED_DECLARATIONS)
      .flat()
      .filter((name) => declared.includes(name));
    expect(stillDeclared).toEqual([]);
  });

  it('keeps the whole family barrel-import-free at runtime (AC4, shared gate)', () => {
    expect(findBarrelImports(index, true)).toEqual([]);
  });
});

// ── The gates fail on broken input ───────────────────────────────────

describe('init paths/gitignore/scheduled-prompts modules — gates fail on broken input', () => {
  it('flags a paths module that reaches into another concern module', () => {
    const broken = indexFromSources({
      [PATHS_MODULE]: "import { promptYesNo } from './init.prompts.js';\nexport const x = promptYesNo;\n",
    }).byFile.get(PATHS_MODULE)!;
    expect(relativeImportsOutside(broken, PATHS_ALLOWED_RELATIVE)).toEqual(['./init.prompts.js']);
  });

  it('flags a provisioning module that reaches into the barrel', () => {
    const broken = indexFromSources({
      [GITIGNORE_MODULE]: "import { ensureGitignore } from './init.js';\nexport const y = ensureGitignore;\n",
      [SCHEDULED_PROMPTS_MODULE]: "import { ensureScheduledPromptsInstalled } from './init.js';\nexport const z = ensureScheduledPromptsInstalled;\n",
    });
    expect(findBarrelImports(broken, true).map((found) => found.file).sort()).toEqual([
      GITIGNORE_MODULE,
      SCHEDULED_PROMPTS_MODULE,
    ]);
  });

  it('accepts a module whose relative imports are all inside its allowlist', () => {
    const allowed = indexFromSources({
      [GITIGNORE_MODULE]:
        "import { locateGitignoreTemplate } from './init.paths.js';\n" +
        "import { WORKLOG_GITIGNORE_SECTION_START } from './init.constants.js';\n" +
        'export const w = locateGitignoreTemplate ?? WORKLOG_GITIGNORE_SECTION_START;\n',
    }).byFile.get(GITIGNORE_MODULE)!;
    expect(relativeImportsOutside(allowed, GITIGNORE_ALLOWED_RELATIVE)).toEqual([]);
  });

  it('detects a moved declaration left behind in the barrel', () => {
    expect(declaredFunctions('export function ensureGitignore(options: { silent: boolean }) {}')).toEqual([
      'ensureGitignore',
    ]);
    expect(declaredFunctions('async function ensureScheduledPromptsInstalled() {}')).toEqual([
      'ensureScheduledPromptsInstalled',
    ]);
    // A call site is not a declaration — the regex must not produce false hits.
    expect(declaredFunctions('const result = ensureGitignore({ silent: true });')).toEqual([]);
  });
});
