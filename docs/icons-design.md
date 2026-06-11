# Icon Set & Accessibility Specification

> Work item: Design icon set & accessibility spec (WL-0MP160SZ3000LMO7)
> Parent: Icons for priority and status (WL-0MNAGKMG5002L3XJ)
> Status: **Implemented** — see commits [69bd2a0](https://github.com/TheWizardsCode/ContextHub/commit/69bd2a0),
> [92fa240](https://github.com/TheWizardsCode/ContextHub/commit/92fa240),
> [dcb09ac](https://github.com/TheWizardsCode/ContextHub/commit/dcb09ac),
> [f3ca18b](https://github.com/TheWizardsCode/ContextHub/commit/f3ca18b)

## Overview

This document defines the icon set for work item **priority** and **status** used
across the TUI (blessed) and CLI (chalk) rendering paths. It covers:

- Chosen icons (emoji / terminal-safe glyphs)
- Accessible labels (aria-label equivalents) for screen readers
- Text-fallback / copy-paste behaviour
- A mechanism to disable icons for scripting
- Compatibility notes

---

## 1. Priority Icons

| Priority  | Icon   | Text Fallback | Accessible Label        |
|-----------|--------|---------------|-------------------------|
| critical  | `🔴`   | `[CRIT]`      | "Critical priority"     |
| high      | `🟠`   | `[HIGH]`      | "High priority"         |
| medium    | `🔵`   | `[MED]`       | "Medium priority"       |
| low       | `⚪`   | `[LOW]`       | "Low priority"          |

**Colour association:** The emoji colours match the existing colour scheme in the
theme (`theme.priority` / `theme.tui` priority colours) so scanning by colour
remains consistent across icon and non-icon contexts.

---

## 2. Status Icons

| Status         | Icon   | Text Fallback | Accessible Label          |
|----------------|--------|---------------|---------------------------|
| open           | `🟢`   | `[OPEN]`      | "Status: Open"            |
| in-progress    | `🔄`   | `[INPR]`      | "Status: In progress"     |
| completed      | `✅`   | `[DONE]`      | "Status: Completed"       |
| blocked        | `⛔`   | `[BLKD]`      | "Status: Blocked"         |
| deleted        | `🗑️`  | `[DEL]`       | "Status: Deleted"         |
| input_needed   | `❓`   | `[HELP]`      | "Status: Input needed"    |

---

## 3. Emoji / Glyph Compatibility

The chosen emoji are part of the Unicode 12.0+ standard and are supported by:

- **GNOME Terminal / VTE** (>= 0.52)
- **kitty** (>= 0.14)
- **Alacritty** (>= 0.4)
- **Windows Terminal**
- **tmux** (when the outer terminal supports colour emoji)
- **iTerm2** (macOS)
- **Terminal.app** (macOS — partial, `.` may render as emoji style)

**When emoji do not render** (older terminals, CI logs, serial lines) the **text
fallback** is used instead. See §5 below.

> **Compatibility note:** Some terminals require a font with emoji support
> (e.g. Noto Color Emoji, Apple Color Emoji, Segoe UI Emoji). If the emoji
> block appears as a blank square (tofu), the text fallback will still be
> readable.

---

## 4. Accessibility Labels

Every icon MUST carry an equivalent accessible label so that screen readers and
tooling that parses CLI output can identify the icon's meaning.

### 4.1 TUI (blessed)

Blessed does not natively support `aria-label` attributes on box/list items.
Instead, accessibility is achieved by:

1. **Prefixing each icon with its text fallback** when an accessibility flag is
   set (e.g. `WL_A11Y=1`).
2. **Blessed `tags` mode** can be used to colour the fallback text the same
   colour as the icon so visual scanning is preserved, while the screen reader
   receives the textual label.

Implementation in the TUI list and detail panes should:

```
{green-fg}🟢{/green-fg}    ← visual icon (emoji)
{green-fg}[OPEN]{/green-fg} ← when WL_A11Y=1 or icons disabled
```

### 4.2 CLI Output

CLI output uses `chalk` to colour output. When icons are enabled:

```
🔴 [CRIT] ← icon + fallback in muted colour beside it
```

The **text fallback is always appended** to the icon in CLI output, separated
by a space. This ensures:
- Copy/paste captures `[CRIT]` not just `🔴`.
- Screen readers pick up `[CRIT]` after the icon.
- Scripts parsing the output can use `[CRIT]` as a reliable marker.

---

## 5. Text Fallback & Copy/Paste

### Behaviour

| Context           | Icon rendering              | Copy/paste result           |
|-------------------|-----------------------------|-----------------------------|
| TTY / TUI         | Emoji icon displayed        | Emoji + fallback preserved  |
| Non-TTY (pipe)    | Text fallback only          | Clean text `[CRIT]`         |
| `WL_NO_ICONS=1`   | Text fallback only          | Clean text `[CRIT]`         |
| `WL_A11Y=1`       | Fallback, no emoji          | Clean text `[CRIT]`         |

### Format

In TUI list rows and detail panes, icons are rendered as:

```
<icon><space><title>
```

For example:

```
🟢 Set up CI pipeline
🔄 Review PR #42
```

When fallback is active (non-TTY or `WL_NO_ICONS=1`):

```
[OPEN] Set up CI pipeline
[INPR] Review PR #42
```

### CLI Output Format

In CLI output (e.g. `wl list`, `wl show`), lines that display priority and
status SHALL include both the icon and the text fallback:

```
Priority: 🔴 [CRIT]   (or  [CRIT]  when icons disabled)
Status:   🟢 [OPEN]   (or  [OPEN]  when icons disabled)
```

---

## 6. Disabling Icons

Two mechanisms control icon display:

| Method               | Effect                       |
|----------------------|------------------------------|
| `WL_NO_ICONS=1`      | Disables all icons globally  |
| `--no-icons` flag    | Per-command opt-out          |

When icons are disabled, the **text fallback** is used everywhere the icon
would have appeared.

No env var is set by default; icons are enabled when `process.stdout.isTTY` is
`true` and disabled otherwise (non-TTY). The `WL_NO_ICONS` env var and
`--no-icons` flag override this auto-detection.

---

## 7. Rendering Cost

The icon lookup is a simple `Map<string, string>` or plain object lookup —
O(1) per call, negligible runtime cost. No SVG, image loading, or network
requests are involved.

**Design decision:** Create a single `src/icons.ts` module that exports pure
functions:

```ts
// src/icons.ts

export interface IconOptions {
  /** When true, use text fallback instead of emoji/icon glyph */
  noIcons?: boolean;
}

/**
 * Get the icon string (emoji or fallback text) for a work item priority.
 */
export function priorityIcon(priority: string, opts?: IconOptions): string;

/**
 * Get the icon string (emoji or fallback text) for a work item status.
 */
export function statusIcon(status: string, opts?: IconOptions): string;

/**
 * Get the accessible label for a priority icon.
 */
export function priorityLabel(priority: string): string;

/**
 * Get the accessible label for a status icon.
 */
export function statusLabel(status: string): string;

/**
 * Check whether icons should be used, based on environment variables
 * and TTY detection.
 */
export function iconsEnabled(opts?: { noIcons?: boolean }): boolean;
```

---

## 8. Implementation Guide

### 8.1 TUI List Rendering

File: `src/tui/components/list.ts` (via controller rendering in
`src/tui/controller.ts`)

List item lines should prepend the priority or status icon before the title:

```
{green-fg}🟢{/green-fg} Set up CI pipeline     ← when icons enabled
{white-fg}[OPEN]{/white-fg} Set up CI pipeline  ← when fallback
```

The `formatTitleOnlyTUI` helper in `src/commands/helpers.ts` may be extended
or a new wrapper created that injects the icon before the title.

### 8.2 TUI Detail Pane

File: `src/tui/components/detail.ts`, `src/tui/components/metadata-pane.ts`

The metadata pane already shows `Status:` and `Priority:` lines. These lines
should be updated to include the icon:

```
Status:   🟢 [OPEN]
Priority: 🔴 [CRIT]
```

### 8.3 CLI Output

File: `src/cli-output.ts`, `src/commands/helpers.ts` (`humanFormatWorkItem`)

The status and priority display lines should include the icon:

```
Status: 🟢 Open | Priority: 🔴 Critical
```

### 8.4 Tests

Tests should verify:
- Icon functions return expected emoji for valid inputs
- Icon functions return text fallback when `noIcons: true` or `WL_NO_ICONS=1`
- Icon functions return text fallback for unrecognized inputs (graceful)
- Accessible label functions return expected strings
- `iconsEnabled()` returns correct value based on env vars

---

## 9. Appendix: Example Usage

```ts
import { priorityIcon, statusIcon, iconsEnabled } from '../icons.js';

const useIcons = iconsEnabled({ noIcons: opts.noIcons });

// In a list renderer:
const icon = priorityIcon(item.priority, { noIcons: !useIcons });
const line = `${icon} ${formatTitleOnlyTUI(item)}`;

// In a metadata pane:
const pIcon = priorityIcon(item.priority, { noIcons: !useIcons });
const sIcon = statusIcon(item.status, { noIcons: !useIcons });
lines.push(`Status:   ${sIcon} ${item.status}`);
lines.push(`Priority: ${pIcon} ${item.priority}`);
```

---

## 10. Implementation Summary

### Files Created/Modified

| File | Change |
|------|--------|
| `src/icons.ts` | Core icon module with emoji, fallback, and label functions |
| `src/tui/controller.ts` | Added icon rendering to TUI list rows |
| `src/tui/components/metadata-pane.ts` | Added icon rendering to metadata pane |
| `src/commands/helpers.ts` | Added icon formatting to CLI output (summary, concise, normal, full) |
| `src/commands/list.ts` | Added `--no-icons` CLI flag |
| `src/commands/show.ts` | Added `--no-icons` CLI flag |
| `src/cli-types.ts` | Added `noIcons` to ListOptions and ShowOptions |
| `tests/unit/icons.test.ts` | 58 unit tests for icon functions |

### CLI Usage

```bash
# Default: icons enabled when output is a TTY
wl list --format full

# Disable icons for clean text output
wl list --format full --no-icons
# or
WL_NO_ICONS=1 wl list --format full
```

### Output Examples

**CLI (TTY) with icons:**
```
ID:    TEST-1
Title: Set up CI pipeline
Status: 🟢 Open [OPEN] · Stage: In Progress | Priority: 🔵 medium [MED ]
```

**CLI with icons disabled:**
```
ID:    TEST-1
Title: Set up CI pipeline
Status: [OPEN] · Stage: In Progress | Priority: medium
```

**TUI list:**
```
▸ 🔴 🔄 Set up CI pipeline (TEST-1)
  ├── 🔵 ✅ Write tests (TEST-2)
```
