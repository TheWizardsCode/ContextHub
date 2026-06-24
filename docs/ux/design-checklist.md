# Pi TUI Design Checklist

This checklist defines the UI/UX requirements for the Pi-based TUI in the ContextHub project.
Implementors and reviewers should validate against these items before merging changes.

## 1. Layout & Structure

- [ ] **Separation of Concerns**: Chat pane and action palette must be visually and functionally separate.
- [ ] **Keyboard-First Navigation**: All primary flows must be operable via keyboard without a mouse.
- [ ] **Responsive Design**: Panes should adapt to terminal size changes (resize events handled gracefully).
- [ ] **Widget Placement**: Widgets (work-item list, details) are placed below the editor, not overlaying it.
- [ ] **Non-Obstructive**: Native chat input and editor remain visible and functional at all times.

## 2. Keyboard Navigation

- [ ] **Shortcuts**: Standard keyboard shortcuts must work:
  - `Ctrl+/` or `Ctrl+Shift+P` for action palette
  - `Esc` to close modals/panels
- [ ] **Tab Order**: Logical tab order across interactive elements.
- [ ] **Focus Management**: Modal dialogs trap focus and restore it on close.

## 3. Accessibility

- [ ] **Labels**: All interactive elements have accessible labels.
- [ ] **Color Contrast**: Sufficient contrast between text and background in all themes.
- [ ] **Screen Reader**: Widgets announce state changes via notifications.
- [ ] **Focus Indicators**: Visible focus indicators for keyboard navigation.

## 4. Chat Pane

- [ ] **Visibility**: Chat pane is toggleable via a keyboard shortcut.
- [ ] **Message Display**: Agent responses are rendered with markdown support.
- [ ] **Streaming**: Agent responses stream incrementally (no blocking waits).
- [ ] **History**: Conversation history is preserved during a session.
- [ ] **Natural Language**: User can type freeform requests; agent interprets and acts.

## 5. Action Palette

- [ ] **Activation**: Opens via keyboard shortcut (configurable).
- [ ] **Filtering**: Typed input narrows results in real-time.
- [ ] **Navigation**: Arrow keys + Enter/Esc for selection and dismissal.
- [ ] **Actions Listed**: All agent-driven actions are discoverable:
  - Create work item
  - Update work item
  - Close work item
  - Claim/assign work item
  - Run `wl` helper commands (next, list, show, search)
  - Start agent conversation
  - Trigger higher-level flows (create PR, run tests, delegate)
- [ ] **Confirmation**: State-changing actions require explicit confirmation.

## 6. Widget System

- [ ] **Persistence**: Widgets remain visible until explicitly hidden.
- [ ] **Refresh**: Widgets auto-refresh after wl CLI operations.
- [ ] **Details**: Selected item details update when selection changes.
- [ ] **Commands**: `/wl` (worklog browse) is functional.

## 7. Error Handling

- [ ] **User-Friendly**: Errors are displayed in a non-crashing, readable format.
- [ ] **Retry**: Transient failures (timeout, network) trigger automatic retry with backoff.
- [ ] **Notifications**: Users are notified of errors via the existing notification system.

## 8. Theme Support

- [ ] **Pi Themes**: Respects the current Pi theme configuration.
- [ ] **Custom Styling**: Widget styling uses Pi theme tokens, not hardcoded colors.

## 9. Performance

- [ ] **Non-Blocking**: wl CLI calls run off the main UI thread (spawn in child process).
- [ ] **Virtual List**: Long lists are virtualized for performance.
- [ ] **Memory**: No memory leaks in widget lifecycle; proper cleanup on hide/destroy.

## 10. Pi Best Practices

- [ ] **Extension Pattern**: TUI follows Pi extension patterns for modularity.
- [ ] **Configuration**: All configurable settings are in config files, not hardcoded.
- [ ] **Plugin Loading**: Plugins load gracefully and handle missing dependencies.
- [ ] **Version Compatibility**: TUI version is reported and compatible with wl CLI version.

## Implementation Notes

- Use `ctx.ui.setWidget()` for widget placement below the editor.
- Register shortcuts via `pi.registerShortcut()` for keyboard interactions.
- Use `ctx.ui.notify()` for user notifications on show/hide/selection.
- Avoid embedding theme ANSI codes into cached strings; rebuild on invalidate.
- Document tradeoffs if using `ctx.ui.custom()` or `ctx.ui.setEditorComponent()` for interactive UI.
