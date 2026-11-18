/**
 * Regression guard: the typecheck gate must stay wired
 * (WL-0MWKQ51G0006F3KV).
 *
 * ## Why a guard
 *
 * No gate used to type-check `packages/herdr` (or any `packages/*` project):
 * the root `build` compiled only `src/**`, the canonical suite ran no
 * `tsc --noEmit`, and `packages/herdr/src` was (and stays) an opt-in test
 * profile. A merge resolution that dropped symbols while leaving their
 * consumers in place therefore compiled "green" everywhere and shipped —
 * commit `485b764c7` did exactly that and broke the Worklog pane on `main`
 * until it was restored by hand (WL-0MWKQ4DO2004C03A).
 *
 * The fix is distribution, not authoring: a root `typecheck` script, its
 * membership of the canonical suite, `noEmitOnError` on every tsconfig, the
 * herdr package build in the root `build`, and CI steps. Each of those is a
 * one-line edit that a later change can silently drop — which would re-open
 * exactly the same hole. This guard fails loudly when any link goes missing,
 * instead of waiting for the next broken release.
 *
 * ## What is checked
 *
 * 1. The root `typecheck` script (expanded through the `npm run <name>`
 *    references it chains) names the root tsconfig **and** every
 *    `packages/*` tsconfig that exists on disk — so adding a package with a
 *    tsconfig without wiring it fails here.
 * 2. Every tsconfig declares `noEmitOnError: true`, so a red tree never
 *    writes loadable-but-broken JS into `dist/`.
 * 3. The root `build` (expanded) compiles `packages/herdr`, which makes the
 *    `dev` → `main` release gate refuse a tree that does not type-check
 *    (`scripts/generate-version.cjs` already invokes `npm run build`).
 * 4. `.pi/test-config.json` `suiteCommands` runs the `typecheck` script, so
 *    `implement.py finish`, the dev-push hook, audit F3 and the ship release
 *    gate all inherit it without touching the byte-locked pre-push template.
 *    `groups.herdr` stays intact (WL-0MVFZVIA50062TJ8).
 * 5. CI type-checks: `install-and-smoke-test.yml` before `npm run build`, and
 *    `cli-tests.yml` via a path-filtered job covering `packages/**` and
 *    `src/**`.
 *
 * The compile itself is deliberately *not* run here: it is the job of the
 * suite command and the CI steps asserted below, and `build-guard.test.ts`
 * already runs `tsc --noEmit` inside the opt-in herdr profile. This guard
 * asserts wiring, cheaply, on every run.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readText(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function readJson<T>(relPath: string): T {
  return JSON.parse(readText(relPath)) as T;
}

/** Every `packages/*` directory (immediate children only) that has a tsconfig. */
function packageTsconfigs(): string[] {
  const packagesDir = path.join(repoRoot, 'packages');
  if (!fs.existsSync(packagesDir)) return [];
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/tsconfig.json`)
    .filter((rel) => fs.existsSync(path.join(repoRoot, rel)));
}

interface RootPackageJson {
  scripts?: Record<string, string>;
}

/** Root `package.json` scripts (never undefined — the file always has some). */
function scripts(): Record<string, string> {
  return readJson<RootPackageJson>('package.json').scripts ?? {};
}

/**
 * Expand a script body through its `npm run <name>` references (and the
 * `npm --prefix <dir> run <name>` form), so a chain such as
 * `typecheck` → `typecheck:herdr` → `tsc -p packages/herdr/tsconfig.json`
 * is visible as one string.
 */
function expandScript(name: string, allScripts: Record<string, string>, seen = new Set<string>()): string {
  const body = allScripts[name];
  if (body === undefined) return '';
  if (seen.has(name)) return body; // cycle guard — the scripts are user data
  seen.add(name);

  const parts = [body];
  const reference = /npm(?:\s+--prefix\s+\S+)?\s+run\s+([\w:.-]+)/g;
  for (const match of body.matchAll(reference)) {
    parts.push(expandScript(match[1], allScripts, seen));
  }
  return parts.join(' \n ');
}

describe('typecheck gate wiring (WL-0MWKQ51G0006F3KV)', () => {
  it('declares a root typecheck script', () => {
    expect(scripts().typecheck, 'package.json scripts.typecheck is missing').toBeTruthy();
  });

  it('type-checks the root and every packages/* project that has a tsconfig', () => {
    const allScripts = scripts();
    const expanded = expandScript('typecheck', allScripts);

    const required = ['tsconfig.json', ...packageTsconfigs()];
    // Compare whole whitespace-separated tokens, not substrings: every
    // packages/*/tsconfig.json contains "tsconfig.json", so a substring check
    // would let a dropped root project pass unnoticed.
    const tokens = new Set(expanded.split(/\s+/));
    const missing = required.filter((rel) => !tokens.has(rel));

    expect(
      missing,
      'the root `typecheck` script (transitively) does not type-check these tsconfigs. ' +
        'Every packages/* directory with a tsconfig must be covered by `npm run typecheck`, ' +
        'because an uncovered project can merge with a broken type tree and still ship ' +
        '(WL-0MWKQ51G0006F3KV). Add a `typecheck:<name>` sub-script using ' +
        '`tsc --noEmit -p <dir>/tsconfig.json` and chain it from `typecheck`:'
    ).toEqual([]);
  });

  it('sets noEmitOnError so a red tree never writes dist/', () => {
    const offenders = ['tsconfig.json', ...packageTsconfigs()].filter((rel) => {
      const config = readJson<{ compilerOptions?: { noEmitOnError?: unknown } }>(rel);
      return config.compilerOptions?.noEmitOnError !== true;
    });

    expect(
      offenders,
      'these tsconfigs do not set `compilerOptions.noEmitOnError: true`, so a build from a ' +
        'tree with type errors still emits loadable-but-broken JS into dist/ ' +
        '(WL-0MWKQ51G0006F3KV):'
    ).toEqual([]);
  });

  it('builds packages/herdr from the root build (the release gate)', () => {
    const expanded = expandScript('build', scripts());
    expect(
      expanded.includes('packages/herdr'),
      'the root `build` does not compile `packages/herdr`, so a herdr type error cannot block ' +
        'the `dev` → `main` promotion (the ship pipeline runs `npm run build`). ' +
        'WL-0MWKQ51G0006F3KV'
    ).toBe(true);
  });
});

interface TestConfig {
  suiteCommands?: string[];
  groups?: Record<string, { commands?: string[]; paths?: string[] }>;
}

describe('typecheck gate membership (WL-0MWKQ51G0006F3KV)', () => {
  const config = readJson<TestConfig>('.pi/test-config.json');
  const suiteCommands = config.suiteCommands ?? [];

  it('runs the typecheck from the canonical full suite', () => {
    expect(
      suiteCommands.some((command) => /\btypecheck\b/.test(command)),
      'the canonical full suite (.pi/test-config.json suiteCommands) does not run the ' +
        'typecheck. Without it the dev-push hook, audit F3 and the ship release gate stay ' +
        'blind to type errors (WL-0MWKQ51G0006F3KV). Add `npm --silent run typecheck`:'
    ).toBe(true);
  });

  it('keeps groups.herdr unchanged (producer decision WL-0MVFZVIA50062TJ8)', () => {
    expect(config.groups?.herdr?.commands).toEqual(['npm --silent test -- packages/herdr/src']);
    expect(config.groups?.herdr?.paths).toEqual(['packages/herdr/**']);
  });
});

describe('typecheck gate in CI (WL-0MWKQ51G0006F3KV)', () => {
  it('runs the typecheck before the build in install-and-smoke-test.yml', () => {
    const workflow = readText('.github/workflows/install-and-smoke-test.yml');
    // Match the whole `run:` line: a bare `indexOf('npm run build')` would match
    // the `npm run build:shared` prerequisite step, which deliberately runs first.
    const typecheckAt = workflow.search(/^\s*run: npm run typecheck$/m);
    const buildAt = workflow.search(/^\s*run: npm run build$/m);

    expect(typecheckAt, 'install-and-smoke-test.yml has no `npm run typecheck` step').toBeGreaterThan(-1);
    expect(buildAt, 'install-and-smoke-test.yml has no `npm run build` step').toBeGreaterThan(-1);
    expect(
      typecheckAt < buildAt,
      'install-and-smoke-test.yml must type-check BEFORE it builds, so the build never consumes ' +
        'a tree with type errors (WL-0MWKQ51G0006F3KV)'
    ).toBe(true);
  });

  it('installs the typecheck prerequisites before checking types in both workflows', () => {
    // The typecheck resolves @worklog/shared from packages/shared/dist and
    // `marked` from packages/herdr/node_modules. A fresh checkout has neither,
    // so a CI job that type-checks without installing them fails for the wrong
    // reason (and would have to be switched off — the failure mode this item
    // exists to prevent).
    for (const workflowPath of [
      '.github/workflows/install-and-smoke-test.yml',
      '.github/workflows/cli-tests.yml',
    ]) {
      const workflow = readText(workflowPath);
      const typecheckAt = workflow.indexOf('npm run typecheck');
      expect(typecheckAt, `${workflowPath} has no \`npm run typecheck\` step`).toBeGreaterThan(-1);

      for (const prerequisite of ['npm ci --prefix packages/herdr', 'npm run build:shared']) {
        const at = workflow.indexOf(prerequisite);
        expect(at, `${workflowPath} does not run \`${prerequisite}\``).toBeGreaterThan(-1);
        expect(
          at < typecheckAt,
          `${workflowPath} must run \`${prerequisite}\` BEFORE \`npm run typecheck\` ` +
            '(WL-0MWKQ51G0006F3KV)'
        ).toBe(true);
      }
    }
  });

  it('runs a path-filtered typecheck job in cli-tests.yml', () => {
    const workflow = readText('.github/workflows/cli-tests.yml');

    expect(workflow, 'cli-tests.yml has no `npm run typecheck` step').toContain('npm run typecheck');
    expect(
      /^\s{2}typecheck:\s*$/m.test(workflow),
      'cli-tests.yml has no `typecheck` job (a PR touching packages/** or src/** must get fast ' +
        'type feedback — WL-0MWKQ51G0006F3KV)'
    ).toBe(true);

    // The job is only useful if its path filter sees the trees it guards.
    const filterBlock = workflow.slice(workflow.indexOf('typecheck:'), workflow.indexOf('docs-only:'));
    expect(filterBlock, 'the typecheck path filter does not cover packages/**').toContain("'packages/**'");
    expect(filterBlock, 'the typecheck path filter does not cover src/**').toContain("'src/**'");
    expect(filterBlock, 'the typecheck path filter does not cover tsconfig*.json').toContain(
      "'tsconfig*.json'"
    );
  });
});
