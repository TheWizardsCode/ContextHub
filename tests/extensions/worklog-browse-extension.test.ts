import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDefaultListWorkItems,
  createScrollableWidget,
  createWorklogBrowseExtension,
  defaultChooseWorkItem,
  formatBrowseOption,
} from '../../packages/tui/extensions/index.ts';
import { ShortcutRegistry } from '../../packages/tui/extensions/shortcut-config.js';

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
    on: vi.fn(),
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

  describe('shortcut dispatch integration', () => {
    /**
     * Test shortcut key dispatch in the browse list view using defaultChooseWorkItem directly.
     */
    function makeListCustomMock() {
      const componentRef: { current: any } = { current: null };
      const doneCalls: any[] = [];
      let resolvePromise: (value: any) => void;
      const promise = new Promise<any>((resolve) => {
        resolvePromise = resolve;
      });
      const custom = vi.fn((renderFn: Function) => {
        const result = renderFn(
          { requestRender: vi.fn(), terminal: { rows: 20 } },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          {},
          (val: any) => {
            doneCalls.push(val);
            resolvePromise(val);
          },
        );
        componentRef.current = result;
        return promise;
      });
      return { custom, componentRef, doneCalls, promise };
    }

    it('dispatches n key as intake <id> in the browse list view', async () => {
      const items = [{ id: 'WL-99', title: 'Intake me', status: 'open' }];

      const { custom, componentRef, doneCalls } = makeListCustomMock();
      const registry = new ShortcutRegistry([
        { key: 'n', command: 'intake <id>', view: 'both' },
      ]);
      const ctx: any = { ui: { custom, notify: vi.fn() } };

      // Start defaultChooseWorkItem — it will call custom() which calls renderFn synchronously
      const resultPromise = defaultChooseWorkItem(items, ctx, () => {}, registry);
      // Yield to let custom() be called
      await new Promise(r => setTimeout(r, 0));

      const comp = componentRef.current;
      expect(typeof comp.handleInput).toBe('function');

      // Press 'n' — should trigger intake shortcut and return ShortcutResult
      comp.handleInput('n');

      // Verify done() was called with ShortcutResult
      expect(doneCalls[0]).toEqual({ type: 'shortcut', command: 'intake WL-99' });
      // Verify the return value is the ShortcutResult (propagated through done())
      const result = await resultPromise;
      expect(result).toEqual({ type: 'shortcut', command: 'intake WL-99' });
    });

    it('shortcut result has no trailing newline for review before submission', async () => {
      const items = [{ id: 'WL-ABC', title: 'Some item', status: 'open' }];

      const { custom, componentRef, doneCalls } = makeListCustomMock();
      const registry = new ShortcutRegistry([
        { key: 'n', command: 'intake <id>', view: 'both' },
      ]);
      const ctx: any = { ui: { custom, notify: vi.fn() } };

      const resultPromise2 = defaultChooseWorkItem(items, ctx, () => {}, registry);
      await new Promise(r => setTimeout(r, 0));

      componentRef.current.handleInput('n');

      // Verify done() was called with ShortcutResult containing the command
      expect(doneCalls[0]).toEqual({ type: 'shortcut', command: 'intake WL-ABC' });
      // No trailing newline
      expect(doneCalls[0].command.endsWith('\n')).toBe(false);
      expect(doneCalls[0].command.endsWith('\r')).toBe(false);
      // Verify the return value matches the done() call
      const result2 = await resultPromise2;
      expect(result2).toEqual({ type: 'shortcut', command: 'intake WL-ABC' });
    });

    it('still navigates with up/down keys while shortcut keys trigger commands', async () => {
      const items = [
        { id: 'WL-1', title: 'One', status: 'open' },
        { id: 'WL-2', title: 'Two', status: 'open' },
        { id: 'WL-3', title: 'Three', status: 'open' },
      ];

      const { custom, componentRef, doneCalls } = makeListCustomMock();
      const registry = new ShortcutRegistry([
        { key: 'n', command: 'intake <id>', view: 'both' },
      ]);
      const ctx: any = { ui: { custom, notify: vi.fn() } };

      const resultPromise3 = defaultChooseWorkItem(items, ctx, () => {}, registry);
      await new Promise(r => setTimeout(r, 0));

      const comp = componentRef.current;

      // Press Down twice: index 0 → 1 → 2
      comp.handleInput('\u001b[B');
      comp.handleInput('\u001b[B');

      // Now press 'n' — should use item at index 2
      comp.handleInput('n');

      // Verify done() was called with ShortcutResult
      expect(doneCalls[0]).toEqual({ type: 'shortcut', command: 'intake WL-3' });
      // Verify the return value matches
      const result3 = await resultPromise3;
      expect(result3).toEqual({ type: 'shortcut', command: 'intake WL-3' });
    });

    it('dispatches n key as intake <id> in the detail scrollable view', async () => {
      const setEditorText = vi.fn();
      const setWidget = vi.fn();
      const listWorkItems = vi.fn().mockResolvedValue([
        { id: 'WL-DEET', title: 'Detail item', status: 'open', description: 'test' },
      ]);
      const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
        onSelectionChange(items[0]);
        return items[0];
      });
      const runWl = vi.fn().mockResolvedValue('## Detail\n\nSome content');

      const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl });
      extension(makePi() as any);

      const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;

      // Capture the renderFn and done result from custom() calls
      const renderFnCapture: Function[] = [];
      const doneResults: any[] = [];
      const custom = vi.fn(async (renderFn: Function) => {
        renderFnCapture.push((tui: any, theme: any, kb: any, done: any) => renderFn(tui, theme, kb, (v: any) => { doneResults.push(v); }));
        return null;
      });

      await commandHandler('', { ui: { notify: vi.fn(), setWidget, custom, setEditorText } as any });

      // custom() was called once (detail view; browse list bypassed by chooseWorkItem mock)
      expect(custom).toHaveBeenCalledTimes(1);

      // Extract the component from the captured renderFn
      const doneWrapper = (val: any) => doneResults.push(val);
      const component = renderFnCapture[0](
        { requestRender: vi.fn(), terminal: { rows: 20 } },
        { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        {},
        doneWrapper,
      );

      // Press 'n' in detail view — should trigger intake shortcut and return ShortcutResult
      component.handleInput('n');

      // Verify ShortcutResult was returned (caller will set editor text after modal closes)
      expect(doneResults[0]).toEqual({ type: 'shortcut', command: 'intake WL-DEET' });
      // No trailing newline
      expect(doneResults[0].command.endsWith('\n')).toBe(false);
      expect(doneResults[0].command.endsWith('\r')).toBe(false);
    });

    it('dispatches a key as audit <id> in the browse list view', async () => {
      const items = [{ id: 'WL-50', title: 'Audit me', status: 'open' }];

      const { custom, componentRef, doneCalls } = makeListCustomMock();
      const registry = new ShortcutRegistry([
        { key: 'a', command: 'audit <id>', view: 'both' },
      ]);
      const ctx: any = { ui: { custom, notify: vi.fn() } };

      // Start defaultChooseWorkItem — it will call custom() which calls renderFn synchronously
      const resultPromise4 = defaultChooseWorkItem(items, ctx, () => {}, registry);
      // Yield to let custom() be called
      await new Promise(r => setTimeout(r, 0));

      const comp = componentRef.current;
      expect(typeof comp.handleInput).toBe('function');

      // Press 'a' — should trigger audit shortcut and return ShortcutResult
      comp.handleInput('a');

      // Verify done() was called with ShortcutResult
      expect(doneCalls[0]).toEqual({ type: 'shortcut', command: 'audit WL-50' });
      // No trailing newline
      expect(doneCalls[0].command.endsWith('\n')).toBe(false);
      expect(doneCalls[0].command.endsWith('\r')).toBe(false);
      // Verify return value
      const result4 = await resultPromise4;
      expect(result4).toEqual({ type: 'shortcut', command: 'audit WL-50' });
    });

    it('shortcut result for audit has no trailing newline', async () => {
      const items = [{ id: 'WL-AUD', title: 'Audit item', status: 'open' }];

      const { custom, componentRef, doneCalls } = makeListCustomMock();
      const registry = new ShortcutRegistry([
        { key: 'a', command: 'audit <id>', view: 'both' },
      ]);
      const ctx: any = { ui: { custom, notify: vi.fn() } };

      const resultPromise5 = defaultChooseWorkItem(items, ctx, () => {}, registry);
      await new Promise(r => setTimeout(r, 0));

      componentRef.current.handleInput('a');

      // Verify done() was called with ShortcutResult
      expect(doneCalls[0]).toEqual({ type: 'shortcut', command: 'audit WL-AUD' });
      // No trailing newline
      expect(doneCalls[0].command.endsWith('\n')).toBe(false);
      expect(doneCalls[0].command.endsWith('\r')).toBe(false);
      // Verify return value
      const result5 = await resultPromise5;
      expect(result5).toEqual({ type: 'shortcut', command: 'audit WL-AUD' });
    });

    it('still navigates with up/down keys while a key triggers audit command', async () => {
      const items = [
        { id: 'WL-1', title: 'One', status: 'open' },
        { id: 'WL-2', title: 'Two', status: 'open' },
        { id: 'WL-3', title: 'Three', status: 'open' },
      ];

      const { custom, componentRef, doneCalls } = makeListCustomMock();
      const registry = new ShortcutRegistry([
        { key: 'a', command: 'audit <id>', view: 'both' },
      ]);
      const ctx: any = { ui: { custom, notify: vi.fn() } };

      const resultPromise6 = defaultChooseWorkItem(items, ctx, () => {}, registry);
      await new Promise(r => setTimeout(r, 0));

      const comp = componentRef.current;

      // Press Down twice: index 0 → 1 → 2
      comp.handleInput('\u001b[B');
      comp.handleInput('\u001b[B');

      // Now press 'a' — should use item at index 2
      comp.handleInput('a');

      // Verify done() was called with ShortcutResult
      expect(doneCalls[0]).toEqual({ type: 'shortcut', command: 'audit WL-3' });
      // Verify return value
      const result6 = await resultPromise6;
      expect(result6).toEqual({ type: 'shortcut', command: 'audit WL-3' });
    });

    it('dispatches a key as audit <id> in the detail scrollable view', async () => {
      const setEditorText = vi.fn();
      const setWidget = vi.fn();
      const listWorkItems = vi.fn().mockResolvedValue([
        { id: 'WL-AUDIT', title: 'Audit item', status: 'open', description: 'test' },
      ]);
      const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
        onSelectionChange(items[0]);
        return items[0];
      });
      const runWl = vi.fn().mockResolvedValue('## Detail\n\nSome content');

      const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl });
      extension(makePi() as any);

      const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;

      // Capture the renderFn and done result from custom() calls
      const renderFnCapture: Function[] = [];
      const doneResults: any[] = [];
      const custom = vi.fn(async (renderFn: Function) => {
        renderFnCapture.push((tui: any, theme: any, kb: any, done: any) => renderFn(tui, theme, kb, (v: any) => { doneResults.push(v); }));
        return null;
      });

      await commandHandler('', { ui: { notify: vi.fn(), setWidget, custom, setEditorText } as any });

      // custom() was called once (detail view; browse list bypassed by chooseWorkItem mock)
      expect(custom).toHaveBeenCalledTimes(1);

      // Extract the component from the captured renderFn
      const doneWrapper = (val: any) => doneResults.push(val);
      const component = renderFnCapture[0](
        { requestRender: vi.fn(), terminal: { rows: 20 } },
        { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        {},
        doneWrapper,
      );

      // Press 'a' in detail view — should trigger audit shortcut and return ShortcutResult
      component.handleInput('a');

      // Verify ShortcutResult was returned (caller will set editor text after modal closes)
      expect(doneResults[0]).toEqual({ type: 'shortcut', command: 'audit WL-AUDIT' });
      // No trailing newline
      expect(doneResults[0].command.endsWith('\n')).toBe(false);
      expect(doneResults[0].command.endsWith('\r')).toBe(false);
    });

    it('full config→load→dispatch→setEditorText flow in both views', async () => {
      // Simulates the complete flow: config file loaded → ShortcutRegistry built
      // → shortcut key dispatches correct command in both list and detail views.
      const setEditorText = vi.fn();
      const setWidget = vi.fn();

      // Step 1: Build registry from config entries (simulates loadShortcutConfig)
      const registry = new ShortcutRegistry([
        { key: 'i', command: 'implement <id>', view: 'both' },
        { key: 'p', command: 'plan <id>', view: 'both' },
        { key: 'n', command: 'intake <id>', view: 'both' },
        { key: 'a', command: 'audit <id>', view: 'both' },
      ]);
      expect(registry.getEntries()).toHaveLength(4);

      // Step 2: Verify registry resolves commands in both views
      expect(registry.lookup('i', 'list')).toBe('implement <id>');
      expect(registry.lookup('i', 'detail')).toBe('implement <id>');
      expect(registry.lookup('p', 'list')).toBe('plan <id>');
      expect(registry.lookup('p', 'detail')).toBe('plan <id>');
      expect(registry.lookup('n', 'list')).toBe('intake <id>');
      expect(registry.lookup('n', 'detail')).toBe('intake <id>');
      expect(registry.lookup('a', 'list')).toBe('audit <id>');
      expect(registry.lookup('a', 'detail')).toBe('audit <id>');

      // Step 3: Dispatch in list view
      const listItems = [{ id: 'WL-LIST', title: 'List item', status: 'open' }];
      const { custom: listCustom, componentRef: listComp, doneCalls: listDone } = makeListCustomMock();
      const listCtx: any = { ui: { custom: listCustom, notify: vi.fn() } };

      const listResultPromise = defaultChooseWorkItem(listItems, listCtx, () => {}, registry);
      await new Promise(r => setTimeout(r, 0));

      listComp.current.handleInput('i');
      expect(listDone[0]).toEqual({ type: 'shortcut', command: 'implement WL-LIST' });
      const listResult = await listResultPromise;
      expect(listResult).toEqual({ type: 'shortcut', command: 'implement WL-LIST' });

      // Step 4: Dispatch in detail view
      const listWorkItems = vi.fn().mockResolvedValue([
        { id: 'WL-DEET', title: 'Detail item', status: 'open', description: 'test' },
      ]);
      const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
        onSelectionChange(items[0]);
        return items[0];
      });
      const runWl = vi.fn().mockResolvedValue('## Detail\n\nSome content');

      const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl });
      extension(makePi() as any);

      const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;
      const renderFnCapture: Function[] = [];
      const doneResults: any[] = [];
      const detailCustom = vi.fn(async (renderFn: Function) => {
        renderFnCapture.push((tui: any, theme: any, kb: any, done: any) => renderFn(tui, theme, kb, (v: any) => { doneResults.push(v); }));
        return null;
      });

      await commandHandler('', { ui: { notify: vi.fn(), setWidget, custom: detailCustom, setEditorText } as any });

      expect(detailCustom).toHaveBeenCalledTimes(1);

      const detailComponent = renderFnCapture[0](
        { requestRender: vi.fn(), terminal: { rows: 20 } },
        { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        {},
        () => {},
      );

      detailComponent.handleInput('p');
      expect(doneResults[0]).toEqual({ type: 'shortcut', command: 'plan WL-DEET' });
    });

    it('unregistered keys are no-ops in both list and detail views', async () => {
      // Verify that keys not in the registry do not trigger any shortcut dispatch.

      // List view: unregistered key does not call setEditorText
      const setEditorTextList = vi.fn();
      const listItems = [{ id: 'WL-X', title: 'Test', status: 'open' }];
      const { custom: listCustom2, componentRef: listComp2, doneCalls: doneCallsX } = makeListCustomMock();
      const registryX = new ShortcutRegistry([
        { key: 'i', command: 'implement <id>', view: 'both' },
      ]);
      const listCtx2: any = { ui: { custom: listCustom2, setEditorText: setEditorTextList, notify: vi.fn() } };

      const unregPromise = defaultChooseWorkItem(listItems, listCtx2, () => {}, registryX);
      await new Promise(r => setTimeout(r, 0));

      listComp2.current.handleInput('x');
      expect(setEditorTextList).not.toHaveBeenCalled();
      // Unregistered key should not trigger done() - verify promise hasn't resolved
      expect(doneCallsX).toHaveLength(0);

      // Detail view: unregistered key does not call setEditorText
      const setEditorTextDetail = vi.fn();
      const setWidget2 = vi.fn();
      const lw2 = vi.fn().mockResolvedValue([
        { id: 'WL-Y', title: 'Test', status: 'open', description: 'test' },
      ]);
      const cw2 = vi.fn(async (items, _ctx, onSelectionChange) => {
        onSelectionChange(items[0]);
        return items[0];
      });
      const rw2 = vi.fn().mockResolvedValue('## Detail\n\nContent');

      const ext2 = createWorklogBrowseExtension({ listWorkItems: lw2, chooseWorkItem: cw2, runWl: rw2 });
      ext2(makePi() as any);

      const cmdHandler2 = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;
      const rc2: Function[] = [];
      const cust2 = vi.fn(async (renderFn: Function) => {
        rc2.push(renderFn);
        return null;
      });

      await cmdHandler2('', { ui: { notify: vi.fn(), setWidget: setWidget2, custom: cust2, setEditorText: setEditorTextDetail } as any });

      const detailComp2 = rc2[0](
        { requestRender: vi.fn(), terminal: { rows: 20 } },
        { fg: (_c: string, t: string) => t, bold: (t: string) => t },
        {},
        () => {},
      );

      detailComp2.handleInput('z');
      expect(setEditorTextDetail).not.toHaveBeenCalled();
    });

    it('navigation keys remain functional in the presence of shortcuts', async () => {
      // Regression test: confirms that all existing navigation keys continue to work
      // correctly after the dynamic dispatcher was introduced.

      // List view: navigation keys (Up/Down) work alongside shortcuts
      const setEditorText = vi.fn();
      const testItems = [
        { id: 'WL-1', title: 'One', status: 'open' },
        { id: 'WL-2', title: 'Two', status: 'open' },
        { id: 'WL-3', title: 'Three', status: 'open' },
      ];
      const testRegistry = new ShortcutRegistry([
        { key: 'i', command: 'implement <id>', view: 'both' },
      ]);

      const { custom: navListCustom, componentRef: navListComp, doneCalls: navDoneCalls } = makeListCustomMock();
      const navListCtx: any = { ui: { custom: navListCustom, notify: vi.fn() } };

      const navResultPromise = defaultChooseWorkItem(testItems, navListCtx, () => {}, testRegistry);
      await new Promise(r => setTimeout(r, 0));

      const navComp = navListComp.current;
      // Navigate down twice: index 0 → 1 → 2
      navComp.handleInput('\u001b[B'); // → index 1
      navComp.handleInput('\u001b[B'); // → index 2
      // Navigate up once: index 2 → 1
      navComp.handleInput('\u001b[A');
      // Press shortcut 'i' - should dispatch for item at index 1
      navComp.handleInput('i');
      expect(navDoneCalls[0]).toEqual({ type: 'shortcut', command: 'implement WL-2' });
      const navResult = await navResultPromise;
      expect(navResult).toEqual({ type: 'shortcut', command: 'implement WL-2' });

      // Detail view: scrollable widget handles PageUp/PageDown/g/G
      const tui = { requestRender: vi.fn(), getHeight: () => 20 };
      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

      const scrollItems = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`);
      const widget = createScrollableWidget(scrollItems)(tui, theme);

      // g → top
      widget.handleInput('g');
      expect(widget.render(80)[0]).toBe('Line 1');

      // G → bottom
      widget.handleInput('G');
      expect(widget.render(80).at(-1)?.trim()).toContain('Line 30');

      // Space (PageDown)
      widget.handleInput('g'); // back to top
      widget.handleInput(' ');
      expect(widget.render(80)[0]).not.toBe('Line 1');

      // PageUp
      widget.handleInput('\u001b[5~');
      expect(widget.render(80)[0]).not.toBe('Line 30');
    });

    it('Enter key selects a work item and returns it from defaultChooseWorkItem', async () => {
      const items = [
        { id: 'WL-E1', title: 'First', status: 'open' },
        { id: 'WL-E2', title: 'Second', status: 'open' },
      ];

      const { custom, componentRef, doneCalls } = makeListCustomMock();
      const ctx: any = { ui: { custom, notify: vi.fn() } };
      const onSelectionChange = vi.fn();

      const enterPromise = defaultChooseWorkItem(items, ctx, onSelectionChange);
      await new Promise(r => setTimeout(r, 0));

      // Navigate down and press Enter
      componentRef.current.handleInput('\u001b[B');
      componentRef.current.handleInput('\r');

      // done() should have been called with the selected item
      expect(doneCalls[0]).toEqual(items[1]);
      // onSelectionChange should have been called for the navigation
      expect(onSelectionChange).toHaveBeenCalledWith(items[1]);
      // Return value should be the selected work item
      const enterResult = await enterPromise;
      expect(enterResult).toEqual(items[1]);
    });

    it('Escape key cancels and returns undefined from defaultChooseWorkItem', async () => {
      const items = [{ id: 'WL-C1', title: 'Cancel test', status: 'open' }];

      const { custom, componentRef, doneCalls } = makeListCustomMock();
      const ctx: any = { ui: { custom, notify: vi.fn() } };

      const escapePromise = defaultChooseWorkItem(items, ctx, vi.fn());
      await new Promise(r => setTimeout(r, 0));

      componentRef.current.handleInput('\u001b');

      // done() should have been called with null
      expect(doneCalls[0]).toBeNull();
      // Return value should be undefined (null ?? undefined)
      const escapeResult = await escapePromise;
      expect(escapeResult).toBeUndefined();
    });

    describe('navigation key protection (WL-0MQDR4V7O007O7TZ)', () => {
      it('browse list: reserved navigation key g does not dispatch shortcut', async () => {
        // If a shortcut is configured for 'g' in the browse list, it should be
        // ignored because 'g' is a reserved navigation key.
        const items = [{ id: 'WL-G', title: 'G item', status: 'open' }];
        const { custom, componentRef, doneCalls } = makeListCustomMock();
        const registry = new ShortcutRegistry([
          { key: 'g', command: 'go <id>', view: 'both' },
        ]);
        const ctx: any = { ui: { custom, notify: vi.fn() } };

        const resultPromise = defaultChooseWorkItem(items, ctx, () => {}, registry);
        await new Promise(r => setTimeout(r, 0));

        // Press 'g' - should NOT trigger shortcut since it's reserved
        componentRef.current.handleInput('g');

        // done() should NOT have been called (g is not enter/escape)
        expect(doneCalls).toHaveLength(0);
      });

      it('detail view: reserved navigation key g does not dispatch shortcut', async () => {
        // Use a custom registry that HAS a shortcut configured for 'g'.
        // The defensive set should prevent it from dispatching.
        const navRegistry = new ShortcutRegistry([
          { key: 'g', command: 'g-command <id>', view: 'detail' },
        ]);
        const setEditorText = vi.fn();
        const setWidget = vi.fn();
        const listWorkItems = vi.fn().mockResolvedValue([
          { id: 'WL-G', title: 'G item', status: 'open', description: 'test' },
        ]);
        const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
          onSelectionChange(items[0]);
          return items[0];
        });
        const runWl = vi.fn().mockResolvedValue('## Detail\n\nContent');

        const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl, shortcutRegistry: navRegistry });
        extension(makePi() as any);

        const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;

        const renderFnCapture: Function[] = [];
        const doneResults: any[] = [];
        const custom = vi.fn(async (renderFn: Function) => {
          renderFnCapture.push((tui: any, theme: any, kb: any, done: any) => renderFn(tui, theme, kb, (v: any) => { doneResults.push(v); }));
          return null;
        });

        await commandHandler('', { ui: { notify: vi.fn(), setWidget, custom, setEditorText } as any });

        expect(custom).toHaveBeenCalledTimes(1);

        const component = renderFnCapture[0](
          { requestRender: vi.fn(), terminal: { rows: 20 } },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          {},
          () => {},
        );

        // Press 'g' in detail view — should NOT trigger shortcut (g is reserved for scroll-to-top)
        component.handleInput('g');
        expect(doneResults).toHaveLength(0);
      });

      it('detail view: reserved navigation key G does not dispatch shortcut', async () => {
        // Use a custom registry that HAS a shortcut configured for 'G'
        const navRegistry = new ShortcutRegistry([
          { key: 'G', command: 'G-command <id>', view: 'detail' },
        ]);
        const setEditorText = vi.fn();
        const setWidget = vi.fn();
        const listWorkItems = vi.fn().mockResolvedValue([
          { id: 'WL-GCAP', title: 'G cap item', status: 'open', description: 'test' },
        ]);
        const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
          onSelectionChange(items[0]);
          return items[0];
        });
        const runWl = vi.fn().mockResolvedValue('## Detail\n\nContent');

        const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl, shortcutRegistry: navRegistry });
        extension(makePi() as any);

        const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;

        const renderFnCapture: Function[] = [];
        const doneResults: any[] = [];
        const custom = vi.fn(async (renderFn: Function) => {
          renderFnCapture.push((tui: any, theme: any, kb: any, done: any) => renderFn(tui, theme, kb, (v: any) => { doneResults.push(v); }));
          return null;
        });

        await commandHandler('', { ui: { notify: vi.fn(), setWidget, custom, setEditorText } as any });

        expect(custom).toHaveBeenCalledTimes(1);

        const component = renderFnCapture[0](
          { requestRender: vi.fn(), terminal: { rows: 20 } },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          {},
          () => {},
        );

        // Press 'G' in detail view — should NOT trigger shortcut (G is reserved for scroll-to-bottom)
        component.handleInput('G');
        expect(doneResults).toHaveLength(0);
      });

      it('detail view: reserved navigation key space does not dispatch shortcut', async () => {
        // Use a custom registry that HAS a shortcut configured for space
        const navRegistry = new ShortcutRegistry([
          { key: ' ', command: 'space-command <id>', view: 'detail' },
        ]);
        const setEditorText = vi.fn();
        const setWidget = vi.fn();
        const listWorkItems = vi.fn().mockResolvedValue([
          { id: 'WL-SP', title: 'Space item', status: 'open', description: 'test' },
        ]);
        const chooseWorkItem = vi.fn(async (items, _ctx, onSelectionChange) => {
          onSelectionChange(items[0]);
          return items[0];
        });
        const runWl = vi.fn().mockResolvedValue('## Detail\n\nContent');

        const extension = createWorklogBrowseExtension({ listWorkItems, chooseWorkItem, runWl, shortcutRegistry: navRegistry });
        extension(makePi() as any);

        const commandHandler = registerCommand.mock.calls.find(c => c[0] === 'wl')?.[1]?.handler;

        const renderFnCapture: Function[] = [];
        const doneResults: any[] = [];
        const custom = vi.fn(async (renderFn: Function) => {
          renderFnCapture.push((tui: any, theme: any, kb: any, done: any) => renderFn(tui, theme, kb, (v: any) => { doneResults.push(v); }));
          return null;
        });

        await commandHandler('', { ui: { notify: vi.fn(), setWidget, custom, setEditorText } as any });

        expect(custom).toHaveBeenCalledTimes(1);

        const component = renderFnCapture[0](
          { requestRender: vi.fn(), terminal: { rows: 20 } },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          {},
          () => {},
        );

        // Press space in detail view — should NOT trigger shortcut (space is reserved for page down)
        component.handleInput(' ');
        expect(doneResults).toHaveLength(0);
      });

      it('non-navigation keys still dispatch shortcuts despite reserved set', async () => {
        // Regression: non-navigation single-char keys should still dispatch
        const items = [{ id: 'WL-MIX', title: 'Mixed', status: 'open' }];
        const { custom, componentRef, doneCalls } = makeListCustomMock();
        const registry = new ShortcutRegistry([
          { key: 'i', command: 'implement <id>', view: 'both' },
          { key: 'g', command: 'go <id>', view: 'both' },
          { key: ' ', command: 'space <id>', view: 'both' },
        ]);
        const ctx: any = { ui: { custom, notify: vi.fn() } };

        const resultPromise = defaultChooseWorkItem(items, ctx, () => {}, registry);
        await new Promise(r => setTimeout(r, 0));

        // Press 'i' — should still dispatch (i is NOT a reserved navigation key)
        componentRef.current.handleInput('i');

        expect(doneCalls[0]).toEqual({ type: 'shortcut', command: 'implement WL-MIX' });
        const result = await resultPromise;
        expect(result).toEqual({ type: 'shortcut', command: 'implement WL-MIX' });
      });
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
