# Data Syncing

This document describes the two syncing workflows and how Worklog uses its local database. Together they enable shared Worklog files across a team and optional community engagement via GitHub Issues:

- Git-backed JSONL syncing (canonical data ref)
- GitHub Issues mirroring (optional)

Both workflows can be used independently. The Git-backed workflow is the canonical source of truth for Worklog data.

## Quickstart

```bash
wl sync # Sync local changes to the canonical JSONL ref
wl gh push # OPTIONAL: Mirror Worklog items to GitHub Issues
wl gh import # OPTIONAL: Pull GitHub Issue updates back into Worklog
```

## Why Worklog Uses a Local Database

Worklog keeps a local SQLite database as the runtime source of truth so reads and writes are fast and resilient even when git or GitHub are unavailable. The JSONL file is the sync boundary (import/export format) and is regenerated from the database after writes or merges. When this document says "syncing" it refers to keeping the JSONL snapshot aligned with the database and the canonical git ref, while "GitHub sync" refers to mirroring that same JSONL-backed data into GitHub Issues.

## Git-Backed Syncing (Canonical JSONL)

Worklog stores work items and comments in `.worklog/worklog-data.jsonl` (the most recent local snapshot). The authoritative, shared copy lives on a Git ref (by default `refs/worklog/data`) to avoid normal PR noise. Until you run `wl sync`, your local JSONL reflects only local changes and is not the team-wide source of truth. In fact, it is ignored by Git and is only ever shared with the team via the sync command.

### Core Commands

- `wl sync`
  - Pulls the remote JSONL ref
  - Merges with local data (conflict resolution)
  - Writes local DB + JSONL
  - Pushes the updated JSONL ref

### Typical Flow

1. Update local items (`wl create`, `wl update`, etc.)
2. Run `wl sync` to publish changes
3. Teammates run `wl sync` to pull the canonical updates

### Auto-Sync

If `autoSync` is enabled, Worklog runs `wl sync` in the background after each local write (debounced). This keeps the canonical ref up to date without manual sync.
Auto-sync is off by default to avoid unexpected git operations during local edits and to let teams choose when to publish shared data.

### Config Options

Set in `.worklog/config.yaml` (local) or `.worklog/config.defaults.yaml` (team defaults):

- `autoSync` (boolean, default false)
  - Auto-push changes to the canonical Git ref after local writes
- `syncRemote` (string, default `origin`)
  - Git remote used for sync
- `syncBranch` (string, default `refs/worklog/data`)
  - Git ref used for the canonical JSONL file

### Troubleshooting

- If `wl sync` shows no updates but you expected changes, confirm your local JSONL is up to date and the correct ref is used.
- If you want to preview a sync without changes, use `wl sync --dry-run`.

## GitHub Issues Mirroring (Optional)

Worklog can mirror items to GitHub Issues and import updates back. This GitHub sync reads from the local JSONL/database and updates Issues; it is separate from the git-backed JSONL sync above.

### Core Commands

- `wl github push` (alias: `wl gh push`)
  - Pushes local Worklog items to GitHub Issues
  - Adds/updates issue titles, bodies, and labels
  - Ensures a `<!-- worklog:id=... -->` marker in the body
  - Links parent/child items using GitHub sub-issues (when enabled)

- `wl github import` (alias: `wl gh import`)
  - Imports changes from GitHub Issues into Worklog
  - Updates existing Worklog items with GitHub changes
  - Optionally creates new Worklog items for unmarked issues
  - Pulls parent/child relationships from GitHub sub-issues

### Status Label Behavior

Worklog uses `wl:status:<status>` labels to represent status. Only one status label is kept on an issue at a time.

### Field Label Mapping

Worklog syncs work item fields to GitHub as labels with the configured prefix (default `wl:`):

- **Status**: `wl:status:<status>` (e.g., `wl:status:open`, `wl:status:in-progress`)
- **Priority**: `wl:priority:<priority>` (e.g., `wl:priority:high`, `wl:priority:medium`)
- **Risk**: `wl:risk:<level>` (e.g., `wl:risk:High`, `wl:risk:Medium`, `wl:risk:Low`, `wl:risk:Severe`)
- **Effort**: `wl:effort:<level>` (e.g., `wl:effort:XS`, `wl:effort:S`, `wl:effort:M`, `wl:effort:L`, `wl:effort:XL`)
- **Stage**: `wl:stage:<stage>` (if set)
- **Issue Type**: `wl:type:<issueType>` (if set)
- **Tags**: `wl:tag:<tag>` for each tag

### Hierarchy (Parent/Child)

- Worklog uses GitHub's sub-issue relationships to keep parent/child structure in sync.
- On `wl gh push`, parent/child links are created or verified via the GitHub GraphQL API.
- On `wl gh import`, parent/child links are read from GitHub and mapped to Worklog `parentId` values.

### Closed Issues

- Worklog does not create new items from closed issues.
- If an existing mapped GitHub issue is closed, Worklog marks the corresponding item as `completed`.

### Config Options

Set in `.worklog/config.yaml` (local) or `.worklog/config.defaults.yaml` (team defaults):

- `githubRepo` (string, e.g. `owner/name`)
  - Repo used for GitHub mirroring
- `githubLabelPrefix` (string, default `wl:`)
  - Prefix for Worklog labels
- `githubImportCreateNew` (boolean, default true)
  - When true, `wl github import` creates Worklog items from unmarked issues

### Recommended Flow

1. Ensure canonical JSONL is up to date: `wl sync`
2. Push to GitHub Issues: `wl gh push`
3. Later, import GitHub updates: `wl gh import`

### Troubleshooting

- If `wl gh push` reports errors, re-run with `--json` for detailed failures.
- If the GitHub CLI is older, label creation uses `gh api` or `gh issue label create`.

## Examples

```bash
# Sync Worklog JSONL with git
wl sync

# Push Worklog items to GitHub Issues
wl gh push

# Import GitHub Issue updates
wl gh import

# Import only issues updated since a timestamp
wl gh import --since 2024-01-01T00:00:00Z
```
