# Migration: Extract Dialog Helpers → src/tui/components/dialog-helpers.ts

> **DEPRECATED**: The Blessed TUI (including `src/tui/components/dialogs.ts`)
> has been removed from the repository. This migration document is preserved
> for historical reference only. The Pi-based TUI that succeeded it (launched
> via `wl tui` / `wl piman`) has also been removed — work item browsing and
> management is now provided by the Herdr plugin.

This one-page mapping documents how the private helper methods used in
src/tui/components/dialogs.ts map to the new exported helpers in
src/tui/components/dialog-helpers.ts.

## Mapping

1. DialogsComponent#createList(...) → createList(blessed?, opts)
   - Current: private method in DialogsComponent that creates blessed.list with
     keys/mouse/style defaults.
   - New API: export createList that accepts an optional blessed factory and
     opts object.

2. DialogsComponent#createTextarea(...) → createTextarea(blessed?, opts)
   - Current: private method that configures textarea defaults.
   - New API: export createTextarea preserving same defaults.

3. DialogsComponent#createLabel(...) → createLabel(blessed?, opts)
   - Current: private method that returns a small box with height=1 and
     cyan/bold style.
   - New API: export createLabel to centralize those defaults.

## Notes

- The extraction was intentionally additive; DialogsComponent retained its
  private helper implementations to avoid large refactors.
- The Blessed TUI was removed in June 2026 and replaced by the Pi-based TUI
  (`wl piman` / `wl tui`). The Pi-based TUI was itself removed later — work
  item browsing is now provided by the Herdr plugin.
