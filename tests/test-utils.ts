/**
 * Test utilities and helpers
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe as vitestDescribe, it as vitestIt } from 'vitest';

/**
 * Resolve the `tsx` CLI binary path.
 *
 * Worktrees have an empty local `node_modules` (deps resolve upward to the
 * main checkout), so a plain `<repoRoot>/node_modules/.bin/tsx` path breaks
 * for tests that spawn tsx as a subprocess from a worktree. Walk up parent
 * directories until a real `node_modules/.bin/tsx` is found.
 */
export function resolveTsxBin(fromDir: string): string {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`tsx binary not found walking up from ${fromDir}`);
    }
    dir = parent;
  }
}

/**
 * Create a temporary directory for test files
 */
export function createTempDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-test-'));
  return tmpDir;
}

/**
 * Clean up a temporary directory.
 * On Windows, SQLite may hold file locks briefly after the connection
 * object goes out of scope; retry a few times to handle EPERM.
 */
export function cleanupTempDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const maxRetries = process.platform === 'win32' ? 5 : 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (attempt < maxRetries && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        // brief spin-wait to let the OS release the file lock
        const delay = 200 * (attempt + 1);
        const until = Date.now() + delay;
        while (Date.now() < until) { /* wait */ }
        continue;
      }
      throw err;
    }
  }
}

/**
 * Create a temporary JSONL file path in a temp directory
 */
export function createTempJsonlPath(dir: string): string {
  return path.join(dir, 'test-data.jsonl');
}

/**
 * Create a temporary database path in a temp directory
 */
export function createTempDbPath(dir: string): string {
  return path.join(dir, 'test.db');
}

/**
 * Wait for a specified number of milliseconds
 */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a minimal TUI test context used by a few TUI-focused tests.
 * This provides a lightweight in-memory database, toast collector, and a
 * `createLayout` factory so tests can instantiate `TuiController` without
 * depending on the real terminal environment.
 */

/**
 * TuiController test API
 *
 * TuiController exposes a minimal test-only API on controller._test with the
 * following helpers which are intended for tests and internal use only:
 *
 * - openCreateDialog()
 * - closeCreateDialog()
 * - submitCreateDialog()
 * - openUpdateDialog()
 * - closeUpdateDialog()
 * - submitUpdateDialog()
 *
 * These are thin wrappers around the controller's internal dialog helpers
 * and provide a stable surface so tests do not need to inspect or modify
 * private widget internals (for example, `__agent_*` properties).
 *
 * Example usage:
 *   const controller = new TuiController(ctx, { blessed: ctx.blessed });
 *   await controller.start({});
 *   (controller as any)._test.openCreateDialog();
 *   (controller as any)._test.submitCreateDialog();
 */
