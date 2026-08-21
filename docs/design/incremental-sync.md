# Incremental Sync Design — Delta Export/Push of Changed Work Items

**Work item:** WL-0MSAKUBKW006FN8Q — Incremental sync: only export/push changed work items instead of full JSONL

**Status:** Design (approved before implementation)

---

## 1. Goal

Make `wl sync` incremental: instead of re-exporting and re-pushing the full JSONL
(11.6 MB, 2133 items, 7494 comments) on every sync, only the records that changed
since the last sync are exported into the JSONL and pushed to the shared
`refs/worklog/data` ref. This eliminates the full-rewrite-per-sync cost that makes
syncs take 5–19 s and periodically trips client timeouts (WL-0MSAKM838006RZNR).

The main wins target the **local** costs (per the constraint note in the intake):
- the full export write (11.6 MB to disk),
- the temp-worktree file copy,
- `git add` hashing/compressing of 11.6 MB,
- the pull-side `git show` + parse of 11.6 MB.

Git already delta-compresses the *network* payload, so the design focuses on local
work proportional to the number of changed records, not the dataset size.

## 2. Approach

Approach **option 1** (dirty tracking + delta export) with a full-snapshot
fallback. This was chosen during planning over option 2 (batched full rewrites,
lower value) and option 3 (sharded JSONL, added ref/file complexity).

The by-ID, field-level timestamp merge (`mergeWorkItems`, `mergeComments`,
`mergeDependencyEdges`, `mergeAuditResults` in `src/sync.ts`) remains the
**correctness backbone**. Deltas feed through the exact same merge logic.

## 3. Delta format specification

### 3.1 Record types (unchanged)

A delta file reuses the existing flat record format from `src/jsonl.ts`:

```
{"type":"workitem","data":{...}}
{"type":"comment","data":{...}}
{"type":"audit_result","data":{...}}
```

Each record already carries `{ type, data }` and is `JSON.stringify`'d with
stable key sorting. Dependency edges are *derived* from `item.dependencies`
(flattened on export, normalized back on import), so they need no separate
record type. **A delta file is therefore a valid subset of the current format.**

### 3.2 Version/header metadata

To let readers distinguish a **delta** from a **full snapshot** (and to gate
backward compatibility), the first line of every JSONL written by the sync path
carries a header record:

```
{"__worklog_sync__":{"version":1,"kind":"delta"}}
...delta records...
```

or

```
{"__worklog_sync__":{"version":1,"kind":"full"}}
...full records...
```

**Design decision:** a header line, not a record-count heuristic. A heuristic
(fewer than N records = delta) is fragile because a legitimately tiny full
snapshot could be misclassified. The header is explicit and additive.

### 3.3 Why a delta is self-describing and mergeable

Because deltas are a subset of the full format:

- **Merge semantics are preserved exactly.** `importFromJsonlContent` parses
  delta records into `items`/`comments`/`dependencyEdges`/`auditResults`, which
  are then fed to the existing by-ID merge functions. There is no divergent
  resolution path.
- **Backward compatibility.** An old `wl` client (or Herdr / Pi TUI) reading a
  delta sees *fewer* records than the full set. That is a *partial* view, not a
  *corrupt* one. Mitigation below (§6.1) ensures every reader obtains a full
  snapshot.

## 4. Dirty tracking (per-type export timestamps)

### 4.1 Mechanism: `updatedAt` threshold, not write interception

