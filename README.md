# Worklog

A lightweight, Git-friendly issue tracker designed for AI agents and development teams. Track hierarchical work items with a CLI or REST API -- all backed by SQLite with JSONL-based Git syncing.

## Features

- **CLI + API**: Manage work items from the command line or a REST API
- **Git-Friendly Syncing**: JSONL format enables seamless team collaboration via Git with automatic conflict resolution
- **Hierarchical Work Items**: Parent-child relationships for organizing epics, features, and tasks
- **Plugin System**: Extend the CLI with custom commands (see [Plugin Guide](PLUGIN_GUIDE.md))
- **AI Agent Integration**: Pi agent plugin modules that auto-load into every session — activity indicator, session health, model/provider display, guardrails, error recovery (`/retry`), and skill-path tool (see [Pi extension](packages/tui/extensions/README.md)).
- **Heartbeat Skill**: Automated work item monitoring via the Pi agent — run `/skill:heartbeat` to flag items needing producer review or to audit completed items for closure readiness (see [skill/heartbeat/SKILL.md](skill/heartbeat/SKILL.md)).
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
wl github push          # add --verbose for a per-item synced list + timing breakdown
wl github import
```

### Pi agent plugin

The repository includes a Pi extension that auto-loads into every pi session
(via a global symlink under `~/.pi/agent/extensions`). It provides the
agent-side capabilities that complement the Herdr plugin: an activity
indicator and session health/model display in the pi footer, guardrails that
protect worklog database files, a `skill_path` tool, automatic error recovery
(`/retry`), and proactive Local Proxy model lease release. Work item browsing
and management is provided by the [Herdr plugin](packages/herdr/).

Install the extension globally:

```bash
npm run install:pi-extension
```

For a single-command install of all integrations (herdr plugin + Pi extension):

```bash
npm run install
```

Then start (or restart) `pi` and run:

```text
/reload
```

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
| [docs/design/incremental-sync.md](docs/design/incremental-sync.md) | Incremental (delta) sync architecture: delta format, full-snapshot cadence, fallback, backward compatibility (WL-0MSAKUBKW006FN8Q) |
| [GIT_WORKFLOW.md](GIT_WORKFLOW.md) | Team collaboration patterns and Git hooks |

### Features

| Document | Description |
|----------|-------------|
| [Heartbeat Skill](skill/heartbeat/SKILL.md) | Automated work item monitoring and audit orchestration for the Pi agent |
| [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md) | Plugin development guide and API reference |
| [LOCAL_LLM.md](LOCAL_LLM.md) | Configure local LLM providers (Ollama, Foundry) |
| [MULTI_PROJECT_GUIDE.md](MULTI_PROJECT_GUIDE.md) | Multi-project setup with custom prefixes |
| [API.md](API.md) | REST API endpoints and usage |
| [docs/FILE_PATH_CONVENTION.md](docs/FILE_PATH_CONVENTION.md) | File path convention for work item descriptions |
| [docs/CROSS_PROJECT_POLLUTION_CLEANUP.md](docs/CROSS_PROJECT_POLLUTION_CLEANUP.md) | Detecting and removing cross-project worklog pollution (`wl doctor foreign-items`) |
| [docs/SYNC_IDENTITY_GATE.md](docs/SYNC_IDENTITY_GATE.md) | Refusing foreign/empty-author commits on sync (`--allow-foreign-author`, polluted-ref recovery) |
| [docs/AGENTS-INSTALL.md](docs/AGENTS-INSTALL.md) | How `wl init` installs AGENTS.md / workflow guidance and how local rules relate to the global agent file |

### Reference

| Document | Description |
|----------|-------------|
| [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) | Architecture overview and file structure |
| [MIGRATING_FROM_BEADS.md](MIGRATING_FROM_BEADS.md) | Migration guide from Beads issue tracker |
| [AGENTS.md](AGENTS.md) | AI agent onboarding and workflow instructions |
| [tests/README.md](tests/README.md) | Test suite documentation |
| [examples/README.md](examples/README.md) | Example plugins |
 | [OpenBrain Integration](docs/openbrain.md) | Documentation for the optional OpenBrain submission integration |

### Internal / Development

| Document | Description |
|----------|-------------|
| [docs/opencode-to-pi-migration.md](docs/opencode-to-pi-migration.md) | Migration guide from OpenCode to Pi framework |
| [docs/migrations.md](docs/migrations.md) | Database migration system |
| [docs/prd/sort_order_PRD.md](docs/prd/sort_order_PRD.md) | Sort order product requirements |
| [docs/validation/status-stage-inventory.md](docs/validation/status-stage-inventory.md) | Status/stage validation rules |
| [docs/SKILL_AUTHORING.md](docs/SKILL_AUTHORING.md) | Skill authoring guide with script best practices |
| [docs/dev/wl-process-healthcheck.md](docs/dev/wl-process-healthcheck.md) | wl process healthcheck watchdog usage (cron/systemd, thresholds) |
| [docs/dev/downtime-dispatcher.md](docs/dev/downtime-dispatcher.md) | Leader-election + shared-coordination downtime dispatcher architecture (herdr); critical-first dispatch tier + freeze split-by-skill |

## Tutorials

Step-by-step guides for learning Worklog:

| Tutorial | Audience | Description |
|----------|----------|-------------|
| [Your First Work Item](docs/tutorials/01-your-first-work-item.md) | New users | Install, init, create, update, and close work items |
| [Team Collaboration](docs/tutorials/02-team-collaboration.md) | Team leads | Git sync, GitHub mirroring, multi-user workflow |
| [Building a Plugin](docs/tutorials/03-building-a-plugin.md) | Developers | Plugin API, database access, testing |
| [Planning an Epic](docs/tutorials/05-planning-an-epic.md) | Project leads | Epics, child items, dependencies, wl next |

See [docs/tutorials/README.md](docs/tutorials/README.md) for the full tutorial index.

## Shell Completion

Worklog ships with shell completion scripts for **bash** and **zsh**. The `wl completion` command generates a completion script that provides tab-completion for all subcommands, options, and dynamic work-item IDs.

### Bash

```bash
# Source directly (current shell only)
source <(wl completion bash)

