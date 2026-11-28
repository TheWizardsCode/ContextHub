# The `pre-push` hook: single source of truth and contract

The `pre-push` hook is the repository's **integration** checkpoint: agents
validate *changed scope* during implementation (`implement.py finish`), and the
**full suite first runs here** — on a push whose remote ref is
`refs/heads/dev` or `refs/heads/main` (SA-0MVECQUGF0064U81). The run also writes
the full-suite cache entry that post-push verification and the audit skill read
read-only.

## One template, three copies, one contract

| Artifact | Role |
| --- | --- |
| `PRE_PUSH_HOOK_CONTENT` (`src/doctor/hook-upgrade.ts`) | **The single source of truth.** The embedded canonical template. |
| `.githooks/pre-push` (this repository) | The committed hook, kept byte-for-byte equal to the template. |
| `tests/fixtures/pre-push-hook.expected.sh` | The checked-in expected text the template and the committed hook are both asserted against. |

`wl init` (`src/commands/init.hooks.ts` → `installCommittedHooks()`) imports the same
`PRE_PUSH_HOOK_CONTENT` constant, and `wl doctor upgrade` compares a project's
committed hook against `generateCanonicalHookContent('pre-push')` — which
returns the same constant. All three therefore emit identical text.

**Changing the template** means changing all three artifacts together
(`PRE_PUSH_HOOK_CONTENT`, `.githooks/pre-push`, the fixture). `wl doctor upgrade`
reports any content difference at the **same marker version** as `outdated` and
overwrites the file, so a template that is *older* than a project's committed
hook silently downgrades that project — the regression WL-0MW2N56M2004PSRP fixes.

### The `vN` marker is an age contract

Every hook carries a marker line — `# worklog:pre-push-hook:v3`,
`# worklog:post-pull-hook:v1` — and `wl doctor upgrade` compares those numbers
before it compares content (`hookMarkerVersion()` in
`src/doctor/hook-upgrade.ts`):

| Project hook vs reference | Verdict | Effect |
| --- | --- | --- |
| newer (`v4` vs template `v3`) | `newer` | **never written** — reported and left byte-identical |
| older (`v1` vs template `v3`) | `outdated` | upgraded to the template |
| same version, different content | `outdated` | upgraded to the template (the WL-0MW2N56M2004PSRP reconciliation) |
| no marker | skipped entirely (not a Worklog hook) | untouched |

A project that improves its hook past the template therefore keeps its hook: the
fix for the improvement belongs **upstream**, in `PRE_PUSH_HOOK_CONTENT`, not in
a forced downgrade of the project (WL-0MWWS66JM0090RQ5 — measured on
`llm`'s `v4` pre-push, which `wl doctor upgrade` used to rewrite to `v3`).

**The upgrade does not commit.** Hook content is pinned by the consuming
project's own tests (e.g. `llm:tests/test_git_hooks.py` asserts
`ERROR: no test runner found`), so a same-version refresh is a contract change
the operator reviews and commits with a work item — never an auto-commit from a
`doctor` command. The one destructive path (downgrading a newer hook) is now
closed, so the remaining writes are always reviewable diffs.

## Behaviours the template must carry

The canonical text reproduces, byte-for-byte, the hook `tce-the-rising`
committed under **RISE-0MVSS1KVV002TJUL**:

1. **`--project-root`** — the runner is invoked as
   `run_tests.py --scope full --strict-git-env --project-root "$repo_root" --json`,
   so a linked-worktree push gates the *pushed tree* rather than whatever
   checkout the hook happens to run from.
2. **HEAD-vs-pushed-SHA warning** — when the checked-out `HEAD` is not the
   sha being pushed to `dev`/`main`, the hook warns
   `"… is not the ref being pushed to dev/main"`, so cache evidence is never
   silently attributed to the wrong commit.
3. **Ref-deletion guard** — an all-zero `local_sha` means "delete this ref":
   there is no tree to test, so the suite is skipped.
4. **Failure log + tail** — the runner's `--json` output is captured to a temp
   log and its last 40 lines are tailed to stderr on failure, then the log is
   removed.
5. **Cache-mirror wording** — a successful mirror prints
   `pre-push: mirrored gate cache entry …`; the external contract tests assert
   that substring.