Per the intake risk mitigation ("track at the export boundary using `updatedAt`
thresholds rather than write interception"), dirty tracking is based on a
**per-type export timestamp** recorded after each successful export/push:

- `last-export-time` state file under `.worklog/` records four timestamps
  (ISO 8601), one per record type:
  - `workitem`
  - `comment`
  - `audit_result`
- On the next sync, a record is **dirty** if `updatedAt > lastExportTime[type]`.

**Why this is robust:** because it is computed at the export boundary against
the data's own `updatedAt` timestamps, it cannot miss changes written by any
path (ORM writes, direct DB writes, imports, migrations) that bump `updatedAt`.
The same threshold mechanism naturally covers comments (keyed by `createdAt`
as the effective update time) and audit results (by `updatedAt`).

**No-baseline rule:** when `last-export-time` is absent (first sync), every
record is dirty → full export.

### 4.2 Per-type coverage

| Type | Dirty predicate |
|------|-----------------|
| `workitem` | `item.updatedAt > lastExportTime.workitem` |
| `comment` | `comment.createdAt > lastExportTime.comment` (comments are immutable after creation) |
| `audit_result` | `audit.updatedAt > lastExportTime.audit_result` |

> **Design note:** comments are treated as immutable-by-`id` (the merge
> dedupes by `id`), so `createdAt` is the correct dirty key — a comment that
> hasn't changed since the last export should not be re-emitted. If a future
> change allows editing comments, the predicate would switch to `updatedAt`.

### 4.3 Deletion propagation (soft deletes)

Deletions are **soft** (`status: 'deleted'`), so a deleted item is a record
whose `updatedAt` was bumped. It is therefore captured by the same dirty
predicate and emitted in the delta with `status:'deleted'`. No hard-delete
tombstone format is needed. On the remote side, the merge sees the
`deleted` item and converges. **(AC4)**

## 5. Export/push orchestration (sync path)

### 5.1 Decide full vs. delta

During `performSync` (after the pull/merge and DB import), decide:

```
needsFull =
  !lastExportTime                              // first sync / no baseline
  OR lastSyncWasDelta && deltaReplayBroken     // chain mismatch (§6.2)
  OR fullSnapshotDue                           // cadence policy (§5.3)
  OR nothing on remote base                    // no full snapshot exists remote
```

Otherwise → **delta export**.

### 5.2 Delta export

`exportForSync()` gains a `{ mode: 'full' | 'delta', since: lastExportTime }`
option. In delta mode:

1. Query only dirty records: `getAllWorkItems({ since })`,
   `getAllComments({ since })`, `getAllAuditResults({ since })`.
2. Build the JSONL **with the delta header** — a small, proportional payload.
3. Write it to `this.jsonlPath` (same path as today; ephemeral pattern
   unchanged).
4. Return the path.

Push proceeds exactly as today via `gitPushDataFileToBranch` — the only change
is that the file content is the delta. **The temp-worktree copy and `git add`
now touch a small file instead of 11.6 MB.**

### 5.3 Full-snapshot cadence policy

**Default:** after every **10 delta syncs**, OR when the accumulated delta
exceeds **1 MB** (advisory threshold), force a full snapshot. Both are
configurable (`sync.fullSnapshotEveryN`, `sync.deltaSizeThreshold`).

Rationale (per plan): preempting that the remote retains a recent full
snapshot bounds any delta-replay cost, and a conservative threshold keeps the
rare slow syncs infrequent. A counter + accumulated-delta-size is persisted in
the last-export-time state file.

### 5.4 Zero-change fast path

If **no** record is dirty AND a full snapshot is not due, skip export+push
entirely (write an empty delta is avoided). This preserves/narrows the existing
`last-sync-time` optimization.

## 6. Pull/merge path & fallback

### 6.1 Read path

`getRemoteDataFileContentWithRef` streams the remote JSONL (unchanged). The
pull side inspects the first line:

- header `kind:"full"` → parse normally, merge (current behavior).
- header `kind:"delta"` → parse the delta records and merge them **onto the
  local base** using the existing by-ID merge. Deltas only ever *add/update*
  records relative to what the local store already has, so merging a delta into
  local state is safe.
- no header (legacy full file) → parse normally as a full snapshot.

### 6.2 Full-snapshot fallback triggers

The pull side requests a full snapshot (sets `needsFull = true` on the next
push, or performs a full pull then full push) when any of:

1. **Missing base** — the local store has no baseline for the remote's delta
   chain (e.g., a brand-new clone that fetched only deltas).
2. **Chain mismatch / corruption** — the remote stream or delta header is
   unreadable, or `git show` fails, or the merge throws.
3. **First sync** in a fresh checkout — no local data to resolve against.
4. **Author-identity gate failure** or any other safety gate that indicates the
   local state cannot trust the remote delta chain.

On fallback the sync reverts to the **full export/merge path with no data
loss** — identical to today's behavior. **(AC5)**

> Because the fallback does not delete anything locally and always rebuilds a
> full snapshot from the (complete) SQLite store, there is no data loss in any
> fallback path.

### 6.3 Delta replay budget bound

The full-snapshot cadence (§5.3) guarantees the remote always has a recent full
snapshot, so the maximum delta replay a fresh reader must apply is bounded by
the records changed since the last full snapshot — not unbounded history.

## 7. Backward compatibility strategy

1. **Delta = valid JSONL subset.** Old clients reading a delta see partial data
   (not corruption). To avoid serving stale partial data, see #2.
2. **Automatic full-snapshot fallback.** The first sync after the incremental
   path is enabled forces a full snapshot (§5.1 `nothing on remote base`), so
   the remote ref always carries a full snapshot before/at the first delta.
   Any reader that cannot interpret a delta triggers a full pull.
3. **Header is additive.** The `__worklog_sync__` header is a single extra line
   the old parser *skips* (it would be treated as a record with neither
   `type` nor `data` and, per `importFromJsonlContent`, falls into the
   "old format, assume workitem" warn path). **Mitigation:** to avoid a stray
   warn log on old clients, the header record includes no `data` wrapper and
   the old parser treats `type === undefined && !parsed.data` as legacy; it
   would `console.warn` and attempt to parse a workitem. We therefore keep the
   header **outside** the old parser's recognized shapes by making the old
   warn path harmless: since `stripWorklogMarkers(parsed.description)` with no
   `description` is a no-op and the header has no required fields, the only
   observable effect on an old client is a single warning line and a spurious
   empty item. **To fully avoid this**, the header is emitted as a comment
   (`#`) line rather than a JSON record when running on a format that must be
   backward-readable by the legacy parser:

   ```
   #worklog-sync version=1 kind=delta
   ```

   The new parser recognizes `#worklog-sync ...` as the header; the old parser
   already ignores `#`-prefixed lines in its `importFromJsonlContent`? **It does
   NOT today** — plain `#` lines are treated as a JSON-parse error.

   **Final decision:** the header is an inline JSON object
   `{"__worklog_sync__":{"version":1,"kind":"full"|"delta"}}` and we **patch the
   legacy parser** (`importFromJsonlContent`) to detect and skip the
   `__worklog_sync__` header line explicitly (defensive, forward-compatible
   with the old format). Old *deployed* binaries still warn on it but never
   crash (it's a parseable JSON object with `type` undefined). The stored-data
   contract remains: **every reader that can't handle deltas falls back to a
   full pull**, guaranteed by the full-snapshot-before-first-delta rule.

## 8. File changes

| File | Change |
|------|--------|
| `packages/shared/src/database.ts` | `exportForSync()` accepts `{mode, since}`; add dirty query support; persist `last-export-time` state (per-type timestamps, delta counter, accumulated size) |
| `src/jsonl.ts` | header emission/parsing; a delta writer (`buildJsonlContent` with `since`) |
| `src/sync.ts` | pull side detects header kind; `exportForSync` call sites; full-snapshot fallback decision |
| `src/commands/sync.ts` | orchestration: decide full vs delta, cadence policy, zero-change skip |
| `tests/` | dirty-tracking, delta export/merge, deletion propagation, convergence (interleaved full+delta), fallback tests |
| `docs/ARCHITECTURE.md` | update "Future Considerations" §1 to reflect implemented design |

## 9. Concurrency & existing protections

The incremental path runs entirely inside the existing sync flow, so it
inherits unchanged:
- the file lock (`withFileLock`, `getLockPathForJsonl`),
- the single-flight guard and `--if-idle` skip semantics (WL-0MSAB7ZUC004SK7E),
- the ephemeral JSONL pattern (SQLite → JSONL → push → delete).

The last-export-time state file is written only after a **successful** push,
under the same lock, so concurrent syncs cannot advance the baseline past data
that was never published. **(AC: no regression to concurrency protections)**

## 10. Performance expectations

- Small change sets (≤ 5 items/comments) export and push a delta proportional
  in size to those records (kilobytes, not 11.6 MB).
- Typical incremental sync target: **≤ 3 s** on the current dataset (2133 items
  / 7494 comments). Baseline today: full sync ~5.8 s local, 5–19 s with network.
- The `git add`/temp-copy/`git show`+parse costs scale with delta size, not
  dataset size.

## 11. Acceptance-criteria mapping

| AC | Design coverage |
|----|-----------------|
| AC1 no full rewrite on small changes | §5.2 delta export, proportional payload |
| AC2 ≤3 s typical incremental sync | §10 performance expectations |
| AC3 correctness/convergence | §3 merge backbone, §8 convergence tests |
| AC4 deletion propagation | §4.3 soft-delete dirty capture |
| AC5 full-snapshot fallback | §6.2 fallback triggers, §7 no data loss |
| AC6 backward compatibility | §7 header scheme + full-pull fallback |
| AC7 tests + suite passes | §8 tests, follow-up tasks 8 |
| AC8 documentation | §8 ARCHITECTURE update, follow-up task 9 |

## 12. Open items decomposed into child tasks

The design resolves the format/cadence questions but the implementation is
executed by the planned child tasks (dirty tracking, delta export, push path,
pull/merge path, fallback, deletion propagation, integration tests,
documentation).
