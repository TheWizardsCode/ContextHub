import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDefaultListWorkItems,
  createWorklogBrowseExtension,
  formatBrowseOption,
} from '../../packages/tui/extensions/index.ts';

describe('Worklog browse pi extension', () => {
  it('formats browse options as title followed by id in parentheses', () => {
    expect(formatBrowseOption({ id: 'WL-42', title: 'Implement thing', status: 'open' })).toBe(
      'Implement thing (WL-42)',
    );
  });

  it('truncates title to keep id visible within width constraints', () => {
    expect(
      formatBrowseOption(
        { id: 'WL-123456', title: 'A very long work item title that will not fit', status: 'open' },
        24,
      ),
    ).toBe('A very long… (WL-123456)');
  });

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

  it('updates above-editor widget with details each time selection changes and renders full markdown on Enter', async () => {
    const listWorkItems = vi.fn().mockResolvedValue([
      { id: 'WL-1', title: 'One', status: 'open' },
      {
        id: 'WL-2',
        title: 'Two',
        status: 'in-progress',
        priority: 'high',
        stage: 'plan_complete',
        risk: 'Medium',
        effort: 'Small',
        description: 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8',
      },
      { id: 'WL-3', title: 'Three', status: 'open' },
      {
        id: 'WL-4',
        title: 'Four',
        status: 'blocked',
        priority: 'critical',
        stage: 'in_progress',
        risk: 'High',
        effort: 'Large',
        description: 'A\nB\nC\nD\nE\nF\nG\nH\nI',
      },
      { id: 'WL-5', title: 'Five', status: 'open' },
      { id: 'WL-6', title: 'Six', status: 'open' },
    ]);

    const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
      onSelectionChange(items[1]);
      onSelectionChange(items[3]);
      return items[3];
    });

    const runWl = vi.fn().mockResolvedValue('## Four Details\n\nLine1\nLine2\nLine3');

    const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl });
    extension(makePi() as any);

    const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;
    expect(typeof commandHandler).toBe('function');

    const notify = vi.fn();
    const setWidget = vi.fn();
    await commandHandler('', { ui: { notify, setWidget } });

    expect(listWorkItems).toHaveBeenCalledTimes(1);
    expect(chooseWorkItem).toHaveBeenCalledTimes(1);
    expect(runWl).toHaveBeenCalledWith(['show', 'WL-4', '--format', 'markdown'], false);

    expect(setWidget).toHaveBeenNthCalledWith(1, 'worklog-browse-selection', [
      'Two <WL-2>',
      'Priority/Stage/Status: high/plan_complete/in-progress',
      'Risk/Effort: Medium/Small',
      'L1',
      'L2',
      'L3',
      'L4',
      'L5',
      'L6',
      'L7',
    ]);
    expect(setWidget).toHaveBeenNthCalledWith(2, 'worklog-browse-selection', [
      'Four <WL-4>',
      'Priority/Stage/Status: critical/in_progress/blocked',
      'Risk/Effort: High/Large',
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
    ]);
    expect(setWidget).toHaveBeenCalledWith('worklog-browse-selection', ['## Four Details', '', 'Line1', 'Line2', 'Line3']);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('shows notification on wl show failure and keeps preview', async () => {
    const listWorkItems = vi.fn().mockResolvedValue([
      { id: 'WL-1', title: 'One', status: 'open', description: 'Only' },
    ]);

    const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
      onSelectionChange(items[0]);
      return items[0];
    });

    const runWl = vi.fn().mockRejectedValue(new Error('not found'));

    const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl });
    extension(makePi() as any);

    const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;
    const notify = vi.fn();
    const setWidget = vi.fn();

    await commandHandler('', { ui: { notify, setWidget } });

    expect(runWl).toHaveBeenCalledWith(['show', 'WL-1', '--format', 'markdown'], false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Failed to render work item details'), 'error');
    expect(setWidget).toHaveBeenCalledWith('worklog-browse-selection', [
      'One <WL-1>',
      'Priority/Stage/Status: —/—/open',
      'Risk/Effort: —/—',
      'Only',
    ]);
  });
  it('reports explicit empty state when no items exist', async () => {
    const listWorkItems = vi.fn().mockResolvedValue([]);
    const chooseWorkItem = vi.fn();

    const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem });
    extension(makePi() as any);

    const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;
    const notify = vi.fn();
    const setWidget = vi.fn();

    await commandHandler('', { ui: { notify, setWidget } });

    expect(notify).toHaveBeenCalledWith('No work items available to browse.', 'info');
    expect(chooseWorkItem).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(setWidget).toHaveBeenCalledWith('worklog-browse-selection', undefined);
  });

  it('uses wl next -n 5 and parses results.workItem payload', async () => {
    const runWl = vi.fn().mockResolvedValue(`{\n  "success": true,\n  "count": 2,\n  "results": [\n    { "workItem": { "id": "WL-10", "title": "Ten", "status": "open", "priority": "medium", "stage": "idea", "risk": "Low", "effort": "Small", "description": "alpha\\nbeta" } },\n    { "workItem": { "id": "WL-11", "title": "Eleven", "status": "blocked", "priority": "high", "stage": "in_progress", "risk": "High", "effort": "Large", "description": "gamma\\ndelta" } }\n  ]\n}`);

    const listWorkItems = createDefaultListWorkItems(runWl as any);
    const items = await listWorkItems();

    expect(runWl).toHaveBeenCalledWith(['next', '-n', '5']);
    expect(items).toEqual([
      {
        id: 'WL-10',
        title: 'Ten',
        status: 'open',
        priority: 'medium',
        stage: 'idea',
        risk: 'Low',
        effort: 'Small',
        description: 'alpha\nbeta',
      },
      {
        id: 'WL-11',
        title: 'Eleven',
        status: 'blocked',
        priority: 'high',
        stage: 'in_progress',
        risk: 'High',
        effort: 'Large',
        description: 'gamma\ndelta',
      },
    ]);
  });
});
