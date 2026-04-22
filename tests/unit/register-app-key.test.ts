import { describe, it, expect } from 'vitest';
import { registerAppKey, ModalDialogBase, isAnyDialogOpen } from '../../src/tui/components/modal-base.js';

// Minimal mocks for BlessedScreen and widget
function makeScreen() {
  const handlers: Array<{ keys: any; handler: (...args: any[]) => void }> = [];
  const screen: any = {
    focused: null,
    key: (keys: any, handler: (...args: any[]) => void) => { handlers.push({ keys, handler }); },
    _handlers: handlers,
  };
  return screen;
}

function makeWidget() {
  const w: any = { focus: () => {}, show: () => {}, hide: () => {}, setFront: () => {} };
  return w;
}

describe('registerAppKey semantics', () => {
  it('calls handler when no modal is open', () => {
    const screen = makeScreen();
    let called = false;
    registerAppKey(screen, ['x'], () => { called = true; });
    // find registered handler and invoke
    const h = screen._handlers.find(h => h.keys && (Array.isArray(h.keys) ? h.keys.includes('x') : h.keys === 'x'));
    expect(h).toBeTruthy();
    h.handler();
    expect(called).toBe(true);
  });

  it('suppresses handler when any modal on same screen is open', () => {
    const screen = makeScreen();
    const dialog = makeWidget();
    const modal = new ModalDialogBase({ screen, dialog, overlay: null, focusTarget: null, restoreFocusTarget: null });

    modal.open();
    try {
      expect(isAnyDialogOpen()).toBe(true);
      let called = false;
      registerAppKey(screen, ['y'], () => { called = true; });
      const h = screen._handlers.find(h => h.keys && (Array.isArray(h.keys) ? h.keys.includes('y') : h.keys === 'y'));
      expect(h).toBeTruthy();
      h.handler();
      expect(called).toBe(false);
    } finally {
      modal.close();
    }
  });

  it('allows handler when modal open on different screen', () => {
    const screen1 = makeScreen();
    const screen2 = makeScreen();
    const dialog1 = makeWidget();
    const modal = new ModalDialogBase({ screen: screen1, dialog: dialog1, overlay: null, focusTarget: null, restoreFocusTarget: null });
    modal.open();
    try {
      let called = false;
      registerAppKey(screen2, ['z'], () => { called = true; });
      const h = screen2._handlers.find(h => h.keys && (Array.isArray(h.keys) ? h.keys.includes('z') : h.keys === 'z'));
      expect(h).toBeTruthy();
      h.handler();
      expect(called).toBe(true);
    } finally {
      modal.close();
    }
  });
});
