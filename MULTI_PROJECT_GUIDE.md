# Multi-Project Setup Example

This document demonstrates how to use Worklog with multiple projects, each with its own prefix.

## Setup

### Initialize Your Project

First, initialize your project configuration:

```bash
worklog init
```

When prompted:
- **Project name**: Enter your project name (e.g., "My Web App")
- **Issue ID prefix**: Enter a short prefix (e.g., "WEB", "API", "PROJ")

This creates a `.worklog/config.yaml` file with your local configuration and automatically syncs with the remote repository to pull any existing work items.

```yaml
projectName: My Web App
prefix: WEB
```

**Configuration System**: Worklog uses a two-tier configuration system:
- `.worklog/config.defaults.yaml` (if present): Team defaults, committed to version control
- `.worklog/config.yaml`: Your local overrides, not committed to version control

Values in `config.yaml` override those in `config.defaults.yaml`, allowing teams to share defaults while individuals can customize their setup.

## Using the Default Prefix

All CLI commands will use the prefix from your config by default:

```bash
# Create a work item - will use WEB prefix
worklog create -t "Add user authentication"

# Output: Created work item with id WEB-0J8L1JQ3H8ZQ2K6D
```

## Working with Multiple Projects

### Using CLI with Custom Prefix

You can override the default prefix for any command using the `--prefix` flag:

```bash
# Create work items for different projects
worklog create -t "API: Add login endpoint" --prefix API
worklog create -t "Frontend: Create login form" --prefix FRONT
worklog create -t "Backend: Setup database" --prefix BACK

# List items from a specific project
worklog list --prefix API

# Update items from different projects
worklog update API-0J8L1JQ3H8ZQ2K6D -s completed --prefix API
worklog update FRONT-0J8L1JQ3H8ZQ2K6D -s in-progress --prefix FRONT
```

### Using API with Custom Prefix

The API supports both legacy routes (using default prefix) and prefix-based routes:

#### Legacy Routes (use default prefix from config)

```bash
# Create item with default prefix
curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{"title": "Task with default prefix"}'

# Get all items
curl http://localhost:3000/items
```

#### Prefix-Based Routes

