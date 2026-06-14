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
| `label` | string _(optional)_ | Short display label shown in the browse help line (e.g., `"implement"`, `"plan"`). When provided, overrides the label derived from the command string. Chord entries are displayed as `leader-second:label` (e.g., `u-p:update priority`). |
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

#### Chord Help Text

When a chord leader key is pressed, the help line replaces the normal shortcut hints with the available chord completions for that leader. The format is `leader-second:label`.

For example, pressing `u` while the help line is visible would show:
```
🔗 u-p:update priority u-t:update title
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

### Help Text Filtering

The help text shown in the browse list dynamically filters shortcuts based on the currently selected item's stage. As you navigate between items with different stages, the help text updates to show only applicable shortcuts. Both key-based and chord-based shortcuts are included in the help line.

For example:
- Selecting an item in the `idea` stage shows `c:create`, `n:intake`, `u-p:update priority`, `u-t:update title`, and `a:audit`.
- Selecting an item in `intake_complete` shows `i:implement`, `p:plan`, `u-p:update priority`, `u-t:update title`, and `a:audit`.
- Selecting an item in `in_progress` shows `u-p:update priority`, `u-t:update title`, and `a:audit`.

When a chord leader key (e.g. `u`) is pressed, the help line temporarily updates to show only the available chord completions for that leader, prefixed with `🔗`:

```
🔗 u-p:update priority u-t:update title
```

### How It Works

1. **Config loading**: `shortcut-config.ts` loads `shortcuts.json` at extension initialization and builds a `ShortcutRegistry` in memory. Key-based and chord-based entries are indexed separately for efficient lookup.
2. **Graceful degradation**: If the config file is missing or contains malformed JSON, the registry is empty (no shortcuts) and a warning is logged. Invalid entries (including entries with both `key` and `chord`, or missing required fields) are silently skipped.
3. **Dispatch**: Both the browse list dispatcher (`defaultChooseWorkItem`) and detail view dispatcher (`createScrollableWidget`) check a set of reserved navigation keys before attempting shortcut lookup. If the pressed key is reserved (see [Reserved Navigation Keys](#reserved-navigation-keys)), shortcut lookup is skipped and navigation takes precedence.
   - **Single-key shortcuts**: For non-reserved single-character keys, `shortcutRegistry.lookup(key, view)` is called. If a match is found, the command template is substituted (`<id>` → selected item ID) and inserted into the editor.
   - **Chord shortcuts**: If no single-key match is found, the registry checks if the key is a chord leader via `shortcutRegistry.getChordByLeader(key, view)`. If chords exist for that leader, the system enters a **pending-chord state** and updates the help line. Pressing a valid completion key triggers `shortcutRegistry.lookupChord([leader, completion], view)`, which dispatches the matching command.
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
```
