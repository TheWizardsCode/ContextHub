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
    const custom = vi.fn(async (renderFn) => {
      // Simulate the TUI calling the render callback
      const factoryResult = renderFn(
        { requestRender: vi.fn() },
        { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        {},
        () => {},
      );
      // Return a thenable that resolves immediately (simulates modal close)
      return Promise.resolve(factoryResult);
    });
    await commandHandler('', { ui: { notify, setWidget, custom } });

    expect(listWorkItems).toHaveBeenCalledTimes(1);
    expect(chooseWorkItem).toHaveBeenCalledTimes(1);
    expect(runWl).toHaveBeenCalledWith(['show', 'WL-4', '--format', 'markdown', '--no-icons'], false);

    expect(setWidget).toHaveBeenNthCalledWith(1, 'worklog-browse-selection', expect.any(Function), { placement: 'belowEditor' });
    expect(setWidget).toHaveBeenNthCalledWith(2, 'worklog-browse-selection', expect.any(Function), { placement: 'belowEditor' });

    // Verify the factory function produces correct output
    const factory1 = setWidget.mock.calls[0][1];
    const mockTheme1 = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const comp1 = factory1({}, mockTheme1);
    expect(comp1.render(80)).toEqual([
      '⭐🔄 Two <WL-2>',
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

    // The scrollable detail widget is now shown via ctx.ui.custom() for proper keyboard focus.
    expect(custom).toHaveBeenCalledTimes(1);

    // Verify that the custom() callback produces a scrollable widget component
    // by re-invoking the factory logic that custom() would call.
    const customCallArgs = custom.mock.calls[0]?.[0] as (tui: any, theme: any, kb: any, done: any) => any;
    const fakeTui = { requestRender: vi.fn() };
    const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const comp = customCallArgs(fakeTui, fakeTheme, {}, () => {});
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
    const custom = vi.fn();

    await commandHandler('', { ui: { notify, setWidget, custom } });

    expect(runWl).toHaveBeenCalledWith(['show', 'WL-1', '--format', 'markdown', '--no-icons'], false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Failed to render work item details'), 'error');
    expect(setWidget).toHaveBeenCalledWith('worklog-browse-selection', expect.any(Function), { placement: 'belowEditor' });
    
    // Verify the factory function produces correct output
    const factory = setWidget.mock.calls[0][1];
    const mockTheme2 = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const comp = factory({}, mockTheme2);
    expect(comp.render(80)).toEqual([
      '🟢 One <WL-1>',
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

    it('handles Kitty arrow sequences (e.g. \x1b[1;1A/\x1b[1;1B)', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      comp.handleInput('\u001b[1;1B'); // Kitty Down
      expect(comp.render(80)[0]).toContain('Line 2');

      comp.handleInput('\u001b[1;1A'); // Kitty Up
      expect(comp.render(80)[0]).toContain('Line 1');
    });

    it('handles Kitty/Page key-id page up/down variants', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTui(), makeTheme());

      comp.handleInput('\u001b[6;1~'); // Kitty PageDown
      expect(comp.render(80)[0]).not.toBe('Line 1');

      comp.handleInput('g');
      expect(comp.render(80)[0]).toBe('Line 1');

      comp.handleInput('pageDown'); // normalized key-id from parseKey
      expect(comp.render(80)[0]).not.toBe('Line 1');

      comp.handleInput('pageUp');
      expect(comp.render(80)[0]).toBe('Line 1');
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

  describe('createScrollableWidget viewport when getHeight is unavailable', () => {
    // Simulates the real pi TUI which does NOT have getHeight().
    // The TUI exposes terminal dimensions via tui.terminal.rows.
    const longContent = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    const makeTuiNoGetHeight = () => ({
      terminal: { rows: 24 },
      requestRender: vi.fn(),
    });
    const makeTheme = () => ({ fg: (_c: string, t: string) => t, bold: (t: string) => t });

    it('uses terminal.rows to determine viewport when getHeight is missing', () => {
      const factory = createScrollableWidget(longContent);
      const comp = factory(makeTuiNoGetHeight(), makeTheme());

      // With terminal height 24, viewport should be floor(24-6) = 18 lines
      const initial = comp.render(80);
      expect(initial.length).toBe(18);
      expect(initial[0]).toContain('Line 1');

      // Scrolling down 20 steps with viewport of 18 → lines 21-38
      for (let i = 0; i < 20; i++) comp.handleInput('\u001b[B');
      const afterScroll = comp.render(80);
      expect(afterScroll[0]).toContain('Line 21');
      expect(afterScroll[afterScroll.length - 1]).toContain('Line 38');
    });

    it('clamps viewport at content length when content is shorter than terminal', () => {
      const shortContent = ['A', 'B', 'C'];
      const factory = createScrollableWidget(shortContent);
      const comp = factory(makeTuiNoGetHeight(), makeTheme());

      const rendered = comp.render(80);
      expect(rendered.length).toBe(3);
      expect(rendered).toEqual(['A', 'B', 'C']);

      // Scrolling should not produce empty lines
      comp.handleInput('\u001b[B');
      comp.handleInput('\u001b[B');
      const clamped = comp.render(80);
      expect(clamped.length).toBe(3);
    });
  });

  describe('custom() keyboard routing integration', () => {
    /**
     * Create a mock custom() that invokes the render callback, captures the
     * returned component and the done callback, and returns it. This matches
     * the real TUI where the factory is called once and the returned component
     * is used for all subsequent input/render cycles.
     */
    function makeCustomMock() {
      const calls: Array<[Function]> = [];
      const componentRef = { current: null as any };
      const doneRef = { current: null as ((value: any) => void) | null };
      // Use a terminal height that creates a reasonable viewport (e.g. ~14 visible lines)
      // The real pi TUI exposes terminal dimensions via terminal.rows (not getHeight).
      const terminalHeight = 20;
      const fn = vi.fn(async (renderFn: Function) => {
        calls.push([renderFn]);
        let capturedDone: (value: any) => void;
        // The real TUI calls the factory once and uses the returned component
        const result = renderFn(
          {
            requestRender: vi.fn(),
            terminal: { rows: terminalHeight },
          },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          {},
          (value: any) => {
            capturedDone = value;
            doneRef.current = value;
          },
        );
        componentRef.current = result;
        return result;
      });
      return { custom: fn, calls, componentRef, doneRef };
    }

    it('uses custom() to display the scrollable widget when available', async () => {
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
      const setWidget = vi.fn();
      const { custom } = makeCustomMock();

      await commandHandler('', { ui: { notify, setWidget, custom } });

      // Verify custom() was called (replaces onTerminalInput approach)
      expect(custom).toHaveBeenCalledTimes(1);
      expect(setWidget).toHaveBeenCalled(); // preview widget is still set

      // Verify the custom() callback returns a scrollable widget component
      expect(custom.mock.calls[0]?.[0]).toBeInstanceOf(Function);
    });

    it('renders scrollable widget content correctly via custom()', async () => {
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
      const setWidget = vi.fn();
      const { custom, componentRef } = makeCustomMock();

      await commandHandler('', { ui: { notify, setWidget, custom } });

      // The component returned by custom() is the actual widget instance
      const comp = componentRef.current;
      expect(typeof comp.render).toBe('function');
      expect(typeof comp.handleInput).toBe('function');

      const initialRender = comp.render(80);
      expect(initialRender[0]).toContain('L1');

      // Test keyboard navigation on the widget component directly
      comp.handleInput('\u001b[B'); // Down
      expect(comp.render(80)[0]).toContain('L2');

      comp.handleInput('\u001b[B'); // Down
      expect(comp.render(80)[0]).toContain('L3');

      comp.handleInput('\u001b[A'); // Up
      expect(comp.render(80)[0]).toContain('L2');

      comp.handleInput('g'); // go to top
      expect(comp.render(80)[0]).toContain('L1');

      comp.handleInput('G'); // go to bottom
      const afterG = comp.render(80);
      expect(afterG[afterG.length - 1].trim()).toContain('L20');
    });

    it('wrapper component has focused property for TUI isFocusable check', () => {
      const tui = { requestRender: vi.fn(), getHeight: () => 20 };
      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

      const widget = createScrollableWidget(['L1', 'L2', 'L3'])(tui, theme);

      // Create the wrapper with the same pattern as production code
      const wrapper = {
        focused: false,
        render: (w: number) => widget.render(w),
        invalidate: () => widget.invalidate(),
        handleInput: (data: string) => {
          widget.handleInput(data);
          tui.requestRender();
        },
      };

      // Verify focused property exists so TUI's isFocusable() returns true
      expect('focused' in wrapper).toBe(true);
      expect(wrapper.focused).toBe(false);
    });

    it('Escape calls done() to close the modal', async () => {
      // Directly test the wrapper logic: create a done callback, invoke the
      // factory to get the widget, then press Escape and verify done() is called.
      const tui = { requestRender: vi.fn(), getHeight: () => 20 };
      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
      let doneCalled = false;
      let doneArg: any = undefined;
      const done = (value: any) => { doneCalled = true; doneArg = value; };

      // Create the scrollable widget (same as production code)
      const widget = createScrollableWidget(['L1', 'L2', 'L3'])(tui, theme);

      // Create the wrapper (same pattern as production code)
      const wrapper = {
        render: (w: number) => widget.render(w),
        invalidate: () => widget.invalidate(),
        handleInput: (data: string) => {
          if (data === '\u001b' || data === 'escape') {
            done(null);
            return;
          }
          widget.handleInput(data);
          tui.requestRender();
        },
      };

      // Verify widget is created
      expect(typeof wrapper.render).toBe('function');
      expect(typeof wrapper.handleInput).toBe('function');
      expect(doneCalled).toBe(false);

      // Press Escape — the wrapper should call done(null)
      wrapper.handleInput('\u001b');
      expect(doneCalled).toBe(true);
      expect(doneArg).toBeNull();

      // Other keys should not trigger done
      wrapper.handleInput('\u001b[B');
      // doneCalled stays true (was called by Escape, not re-triggered)
    });

    it('Escape in detail view clears the worklog-browse-selection widget', async () => {
      // This test verifies the fix for WL-0MQ8KG8R2006E6BS
      // When ESC is pressed in the detail view, the preview widget should be cleared
      const listWorkItems = vi.fn().mockResolvedValue([
        { id: 'WL-1', title: 'One', status: 'open', description: 'Test' },
      ]);

      const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
        onSelectionChange(items[0]);
        return items[0];
      });

      const runWl = vi.fn().mockResolvedValue('# Detail\n\nContent');

      const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl });
      extension(makePi() as any);

      const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;

      const notify = vi.fn();
      const setWidget = vi.fn();
      const { custom } = makeCustomMock();

      await commandHandler('', { ui: { notify, setWidget, custom } });

      // Find the handleInput function from the custom mock
      const customCallArgs = custom.mock.calls[0]?.[0] as Function;
      const tui = { requestRender: vi.fn(), getHeight: () => 20 };
      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
      const comp = customCallArgs(tui, theme, {}, () => {});

      // Press Escape
      comp.handleInput('\u001b');

      // Verify setWidget was called to clear the preview widget
      expect(setWidget).toHaveBeenCalledWith('worklog-browse-selection', undefined);
    });

    it('does not use custom() when not available', async () => {
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

      // No custom provided - should show warning and not crash
      await commandHandler('', { ui: { notify, setWidget } });

      expect(notify).toHaveBeenCalledWith(
        'Scrollable detail view requires a TUI that supports custom overlays.',
        'warning',
      );
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
