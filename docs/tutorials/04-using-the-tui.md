# Tutorial 4: Using the TUI

**Target audience:** Any Worklog user who prefers a visual interface
**Time to complete:** 10 minutes
**Prerequisites:** Worklog installed ([Tutorial 1](01-your-first-work-item.md)) with some work items created

## What you will learn

By the end of this tutorial you will be able to:

- Launch and navigate the interactive TUI
- Create, edit, and manage work items visually
- Use keyboard shortcuts for efficient navigation
- Access the built-in OpenCode AI assistant

## Step 1: Launch the TUI

```bash
wl tui
```

The TUI opens with two panes:

- **Left pane**: A tree view of all work items, showing parent/child hierarchy
- **Right pane**: Details of the currently selected item (same format as `wl show --format full`)

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

## Step 6: Use the OpenCode AI assistant

Press `O` (capital O) to open the OpenCode AI assistant dialog. The server starts automatically and a status indicator appears:

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
| OpenCode AI | O |
| Switch panes | Ctrl+W, Ctrl+W |
| Help | h |
| Quit | q / Esc / Ctrl+C |

## Next steps

- [Planning and Tracking an Epic](05-planning-an-epic.md) -- organize complex features
- [TUI Reference](../../TUI.md) -- complete TUI documentation
- [OpenCode TUI Integration](../../docs/opencode-tui.md) -- detailed OpenCode docs
