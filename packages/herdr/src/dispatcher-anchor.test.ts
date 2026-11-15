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
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDispatcherAnchor,
  getDispatcherTabAnchor,
  getItemTabAnchor,
  resolveProjectWorkspace,
  resolveExtensionsTab,
  applyPlacementMode,
  moveTabInWorkspace,
  resolveHerdrSocketPath,
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
import {
  seedStaleAnchorState,
  STALE_ANCHOR,
  STALE_ANCHOR_JSON,
  STALE_TAB_ANCHORS,
  STALE_TAB_ANCHORS_JSON,
} from './__fixtures__/stale-dispatcher-anchors.js';
import { persistPrefixTab } from './dispatcher-anchor.persistence.js';

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

  // ── Primary-path near-miss diagnostics (WL-0MWHCV3PR002WSQM) ────────
  // Parent AC7 / this item AC1/AC2/AC3: when the resolver returns `null` but
  // a plugin pane reported a DIFFERENT non-empty `HERDR_RESOLVED_CWD`, the
  // optional trailing report callback receives the per-pane near-miss record
  // (expected vs actual root, pane/workspace ids) — so a ContextHub-style
  // mismatch (`…/packages/herdr` ≠ the worklog root) is visible instead of
  // looking like "no plugin pane". Additive: every existing caller passes no
  // callback and keeps today's behaviour byte-for-byte (the match logic is
  // unchanged). No report on a match (AC3), no report for an absent env
  // (AC3 — an absent env is not a mismatch).

  it('AC2: a pane reporting a DIFFERENT HERDR_RESOLVED_CWD yields a near-miss record on null (expected vs actual)', async () => {
    const report = vi.fn();
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane()],
      readProcEnviron: async () =>
        procEnv({ HERDR_RESOLVED_CWD: `${ROOT}/packages/herdr`, HERDR_WORKSPACE_ID: 'wC' }),
    });

    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT, report)).toBeNull();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      expectedRoot: ROOT,
      actualRoot: `${ROOT}/packages/herdr`,
      paneId: 'wC:pB',
      workspaceId: 'wC',
    });
  });

  it('AC2: the near-miss falls back to the pane workspaceId when HERDR_WORKSPACE_ID is absent', async () => {
    const report = vi.fn();
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane({ workspaceId: 'wFromPane' })],
      readProcEnviron: async () =>
        procEnv({ HERDR_RESOLVED_CWD: '/somewhere/else' }),
    });

    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT, report)).toBeNull();
    expect(report).toHaveBeenCalledWith({
      expectedRoot: ROOT,
      actualRoot: '/somewhere/else',
      paneId: 'wC:pB',
      workspaceId: 'wFromPane',
    });
  });

  it('AC2: every mismatching plugin pane reports its own near-miss (one record per pane)', async () => {
    const report = vi.fn();
    const deps = makeResolverDeps({
      listMachinePanes: async () => [
        machinePane({ paneId: 'wC:pA', tabId: 'wC:tA' }),
        machinePane({ paneId: 'wC:pB', tabId: 'wC:tB' }),
      ],
      getPaneProcessInfo: async () => ({ shellPid: '1' }),
      readProcEnviron: async () =>
        procEnv({ HERDR_RESOLVED_CWD: `${ROOT}/packages/herdr`, HERDR_WORKSPACE_ID: 'wC' }),
    });

    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT, report)).toBeNull();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenNthCalledWith(1, {
      expectedRoot: ROOT,
      actualRoot: `${ROOT}/packages/herdr`,
      paneId: 'wC:pA',
      workspaceId: 'wC',
    });
    expect(report).toHaveBeenNthCalledWith(2, {
      expectedRoot: ROOT,
      actualRoot: `${ROOT}/packages/herdr`,
      paneId: 'wC:pB',
      workspaceId: 'wC',
    });
  });

  it('AC3: a MATCHING root produces no near-miss report', async () => {
    const report = vi.fn();
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane()],
      readProcEnviron: async () => procEnv({ HERDR_RESOLVED_CWD: ROOT, HERDR_WORKSPACE_ID: 'wC' }),
    });

    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT, report)).toEqual({
      paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:t1',
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('AC3: an absent HERDR_RESOLVED_CWD is NOT a mismatch (no near-miss report)', async () => {
    const report = vi.fn();
    const deps = makeResolverDeps({
      listMachinePanes: async () => [machinePane()],
      readProcEnviron: async () => procEnv({ HERDR_WORKSPACE_ID: 'wC' }),
    });

    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT, report)).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  it('AC3: no plugin pane at all → null with no near-miss report', async () => {
    const report = vi.fn();
    const deps = makeResolverDeps({ listMachinePanes: async () => [] });

    expect(await resolveProjectWorkspace('/anywhere', deps, ROOT, report)).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });
});

// ── getItemTabAnchor (AC2/AC5) ─────────────────────────────────────────

