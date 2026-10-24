# `wl sync` persist phase: before/after (WL-0MVK6SDU90036BBX)

F2 (WL-0MVJV2NNG00771C6) profiled `wl sync` on the 123.7 MB F1 fixture and
found the persist phase — `db.import(items + edges + audits)` plus
`db.importComments(26,000)` — took ~97 % of the pipeline, with 78–90 % of that
CPU inside `upsertFtsEntry`. Every item and every comment was cleared and
re-inserted, and every item's FTS row was rebuilt, even when the merge result
was unchanged: a no-change sync paid the whole cost.

WL-0MVK3WRY9009KV6P fixed that with differential persist
(WL-0MVK6S9TN00500UL): only records whose merged value differs from the local
store are written, FTS upkeep is proportional to the changed ids, and a
no-change sync performs **zero record writes and zero FTS writes**. The phase
timings are now observable in `wl sync --json` (`summary.phaseTimings`, same
names as the probe — WL-0MVK6SD5O001K901), and the write-detection behaviour is
pinned by the default-suite tests added in WL-0MVK6S4HM005GBCO
(`tests/unit/persist-write-detection.test.ts`).

This note is the measurement record: the re-runnable commands and the
before/after table behind parent ACs 2 and 6.

## Re-runnable measurement

### 1. Generate the full-scale F2 fixture

The probe needs the fixture **kept on disk**; the `--stages` harness run
generates the same fixture internally and deletes it. Generate it with the
harness's own exported generator (same `full` profile the `--stages` run uses,
same deterministic seed):

```sh
cat > .tmp-gen-f2-fixture.ts <<'EOF'
import { generateLargeWorklog, LARGE_DB_PROFILES } from './packages/herdr/test/perf/large-db-harness.js';

const fixture = generateLargeWorklog(LARGE_DB_PROFILES.full);
console.log(fixture.worklogDir);
EOF

FIXTURE=$(npx tsx .tmp-gen-f2-fixture.ts)
rm .tmp-gen-f2-fixture.ts
```

That builds 2,600 items / 26,000 comments / 259 dependency edges in a throwaway
`/tmp/herdr-large-db-*/.worklog` (123.7 MB SQLite DB, 78.5 MB JSONL snapshot
when exported). Only `/tmp` is written; no repository or operator worklog is
touched.

The equivalent stage-table run, if a refresh breakdown is also wanted:

```sh
npx tsx packages/herdr/test/perf/large-db-harness.ts --profile full --stages --json
```

### 2. Time the persist phases

The probe replays `performSync`'s persist pipeline on a **disposable copy** of
the store (the input `.worklog` is never modified) and reports wall and CPU
time per contract phase:

```sh
npx tsx packages/herdr/test/perf/wl-sync-phase-probe.ts --worklog-dir "$FIXTURE" --json
```

`persist-items` + `persist-comments` are the phases the parent AC measures.
Because the probe exports the JSONL from the same store copy and merges it
straight back, the merge result is unchanged — i.e. it measures exactly the
**no-change sync** case.

### 3. CPU profile of the run

`node --cpu-prof` around the probe (run it through the `tsx` loader so the
profile covers the measurement process itself):

```sh
node --cpu-prof --cpu-prof-dir=/tmp/sync-prof --import tsx \
  packages/herdr/test/perf/wl-sync-phase-probe.ts --worklog-dir "$FIXTURE" --json
```

Top self-time functions from the generated `CPU.*.cpuprofile`:

```sh
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const nodes = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
let total = 0;
for (let i = 0; i < p.samples.length; i += 1) {
  const us = p.timeDeltas[i] || 0;
  total += us;
  self.set(p.samples[i], (self.get(p.samples[i]) || 0) + us);
}
const agg = new Map();
for (const [id, us] of self) {
  const name = nodes.get(id)?.callFrame.functionName || "(anonymous)";
  agg.set(name, (agg.get(name) || 0) + us / 1000);
}
for (const [name, ms] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(name.padEnd(40), ms.toFixed(1), "ms", ((100 * ms) / (total / 1000)).toFixed(1) + "%");
}
' /tmp/sync-prof/CPU.*.cpuprofile
```

### 4. Before/after

"Before" is the last pre-fix `dev` commit (`a6860d43`, before the differential
persist landed); "after" is the fixed tree. Run the **same probe file** in both
trees so only the production code differs.

