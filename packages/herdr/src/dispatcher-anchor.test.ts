/**
 * packages/herdr/src/dispatcher-anchor.test.ts — Dispatcher anchor provisioning (F1 WL-0MTR2CD4X006XI7U)
 *
 * ACs: persistence / idempotent provisioning / concurrent safety / stale-pane
 * re-provision / no-op when valid / fail-safe null.
 *
 * Parent: WL-0MTRQT482001SNXC (per-prefix tabs). TC1: types + persistence helpers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDispatcherAnchor,
  getDispatcherTabAnchor,
  DISPATCHER_ANCHOR_FILE,
  DISPATCHER_TAB_ANCHOR_FILE,
  DISPATCHER_WORKSPACE_LABEL,
  type DispatcherAnchor,
  type DispatcherAnchorDeps,
  type DispatcherTabAnchor,
  type DispatcherTabAnchorEntry,
  type DispatcherTabInfo,
  type DispatcherPaneInfo,
  readTabAnchors,
  writeTabAnchors,
  parseTabListOutput,
  parseTabCreateOutput,
  parsePaneListOutput,
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

function readTabAnchorPersisted(): DispatcherTabAnchor | null {
  try {
    const raw = fs.readFileSync(path.join(tmpDir, DISPATCHER_TAB_ANCHOR_FILE), 'utf-8');
    return JSON.parse(raw) as DispatcherTabAnchor;
  } catch { return null; }
}

function writeTabAnchorPersisted(a: DispatcherTabAnchor): void {
  fs.writeFileSync(path.join(tmpDir, DISPATCHER_TAB_ANCHOR_FILE), JSON.stringify(a), 'utf-8');
}

describe('getDispatcherAnchor ACs', () => {
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
    // First call provisions; second call is simulated by pre-holding the lock file.
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
    // cleanup lock for other tests (afterEach removes dir, but be tidy)
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
    // Simulate an unresolvable / uncreatable machine dir by making the dir a file.
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
});

// ── Per-prefix tab anchor tests (TC1: WL-0MU2LC5S00024LL6) ──────────────

describe('readTabAnchors / writeTabAnchors TC1', () => {
  it('TC1-1 readTabAnchors returns empty map when file absent', () => {
    const result = readTabAnchors(tmpDir);
    expect(result).toEqual({ workspaceId: '', byPrefix: {} });
  });

  it('TC1-2 writeTabAnchors creates a valid JSON file', () => {
    const anchors: DispatcherTabAnchor = {
      workspaceId: 'wT',
      byPrefix: {
        WL: { tabId: 'wT:t1', paneId: 'wT:t1:p1' },
      },
    };
    const success = writeTabAnchors(tmpDir, anchors);
    expect(success).toBe(true);
    const persisted = readTabAnchorPersisted();
    expect(persisted).toEqual(anchors);
  });

  it('TC1-3 readTabAnchors returns null on corrupt JSON', () => {
    fs.writeFileSync(path.join(tmpDir, DISPATCHER_TAB_ANCHOR_FILE), 'not json{{{');
    const result = readTabAnchors(tmpDir);
    expect(result).toBeNull();
  });

  it('TC1-4 persistence round-trip: write then read returns same data', () => {
    const anchors: DispatcherTabAnchor = {
      workspaceId: 'wRound',
      byPrefix: {
        WL: { tabId: 'wRound:t1', paneId: 'wRound:t1:p1' },
        TCE: { tabId: 'wRound:t2', paneId: 'wRound:t2:p1' },
      },
    };
    writeTabAnchors(tmpDir, anchors);
    const result = readTabAnchors(tmpDir);
    expect(result).toEqual(anchors);
  });

  it('TC1-5 backward-compat: legacy anchor file yields workspaceId with empty byPrefix', () => {
    // Write only the legacy anchor file (no tab anchor file)
    writePersisted({ paneId: 'wLegacy:p1', workspaceId: 'wLegacy' });
    // Tab anchor file does NOT exist
    const result = readTabAnchors(tmpDir);
    expect(result).toEqual({ workspaceId: 'wLegacy', byPrefix: {} });
  });

  it('TC1-6 backward-compat: corrupt legacy file + no tab file yields empty workspaceId', () => {
    // Write corrupt legacy file
    fs.writeFileSync(path.join(tmpDir, DISPATCHER_ANCHOR_FILE), '{ corrupt');
    const result = readTabAnchors(tmpDir);
    expect(result).toEqual({ workspaceId: '', byPrefix: {} });
  });

  it('handles variant key shapes: tab_id vs tabId, pane_id vs paneId', () => {
    // Write with variant key shapes (simulating older herdr CLI output)
    const variantAnchors: DispatcherTabAnchor = {
      workspaceId: 'wVariant',
      byPrefix: {
        WL: { tabId: 'wVariant:t1', paneId: 'wVariant:t1:p1' },
      },
    };
    writeTabAnchors(tmpDir, variantAnchors);
    // Overwrite with variant shapes
    const raw = JSON.stringify({
      workspace_id: 'wVariant',
      byPrefix: {
        WL: { tab_id: 'wVariant:t1', pane_id: 'wVariant:t1:p1' },
      },
    });
    fs.writeFileSync(path.join(tmpDir, DISPATCHER_TAB_ANCHOR_FILE), raw);
    const result = readTabAnchors(tmpDir);
    expect(result).toEqual({
      workspaceId: 'wVariant',
      byPrefix: {
        WL: { tabId: 'wVariant:t1', paneId: 'wVariant:t1:p1' },
      },
    });
  });

  it('handles empty byPrefix but valid workspaceId', () => {
    const raw = JSON.stringify({ workspaceId: 'wEmpty', byPrefix: {} });
    fs.writeFileSync(path.join(tmpDir, DISPATCHER_TAB_ANCHOR_FILE), raw);
    const result = readTabAnchors(tmpDir);
    expect(result).toEqual({ workspaceId: 'wEmpty', byPrefix: {} });
  });

  it('handles empty file returns null', () => {
    fs.writeFileSync(path.join(tmpDir, DISPATCHER_TAB_ANCHOR_FILE), '');
    const result = readTabAnchors(tmpDir);
    expect(result).toBeNull();
  });

  it('handles whitespace-only file returns null', () => {
    fs.writeFileSync(path.join(tmpDir, DISPATCHER_TAB_ANCHOR_FILE), '   \n  ');
    const result = readTabAnchors(tmpDir);
    expect(result).toBeNull();
  });

  it('writeTabAnchors returns false on I/O error (read-only dir)', () => {
    const anchors: DispatcherTabAnchor = {
      workspaceId: 'w',
      byPrefix: { X: { tabId: 't', paneId: 'p' } },
    };
    // Make the dir read-only so write fails
    fs.chmodSync(tmpDir, 0o444);
    try {
      const success = writeTabAnchors(tmpDir, anchors);
      expect(success).toBe(false);
    } finally {
      fs.chmodSync(tmpDir, 0o755); // restore for cleanup
    }
  });
});

// ── Per-prefix tab anchor provisioning (TC2: WL-0MU2LF6SZ000JQYI) ───────

interface TabDepsOverrides {
  createWorkspace?: DispatcherAnchorDeps['createWorkspace'];
  isPaneAlive?: DispatcherAnchorDeps['isPaneAlive'];
  listTabs?: DispatcherAnchorDeps['listTabs'];
  createTab?: DispatcherAnchorDeps['createTab'];
  listPanes?: DispatcherAnchorDeps['listPanes'];
}

function makeTabDeps(overrides: TabDepsOverrides = {}): DispatcherAnchorDeps {
  return {
    createWorkspace: overrides.createWorkspace ?? (async () => ({ workspaceId: 'wD', paneId: 'wD:p1' })),
    isPaneAlive: overrides.isPaneAlive ?? (async () => true),
    listTabs: overrides.listTabs ?? (async () => [] as DispatcherTabInfo[]),
    createTab: overrides.createTab ?? (async (ws: string, label: string) => ({ tabId: `${ws}:t${label}`, paneId: `${ws}:t${label}:p1` })),
    listPanes: overrides.listPanes ?? (async () => [] as DispatcherPaneInfo[]),
  };
}

describe('getDispatcherTabAnchor ACs (TC2)', () => {
  it('TC2-AC1 first dispatch creates the labelled tab and persists the mapping', async () => {
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeTabDeps({ createTab });
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(createTab).toHaveBeenCalledWith('wD', 'WL');
    const persisted = readTabAnchorPersisted();
    expect(persisted).toEqual({
      workspaceId: 'wD',
      byPrefix: { WL: { tabId: 'wD:tWL', paneId: 'wD:tWL:p1' } },
    });
  });

  it('TC2-AC2 second dispatch reuses the persisted tab without creating', async () => {
    writeTabAnchorPersisted({
      workspaceId: 'wD',
      byPrefix: { WL: { tabId: 'wD:tWL', paneId: 'wD:tWL:p1' } },
    });
    const createTab = vi.fn(async () => null);
    const createWorkspace = vi.fn(async () => {
      throw new Error('should not provision workspace');
    });
    const deps = makeTabDeps({
      createTab,
      createWorkspace: createWorkspace as unknown as DispatcherAnchorDeps['createWorkspace'],
      isPaneAlive: async () => true,
    });
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(createTab).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('TC2-AC2 stale persisted pane is re-created (dead tab replaced)', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    writeTabAnchorPersisted({
      workspaceId: 'wD',
      byPrefix: { WL: { tabId: 'wD:tWL', paneId: 'wD:tWL:pDEAD' } },
    });
    const createTab = vi.fn(async (ws: string) => ({ tabId: `${ws}:tWL2`, paneId: `${ws}:tWL2:p1` }));
    const deps = makeTabDeps({
      createTab,
      isPaneAlive: async (paneId: string) => paneId !== 'wD:tWL:pDEAD',
      // The dead tab is still listed, but its only pane is dead.
      listTabs: async () => [{ tabId: 'wD:tWL', label: 'WL' }],
      listPanes: async () => [{ paneId: 'wD:tWL:pDEAD', tabId: 'wD:tWL' }],
    });
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL2', paneId: 'wD:tWL2:p1' });
    expect(createTab).toHaveBeenCalledWith('wD', 'WL');
    const persisted = readTabAnchorPersisted();
    expect(persisted?.byPrefix.WL).toEqual({ tabId: 'wD:tWL2', paneId: 'wD:tWL2:p1' });
  });

  it('adopts an unpersisted matching tab when its anchor pane is alive', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    writeTabAnchorPersisted({ workspaceId: 'wD', byPrefix: {} });
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createTab,
      listTabs: async () => [{ tabId: 'wD:tWL', label: 'WL' }],
      listPanes: async () => [{ paneId: 'wD:tWL:p1', tabId: 'wD:tWL' }],
      isPaneAlive: async () => true,
    });
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(createTab).not.toHaveBeenCalled();
    const persisted = readTabAnchorPersisted();
    expect(persisted?.byPrefix.WL).toEqual({ tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
  });

  it('TC2-AC3 concurrent first-dispatches do not duplicate (lock held, no entry → fail closed)', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    // Simulate another holder by pre-creating the lock file.
    const lockPath = path.join(tmpDir, 'downtime-coordination.lock');
    fs.writeFileSync(lockPath, '');
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({ createTab });
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toBeNull();
    expect(createTab).not.toHaveBeenCalled();
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  });

  it('does not duplicate when lock is held but the winner already persisted', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    writeTabAnchorPersisted({
      workspaceId: 'wD',
      byPrefix: { WL: { tabId: 'wD:tWL', paneId: 'wD:tWL:p1' } },
    });
    const lockPath = path.join(tmpDir, 'downtime-coordination.lock');
    fs.writeFileSync(lockPath, '');
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createTab,
      // re-read after lock contention is what the winner wrote
      isPaneAlive: async () => true,
    });
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    expect(createTab).not.toHaveBeenCalled();
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  });

  it('TC2-AC4 fail-closed: unparseable `tab list` → null, never creates a duplicate', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    const createTab = vi.fn(async () => null);
    const deps = makeTabDeps({
      createTab,
      listTabs: async () => null, // parse failure
    });
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toBeNull();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('TC2-AC4 fail-closed: `tab create` returns null (unparseable output) → null, nothing persisted', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    const deps = makeTabDeps({ createTab: async () => null });
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toBeNull();
    // No WL entry may be persisted — the map stays empty (legacy anchor only).
    const persisted = readTabAnchors(tmpDir);
    expect(persisted?.byPrefix).toEqual({});
  });

  it('preserves other prefixes when persisting a new one', async () => {
    writePersisted({ paneId: 'wD:p1', workspaceId: 'wD' });
    writeTabAnchorPersisted({
      workspaceId: 'wD',
      byPrefix: { TCE: { tabId: 'wD:tTCE', paneId: 'wD:tTCE:p1' } },
    });
    const createTab = vi.fn(async (ws: string) => ({ tabId: `${ws}:tWL`, paneId: `${ws}:tWL:p1` }));
    const deps = makeTabDeps({ createTab });
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toEqual({ workspaceId: 'wD', tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
    const persisted = readTabAnchorPersisted();
    expect(persisted?.byPrefix.TCE).toEqual({ tabId: 'wD:tTCE', paneId: 'wD:tTCE:p1' });
    expect(persisted?.byPrefix.WL).toEqual({ tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
  });

  it('empty prefix fails closed (no dispatch)', async () => {
    const deps = makeTabDeps();
    const got = await getDispatcherTabAnchor(tmpDir, deps, '');
    expect(got).toBeNull();
  });

  it('machine dir unresolvable → null', async () => {
    const fileAsDir = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(fileAsDir, 'x');
    process.env.HERDR_COORDINATION_DIR = fileAsDir;
    const deps = makeTabDeps();
    const got = await getDispatcherTabAnchor(tmpDir, deps, 'WL');
    expect(got).toBeNull();
  });
});

describe('tab CLI parsers (TC2)', () => {
  it('parseTabListOutput: live nested result shape', () => {
    const raw = '{"id":"cli:tab:list","result":{"tabs":[{"label":"WL","tab_id":"wD:tWL"},{"label":"Worklog","tab_id":"wD:tX"}]}}';
    expect(parseTabListOutput(raw)).toEqual([
      { tabId: 'wD:tWL', label: 'WL' },
      { tabId: 'wD:tX', label: 'Worklog' },
    ]);
  });

  it('parseTabListOutput: camelCase keys and log-line prefix tolerated', () => {
    const raw = 'some log line\n{"result":{"tabs":[{"tabId":"wD:tWL","title":"WL"}]}}';
    expect(parseTabListOutput(raw)).toEqual([{ tabId: 'wD:tWL', label: 'WL' }]);
  });

  it('parseTabListOutput: bare tabs array without envelope', () => {
    const raw = '{"tabs":[{"tab_id":"t1","label":"A"}]}';
    expect(parseTabListOutput(raw)).toEqual([{ tabId: 't1', label: 'A' }]);
  });

  it('parseTabListOutput: null on garbage / missing tabs array', () => {
    expect(parseTabListOutput('not json')).toBeNull();
    expect(parseTabListOutput('{}')).toBeNull();
    expect(parseTabListOutput('{"result":{"tabs":"nope"}}')).toBeNull();
  });

  it('parseTabCreateOutput: live nested tab + root_pane shape', () => {
    const raw = '{"id":"cli:tab:create","result":{"root_pane":{"pane_id":"wD:tWL:p1"},"tab":{"tab_id":"wD:tWL","label":"WL"}}}';
    expect(parseTabCreateOutput(raw)).toEqual({ tabId: 'wD:tWL', paneId: 'wD:tWL:p1' });
  });

  it('parseTabCreateOutput: camelCase variants', () => {
    const raw = '{"result":{"rootPane":{"paneId":"p9"},"tab":{"tabId":"t9"}}}';
    expect(parseTabCreateOutput(raw)).toEqual({ tabId: 't9', paneId: 'p9' });
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
});
