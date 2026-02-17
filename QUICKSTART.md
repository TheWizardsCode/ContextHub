# Quick Start Guide

Get started with Worklog in 5 minutes!

## Installation

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Install CLI globally (optional, for easier access)
npm install -g .
# or for development
npm link
```

You can run `wl init` in unattended mode by supplying all required values on the command line:

```bash
wl init --project-name "My Project" --prefix PROJ --auto-export yes --auto-sync no --agents-template append --workflow-inline yes --stats-plugin-overwrite no
```

Passing `--workflow-inline yes` selects the basic workflow option. Use `--workflow-inline no` to skip workflow setup.

`--agents-template append` inserts the global `AGENTS.md` pointer line at the top of your local `AGENTS.md` while preserving existing content.

**Note:** After installing globally, you can use `worklog` or `wl` commands directly. If you skip the global install, use `npm run cli -- <command>` for development.

## Your First Work Item

### Using CLI

```bash
# Create your first work item
worklog create -t "My first task" -d "Let's get started!"

# See it in the list
worklog list

# Update its status
worklog update WI-0J8L1JQ3H8ZQ2K6D -s in-progress

# Mark it complete
worklog update WI-0J8L1JQ3H8ZQ2K6D -s completed
```

### Using the API

```bash
# Terminal 1: Start the server
npm start

# Terminal 2: Create a work item
curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{
    "title": "API test",
    "status": "open",
    "priority": "medium"
  }'

# List all items
curl http://localhost:3000/items | jq
```

## Creating a Project Hierarchy

```bash
# Create an epic
worklog create -t "Build MVP" -p critical

# Add features under it
worklog create -t "User registration" -P WI-0J8L1JQ3H8ZQ2K6D -p high
worklog create -t "User login" -P WI-0J8L1JQ3H8ZQ2K6D -p high

# Add tasks under features
worklog create -t "Design login form" -P WI-0J8L1JQ3H8ZQ2K6E -p medium
worklog create -t "Implement auth API" -P WI-0J8L1JQ3H8ZQ2K6E -p high

# View the hierarchy
worklog show WI-0J8L1JQ3H8ZQ2K6D -c
```

## Working with Git

```bash
# Your work items are automatically saved to .worklog/worklog-data.jsonl

# Add to Git
git add .worklog/worklog-data.jsonl
git commit -m "Add project tasks"
git push

# Team members can pull and see your work items
git pull
worklog list
```

## Common Commands

```bash
# List all open tasks
worklog list -s open

# List high priority items
worklog list -p high

# Show root items only (no parent)
worklog list -P null

# View a specific item with its children
worklog show WI-0J8L1JQ3H8ZQ2K6D -c

# Update multiple fields
worklog update WI-0J8L1JQ3H8ZQ2K6D -s completed -d "All done!"

# Delete a work item
worklog delete WI-0J8L1JQ3H8ZQ2K6E

# Toggle needs-producer-review flag
worklog reviewed WI-0J8L1JQ3H8ZQ2K6E
# Set needs-producer-review flag explicitly
worklog reviewed WI-0J8L1JQ3H8ZQ2K6E true

# Export to backup
worklog export -f backup.jsonl

# Import from backup
worklog import -f backup.jsonl
```

## Next Steps

- Read [README.md](README.md) for complete documentation
- Check [EXAMPLES.md](EXAMPLES.md) for more usage examples
- See [GIT_WORKFLOW.md](GIT_WORKFLOW.md) for team collaboration patterns

## Tips

1. **Start Simple**: Create a few tasks and get comfortable with the CLI
2. **Commit Often**: Keep your work items in sync with Git
3. **Tag Everything**: Use tags to organize and filter (`--tags "urgent,bug"`)
4. **Leverage Hierarchy**: Use parent-child relationships for better organization

Happy tracking! 🚀
