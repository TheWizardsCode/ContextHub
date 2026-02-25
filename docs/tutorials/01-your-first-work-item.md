# Tutorial 1: Your First Work Item

**Target audience:** New users with no prior Worklog experience
**Time to complete:** 10-15 minutes
**Prerequisites:** Node.js (v18+) installed, a Git repository

## What you will learn

By the end of this tutorial you will be able to:

- Initialize Worklog in a project
- Create, view, and update work items
- Add comments to track progress
- Close work items with a reason

## Step 1: Install Worklog

Clone and build Worklog, then make the `wl` command available globally:

```bash
git clone https://github.com/rgardler-msft/Worklog.git
cd Worklog
npm install
npm run build
npm link
```

Verify the installation:

```bash
wl --version
```

You should see a version number printed to the terminal.

## Step 2: Initialize your project

Navigate to the Git repository where you want to track work, then run:

```bash
wl init
```

Worklog will prompt you for a project name and an ID prefix (e.g. `WI` or `PROJ`). Accept the defaults or choose your own. When asked about `AGENTS.md`, choose the option that suits your project.

After initialization you will have a `.worklog/` directory containing configuration and a local SQLite database. This directory is typically added to `.gitignore` since data is shared via `wl sync` rather than through direct file commits.

## Step 3: Create your first work item

```bash
wl create -t "Set up project README" -d "Draft an initial README with project description and setup instructions" -p medium
```

Worklog prints the new work item, including its ID (e.g. `WI-0ABC123`). Note this ID -- you will use it in the following steps.

To see it in a list:

```bash
wl list
```

You should see your new item with status `open` and priority `medium`.

## Step 4: View work item details

Use `show` with the ID from Step 3:

```bash
wl show <id>
```

This displays the full details: title, description, status, priority, timestamps, and any comments.

For additional detail use the `--format full` flag:

```bash
wl show <id> --format full
```

## Step 5: Update the work item

Mark the item as in-progress and assign it to yourself:

```bash
wl update <id> -s in-progress --stage in_progress -a "Your Name"
```

Verify the change:

```bash
wl show <id>
```

The status should now read `in-progress`, the stage `in_progress`, and the assignee should show your name.

### Change the priority

If the item becomes urgent, bump its priority:

```bash
wl update <id> -p high
```

## Step 6: Add a comment

Comments let you record progress, decisions, or context:

```bash
wl comment add <id> -c "Drafted the overview section, still need install steps" -a "Your Name"
```

View all comments on the item:

```bash
wl comment list <id>
```

Each comment gets its own ID (e.g. `WI-0ABC123-C1`) that you can use to update or delete it later.

## Step 7: Create a child work item

Break large tasks into subtasks using the `--parent` flag:

```bash
wl create -t "Write install instructions" -d "Add npm install and build steps to the README" -P <parent-id>
```

View the parent with its children:

```bash
wl show <parent-id> -c
```

You should see the child item listed under the parent.

## Step 8: Close the work items

Close the child first (parents cannot close while children are open):

```bash
wl close <child-id> -r "Install section written and reviewed"
```

Then close the parent:

```bash
wl close <parent-id> -r "README complete with all sections"
```

Verify both are closed:

```bash
wl list -s completed
```

Both items should appear with status `completed`.

## Step 9: See what to work on next

If you have more open items, Worklog can recommend the next one based on priority:

```bash
wl next
```

This shows the highest-priority open item that is not blocked by dependencies.

## Summary

You have learned the core Worklog workflow:

| Action | Command |
|--------|---------|
| Initialize | `wl init` |
| Create | `wl create -t "Title" -d "Description"` |
| List | `wl list` |
| View details | `wl show <id>` |
| Update | `wl update <id> -s <status>` |
| Comment | `wl comment add <id> -c "Text" -a "Author"` |
| Child items | `wl create -t "Title" -P <parent-id>` |
| Close | `wl close <id> -r "Reason"` |
| Next item | `wl next` |

## Next steps

- [Team Collaboration with Git Sync](02-team-collaboration.md) -- share work items with your team
- [Planning and Tracking an Epic](05-planning-an-epic.md) -- organize large features with dependencies
- [CLI Reference](../../CLI.md) -- full command documentation
