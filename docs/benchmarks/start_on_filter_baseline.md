# `startOn` pre-filter baseline — `list` / `search` / `next`

## Purpose

The `startOn` epic (WL-0MWM0FDZK007BAD0) makes every CLI and Herdr search
surface filter out work items whose earliest start instant is still in the
future. Parent AC9 requires `list` / `search` / `next` to stay within the
existing benchmarks on the current store size and requires the figures to be
recorded.

Slice 1 (WL-0MWMGEL5R003IH71) recorded the **before** figures on unchanged
code, so slice 4's default filter and slice 2's index can be compared against a
measured baseline instead of a guess, and slice 7 (WL-0MWMGEXX3003QJRV) can
publish an honest before/after pair. **Slice 7's after run is recorded below**
together with the `EXPLAIN QUERY PLAN` evidence and a verdict against
`packages/herdr/test/perf/large-db-budget.json`.

This baseline was captured **before any `startOn` code landed**: no schema
column, no index, no filter, no predicate in the measured paths. The predicate
itself (`isNotStarted`, shipped in the same slice) is measured only as an
additional, clearly-labelled row — the shipped `list` / `search` / `next` rows
are the unmodified code paths.

## How to run

```bash
npm run benchmark:start-on-filter          # full profile, text report
npm run benchmark:start-on-filter:json     # machine-readable report
npx tsx bench/start-on-filter-baseline.ts --profile default --runs 9 --json
```

Options:

- `--profile default|full` — fixture size (default `full`: the epic's real
  scale).
- `--runs N` — measured samples per surface (default 7, minimum 3).
- `--now <ISO-8601>` — the instant the `isNotStarted` preview compares
  against (default: the instant the run starts; recorded in the report).
- `--json` — machine-readable report on stdout.
- `--keep` — keep the generated fixture directory for inspection.

The script is a recorder, not a gate: it exits non-zero only on a malformed
argument or a fixture/bench failure. Regression gating stays where it already
lives (the herdr large-DB budget ratchet and the dev-push suite).

The report also carries `queryPlans`: `EXPLAIN QUERY PLAN` output captured from
the live connection for the statements each surface actually prepares (a
one-off `prepare` wrapper, never inside a timed sample), plus a representative
SQL-side `startOn` predicate (`START_ON_INDEX_PROBE_SQL`). It is emitted in both
the text and `--json` reports so the index verdict below is reproducible, not
hand-copied.

## Method

### Store (the existing large-db harness fixture)

The fixture is `generateLargeWorklog(LARGE_DB_PROFILES.full)` from
`packages/herdr/test/perf/large-db-harness.ts` — the same generator the Herdr
refresh budget harness uses (WL-0MVJV2N3A001LE5G):

| Property | Value |
|---|---|
| Work items | 2,600 (nested parent → child → grandchild subtrees) |
| Dependency edges | 259 |
| Comments | 10 per item (26,000 — the volume that dominates a real worklog) |
| SQLite database | 123.7 MB |
| `.worklog` on disk | 123.7 MB |
| Fixture generation | 3.8–5.3 s (deterministic seed `0x5eed1a2b`) |

The fixture is built in a throwaway temp `.worklog` (the repository's own
worklog is never opened or touched) and removed after the run unless `--keep`
is passed.

### Calls measured

Measured **in-process** at the exact entry point each command uses, so a sample
is the query cost rather than process startup (startup has its own budget,
`tests/cli/startup-import-budget.test.ts`):

| Surface | Call | CLI command |
|---|---|---|
| `list` | `db.list({})` | `wl list` |
| `search` | `db.search('refresh', { limit: 20 })` | `wl search refresh` |
| `next` | `selectBrowseFeed(db, { count: 30 })` | `wl next -n 30` (shared browse feed) |
| `filter pass` | an already-materialised 2,600-item array filtered through `isNotStarted(item, now)` | *not shipped* — the pure cost slice 4 adds |
| `list + filter` | `db.list({}).filter(item => !isNotStarted(item, now))` | *not shipped* — the composed shape slice 4 adds |

Two method choices matter for honesty:

1. **The store row cache is disabled** (`WL_CACHE_ENABLED=0`, read by the store
   at construction). A fresh `wl` process starts with an empty cache, so a warm
   in-process cache hit (0.01 ms for `list`, measured while preparing this
   baseline) would describe an artefact of staying in one process rather than
   an invocation. Every sample is a real cold read.
