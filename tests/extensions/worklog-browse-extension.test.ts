import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDefaultListWorkItems,
  createWorklogBrowseExtension,
} from '../../packages/tui/extensions/index.ts';

describe('Worklog browse pi extension', () => {
  const registerCommand = vi.fn();
  const registerShortcut = vi.fn();
  const sendMessage = vi.fn();

  const makePi = () => ({
    registerCommand,
    registerShortcut,
    sendMessage,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers /wl command and Ctrl+Shift+B shortcut', () => {
    const extension = createWorklogBrowseExtension();
    extension(makePi() as any);

    expect(registerCommand).toHaveBeenCalledWith(
      'wl',
      expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
    );
    expect(registerShortcut).toHaveBeenCalledWith(
      'ctrl+shift+b',
      expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
    );
  });

  it('posts selected item title to chat each time selection changes', async () => {
    const listWorkItems = vi.fn().mockResolvedValue([
      { id: 'WL-1', title: 'One', status: 'open' },
      { id: 'WL-2', title: 'Two', status: 'in-progress' },
      { id: 'WL-3', title: 'Three', status: 'open' },
      { id: 'WL-4', title: 'Four', status: 'blocked' },
      { id: 'WL-5', title: 'Five', status: 'open' },
      { id: 'WL-6', title: 'Six', status: 'open' },
    ]);

    const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
      onSelectionChange(items[1]);
      onSelectionChange(items[3]);
      return items[3];
    });

    const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem });
    extension(makePi() as any);

    const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;
    expect(typeof commandHandler).toBe('function');

    const notify = vi.fn();
    await commandHandler('', { ui: { notify } });

    expect(listWorkItems).toHaveBeenCalledTimes(1);
    expect(chooseWorkItem).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        customType: 'worklog-browse-selection',
        display: true,
        content: 'Two',
      }),
      expect.objectContaining({ triggerTurn: false }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        customType: 'worklog-browse-selection',
        display: true,
        content: 'Four',
      }),
      expect.objectContaining({ triggerTurn: false }),
    );
  });

  it('reports explicit empty state when no items exist', async () => {
    const listWorkItems = vi.fn().mockResolvedValue([]);
    const chooseWorkItem = vi.fn();

    const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem });
    extension(makePi() as any);

    const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;
    const notify = vi.fn();

    await commandHandler('', { ui: { notify } });

    expect(notify).toHaveBeenCalledWith('No work items available to browse.', 'info');
    expect(chooseWorkItem).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('uses wl next -n 5 and parses results.workItem payload', async () => {
    const runWl = vi.fn().mockResolvedValue(`{\n  "success": true,\n  "count": 2,\n  "results": [\n    { "workItem": { "id": "WL-10", "title": "Ten", "status": "open" } },\n    { "workItem": { "id": "WL-11", "title": "Eleven", "status": "blocked" } }\n  ]\n}`);

    const listWorkItems = createDefaultListWorkItems(runWl as any);
    const items = await listWorkItems();

    expect(runWl).toHaveBeenCalledWith(['next', '-n', '5']);
    expect(items).toEqual([
      { id: 'WL-10', title: 'Ten', status: 'open' },
      { id: 'WL-11', title: 'Eleven', status: 'blocked' },
    ]);
  });
});
