import fs from 'fs';
import os from 'os';
import path from 'path';
import { TuiController } from '../dist/tui/controller.js';

// Minimal helpers copied/adapted from tests/test-utils to allow running
// the TUI headlessly without pulling the test harness.
function makeBox() {
  let _content = '';
  let _items = [];
  const obj = {
    hidden: true,
    width: 0,
    height: 0,
    selected: 0,
    childBase: 0,
  };
  obj.show = () => { obj.hidden = false; };
  obj.hide = () => { obj.hidden = true; };
  obj.focus = () => { screen.focused = obj; };
  obj.setFront = () => {};
  obj.setContent = (s) => { _content = String(s ?? ''); };
  obj.getContent = () => _content;
  obj.setScroll = (_n) => {};
  obj.setScrollPerc = (_n) => {};
  obj.pushLine = (_s) => {};
  obj.setItems = (next) => { _items = Array.isArray(next) ? next.slice() : []; };
  obj.select = (idx) => { obj.selected = idx; };
  obj.getItem = (idx) => { const v = _items[idx]; return v ? { getContent: () => v } : undefined; };
  obj.on = (_ev, _cb) => {};
  obj.key = (_keys, _cb) => {};
  obj.setLabel = (_s) => {};
  obj.clearValue = () => {};
  obj.setValue = (_v) => {};
  obj.destroy = () => {};
  obj.removeAllListeners = () => {};
  obj.removeListener = (_ev, _cb) => {};
  return obj;
}

// Simple screen that allows registering keypress handlers and
// exposing `emit('keypress', ch, key)` to simulate key events.
const rawKeyHandlers = [];
const keyBindings = [];

const screen = {
  height: 40,
  width: 100,
  focused: null,
  render: () => {},
  destroy: () => {},
  on: (ev, cb) => { if (ev === 'keypress') rawKeyHandlers.push(cb); },
  key: (keys, cb) => {
    const list = Array.isArray(keys) ? keys : [keys];
    const normalized = list.map(k => String(k).toLowerCase());
    keyBindings.push({ keys: normalized, handler: cb });
  },
  emit: (ev, ch, key) => {
    if (ev !== 'keypress') return;
    rawKeyHandlers.forEach(h => { try { h(ch, key); } catch (_) {} });
    const name = (key && key.name) ? String(key.name).toLowerCase() : String(ch || '').toLowerCase();
    keyBindings.forEach(({ keys, handler }) => {
      try { if (keys.includes(name)) handler(ch, key); } catch (_) {}
    });
  },
};

// Minimal blessed-compatible factory
const blessedImpl = {
  screen: (_opts) => screen,
  box: (_opts) => makeBox(),
  list: (_opts) => makeBox(),
  textarea: (_opts) => makeBox(),
  button: (_opts) => makeBox(),
  text: (_opts) => makeBox(),
};

