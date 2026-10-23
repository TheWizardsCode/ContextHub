# Herdr event-driven refresh (fast, non-blocking refresh after agent writes)

Parent work item: `WL-0MV02VA29009WBEN` — *Make Herdr UI refresh snappy after
agent work-item updates*.

## Problem

The Herdr Work Items pane relied on a 30 s auto-refresh tick, so an agent's
`wl` write could take up to 30 s to appear. When the tick did run, the write
had just invalidated the on-disk read cache, so the pane spawned ~5 cold `wl`
processes (plus one `wl list --parent` per expanded parent) for a multi-second
update — precisely when the operator is watching an agent work.

## Design

### 1. Event-driven detection (`db-change.ts` → `watchDbChanges`)

`watchDbChanges(cacheDir, worklogDir, onChange, opts)` watches the **same
cross-process signal** the existing `DbChangeTracker` reads:

- the per-worklog state counter `<cacheDir>/state/<sha256(worklogDir)>.json`
  (bumped by every `wl` write and by post-sync cache invalidation —
  write-only from `wl`'s perspective).

The SQLite `worklog.db` / `worklog.db-wal` / `worklog.db-shm` files are
**deliberately NOT watched**. An early design watched them too, which created
a self-sustaining refresh loop: the pane's own refresh path
(`fetchActionableCount` / `fetchChildrenForItems`) opens a fresh
`WorklogDatabase` connection for in-process reads, and that open/close
checkpoints the WAL and touches `-shm` — i.e. it modifies exactly the files
being watched, re-firing the watch → another refresh → more file churn. The
pane never writes the state counter (it only reads it), so the counter is the
loop-free authoritative signal (producer-rejection fix for
`WL-0MV02VA29009WBEN`).

A burst of events is coalesced into **at most one trailing** `onChange()` after
`debounceMs` (default 150 ms). The watch is **fail-open**: a target whose
`fs.watch` throws is skipped, and when no target can be established the handle
reports `active === false` so the caller keeps the 30 s polling tick. An
asynchronous `fs.FSWatcher` `'error'` event (inotify limits, network FS) and a
throwing `onChange` are both swallowed through the `onError` seam so nothing
escapes into the TUI event loop. `dispose()`/`close()` closes every handle and
clears any pending timer; teardown happens on pane exit.

### 2. Wire-through (`worklist.ts`)

The watch callback dispatches asynchronously (`void requestWatchRefresh()`),
which:

1. skips when a text-input overlay is open (`inputActive()`) or the pane tab is
   hidden (`paneGate.visible()`) — the change is deliberately **left
   unconsumed** so the fallback tick refreshes once the gate clears;
2. consumes the `DbChangeTracker` baseline (`tracker.dbChanged()`) so the next
   30 s tick sees the change as already handled and stays a no-op
   (`WL-0MSJ1OLTL009N4IQ`, idle zero-spawn preserved);
3. calls the existing gated `doRefresh` (awaited), preserving its
   **single-flight + trailing-coalescing** semantics
   (`WL-0MSBVYBMD004007C`, `WL-0MTIB7JAN004MQ8N`) — the watch never bypasses
   those guards, so a burst cannot cause a refresh storm. Because the state
   counter is bumped *before* a `wl` write commits (pre-action cache
   invalidation), the counter is re-checked after the refresh and, if it
   moved again (the write settled mid-refresh), one final trailing refresh
   runs so the pane never shows a pre-commit snapshot.

### 3. Cold-refresh cost (`fetcher.ts`)

The default-view refresh now spawns far fewer `wl` processes:

- **In-process SQLite reads** — `fetchActionableCount` and
  `fetchChildrenForItems` read in-process from SQLite when a worklog dir is
  resolved and `better-sqlite3` is available. The store is loaded lazily
  (kept out of the plugin import graph until needed); the in-memory query
  cache is never trusted across a refresh boundary.
- **One shared connection per refresh (WL-0MV6C6SLB005HX7B)** — the two
  helpers previously opened a FRESH `WorklogDatabase` each, running the
  synchronous open + pragmas + `initializeSchema`/`initializeFts` DDL on the
  UI event loop twice per refresh (~46–70 ms apiece on a large `worklog.db`).
  `doRefresh` now creates one `InProcessRefreshScope`
  (`createInProcessRefreshScope` in `fetcher.ts`) and both helpers consume
  the SAME connection, closed in the refresh's `finally` — so the blocking
  cost is bounded at one open per refresh. Scope-less callers (e.g. the
  startup actionable-count load) still open a fresh per-call connection, and
  every in-process read still fails open to the `wl` spawn path unchanged.
- **One consolidated read (WL-0MVGYLU0S004WZUS)** — the default-view tick now
  issues a single `wl worklist --json` (WL-0MVI0HX58009JJRF) instead of the
  five separate reads it used to fan out to (four mandatory `wl list` subsets +
  the `wl next` browse feed). The command opens the database once and returns
  `critical`, `reviewQueue`, `inProgressRoots`, `blockedRoots` and `browse` in
  one payload, built from the *same* query and selection code the individual
  commands use (no forked filters, no forked ordering; the browse feed comes
  from the shared selection module consumed by `wl next` too).
  - **One read-cache entry** — `worklist` is a cacheable read
    (WL-0MVI0IS6Y0028KTO): the payload is keyed by `(worklog-dir, argv)` and
    invalidated by the same monotonic state counter as the other read commands,
    so repeat ticks across panes are cache hits rather than DB work.
  - **Derived review-queue state** — `fetchReviewQueueState()` derives the
    banner state from the same bundle (in flight or freshly settled) instead of
    spawning the review query again (`doRefresh` starts the item read first so
    there is always a bundle to derive from — WL-0MVI0IW8V007DFM6).
  - **Mandatory guarantees preserved** — critical, review-queue, in-progress
    root and blocked-root items are always included regardless of the browse
    window; `selectWorkItems` → `regroupWorkItems` runs unchanged, and items
    shared with a mandatory subset keep the richer `wl list` audit fields
    (`auditResult`, `auditedAt`, `fingerprint`, `currentFingerprint`), so the
    audit-bucket sort classifies them exactly as before.
  - **Fail-open fallback** — an older `wl` without the command, a non-zero exit,
    a malformed payload or a missing subset key falls back to the per-subset
    spawn path with unchanged behaviour. A *hung* `wl` is deliberately NOT
    retried: the timeout propagates so the refresh stays bounded instead of
    paying the 60 s bound again per subset.
  - **Filtered views unchanged** — the stage-filtered, priority-filtered and
    recent-dispatches views keep their existing reads; only the unfiltered
    default view is consolidated.
- **Cross-subset consistency** — the five subsets are read through one
  connection, so a single refresh reflects one stable view of the worklog.
  Residual risk: a write landing *between* two of those in-process queries
  (rather than before/after the read) can still make two subsets disagree for
  one tick — the same eventual-consistency window the previous five-spawn
  implementation had, now bounded to one process instead of five.
- **One read for all expanded parents** — `fetchChildrenForItems()` resolves
  every expanded parent in one in-process query; per-parent CLI calls remain
  only as the fallback.

Measured on the benchmark harness (≥ 1000 items, ≥ 20 expanded parents), the
cold default-view refresh dropped from **25 → 3** `wl` spawns (~88 %).

#### Measured: five spawns → one (WL-0MVI0IX6E000N6IZ)

Measured on one host (4 panes, 30 s cycle, 5 s tick, 20 seeded items) with the
same build, comparing the two query sets on the F10 harness
(`bench/herdr-refresh-cycle.ts`):

| Query set | Spawns / refresh | Spawns / cycle | CPU-s / cycle | p95 spawn wall |
| --- | --- | --- | --- | --- |
| `legacy` (four `wl list` subsets + `wl next`) | 5 | 120 | 75.68 | 1227 ms |
| `consolidated` (`wl worklist --json`) | **1** | **24** | **11.89** | **568 ms** |
| pre-F4 baseline (recorded on F10) | 5 | 120 | 159.44 | — |
| F10 target (≤ 0.4× pre-F4) | — | — | ≤ 63.78 | — |

- **0.157×** the same-host legacy CPU cost and **0.075×** the pre-F4 baseline —
  comfortably below the ≤ 0.4× target.
- **5 → 1 spawn per refresh tick** (80 % fewer process startups; 120 → 24 per
  30 s cycle). All measured spawns were cache hits: one write-free read
  populates the shared cache entry that every pane then reuses.
- Single refresh (`bench/herdr-refresh-perf.ts --json --query-set consolidated`,
  1000 items / 20 expanded parents): **1 spawn**, cold **893 ms**, warm
  **445 ms** (legacy: 5 spawns, cold 1188 ms, warm 629 ms), both within the
  2 s target.

Reproduce:

```sh
npm run benchmark:herdr-refresh:json -- --items 20 --cycle-seconds 30 --tick-seconds 5 --query-set consolidated
npm run benchmark:herdr-refresh:json -- --items 20 --cycle-seconds 30 --tick-seconds 5 --query-set legacy
npx tsx bench/herdr-refresh-perf.ts --json --query-set consolidated
```

## Verification

### Automated

- `packages/herdr/src/db-change.test.ts` — `watchDbChanges` contract: trigger,
  debounce/coalescing, per-file filtering (state counter only — SQLite
  `-wal`/`-shm`/db churn never fires), fail-open, teardown, async error,
  throwing callback, real-`fs.watch` write, and a real-`fs.watch` regression
  that SQLite-file churn alone never fires the watch.
- `packages/herdr/src/worklist-watch.test.ts` — integration: a state-counter
  write (the same signal a `wl` write bumps) triggers a refresh within 2 s,
  before the 30 s tick; unrelated writes do not; fail-open + idle no-spawn; the
  typing/visibility gates; trail-coalescing; the watch consumes the signal so
  the next tick is a no-op; and an event-loop-delay responsiveness guard
  (≤ 100 ms p95) across watch-triggered refreshes.
- `packages/herdr/src/hydrator-responsiveness.test.ts` — event-loop delay
  guard for the real watch primitive under a burst of writes.
- `bench/herdr-refresh-perf.ts` (+ `tests/bench/herdr-refresh-perf.test.ts`) —
  repeatable warm/cold latency and `wl` spawn-count benchmark.

### Manual real-agent-write note (F6)

A real `wl comment add` against the shared `.worklog` was performed while a
`watchDbChanges` handle watched the real cache/DB signals. Three consecutive
runs measured the write → watch-callback latency at **116 ms / 924 ms /
1175 ms** — all within the ≤ 2 s target (the spread reflects the 150 ms
debounce plus machine load). The integration test
`worklist-watch.test.ts` asserts the same < 2 s bound deterministically with an
emulated write.

## Large-DB refresh budget harness (F1 — WL-0MVJV2N3A001LE5G)

The parent epic (`WL-0MVJC1EQX001QR9W`, "Herdr extension is unresponsive,
especially on larger worklog databases") has measurable acceptance criteria
at the operator's real scale — a default-view refresh ≤ ~1.5 s p95 wall, ≤ ~200
ms aggregate TUI event-loop blocking, a documented per-spawn RSS budget with
≤ ~300 MB aggregate for a pane, write → reflect ≤ ~2 s p95, one consolidated
`wl worklist` read per refresh and zero spawns when idle. Before this harness
those numbers were only quoted ad hoc in the epic's intake, so a regression
between the fix items (F3–F6) could not be caught.

`packages/herdr/test/perf/large-db-harness.ts` is the verification foundation:

| Piece | What it does |
|---|---|
| `generateLargeWorklog(scale)` | Deterministic fixture: nested parent/child/grandchild subtrees, dependency edges, comments (and the FTS volume they add), realistic status/priority mix — written as a JSONL snapshot and bulk-imported into a throwaway **temp** `.worklog`, then the snapshot is deleted (ephemeral-JSONL pattern). The repository's own worklog is never touched. |
| `runLargeDbHarness({ profile })` | Measures the default-view refresh data path exactly as `doRefresh` drives it (concurrent `fetchNextItems` + `fetchChildrenForItems` + `fetchReviewQueueState` + `fetchActionableCount`, one shared in-process SQLite scope), plus the idle tick and the real `watchDbChanges` write → reflect path. |
| `evaluateLargeDbBudget(report, budget)` | The ratchet/policy: CPU-time gate with documented headroom, spawn/idle invariants, RSS and event-loop headroom, and the parent AC targets once `acTargets.enforced`. |
| `packages/herdr/test/perf/large-db-budget.json` | The checked-in baseline: recorded metrics per profile + CLI target (`src` = tsx, `dist` = built), the parent AC numbers, the tolerance policy and the exact measurement commands. |
| `packages/herdr/src/large-db-refresh-budget.test.ts` | The default-suite ratchet: generator contract, policy unit tests and one measured `default`-profile run. |

### Metrics

- **refresh wall / CPU** — p50/p95 end-to-end refresh (event → data load).
  CPU time is `process.resourceUsage()` for the harness plus the per-spawn CPU
  from the `WL_SPAWN_COUNT_FILE` instrumentation: it is **load independent**,
  so the ratchet is the CPU budget (a shared/loaded host inflates wall time but
  not process CPU; the same approach as `docs/dev/wl-startup-import-budget.md`).
- **aggregate event-loop blocking** — a 1 ms heartbeat probe sums the delays
  attributable to a blocked loop during a refresh (the perceived lag the parent
  AC bounds), plus the longest single stall.
- **spawn accounting** — counted through the fetcher's injectable exec seam
  (`setExecFileAsync`), with the argument vectors recorded so the consolidated
  `wl worklist` read is asserted, not inferred.
- **peak RSS per spawn / aggregate per pane** — per-spawn peaks come from the
  spawn records; the pane aggregate is the refresh's own RSS delta plus its
  largest concurrent `wl` child.
- **write → reflect** — the state counter is bumped exactly as a `wl` write
  does while the REAL `watchDbChanges` handle is armed; detection (debounced
  watch callback) and reflection (watch + refresh data path) are both reported.

### Profiles and commands

`default` is small enough for the default test suite; `full` is the parent's
real scale (~2,600 items / ~100 MB on disk) and is run on demand:

```sh
# Default-suite ratchet (also runs inside the herdr test group)
npx tsx packages/herdr/test/perf/large-db-harness.ts --profile default --json

# Full-scale run: text output, then machine-readable
npm run test:perf:large
npm run test:perf:large -- --json

# Measure the built CLI (what /usr/local/bin/wl runs) instead of tsx
npm run build && npm run test:perf:large -- --json --target dist

# Re-baseline deliberately (rewrites the recorded numbers for that profile/target)
npm run test:perf:large -- --json --target dist --update-budget
```

`--target auto` (the default) prefers a **fresh** `dist/cli.js` and falls back
to `tsx src/cli.ts` when there is no build (or a stale one), so the numbers
never describe code that no longer exists in `src/`. Both targets are recorded
in the budget because the default suite cannot assume a build is present.
Other options: `--samples N`, `--write-samples N`, `--keep` (keep the fixture
for inspection).

### Re-baselining

1. Make the change (F3–F6) and re-run the profile **without**
   `--update-budget`; confirm the policy passes.
2. Re-run with `--update-budget` for each affected profile/target.
3. Commit the regenerated `packages/herdr/test/perf/large-db-budget.json` with
   the change, so the improvement is locked in (a shrinking refresh is an
   improvement and must be recorded the same way).
4. `acTargets.enforced` is now `true` (flipped by F7,
   WL-0MVJV2QHO003K6H3): every full-scale run asserts the parent AC targets.
   AC5 is asserted as the epic states it — the per-spawn peak inside the
   documented budget **or** a capped fan-out (`wlSpawnCap × peak`) inside the
   pane ceiling — and the AC numbers are asserted for the built (`dist`) CLI
   only. The `src` (tsx) target is report-only because tsx module-load cost
   inside every spawn does not describe what `wl` runs. Re-run both profiles
   to confirm after re-baselining.

### Baseline (F1, pre-change)

Recorded on the reference host (`rgardler-AI-Laptop`, node v22.22.1, quiet
host) with 5 measured refreshes and 5 write → reflect samples per profile and
CLI target. The exact figures — dataset shape, measurement command and every
metric — live in `packages/herdr/test/perf/large-db-budget.json` under
`profiles.<name>.baselines.<target>`; these are the numbers to quote in
work-item comments. F7 re-verified and re-recorded the `full` profile after
F3–F6 (see [F7 — end-to-end parent AC verification](#f7--end-to-end-parent-ac-verification-wl-0mvjv2qho003k6h3)).

`full` profile — 2,600 items, nested parent/child/grandchild subtrees, 259
dependency edges, 10 comments per item, **~124 MB on disk** (the operator's
own worklog is ~109 MB, so this is the same order of scale):

| Metric | `dist` (what `wl` runs) | `src` (tsx) |
|---|---|---|
| refresh wall p50 / p95 | 1,798 ms / 2,182 ms | 4,821 ms / 8,086 ms |
| refresh CPU p95 | 1,457 ms | 3,522 ms |
| aggregate event-loop blocking p95 | 917 ms | 1,542 ms |
| spawns per refresh | 1 (`wl worklist`) | 1 (`wl worklist`) |
| peak RSS per spawn | 145 MB | 125 MB |
| pane aggregate RSS | 427 MB | 411 MB |
| write → reflect p95 (watch) | 3,647 ms | 6,422 ms |
| idle tick spawns | 0 | 0 |

`default` profile — 300 items / 1.7 MB, the default-suite ratchet:

| Metric | `dist` | `src` |
|---|---|---|
| refresh wall p50 / p95 | 610 ms / 637 ms | 5,232 ms / 6,780 ms |
| refresh CPU p95 | 726 ms | 3,165 ms |
| event-loop blocking p95 | 70 ms | 1,405 ms |
| peak RSS per spawn | 69 MB | 110 MB |
| pane aggregate RSS | 71 MB | 110 MB |
| write → reflect p95 | 1,414 ms | 7,243 ms |

Against the parent AC targets, the pre-change `full`-scale baseline **missed**
the event-loop budget (917 ms / 1,542 ms vs ≤ ~200 ms), the refresh
wall-time target (2,182 ms / 8,086 ms vs ≤ ~1,500 ms) and the
write → reflect target (3,647 ms / 6,422 ms vs ≤ ~2,000 ms); only the single
consolidated read and the zero-spawn-when-idle guarantees already held. That
was exactly the gap F3–F6 closed. F7 re-verification (below) records the
post-fix full-scale baseline and flips `acTargets.enforced` to `true`.

## Stage profile: which driver costs what (F2 — WL-0MVJV2NNG00771C6)

F1 measures the refresh **aggregate**. F2 needs the opposite: each driver on
its own, so the epic can decide what is fixed in scope (F3–F6) and what becomes
a separate work item. `runStageProfile()` in the same harness measures every
stage of one default-view refresh in isolation at the requested scale:

```sh
# Full-scale stage table (text, then machine-readable)
npm run test:perf:large -- --stages
npm run test:perf:large -- --stages --json

# Built CLI (what /usr/local/bin/wl runs), more samples
npm run build && npm run test:perf:large -- --stages --samples 5 --target dist
```

What it measures, and through which seam:

| Stage | Seam | What it attributes |
|---|---|---|
| `cli-startup` | spawn record (`--version`, kind `version`) | Node + CLI module graph: the floor every spawn pays |
| `worklist-cold` | `wl worklist -n <browse>` after clearing the read cache (kind `read-work`) | The consolidated data-load spawn: DB open + subset queries + browse selection + JSON serialisation |
| `worklist-warm` | the same spawn immediately after (kind `cache-hit`) | What the read cache already saves |
| `json-parse` | `JSON.parse` + `extractItems` of the captured payload | Primary-side payload load (mirrors `parseWorklistBundle`) |
| `sqlite-open` | `createInProcessRefreshScope()` first read | Pragmas + schema + FTS DDL on the TUI event loop |
| `sqlite-full-read` | `db.list({})` in that scope | Materialising the whole item table |
| `subset-queries` | the four default-view subset queries | Query/filter cost once the table is resident |
| `children-inprocess-cold` | `fetchChildrenForItems(expanded, …, scope)` on a fresh scope | The expanded-children read when it wins the refresh race (pays open + table read) |
| `children-inprocess-warm` | the same call on the same scope | What the shared refresh connection saves |
| `children-cli-per-parent` | `wl list --parent <id>` spawn | The per-parent CLI fallback the in-process batch read replaced |
| `actionable-count` | `fetchActionableCount(scope)` | In-process count |
| `hydrator-dep-list` | `wl dep list <id>` spawn (GNU `time` metric; the CLI does not record this non-cacheable read) | One hydrator spawn per pending-claim candidate per tick |
| `render` | `WorkItemListState.getDisplayRows()` + `formatItemLine` | Row build + line formatting for the visible window |

Notes on reading the numbers:

- **Rank by CPU, not wall.** A loaded shared host inflates wall time (the F1
  ratchet uses CPU for the same reason); GNU `time` supplies the child's own
  CPU and peak RSS for spawns the CLI's `WL_SPAWN_COUNT_FILE` instrumentation
  does not cover. Where GNU `time` is unavailable, spawn-record CPU/RSS is used
  as the fallback (recorded as `null` when neither exists).
- **The stages are measured serially**, while the live refresh runs them
  concurrently (`Promise.all` in `doRefresh`). The `refreshAttribution`
  baseline is therefore an upper bound used to rank the drivers.
- **`payload build` is derived** (`worklist-cold` minus `cli-startup`) so the
  fixed Node start-up floor is not attributed to the payload.
- **RSS breakdown** compares the peak RSS of `wl --version` (module graph),
  `wl show <id>` (open + one item), the cold `wl worklist` spawn (full data
  load) and the in-process heap deltas for table materialisation, payload
  stringification and parsing.

The full-scale F2 results (cost table, `wl sync` breakdown, RSS decomposition
and the fix/defer decision per driver) are recorded on the work item
`WL-0MVJV2NNG00771C6`; the harness is the re-runnable evidence behind them.

## Bounded `wl` spawn concurrency (F5 — WL-0MVJV2PC2008PY64)

### The memory problem

Every surviving `wl` spawn on a large store peaks at ~120–145 MB RSS (F2
measured `wl worklist` at 164.4 MB cold and the F1 full-scale baseline records
144.9 MB per spawn on the built CLI). A default-view refresh uses exactly one
consolidated spawn, so a *quiet* pane is fine — but the pane's fan-out paths
can each multiply that peak: the fallback per-subset reads (an older `wl`
without the `worklist` command), the per-edge `wl show`/`wl dep list`
metadata probes (F4 reduced, did not eliminate them), and the per-parent
`wl list --parent` fallback (F4's in-process batch read replaces it, but any
in-process failure degrades to it). Ten concurrent reads at 145 MB each is a
1.4 GB aggregate — far over the parent AC 5 ≤ ~300 MB per-pane ceiling.

### The budget (documented, enforced, asserted)

| Budget item | Value | Enforcement |
|---|---|---|
| Per-spawn peak RSS | measured per profile/target in `large-db-budget.json` (`peakRssPerSpawnMb`; full-scale: ≤ ~130–145 MB baseline) | F1 refresh ratchet (`large-db-refresh-budget.test.ts`) |
| **Concurrent `wl` read spawns per pane** | **`DEFAULT_WL_SPAWN_CAP = 1`** (`fetcher.ts` semaphore, FIFO, microtask handover) | **fetcher production code** + spawn-burst ratchet (`large-db-spawn-cap.test.ts`) |
| **Aggregate spawn-RSS bound** | **cap × worst-case cold per-spawn peak ≤ ~145–176 MB ≤ 300 MB ceiling** | spawn-burst policy (`evaluateSpawnCapReport`) |
| Event-loop blocking with a spawn-heavy burst | ≤ ~200 ms (parent AC 1) | spawn-burst measured event-loop probe |

The cap was **2** in F5 (`WL-0MVJV2PC2008PY64`); **F8
(`WL-0MVKVJYV6008SL9G`) tightened it to 1** after F7's end-to-end verification
measured the *cold* `wl show` peak on the **built** CLI at full scale at
144.6–175.3 MB/spawn: `2 × peak` is 289–351 MB, which cannot guarantee the
≤ ~300 MB ceiling (the 175 MB case breached it). One concurrent read bounds
the worst case at a single spawn's peak (≤ ~176 MB) with margin, and the
measured burst event-loop blocking dropped from 183–215 ms (cap 2) to
140 ms (cap 1). The trade-off is deliberate: the rare fallback fan-out paths
(older CLI without `worklist`, degraded in-process reads) serialise and so
pay wall time, while the consolidated single-read default view and the
in-process expand/hydrator reads (F4) are unaffected.

The cap applies to READ spawns (`list`, `next`, `worklist`, `show`, `search`,
`status`, `dep`). Writes (claims, `wl comment add`, chord commands, `wl sync`)
are deliberately uncapped: they are user-driven, rare and already serialised
by the CLI's own mutation lock, and `wl sync` keeps its F3 isolation path —
queueing them behind reads would add latency without bounding a real memory
fan-out. Queued reads are released on a microtask (never under the TUI event
loop) in strict FIFO order, so a spawn-heavy refresh degrades to a bounded
pipeline instead of an unbounded process fan-out; input handling is never
blocked by the queue.

### Harness evidence (`runSpawnConcurrencyScenario` / `--spawn-burst N`)

A burst of distinct cold single-item reads (`wl show <id>`, which always
spawns and is cacheable so each spawn records its own peak RSS) is driven
through the real fetcher exec seam in two phases: capped (the production cap)
and uncapped (cap widened to the burst size — the fan-out the budget bounds).

```sh
# Default profile (default suite):
npx vitest run packages/herdr/src/large-db-spawn-cap.test.ts
# Current default-profile numbers (300 items / 1.7 MB, tsx target, burst 6):
npx tsx packages/herdr/test/perf/large-db-harness.ts --spawn-burst 6
# Full scale (2,600 items / ~100 MB), on demand:
npm run test:perf:large -- --spawn-burst 8
```

Measured (this worktree, `rgardler-AI-Laptop`). F5's original cap-2 numbers
(tsx target) are kept for history; F8's cap-1 numbers include the built (`dist`)
CLI at the parent's full scale, which is the case that decides the ceiling.

| Profile | Phase | Peak concurrent `wl` | Aggregate RSS bound (cap × peak) | Event-loop blocked | Wall |
|---|---|---|---|---|---|
| default (300 items, tsx, F5) | capped (cap 2) | **2** | **226.6 MB** | 49.9 ms | 3.0 s |
| default (300 items, tsx, F5) | uncapped (cap 6) | 6 | 660.6 MB | 99.6 ms | 2.0 s |
| full (2,600 items, tsx, F5) | capped (cap 2) | **2** | **220.2 MB** | **126.5 ms** | 3.9 s |
| full (2,600 items, tsx, F5) | uncapped (cap 8) | 8 | 870.4 MB | **254.3 ms (breaches ≤ 200 ms)** | 2.5 s |
| full (2,600 items, **dist**, F8) | capped (cap 1) | **1** | **146.9 MB** | **140.1 ms** | 2.5 s |
| full (2,600 items, **dist**, F8) | uncapped (cap 8) | 8 | 1175.2 MB | **216.2 ms (breaches ≤ 200 ms)** | 0.9 s |
| full (2,600 items, **dist**, F7 AC run, cap 2) | capped (cap 2) | 2 | 347.8 MB (breaches ≤ 300 MB) | 185.3 ms | 1.6 s |

Before/after: the SAME burst that would reach 6–8 concurrent processes (660
→ 1175 MB aggregate) is held by the documented cap to ONE concurrent process
and a ~147 MB aggregate bound — comfortably inside parent AC 5's ≤ ~300 MB
ceiling and independent of the cold per-spawn peak's run-to-run variation
(144.6–175.3 MB). The full-scale uncapped phase also breaches the parent AC 1
≤ ~200 ms input-lag budget (216 ms — the loop pays for eight simultaneous
100 MB children), while the capped phase stays at 140 ms: bound the
concurrency and you bound the input lag too.

### AC coverage

- AC1 (per-spawn or aggregate budget confirmed): the aggregate budget is the
  documented `cap × per-spawn peak` and is asserted per run; per-spawn peaks
  are recorded per profile/target in `large-db-budget.json` (the F1 ratchet).
- AC2 (documented spawn cap whose aggregate RSS is asserted by an automated
  test): `DEFAULT_WL_SPAWN_CAP = 1` (F8; was 2 in F5), enforced by the fetcher
  semaphore and asserted by `large-db-spawn-cap.test.ts` (policy + measured).
- AC3 (budget + enforcement documented): this section + `large-db-budget.json`.
- AC4 (no regression): the default-view refresh still reads through ONE
  consolidated `wl worklist` spawn (the F1 ratchet); the cap only engages
  when more than one read races; zero-spawn-when-idle is untouched (the idle
  tick never calls the fetch path).
- AC5 (spawns off the event loop; queued reads never block input): the queue
  is promise-based with microtask handover; the spawn-burst measured phase
  asserts total event-loop blocking ≤ 200 ms. F3's sync isolation is
  unaffected (`wl sync` is not in the capped command set).
- AC6 (no new heavy dependency): the cap is a promise FIFO — no library,
  no new import in the Pane graph, and reads keep preferring the in-process
  SQLite path (F6) over new spawns.

## Auto-sync isolation: the pane never stalls on `wl sync` (F3 — WL-0MVJV2O7H003HY9N)

The epic's Auto-sync acceptance criteria: while a long ~36 s `wl sync` is in
flight the pane stays responsive — a concurrent default-view refresh completes
without waiting, the sync spawn never blocks the TUI event loop, and the only
"hanging" indication is a brief non-blocking status notice. The `wl sync`
perf fix itself is a separate item (`WL-0MVK3WRY9009KV6P`); this item is
pane-side isolation only.

### What changed

- **In-flight instrumentation + status model** (`packages/herdr/src/auto-sync.ts`):
  `runSync` now publishes a status snapshot the moment the child spawns
  (`getSyncStatus()` → `syncing` with the child PID, an epoch `startedAtMs` and a
  **monotonic** `startedAtMonotonicMs` via `performance.now()`) and clears it
  with a recorded outcome (`synced`/`failed`, duration) when the child settles.
  A tiny subscription primitive (`onSyncStatusChange`) and a pure non-blocking
  notice renderer (`formatSyncNotice`, `⟳ syncing… Ns`) let the pane observe the
  sync without polling, and let the harness prove a refresh never waited on it.
  The spawn itself goes through an injectable seam (`_setSyncSpawnForTests`)
  still defaulting to `child_process.spawn`, so the real path is unchanged.
- **Non-blocking status notice** (`packages/herdr/src/worklist.ts`): while a
  sync is in flight the header appends the notice (`⟳ syncing… 7s`), refreshed
  on status transitions and by a 1 s unref'd ticker, cleared the moment the
  sync settles, torn down on pane exit. It is a pure string read — it never
  awaits, locks or touches the DB, and it is clamped by the existing header
  truncation guard, so input handling is untouched (the notice is the only
  "hanging" indication, exactly as the AC allows).
- **Sync-in-flight + lock-contention scenarios** (`large-db-harness.ts`):
  - `runSyncInFlightScenario()` — a hooked long sync started through the REAL
    `runSync` (so the instrumentation and notice are the production ones),
    with concurrent refreshes measured against a no-sync baseline from the
    same host; reports the spawn's event-loop cost, the pane notice, and the
    sync-remaining at each refresh end (`noWaitGap`).
  - `runSyncLockContentionScenario()` — a sync-shaped writer holding both the
    per-worklog sync **file lock** (`worklog-data.jsonl.lock`, the lock `wl
    sync --if-idle` takes) and a real SQLite **write transaction** on the
    worklog DB; concurrent refreshes must complete without waiting (the
    refresh never shares the sync's handle and never takes its lock).
  Both are exposed as CLI flags for the on-demand full-scale run:

  ```sh
  npm run test:perf:large -- --sync-in-flight --samples 5     # text
  npm run test:perf:large -- --sync-in-flight --json
  npm run test:perf:large -- --lock-contention
  npm run test:perf:large -- --sync-in-flight --sync-duration 36000 --json --target dist
  ```

### Automated (default suite)

- `auto-sync.test.ts` — status model unit tests: PID + monotonic start,
  elapsed, `synced`/`failed` transitions, subscriber notifications, skip paths
  never claim a sync is running, spawn-throw clears the state, `formatSyncNotice`
  is empty when idle and shows an elapsed counter while in flight.
- `worklist-sync-notice.test.ts` — the TUI renders the notice while a sync is
  in flight (and still renders the list), a keystroke (`q`) quits while the
  notice is showing (input is never blocked), the 1 s ticker moves the elapsed
  counter, settling clears the notice, auto-sync disabled shows nothing, and a
  sync already in flight when the pane starts is adopted.
- `auto-sync-isolation.test.ts` — `runSyncInFlightScenario` at the default
  profile with the operator-observed ~36 s figure: spawn blocks the event loop
  ≤ 200 ms (measured ~0), the notice shows "syncing…" for every with-sync
  refresh, every refresh ends with ≥ half the sync duration still remaining
  (no wait gap), refresh wall/event-loop stay inside the documented F1
  headroom of their own no-sync baseline, the refresh path still issues
  exactly one consolidated `wl worklist` spawn (the sync adds none), and the
  hook settles to `synced`. `runSyncLockContentionScenario` asserts the same
  relative budget while the file lock and a real write transaction are held.

Like F1, the absolute AC numbers (refresh ≤ 1.5 s wall p95, ≤ 200 ms event-loop
blocking at full scale) stay gated behind `acTargets.enforced` (flipped once F7
records a compliant full-scale baseline); F3's tests prove **non-interference**
(the no-wait-gap invariant, absolute) plus host-load-tolerant relative
headroom, which is the actual F3 deliverable.

### `wl sync` persist phases

`wl sync` is not on the Herdr refresh path, but F2 measured it because the
operator reports it taking ~36 s. `packages/herdr/test/perf/wl-sync-phase-probe.ts`
replays `performSync`'s persist pipeline on a **disposable copy** of a store and
times each phase:

```sh
npx tsx packages/herdr/test/perf/wl-sync-phase-probe.ts --worklog-dir <dir>/.worklog --json
```

On the F1 full-scale fixture (2,600 items / 26,000 comments / 123.7 MB DB) the
persist phases take ~97 % of the pipeline, and 78–90 % of that CPU is
`upsertFtsEntry` — every item's FTS row is rebuilt even when nothing changed,
so a no-change sync pays the whole cost. The fix is a separate work item
(`WL-0MVK3WRY9009KV6P`, blocked by F2) per the epic's scope guardrail; the
probe is the before/after measurement tool for it.

## F7 — end-to-end parent AC verification (WL-0MVJV2QHO003K6H3)

F1–F6 each verify one slice. F7 is the end-to-end evidence run that every
parent acceptance criterion holds **together**, after all the fixes, at the
operator's real scale. It adds `--ac-report` to the F1 harness: the existing
F1 refresh budget, F3 sync-in-flight, F4 in-process expand and F5 spawn-burst
scenarios run in one pass and are aggregated into one JSON document
(`runAcReport()` → `buildAcReport()`) plus a human summary. AC1–AC6 are each
reported with the measured number, its target and the scenario that produced
it; the budget ratchet and the raw scenario reports are attached so every
quoted number is reproducible.

```sh
# The evidence run (built CLI, parent's full scale ~2,600 items / 123.7 MB)
npm run build && npm run test:perf:large -- --ac-report --json --target dist
# Human summary instead of JSON
npm run build && npm run test:perf:large -- --ac-report --target dist
```

`--ac-report` also accepts `--samples N`, `--write-samples N`,
`--sync-duration MS`, `--spawn-burst N` and `--profile default|full`; the
default-suite `large-db-ac-report.test.ts` pins the AC mapping (pure) and a
small-scale end-to-end run of the same wiring.

### Verified numbers (built CLI, full scale)

Measured on `rgardler-AI-Laptop` (node v22.22.1, 16 CPUs, 1-min load 2.7 —
~0.2/core), `dist` target, 5 refresh / 5 write → reflect / 5 sync-in-flight
samples, 2,600-item fixture (123.7 MB):

| AC | Criterion (parent) | Measured | Target | Verdict |
|---|---|---|---|---|
| AC1 | refresh lag in aggregate | 196 ms event-loop blocked p95; 144 ms during the capped spawn burst | ≤ ~200 ms | met |
| AC2 | refresh cost + single read | 478 ms refresh p95 wall; 1 consolidated `wl worklist` read; 0 expand/hydrator spawns with CLI parity | ≤ ~1.5 s p95 | met |
| AC3 | auto-sync cannot stall the pane | no wait gap (sync had ~34 s left at every refresh end); 0 ms sync-spawn loop cost; 82 ms refresh loop p95 with sync; non-blocking `⟳ syncing…` notice | no lock wait / no stall | met |
| AC4 | write → reflect | 780 ms p95 (watch detection 160 ms) | ≤ ~2 s p95 | met |
| AC5 | memory budget | 145 MB refresh per-spawn peak; capped fan-out 1 concurrent read, aggregate bound 175 MB (`1 × 175 MB`) | per-spawn budget OR cap × peak ≤ ~300 MB | met via the capped route |
| AC6 | no regressions | 1 spawn/refresh, 0 idle spawns, 1 in-process open (open p95 4 ms), event-driven watch fires | invariants | met (suites below) |

All six parent ACs are met at full scale and the budget ratchet passes with
`acTargets.enforced: true`. The full Herdr plugin + TUI suites are the other
half of AC6 and ran green at the pushed commit (the dev-push gate's full-suite
run, cached for the audit).

### Notes and limits

- **Host-load sensitivity.** AC1/AC2/AC4 are user-perceived (wall-clock) numbers,
  so they are only meaningful on a host that is not CPU-starved. A run during
  heavy external contention (1-min load ~10–30 on 16 CPUs) measured 271 ms
  loop blocking and 2.2 s write → reflect with no code change; the report
  records the host + load average so a reading can be judged. The regression
  ratchet remains CPU-time based (load independent), as documented above.
- **AC5 route choice.** The per-spawn peak (145–176 MB cold, measured on
  `dist`) is not below the pre-change baseline, so AC5 is satisfied by the
  bounded fan-out route: F8 (`WL-0MVKVJYV6008SL9G`) tightened the read-spawn
  cap from 2 to 1 after F7 showed `2 × cold peak` could reach ~351 MB. The
  one-open, zero-spawn-when-idle and single-consolidated-read guarantees are
  unchanged.
- **Per-expand child fetches** are measured in-process (F4) and must be zero
  spawns with exact CLI row parity; the AC report asserts both.
- The raw JSON report is not checked in (it is host-dependent evidence); the
  stable, checked-in artefact is `large-db-budget.json`, which F7 re-baselined
  (full `dist` + `src`) and marked enforced.

## References

- Sibling Pi-TUI precedents: `WL-0MKXN75CZ0QNBUJJ`, `WL-0MQ3LYSPS006V60H`.
- Read cache: `src/read-cache.ts` / `src/read-cache-cli.ts`
  (`WL-0MSAZQEQB008O7H3`).
- Fetch memo: `WL-0MSGAEPOJ002824S`. In-flight refresh guard:
  `WL-0MSBVYBMD004007C`. Trail-coalescing: `WL-0MTIB7JAN004MQ8N`.
- Responsiveness precedent: `WL-0MUY0RDBQ001H74P`, `WL-0MUY1CZES0099A04`.
