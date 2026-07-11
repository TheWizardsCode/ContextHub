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

If you have existing data with `WI` prefix and want to migrate to a new prefix:

1. Initialize config with your new prefix
2. Your existing `WI-*` items will continue to work
3. New items will use the new prefix
4. Both old and new items can coexist in the same database
