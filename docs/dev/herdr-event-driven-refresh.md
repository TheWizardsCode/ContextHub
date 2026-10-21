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

## References

- Sibling Pi-TUI precedents: `WL-0MKXN75CZ0QNBUJJ`, `WL-0MQ3LYSPS006V60H`.
- Read cache: `src/read-cache.ts` / `src/read-cache-cli.ts`
  (`WL-0MSAZQEQB008O7H3`).
- Fetch memo: `WL-0MSGAEPOJ002824S`. In-flight refresh guard:
  `WL-0MSBVYBMD004007C`. Trail-coalescing: `WL-0MTIB7JAN004MQ8N`.
- Responsiveness precedent: `WL-0MUY0RDBQ001H74P`, `WL-0MUY1CZES0099A04`.
