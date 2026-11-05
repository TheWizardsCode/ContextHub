/**
 * tests/cli/init/init-workflow-sync-modules.test.ts — module-boundary and
 * behaviour gate for the `init` workflow and one-shot sync concern modules.
 *
 * Parent: WL-0MVGKH6Z1000XWGJ (decompose the `src/commands/init.ts` god class).
 * Child: WL-0MW0KDZPM009TLL4 — extract `init.workflow.ts` and `init.sync.ts`.
 *
 * The parent's structural guard (`tests/cli/init/split-guard.test.ts`) already
 * enforces the family-wide invariants (no concern module imports the barrel, an
 * acyclic graph, a top-level responsibility JSDoc, the 1,000-line ceiling).
 * This file locks the criteria specific to this extraction:
 *
 * | Gate | Acceptance criterion |
 * |---|---|
 * | both modules exist, export the moved declarations, carry a responsibility JSDoc | AC1 |
 * | the moved declarations and the `WorkflowChoice` type are gone from `src/commands/init.ts` | AC2 |
 * | each module stays inside its declared dependency set | AC3 |
 * | neither module reaches the barrel or the register module at runtime | AC4 |
 * | `src/commands/init.ts` lands under the 1,000-line ceiling | AC5 |
 * | WORKFLOW inlining behaviour is unchanged (insert once, never write WORKFLOW.md) | AC2 / AC6 |
 *
 * Move-only means behaviour is unchanged: `tests/cli/init.test.ts` stays the
 * oracle for the CLI-level workflow and sync cases and is deliberately not
 * duplicated here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  INIT_BARREL,
  MAX_MODULE_LINES,
  findBarrelImports,
  hasLeadingJsDoc,
  indexFromSources,
  loadModuleIndex,
  type ParsedModule,
} from './split-guard-scan.js';
import { cleanupTempDir, createTempDir } from '../../test-utils.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const WORKFLOW_MODULE = 'src/commands/init.workflow.ts';
const SYNC_MODULE = 'src/commands/init.sync.ts';
/** The module that owns the init flow since WL-0MW0KE2DO000IK63. */
const REGISTER_MODULE = 'src/commands/init.register.ts';

/** AC3: the only relative modules `init.workflow.ts` may reach for. */
const WORKFLOW_ALLOWED_RELATIVE = new Set([
  './init.constants.js',
  './init.content.js',
  './init.paths.js',
]);

/** AC3: the only relative modules `init.sync.ts` may reach for. */
const SYNC_ALLOWED_RELATIVE = new Set([
  './init.paths.js',
  '../types.js',
  '../config.js',
  '../jsonl.js',
  '../sync.js',
  '../sync-defaults.js',
  '../mutation-lock.js',
]);

