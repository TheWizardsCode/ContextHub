# Worktree node_modules — end-to-end verification (WL-0MSGQ64N2006TQB2)

> How a worktree resolves `@worklog/shared` (through the worktree-local link
> farm: dependency packages via links into the main checkout's `node_modules`,
> and the `@worklog/shared` workspace package to the **worktree's own**
> `packages/shared/dist`) is documented in
> [Module resolution in a worktree](./worktree-isolation.md#module-resolution-in-a-worktree).

## Problem

`implement.py start` creates a fresh git worktree with no `node_modules`, so
tests that spawn the CLI via `path.join(projectRoot, 'node_modules', '.bin',
'tsx')` failed with MODULE_NOT_FOUND. The 9 read-cache e2e tests
(`tests/cli/read-cache-e2e.test.ts`) failed on every `implement.py finish`
for worktree-based items.

## Fixes (both shipped before this verification)

1. **implement.py auto-symlink** — SorraAgents SA-0MSGS763C006SM1B, commit
   `03344c5c` on dev: `implement.py start` symlinked
   `<worktree>/node_modules -> <repo-root>/node_modules` when the main
   checkout has one and the worktree lacks one. **Superseded by the link
   farm** (`SA-0MVMZBJGT00718ZO`): for path-consumed workspace packages such as
   `@worklog/shared`, `implement.py start` now materialises a worktree-local
   link farm whose `@worklog/shared` entry points at the worktree's own
   `packages/shared`; a repository without such a package keeps the
   whole-directory symlink (the degradation path).
2. **resolveTsxBin walk-up** — ContextHub commit `613f1490`:
   `tests/test-utils.ts` `resolveTsxBin()` walks up parent directories to
   find a real `node_modules/.bin/tsx`, used by all read-cache test files.

## AC1 verification (2026-08-07, fresh worktree at dev HEAD `c6c26688`)

> **Pre-farm era.** This table verified the whole-directory `node_modules`
> symlink shipped by fix 1 before `SA-0MVMZBJGT00718ZO`. With the link farm,
> the worktree additionally resolves `@worklog/shared` from its own
> `packages/shared/dist` (see the module-resolution section linked above); the
> read-cache e2e and full-suite results below still hold.

| Configuration | pytest | vitest (full suite) | read-cache e2e |
|---|---|---|---|
| Worktree with symlink (start default) | 103 passed | 4071 passed (223 files) | 9 passed |
| Worktree, **symlink removed** (no node_modules) | — | **4071 passed** (223 files) | **9 passed** |

- `npm run build` (build:shared + tsc + generate-version + herdr postbuild)
  succeeds both with and without the symlink (npm resolves `.bin` from the
  ancestor main-checkout `node_modules`).
- Initial full-suite run before build showed 40 failures across 10 files —
  all caused by the missing `dist/` directory in the fresh worktree
  (gitignored, not checked out), not by node_modules. After `npm run build`
  the suite is fully green, confirming `implement.py finish`'s
  build → test ordering is correct.
- `tests/cli/read-cache-e2e.test.ts` (9 tests) and
  `tests/cli/read-cache-spawn-reduction.test.ts` (1 test) pass in all
  configurations.

## AC2 — no repo pollution

`node_modules`, `dist` and `.worklog` are gitignored; the symlink and build
artifacts live inside the gitignored worktree. `git status` in the worktree
shows only the intended verification doc.

## AC3 — main checkout

Main checkout at the same commit (`c6c26688`) with its own `node_modules`
present — unchanged behavior; suite green (verified previously, 2026-08-07).

## Conclusion

The MODULE_NOT_FOUND failure mode described in WL-0MSGQ64N2006TQB2 is fully
resolved. The `resolveTsxBin` walk-up alone (fix 2) makes the suite green in a
worktree with no node_modules at all; the implement.py link step (fix 1) —
originally a whole-directory symlink, now the worktree-local link farm —
remains as belt-and-braces and is the default state created by
`implement.py start`.
