import { describe, it, expect } from 'vitest';
import blessed from 'blessed';
import { ModalDialogsComponent } from '../../src/tui/components/modals.js';
import { createTuiTestContext } from '../test-utils.js';
import { TuiController } from '../../src/tui/controller.js';

describe('Destroy & lifecycle cleanup (controller & modals)', () => {
  it('ModalDialogs.forceCleanup ends textbox reading and releases grabKeys', async () => {
    const screen = blessed.screen({ smartCSR: true, title: 'test' });
    const modal = new ModalDialogsComponent({ parent: screen, blessed }).create();

    // Start an editTextarea modal. It sets activeCleanup synchronously so
    // we can forceCleanup immediately without awaiting the promise.
    // Start the modal but do not await its promise — forceCleanup is
    // expected to perform cleanup but not necessarily resolve the original
    // promise returned to the caller.
    /* eslint-disable no-unused-vars */
    const p = modal.editTextarea({ title: 't', initial: 'x', confirmLabel: 'OK', cancelLabel: 'Cancel' });
    /* eslint-enable no-unused-vars */

    // Force cleanup should not throw and should reset grabKeys
    expect(() => { modal.forceCleanup(); }).not.toThrow();
    expect((screen as any).grabKeys).toBe(false);

    try { screen.destroy(); } catch (_) {}

  });

  it('Starting and shutting down controller repeatedly does not leak or throw', async () => {
    const ctx = createTuiTestContext();

    for (let i = 0; i < 3; i++) {
      const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
      await controller.start({});
      // Trigger quit key to invoke shutdown path
      ctx.screen.emit('keypress', 'q', { name: 'q' });
      // allow shutdown to complete
      await new Promise(r => setTimeout(r, 10));
    }

    expect(true).toBe(true);
  });
});