function createLayout() {
  const make = () => makeBox();
  const layout = {
    screen,
    listComponent: { getList: (() => { const b = make(); return () => b; })(), getFooter: (() => { const b = make(); return () => b; })() },
    detailComponent: { getDetail: (() => { const b = make(); return () => b; })(), getCopyIdButton: (() => { const b = make(); return () => b; })() },
    toastComponent: { show: (m) => {}, showError: (m) => {} },
    overlaysComponent: { detailOverlay: make(), closeOverlay: make(), updateOverlay: make() },
    dialogsComponent: {
      detailModal: make(), detailClose: make(), closeDialog: make(), closeDialogText: make(), closeDialogOptions: make(),
      updateDialog: make(), updateDialogText: make(), updateDialogOptions: make(), updateDialogStageOptions: make(), updateDialogStatusOptions: make(), updateDialogPriorityOptions: make(), updateDialogComment: make(),
    },
    helpMenu: { isVisible: () => false, show: () => {}, hide: () => {} },
    modalDialogs: { selectList: async () => 0, editTextarea: async () => null, confirmTextbox: async () => false, forceCleanup: () => {} },
    opencodeUi: { serverStatusBox: make(), dialog: make(), textarea: make(), suggestionHint: make(), sendButton: make(), cancelButton: make(), ensureResponsePane: () => make() },
    nextDialog: { overlay: make(), dialog: make(), close: make(), text: make(), options: make() },
  };
  return layout;
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-bench-'));
  // Build a simple in-memory DB with 30 items forming a small tree.
  let nextId = 1;
  const items = new Map();
  function createSampleItem(overrides = {}) {
    const id = `WL-BENCH-${nextId++}`;
    const now = new Date().toISOString();
    const item = Object.assign({
      id,
      title: `Item ${id}`,
      description: '',
      status: 'open',
      priority: 'medium',
      sortIndex: 0,
      parentId: null,
      createdAt: now,
      updatedAt: now,
      tags: [],
      assignee: '',
      stage: '',
      issueType: 'task',
      createdBy: '',
      deletedBy: '',
      deleteReason: '',
      risk: '',
      effort: '',
      needsProducerReview: false,
    }, overrides);
    items.set(id, item);
    return id;
  }

  // Create a root with several children to ensure toggle is non-noop
  const root = createSampleItem({ title: 'Root' });
  for (let i = 0; i < 29; i++) {
    createSampleItem({ parentId: root, title: `Child ${i + 1}` });
  }

  const utils = {
    requireInitialized: () => {},
    getDatabase: () => ({
      list: () => Array.from(items.values()),
      getPrefix: () => undefined,
      getCommentsForWorkItem: () => [],
      update: (id, updates) => {
        const cur = items.get(id);
        if (!cur) return false;
        const next = Object.assign({}, cur, updates);
        items.set(id, next);
        return next;
      },
      createComment: (_) => ({}),
      get: (id) => items.get(id),
    }),
    createSampleItem: (o) => createSampleItem(o),
    db: null,
  };
  utils.db = utils.getDatabase();

  const layout = createLayout();

  const controller = new TuiController({ program: { opts: () => ({ verbose: false }) }, utils, blessed: blessedImpl, createLayout: () => layout }, {
    blessed: blessedImpl,
    createLayout: () => layout,
    resolveWorklogDir: () => tmp,
    createPersistence: () => ({ loadPersistedState: async () => null, savePersistedState: async () => undefined, statePath: path.join(tmp, 'tui-state.json') }),
    fs: fs,
  });

  // Start the controller with perf enabled
  await controller.start({ perf: true });

  // Repeatedly toggle expand/collapse on the selected item
  const ITERATIONS = 60;
  for (let i = 0; i < ITERATIONS; i++) {
    // Emit space (toggle)
    screen.emit('keypress', ' ', { name: 'space' });
    // Allow event loop to process
    await new Promise(r => setTimeout(r, 0));
  }

  // Quit to trigger shutdown and perf write
  screen.emit('keypress', 'q', { name: 'q' });

  // Wait a tick for async write to complete
  await new Promise(r => setTimeout(r, 50));

  const perfPath = path.join(tmp, 'tui-performance.json');
  if (!fs.existsSync(perfPath)) {
    console.error('FAIL: perf file not found:', perfPath);
    process.exitCode = 2;
    return;
  }

  const raw = await fs.promises.readFile(perfPath, 'utf8');
  let parsed = [];
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('FAIL: could not parse perf file:', err);
    process.exitCode = 2;
    return;
  }

  const expandEvents = parsed.filter(e => e && (e.event === 'expand_toggle' || e.event === 'expand_toggle_noop'));
  if (expandEvents.length === 0) {
    console.error('FAIL: no expand_toggle events recorded');
    process.exitCode = 2;
    return;
  }

  // Check threshold 200 ms
  const thresholdMs = 200;
  const bad = expandEvents.filter(e => Number(e.duration) > thresholdMs);
  if (bad.length > 0) {
    for (const b of bad) {
      console.error(`FAIL: expand_toggle exceeded ${thresholdMs} ms: ${b.duration.toFixed ? b.duration.toFixed(2) : b.duration} ms`);
      // Print a compact stack trace placeholder — controller records no stack,
      // so provide a minimal callsite trace for context.
      console.error(new Error('Slow operation').stack.split('\n').slice(0, 5).join('\n'));
    }
    process.exitCode = 1;
    return;
  }

  console.log('PASS');
  process.exitCode = 0;
}

// Run when executed directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('tui-expand.js')) {
  run().catch(err => { console.error('ERROR', err); process.exitCode = 2; });
}
