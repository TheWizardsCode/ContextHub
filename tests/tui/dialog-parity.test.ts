import { describe, it, expect } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiTestContext } from '../test-utils.js';

// Parity-focused integration tests: exercise create/update dialogs using
// the same keybindings and flows used in production. These tests are
// intentionally compact and deterministic (no real terminal), using the
// provided test harness.

describe('Dialog parity tests', () => {
  it('Create dialog parity: open via shortcut, submit via test API, DB updated', async () => {
    const ctx = createTuiTestContext();

    // Provide a create() implementation so submitCreateDialog can succeed
    const baseDb = ctx.utils.getDatabase();
    const dbWithCreate = Object.assign({}, baseDb, {
      create: (payload: any) => {
        const id = ctx.utils.createSampleItem({ tags: [] });
        const item = baseDb.get(id);
        if (!item) return null;
        item.title = payload.title ?? item.title;
        item.description = payload.description ?? item.description;
        item.issueType = payload.issueType ?? item.issueType;
        item.priority = payload.priority ?? item.priority;
        baseDb.update(id, item);
        return item;
      },
    });
    ctx.utils.getDatabase = () => dbWithCreate;

    // Ensure the TUI startup path takes the full code path
    ctx.utils.createSampleItem({ tags: [] });
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    const layout = ctx.createLayout();
    await controller.start({});

    // Open create dialog via keyboard shortcut (Shift+C)
    ctx.screen.emit('keypress', 'C', { name: 'c', shift: true });
    await new Promise(r => setTimeout(r, 5));

    const createDialog = layout.dialogsComponent.createDialog as any;
    const titleInput = layout.dialogsComponent.createDialogTitleInput as any;

    expect(createDialog.hidden).toBe(false);
    expect(titleInput).toBeTruthy();

    // Provide getValue so submit can read title
    titleInput.getValue = () => 'Parity Create Item';

    // Use controller test API to submit (stable surface used by other tests)
    (controller as any)._test.submitCreateDialog();
    await new Promise(r => setTimeout(r, 5));

    // Verify toast and dialog closed
    expect(ctx.toast.lastMessage()).toMatch(/^Created:/);
    expect(createDialog.hidden).toBe(true);

    // Verify DB contains an item with provided title
    const db = ctx.utils.getDatabase();
    const all = db.list();
    const found = all.find((i: any) => i.title === 'Parity Create Item');
    expect(found).toBeTruthy();
  });

  it('Update dialog parity: open via key, change priority, submit persists update', async () => {
    const ctx = createTuiTestContext();
    const id = ctx.utils.createSampleItem({ tags: [] });

    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    const layout = ctx.createLayout();
    await controller.start({});

    // Open update dialog via keyboard shortcut (u)
    ctx.screen.emit('keypress', 'u', { name: 'u' });
    await new Promise(r => setTimeout(r, 5));

    const updateDialog = layout.dialogsComponent.updateDialog as any;
    const priorityList = layout.dialogsComponent.updateDialogPriorityOptions as any;

    expect(updateDialog.hidden).toBe(false);

    // Select a different priority index if available
    if (typeof priorityList.select === 'function') priorityList.select(0);

    // Submit the update using controller test API
    (controller as any)._test.submitUpdateDialog();
    await new Promise(r => setTimeout(r, 5));

    const db = ctx.utils.getDatabase();
    const updated = db.get(id);
    expect(updated).toBeTruthy();
    expect(updated.priority).toBe('critical');

    // Re-open and cancel via test API to ensure close path works
    ctx.screen.emit('keypress', 'u', { name: 'u' });
    await new Promise(r => setTimeout(r, 5));
    expect(updateDialog.hidden).toBe(false);
    (controller as any)._test.closeUpdateDialog();
    await new Promise(r => setTimeout(r, 5));
    expect(updateDialog.hidden).toBe(true);
  });
});
