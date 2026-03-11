# Update Dialog — Keyboard Interaction Reference

The Update Work Item dialog (`updateDialog`) lets users change the **Status**, **Stage**, and **Priority** of a work item and optionally add a comment before saving.

## Visual Layout

```
┌─ Update Work Item ────────────────────────────────────────────┐
│  Update: <title>                                              │
│  ID: <id>  Status: <s> · Stage: <s> · Priority: <p>          │
│                                                               │
│  Status          Stage           Priority                     │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐              │
│  │ open       │  │ idea       │  │ critical   │              │
│  │ in-progress│  │ prd_done   │  │ high       │              │
│  │ blocked    │  │ …          │  │ medium     │              │
│  │ …          │  │            │  │ low        │              │
│  └────────────┘  └────────────┘  └────────────┘              │
│                                                               │
│  ┌─ Comment ───────────────────────────────────────────────┐  │
│  │ (multiline text area)                                   │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

## Tab Order

Focus moves left-to-right through the three selection columns and then to the comment area:

| # | Control       | Notes                                |
|---|---------------|--------------------------------------|
| 1 | Status list   | Initial focus when dialog opens      |
| 2 | Stage list    |                                      |
| 3 | Priority list |                                      |
| 4 | Comment box   | Multiline textarea                   |

- **Tab** advances focus to the next control (wraps from Comment → Status).
- **Shift+Tab** moves focus to the previous control (wraps from Status → Comment).
- **← / →** also moves focus left or right between the three lists (and comment area).

## Per-Control Keyboard Semantics

### Selection lists (Status, Stage, Priority)

The three lists are treated as already-open interactive areas — they do not need to be "opened" first.

| Key             | Action                                              |
|-----------------|-----------------------------------------------------|
| ↑ / ↓           | Navigate list options                               |
| Enter           | Confirm selection and **save** the dialog           |
| Escape          | **Close** the dialog without saving                 |
| Tab             | Move focus to the next control                      |
| Shift+Tab       | Move focus to the previous control                  |
| ← / →           | Move focus to the adjacent list / comment area      |

### Comment textarea

| Key             | Action                                                       |
|-----------------|--------------------------------------------------------------|
| (type)          | Insert characters                                            |
| Ctrl+J / Ctrl+M | Insert a newline                                             |
| Enter           | **Save** the dialog (field + comment)                        |
| Escape          | **Close** the dialog without saving                          |
| Tab             | Move focus to the next control (Status list, wrapping)       |
| Shift+Tab       | Move focus to the previous control (Priority list)           |

### Dialog-level keys (active regardless of focused child)

| Key             | Action                     |
|-----------------|----------------------------|
| Enter           | Save the dialog            |
| Ctrl+S          | Save the dialog            |
| Escape          | Close without saving       |
| Tab             | Cycle focus forward        |
| Shift+Tab       | Cycle focus backward       |

## Behaviour Notes

- Escape is registered on the dialog box **and** on each of the three selection lists and the comment textarea independently, so it reliably closes the dialog regardless of which widget currently holds focus.
- Arrow key navigation inside lists is provided by blessed's built-in `keys: true` option.
- When the dialog opens it focuses the **Status** list (leftmost column) so keyboard users can immediately navigate.
- Clicking the overlay area behind the dialog triggers an unsaved-changes confirmation before closing.
