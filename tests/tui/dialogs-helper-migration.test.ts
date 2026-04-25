import { describe, it, expect, vi } from 'vitest';

const { createListSpy, createTextareaSpy, createLabelSpy } = vi.hoisted(() => ({
  createListSpy: vi.fn((blessed: any, opts: any) => blessed.list(opts)),
  createTextareaSpy: vi.fn((blessed: any, opts: any) => blessed.textarea(opts)),
  createLabelSpy: vi.fn((blessed: any, opts: any) => blessed.box(opts)),
}));

vi.mock('../../src/tui/components/dialog-helpers.js', () => ({
  createList: createListSpy,
  createTextarea: createTextareaSpy,
  createLabel: createLabelSpy,
}));

import { DialogsComponent } from '../../src/tui/components/dialogs.js';

function createMockWidget(overrides: Record<string, unknown> = {}): any {
  return {
    on: vi.fn(),
    key: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    setFront: vi.fn(),
    setContent: vi.fn(),
    setLabel: vi.fn(),
    setItems: vi.fn(),
    select: vi.fn(),
    destroy: vi.fn(),
    removeAllListeners: vi.fn(),
    hidden: true,
    style: {},
    items: [],
    ...overrides,
  };
}

function createMockBlessed(): any {
  return {
    box: vi.fn((opts?: any) => createMockWidget({ ...opts })),
    list: vi.fn((opts?: any) => createMockWidget({ ...opts, items: opts?.items ?? [] })),
    textarea: vi.fn((opts?: any) => createMockWidget({ ...opts, getValue: vi.fn(() => ''), setValue: vi.fn(), clearValue: vi.fn() })),
  };
}

describe('DialogsComponent helper migration', () => {
  it('uses shared dialog-helpers for lists, textareas and labels', () => {
    const blessed = createMockBlessed();
    const screen = createMockWidget({ width: 120, height: 40, on: vi.fn() });
    const overlays = {
      detailOverlay: {},
      closeOverlay: {},
      updateOverlay: {},
      createOverlay: {},
      hide: vi.fn(),
    } as any;

    new DialogsComponent({ parent: screen, blessed, overlays });

    expect(createListSpy).toHaveBeenCalled();
    expect(createTextareaSpy).toHaveBeenCalled();
    expect(createLabelSpy).toHaveBeenCalled();

    expect(createListSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(createTextareaSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(createLabelSpy.mock.calls.length).toBeGreaterThanOrEqual(7);
  });
});
