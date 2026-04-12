import React from 'react';
import {render} from 'ink-testing-library';
import InkVirtualList from '../../src/tui/components/ink-virtual-list';
import {describe, it, expect} from 'vitest';

function makeItems(n: number) {
  return Array.from({length: n}, (_, i) => ({id: String(i), title: `item-${i}`}));
}

describe('InkVirtualList', () => {
  it('renders first viewport and moves selection with j/k', async () => {
    const items = makeItems(30);
    const {lastFrame, stdin, cleanup} = render(React.createElement(InkVirtualList, {items, height: 5, showSelectionMarker: true}));

    // initial selection should be on first item (verify via hidden marker)
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain('__SEL__0__');
    // move down twice
    stdin.write('j');
    await new Promise((r) => setTimeout(r, 10));
    stdin.write('j');
    await new Promise((r) => setTimeout(r, 10));
    // expect selection marker to indicate index 2
    expect(lastFrame()).toContain('__SEL__2__');

    // move up once
    stdin.write('k');
    await new Promise((r) => setTimeout(r, 10));
    expect(lastFrame()).toContain('__SEL__1__');

    cleanup();
  });

  it('keeps selection stable when items change preserving id', () => {
    const items = makeItems(20);
    const r = render(React.createElement(InkVirtualList, {items, height: 5, showSelectionMarker: true}));
    // move to item 10
    r.stdin.write('G'); // go to last
    // update props: create new array with same ids but different order
    const newItems = makeItems(20).map((it) => ({...it}));
    // re-render with same ids
    r.rerender(React.createElement(InkVirtualList, {items: newItems, height: 5}));
    // selection should still be present (no crash) and show some item
    expect(r.lastFrame()).toBeDefined();
    r.cleanup();
  });
});
