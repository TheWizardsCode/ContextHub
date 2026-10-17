# Test Suite Baseline — Legacy `test/` Deduplication

**Work item:** WL-0MV4UZ6C4007XDGI (child of WL-0MV28X3BT0079JM3)
**Baseline commit:** `85679713a678b54417d4e994fc7f305c3ff75d38` (dev)
**Measured:** 2026-10-12

## Purpose

Record the pre-change baseline (test file count and suite runtime) for the
legacy `test/` vs `tests/` deduplication epic, so the post-change child
(`WL-0MV4V0IF9008214R`) can report a meaningful delta.

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

## Related

- Parent epic: WL-0MV28X3BT0079JM3 — Deduplicate legacy `test/` vs `tests/`
- `downtime-worker` test split: WL-0MV28X3SL005R5KX
- Runtime measurement child: WL-0MV4VTFYE0073POG
  files and delete verbatim subsets
- Post-change measurement: WL-0MV4V0IF9008214R
- Model-cooldown epic: WL-0MV54ZP3Y00514Y9 — Resume model-exhausted jobs
  instead of switching to cheap
- Regression guard + full-suite verification: WL-0MV563AU2007FM56
