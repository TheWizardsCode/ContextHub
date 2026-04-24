import { describe, it, expect, vi } from 'vitest';
import { createList, createTextarea, createLabel } from '../../src/tui/components/dialog-helpers.js';

const makeFactory = () => {
  return {
    list: (opts: any) => Object.assign({ __type: 'list' }, opts),
    textarea: (opts: any) => Object.assign({ __type: 'textarea' }, opts),
    box: (opts: any) => Object.assign({ __type: 'box' }, opts),
  } as any;
};

describe('dialog-helpers', () => {
  it('createList applies defaults and merges options', () => {
    const factory = makeFactory();
    const list: any = createList(factory as any, { items: ['a', 'b'], height: 4 });
    expect(list.__type).toBe('list');
    expect(list.items).toEqual(['a', 'b']);
    expect(list.keys).toBe(true);
    expect(list.mouse).toBe(true);
    expect(list.style.selected.bg).toBe('blue');
    expect(list.height).toBe(4);
  });

  it('createTextarea applies defaults and custom options', () => {
    const factory = makeFactory();
    const ta: any = createTextarea(factory as any, { label: 'desc', inputOnFocus: false });
    expect(ta.__type).toBe('textarea');
    expect(ta.label).toBe('desc');
    // defaults
    expect(ta.input).toBe(true);
    expect(ta.wrap).toBe(true);
    // overridden
    expect(ta.inputOnFocus).toBe(false);
    // style defaults exist
    expect(ta.style).toBeDefined();
  });

  it('createLabel applies defaults and merges opts', () => {
    const factory = makeFactory();
    const label: any = createLabel(factory as any, { content: 'Title', style: { fg: 'yellow' } });
    expect(label.__type).toBe('box');
    expect(label.height).toBe(1);
    // merged style should preserve fg override
    expect(label.style.fg).toBe('yellow');
    // preserved default bold if not overridden
    expect(label.style.bold).toBe(true);
    expect(label.content).toBe('Title');
  });
});
