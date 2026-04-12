/**
 * Tests for the Ink-based TUI components.
 *
 * Uses ink-testing-library to render components in a virtual terminal and
 * verify their output without a real terminal session.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import type { WorkItem } from '../../../src/types.js';
import { WorkItemList } from '../../../src/tui/ink/WorkItemList.js';
import { DetailPane } from '../../../src/tui/ink/DetailPane.js';
import { MetadataPane } from '../../../src/tui/ink/MetadataPane.js';
import { StatusBar } from '../../../src/tui/ink/StatusBar.js';
import { HelpModal } from '../../../src/tui/ink/HelpModal.js';
import type { VisibleNode } from '../../../src/tui/state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'WL-TEST-001',
    title: 'Test work item',
    description: 'A test description',
    status: 'open',
    priority: 'medium',
    sortIndex: 0,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    assignee: '',
    stage: '',
    issueType: 'task',
    createdBy: '',
    deletedBy: '',
    deleteReason: '',
    risk: '',
    effort: '',
    ...overrides,
  };
}

function makeNode(item: WorkItem, depth = 0, hasChildren = false): VisibleNode {
  return { item, depth, hasChildren };
}

// ── WorkItemList ─────────────────────────────────────────────────────────────

describe('WorkItemList', () => {
  it('renders an empty list without crashing', () => {
    const { lastFrame } = render(
      React.createElement(WorkItemList, {
        nodes: [],
        selectedIndex: 0,
        isFocused: false,
        width: 60,
        height: 10,
      }),
    );
    const frame = lastFrame();
    expect(frame).toBeDefined();
    // Should still render the box
    expect(typeof frame).toBe('string');
  });

  it('renders work items with status symbols', () => {
    const items = [
      makeItem({ id: 'WL-1', title: 'Open item', status: 'open' }),
      makeItem({ id: 'WL-2', title: 'In progress item', status: 'in-progress' }),
      makeItem({ id: 'WL-3', title: 'Completed item', status: 'completed' }),
    ];
    const nodes = items.map(i => makeNode(i));

    const { lastFrame } = render(
      React.createElement(WorkItemList, {
        nodes,
        selectedIndex: 0,
        isFocused: true,
        width: 60,
        height: 15,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Open item');
    expect(frame).toContain('In progress item');
    expect(frame).toContain('Completed item');
  });

  it('renders the item count', () => {
    const nodes = [
      makeNode(makeItem({ id: 'WL-1', title: 'Item 1' })),
      makeNode(makeItem({ id: 'WL-2', title: 'Item 2' })),
    ];

    const { lastFrame } = render(
      React.createElement(WorkItemList, {
        nodes,
        selectedIndex: 0,
        isFocused: false,
        width: 60,
        height: 15,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 items');
  });

  it('indicates a move-source item with [M] marker', () => {
    const item = makeItem({ id: 'WL-MOVE', title: 'Being moved' });
    const nodes = [makeNode(item)];

    const { lastFrame } = render(
      React.createElement(WorkItemList, {
        nodes,
        selectedIndex: 0,
        isFocused: false,
        moveSourceId: 'WL-MOVE',
        width: 60,
        height: 10,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('[M]');
  });

  it('shows expand indicator for nodes with children', () => {
    const parentItem = makeItem({ id: 'WL-PARENT', title: 'Parent item' });
    const nodes = [makeNode(parentItem, 0, true)];

    const { lastFrame } = render(
      React.createElement(WorkItemList, {
        nodes,
        selectedIndex: 0,
        isFocused: false,
        width: 60,
        height: 10,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('▶');
  });
});

// ── DetailPane ───────────────────────────────────────────────────────────────

describe('DetailPane', () => {
  it('renders "No item selected" when item is null', () => {
    const { lastFrame } = render(
      React.createElement(DetailPane, {
        item: null,
        isFocused: false,
        width: 50,
        height: 15,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('No item selected');
  });

  it('renders the item title', () => {
    const item = makeItem({ title: 'My specific work item' });
    const { lastFrame } = render(
      React.createElement(DetailPane, {
        item,
        isFocused: false,
        width: 50,
        height: 15,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('My specific work item');
  });

  it('renders the item description', () => {
    const item = makeItem({ description: 'This is the description text' });
    const { lastFrame } = render(
      React.createElement(DetailPane, {
        item,
        isFocused: false,
        width: 50,
        height: 20,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('This is the description text');
  });
});

// ── MetadataPane ─────────────────────────────────────────────────────────────

describe('MetadataPane', () => {
  it('renders empty pane when item is null', () => {
    const { lastFrame } = render(
      React.createElement(MetadataPane, {
        item: null,
        isFocused: false,
        width: 35,
        height: 15,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Metadata');
  });

  it('renders item status', () => {
    const item = makeItem({ status: 'in-progress' });
    const { lastFrame } = render(
      React.createElement(MetadataPane, {
        item,
        isFocused: false,
        width: 40,
        height: 20,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('in-progress');
  });

  it('renders item priority', () => {
    const item = makeItem({ priority: 'high' });
    const { lastFrame } = render(
      React.createElement(MetadataPane, {
        item,
        isFocused: false,
        width: 40,
        height: 20,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('high');
  });

  it('renders item tags', () => {
    const item = makeItem({ tags: ['frontend', 'bug'] });
    const { lastFrame } = render(
      React.createElement(MetadataPane, {
        item,
        isFocused: false,
        width: 40,
        height: 20,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('frontend');
  });
});

// ── StatusBar ────────────────────────────────────────────────────────────────

describe('StatusBar', () => {
  it('renders keyboard hints when no message is present', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        focusPane: 'list',
        width: 80,
      }),
    );

    const frame = lastFrame() ?? '';
    // Should contain some navigation hints
    expect(frame).toContain('navigate');
  });

  it('renders a toast message when provided', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        focusPane: 'list',
        message: 'Item created successfully',
        messageType: 'success',
        width: 80,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Item created successfully');
  });

  it('renders detail pane hints when detail pane is focused', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        focusPane: 'detail',
        width: 80,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('scroll');
  });
});

// ── HelpModal ────────────────────────────────────────────────────────────────

describe('HelpModal', () => {
  it('renders keyboard shortcuts', () => {
    const { lastFrame } = render(
      React.createElement(HelpModal, {
        onClose: () => {},
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Keyboard Shortcuts');
    expect(frame).toContain('Move up');
    expect(frame).toContain('Quit');
  });

  it('includes help close instruction', () => {
    const { lastFrame } = render(
      React.createElement(HelpModal, {
        onClose: () => {},
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('close');
  });
});