export function createTuiTestContext(options?: { prefix?: string }) {
  let nextId = 1;
  const items = new Map<string, any>();
  const testPrefix = options?.prefix ?? undefined;

  const utils = {
    createSampleItem: ({ tags = [] } = {}) => {
      const id = `WL-TEST-${nextId++}`;
      const now = new Date().toISOString();
    const item = {
      id,
      title: 'Sample',
      description: '',
      status: 'open',
      priority: 'medium',
      sortIndex: 0,
      parentId: null,
      createdAt: now,
      updatedAt: now,
      tags,
      assignee: '',
      stage: '',
      issueType: 'task',
      createdBy: '',
      deletedBy: '',
      deleteReason: '',
      risk: '',
      effort: '',
      needsProducerReview: false,
    };
      items.set(id, item);
      return id;
    },
    db: {
      get: (id: string) => items.get(id),
      update: (id: string, updates: any) => {
        const cur = items.get(id);
        if (!cur) return false;
        const next = Object.assign({}, cur, updates);
        items.set(id, next);
        return next;
      },
    },
    requireInitialized: () => {},
    getDatabase: (prefix?: string) => ({
      list: (query?: any) => Array.from(items.values()),
      getPrefix: () => testPrefix,
      getCommentsForWorkItem: (id: string) => [],
      getAuditResult: (id: string) => null,
      update: (id: string, updates: any) => {
        const cur = items.get(id);
        if (!cur) return false;
        const next = Object.assign({}, cur, updates);
        items.set(id, next);
        return next;
      },
      createComment: (_: any) => ({}),
      get: (id: string) => items.get(id),
    }),
  } as any;

  const toast = {
    _last: '',
    _lastIsError: false,
    show: (m: string) => { toast._last = m; toast._lastIsError = false; },
    showError: (m: string) => { toast._last = m; toast._lastIsError = true; },
    lastMessage: () => toast._last,
    lastIsError: () => toast._lastIsError,
  } as any;

  // Mock WlDbAdapter that returns test data from the in-memory items store
  const createMockWlDbAdapter = () => ({
    list: (query?: Record<string, unknown>) => {
      let allItems = Array.from(items.values());
      // Apply status filter if present
      if (query?.status) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status];
        allItems = allItems.filter(item => statuses.includes(item.status));
      }
      // Apply stage filter if present (supports non-closed stage filtering)
      if (query?.stage) {
        const stages = Array.isArray(query.stage) ? query.stage : [query.stage];
        allItems = allItems.filter(item => {
          if (!item.stage) return true; // items without stage match
          if (stages.length === 1 && stages[0] === 'non-closed') {
            return item.stage !== 'done' && item.stage !== 'closed';
          }
          return stages.includes(item.stage);
        });
      }
      // Apply needsProducerReview filter if present
      if (query?.needsProducerReview) {
        allItems = allItems.filter(item => item.needsProducerReview === true);
      }
      // Apply assignee filter (supports @github-copilot)
      if (query?.assignee) {
        const assignee = String(query.assignee).toLowerCase();
        allItems = allItems.filter(item => {
          const itemAssignee = (item.assignee || '').toLowerCase();
          return itemAssignee.includes(assignee);
        });
      }
      return allItems;
    },
    get: (id: string) => items.get(id) ?? null,
    create: (item: Record<string, unknown>) => {
      const id = `WL-TEST-${nextId++}`;
      const now = new Date().toISOString();
      const newItem = {
        id,
        title: String(item.title ?? 'Untitled'),
        description: String(item.description ?? ''),
        status: 'open',
        priority: String(item.priority ?? 'medium'),
        sortIndex: 0,
        parentId: null,
        createdAt: now,
        updatedAt: now,
        tags: item.tags ? (Array.isArray(item.tags) ? item.tags : []) : [],
        assignee: String(item.assignee ?? ''),
        stage: 'idea',
        issueType: String(item.issueType ?? 'task'),
        createdBy: String(item.createdBy ?? ''),
        deletedBy: '',
        deleteReason: '',
        risk: String(item.risk ?? ''),
        effort: String(item.effort ?? ''),
        needsProducerReview: Boolean(item.needsProducerReview ?? false),
        doNotDelegate: Boolean(item.doNotDelegate ?? false),
      };
      items.set(id, newItem);
      return newItem;
    },
    update: (id: string, updates: Record<string, unknown>) => {
      const cur = items.get(id);
      if (!cur) return null;
      const next = Object.assign({}, cur, updates);
      items.set(id, next);
      return next;
    },
    getPrefix: () => testPrefix,
    getCommentsForWorkItem: (id: string) => {
      const comments = Array.from(items.values())
        .filter(i => i._isComment && i.workItemId === id)
        .map(i => ({
          id: i.id,
          workItemId: i.workItemId,
          author: i.author ?? '',
          comment: i.comment ?? '',
          createdAt: i.createdAt ?? '',
          references: i.references ?? [],
        }));
      return comments;
    },
    getAuditResult: (_id: string) => null,
    createComment: (params: { workItemId: string; comment: string; author: string }) => {
      const id = `WL-TEST-COMMENT-${nextId++}`;
      const now = new Date().toISOString();
      const comment = {
        id,
        workItemId: params.workItemId,
        author: params.author ?? '',
        comment: params.comment ?? '',
        createdAt: now,
        references: [],
        _isComment: true,
      };
      items.set(id, comment);
      return comment;
    },
    getAll: () => Array.from(items.values()),
    getAllComments: () => Array.from(items.values()).filter(i => i._isComment),
    getChildren: (parentId: string) => Array.from(items.values()).filter(i => i.parentId === parentId),
    upsertItems: (_: any[]) => {},
  });

  // Minimal box/screen factories used by the layout mocks
  const makeBox = () => {
    let _content = '';
    let _items: string[] = [];
    const obj: any = {
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
    obj.setContent = (s: string) => { _content = s; };
    obj.getContent = () => _content;
    obj.setScroll = (_n: number) => {};
    obj.setScrollPerc = (_n: number) => {};
    obj.pushLine = (_s: string) => {};
    obj.setItems = (next: string[]) => { _items = next.slice(); obj.items = _items.map(v => ({ getContent: () => v })); };
    obj.select = (idx: number) => { obj.selected = idx; };
    obj.getItem = (idx: number) => { const v = (obj.items && obj.items[idx]); return v ? v : undefined; };
    // Initialize items property to match blessed List API shape
    obj.items = [];
    obj.on = (_ev: string, _cb?: any) => {};
    obj.key = (_keys: any, _cb?: any) => {};
    obj.setLabel = (_s: string) => {};
    obj.clearValue = () => {};
    obj.setValue = (_v: string) => {};
    obj.destroy = () => {};
    obj.removeAllListeners = () => {};
    obj.removeListener = (_ev: string, _cb?: any) => {};
    return obj as any;
  };

  // Simple screen that allows registering keypress handlers and
  // exposing `emit('keypress', ch, key)` to simulate key events.
  const rawKeyHandlers: Array<(...args: any[]) => void> = [];
  const keyBindings: Array<{ keys: string[]; handler: (...args: any[]) => void }> = [];

  const screen: any = {
    height: 40,
    width: 100,
    focused: null,
    render: () => {},
    destroy: () => {},
    // raw keypress listeners
    on: (ev: string, cb: (...args: any[]) => void) => { if (ev === 'keypress') rawKeyHandlers.push(cb); },
    // register a key binding (blessed semantics expect this)
    key: (keys: any, cb: (...args: any[]) => void) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const normalized = list.map((k: any) => String(k).toLowerCase());
      keyBindings.push({ keys: normalized, handler: cb });
    },
    // emit a raw keypress: invoke raw handlers and matching key bindings
    emit: (ev: string, ch: any, key: any) => {
      if (ev !== 'keypress') return;
      // call raw listeners
      rawKeyHandlers.forEach(h => { try { h(ch, key); } catch (_) {} });
      // call bindings that match the key name (case-insensitive)
      const name = (key && key.name) ? String(key.name).toLowerCase() : String(key || '').toLowerCase();
      keyBindings.forEach(({ keys, handler }) => {
        try {
          if (keys.includes(name)) handler(ch, key);
        } catch (_) {}
      });
    },
  };

  // Minimal blessed-compatible factory used by createLayout
  const blessedImpl: any = {
    screen: (_opts?: any) => screen,
    box: (_opts?: any) => makeBox(),
    list: (_opts?: any) => makeBox(),
    textarea: (_opts?: any) => makeBox(),
    button: (_opts?: any) => makeBox(),
    text: (_opts?: any) => makeBox(),
  };

  const layout = {
    screen,
    // Use consistent instances so focus/selected are shared
    listComponent: { getList: (() => { const b = makeBox(); return () => b; })(), getFooter: (() => { const b = makeBox(); return () => b; })() },
    detailComponent: { getDetail: (() => { const b = makeBox(); return () => b; })(), getCopyIdButton: (() => { const b = makeBox(); return () => b; })() },
    toastComponent: { show: (m: string) => toast.show(m), showError: (m: string) => toast.showError(m) },
    overlaysComponent: { detailOverlay: makeBox(), closeOverlay: makeBox(), updateOverlay: makeBox(), createOverlay: makeBox() },
    dialogsComponent: {
      detailModal: makeBox(), detailClose: makeBox(), closeDialog: makeBox(), closeDialogText: makeBox(), closeDialogOptions: makeBox(),
      updateDialog: makeBox(), updateDialogText: makeBox(), updateDialogOptions: makeBox(), updateDialogStageOptions: makeBox(), updateDialogStatusOptions: makeBox(), updateDialogPriorityOptions: makeBox(), updateDialogComment: makeBox(),
      createDialog: makeBox(), createDialogText: makeBox(), createDialogTitleInput: makeBox(), createDialogDescription: makeBox(), createDialogIssueTypeOptions: makeBox(), createDialogPriorityOptions: makeBox(), createDialogCreateButton: makeBox(), createDialogCancelButton: makeBox(),
    },
    helpMenu: { isVisible: () => false, show: () => {}, hide: () => {} },
    modalDialogs: { selectList: async () => 0, editTextarea: async () => null, confirmTextbox: async () => false, forceCleanup: () => {} },
    agentPane: { serverStatusBox: makeBox(), dialog: makeBox(), textarea: makeBox(), suggestionHint: makeBox(), sendButton: makeBox(), cancelButton: makeBox(), ensureResponsePane: () => makeBox() },
    nextDialog: { overlay: makeBox(), dialog: makeBox(), close: makeBox(), text: makeBox(), options: makeBox() },
  };

  const program = { opts: () => ({ verbose: false, format: undefined, json: false }) } as any;

  // Minimal command registry so CLI command modules can register commands
  // and tests can invoke them via `ctx.runCli([...])`.
  program._commands = new Map();
  program.command = (spec: string) => {
    const name = String(spec).split(' ')[0];
    const builder: any = {
      description: (_d: string) => builder,
      option: (_opt: string, _desc?: string) => builder,
      action: (fn: (...args: any[]) => any) => {
        program._commands.set(name, fn);
        return builder;
      }
    };
    return builder;
  };

  // Simple runner that invokes a registered command handler with a
  // parsed `options` object. Supports long-form flags like
  // `--do-not-delegate true` and converts kebab-case to camelCase to
  // match commander behaviour in the real code.
  function kebabToCamel(s: string) {
    return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  async function runCli(args: string[]): Promise<any> {
    const cmd = args[0];
    const id = args[1];
    let value: string | undefined;
    const rest: string[] = [];
    if (args.length > 2) {
      const maybeValue = args[2];
      if (maybeValue && !String(maybeValue).startsWith('-')) {
        value = maybeValue;
        rest.push(...args.slice(3));
      } else {
        rest.push(...args.slice(2));
      }
    }
    const handler = program._commands.get(cmd);
    if (!handler) throw new Error(`Command not registered: ${cmd}`);
    const options: Record<string, any> = {};
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (!token) continue;
      if (token.startsWith('--')) {
        const key = kebabToCamel(token.replace(/^--+/, ''));
        const next = rest[i + 1];
        if (next !== undefined && !String(next).startsWith('-')) {
          options[key] = next;
          i++;
        } else {
          options[key] = true;
        }
      } else if (token.startsWith('-')) {
        // ignore short flags for tests (not needed currently)
      }
    }

    if (value !== undefined) {
      return await Promise.resolve(handler(id, value, options));
    }
    return await Promise.resolve(handler(id, options));
  }

  // Expose a tiny CLI test context built on top of the TUI helpers so
  // tests that register commands can run them in-process.
  return {
    program,
    utils: Object.assign({}, utils, {
      // Commander-like helpers used by CLI commands under test
      normalizeCliId: (id: string, _prefix?: string) => id,
      getConfig: () => ({}),
      isJsonMode: () => false,
      // Expose the small in-memory db implementation (get + update)
      db: utils.db,
    }),
    toast,
    blessed: blessedImpl,
    screen,
    createLayout: () => layout,
    createWlDbAdapter: createMockWlDbAdapter,
    runCli,
  } as any;
}

