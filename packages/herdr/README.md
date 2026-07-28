# Worklog Selection List — Herdr Plugin

A Herdr plugin that provides a keyboard-navigable work item selection list for browsing, filtering, and selecting [Worklog](https://github.com/your-org/worklog) work items from within Herdr.

## Features

- **Browse work items** — Lists work items from `wl next` in a scrollable, keyboard-navigable list
- **Filter by stage** — Press `f` followed by a chord key (`i`=idea, `n`=intake, `p`=plan, `r`=review) to filter items by stage
- **View details** — Press Enter on any item to see its full details (description, acceptance criteria, metadata, tags, priority, and audit status information such as audit result, review status, and last audit timestamp)
- **Audit indicators** — The list view shows audit icons next to `in_review` items (✅ audited, ❌ failed, ❓ unaudited). The detail view metadata section additionally shows the review status (❌ needs review / ✅ reviewed) and the last audit timestamp.
- **Chord shortcuts** — Multi-key chord sequences provide quick actions like filtering, updating priorities, and more (configurable via `shortcuts.json`)
- **Command output** — When a chord resolves to a non-`/wl` command (e.g., `!!wl update <id> --priority high`), the resolved command is output to stdout with a `CMD:` prefix for the calling framework to execute
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

3. Filter by stage using chord shortcuts:
   - Press `f` then `i` — Filter to idea-stage items
   - Press `f` then `n` — Filter to intake_complete items
   - Press `f` then `p` — Filter to plan_complete items
   - Press `f` then `r` — Filter to in_review items
   - Press `Escape` to cancel an incomplete chord

4. For other chord shortcuts (displayed in the footer), press the chord leader key followed by the remaining keys to execute actions like updating item priorities or closing items.

5. Refresh the list:
   - Press `r` to reload

6. Quit:
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
│   ├── shortcut-config.ts  # Chord shortcut registry and config loader
│   ├── shortcuts.json      # Shortcut/chord definitions
│   ├── icons.ts            # Icon and colour helpers
│   ├── settings.ts         # User settings management
│   └── worklist.ts         # List state, rendering, keyboard handling, command output
├── scripts/
│   ├── open.sh             # Open the worklist pane
│   └── toggle.sh           # Toggle the worklist pane
└── tests/herdr/            # Test files
```

### Design decisions

- **No direct database access** — The plugin uses the `wl` CLI as the backend data source, ensuring compatibility without duplicating data-access logic.
- **Terminal UI via raw mode** — The TUI uses raw stdin mode and ANSI escape codes for rendering, making it compatible with any Herdr pane without additional dependencies.
- **Testable core** — All state management, formatting, and keyboard handling is pure logic in `worklist.ts`, fully testable without a terminal.
- **Command output via callback** — When a chord resolves to a non-`/wl` command, it is passed to an `onCommand` callback (set by the entry point) which writes the resolved command to stdout with a `CMD:` prefix. The calling framework (Herdr) reads this output to execute arbitrary commands.
- **`<id>` placeholder resolution** — Before output, any `<id>` placeholders in the resolved command are replaced with the currently selected work item's ID. If no item is selected and the command requires `<id>`, the command is silently dropped (graceful no-op).
- **Chord shortcut system** — Multi-key chord sequences are defined in `shortcuts.json` and resolved via `ShortcutRegistry`. Chords can be filtered by view (list/detail) and stage.
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