2. **The FTS index is rebuilt before measuring.** The fixture's bulk JSONL
   import bypasses the FTS triggers, so `worklog_fts` is empty after generation
   (`select count(*) from worklog_fts` → 0). Measuring `search` against an empty
   index would report the cost of finding nothing, so the bench rebuilds it
   exactly as `wl search --rebuild-index` does (2,600 documents; ~2.0 s) and
   records the rebuild cost separately — it is fixture preparation, never part
   of a search sample.

### Timing protocol

One discarded warmup per surface (JIT, statement cache, page cache), then
`--runs` measured samples (default 7). Median and nearest-rank p95 are reported
alongside every raw sample, with the row count each surface returned so a row
can never be read as "the latency of returning nothing".

Wall-clock medians on this shared 16-vCPU dev host vary by roughly ±20 % with
host load (load average 14 during these runs), which is why the filter's
incremental cost is taken from the `filter pass` row (a pure in-memory
computation, load-insensitive at this scale) rather than from the difference
between two dominated-by-I/O reads.

## Results — before (full profile, 2,600 items / 123.7 MB)

Captured 2026-11-18T21:19:01Z, 9 samples per surface, commit `39b10762d`
(the `dev` tip the slice branched from).

| Surface | Median | p95 | Min | Max | Rows returned |
|---|---|---|---|---|---|
| `list` | 65.47 ms | 83.81 ms | 54.09 ms | 83.81 ms | 2,600 |
| `search` | 169.50 ms | 172.45 ms | 165.55 ms | 172.45 ms | 20 |
| `next` | 2,234.97 ms | 2,407.35 ms | 1,964.65 ms | 2,407.35 ms | 30 |
| `filter pass` (new predicate, not shipped) | 1.81 ms | 22.75 ms | 1.73 ms | 22.75 ms | 2,600 |
| `list + filter` (new shape, not shipped) | 64.35 ms | 73.48 ms | 60.27 ms | 73.48 ms | 2,600 |

A second full-profile run (7 samples, 2026-11-18T21:18:11Z) reproduced the same
picture: `list` 71.20 ms, `search` 205.95 ms, `next` 2,176.52 ms, `filter pass`
1.61 ms, `list + filter` 58.53 ms.

Environment:

- Linux 7.0.0-38-generic, 16 vCPU, 30,223 MB RAM, load average 14.23 / 11.22 at
  capture time (shared host — several sibling agents running).
- Node.js v22.22.1, `better-sqlite3` via the repository's own install.
- Store row cache disabled (`WL_CACHE_ENABLED=0`), FTS index rebuilt before
  measuring (2,012 ms, 2,600 documents).

### Interpretation for AC9 (written before the filter shipped)

- **The filter is cheap relative to the reads it filters.** `isNotStarted` over
  the whole 2,600-item store costs **1.6–1.8 ms median** (≈ 0.7 µs/item, one
  `Date.parse` per item plus a comparison). At the epic's store size that is
  ~2–3 % of a cold `list` read and ~0.08 % of a `next` selection, so a
  memory-side predicate cannot by itself breach the existing benchmarks —
  whatever regression slice 4 shows, if any, will come from *where* the filter
  sits (per-row SQL vs. one in-memory pass) rather than from the predicate.
- **`list` and `search` read every row today.** Both already materialise the
  full item set per invocation; the filter adds a pass over data that is
  already in memory.
- **`next` dominates every other surface** (2.2 s median at 2,600 items): the
  dependency-aware browse feed is ~30× the cost of a raw list read, which is why
  slice 4 must filter *before* selection (a filter after selection would be
  invisible in the median but wrong at the boundary) and why slice 2's index
  choice should not add a second per-row query to this path.
- **What "stays within the existing benchmarks" means here:** slice 7 compares
  its post-filter figures against the rows above on the same host/profile. A
  `next` median materially above ~2.4 s p95, a `list` median materially above
  ~84 ms p95, or a `search` median materially above ~172 ms p95 would be the
  regression signal — the recorded p95s, not the medians, are the comparison
  points because host load moves medians by ~20 %.

## Before — default profile (300 items / 1.7 MB)

The `default` profile is the fixture size the default test suite uses; it is
recorded for a quick sanity check of the same trend at small scale
(2026-11-18T21:19:08Z, 3 samples):

| Surface | Median | p95 | Rows returned |
|---|---|---|---|
| `list` | 2.17 ms | 2.60 ms | 300 |
| `search` | 8.09 ms | 8.11 ms | 20 |
| `next` | 415.81 ms | 431.05 ms | 30 |
| `filter pass` | 0.18 ms | 0.21 ms | 300 |
| `list + filter` | 2.26 ms | 2.44 ms | 300 |