6. **Defensive cache plumbing** — `git rev-parse --absolute-git-dir` /
   `--git-common-dir` are resolved with presence checks in every branch, a
   relative common dir is resolved with `$(cd "$wt_root" && pwd)`, and the main
   cache directory is created (`mkdir -p`) when absent. Mirroring stays
   fail-soft: cache plumbing never decides a push.

## Cache-evidence flow (worktree → main checkout)

`implement.py finish` pushes from the **linked worktree** holding the pushed
commit. `run_tests.py` caches per git state under that worktree's cache
(`<worktree>/.worklog/cache`, else `<git-dir>/test-cache`), while post-push
verification and the audit skill read the **main checkout's**
`<main>/.worklog/cache`. `mirror_suite_cache` bridges the two: keys are
content-addressed (normalised command + git state), so copying an entry the
main cache lacks is always safe — an identical key is an identical run. An
existing entry is never overwritten (SA-0MVTFMB7K002Y1F3, WL-0MV20XXWE00466FP).

## Ordering guarantees

- stdin is read **once**, before any early exit, so a `WORKLOG_SKIP_PRE_PUSH=1`
  bypass cannot skip the gate.
- The full-suite gate runs **before** the worklog-sync section (which exits
  early in a linked worktree) — a dev push from an `implement.py` worktree is
  still gated (RISE-0MVSS1KVV002TJUL AC3).
- A missing `run_tests.py` **hard-fails**: silently skipping would reproduce
  the unenforced-gate gap this hook closes.

## Shared-build precondition for full-suite evidence (WL-0MW8G1X3V007CGAE)

A full-suite verdict only describes the pushed commit if the shared workspace
build the run **resolves** is at least as new as its sources. `tests/**` reach
`@worklog/shared` through the package `exports` map into
`packages/shared/dist/` — **gitignored build output** — so a checkout whose
build predates a change under `packages/shared/src` runs the OLD shared code
and reports failures for work that is already correct and merged. This is the
same failure class as the stale root `dist/` (WL-0MVH44JRR000A23U), one
workspace over.

Every vitest invocation therefore runs a **once-per-run preflight** before any
test file is collected (`globalSetup` in `vitest.config.ts` →
`tests/global-setup.ts`, verdict in `tests/shared-dist-guard.ts`). Because it is
`globalSetup`, not `setupFiles`, it costs one `packages/shared/src` walk per
run rather than one per test file.

- **Fresh** means the resolved artefact
  (`packages/shared/dist/worklog-paths.js`) has an mtime **greater than or
  equal to** the newest build input under `packages/shared/src` (recursively).
  Generated/declaration files are excluded, mirroring `isDistFresh()`:
  `src/version.ts` is rewritten by `scripts/generate-version.cjs` after `tsc`,
  and `*.d.ts` is compiler output only.
- **Stale or missing** aborts the run with one actionable message naming the
  resolved `packages/shared` directory, the stale artefact's mtime versus the
  newest source mtime (or the missing artefact path), and the exact remedy:
  `cd <that repository root> && npm run build:shared`. The message reaches the
  hook's failure tail, so the agent sees the precondition, not a code defect.
- **Resolution, not guessing.** Freshness is judged on the package the run
  actually loads (through `node_modules/@worklog/shared`, symlinks followed),
  and the named repository root is derived from that package — so a run from a
  linked worktree names the checkout that owns the build it loads.
- **Never rebuild.** The preflight only `stat`s; the suite must not mutate the
  checkout (the live-repo mutation guard would report it) and a silent rebuild
  would make the suite pass against a build nobody asked for. Run the printed
  command yourself; `implement.py start` builds a fresh worktree's shared
  package up front (see below) and `implement.py finish`'s own `npm run build`
  runs again before it tests, which is why gated runs are never affected.
- **Fail-open.** An unresolvable package with no discoverable repository root,
  a package outside a `packages/` workspace, and an unreadable directory all
  proceed silently — the guard may only fire for a genuinely stale or absent
  artefact.
- **mtime is a heuristic** (accepted in WL-0MW8G1X3V007CGAE): a branch switch
  or a restored file can make `src` look newer than `dist` without a content
  change — a false positive that costs one `npm run build:shared` — and a
  copied `dist` can carry an older mtime with newer content. Content hashing
  is deliberately out of scope.

Recovery detail (including the missing/wiped-package case and
`scripts/repair-shared-package.sh`) lives in
[wl-shared-dist-diagnostic.md](./wl-shared-dist-diagnostic.md) — that document
covers the `wl` CLI's fail-fast diagnostic; this section covers the test run.
No separate machinery is needed for the suite: the preflight links the same
rebuild command.

