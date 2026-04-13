import { describe, it, expect, vi } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiTestContext } from '../test-utils.js';

describe('TUI create dialog input regression', () => {
  it('focuses title input once per open to avoid duplicate key insertion', async () => {
    const ctx = createTuiTestContext();
    ctx.utils.createSampleItem({ tags: [] });

    const layout = ctx.createLayout();
    const titleInput = layout.dialogsComponent.createDialogTitleInput;
    const createDialog = layout.dialogsComponent.createDialog;

    const originalFocus = titleInput.focus;
    const focusSpy = vi.fn(() => {
      if (typeof originalFocus === 'function') {
        originalFocus();
      }
    });
    titleInput.focus = focusSpy;

    const controller = new TuiController(ctx as any, {
      blessed: ctx.blessed,
    });

    await controller.start({});

    // First open via Shift+C: focus once
    ctx.screen.emit('keypress', 'C', { name: 'c', shift: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createDialog.hidden).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(1);

    // Same shortcut while already open must not stack focus/read handlers
    ctx.screen.emit('keypress', 'C', { name: 'c', shift: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(focusSpy).toHaveBeenCalledTimes(1);

    // Close and reopen: exactly one additional focus call
    ctx.screen.emit('keypress', '', { name: 'escape' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createDialog.hidden).toBe(true);

    ctx.screen.emit('keypress', 'C', { name: 'c', shift: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createDialog.hidden).toBe(false);
    expect(focusSpy).toHaveBeenCalledTimes(2);
  });

  it('patches textarea listener once and maps Tab to focus navigation', async () => {
    const ctx = createTuiTestContext();
    ctx.utils.createSampleItem({ tags: [] });

    const layout = ctx.createLayout();
    const titleInput = layout.dialogsComponent.createDialogTitleInput as any;

    // Simulate blessed textarea internals used by controller patching.
    const originalListener = vi.fn();
    titleInput._listener = originalListener;
    titleInput._reading = true;
    titleInput.options = { inputOnFocus: true };
    titleInput._done = vi.fn(() => {
      titleInput._reading = false;
    });

    const createDialog = layout.dialogsComponent.createDialog;

    const controller = new TuiController(ctx as any, {
      blessed: ctx.blessed,
    });

    await controller.start({});

    const patched = titleInput._listener;
    expect(typeof patched).toBe('function');
    expect(patched).not.toBe(originalListener);
    expect(titleInput.__opencode_orig_listener).toBe(originalListener);

    // Open create modal and focus title to exercise tab path.
    ctx.screen.emit('keypress', 'C', { name: 'c', shift: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createDialog.hidden).toBe(false);
    titleInput.focus();

    // Tab should be consumed by focus cycling, not passed to original listener.
    patched.call(titleInput, '\t', { name: 'tab' });
    expect(originalListener).not.toHaveBeenCalled();
    expect(titleInput._done).toHaveBeenCalled();
    expect(titleInput._reading).toBe(false);

    // Non-tab key should still delegate to original listener.
    patched.call(titleInput, 'a', { name: 'a' });
    expect(originalListener).toHaveBeenCalledTimes(1);
  });
});
