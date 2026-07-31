# Worklog Selection List — Herdr Plugin

A Herdr plugin that provides a keyboard-navigable work item selection list for browsing, filtering, and selecting [Worklog](https://github.com/your-org/worklog) work items from within Herdr.

## Features

- **Browse work items** — Lists work items from `wl next` in a scrollable, keyboard-navigable list
- **Filter by stage** — Press `f` followed by a chord key (`i`=idea, `n`=intake, `p`=plan, `r`=review) to filter items by stage
- **View details** — Press Enter on any item to see its full details (description, acceptance criteria, metadata, tags, priority, and audit status information such as audit result, review status, and last audit timestamp)
- **Audit indicators** — The list view shows audit icons next to `in_review` items (✅ audited, ❌ failed, ❓ unaudited). The detail view metadata section additionally shows the review status (❌ needs review / ✅ reviewed) and the last audit timestamp.
- **Chord shortcuts** — Multi-key chord sequences provide quick actions like updating priorities, stage/status, title, closing/deleting items, running workflows, and toggling review status (configurable via `shortcuts.json`)
- **Command output** — When a chord resolves to a non-`/wl` command (e.g., `!!wl update <id> --priority high`), the resolved command is output to stdout for the calling framework to execute
- **Keyboard navigation** — Arrow keys or j/k to navigate (wraps at list boundaries), Page Up/Down, g/G for first/last, Enter to select, Escape to go back
- **Pi agent pane dispatch** — Agent commands (`/skill:*`, `/intake`, `/plan`) are automatically dispatched to a new pi agent pane opened to the right, where pi receives the command as its initial prompt
- **Open Pi Agent action** — The plugin provides an action to open a fresh interactive pi session pane
- **Tab-based opening** — The worklist opens in a new tab in the current workspace, providing full-screen access without reducing space for existing panes
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
   - Press `prefix+l` to open the worklist in a new tab
   - Right-click in any pane → Plugins → Worklog Selection List → Open worklist
   - Or use the Herdr command palette: `herdr plugin action run worklog-selection-list open-worklist`

2. Navigate the list:
   - `↑`/`k` — Move up (wraps to last item when at top)
   - `↓`/`j` — Move down (wraps to first item when at bottom)
   - `PgUp` — Page up
   - `PgDn` — Page down
   - `g` — Go to first item
   - `G` — Go to last item (last visible item in expanded hierarchy)
   - `Enter` — View item details, or expand a parent item with children
   - `Tab` — Toggle expand/collapse a parent item with children
   - `Escape` — Go back (from detail or filter mode); in a child list, return to the parent level at the previous scroll position

3. Filter by stage using chord shortcuts:
   - Press `f` then `i` — Filter to idea-stage items
   - Press `f` then `n` — Filter to intake_complete items
   - Press `f` then `p` — Filter to plan_complete items
   - Press `f` then `r` — Filter to in_review items
   - Press `Escape` to cancel an incomplete chord

4. Workflow shortcuts (single-key):
   - Press `c` — Create a new work item
   - Press `i` — Run the implement workflow on the selected item (intake_complete, plan_complete, in_progress)
   - Press `n` — Run the intake workflow on the selected item (idea stage)
   - Press `p` — Run the plan workflow on the selected item (intake_complete stage)
   - Press `s` — Insert a search command

5. Producer review shortcut:
   - Press `r` — Toggle 'Needs Producer Review' flag and add a comment to the selected item

6. Priority update chords (press `u` then `p` then a priority key):
   - Press `u`, `p`, `l` — Set priority to low
   - Press `u`, `p`, `m` — Set priority to medium
   - Press `u`, `p`, `h` — Set priority to high
   - Press `u`, `p`, `c` — Set priority to critical

7. Other update chords (press `u` then a key):
   - Press `u`, `s` — Insert an update stage/status template
   - Press `u`, `t` — Insert an update title template

8. Close/delete chords (press `x` then a key):
   - Press `x`, `c` — Close the selected item
   - Press `x`, `d` — Delete the selected item

9. Audit chords (in_review stage only, press `a` then a key):
   - Press `a`, `a` — Run automatic audit on the selected item
   - Press `a`, `y` — Approve the selected item (mark ready to close)
   - Press `a`, `r` — Reject the selected item (mark not ready to close)

10. Quit:
   - Press `q` to close the worklist pane

### From the command line

```bash
# Direct invocation (opens in a new tab)
herdr plugin action run worklog-selection-list open-worklist
```

### Configuration

The plugin respects the following environment variables:

- `WL_COUNT` — Number of work items to fetch (default: 20, now superseded by `browseItemCount` in settings)

#### Plugin Settings (config file)

Settings are persisted in `~/.config/herdr/worklog-plugin.json`. Key settings include:

- `autoRefresh` — Enable periodic auto-refresh of the work item list (default: `true`)
- `refreshIntervalMs` — Interval in ms between auto-refreshes (default: `30000`)
- `autoSync` — Enable periodic background `wl sync` before auto-refreshes (default: `true`)
- `syncIntervalMs` — Interval in ms between background `wl sync` calls (default: `30000`, minimum: `30000`; set to `0` to disable auto-sync)

### Selection List Behaviour

The default (unfiltered) worklist always shows **all** critical-priority
items and **all** completed/in_review items (the producer-review queue),
regardless of the `browseItemCount` setting:

- Items with `priority=critical` are always included.
- Items with `status=completed` **and** `stage=in_review` are always included.
- The `browseItemCount` limit applies only to the remaining "other" items.
  The number of "other" slots is `browseItemCount − (critical count) −
  (completed/in_review count)`, floored at zero.
- When critical + completed/in_review items alone meet or exceed
  `browseItemCount`, all of them are shown anyway (no hard cap on the
  mandatory set) — the total may exceed the configured count.
- An item that is both critical and completed/in_review counts once
  (deduplicated) toward the total.

Example: with `browseItemCount=15`, 2 critical + 3 completed/in_review +
20 other items → the list shows 2 critical + 3 completed/in_review + the
first 10 others (15 total). If there were 20 completed/in_review items
instead of 3, all 22 mandatory items would be shown (22 > 15).

The **stage-filtered** views (press `f` + stage chord) are unchanged: they
show only items matching the selected stage.

The "top N of M" header reflects the **actual displayed count** (N), which
may exceed `browseItemCount` when the mandatory set is large.

## Architecture

```
packages/herdr/
├── herdr-plugin.toml       # Herdr plugin manifest
├── README.md               # This file
├── src/
│   ├── index.ts            # Entry point — TUI main loop
│   ├── fetcher.ts          # Worklog data fetching via wl CLI
│   ├── auto-sync.ts       # Background `wl sync` with configurable timer
│   ├── shortcut-config.ts  # Chord shortcut registry and config loader
│   ├── shortcuts.json      # Shortcut/chord definitions
│   ├── icons.ts            # Icon and colour helpers
│   ├── settings.ts         # User settings management
│   └── worklist.ts         # List state, rendering, keyboard handling, command output
├── scripts/
│   ├── open.sh             # Open the worklist pane
│   ├── toggle.sh           # Toggle the worklist pane
│   ├── send-to-pi.sh       # Split pane to right, launch pi with agent command
│   └── open-pi-agent.sh    # Open a fresh interactive pi agent pane
└── tests/herdr/            # Test files
```

### Design decisions

- **No direct database access** — The plugin uses the `wl` CLI as the backend data source, ensuring compatibility without duplicating data-access logic.
- **Terminal UI via raw mode** — The TUI uses raw stdin mode and ANSI escape codes for rendering, making it compatible with any Herdr pane without additional dependencies.
- **Testable core** — All state management, formatting, and keyboard handling is pure logic in `worklist.ts`, fully testable without a terminal.
- **Command output via callback** — When a chord resolves to a non-`/wl` command, it is passed to an `onCommand` callback (set by the entry point) which writes the resolved command to stdout with a `CMD:` prefix. The calling framework (Herdr) reads this output to execute arbitrary commands.
- **Pi agent dispatch** — Agent commands (`/skill:*`, `/intake`, `/plan`) are intercepted by the entry point and routed to a new pi agent pane. The `send-to-pi.sh` script splits the current pane to the right, creates a new pane, runs `pi` with the command as the initial prompt, and renames the pane to "Pi Agent". Non-agent commands continue to use the standard `CMD:` output.
- **`<id>` placeholder resolution** — Before output, any `<id>` placeholders in the resolved command are replaced with the currently selected work item's ID. If no item is selected and the command requires `<id>`, the command is silently dropped (graceful no-op).
- **Chord shortcut system** — Multi-key chord sequences are defined in `shortcuts.json` and resolved via `ShortcutRegistry`. Chords can be filtered by view (list/detail) and stage.

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
