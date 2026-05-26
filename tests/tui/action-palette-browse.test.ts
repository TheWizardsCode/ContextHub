import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../src/tui/wl-integration.js', () => ({
  runWl: vi.fn(),
  wlEvents: new EventEmitter(),
}));

import { runWl } from '../../src/tui/wl-integration.js';
import { ActionPalette } from '../../src/tui/actionPalette.js';

const runWlMock = vi.mocked(runWl);

describe('ActionPalette worklog browse flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a browse action entry point with a shortcut', () => {
    const chatPane = { sendMessage: vi.fn() } as any;
    const palette = new ActionPalette(chatPane);

    const browse = palette.getAction('wl-browse');
    expect(browse).toBeDefined();
    expect(browse?.shortcut).toBe('Ctrl+B');
  });

  it('loads exactly five items from wl list and opens browse mode', async () => {
    runWlMock.mockResolvedValue([
      { id: 'WL-1', title: 'First', status: 'open' },
      { id: 'WL-2', title: 'Second', status: 'open' },
      { id: 'WL-3', title: 'Third', status: 'open' },
      { id: 'WL-4', title: 'Fourth', status: 'open' },
      { id: 'WL-5', title: 'Fifth', status: 'open' },
      { id: 'WL-6', title: 'Sixth', status: 'open' },
    ] as any);

    const chatPane = { sendMessage: vi.fn() } as any;
    const palette = new ActionPalette(chatPane);
    const onBrowseOpen = vi.fn();
    palette.on('browse-open', onBrowseOpen);

    const browse = palette.getAction('wl-browse');
    const result = await palette.executeAction(browse!);

    expect(runWlMock).toHaveBeenCalledWith('list', ['-n', '5']);
    expect(onBrowseOpen).toHaveBeenCalledTimes(1);
    const payload = onBrowseOpen.mock.calls[0][0];
    expect(payload.items).toHaveLength(5);
    expect(payload.items.map((i: any) => i.id)).toEqual(['WL-1', 'WL-2', 'WL-3', 'WL-4', 'WL-5']);
    expect(result).toContain('Browse mode opened');
  });

  it('supports selection + Enter by sending show for the selected work item to chat', async () => {
    runWlMock.mockResolvedValue([
      { id: 'WL-1', title: 'First', status: 'open' },
      { id: 'WL-2', title: 'Second', status: 'open' },
      { id: 'WL-3', title: 'Third', status: 'open' },
    ] as any);

    const chatPane = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    const palette = new ActionPalette(chatPane);

    await palette.executeAction(palette.getAction('wl-browse')!);

    // Default browse selection is the first item; move to second.
    palette.selectNext();
    await palette.executeSelected();

    expect(chatPane.sendMessage).toHaveBeenCalledWith('show WL-2');
  });

  it('returns an explicit empty-state message when no work items are available', async () => {
    runWlMock.mockResolvedValue([] as any);

    const chatPane = { sendMessage: vi.fn() } as any;
    const palette = new ActionPalette(chatPane);
    const onEmpty = vi.fn();
    palette.on('browse-empty-state', onEmpty);

    const result = await palette.executeAction(palette.getAction('wl-browse')!);

    expect(result).toBe('No work items available to browse.');
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(chatPane.sendMessage).not.toHaveBeenCalled();
  });
});
