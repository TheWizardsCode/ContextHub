# TUI Extensions

Extension modules for the Worklog TUI and Pi agent integration.

## `/wl` Slash Command — Stage Filtering

The `/wl` slash command browses up to 5 work items recommended by the `wl next` algorithm. It supports an optional stage filter argument.

### Usage

```
/wl              # Show top 5 unfiltered work items (default)
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

All canonical stage names (`in_progress`, `in_review`, `intake_complete`, `plan_complete`) are also recognised directly.

### Invalid Values

Typing an unrecognised stage value produces an error notification and falls back to the default unfiltered list without crashing.

### Autocomplete

The `/wl` command registers `getArgumentCompletions`, so Pi's editor shows autocomplete suggestions for valid stage values (both shorthand and canonical) when typing arguments.

### Example

- `/wl progress` — filters to items in `in_progress` stage
- `/wl in_review` — filters to items in `in_review` stage
- `/wl` — shows the default unfiltered top 5 items (backward compatible)
- `/wl   ` — whitespace-only arguments are treated as "no arguments" and show unfiltered items

## Shortcuts

The `shortcuts.json` config file defines a **config-driven shortcut system** that allows keyboard shortcuts in the Pi extension's worklog browse views (list and detail) to be expressed declaratively rather than hardcoded.

### Schema

Each shortcut entry is a JSON object:

```json
{
  "key": "i",
  "command": "implement <id>",
  "view": "both"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | Single character key to trigger the shortcut (e.g., `"i"`, `"p"`) |
| `command` | string | Template string to insert into the Pi editor. The placeholder `<id>` is replaced with the selected work item's ID. |
| `view` | string | Which view the shortcut applies to: `"list"` (browse selection only), `"detail"` (detail view only), or `"both"` (both views). |

### Current Shortcuts

| Key | Command | View |
|-----|---------|------|
| `i` | `implement <id>` | both |
| `p` | `plan <id>` | both |
| `n` | `intake <id>` | both |
| `a` | `audit <id>` | both |

### How It Works

1. **Config loading**: `shortcut-config.ts` loads `shortcuts.json` at extension initialization and builds a `ShortcutRegistry` in memory.
2. **Graceful degradation**: If the config file is missing or contains malformed JSON, the registry is empty (no shortcuts) and a warning is logged. Invalid entries are silently skipped.
3. **Dispatch**: Both the browse list dispatcher (`defaultChooseWorkItem`) and detail view dispatcher (`createScrollableWidget`) check a set of reserved navigation keys before attempting shortcut lookup. If the pressed key is reserved (see [Reserved Navigation Keys](#reserved-navigation-keys)), shortcut lookup is skipped and navigation takes precedence. For non-reserved single-character keys, `shortcutRegistry.lookup(key, view)` is called. If a match is found, the command template is substituted (`<id>` → selected item ID) and inserted into the editor via `ctx.ui.setEditorText()`.
4. **No trailing newline**: The inserted text has no trailing newline, allowing the user to review or edit the command before pressing Enter to submit.

### Reserved Navigation Keys

The following single-character keys are reserved for navigation and **cannot** be used as shortcut keys. Any shortcut entry in `shortcuts.json` with one of these keys will be silently ignored (navigation takes precedence):

| Key | Navigation Action | View |
|-----|-------------------|------|
| `g` | Scroll to top | detail |
| `G` | Scroll to bottom | detail |
| ` ` (space) | Page down | detail |

Multi-character navigation keys (e.g., escape sequences for arrow keys, key-id strings like `enter`, `escape`, `up`, `down`) are already excluded from shortcut lookup because the dispatcher only checks single-character keys.

### Adding a New Shortcut

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
