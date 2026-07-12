# Migration guide: sort_index ordering

This guide describes how to migrate existing work item ordering to the new `sort_index` model and how to roll back safely.

## Overview

The migration adds a `sort_index` integer to `work_items`, initializes values based on current `wl next` ordering, and updates default list/next ordering to use the new field. Gaps (default 100) are used to keep reordering efficient.

## Preconditions

- Ensure you have a clean working tree and a recent backup/export.
- Close or pause concurrent edits (avoid running `wl sync` during migration).

## Apply migration

1) Dry-run to validate state and show changes:

```
wl migrate sort-index --dry-run
```

Dry-run output shows each item ID, title, and the proposed sort_index value.

2) Apply migration:

```
wl migrate sort-index
```

If you only need to rebuild ordering for active items based on current database values (without running the migration), use:

```
wl re-sort
```

3) Verify ordering:

```
wl list
```

## CLI examples

Re-sort active work items to restore gaps after manual edits:

```
wl re-sort
```

Re-sort using recency-based ordering:

```
wl re-sort --recency
```

## Backup

Export a backup before migration:

```
wl export --file backup-before-sort-index.json
```

## Notes for developers

- Use integer gaps (default 100) for `sort_index` to allow insertion without full reindexing.
- Reindex only the affected level (siblings with the same parent) to minimize churn.
- Keep moves of a parent and its subtree stable by offsetting child indices.
- Conflict resolution should prefer `updated_at`, then owner, then reindex deterministically.

## Benchmarking

Run the migration benchmark to validate performance up to 1000 items per level:

```
npm run benchmark:sort-index -- --level-size 1000 --depth 3 --gap 100
```

Record results in `docs/benchmarks/sort_index_migration.md`.
