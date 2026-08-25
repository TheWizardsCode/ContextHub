# Investigation: WAL growth / checkpointing under concurrent writers

**Work item:** WL-0MSG8EG7P002MX2I — Investigate WAL growth/checkpointing:
large `worklog.db-wal` files under concurrent writers

**Child:** WL-0MT5J1CC4007QJFP — Document WAL checkpoint behavior and root
cause of 16MB WAL

**Status:** Investigation complete. Configuration documented, root cause
identified and reproduced by measurement, no correctness risk.

**Related:** [wl-process-spawning-investigation.md](./wl-process-spawning-investigation.md)
(origin of the 206-process spawn storm), WL-0MSAZQEQB008O7H3 (read-cache AC #2 —
WAL-aware invalidation), [read-cache `src/read-cache.ts`](../../src/read-cache.ts).

---

## 1. Executive summary

Worklog runs SQLite in **WAL journal mode** with **no explicit checkpoint
logic**. All checkpointing is left to SQLite defaults:

- `PRAGMA journal_mode = WAL` — set explicitly at open (`src/persistent-store.ts`).
- `PRAGMA wal_autocheckpoint` — **not set**, so SQLite's default of **1000
  pages** applies (~4MB at the 4096-byte page size).
- No `PRAGMA wal_checkpoint(...)` call exists anywhere in the codebase.

The 16MB WAL observed during the 206-process spawn storm is the expected
outcome of SQLite's default WAL behavior under heavy concurrent write load:
writes land in the shared WAL faster than any single connection's
between-transaction auto-checkpoint can reclaim them. **It is a
performance/read-latency concern, not a correctness risk** — SQLite WAL is
crash-safe by design, and checkpoint-on-close merges everything back when the
last connection exits.

## 2. Exact SQLite WAL configuration

### 2.1 Pragmas set by Worklog

Both the root CLI store (`src/persistent-store.ts`) and the shared TUI store
(`packages/shared/src/persistent-store.ts`) apply identical pragmas at open:

| Pragma | Value | Where set | Notes |
|--------|-------|-----------|-------|
| `journal_mode` | `WAL` | both, constructor | Enables concurrent readers + single writer; writes go to `worklog.db-wal` first |
| `foreign_keys` | `ON` | both, constructor | Referential integrity; unrelated to WAL |
| `busy_timeout` | 5000 (CLI) / 250 (TUI) ms | both, constructor | Writer contention backoff; overridable via `WL_SQLITE_BUSY_TIMEOUT_MS` |

### 2.2 SQLite defaults left in effect (verified live)

Measured on the current worklog database (`PRAGMA ...` queries):

```
page_size:         4096
journal_mode:      wal
wal_autocheckpoint: 1000
```

- **Page size** is the SQLite default **4096 bytes** (never overridden).
- **`wal_autocheckpoint`** is the SQLite default **1000 pages ≈ 4MB** of
  accumulated WAL writes before a connection attempts an automatic
  checkpoint between transactions.

### 2.3 Confirmed absence of explicit checkpoint logic

`grep` for `checkpoint`/`wal_autocheckpoint` across `src/` and `packages/`
finds only TUI *session-recovery* "checkpoint-and-terminate" terminology
(`packages/tui/extensions/Worklog/lib/recovery/*`) — nothing related to
SQLite WAL checkpointing. There is no `PRAGMA wal_checkpoint` and no
`wal_autocheckpoint` assignment anywhere. **Worklog relies entirely on
SQLite's default auto-checkpoint + checkpoint-on-close.**

## 3. When/where checkpointing happens

### 3.1 Auto-checkpoint (SQLite default, ~4MB threshold)

- After **1000 pages** (~4MB) of WAL writes, a connection runs an automatic
  checkpoint at the next point between transactions.
- Auto-checkpoint is **passive by default**: it does not block other writers,
  but it can only reclaim pages/segments that are no longer referenced by any
  active reader. Under heavy write concurrency the checkpointed frames are
  often immediately overwritten by new writes, so the WAL can keep growing
  well past the threshold while writers are active.
- Crucially, the checkpoint is attempted by **whichever connection happens to
  cross the threshold** — with many short-lived writer processes (each `wl`
  invocation opens its own connection), no single connection is well placed to
  reclaim pages written by others.

### 3.2 Checkpoint on close

- When the **last connection** to the database closes, SQLite performs a
  final checkpoint that merges all remaining WAL frames into
  `worklog.db` and deletes `worklog.db-wal` (and `-shm`).
- This matches the observation that `worklog.db-wal` files *disappear once
  all processes close*.

### 3.3 No explicit checkpoint in wl

`wl sync`, `importData()`, bulk mutations, and all writes rely on 3.1/3.2
alone. There is no post-sync `wal_checkpoint`.

## 4. Root cause of the 16MB WAL

### 4.1 The spawn storm

The excessive-spawn investigation (WL-0MSB19J56006E87J) observed **206
concurrent `wl` processes** each opening its own SQLite connection to the same
`.worklog/worklog.db`.

### 4.2 Mechanism

1. Every write (create/update/comment/sync-import…) commits to the **shared
   WAL** (`worklog.db-wal`) — the main `worklog.db` file is untouched until a
   checkpoint.
2. Each connection runs an auto-checkpoint attempt once cumulative writes
   cross the 1000-page (~4MB) threshold.
