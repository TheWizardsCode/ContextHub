# Doctor and Migration Policy

This document describes the `wl doctor` command and the migration policy for Worklog database schema changes.

## Overview

`wl doctor` validates your work items against the configured status/stage rules and provides subcommands for database schema upgrades and data pruning. It is the primary tool for maintaining database health.

### What `wl doctor` checks

- **Status/stage compatibility** — validates every work item's status and stage against the rules defined in `.worklog/config.yaml` (see `docs/validation/status-stage-inventory.md` for the full rule set).
- **Dependency edges** — checks that all dependency edges reference existing work items.
- **Pending migrations** — the `upgrade` subcommand detects and applies schema migrations.
- **Stale deleted items** — the `prune` subcommand removes soft-deleted items older than a configurable threshold.

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