> **Rebuild, then `--force` once.** `run_tests.py` caches a verdict per git
> state, and a rebuild does not change git state — so a run that aborted on the
> preflight can be replayed from cache after you have rebuilt. Re-run the first
> suite once with `run_tests.py --force` (or `--no-cache`) to record the fresh
> verdict; subsequent runs hit the refreshed entry. The cache key and the
> reason a rebuild is invisible to it are the runner's own behaviour
> (WL-0MWRZZ98Y007RKZ4), not this guard's.

## Fresh-worktree shared build at `implement.py start` (WL-0MW3EDP6D002U6V4)

The full-suite guard above catches a stale build in *any* checkout. A **fresh
implement worktree** has the complementary, harder failure:
`packages/shared/dist/` is gitignored, and `implement.py start` materialises a
`node_modules` link farm that points `@worklog/shared` at the worktree's *own*
(unbuilt) package — so every TypeScript suite that imports the package fails
with a cascade of import errors before a single test runs.

`implement.py start` therefore ensures the worktree's `packages/shared/dist`
exists and is fresh before the agent touches the tree (SorraAgents framework,
SA-0MWHUVJFO009R9EC — framework half of WL-0MW3EDP6D002U6V4):

- **Freshness-based, unconditional on the change set** (producer decision
  Q2=A): build when `dist/` is missing or older than the newest
  `packages/shared/src/**` file (the same mtime comparison as `isDistFresh()`
  above), skip when fresh, and no-op for a repo without a workspace
  `@worklog/shared` package. The shared `_newest_mtime` /
  `_shared_dist_freshness` helper is reused by WL-0MW8G1X3V007CGAE's guard.
- **Worktree-local only.** It builds the package the worktree resolves (never
  the main checkout), and only when the resolution points inside the worktree.
- **Best-effort, one diagnostic.** A build failure does not abort `start`; the
  start report records `steps.shared_build` with a single actionable message
  naming the resolved `packages/shared` path and `npm run build:shared` — never
  N import errors.

This is the start-time complement to the full-suite `globalSetup` guard: the
guard decides whether a run in an *existing* checkout may proceed; the start
step makes a *fresh* worktree importable in the first place.

See also [wl-shared-dist-diagnostic.md](./wl-shared-dist-diagnostic.md),
WL-0MW8G1X3V007CGAE (stale build) and WL-0MW3EDP6D002U6V4 (umbrella).

## The type check rides the full suite (WL-0MWKQ51G0006F3KV)

`npm run typecheck` (root, `packages/shared` and `packages/herdr`) is the first
entry in `.pi/test-config.json` `suiteCommands`, so the hook's `--scope full`
run executes it **without the template carrying a type-check step of its own**.
That is deliberate: the template is byte-locked across three artifacts, and a
bespoke step would mean editing `PRE_PUSH_HOOK_CONTENT`, `.githooks/pre-push`
and the fixture together for a check the suite already runs. `npm run build`
compiles `packages/herdr` as well, so a broken tree also fails the release
gate. See
[test-suite-baseline.md](./test-suite-baseline.md#the-typecheck-gate-wl-0mwkq51g0006f3kv).

## Bypasses

| Variable | Effect |
| --- | --- |
| `TEST_SCOPE_SKIP=1` | Skips the full-suite gate. Not recommended — it is the only way to skip it. |
| `WORKLOG_SKIP_PRE_PUSH=1` | Skips the worklog sync. Does **not** skip the gate. |
| `BRANCH_POLICY_SKIP=1` | Skips the protected-branch check. |
| `CONTEXT_BUDGET_SKIP=1` | Skips the context-budget gate. |

## Tests

- `tests/pre-push-hook-gate.test.ts` — executes the committed hook end-to-end
  in throwaway git repositories (which refs gate, `--project-root`, the
  HEAD-mismatch warning, the deletion guard, the failure tail, the mirror
  wording and fail-softness, bypasses, runner resolution).
- `tests/doctor-hook-upgrade.test.ts` — asserts the embedded template and the
  committed hook both equal the checked-in fixture, and that the backported
  behaviours are present in the template.
- `tests/cli/init.test.ts` — asserts `wl init` writes a hook equal to the
  committed template.
