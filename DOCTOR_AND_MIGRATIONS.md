# Doctor and Migration Policy

This document describes the `wl doctor` command and the migration policy for Worklog database schema changes.

## Overview

`wl doctor` validates your work items against the configured status/stage rules and provides subcommands for database schema upgrades and data pruning. It is the primary tool for maintaining database health.

### What `wl doctor` checks

- **Status/stage compatibility** — validates every work item's status and stage against the rules defined in `.worklog/config.yaml` (see `docs/validation/status-stage-inventory.md` for the full rule set).
- **Dependency edges** — checks that all dependency edges reference existing work items.
- **Podcast script `Key Files:`** — flags a `podcast` item at a script-bearing stage (`plan_complete` / `in_review` / `done`) whose `Key Files:` contains no `.podcast.md` path that resolves to an existing file under the worklog root, and any `podcast` item whose listed `.podcast.md` path does not resolve. Detection is artifact-based (filesystem), not stage/status-based. `wl doctor --fix` backfills the path when a matching script is found (see `docs/FILE_PATH_CONVENTION.md`).
- **Pending migrations** — the `upgrade` subcommand detects and applies schema migrations.
- **Stale deleted items** — the `prune` subcommand removes soft-deleted items older than a configurable threshold.
- **Audit gaps** — the `audit-gaps` subcommand reports `completed`/`in_review` items with no audit record (read-only).

## Running `wl doctor`

### Basic validation

```bash
# Check for issues (read-only)
wl doctor

# JSON output for scripting
wl doctor --json

# Apply safe fixes interactively (prompts for non-safe findings)
wl doctor --fix
```

When issues are found, doctor prints each work item ID with its findings and suggested fixes. Findings that require manual intervention are grouped by type at the end.

### Schema migrations (`wl doctor upgrade`)

Preview pending migrations before applying:

```bash
wl doctor upgrade --dry-run
```

Apply pending migrations (creates a backup first, then prompts for confirmation):

```bash
wl doctor upgrade
```

Apply non-interactively (for CI or automation):

```bash
wl doctor upgrade --confirm
```

### Pruning deleted items (`wl doctor prune`)

Remove soft-deleted work items older than a threshold:

```bash
# Preview what would be pruned (default: 30 days)
wl doctor prune --dry-run

# Prune items deleted more than 30 days ago
wl doctor prune

# Custom threshold
wl doctor prune --days 90
```

Notes on GitHub-linked items:

- By default `wl doctor prune` skips any deleted work item that is linked to a GitHub issue (has `githubIssueNumber`) when the local `updatedAt` is newer than the recorded `githubIssueUpdatedAt` on the work item. This prevents accidentally orphaning GitHub issues that have local changes not yet reflected on GitHub.

JSON output from `--json` includes a `skippedIds` array when such items are detected during a dry-run or actual prune.

### Detecting foreign work items (`wl doctor foreign-items`)

Reports work items whose ID prefix does not match the project's configured prefix (from `.worklog/config.yaml`). This is used to detect cross-project worklog pollution: a work item is *foreign* when the substring before the first `-` in its ID differs from the configured prefix (e.g. `WL-` items in a `SA` project). IDs without a `-` separator cannot be classified and are left alone.

```bash
# Report foreign items (read-only; default)
wl doctor foreign-items --dry-run

# JSON output for scripting
wl doctor foreign-items --dry-run --json

# Override the prefix used for classification
wl doctor foreign-items --prefix SA

# Hard-delete all foreign items (destructive; explicit opt-in required)
wl doctor foreign-items --apply

# Clean the DB and rewrite the remote worklog ref so it contains only own items
wl doctor foreign-items --apply --push
```

The report includes total items scanned, the foreign count, counts grouped by prefix, the deleted/non-deleted breakdown, and the full list of foreign IDs. Dry-run mode never modifies the database.

`--apply` hard-deletes every foreign item with full cascade: the work item row, its comments, dependency edges referencing it, its `audit_results` row, and its FTS index entry. Own items are never touched. The result reports before/after totals, per-prefix removed counts, and any errors. Run `--dry-run` first to preview exactly what will be removed.

See [docs/CROSS_PROJECT_POLLUTION_CLEANUP.md](docs/CROSS_PROJECT_POLLUTION_CLEANUP.md) for the full usage guide, recommended workflow, and the pollution-source sweep findings.

Adding `--push` rewrites the project's remote worklog ref (`origin refs/worklog/data`, or the configured `syncBranch`) so it contains only the project's own items, bypassing the polluted remote history entirely (a fresh orphan commit is force-pushed and the local tracking ref is updated to match). `--push` requires `--apply` — rewriting the ref without cleaning the DB would publish foreign items. After the push, a subsequent `wl sync` pulls the clean ref and cannot re-import foreign items.

### Reporting audit gaps (`wl doctor audit-gaps`)

Work items can reach `completed`/`in_review` — and ship — without an audit record. `wl doctor audit-gaps` is a **read-only** report of every such item (WL-0MUBVH9FV0027COG):

```bash
# Report completed/in_review items with no audit record (read-only)
wl doctor audit-gaps

# Machine-readable report
wl doctor audit-gaps --json
```

Each reported row shows:

- **relationship** — `root` or `child of <parent-id>`.
- **age** — derived from `activityAt` (falling back to `updatedAt`), in milliseconds and whole days.
- **classification** — one of:
  - `uncovered` — a genuine gap (flagged);
  - `covered` — a child whose **direct** parent has a fresh audit (derived depth-1 coverage; never dispatched independently);
  - `waived` — an explicit, durable waiver is recorded.

Items with a *fresh* audit are omitted; stale-but-present audits are handled by the closure guard and the icon surfaces. The report has **no** `--apply`: it never mutates the database. The JSON payload exposes `items` (all no-audit items with their classification) and `flagged` (the `uncovered` subset), plus `noAuditCount`, `flaggedCount`, `coveredCount`, and `waivedCount`.

#### Recording a waiver (`wl audit-waive` / `wl audit-unwaive`)

To deliberately accept an audit gap, record a waiver with a reason:

```bash
wl audit-waive WL-ABC123 --reason "Legacy item completed before audits were enforced"
wl audit-unwaive WL-ABC123   # remove the waiver
```

The waiver is stored durably in the nullable `workitems.auditWaiver` JSON column (`{ reason, author, waivedAt }`), surfaced by `wl show --json`, and round-trips through JSONL sync. A waived item is excluded from the `audit-gaps` flagged set and produces no closure warning. Absence of a waiver is fail-safe: it never suppresses a flag. This is the only schema addition made by WL-0MUBVH9FV0027COG, applied through `wl doctor upgrade` (migration `20260928-add-audit-waiver`).

## Backups

When `wl doctor upgrade` applies migrations, it automatically:

1. Creates a timestamped backup of the database in `.worklog/backups/`.
2. Prunes backups to keep only the 5 most recent copies.

Backup filenames follow the pattern `worklog.db.<ISO-timestamp>`.

You can also create a manual backup before any risky operation:

```bash
wl export --file backup-before-change.jsonl
```

## Migration Policy

### How migrations work

- Migrations are defined in `src/migrations/index.ts` as an ordered list.
- Each migration has an `id`, `description`, and `safe` flag (indicating whether it is non-destructive).
- `wl doctor upgrade --dry-run` lists pending migrations without applying them.
- `wl doctor upgrade` prompts interactively before applying; `--confirm` bypasses the prompt.
- All migrations run inside a single database transaction — if any migration fails, the entire batch is rolled back.
- After successful application, the `metadata.schemaVersion` value is incremented.

### Safe vs non-safe migrations

- **Safe** migrations are non-destructive (e.g., adding a column with a default value). They can be applied with `--fix` or `--confirm` without risk.
- **Non-safe** migrations may alter or remove data. They require explicit confirmation and are listed separately in the dry-run output.

### Adding a new migration (for developers)

1. Add an entry to the `MIGRATIONS` array in `src/migrations/index.ts`.
2. Include an `id` (date-prefixed, e.g., `20260301-add-new-column`), a human-readable `description`, and set `safe: true` if the migration is non-destructive.
3. Implement the `apply` function. Make it **idempotent** — check whether the change has already been applied before executing it.
4. Run `wl doctor upgrade --dry-run` to verify the migration is detected.
5. Run `wl doctor upgrade --confirm` to apply and verify.
6. Update this document if the migration changes operational guidance.

## CI and Automation

### Running doctor in CI

```bash
# Validate work items (fails with non-zero exit if issues found)
wl doctor --json

# Check for pending migrations (informational)
wl doctor upgrade --dry-run --json
```

### Applying migrations in CI

If your CI pipeline needs to apply migrations automatically:

```bash
wl doctor upgrade --confirm --json
```

**Important:** Applying migrations in CI modifies the database. Ensure your pipeline:

- Has write access to the `.worklog/` directory.
- Creates or preserves backups (automatic via `wl doctor upgrade`).
- Commits the updated `.worklog/worklog-data.jsonl` after migration if data changes occur.

### Data migration (`wl migrate`)

The `wl migrate` command handles data-level migrations (as opposed to schema-level migrations handled by `wl doctor upgrade`):

```bash
# Preview sort_index migration
wl migrate sort-index --dry-run

# Apply sort_index migration with custom gap
wl migrate sort-index --gap 100
```

See `docs/migrations/sort_index.md` for details on the sort_index migration.

## Troubleshooting

### "Migrations present but not confirmed"

This error occurs when `wl doctor upgrade` finds pending migrations but no `--confirm` flag was provided and the user declined the interactive prompt. Rerun with `--confirm` to apply.

### Backup failures

If backup creation fails, the migration is aborted. Check:

- Write permissions on `.worklog/backups/`.
- Available disk space.
- That the database file is not locked by another process.

### Rolling back a migration

If a migration causes issues:

1. Stop all Worklog processes.
2. Copy the most recent backup from `.worklog/backups/` over the current database:
   ```bash
   cp .worklog/backups/worklog.db.<timestamp> .worklog/worklog.db
   ```
3. Verify with `wl doctor`.

## Related documentation

- [CLI Reference — doctor](CLI.md#doctor-options) — full flag reference
- [CLI Reference — migrate](CLI.md#migrate-subcommands) — data migration commands
- [Sort Index Migration Guide](docs/migrations/sort_index.md) — sort_index migration details
- [Status/Stage Inventory](docs/validation/status-stage-inventory.md) — validation rules
