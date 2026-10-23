/**
 * Build-freshness contracts for the startup target resolver
 * (WL-0MVH44JRR000A23U).
 *
 * ## Why
 *
 * `tests/cli/entry-point-split.test.ts` picks the CLI under test with
 * `resolveStartupTarget('auto', repoRoot)`. Before the freshness guard, `auto`
 * preferred any existing `dist/cli.js`, so a checkout whose `dist/` predated a
 * `src/` change silently tested *old* code: the `--version` version-spawn
 * assertion failed with `expected +0 to be 1` even though the source was
 * correct. The misleading failure depended purely on whether that checkout had
 * happened to be rebuilt.
 *
 * ## What is pinned
 *
 * 1. `auto` selects `dist` only when the build is at least as new as every
 *    source file; otherwise it falls back to `src` (tsx), which always
 *    reflects the working tree.
 * 2. The *generated* `src/version.ts` is excluded from the comparison —
 *    `scripts/generate-version.cjs` rewrites it *after* tsc, so counting it
 *    would make every fresh build look stale and `auto` would silently stop
 *    covering the built `dist/`.
 * 3. `dist` stays explicit and loud: it still resolves to `dist` even when
 *    stale (a benchmark asked for the build), and throws when the build is
 *    missing.
 *
 * Fixtures are temp directories with controlled mtimes, so the assertions
 * never depend on this checkout's `dist/` state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isDistFresh,
  resolveStartupTarget,
  buildStartupInvocation,
} from '../../bench/wl-startup-perf.js';

/** Fixed epoch seconds keep the mtime ordering unambiguous. */
const OLDER = 1_700_000_000;
const NEWER = OLDER + 60;

let fixtureRoot: string;

/** Write `content` at `relativePath` with an explicit mtime. */
function writeAtMtime(relativePath: string, epochSeconds: number): string {
  const full = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `// ${relativePath}\n`, 'utf8');
  fs.utimesSync(full, epochSeconds, epochSeconds);
  return full;
}

/** Seed the `node_modules/.bin/tsx` that the `src` invocation resolves upward. */
function seedTsxBin(): void {
  const bin = path.join(fixtureRoot, 'node_modules', '.bin', 'tsx');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/usr/bin/env node\n', 'utf8');
  fs.chmodSync(bin, 0o755);
}

/** A fixture with a built entry point plus a plain source module. */
function seedBuiltFixture(options: { distMtime?: number; srcMtime?: number } = {}): void {
  writeAtMtime('dist/cli.js', options.distMtime ?? NEWER);
  writeAtMtime('src/cli-main.ts', options.srcMtime ?? OLDER);
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-target-freshness-'));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('isDistFresh — build freshness guard', () => {
  it('treats a build newer than every source file as fresh', () => {
    seedBuiltFixture({ distMtime: NEWER, srcMtime: OLDER });
    expect(isDistFresh(fixtureRoot)).toBe(true);
  });

  it('treats a build predating a source change as stale', () => {
    seedBuiltFixture({ distMtime: OLDER, srcMtime: NEWER });
    expect(isDistFresh(fixtureRoot)).toBe(false);
  });

  it('ignores the generated src/version.ts regenerated after tsc', () => {
    // The real build order: tsc emits dist/, then generate-version.cjs
    // rewrites src/version.ts — so the generated file is always newer than a
    // freshly built dist. It must not make the build look stale.
    seedBuiltFixture({ distMtime: OLDER, srcMtime: OLDER });
    writeAtMtime('src/version.ts', NEWER);
    expect(isDistFresh(fixtureRoot)).toBe(true);
  });

  it('reports a missing build as not fresh', () => {
    writeAtMtime('src/cli-main.ts', OLDER);
    expect(isDistFresh(fixtureRoot)).toBe(false);
  });

  it('treats a checkout with no src/ as fresh (resolution fixtures)', () => {
    writeAtMtime('dist/cli.js', OLDER);
    expect(isDistFresh(fixtureRoot)).toBe(true);
  });
});

describe('resolveStartupTarget — auto never selects a stale build', () => {
  it('selects dist for a fresh build', () => {
    seedBuiltFixture({ distMtime: NEWER, srcMtime: OLDER });
    expect(resolveStartupTarget('auto', fixtureRoot)).toBe('dist');
  });

  it('falls back to src when the build is stale', () => {
    seedBuiltFixture({ distMtime: OLDER, srcMtime: NEWER });
    expect(resolveStartupTarget('auto', fixtureRoot)).toBe('src');
  });

  it('falls back to src when no build exists', () => {
    writeAtMtime('src/cli-main.ts', OLDER);
    expect(resolveStartupTarget('auto', fixtureRoot)).toBe('src');
  });

  it('keeps freshly built coverage when only the generated file is newer', () => {
    seedBuiltFixture({ distMtime: OLDER, srcMtime: OLDER });
    writeAtMtime('src/version.ts', NEWER);
    expect(resolveStartupTarget('auto', fixtureRoot)).toBe('dist');
  });

  it('honours an explicit dist request even when the build is stale', () => {
    seedBuiltFixture({ distMtime: OLDER, srcMtime: NEWER });
    expect(resolveStartupTarget('dist', fixtureRoot)).toBe('dist');
  });

  it('throws an actionable error when an explicit dist build is missing', () => {
    writeAtMtime('src/cli-main.ts', OLDER);
    expect(() => resolveStartupTarget('dist', fixtureRoot)).toThrow(/npm run build/);
  });

  it('honours an explicit src request', () => {
    seedBuiltFixture({ distMtime: NEWER, srcMtime: OLDER });
    expect(resolveStartupTarget('src', fixtureRoot)).toBe('src');
  });
});

describe('buildStartupInvocation — target selection shape', () => {
  it('runs the built entry point for dist (what /usr/local/bin/wl executes)', () => {
    seedBuiltFixture({ distMtime: NEWER, srcMtime: OLDER });
    const invocation = buildStartupInvocation(
      resolveStartupTarget('auto', fixtureRoot),
      fixtureRoot
    );
    expect(invocation[0]).toBe(process.execPath);
    expect(invocation[1]).toBe(path.join(fixtureRoot, 'dist', 'cli.js'));
  });

  it('runs the tsx entry point for src (always reflects the working tree)', () => {
    seedBuiltFixture({ distMtime: OLDER, srcMtime: NEWER });
    seedTsxBin();
    const invocation = buildStartupInvocation(
      resolveStartupTarget('auto', fixtureRoot),
      fixtureRoot
    );
    expect(invocation[1]).toMatch(/[\\/]tsx$/);
    expect(invocation[2]).toBe(path.join(fixtureRoot, 'src', 'cli.ts'));
  });
});
