# wl startup import budget (F2 — WL-0MVFRRAXD001E7AN)

The parent epic (WL-0MVFNMSRW002FI6B, "Investigate transient wl process CPU
usage") requires the `wl` fast path to stop loading command modules, the DB
runtime and plugins:
warm cache-hit `wl next --json` / `wl list --status open --json` and
`wl --version` should cost p95 ≤ 0.5 s wall and ≤ 60 MB peak RSS on the
reference host (bare node is ~0.5 s / 58 MB).

F2 builds the harness that (a) captures the pre-change baseline and (b) locks
the current import graph in place as a **ratchet**, so each later slimming
change (F4 split entry, F6 lazy command registry, F7 fast-path slimming) can
only tighten it — no regression can slip through between items.

## Files

| File | Purpose |
|---|---|
| `bench/startup-import-graph.ts` | AST walker for the transitive **static, runtime** import graph of `src/cli.ts` (type-only and dynamic imports excluded; unresolved relative imports are a hard error). |
| `bench/startup-budget.ts` | Budget schema/read/write, the import ratchet, and the host-load–tolerant regression policy. |
| `bench/wl-startup-perf.ts` | Benchmark: ≥ 10 warm runs per scenario, p95 wall/CPU/RSS, bare-node floor, `--json`, `--target src\|dist\|auto`, `--update-budget`. |
| `bench/startup-import-budget.json` | The checked-in budget: import graph, per-target baselines, AC1 targets and headroom policy. |
| `tests/cli/startup-import-budget.test.ts` | Ratchet (fails on an added module), budget integrity, policy unit tests, and a measured regression test in the default suite. |

## What the budget records

- **`importGraph.modules`** — every repository module statically reachable
  from `src/cli.ts`, sorted. The ratchet test fails when a module is **added**.
  Removing modules is allowed (an improvement) and prints the exact command to
  lock it in, so a later change cannot silently re-add them.
- **`baselines.<src|dist>.scenarios`** — measured p50/p95 wall time, p95 CPU
  time (`process.resourceUsage` user+system, read from the F1 spawn records),
  p95/max peak RSS, and the spawn-record kind per scenario (`cache-hit` for the
  read scenarios, `version` for `--version`). Both invocation targets are
  recorded because the default suite can always run `src` (tsx), while
  `/usr/local/bin/wl` runs `dist` (built `dist/cli.js`).
- **`ac1Targets`** — the parent AC1 numbers (500 ms / 60 MB) plus `enforced`
  and `measuredTarget`. The target is only asserted once F7 records a
  compliant `dist` baseline and flips `enforced`; before that the budget is a
  ratchet against today's pre-slimming graph and cost, not a target the tree
  cannot yet meet.
- **`regression`** — the headroom policy (see below).

## Re-running the benchmark

The exact commands (both targets; `dist` requires a build):

```bash
# src (tsx) — the target the default test suite can always run
npm run benchmark:wl-startup -- --target src --runs 12 --json

# dist (built; what /usr/local/bin/wl executes)
npx tsc                       # or `npm run build` for the full build
npm run benchmark:wl-startup -- --target dist --runs 12 --json

# Record the numbers as the new budget (deliberate ratchet step)
npm run benchmark:wl-startup -- --target dist --runs 12 --update-budget
```

Additional options: `--warmup N` (max warmup attempts before sampling),
`--bare-node-runs N`, `--worklog-root <dir>` (benchmark a real worklog instead
of the throwaway 3-item fixture), `--keep` (keep the temp fixture/cache),
`--json`.

### Build-freshness requirement (`--target auto`)

`--target auto` (also used by `tests/cli/entry-point-split.test.ts`) selects
the built `dist/cli.js` **only when that build is at least as new as every
file under `src/`**; otherwise it falls back to the tsx `src/cli.ts` entry
(`resolveStartupTarget` in `bench/wl-startup-perf.ts`).

This guard exists because a stale `dist/` silently makes the suite test *old*
code: `entry-point-split` asserts the `--version` spawn record added to
`src/cli.ts`, and a build predating that change emits no `version` record — the
test then fails with `expected +0 to be 1` depending only on whether the
checkout happened to be rebuilt (`dist/` is gitignored, and neither `npm test`
nor `git pull` rebuilds it).

Consequences for operators and CI:

- **Rebuild after pulling source changes** (`npm run build`) before trusting a
  `dist`-targeted result. A stale build does not fail silently: `auto` switches
  to `src`, while an explicit `--target dist` still runs the stale build (it is
  an explicit request) — verify timestamps with `isDistFresh(repoRoot)` when in
  doubt.
- **The generated `src/version.ts` is excluded** from the comparison: `npm run
  build` runs `tsc` and then `scripts/generate-version.cjs` rewrites
  `src/version.ts`, so counting it would make *every* fresh build look stale and
  `auto` would stop covering `dist/` entirely.
- **No build present** (`dist/cli.js` missing) → `auto` uses `src`, which is
  always correct and always available; `--target dist` throws an actionable
  "build the CLI first" error.

The contracts are pinned by `tests/unit/startup-target-freshness.test.ts`.

The read scenarios are warmed until the first cache hit and every counted
sample must report the expected spawn kind, so the numbers describe the served
cache-hit fast path (and a cache-TTL miss mid-loop is re-warmed and retried,
not counted). `WL_CACHE_DIR` always points into the throwaway benchmark
directory, so the run starts from a cold cache and never disturbs the
operator's `~/.cache/wl`.

## Fast-path runtime allowlist (F7 — WL-0MVFRROLM002K98B)

The fast path defers the read-cache machinery, the worklog resolver and the
process-lifecycle module behind `await import(...)`, so `wl --version` exits
before loading any of them. The static ratchet cannot see those modules, so the
budget also records:

- **`fastPathDynamicImports`** — the fast path's dynamic entrypoints
  (`src/process-lifecycle.ts`, `src/read-cache-cli.ts`, `src/worklog-paths.ts`).
- **`fastPathRuntimeModules`** — the union of the static boot graph and the
  transitive static graphs of those entrypoints (the modules a warm cache-hit
  read can load).

Adding either fails `tests/cli/startup-import-budget.test.ts`; moving an import
behind `await import()` is therefore not a way around the budget. Regenerate
both with the same `--update-budget` command.

Current shape (after F7): **4 static modules** (`src/cli.ts`,
`src/argv-normalize.ts`, `src/spawn-counter.ts`, `src/version.ts`) and 3 dynamic
entrypoints, for an 8-module runtime union.

## Regression policy (host-load tolerant)

Shared hosts (a Raspberry Pi, the herdr server) inflate wall-clock time under
contention, so the pass/fail gate is **CPU time** — `user + system` from the
F1 spawn instrumentation, which is load independent:

- **p95 CPU** ≤ recorded p95 + `cpuHeadroomPct` (default 50 %) — the gate;
- **p95 wall** ≤ recorded p95 + `wallHeadroomPct` (default 200 %) + 250 ms —
  catches gross regressions while tolerating a loaded host;
- **p95 peak RSS** ≤ recorded p95 + `cpuHeadroomPct`;
- every sample must be a genuine fast-path invocation (expected spawn kind);
- parent AC1's 500 ms / 60 MB is asserted for the `measuredTarget` only once
  `ac1Targets.enforced` is true (F7).

`tests/cli/startup-import-budget.test.ts` applies this policy to a real
measured `src` run (`regression.runs` samples, default 4) — CPU time is the
gate, so suite runs on a busy machine do not produce false failures — and the
ratchet check is pure AST/filesystem work (well under a second).

## Updating the budget

1. Make the change (remove modules / improve timings).
2. Re-run the benchmark for the affected target(s) **without**
   `--update-budget` and confirm the policy passes.
3. Re-run with `--update-budget` (it rewrites the import graph and that
   target's baseline, preserving `ac1Targets`/`regression`).
4. Commit `bench/startup-import-budget.json` with the change, so the
   improvement is locked in.

F7 would flip `ac1Targets.enforced` to `true` in the same change that records a
compliant `dist` baseline. The F7 measurement found the target unreachable by
import slimming alone (both AC1 numbers sit at or below the bare-node floor on
the loaded reference host), so `enforced` stays `false`, the measured floor is
recorded in `ac1Targets.note`, and an OPEN QUESTION was raised on the parent
(WL-0MVFNMSRW002FI6B).

## Baseline (F2, 2026-10-20)

Recorded on the reference host — node v22.22.1, 3-item throwaway fixture,
12 measured warm runs per scenario after warmup, p95 values:

| Scenario | `src` (tsx): wall / CPU / p95 RSS | `dist`: wall / CPU / p95 RSS |
|---|---|---|
| `wl next --json` (cache hit) | 5017 ms / 4038 ms / 125.2 MB | 1316 ms / 1224 ms / 78.8 MB |
| `wl list --status open --json` (cache hit) | 5895 ms / 4270 ms / 122.4 MB | 1838 ms / 1320 ms / 78.9 MB |
| `wl --version` | 4739 ms / 3933 ms / 122.9 MB | 1390 ms / 1265 ms / 78.5 MB |
| bare-node floor | 827 ms / 531 ms / 57.6 MB | 670 ms / 562 ms / 61.1 MB |

Context: the shared host was loaded during capture (F1 measured the same
`dist` commands at ~1.0–1.2 s p95 on a quieter host), which is why wall times
are high while the CPU-time budget stays meaningful. `src` (tsx) is dominated
by the on-the-fly transform of the 88-module graph; `dist` is the number that
matters for `/usr/local/bin/wl` and for AC1. Current `dist` peak RSS
(~79 MB) is above AC1's 60 MB target and cache hits still boot the full graph —
exactly what F4/F6/F7 reduce; F7 re-runs the benchmark and flips
`ac1Targets.enforced`.

Exact figures (including `maxRssMb` and the bare-node floor per target) are in
`bench/startup-import-budget.json` under `baselines.src` / `baselines.dist`;
the recorded import graph is 88 repository modules plus 23 external
specifiers.
