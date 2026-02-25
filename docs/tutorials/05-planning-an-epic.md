# Tutorial 5: Planning and Tracking an Epic

**Target audience:** Project leads managing complex multi-step features
**Time to complete:** 15-20 minutes
**Prerequisites:** Worklog installed ([Tutorial 1](01-your-first-work-item.md)), familiarity with creating and updating work items

## What you will learn

By the end of this tutorial you will be able to:

- Create an epic with child work items
- Use dependencies to control execution order
- Track progress through stages
- Use `wl next` to determine what to work on
- Close an epic when all children are complete

## Scenario

You are building a user authentication feature. This involves multiple tasks that need to be completed in a specific order. You will plan the entire feature as an epic, break it into tasks, set up dependencies, and track it to completion.

## Step 1: Create the epic

```bash
wl create \
  -t "User authentication system" \
  -d "Implement login, registration, and session management for the web application" \
  -p high \
  --issue-type epic
```

Note the epic's ID (e.g. `WI-0ABC001`). All child items will reference this ID.

## Step 2: Break it into child tasks

Create the individual tasks as children of the epic:

```bash
# Task 1: Database schema
wl create \
  -t "Design auth database schema" \
  -d "Create users table with email, password hash, and session fields" \
  -p high \
  --issue-type task \
  -P <epic-id>

# Task 2: Registration API
wl create \
  -t "Build registration endpoint" \
  -d "POST /api/register with email validation and password hashing" \
  -p high \
  --issue-type task \
  -P <epic-id>

# Task 3: Login API
wl create \
  -t "Build login endpoint" \
  -d "POST /api/login with credential verification and JWT token generation" \
  -p high \
  --issue-type task \
  -P <epic-id>

# Task 4: Frontend login form
wl create \
  -t "Create login page UI" \
  -d "Login form with email/password fields, error handling, and redirect" \
  -p medium \
  --issue-type task \
  -P <epic-id>

# Task 5: Integration tests
wl create \
  -t "Write auth integration tests" \
  -d "End-to-end tests for registration, login, and session flow" \
  -p medium \
  --issue-type task \
  -P <epic-id>
```

View the epic with all its children:

```bash
wl show <epic-id> -c
```

## Step 3: Set up dependencies

Some tasks must be completed before others can start. Use dependency edges to enforce this:

```bash
# Registration endpoint depends on the database schema
wl dep add <registration-id> <schema-id>

# Login endpoint depends on the database schema
wl dep add <login-id> <schema-id>

# Frontend login depends on the login endpoint
wl dep add <frontend-id> <login-id>

# Integration tests depend on both endpoints
wl dep add <tests-id> <registration-id>
wl dep add <tests-id> <login-id>
```

View the dependency graph for any item:

```bash
wl dep list <tests-id>
```

This shows both inbound dependencies (items this one depends on) and outbound dependencies (items that depend on this one).

## Step 4: Use `wl next` to find ready work

With dependencies in place, `wl next` automatically recommends work that is not blocked:

```bash
wl next
```

At this point, only "Design auth database schema" is ready because all other items depend on it (directly or transitively). Items blocked by unfinished dependencies are excluded by default.

### Get multiple recommendations

```bash
wl next -n 3
```

### Filter by assignee

```bash
wl next -a "Alice"
```

## Step 5: Track progress through stages

Use stages to indicate workflow progress. Start working on the schema task:

```bash
wl update <schema-id> -s in-progress --stage in_progress -a "Your Name"
```

Common stage progression:

| Stage | Meaning |
|-------|---------|
| `idea` | Identified but not yet analyzed |
| `intake_complete` | Requirements understood |
| `plan_complete` | Implementation planned |
| `in_progress` | Active development |
| `in_review` | Code review or QA |

Track what is currently in progress:

```bash
wl in-progress
```

## Step 6: Complete tasks and watch the epic progress

Close the schema task:

```bash
wl close <schema-id> -r "Schema migration applied and tested"
```

Now check what is unblocked:

```bash
wl next -n 3
```

Both the registration and login endpoints should now appear as ready work, since their dependency (the schema) is complete.

Continue working through the tasks:

```bash
# Start registration endpoint
wl update <registration-id> -s in-progress --stage in_progress

# ... implement ...

wl close <registration-id> -r "Registration endpoint implemented with validation"

# Start login endpoint
wl update <login-id> -s in-progress --stage in_progress

# ... implement ...

wl close <login-id> -r "Login endpoint with JWT generation complete"
```

After closing both endpoints, `wl next` will recommend the frontend and integration test tasks.

## Step 7: Close the epic

An epic cannot be closed while it has open children. After closing all child tasks:

```bash
wl close <frontend-id> -r "Login page UI complete with error handling"
wl close <tests-id> -r "All auth integration tests passing"
```

Now close the epic itself:

```bash
wl close <epic-id> -r "User authentication system fully implemented and tested"
```

Verify everything is complete:

```bash
wl show <epic-id> -c
```

All items should show status `completed`.

## Step 8: Use tags and search for organization

Add tags to categorize work items:

```bash
wl update <epic-id> --tags "auth,backend,q1-2026"
```

Search across all items:

```bash
wl search "authentication"
```

List items by tag:

```bash
wl list --tags "auth"
```

## Dependency management reference

| Command | Description |
|---------|-------------|
| `wl dep add <item> <depends-on>` | Item cannot start until depends-on is complete |
| `wl dep list <item>` | Show all dependencies for an item |
| `wl dep rm <item> <depends-on>` | Remove a dependency |
| `wl next` | Show highest-priority unblocked item |
| `wl next --include-blocked` | Show all items including blocked ones |

## Summary

| Action | Command |
|--------|---------|
| Create epic | `wl create -t "Title" --issue-type epic` |
| Add child task | `wl create -t "Task" -P <epic-id>` |
| Add dependency | `wl dep add <item> <depends-on>` |
| View dependencies | `wl dep list <item>` |
| Find ready work | `wl next` |
| Track progress | `wl in-progress` |
| View epic hierarchy | `wl show <epic-id> -c` |
| Close epic | `wl close <epic-id> -r "Reason"` |

## Next steps

- [Team Collaboration with Git Sync](02-team-collaboration.md) -- share your epic with the team
- [Using the TUI](04-using-the-tui.md) -- visualize epic hierarchy interactively
- [CLI Reference](../../CLI.md) -- full command documentation
