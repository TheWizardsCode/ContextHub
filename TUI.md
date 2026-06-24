# Worklog TUI

The Worklog TUI is a Pi-based interactive terminal UI that provides a unified
agent chat + work item management experience. It is available via the `wl tui`
and `wl piman` commands (they are aliases for each other).

## Overview

The TUI launches the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)
with worklog extensions pre-loaded, providing:

- **Browse view**: list and select recommended work items with keyboard-driven navigation
- **Detail view**: full work item details, comments, and audit results
- **Shortcut keys**: configurable keyboard shortcuts for common workflows (implement, plan, audit, intake)
- **Agent chat**: natural language interaction for work item management

## Usage

```bash
# Launch the TUI
wl tui
wl piman    # same as wl tui

# Show only in-progress items
wl tui --in-progress
wl piman --in-progress

# Include completed/deleted items
wl tui --all

# Override the default prefix
wl tui --prefix PREFIX

# Enable performance instrumentation
wl tui --perf
```

## Architecture

The TUI is implemented as a Pi extension located in `packages/tui/`:

- `packages/tui/pi.json` — Extension configuration and entry points
- `packages/tui/extensions/index.ts` — Main extension that registers the `/wl` browser command
- `packages/tui/extensions/chatPane.ts` — Chat pane for natural language work item management
- `packages/tui/extensions/actionPalette.ts` — Keyboard-first action palette
- `packages/tui/extensions/wl-integration.ts` — Integration layer for executing wl CLI commands
- `packages/tui/extensions/shortcut-config.ts` — Config-driven keyboard shortcut system
- `packages/tui/extensions/shortcuts.json` — Default shortcut definitions

## Features

### Browse & Select

On launch, the TUI shows a list of recommended next work items. Navigate with
Up/Down arrows, press Enter to see full details, or use shortcut keys:

- **i** — insert `implement <id>` into the editor
- **p** — insert `plan <id>` into the editor
- **n** — insert `intake <id>` into the editor
- **a** — insert `audit <id>` into the editor

### Agent Chat

Natural language interaction for work item operations. Type commands like:
- "list work items"
- "show WL-123"
- "create a work item: fix login bug"
- "claim next task"

### Settings

Press `/wl settings` to open the settings overlay where you can configure:
- Number of items to browse (3, 5, 10, 15, or 20)
- Show/hide icons in the browse list

## See Also

- [Pi TUI Extensions README](packages/tui/extensions/README.md) — Details on the
  config-driven shortcut system and extension architecture
- `docs/tutorials/04-using-the-tui.md` — Tutorial for getting started with the TUI