> **Gotcha when using a second worktree:** `packages/shared` is consumed through
> the workspace symlink `node_modules/@worklog/shared`. `implement.py start`
> creates that symlink relative to its own worktree, so a hand-made worktree
> that borrows the first worktree's `node_modules` will silently load the
> **fixed** `packages/shared` and produce identical "before" numbers. Point
> `node_modules/@worklog/shared` at the before-tree's own `packages/shared`
> (and build it: `cd packages/shared && npm run build`) before profiling.

```sh
# example: pre-fix tree at /tmp/wl-before-perf
git -C <repo> worktree add /tmp/wl-before-perf a6860d43
cd /tmp/wl-before-perf && npm --prefix packages/shared run build
# then run step 2 / step 3 from that tree
```

## Results

Fixture: 2,600 items / 26,000 comments / 259 edges / 123.7 MB DB. Host
`rgardler-AI-Laptop`, Node v22.22.1, 16 vCPU, load average 15–25 during the
run (shared host — read wall time as a range, CPU time and the ratio as the
stable metric).

| Phase | Before (`a6860d43`) wall / CPU | After (fixed) wall / CPU | After ÷ before |
|---|---|---|---|
| `persist-items` (`db.import`) | 41.7 s / 43.8 s | 95 ms / 89 ms | 0.23 % |
| `persist-comments` (`db.importComments`) | 99.7 s / 105.7 s | 578 ms / 526 ms | 0.58 % |
| **persist total** | **141.4 s / 149.5 s** | **0.68 s / 0.62 s** | **0.48 %** |
| F2 baseline on a quiet host (WL-0MVJV2NNG00771C6) | 57.4 s (14.0 s + 43.5 s) | 0.68 s | **1.2 %** |

- Before: two runs under the same load — 141.4 s and 175.5 s wall
  (149.5 s / 176.4 s CPU). The pre-fix numbers exceed F2's 57.4 s quiet-host
  baseline because of current host load; the ratio against the AC baseline is
  therefore the conservative one (1.2 %).
- After: median of three consecutive runs (wall range 0.16–0.95 s; the warm
  profiled run measured 158 ms). The target was ≤ 5.7 s (10 % of 57.4 s); the
  measured persist total is **0.68 s → ~1.2 % of the baseline**, with zero
  writes.

CPU profile self time (whole probe run; the persist phases are ~97 % of it):

| Function | Before | After |
|---|---|---|
| `upsertFtsEntry` | 127.5 s — 81.7 % of all self time | **0.0 ms (absent from the profile)** |
| `saveComment` | 4.4 s — 2.8 % | 0.0 ms |
| `saveWorkItem`, `clearWorkItems`, `clearComments`, `deleteFtsEntry` | present | 0.0 ms |
| `importComments` (diff scan only) | — | 17.2 ms |

The after profile shows **zero `upsertFtsEntry` self time** and zero self time
in every record-write/FTS function — the no-change sync performs no writes at
all. The remaining after-run cost is the change-detection diff itself
(`stableStringify` / `stableItemKey`, ~18 % / ~5 % of self time), not database
work.

## Where the fix is

- `packages/shared/src/database.ts` — `import()`, `importComments()`,
  `upsertItems()`, `upsertComments()`: differential persist, per-record-type
  transactions, FTS upkeep only for changed ids.
- `packages/shared/src/persistent-store.ts` — `deleteFtsEntry` (targeted
  FTS-row removal for the sync path), unchanged `clearWorkItems()` /
  `clearComments()` for the remaining destructive callers (`importData()`,
  `doctor migrate`, `clear()`).
- `src/commands/sync.ts`, `src/sync-phase-timings.ts` — phase timings in
  `wl sync --json` (`summary.phaseTimings`), same names as the probe.

## Limits

- The probe replays the persist pipeline **offline**: no network fetch and no
  git push. It measures exactly the persist phases the AC targets.
- The probe is single-run per invocation; quote the ratio and CPU shares (as
  above) rather than one wall number, which is load-sensitive on a shared host.
- The fixture is regenerated per run (deterministic seed), so a future re-run
  compares like with like; the checked-in numbers above are dated
  2026-10-24T04:57Z–05:15Z (UTC).
