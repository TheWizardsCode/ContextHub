# Colour Mapping for Work Items

This document describes the colour-coding system used for work item titles in the CLI and TUI.

## Overview

Work item titles are colour-coded based on their **stage** using a progression colour scheme (gray → blue → cyan → yellow → green → white), with a **red override for blocked items** that takes priority regardless of stage. When a work item has `status: blocked`, it always displays in red.

## Colour Mapping Table

### Stage Progression Colours

| Stage | CLI Colour | TUI Tag | Description |
|-------|-----------|---------|-------------|
| `idea` | Gray | `gray-fg` | Initial ideation phase |
| `intake_complete` | Blue | `blue-fg` | Intake process completed |
| `plan_complete` | Cyan | `cyan-fg` | Planning phase completed |
| `in_progress` | Yellow | `yellow-fg` | Work in progress |
| `in_review` | Green | `green-fg` | Under review |
| `done` | White | `white-fg` | Work completed |

### Blocked Override

| Condition | CLI Colour | TUI Tag | Description |
|-----------|-----------|---------|-------------|
| `status: blocked` | Red Bright | `red-fg` | Always red, overriding any stage colour |

### Default Fallback

| Condition | CLI Colour | TUI Tag | Description |
|-----------|-----------|---------|-------------|
| No stage, not blocked | Gray | `gray-fg` | Falls back to idea/gray colour |

## Priority Rules

1. **Blocked override**: When a work item has `status: blocked`, it always displays in red, regardless of its stage value
2. **Stage progression**: When a work item has a stage set, the stage progression colour is used
3. **Default**: When no stage is set (or stage is empty/unknown) and status is not blocked, the default gray colour (idea) is used

## Examples

```
# TUI (Blessed markup)
{gray-fg}My New Idea{/gray-fg}          # idea stage
{blue-fg}Ready for Review{/blue-fg}     # intake_complete stage
{cyan-fg}Work is Planned{/cyan-fg}      # plan_complete stage
{yellow-fg}Current Work{/yellow-fg}      # in_progress stage
{green-fg}Under Review{/green-fg}       # in_review stage
{white-fg}Completed{/white-fg}           # done stage
{red-fg}Blocked Item{/red-fg}            # blocked status (overrides stage)

# CLI (Chalk - actual ANSI codes depend on terminal)
My New Idea       # gray when idea
Ready for Review  # blue when intake_complete
Work is Planned   # cyan when plan_complete
Current Work      # yellow when in_progress
Under Review      # green when in_review
Completed         # white when done
Blocked Item      # red when status is blocked (always overrides stage)
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

- `src/theme.ts` - Theme definitions for CLI and TUI colours (stage progression and blocked override)
- `src/commands/helpers.ts` - Helper functions for title rendering

### Functions

- `titleColorForStage(stage)` - Returns Chalk function for stage-based colour (CLI)
- `titleColorForStageTUI(stage)` - Returns blessed tag wrapper for stage (TUI)
- `renderTitle(item)` - Renders title with appropriate colour (CLI); checks blocked status first
- `renderTitleTUI(item)` - Renders title with blessed markup (TUI); checks blocked status first

### Changing the Colour Mapping

To modify colours:

1. Edit `src/theme.ts`:
   - For CLI: Update `theme.stage` objects or `theme.blocked`
   - For TUI: Update `theme.tui.stage` objects or `theme.tui.blocked`

2. The colour functions in `src/commands/helpers.ts` automatically pick up theme changes

### Adding New Stages

To add a new stage colour:

1. Add the entry to `theme.stage` (CLI) in `src/theme.ts`
2. Add the entry to `theme.tui.stage` (TUI) in `src/theme.ts`
3. Add a case to `titleColorForStage` in `src/commands/helpers.ts`
4. Add a case to `titleColorForStageTUI` in `src/commands/helpers.ts`

## Testing

Tests are located in `tests/unit/colour-mapping.test.ts`:

- Theme structure verification (stage colours, blocked override)
- Stage-based colour mapping (CLI and TUI)
- Blocked status override (always red regardless of stage)
- Default/fallback behaviour (gray when no stage, not blocked)
- Accessibility (preserving text labels)
- Fallback behaviour (colours disabled)
- Visual regression tests (snapshot-like)