import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorklogBrowseExtension, formatBrowseOption } from '../../packages/tui/extensions/index.ts';

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

  it('registers a browse command and Ctrl+B shortcut', () => {
    const extension = createWorklogBrowseExtension();
    extension(makePi() as any);

    expect(registerCommand).toHaveBeenCalledWith(
      'wl-browse',
      expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
    );
    expect(registerShortcut).toHaveBeenCalledWith(
      'ctrl+b',
      expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
    );
  });

  it('shows first five items and posts wl show details to chat for selected item', async () => {
    const listWorkItems = vi.fn().mockResolvedValue([
      { id: 'WL-1', title: 'One', status: 'open' },
      { id: 'WL-2', title: 'Two', status: 'in-progress' },
      { id: 'WL-3', title: 'Three', status: 'open' },
      { id: 'WL-4', title: 'Four', status: 'blocked' },
      { id: 'WL-5', title: 'Five', status: 'open' },
      { id: 'WL-6', title: 'Six', status: 'open' },
    ]);
    const showWorkItem = vi.fn().mockResolvedValue('show output');

    const extension = createWorklogBrowseExtension({ listWorkItems, showWorkItem });
    extension(makePi() as any);

    const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl-browse')?.[1]?.handler;
    expect(typeof commandHandler).toBe('function');

    const options = [
      formatBrowseOption({ id: 'WL-1', title: 'One', status: 'open' }),
      formatBrowseOption({ id: 'WL-2', title: 'Two', status: 'in-progress' }),
      formatBrowseOption({ id: 'WL-3', title: 'Three', status: 'open' }),
      formatBrowseOption({ id: 'WL-4', title: 'Four', status: 'blocked' }),
      formatBrowseOption({ id: 'WL-5', title: 'Five', status: 'open' }),
    ];

    const select = vi.fn().mockResolvedValue(options[1]);
    const notify = vi.fn();

    await commandHandler('', { ui: { select, notify } });

    expect(select).toHaveBeenCalledWith('Browse Worklog items (first 5)', options);
    expect(listWorkItems).toHaveBeenCalledTimes(1);
    expect(showWorkItem).toHaveBeenCalledWith('WL-2');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'worklog-browse',
        display: true,
        content: expect.stringContaining('wl show WL-2'),
      }),
      expect.objectContaining({ triggerTurn: false }),
    );
  });

  it('reports explicit empty state when no items exist', async () => {
    const listWorkItems = vi.fn().mockResolvedValue([]);
    const showWorkItem = vi.fn();

    const extension = createWorklogBrowseExtension({ listWorkItems, showWorkItem });
    extension(makePi() as any);

    const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl-browse')?.[1]?.handler;
    const notify = vi.fn();

    await commandHandler('', { ui: { select: vi.fn(), notify } });

    expect(notify).toHaveBeenCalledWith('No work items available to browse.', 'info');
    expect(showWorkItem).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
