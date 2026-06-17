# Tutorial 4: Using the TUI

**Target audience:** Any Worklog user who prefers a visual interface
**Time to complete:** 10 minutes
**Prerequisites:** Worklog installed ([Tutorial 1](01-your-first-work-item.md)) with some work items created

## What you will learn

By the end of this tutorial you will be able to:

- Launch and navigate the interactive TUI
- Create, edit, and manage work items visually
- Use keyboard shortcuts for efficient navigation
- Access the built-in Pi agent assistant

## Step 1: Launch the TUI

```bash
wl tui
wl piman
```

The TUI launches the Pi coding agent with Worklog extensions pre-loaded.
It shows a browse list of recommended next work items.

> **Note:** The TUI is now Pi-based. Both `wl tui` and `wl piman` launch
> the same interactive browse interface.

### Filter to in-progress items only

```bash
wl tui --in-progress
```

### Include completed and deleted items

```bash
wl tui --all
```

## Step 2: Navigate the tree

| Key | Action |
|-----|--------|
| Up / Down | Move selection up or down |
| Right / Enter | Expand a node to show children |
| Left | Collapse a node (or jump to parent) |
| Space | Toggle expand/collapse |
| Mouse click | Select an item |
| Mouse scroll | Scroll the list |

As you navigate, the details pane on the right updates to show the selected item's full information, including description, comments, timestamps, and metadata.

Note: The right-hand metadata pane shows a compact, easy-to-scan layout. Risk and Effort are shown on a single line (`Risk/Effort: <Risk>/<Effort>`), and a one-line Audit summary (when present) is surfaced as `Audit: <excerpt> — by <author>`. Created/Updated rows are not displayed in the compact pane to reduce noise.

## Step 3: Manage work items

The TUI supports common work item operations without leaving the interface:

| Key | Action |
|-----|--------|
| n | Create a new work item |
| e | Edit the selected item |
| c | Add a comment to the selected item |
| d | Delete the selected item |
| r | Refresh/reload all items |
| / | Search items |
| v | Cycle the needs-producer-review filter (on/off/all) |
| h | Toggle the help menu |

### Create a work item

Press `n` to open the creation dialog. Fill in the title, description, and other fields. The new item appears in the tree immediately.

### Edit an item

Select an item and press `e`. Modify any field and save. The details pane updates to reflect your changes.

### Add a comment

Select an item and press `c`. Type your comment and save. Comments appear in the details pane under the item's existing comments.

## Step 4: Move and reparent items

Press `m` on a selected item to enter move mode:

1. The source item is highlighted with a yellow `[M]` prefix
2. Its descendants are dimmed (they cannot be targets)
3. Navigate to the desired new parent
4. Press `m` or `Enter` to reparent the item under the target
5. Press `m` or `Enter` on the source item itself to unparent it (move to root level)
6. Press `Esc` to cancel

Other action keys are disabled during move mode to prevent accidental edits.

## Step 5: Switch between panes

Use window-management shortcuts to move focus:

| Key | Action |
|-----|--------|
| Ctrl+W, Ctrl+W | Cycle focus between panes |
| Ctrl+W, h | Focus the list pane |
| Ctrl+W, l | Focus the details pane |
| Ctrl+W, p | Focus the previous pane |

## Step 6: Use the Pi agent assistant

Press `O` (capital O) to open the Pi agent assistant dialog. The server starts automatically and a status indicator appears:

- `[-]` -- Server stopped
- `[~]` -- Server starting
- `[OK] Port: 9999` -- Server running
- `[X]` -- Server error

### Interact with OpenCode

| Key | Action |
|-----|--------|
| Type your prompt | Enter your question or instruction |
| Ctrl+S | Send the prompt |
| Enter | Accept autocomplete or add a newline |
| Escape | Close the dialog |

### Run shell commands

Prefix your prompt with `!` to run a shell command in the project root:

```
! npm test
```

The command output streams in the response pane. Press `Ctrl+C` to cancel a running command without closing the prompt.

### Use slash commands

Type `/` to see available commands:

- `/help` -- Get help with OpenCode
- `/create` -- Create a new work item from a description
- `/edit` -- Edit files with AI assistance
- `/test` -- Generate or run tests
- `/fix` -- Fix issues in code

Example:

```
/create Fix the login page redirect when session expires
```

This creates a work item with an auto-generated title, description, and appropriate issue type and priority.

### Navigate OpenCode panes

When OpenCode is active, the response appears in a bottom pane:

| Key | Action |
|-----|--------|
| Ctrl+W, k | Focus the response pane |
| Ctrl+W, j | Focus the input pane |
| q or click [x] | Close the response pane |

## Step 6a: Pi Extension Browse Shortcuts

When using the Pi agent with the Worklog browse extension (launched via `piman`), you can quickly insert commands into the editor using keyboard shortcuts. These shortcuts are **config-driven** — defined in `packages/tui/extensions/shortcuts.json` and dispatched dynamically by the shortcut registry, so they can be extended or customized without editing source code.

### Browse List View Shortcuts

In the browse selection list (when you see a list of work items), press one of the following keys to insert a command for the selected item:

| Key | Command Inserted |
|-----|------------------|
| `i` | `implement <selected-id>` |
| `p` | `plan <selected-id>` |
| `n` | `intake <selected-id>` |
| `c` | `create <description>` |
| `a` | `audit <selected-id>` |

The command text is inserted into the Pi editor (without a trailing newline), allowing you to review or edit it before pressing Enter to submit.

### Detail View Shortcuts

In the detail scrollable view (when viewing a single work item), the same shortcuts work identically: press `i`, `p`, `n`, or `a` to insert the corresponding command for the currently displayed work item. The detail view also clears its preview widget before closing the modal, giving you a clean editor to work in.

### How It Works

Each shortcut is defined as a JSON object with:
- `key`: The single-character key (e.g., `"i"`)
- `command`: The template string to insert (e.g., `"implement <id>"`)
- `view`: Which view(s) the shortcut applies to (`"list"`, `"detail"`, or `"both"`)

The `shortcutRegistry` loads `shortcuts.json` at extension init time and dispatches matched shortcuts in both the browse list and detail view handlers. Navigation keys (`Up`, `Down`, `Enter`, `Escape`, `PageUp`, `PageDown`, `G`) remain functional in both views.

## Step 7: Exit the TUI

Press `q`, `Esc`, or `Ctrl+C` to quit the TUI. All changes made during the session are saved to the local database.

## Summary

| Action | Key |
|--------|-----|
| Launch TUI | `wl tui` |
| Navigate | Arrow keys, Space, Enter |
| Create item | n |
| Edit item | e |
| Add comment | c |
| Delete item | d |
| Search | / |
| Move/reparent | m |
| Pi agent | O |
| Switch panes | Ctrl+W, Ctrl+W |
| Help | h |
| Quit | q / Esc / Ctrl+C |
| Pi extension: implement | `i` (browse view) |
| Pi extension: plan | `p` (browse view) |
| Pi extension: intake | `n` (browse view) |
| Pi extension: create | `c` (browse view) |
| Pi extension: audit | `a` (browse view) |

## Next steps

- [Planning and Tracking an Epic](05-planning-an-epic.md) -- organize complex features
- [TUI Reference](../../TUI.md) -- complete TUI documentation
- [Pi TUI Migration Guide](../../docs/opencode-to-pi-migration.md) -- migrating from OpenCode to Pi