## Results — after (default filter and index shipped)

Captured on the same host and fixture, **after** the whole `startOn` epic
landed. Nothing in the measurement method changed between the two runs (same
script, same cache/FTS preparation, same warmup-then-`--runs` protocol), so the
before/after rows are directly comparable.

- Before: `39b10762d`, 2026-11-18T21:19:01Z, load average 14.23 (shared,
  contended host).
- After: `6088d6655`, 2026-11-19T11:47:33Z, load average 1.90 (quiet host).

The host was noticeably quieter for the after run. That flatters every absolute
number (including the before run's own second sample, which moved 10–20 %), so
the comparison below is deliberately conservative: it reads the **after p95 as
an upper bound against the before p95**, not the after median against the before
median. The floor for the change's cost is the `filter pass` row (a pure
in-memory predicate, not bound by I/O) and the difference between `list` and
`list + filter`.

### After — full profile (2,600 items / 123.7 MB, 9 samples)

Store: 2,600 items, 259 dependency edges, 123.7 MB SQLite database, 123.7 MB on
disk, fixture generation 2,384 ms, FTS rebuild 2,600 documents in 1,105 ms.
Same size as the before run (the generator is deterministic).

| Surface | Median | p95 | Min | Max | Rows returned |
|---|---|---|---|---|---|
| `list` | 36.27 ms | 36.99 ms | 32.68 ms | 36.99 ms | 2,600 |
| `search` | 106.75 ms | 112.24 ms | 105.32 ms | 112.24 ms | 20 |
| `next` (includes the shipped default filter) | 1,238.76 ms | 1,266.17 ms | 1,211.48 ms | 1,266.17 ms | 30 |
| `filter pass` | 0.67 ms | 0.80 ms | 0.65 ms | 0.80 ms | 2,600 |
| `list + filter` | 35.17 ms | 39.16 ms | 34.09 ms | 39.16 ms | 2,600 |

### Before → after, full profile

| Surface | Before p95 | After p95 | Δ | Baseline comparison point |
|---|---|---|---|---|
| `list` (raw read) | 83.81 ms | 36.99 ms | −55.9 % | 84 ms p95 |
| `search` (raw FTS read) | 172.45 ms | 112.24 ms | −34.9 % | 172 ms p95 |
| `next` (filter applied inside the selection) | 2,407.35 ms | 1,266.17 ms | −47.4 % | 2.4 s p95 |
| `filter pass` (predicate only) | 22.75 ms p95 / 1.81 ms median | 0.80 ms p95 / 0.67 ms median | — | n/a (new predicate) |
| `list + filter` (shipped list shape) | 73.48 ms p95 | 39.16 ms p95 | −46.7 % | 84 ms p95 |

**Verdict: within the existing benchmarks.** Every after p95 is *below* the
before p95 it is compared against, on a store of identical size, with the
shipped filter applied. The filter's own incremental cost is **0.65–0.80 ms over
2,600 items** (≈ 0.2–0.3 µs/item) — ~2 % of a cold `list` and ~0.05 % of a
`next` selection — exactly the order slice 1 predicted (1.6–1.8 ms median then,
re-measured at the same order under lighter load). `list + filter` tracks `list`
within run-to-run noise, so the default exclusion adds no measurable read cost.

### After — default profile (300 items / 1.7 MB, 9 samples)

Captured 2026-11-19T11:50:10Z, load average 2.57.

| Surface | Median | p95 | Rows returned |
|---|---|---|---|
| `list` | 1.82 ms | 2.77 ms | 300 |
| `search` | 5.93 ms | 6.51 ms | 20 |
| `next` | 218.93 ms | 232.91 ms | 30 |
| `filter pass` | 0.09 ms | 0.10 ms | 300 |
| `list + filter` | 1.60 ms | 2.55 ms | 300 |

The small fixture is where the before p95s were measured from only 3 samples:
`list` 2.77 ms after vs 2.60 ms before p95 (+0.17 ms, well inside the ±20 %
host noise documented in the method), `list + filter` 2.55 ms vs 2.44 ms, and
`next` 232.91 ms vs 431.05 ms. No default-profile regression signal.

### `EXPLAIN QUERY PLAN` — the statements the surfaces actually prepare

Captured from the live connection during the after run (verbatim detail lines;
the SQL is whitespace-normalised):