# Permanent installation
wl completion bash > ~/.wl-completion.bash
echo "source ~/.wl-completion.bash" >> ~/.bashrc
```

### Zsh

```zsh
# Source directly (current shell only)
source <(wl completion zsh)

# Permanent installation
wl completion zsh > ~/.wl-completion.zsh
echo "source ~/.wl-completion.zsh" >> ~/.zshrc
```

> **Note:** Dynamic work-item ID completion (e.g., `wl show <TAB>`) calls `wl list --json` in the background to fetch open work items. This may add a slight delay on first tab press in large repositories.

## Development

```bash
npm run build         # Build the project
npm run dev           # Development mode with auto-reload
npm test              # Run all tests
npm run test:watch    # Tests in watch mode
npm run test:coverage # Tests with coverage report
```

### Vitest Configuration

The project uses [Vitest](https://vitest.dev/) with the following settings in `vitest.config.ts`:

- **Pool:** `'forks'` (child processes) — supports tests that use `process.chdir()` for temp directory setup
- **maxWorkers:** `4` — limits concurrent worker count to prevent unbounded memory growth during test execution
- **Exclusions:** Worktree directories (`.worklog/worktrees/**`) are excluded to prevent duplicate test file discovery

See [tests/README.md](tests/README.md) for detailed testing documentation.

### Test Mock Patterns

Work item tests under `tests/cli/` and `tests/unit/` demonstrate the mock
patterns used by this project:

- **Comprehensive `node:fs` mock:** Rather than stubbing only the few fs functions used directly by the code under test, the mock covers the broader set that may be called during module initialization, preventing cascading errors and heap OOM during import.
- **Stale-import grep guard:** `tests/unit/icons.test.ts` fails the build if any file imports from the removed `icons.js` wrapper paths, preventing the deprecated `icons.ts` files from drifting back in.
- **Infinite loop guard:** `custom()` mocks return a terminating shortcut instead of `null` to break long-running TUI loops, preventing infinite-loop-based OOM in test mocks.

## License

MIT