/** Declarations this child moved out of the barrel. */
const MOVED_DECLARATIONS = {
  [WORKFLOW_MODULE]: [
    'promptWorkflowChoice',
    'ensureWorkflowTemplateInstalled',
    'insertWorkflowLoaderIntoAgents',
  ],
  [SYNC_MODULE]: ['performInitSync'],
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

/** Repo-relative specifiers imported by the barrel. */
function barrelSpecifiers(): string[] {
  return loadModuleIndex(repoRoot, ['src'])
    .byFile.get(INIT_BARREL)!
    .imports.map((imp) => imp.specifier);
}

/** Repo-relative specifiers the barrel re-exports. */
function barrelReexports(): string[] {
  return loadModuleIndex(repoRoot, ['src'])
    .byFile.get(INIT_BARREL)!
    .reexports.map((reexport) => reexport.specifier)
    .sort();
}

/** Repo-relative specifiers imported by the init flow module. */
function registerSpecifiers(): string[] {
  return loadModuleIndex(repoRoot, ['src'])
    .byFile.get(REGISTER_MODULE)!
    .imports.map((imp) => imp.specifier);
}

const index = loadModuleIndex(repoRoot, ['src']);
const moduleAt = (file: string): ParsedModule => {
  const found = index.byFile.get(file);
  if (!found) throw new Error(`${file} was not parsed — the module is missing`);
  return found;
};

// ── Gates against the live tree ───────────────────────────────────────

describe('init workflow/sync modules — live tree', () => {
  it('exports every moved declaration from its new module at runtime (AC1)', async () => {
    const workflow = (await import('../../../src/commands/init.workflow.js')) as Record<string, unknown>;
    const sync = (await import('../../../src/commands/init.sync.js')) as Record<string, unknown>;
    const checks: [string, Record<string, unknown>, readonly string[]][] = [
      ['init.workflow.ts', workflow, MOVED_DECLARATIONS[WORKFLOW_MODULE]],
      ['init.sync.ts', sync, MOVED_DECLARATIONS[SYNC_MODULE]],
    ];
    for (const [label, loaded, names] of checks) {
      for (const name of names) {
        expect(typeof loaded[name], `${label} does not export ${name}`).toBe('function');
      }
    }
  });

  it('documents each new module with a single-responsibility JSDoc header (AC1)', () => {
    for (const file of [WORKFLOW_MODULE, SYNC_MODULE]) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
      expect(hasLeadingJsDoc(source), `${file} lacks a top-level JSDoc header`).toBe(true);
      const header = source.slice(0, source.indexOf('*/')).toLowerCase();
      expect(header, `${file} must name its single responsibility`).toContain('single responsibility');
    }
  });

  it('keeps init.workflow.ts inside its allowed dependency set (AC3)', () => {
    const parsed = moduleAt(WORKFLOW_MODULE);
    const specifiers = runtimeSpecifiers(parsed);
    expect(specifiers).toContain('./init.constants.js');
    expect(specifiers).toContain('./init.content.js');
    expect(specifiers).toContain('./init.paths.js');
    expect(relativeImportsOutside(parsed, WORKFLOW_ALLOWED_RELATIVE)).toEqual([]);
  });

  it('keeps init.sync.ts inside its allowed dependency set (AC3)', () => {
    const parsed = moduleAt(SYNC_MODULE);
    const specifiers = runtimeSpecifiers(parsed);
    expect(specifiers).toContain('./init.paths.js');
    expect(specifiers).toContain('../config.js');
    expect(specifiers).toContain('../jsonl.js');
    expect(specifiers).toContain('../sync.js');
    expect(specifiers).toContain('../sync-defaults.js');
    expect(specifiers).toContain('../mutation-lock.js');
    expect(relativeImportsOutside(parsed, SYNC_ALLOWED_RELATIVE)).toEqual([]);
  });

  it('never reaches back into the barrel or the register module at runtime (AC4)', () => {
    for (const file of [WORKFLOW_MODULE, SYNC_MODULE]) {
      const specifiers = runtimeSpecifiers(moduleAt(file));
      expect(specifiers, `${file} must not import the barrel`).not.toContain('./init.js');
      expect(specifiers, `${file} must not import init.register.ts`).not.toContain('./init.register.js');
    }
    // Shared family-wide gate: no init concern module imports the barrel.
    expect(findBarrelImports(index, true)).toEqual([]);
  });

  it('removes the moved declarations from src/commands/init.ts and imports them instead (AC2)', () => {
    const barrelSource = fs.readFileSync(path.join(repoRoot, INIT_BARREL), 'utf-8');
    const declared = declaredFunctions(barrelSource);
    const moved = Object.values(MOVED_DECLARATIONS).flat();
    expect(moved.filter((name) => declared.includes(name))).toEqual([]);
    // The `WorkflowChoice` type moved with its producers.
    expect(barrelSource).not.toContain("type WorkflowChoice =");
    // The private insertion helper is exported so the barrel can keep wiring it.
    const workflowSource = fs.readFileSync(path.join(repoRoot, WORKFLOW_MODULE), 'utf-8');
    expect(declaredFunctions(workflowSource)).toEqual(
      expect.arrayContaining([...MOVED_DECLARATIONS[WORKFLOW_MODULE]]),
    );
    // The init flow consumes the extracted modules rather than re-declaring
    // them. Since WL-0MW0KE2DO000IK63 that flow lives in `init.register.ts`
    // and the barrel only re-exports it.
    const specifiers = registerSpecifiers();
    expect(specifiers).toContain('./init.workflow.js');
    expect(specifiers).toContain('./init.sync.js');
    expect(barrelSpecifiers()).toEqual([]);
    expect(barrelReexports()).toEqual(['./init.register.js', './init.sorra-agents.js']);
  });

  it('brings src/commands/init.ts under the maintainability ceiling (AC5)', () => {
    const source = fs.readFileSync(path.join(repoRoot, INIT_BARREL), 'utf-8');
    const lineCount = (source.match(/\n/g) ?? []).length;
    expect(lineCount).toBeLessThanOrEqual(MAX_MODULE_LINES);
  });
});

