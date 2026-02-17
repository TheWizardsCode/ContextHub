# Worklog TUI

This document describes the interactive terminal UI shipped as the `wl tui` (or `worklog tui`) command.

## Overview

- The TUI presents a tree view of work items on the left and a details pane on the right.
- It can show all items, or be limited to in-progress items via `--in-progress`.
- The details pane uses the same human formatter as the CLI so what you see in the TUI matches `wl show --format full`.
- Integrated OpenCode AI assistant for intelligent work item management and coding assistance.

## Controls

### Navigation

- Arrow Up / Down — move selection
- Right / Enter — expand node
- Left — collapse node (or collapse parent)
- Space — toggle expand/collapse
- Mouse — click to select and scroll
- q / Esc / Ctrl-C — quit
- Ctrl+W, Ctrl+W — cycle focus between list, details, and OpenCode
- Ctrl+W, h / l — focus list or details
- Ctrl+W, k / j — move focus between OpenCode response and input
- Ctrl+W, p — focus previous pane

### Work Item Actions

- n — create new work item
- e — edit selected item
- c — add comment to selected item
- d — delete selected item
- r — refresh/reload items
- / — search items
- v — cycle needs-producer-review filter (on/off/all)
- h — toggle help menu

### OpenCode AI Integration

- **O** (capital O) — open OpenCode AI assistant dialog
  - Ctrl+S — send prompt
  - Enter — accept autocomplete or add newline
  - Escape — close dialog
  - Prefix `!` to run a local shell command in the project root
  - Ctrl+C cancels a running `!` command without closing the prompt
  - Command shows in orange; output streams in white
- When OpenCode is active:
  - Response appears in bottom pane
  - Input fields appear when agent needs information
  - q or click [x] to close response pane

## OpenCode Features

### Auto-start Server

The OpenCode server automatically starts when you press O. Server status indicators:

- `[-]` — Server stopped
- `[~]` — Server starting
- `[OK] Port: 9999` — Server running (example; configurable via `OPENCODE_SERVER_PORT` or auto-selected)
- `[X]` — Server error

### Slash Commands

Type `/` in the OpenCode dialog to see available commands:

- `/help` — Get help with OpenCode
- `/edit` — Edit files with AI assistance
- `/create` — Create new files
- `/test` — Generate or run tests
- `/fix` — Fix issues in code
- Plus 20+ more commands

### Interactive Sessions

- Sessions persist across multiple prompts
- Real-time streaming responses
- Interactive input when agents need clarification
- Tool usage highlighted in colors

For detailed OpenCode documentation, see `docs/opencode-tui.md`.

## Usage

Install dependencies and run from source:

```
npm install
npm run cli -- tui
```

## Options

- `--in-progress` — show only items with status `in-progress`.
- `--prefix <prefix>` — use a different project prefix.

## Notes

- The TUI uses `blessed` for rendering. For a smoother TypeScript developer experience install the types: `npm install -D @types/blessed`.
- The TUI is intentionally lightweight: it renders items from the current database snapshot. If you want live updates across processes, run a background sync or re-open the TUI.
