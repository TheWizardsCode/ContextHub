/**
 * tests/cli/init/init-agent-template-modules.test.ts — module-boundary and
 * behaviour gate for the `init` AGENTS-template and stats-plugin concern
 * modules.
 *
 * Parent: WL-0MVGKH6Z1000XWGJ (decompose the `src/commands/init.ts` god class).
 * Child: WL-0MW0KDX260087BWP — extract `init.agent-template.ts` and
 * `init.stats-plugin.ts`.
 *
 * The parent's structural guard (`tests/cli/init/split-guard.test.ts`) already
 * enforces the family-wide invariants (no concern module imports the barrel, an
 * acyclic graph, a top-level responsibility JSDoc, the 1,000-line ceiling).
 * This file locks the criteria specific to this extraction:
 *
 * | Gate | Acceptance criterion |
 * |---|---|
 * | both modules exist, export the moved declarations, carry a responsibility JSDoc | AC1 |
 * | the moved declarations are gone from `src/commands/init.ts` | AC2 |
 * | each module stays inside its declared dependency set | AC3 |
 * | neither module reaches the barrel or the register module at runtime | AC4 |
 * | the moved behaviour is unchanged (append/overwrite/skip branches) | AC2 / AC6 |
 *
 * Move-only means behaviour is unchanged: the existing `tests/cli/init.test.ts`
 * suite stays the oracle for the CLI-level stats-plugin and AGENTS-template
 * cases and is deliberately not duplicated here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  INIT_BARREL,
  findBarrelImports,
  hasLeadingJsDoc,
  indexFromSources,
  loadModuleIndex,
  type ParsedModule,
} from './split-guard-scan.js';
import { cleanupTempDir, createTempDir } from '../../test-utils.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const AGENT_TEMPLATE_MODULE = 'src/commands/init.agent-template.ts';
const STATS_PLUGIN_MODULE = 'src/commands/init.stats-plugin.ts';

/** AC3: the only relative modules `init.agent-template.ts` may reach for. */
const AGENT_TEMPLATE_ALLOWED_RELATIVE = new Set([
  './init.constants.js',
  './init.content.js',
  './init.options.js',
  './init.paths.js',
]);

/** AC3: the only relative modules `init.stats-plugin.ts` may reach for. */
const STATS_PLUGIN_ALLOWED_RELATIVE = new Set([
  './init.content.js',
  './init.paths.js',
  './init.prompts.js',
  '../worklog-paths.js',
]);

/** Declarations this child moved out of the barrel. */
const MOVED_DECLARATIONS = {
  [AGENT_TEMPLATE_MODULE]: ['ensureAgentTemplateInstalled', 'resolveAgentDestination'],
  [STATS_PLUGIN_MODULE]: ['ensureStatsPluginInstalled'],
} as const;

