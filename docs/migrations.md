Worklog Migration Policy and `wl doctor upgrade`

Overview
--------
This document explains how to inspect and apply database schema migrations for Worklog using
the `wl doctor upgrade` command and the repository migration runner. Migrations are centralized
in `src/migrations` and must be applied explicitly to avoid silent schema changes on production
databases.

Backups
-------
- Before applying migrations the runner creates a timestamped backup of the database in
  `<dbdir>/backups/`.
- The runner prunes backups to keep the most recent 5 backups to limit disk usage.

Running `wl doctor upgrade`
---------------------------
Examples:

- Preview pending migrations (dry-run):

  `wl doctor upgrade --dry-run`

  This lists pending migrations without applying them.

- Apply pending migrations interactively:

  `wl doctor upgrade`

  The command lists safe migrations and prompts for confirmation before applying.

- Apply pending migrations non-interactively:

  `wl doctor upgrade --confirm`

  Use `--confirm` to skip the interactive prompt. Note: the command still enforces the
  backup creation behavior and will fail on errors.

Flags (current behaviour)
-------------------------
- `--dry-run` — list pending migrations without applying them.
- `--confirm` — apply migrations non-interactively (no prompt).

If a flag described here is not implemented in your local `wl` version, the command will
document the planned behaviour and fall back to the safe (dry-run) behaviour by default.

Backups & Safety
----------------
- Backups are mandatory. The migration runner will not apply migrations without creating a
  backup first.
- The runner prunes backups to keep only the last 5.

CI / Automation
---------------
- By default CI should not auto-apply migrations to persistent production databases. Use a
  dedicated migration step that runs `wl doctor upgrade --dry-run` and fails the build if
  pending migrations are found.
- To allow non-interactive application (risky), set an explicit environment variable such as
  `WL_AUTO_MIGRATE=true` and run `wl doctor upgrade --confirm` in a controlled environment.
  This repository recommends making the migration step explicit and auditable in CI.

Adding a migration
------------------
- Add SQL migration files and a migration descriptor to `src/migrations` following the
  repository migration conventions. Ensure `safe` is set appropriately for the migration.
- Update tests and docs describing the behavioural change.

Troubleshooting
---------------
- If `wl doctor upgrade` reports pending migrations but you cannot apply them, inspect the
  migration descriptor and review the SQL for potential destructive operations. Run a dry-run
  first and verify backups.
- To inspect the workitems schema directly use sqlite3: `sqlite3 path/to/worklog.db "PRAGMA table_info('workitems')"`

Reference
---------
- Migrations runner: `src/migrations/index.ts`
- Migration descriptors: `src/migrations/*`
- Migration application: `runMigrations` creates backups and prunes to the last 5 backups.

Audit field migration note
--------------------------
- Migration `20260315-add-audit` is now a no-op. The `audit` column has been replaced by the `audit_results` table.
- Migration `20260604-add-audit-results` creates the `audit_results` table with columns: `work_item_id TEXT PRIMARY KEY`, `ready_to_close INTEGER NOT NULL DEFAULT 0`, `audited_at TEXT NOT NULL`, `summary TEXT`, `raw_output TEXT`, `author TEXT`, and a foreign key on `work_item_id` referencing `workitems(id)` with `ON DELETE CASCADE`.
- Migration `20260604-backfill-audit-results` reads existing `workitems.audit` JSON data and inserts corresponding rows into `audit_results`. This migration is idempotent (tracked via `audit_backfill_complete` metadata key).
- Migration `20260604-drop-audit-column` drops the legacy `audit TEXT` column from `workitems`.
- Structured audit data is now stored in the `audit_results` table (latest-only per work item).
- Use `wl audit-show <id>` to view audit results and `wl audit-set <id> --ready-to-close --summary <text>` to set them.
- Use `wl update --audit-text <text>` to set audit via the existing CLI interface (writes to `audit_results` table).
- Redaction/safety rules for audit text are tracked separately in `Redaction and Safety Rules for Audit Text (WL-0MMNCOIYS15A1YSI)`.
- See `docs/AUDIT_STATUS.md` for full documentation on audit status semantics.

Hook upgrades
-------------
The `wl doctor upgrade` command also checks and upgrades outdated git hooks installed in
`.git/hooks/` from the committed safe versions in `.githooks/`. This ensures existing
installations automatically get the safe hook patterns (using `--git-branch refs/worklog/data`)
without manual re-installation.

A hook is considered outdated when it:
- Lacks the safe `--git-branch refs/worklog/data` guard, or
- Contains hardcoded paths like `/tmp/Worklog/...` or absolute paths to `.git/hooks/` for
  the central post-pull script (should use `$(dirname "$0")`), or
- Lacks the worktree-skip guard (a `git rev-parse --git-dir != git rev-parse --git-common-dir`
  check plus a `*tmp-worktree-*` PWD check), or
- Differs in any way from the committed `.githooks/` version.

Only hooks that contain a Worklog marker (`worklog:pre-push-hook:`, `worklog:post-pull-hook:`,
or `worklog:post-checkout-hook:`) are considered for upgrade. Non-Worklog hooks are skipped.

> **Worktree safety:** All hooks (`pre-push`, `post-checkout`, `post-merge`/`post-rewrite` via
> `worklog-post-pull`) skip the sync when running inside a git worktree (where
> `git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`) or inside the
> internal `tmp-worktree-*` worktrees used by `wl sync`. Sync is only meaningful from the
> main checkout; running it from a worktree previously produced destructive "Sync work
> items and comments" commits that deleted tracked files (WL-0MS99Y6R40028Q9G).

Examples:

- Preview outdated hooks alongside migrations (dry-run):

  `wl doctor upgrade --dry-run`

- Preview outdated hooks with JSON output:

  `wl doctor upgrade --dry-run --json`

- Apply outdated hooks alongside migrations (non-interactively):

  `wl doctor upgrade --confirm`

- Apply outdated hooks alongside migrations (interactive prompt):

  `wl doctor upgrade`

The committed hook scripts live in `.githooks/` and include:
- `pre-push` — auto-syncs Worklog data before pushing, uses `--git-branch refs/worklog/data`
- `post-checkout` — auto-syncs after branch checkout; skips worktrees/temp worktrees
- `post-merge` — wrapper that delegates to `worklog-post-pull`
- `post-rewrite` — wrapper that delegates to `worklog-post-pull`
- `worklog-post-pull` — central sync script; skips worktrees/temp worktrees

All hooks skip sync when run inside a git worktree or a `tmp-worktree-*` temp worktree
(WL-0MS99Y6R40028Q9G).

See `src/doctor/hook-upgrade.ts` for the implementation.