// Back-compat alias for CLI command tests.
export const createTestContext = createTuiTestContext;

// Helper to gate long-running tests. Set WL_RUN_LONG_TESTS=true to enable.
export const RUN_LONG = process.env.WL_RUN_LONG_TESTS === 'true';

/**
 * Describe wrapper for long-running tests. Skips the suite unless
 * WL_RUN_LONG_TESTS=true in the environment.
 */
export function describeLong(name: string, fn: () => void) {
  // Prefer the vitest-provided describe if available
  if (typeof vitestDescribe === 'function') {
    if (RUN_LONG) return vitestDescribe(name, fn);
    if (typeof vitestDescribe.skip === 'function') return vitestDescribe.skip(name, fn);
    return vitestDescribe(name, () => {});
  }
  // Fallback to global describe if present (non-vitest environments)
  const g: any = globalThis as any;
  const desc = g.describe;
  if (typeof desc === 'function') {
    if (RUN_LONG) return desc(name, fn);
    if (typeof desc.skip === 'function') return desc.skip(name, fn);
    return desc(name, () => {});
  }
  // No test runner available; no-op.
  return;
}

/**
 * Test wrapper for individual long-running tests. Skips the test unless
 * WL_RUN_LONG_TESTS=true in the environment.
 */
export function itLong(name: string, fn: (done?: any) => any) {
  if (typeof vitestIt === 'function') {
    if (RUN_LONG) return vitestIt(name, fn as any);
    if (typeof vitestIt.skip === 'function') return vitestIt.skip(name, fn as any);
    return vitestIt(name, () => {});
  }
  const g: any = globalThis as any;
  const itFn = g.it;
  if (typeof itFn === 'function') {
    if (RUN_LONG) return itFn(name, fn as any);
    if (typeof itFn.skip === 'function') return itFn.skip(name, fn as any);
    return itFn(name, () => {});
  }
  return;
}
