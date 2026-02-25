# Data Format

Work items and comments are stored in JSONL (JSON Lines) format, with each line representing one item. This format is Git-friendly as changes to individual items create minimal diffs.

## Storage Architecture

Worklog uses a **dual-storage model** to combine the benefits of persistent databases and Git-friendly text files:

### SQLite Database (`.worklog/worklog.db`)

- Primary runtime storage
- Persists across CLI and API executions
- Fast queries and transactions
- Located in `.worklog/worklog.db` (not committed to Git)

### JSONL Export (`.worklog/worklog-data.jsonl`)

- Git-friendly text format (one JSON object per line)
- Automatically exported and backed up to Git (in a Ref branch) on every push
- Used for collaboration via Git (pull/push)
- Located in `.worklog/worklog-data.jsonl` (not committed to Git)

## How It Works

**On Startup (CLI or API)**:

- Database connects to persistent SQLite file
- Checks if JSONL file is newer than database's last import
- If JSONL is newer (e.g., after `git pull`), automatically refreshes database from JSONL
- If database is empty and JSONL exists, imports from JSONL

**On Write Operations** (create/update/delete):

- Changes saved to database immediately
- Database automatically exports current state to JSONL
- If auto-sync is enabled, Worklog pushes updates to the git data ref automatically

## Source of Truth Model

- **Database**: Runtime source of truth for CLI and API operations
- **JSONL**: Import/export boundary for Git workflows
- If auto-sync is enabled, the git JSONL ref acts as the team-wide canonical source

## Work Item Structure

```json
{
  "id": "WI-0J8L1JQ3H8ZQ2K6D",
  "title": "Example task",
  "description": "Task description",
  "status": "open",
  "priority": "medium",
  "parentId": null,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "tags": ["feature", "backend"],
  "assignee": "john.doe",
  "stage": "development"
}
```

### Work Item Fields

- **id**: Unique identifier (auto-generated)
- **title**: Short title of the work item
- **description**: Detailed description
- **status**: `open`, `in-progress`, `completed`, `blocked`, or `deleted`
- **priority**: `low`, `medium`, `high`, or `critical`
- **parentId**: ID of parent work item (null for root items)
- **createdAt**: ISO timestamp of creation
- **updatedAt**: ISO timestamp of last update
- **tags**: Array of string tags
- **assignee**: Person assigned to the work item
- **stage**: Current stage of the work item in the workflow
- **issueType**: Optional interoperability field for imported issue types
- **createdBy**: Optional interoperability field for imported creator/actor
- **deletedBy**: Optional interoperability field for imported deleter/actor
- **deleteReason**: Optional interoperability field for imported deletion reason

## Comment Structure

```json
{
  "id": "WI-C0J8L1JQ3H8ZQ2K6F",
  "workItemId": "WI-0J8L1JQ3H8ZQ2K6D",
  "author": "Jane Doe",
  "comment": "This is a comment with **markdown** support!",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "references": [
    "WI-0J8L1JQ3H8ZQ2K6E",
    "src/api.ts",
    "https://example.com/docs"
  ]
}
```

### Comment Fields

- **id**: Unique identifier (auto-generated, format: `PREFIX-C<unique>`)
- **workItemId**: ID of the work item this comment belongs to
- **author**: Name of the comment author (freeform string)
- **comment**: Comment text in markdown format
- **createdAt**: ISO timestamp of creation
- **references**: Array of references (work item IDs, relative file paths, or URLs)

## Git Workflow

The JSONL format enables team collaboration:

```bash
# Pull latest changes from team
git pull

# Your next CLI/API call automatically refreshes from the updated JSONL
wl list

# Make changes
wl create -t "New task"

# JSONL is automatically updated, commit and push
git add .worklog/worklog-data.jsonl
git commit -m "Add new task"
git push
```

The `sync` command provides automated Git workflow:

```bash
# Pull, merge, and push in one command
wl sync

# Dry run to preview changes
wl sync --dry-run

# Diagnostics for troubleshooting sync setup
wl sync debug
wl --json sync debug
```

See [DATA_SYNCING.md](DATA_SYNCING.md) for full sync workflow details and [GIT_WORKFLOW.md](GIT_WORKFLOW.md) for team collaboration patterns.