```bash
# Create item with API prefix
curl -X POST http://localhost:3000/projects/API/items \
  -H "Content-Type: application/json" \
  -d '{"title": "Add authentication endpoint"}'

# Get items for API project
curl http://localhost:3000/projects/API/items

# Create item with FRONT prefix
curl -X POST http://localhost:3000/projects/FRONT/items \
  -H "Content-Type: application/json" \
  -d '{"title": "Create login form"}'

# Get specific item
curl http://localhost:3000/projects/API/items/API-0J8L1JQ3H8ZQ2K6D

# Update item
curl -X PUT http://localhost:3000/projects/API/items/API-0J8L1JQ3H8ZQ2K6D \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

## Cross-repo dependencies

A dependency edge may target a work item that lives in **another project's**
store, so a consumer item is blocked mechanically by its upstream item instead
of by a prose note. The edge is recorded in *this* project's store; the foreign
target is only ever read — never written, synced or locked (see
[`CONFIG.md`](CONFIG.md#cross-repo-project-discovery-projectsroot)).

### Discovery rule

`wl` finds sibling projects by scanning a **projects root** — the
`projectsRoot` key in `.worklog/config.yaml`, defaulting to the parent
directory of the current checkout. Only the immediate subdirectories are
considered, and a candidate is a project only when it is:

- **not hidden** and a **git repository**, and
- holds a **genuine** worklog store — `.worklog/initialized` or
  `.worklog/worklog.db`.

A worktree-shaped stub (a checkout whose `.worklog/` holds only the tracked
`config.yaml`) is excluded, as are non-git and hidden folders. Each project's
prefix is read from its own `.worklog/config.yaml`, and the resulting
`prefix → path` map is sorted and memoised per process.

```sh
wl project list
wl --json project list
wl project list --projects-root /srv/checkouts
```

`project list --json` reports `projectsRoot`, a sorted `projects` array
(`prefix`, `path`, `ambiguous`) and any `warnings`. A missing or unreadable
projects root is a warning plus an empty list — never an error.

### Duplicate prefixes are ambiguous, never guessed

When two discovered projects declare the same prefix, the map cannot say which
store owns an id. Discovery reports the prefix with `ambiguous: true`,
`path: null` and both candidate paths, and `wl dep add` / `wl dep list` refuse
such an id non-zero instead of picking a store.

### Recording and listing foreign edges

`wl dep add`, `wl dep rm` and `wl dep list` accept ids from a discovered project
(`wl dep --help` states that foreign ids are supported):

```sh
wl dep add WL-CONSUMER SA-UPSTREAM        # a foreign id as the blocker
wl dep list WL-CONSUMER --json
wl dep rm WL-CONSUMER SA-UPSTREAM
```

The edge is stored locally, so `dep rm` needs no sibling store; the foreign
endpoint is resolved read-only only to validate it and read its
title/status/stage. The local dependent flips to `blocked` exactly as it does
for a same-project edge. A target that cannot be resolved is refused at
`dep add` time, so the `unresolved`/`unavailable` states below describe an edge
that resolved when it was recorded and whose sibling store has since gone away
(or arrived via an import). `dep list --json` marks foreign entries with
`foreign: true` and adds:

| Field | Meaning |
|---|---|
| `foreign_dependency` | `"resolved"`, `"unresolved"` or `"unavailable"` (below) |
| `unresolved` | `true` when the target could not be resolved and the edge keeps blocking |
| `blocking` | `true` when the edge currently blocks the dependent |
| `reason` | Why resolution failed; present only when it did |

### The three `foreign_dependency` states

| State | What it means | Blocks the dependent? |
|---|---|---|
| `resolved` | The owning project was discovered and the item was read from its store. | Only while the target is active (not `completed`/`deleted`, not in `in_review`/`done`) |
| `unresolved` | The project was found and its store opened, but it holds no such item. | **Yes** — fail-safe (`unresolved: true`) |
| `unavailable` | No project owns the prefix, the prefix is ambiguous, or the store could not be opened/read. | **Yes** when a project was discovered; **no** when no project owns the prefix (a non-blocking coordination note) |

### Fail-safe gating

Every path that evaluates blockers (`wl next`, `wl worklist`, `wl list`,
`wl dep list`, `wl doctor`) resolves a foreign target's status/stage from its
own store with the same terminal semantics as a local target. A store that
disappears, an unreadable database or an absent target **never silently
unblocks** the dependent: it stays blocked, `wl next` excludes it (include it
with `--include-blocked`) and `wl next --json` reports the edge on
`foreign_dependencies` with `unresolved: true` and a `reason`. `wl doctor`
reports the same edge as a `dependency.foreign-unresolved` finding.

An undiscoverable prefix is the one deliberate exception: with no project to
read, the edge is a coordination note and does not block, so a pre-existing
cross-prefix edge cannot stall work. `wl next --json` still reports it with
`foreign_dependency: "unavailable"`, plus the `unknown_project` remediation
fields below.

### Clone remediation for a missing project

When a dependency id's prefix belongs to no discovered project, `dep add` and
`dep list` exit non-zero with an actionable payload instead of a bare
`Work item not found`:

```json
{
  "success": false,
  "error_code": "unknown_project",
  "prefix": "GHOST",
  "projects_root": "/home/me/projects",
  "remediation": "Run `wl project add GHOST --git-url <url>` to clone the project into /home/me/projects, then retry."
}
```

Run the remediation with the missing project's git URL:

```sh
wl project add GHOST --git-url git@github.com:example/ghost.git
wl --json project add GHOST --git-url git@github.com:example/ghost.git --path /srv/checkouts/ghost
wl project add GHOST --interactive   # prompt for the URL (the only interactive path)
```

`wl project add` clones into the projects root (default
`<projectsRoot>/<prefix-lowercased>`), validates that the clone's
`.worklog/config.yaml` declares the requested prefix and records only the
`projects.<PREFIX>` mapping — every other config key is preserved. It is
idempotent: re-running against an existing correct clone reports
`"cloned": false` and re-records the same mapping. A prefix mismatch
(`prefix_mismatch`) or clone failure (`clone_failed`) exits non-zero, removes a
clone it just made and leaves **no** mapping behind. It never prompts for
credentials and never reads stdin unless `--interactive` is passed.

Discovery still requires a genuine store: a freshly cloned repository becomes
discoverable once it has a local `.worklog/worklog.db` (for example after
`wl sync` inside the clone). Then re-run the `dep` command that failed.

> Foreign items are never imported, exported or synced into this project —
> only dependency resolution reads a sibling store, and it does so read-only.

## Workflow Example

Here's a complete workflow using multiple projects:

```bash
# Initialize main project
worklog init
# Project name: WebApp
# Prefix: WEB

