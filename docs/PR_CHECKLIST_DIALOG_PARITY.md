# Dialog Parity PR Checklist

This checklist should be completed by a reviewer when changes affect the TUI dialogs component (`src/tui/components/dialogs.ts`).

## Manual Verification Steps

### Create Dialog (Shift+C)

- [ ] **Open Create Dialog**: Press `Shift+C` to open the create dialog
- [ ] **Confirm fields present**: 
  - [ ] Title input field is visible and focused
  - [ ] Description textarea is visible
  - [ ] Issue Type dropdown/list is visible with options (bug, feature, task, epic, chore)
  - [ ] Priority dropdown/list is visible with options (critical, high, medium, low)
- [ ] **Submit**: Fill in a test title and description, press `Ctrl+S` to submit
- [ ] **Verify**: 
  - [ ] Toast message confirms creation ("Created:")
  - [ ] Dialog closes after successful submission
  - [ ] New item appears in the work item list

### Update Dialog (u)

- [ ] **Open Update Dialog**: Press `u` while a work item is selected
- [ ] **Verify fields present**:
  - [ ] Status options list is visible
  - [ ] Stage options list is visible  
  - [ ] Priority options list is visible
  - [ ] Comment textarea is visible
- [ ] **Change Priority**: Select a different priority from the dropdown
- [ ] **Submit**: Press `Ctrl+S` to save changes
- [ ] **Verify**:
  - [ ] Toast message confirms update
  - [ ] Changes are persisted (item shows new priority)
  - [ ] Dialog closes

### Visual Inspection

- [ ] **Modal Borders**: All dialogs have visible border lines
- [ ] **Labels**: Each dialog has a label (title bar) correctly displayed
- [ ] **Positioning**: Dialogs are centered on screen
- [ ] **Styling**: Border colors are consistent (green for details, magenta for close, etc.)
- [ ] **Responsive**: Dialogs adapt to terminal resize

## Reviewer Confirmation

> I have completed the manual verification steps above and confirm that the dialogs render and function correctly after these changes.

**Reviewer**: _________________  
**Date**: _________________  

**Notes** (optional):
```

```
