# Colour Mapping for Work Items

This document describes the colour-coding system used for work item titles in the CLI and TUI.

## Overview

Work item titles are colour-coded based on their **stage** (primary) or **status** (fallback) to improve scanability and reduce triage time. When a stage is set, its colour takes precedence over the status colour.

## Colour Mapping Table

### Stage-based Colours

| Stage | CLI Colour | TUI Tag | Description |
|-------|-----------|---------|-------------|
| `idea` | Blue | `blue-fg` | Initial ideation phase |
| `intake_complete` | Orange (#FFA500) | `214-fg` | Intake process completed |
| `plan_complete` | White | `white-fg` | Planning phase completed |
| `in_progress` | Cyan | `cyan-fg` | Work in progress |
| `in_review` | Magenta | `magenta-fg` | Under review |
| `done` | Green | `green-fg` | Work completed |

### Status-based Colours (Fallback)

| Status | CLI Colour | TUI Tag | Description |
|--------|-----------|---------|-------------|
| `open` | Green Bright | `green-fg` | Item is open |
| `in-progress` | Cyan | `cyan-fg` | Work in progress |
| `blocked` | Red Bright | `red-fg` | Item is blocked |
| `completed` | White | `white-fg` | Work completed |
| `input_needed` | Yellow | `yellow-fg` | Needs input |
| `deleted` | Gray | `gray-fg` | Item deleted |

## Priority Rules

1. **Stage takes precedence**: When a work item has a stage set, the stage colour is used
2. **Status fallback**: When no stage is set (or stage is empty), the status colour is used
3. **Default**: If neither stage nor status has a specific colour, the default green colour is used

## Examples

```
# TUI (Blessed markup)
{magenta-fg}My Review Item{/magenta-fg}      # in_review stage
{green-fg}Completed Work{/green-fg}          # done stage
{red-fg}Blocked Item{/red-fg}                # blocked status

# CLI (Chalk - actual ANSI codes depend on terminal)
My Review Item    # magenta colour when in_review
Completed Work    # green colour when done
Blocked Item      # red colour when blocked
```

## Accessibility

### Colour-Only Signals

The colour-coding system is designed with accessibility in mind:

1. **Text labels preserved**: All work item titles remain readable with their original text
2. **No colour-only information**: Status and stage are always shown as text labels in metadata
3. **Terminal fallback**: When colours are not supported (e.g., `TERM=dumb`), output falls back to plain text

### Supported Terminals

- Modern terminals with 256-color or truecolor support (recommended)
- Terminal emulators: iTerm2, Alacritty, Kitty, Windows Terminal, GNOME Terminal
- Fallback: Plain text output for terminals without colour support

## Implementation Details

### Files

- `src/theme.ts` - Theme definitions for CLI and TUI colours
- `src/commands/helpers.ts` - Helper functions for title rendering

### Functions

- `titleColorForStatus(status)` - Returns Chalk function for status-based colour (CLI)
- `titleColorForStatusTUI(status)` - Returns blessed tag wrapper for status (TUI)
- `titleColorForStage(stage)` - Returns Chalk function for stage-based colour (CLI)
- `titleColorForStageTUI(stage)` - Returns blessed tag wrapper for stage (TUI)
- `renderTitle(item)` - Renders title with appropriate colour (CLI)
- `renderTitleTUI(item)` - Renders title with blessed markup (TUI)

### Changing the Colour Mapping

To modify colours:

1. Edit `src/theme.ts`:
   - For CLI: Update `theme.stage` or `theme.status` objects
   - For TUI: Update `theme.tui.stage` or `theme.tui.status` objects

2. The colour functions in `src/commands/helpers.ts` automatically pick up theme changes

### Adding New Stages/Statuses

To add a new stage or status colour:

1. Add the entry to `theme.stage` or `theme.status` (CLI) in `src/theme.ts`
2. Add the entry to `theme.tui.stage` or `theme.tui.status` (TUI) in `src/theme.ts`
3. Add a case to `titleColorForStage` or `titleColorForStatus` in `src/commands/helpers.ts`
4. Add a case to `titleColorForStageTUI` or `titleColorForStatusTUI` in `src/commands/helpers.ts`

## Testing

Tests are located in `tests/unit/colour-mapping.test.ts`:

- Theme structure verification
- Stage-based colour mapping
- Status-based colour mapping
- TUI blessed markup tags
- Priority (stage over status)
- Accessibility (preserving text labels)
- Fallback behaviour (colours disabled)
- Visual regression tests (snapshot-like)
