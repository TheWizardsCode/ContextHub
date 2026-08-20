# Icon Set & Accessibility Specification

> Work item: Design icon set & accessibility spec (WL-0MP160SZ3000LMO7)
> Parent: Icons for priority and status (WL-0MNAGKMG5002L3XJ)
> Status: **Implemented** — see commits [69bd2a0](https://github.com/TheWizardsCode/ContextHub/commit/69bd2a0),
> [92fa240](https://github.com/TheWizardsCode/ContextHub/commit/92fa240),
> [dcb09ac](https://github.com/TheWizardsCode/ContextHub/commit/dcb09ac),
> [f3ca18b](https://github.com/TheWizardsCode/ContextHub/commit/f3ca18b)

## Overview

This document defines the icon set for work item **priority** and **status** used
across the CLI (chalk) and TUI rendering paths. It covers:

- Chosen icons (emoji / terminal-safe glyphs)
- Accessible labels (aria-label equivalents) for screen readers
- Text-fallback / copy-paste behaviour
- A mechanism to disable icons for scripting
- Compatibility notes

---

## 1. Priority Icons

| Priority  | Icon   | Text Fallback | Accessible Label        | Visual Meaning        |
|-----------|--------|---------------|-------------------------|---------------------|
| critical  | `🚨`   | `[CRIT]`      | "Critical priority"     | Rotating light - urgent/danger |
| high      | `⭐`   | `[HIGH]`      | "High priority"         | Star - important     |
| medium    | `📋`   | `[MED]`       | "Medium priority"       | Clipboard - standard task |
| low       | `🐢`   | `[LOW]`       | "Low priority"          | Turtle - slow/low priority |

**Colour association:** The emoji colours are enhanced with chalk color tags to match the existing colour scheme in the theme (`theme.priority` colours) so scanning by colour remains consistent.
- critical: red (🚨)
- high: yellow (⭐)
- medium: blue (📋)
- low: gray (🐢)

---

## 2. Stage Icons

| Stage            | Icon   | Text Fallback | Accessible Label               |
|------------------|--------|---------------|--------------------------------|
| idea             | `💡`   | `[IDEA]`      | "Stage: Idea"                  |
| intake_complete  | `📥`   | `[INTAKE]`    | "Stage: Intake Complete"       |
| plan_complete    | `📋`   | `[PLAN]`      | "Stage: Plan Complete"         |
| in_progress      | `🛠️`  | `[PROG]`      | "Stage: In Progress"           |
| in_review        | `🔍`   | `[REVIEW]`    | "Stage: In Review"             |
| done             | `🏁`   | `[DONE]`      | "Stage: Done"                  |

## 3. Audit Result Icons

| Result  | Icon   | Text Fallback | Accessible Label      |
|---------|--------|---------------|-----------------------|
| yes     | `✅`   | `[YES]`       | "Audit: Passed"       |
| no      | `❌`   | `[NO]`        | "Audit: Failed"       |
| unknown | `❓`   | `[UNKN]`      | "Audit: Not run"      |

## 3a. Stale Audit Result Icons

| State                         | Icon   | Text Fallback   | Accessible Label              |
|-------------------------------|--------|-----------------|-------------------------------|
| Audit passed (stale)          | `🟩`   | `[YES_STALE]`   | "Audit: Passed (stale)"      |

When an audit result is `readyToClose: true` but the audit timestamp is stale
(more than 60 seconds before `updatedAt`), the stale-passed icon is displayed
in column 2 instead of the stage icon. This preserves the information that
audit passed even after subsequent minor updates made the audit appear stale.

Note: flag-only flips of `needsProducerReview` do **not** move `updatedAt`
(WL-0MSN6ZCTN0027U2R), so a previously fresh audit stays fresh — the
stale-passed icon is only reached by genuine content changes.

The stale-passed icon only applies to `in_review` items. The regular audit
icons (✅ / ❌ / ❔) are used for fresh audits, and the stage icon (🔍) is
used when no audit exists or when the audit is stale with `readyToClose: false`.

The stale-passed icon was chosen to be visually distinct from:
- ✅ (fresh audit passed, green check mark)
- ❌ (fresh audit failed, red cross)
- 🔍 (stage icon, when no audit or stale without pass)
- ❔ (unknown/not run)

🟩 (green square button, U+1F7E9) has a distinct shape from all of these,
and its green colour still conveys a positive (passed) result even when the
check mark is not shown.

## 3b. Producer Review Flag Icons

| State                    | Icon   | Text Fallback       | Accessible Label              |
|--------------------------|--------|---------------------|-------------------------------|
| Needs producer review    | `❌`   | `[NEEDS_PRODUCER]`  | "Needs producer review"       |
| Producer review complete | `✅`   | `[PRODUCER_OK]`     | "Producer review complete"    |

The producer review flag is always shown in the third icon column of the TUI selection list, replacing the audit result icon for all stages.

## 4. Epic Icons

| Type    | Icon   | Text Fallback | Accessible Label        | Visual Meaning                            |
|---------|--------|---------------|-------------------------|-------------------------------------------|
| epic    | `🏰`   | `[EPIC]`      | "Issue Type: Epic"     | Castle — a large feature with dependencies |

## 5. Status Icons

| Status         | Icon   | Text Fallback | Accessible Label          |
|----------------|--------|---------------|---------------------------|
| open           | `🔓`   | `[OPEN]`      | "Status: Open"            |
| in-progress    | `🔄`   | `[INPR]`      | "Status: In progress"     |
| completed      | `✔️`   | `[DONE]`      | "Status: Completed"       |
| blocked        | `⛔`   | `[BLKD]`      | "Status: Blocked"         |
| deleted        | `🗑️`  | `[DEL]`       | "Status: Deleted"         |
| input_needed   | `💬`   | `[HELP]`      | "Status: Input needed"    |

## 6. Risk Icons

| Risk Level | Icon   | Text Fallback | Accessible Label      |
|------------|--------|---------------|-----------------------|
| Low        | `🌱`   | `[LOW]`       | "Risk: Low"           |
| Medium     | `⚠️`   | `[MED]`       | "Risk: Medium"        |
| High       | `🔥`   | `[HIGH]`      | "Risk: High"          |
| Severe     | `🚨`   | `[SEV]`       | "Risk: Severe"        |

**Note:** The 🚨 (Severe risk) icon is the same as the 🚨 (critical priority) icon. This overlap is acceptable because they appear in different positions in the UI — risk icons appear at the end of the information bar as a pipe-separated segment, while priority icons appear in the selection list row icon prefix — making visual disambiguation by context straightforward.

## 7. Effort Icons

| Effort Size | Icon   | Text Fallback | Accessible Label                 |
|-------------|--------|---------------|----------------------------------|
| XS          | `🐜`   | `[XS]`        | "Effort: XS (extra small)"       |
| S           | `🐇`   | `[S]`         | "Effort: S (small)"              |
| M           | `🐕`   | `[M]`         | "Effort: M (medium)"             |
| L           | `🐘`   | `[L]`         | "Effort: L (large)"              |
| XL          | `🐋`   | `[XL]`        | "Effort: XL (extra large)"       |

**Animal analogy:** The effort icons follow a size progression: ant (XS) → rabbit (S) → dog (M) → elephant (L) → whale (XL), making the scale intuitively visual.

---

## 8. Emoji / Glyph Compatibility

The chosen emoji are part of the Unicode 12.0+ standard and are supported by:

- **GNOME Terminal / VTE** (>= 0.52)
- **kitty** (>= 0.14)
- **Alacritty** (>= 0.4)
- **Windows Terminal**
- **tmux** (when the outer terminal supports colour emoji)
- **iTerm2** (macOS)
- **Terminal.app** (macOS — partial, `.` may render as emoji style)

**When emoji do not render** (older terminals, CI logs, serial lines) the **text
fallback** is used instead. See §8 below.

> **Compatibility note:** Some terminals require a font with emoji support
> (e.g. Noto Color Emoji, Apple Color Emoji, Segoe UI Emoji). If the emoji
> block appears as a blank square (tofu), the text fallback will still be
> readable.

---

## 9. Accessibility Labels

Every icon MUST carry an equivalent accessible label so that screen readers and
tooling that parses CLI output can identify the icon's meaning.

### 9.1 CLI/Plugin Output

The retained Pi extension modules (session health footer) and CLI output
use `chalk` for colour. Icons can be annotated via the framework's built-in
label system where supported.

### 9.2 CLI Output

CLI output uses `chalk` to colour output. When icons are enabled:

```
🚨 [CRIT] ← icon + fallback in muted colour beside it
```

The **text fallback is always appended** to the icon in CLI output, separated
by a space. This ensures:
- Copy/paste captures `[CRIT]` not just `🚨`.
- Screen readers pick up `[CRIT]` after the icon.
- Scripts parsing the output can use `[CRIT]` as a reliable marker.

---

## 10. Text Fallback & Copy/Paste

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
Priority: 🚨 [CRIT]   (or  [CRIT]  when icons disabled)
Status:   🟢 [OPEN]   (or  [OPEN]  when icons disabled)
```

---

## 11. Disabling Icons

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

## 12. Rendering Cost

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

## 13. Implementation Guide

### 13.1 CLI List Rendering

Icons are prepended before the title in CLI list output:

```
🔓 ✅ Set up CI pipeline  ← when icons enabled
[OPEN][PRODUCER_OK] Set up CI pipeline  ← when fallback
```

> The Pi-based TUI browse list (which rendered status/stage/producer-review/
> epic icons via `getIconPrefix` in `packages/tui/extensions/Worklog/lib/browse.ts`)
> has been removed — work item browsing is now provided by the Herdr plugin.
> The `dist/icons.ts` functions remain in use by the CLI and the retained
> session-health footer.

### 13.2 CLI Detail Output

File: `src/cli-output.ts`, `src/commands/helpers.ts` (`humanFormatWorkItem`)

The status and priority display lines include the icon:

```
Status:   🟢 [OPEN]
Priority: 🔴 [CRIT]
```

### 13.3 Tests

Tests should verify:
- Icon functions return expected emoji for valid inputs
- Icon functions return text fallback when `noIcons: true` or `WL_NO_ICONS=1`
- Icon functions return text fallback for unrecognized inputs (graceful)
- Accessible label functions return expected strings
- `iconsEnabled()` returns correct value based on env vars

---

## 14. Appendix: Example Usage

```ts
import { priorityIcon, statusIcon, iconsEnabled } from '../icons.js';

const useIcons = iconsEnabled({ noIcons: opts.noIcons });

// In a list renderer:
const icon = priorityIcon(item.priority, { noIcons: !useIcons });
const line = `${icon} ${item.title}`;

// In a detail view:
const pIcon = priorityIcon(item.priority, { noIcons: !useIcons });
const sIcon = statusIcon(item.status, { noIcons: !useIcons });
lines.push(`Status:   ${sIcon} ${item.status}`);
lines.push(`Priority: ${pIcon} ${item.priority}`);
```

---

## 15. Implementation Summary

### Files Created/Modified

| File | Change |
|------|--------|
| `src/icons.ts` | Core icon module with emoji, fallback, and label functions |
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

**CLI (TTY) with icons (normal format):**
```
| Field     | Value |
| --------- | ----- |
| ID        | TEST-1 |
| Title     | Set up CI pipeline |
| Status    | 🟢 Open [OPEN] · Stage: In Progress \| Priority: 🚨 critical [CRIT] |
| SortIndex | 100 |
| Risk      | — |
| Effort    | — |

Description: A test item for audit formatting
```

**CLI with icons disabled:**
```
| Field     | Value |
| --------- | ----- |
| ID        | TEST-1 |
| Title     | Set up CI pipeline |
| Status    | [OPEN] · Stage: In Progress \| Priority: critical |
| SortIndex | 100 |
| Risk      | — |
| Effort    | — |

Description: A test item for audit formatting
```

**TUI list:**
```
▸ 🚨 ⭐ Set up CI pipeline (TEST-1)
  ├── 📋 🔄 Write tests (TEST-2)
```
