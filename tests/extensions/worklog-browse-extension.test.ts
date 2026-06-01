import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDefaultListWorkItems,
  createScrollableWidget,
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

    // The final widget is a scrollable component factory. Ensure setWidget was called with a factory
    const factoryCall = setWidget.mock.calls.find(c => c[0] === 'worklog-browse-selection' && typeof c[1] === 'function');
    expect(factoryCall).toBeDefined();
    const factory = factoryCall?.[1];

    // Simulate the TUI calling the factory to get a component and rendering it
    const fakeTui = { getHeight: () => 80, requestRender: () => {} };
    const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const comp = factory(fakeTui, fakeTheme);
    expect(typeof comp.render).toBe('function');
    expect(comp.render(80)).toEqual(['## Four Details', '', 'Line1', 'Line2', 'Line3']);

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

  describe('createScrollableWidget.handleInput keyboard routing', () => {
    // Use content longer than viewport so scrolling has a visible effect.
    // getHeight: 20 gives viewport of ~14 lines, so 50 lines scrolled by 10
    // will clearly shift the visible range.
    const longContent = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    const makeTui = () => ({ getHeight: () => 20, requestRender: vi.fn() });
    const makeTheme = () => ({ fg: (_c: string, t: string) => t, bold: (t: string) => t });

    it('handles Up key to scroll up by one line', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      // Scroll down first
      comp.handleInput('\u001b[B'); // Down
      expect(comp.render(80)[0]).toContain('Line 2');

      // Scroll back up
      comp.handleInput('\u001b[A'); // Up
      expect(comp.render(80)[0]).toContain('Line 1');
    });

    it('handles Down key to scroll down by one line', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      comp.handleInput('\u001b[B'); // Down
      expect(comp.render(80)[0]).toContain('Line 2');
    });

    it('handles g key to scroll to top', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      // Scroll down first
      for (let i = 0; i < 10; i++) comp.handleInput('\u001b[B');
      expect(comp.render(80)[0]).not.toBe('Line 1');

      // Go to top
      comp.handleInput('g');
      expect(comp.render(80)[0]).toBe('Line 1');
    });

    it('handles G key to scroll to bottom', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      // Go to bottom
      comp.handleInput('G');
      const rendered = comp.render(80);
      expect(rendered[rendered.length - 1].trim()).toContain('Line 50');
    });

    it('handles PageDown and Space to scroll by viewport height', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      // PageDown - should jump by ~14 lines
      comp.handleInput('\u001b[6~');
      const afterPageDown = comp.render(80);
      expect(afterPageDown[0]).not.toBe('Line 1');

      // Scroll back to top and test Space
      comp.handleInput('g');
      expect(comp.render(80)[0]).toBe('Line 1');

      comp.handleInput(' '); // Space should page down
      const afterSpace = comp.render(80);
      expect(afterSpace[0]).not.toBe('Line 1');
    });

    it('handles PageUp to scroll up by viewport height', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      // Go to bottom then page up
      comp.handleInput('G');
      comp.handleInput('\u001b[5~'); // PageUp
      const rendered = comp.render(80);
      // After G we're at bottom (around line 36-50), after PageUp we go up ~14 lines
      expect(rendered[0]).not.toContain('Line 50');
    });

    it('does not scroll above the first line', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      // Multiple up presses should clamp at line 1
      comp.handleInput('\u001b[A');
      comp.handleInput('\u001b[A');
      comp.handleInput('\u001b[A');
      expect(comp.render(80)[0]).toContain('Line 1');
    });

    it('does not scroll below the last line', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      // Go to bottom
      comp.handleInput('G');
      const rendered = comp.render(80);
      expect(rendered[rendered.length - 1].trim()).toContain('Line 50');

      // Pressing down at bottom should not go past last line
      comp.handleInput('\u001b[B');
      const rendered2 = comp.render(80);
      expect(rendered2[rendered2.length - 1].trim()).toContain('Line 50');
    });
  });

  describe('onTerminalInput keyboard routing integration', () => {
    /**
     * Create a setWidget mock that invokes factory functions synchronously,
     * matching the real Pi TUI behaviour where setWidget calls the factory
     * during registration. This ensures widgetInstance is populated before
     * the onTerminalInput registration runs.
     */
    function makeSetWidgetMock() {
      const calls: Array<[string, any]> = [];
      const fn = vi.fn((id: string, content: any) => {
        calls.push([id, content]);
        if (typeof content === 'function') {
          // Simulate Pi TUI: invoke factory synchronously during setWidget
          const fakeTui = { getHeight: () => 20, requestRender: vi.fn() };
          const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
          content(fakeTui, fakeTheme);
        }
      });
      return { setWidget: fn, calls };
    }

    it('registers onTerminalInput listener when scrollable widget is displayed', async () => {
      const listWorkItems = vi.fn().mockResolvedValue([
        { id: 'WL-1', title: 'One', status: 'open', description: 'Test' },
      ]);

      const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
        onSelectionChange(items[0]);
        return items[0];
      });

      const runWl = vi.fn().mockResolvedValue('# Detail\n\nSome\ncontent\nfor\ntesting');

      const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl });
      extension(makePi() as any);

      const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;

      const notify = vi.fn();
      const { setWidget } = makeSetWidgetMock();
      const inputListenerRef = { current: null as ((data: string) => { consume?: boolean; data?: string } | undefined) | null };
      let unsubscribed = false;

      const onTerminalInput = vi.fn((handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
        inputListenerRef.current = handler;
        return () => { unsubscribed = true; };
      });

      await commandHandler('', { ui: { notify, setWidget, onTerminalInput } });

      // Verify onTerminalInput was called (widgetInstance was populated because
      // makeSetWidgetMock invokes the factory synchronously)
      expect(onTerminalInput).toHaveBeenCalledTimes(1);
      expect(inputListenerRef.current).toBeDefined();

      // Verify the listener returns consume for navigation keys
      const listener = inputListenerRef.current!;

      // Down key should be consumed
      expect(listener('\u001b[B')).toEqual({ consume: true });
      // Up key should be consumed
      expect(listener('\u001b[A')).toEqual({ consume: true });
      // g should be consumed
      expect(listener('g')).toEqual({ consume: true });
      // G should be consumed
      expect(listener('G')).toEqual({ consume: true });
      // PageDown should be consumed
      expect(listener('\u001b[6~')).toEqual({ consume: true });
      // PageUp should be consumed
      expect(listener('\u001b[5~')).toEqual({ consume: true });
      // Space should be consumed
      expect(listener(' ')).toEqual({ consume: true });

      // Regular characters should pass through
      expect(listener('x')).toBeUndefined();
      expect(listener('hello')).toBeUndefined();

      // Escape should consume AND clear the widget
      expect(listener('\u001b')).toEqual({ consume: true });
      expect(setWidget).toHaveBeenLastCalledWith('worklog-browse-selection', undefined);
      expect(unsubscribed).toBe(true);
    });

    it('does not register onTerminalInput when not available', async () => {
      const listWorkItems = vi.fn().mockResolvedValue([
        { id: 'WL-1', title: 'One', status: 'open', description: 'Test' },
      ]);

      const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
        onSelectionChange(items[0]);
        return items[0];
      });

      const runWl = vi.fn().mockResolvedValue('Detail');

      const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl });
      extension(makePi() as any);

      const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;
      const notify = vi.fn();
      const setWidget = vi.fn();

      // No onTerminalInput provided - should still work without it
      await commandHandler('', { ui: { notify, setWidget } });

      expect(setWidget).toHaveBeenCalled();
    });

    it('forwards navigation keys from onTerminalInput to widget handleInput', async () => {
      const listWorkItems = vi.fn().mockResolvedValue([
        { id: 'WL-1', title: 'One', status: 'open', description: 'Test' },
      ]);

      const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
        onSelectionChange(items[0]);
        return items[0];
      });

      const runWl = vi.fn().mockResolvedValue('L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nL11\nL12\nL13\nL14\nL15\nL16\nL17\nL18\nL19\nL20');

      const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl });
      extension(makePi() as any);

      const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;

      const notify = vi.fn();
      let capturedHandler: ((data: string) => any) | null = null;
      let capturedWidgetInstance: any = null;
      const setWidget = vi.fn((id: string, content: any) => {
        if (typeof content === 'function') {
          const fakeTui = { getHeight: () => 20, requestRender: vi.fn() };
          const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
          capturedWidgetInstance = content(fakeTui, fakeTheme);
        }
      });
      const onTerminalInput = vi.fn((handler: any) => {
        capturedHandler = handler;
        return vi.fn();
      });

      await commandHandler('', { ui: { notify, setWidget, onTerminalInput } });

      // The onTerminalInput handler should forward to the widget
      expect(capturedHandler).toBeDefined();
      expect(capturedWidgetInstance).toBeDefined();

      const initialRender = capturedWidgetInstance.render(80);
      expect(initialRender[0]).toContain('L1');

      // Dispatch Down key through the captured handler
      capturedHandler!('\u001b[B');
      expect(capturedWidgetInstance.render(80)[0]).toContain('L2');

      // Dispatch Down again
      capturedHandler!('\u001b[B');
      expect(capturedWidgetInstance.render(80)[0]).toContain('L3');

      // Dispatch Up
      capturedHandler!('\u001b[A');
      expect(capturedWidgetInstance.render(80)[0]).toContain('L2');

      // Dispatch g (go to top)
      capturedHandler!('g');
      expect(capturedWidgetInstance.render(80)[0]).toContain('L1');

      // Dispatch G (go to bottom)
      capturedHandler!('G');
      const afterG = capturedWidgetInstance.render(80);
      const lines = afterG.slice(0);
      expect(lines[lines.length - 1].trim()).toContain('L20');
    });
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
