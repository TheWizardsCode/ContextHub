# Tutorial 2: Team Collaboration with Git Sync

**Target audience:** Team leads and developers sharing work items across a team
**Time to complete:** 15-20 minutes
**Prerequisites:** Worklog installed ([Tutorial 1](01-your-first-work-item.md)), Git configured with a remote repository

## What you will learn

By the end of this tutorial you will be able to:

- Share work items with teammates using `wl sync`
- Understand the JSONL sync model and conflict resolution
- Mirror work items to GitHub Issues
- Import changes from GitHub back into Worklog

## How Worklog data sharing works

Worklog stores data in a local SQLite database for fast reads and writes. To share data with your team, Worklog exports to a JSONL file and pushes it to a dedicated Git ref (`refs/worklog/data` by default). This ref is separate from your normal branches, so syncing never creates pull requests or clutters your commit history.

The flow looks like this:

```
You: local DB  -->  JSONL  -->  git push (refs/worklog/data)
                                     |
Team: git pull (refs/worklog/data)  -->  merge  -->  local DB
```

## Step 1: Set up two collaborators

For this tutorial, simulate two team members by creating two clones of the same repository:

```bash
# Alice's workspace
git clone https://github.com/your-org/your-project.git alice-workspace
cd alice-workspace
wl init
```

```bash
# Bob's workspace (in a separate terminal)
git clone https://github.com/your-org/your-project.git bob-workspace
cd bob-workspace
wl init
```

Both workspaces now have independent local databases pointing at the same remote.

## Step 2: Alice creates and syncs work items

In Alice's workspace:

```bash
# Create some work items
wl create -t "Design the API schema" -p high -a "Alice"
wl create -t "Write integration tests" -p medium -a "Bob"

# Push to the shared ref
wl sync
```

The `sync` command:

1. Pulls any existing data from the remote ref
2. Merges it with local changes
3. Pushes the combined result back

Alice should see output confirming the push succeeded.

## Step 3: Bob pulls the shared data

In Bob's workspace:

```bash
wl sync
```

Bob's local database now contains Alice's work items. Verify:

```bash
wl list
```

Both items should appear. Bob can now update his assigned item:

```bash
wl update <id> -s in-progress --stage in_progress
wl sync
```

## Step 4: Alice pulls Bob's updates

Back in Alice's workspace:

```bash
wl sync
wl show <id>
```

The item Bob updated should now show `in-progress` in Alice's workspace.

## Step 5: Handle concurrent edits

When Alice and Bob edit different items, sync merges cleanly. When they edit the same item, Worklog resolves conflicts by keeping the most recently updated version (last-write-wins on a per-item basis).

Example of a conflict scenario:

```bash
# Alice updates the title
wl update <id> -t "Design the REST API schema"

# Bob updates the same item's priority (before syncing)
wl update <id> -p critical

# Alice syncs first
wl sync

# Bob syncs -- Worklog merges both changes
wl sync
```

After both sync, the item will have Bob's priority (`critical`) and Alice's title (`Design the REST API schema`) because each field's latest timestamp wins.

## Step 6: Configure sync options

Sync behavior is configured in `.worklog/config.yaml`:

```yaml
# Auto-sync after every local write (off by default)
autoSync: false

# Git remote to sync with
syncRemote: origin

# Git ref for the JSONL data (default avoids GitHub PR noise)
syncBranch: refs/worklog/data
```

To enable auto-sync so changes are pushed immediately:

```bash
# Edit .worklog/config.yaml and set autoSync: true
```

Use `wl sync --dry-run` to preview what would be synced without making changes.

## Step 7: Mirror to GitHub Issues (optional)

Worklog can mirror work items to GitHub Issues for visibility outside the CLI:

### Push to GitHub

```bash
wl github push
```

This creates or updates GitHub Issues for each work item, adding labels like `wl:status:open`, `wl:priority:high`, and `wl:type:feature`. Parent/child relationships are preserved using GitHub sub-issues.

### Import from GitHub

```bash
wl github import
```

This pulls updates from GitHub Issues back into Worklog. If someone changes an issue title or closes it on GitHub, those changes are reflected locally after import.

### Import only recent changes

```bash
wl github import --since 2025-01-15T00:00:00Z
```

### Configure the GitHub repo

Set the target repository in `.worklog/config.yaml`:

```yaml
githubRepo: your-org/your-project
githubLabelPrefix: "wl:"
githubImportCreateNew: true
```

When `githubImportCreateNew` is `true`, `wl github import` will create new Worklog items for GitHub Issues that don't already have a Worklog marker.

## Recommended daily workflow

```bash
# Start of day: pull latest from your team
wl sync

# Work normally: create, update, comment
wl update <id> -s in-progress --stage in_progress
wl comment add <id> -c "Started implementation" -a "Your Name"

# End of day: push your changes
wl sync

# Optionally update GitHub Issues
wl github push
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `wl sync` shows no updates | Check that both clones point at the same remote with `git remote -v` |
| Push fails with permission error | Verify you have push access to the remote repository |
| GitHub push fails | Ensure `gh` CLI is installed and authenticated (`gh auth status`) |
| Stale data after sync | Run `wl sync` again -- the first run may only pull, and a second run pushes local changes |

## Summary

| Action | Command |
|--------|---------|
| Sync with team | `wl sync` |
| Preview sync | `wl sync --dry-run` |
| Push to GitHub | `wl github push` |
| Import from GitHub | `wl github import` |
| Import recent only | `wl github import --since <ISO date>` |

## Next steps

- [Building a CLI Plugin](03-building-a-plugin.md) -- extend Worklog with custom commands
- [Planning and Tracking an Epic](05-planning-an-epic.md) -- organize complex features
- [Data Syncing Reference](../../DATA_SYNCING.md) -- full sync documentation
