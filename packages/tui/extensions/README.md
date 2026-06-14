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
  "view": "both",
  "stages": ["intake_complete"],
  "label": "implement",
  "description": "Run the implement workflow on the selected work item"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | Single character key to trigger the shortcut (e.g., `"i"`, `"p"`) |
| `command` | string | Template string to insert into the Pi editor. The placeholder `<id>` is replaced with the selected work item's ID. |
| `view` | string | Which view the shortcut applies to: `"list"` (browse selection only), `"detail"` (detail view only), or `"both"` (both views). |
| `label` | string _(optional)_ | Short display label shown in the browse help line (e.g., `"implement"`, `"plan"`). When provided, overrides the label derived from the command string. |
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

### Current Shortcuts

| Key | Command | View | Stages | Label | Description |
|-----|---------|------|--------|-------|-------------|
| `c` | `create <desc>` | both | `["idea"]` | create | Create a new work item with a description and priority template |
| `i` | `implement <id>` | both | `["intake_complete"]` | implement | Run the implement workflow on the selected work item |
| `p` | `plan <id>` | both | `["intake_complete"]` | plan | Run the plan workflow on the selected work item |
| `n` | `intake <id>` | both | `["idea"]` | intake | Create a new work item from the selected item via intake |
| `a` | `audit <id>` | both | (always available) | audit | Run an audit on the selected work item |

### Help Text Filtering

The help text shown in the browse list dynamically filters shortcuts based on the currently selected item's stage. As you navigate between items with different stages, the help text updates to show only applicable shortcuts.

For example:
- Selecting an item in the `idea` stage shows `c:create`, `n:intake`, and `a:audit`.
- Selecting an item in `intake_complete` shows `i:implement`, `p:plan`, and `a:audit`.
- Selecting an item in `in_progress` shows only `a:audit`.

### How It Works

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
