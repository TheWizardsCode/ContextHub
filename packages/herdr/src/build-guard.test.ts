/**
 * Build-guard regression test (WL-0MUFSQMH90086I7W).
 *
 * The herdr plugin is not compiled by the root `tsc` — the root tsconfig
 * includes only the repo-root `src/**`, and `packages/herdr` has its own
 * build. A missing type import in the plugin therefore shipped to `dev`
 * unnoticed: `downtime-worker.ts` referenced the `PaneLifecycleKind` type in
 * its `closePane` dependency signature without importing it, so
 * `npm run build` inside `packages/herdr` failed with TS2304 while the root
 * build stayed green.
 *
 * This guard compiles the plugin's own tsconfig and asserts it produces no
 * diagnostics, so any future type error in `packages/herdr` fails the suite
 * instead of reaching `dev`.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('herdr plugin build guard', () => {
  it('type-checks with tsc --noEmit and reports no errors', () => {
    let failed = false;
    let diagnostics = '';

    try {
      execFileSync('npx', ['tsc', '--noEmit'], {
        cwd: packageDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      failed = true;
      const e = error as { stdout?: string; stderr?: string };
      diagnostics = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }

    expect(failed, `tsc reported type errors:\n${diagnostics}`).toBe(false);
  }, 120_000);
});
