/**
 * packages/herdr/src/dispatcher-anchor.test.ts — Dispatcher anchors, per-prefix
 * tab routing and project-workspace + item-ID tab resolution.
 *
 * Coverage:
 *  - C0 `getDispatcherAnchor` provisioning (retained as the AC4 fallback).
 *  - C1 `getDispatcherTabAnchor` — per-prefix tab routing inside the
 *    Dispatcher workspace (WL-0MTRQT482001SNXC).
 *  - machine-wide / process-info / proc-environ parsers.
 *  - `resolveProjectWorkspace` — project root → plugin workspace (AC1/AC3).
 *  - `getItemTabAnchor` — create-or-reuse the exact item-ID tab (AC2/AC5).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDispatcherAnchor,
  getDispatcherTabAnchor,
  getItemTabAnchor,
  resolveProjectWorkspace,
  createDispatcherAnchorDeps,
  DISPATCHER_ANCHOR_FILE,
  DISPATCHER_TAB_ANCHORS_FILE,
  DISPATCHER_WORKSPACE_LABEL,
  DISPATCHER_ROOT_TAB_LABEL,
  PLUGIN_PANE_LABEL,
  type DispatcherAnchor,
  type DispatcherAnchorDeps,
  type DispatcherTabAnchors,
  type DispatcherTabInfo,
  type DispatcherPaneInfo,
  type MachinePaneInfo,
  parseTabListOutput,
  parseTabCreateOutput,
  parsePaneListOutput,
  parseMachinePaneListOutput,
  parsePaneProcessInfoOutput,
  parseProcEnviron,
} from './dispatcher-anchor.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'da-test-'));
}
function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

let tmpDir: string;
let saved: string | undefined;

beforeEach(() => {
  tmpDir = mkTmp();
  saved = process.env.HERDR_COORDINATION_DIR;
  process.env.HERDR_COORDINATION_DIR = tmpDir;
});

afterEach(() => {
  if (saved !== undefined) process.env.HERDR_COORDINATION_DIR = saved;
  else delete process.env.HERDR_COORDINATION_DIR;
  cleanup(tmpDir);
  vi.restoreAllMocks();
});

function readPersisted(): DispatcherAnchor | null {
  try {
    const raw = fs.readFileSync(path.join(tmpDir, DISPATCHER_ANCHOR_FILE), 'utf-8');
    return JSON.parse(raw) as DispatcherAnchor;
  } catch { return null; }
}

function writePersisted(a: DispatcherAnchor): void {
  fs.writeFileSync(path.join(tmpDir, DISPATCHER_ANCHOR_FILE), JSON.stringify(a), 'utf-8');
}

function readTabAnchorsPersisted(): DispatcherTabAnchors | null {
  try {
    const raw = fs.readFileSync(path.join(tmpDir, DISPATCHER_TAB_ANCHORS_FILE), 'utf-8');
    return JSON.parse(raw) as DispatcherTabAnchors;
  } catch { return null; }
}

describe('getDispatcherAnchor ACs (C0 fallback, retained)', () => {
  it('AC2 idempotent provisioning: first call creates workspace and persists', async () => {
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => ({ workspaceId: 'wD', paneId: 'wD:p1' })),
      isPaneAlive: vi.fn(async () => true),
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toEqual({ paneId: 'wD:p1', workspaceId: 'wD' });
    expect(deps.createWorkspace).toHaveBeenCalledWith(DISPATCHER_WORKSPACE_LABEL);
    expect(readPersisted()).toEqual({ paneId: 'wD:p1', workspaceId: 'wD' });
  });

  it('AC1 persistence + AC5 no-op when valid: second call returns persisted without creating', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => { throw new Error('should not be called'); }),
      isPaneAlive: vi.fn(async () => true),
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toEqual({ paneId: 'wD:p1', workspaceId: 'wD' });
    expect(deps.createWorkspace).not.toHaveBeenCalled();
    expect(deps.isPaneAlive).toHaveBeenCalledWith('wD:p1');
  });

  it('AC4 closed-pane auto-reprovision: stale pane is replaced', async () => {
    writePersisted({ paneId: 'wD:OLD', workspaceId: 'wD' });
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => ({ workspaceId: 'wD2', paneId: 'wD2:p1' })),
      isPaneAlive: vi.fn(async () => false),
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toEqual({ paneId: 'wD2:p1', workspaceId: 'wD2' });
    expect(readPersisted()).toEqual({ paneId: 'wD2:p1', workspaceId: 'wD2' });
  });

  it('AC3 concurrent safety: second caller sees persisted value when lock is held', async () => {
    const lockPath = path.join(tmpDir, 'downtime-coordination.lock');
    fs.writeFileSync(lockPath, '');
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => { throw new Error('should not create under contention'); }),
      isPaneAlive: vi.fn(async () => true),
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toEqual({ paneId: 'wD:p1', workspaceId: 'wD' });
    expect(deps.createWorkspace).not.toHaveBeenCalled();
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  });

  it('AC6 fail-safe: provisioning failure returns null', async () => {
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => { throw new Error('herdr unavailable'); }),
      isPaneAlive: vi.fn(async () => true),
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toBeNull();
  });

  it('AC6 fail-safe: isPaneAlive throw returns null (stale check fail-safe)', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => ({ workspaceId: 'wD', paneId: 'wD:p1' })),
      isPaneAlive: vi.fn(async () => { throw new Error('rpc boom'); }),
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toBeNull();
  });

  it('returns null when machine dir is unresolvable (empty HERDR_COORDINATION_DIR + ensure fails)', async () => {
    const fileAsDir = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    process.env.HERDR_COORDINATION_DIR = fileAsDir;
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => ({ workspaceId: 'w', paneId: 'w:p1' })),
      isPaneAlive: vi.fn(async () => true),
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toBeNull();
  });

  // ── Root-pane adoption (WL-0MU2EOHK900425VU) ──────────────────────────

  it('AC1 root-pane adoption: first provision moves the root pane into a labelled tab', async () => {
    const movePaneToNewTab = vi.fn(async () => true);
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => ({ workspaceId: 'wD', paneId: 'wD:p1' })),
      isPaneAlive: vi.fn(async () => true),
      movePaneToNewTab,
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toEqual({ paneId: 'wD:p1', workspaceId: 'wD' });
    expect(DISPATCHER_ROOT_TAB_LABEL).toBe('Downtime');
    expect(movePaneToNewTab).toHaveBeenCalledTimes(1);
    expect(movePaneToNewTab).toHaveBeenCalledWith('wD:p1', DISPATCHER_ROOT_TAB_LABEL);
  });

  it('AC2 stale re-provision also adopts the replacement root pane', async () => {
    writePersisted({ paneId: 'wD:OLD', workspaceId: 'wD' });
    const movePaneToNewTab = vi.fn(async () => true);
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => ({ workspaceId: 'wD2', paneId: 'wD2:p1' })),
      isPaneAlive: vi.fn(async () => false),
      movePaneToNewTab,
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toEqual({ paneId: 'wD2:p1', workspaceId: 'wD2' });
    expect(movePaneToNewTab).toHaveBeenCalledWith('wD2:p1', DISPATCHER_ROOT_TAB_LABEL);
  });

  it('AC1 adoption returning false is non-fatal: anchor still persisted and returned', async () => {
    const deps: DispatcherAnchorDeps = {
      createWorkspace: vi.fn(async () => ({ workspaceId: 'wD', paneId: 'wD:p1' })),
      isPaneAlive: vi.fn(async () => true),
      movePaneToNewTab: vi.fn(async () => false),
    };
    const got = await getDispatcherAnchor(tmpDir, deps);
    expect(got).toEqual({ paneId: 'wD:p1', workspaceId: 'wD' });
    expect(readPersisted()).toEqual({ paneId: 'wD:p1', workspaceId: 'wD' });
  });
});

// ── herdr CLI parsers ──────────────────────────────────────────────────

describe('tab/pane CLI parsers', () => {
  it('parseTabListOutput: live nested result shape', () => {
    const raw = '{"id":"cli:tab:list","result":{"tabs":[{"label":"WL-ABC","tab_id":"wD:tWL"},{"label":"Worklog","tab_id":"wD:tX"}]}}';
    expect(parseTabListOutput(raw)).toEqual([
      { tabId: 'wD:tWL', label: 'WL-ABC' },
      { tabId: 'wD:tX', label: 'Worklog' },
    ]);
  });

  it('parseTabListOutput: camelCase keys and log-line prefix tolerated', () => {
    const raw = 'some log line\n{"result":{"tabs":[{"tabId":"wD:tWL","title":"WL-ABC"}]}}';
    expect(parseTabListOutput(raw)).toEqual([{ tabId: 'wD:tWL', label: 'WL-ABC' }]);
  });

  it('parseTabListOutput: null on garbage / missing tabs array', () => {
    expect(parseTabListOutput('not json')).toBeNull();
    expect(parseTabListOutput('{}')).toBeNull();
    expect(parseTabListOutput('{"result":{"tabs":"nope"}}')).toBeNull();
  });

  it('parseTabCreateOutput: live nested tab + root_pane shape', () => {
    const raw = '{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"wD:tWL:p1"},"tab":{"tab_id":"wD:tWL","label":"WL-ABC"}}}';
    expect(parseTabCreateOutput(raw)).toEqual({ tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
  });

  it('parseTabCreateOutput: null when fields missing', () => {
    expect(parseTabCreateOutput('{"result":{"tab":{}}}')).toBeNull();
    expect(parseTabCreateOutput('garbage')).toBeNull();
  });

  it('parsePaneListOutput: filters to paneId + tabId', () => {
    const raw = '{"result":{"panes":[{"pane_id":"wD:tWL:p1","tab_id":"wD:tWL","label":"x"},{"pane_id":"wD:tTCE:p1","tab_id":"wD:tTCE"}]}}';
    expect(parsePaneListOutput(raw)).toEqual([
      { paneId: 'wD:tWL:p1', tabId: 'wD:tWL' },
      { paneId: 'wD:tTCE:p1', tabId: 'wD:tTCE' },
    ]);
  });

  it('parseMachinePaneListOutput: nested result, label + focused + key variants', () => {
    const raw = '{"result":{"panes":[{"pane_id":"wC:pB","workspace_id":"wC","tab_id":"wC:t1","label":"Work Items","focused":true},{"paneId":"wC:pX","workspaceId":"wC","tabId":"wC:t2","title":"Editor","is_focused":true}]}}';
    expect(parseMachinePaneListOutput(raw)).toEqual([
      { paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1', label: 'Work Items', focused: true },
      { paneId: 'wC:pX', workspaceId: 'wC', tabId: 'wC:t2', label: 'Editor', focused: true },
    ]);
  });

  it('parseMachinePaneListOutput: null on unparseable output / missing arrays', () => {
    expect(parseMachinePaneListOutput('not json')).toBeNull();
    expect(parseMachinePaneListOutput('{}')).toBeNull();
  });

  it('parsePaneProcessInfoOutput: live nested shape and shellPid variant', () => {
    expect(
      parsePaneProcessInfoOutput('{"result":{"process_info":{"shell_pid":"4321"}}}'),
    ).toEqual({ shellPid: '4321' });
    expect(
      parsePaneProcessInfoOutput('{"result":{"processInfo":{"shellPid":99}}}'),
    ).toEqual({ shellPid: '99' });
  });

  it('parsePaneProcessInfoOutput: null on missing/empty shell_pid', () => {
    expect(parsePaneProcessInfoOutput('{"result":{"process_info":{}}}')).toBeNull();
    expect(parsePaneProcessInfoOutput('{"result":{"process_info":{"shell_pid":""}}}')).toBeNull();
    expect(parsePaneProcessInfoOutput('garbage')).toBeNull();
  });

  it('parseProcEnviron: NUL-delimited map, last value wins, values may contain =', () => {
    const raw = 'A=1\0HERDR_RESOLVED_CWD=/repo/p\0HERDR_WORKSPACE_ID=wC\0URL=x=y\0A=2\0';
    expect(parseProcEnviron(raw)).toEqual({
      A: '2',
      HERDR_RESOLVED_CWD: '/repo/p',
      HERDR_WORKSPACE_ID: 'wC',
      URL: 'x=y',
    });
  });
});

// ── resolveProjectWorkspace (AC1/AC3) ─────────────────────────────────

const ROOT = '/home/rgardler/projects/ContextHub';

function machinePane(over: Partial<MachinePaneInfo> = {}): MachinePaneInfo {
  return { paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1', label: PLUGIN_PANE_LABEL, focused: false, ...over };
}

function procEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';
}

interface ResolverOverrides {
  listMachinePanes?: DispatcherAnchorDeps['listMachinePanes'];
  getPaneProcessInfo?: DispatcherAnchorDeps['getPaneProcessInfo'];
  readProcEnviron?: DispatcherAnchorDeps['readProcEnviron'];
}

function makeResolverDeps(over: ResolverOverrides = {}): DispatcherAnchorDeps {
  return {
    createWorkspace: async () => ({ workspaceId: 'wD', paneId: 'wD:p1' }),
    isPaneAlive: async () => true,
    listMachinePanes: over.listMachinePanes ?? (async () => [] as MachinePaneInfo[]),
    getPaneProcessInfo: over.getPaneProcessInfo ?? (async () => ({ shellPid: '1' })),
    readProcEnviron:
      over.readProcEnviron ??
      (async () => procEnv({ HERDR_RESOLVED_CWD: ROOT, HERDR_WORKSPACE_ID: 'wC' })),
  };
}

describe('resolveProjectWorkspace ACs (AC1/AC3)', () => {
  it('AC1/AC3: matches on HERDR_RESOLVED_CWD and returns pane/workspace/tab', async () => {
    const getPaneProcessInfo = vi.fn(async () => ({ shellPid: '123' }));
    const readProcEnviron = vi.fn(async () =>
      procEnv({ HERDR_RESOLVED_CWD: ROOT, HERDR_WORKSPACE_ID: 'wC' }),
    );
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane()],
      getPaneProcessInfo,
      readProcEnviron,
    });
    const got = await resolveProjectWorkspace('/anywhere', deps, ROOT);
    expect(got).toEqual({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1' });
    expect(getPaneProcessInfo).toHaveBeenCalledWith('wC:pB');
    expect(readProcEnviron).toHaveBeenCalledWith('123');
  });

  it('AC3: falls back to the pane workspaceId when HERDR_WORKSPACE_ID is absent', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane({ workspaceId: 'wFromPane' })],
      readProcEnviron: async () => procEnv({ HERDR_RESOLVED_CWD: ROOT }),
    });
    const got = await resolveProjectWorkspace('/anywhere', deps, ROOT);
    expect(got).toEqual({ paneId: 'wC:pB', workspaceId: 'wFromPane', tabId: 'wC:t1' });
  });

  it('AC1: ignores non-plugin panes entirely (no process-info probe)', async () => {
    const getPaneProcessInfo = vi.fn(async () => ({ shellPid: '1' }));
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane({ label: 'Editor' })],
      getPaneProcessInfo,
    });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toBeNull();
    expect(getPaneProcessInfo).not.toHaveBeenCalled();
  });

  it('AC3: no plugin pane for R → null', async () => {
    const deps = makeResolverDeps({ listMachinePanes: async () => [] });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toBeNull();
  });

  it('AC3: plugin panes exist but none match R → null (never another root)', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane({ paneId: 'wC:pOTHER' })],
      getPaneProcessInfo: async () => ({ shellPid: '1' }),
      readProcEnviron: async () =>
        procEnv({ HERDR_RESOLVED_CWD: '/home/rgardler/projects/Tableau-Card-Engine', HERDR_WORKSPACE_ID: 'wY' }),
    });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toBeNull();
  });

  it('AC3 ambiguity: prefers the focused matching pane', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => [
        machinePane({ paneId: 'wC:pA', tabId: 'wC:tA', focused: false }),
        machinePane({ paneId: 'wC:pB', tabId: 'wC:tB', focused: true }),
      ],
      getPaneProcessInfo: async (id) => ({ shellPid: id === 'wC:pA' ? '1' : '2' }),
      readProcEnviron: async () => procEnv({ HERDR_RESOLVED_CWD: ROOT, HERDR_WORKSPACE_ID: 'wC' }),
    });
    const got = await resolveProjectWorkspace('/anywhere', deps, ROOT);
    expect(got).toEqual({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tB' });
  });

  it('AC3 ambiguity: no focus → lowest pane id wins deterministically', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => [
        machinePane({ paneId: 'wC:pZ', tabId: 'wC:tZ' }),
        machinePane({ paneId: 'wC:pA', tabId: 'wC:tA' }),
      ],
      getPaneProcessInfo: async () => ({ shellPid: '1' }),
      readProcEnviron: async () => procEnv({ HERDR_RESOLVED_CWD: ROOT, HERDR_WORKSPACE_ID: 'wC' }),
    });
    const got = await resolveProjectWorkspace('/anywhere', deps, ROOT);
    expect(got?.paneId).toBe('wC:pA');
  });

  it('AC3 fail-closed: malformed pane list → null', async () => {
    const deps = makeResolverDeps({ listMachinePanes: async () => null });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toBeNull();
  });

  it('AC3 fail-closed: malformed process-info → null', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane()],
      getPaneProcessInfo: async () => null,
    });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toBeNull();
  });

  it('AC3 fail-closed: missing shell_pid → null', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane()],
      getPaneProcessInfo: async () => ({ shellPid: '' }),
    });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toBeNull();
  });

  it('AC3 fail-closed: unreadable /proc environ → null', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane()],
      readProcEnviron: async () => null,
    });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toBeNull();
  });

  it('AC3 fail-closed: missing HERDR_RESOLVED_CWD → null', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane()],
      readProcEnviron: async () => procEnv({ HERDR_WORKSPACE_ID: 'wC' }),
    });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toBeNull();
  });

  it('AC3 fail-closed: throwing CLI deps → null', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => { throw new Error('herdr down'); },
    });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toBeNull();
  });

  it('empty root → null without probing panes', async () => {
    const listMachinePanes = vi.fn(async () => [machinePane()]);
    const deps = makeResolverDeps({ listMachinePanes });
    expect(await resolveProjectWorkspace('/anywhere', deps, '')).toBeNull();
    expect(listMachinePanes).not.toHaveBeenCalled();
  });

  it('trailing-slash tolerant matching (root vs HERDR_RESOLVED_CWD)', async () => {
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane()],
      readProcEnviron: async () => procEnv({ HERDR_RESOLVED_CWD: `${ROOT}/`, HERDR_WORKSPACE_ID: 'wC' }),
    });
    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT)).toEqual({
      paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1',
    });
  });
});

// ── getItemTabAnchor (AC2/AC5) ─────────────────────────────────────────

function makeTabDeps(over: ResolverOverrides & {
  createWorkspace?: DispatcherAnchorDeps['createWorkspace'];
  isPaneAlive?: DispatcherAnchorDeps['isPaneAlive'];
  listTabs?: DispatcherAnchorDeps['listTabs'];
  createTab?: DispatcherAnchorDeps['createTab'];
  listPanes?: DispatcherAnchorDeps['listPanes'];
} = {}): DispatcherAnchorDeps {
  return {
    createWorkspace: over.createWorkspace ?? (async () => ({ workspaceId: 'wD', paneId: 'wD:p1' })),
    isPaneAlive: over.isPaneAlive ?? (async () => true),
    listTabs: over.listTabs ?? (async () => [] as DispatcherTabInfo[]),
    createTab: over.createTab ?? (async (ws: string, label: string) => ({ tabId: `${ws}:t${label}`, paneId: `${ws}:t${label}:p1` })),
    listPanes: over.listPanes ?? (async () => [] as DispatcherPaneInfo[]),
    ...(over.listMachinePanes ? { listMachinePanes: over.listMachinePanes } : {}),
    ...(over.getPaneProcessInfo ? { getPaneProcessInfo: over.getPaneProcessInfo } : {}),
    ...(over.readProcEnviron ? { readProcEnviron: over.readProcEnviron } : {}),
  } as DispatcherAnchorDeps;
}

describe('getItemTabAnchor ACs (AC2/AC5)', () => {
  it('AC2: first dispatch creates the exact item-ID tab and returns its anchor pane', async () => {
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeTabDeps({ createTab });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC');
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    expect(createTab).toHaveBeenCalledWith('wC', 'WL-ABC');
  });

  it('AC2: second dispatch REUSES the existing tab (no duplicate create)', async () => {
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createTab,
      listTabs: async () => [{ tabId: 'wC:tWL-ABC', label: 'WL-ABC' }],
      listPanes: async () => [{ paneId: 'wC:tWL-ABC:p1', tabId: 'wC:tWL-ABC' }],
      isPaneAlive: async () => true,
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC');
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC2: matching tab with a dead pane is replaced (create)', async () => {
    const createTab = vi.fn(async (ws: string) => ({ tabId: `${ws}:tNEW`, paneId: `${ws}:tNEW:p1` }));
    const deps = makeTabDeps({
      createTab,
      listTabs: async () => [{ tabId: 'wC:tDEAD', label: 'WL-ABC' }],
      listPanes: async () => [{ paneId: 'wC:tDEAD:p1', tabId: 'wC:tDEAD' }],
      isPaneAlive: async () => false,
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC');
    expect(got).toEqual({ tabId: 'wC:tNEW', paneId: 'wC:tNEW:p1' });
    expect(createTab).toHaveBeenCalledWith('wC', 'WL-ABC');
  });

  it('AC5: a different item id gets its own tab (no prefix collapsing)', async () => {
    const createTab = vi.fn(async (ws: string, label: string) => ({ tabId: `${ws}:t${label}`, paneId: `${ws}:t${label}:p1` }));
    const deps = makeTabDeps({ createTab });
    await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC');
    await getItemTabAnchor('/repo', deps, 'wC', 'WL-XYZ');
    expect(createTab).toHaveBeenNthCalledWith(1, 'wC', 'WL-ABC');
    expect(createTab).toHaveBeenNthCalledWith(2, 'wC', 'WL-XYZ');
  });

  it('AC2 fail-closed: unparseable tab list → null, never creates', async () => {
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({ listTabs: async () => null, createTab });
    expect(await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC')).toBeNull();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC2 fail-closed: unreadable pane list (unknown) → null, never creates', async () => {
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      listTabs: async () => [{ tabId: 'wC:tWL-ABC', label: 'WL-ABC' }],
      listPanes: async () => null,
      createTab,
    });
    expect(await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC')).toBeNull();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC2 fail-closed: tab create returns null → null', async () => {
    const deps = makeTabDeps({ createTab: async () => null });
    expect(await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC')).toBeNull();
  });

  it('AC2 guard: empty item id or workspace id → null', async () => {
    const deps = makeTabDeps();
    expect(await getItemTabAnchor('/repo', deps, 'wC', '')).toBeNull();
    expect(await getItemTabAnchor('/repo', deps, '', 'WL-ABC')).toBeNull();
  });

  it('AC2 concurrent: lock held with no existing tab → fail closed (no duplicate)', async () => {
    const lockPath = path.join(tmpDir, 'downtime-coordination.lock');
    fs.writeFileSync(lockPath, '');
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({ createTab });
    expect(await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC')).toBeNull();
    expect(createTab).not.toHaveBeenCalled();
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  });

  it('AC2 concurrent: lock held but the winner already created the tab → adopt it', async () => {
    const lockPath = path.join(tmpDir, 'downtime-coordination.lock');
    fs.writeFileSync(lockPath, '');
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createTab,
      listTabs: async () => [{ tabId: 'wC:tWL-ABC', label: 'WL-ABC' }],
      listPanes: async () => [{ paneId: 'wC:tWL-ABC:p1', tabId: 'wC:tWL-ABC' }],
      isPaneAlive: async () => true,
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC');
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    expect(createTab).not.toHaveBeenCalled();
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  });

  // Create-vs-reuse signal (WL-0MUYI3K8H007MPKF, AC7): the interactive path
  // gates its placeholder root-pane cleanup on a genuine create.
  it('AC7: invokes onCreate with the anchor ONLY when the tab is provisioned', async () => {
    const onCreate = vi.fn();
    const deps = makeTabDeps({
      createTab: async (ws: string, label: string) => ({
        tabId: `${ws}:t${label}`,
        paneId: `${ws}:t${label}:p1`,
      }),
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC', onCreate);
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
  });

  it('AC7: does NOT invoke onCreate when REUSING an existing tab', async () => {
    const onCreate = vi.fn();
    const deps = makeTabDeps({
      createTab: async () => null,
      listTabs: async () => [{ tabId: 'wC:tWL-ABC', label: 'WL-ABC' }],
      listPanes: async () => [{ paneId: 'wC:tWL-ABC:p1', tabId: 'wC:tWL-ABC' }],
      isPaneAlive: async () => true,
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC', onCreate);
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('AC7 fail-open: a throwing onCreate never fails provisioning', async () => {
    const deps = makeTabDeps({
      createTab: async (ws: string, label: string) => ({
        tabId: `${ws}:t${label}`,
        paneId: `${ws}:t${label}:p1`,
      }),
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC', () => {
      throw new Error('observer boom');
    });
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
  });

  it('machine dir unresolvable → null', async () => {
    const fileAsDir = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    process.env.HERDR_COORDINATION_DIR = fileAsDir;
    const deps = makeTabDeps();
    expect(await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC')).toBeNull();
  });
});

// ── getDispatcherTabAnchor (C1, WL-0MTRQT482001SNXC) ─────────────────────

describe('getDispatcherTabAnchor ACs (per-prefix tabs in Dispatcher workspace)', () => {
  it('AC1: first dispatch for a prefix creates the labelled tab and persists the mapping', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeTabDeps({ createTab });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(createTab).toHaveBeenCalledWith('wD', 'WL');
    expect(readTabAnchorsPersisted()).toEqual({
      workspaceId: 'wD',
      byPrefix: { WL: { tabId: 'wD:tWL', paneId: 'wD:tWL:p1' } },
    });
  });

  it('AC1: second dispatch for the same prefix REUSES the tab (no duplicate create)', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createTab,
      listTabs: async () => [{ tabId: 'wD:tWL', label: 'WL' }],
      listPanes: async () => [{ paneId: 'wD:tWL:p1', tabId: 'wD:tWL' }],
      isPaneAlive: async () => true,
    });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(createTab).not.toHaveBeenCalled();
    expect(readTabAnchorsPersisted()).toEqual({
      workspaceId: 'wD',
      byPrefix: { WL: { tabId: 'wD:tWL', paneId: 'wD:tWL:p1' } },
    });
  });

  it('AC1: distinct prefixes get distinct tabs (WL and TCE do not collapse)', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeTabDeps({ createTab });

    const wl = await getDispatcherTabAnchor('/repo', deps, 'WL');
    const tce = await getDispatcherTabAnchor('/repo', deps, 'TCE');

    expect(wl?.tabId).toBe('wD:tWL');
    expect(tce?.tabId).toBe('wD:tTCE');
    expect(createTab).toHaveBeenNthCalledWith(1, 'wD', 'WL');
    expect(createTab).toHaveBeenNthCalledWith(2, 'wD', 'TCE');
    const persisted = readTabAnchorsPersisted();
    expect(persisted?.byPrefix.WL).toEqual({ tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(persisted?.byPrefix.TCE).toEqual({ tabId: 'wD:tTCE', paneId: 'wD:tTCE:p1' });
  });

  it('AC1: prefix is case-preserved (raw prefix, no normalisation)', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeTabDeps({ createTab });

    await getDispatcherTabAnchor('/repo', deps, 'wl');
    await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(createTab).toHaveBeenNthCalledWith(1, 'wD', 'wl');
    expect(createTab).toHaveBeenNthCalledWith(2, 'wD', 'WL');
  });

  it('AC2: a persisted anchor with a live pane is adopted without listing tabs', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    fs.writeFileSync(
      path.join(tmpDir, DISPATCHER_TAB_ANCHORS_FILE),
      JSON.stringify({ workspaceId: 'wD', byPrefix: { WL: { tabId: 'wD:tWL', paneId: 'wD:tWL:p1' } } }),
      'utf-8',
    );
    const listTabs = vi.fn(async () => [] as DispatcherTabInfo[]);
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({ listTabs, createTab, isPaneAlive: async () => true });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(listTabs).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC2: a persisted anchor with a DEAD pane is re-provisioned', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    fs.writeFileSync(
      path.join(tmpDir, DISPATCHER_TAB_ANCHORS_FILE),
      JSON.stringify({ workspaceId: 'wD', byPrefix: { WL: { tabId: 'wD:tOLD', paneId: 'wD:tOLD:p1' } } }),
      'utf-8',
    );
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}NEW`,
      paneId: `${ws}:t${label}NEW:p1`,
    }));
    const deps = makeTabDeps({ createTab, isPaneAlive: async () => false });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWLNEW', paneId: 'wD:tWLNEW:p1' });
    expect(createTab).toHaveBeenCalledWith('wD', 'WL');
    expect(readTabAnchorsPersisted()?.byPrefix.WL).toEqual({
      tabId: 'wD:tWLNEW', paneId: 'wD:tWLNEW:p1',
    });
  });

  it('AC2: a tab existing in herdr but not in the map is adopted and persisted', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createTab,
      listTabs: async () => [{ tabId: 'wD:tWL', label: 'WL' }],
      listPanes: async () => [{ paneId: 'wD:tWL:p1', tabId: 'wD:tWL' }],
      isPaneAlive: async () => true,
    });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(createTab).not.toHaveBeenCalled();
    expect(readTabAnchorsPersisted()?.byPrefix.WL).toEqual({
      tabId: 'wD:tWL', paneId: 'wD:tWL:p1',
    });
  });

  it('AC2: a matching tab with a dead pane is replaced (stale-tab re-provision)', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const createTab = vi.fn(async (ws: string) => ({ tabId: `${ws}:tNEW`, paneId: `${ws}:tNEW:p1` }));
    const deps = makeTabDeps({
      createTab,
      listTabs: async () => [{ tabId: 'wD:tDEAD', label: 'WL' }],
      listPanes: async () => [{ paneId: 'wD:tDEAD:p1', tabId: 'wD:tDEAD' }],
      isPaneAlive: async () => false,
    });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tNEW', paneId: 'wD:tNEW:p1' });
    expect(createTab).toHaveBeenCalledWith('wD', 'WL');
  });

  it('AC2 fail-closed: unparseable tab list → null, never creates (no duplicate)', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({ listTabs: async () => null, createTab });

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC2 fail-closed: unreadable pane list (unknown) → null, never creates', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      listTabs: async () => [{ tabId: 'wD:tWL', label: 'WL' }],
      listPanes: async () => null,
      createTab,
    });

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC2 fail-closed: tab create returns null (malformed CLI output) → null', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const deps = makeTabDeps({ createTab: async () => null });

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
    expect(readTabAnchorsPersisted()).toBeNull();
  });

  it('AC2 guard: empty prefix → null without touching the CLI', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const listTabs = vi.fn(async () => [] as DispatcherTabInfo[]);
    const deps = makeTabDeps({ listTabs });

    expect(await getDispatcherTabAnchor('/repo', deps, '')).toBeNull();
    expect(listTabs).not.toHaveBeenCalled();
  });

  it('AC2 concurrent: lock held with no existing tab → fail closed (no duplicate)', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const lockPath = path.join(tmpDir, 'downtime-coordination.lock');
    fs.writeFileSync(lockPath, '');
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({ createTab });

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
    expect(createTab).not.toHaveBeenCalled();
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  });

  it('AC2 concurrent: lock held but the winner already created the tab → adopt it', async () => {
    writePersisted({ paneId: 'wD:pRoot', workspaceId: 'wD' });
    const lockPath = path.join(tmpDir, 'downtime-coordination.lock');
    fs.writeFileSync(lockPath, '');
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createTab,
      listTabs: async () => [{ tabId: 'wD:tWL', label: 'WL' }],
      listPanes: async () => [{ paneId: 'wD:tWL:p1', tabId: 'wD:tWL' }],
      isPaneAlive: async () => true,
    });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(createTab).not.toHaveBeenCalled();
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  });

  it('machine dir unresolvable → null', async () => {
    const fileAsDir = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    process.env.HERDR_COORDINATION_DIR = fileAsDir;
    const deps = makeTabDeps();

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
  });
});

// ── createDispatcherAnchorDeps CLI wrappers ────────────────────────────

describe('createDispatcherAnchorDeps.movePaneToNewTab', () => {
  function writeFakeHerdr(script: string): string {
    const binPath = path.join(tmpDir, 'herdr');
    fs.writeFileSync(binPath, `#!/usr/bin/env bash\n${script}\n`, 'utf-8');
    fs.chmodSync(binPath, 0o755);
    return binPath;
  }

  it('invokes `pane move <id> --new-tab --tab-label <label> --no-focus`', async () => {
    const record = path.join(tmpDir, 'argv.txt');
    const binPath = writeFakeHerdr(`printf '%s\\n' "$@" > "${record}"`);
    const deps = createDispatcherAnchorDeps(tmpDir, binPath);
    const ok = await deps.movePaneToNewTab!('wD:p1', DISPATCHER_ROOT_TAB_LABEL);
    expect(ok).toBe(true);
    const argv = fs.readFileSync(record, 'utf-8').trim().split('\n');
    expect(argv).toEqual([
      'pane', 'move', 'wD:p1', '--new-tab', '--tab-label', DISPATCHER_ROOT_TAB_LABEL, '--no-focus',
    ]);
  });

  it('returns false (never throws) and logs when the CLI fails', async () => {
    const binPath = writeFakeHerdr('exit 3');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deps = createDispatcherAnchorDeps(tmpDir, binPath);
      await expect(
        deps.movePaneToNewTab!('wD:p1', DISPATCHER_ROOT_TAB_LABEL),
      ).resolves.toBe(false);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('listMachinePanes parses the fake CLI pane list', async () => {
    const binPath = writeFakeHerdr(
      `echo '{"result":{"panes":[{"pane_id":"wC:pB","workspace_id":"wC","tab_id":"wC:t1","label":"Work Items","focused":true}]}}'`,
    );
    const deps = createDispatcherAnchorDeps(tmpDir, binPath);
    expect(await deps.listMachinePanes!()).toEqual([
      { paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1', label: 'Work Items', focused: true },
    ]);
  });

  it('getPaneProcessInfo parses the fake CLI process-info', async () => {
    const binPath = writeFakeHerdr(
      `echo '{"result":{"process_info":{"shell_pid":"4242"}}}'`,
    );
    const deps = createDispatcherAnchorDeps(tmpDir, binPath);
    expect(await deps.getPaneProcessInfo!('wC:pB')).toEqual({ shellPid: '4242' });
  });
});