3. With 206 concurrent writers, WAL frames from many connections accumulate
   **faster than any single connection can reclaim them**: a passive
   checkpoint can only move frames to the main DB when no reader holds them,
   and checkpointed frames are rapidly superseded by new writes from other
   processes.
4. The WAL therefore grows to **~16MB ≈ 4000 pages**, well past the nominal
   threshold, until the write storm subsides and connections drain/close.

### 4.3 Why 16MB is explainable (not a leak)

- The observed size is consistent with the write volume of the storm, not a
  defect: it is bounded by total unwritten data and cleared on close.
- `PRAGMA wal_checkpoint(TRUNCATE)` on the current quiesced DB reports
  `(0, 0, 0)` — zero busy/checkpointed pages, WAL fully merged. A post-storm
  `worklog.db` at 55MB confirms data integrity was preserved.

### 4.4 Ruled out

- **Not a correctness issue**: WAL mode is crash-safe; the WAL is the
  database's own durable record until checkpointed. No data loss or
  corruption indicator has been observed.
- **Not a code defect in wl**: there is no missing checkpoint call — the
  behavior is SQLite's documented default. The only mitigations are tuning
  (`wal_autocheckpoint`) or explicit post-batch checkpointing, which are
  evaluated separately (see the recommendation child, WL-0MT5J4Q290025O0L).

## 5. Why a large WAL matters

1. **Read cost:** SQLite reads must consult the WAL for the latest version of
   every page. A 16MB WAL adds scan + merge overhead to every read query
   (work-item lists, search, `wl show`, …). Measured before/after impact is
   documented in the benchmark child (WL-0MT5J3X1R009A6I6).
2. **Cache invalidation:** `worklog.db` mtime/size alone is unreliable while
   a large WAL holds live writes. The read cache (`src/read-cache.ts`) is
   already WAL-aware — it fingerprints `worklog.db`, `worklog.db-wal` and
   `worklog.db-shm` (and the CLI uses a monotonic state counter) — so cache
   correctness holds regardless of WAL size (covers parent AC #2 / WL-0MSAZQEQB008O7H3).
3. **Crash/recovery:** on abnormal exit (kill, power loss), a larger WAL means
   longer recovery time when SQLite replays it on the next open. WAL replay is
   linear in WAL size; 16MB replays in well under a second on SSD, so the
   practical impact is minimal.

## 6. Verification performed

- Live `PRAGMA` queries on `.worklog/worklog.db`: `page_size = 4096`,
  `journal_mode = wal`, `wal_autocheckpoint = 1000`.
- `PRAGMA wal_checkpoint(TRUNCATE)` on the quiesced DB: `(0, 0, 0)` (no
  outstanding WAL frames; DB size 55MB intact).
- Grep across `src/` + `packages/`: no SQLite checkpoint/autocheckpoint
  pragma calls; WAL-only configuration matches the docs above.
- Reproduction + read-latency before/after numbers: see the benchmark child
  WL-0MT5J3X1R009A6I6 (`docs/benchmarks/wal-read-latency-benchmark.md`).

## 7. Recommendation (WL-0MT5J4Q290025O0L)

**Decision: add an explicit `PRAGMA wal_checkpoint(PASSIVE)` after
`importData()` (the `wl sync` / doctor / init bulk-import path) and keep the
SQLite-default auto-checkpoint threshold (1000 pages ≈ 4MB).** Implemented in
`src/persistent-store.ts` and `packages/shared/src/persistent-store.ts`.

### Rationale

1. **Measured read cost is real**: the benchmark (WL-0MT5J3X1R009A6I6) shows
   full-table scans (`getAllWorkItems`) are 5–15% slower with a 16MiB WAL and
   18–34% slower with a 30MiB WAL vs a checkpointed DB. Point reads and FTS
   queries are unaffected.
2. **Pre-plan Option C (raise `wal_autocheckpoint` to 10000 pages ≈ 40MB) is
   rejected**: a larger threshold allows the WAL to *grow bigger before any
   checkpoint* — the measured data shows larger WALs are slower to read, so
   this would make the problem worse, not better.
3. **A PASSIVE checkpoint after the largest regular write batch is cheap and
   safe**: it merges WAL frames back into `worklog.db` immediately (bounded
   WAL growth across repeated imports), never blocks concurrent readers or
   writers (unlike `TRUNCATE`, which may report busy=1 under an active
   reader), and adds negligible overhead to `importData`.
4. **Steady-state behavior is unchanged**: normal single-write paths
   (create/update/comment) still rely on auto-checkpoint + checkpoint-on-
   close; only the bulk-import path explicitly bounds the WAL.

### Risks and notes

- **Low risk.** PASSIVE never blocks; worst case it does nothing under heavy
  concurrent readers (frames remain until the next auto-checkpoint).
- `TRUNCATE` was considered and rejected: it can be blocked (busy=1) when a
  reader holds the WAL, and file shrinkage is cosmetic — non-blocking PASSIVE
  achieves the read-latency goal (merged frames) without contention.
- The 16MB WAL root cause is the concurrent-writer storm (206 processes),
  addressed separately by spawn-rate fixes (WL-0MSB19J56006E87J); the
  checkpoint addition bounds WAL growth for the remaining bulk paths.