# Create main web app tasks
worklog create -t "Setup project structure"
worklog create -t "Create homepage"

# Create API tasks with custom prefix
worklog create -t "Design REST API" --prefix API
worklog create -t "Implement user endpoints" --prefix API

# Create mobile tasks with custom prefix
worklog create -t "Setup React Native" --prefix MOB
worklog create -t "Create login screen" --prefix MOB

# List all tasks (shows all prefixes)
worklog list

# List tasks for specific project
worklog list --prefix API

# Update status
worklog update WEB-0J8L1JQ3H8ZQ2K6D -s completed
worklog update API-0J8L1JQ3H8ZQ2K6D -s in-progress --prefix API
worklog update MOB-0J8L1JQ3H8ZQ2K6D -s completed --prefix MOB
```

## Best Practices

1. **Share Defaults**: If working in a team, commit `.worklog/config.defaults.yaml` to version control so team members share the same default prefix. Individual users can create their own `.worklog/config.yaml` to override values as needed.

2. **Consistent Prefixes**: Use short, meaningful prefixes:
   - `WEB` for web application
   - `API` for API services
   - `MOB` for mobile app
   - `DOC` for documentation
   - `TEST` for testing tasks

3. **Shared Data**: All items regardless of prefix are stored in the same `.worklog/worklog-data.jsonl` file, making it easy to track work across projects.

4. **Override When Needed**: Use `--prefix` flag only when you need to work with a different project temporarily. Most of the time, use the default prefix from config.

## Migrating Existing Data

Once work items exist, the project prefix cannot simply be hand-edited in
`.worklog/config.yaml`: `wl` treats any item whose ID prefix differs from the
configured one as *foreign* (`wl doctor foreign-items`), which breaks
cross-project lookups. Use the managed rename instead
(WL-0MVZ2U4E0003IVSZ):

```bash
# 1. Preview (default; read-only): counts per record type plus sample IDs
wl doctor prefix --to WEB

# 2. Apply — confirmation-gated (`--apply` prompts for `y`; `--confirm` for
#    non-interactive runs)
wl doctor prefix --to WEB --apply
wl doctor prefix --to WEB --confirm
```

The rename rewrites the `prefix:` entry in `.worklog/config.yaml` and every
ID-bearing record in the store in one transaction, preserving each item's
suffix (`WI-0J8L1JQ3H8ZQ2K6D` → `WEB-0J8L1JQ3H8ZQ2K6D`) — so the whole backlog
moves to the new prefix and there are no lingering old-prefix items. It also
writes `.worklog/prefix-rename-<timestamp>.json` mapping every old ID to its
new one. Re-running is an idempotent no-op; a mid-run failure rolls back and
leaves the store untouched. ID references held outside the store (code
comments, docs, test fixtures, commit messages, branch and worktree names) are
out of scope — sweep them with the rename map. See
[DOCTOR_AND_MIGRATIONS.md](DOCTOR_AND_MIGRATIONS.md#renaming-the-project-prefix-wl-doctor-prefix).
