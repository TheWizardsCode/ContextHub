import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { TuiController } from '../../src/tui/controller.js';

// Minimal test doubles for widgets
const makeBox = (opts: any = {}) => {
  const emitter = new EventEmitter() as any;
  return {
    ...opts,
    hidden: true,
    width: 0,
    height: 0,
    style: { border: {}, label: {}, selected: {}, focus: { border: {} } },
    show: vi.fn(() => { /* no-op */ }),
    hide: vi.fn(() => { /* no-op */ }),
    focus: vi.fn(),
    setFront: vi.fn(),
    setContent: vi.fn(),
    getContent: vi.fn(() => ''),
    setLabel: vi.fn(),
    setItems: vi.fn(),
    select: vi.fn(),
    getItem: vi.fn(() => undefined),
    on: (...args: any[]) => emitter.on(...args),
    key: vi.fn(),
    setScroll: vi.fn(),
    setScrollPerc: vi.fn(),
    getScroll: vi.fn(() => 0),
    pushLine: vi.fn(),
    clearValue: vi.fn(),
    setValue: vi.fn(),
    getValue: vi.fn(() => ''),
    moveCursor: vi.fn(),
    emit: (...args: any[]) => emitter.emit(...args),
    destroy: vi.fn(),
  } as any;
};

const makeTextarea = () => {
  const textarea = makeBox();
  (textarea as any)._updateCursor = vi.fn();
  return textarea as any;
};

const makeList = (items: string[] = []) => {
  const box = makeBox() as any;
  let _items = items.slice();
  let selected = 0;
  box.setItems = vi.fn((next: string[]) => {
    _items = next.slice();
    box.items = _items.map(value => ({ getContent: () => value }));
  });
  box.select = vi.fn((idx: number) => { selected = idx; box.selected = selected; });
  Object.defineProperty(box, 'selected', {
    get: () => selected,
    set: (v: number) => { selected = v; box._sel = v; },
  });
  box.getItem = vi.fn((idx: number) => {
    const value = _items[idx];
    return value ? { getContent: () => value } : undefined;
  });
  box.items = _items.map(v => ({ getContent: () => v }));
  return box;
};

const makeScreen = () => {
  const screen = new EventEmitter() as any;
  screen.height = 40;
  screen.width = 120;
  screen.focused = null;
  screen.render = vi.fn();
  screen.destroy = vi.fn();
  screen.key = (keys: any, cb: any) => { screen._keyHandlers = screen._keyHandlers || []; screen._keyHandlers.push({ keys, cb }); };
  return screen;
};

