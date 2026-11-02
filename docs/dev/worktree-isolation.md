# Worktree isolation

Two independent mechanisms keep work confined to the right tree. This page
documents both, and the guards that depend on them.

| Mechanism | Lives in | Isolates |
|---|---|---|
| Implementation worktrees | `implement` skill (`implement.py start`) | An agent's edits, build output and commits from the main checkout |
| Sync temp worktrees | `src/sync/worktree.ts` | A single `wl sync` push/pull from the project working tree |

## 1. Implementation worktrees (agent-side)

Every implementation runs in a linked worktree forked from `dev`:

```
.worklog/worktrees/wl-<work-item-id>-<slug>
```

Rules (enforced by the `implement` skill, not advisory):

- **All edits, builds, commits and pushes happen inside that worktree.** The
  main checkout is only ever a source of `.worklog` data.
- **`cwd` is not sufficient evidence.** Before the first write, assert the
  tree you are operating in:
  ```bash
  test "$(git rev-parse --show-toplevel)" = "$(pwd)"   # or $IMPLEMENT_WORKTREE_PATH
  ```
  An absolute path under the main checkout writes outside the worktree even
  when `cwd` looks correct. `implement.py finish` refuses to finish when it
  detects changes outside the worktree.
- **`wl` reads the main checkout's store.** Run it worktree-safely as
  `wl --worklog-dir <main-checkout>/.worklog …`; never `cd` to the main
  checkout to edit.
- **`node_modules` is symlinked, not installed.** `implement.py start` links
  the main checkout's `node_modules` (and nested workspace ones) into the
  worktree. Do not run `npm install` in a worktree — writes pass through the
  symlink and corrupt the shared tree.
- **The worktree is disposable.** After a successful push it is removed
  (`git worktree remove … && git worktree prune`); the commits live on `dev`.

A driven child session (`implement.py drive`) gets its own worktree and must
assert `git rev-parse --show-toplevel` equals `$IMPLEMENT_WORKTREE_PATH`. The
parent phase fails closed when a child's work lands in the main checkout.

## 2. Sync temp worktrees (runtime)

`withTempWorktree(repoRootPath, target, run, { forceOrphan? })` in
`src/sync/worktree.ts` materialises the data-ref work for one sync operation:

- Creates `.worklog/tmp-worktree-*/wt` via `git worktree add --detach`.
- **Base ref** is the fetched remote-tracking ref when the target ref exists,
  otherwise local `HEAD` (the first-sync orphan path).
- **`forceOrphan: true`** (ref rewrite only) skips the fetch entirely and
  builds from `HEAD`, so a polluted remote ref is never re-imported. The
  rewrite path then force-pushes a fresh orphan commit over it.
- On an unborn repository, the cryptic `git worktree add` failure is
  translated into an actionable message (create an initial commit, or use
  `wl sync --no-push`).
- The callback runs inside `withinWorktreeContext(worktreePath)`, so any child
  process spawned there is registered with the process-lifecycle module.

Teardown is unconditional, in a `finally`, and best-effort at every step:

1. `killProcessesForWorktree(worktreePath)` — kill tracked processes **before**
   removing the tree, so nothing is orphaned.
2. `git worktree remove --force` — drop the worktree registration.
3. `fs.rmSync(tmpRoot, …)` — remove the temp directory.

None of the cleanup steps can mask the callback's own result; a failing
cleanup step is swallowed deliberately.

### Environment hygiene

A git hook exports `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` into its
children. Those variables would point every child `git` command — including
the ones running inside the temp worktree — at the wrong repository.
`sanitizeGitEnv()` in `src/sync/git-exec.ts` strips all three before every
sync child process runs, and it is the single place that does so.

