# TUI Extensions

Extension modules for the Worklog TUI and Pi agent integration.

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
3. **Dispatch**: Both the browse list dispatcher (`defaultChooseWorkItem`) and detail view dispatcher (`createScrollableWidget`) call `shortcutRegistry.lookup(key, view)` before checking navigation keys. If a match is found, the command template is substituted (`<id>` → selected item ID) and inserted into the editor via `ctx.ui.setEditorText()`.
4. **No trailing newline**: The inserted text has no trailing newline, allowing the user to review or edit the command before pressing Enter to submit.

### Adding a New Shortcut

1. Add a new entry to `shortcuts.json` with the desired `key`, `command`, and `view`.
2. The shortcut is immediately available — no code changes needed.

Example:

```json
{
  "key": "c",
  "command": "close <id> --reason \"fixed\"",
  "view": "detail"
}
```