describe('Next dialog View selects item (controller-level)', () => {
  it('selects recommended item on keyboard View action', async () => {
    const screen = makeScreen();
    const list = makeList();
    const nextOptions = makeList(['View', 'Next recommendation', 'Close']);

    // Minimal ctx and deps
    const ctx: any = {
      program: { opts: () => ({ verbose: false }) },
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [
            { id: 'WL-A', title: 'A', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' },
            { id: 'WL-B', title: 'B', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' },
          ],
          get: () => null,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          getPrefix: () => undefined,
        }))
      },
      toast: { show: () => {} },
    };

    // createLayout returns our controlled layout
    const createLayout = () => ({
      screen,
      listComponent: { getList: () => list, getFooter: () => makeBox() },
      detailComponent: { getDetail: () => makeBox(), getCopyIdButton: () => makeBox() },
      metadataPaneComponent: { updateFromItem: vi.fn() },
      toastComponent: { show: vi.fn() },
      emptyStateComponent: makeBox(),
      overlaysComponent: { detailOverlay: makeBox(), closeOverlay: makeBox(), updateOverlay: makeBox(), createOverlay: makeBox() },
      dialogsComponent: {
        detailModal: makeBox(),
        detailClose: makeBox(),
        closeDialog: makeBox(),
        closeDialogText: makeBox(),
        closeDialogOptions: makeList(),
        updateDialog: makeBox(),
        updateDialogText: makeBox(),
        updateDialogOptions: makeList(),
        updateDialogStageOptions: makeList(),
        updateDialogStatusOptions: makeList(),
        updateDialogPriorityOptions: makeList(),
        updateDialogComment: makeBox(),
        createDialog: makeBox(),
        createDialogText: makeBox(),
        createDialogTitleInput: makeTextarea(),
        createDialogDescription: makeTextarea(),
        createDialogIssueTypeOptions: makeList(),
        createDialogPriorityOptions: makeList(),
        createDialogCreateButton: makeBox(),
        createDialogCancelButton: makeBox(),
      },
      helpMenu: { isVisible: () => false, show: () => {}, hide: () => {} },
      modalDialogs: {
        selectList: vi.fn(async () => 0),
        editTextarea: vi.fn(async () => null),
        confirmYesNo: vi.fn(async () => true),
        forceCleanup: vi.fn(),
      },
      agentPane: { serverStatusBox: makeBox(), dialog: makeBox(), textarea: makeBox(), suggestionHint: makeBox(), sendButton: makeBox(), cancelButton: makeBox(), ensureResponsePane: () => makeBox() },
      nextDialog: { overlay: makeBox(), dialog: makeBox(), close: makeBox(), text: makeBox(), options: nextOptions },
    });

    // spawnImpl to emulate 'wl next' returning WL-B recommendation
    const spawnImpl = (_cmd: string, _args: string[], _opts: any) => {
      const proc: any = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.on = (ev: string, cb: any) => { proc.addListener(ev, cb); };
      const payload = JSON.stringify({ success: true, results: [{ workItem: { id: 'WL-B', title: 'B', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' }, reason: 'recommended' }] });
      // emit data and close
      setTimeout(() => { proc.stdout.emit('data', Buffer.from(payload)); proc.emit('close', 0); }, 10);
      return proc as unknown as ChildProcess;
    };

    const controller = new TuiController(ctx as any, { createLayout, spawn: spawnImpl });
    await controller.start({});

    // Find the handler for 'n' on our screen
    const handler = (screen as any)._keyHandlers.find((h: any) => {
      const ks = Array.isArray(h.keys) ? h.keys : [h.keys];
      return ks.includes('n');
    });
    expect(handler).toBeTruthy();

    // Open next dialog (invokes runNextWorkItems)
    await handler.cb();
    // allow spawn to emit
    await new Promise(r => setTimeout(r, 30));

    // Spy on list.select before simulating View activation
    list.select = vi.fn(list.select.bind(list));

    // Simulate the user selecting View
    nextOptions.emit('select', null, 0);

    // Expect the list.select to have been called with the index of WL-B
    const idx = (list.items || []).map((it: any) => (typeof it === 'string' ? it : (it.getContent ? it.getContent() : String(it)))).findIndex((s: string) => s.includes('WL-B'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(list.select).toHaveBeenCalledWith(idx);
  });

  it('selects recommended item on mouse click View action', async () => {
    const screen = makeScreen();
    const list = makeList();
    const nextOptions = makeList(['View', 'Next recommendation', 'Close']);

    const ctx: any = {
      program: { opts: () => ({ verbose: false }) },
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [
            { id: 'WL-A', title: 'A', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' },
            { id: 'WL-C', title: 'C', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' },
          ],
          get: () => null,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          getPrefix: () => undefined,
        }))
      },
      toast: { show: () => {} },
    };

    const createLayout = () => ({
      screen,
      listComponent: { getList: () => list, getFooter: () => makeBox() },
      detailComponent: { getDetail: () => makeBox(), getCopyIdButton: () => makeBox() },
      metadataPaneComponent: { updateFromItem: vi.fn() },
      toastComponent: { show: vi.fn() },
      emptyStateComponent: makeBox(),
      overlaysComponent: { detailOverlay: makeBox(), closeOverlay: makeBox(), updateOverlay: makeBox(), createOverlay: makeBox() },
      dialogsComponent: {
        detailModal: makeBox(),
        detailClose: makeBox(),
        closeDialog: makeBox(),
        closeDialogText: makeBox(),
        closeDialogOptions: makeList(),
        updateDialog: makeBox(),
        updateDialogText: makeBox(),
        updateDialogOptions: makeList(),
        updateDialogStageOptions: makeList(),
        updateDialogStatusOptions: makeList(),
        updateDialogPriorityOptions: makeList(),
        updateDialogComment: makeBox(),
        createDialog: makeBox(),
        createDialogText: makeBox(),
        createDialogTitleInput: makeTextarea(),
        createDialogDescription: makeTextarea(),
        createDialogIssueTypeOptions: makeList(),
        createDialogPriorityOptions: makeList(),
        createDialogCreateButton: makeBox(),
        createDialogCancelButton: makeBox(),
      },
      helpMenu: { isVisible: () => false, show: () => {}, hide: () => {} },
      modalDialogs: {
        selectList: vi.fn(async () => 0),
        editTextarea: vi.fn(async () => null),
        confirmYesNo: vi.fn(async () => true),
        forceCleanup: vi.fn(),
      },
      agentPane: { serverStatusBox: makeBox(), dialog: makeBox(), textarea: makeBox(), suggestionHint: makeBox(), sendButton: makeBox(), cancelButton: makeBox(), ensureResponsePane: () => makeBox() },
      nextDialog: { overlay: makeBox(), dialog: makeBox(), close: makeBox(), text: makeBox(), options: nextOptions },
    });

    const spawnImpl = (_cmd: string, _args: string[], _opts: any) => {
      const proc: any = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.on = (ev: string, cb: any) => { proc.addListener(ev, cb); };
      const payload = JSON.stringify({ success: true, results: [{ workItem: { id: 'WL-C', title: 'C', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' }, reason: 'recommended' }] });
      setTimeout(() => { proc.stdout.emit('data', Buffer.from(payload)); proc.emit('close', 0); }, 10);
      return proc as unknown as ChildProcess;
    };

    const controller = new TuiController(ctx as any, { createLayout, spawn: spawnImpl });
    await controller.start({});

    const handler = (screen as any)._keyHandlers.find((h: any) => {
      const ks = Array.isArray(h.keys) ? h.keys : [h.keys];
      return ks.includes('n');
    });
    expect(handler).toBeTruthy();

    await handler.cb();
    await new Promise(r => setTimeout(r, 30));

    list.select = vi.fn(list.select.bind(list));
    // Simulate click
    nextOptions.emit('click');

    const idx = (list.items || []).map((it: any) => (typeof it === 'string' ? it : (it.getContent ? it.getContent() : String(it)))).findIndex((s: string) => s.includes('WL-C'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(list.select).toHaveBeenCalledWith(idx);
  });

  it('selects recommended item when another item was selected before opening Next dialog', async () => {
    const screen = makeScreen();
    const list = makeList();
    const nextOptions = makeList(['View', 'Next recommendation', 'Close']);

    const ctx: any = {
      program: { opts: () => ({ verbose: false }) },
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [
            { id: 'WL-A', title: 'A', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' },
            { id: 'WL-B', title: 'B', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' },
            { id: 'WL-C', title: 'C', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' },
          ],
          get: () => null,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          getPrefix: () => undefined,
        }))
      },
      toast: { show: () => {} },
    };

    const createLayout = () => ({
      screen,
      listComponent: { getList: () => list, getFooter: () => makeBox() },
      detailComponent: { getDetail: () => makeBox(), getCopyIdButton: () => makeBox() },
      metadataPaneComponent: { updateFromItem: vi.fn() },
      toastComponent: { show: vi.fn() },
      emptyStateComponent: makeBox(),
      overlaysComponent: { detailOverlay: makeBox(), closeOverlay: makeBox(), updateOverlay: makeBox(), createOverlay: makeBox() },
      dialogsComponent: {
        detailModal: makeBox(),
        detailClose: makeBox(),
        closeDialog: makeBox(),
        closeDialogText: makeBox(),
        closeDialogOptions: makeList(),
        updateDialog: makeBox(),
        updateDialogText: makeBox(),
        updateDialogOptions: makeList(),
        updateDialogStageOptions: makeList(),
        updateDialogStatusOptions: makeList(),
        updateDialogPriorityOptions: makeList(),
        updateDialogComment: makeBox(),
        createDialog: makeBox(),
        createDialogText: makeBox(),
        createDialogTitleInput: makeTextarea(),
        createDialogDescription: makeTextarea(),
        createDialogIssueTypeOptions: makeList(),
        createDialogPriorityOptions: makeList(),
        createDialogCreateButton: makeBox(),
        createDialogCancelButton: makeBox(),
      },
      helpMenu: { isVisible: () => false, show: () => {}, hide: () => {} },
      modalDialogs: {
        selectList: vi.fn(async () => 0),
        editTextarea: vi.fn(async () => null),
        confirmYesNo: vi.fn(async () => true),
        forceCleanup: vi.fn(),
      },
      agentPane: { serverStatusBox: makeBox(), dialog: makeBox(), textarea: makeBox(), suggestionHint: makeBox(), sendButton: makeBox(), cancelButton: makeBox(), ensureResponsePane: () => makeBox() },
      nextDialog: { overlay: makeBox(), dialog: makeBox(), close: makeBox(), text: makeBox(), options: nextOptions },
    });

    const spawnImpl = (_cmd: string, _args: string[], _opts: any) => {
      const proc: any = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.on = (ev: string, cb: any) => { proc.addListener(ev, cb); };
      const payload = JSON.stringify({ success: true, results: [{ workItem: { id: 'WL-C', title: 'C', status: 'open', priority: 'medium', parentId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [], assignee: '', stage: 'idea', issueType: 'task' }, reason: 'recommended' }] });
      setTimeout(() => { proc.stdout.emit('data', Buffer.from(payload)); proc.emit('close', 0); }, 10);
      return proc as unknown as ChildProcess;
    };

    const controller = new TuiController(ctx as any, { createLayout, spawn: spawnImpl });
    await controller.start({});

    // Simulate user selecting WL-A then WL-B via arrow keys
    // We trigger the list 'select item' handler to emulate list.select()
    list.select(1);
    if (typeof (list.emit) === 'function') list.emit('select item', null, 1);

    // Now open Next dialog
    const handler = (screen as any)._keyHandlers.find((h: any) => {
      const ks = Array.isArray(h.keys) ? h.keys : [h.keys];
      return ks.includes('n');
    });
    expect(handler).toBeTruthy();
    await handler.cb();
    await new Promise(r => setTimeout(r, 30));

    // Spy and trigger View
    list.select = vi.fn(list.select.bind(list));
    nextOptions.emit('select', null, 0);

    const idx = (list.items || []).map((it: any) => (typeof it === 'string' ? it : (it.getContent ? it.getContent() : String(it)))).findIndex((s: string) => s.includes('WL-C'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(list.select).toHaveBeenCalledWith(idx);
  });

});