# Cross-Project Worklog Pollution Cleanup

This document explains the `wl doctor foreign-items` command — the tool used to
detect and remove work items whose ID prefix does not belong to the current
project. It is the canonical remediation mechanism for cross-project worklog
pollution (see WL-0MSAH2A71000MUA3).

## Background

A work item is **foreign** when the substring before the first `-` in its ID
does not match the project's configured prefix from `.worklog/config.yaml`
(e.g. `WL` for ContextHub, `SA` for SorraAgents, `CG` for Tableau-Card-Engine,
`OSL` for open_source_llm).

Historically, `wl sync` could merge one project's worklog into another
project's database and push it to the wrong project's remote ref
(`origin refs/worklog/data`), polluting project DBs and git refs. The root
cause was fixed (WL-0MSAH26DD001XXST) and the polluted DBs/refs were cleaned
(WL-0MSAH2A71000MUA3). This command is the repeatable mechanism for removing
any future contamination safely.

IDs without a `-` separator cannot be classified and are always left alone.

## Usage

### Dry-run (default; read-only)

```bash
# Report foreign items grouped by prefix, with counts and ID lists
wl doctor foreign-items --dry-run

# JSON output for scripting
wl doctor foreign-items --dry-run --json
```

The report includes:

- `totalItems` — items scanned
- `foreignCount` — items whose prefix does not match the project prefix
- `byPrefix` — counts and ID lists grouped by foreign prefix
- `deletedForeignCount` / `nonDeletedForeignCount` — deleted vs active split

Dry-run never modifies the database.

### Apply (destructive)

```bash
# Hard-delete every foreign item with full cascade
wl doctor foreign-items --apply
```

`--apply` removes each foreign item and everything attached to it:

- the work item row
- its comments
- dependency edges referencing it (fromId/toId)
- its `audit_results` row
- its FTS index entry

Own items are never touched. The JSON result reports before/after totals,
per-prefix removed counts, removed IDs, and any errors.

### Rewrite the remote ref (destructive)

```bash
# Clean the DB and rewrite the remote worklog ref with only own items
wl doctor foreign-items --apply --push
```

`--push` (which requires `--apply`) exports the post-cleanup DB to JSONL and
**rewrites** the project's remote worklog ref (`origin refs/worklog/data`, or
the configured `syncBranch`) so it contains only the project's own items. It:

1. creates a fresh orphan commit containing only the clean JSONL (bypassing
   the polluted remote history entirely — the remote ref is never fetched),
2. force-pushes it to the remote ref,
3. updates the local tracking ref
   (`refs/worklog/remotes/origin/worklog/data`) to match.

After the push, a subsequent `wl sync` pulls the clean ref and cannot
re-import foreign items. The push is serialized with the same file lock used
by `wl sync` to avoid clobbering concurrent activity.

`--push` without `--apply` is refused: rewriting the ref without cleaning the
DB would publish foreign items.

### Prefix override

```bash
# Classify against a different prefix (e.g. checking a WL- ref from an SA project)
wl doctor foreign-items --prefix WL
```

## Recommended workflow

1. **Scan** — `wl doctor foreign-items --dry-run --json` and record the foreign
   counts.
2. **Back up** — copy `.worklog/worklog.db` to a safe location.
3. **Apply** — `wl doctor foreign-items --apply` to remove foreign items from
   the DB.
4. **Push** — `wl doctor foreign-items --apply --push` to rewrite the remote
   ref (only after confirming the dry-run and applying).
5. **Verify** — re-run the dry-run (expect 0 foreign items) and
   `wl doctor prune --dry-run` (expect only own-prefix deleted items).

## Pollution-source sweep (2026-08-01)

The following were inspected during the original cleanup and found **not** to
be re-pollution sources:

- **herdr worklist auto-sync** (`packages/herdr/src/auto-sync.ts`) — now roots
  spawned `wl sync` at the tab project's working directory (fix in
  WL-0MSAH26DD001XXST), so a sync can no longer fetch another project's
  remote ref into this project's DB.