/** Helpers that stay module-private — moved, but never re-exported. */
const INTERNAL_HELPERS = {
  [AGENT_TEMPLATE_MODULE]: ['promptAgentTemplateAction', 'printAgentTemplateSummary'],
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

describe('init agent-template/stats-plugin modules — live tree', () => {
  it('exports every moved declaration from its new module at runtime (AC1)', async () => {
    const agentTemplate = (await import('../../../src/commands/init.agent-template.js')) as Record<string, unknown>;
    const statsPlugin = (await import('../../../src/commands/init.stats-plugin.js')) as Record<string, unknown>;
    const checks: [string, Record<string, unknown>, readonly string[]][] = [
      ['init.agent-template.ts', agentTemplate, MOVED_DECLARATIONS[AGENT_TEMPLATE_MODULE]],
      ['init.stats-plugin.ts', statsPlugin, MOVED_DECLARATIONS[STATS_PLUGIN_MODULE]],
    ];
    for (const [label, loaded, names] of checks) {
      for (const name of names) {
        expect(typeof loaded[name], `${label} does not export ${name}`).toBe('function');
      }
    }
  });

  it('documents each new module with a single-responsibility JSDoc header (AC1)', () => {
    for (const file of [AGENT_TEMPLATE_MODULE, STATS_PLUGIN_MODULE]) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
      expect(hasLeadingJsDoc(source), `${file} lacks a top-level JSDoc header`).toBe(true);
      const header = source.slice(0, source.indexOf('*/')).toLowerCase();
      expect(header, `${file} must name its single responsibility`).toContain('single responsibility');
    }
  });

  it('keeps init.agent-template.ts inside its allowed dependency set (AC3)', () => {
    const parsed = moduleAt(AGENT_TEMPLATE_MODULE);
    const specifiers = runtimeSpecifiers(parsed);
    expect(specifiers).toContain('./init.content.js');
    expect(specifiers).toContain('./init.paths.js');
    expect(specifiers).toContain('./init.constants.js');
    expect(relativeImportsOutside(parsed, AGENT_TEMPLATE_ALLOWED_RELATIVE)).toEqual([]);
  });

  it('keeps init.stats-plugin.ts inside its allowed dependency set (AC3)', () => {
    const parsed = moduleAt(STATS_PLUGIN_MODULE);
    const specifiers = runtimeSpecifiers(parsed);
    expect(specifiers).toContain('./init.content.js');
    expect(specifiers).toContain('./init.paths.js');
    expect(specifiers).toContain('./init.prompts.js');
    expect(specifiers).toContain('../worklog-paths.js');
    expect(relativeImportsOutside(parsed, STATS_PLUGIN_ALLOWED_RELATIVE)).toEqual([]);
  });

  it('never reaches back into the barrel or the register module at runtime (AC4)', () => {
    for (const file of [AGENT_TEMPLATE_MODULE, STATS_PLUGIN_MODULE]) {
      const specifiers = runtimeSpecifiers(moduleAt(file));
      expect(specifiers, `${file} must not import the barrel`).not.toContain('./init.js');
      expect(specifiers, `${file} must not import init.register.ts`).not.toContain('./init.register.js');
    }
    // Shared family-wide gate: no init concern module imports the barrel.
    expect(findBarrelImports(index, true)).toEqual([]);
  });

  it('removes the moved declarations from src/commands/init.ts (AC2)', () => {
    const declared = declaredFunctions(
      fs.readFileSync(path.join(repoRoot, INIT_BARREL), 'utf-8'),
    );
    const moved = [
      ...Object.values(MOVED_DECLARATIONS).flat(),
      ...Object.values(INTERNAL_HELPERS).flat(),
    ];
    expect(moved.filter((name) => declared.includes(name))).toEqual([]);
    // The private helpers really did move into the concern module.
    const agentTemplateDeclared = declaredFunctions(
      fs.readFileSync(path.join(repoRoot, AGENT_TEMPLATE_MODULE), 'utf-8'),
    );
    for (const name of INTERNAL_HELPERS[AGENT_TEMPLATE_MODULE]) {
      expect(agentTemplateDeclared, `${AGENT_TEMPLATE_MODULE} lost ${name}`).toContain(name);
    }
  });
});

// ── Moved behaviour (move-only, AC2/AC6) ─────────────────────────────

