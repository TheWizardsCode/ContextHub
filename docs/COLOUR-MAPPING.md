# Colour Mapping for Work Items

This document describes the colour-coding system used for work item titles and ids in the CLI and Herdr.

## Overview

Work item **titles and ids** are colour-coded based on their **priority** using a consistent scheme
(critical → red, high → orange, medium → yellow, low → white). The same mapping is used in both the
CLI (`src/theme.ts`, chalk) and the Herdr worklist (`packages/shared/src/icons.ts`, ANSI 256).

There is **no blocked override**: blocked items display their natural priority colour like every other
item (per clarification Q3b on WL-0MSJ2JFMO007PGQ6).

> **Revision note (2026-09-08):** the original scheme specified `medium → white`, `low → dimmed`, with
> ids coloured by **stage**. A producer review of the first delivery changed this: medium is **yellow**
> (better contrast than white), low is **white** (dim was too low-contrast), and ids share the title's
> priority colour for a consistent visual cue. The docs, code comments and tests reflect the revised
> scheme.

## Colour Mapping Table

### Priority Colours (titles and ids)

| Priority | CLI Colour (chalk) | Herdr ANSI 256 | Colour Name | Description |
|----------|--------------------|----------------|-------------|-------------|
| `critical` | `chalk.red` | `196` | Red | Immediate attention |
| `high` | `chalk.hex('#FFA500')` | `208` | Orange | Important |
| `medium` | `chalk.yellow` | `220` | Yellow | Standard/default |
| `low` | `chalk.white` | `15` | White | Recedes |

### Default Fallback

| Condition | CLI Colour | Herdr ANSI 256 | Description |
|-----------|------------|----------------|-------------|
| Unknown/missing priority | Medium (yellow) | `220` | Falls back to medium/yellow |

### Stage Colours (unchanged — used by the stage filter dialog and separators)

| Stage | CLI Colour | Colour Name |
|-------|-----------|-------------|
| `idea` | Gray | `gray` |
| `intake_complete` | Blue | `blue` |
| `plan_complete` | Cyan | `cyan` |
| `in_progress` | Yellow | `yellow` |
| `in_review` | Green | `green` |
| `done` | White | `white` |

## Priority Rules

1. **Priority colour**: A work item's title and id are coloured by its priority (critical/high/medium/low).
2. **No blocked override**: Blocked items display their natural priority colour — there is no unconditional
   red override for `status: blocked`.
3. **Default fallback**: When priority is missing or unknown, the medium/yellow colour is used.

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

- `src/theme.ts` — canonical priority colour mapping (chalk) for the CLI
- `src/commands/helpers.ts` — `titleColorForPriority`, `renderTitle`, `formatTitleAndId` (both title and id by priority)
- `packages/shared/src/icons.ts` — `priorityColor(priority)` / `applyPriorityColour(text, priority)` (ANSI 256) for Herdr
- `packages/herdr/src/worklist.ts` — `formatItemLine` (title and id both via priority colour)

### Functions

- `titleColorForPriority(priority)` — Returns Chalk function for priority colour (unknown → medium/yellow)
- `renderTitle(item)` — Renders title coloured by priority (no blocked override)
- `priorityColor(priority)` / `applyPriorityColour(text, priority)` — Herdr ANSI 256 equivalents

### Keeping CLI and Herdr Colours Consistent

The CLI uses chalk named/hex colours and Herdr renders raw ANSI 256 escape codes. The two maps must stay
consistent: `critical` ≈ red (196), `high` ≈ orange (208), `medium` ≈ yellow (220), `low` ≈ white (15).
When changing colours, update both `src/theme.ts` and `packages/shared/src/icons.ts`.

## Testing

Tests are located in:

- `tests/unit/colour-mapping.test.ts` — CLI helpers colour mapping (titles and ids by priority, blocked items show priority, unknown fallback)
- `packages/shared/src/icons-priority-colour.test.ts` — Herdr `priorityColor` / `applyPriorityColour` ANSI 256 mapping
- `packages/herdr/src/worklist.test.ts` (see `formatItemLine — priority title + stage id` describe block) — Herdr row colouring
