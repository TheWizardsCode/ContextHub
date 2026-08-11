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
export function resolveTsxBin(fromDir) {
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
export function createTempDir() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-test-'));
    return tmpDir;
}
/**
 * Clean up a temporary directory.
 * On Windows, SQLite may hold file locks briefly after the connection
 * object goes out of scope; retry a few times to handle EPERM.
 */
export function cleanupTempDir(dir) {
    if (!fs.existsSync(dir)) {
        return;
    }
    const maxRetries = process.platform === 'win32' ? 5 : 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        }
        catch (err) {
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
export function createTempJsonlPath(dir) {
    return path.join(dir, 'test-data.jsonl');
}
/**
 * Create a temporary database path in a temp directory
 */
export function createTempDbPath(dir) {
    return path.join(dir, 'test.db');
}
/**
 * Wait for a specified number of milliseconds
 */
export function wait(ms) {
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
export function createTuiTestContext(options) {
    let nextId = 1;
    const items = new Map();
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
            get: (id) => items.get(id),
            update: (id, updates) => {
                const cur = items.get(id);
                if (!cur)
                    return false;
                const next = Object.assign({}, cur, updates);
                items.set(id, next);
                return next;
            },
        },
        requireInitialized: () => { },
        getDatabase: (prefix) => ({
            list: (query) => Array.from(items.values()),
            getPrefix: () => testPrefix,
            getCommentsForWorkItem: (id) => [],
            getAuditResult: (id) => null,
            update: (id, updates) => {
                const cur = items.get(id);
                if (!cur)
                    return false;
                const next = Object.assign({}, cur, updates);
                items.set(id, next);
                return next;
            },
            createComment: (_) => ({}),
            get: (id) => items.get(id),
        }),
    };
    const toast = {
        _last: '',
        _lastIsError: false,
        show: (m) => { toast._last = m; toast._lastIsError = false; },
        showError: (m) => { toast._last = m; toast._lastIsError = true; },
        lastMessage: () => toast._last,
        lastIsError: () => toast._lastIsError,
    };
    // Mock WlDbAdapter that returns test data from the in-memory items store
    const createMockWlDbAdapter = () => ({
        list: (query) => {
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
                    if (!item.stage)
                        return true; // items without stage match
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
        get: (id) => items.get(id) ?? null,
        create: (item) => {
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
        update: (id, updates) => {
            const cur = items.get(id);
            if (!cur)
                return null;
            const next = Object.assign({}, cur, updates);
            items.set(id, next);
            return next;
        },
        getPrefix: () => testPrefix,
        getCommentsForWorkItem: (id) => {
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
        getAuditResult: (_id) => null,
        createComment: (params) => {
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
        getChildren: (parentId) => Array.from(items.values()).filter(i => i.parentId === parentId),
        upsertItems: (_) => { },
    });
    // Minimal box/screen factories used by the layout mocks
    const makeBox = () => {
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
        obj.setFront = () => { };
        obj.setContent = (s) => { _content = s; };
        obj.getContent = () => _content;
        obj.setScroll = (_n) => { };
        obj.setScrollPerc = (_n) => { };
        obj.pushLine = (_s) => { };
        obj.setItems = (next) => { _items = next.slice(); obj.items = _items.map(v => ({ getContent: () => v })); };
        obj.select = (idx) => { obj.selected = idx; };
        obj.getItem = (idx) => { const v = (obj.items && obj.items[idx]); return v ? v : undefined; };
        // Initialize items property to match blessed List API shape
        obj.items = [];
        obj.on = (_ev, _cb) => { };
        obj.key = (_keys, _cb) => { };
        obj.setLabel = (_s) => { };
        obj.clearValue = () => { };
        obj.setValue = (_v) => { };
        obj.destroy = () => { };
        obj.removeAllListeners = () => { };
        obj.removeListener = (_ev, _cb) => { };
        return obj;
    };
    // Simple screen that allows registering keypress handlers and
    // exposing `emit('keypress', ch, key)` to simulate key events.
    const rawKeyHandlers = [];
    const keyBindings = [];
    const screen = {
        height: 40,
        width: 100,
        focused: null,
        render: () => { },
        destroy: () => { },
        // raw keypress listeners
        on: (ev, cb) => { if (ev === 'keypress')
            rawKeyHandlers.push(cb); },
        // register a key binding (blessed semantics expect this)
        key: (keys, cb) => {
            const list = Array.isArray(keys) ? keys : [keys];
            const normalized = list.map((k) => String(k).toLowerCase());
            keyBindings.push({ keys: normalized, handler: cb });
        },
        // emit a raw keypress: invoke raw handlers and matching key bindings
        emit: (ev, ch, key) => {
            if (ev !== 'keypress')
                return;
            // call raw listeners
            rawKeyHandlers.forEach(h => { try {
                h(ch, key);
            }
            catch (_) { } });
            // call bindings that match the key name (case-insensitive)
            const name = (key && key.name) ? String(key.name).toLowerCase() : String(key || '').toLowerCase();
            keyBindings.forEach(({ keys, handler }) => {
                try {
                    if (keys.includes(name))
                        handler(ch, key);
                }
                catch (_) { }
            });
        },
    };
    // Minimal blessed-compatible factory used by createLayout
    const blessedImpl = {
        screen: (_opts) => screen,
        box: (_opts) => makeBox(),
        list: (_opts) => makeBox(),
        textarea: (_opts) => makeBox(),
        button: (_opts) => makeBox(),
        text: (_opts) => makeBox(),
    };
    const layout = {
        screen,
        // Use consistent instances so focus/selected are shared
        listComponent: { getList: (() => { const b = makeBox(); return () => b; })(), getFooter: (() => { const b = makeBox(); return () => b; })() },
        detailComponent: { getDetail: (() => { const b = makeBox(); return () => b; })(), getCopyIdButton: (() => { const b = makeBox(); return () => b; })() },
        toastComponent: { show: (m) => toast.show(m), showError: (m) => toast.showError(m) },
        overlaysComponent: { detailOverlay: makeBox(), closeOverlay: makeBox(), updateOverlay: makeBox(), createOverlay: makeBox() },
        dialogsComponent: {
            detailModal: makeBox(), detailClose: makeBox(), closeDialog: makeBox(), closeDialogText: makeBox(), closeDialogOptions: makeBox(),
            updateDialog: makeBox(), updateDialogText: makeBox(), updateDialogOptions: makeBox(), updateDialogStageOptions: makeBox(), updateDialogStatusOptions: makeBox(), updateDialogPriorityOptions: makeBox(), updateDialogComment: makeBox(),
            createDialog: makeBox(), createDialogText: makeBox(), createDialogTitleInput: makeBox(), createDialogDescription: makeBox(), createDialogIssueTypeOptions: makeBox(), createDialogPriorityOptions: makeBox(), createDialogCreateButton: makeBox(), createDialogCancelButton: makeBox(),
        },
        helpMenu: { isVisible: () => false, show: () => { }, hide: () => { } },
        modalDialogs: { selectList: async () => 0, editTextarea: async () => null, confirmTextbox: async () => false, forceCleanup: () => { } },
        agentPane: { serverStatusBox: makeBox(), dialog: makeBox(), textarea: makeBox(), suggestionHint: makeBox(), sendButton: makeBox(), cancelButton: makeBox(), ensureResponsePane: () => makeBox() },
        nextDialog: { overlay: makeBox(), dialog: makeBox(), close: makeBox(), text: makeBox(), options: makeBox() },
    };
    const program = { opts: () => ({ verbose: false, format: undefined, json: false }) };
    // Minimal command registry so CLI command modules can register commands
    // and tests can invoke them via `ctx.runCli([...])`.
    program._commands = new Map();
    program.command = (spec) => {
        const name = String(spec).split(' ')[0];
        const builder = {
            description: (_d) => builder,
            option: (_opt, _desc) => builder,
            action: (fn) => {
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
    function kebabToCamel(s) {
        return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    }
    async function runCli(args) {
        const cmd = args[0];
        const id = args[1];
        let value;
        const rest = [];
        if (args.length > 2) {
            const maybeValue = args[2];
            if (maybeValue && !String(maybeValue).startsWith('-')) {
                value = maybeValue;
                rest.push(...args.slice(3));
            }
            else {
                rest.push(...args.slice(2));
            }
        }
        const handler = program._commands.get(cmd);
        if (!handler)
            throw new Error(`Command not registered: ${cmd}`);
        const options = {};
        for (let i = 0; i < rest.length; i++) {
            const token = rest[i];
            if (!token)
                continue;
            if (token.startsWith('--')) {
                const key = kebabToCamel(token.replace(/^--+/, ''));
                const next = rest[i + 1];
                if (next !== undefined && !String(next).startsWith('-')) {
                    options[key] = next;
                    i++;
                }
                else {
                    options[key] = true;
                }
            }
            else if (token.startsWith('-')) {
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
            normalizeCliId: (id, _prefix) => id,
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
    };
}
// Back-compat alias for CLI command tests.
export const createTestContext = createTuiTestContext;
// Helper to gate long-running tests. Set WL_RUN_LONG_TESTS=true to enable.
export const RUN_LONG = process.env.WL_RUN_LONG_TESTS === 'true';
/**
 * Describe wrapper for long-running tests. Skips the suite unless
 * WL_RUN_LONG_TESTS=true in the environment.
 */
export function describeLong(name, fn) {
    // Prefer the vitest-provided describe if available
    if (typeof vitestDescribe === 'function') {
        if (RUN_LONG)
            return vitestDescribe(name, fn);
        if (typeof vitestDescribe.skip === 'function')
            return vitestDescribe.skip(name, fn);
        return vitestDescribe(name, () => { });
    }
    // Fallback to global describe if present (non-vitest environments)
    const g = globalThis;
    const desc = g.describe;
    if (typeof desc === 'function') {
        if (RUN_LONG)
            return desc(name, fn);
        if (typeof desc.skip === 'function')
            return desc.skip(name, fn);
        return desc(name, () => { });
    }
    // No test runner available; no-op.
    return;
}
/**
 * Test wrapper for individual long-running tests. Skips the test unless
 * WL_RUN_LONG_TESTS=true in the environment.
 */
export function itLong(name, fn) {
    if (typeof vitestIt === 'function') {
        if (RUN_LONG)
            return vitestIt(name, fn);
        if (typeof vitestIt.skip === 'function')
            return vitestIt.skip(name, fn);
        return vitestIt(name, () => { });
    }
    const g = globalThis;
    const itFn = g.it;
    if (typeof itFn === 'function') {
        if (RUN_LONG)
            return itFn(name, fn);
        if (typeof itFn.skip === 'function')
            return itFn.skip(name, fn);
        return itFn(name, () => { });
    }
    return;
}
//# sourceMappingURL=test-utils.js.map