# Test Suite Baseline — Legacy `test/` Deduplication

**Work item:** WL-0MV4UZ6C4007XDGI (child of WL-0MV28X3BT0079JM3)
**Baseline commit:** `85679713a678b54417d4e994fc7f305c3ff75d38` (dev)
**Measured:** 2026-10-12

## Purpose

Record the pre-change baseline (test file count and suite runtime) for the
legacy `test/` vs `tests/` deduplication epic, so the post-change child
(`WL-0MV4V0IF9008214R`) can report a meaningful delta.

## Test gates

**Canonical gate reference.** Added by WL-0MVGJ4WSS005BMSI (child:
WL-0MVH75NY3002TTX9). This section states which suites each gate runs and how
to run the herdr package suite. Its root-level coverage gap (root-level
`tests/*.test.ts` files never executed by any gate) was closed by
**WL-0MVG4FF9200346NR** — see [Full `tests/` coverage](#full-tests-coverage-wl-0mvg4ff9200346nr)
below; the old two-command canonical suite (`tests/cli` + `tests/unit`) was
replaced by the `tests/` umbrella.

### What each gate runs

| Gate | Where it runs | Scope | Suites |
|---|---|---|---|
| Implement finish | `implement.py finish` (development time) | changed | Named group selected from the changed files (`groups` in `.pi/test-config.json`); otherwise the affected test files; falls back to the full canonical suite when nothing narrower is selectable |
| Dev-push | `pre-push` hook (when installed) | full | The full canonical suite (`suiteCommands`) |
| Ship release | `dev` → `main` promotion | full | The full canonical suite, re-run on the merged tree |
| Audit (F3) | audit skill, on a cache miss | full | The full canonical suite, read from the per-repo test cache |

The **canonical full suite** is declared in `.pi/test-config.json`
(`suiteCommands`):

```bash
npm --silent test -- tests
```

Since **WL-0MVG4FF9200346NR** this is a single umbrella command that
executes **all 277 `tests/` test files** in one vitest run — the 77
root-level files plus the `bench/`, `debug/`, `extensions/`, `herdr/`,
`integration/`, `lib/` and `scripts/` sub-suite files. It replaced the two
narrow commands (`tests/cli` + `tests/unit`), which left 117 files executed
by no full-suite gate. Vitest positional filters are substring matches on
the repository-relative path, so the `tests` filter grabs exactly the
`tests/` files and nothing outside them, and a single run de-duplicates its
own file set (the shared-basename unit-vs-CLI variants — e.g.
`tests/audit.test.ts` + `tests/cli/audit.test.ts` — each execute exactly
once).

> **This repository's `pre-push` hook does not run the test suite today** — it
> enforces branch policy, the context budget and `wl sync` only. Until it
> does, the canonical suite is enforced at development time by
> `implement.py finish` (which falls back to full scope for `.pi/`-only
> changes) and by the `ship` release gate at release time. This is a
> pre-existing gap tracked separately; do not treat a successful push as
> full-suite evidence.

### The herdr package suite is a separate, opt-in gate

The `packages/herdr/src` suite (107 files / ~3,500 tests) is **not** part of
the canonical full suite — a producer decision recorded on
**WL-0MVFZVIA50062TJ8** ("the herdr tests will not be run as part of the
canonical full suite"). It is a sanctioned, cache-recorded profile instead:

```bash
# by type — types.herdr in .pi/skills_extensions/test/extension.json
python3 <test-skill>/scripts/run_tests.py --type herdr --json

# by named group — groups.herdr in .pi/test-config.json
python3 <test-skill>/scripts/run_tests.py --group herdr --json
```

Both resolve to `npm --silent test -- packages/herdr/src`. Prefer them over an
ad-hoc `npx vitest run packages/herdr/src`: only the test skill's runner
records the run in the per-repo cache, so only runner evidence is visible to
the audit.

- **`groups.herdr` also drives changed-scope selection.** A change under
  `packages/herdr/**` makes `implement.py finish` auto-select the `herdr`
  group (paths spec `packages/herdr/**`).
- **Runtime (re-measured 2026-10-21):** ~67 s cold on a 16-core shared host
  at load average 4.8–12.2 (load-dominated). WL-0MVFE1IRB0004X1U measured
  ~130 s on an idle host. Budget a couple of minutes, not tens of minutes.

### Type-map contract

`.pi/skills_extensions/test/extension.json` defines only `herdr`. A minimum
type it omits — `--type unit`, `--type smoke` — **fails with a loud
diagnostic naming the file**; it is never silently substituted with the full
suite. `--type full` still resolves from `suiteCommands`, so a bare
`run_tests.py` invocation keeps working.

### Cache evidence scope

Only a `--type full` run at `scope=full` counts as full-suite evidence for the
audit skill. `--type herdr` and `--group herdr` runs use independent cache
keys (`herdr`, `group:herdr`): they are recorded and queryable, but they
**never satisfy a "full test suite passes" AC**. Auditing a herdr-only change
still needs operator attestation (`--green-run HEAD`) or a herdr-aware audit
follow-up (not implemented).

### Full `tests/` coverage (WL-0MVG4FF9200346NR)

**2026-10-25.** The canonical suite used to run `tests/cli` + `tests/unit`
only, leaving 117 of 277 `tests/` files (77 root-level plus the `bench/`,
`debug/`, `extensions/`, `herdr/`, `integration/`, `lib/`, `scripts/`
sub-suite files) executed by no full-suite gate — they only ran under a bare
`npx vitest` / CI. The fix replaced the two narrow commands with the single
umbrella `npm --silent test -- tests` (see above), so a `--type full` run now
executes every `tests/` file.

#### Coverage table (2026-10-25 `dev` tree, `git ls-files`)

| Location | Files | In canonical suite? |
|---|---|---|
| `tests/` (root level) | 77 | Yes (was No) |
| `tests/cli` | 111 | Yes (unchanged) |
| `tests/unit` | 49 | Yes (unchanged) |
| `tests/herdr` | 20 | Yes (was No) |
| `tests/integration` | 5 | Yes (was No) |
| `tests/lib` | 6 | Yes (was No) |
| `tests/bench` | 4 | Yes (was No) |
| `tests/scripts` | 3 | Yes (was No) |
| `tests/debug` | 1 | Yes (was No) |
| `tests/extensions` | 1 | Yes (was No) |
| **`tests/` total** | **277** | **277 / 277 (100 %)** |
| `packages/herdr` | 129 | No — producer decision WL-0MVFZVIA50062TJ8 (won't-fix); opt-in `--type herdr` / `--group herdr` |
| `packages/tui` | 22 | No — documented gap; tracked in WL-0MVODOJWB004G03J |
| `packages/shared` | 12 | No — documented gap; tracked in WL-0MVODOJWB004G03J |
| **Repository total** | **440** | **277 (63 %)** |

The `packages/` rows are deliberately out of this item's scope: the herdr
exclusion is producer-sanctioned (won't-fix) and the `tui` + `shared` gap is
tracked in **WL-0MVODOJWB004G03J** (`discovered-from:WL-0MVG4FF9200346NR`).
"Full parity with `npm test`" is **not** the accepted intent (see the herdr
decision above).

#### Runtime (measured with `run_tests.py`, 16-core shared host)

Before and after runs both resolved the *declared* canonical set through the
test skill's runner. **Trap:** `run_tests.py --suite node` resolves the
**legacy convention** path (`tests/{unit,node,cli}`) and ignores
`suiteCommands` — for canonical runs always use the default `--suite all`
(or a plain `--type full`) so the declared `suiteCommands` drive the run.

| Run | Command resolved | Files | Vitest duration | Runner elapsed |
|---|---|---|---|---|
| Before (2026-10-25) | `npm --silent test -- tests/cli` + `npm --silent test -- tests/unit` | 160 (111 cli + 49 unit) | — (per-suite tails truncated by the runner; load-dominated) | **1620.1 s** — host heavily loaded with concurrent agent suites |
| After (2026-10-25) | `npm --silent test -- tests` | **278** (277 + the guard test below) | **790.89 s** | **1065.4 s** |

`timeoutPerCommand` was raised 1800 → **3600** in the same change: the after run
is ~2× the before suite's file count, and the old budget left too little
headroom on a loaded host (both numbers stay far below the new ceiling, so the
timeout is a safety net, not a runtime cost).

#### Verification (AC2) and regression guard

The widened run reports `Test Files 278 …` (277 `tests/` + the guard test)
and a path diff against `git ls-files` confirms every `tests/` test file
runs and no file runs twice (one vitest run de-duplicates its own file set).
`tests/unit/canonical-suite-coverage.test.ts` (**added by this item**) is a
regression guard: it fails the build if `suiteCommands` ever stops covering a
`tests/` test file — naming the uncovered files — so the coverage cannot
silently regress (same guard class as `no-stale-dist-spawn.test.ts`).

#### Newly surfaced failures

6 failures surfaced, all in `tests/herdr/fetcher-memo.test.ts` (a file the
old canonical suite never executed): its spawn-count assertions were written
before the F5/F8 bounded spawn cap made `runWlInner` await
`acquireWlSpawnSlot()` before reaching `execFileAsync`, so they read 0 calls
synchronously and the leaked in-flight promise hung every later test. Fixed
in place (`waitForCalls()` + a raised spawn cap for the memo suite, whose
serial-concurrency contract lives in
`packages/herdr/src/fetcher-spawn-cap.test.ts`) — triaged as the critical
test-failure item **WL-0MVOERBM5001VUPY**, closed inline by this item's
commit. The remainder of the widened suite was green on the first run.

## Test file count (baseline)

Tracked test files matching the vitest include pattern:

```bash
git ls-files | grep -E '\.(test|spec)\.(ts|tsx|js|mjs|cjs)$' | wc -l
```

| Location | Test files |
|---|---|
| `packages/` | 115 |
| `test/` (legacy) | 9 |
| `tests/` | 234 |
| **Total** | **358** |

Vitest discovers 358 test files (357 passed, 1 skipped —
`tests/github-sync-load.long.test.ts`).

> **Stale row note (WL-0MVG4FF9200346NR).** The legacy root `test/` directory
> no longer exists — the deduplication epic (WL-0MV28X3BT0079JM3) deleted its
> last files, so the `test/` row above is a baseline snapshot for commit
> `85679713`, not a description of the current tree. Current counts live in
> the [coverage table](#coverage-table-2026-10-25-dev-tree-git-ls-files)
> (`tests/` 277, `packages/` 163, repository total 440).

## Suite runtime (baseline)

### Full vitest suite (all packages)

Command (run from the worktree root, after `npm run build`):

```bash
npm run build          # build step
npm --silent test      # vitest run — the complete suite
```

Result:

| Metric | Value |
|---|---|
| Test files | 357 passed, 1 skipped (358) |
| Tests | 7851 passed, 5 skipped (7856) |
| Vitest duration | 243.30 s |
| Wall clock (`/usr/bin/time -v`) | 4:04.27 |

### Framework-declared canonical suite (`.pi/test-config.json`)

> **Historical baseline (pre-WL-0MVG4FF9200346NR).** The commands and numbers
> below describe the commit `85679713` baseline, when `suiteCommands` was
> `tests/cli` + `tests/unit`. The canonical suite is now the single umbrella
> `npm --silent test -- tests` (277 files) — see
> [Full `tests/` coverage](#full-tests-coverage-wl-0mvg4ff9200346nr).

The implement/test/pre-push gates run the suite declared in
`.pi/test-config.json`:

```json
{
  "suiteCommands": [
    "npm --silent test -- tests/cli",
    "npm --silent test -- tests/unit"
  ],
  "timeoutPerCommand": 1800
}
```

Command (via the test skill, which records the run in the per-repo cache):

```bash
python3 /home/rgardler/.pi/agent/skills/test/scripts/run_tests.py --force --type full --json
```

Result:

| Suite | Test files | Tests | Vitest duration |
|---|---|---|---|
| `tests/cli` | 95 | 852 passed, 4 skipped (856) | 181.70 s |
| `tests/unit` | 31 | 519 passed (519) | 6.67 s |
| **Canonical total** | **126** | **1371 passed, 4 skipped (1375)** | **~188.4 s** |

> Note: the canonical suite is a subset of the full vitest suite. It does not
> include the legacy `test/` files at the repo root, nor most of `tests/`
> (only `tests/cli` and `tests/unit`), nor `packages/`, so the deduplication
> delta is most visible in the **full** suite numbers above.

## Environment

- Node/npm via the repo-managed `node_modules` (shared with the main checkout
  via symlink in the worktree).
- Machine load and CPU count affect wall-clock; treat durations as indicative,
  not exact. Both baseline and post-change runs must use the same commands
  and host for a like-for-like comparison.

## Reproduce

```bash
git checkout 85679713a678b54417d4e994fc7f305c3ff75d38
npm run build
npm --silent test                        # full suite
python3 <test-skill>/scripts/run_tests.py --force --type full --json   # canonical subset
```

## Post-change measurement (2026-10-12)

Measured on the worktree HEAD `467b4f4e` (dev) after all six deduplication
children landed, using the same commands as the baseline.

### Test file count (post-change)

| Location | Baseline | Post-change | Δ |
|---|---|---|---|
| `packages/` | 115 | 128 | +13 |
| `test/` (legacy) | 9 | 0 | -9 |
| `tests/` | 234 | 243 | +9 |
| **Total** | **358** | **371** | **+13** |

### Full vitest suite (all packages)

```bash
npm run build
/usr/bin/time -v npm --silent test
```

| Metric | Baseline | Post-change |
|---|---|---|
| Test files | 357 passed, 1 skipped (358) | 370 passed, 1 skipped (371) |
| Tests | 7851 passed, 5 skipped (7856) | 7952 passed, 5 skipped (7957) |
| Vitest duration | 243.30 s | 643.68 s |
| Wall clock (`/usr/bin/time -v`) | 4:04.27 | 10:45.65 |

### Canonical suite (`.pi/test-config.json` — `tests/cli` + `tests/unit`)

```bash
python3 <test-skill>/scripts/run_tests.py --force --type full --json
```

| Suite | Baseline | Post-change |
|---|---|---|
| `tests/cli` | 95 files, 852 passed + 4 skipped (856), 181.70 s | 98 files, 859 passed + 4 skipped (863), 297.81 s |
| `tests/unit` | 31 files, 519 passed (519), 6.67 s | 31 files, 519 passed (519), 7.20 s |
| **Canonical total** | **126 files, 1371 passed + 4 skipped (1375), ~188.4 s** | **129 files, 1378 passed + 4 skipped (1382), ~305 s** (runner elapsed 355.4 s) |

### Isolated contribution of this epic

The raw before/after deltas above are confounded by unrelated concurrent
work (see below). Isolating this epic's changes:

- Legacy `test/` directory: 9 files → 0. Six files were **relocated** into
  `tests/` (still in the suite); three were deleted after their unique
  coverage was migrated (`validator`, `migrations`, `throttler`).
- `tests/validator.test.ts` (verbatim subset) deleted.
- Two new `tests/` files added to preserve migrated coverage
  (`tests/api-needs-producer-review-filter.test.ts`,
  `tests/cli/validate-cli-md.test.ts`).
- **Net: -8 test files** attributable to the epic (the six relocations remain
  in the suite).
- **Test cases: net -7**, all redundant — 1 verbatim subset (WL-0MV4UTKU5008IFLH),
  3 throttler cases already covered (WL-0MV4UWH28002OTNJ), and 3 duplicate
  `iconsEnabled` cases (WL-0MV4UY7IV001OCHG). Meaningful coverage is unchanged;
  every removal is accounted for in the child work-item comments.

### Confounders

- **Machine load.** The post-change run executed while the host was heavily
  loaded (load average ~38 on 16 cores) because several unrelated
  `implement.py drive` operations were running concurrently. The absolute
  runtime increase (243 s → 644 s) is therefore **not** attributable to this
  epic — the epic strictly removes test executions.
- **Unrelated concurrent work.** Independent commits added test files to
  `packages/` (+13) and `tests/` (read-cache and dispatch-tier splits), which
  inflate the raw post-change file and test counts.
- A like-for-like runtime comparison would require re-measuring the baseline
  commit on an idle host with the same command set.

### Conclusion

Full suite green after deduplication (`370 passed / 1 skipped` files,
`7952 passed / 5 skipped` tests). No meaningful coverage reduction; all
removed assertions are accounted for.

## Model-cooldown epic baseline (WL-0MV54ZP3Y00514Y9)

**Work item:** WL-0MV563AU2007FM56 (child of the model-cooldown epic —
"Cooldown regression guard and full-suite verification")
**Measured:** 2026-10-12, from the epic worktree with `dist/` built
(`npm run build`).
**Command:** `npm --silent test` (vitest run — the complete suite, including
`packages/`).

The implement/test gates resolve the canonical subset from
`.pi/test-config.json` (`tests/cli` + `tests/unit`); this record uses the
**full** vitest suite so the epic's `packages/` changes are covered.

### Before and after the regression guard

The "before" state is the post-cooldown dev base (regression test absent);
the "after" state adds the withdrawn-drain regression guard
(`packages/herdr/src/drain-regression-guard.test.ts`, three tests). The only
functional change in this child is the test file, so the delta is exactly
the guard.

| Metric | Before | After | Δ |
|---|---|---|---|
| Test files (passed / skipped / total) | 373 / 1 / 374 | 374 / 1 / 375 | +1 file |
| Tests (passed / skipped / total) | 8004 / 5 / 8009 | 8007 / 5 / 8012 | +3 tests |
| Vitest duration | 256.88 s | 240.13 s | −16.75 s (host load) |
| Wall clock (`/usr/bin/time -v`) | 4:17.85 | 4:01.10 | −16.75 s |

Both runs are green; the runtime difference is host-load noise (several
concurrent `implement.py drive` runs were active), not a coverage change.

### Pre-epic context (static)

Tracked test files at the pre-epic commit (`a58d8d6b`, parent of the first
cooldown child commit `f505eb1f`), counted with `git ls-tree` (no full-suite
run at that commit): **365** test files (121 under `packages/`, 235 under
`tests/`, 9 legacy `test/`). The pre-this-child HEAD has **374** (131
`packages/`, 243 `tests/`). The +9-file delta spans the cooldown epic plus
unrelated work merged between those commits and is **not** attributable to
the cooldown epic alone.

### Conclusion

Full suite green after the cooldown epic and its regression guard (374 passed
/ 1 skipped files, 8007 passed / 5 skipped tests). The withdrawn client-side
drain is pinned as not reintroduced (see
`packages/herdr/src/drain-regression-guard.test.ts`).

## `downtime-worker` test-split runtime (WL-0MV4VTFYE0073POG)

**Work item:** WL-0MV4VTFYE0073POG (child of WL-0MV28X3SL005R5KX — "Split
`downtime-worker.test.ts` and cap mocks per test")
**Measured:** 2026-10-12, from the child worktree at dev HEAD `1f701621`
**Scope:** the `downtime-worker` test module only (not the full suite)
**Host:** 16 cores; load average 12–19 during runs (several concurrent
`implement.py` operations)

### Purpose

Parent AC6 requires the `downtime-worker` test-suite runtime to be measured
before and after the split. This section records the method and the results.

### Method

The "before" state is the last pre-split revision of the monolith,
`daa7d2a9:packages/herdr/src/downtime-worker.test.ts` (13,103 lines, 715
tests, 129 describe suites). The "after" state is all 13
`packages/herdr/src/downtime-worker*.test.ts` files (13,697 lines, 725 tests,
146 describe suites).

```bash
# Pre-split baseline (reconstructed from git into a temporary test file)
git show daa7d2a9:packages/herdr/src/downtime-worker.test.ts \
  > packages/herdr/src/downtime-worker.presplit.test.ts
npx vitest run --config vitest.measure.config.ts \
  packages/herdr/src/downtime-worker.presplit.test.ts

# Post-split (all split files)
npx vitest run --config vitest.measure.config.ts \
  packages/herdr/src/downtime-worker*.test.ts
```

Five alternating iterations of each state were run; the **median** is quoted
(the host was too loaded for a single run to be meaningful).

> **Isolation note.** `vitest.measure.config.ts` extends `vitest.config.ts`
> and aliases `@worklog/shared` (and its subpaths) to the worktree's own
> freshly built `packages/shared/dist`. This was required while concurrent
> `implement.py` builds in other worktrees repeatedly overwrote the main
> checkout's packaged `packages/herdr/node_modules/@worklog/shared` copy
> (via `install-herdr.sh`), causing intermittent `ERR_MODULE_NOT_FOUND`
> collection failures. Since WL-0MVAY631M004RZ3Q that dependency is a
> symlink to the live workspace package (link-shared.mjs) instead of a
> packaged copy, so builds no longer rewrite it; the alias is retained for
> measurement isolation (the worktree's own dist) and does not change any
> test semantics.

### Results

| Metric | Pre-split | Post-split | Δ |
|---|---|---|---|
| Test files | 1 | 13 | +12 |
| Tests (all passing) | 715 | 725 | +10 |
| Describe suites | 129 | 146 | +17 |
| Wall clock (median of 5) | **5.80 s** | **5.83 s** | **+0.03 s (+0.5%)** |
| Wall clock (min of 5) | 5.19 s | 5.59 s | +0.40 s |
| Vitest duration (median) | 3.90 s | 4.19 s | +0.29 s (+7.4%) |
| `tests` time (median) | 1.65 s | 2.54 s | +0.89 s (+53.9%) |
| `transform` aggregate (median) | 3.27 s | 8.05 s | +4.78 s (+146%) |
| `import` aggregate (median) | 1.81 s | 6.65 s | +4.84 s (+267%) |
| `setup` aggregate (median) | ~0.12 s | ~0.77 s | ~+540% |

Post-split test counts per file:

| File | Tests |
|---|---|
| `downtime-worker.audit-tier.test.ts` | 55 |
| `downtime-worker.critical-first.test.ts` | 117 |
| `downtime-worker.dispatch.test.ts` | 40 |
| `downtime-worker.fixtures.test.ts` | 8 |
| `downtime-worker.gates.test.ts` | 16 |
| `downtime-worker.idle.test.ts` | 50 |
| `downtime-worker.orchestrator.test.ts` | 72 |
| `downtime-worker.pane.test.ts` | 68 |
| `downtime-worker.parse.test.ts` | 34 |
| `downtime-worker.settings.test.ts` | 57 |
| `downtime-worker.sprint-view.test.ts` | 57 |
| `downtime-worker.test.ts` (residual) | 49 |
| `downtime-worker.tiers.test.ts` | 102 |
| **Total** | **725** |

### Interpretation

- **Wall clock is effectively neutral** (+0.5% median, within host-load
  noise). Vitest's own reported duration rises ~7%.
- The split replaces one module graph with 13 isolated ones
  (`singleFork: true`, `isolate: true`), so the **aggregate**
  transform/import/setup work rises 2.5–6.5×. On this loaded host, warm
  caches largely absorb that overhead, so it barely surfaces in wall clock;
  on an idle host or a cold CI cache the per-file isolation overhead may be
  more visible.
- **No meaningful runtime improvement or regression.** The split's benefit is
  maintainability (≤2,000-line files, bounded mocks per test), not speed.

### Caveats

- The pre-split baseline is reconstructed from commit `daa7d2a9` using the
  current (HEAD) production code. Production code is unchanged by the split
  apart from a JSDoc-only edit to `downtime-worker.ts`, so the comparison is
  like-for-like.
- The host was shared and heavily loaded (load average 12–19 on 16 cores; a
  `tce-main-street` vitest run, other `ContextHub` worktrees, and pytest were
  active). Wall-clock figures are noisy; medians and minima of 5 alternating
  runs are reported rather than a single sample.
- Vitest's `transform`/`import`/`setup` totals are aggregates across all test
  files in the run.

## Test-suite runtime reduction (WL-0MVF9JJUH0077OB8)

**Work item:** WL-0MVF9JJUH0077OB8 — Reduce time to run tests
**Measured:** 2026-10-20, worktree from dev `bec96e2b` with `dist/` built
(`npx tsc`), so the dist-spawning sync tests are exercised faithfully.
**Host:** 16 cores, shared dev host. Load average 10.8–14.0 during every run
(several unrelated agent suites active). Load is quoted per run because it
dominates absolute wall-clock on this host — see *Confounders*.

### Root cause

Per-spawn TypeScript transpilation, not test logic. Tests that need real
process isolation spawned `tsx src/cli.ts`, which re-transpiles the whole
`src/` import graph on **every** process start:

| Invocation | Time per spawn |
|---|---|
| `node node_modules/.bin/tsx src/cli.ts --version` (idle host) | 2.81 s |
| `node node_modules/.bin/tsx src/cli.ts --version` (load avg 10) | 7.1–10.0 s |
| `node dist/cli.js --version` | 1.43 s |
| `node <esbuild bundle of src/cli.ts> --version` | 1.14–1.58 s |

The canonical suite performed ~150 such spawns, so it paid a 5× tax per spawn
on the majority of its wall clock — and that tax scales with host load, which
is exactly the 486 → 730 s swing previously observed.

### Change (test code + test config only)

`tests/cli/cli-bundle.ts` builds `src/cli.ts` **once per test process** with
esbuild (the transpiler tsx already uses) and tests spawn that bundle instead
of tsx. Same entry file, same command graph — only pre-compiled. npm and
workspace packages stay external, and the bundle directory mirrors the repo
layout (`<dir>/app/src/cli.mjs` with symlinked `templates/`, `examples/`,
`package.json`) because `src/` derives its package root from
`import.meta.url`/`../..`. Falls back to `tsx` automatically if the build
fails.

Converted: `read-cache-spawn-reduction`, `read-cache-e2e`, `init` (via
`execAsync`), `search-fts-freshness`, `doctor-cache`, `update-if-assignee`,
`sync-author-gate` and `sync-assignee-clear` (via `execWithInput`), and the
`dist/cli.js`-spawning sync integration tests (`sync-vs-mutation`,
`sync-integration-convergence`, `sync-delta-{pull,push,delete,fallback}`) —
which as a side effect now run against current `src/` instead of whatever
build happened to be on disk.

Also:

- `isDistFresh()` in `bench/wl-startup-perf.ts` makes
  `resolveStartupTarget('auto')` ignore a `dist/` older than `src/` (a stale
  build made `entry-point-split` assert against code that no longer exists —
  a real intermittent failure).
- `startup-import-budget` warmup runs dropped 4 → 2 (the gated samples are
  unchanged).
- `vitest.config.ts` gained `hookTimeout: 60000` (vitest's default is 10 s).
  Several suites create real git remotes and bare repositories in
  `beforeEach`; at load ~20 that setup alone exceeded 10 s and failed as
  `Hook timed out` in `sync-concurrent.test.ts` — a load-induced flake with
  nothing wrong with the code under test.
- `tests/cli/entry-point-split.test.ts` runs its dispatch-parity loop through
  a bounded pool (4 in flight, `mapConcurrent` + an async `spawn` wrapper)
  instead of serial `spawnSync` (WL-0MVSFQ3J4004SNJ9). Parity needs one CLI
  process per built-in command (~32); serially that cost multiplies by the
  command count, so on a contended host (~10 s per `--help`) the serial sum
  blew the test's fixed 300 s budget with nothing wrong in the code. The pool
  divides the wall cost by its width (roughly 32 / 4 ≈ 8 spawns deep instead
  of 32), and the per-test budget is now 600 s of headroom. Each child keeps
  the same 60 s hard kill as the synchronous helper, and results are collected
  in command order so failure messages stay precise.
- `tests/unit/no-tsx-cli-spawn.test.ts` is the regression guard AC6 asks for:
  it fails if the bundle cannot be built (`isBundled()`) or if any test file
  outside a documented allowlist spawns the CLI through `tsx` again.

##### Sweep completeness + second guard (WL-0MVII17N3003FJWT)

A later false failure proved the `dist/` idiom had not been fully swept:
`wl completion bash|zsh > contains all known subcommands` failed with
`expected completion script to contain "worklist"` purely because the
checkout's `dist/cli.js` (gitignored, not rebuilt by `npm test`) predated the
commit that registered the `worklist` command — the source was correct.

- Converted the last hard-coded `dist/cli.js` spanners to the bundle:
  `completion.test.ts`, `doctor-foreign-items-push.test.ts`, `grouping.test.ts`,
  `sync-cache-invalidation.test.ts`, `sync-concurrent.test.ts` and
  `plugin-integration.test.ts` (all now spawn through `runCliProcess()` /
  `cliInvocation()`, so they always run current `src/`).
- `tests/unit/no-stale-dist-spawn.test.ts` is a second regression guard (this
  time for the hard-coded `dist/` idiom): it fails when any test file outside
  a documented allowlist hard-codes a `dist/cli.js` path, naming the file and
  the `runCliProcess()` / `cliInvocation()` helpers to use. Its red evidence
  comes from a temp-dir fixture (the gate rebuilds `dist/` before testing, so
  the ambient failure is not reproducible), mirroring the fixture pattern of
  `startup-target-freshness.test.ts`.
- **Standing rule:** tests must not hard-code `dist/cli.js`. `dist/` is
  gitignored and `npm test` does not rebuild it, so a hard-coded spawn asserts
  against a possibly stale build and fails for reasons unrelated to the code
  under test. Spawn through `runCliProcess()` / `cliInvocation()` from
  `tests/cli/cli-bundle.ts` (or `resolveStartupTarget` where the built entry
  itself is the subject — `smoke`, `entry-point-split`,
  `startup-import-budget`); `npm run build` is only required before a bare
  checkout's suite for the tests that legitimately exercise the built
  artefact, and the guard keeps a forgotten rebuild from silently producing
  false failures.

### Results — canonical suite (`.pi/test-config.json`)

> Historical (WL-0MVF9JJUH0077OB8): the canonical suite at the time was the
> two-command pair below. Since WL-0MVG4FF9200346NR it is the single umbrella
> `npm --silent test -- tests` (277 files); the runtime figures in this
> section remain valid as a pre-widening measurement.

```bash
npm --silent test -- tests/cli
npm --silent test -- tests/unit
```

Wall clock on this host is **not a reliable instrument**: two post-change runs
of identical code measured 462 s and 928 s depending on what else was running.
Three measurements are therefore reported — an adjacent A/B pair (most
trustworthy), a mid-load pair, and the per-test aggregates.

#### A/B pair — back-to-back, matched load (primary evidence)

Baseline and post-change trees measured **back-to-back** on the same host so
both see the same conditions (load average **27–30** — deliberately lumpy, so
this is the pessimistic case). CPU time is the load-independent metric.

| Metric | Baseline (pre-change) | Post-change | Δ |
|---|---|---|---|
| Wall clock (`/usr/bin/time`) | 1189.5 s | 774.5 s | **−415.0 s (−34.9 %)** |
| CPU (user+system) | 3160.8 s | 2445.5 s | **−715.3 s (−22.6 %)** |
| Result | green (`node` suite rc 0) | green (`node` suite rc 0) | — |

#### Mid-load pair (load ~11–14)

| Suite | Baseline (pre-change) | Post-change | Δ |
|---|---|---|---|
| `tests/cli` | 104 files, 868 passed + 4 skipped, **624.03 s** | 104 files, 868 passed + 4 skipped, **426.78 s** | **−197.25 s (−31.6 %)** |
| `tests/unit` | 43 files, 624 passed, **27.44 s** | 43 files, 624 passed, **29.04 s** | +1.60 s (noise) |
| **Canonical total** | **147 files, 1492 passed, 651.47 s** | **147 files, 1492 passed, 455.82 s** | **−195.65 s (−30.0 %)** |

Per-test aggregates from that pair (`tests/cli`): `tests`
**2319.05 s → 1528.78 s** (−34.1 %); `import` 79.83 s → 77.87 s; `transform`
20.67 s → 17.73 s.

Test counts are unchanged apart from one removed duplicate (see below):
868 passed + 4 skipped in both runs.

#### Same-code variance (why one run proves nothing)

Six post-change canonical runs of identical code measured: 462.3 s, 533.8 s,
549.3 s, 621.6 s, 919.1 s, 928.4 s — a 2× spread driven purely by host load
(≈4 → 24 load average). Two pre-change runs measured 624.0 s and 877.9 s. Any
single-run comparison on this host can therefore be made to show anything from
−35 % to +10 %; the A/B pair above and the load-independent CPU figure are the
honest evidence, and all six post-change runs were **green** (no timeouts,
no flakes).

### Post-change top-20 slow tests

Measured from the canonical `tests/cli` run above (per-test durations as
reported by vitest). Baseline column is the same table from the pre-change
canonical run, so the comparison is like-for-like.

| # | Test | Baseline | Post-change |
|---|---|---|---|
| 1 | `sync-vs-mutation` — AC1/AC2 cross-command mutations survive (whole file) | 162.9 s | 151.3 s |
| 2 | `close-recursive` (whole file, 46 tests) | 128.4 s | 120.7 s |
| 3 | `issue-management` (whole file, 49 tests) | 95.7 s | 87.6 s |
| 4 | `read-cache-spawn-reduction` — 6-pane simulation | 203.2 s | 83.8 s |
| 5 | `startup-import-budget` — warm cache-hit within budget | 69.0 s | 59.4 s |
| 6 | `issue-status` (whole file, 43 tests) | 74.7 s | 57.9 s |
| 7 | `valid-json-output` (whole file, 38 tests) | 68.8 s | 56.7 s |
| 8 | `init` (whole file, 20 tests) | 109.4 s | 55.6 s |
| 9 | `entry-point-split` — dispatch parity (all built-ins) | 47.4 s | 35.4 s |
| 10 | `read-cache-e2e` (whole file, 9 tests) | 146.2 s | 51.8 s |
| 11 | `json-output-shape` (whole file, 18 tests) | 63.1 s | 51.4 s |
| 12 | `sync-integration-convergence` — AC7 interleaved 4 rounds | 41.8 s | 31.4 s |
| 13 | `update-batch` (whole file, 25 tests) | 33.6 s | 31.0 s |
| 14 | `sync-delta-delete` (whole file, 3 tests) | 29.0 s | 24.2 s |
| 15 | `audit-results-cli` (whole file, 24 tests) | 25.8 s | 23.7 s |
| 16 | `sync-delta-fallback` (whole file, 3 tests) | 29.0 s | 23.6 s |
| 17 | `update-audit-revert` (whole file, 14 tests) | 22.8 s | 23.1 s |
| 18 | `stats-by-type` (whole file, 5 tests) | 46.7 s | 22.7 s |
| 19 | `sync-delta-pull` (whole file, 3 tests) | 23.3 s | 22.3 s |
| 20 | `create-update-demote-parent` (whole file, 14 tests) | 21.7 s | 22.2 s |

Remaining slow tests are **intentional**: real-git sync integration (~25
tests) cannot have `git` mocked without removing the behaviour under test;
`startup-import-budget` and `entry-point-split` must observe the real
`tsx`/`dist` entry points; the in-process CLI contract tests
(`close-recursive`, `issue-management`, `issue-status`, `valid-json-output`,
`json-output-shape`) pay real CLI startup (~200 ms/call), which is production
behaviour rather than test overhead.

### What was removed

One duplicate in `tests/cli/read-cache-e2e.test.ts` — *"a fresh cache dir
misses once then hits (no cross-test pollution)"* — which re-asserted the
miss→hit cycle already covered by *"serves repeat identical reads from cache
(AC1)"* (every case in that file already uses a fresh temp dir). A
duplicate-title audit over the canonical suite found no other duplicated
tests.

### Full-suite per-test timings (`npm run test:timings`)

`npm run test:timings` (full `vitest run`, all packages) reported
**4095.4 s across 8284 tests** during this session, versus **2434.4 s across
8281 tests** for the pre-change report of 2026-10-20T06:04Z. Those two
full-suite figures are **not** comparable: the post-change report ran while
the host was markedly more loaded (wall clock 1440 s for a suite whose
canonical subset is 456 s). The canonical-suite tables above are the
like-for-like measurement; treat `test-timings.json` absolute values as
host-load-sensitive and compare only reports taken in the same conditions.

### pytest

`pytest -q -r a --disable-warnings` (via `run_tests.py --suite pytest`):
**167 tests, 162 passed / 5 failed, 101–103 s**. The 5 failures are
pre-existing skill-behaviour drift (`tests/skill/heartbeat/`,
`skill/pane-triage/tests/`), confirmed identical on a clean tree with these
changes stashed, and are tracked in WL-0MVH2T0ZV006KIOU. No Python test is
≥5 s, so no optimisation was needed and pytest is unchanged.

### Reproduce

```bash
# from the worktree, with dist built so the entry-point tests are faithful
npx tsc

# canonical suite (pre-change baseline was the same command on dev bec96e2b)
python3 <test-skill>/scripts/run_tests.py --scope full --suite all --force --json

# per-test timings (full suite; load-sensitive)
npm run test:timings

# pytest
python3 <test-skill>/scripts/run_tests.py --suite pytest --force --json
```

### Confounders

- **Host load is the dominant variable.** Sessions ran at load average 3–30
  on a shared 16-core host with unrelated agent suites active, which moves
  absolute wall clock by up to 2× for identical code. This is why the A/B
  pair (back-to-back, matched load) and the CPU-time figure are the primary
  evidence, and why single-run comparisons are not quoted as authoritative.
- **Load makes the pre-change suite *fail*, not just slow.** The second
  pre-change run at load ~20 hit `Test timed out in 60000ms` in
  `read-cache-e2e > arg variants produce separate cache entries (AC3)` —
  eight `tsx` spawns each taking ~8 s exceeds the 60 s test timeout. The
  post-change suite stayed green in all six runs, including at load 24–30,
  because a spawn now costs ~1.1 s instead of ~8 s.
- **Relative gain grows with load.** `tsx` spawn cost rises steeply with CPU
  contention (2.8 s idle → 8 s loaded) while the pre-compiled spawn barely
  moves, so an idle CI host will show a smaller proportional win than the
  loaded measurements here — but a strictly faster suite in absolute terms.

## Related

- Parent epic: WL-0MV28X3BT0079JM3 — Deduplicate legacy `test/` vs `tests/`
- `downtime-worker` test split: WL-0MV28X3SL005R5KX
- Runtime measurement child: WL-0MV4VTFYE0073POG
  files and delete verbatim subsets
- Post-change measurement: WL-0MV4V0IF9008214R
- Model-cooldown epic: WL-0MV54ZP3Y00514Y9 — Resume model-exhausted jobs
  instead of switching to cheap
- Regression guard + full-suite verification: WL-0MV563AU2007FM56
- Test-suite runtime reduction: WL-0MVF9JJUH0077OB8 — Reduce time to run tests
  (bundle-based CLI spawning; see the section above)
- Pre-existing pytest failures: WL-0MVH2T0ZV006KIOU
- Canonical gate reference author: WL-0MVGJ4WSS005BMSI (child WL-0MVH75NY3002TTX9)
- Root-level `tests/` coverage (the `tests/` umbrella): WL-0MVG4FF9200346NR —
  see [Full `tests/` coverage](#full-tests-coverage-wl-0mvg4ff9200346nr)
- Stale `fetcher-memo` test exposed by that widening:
  WL-0MVOERBM5001VUPY (fixed inline by WL-0MVG4FF9200346NR)
- Remaining `packages/` coverage gap (`tui` + `shared`):
  WL-0MVODOJWB004G03J
- Herdr package suite exclusion (producer decision, won't-fix):
  WL-0MVFZVIA50062TJ8
