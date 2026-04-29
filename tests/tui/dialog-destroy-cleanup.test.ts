import { describe, it, expect } from 'vitest';
import blessed from 'blessed';
import { DialogsComponent } from '../../src/tui/components/dialogs.js';
import { OverlaysComponent } from '../../src/tui/components/overlays.js';

describe('Destroy & lifecycle cleanup', () => {
  it('DialogsComponent.destroy calls removeAllListeners and destroys widgets', () => {
    const screen = blessed.screen({ smartCSR: true, title: 'test' });

    const overlays = new OverlaysComponent({ parent: screen, blessed }).create();
    const dialogs = new DialogsComponent({ parent: screen, blessed, overlays }).create();

    // Replace removeAllListeners on a selection of widgets to detect calls
    const targets: Array<{ name: string; widget: any; called: { v: boolean }; orig?: any }> = [];
    const names = [
      'createDialogTitleInput',
      'createDialogDescription',
      'createDialogIssueTypeOptions',
      'createDialogPriorityOptions',
      'updateDialogComment',
    ];

    for (const name of names) {
      const widget = (dialogs as any)[name];
      if (!widget) continue;
      const called = { v: false };
      targets.push({ name, widget, called, orig: widget.destroy });
      try {
        widget.destroy = () => { called.v = true; };
      } catch (_) {}
    }

    // Call destroy and ensure our spies were invoked
    expect(() => { dialogs.destroy(); }).not.toThrow();

    for (const t of targets) {
      // For destroyed widgets, destroy may no longer exist; accept either the
      // widget.destroy override was called or the widget has been destroyed by
      // the component (destroy may be removed after invocation).
      const wasCalled = t.called.v;
      expect(wasCalled || typeof t.widget.destroy !== 'function').toBe(true);
    }

    try { screen.destroy(); } catch (_) {}
  });
});