**Test-fixture layer (defence-in-depth, WL-0MVWRR4GD001M9LA).** The finish
gate (SA-0MVQHVGFR006W8LG) exports a temporary `GIT_INDEX_FILE` into the
suite it runs: `implement.py finish` stages the would-be-commit tree into a
throwaway index and requires that index to be byte-identical after the suite
(`index_unchanged`) for the verdict to describe the tree it tested. A test
fixture that spawns `git` with a spread of `process.env` inherits that
override, so its `git add`/`git commit` write into the *gate's* index instead
of the fixture's own repository — the gate then refuses the run as
unattributable ("gate evidence invalid: the temporary index changed while the
suite ran"). Two layers keep this from happening:

1. *Suite-wide:* `tests/setup-tests.ts` deletes the repository-override
   variables once, before any test file runs (WL-0MVVWRPRO006IQ61).
2. *Per fixture:* every fixture git invocation goes through the shared
   `fixtureGitEnv()` helper in `tests/cli/git-helpers.ts`, which scrubs the
   same list (plus `GIT_INDEX_FILE`) on every call and keeps the real git
   reachable by dropping the test mock-bin from `PATH`. A test that sets an
   override *after* suite setup (a deliberate-leak regression) still cannot
   hand it to a fixture command; the no-non-hermetic-fixtures invariant is
   enforced by `tests/cli/fixture-git-env.test.ts`. Mirrors
   `skill/shared/git_sandbox.py::fixture_git_env()`.

## Module resolution in a worktree

A worktree has no dependency tree of its own: `implement.py start` symlinks the
**main checkout's** `node_modules` into it (and the nested workspace ones).
Everything a worktree test resolves therefore comes from the main checkout's
tree — including `@worklog/shared`, a workspace package whose entry points are
*gitignored build output* rather than source.

### Resolution order

Resolving `@worklog/shared/<entry>` from inside a worktree walks these steps,
in this order:

| # | Step | Resolves into |
|---|---|---|
| 1 | `node_modules` lookup — `<worktree>/node_modules`, a symlink to `<main>/node_modules` | **main checkout** |
| 2 | `node_modules/@worklog/shared` — the workspace link `-> ../../packages/shared` (a plain symlink today; the link farm in `SA-0MVMZBJGT00718ZO` will replace it) | **main checkout** |
| 3 | `packages/shared` — the package directory that link points at | **main checkout** |
| 4 | `packages/shared/package.json` `main` / `exports` (`./dist/*.js`) | **main checkout** |
| 5 | `packages/shared/dist/<entry>.js` — the `tsc` build output | **main checkout** |

Not one step resolves into the worktree. A worktree's `packages/shared` source
is only read by tests that import it by relative path
(`../../packages/shared/src/…`).

Confirm which tree a resolution lands in, from inside the worktree:

```bash
readlink -f node_modules/@worklog/shared
# → /home/…/ContextHub/packages/shared            (the main checkout)
node --input-type=module -e \
  "console.log(import.meta.resolve('@worklog/shared/worklog-paths'))"
# → file:///home/…/ContextHub/packages/shared/dist/worklog-paths.js
```

### The stale-`dist` failure signature

A `packages/shared` edit in the worktree — and a build run in the worktree,
which writes `<worktree>/packages/shared/dist` — is **invisible** to every
consumer of `@worklog/shared`: steps 2–5 above resolve the main checkout's
package and the main checkout's build. The test therefore exercises code that
does not contain the change, and goes red in a way that looks like a behaviour
regression but is a resolution artefact. The canonical instance is the persist
write-detection tests (`tests/unit/persist-write-detection.test.ts`,
WL-0MVK6S4HM005GBCO): the change-detection spies are "never called" because
the CLI wrapper resolved a `dist/` built before the differential-persist change
(WL-0MVM9E3SV003III0).

- **Correct diagnosis:** the resolved `dist` is the main checkout's build.
  Confirm it with the two commands above, then import the worktree source by
  relative path in the test (what the persist tests do), or treat the red as
  unattributable to your change rather than as a code regression.
- **Wrong diagnosis:** weakening, skipping or "fixing" the test. A red caused
  by stale build output says nothing about the assertion, so editing the test
  removes the signal without the change ever being verified.

See [`wl-shared-dist-diagnostic.md`](./wl-shared-dist-diagnostic.md) for the
`wl` startup preflight that names the same missing-`dist` state, and
[`implement-worktree-node-modules-verification.md`](./implement-worktree-node-modules-verification.md)
for the end-to-end verification of the `node_modules` symlink.

### Current vs pending: there is no link farm yet

Today a worktree resolves the **main checkout's** `packages/shared/dist`; no
mechanism makes the worktree's own `packages/shared` the resolution target. The
link-farm setup that will do so is tracked in SorraAgents
`SA-0MVMZBJGT00718ZO` and has not shipped — do not look for a link-farm command,
and do not hand-roll one. Until it lands, a `packages/shared` change is only
testable by importing the worktree source directly.

### Constraints

- **Never run `npm install` in a worktree.** `<worktree>/node_modules` is a
  symlink to the main checkout's tree, so an install writes the dependency tree
  every other tree on the host resolves. The live statement of the rule is in
  [§1 Implementation worktrees](#1-implementation-worktrees-agent-side).
- **Never write through `node_modules`.** `node_modules/@worklog/shared` is a
  symlink into the main checkout's `packages/shared`, so a write through that
  path edits the main checkout — not your worktree — and corrupts the package
  every other session builds against. Same live statement:
  [§1 Implementation worktrees](#1-implementation-worktrees-agent-side).

## Guards that depend on isolation

Both hooks below no-op inside an isolated tree, because syncing from a tree
that has no local `.worklog` (or is mid-push) would either fail or recurse:

- **Temp worktree:** the hook skips when `PWD` matches `*tmp-worktree-*`.
- **Linked worktree:** the hook skips when `git rev-parse --git-dir` differs
  from `git rev-parse --git-common-dir` (a worktree has a different git dir
  but shares the common dir).

The same checks exist in `.githooks/pre-push`, `.githooks/post-checkout`,
`.githooks/worklog-post-pull`, in the hook content generated by
`src/commands/init.ts`, and in the canonical hook content in
`src/doctor/hook-upgrade.ts`.

## Main-checkout deletions: detection and recovery

The isolation rules above protect a *run's own* tree, but a concurrent
worktree-scoped run can still delete files from the **main checkout** — the
`packages/shared` wipe of 2026-10-31 (WL-0MVWK20DK004TQZM) broke `wl`
machine-wide for ~35 minutes while the overlapping finish run's guard never
verified (`verifies: []` — it aborted at the test gate). Two scripts cover
that gap, both resolving the **main** checkout even when invoked from a
linked worktree (`git worktree list --porcelain` first entry):

- **`scripts/check-main-checkout.sh`** — read-only integrity check: exit 1
  naming every tracked-file deletion in the main checkout plus the live
  worktree list as concurrent-actor evidence; `--work-item <id>` also records
  the report through `wl comment add` so it survives an aborted finish run;
  `--json` for machine use. Regression-tested in
  `tests/scripts/check-main-checkout.test.ts` (clean pass, one deletion,
  worktree-invoked, untracked ignored, wl-broken still fails).
- **`scripts/repair-shared-package.sh`** — one-command recovery: restores the
  **deleted** tracked files under `packages/shared/` from `HEAD` (per path,
  never stash/reset/clean, never clobbering modified-but-present files), then
  rebuilds via `npm run build:shared` and verifies
  `packages/shared/dist/worklog-paths.js`. Idempotent; smoke-tested in
  `tests/scripts/repair-shared-package.test.ts`.

See `docs/dev/wl-shared-dist-diagnostic.md` for the `wl` diagnostic that fires
on the same state.

## Repo-wide filesystem walks and concurrent worktree churn

Implementation worktrees live *inside* the main checkout
(`.worklog/worktrees/wl-<id>-<slug>`), so they are created and pruned while
other tests, builds and editors are mutating the same tree. A test that walks
the whole checkout therefore races the filesystem: a path listed by
`readdirSync` can be gone by the time it is `stat`ed or read, and a
hand-rolled `readdir` → `statSync` → `readFileSync` walk crashes with `ENOENT`
on a healthy tree (WL-0MVSLXT79008D4X6 — the icons repo-wide import guard
failing while a sibling `implement.py finish` removed its worktree).

Rules for repo-wide guard tests:

- Walk through `tests/helpers/repo-file-walk.ts` (`walkRepoSourceFiles`)
rather than re-implementing the traversal. It never enters `node_modules`,
`dist`, `.git`, `.worklog` or `coverage`, never follows symlinks, skips
entries that vanish mid-walk (`ENOENT`/`ENOTDIR`) and rethrows any other
error so a genuine filesystem problem still fails the guard.
- Never assert on files that another agent may be mutating; prefer the
reader-visitor API so the checked content and its path stay together.

The walker's own contract is pinned by `tests/unit/repo-file-walk.test.ts`
(vanishing directory, vanishing file, symlinks, exclusions, and error
propagation).

## Tests

| Behaviour | Test |
|---|---|
| Temp-worktree branch handling, target validation, hook guards, `GIT_DIR` leak | `tests/sync-worktree.test.ts` |
| Rewrite/force-push against a real polluted remote | `tests/rewrite-and-force-push.test.ts` |
| Hermetic fixture git env (fixtureGitEnv) + no non-hermetic fixtures invariant | `tests/cli/fixture-git-env.test.ts` |
| Sync-family layering, size ceiling and frozen barrel surface | `tests/sync/split-guard.test.ts` |
| Race-tolerant repo-wide walker (concurrent worktree churn) | `tests/unit/repo-file-walk.test.ts` |
| Icons repo-wide import guard (uses the walker) | `tests/unit/icons.test.ts` |
