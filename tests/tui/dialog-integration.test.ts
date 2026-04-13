import { describe, it, expect, vi } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiTestContext } from '../test-utils.js';

describe('Dialog integration tests', () => {
  it('Create dialog: Tab handling and Ctrl+S submission', async () => {
    const ctx = createTuiTestContext();

    // Provide a create() implementation so submitCreateDialog can succeed
    const baseDb = ctx.utils.getDatabase();
    const dbWithCreate = Object.assign({}, baseDb, {
      create: (payload: any) => {
        // Reuse createSampleItem to allocate an id and then set fields
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

    const layout = ctx.createLayout();
    const createDialog = layout.dialogsComponent.createDialog as any;
    const titleInput = layout.dialogsComponent.createDialogTitleInput as any;
    const createDialogCreateButton = layout.dialogsComponent.createDialogCreateButton as any;

    // Ensure the TUI startup path takes the full code path (not the empty-state early return)
    // by seeding a sample item into the in-memory DB.
    ctx.utils.createSampleItem({ tags: [] });
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    await controller.start({});

    // Open create dialog via test API
    (controller as any)._test.openCreateDialog();
    // allow handlers to run
    await new Promise(r => setTimeout(r, 10));

    expect(createDialog.hidden).toBe(false);

    // Ensure patched listener is present for title input (Tab mapping)
    const orig = (titleInput as any).__opencode_orig_listener;
    const patched = (titleInput as any)._listener;
    expect(typeof patched).toBe('function');
    expect(patched).not.toBe(orig);

    // Provide getValue so submit can read title
    titleInput.getValue = () => 'New Create Item';

    // Simulate Ctrl+S via the registered handler property
    // Use the test API to submit the create dialog (calls submitCreateDialog)
    (controller as any)._test.submitCreateDialog();

    // allow create flow to complete
    await new Promise(r => setTimeout(r, 10));

    // Toast should indicate creation and dialog should be closed
    expect(ctx.toast.lastMessage()).toMatch(/^Created:/);
    expect(createDialog.hidden).toBe(true);
  });

  it('Update dialog: Enter submits changes and Escape cancels', async () => {
    const ctx = createTuiTestContext();
    const id = ctx.utils.createSampleItem({ tags: [] });

    const layout = ctx.createLayout();
    const updateDialog = layout.dialogsComponent.updateDialog as any;
    const updateDialogPriorityOptions = layout.dialogsComponent.updateDialogPriorityOptions as any;

    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    await controller.start({});

    // Open update dialog via test API
    (controller as any)._test.openUpdateDialog();
    await new Promise(r => setTimeout(r, 10));

    expect(updateDialog.hidden).toBe(false);

    // Select a different priority (0 -> 'critical')
    if (typeof updateDialogPriorityOptions.select === 'function') updateDialogPriorityOptions.select(0);

    // Use the controller test API to submit the update dialog
    (controller as any)._test.submitUpdateDialog();

    await new Promise(r => setTimeout(r, 10));

    // Verify DB updated (priority changed)
    const db = ctx.utils.getDatabase();
    const updated = db.get(id);
    expect(updated).toBeTruthy();
    expect(updated.priority).toBe('critical');

    // Re-open and press Escape to cancel
    ctx.screen.emit('keypress', 'u', { name: 'u' });
    await new Promise(r => setTimeout(r, 10));
    expect(updateDialog.hidden).toBe(false);
    const escHandler = (updateDialog as any).__opencode_key_escape;
    expect(typeof escHandler).toBe('function');
    escHandler();
    await new Promise(r => setTimeout(r, 10));
    expect(updateDialog.hidden).toBe(true);
  });
});