// ── Moved behaviour (move-only, AC2/AC6) ─────────────────────────────

describe('init workflow/sync modules — moved behaviour', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  function enterTempDir(): string {
    const tempDir = createTempDir();
    tempDirs.push(tempDir);
    process.chdir(tempDir);
    return tempDir;
  }

  // Restore the cwd and drop every temp dir even when an assertion throws.
  const cleanup = (): void => {
    process.chdir(originalCwd);
    while (tempDirs.length > 0) cleanupTempDir(tempDirs.pop()!);
  };

  it('maps a forced workflow answer without touching stdin', async () => {
    const { promptWorkflowChoice } = await import('../../../src/commands/init.workflow.js');
    await expect(promptWorkflowChoice(true)).resolves.toBe('basic');
    await expect(promptWorkflowChoice(false)).resolves.toBe('none');
  });

  it('never writes a standalone WORKFLOW.md when no agent destination is given', async () => {
    const { ensureWorkflowTemplateInstalled } = await import('../../../src/commands/init.workflow.js');
    const tempDir = enterTempDir();
    try {
      const result = await ensureWorkflowTemplateInstalled({ silent: true });

      expect(result.installed).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('not writing WORKFLOW.md to repository (inlining only)');
      expect(fs.existsSync(path.join(tempDir, 'WORKFLOW.md'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('inlines the workflow content once, above the existing AGENTS.md content', async () => {
    const { insertWorkflowLoaderIntoAgents } = await import('../../../src/commands/init.workflow.js');
    const tempDir = enterTempDir();
    try {
      const existing = '## Local Rules\n\n- Keep the local thing\n';
      const agentPath = path.join(tempDir, 'AGENTS.md');
      fs.writeFileSync(agentPath, existing, 'utf-8');

      const result = insertWorkflowLoaderIntoAgents(agentPath);

      expect(result.inserted).toBe(true);
      const updated = fs.readFileSync(agentPath, 'utf-8');
      expect(updated.startsWith('<!-- WORKFLOW: start -->\n')).toBe(true);
      expect(updated).toContain('<!-- WORKFLOW: end -->');
      expect(updated.endsWith(existing)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('is idempotent — a second inline leaves the AGENTS.md content untouched', async () => {
    const { insertWorkflowLoaderIntoAgents } = await import('../../../src/commands/init.workflow.js');
    const tempDir = enterTempDir();
    try {
      const agentPath = path.join(tempDir, 'AGENTS.md');
      fs.writeFileSync(agentPath, '## Local Rules\n', 'utf-8');
      insertWorkflowLoaderIntoAgents(agentPath);
      const afterFirst = fs.readFileSync(agentPath, 'utf-8');

      const second = insertWorkflowLoaderIntoAgents(agentPath);

      expect(second.inserted).toBe(false);
      expect(second.reason).toBe('already present');
      expect(fs.readFileSync(agentPath, 'utf-8')).toBe(afterFirst);
    } finally {
      cleanup();
    }
  });

  it('reports a missing AGENTS.md as not inserted rather than throwing', async () => {
    const { insertWorkflowLoaderIntoAgents } = await import('../../../src/commands/init.workflow.js');
    const tempDir = enterTempDir();
    try {
      const result = insertWorkflowLoaderIntoAgents(path.join(tempDir, 'missing-AGENTS.md'));

      expect(result.inserted).toBe(false);
      expect(result.reason).toBe('agents file not found');
    } finally {
      cleanup();
    }
  });

  it('inlines through ensureWorkflowTemplateInstalled when a destination is given', async () => {
    const { ensureWorkflowTemplateInstalled } = await import('../../../src/commands/init.workflow.js');
    const tempDir = enterTempDir();
    try {
      const agentPath = path.join(tempDir, 'AGENTS.md');
      fs.writeFileSync(agentPath, '## Local Rules\n', 'utf-8');

      const result = await ensureWorkflowTemplateInstalled({
        silent: true,
        agentDestinationPath: agentPath,
      });

      expect(result.installed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(fs.readFileSync(agentPath, 'utf-8')).toContain('<!-- WORKFLOW: start -->');
    } finally {
      cleanup();
    }
  });
});

// ── The gates fail on broken input ───────────────────────────────────

describe('init workflow/sync modules — gates fail on broken input', () => {
  it('flags a workflow module that reaches into a module outside its allowlist', () => {
    const broken = indexFromSources({
      [WORKFLOW_MODULE]:
        "import { performInitSync } from './init.sync.js';\nexport const x = performInitSync;\n",
    }).byFile.get(WORKFLOW_MODULE)!;
    expect(relativeImportsOutside(broken, WORKFLOW_ALLOWED_RELATIVE)).toEqual([
      './init.sync.js',
    ]);
  });

  it('flags a sync module that reaches into the barrel', () => {
    const broken = indexFromSources({
      [SYNC_MODULE]:
        "import { performInitSync } from './init.js';\nexport const y = performInitSync;\n",
    });
    expect(findBarrelImports(broken, true).map((found) => found.file)).toEqual([SYNC_MODULE]);
  });

  it('accepts a module whose relative imports are all inside its allowlist', () => {
    const allowed = indexFromSources({
      [SYNC_MODULE]:
        "import { getSyncDefaults } from './init.paths.js';\n" +
        "import { withStoreMutationLock } from '../mutation-lock.js';\n" +
        'export const w = [getSyncDefaults, withStoreMutationLock];\n',
    }).byFile.get(SYNC_MODULE)!;
    expect(relativeImportsOutside(allowed, SYNC_ALLOWED_RELATIVE)).toEqual([]);
  });

  it('detects a moved declaration left behind in the barrel', () => {
    expect(declaredFunctions('type WorkflowChoice = \'none\';\n')).toEqual([]);
    expect(declaredFunctions('async function performInitSync(dataPath: string) {}')).toEqual([
      'performInitSync',
    ]);
    expect(declaredFunctions('export function insertWorkflowLoaderIntoAgents(agentPath: string) {}')).toEqual([
      'insertWorkflowLoaderIntoAgents',
    ]);
    // A call site is not a declaration — the regex must not produce false hits.
    expect(declaredFunctions('const r = await performInitSync(dataPath);')).toEqual([]);
  });

  it('rejects a module without a responsibility JSDoc header', () => {
    expect(hasLeadingJsDoc("import * as fs from 'fs';\nexport const x = 1;\n")).toBe(false);
    expect(
      hasLeadingJsDoc('/**\n * init sync — single responsibility: bootstrap.\n */\nexport const x = 1;\n'),
    ).toBe(true);
  });
});
