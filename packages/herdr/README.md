# Worklog Selection List — Herdr Plugin

A Herdr plugin that provides a keyboard-navigable work item selection list for browsing, filtering, and selecting [Worklog](https://github.com/your-org/worklog) work items from within Herdr.

## Features

- **Browse work items** — Lists work items from `wl next` in a scrollable, keyboard-navigable list
- **Filter by stage** — Press `/` to activate filter mode, then select a stage by number (0-5)
- **View details** — Press Enter on any item to see its full details (description, acceptance criteria, metadata, tags, priority)
- **Keyboard navigation** — Arrow keys or j/k to navigate, Page Up/Down, g/G for first/last, Enter to select, Escape to go back
- **Refresh** — Press `r` to reload the work item list from the Worklog
- **Quit** — Press `q` to exit

## Requirements

- [Herdr](https://herdr.dev) v0.7.0 or later
- [Worklog CLI (`wl`)](https://github.com/your-org/worklog) installed and on PATH

## Installation

### From source (development)

```bash
# Clone the repository
cd /path/to/worklog-repo

# Link the plugin in Herdr
herdr plugin link packages/herdr/herdr-plugin.toml

# Build the plugin
cd packages/herdr && npm run build
```

The plugin pane will then be available via the Herdr plugin system.

## Usage

### From the Herdr UI

1. Open the worklist pane:
   - Right-click in any pane → Plugins → Worklog Selection List → Toggle worklist
   - Or use the Herdr command palette: `herdr plugin action run worklog-selection-list toggle-worklist`

2. Navigate the list:
   - `↑`/`k` — Move up
   - `↓`/`j` — Move down
   - `PgUp` — Page up
   - `PgDn` — Page down
   - `g` — Go to first item
   - `G` — Go to last item
   - `Enter` — View item details
   - `Escape` — Go back (from detail or filter mode)

3. Filter by stage:
   - Press `/` to enter filter mode
   - Press a digit key (0-5) to select a stage:
     - `0` — idea
     - `1` — intake_complete
     - `2` — plan_complete
     - `3` — in_progress
     - `4` — in_review
     - `5` — completed
   - Press `Escape` to cancel filtering

4. Refresh the list:
   - Press `r` to reload

5. Quit:
   - Press `q` to close the worklist pane

### From the command line

```bash
# Direct invocation
herdr plugin action run worklog-selection-list open-worklist

# Toggle the pane
herdr plugin action run worklog-selection-list toggle-worklist
```

### Configuration

The plugin respects the following environment variables:

- `WL_COUNT` — Number of work items to fetch (default: 20)

## Architecture

```
packages/herdr/
├── herdr-plugin.toml       # Herdr plugin manifest
├── README.md               # This file
├── src/
│   ├── index.ts            # Entry point — TUI main loop
│   ├── fetcher.ts          # Worklog data fetching via wl CLI
│   └── worklist.ts         # List state, rendering, and keyboard handling
└── scripts/
    ├── open.sh             # Open the worklist pane
    └── toggle.sh           # Toggle the worklist pane
```

### Design decisions

- **No direct database access** — The plugin uses the `wl` CLI as the backend data source, ensuring compatibility without duplicating data-access logic.
- **Terminal UI via raw mode** — The TUI uses raw stdin mode and ANSI escape codes for rendering, making it compatible with any Herdr pane without additional dependencies.
- **Testable core** — All state management, formatting, and keyboard handling is pure logic in `worklist.ts`, fully testable without a terminal.
- **No agent launch commands** — Per scope constraints, the plugin only handles listing, filtering, browsing, and selection — not agent execution.

## Development

```bash
# Run tests
npx vitest run tests/herdr/

# Run the plugin directly (outside Herdr)
npx tsx packages/herdr/src/index.ts

# Build TypeScript
cd packages/herdr && npx tsc
```

## License

MIT — see [LICENSE](../../LICENSE) for details.