function makeTabDeps(over: ResolverOverrides & {
  createWorkspace?: DispatcherAnchorDeps['createWorkspace'];
  isPaneAlive?: DispatcherAnchorDeps['isPaneAlive'];
  listTabs?: DispatcherAnchorDeps['listTabs'];
  createTab?: DispatcherAnchorDeps['createTab'];
  listPanes?: DispatcherAnchorDeps['listPanes'];
  moveTab?: DispatcherAnchorDeps['moveTab'];
  probeWorkspace?: DispatcherAnchorDeps['probeWorkspace'];
} = {}): DispatcherAnchorDeps {
  return {
    createWorkspace: over.createWorkspace ?? (async () => ({ workspaceId: 'wD', paneId: 'wD:p1' })),
    isPaneAlive: over.isPaneAlive ?? (async () => true),
    listTabs: over.listTabs ?? (async () => [] as DispatcherTabInfo[]),
    createTab: over.createTab ?? (async (ws: string, label: string) => ({ tabId: `${ws}:t${label}`, paneId: `${ws}:t${label}:p1` })),
    listPanes: over.listPanes ?? (async () => [] as DispatcherPaneInfo[]),
    // The workspace-existence probe (WL-0MWHCUPGQ001FASL) is OPTIONAL on the
    // deps contract and, when absent, fails closed (parent decision "Missing
    // ≠ unreadable"). These tab tests exercise the resolver against a VALID
    // persisted workspace, so the shared default answers `alive`; the
    // recovery/regression tests (WL-0MWHCUTDM003B39Q) override it with
    // `missing`/`unreadable`, or build a raw deps object without it.
    probeWorkspace: over.probeWorkspace ?? (async () => 'alive'),
    ...(over.moveTab ? { moveTab: over.moveTab } : {}),
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

// ── resolveExtensionsTab (WL-0MVZ88G51004IYHW) ───────────────────────────

function makeExtensionsDeps(over: {
  listTabs?: DispatcherAnchorDeps['listTabs'];
  listMachinePanes?: DispatcherAnchorDeps['listMachinePanes'];
} = {}): DispatcherAnchorDeps {
  return {
    createWorkspace: async () => ({ workspaceId: 'wD', paneId: 'wD:p1' }),
    isPaneAlive: async () => true,
    listTabs: over.listTabs ?? (async () => [] as DispatcherTabInfo[]),
    ...(over.listMachinePanes ? { listMachinePanes: over.listMachinePanes } : {}),
  } as DispatcherAnchorDeps;
}

function workItemsPane(over: Partial<MachinePaneInfo> = {}): MachinePaneInfo {
  return {
    paneId: 'wC:pB',
    workspaceId: 'wC',
    tabId: 'wC:t1',
    label: PLUGIN_PANE_LABEL,
    focused: false,
    ...over,
  };
}

describe('resolveExtensionsTab (left-of-extensions placement)', () => {
  it('returns the index of the tab hosting a Work Items pane (strategy 1)', async () => {
    const deps = makeExtensionsDeps({
      listTabs: async () => [
        { tabId: 'wC:t1', label: 'Worklog' },
        { tabId: 'wC:t2', label: 'WL-ABC' },
        { tabId: 'wC:t3', label: 'Downtime' },
      ],
      listMachinePanes: async () => [workItemsPane()],
    });
    expect(await resolveExtensionsTab('/repo', deps, 'wC')).toBe(0);
  });

  it('falls back to a tab labelled exactly Worklog when no Work Items pane exists (strategy 2)', async () => {
    const deps = makeExtensionsDeps({
      listTabs: async () => [
        { tabId: 'wC:tOther', label: 'Editor' },
        { tabId: 'wC:tWorklog', label: 'Worklog' },
        { tabId: 'wC:tLast', label: 'Downtime' },
      ],
      listMachinePanes: async () => [],
    });
    expect(await resolveExtensionsTab('/repo', deps, 'wC')).toBe(1);
  });

  it('fail-open: no Work Items pane and no Worklog tab → null', async () => {
    const deps = makeExtensionsDeps({
      listTabs: async () => [
        { tabId: 'wC:tA', label: 'Editor' },
        { tabId: 'wC:tB', label: 'Downtime' },
      ],
      listMachinePanes: async () => [],
    });
    expect(await resolveExtensionsTab('/repo', deps, 'wC')).toBeNull();
  });

  it('fail-open: ambiguous (2 tabs host Work Items panes) → null, never guesses', async () => {
    const deps = makeExtensionsDeps({
      listTabs: async () => [
        { tabId: 'wC:tA', label: 'Worklog' },
        { tabId: 'wC:tB', label: 'Other' },
      ],
      listMachinePanes: async () => [
        workItemsPane({ tabId: 'wC:tA' }),
        workItemsPane({ tabId: 'wC:tB' }),
      ],
    });
    expect(await resolveExtensionsTab('/repo', deps, 'wC')).toBeNull();
  });

  it('fail-open: unreadable machine pane list falls through to strategy 2', async () => {
    const deps = makeExtensionsDeps({
      listTabs: async () => [
        { tabId: 'wC:tOther', label: 'Editor' },
        { tabId: 'wC:tWorklog', label: 'Worklog' },
      ],
      listMachinePanes: async () => null,
    });
    expect(await resolveExtensionsTab('/repo', deps, 'wC')).toBe(1);
  });

  it('fail-open: unreadable tab list → null', async () => {
    const deps = makeExtensionsDeps({ listTabs: async () => null });
    expect(await resolveExtensionsTab('/repo', deps, 'wC')).toBeNull();
  });
});

// ── applyPlacementMode (WL-0MVZ88G51004IYHW) ─────────────────────────────

describe('applyPlacementMode (left-of-extensions placement)', () => {
  it("placement 'right' (default) never repositions (dispatcher behaviour unchanged)", async () => {
    const moveTab = vi.fn(async () => true);
    const deps = makeTabDeps({
      moveTab,
      listTabs: async () => [{ tabId: 'wC:t1', label: 'Worklog' }],
      listMachinePanes: async () => [],
    });
    expect(await applyPlacementMode('/repo', deps, 'wC', 'right', 'wC:tItem')).toBe(false);
    expect(moveTab).not.toHaveBeenCalled();
  });

  it("placement 'left-of-extensions' moves the tab to the extensions tab's index", async () => {
    const moveTab = vi.fn(async () => true);
    const deps = makeTabDeps({
      moveTab,
      listTabs: async () => [
        { tabId: 'wC:t1', label: 'Worklog' },
        { tabId: 'wC:t2', label: 'Editor' },
      ],
      listMachinePanes: async () => [workItemsPane({ tabId: 'wC:t1' })],
    });
    const ok = await applyPlacementMode('/repo', deps, 'wC', 'left-of-extensions', 'wC:tItem');
    expect(ok).toBe(true);
    expect(moveTab).toHaveBeenCalledTimes(1);
    expect(moveTab).toHaveBeenCalledWith('wC', 'wC:tItem', 0);
  });

  it('fail-open: extensions tab unresolvable → no move, no throw', async () => {
    const moveTab = vi.fn(async () => true);
    const deps = makeTabDeps({
      moveTab,
      listTabs: async () => [{ tabId: 'wC:tA', label: 'Editor' }],
      listMachinePanes: async () => [],
    });
    expect(await applyPlacementMode('/repo', deps, 'wC', 'left-of-extensions', 'wC:tItem')).toBe(false);
    expect(moveTab).not.toHaveBeenCalled();
  });

  it('fail-open: moveTab dep absent (legacy/test caller) → no move, no throw', async () => {
    const deps = makeTabDeps(); // no moveTab
    expect(await applyPlacementMode('/repo', deps, 'wC', 'left-of-extensions', 'wC:tItem')).toBe(false);
  });

  it('fail-open: moveTab returns false (CLI failure) → stays at default position', async () => {
    const deps = makeTabDeps({
      moveTab: async () => false,
      listTabs: async () => [{ tabId: 'wC:t1', label: 'Worklog' }],
      listMachinePanes: async () => [],
    });
    expect(await applyPlacementMode('/repo', deps, 'wC', 'left-of-extensions', 'wC:tItem')).toBe(false);
  });

  it('fail-open: moveTab throws → swallowed, no throw, no move', async () => {
    const deps = makeTabDeps({
      moveTab: async () => { throw new Error('rpc boom'); },
      listTabs: async () => [{ tabId: 'wC:t1', label: 'Worklog' }],
      listMachinePanes: async () => [],
    });
    expect(await applyPlacementMode('/repo', deps, 'wC', 'left-of-extensions', 'wC:tItem')).toBe(false);
  });
});

// ── getItemTabAnchor left-of-extensions placement ────────────────────────

describe('getItemTabAnchor placement mode (WL-0MVZ88G51004IYHW)', () => {
  it('left-of-extensions: interactive dispatch creates a fresh tab AND moves it left of the extensions tab', async () => {
    const moveTab = vi.fn(async () => true);
    const deps = makeTabDeps({
      moveTab,
      listTabs: async () => [
        { tabId: 'wC:tWorklog', label: 'Worklog' },
        { tabId: 'wC:tEditor', label: 'Editor' },
      ],
      listMachinePanes: async () => [workItemsPane({ tabId: 'wC:tWorklog' })],
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC', undefined, 'left-of-extensions');
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    expect(moveTab).toHaveBeenCalledTimes(1);
    expect(moveTab).toHaveBeenCalledWith('wC', 'wC:tWL-ABC', 0);
  });

  it('default (right): dispatcher-style creation does NOT reposition the fresh tab', async () => {
    const moveTab = vi.fn(async () => true);
    const deps = makeTabDeps({ moveTab });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC');
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    expect(moveTab).not.toHaveBeenCalled();
  });

  it('reuse semantics: an existing item-ID tab is adopted WITHOUT being moved', async () => {
    const moveTab = vi.fn(async () => true);
    const deps = makeTabDeps({
      moveTab,
      listTabs: async () => [{ tabId: 'wC:tWL-ABC', label: 'WL-ABC' }],
      listPanes: async () => [{ paneId: 'wC:tWL-ABC:p1', tabId: 'wC:tWL-ABC' }],
      isPaneAlive: async () => true,
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC', undefined, 'left-of-extensions');
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    expect(moveTab).not.toHaveBeenCalled();
  });

  it('fail-open: extensions tab unresolvable → fresh tab stays right, anchor still returned', async () => {
    const moveTab = vi.fn(async () => true);
    const deps = makeTabDeps({
      moveTab,
      listTabs: async () => [{ tabId: 'wC:tEditor', label: 'Editor' }],
      listMachinePanes: async () => [],
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC', undefined, 'left-of-extensions');
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
    expect(moveTab).not.toHaveBeenCalled();
  });

  it('fail-open: moveTab fails → fresh tab stays right, anchor still returned, dispatch not blocked', async () => {
    const moveTab = vi.fn(async () => false);
    const deps = makeTabDeps({
      moveTab,
      listTabs: async () => [{ tabId: 'wC:tWorklog', label: 'Worklog' }],
      listMachinePanes: async () => [],
    });
    const got = await getItemTabAnchor('/repo', deps, 'wC', 'WL-ABC', undefined, 'left-of-extensions');
    expect(got).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });
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

// ── Regression fixtures: stale anchors (WL-0MWH50EN4007C6YH) ────────────

// Test-only safety net committed BEFORE the anchor self-healing fix
// (WL-0MWH50EN4007C6YH). Each case seeds the recorded pre-fix state via the
// shared fixture (`seedStaleAnchorState`) and pins today's behaviour with
// injected deps only — no test reads `~/.herdr` (HERDR_COORDINATION_DIR is
// overridden to tmpDir in the beforeEach).

describe('regression fixtures: stale anchors (WL-0MWH50EN4007C6YH)', () => {
  // AC1 — the committed fixture must reproduce the recorded pre-fix state
  // exactly (both files, both ids `w6A`) so the sibling fix item
  // (WL-0MWHCUTDM003B39Q) can seed it verbatim.
  it('AC1: fixture writes the recorded w6A anchor files verbatim and they read back as anchor state', () => {
    seedStaleAnchorState(tmpDir);
    expect(fs.readFileSync(path.join(tmpDir, DISPATCHER_ANCHOR_FILE), 'utf-8')).toBe(STALE_ANCHOR_JSON);
    expect(fs.readFileSync(path.join(tmpDir, DISPATCHER_TAB_ANCHORS_FILE), 'utf-8')).toBe(STALE_TAB_ANCHORS_JSON);
    expect(STALE_ANCHOR).toEqual({ paneId: 'w6A:p1', workspaceId: 'w6A' });
    expect(STALE_TAB_ANCHORS).toEqual({
      workspaceId: 'w6A',
      byPrefix: { WL: { tabId: 'w6A:t2', paneId: 'w6A:p5' } },
    });
    // The production readers accept the seeded state as-is.
    expect(readPersisted()).toEqual(STALE_ANCHOR);
    expect(readTabAnchorsPersisted()).toEqual(STALE_TAB_ANCHORS);
  });

  // AC2 — parent AC2: a persisted prefix entry whose pane is dead (workspace
  // alive) still re-resolves/re-creates the tab and persists the new mapping,
  // so the fast path cannot regress.
  it('AC2: dead pane with the workspace alive re-provisions the tab and persists the new mapping', async () => {
    seedStaleAnchorState(tmpDir);
    const createWorkspace = vi.fn(async () => {
      throw new Error('workspace alive — createWorkspace must never run');
    });
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeTabDeps({
      createWorkspace,
      createTab,
      isPaneAlive: async (paneId: string) => paneId !== 'w6A:p1' && paneId !== 'w6A:p5',
    });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(createWorkspace).not.toHaveBeenCalled(); // workspace reused from the persisted anchor
    expect(got).toEqual({ workspaceId: 'w6A', tabId: 'w6A:tWL', paneId: 'w6A:tWL:p1' });
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledWith('w6A', 'WL');
    // The new mapping supersedes the recorded stale entry (no re-lookup on the
    // next dispatch).
    expect(readTabAnchorsPersisted()).toEqual({
      workspaceId: 'w6A',
      byPrefix: { WL: { tabId: 'w6A:tWL', paneId: 'w6A:tWL:p1' } },
    });
  });

  // AC3 — parent AC3 (first half): a transient/unreadable herdr must fail
  // closed with `anchor-unavailable` and provisions NOTHING — createWorkspace
  // (and createTab) are never called, so an outage cannot duplicate the
  // workspace.
  it('AC3: unreadable tab list (null) → null, provisions nothing', async () => {
    seedStaleAnchorState(tmpDir);
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wX', paneId: 'wX:p1' }));
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createWorkspace,
      createTab,
      listTabs: async () => null,
      isPaneAlive: async (paneId: string) => paneId !== 'w6A:p1' && paneId !== 'w6A:p5',
    });

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC3: tab list CLI error (throw) → null, provisions nothing', async () => {
    seedStaleAnchorState(tmpDir);
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wX', paneId: 'wX:p1' }));
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createWorkspace,
      createTab,
      listTabs: async () => { throw new Error('herdr down'); },
      isPaneAlive: async (paneId: string) => paneId !== 'w6A:p1' && paneId !== 'w6A:p5',
    });

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC3: unreadable pane list (null) → null, provisions nothing', async () => {
    seedStaleAnchorState(tmpDir);
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wX', paneId: 'wX:p1' }));
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createWorkspace,
      createTab,
      listTabs: async () => [{ tabId: 'w6A:t2', label: 'WL' }],
      listPanes: async () => null,
      isPaneAlive: async (paneId: string) => paneId !== 'w6A:p1' && paneId !== 'w6A:p5',
    });

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC3: pane list CLI error (throw) → null, provisions nothing', async () => {
    seedStaleAnchorState(tmpDir);
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wX', paneId: 'wX:p1' }));
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createWorkspace,
      createTab,
      listTabs: async () => [{ tabId: 'w6A:t2', label: 'WL' }],
      listPanes: async () => { throw new Error('herdr down'); },
      isPaneAlive: async (paneId: string) => paneId !== 'w6A:p1' && paneId !== 'w6A:p5',
    });

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  // AC4 — parent AC3 (second half): two concurrent getDispatcherAnchor
  // callers with a stale anchor produce exactly ONE createWorkspace call
  // (coordination lock + in-lock double-check) and both receive the same
  // anchor. The loser's first stale-pane check is parked until the winner has
  // persisted and released, so its lock attempt lands after — and its
  // double-check adopts the winner's anchor instead of creating a second
  // workspace.
  it('AC4: concurrent stale first-dispatchers create exactly one workspace and both adopt the same anchor', async () => {
    seedStaleAnchorState(tmpDir);
    let releaseSlowCheck!: () => void;
    const slowStaleCheck = new Promise<void>((r) => { releaseSlowCheck = r; });
    let staleChecks = 0;
    const isPaneAlive = vi.fn(async (paneId: string) => {
      staleChecks += 1;
      // The SECOND stale-pane check belongs to the racing caller (call order
      // is deterministic: launch A, launch B, then A's in-lock double-check).
      if (paneId === 'w6A:p1' && staleChecks === 2) await slowStaleCheck;
      return paneId !== 'w6A:p1' && paneId !== 'w6A:p5';
    });
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wB', paneId: 'wB:p1' }));
    const deps: DispatcherAnchorDeps = { createWorkspace, isPaneAlive };

    const first = getDispatcherAnchor('/repo', deps);
    const second = getDispatcherAnchor('/repo', deps);

    // The winner completes fully (provision → persist → release) while the
    // racer is still parked on its initial stale-pane check.
    expect(await first).toEqual({ paneId: 'wB:p1', workspaceId: 'wB' });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(readPersisted()).toEqual({ paneId: 'wB:p1', workspaceId: 'wB' });

    // Release the racer: its lock attempt now succeeds and the in-lock
    // double-check adopts the persisted anchor WITHOUT a second create.
    releaseSlowCheck();
    expect(await second).toEqual({ paneId: 'wB:p1', workspaceId: 'wB' });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });
});

// ── Stale workspace recovery (WL-0MWHCUTDM003B39Q) ─────────────────────

// The fix item: validate the persisted Dispatcher workspace on read and
// re-provision exactly one replacement when it is positively missing. These
// tests seed the recorded pre-fix state (`w6A`, from the sibling guard
// fixture) against injected deps whose probe reports `missing`/`unreadable`
// (AC1/AC3/AC4/AC5/AC8 of WL-0MWHCUTDM003B39Q).

describe('stale workspace recovery — validate on read and re-provision (WL-0MWHCUTDM003B39Q)', () => {
  // AC1 (parent AC1) — the recorded pre-fix state (w6A gone) self-heals:
  // getDispatcherTabAnchor validates the persisted workspace, provisions a
  // fresh Dispatcher workspace and resolves a NEW WL tab in it — instead of
  // failing closed with `null` forever.
  it('AC1: a positively-missing persisted workspace is recovered and a new WL tab anchor is returned', async () => {
    seedStaleAnchorState(tmpDir);
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wB', paneId: 'wB:p1' }));
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeTabDeps({
      createWorkspace,
      createTab,
      probeWorkspace: async () => 'missing',
      isPaneAlive: async (paneId: string) => paneId.startsWith('wB'),
    });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(got).toEqual({ workspaceId: 'wB', tabId: 'wB:tWL', paneId: 'wB:tWL:p1' });
    // Provisioned under the coordination lock, exactly once.
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledWith(DISPATCHER_WORKSPACE_LABEL);
    // Both anchor files are rewritten with the recovered ids (AC5 first half).
    expect(readPersisted()).toEqual({ paneId: 'wB:p1', workspaceId: 'wB' });
    expect(readTabAnchorsPersisted()).toEqual({
      workspaceId: 'wB',
      byPrefix: { WL: { tabId: 'wB:tWL', paneId: 'wB:tWL:p1' } },
    });
  });

  // AC3 (parent AC3, first half) — missing ≠ unreadable: a transient or
  // unreadable herdr still fails closed with `anchor-unavailable` and
  // provisions NOTHING. Only a positively `missing` workspace may recover.
  it('AC3: an unreadable probe fails closed and creates zero workspaces', async () => {
    seedStaleAnchorState(tmpDir);
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wX', paneId: 'wX:p1' }));
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createWorkspace,
      createTab,
      probeWorkspace: async () => 'unreadable',
      isPaneAlive: async () => false,
    });

    expect(await getDispatcherTabAnchor('/repo', deps, 'WL')).toBeNull();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('AC3: an ABSENT probe dep fails closed exactly like unreadable (zero creates)', async () => {
    seedStaleAnchorState(tmpDir);
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wX', paneId: 'wX:p1' }));
    const createTab = vi.fn(async () => null);
    // Raw deps object — deliberately omits probeWorkspace (the optional member
    // must default to `unreadable`, never to `missing`, per the contract).
    const noProbeDeps: DispatcherAnchorDeps = {
      createWorkspace,
      createTab,
      isPaneAlive: async () => false,
      listTabs: async () => [],
    };

    expect(await getDispatcherTabAnchor('/repo', noProbeDeps, 'WL')).toBeNull();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
  });

  // AC4 (parent AC3, second half) — two concurrent first-dispatchers that
  // both observe `missing` create exactly ONE replacement workspace (the
  // coordination lock + in-lock double-check) and both return the same
  // anchor. The second caller's probe is parked until the winner has fully
  // recovered AND resolved its prefix tab, so its recovery double-check
  // adopts the persisted anchor and its tab re-check adopts the created tab.
  it('AC4: concurrent missing-observing callers create exactly one workspace and share the anchor', async () => {
    seedStaleAnchorState(tmpDir);

    // A tiny in-memory herdr so the second caller re-adopts the first
    // caller's tab instead of creating a duplicate.
    const tabs: Record<string, { tabId: string; label: string; paneId: string }> = {};
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wB', paneId: 'wB:p1' }));
    const createTab = vi.fn(async (ws: string, label: string) => {
      const tabId = `${ws}:t${label}`;
      const rec = { tabId, label, paneId: `${tabId}:p1` };
      tabs[tabId] = rec;
      return rec;
    });
    const listTabs = vi.fn(async (ws: string) =>
      Object.values(tabs)
        .filter((rec) => rec.tabId.startsWith(`${ws}:`))
        .map((rec) => ({ tabId: rec.tabId, label: rec.label })),
    );
    const listPanes = vi.fn(async (ws: string) =>
      Object.values(tabs)
        .filter((rec) => rec.tabId.startsWith(`${ws}:`))
        .map((rec) => ({ paneId: rec.paneId, tabId: rec.tabId })),
    );
    const isPaneAlive = vi.fn(async (paneId: string) => paneId.startsWith('wB'));

    let releaseSecondProbe!: () => void;
    const secondProbeGate = new Promise<void>((r) => { releaseSecondProbe = r; });
    let probeCalls = 0;
    const probeWorkspace = vi.fn(async (workspaceId: string) => {
      probeCalls += 1;
      // Park the SECOND caller's probe until the winner has fully recovered.
      if (workspaceId === 'w6A' && probeCalls === 2) await secondProbeGate;
      return 'missing';
    });
    const deps = makeTabDeps({
      createWorkspace, createTab, listTabs, listPanes, isPaneAlive, probeWorkspace,
    });

    const first = getDispatcherTabAnchor('/repo', deps, 'WL');
    const second = getDispatcherTabAnchor('/repo', deps, 'WL');

    // The winner recovers, resolves the WL tab and persists both files while
    // the racer is parked on its probe.
    expect(await first).toEqual({ workspaceId: 'wB', tabId: 'wB:tWL', paneId: 'wB:tWL:p1' });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledTimes(1);

    // Release the racer: its lock attempt now succeeds, the in-lock
    // double-check adopts the persisted anchor and the tab re-check adopts
    // the created tab — no second workspace, no second tab.
    releaseSecondProbe();
    expect(await second).toEqual({ workspaceId: 'wB', tabId: 'wB:tWL', paneId: 'wB:tWL:p1' });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledTimes(1);
  });

  // AC5 — recovery persists BOTH anchors; a second resolution reuses them
  // with no probe and no provisioning (idempotent — no per-tick
  // re-provisioning loop, parent AC5/AC10).
  it('AC5: the recovered anchor is persisted and a second resolution reuses it without re-provisioning', async () => {
    seedStaleAnchorState(tmpDir);
    const createWorkspace = vi.fn(async () => ({ workspaceId: 'wB', paneId: 'wB:p1' }));
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const probeWorkspace = vi.fn(async () => 'missing');
    const isPaneAlive = vi.fn(async (paneId: string) => !paneId.startsWith('w6A'));
    const deps = makeTabDeps({ createWorkspace, createTab, probeWorkspace, isPaneAlive });

    const first = await getDispatcherTabAnchor('/repo', deps, 'WL');
    expect(first).toEqual({ workspaceId: 'wB', tabId: 'wB:tWL', paneId: 'wB:tWL:p1' });
    expect(readPersisted()).toEqual({ paneId: 'wB:p1', workspaceId: 'wB' });
    expect(readTabAnchorsPersisted()).toEqual({
      workspaceId: 'wB',
      byPrefix: { WL: { tabId: 'wB:tWL', paneId: 'wB:tWL:p1' } },
    });

    // Second resolution → healthy fast path: same anchor, no probe (the
    // healthy path never consults the probe — AC8), no createWorkspace.
    const second = await getDispatcherTabAnchor('/repo', deps, 'WL');
    expect(second).toEqual(first);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(probeWorkspace).toHaveBeenCalledTimes(1);
    expect(probeWorkspace).toHaveBeenCalledWith('w6A');
    expect(createTab).toHaveBeenCalledTimes(1);
  });

  // AC8 (parent AC10) — a healthy resolution issues exactly the same herdr
  // calls as today: one pane-liveness check and nothing else. The probe is
  // consulted only after a stale-pane fast-path miss; the placement code
  // path adds no `wl` invocation (the probe's own suite pins the no-wl
  // spawn at the CLI level).
  it('AC8: healthy resolution makes no probe / list / create calls and exactly one liveness check', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    fs.writeFileSync(
      path.join(tmpDir, DISPATCHER_TAB_ANCHORS_FILE),
      JSON.stringify({ workspaceId: 'wD', byPrefix: { WL: { tabId: 'wD:tWL', paneId: 'wD:tWL:p1' } } }),
      'utf-8',
    );
    const probeWorkspace = vi.fn(async () => 'alive');
    const listTabs = vi.fn(async () => [] as DispatcherTabInfo[]);
    const createWorkspace = vi.fn(async () => { throw new Error('must not be called'); });
    const createTab = vi.fn(async () => null);
    const isPaneAlive = vi.fn(async () => true);
    const deps = makeTabDeps({ probeWorkspace, listTabs, createWorkspace, createTab, isPaneAlive });

    const got = await getDispatcherTabAnchor('/repo', deps, 'WL');

    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(probeWorkspace).not.toHaveBeenCalled();
    expect(listTabs).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(createTab).not.toHaveBeenCalled();
    expect(isPaneAlive).toHaveBeenCalledTimes(1);
    expect(isPaneAlive).toHaveBeenCalledWith('wD:tWL:p1');
  });
});

// ── persistPrefixTab pruning (WL-0MWHCUX6A002W8ZG) ──────────────────────
// The persisted per-prefix map is rewritten whenever a dispatch resolves a
// tab; entries whose ids cannot belong to the workspace being written (a
// superseded/dead workspace, or an ill-formed hand-edited id) are pruned so
// dead ids cannot accumulate and mask a later wedge. Herdr ids are
// workspace-scoped (`<workspaceId>:` prefix), so membership is decided from
// the ids alone — no CLI call.

describe('persistPrefixTab pruning (WL-0MWHCUX6A002W8ZG)', () => {
  it('AC2: a dead-workspace entry is dropped on rewrite; live siblings and the upsert survive', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, DISPATCHER_TAB_ANCHORS_FILE),
      JSON.stringify({
        workspaceId: 'w6B',
        byPrefix: {
          // Dead workspace: every id carries the superseded w6A prefix.
          WL: { tabId: 'w6A:t2', paneId: 'w6A:p5' },
          // Live sibling in the workspace being written — must survive.
          TCE: { tabId: 'w6B:t6', paneId: 'w6B:p31' },
        },
      }),
      'utf-8',
    );

    persistPrefixTab(tmpDir, 'w6B', 'WL', 'w6B:t2', 'w6B:p5');

    // AC3: the map-level workspaceId is always the workspace being written.
    expect(readTabAnchorsPersisted()).toEqual({
      workspaceId: 'w6B',
      byPrefix: {
        WL: { tabId: 'w6B:t2', paneId: 'w6B:p5' },
        TCE: { tabId: 'w6B:t6', paneId: 'w6B:p31' },
      },
    });
  });

  it('AC4: after recovery the persisted map carries no dead w6A ids and holds the recovered entry', () => {
    // Seed the recorded pre-fix map (workspaceId w6A owns WL) as-is.
    seedStaleAnchorState(tmpDir);

    // Simulate the first dispatch write after recovery to the new workspace.
    persistPrefixTab(tmpDir, 'w6B', 'WL', 'w6B:t2', 'w6B:p5');

    const persisted = readTabAnchorsPersisted();
    expect(persisted?.workspaceId).toBe('w6B');
    expect(JSON.stringify(persisted)).not.toContain('w6A');
    expect(persisted?.byPrefix.WL).toEqual({ tabId: 'w6B:t2', paneId: 'w6B:p5' });
  });

  it('AC5: two prefixes in the same live workspace are both retained across a rewrite', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, DISPATCHER_TAB_ANCHORS_FILE),
      JSON.stringify({
        workspaceId: 'w6B',
        byPrefix: {
          WL: { tabId: 'w6B:t2', paneId: 'w6B:p5' },
          TCE: { tabId: 'w6B:t6', paneId: 'w6B:p31' },
        },
      }),
      'utf-8',
    );

    persistPrefixTab(tmpDir, 'w6B', 'TCE', 'w6B:t6', 'w6B:p31');

    expect(readTabAnchorsPersisted()).toEqual({
      workspaceId: 'w6B',
      byPrefix: {
        WL: { tabId: 'w6B:t2', paneId: 'w6B:p5' },
        TCE: { tabId: 'w6B:t6', paneId: 'w6B:p31' },
      },
    });
  });

  it('AC6: an ill-formed id (no `<workspaceId>:` prefix) is dropped rather than retained', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, DISPATCHER_TAB_ANCHORS_FILE),
      JSON.stringify({
        workspaceId: 'w6B',
        byPrefix: {
          // Hand-edited: no w6B: prefix, so it can never resolve here.
          WL: { tabId: 't2', paneId: 'p5' },
        },
      }),
      'utf-8',
    );

    persistPrefixTab(tmpDir, 'w6B', 'TCE', 'w6B:t6', 'w6B:p31');

    expect(readTabAnchorsPersisted()).toEqual({
      workspaceId: 'w6B',
      byPrefix: { TCE: { tabId: 'w6B:t6', paneId: 'w6B:p31' } },
    });
  });

  it('AC1/AC7: an ill-formed upsert fails closed (false, nothing written, no tmp residue)', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, DISPATCHER_TAB_ANCHORS_FILE),
      JSON.stringify({ workspaceId: 'w6B', byPrefix: {} }),
      'utf-8',
    );

    expect(persistPrefixTab(tmpDir, 'w6B', 'WL', 't2', 'p5')).toBe(false);
    expect(readTabAnchorsPersisted()).toEqual({ workspaceId: 'w6B', byPrefix: {} });
    expect(fs.existsSync(path.join(tmpDir, `${DISPATCHER_TAB_ANCHORS_FILE}.tmp`))).toBe(false);
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

  // moveTabInWorkspace (WL-0MVZ88G51004IYHW): repositioning fresh interactive
  // tabs via the herdr socket API `tab.move` with `insert_index`. Herdr
  // 0.9.5 has NO `tab move` CLI subcommand, so the call goes straight to the
  // newline-delimited JSON-RPC Unix socket; these are integration tests
  // against a fake socket server that pins the exact frame and fail-open
  // handling.
  type FakeSocket = {
    moveTab: (tabId: string, insertIndex: number) => Promise<boolean>;
    received: string[];
    close: () => Promise<void>;
  };

  async function withFakeSocket(
    handler: (socket: net.Socket, requestId: string) => void,
  ): Promise<FakeSocket> {
    const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-sock-'));
    const sockPath = path.join(sockDir, 'herdr.sock');
    const received: string[] = [];
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        received.push(line);
        const frame = JSON.parse(line) as { id: string };
        handler(socket, frame.id);
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    return {
      moveTab: (tabId: string, insertIndex: number) =>
        moveTabInWorkspace(tabId, insertIndex, sockPath),
      received,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            try { fs.rmSync(sockDir, { recursive: true, force: true }); } catch { /* ignore */ }
            resolve();
          });
        }),
    };
  }

  it('moveTabInWorkspace frames a `tab.move` JSON-RPC request with {tab_id, insert_index}', async () => {
    const fake = await withFakeSocket((socket, id) => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } })}\n`);
    });
    try {
      await expect(fake.moveTab('wC:tItem', 3)).resolves.toBe(true);
      expect(fake.received).toHaveLength(1);
      const frame = JSON.parse(fake.received[0]) as {
        jsonrpc: string;
        method: string;
        params: { tab_id: string; insert_index: number };
      };
      expect(frame.jsonrpc).toBe('2.0');
      expect(frame.method).toBe('tab.move');
      expect(frame.params).toEqual({ tab_id: 'wC:tItem', insert_index: 3 });
    } finally {
      await fake.close();
    }
  });

  it('moveTabInWorkspace returns false (fail-open) on a JSON-RPC error payload', async () => {
    const fake = await withFakeSocket((socket, id) => {
      socket.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: 'no such tab' } })}\n`,
      );
    });
    try {
      await expect(fake.moveTab('wC:tItem', 0)).resolves.toBe(false);
    } finally {
      await fake.close();
    }
  });

  it('moveTabInWorkspace returns false (fail-open) when the socket is unreachable', async () => {
    const bogus = path.join(os.tmpdir(), `no-such-herdr-${Date.now()}.sock`);
    await expect(moveTabInWorkspace('wC:tItem', 0, bogus)).resolves.toBe(false);
  });

  it('moveTabInWorkspace returns false (fail-open) for an invalid tab id / index', async () => {
    await expect(moveTabInWorkspace('', 0, '/tmp/x.sock')).resolves.toBe(false);
    await expect(moveTabInWorkspace('wC:tItem', -1, '/tmp/x.sock')).resolves.toBe(false);
  });

  it('resolveHerdrSocketPath honours HERDR_SOCKET_PATH, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(resolveHerdrSocketPath({ HERDR_SOCKET_PATH: '/tmp/explicit.sock' })).toBe('/tmp/explicit.sock');
    expect(resolveHerdrSocketPath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe('/tmp/xdg/herdr/herdr.sock');
    expect(resolveHerdrSocketPath({})).toBe(path.join(os.homedir(), '.config', 'herdr', 'herdr.sock'));
  });
});
