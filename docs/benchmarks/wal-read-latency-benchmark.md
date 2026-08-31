# WAL read-latency benchmark

## Purpose

Measure the impact of a large SQLite WAL (`worklog.db-wal`) on read latency,
comparing identical read queries against the same database with a large WAL
present vs. after a `PRAGMA wal_checkpoint(TRUNCATE)` merges it into the main
DB file.

Motivation (WL-0MSG8EG7P002MX2I): under the 206-process spawn storm a ~16MB
`worklog.db-wal` was observed — SQLite's default auto-checkpoint (1000 pages,
~4MB) could not keep up with concurrent writers. SQLite must scan the WAL for
the latest version of every page on read, so a large WAL is expected to slow
reads.

## How to run

```
npm run benchmark:wal-read-latency            # text output
npm run benchmark:wal-read-latency:json       # machine-readable output
npx tsx bench/wal-read-latency.ts --items 3000 --wal-target-mb 16 --iterations 7 --json
```

### Options

- `--items` (default 3000) — work items seeded into the test DB (real schema
  via `SqlitePersistentStore`)
- `--desc-kb` (default 2) — size of each item's description in KiB (rows span
  multiple 4KB pages, like real Worklog markdown descriptions)
- `--wal-target-mb` (default 16) — target WAL size in MiB; the writer bloats
  rows (changing content, since SQLite treats repeated identical-value
  UPDATEs as no-ops) in small committed batches until the on-disk WAL reaches
  the target
- `--iterations` (default 7) — query repetitions per phase; median reported
- `--keep` — keep the temp DB dir (default removes it)
- `--json` — JSON output for agent consumption

### Methodology

1. Build a temp worklog DB (real schema: `workitems`, `comments`, FTS5, …)
   seeded with `--items` work items via the store's `importData`.
2. Open a raw writer connection with `PRAGMA wal_autocheckpoint = 0` —
   disables automatic checkpointing so WAL frames genuinely accumulate
   (deterministic stand-in for "concurrent writers outpace auto-checkpoint").
3. Bloat rows until `worklog.db-wal` reaches `--wal-target-mb`. The writer
   stays open so no checkpoint-on-close fires mid-measurement.
4. Measure three read queries (mirrors of `SqlitePersistentStore` hot paths)
   against a **fresh read-only connection per iteration**, each with a small
   2MiB SQLite page cache so full-table scans stay disk/WAL-bound rather than
   being masked by a warm per-connection cache:
   - `SELECT * FROM workitems` → mirrors `getAllWorkItems()` (`wl list`/TUI
     list rendering)
   - `SELECT * FROM workitems WHERE id = ?` → mirrors `getWorkItem(id)`
   - `SELECT * FROM worklog_fts WHERE worklog_fts MATCH 'benchmark*' LIMIT 50`
     → mirrors FTS search
5. Run `PRAGMA wal_checkpoint(TRUNCATE)` (merges WAL → main DB, WAL → 0).
6. Repeat the same measurements (post-checkpoint, small/zero WAL).
7. Report medians and the large-WAL vs checkpointed percentage delta.

## Results

Run on 2026-08-25 (Linux, SSD, Node 22 / better-sqlite3 12.11.1). Seed:
3000 items × 2 KiB descriptions. Each run repeats the two phases 7× and
reports medians; multi-run statistics below (OS page cache is warm for both
phases, so the delta isolates WAL-scan overhead rather than cold-disk
effects).

### 16 MiB WAL (default target) — 5 runs

| Hint | Large WAL (16.2 MiB) | After checkpoint (0 MiB) | getAllWorkItems slowdown |
|------|----------------------|--------------------------|--------------------------|
| global cache warm | 15.5–18.5 ms | 13.5–17.8 ms | **+1.5% … +15.4%**, median **~11%** |
| 2MiB SQLite cache | 15.5–17.0 ms | 13.6–16.1 ms | **+4.5% … +14.4%**, median **~13.5%** |

Point reads (`getWorkItem(id)`, ~0.05 ms) and FTS queries (~0.04 ms) show no
measurable difference — sub-ms, noise-dominated.

### 30 MiB WAL (larger-growth variant)

| Query | Large WAL (29.7 MiB) | After checkpoint (0 MiB) | Slowdown |
|-------|----------------------|--------------------------|----------|
| getAllWorkItems (full scan) | 50–68 ms | 42–67 ms | **+17.6% … +34.2%** |
| getWorkItem(id) | 0.048–0.085 ms | 0.054–0.058 ms | ~0 (noise) |
| searchFts | 0.035 ms | 0.036–0.041 ms | ~0 (noise) |

### JSON sample (16 MiB run)

```json
{"items":3000,"walTargetMiB":16,"iterations":7,"walSizeLargeMiB":16.21,
 "phaseResults":[
   {"phase":"large-wal","walMiB":16.21,"getAllMedianMs":16.3077,"getByIdMedianMs":0.0497,"searchMedianMs":0.0363},
   {"phase":"after-checkpoint","walMiB":0,"getAllMedianMs":14.1307,"getByIdMedianMs":0.0576,"searchMedianMs":0.0373}
 ],
 "delta":{"getAllSlowerPct":15.4,"getByIdSlowerPct":-13.8,"searchSlowerPct":-2.6}}
```

## Interpretation

- **Full-table scans are the affected path**: `getAllWorkItems()` (the basis
  of `wl list` and the TUI work-item list) is measurably slower — roughly
  **+5–15% with a 16 MiB WAL (median ~13%)**, up to **+17–34% with a
  30 MiB WAL** — because the query must consult the WAL for every page's
  latest version.
- **Point reads and FTS queries are effectively unaffected** at this scale:
  index-driven lookups touch few pages and fewer WAL frames; sub-ms timings
  are noise-dominated.
- Timings are warm-cache (OS page cache warm for both phases), so the delta
  isolates WAL-scan overhead rather than cold-disk effects; a cold cache
  would likely widen the gap. Run-to-run variance (±10 pp on the full scan)
  reflects OS page-cache warmth; use multiple runs + median for comparisons.
- The WAL growth itself is bounded by write volume and cleared on
  last-connection close (checkpoint-on-close), matching production
  observation (see `docs/dev/wal-checkpointing-investigation.md`).

## Environment

- Node `v22.22.1`, better-sqlite3 `12.11.1`
- SQLite defaults: page_size 4096, wal_autocheckpoint 1000 pages (~4MB)
- Temp DB removed unless `--keep`