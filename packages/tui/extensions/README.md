# TUI Extensions

Extension modules for the Worklog TUI and Pi agent integration.

## Settings

The extension has five user-configurable settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `browseItemCount` | `5` | Number of work items shown in the browse list (1–50). Critical and completed/in_review items are always shown regardless of this limit — see [Selection List Behaviour](#selection-list-behaviour) |
| `showIcons` | `true` | Whether to show emoji icons in the browse list and preview widget |
| `showActivityIndicator` | `true` | Whether to show the activity indicator (⏵) in the footer |
| `showHelpText` | `true` | Whether to show the shortcut help text line in the browse selection overlay |
| `autoInjectEnabled` | `true` | Whether to auto-inject relevant work items into the system prompt before each agent turn |

Settings are stored in Pi's canonical settings files under the `context-hub`
namespace. Settings changed via `/wl settings` are persisted to the project's
`.pi/settings.json`.

### Project `.pi` Discovery

The project settings directory is discovered the same way as the `.worklog`
directory (see `resolveWorklogDir()`/`resolvePiDir()` in `src/worklog-paths.ts`):

1. Walk up from the current working directory toward the git repo root; the
   **nearest** directory with a `.pi/settings.json` wins — a local settings
   file in the working directory (or a closer ancestor) overrides the repo
   root.
2. If no `.pi/settings.json` exists between the working directory and the
   repo root, the **git repo root's** `.pi/settings.json` is used.
3. Outside a git repository, the working directory is used as-is.

This means a project-level `.pi/settings.json` at the repo root is the
canonical settings location: running pi from a subdirectory (e.g.
`packages/herdr/`) loads and persists settings to the repo root unless a
closer `.pi/settings.json` exists. Unlike `.worklog`, worktree isolation is
not applied — `.pi` holds developer configuration, so settings are shared
across the repository.

### Resolution Order

Settings are resolved from multiple locations, with later sources overriding
earlier ones:

| Order | Source | File |
|-------|--------|------|
| 1 | Built-in defaults | `DEFAULT_SETTINGS` (code) |
| 2 | Global settings | `~/.pi/agent/settings.json` → `{ "context-hub": { ... } }` |
| 3 | Project settings | `<project>/.pi/settings.json` → `{ "context-hub": { ... } }` |

Project settings always win, allowing per-project overrides while individual
team members can set personal defaults globally. `project` is resolved
repo-root aware as described above (nearest `.pi/settings.json` wins, falling
back to the git repo root).

### Auto-Refresh

When the browse selection list overlay is open, the item list automatically
refreshes every 5 seconds. This ensures that newly created, updated, or
reassigned work items appear without requiring the user to close and re-open
the browse dialog.

**Behaviour:**

- The list re-fetches from the database every 5 seconds using the same
  `wl next` command and stage filter as the initial load.
- The currently selected item remains selected after a refresh, matched by
  work item ID. If the selected item no longer exists (e.g., was deleted or
  filtered out), the selection falls back to the first item.
- The refresh is deferred while a chord shortcut key sequence is in progress
  (e.g., after pressing a chord leader like `u`). Once the chord is resolved
  or cancelled, normal refresh resumes.
- No visual flash, spinner, or notification is shown — the data updates
  silently in-place.
- Auto-refresh is a hardcoded feature (5-second interval) with no
  configuration UI. It only applies to the browse list overlay, not
  to the detail view.

### Selection List Behaviour

The default (unfiltered) selection list always shows **all** critical-priority
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

The **stage-filtered** views (`/wl idea`, `/wl plan`, …) are unchanged: they
show only items matching the selected stage.

The "top N of M" title reflects the **actual displayed count** (N), which
may exceed `browseItemCount` when the mandatory set is large.

### Hierarchical Navigation (Drill into Children)

The browse selection list supports navigating into child work items
when an item has children. This allows you to drill down through the
work-item hierarchy without leaving the browse dialog.

**How it works:**

- When an item in the browse list has children (`childCount > 0`), pressing
  **Tab** on that item navigates into its children. All items with children
  are visually marked with a child count indicator (e.g., `(3)`),
  regardless of their issue type.
- **Enter** on any item (including parents with children) opens the detail
  view, as before.
- Pressing **Escape** while viewing children navigates back one level in
  the hierarchy. The footer shows a `[esc] back` hint (with `(N levels)`
  when nested deeper than one level) while inside a child list.
- You can drill down **arbitrarily deep** through the hierarchy (children
  of children of children, etc.) using the same Tab mechanism at each
  level.
- When navigating back to a parent level (via Escape), the previously
  selected item and list state are restored, so you return to the same
  position you left.
- At the root level (no parent context), pressing Enter on an item without
  children opens the detail view as before — behavior is unchanged for
  non-parent items.

**Example flow:**

1. Browse the root list — items with children show `(N)` count indicators.
2. Press Tab on an epic or other item with children → the list updates to
   show its child work items.
3. Press Tab on a child that also has children → navigate further down.
4. Press Escape to go back up one level.
5. At root level, pressing Enter on a leaf item opens the detail view.
6. Escape at root level closes the browse overlay.

**Note:** When navigating within child items, the auto-refresh feature
calls `fetchChildren()` to re-fetch the child items of the current parent
in-place, rather than refreshing the root-level list. This ensures new
children appear, completed children disappear, and re-sorted items are
repositioned — all while staying at the same navigation level. At the
root level, the standard `wl next` refresh is used.

### `/wl settings` Command

Open the settings overlay by typing `/wl settings` in the Pi editor. This opens an interactive overlay where you can change settings using the arrow keys and Enter.

- **Number of items**: Cycle through presets (3, 5, 10, 15, 20). Changes take effect immediately — the next `/wl` browse will use the new count.
- **Show icons**: Toggle between on/off. Changes are applied immediately — the preview widget and browse list reflect the change.
- **Activity indicator**: Toggle the activity indicator (⏵) in the footer on/off. When disabled, the footer line is hidden and no new indicators are shown. Existing indicators are cleared.
- **Help text**: Toggle the shortcut help text line in the browse selection overlay on/off. When disabled, the help line is hidden on the next browse overlay open.
- **Auto-inject items**: Toggle auto-injection of relevant work items before agent turns on/off. When enabled, the extension searches for related work items based on the prompt context and injects them into the system prompt automatically.

Press `Escape` to close the settings overlay.

### Settings File Format

Settings in Pi's settings files are stored under the `context-hub` namespace.
Example `.pi/settings.json`:

```json
{
  "context-hub": {
    "browseItemCount": 10,
    "showIcons": false,
    "showActivityIndicator": true,
    "showHelpText": true,
    "autoInjectEnabled": true
  }
}
```

When all settings files are missing or contain no `context-hub` section,
built-in defaults are used (5 items, icons enabled, activity indicator
enabled, help text enabled, auto-inject enabled).

## Activity Indicator

The extension displays a **persistent activity indicator** in the Pi footer,
showing the currently executing command or skill. The indicator appears as a
status line with a `⏵` prefix in the theme's accent color, positioned above
the directory path and Git branch info.

### What Triggers the Indicator

| Input Type | Example | Indicator Behavior |
|------------|---------|-------------------|
| Extension commands (via `/wl` or `Ctrl+Shift+B` shortcut) | `/wl`, `/wl progress` | Shows `⏵ /wl` |
| Skills | `/skill:audit WL-123` | Shows `⏵ skill:audit` |
| Built-in Pi commands | `/model`, `/settings`, `/new` | Clears the indicator |
| Free-form text | `Fix the login bug` | Clears the indicator |
| Other extension commands | `/other-ext-cmd` | Not detectable (Pi limitation) |

### Persistence

- The indicator persists across turns within a session until new input is typed.
- Creating a new session (`/new`) clears the indicator.
- Resuming a session (`/resume`) attempts to recover the last-known command
  from the session's history (best-effort).

### Graceful Degradation

The indicator gracefully degrades in non-TUI modes (print, JSON, RPC) where
`setStatus` is a no-op. The feature has no effect and does not produce errors
when used outside the Pi TUI.

### Technical Notes

- Uses Pi's `ctx.ui.setStatus()` API with the key `worklog-activity` to
  display the indicator in the footer's status line area. This avoids
  replacing the entire footer and does not conflict with existing widget
  or status usage.
- The indicator text is truncated to fit the terminal width with an ellipsis
  (`…`) for overflow.
- Extension commands registered by the Worklog extension itself (`/wl`,
  `Ctrl+Shift+B`) set the indicator directly in their command handlers.
- Skills (`/skill:name`) are captured via Pi's `input` event, which fires
  before skill expansion.
- Built-in Pi commands and free-form text clear the indicator via the same
  `input` event handler.

## Session Health Footer

The extension displays a **real-time session health footer** that replaces
Pi's default footer with a rich health dashboard showing:

### What It Displays

The footer uses a **three-section layout**: **left** (status + elapsed time since last response + turn count + last-chunk timer), **center** (total wall-clock session duration), and **right** (token usage + context + model).

| Element | Description |
|---------|-------------|
| **Status marker** | `○` idle, `●` streaming, `⚡ <tool>` tool execution |
| **Last chunk time** | Elapsed time since the last streaming chunk (e.g., `(Last Chunk: 3s ago)`) — shown only during active streaming |
| **Turn count** | Number of turns in the current session (e.g., `#3`) |
| **Response elapsed** | Colour-coded elapsed time since the last model response (shown after the state marker in the left section) |
| **Total session time** | Total wall-clock session duration (e.g., `Total: 5m 42s`) — shown in the center section |
| **Token usage** | Input/output token counts (e.g., `↑1.2k ↓4.5k`) |
| **Context usage** | Percentage of context window (e.g., `76.8%/128k`) |
| **Model ID** | Currently active model (e.g., `gpt-4`). While a model alias is selected but no resolved provider/model has been received yet, shows `{alias} → (resolving)` (e.g., `code → (resolving)`). |

### Colour Coding

The response age indicator uses colour coding to provide at-a-glance health:

| Colour | Threshold | Meaning |
|--------|-----------|--------|
| Green (`success`) | < 5s | Healthy — response received recently |
| Yellow/Orange (`warning`) | 5–30s | Moderate delay — model is processing |
| Red (`error`) | > 30s | Stuck or slow — consider interrupting |

### Layout

The footer spans three lines. The first line shows extension status entries
(e.g., activity indicator). The second line shows session health metrics in
a **three-section layout**. The third line shows the model/provider info and
(optionally) an initial prompt preview:

```
⏵ /wl                                                                        ← Extension statuses
● Streaming 45s #5   Total: 5m 42s  ↑1.2k ↓4.5k 39.1%/128k                  ← Session health
code → openai/gpt-4  │  Fix the bug                                          ← Model + prompt
│  │          │   │  │             │           │    │       │              │
│  │          │   │  │             │           │    │       └────────────── Context usage
│  │          │   │  │             │           │    └────────────────────── Output tokens
│  │          │   │  │             │           └─────────────────────────── Input tokens
│  │          │   │  │             └─────────────────────────────────────── Total session time
│  │          │   │  └───────────────────────────────────────────────────── Last chunk timer (streaming only)
│  │          │   └──────────────────────────────────────────────────────── Turn count
│  │          └──────────────────────────────────────────────────────────── Elapsed time since last response
└────────────────────────────────────────────────────────────────────────── Status marker
```

### Model/Provider Display (Line 3)

The third footer line shows the model alias and resolved provider/model in
dimmed text. The display varies depending on available state:

| State | Example |
|-------|---------|
| Model alias selected, resolved provider/model received | `code → openai/gpt-4` |
| Model alias selected, waiting for resolution | `code → (resolving)` |
| No model alias, resolved provider/model available | `openai/gpt-4` |
| No model info at all | `—` |

When an initial prompt preview is available, it is shown after the model
info separated by a vertical bar (e.g., `code → openai/gpt-4  │  Fix the bug`).

During **idle** or **tool execution**, the last-chunk timer is not shown.

### Event Tracking

The extension subscribes to the following Pi lifecycle events to update state:

| Event | Update |
|-------|--------|
| `turn_start` | Increment turn count, set status to streaming, set last-response timer |
| `message_update` | Update last-chunk timer (shown during active streaming) |
| `message_end` (assistant) | Set status to idle, update response time |
| `tool_execution_start` | Set status to tool with tool name |
| `tool_execution_end` | Reset status to idle |
| `model_select` | Refresh footer display |
| `session_start` | Reset counters, initialize footer |
| `session_shutdown` | Clean up ticker interval |

### Ticker

A 1-second `setInterval` ticker refreshes the token counts and context usage
from the session manager. The footer re-renders automatically when the branch
changes.

### Graceful Degradation

The session health footer gracefully degrades in non-TUI modes (print, JSON,
RPC) where `setFooter` is a no-op. The feature has no effect and does not
produce errors when used outside the Pi TUI.

### Technical Notes

- Uses Pi's `ctx.ui.setFooter()` API to replace the entire footer with a
  custom render function.
- The footer renderer uses `truncateToWidth` and `visibleWidth` from
  `@earendil-works/pi-tui` for safe ANSI-aware truncation.
- Only one `setFooter()` can be active at a time. This module's footer
  replaces Pi's default footer (git branch, cwd path, etc.).
- The footer includes extension status entries (set via `ctx.ui.setStatus()`)
  from `footerData.getExtensionStatuses()` as the first line. This ensures
  that status entries from other modules — such as the resolved
  provider/model (`worklog-0model`) and the activity indicator
  (`worklog-activity`) — remain visible alongside the session health metrics.
- The footer uses a **three-section layout**: left (status marker + elapsed
  time since last response + turn count + last-chunk timer), center (total
  session duration), and right (token counts + context usage + model ID).
- A `lastChunkTime` property tracks the timestamp of the last `message_update`
  event. The **last-chunk timer** `(Last Chunk: Xs ago)` is displayed in the
  left section only when `status === 'streaming'`.
- Token counts are calculated from session entries by summing
  `usage.input` and `usage.output` from assistant messages.
- Context usage is obtained from `ctx.getContextUsage()` which returns
  `{ tokens, contextWindow, percent }`.

## Error Recovery Module

The extension includes a built-in automatic error recovery module that replaces the
standalone `pi-retry` extension. When the recovery module is active, pi's built-in
retry mechanism is suppressed and errors are handled according to per-category
configuration.

### Error Categories

| Category | Default Action | Description |
|----------|---------------|-------------|
| `rateLimit` (429) | NOT retried | Informative error shown to the user |
| `serverError` (5xx) | Retried | Exponential backoff with configurable delay |
| `authError` (401/403) | NOT retried | Checkpoint saved + terminal error displayed |
| `contextLength` | Compact + Continue | `/compact` triggered, then auto-continue |
| `quotaExhausted` | NOT retried | Checkpoint saved + terminal error displayed |
| `timeout` | Retried | Exponential backoff with configurable delay |
| `terminated` | NOT retried | Checkpoint saved + terminal error displayed |

### Configuration

Recovery settings are stored under `context-hub.recovery.*` in Pi's settings files.
Each category can be configured individually:

```json
{
  "context-hub": {
    "recovery": {
      "serverError": {
        "enabled": true,
        "baseDelayMs": 2000,
        "maxDelayMs": 60000
      },
      "timeout": {
        "enabled": true,
        "baseDelayMs": 2000,
        "maxDelayMs": 60000
      },
      "rateLimit": {
        "enabled": false
      }
    }
  }
}
```

### `/retry` Command

The module registers a `/retry` command with the following subcommands:

- `/retry` — Manual trigger: auto-detects the last error and applies the correct
  recovery strategy (retry, compact+continue, or warning)
- `/retry status` — Displays diagnostics: per-category attempt counts, last
  error messages, is-retrying flags, continuation count
- `/retry reset` — Resets all retry counters and state

### Architecture

The recovery module is implemented in `Worklog/lib/recovery/` and consists of:

| File | Purpose |
|------|---------|
| `error-patterns.ts` | Error classification patterns for all 7 categories |
| `retry-logic.ts` | Exponential backoff, state managers, interruptible sleep |
| `recovery.ts` | Compact-and-continue and checkpoint-and-terminate handlers |
| `retry-command.ts` | `/retry` command interface (status, reset, manual-trigger) |
| `register-recovery.ts` | Extension lifecycle wiring (agent_end, turn_end, session_start) |

The module is auto-registered during extension initialization in `index.ts`.

## Auto-Injection

The extension automatically injects relevant work items into the system
prompt before each agent turn, providing context without requiring manual
`wl next` or `wl list` calls.

### How It Works

When a new agent turn begins, the `before_agent_start` hook triggers the
auto-injection pipeline:

1. **ID Detection**: The user's prompt text is scanned for work item ID
   patterns (e.g., `WL-0MQL0T5TR0060AEH`). All unique IDs are collected.

2. **ID-Based Scanning** (when IDs are detected in the prompt):
   - The referenced work item is fetched via `wl show`.
   - Its **description** is scanned for embedded work item IDs.
   - Its **comments** are fetched via `wl comment list` and scanned for IDs.
   - Its **children** are fetched via `wl list --parent` and included directly.
   - Each discovered related work item is fetched via `wl show` and added to
     the result set, deduplicated against already-known IDs.
   - The originally referenced ID is excluded from the related-items list.

3. **Keyword Fallback** (only when NO work item ID is detected in the prompt):
   A `wl search` is performed using the prompt keywords to find related
   items (up to 5 results). This preserves backward compatibility for
   prompts like "working on implementation task" that don't reference a
   specific work item.

4. **Formatting**: Found items are formatted as markdown context:
   - **Full-detail mode** (≤3 items): Shows ID, title, and inline tags
     for priority, status, and stage.
   - **Links-only mode** (>3 items): Compact ID + title list.
5. **Injection**: The formatted context is appended to the system prompt
   under a `## Relevant Work Items` heading.
6. **Status Indicator**: A status bar notification (e.g., `📋 3 items
   auto-injected`) is shown briefly in the footer.

### What Gets Injected

**Full-detail mode** (≤3 items):
```markdown
## Relevant Work Items

- **WL-123**: Fix login bug `high` `open` `in_progress`
- **WL-456**: Add tests `medium` `in_review`
```

**Links-only mode** (>3 items):
```markdown
## Relevant Work Items

- WL-123: Fix login bug
- WL-456: Add tests
```

### Configuration

Auto-injection can be toggled via the `autoInjectEnabled` setting:
- **`/wl settings`** — Toggle the "Auto-inject items" option on/off
- **`.pi/settings.json`** — Set `{ "context-hub": { "autoInjectEnabled": false } }`

Changes take effect immediately. When disabled, the `before_agent_start`
handler returns without performing any search or injection.

### Graceful Degradation

- Missing or invalid work item IDs are silently skipped (no errors surfaced).
- Comment listing or child fetching failures are silently caught — the
  handler degrades gracefully to still return the explicitly referenced IDs
  and any successfully scanned sources.
- `wl search` keyword fallback failures are silently caught — the handler
  returns only the explicitly referenced and discovered related IDs.
- When the prompt contains only IDs (no searchable text), ID-based scanning
  still runs — description, comments, and children are scanned for related
  work items.
- When no related items are found, the system prompt is left unmodified.
- In non-TUI modes (print, JSON, RPC), the status bar indicator is a no-op
  with no errors.

### Technical Notes

- Implemented in `Worklog/lib/auto-inject.ts` and registered in `Worklog/index.ts`.
- Uses Pi's `before_agent_start` hook — available in the pi ExtensionAPI.
- The `AUTO_INJECT_STATUS_KEY` (`worklog-auto-inject`) is used for the
  status bar indicator to avoid conflicts with other status entries.

## `/wl` Slash Command — Stage Filtering

The `/wl` slash command browses work items recommended by the `wl next` algorithm. The number of items shown is controlled by the `browseItemCount` setting (default: 5). It also supports an optional stage filter argument.

### Usage

```
/wl              # Show unfiltered work items (count from settings)
/wl settings     # Open the settings overlay
/wl schedule     # Manage periodic request schedules (see Periodic Request Scheduler)
/wl idea         # Show items in idea stage
/wl intake       # Show items in intake_complete stage
/wl plan         # Show items in plan_complete stage
/wl progress     # Show items in in_progress stage
/wl review       # Show items in in_review stage
/wl in_progress  # Canonical stage names also work
/wl in_review    # Canonical stage names also work
```

### Stage Shorthand Aliases

| Shorthand | Canonical Stage |
|-----------|----------------|
| `intake`  | `intake_complete` |
| `plan`    | `plan_complete` |
| `progress`| `in_progress` |
| `review`  | `in_review` |

All canonical stage names (`idea`, `in_progress`, `in_review`, `intake_complete`, `plan_complete`) are also recognised directly.

### Invalid Values

Typing an unrecognised stage value produces an error notification and falls back to the default unfiltered list without crashing.

### Autocomplete

The `/wl` command registers `getArgumentCompletions`, so Pi's editor shows autocomplete suggestions for valid stage values (both shorthand and canonical) and the `settings`/`schedule` commands when typing arguments.

### Example

- `/wl progress` — filters to items in `in_progress` stage
- `/wl in_review` — filters to items in `in_review` stage
- `/wl settings` — opens the settings overlay
- `/wl schedule list` — lists all configured periodic request schedules
- `/wl schedule add "0 1 * * *" "Daily audit"` — adds a daily audit schedule
- `/wl` — shows the default unfiltered items (count from settings)
- `/wl   ` — whitespace-only arguments are treated as "no arguments" and show unfiltered items

## Shortcuts

Source config file: `packages/tui/extensions/Worklog/shortcuts.json`
(installed to `~/.pi/agent/extensions/worklog/Worklog/shortcuts.json`).

The `shortcuts.json` config file defines a **config-driven shortcut system** that allows keyboard shortcuts in the Pi extension's worklog browse views (list and detail) to be expressed declaratively rather than hardcoded.

### Schema

Each shortcut entry is a JSON object. Entries use **either** `key` (single-character immediate dispatch) **or** `chord` (multi-key sequence) — they are mutually exclusive.

Single-key entry:

```json
{
  "key": "i",
  "command": "implement <id>",
  "view": "both",
  "stages": ["intake_complete"],
  "label": "implement",
  "description": "Run the implement workflow on the selected work item"
}
```

Chord entry:

```json
{
  "chord": ["u", "p"],
  "command": "!!wl update --priority <id>",
  "view": "both",
  "label": "update priority",
  "description": "Update the priority of the selected work item"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `key` | string _(mutually exclusive with `chord`)_ | Single character key to trigger the shortcut immediately (e.g., `"i"`, `"p"`). Exactly one of `key` or `chord` must be set. |
| `chord` | string[] _(mutually exclusive with `key`)_ | Two-or-more character sequence that triggers the shortcut. The first key is the **leader** — pressing it enters a pending-chord state and the help line updates to show available completions. The second key (or remaining keys) completes the chord. Example: `["u", "p"]` means press `u` then `p`. |
| `command` | string | Template string to insert into the Pi editor. The placeholder `<id>` is replaced with the selected work item's ID. |
| `view` | string | Which view the shortcut applies to: `"list"` (browse selection only), `"detail"` (detail view only), or `"both"` (both views). |
| `label` | string _(optional)_ | Short display label shown in the browse help line (e.g., `"implement"`, `"plan"`). When provided, overrides the label derived from the command string. Chord entries are displayed as `leader:firstWord...` (e.g., `u:update...`) to keep the help line compact. |
| `description` | string _(optional)_ | One-sentence description of the command for use in help screens (e.g., `"Run the implement workflow on the selected work item"`). |
| `stages` | string[] _(optional)_ | Allow-list of work item stages for which the shortcut is available. When omitted or empty, the shortcut is unconditionally available (backward compatible). The stage comparison is case-sensitive, exact match. |

### Stage-Based Visibility

Shortcuts can be made conditional on the selected work item's stage using the optional `stages` field:

- **With `stages` set**: The shortcut only appears and dispatches when the selected item's stage matches one of the listed values.
- **Without `stages`** (or `stages: []`): The shortcut is always available, preserving backward compatibility.

This allows contextual shortcuts — for example, showing an **intake** shortcut only for items in the `idea` stage, and an **implement** shortcut only for items in the `intake_complete` stage.

#### Visibility Rules

| `stages` value | Behavior |
|----------------|----------|
| `undefined` (omitted) | Shortcut always available |
| `[]` (empty array) | Shortcut always available |
| `["idea"]` | Shortcut only available when item stage is `"idea"` |
| `["idea", "in_progress"]` | Shortcut available when item stage is `"idea"` or `"in_progress"` |

### Chord Shortcuts

Chord shortcuts let you dispatch commands with a two-key sequence. Press the **leader** key first — this does not dispatch anything. Instead, the help line updates to show available completions for that leader. Press the second key to complete the chord and dispatch the command.

#### How Chords Work

1. Press the leader key (e.g., `u`) — the shortcut does not fire. The help line updates to show available completions for that leader.
2. Press the completion key (e.g., `p`) — the full chord (`u-p`) is dispatched and the command is inserted into the editor.
3. Press `Escape` at any point during chord input to cancel.
4. Press an unrecognised completion key to cancel the pending chord.

#### Examples

| Chord | Command | Description |
|-------|---------|-------------|
| `u-p` | `!!wl update --priority <id>` | Update the priority of the selected work item |
| `u-t` | `!!wl update --title <id>` | Update the title of the selected work item |
| `f-i` | `/wl idea` | Filter browse list to items in the idea stage |
| `f-n` | `/wl intake` | Filter browse list to items in the intake_complete stage |
| `f-p` | `/wl plan` | Filter browse list to items in the plan_complete stage |
| `f-r` | `/wl review` | Filter browse list to items in the in_review stage |

#### Chord Help Text

When a chord leader key is pressed, the help line replaces the normal shortcut hints with the available chord completions for that leader. The pending state shows only the second key and the distinguishing part of the label (the first word is dropped since it's implied by the leader context).

For example, pressing `u` while the help line is visible would show:
```
🔗 p:priority t:title
```

#### Chord Stage Filtering

Chord entries respect the same `stages` field as key-based shortcuts. If a chord entry has `stages` set, it only appears in the help line completions and only dispatches when the selected item's stage matches. Chords without a `stages` constraint (or with an empty array) are always available.

#### Reserved Keys

The same reserved navigation keys (`g`, `G`, ` `) that cannot be used as shortcut keys also cannot be chord leaders. Any chord entry with a reserved leader key is silently ignored.

#### Key Differences from Single-Key Shortcuts

| Aspect | Single-key shortcut | Chord shortcut |
|--------|-------------------|----------------|
| Trigger | Press key once | Press leader key, then completion key |
| Help text | Always visible | Shown after pressing the leader key |
| Cancel | N/A | Press `Escape` or unrecognised key |
| Entry format | `{"key": "i", ...}` | `{"chord": ["u", "p"], ...}` |

### Current Shortcuts

| Type | Key(s) | Command | View | Stages | Label | Description |
|------|--------|---------|------|--------|-------|-------------|
| key | `c` | `create <desc>` | both | `["idea"]` | create | Create a new work item with a description and priority template |
| key | `n` | `intake <id>` | both | `["idea"]` | intake | Create a new work item from the selected item via intake |
| key | `p` | `plan <id>` | both | `["intake_complete"]` | plan | Run the plan workflow on the selected work item |
| key | `i` | `implement <id>` | both | `["plan_complete"]` | implement | Run the implement workflow on the selected work item |
| key | `a` | `audit <id>` | both | (always available) | audit | Run an audit on the selected work item |
| chord | `u-p` | `!!wl update --priority <id>` | both | (always available) | update priority | Update the priority of the selected work item |
| chord | `u-t` | `!!wl update --title <id>` | both | (always available) | update title | Update the title of the selected work item |
| chord | `f-i` | `/wl idea` | both | (always available) | filter idea | Filter browse list to items in the idea stage |
| chord | `f-n` | `/wl intake` | both | (always available) | filter intake | Filter browse list to items in the intake_complete stage |
| chord | `f-p` | `/wl plan` | both | (always available) | filter plan | Filter browse list to items in the plan_complete stage |
| chord | `f-r` | `/wl review` | both | (always available) | filter in_review | Filter browse list to items in the in_review stage |

### Help Text Filtering

The help text shown in the browse list dynamically filters shortcuts based on the currently selected item's stage. As you navigate between items with different stages, the help text updates to show only applicable shortcuts. Both key-based and chord-based shortcuts are included in the help line.

For example:
- Selecting an item in the `idea` stage shows `c:create`, `n:intake`, `u:update...`, and `a:audit`.
- Selecting an item in `intake_complete` shows `i:implement`, `p:plan`, `u:update...`, and `a:audit`.
- Selecting an item in `in_progress` shows `u:update...`, and `a:audit`.

When a chord leader key (e.g. `u`) is pressed, the help line temporarily updates to show only the available chord completions for that leader, prefixed with `🔗`. Each completion is shown as the second key followed by the distinguishing part of the label:

```
🔗 p:priority t:title
```

### How It Works

1. **Config loading**: `Worklog/shortcut-config.ts` loads `Worklog/shortcuts.json` at extension initialization and builds a `ShortcutRegistry` in memory. Key-based and chord-based entries are indexed separately for efficient lookup.
2. **Graceful degradation**: If the config file is missing or contains malformed JSON, the registry is empty (no shortcuts) and a warning is logged. Invalid entries (including entries with both `key` and `chord`, or missing required fields) are silently skipped.
3. **Dispatch**: Both the browse list dispatcher (`defaultChooseWorkItem`) and detail view dispatcher (`createScrollableWidget`) check a set of reserved navigation keys before attempting shortcut lookup. If the pressed key is reserved (see [Reserved Navigation Keys](#reserved-navigation-keys)), shortcut lookup is skipped and navigation takes precedence.
   - **Single-key shortcuts**: For non-reserved single-character keys, `shortcutRegistry.lookup(key, view)` is called. If a match is found, the command template is substituted (`<id>` → selected item ID) and inserted into the editor.
   - **Chord shortcuts**: If no single-key match is found, the registry checks if the key is a chord leader via `shortcutRegistry.getChordByLeader(key, view)`. If chords exist for that leader, the system enters a **pending-chord state** and updates the help line. Pressing a valid completion key triggers `shortcutRegistry.lookupChord([leader, completion], view)`, which dispatches the matching command.
4. **No trailing newline**: The inserted text has no trailing newline, allowing the user to review or edit the command before pressing Enter to submit.

### Detail View Shortcut Hints

The detail view overlay displays a shortcut hint line at the bottom of the rendered content (below the work item details). This hint line follows the same formatting and stage-filtering logic as the selection list hints:

- Available shortcuts whose `view` includes `detail` or `both` are shown, filtered by the selected item's stage.
- When a chord leader key is pressed, the hint line temporarily updates to show available chord completions (same `🔗` prefix as the selection list).
- The hint line respects the `showHelpText` setting — hidden when disabled.
- The hint line is rendered as dim text, truncated to the terminal width, and is not part of the scrollable content.

### Reserved Navigation Keys

The following single-character keys are reserved for navigation and **cannot** be used as shortcut keys. Any shortcut entry in `shortcuts.json` with one of these keys will be silently ignored (navigation takes precedence):

| Key | Navigation Action | View |
|-----|-------------------|------|
| `g` | Scroll to top | detail |
| `G` | Scroll to bottom | detail |
| ` ` (space) | Page down | detail |

Multi-character navigation keys (e.g., escape sequences for arrow keys, key-id strings like `enter`, `escape`, `up`, `down`) are already excluded from shortcut lookup because the dispatcher only checks single-character keys.

### Adding a New Shortcut

#### Key-based Shortcut

1. Add a new entry to `shortcuts.json` with the desired `key`, `command`, and `view`.
2. Ensure the `key` is not a reserved navigation key (see above).
3. The shortcut is immediately available — no code changes needed.

Example:

```json
{
  "key": "c",
  "command": "close <id> --reason \"fixed\"",
  "view": "detail"
}
```

#### Chord-based Shortcut

1. Add a new entry to `shortcuts.json` with `chord` (an array of 2+ key strings), `command`, and `view`.
2. Ensure the first key in the chord is not a reserved navigation key.
3. Optionally add `label`, `description`, and `stages` fields.
4. The chord shortcut is immediately available — no code changes needed.

Example:

```json
{
  "chord": ["u", "p"],
  "command": "!!wl update --priority <id>",
  "view": "both",
  "label": "update priority",
  "description": "Update the priority of the selected work item"
}
```

## Lease Release

The extension includes a **proactive lease release** module that automatically
releases the previous session's model lease when a new Pi session is created
(via `/new`). This speeds up model reclamation on the Local Proxy provider.

### How It Works

1. When Pi fires a `session_start` event with reason `"new"` (indicating a
   session replacement), the module reads `~/.pi/agent/models.json` to locate
   the `"Local Proxy"` provider's `baseUrl`.
2. It sends a best-effort `POST {baseUrl}/leases/release` with a JSON body
   containing the previous session's identifier (`previousSessionFile`).
3. The call is **fire-and-forget**: it does not block session startup.
   Failures (network errors, non-2xx responses) are silently logged at
   debug level only — no user-visible errors.
4. If the `"Local Proxy"` provider is not configured, no request is sent.

### When It Fires

| Session Start Reason | Lease Release Triggered |
|----------------------|------------------------|
| `"startup"` (initial Pi launch) | No |
| `"new"` (session via `/new`) | Yes |
| `"resume"` (session resumed) | No |
| `"fork"` (session forked) | No |
| `"reload"` (extensions reloaded) | No |

### Technical Notes

- Implemented in `Worklog/lease-release.ts`.
- The proxy configuration is read at runtime from `~/.pi/agent/models.json`.
- Results are cached per-extension-lifecycle to avoid repeated filesystem reads.
- Registered in `Worklog/index.ts` via `registerLeaseRelease(pi)`.
- Tests are in `Worklog/lease-release.test.ts`.

## Periodic Request Scheduler

The extension includes a **periodic request scheduler** that automatically submits pi requests on a recurring schedule using cron expressions. This is useful for automating recurring tasks such as hourly audits, daily intake checks, or nightly cleanup while the pi session is running.

Requests are submitted through pi's normal message flow via `pi.sendUserMessage()`, making both the request and its response fully visible in the session history.

### How It Works

1. **Background ticker**: The scheduler runs a background interval (every 30 seconds by default) that checks all configured schedules.
2. **Cron matching**: For each enabled schedule, the current time is checked against the cron expression. If the expression matches the current minute, the request is a candidate for submission.
3. **Idle check**: Before submitting, the scheduler verifies that the pi agent is idle (no active streaming or tool execution) to avoid interrupting active work. If the agent is busy, the scheduled run is skipped for that minute.
4. **Duplicate prevention**: Once a schedule fires, it will not fire again within the same minute, preventing duplicate submissions.
5. **Visibility**: The request is submitted via `pi.sendUserMessage()`, so it appears as a user message in the session log alongside any pi responses.

### The `/wl schedule` Command

Manage configured schedules via the `/wl schedule` command. Autocomplete for `schedule` is available when typing `/wl ` in Pi's editor.

#### Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List all configured schedules with their ID, cron expression, request text, label, and enabled status |
| `add <cron> <request>` | Add a new schedule with a cron expression and pi request text. Optionally add `--label <label>` for display |
| `remove <id>` | Remove a schedule by its unique ID |
| `toggle <id>` | Enable or disable a schedule by its ID without removing it |
| `help` | Show help text with usage and examples |

#### Examples

```
/wl schedule add "0 1 * * *" "/skill:audit WL-123" --label "Daily audit"
/wl schedule add "*/15 * * * *" "Check for new work items"
/wl schedule list
/wl schedule toggle sched-abc123-1
/wl schedule remove sched-abc123-1
```

### Cron Expression Format

The scheduler supports standard 5-field cron expressions:

```
 ┌────────── minute (0-59)
 │ ┌───────── hour (0-23)
 │ │ ┌──────── day of month (1-31)
 │ │ │ ┌────── month (1-12)
 │ │ │ │ ┌──── day of week (0-7, 0 and 7 are Sunday)
 │ │ │ │ │
 * * * * *
```

Supported syntax:

| Syntax | Description | Example |
|--------|-------------|---------|
| `*` | Wildcard — matches every value | `*` in minute field = every minute |
| `N` | Exact value | `0` in hour field = midnight only |
| `N,M` | List of values | `1,15` in minute field = at minutes 1 and 15 |
| `N-M` | Range of values (inclusive) | `9-17` in hour field = every hour from 9am to 5pm |
| `*/N` | Step with wildcard | `*/15` in minute field = every 15 minutes |
| `N-M/N` | Step with range | `1-30/10` in minute field = at 1, 11, 21 minutes past the hour |

#### Common Examples

| Cron Expression | Description |
|----------------|-------------|
| `0 * * * *` | Every hour at minute 0 |
| `*/15 * * * *` | Every 15 minutes |
| `0 1 * * *` | Daily at 1:00 AM |
| `0 9,17 * * 1-5` | Weekdays at 9:00 AM and 5:00 PM |
| `0 0 * * 0` | Midnight every Sunday |

### Configuration Persistence

Schedule configuration is persisted to the project's `.pi/settings.json` under the `context-hub` namespace and survives pi restarts. When a new session starts (`session_start`), the scheduler reloads schedules from disk and resumes.

Example `.pi/settings.json`:

```json
{
  "context-hub": {
    "schedules": [
      {
        "id": "sched-abc123-1",
        "cron": "0 1 * * *",
        "request": "/skill:audit WL-123",
        "label": "Daily audit",
        "enabled": true
      }
    ]
  }
}
```

Schedules can be added and removed via `/wl schedule add` and `/wl schedule remove`, or by editing the settings file directly.

### Technical Notes

- Implemented in `Worklog/lib/scheduler.ts`.
- Uses a minimal bundled cron expression parser with zero external dependencies.
- Agent idle state is tracked via pi lifecycle events (`turn_start`, `message_end`, `tool_execution_start`).
- The background ticker runs at 30-second intervals (not configurable via settings, but adjustable in code).
- The scheduler is registered in `Worklog/index.ts` via `registerScheduler(pi)`.
- Lifecycle: starts on `session_start`, stops on `session_shutdown`.
- Tests are in `Worklog/lib/scheduler.test.ts` (48 tests).
```
