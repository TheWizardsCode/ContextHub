/*
 * Textarea helper: encapsulates cursor/index math and read-mode helpers
 * used by TUI multiline textareas. This extracts the logic from
 * controller.ts so other modules can reuse the behaviour.
 */
import type { Widgets } from 'blessed';

type AnyWidget = any;

export type TextareaHelper = {
  getCursorIndex: () => number;
  setCursorIndex: (value: string, nextIndex: number) => void;
  moveHorizontal: (delta: number) => void;
  moveVertical: (delta: number) => void;
  insertAtCursor: (text: string) => void;
  deleteBackward: () => void;
  deleteForward: () => void;
  attachUpdateCursorOverride: () => void;
  startReading: () => void;
  endReading: () => void;
  buildKeyHandler: () => (ch: unknown, key: unknown) => boolean | undefined;
};

// Create and attach helpers for a blessed textarea-like widget.
export default function createTextareaHelper(widget: AnyWidget, screen: AnyWidget): TextareaHelper {
  let cursorIndex = 0;
  let desiredColumn: number | null = null;

  const clamp = (value: string, nextIndex: number) => Math.max(0, Math.min(nextIndex, value.length));

  const setCursorIndex = (value: string, nextIndex: number) => {
    cursorIndex = clamp(value, nextIndex);
    try { if (widget) (widget as any).__opencode_cursor = cursorIndex; } catch (_) {}
  };

  const getLineColumnFromIndex = (value: string, index: number) => {
    const clamped = Math.max(0, Math.min(index, value.length));
    let line = 0;
    let column = 0;
    for (let i = 0; i < clamped; i += 1) {
      if (value[i] === '\n') {
        line += 1;
        column = 0;
      } else {
        column += 1;
      }
    }
    return { line, column };
  };

  const getIndexFromLineColumn = (value: string, line: number, column: number) => {
    const lines = value.split('\n');
    const safeLine = Math.max(0, Math.min(line, Math.max(0, lines.length - 1)));
    let idx = 0;
    for (let i = 0; i < safeLine; i += 1) {
      idx += lines[i].length + 1;
    }
    const safeColumn = Math.max(0, Math.min(column, lines[safeLine]?.length ?? 0));
    return idx + safeColumn;
  };

  const updateCursor = () => {
    try { (widget as any)._updateCursor?.(); } catch (_) {}
    try { screen.render(); } catch (_) {}
  };

  const moveHorizontal = (delta: number) => {
    const value = widget.getValue ? widget.getValue() : '';
    setCursorIndex(value, cursorIndex + delta);
    const { column } = getLineColumnFromIndex(value, cursorIndex);
    desiredColumn = column;
    updateCursor();
  };

  const moveVertical = (delta: number) => {
    const value = widget.getValue ? widget.getValue() : '';
    const position = getLineColumnFromIndex(value, cursorIndex);
    const targetLine = position.line + delta;
    const desired = desiredColumn ?? position.column;
    const nextIndex = getIndexFromLineColumn(value, targetLine, desired);
    setCursorIndex(value, nextIndex);
    updateCursor();
  };

  const insertAtCursor = (text: string) => {
    if (!text) return;
    const value = widget.getValue ? widget.getValue() : '';
    const nextValue = value.slice(0, cursorIndex) + text + value.slice(cursorIndex);
    const nextIndex = cursorIndex + text.length;
    widget.setValue?.(nextValue);
    setCursorIndex(nextValue, nextIndex);
    desiredColumn = null;
    updateCursor();
  };

  const deleteBackward = () => {
    const value = widget.getValue ? widget.getValue() : '';
    if (cursorIndex <= 0) return;
    const nextValue = value.slice(0, cursorIndex - 1) + value.slice(cursorIndex);
    const nextIndex = cursorIndex - 1;
    widget.setValue?.(nextValue);
    setCursorIndex(nextValue, nextIndex);
    desiredColumn = null;
    updateCursor();
  };

  const deleteForward = () => {
    const value = widget.getValue ? widget.getValue() : '';
    if (cursorIndex >= value.length) return;
    const nextValue = value.slice(0, cursorIndex) + value.slice(cursorIndex + 1);
    widget.setValue?.(nextValue);
    setCursorIndex(nextValue, cursorIndex);
    desiredColumn = null;
    updateCursor();
  };

  // Override widget._updateCursor to position the terminal cursor according
  // to the current helper cursorIndex and widget internals (_clines, ftor).
  const attachUpdateCursorOverride = () => {
    const base = (widget as any)._updateCursor?.bind(widget);
    const custom = function(this: any, get?: boolean) {
      if (this.screen?.focused !== this) return;
      const lpos = get ? this.lpos : this._getCoords?.();
      if (!lpos || !this.screen?.program) {
        base?.(get);
        return;
      }
      if (!this._clines || !Array.isArray(this._clines) || !Array.isArray(this._clines.ftor)) {
        base?.(get);
        return;
      }

      const value = typeof this.value === 'string' ? this.value : '';
      const { line, column } = getLineColumnFromIndex(value, cursorIndex);
      const wrappedIndexes: number[] = this._clines.ftor[line] ?? [];
      const fallbackIndex = Math.min(line, Math.max(0, this._clines.length - 1));
      const wrapped = wrappedIndexes.length ? wrappedIndexes : [fallbackIndex];

      let remaining = column;
      let wrappedIndex = wrapped[wrapped.length - 1] ?? fallbackIndex;
      let columnInWrapped = 0;

      for (const index of wrapped) {
        const text = (this._clines[index] ?? '').replace(/\x1b\[[0-9;]*m/g, '');
        const width = typeof this.strWidth === 'function' ? this.strWidth(text) : text.length;
        if (remaining <= width) {
          wrappedIndex = index;
          columnInWrapped = remaining;
          break;
        }
        remaining -= width;
      }

      if (wrappedIndex == null || wrappedIndex < 0) {
        base?.(get);
        return;
      }

      const visibleLine = Math.max(
        0,
        Math.min(
          wrappedIndex - (this.childBase || 0),
          Math.max(0, (lpos.yl - lpos.yi) - this.iheight - 1),
        ),
      );
      const lineText = (this._clines[wrappedIndex] ?? '').replace(/\x1b\[[0-9;]*m/g, '');
      const colText = lineText.slice(0, columnInWrapped);
      const cxOffset = typeof this.strWidth === 'function' ? this.strWidth(colText) : colText.length;
      const cy = lpos.yi + this.itop + visibleLine;
      const cx = lpos.xi + this.ileft + cxOffset;
      const program = this.screen.program;

      if (cy === program.y && cx === program.x) return;
      if (cy === program.y) {
        if (cx > program.x) {
          program.cuf(cx - program.x);
        } else if (cx < program.x) {
          program.cub(program.x - cx);
        }
      } else if (cx === program.x) {
        if (cy > program.y) {
          program.cud(cy - program.y);
        } else if (cy < program.y) {
          program.cuu(program.y - cy);
        }
      } else {
        program.cup(cy, cx);
      }
    };
    try { (widget as any)._updateCursor = custom; } catch (_) {}
  };

  const endReading = () => {
    try {
      if (widget?.__listener && typeof widget.removeListener === 'function') {
        try { widget.removeListener('keypress', widget.__listener); } catch (_) {}
      }
      if (widget?.__done && typeof widget.removeListener === 'function') {
        try { widget.removeListener('blur', widget.__done); } catch (_) {}
      }
      // If a legacy `_done` callback is present (tests and some blessed
      // variants use this), call it so callers can perform cleanup. Do so
      // before deleting the property so spies are still callable.
      try { if (typeof widget?._done === 'function') { try { (widget as any)._done(); } catch (_) {} } } catch (_) {}

      delete widget.__listener;
      delete widget.__done;
      // Intentionally preserve any legacy `_done` callback so tests and
      // callers can still assert on or reuse the function after we call it.
      try { if (typeof widget?._callback !== 'undefined') delete widget._callback; } catch (_) {}
      if (widget?._reading) {
        widget._reading = false;
      }
    } catch (_) {}
    try {
      if (typeof (screen as any).grabKeys === 'function') {
        try { (screen as any).grabKeys(false); } catch (_) { (screen as any).grabKeys = false; }
      } else {
        (screen as any).grabKeys = false;
      }
    } catch (_) {}
    try { if (typeof (screen as any).program?.hideCursor === 'function') (screen as any).program.hideCursor(); } catch (_) {}
  };

  const startReading = () => {
    try {
      if (!widget) return;
      if (widget.__listener && typeof widget.removeListener === 'function') {
        try { widget.removeListener('keypress', widget.__listener); } catch (_) {}
      }
      if (widget.__done && typeof widget.removeListener === 'function') {
        try { widget.removeListener('blur', widget.__done); } catch (_) {}
      }
      delete widget.__listener;
      delete widget.__done;
      delete widget._done;
      delete widget._callback;
      widget._reading = true;
      const value = widget.getValue ? widget.getValue() : '';
      setCursorIndex(value, cursorIndex);
      if (typeof (screen as any).program?.showCursor === 'function') {
        (screen as any).program.showCursor();
      }
      updateCursor();
    } catch (_) {}
  };

  const buildKeyHandler = () => {
    return (_ch: unknown, key: unknown) => {
      if (!widget) return;
      if ((screen as any).focused !== widget) return;
      const k = key as any | undefined;
      if (k?.name === 'tab') {
        return false;
      }
      if (k?.name === 'S-tab') {
        return false;
      }
      if (k?.name === 'left') {
        moveHorizontal(-1);
        return false;
      }
      if (k?.name === 'right') {
        moveHorizontal(1);
        return false;
      }
      if (k?.name === 'up') {
        moveVertical(-1);
        return false;
      }
      if (k?.name === 'down') {
        moveVertical(1);
        return false;
      }
      if (k?.name === 'backspace') {
        deleteBackward();
        return false;
      }
      if (k?.name === 'delete') {
        deleteForward();
        return false;
      }
      if (k?.name === 'enter' || k?.name === 'linefeed' || k?.name === 'return') {
        insertAtCursor('\n');
        return false;
      }
      const insertChar = typeof _ch === 'string' ? _ch : '';
      if (!insertChar) return;
      if (/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(insertChar)) return;
      insertAtCursor(insertChar);
      return false;
    };
  };

  return {
    getCursorIndex: () => cursorIndex,
    setCursorIndex: (value: string, nextIndex: number) => setCursorIndex(value, nextIndex),
    moveHorizontal,
    moveVertical,
    insertAtCursor,
    deleteBackward,
    deleteForward,
    attachUpdateCursorOverride,
    startReading,
    endReading,
    buildKeyHandler,
  };
}
