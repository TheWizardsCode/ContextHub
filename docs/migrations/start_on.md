# Migration guide: `startOn` (earliest start instant)

Migration id: **`20261118-add-start-on`** — added by WL-0MWMGEPY2004EDZ8
(epic WL-0MWM0FDZK007BAD0). Schema version: **9 → 10**
(`SCHEMA_VERSION` in `packages/shared/src/persistent-store.ts` and
`CURRENT_SCHEMA_VERSION` in `src/migrations/index.ts` are bumped together).

## What it does

`workitems` gains a nullable `startOn TEXT` column holding each item's
**earliest instant at which it may proceed** as an ISO-8601 UTC timestamp.

The column's invariant is **always populated with the effective instant**:

```
stored startOn = startOn ?? createdAt
```

so every "has this item started?" query compares a single non-null column and
never needs `COALESCE` over two. The migration:

1. adds `workitems.startOn` when it is missing (idempotent);
2. back-fills every row without one — `UPDATE workitems SET startOn = createdAt
   WHERE startOn IS NULL OR trim(startOn) = ''` — so existing items behave
   exactly as they did before (`createdAt` is the default, **never "blocked"**);
3. creates `idx_workitems_startOn` so the default `startOn` filter uses an
   index rather than a table scan;
4. records the metadata sentinels `startOn_added` and `startOn_backfilled`.

Re-running the migration is a **no-op**: the `ALTER` is guarded by a column
check, the `UPDATE` only touches rows that are still `NULL`/blank (so an
explicitly scheduled item is never overwritten), and the index uses
`CREATE INDEX IF NOT EXISTS`.

## Why the pending check keys on a sentinel, not the column

`listPendingMigrations` treats a migration as applied when its `requiredColumn`
is present. This migration's `requiredColumn` is therefore
**`__meta:startOn_backfilled`**, not `startOn`:

the persistent store repairs a missing column *additively* on open (recording
`startOn_added`) so an older database keeps working before anyone runs
`wl doctor upgrade`. If the pending check keyed on the column's presence, that
repair would silently retire the back-fill and leave every legacy row `NULL`.

## Apply the migration

```bash
wl doctor upgrade --dry-run     # lists 20261118-add-start-on as pending
wl doctor upgrade --confirm     # takes a backup, then applies it
```

`wl doctor upgrade` writes a pre-migration snapshot to
`.worklog/backups/worklog.db.<timestamp>` before applying anything.

Merely running the CLI is also safe and does **not** apply the back-fill: the
store adds the column if it is absent (so writes never fail) and leaves the
migration pending until you run the command above.

## Verify

```bash
wl doctor upgrade --dry-run          # → "no pending migrations"
wl doctor --json | jq '.[] | select(.checkId | startswith("startOn."))'
```

`wl doctor` reports:

| Check id | Meaning | Remediation |
|---|---|---|
| `startOn.missing` | one **global** warning: live rows whose stored `startOn` is still `NULL`/blank, so the column does not hold the effective instant | `wl doctor upgrade --confirm` |
| `startOn.invalid` | a per-item warning for a stored `startOn` that is not a parseable ISO-8601 instant (such an item fails open — it reads as started) | set a valid instant on that item, or clear it back to `createdAt` |

Both are warning-level and read-only; neither changes an item's status, and
`wl doctor --fix` does not apply them (the migration — not a per-row write — is
the safe repair).

## Roll back

The column is additive and nullable, so no data is lost by rolling back:

```bash
wl export --file backup-before-rollback.json          # keep a portable copy
sqlite3 .worklog/worklog.db 'ALTER TABLE workitems DROP COLUMN startOn'
sqlite3 .worklog/worklog.db 'DROP INDEX IF EXISTS idx_workitems_startOn'
sqlite3 .worklog/worklog.db \
  "UPDATE metadata SET value = '9' WHERE key = 'schemaVersion'"
sqlite3 .worklog/worklog.db \
  "DELETE FROM metadata WHERE key IN ('startOn_added', 'startOn_backfilled')"
```

An older build ignores the column if it is left in place, so dropping it is
only necessary if you also want the schema byte-identical to the previous
release.

## Title-prefix scheduling (legacy workflows)

Scheduling is expressed **only** by the `startOn` field. No work-item title is
parsed for a start instant, and no workflow reference in this repository (or in
the installed Pi skill set) uses a `[run-not-before …]` title prefix. If a
project migrating from an older convention still carries such a prefix, drop it
and set the field instead:

```bash
wl update WL-ABC123 --title "Re-measure cache hit rate" \
  --start-on 2026-11-19T10:25:00Z
```

The field is visible and queryable (`wl list --include-not-started`,
`wl list --fields startOn`, `wl next --starts-before …`) and the claim guard
enforces it, none of which a title prefix could do.

## Notes for developers

- Storage invariant: `saveWorkItem` writes `normalizeStartOn(startOn, createdAt)`
  (`packages/shared/src/start-on.ts`), and `rowToWorkItem` reads a `NULL` column
  as `createdAt`. Both call the same helper as the JSONL import back-fill and the
  doctor check, so the three can never disagree.
- `startOn` is part of the tracked field set, so a scheduling-only edit bumps
  `updatedAt` and therefore propagates through two-way sync. The merge resolves
  it like every other mutable field (default-aware, newest-write-wins), so sync
  never resurrects a stale value.
- Legacy JSONL/Git records without the field import as `createdAt`, and the
  tracked-field comparison compares the **effective** instant, so re-importing a
  legacy snapshot does not churn `updatedAt`.
- `startOn` is in `VALID_FIELDS`, so `wl list --fields startOn` and friends work.
