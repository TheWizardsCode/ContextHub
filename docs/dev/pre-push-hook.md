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

`wl init` (`src/commands/init.ts` → `installCommittedHooks()`) imports the same
`PRE_PUSH_HOOK_CONTENT` constant, and `wl doctor upgrade` compares a project's
committed hook against `generateCanonicalHookContent('pre-push')` — which
returns the same constant. All three therefore emit identical text.

**Changing the template** means changing all three artifacts together
(`PRE_PUSH_HOOK_CONTENT`, `.githooks/pre-push`, the fixture). `wl doctor upgrade`
reports any content difference as `outdated` and overwrites the file, so a
template that is *older* than a project's committed hook silently downgrades
that project — the regression WL-0MW2N56M2004PSRP fixes.

## Behaviours the template must carry

The canonical text reproduces, byte-for-byte, the hook `tce-the-rising`
committed under **RISE-0MVSS1KVV002TJUL**:

1. **`--project-root` + `--gate-commit`** — the runner is invoked as
   `run_tests.py --scope full --strict-git-env --json --project-root "$repo_root"
   --gate-commit "$gate_commit"`, so the gate is bound to the *pushed commit*:
   the runner resolves a clean checkout whose `HEAD` is exactly that commit
   (the push cwd when it qualifies, else any clean `git worktree list`
   checkout) and refuses (exit 2) when none holds it. So "the dev push
   succeeded" means the suite ran against what landed (SA-0MVTRBT50005DUEH,
   WL-0MW2A3NAP0088IE9).
2. **Multi-commit refusal** — one suite can evidence one commit, so a push
   carrying several different `dev`/`main` commits is refused *before* any
   suite runs, listing each `ref=sha` and the recovery (one commit per push;
   escape hatches `TEST_SCOPE_SKIP=1` / `git push --no-verify`).
3. **Unsupported-runner pre-check** — a resolved runner that predates
   `--gate-commit` is refused with a named upgrade message, never an argparse
   error.
4. **Ref-deletion guard** — an all-zero `local_sha` means "delete this ref":
   there is no tree to test, so the suite is skipped.
5. **Failure log + tail** — the runner's `--json` output and stderr are
   captured to a temp log and its last 40 lines are tailed to stderr on
   failure, then the log is removed.
6. **Gate provenance echo** — the runner's `run_tests: gate-*` lines
   (`gate-subject`, `gate-root`, `gate-verdict`, `gate-refused`) are echoed to
   the pusher, so the validated checkout and executed-vs-cached is visible.
7. **Cache-mirror wording + gate-root source** — a successful mirror prints
   `pre-push: mirrored gate cache entry …`; the external contract tests assert
   that substring. The mirror sources from the gate-resolved root
   (`run_tests: gate-root`) rather than the push cwd.
8. **Defensive cache plumbing** — `git rev-parse --absolute-git-dir` /
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

## Bypasses

| Variable | Effect |
| --- | --- |
| `TEST_SCOPE_SKIP=1` | Skips the full-suite gate. Not recommended — it is the only way to skip it. |
| `WORKLOG_SKIP_PRE_PUSH=1` | Skips the worklog sync. Does **not** skip the gate. |
| `BRANCH_POLICY_SKIP=1` | Skips the protected-branch check. |
| `CONTEXT_BUDGET_SKIP=1` | Skips the context-budget gate. |

## Tests

- `tests/pre-push-hook-gate.test.ts` — executes the committed hook end-to-end
  in throwaway git repositories (which refs gate, `--project-root`,
  `--gate-commit`, the multi-commit refusal, the unsupported-runner refusal,
  the deletion guard, the failure tail, the gate-root mirror
  wording and fail-softness, bypasses, runner resolution).
- `tests/doctor-hook-upgrade.test.ts` — asserts the embedded template and the
  committed hook both equal the checked-in fixture, and that the backported
  behaviours are present in the template.
- `tests/cli/init.test.ts` — asserts `wl init` writes a hook equal to the
  committed template.
