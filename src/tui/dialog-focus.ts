// Minimal Pane type used by the focus helpers. Keep `any` to avoid
// coupling with blessed types in this small helper.
type Pane = any;
import { theme } from '../theme.js';

import { KEY_TAB, KEY_SHIFT_TAB } from './constants.js';

type FocusManager = {
  // The controller's focus managers use `1 | -1` as the delta type.
  cycle: (delta: 1 | -1) => void;
  getIndex: () => number;
  focusIndex: (i: number) => void;
};

// Lightweight wrapper to create a focus manager over an ordered array of
// fields. The controller already provides createUpdateDialogFocusManager;
// accept a prebuilt focus manager for compatibility.
export const createFocusHelpers = (
  fieldOrder: Array<Pane | undefined | null>,
  focusManager: FocusManager,
  screen?: any,
) => {
  const applyFocusStyles = (focused: Pane | undefined | null) => {
    fieldOrder.forEach((field) => {
      if (!field || !field.style) return;
      // For list items
      if (field.style.selected) {
        field.style.selected.bg = field === focused ? 'cyan' : 'blue';
        field.style.selected.fg = field === focused ? theme.tui.colors.lightText : 'white';
      }
      // For textareas with borders
      if ((field as any).style?.border) {
        (field as any).style.border.fg = field === focused ? 'cyan' : 'gray';
      }
    });
    try { if (screen && typeof screen.render === 'function') screen.render(); } catch (_) {}
  };

  // registerKey optional parameter: if provided, use it to register key handlers
  // (useful to register modal-wrapped handlers via ModalDialogBase.registerKeyHandler)
  const wireFieldNavigation = (
    screen: any,
    isHidden: () => boolean,
    isTextarea: (f: Pane | undefined | null) => boolean,
    registerKey?: (target: any, keys: string[] | string, handler: (...args: any[]) => void) => void,
  ) => {
    const wireOne = (field: Pane | undefined | null) => {
      if (!field || typeof field.key !== 'function') return;
      const isFocusedField = () => (screen as any).focused === field;

      const fieldTabHandler = () => {
        if (isHidden()) return;
        if (!isFocusedField()) return;
        focusManager.cycle(1);
        applyFocusStyles(fieldOrder[focusManager.getIndex()]);
        return false;
      };

      const fieldShiftTabHandler = () => {
        if (isHidden()) return;
        if (!isFocusedField()) return;
        focusManager.cycle(-1);
        applyFocusStyles(fieldOrder[focusManager.getIndex()]);
        return false;
      };

      // Attach Tab handlers for non-textareas; textareas may need special
      // listener patching by the caller.
      if (!isTextarea(field)) {
        try {
          (field as any).__opencode_key_tab = fieldTabHandler;
          (field as any).__opencode_key_stab = fieldShiftTabHandler;
          if (typeof registerKey === 'function') {
            registerKey(field, KEY_TAB as any, fieldTabHandler);
            registerKey(field, KEY_SHIFT_TAB as any, fieldShiftTabHandler);
          } else {
            // Fallback to field.key when no registerKey provided
            field.key(KEY_TAB as any, fieldTabHandler);
            field.key(KEY_SHIFT_TAB as any, fieldShiftTabHandler);
          }
        } catch (_) {}
      }
    };

    fieldOrder.forEach(wireOne);
  };

  return { applyFocusStyles, wireFieldNavigation };
};

export default createFocusHelpers;
