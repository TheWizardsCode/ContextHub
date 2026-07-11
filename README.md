# Worklog

A lightweight, Git-friendly issue tracker designed for AI agents and development teams. Track hierarchical work items with a CLI, interactive TUI, or REST API -- all backed by SQLite with JSONL-based Git syncing.

## Features

- **CLI + TUI + API**: Manage work items from the command line, an interactive terminal UI, or a REST API
- **Git-Friendly Syncing**: JSONL format enables seamless team collaboration via Git with automatic conflict resolution
- **Hierarchical Work Items**: Parent-child relationships for organizing epics, features, and tasks
- **Plugin System**: Extend the CLI with custom commands (see [Plugin Guide](PLUGIN_GUIDE.md))
- **AI Agent Integration**: Built-in Pi agent with real-time streaming, interactive agent chat pane, and agent-driven action palette.
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
wl tui                # Launch Pi-based TUI (interactive browse + agent chat)
wl tui --in-progress  # Launch Pi-based TUI, show only in-progress items
wl tui --perf         # Enable performance instrumentation and write diagnostics artifacts under .worklog/
wl tui --perf         # Launch Pi-based TUI with performance instrumentation
```

Press `O` in the TUI to access the Pi agent chat pane. The Pi-based TUI provides natural language chat, an action palette with agent-driven flows, and all work item operations through the `wl` CLI. See [TUI.md](TUI.md) for controls, including quick stage filters (`Alt+T` for `intake_complete`, `Alt+P` for `plan_complete`) that exclude closed items.

For the Pi-based TUI design checklist, see [docs/ux/design-checklist.md](docs/ux/design-checklist.md).

For freeze triage and profiling details (including `TUI_CHORD_DEBUG`, `strace`, and artifact locations), see [docs/TUI_PROFILING.md](docs/TUI_PROFILING.md).

### Install the Pi Worklog browse extension

The repository includes a Pi extension that adds a Worklog browse flow (`/wl` and `Ctrl+Shift+B`) which lists the next 5 recommended work items (`wl next -n 5`) and previews the selected item in a widget above the editor as selection changes (`title <id>`, `Priority/Stage/Status`, `Risk/Effort`, and the first 7 description lines). Pressing Enter on a selected item opens a focused scrollable detail view backed by `wl show <id> --format markdown`, with keyboard navigation support for Up/Down, PageUp/PageDown, Space, `g` (top), `G` (bottom), and `Esc` (close).

Install it globally by creating a symlink under `~/.pi/agent/extensions`:

```bash
npm run install:pi-extension
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
| [GIT_WORKFLOW.md](GIT_WORKFLOW.md) | Team collaboration patterns and Git hooks |

### Features

| Document | Description |
|----------|-------------|
| [TUI.md](TUI.md) | Interactive terminal UI controls and features |
| [PLUGIN_GUIDE.md](PLUGIN_GUIDE.md) | Plugin development guide and API reference |
| [LOCAL_LLM.md](LOCAL_LLM.md) | Configure local LLM providers (Ollama, Foundry) |
| [MULTI_PROJECT_GUIDE.md](MULTI_PROJECT_GUIDE.md) | Multi-project setup with custom prefixes |
| [API.md](API.md) | REST API endpoints and usage |
| [docs/FILE_PATH_CONVENTION.md](docs/FILE_PATH_CONVENTION.md) | File path convention for work item descriptions |

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
| [docs/ux/design-checklist.md](docs/ux/design-checklist.md) | Pi-based TUI design checklist |
| [docs/tui-ci.md](docs/tui-ci.md) | Headless TUI testing for CI |
| [docs/migrations.md](docs/migrations.md) | Database migration system |
| [docs/prd/sort_order_PRD.md](docs/prd/sort_order_PRD.md) | Sort order product requirements |
| [docs/validation/status-stage-inventory.md](docs/validation/status-stage-inventory.md) | Status/stage validation rules |
| [docs/SKILL_AUTHORING.md](docs/SKILL_AUTHORING.md) | Skill authoring guide with script best practices |

## Tutorials

Step-by-step guides for learning Worklog:

| Tutorial | Audience | Description |
|----------|----------|-------------|
| [Your First Work Item](docs/tutorials/01-your-first-work-item.md) | New users | Install, init, create, update, and close work items |
| [Team Collaboration](docs/tutorials/02-team-collaboration.md) | Team leads | Git sync, GitHub mirroring, multi-user workflow |
| [Building a Plugin](docs/tutorials/03-building-a-plugin.md) | Developers | Plugin API, database access, testing |
| [Using the TUI](docs/tutorials/04-using-the-tui.md) | Any user | Interactive tree view, keyboard shortcuts, Pi agent chat, action palette |
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
npm run test:tui      # TUI tests only (CI/headless)
```

### Vitest Configuration

The project uses [Vitest](https://vitest.dev/) with the following settings in `vitest.config.ts`:

- **Pool:** `'forks'` (child processes) — supports tests that use `process.chdir()` for temp directory setup
- **maxWorkers:** `4` — limits concurrent worker count to prevent unbounded memory growth during test execution
- **Exclusions:** Worktree directories (`.worklog/worktrees/**`) are excluded to prevent duplicate test file discovery

See [tests/README.md](tests/README.md) for detailed testing documentation.

### Test Mock Patterns

The `tests/extensions/worklog-browse-extension.test.ts` file (1700+ lines, 68 tests) demonstrates key mock patterns used by this project:

- **Comprehensive `node:fs` mock:** Rather than stubbing only the 4 fs functions used directly by the code under test, the mock covers ~12 functions (`existsSync`, `statSync`, `lstatSync`, `readdirSync`, `accessSync`, `watch`, `promises`, `constants`, `readFileSync`, `writeFileSync`, `mkdirSync`, `realpathSync`) that may be called during module initialization. This prevents cascading errors and heap OOM during import.
- **`icons.js` mock:** The dynamic `require('dist/icons.js')` in the browse module is mocked with stub implementations for all 8 exported functions (`priorityIcon`, `statusIcon`, `stageIcon`, `auditIcon`, `epicIcon`, `iconsEnabled`, `riskIcon`, `effortIcon`), preventing uncontrolled file resolution during import.
- **Infinite loop guard:** `custom()` mocks return `{ type: 'shortcut', command: '/test-exit' }` instead of `null` to break the `runBrowseFlow` while(true) loop, preventing infinite-loop-based OOM in test mocks.

## License

MIT
