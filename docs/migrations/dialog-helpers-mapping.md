# Migration: Extract Dialog Helpers → src/tui/components/dialog-helpers.ts

This one-page mapping documents how the private helper methods used in
src/tui/components/dialogs.ts map to the new exported helpers in
src/tui/components/dialog-helpers.ts.

## Mapping

1. DialogsComponent#createList(...) → createList(blessed?, opts)
   - Current: private method in DialogsComponent that creates blessed.list with
     keys/mouse/style defaults.
   - New API: export createList that accepts an optional blessed factory and
     opts object. Callers should replace `this.createList({...})` with
     `createList(this.blessedImpl, {...})` or `createList(undefined, {...})` in
     tests.

2. DialogsComponent#createTextarea(...) → createTextarea(blessed?, opts)
   - Current: private method that configures textarea defaults (inputOnFocus,
     border, style, scrollbar).
   - New API: export createTextarea preserving same defaults and option
     merging. Replace `this.createTextarea({...})` with
     `createTextarea(this.blessedImpl, {...})`.

3. DialogsComponent#createLabel(...) → createLabel(blessed?, opts)
   - Current: private method that returns a small box with height=1 and
     cyan/bold style.
   - New API: export createLabel to centralize those defaults.

## Usage

- Migration is non-breaking: helpers accept the blessed factory so callers can
  pass `this.blessedImpl` and maintain identical behavior.
- Tests can import helpers and pass lightweight factory doubles to exercise
  defaults without initializing a full blessed.Screen.

## Notes

- The extraction is intentionally additive; DialogsComponent still retains its
  private helper implementations to avoid large refactors. Migrations of
  callers can be performed incrementally in follow-up child work items.
