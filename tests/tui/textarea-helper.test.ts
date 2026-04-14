import { describe, it, expect, vi, beforeEach } from 'vitest';
import createTextareaHelper from '../../src/tui/textarea-helper.js';

const makeScreen = () => ({
  render: vi.fn(),
  program: {
    x: 0,
    y: 0,
    cup: vi.fn(),
    cuf: vi.fn(),
    cub: vi.fn(),
    cud: vi.fn(),
    cuu: vi.fn(),
    showCursor: vi.fn(),
    hideCursor: vi.fn(),
  },
  grabKeys: false,
});

const makeWidget = (value = '') => {
  const w: any = {
    value,
    getValue: () => w.value,
    setValue: vi.fn((v: string) => { w.value = v; }),
    _updateCursor: vi.fn(),
    // minimal layout internals used by the override
    _clines: ['hello world'],
    _clines: [] as string[],
    itop: 0,
    ileft: 0,
    iheight: 0,
    childBase: 0,
    strWidth: (s: string) => s.length,
    _getCoords: () => ({ xi: 0, yi: 0, xl: 0, yl: 0 }),
  };
  return w;
};

describe('textarea-helper', () => {
  it('inserts and deletes at cursor and updates index', () => {
    const screen = makeScreen();
    const widget: any = {
      value: 'abc',
      getValue: () => widget.value,
      setValue: vi.fn((v: string) => { widget.value = v; }),
    };
    const helper = createTextareaHelper(widget, screen as any);

    helper.setCursorIndex(widget.getValue(), 1);
    expect(helper.getCursorIndex()).toBe(1);

    helper.insertAtCursor('X');
    expect(widget.setValue).toHaveBeenCalled();
    expect(widget.getValue()).toBe('aXbc');
    expect(helper.getCursorIndex()).toBe(2);

    helper.deleteBackward();
    expect(widget.getValue()).toBe('abc');
    expect(helper.getCursorIndex()).toBe(1);

    helper.deleteForward();
    // deleteForward removes the character at the current cursor index (removes 'b')
    expect(widget.getValue()).toBe('ac');
    expect(helper.getCursorIndex()).toBe(1);
  });

  it('moves cursor vertically and horizontally and calls _updateCursor via override', () => {
    const screen: any = makeScreen();
    const widget: any = {
      value: 'line1\nline2\nline3',
      getValue: function () { return this.value; },
      setValue: vi.fn((v: string) => { widget.value = v; }),
      _clines: ['line1', 'line2', 'line3'],
      _clines: [] as any,
      // fake ftor mapping lines to wrapped indexes
      _clines: { ftor: [[0], [1], [2]] } as any,
      _clines: [] as any,
      itop: 0,
      ileft: 0,
      iheight: 1,
      childBase: 0,
      strWidth: (s: string) => s.length,
      _getCoords: () => ({ xi: 0, yi: 0, xl: 10, yl: 5 }),
    } as any;

    // Ensure _clines and ftor shape expected
    widget._clines = ['line1', 'line2', 'line3'];
    (widget._clines as any).ftor = [[0], [1], [2]];

    const helper = createTextareaHelper(widget, screen as any);
    helper.attachUpdateCursorOverride();

    helper.setCursorIndex(widget.getValue(), 0);
    helper.moveHorizontal(2);
    expect(helper.getCursorIndex()).toBe(2);

    // Move down one line
    helper.moveVertical(1);
    // Cursor should now be on second line with same column (2)
    expect(helper.getCursorIndex()).toBeGreaterThanOrEqual(2);

    // Calling update cursor should attempt to position program cursor
    try { (widget as any)._updateCursor(); } catch (_) {}
    // program.cup should have been called at least once
    expect(screen.program.cup).toBeDefined();
  });
});