- **Agent skills scripts** (`~/.pi/agent/skills/`) — no hard-coded
  cross-project `--worklog-dir` paths. Where skills resolve a worklog
  directory, they derive it dynamically from the current working directory /
  git root (never another project's path).
- **`~/.pi/agent/skills/effort-and-risk/final-*.json`** — stale one-off output
  artifacts (recorded error messages), not referenced by any script.

### Documented out-of-scope items

- **`.worklog.bak/`** (ContextHub repo) — a stale backup with an older schema;
  its items use the `WL` prefix (the project's own), so it is not a pollution
  source. It is not a live worklog.
- **Vendored copies** (e.g. `open_source_llm/packages/ContextHub/.worklog`) —
  vendored ContextHub checkouts whose worklog uses prefix `WL` (own), not
  foreign. They are separate checkouts, not the host project's worklog.
- **Stale comment IDs** (e.g. a `WI-C0...` comment ID on an own item in
  Tableau-Card-Engine) — comments are attached data on own items, not foreign
  work items; removing them would delete legitimate history.

## Defense-in-depth: sync prefix filter (SA-0MSC0BM1V0032UYT)

On 2026-08-02 the SorraAgents worklog was **re-contaminated** with foreign
`WL-` items even though the repo-context guard (`assertDataFileInCwdRepo`,
WL-0MSAH26DD001XXST) had been deployed 55 minutes earlier. Investigation
showed the polluting sync ran **pre-fix code**: a process (or daemon) that
loaded modules before the guard was built, re-importing a stale pre-cleanup
snapshot. The repo-context guard is not enough against already-running
processes that never re-read the binary/source.

As defense-in-depth, `wl sync` now applies a **prefix filter at merge time**
(`filterRemoteDataByPrefix` in `src/sync.ts`): work items fetched from the
remote ref whose ID prefix does not match the project's configured prefix
(`--prefix`, or `.worklog/config.yaml` → `prefix`) are **never imported**, and
their comments, dependency edges and audit results are dropped with them. IDs
without a `-` separator are unclassifiable and are kept (matching
`wl doctor foreign-items`). The filter is the last line of defence: even a
sync that somehow reaches the merge step with a polluted remote snapshot
cannot re-import foreign items.

```bash
# A sync against a polluted remote ref logs/prints the dropped foreign items
wl sync
# e.g. "Foreign-prefix filter: dropped N remote item(s) not matching project prefix 'SA'"
```

## Daemon / long-running process restart procedure

Long-running `wl`-spawning processes keep whatever code they loaded at
startup — rebuilding `dist/` does **not** change them. After any `wl` upgrade
(especially guard/filter changes), restart or terminate them:

1. **Orphaned/test-harness processes** — terminate processes running
   worktree or deleted-worktree sources, e.g. `tsx <worktree>/src/cli.ts`:
   `ps aux | grep -E "tsx .*worktrees.*cli.ts|tsx src/cli.ts"` then kill the
   PIDs (they reparent to PID 1 and never exit on their own).
2. **herdr server + panes** — the server (and its panes) load the
   `worklog-selection-list` plugin from `packages/herdr` at startup. Restart
   so panes pick up current `auto-sync`/`fetcher` code:
   ```bash
   herdr server stop   # or: kill <herdr-server-pid>
   herdr server start
   ```
   > ⚠ Restarting the herdr server terminates every pane it hosts (including
   > active pi/agent sessions). Coordinate with operators before restarting.
3. **pi TUI Worklog extension** — the extension spawns the installed `wl` CLI
   per invocation, so no restart is needed for CLI-side fixes; only a `pi`
   restart reloads extension code itself.

After restart, verify with `wl sync --dry-run --no-push` (expect `itemsAdded=0`
and no "Foreign-prefix filter: dropped …" line for a clean project) and
`wl doctor foreign-items --dry-run` (expect 0 foreign).
