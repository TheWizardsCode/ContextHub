/**
 * CLI tests for `wl project list` (F2 — WL-0MVWEELAW005SDLU).
 *
 * The command is a thin surface over `discoverProjects()`; these specs assert
 * the two observable output contracts from the work item:
 *
 *   - the default human output is the `prefix → path` map, sorted by prefix;
 *   - `--json` is `{ success, projectsRoot, projects: [{ prefix, path,
 *     ambiguous }] }`, and ambiguous prefixes carry `path: null`.
 *
 * They run the REAL CLI (`runCliProcess` from `cli-bundle.ts`) from a throwaway
 * consumer checkout whose `.worklog/config.yaml` declares the fixture projects
 * root, so the default-root/config path is exercised end to end.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCliProcess } from './cli-bundle.js';
import { cleanupTempDir, createTempDir } from '../test-utils.js';
import {
  FIXTURE_PREFIXES,
  makeProjectsRoot,
  writeProjectConfig,
  type ProjectsRootFixture,
} from '../helpers/cross-repo-fixture.js';

/** Canonical form for path comparisons (`os.tmpdir()` may be a symlink). */
function real(target: string): string {
  return fs.realpathSync(target);
}

/** Strip chalk/SGR escapes so assertions work with or without colour. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Prefixes discovery must report for the fixture's standard layout. */
const EXPECTED_PREFIXES = [
  FIXTURE_PREFIXES.withTests,
  FIXTURE_PREFIXES.withoutTests,
  FIXTURE_PREFIXES.duplicate,
];

describe('wl project list', () => {
  const disposables: Array<() => void> = [];
  let fixture: ProjectsRootFixture | undefined;

  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()!();
    }
    fixture?.cleanup();
    fixture = undefined;
  });

  /** A consumer checkout whose config points discovery at the fixture root. */
  function consumerCheckout(): string {
    const checkout = createTempDir();
    disposables.push(() => cleanupTempDir(checkout));
    writeProjectConfig(checkout, {
      prefix: 'CONS',
      projectName: 'Consumer',
      projectsRoot: fixture!.root,
    });
    return checkout;
  }

  function run(args: string[], cwd: string) {
    return runCliProcess(args, {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        WL_TUI_MODE: '1',
        WL_CACHE_DIR: path.join(cwd, 'cache'),
      },
    });
  }

  it('prints the sorted prefix → path map for humans', () => {
    fixture = makeProjectsRoot();
    const checkout = consumerCheckout();

    const { status, stdout, stderr } = run(['project', 'list'], checkout);
    expect(status, stderr).toBe(0);

    const output = stripAnsi(stdout);
    expect(output).toContain(`Projects root: ${real(fixture.root)}`);

    const lines = output.split('\n').filter((line) => line.includes('→'));
    const prefixes = lines.map((line) => line.split('→')[0].trim());
    expect(prefixes).toEqual(EXPECTED_PREFIXES);

    const alphaLine = lines.find((line) => line.startsWith(FIXTURE_PREFIXES.withTests))!;
    expect(alphaLine).toContain(real(fixture.layout!.withTests.dir));
    const duplicateLine = lines.find((line) => line.startsWith(FIXTURE_PREFIXES.duplicate))!;
    expect(duplicateLine).toContain('ambiguous');
    expect(duplicateLine).toContain(real(fixture.layout!.duplicates[0].dir));
    expect(duplicateLine).toContain(real(fixture.layout!.duplicates[1].dir));
  });

  it('emits the documented --json shape and never guesses an ambiguous owner', () => {
    fixture = makeProjectsRoot();
    const checkout = consumerCheckout();

    const { status, stdout, stderr } = run(['--json', 'project', 'list'], checkout);
    expect(status, stderr).toBe(0);

    const payload = JSON.parse(stdout);
    expect(payload.success).toBe(true);
    expect(real(payload.projectsRoot)).toBe(real(fixture.root));
    expect(payload.projects.map((project: { prefix: string }) => project.prefix)).toEqual(
      EXPECTED_PREFIXES,
    );

    const byPrefix = new Map(
      payload.projects.map((project: Record<string, unknown>) => [project.prefix, project]),
    );
    const alpha = byPrefix.get(FIXTURE_PREFIXES.withTests) as Record<string, unknown>;
    expect(real(String(alpha.path))).toBe(real(fixture.layout!.withTests.dir));
    expect(alpha.ambiguous).toBe(false);

    const duplicate = byPrefix.get(FIXTURE_PREFIXES.duplicate) as Record<string, unknown>;
    expect(duplicate.ambiguous).toBe(true);
    expect(duplicate.path).toBeNull();

    // Decoys (config-only stub, non-git folder, hidden folder) are excluded.
    for (const excluded of [
      FIXTURE_PREFIXES.worktreeStub,
      FIXTURE_PREFIXES.nonGit,
      FIXTURE_PREFIXES.hidden,
    ]) {
      expect(byPrefix.has(excluded)).toBe(false);
    }
  });

  it('honours --projects-root over the checkout config', () => {
    fixture = makeProjectsRoot();
    const checkout = consumerCheckout();

    const { status, stdout, stderr } = run(
      ['--json', 'project', 'list', '--projects-root', fixture.root],
      checkout,
    );
    expect(status, stderr).toBe(0);

    const payload = JSON.parse(stdout);
    expect(real(payload.projectsRoot)).toBe(real(fixture.root));
    expect(payload.projects.map((project: { prefix: string }) => project.prefix)).toEqual(
      EXPECTED_PREFIXES,
    );
  });
});
