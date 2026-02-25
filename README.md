# Worklog

A lightweight, Git-friendly issue tracker designed for AI agents and development teams. Track hierarchical work items with a CLI, interactive TUI, or REST API -- all backed by SQLite with JSONL-based Git syncing.

## Features

- **CLI + TUI + API**: Manage work items from the command line, an interactive terminal UI, or a REST API
- **Git-Friendly Syncing**: JSONL format enables seamless team collaboration via Git with automatic conflict resolution
- **Hierarchical Work Items**: Parent-child relationships for organizing epics, features, and tasks
- **Plugin System**: Extend the CLI with custom commands (see [Plugin Guide](PLUGIN_GUIDE.md))
- **AI Agent Integration**: Built-in OpenCode assistant with real-time streaming and interactive input
- **Multi-Project Support**: Custom prefixes for issue IDs per project

## Installation

```bash
npm install
npm run build
npm link       # or: npm install -g .
```

After installing, `worklog` and `wl` are available globally. For development without global install, use `npm run cli -- <command>`.

## Quick Start

```bash
# Initialize your project
wl init

# Create your first work item
wl create -t "My first task" -d "Let's get started!"

# See it in the list
wl list

# Update its status
wl update <id> -s in-progress

# Add a comment
wl comment add <id> -c "Making progress" -a "Your Name"

# Mark it complete
wl update <id> -s completed

# View hierarchy (create children with -P <parent-id>)
wl create -t "Sub-task" -P <parent-id>
wl show <parent-id> -c
```

### Working with Your Team

```bash
# Sync work items via Git (pull, merge, push)
wl sync

# Mirror to GitHub Issues (optional)
wl github push
wl github import
```

### Using the TUI

```bash
wl tui                # Interactive tree view of all items
wl tui --in-progress  # Show only in-progress items
```

Press `O` in the TUI to access the built-in OpenCode AI assistant. See [TUI.md](TUI.md) for controls.

### Customizing Your Workflow

You can get a lot of value from using Worklog as a memory for your agents. But you can go further by building a personal workflow. Worklog brings a minimal workflow installed via `wl init`, and you can customize it in your `AGENTS.md`. For inspiration, see the [Sorra Agents Repository](https://github.com/sorratheorc/sorraagents).

## Documentation

### Getting Started

| Document | Description |
|----------|-------------|
| [CONFIG.md](CONFIG.md) | Configuration system, `wl init`, and setup options |
| [CLI.md](CLI.md) | Complete CLI command reference |
| [EXAMPLES.md](EXAMPLES.md) | Practical usage examples |

### Core Concepts

| Document | Description |
|----------|-------------|
| [DATA_FORMAT.md](DATA_FORMAT.md) | JSONL data format, storage architecture, and field reference |
| [DATA_SYNCING.md](DATA_SYNCING.md) | Git-backed syncing and GitHub Issue mirroring |
| [GIT_WORKFLOW.md](GIT_WORKFLOW.md) | Team collaboration patterns and Git hooks |

### Features

| Document | Description |
|----------|-------------|
| [TUI.md](TUI.md) | Interactive terminal UI controls and features |
| [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md) | Plugin development guide and API reference |
| [LOCAL_LLM.md](LOCAL_LLM.md) | Configure local LLM providers (Ollama, Foundry) |
| [MULTI_PROJECT_GUIDE.md](MULTI_PROJECT_GUIDE.md) | Multi-project setup with custom prefixes |
| [API.md](API.md) | REST API endpoints and usage |

### Reference

| Document | Description |
|----------|-------------|
| [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) | Architecture overview and file structure |
| [MIGRATING_FROM_BEADS.md](MIGRATING_FROM_BEADS.md) | Migration guide from Beads issue tracker |
| [AGENTS.md](AGENTS.md) | AI agent onboarding and workflow instructions |
| [tests/README.md](tests/README.md) | Test suite documentation |
| [examples/README.md](examples/README.md) | Example plugins |

### Internal / Development

| Document | Description |
|----------|-------------|
| [docs/opencode-tui.md](docs/opencode-tui.md) | OpenCode TUI integration details |
| [docs/tui-ci.md](docs/tui-ci.md) | Headless TUI testing for CI |
| [docs/migrations.md](docs/migrations.md) | Database migration system |
| [docs/prd/sort_order_PRD.md](docs/prd/sort_order_PRD.md) | Sort order product requirements |
| [docs/validation/status-stage-inventory.md](docs/validation/status-stage-inventory.md) | Status/stage validation rules |

## Tutorials

Step-by-step guides for learning Worklog:

| Tutorial | Audience | Description |
|----------|----------|-------------|
| [Your First Work Item](docs/tutorials/01-your-first-work-item.md) | New users | Install, init, create, update, and close work items |
| [Team Collaboration](docs/tutorials/02-team-collaboration.md) | Team leads | Git sync, GitHub mirroring, multi-user workflow |
| [Building a Plugin](docs/tutorials/03-building-a-plugin.md) | Developers | Plugin API, database access, testing |
| [Using the TUI](docs/tutorials/04-using-the-tui.md) | Any user | Interactive tree view, keyboard shortcuts, OpenCode AI |
| [Planning an Epic](docs/tutorials/05-planning-an-epic.md) | Project leads | Epics, child items, dependencies, wl next |

See [docs/tutorials/README.md](docs/tutorials/README.md) for the full tutorial index.

## Development

```bash
npm run build         # Build the project
npm run dev           # Development mode with auto-reload
npm test              # Run all tests
npm run test:watch    # Tests in watch mode
npm run test:coverage # Tests with coverage report
npm run test:tui      # TUI tests only (CI/headless)
```

See [tests/README.md](tests/README.md) for detailed testing documentation.

## License

MIT
