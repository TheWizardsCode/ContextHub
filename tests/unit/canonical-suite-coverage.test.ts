/**
 * Regression guard: the canonical full suite (`.pi/test-config.json`
 * `suiteCommands`) must execute every test file under `tests/`.
 *
 * ## Why a guard
 *
 * WL-0MVG4FF9200346NR found that the canonical suite
 * (`tests/cli` + `tests/unit`) never executed 117 of the 277 `tests/`
 * files (77 root-level `tests/*.test.ts` plus `bench/`, `debug/`,
 * `extensions/`, `herdr/`, `integration/`, `lib/`, `scripts/`). Those
 * files only ran under a bare `npx vitest` / CI, so gate failures could be
 * missed by `/skill:test`, the ship release gate and audit F3 auto-runs
 * while CI stayed authoritative. The fix replaced the two narrow commands
 * with the single umbrella `npm --silent test -- tests`.
 *
 * Vitest positional filters are **substring matches** on the repository-
 * relative path, so a command is only trustworthy when the filter is a
 * substring of every file it must cover. This guard re-derives that
 * property from the config, so a future narrowing of `suiteCommands`
 * (e.g. back to `tests/cli`) fails loudly with the uncovered files named,
 * instead of silently shrinking the gate (the same regression class as
 * `no-stale-dist-spawn.test.ts` guarded for `dist/`).
 *
 * ## What is checked
 *
 * 1. `suiteCommands` is a non-empty list.
 * 2. Every `*.test.ts` file under `tests/` (vitest's own discovery scope,
 *    with `node_modules` and `fixtures` excluded) is matched by at least
 *    one command's positional filter — i.e. the canonical full suite really executes it.
 * 3. Any file not covered by `suiteCommands` fails with the file names
 *    listed, so an exclusion has to be a deliberate, documented decision
 *    rather than an accident of the filter string.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_CONFIG_PATH = path.join(repoRoot, '.pi', 'test-config.json');

/** Read the declared canonical suite commands from `.pi/test-config.json`. */
function suiteCommands(): string[] {
  const raw = fs.readFileSync(TEST_CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw) as { suiteCommands?: unknown };
  const commands = config.suiteCommands;
  if (!Array.isArray(commands) || commands.length === 0) {
    return [];
  }
  return commands.filter(
    (c): c is string => typeof c === 'string' && c.trim().length > 0
  );
}

/**
 * The vitest positional filters a command carries (after `--`). Vitest
 * treats them as substring matches on the repository-relative path.
 */
function positionalFilters(command: string): string[] {
  // e.g. "npm --silent test -- tests"  ->  ["tests"]
  //      "npm --silent test -- tests/cli"  ->  ["tests/cli"]
  const dashDash = command.indexOf('--');
  const tail = dashDash >= 0 ? command.slice(dashDash + 2) : '';
  return tail
    .split(/\s+/)
    .filter((p) => p.length > 0 && !p.startsWith('-'));
}

/** Every `*.test.ts` file under `tests/`, excluding dependency/fixture dirs. */
function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      testFiles(full, found);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('canonical suite coverage (WL-0MVG4FF9200346NR)', () => {
  it('declares a non-empty canonical suite', () => {
    expect(suiteCommands().length, TEST_CONFIG_PATH).toBeGreaterThan(0);
  });

  it('executes every tests/**/*.test.ts file', () => {
    const commands = suiteCommands();
    const filters = commands.flatMap(positionalFilters);
    expect(filters.length, 'suiteCommands carry no positional filter to match').toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const file of testFiles(path.join(repoRoot, 'tests'))) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      if (!filters.some((f) => rel.includes(f))) uncovered.push(rel);
    }

    expect(
      uncovered,
      'these *.test.ts files under tests/ are NOT executed by the canonical full suite ' +
        '(suiteCommands in .pi/test-config.json). The canonical suite must cover every ' +
        'tests/ file (WL-0MVG4FF9200346NR); any exclusion must be documented as a deliberate ' +
        'decision, not an accident of the filter string:'
    ).toEqual([]);
  });
});