describe('init agent-template/stats-plugin modules — moved behaviour', () => {
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

  it('resolves the AGENTS.md destination inside the project root', async () => {
    const { resolveAgentDestination } = await import('../../../src/commands/init.agent-template.js');
    expect(resolveAgentDestination('/tmp/example-project')).toBe(
      path.join('/tmp/example-project', 'AGENTS.md'),
    );
  });

  it('reports an existing stats plugin that already matches the template as in place', async () => {
    const { ensureStatsPluginInstalled } = await import('../../../src/commands/init.stats-plugin.js');
    const { locateExampleStatsPlugin } = await import('../../../src/commands/init.paths.js');
    const templatePath = locateExampleStatsPlugin();
    expect(templatePath).not.toBeNull();

    const tempDir = enterTempDir();
    try {
      const pluginsDir = path.join(tempDir, '.worklog', 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      const destination = path.join(pluginsDir, 'stats-plugin.mjs');
      fs.writeFileSync(destination, fs.readFileSync(templatePath!, 'utf-8'), 'utf-8');

      const result = await ensureStatsPluginInstalled({ silent: true });

      expect(result.installed).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('already in place');
      expect(result.destinationPath).toBe(destination);
    } finally {
      cleanup();
    }
  });

  it('never clobbers an existing stats plugin when overwrite is false', async () => {
    const { ensureStatsPluginInstalled } = await import('../../../src/commands/init.stats-plugin.js');
    const tempDir = enterTempDir();
    try {
      const pluginsDir = path.join(tempDir, '.worklog', 'plugins');
      fs.mkdirSync(pluginsDir, { recursive: true });
      const destination = path.join(pluginsDir, 'stats-plugin.mjs');
      const custom = 'export const customStats = () => 1;\n';
      fs.writeFileSync(destination, custom, 'utf-8');

      const result = await ensureStatsPluginInstalled({ silent: true, overwrite: false });

      expect(result.installed).toBe(false);
      expect(result.reason).toBe('user declined');
      expect(fs.readFileSync(destination, 'utf-8')).toBe(custom);
    } finally {
      cleanup();
    }
  });

  it('appends the global reference above existing local AGENTS.md rules', async () => {
    const { ensureAgentTemplateInstalled } = await import('../../../src/commands/init.agent-template.js');
    const tempDir = enterTempDir();
    try {
      const existing = '## Local Rules\n\n- Keep the local thing\n';
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), existing, 'utf-8');

      const result = await ensureAgentTemplateInstalled({ silent: true, action: 'append' });

      expect(result.installed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.insertedReference).toBe(true);
      const updated = fs.readFileSync(path.join(tempDir, 'AGENTS.md'), 'utf-8');
      expect(updated.startsWith('## Global agent guidance')).toBe(true);
      expect(updated).toContain('## Local Rules');
      expect(updated.indexOf('## Global agent guidance')).toBeLessThan(
        updated.indexOf('## Local Rules'),
      );
    } finally {
      cleanup();
    }
  });

  it('keeps AGENTS.md untouched when the global reference is already present', async () => {
    const { ensureAgentTemplateInstalled } = await import('../../../src/commands/init.agent-template.js');
    const tempDir = enterTempDir();
    try {
      const existing =
        '## Global agent guidance\n\nRead the global agent instructions at `~/.pi/agent/AGENTS.md`\n\n## Project-specific guidance\n\n- Keep it\n';
      const destination = path.join(tempDir, 'AGENTS.md');
      fs.writeFileSync(destination, existing, 'utf-8');

      // Even an explicit overwrite must not rewrite an already-referenced file.
      const result = await ensureAgentTemplateInstalled({ silent: true, action: 'overwrite' });

      expect(result.installed).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('global reference already present');
      expect(fs.readFileSync(destination, 'utf-8')).toBe(existing);
    } finally {
      cleanup();
    }
  });

  it('overwrites AGENTS.md when the operator explicitly asks for it', async () => {
    const { ensureAgentTemplateInstalled } = await import('../../../src/commands/init.agent-template.js');
    const tempDir = enterTempDir();
    try {
      const destination = path.join(tempDir, 'AGENTS.md');
      fs.writeFileSync(destination, '## Local Rules\n\n- Old rule\n', 'utf-8');

      const result = await ensureAgentTemplateInstalled({ silent: true, action: 'overwrite' });

      expect(result.installed).toBe(true);
      expect(result.overwritten).toBe(true);
      const updated = fs.readFileSync(destination, 'utf-8');
      expect(updated).not.toContain('Old rule');
      expect(updated.startsWith('## Global agent guidance')).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ── The gates fail on broken input ───────────────────────────────────

describe('init agent-template/stats-plugin modules — gates fail on broken input', () => {
  it('flags an agent-template module that reaches into a module outside its allowlist', () => {
    const broken = indexFromSources({
      [AGENT_TEMPLATE_MODULE]:
        "import { promptYesNo } from './init.prompts.js';\nexport const x = promptYesNo;\n",
    }).byFile.get(AGENT_TEMPLATE_MODULE)!;
    expect(relativeImportsOutside(broken, AGENT_TEMPLATE_ALLOWED_RELATIVE)).toEqual([
      './init.prompts.js',
    ]);
  });

  it('flags a stats-plugin module that reaches into the barrel', () => {
    const broken = indexFromSources({
      [STATS_PLUGIN_MODULE]:
        "import { ensureStatsPluginInstalled } from './init.js';\nexport const y = ensureStatsPluginInstalled;\n",
    });
    expect(findBarrelImports(broken, true).map((found) => found.file)).toEqual([
      STATS_PLUGIN_MODULE,
    ]);
  });

  it('accepts a module whose relative imports are all inside its allowlist', () => {
    const allowed = indexFromSources({
      [STATS_PLUGIN_MODULE]:
        "import { normalizeContent } from './init.content.js';\n" +
        "import { locateExampleStatsPlugin } from './init.paths.js';\n" +
        'export const w = locateExampleStatsPlugin ?? normalizeContent;\n',
    }).byFile.get(STATS_PLUGIN_MODULE)!;
    expect(relativeImportsOutside(allowed, STATS_PLUGIN_ALLOWED_RELATIVE)).toEqual([]);
  });

  it('detects a moved declaration left behind in the barrel', () => {
    expect(
      declaredFunctions('export async function ensureAgentTemplateInstalled(options: { silent: boolean }) {}'),
    ).toEqual(['ensureAgentTemplateInstalled']);
    expect(declaredFunctions('async function ensureStatsPluginInstalled() {}')).toEqual([
      'ensureStatsPluginInstalled',
    ]);
    expect(declaredFunctions('function resolveAgentDestination(root: string) {}')).toEqual([
      'resolveAgentDestination',
    ]);
    // A call site is not a declaration — the regex must not produce false hits.
    expect(declaredFunctions('const r = resolveAgentDestination(projectRoot);')).toEqual([]);
  });

  it('rejects a module without a responsibility JSDoc header', () => {
    expect(hasLeadingJsDoc("import * as fs from 'fs';\nexport const x = 1;\n")).toBe(false);
    expect(hasLeadingJsDoc('/**\n * init stats-plugin — single responsibility: install.\n */\nexport const x = 1;\n')).toBe(true);
  });
});
