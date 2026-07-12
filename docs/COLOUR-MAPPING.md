# Colour Mapping for Work Items

This document describes the colour-coding system used for work item titles in the CLI and TUI.

## Overview

Work item titles are colour-coded based on their **stage** using a progression colour scheme (gray → blue → cyan → yellow → green → white), with a **red override for blocked items** that takes priority regardless of stage. When a work item has `status: blocked`, it always displays in red.

## Colour Mapping Table

### Stage Progression Colours

| Stage | CLI Colour | Colour Name | Description |
|-------|-----------|-------------|-------------|
| `idea` | Gray | `gray` | Initial ideation phase |
| `intake_complete` | Blue | `blue` | Intake process completed |
| `plan_complete` | Cyan | `cyan` | Planning phase completed |
| `in_progress` | Yellow | `yellow` | Work in progress |
| `in_review` | Green | `green` | Under review |
| `done` | White | `white` | Work completed |

### Blocked Override

| Condition | CLI Colour | Colour Name | Description |
|-----------|-----------|-------------|-------------|
| `status: blocked` | Red Bright | `red` | Always red, overriding any stage colour |

### Default Fallback

| Condition | CLI Colour | Colour Name | Description |
|-----------|-----------|-------------|-------------|
| No stage, not blocked | Gray | `gray` | Falls back to idea/gray colour |

## Priority Rules

1. **Blocked override**: When a work item has `status: blocked`, it always displays in red, regardless of its stage value
2. **Stage progression**: When a work item has a stage set, the stage progression colour is used
3. **Default**: When no stage is set (or stage is empty/unknown) and status is not blocked, the default gray colour (idea) is used



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

- `titleColorForStage(stage)` - Returns Chalk function for stage-based colour
- `renderTitle(item)` - Renders title with appropriate colour; checks blocked status first

### Changing the Colour Mapping

To modify colours:

1. Edit `src/theme.ts`: Update `theme.stage` objects or `theme.blocked`
2. The colour functions in `src/commands/helpers.ts` automatically pick up theme changes

### Adding New Stages

To add a new stage colour:

1. Add the entry to `theme.stage` in `src/theme.ts`
2. Add a case to `titleColorForStage` in `src/commands/helpers.ts`

## Testing

Tests are located in `tests/unit/colour-mapping.test.ts`:

- Theme structure verification (stage colours, blocked override)
- Stage-based colour mapping
- Blocked status override (always red regardless of stage)
- Default/fallback behaviour (gray when no stage, not blocked)
- Accessibility (preserving text labels)
- Fallback behaviour (colours disabled)
- Visual regression tests (snapshot-like)