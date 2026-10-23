# wl spawn baseline — per-invocation cost (F1, 2026-10-19)

Baseline measurement for the spawn-load epic (WL-0MVFNMSRW002FI6B, F1
WL-0MVFRR98A008MM19). Every `wl` invocation pays a per-process boot cost;
this table is the "before" against which the import-slimming phases (F2–F7)
and the ≥60% CPU-second reduction verdict (F10) are compared.

## Method

- Host: reference host for this repo (this worklog); node v22.22.1.
- Binary: `node dist/cli.js` from the F1 worktree build
  (`wl-WL-0MVFRR98A008MM19-spawn-instrumentation-per-process-cpu-an`), run
  against the main checkout's `.worklog` via `--worklog-dir`.
- `/usr/bin/time -v` per run; `N=10` runs after 2 warmups except where noted;
  p95 = 95th percentile, median = middle sample.
- `wl sync` refuses to run from a linked worktree (cross-project guard,
  WL-0MSAH26DD001XXST), so it is measured with `cwd` = main checkout; CPU and
  RSS come from `/usr/bin/time -v` (full-process, not the spawn record).
- The shared host runs herdr auto-sync (60 s cadence) and pi agents
  concurrently — samples can show contention outliers (`wl list --json` p95
  21.9 s vs median 2.78 s).

## Results

| Command | p95 wall (s) | median wall (s) | p95 RSS (MB) | mean CPU (s) |
|---|---|---|---|---|
| `wl --version` | 1.19 | 1.01 | 78.9 | 1.051 |
| `wl next --json` | 1.10 | 1.00 | 79.2 | 1.033 |
| `wl list --json` | 21.92* | 2.78 | 257.5 | 4.110 |
| `wl status` | 3.06 | 2.25 | 165.2 | 2.187 |
| `wl sync --if-idle --dry-run` | 9.39 | 7.58 | 354.4 | 6.357 |
| `wl sync --if-idle --no-push` (real sync, n=3) | 180.8 | 179.0 | 475.9 | 109.0 |
| `node -e ''` (bare reference, n=4) | 0.52 | 0.45 | 58.3 | 0.43 |

\* Contention outlier — median 2.78 s is representative.

## Spawn-record evidence (new instrumentation)

`WL_SPAWN_COUNT_FILE` now records `<kind>\t<ts>\t<pid>\t<cpuMs>\t<maxRssKb>`.
A short instrumented run of `wl next --json` produced:

```
read-work	1792451822938	3107097	1079	79788
cache-hit	1792451825132	3107192	1159	80660
```

`summariseSpawnRecords` over that file: `total=2, byKind={read-work:1,
cache-hit:1}, cpuSeconds=2.238, maxRssKb=80660, missingCpu=0, missingRss=0`.
The stderr path (`WL_SPAWN_COUNT=1`) reports
`[wl:spawn] read-work <pid> cpuMs=1052 maxRssKb=80172`.

Per-spawn CPU at the instrumentation point ≈ 1.05–1.18 s — the boot/import
graph dominates each process (bare node ≈ 0.43 CPU-s), confirming the
import-slimming lever (F2–F7) for the AC2 reduction target.

## Caveats / next steps

- `wl list --json` (unfiltered) is the heaviest read — the read-cache fast
  path (already shipped, WL-0MSAZQEQB008O7H3) and the F4/F6/F7 import cleanup
  target it.
- The real-sync sample (109 CPU-s) includes git pull/merge, full JSONL export
  and re-sort; it is the extreme case among herdr's 60 s auto-sync cadence and
  is dominated by data volume, not import graph.
- Re-measure after F7 with the identical method for the AC2 verdict (F10).