```text
list, next
  SCAN workitems
  sql: SELECT * FROM workitems

search
  SCAN worklog_fts VIRTUAL TABLE INDEX 0:M7
  SEARCH workitems USING INDEX sqlite_autoindex_workitems_1 (id=?)
  USE TEMP B-TREE FOR ORDER BY
  sql: SELECT worklog_fts.itemId, bm25(worklog_fts, 10.0, 5.0, 2.0, 3.0) AS rank,
       snippet(worklog_fts, 0, '<<', '>>', '...', 32) AS title_snippet,
       snippet(worklog_fts, 1, '<<', '>>', '...', 32) AS desc_snippet,
       snippet(worklog_fts, 2, '<<', '>>', '...', 32) AS comment_snippet,
       snippet(worklog_fts, 3, '<<', '>>', '...', 32) AS tags_snippet,
       worklog_fts.status, worklog_fts.parentId
  FROM worklog_fts
  JOIN workitems ON worklog_fts.itemId = workitems.id
  WHERE worklog_fts MATCH ? AND workitems.status != 'deleted'
  ORDER BY rank LIMIT ?

index probe (not a shipped call — representative SQL-side `startOn` predicate)
  SEARCH workitems USING INDEX idx_workitems_startOn (startOn>?)
  sql: SELECT id FROM workitems WHERE startOn > ? ORDER BY startOn
```

### The index verdict (honest form of AC9)

The migration creates `idx_workitems_startOn`, and the probe row proves it is
usable: any SQL-side `startOn` predicate is planned as
`SEARCH workitems USING INDEX idx_workitems_startOn (startOn>?)` instead of a
table scan.

The shipped default filter deliberately does **not** put `startOn` into SQL.
The slice-4 design applies one `isNotStarted` predicate to rows the reads have
already materialised:

- `list` and `next` read `SELECT * FROM workitems` (`SCAN workitems`),
- `search` reads the FTS index and joins by rowid,
- `filter pass` / `list + filter` measure that memory-side predicate.

So AC9 is satisfied through its **"or an equivalent query plan"** branch: the
existing plans are untouched (no new per-row query on the `next` path, which was
the regression risk slice 1 called out), and the recorded figures show the
surfaces stay comfortably within the benchmarks. The index is not what keeps
these three reads fast — it is the seed for any future SQL-side scheduling read
and costs only the write-side maintenance of one column index.

## Verdict against `packages/herdr/test/perf/large-db-budget.json`

The budget file owns the Herdr large-DB refresh ratchet (full profile,
`dist` target). Re-ran it on the after tree
(`npx tsx packages/herdr/test/perf/large-db-harness.ts --profile full --json`,
2026-11-19T11:48:13Z, 2,600 items / 123.7 MB, 5 samples) — the harness's own
`evaluation.ok` is `true` with an empty `violations` list:

| Metric | Measured | Recorded baseline | Limit (headroom) | AC target | Result |
|---|---|---|---|---|---|
| `refreshP95WallMs` | 240.5 ms | 714 ms | 2,642 ms | 1,500 ms | pass |
| `refreshP95CpuMs` (load-independent gate) | 309.1 ms | 885.4 ms | 1,771 ms | — | pass |
| `eventLoopBlockingP95Ms` | 68.8 ms | 172.7 ms | 618 ms | 200 ms | pass |
| `peakRssPerSpawnMb` | 142.0 | 144.7 | 180.9 | either route (see note) | pass |
| `paneAggregateRssMb` | 417.1 | 426.5 | 533.1 | — | pass |
| `writeToReflectP95Ms` | 901.4 ms | 1,404.9 ms | 4,715 ms | 2,000 ms | pass |
| `spawnsPerRefresh` | 1 | 1 | 1 | 1 | pass |
| `idleSpawns` | 0 | 0 | 0 | 0 | pass |

`spawnMemoryBudget` passes via the capped fan-out route (1 × 142 MB = 142 MB
against the 300 MB pane ceiling), exactly as the budget file's `acTargets.note`
requires, because the per-spawn peak (142 MB) is still above the 130 MB
per-spawn target on this host.

## Related

- Epic: WL-0MWM0FDZK007BAD0 — add `startOn` to work items; every search surface
  filters not-yet-started items by default.
- Slice 1: WL-0MWMGEL5R003IH71 — `isNotStarted` predicate, frozen-clock harness
  and this baseline.
- Fixture/harness: `packages/herdr/test/perf/large-db-harness.ts`,
  `packages/herdr/test/perf/large-db-budget.json`.
- Predicate: `packages/shared/src/predicates.ts` (`isNotStarted`), exported via
  the `@worklog/shared/predicates` subpath.
- Frozen clock: `tests/helpers/frozen-clock.ts`.
