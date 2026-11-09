/**
 * packages/herdr/src/index.interactive.test.ts — interactive item-tab anchor
 * placement, root-pane cleanup and operator-dispatch priority tests
 * (work item WL-0MVOA238A0078J2H).
 *
 * Moved verbatim from the monolithic `index.test.ts`.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSendToPiArgs,
  extractWorkItemId,
  resolveInteractiveDispatchPriority,
  spawnBackgroundPi,
} from './index.js';
import { resetExecFileAsync, setExecFileAsync } from './fetcher.js';
import {
  setupHostCpuPin,
  makeInteractiveAnchorDeps,
  buildSendToPiArgsWithPriority,
  resolveInteractiveDispatchPriorityWithLookup,
  paneDispatchPriority,
  type DispatcherAnchorDeps,
  type DispatcherTabInfo,
  type ItemTabAnchor,
} from './index.fixtures.js';

setupHostCpuPin();

type InteractiveAnchorHelpers = {
  resolveInteractiveWorkspaceId?: (
    env?: Record<string, string | undefined>,
  ) => string | null;
  resolveInteractiveItemAnchor?: (
    cwd: string,
    workspaceId: string,
    itemId: string,
    deps?: DispatcherAnchorDeps,
    onCreate?: (anchor: ItemTabAnchor) => void,
    placementMode?: string,
  ) => Promise<ItemTabAnchor | null>;
  resolveInteractiveItemAnchorAfterAdmission?: (
    admitted: boolean,
    cwd: string,
    workspaceId: string,
    itemId: string | undefined,
    deps?: DispatcherAnchorDeps,
    onCreate?: (anchor: ItemTabAnchor) => void,
    placementMode?: string,
  ) => Promise<ItemTabAnchor | null>;
};

// The dynamic `import('./index.js')` helper is deliberately co-located with
// its consumers: the index split guard's dynamic-import scan discovers barrel
// symbols through a same-file helper cast, so moving it to `index.fixtures.ts`
// would under-freeze those symbols in the baseline.
async function loadInteractiveAnchorHelpers(): Promise<InteractiveAnchorHelpers> {
  return (await import('./index.js')) as unknown as InteractiveAnchorHelpers;
}

describe('extractWorkItemId — no-ID fallback (AC4)', () => {
  it('returns undefined for a blank /prompt: session (Open Pi Agent / P n)', () => {
    expect(extractWorkItemId('/prompt:')).toBeUndefined();
  });

  it('returns undefined for generic commands with no work-item ID', () => {
    expect(extractWorkItemId('ls -la')).toBeUndefined();
    expect(extractWorkItemId('wl search test')).toBeUndefined();
    expect(extractWorkItemId('wl update <id> --priority high')).toBeUndefined();
  });

  it('returns the work-item ID when one is present (both channels)', () => {
    expect(extractWorkItemId('/skill:implement WL-ABC')).toBe('WL-ABC');
    expect(extractWorkItemId('!!wl update WL-ABC --priority high')).toBe('WL-ABC');
  });
});

describe('resolveInteractiveWorkspaceId (AC1/AC2)', () => {
  it('returns HERDR_WORKSPACE_ID when set', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    expect(helpers.resolveInteractiveWorkspaceId!({ HERDR_WORKSPACE_ID: 'w45' })).toBe('w45');
  });

  it('returns null when HERDR_WORKSPACE_ID is unset', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    expect(helpers.resolveInteractiveWorkspaceId!({})).toBeNull();
  });

  it('treats a blank HERDR_WORKSPACE_ID as absent (fail-open to the current pane)', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    expect(helpers.resolveInteractiveWorkspaceId!({ HERDR_WORKSPACE_ID: '' })).toBeNull();
    expect(helpers.resolveInteractiveWorkspaceId!({ HERDR_WORKSPACE_ID: '   ' })).toBeNull();
  });

  it('defaults to process.env.HERDR_WORKSPACE_ID', async () => {
    const saved = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = 'w77';
    try {
      const helpers = await loadInteractiveAnchorHelpers();
      expect(helpers.resolveInteractiveWorkspaceId!()).toBe('w77');
    } finally {
      if (saved === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = saved;
    }
  });
});

describe('resolveInteractiveItemAnchor (AC3/AC5)', () => {
  let coordDir: string;
  let savedCoord: string | undefined;

  beforeEach(() => {
    coordDir = mkdtempSync(join(tmpdir(), 'interactive-anchor-'));
    savedCoord = process.env.HERDR_COORDINATION_DIR;
    process.env.HERDR_COORDINATION_DIR = coordDir;
  });

  afterEach(() => {
    if (savedCoord === undefined) delete process.env.HERDR_COORDINATION_DIR;
    else process.env.HERDR_COORDINATION_DIR = savedCoord;
    try { rmSync(coordDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC3: first call creates the exact item-ID tab and returns its anchor pane', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeInteractiveAnchorDeps({ createTab });

    const got = await helpers.resolveInteractiveItemAnchor!('/repo', 'w9', 'WL-ABC', deps);

    expect(got).toEqual({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
    expect(createTab).toHaveBeenCalledWith('w9', 'WL-ABC');
  });

  it('AC3: second call for the same workspace + item reuses the tab (no duplicate create)', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const tabs: DispatcherTabInfo[] = [];
    const createTab = vi.fn(async (ws: string, label: string) => {
      const anchor = { tabId: `${ws}:t${label}`, paneId: `${ws}:t${label}:p1` };
      tabs.push({ tabId: anchor.tabId, label });
      return anchor;
    });
    const deps = makeInteractiveAnchorDeps({
      createTab,
      listTabs: async () => tabs.map((t) => ({ ...t })),
      listPanes: async () => tabs.map((t) => ({ paneId: `${t.tabId}:p1`, tabId: t.tabId })),
      isPaneAlive: async () => true,
    });

    const first = await helpers.resolveInteractiveItemAnchor!('/repo', 'w9', 'WL-ABC', deps);
    const second = await helpers.resolveInteractiveItemAnchor!('/repo', 'w9', 'WL-ABC', deps);

    expect(first).toEqual({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
    expect(second).toEqual(first);
    expect(createTab).toHaveBeenCalledTimes(1);
  });

  it('AC5 fail-open: tab resolution throws → null (never throws)', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const deps = makeInteractiveAnchorDeps({
      listTabs: async () => { throw new Error('herdr tab list failed'); },
    });
    await expect(helpers.resolveInteractiveItemAnchor!('/repo', 'w9', 'WL-ABC', deps)).resolves.toBeNull();
  });

  it('AC5 fail-open: tab creation returns null → null', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const deps = makeInteractiveAnchorDeps({ createTab: async () => null });
    await expect(helpers.resolveInteractiveItemAnchor!('/repo', 'w9', 'WL-ABC', deps)).resolves.toBeNull();
  });

  it('AC5 fail-open: tab creation throws → null', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const deps = makeInteractiveAnchorDeps({
      createTab: async () => { throw new Error('herdr tab create failed'); },
    });
    await expect(helpers.resolveInteractiveItemAnchor!('/repo', 'w9', 'WL-ABC', deps)).resolves.toBeNull();
  });

  it('AC5 guard: empty workspace id or item id → null', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const deps = makeInteractiveAnchorDeps();
    await expect(helpers.resolveInteractiveItemAnchor!('/repo', '', 'WL-ABC', deps)).resolves.toBeNull();
    await expect(helpers.resolveInteractiveItemAnchor!('/repo', 'w9', '', deps)).resolves.toBeNull();
  });

  // Create-vs-reuse signal (WL-0MUYI3K8H007MPKF, AC7): the observer fires ONLY
  // when the tab is provisioned, so the interactive path can gate cleanup on a
  // genuine create.
  it('AC7: forwards the onCreate observer when the tab is provisioned', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const onCreate = vi.fn();
    const deps = makeInteractiveAnchorDeps();
    await helpers.resolveInteractiveItemAnchor!('/repo', 'w9', 'WL-ABC', deps, onCreate);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
  });

  it('AC7: does NOT forward the onCreate observer when the tab is reused', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const onCreate = vi.fn();
    const deps = makeInteractiveAnchorDeps({
      listTabs: async () => [{ tabId: 'w9:tWL-ABC', label: 'WL-ABC' }],
      listPanes: async () => [{ paneId: 'w9:tWL-ABC:p1', tabId: 'w9:tWL-ABC' }],
    });
    const got = await helpers.resolveInteractiveItemAnchor!('/repo', 'w9', 'WL-ABC', deps, onCreate);
    expect(got).toEqual({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
    expect(onCreate).not.toHaveBeenCalled();
  });

  // Left-of-extensions placement (WL-0MVZ88G51004IYHW): operator-created tabs
  // land immediately left of the Worklog/extensions tab; dispatcher tabs stay
  // right; fail-open at every boundary.
  it('left-of-extensions: a fresh interactive tab is moved to the extensions tab index', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const moveTab = vi.fn(async () => true);
    const deps = makeInteractiveAnchorDeps({
      moveTab,
      listTabs: async () => [
        { tabId: 'w9:tWorklog', label: 'Worklog' },
        { tabId: 'w9:tDrop', label: 'Downtime' },
      ],
      listMachinePanes: async () => [
        { paneId: 'w9:pB', workspaceId: 'w9', tabId: 'w9:tWorklog', label: 'Work Items', focused: false },
      ],
    });
    const got = await helpers.resolveInteractiveItemAnchor!(
      '/repo', 'w9', 'WL-ABC', deps, undefined, 'left-of-extensions',
    );
    expect(got).toEqual({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
    expect(moveTab).toHaveBeenCalledTimes(1);
    expect(moveTab).toHaveBeenCalledWith('w9', 'w9:tWL-ABC', 0);
  });

  it('left-of-extensions: a reused interactive tab is NEVER moved', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const moveTab = vi.fn(async () => true);
    const deps = makeInteractiveAnchorDeps({
      moveTab,
      listTabs: async () => [{ tabId: 'w9:tWL-ABC', label: 'WL-ABC' }],
      listPanes: async () => [{ paneId: 'w9:tWL-ABC:p1', tabId: 'w9:tWL-ABC' }],
    });
    const got = await helpers.resolveInteractiveItemAnchor!(
      '/repo', 'w9', 'WL-ABC', deps, undefined, 'left-of-extensions',
    );
    expect(got).toEqual({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
    expect(moveTab).not.toHaveBeenCalled();
  });

  it('default placement (right): an interactive anchor without a placement mode is NOT moved', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const moveTab = vi.fn(async () => true);
    const deps = makeInteractiveAnchorDeps({ moveTab });
    const got = await helpers.resolveInteractiveItemAnchor!('/repo', 'w9', 'WL-ABC', deps);
    expect(got).toEqual({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
    expect(moveTab).not.toHaveBeenCalled();
  });

  it('fail-open: extensions tab unavailable → fresh tab stays, dispatch anchor still returned', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const moveTab = vi.fn(async () => true);
    const deps = makeInteractiveAnchorDeps({
      moveTab,
      listTabs: async () => [{ tabId: 'w9:tDrop', label: 'Downtime' }],
      listMachinePanes: async () => [],
    });
    const got = await helpers.resolveInteractiveItemAnchor!(
      '/repo', 'w9', 'WL-ABC', deps, undefined, 'left-of-extensions',
    );
    expect(got).toEqual({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
    expect(moveTab).not.toHaveBeenCalled();
  });

  it('fail-open: moveTab failure → fresh tab stays at default right position', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const moveTab = vi.fn(async () => false);
    const deps = makeInteractiveAnchorDeps({
      moveTab,
      listTabs: async () => [{ tabId: 'w9:tWorklog', label: 'Worklog' }],
      listMachinePanes: async () => [],
    });
    const got = await helpers.resolveInteractiveItemAnchor!(
      '/repo', 'w9', 'WL-ABC', deps, undefined, 'left-of-extensions',
    );
    expect(got).toEqual({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
  });
});

// ---------------------------------------------------------------------------
// Admission-gated interactive provisioning (WL-0MW5JE0SZ0057K30)
//
// The interactive agent dispatch used to provision the item-ID tab BEFORE the
// host-budget dialog, so a cancel left an orphaned empty pane in a fresh item
// tab. The helper must therefore be a hard no-op unless the dispatch was
// admitted (`admitted === false`) or carries no work-item id.
// ---------------------------------------------------------------------------

describe('resolveInteractiveItemAnchorAfterAdmission (WL-0MW5JE0SZ0057K30)', () => {
  let coordDir: string;
  let savedCoord: string | undefined;

  beforeEach(() => {
    coordDir = mkdtempSync(join(tmpdir(), 'interactive-admission-'));
    savedCoord = process.env.HERDR_COORDINATION_DIR;
    process.env.HERDR_COORDINATION_DIR = coordDir;
  });

  afterEach(() => {
    if (savedCoord === undefined) delete process.env.HERDR_COORDINATION_DIR;
    else process.env.HERDR_COORDINATION_DIR = savedCoord;
    try { rmSync(coordDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('provisions NOTHING when the dispatch was refused (cancelled)', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeInteractiveAnchorDeps({ createTab });

    const got = await helpers.resolveInteractiveItemAnchorAfterAdmission!(
      false,
      '/repo',
      'w9',
      'WL-ABC',
      deps,
    );

    expect(got).toBeNull();
    // The tab (and therefore herdr's placeholder root pane) was never created.
    expect(createTab).not.toHaveBeenCalled();
  });

  it('provisions the item tab once the dispatch is admitted', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const createTab = vi.fn(async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }));
    const deps = makeInteractiveAnchorDeps({ createTab });

    const got = await helpers.resolveInteractiveItemAnchorAfterAdmission!(
      true,
      '/repo',
      'w9',
      'WL-ABC',
      deps,
    );

    expect(got).toEqual({ tabId: 'w9:tWL-ABC', paneId: 'w9:tWL-ABC:p1' });
    expect(createTab).toHaveBeenCalledWith('w9', 'WL-ABC');
  });

  it('provisions NOTHING for a command with no work-item id', async () => {
    const helpers = await loadInteractiveAnchorHelpers();
    const createTab = vi.fn();
    const deps = makeInteractiveAnchorDeps({ createTab });

    const got = await helpers.resolveInteractiveItemAnchorAfterAdmission!(
      true,
      '/repo',
      'w9',
      undefined,
      deps,
    );

    expect(got).toBeNull();
    expect(createTab).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Default interactive liveness resolver (WL-0MUYI3K8H007MPKF, AC7)
//
// The helper contract is exercised with injected deps above; these tests pin
// the PRODUCTION resolver's classification: a freshly created placeholder root
// pane (no agent, no shell label) is excluded, while a live pi agent pane or a
// shell-command pane is included so a reused anchor survives cleanup.
// ---------------------------------------------------------------------------

describe('defaultInteractiveLiveTrackedPanesResolver (AC7)', () => {
  afterEach(() => {
    resetExecFileAsync();
  });

  function mockPaneList(panes: unknown[]): void {
    setExecFileAsync(
      vi.fn().mockResolvedValue({ stdout: JSON.stringify({ result: { panes } }), stderr: '' }) as never,
    );
  }

  it('excludes a placeholder root pane and includes live pi/shell panes', async () => {
    const { defaultInteractiveLiveTrackedPanesResolver } = await import('./index.js');
    mockPaneList([
      { pane_id: 'w9:tWL-ABC:p1', label: '', agent: '', agent_status: '' },
      { pane_id: 'w9:tWL-ABC:p2', label: 'Manually triggered implement - WL-ABC', agent: 'pi', agent_status: 'working' },
      { pane_id: 'w9:tWL-ABC:p3', label: 'Shell: wl update WL-ABC', agent: '', agent_status: '' },
    ]);
    const result = await defaultInteractiveLiveTrackedPanesResolver('/repo');
    expect(result.ok).toBe(true);
    expect(result.paneIds).toEqual(['w9:tWL-ABC:p2', 'w9:tWL-ABC:p3']);
  });

  it('excludes terminal (done/exited) agent panes', async () => {
    const { defaultInteractiveLiveTrackedPanesResolver } = await import('./index.js');
    mockPaneList([
      { pane_id: 'w9:tWL-ABC:p2', label: 'Manually triggered implement', agent: 'pi', agent_status: 'done' },
    ]);
    const result = await defaultInteractiveLiveTrackedPanesResolver('/repo');
    expect(result).toEqual({ ok: true, paneIds: [] });
  });

  it('fail-safe: an unparseable pane list resolves {ok:false}', async () => {
    const { defaultInteractiveLiveTrackedPanesResolver } = await import('./index.js');
    setExecFileAsync(vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' }) as never);
    const result = await defaultInteractiveLiveTrackedPanesResolver('/repo');
    expect(result.ok).toBe(false);
  });

  it('fail-safe: a throwing herdr invocation resolves {ok:false}', async () => {
    const { defaultInteractiveLiveTrackedPanesResolver } = await import('./index.js');
    setExecFileAsync(vi.fn().mockRejectedValue(new Error('herdr unavailable')) as never);
    const result = await defaultInteractiveLiveTrackedPanesResolver('/repo');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interactive item-tab root-pane cleanup (WL-0MUYI3JRC006115V, test-first)
//
// TDD red phase: the interactive dispatch path does NOT yet close the
// placeholder root pane after the first pane spawns into a freshly created
// item tab, so `closeInteractiveTabRootPane` is not exported. These tests pin
// the interface agreed with the sibling implementation child
// (WL-0MUYI3K8H007MPKF) and go green when it lands (parent WL-0MUKZGEQ2007FECS,
// AC7/AC8). The dynamic import keeps the suite green in the red phase — only
// these new cases fail.
//
// Pinned contract (parent AC7):
//   closeInteractiveTabRootPane(anchorPaneId, ctx, deps)
//     - closes the anchor pane only when liveness POSITIVELY confirms it is
//       NOT a live tracked pi/shell pane;
//     - leaves the anchor open when liveness is unknown/unavailable (fail-safe)
//       or when the anchor IS a live tracked pane;
//     - never throws (fail-open) — cleanup errors never change the dispatch
//       outcome.
//
// The liveness dep mirrors the downtime path's `getRunningDowntimePanes`
// (`{ok:true, paneIds}` / `{ok:false}`): `getLiveTrackedPanes(cwd)` returns the
// ids of panes currently hosting a tracked pi/shell session, or `{ok:false}`
// when the probe cannot be answered. `closePane(paneId, cwd)` mirrors the
// existing herdr close convention.
// ---------------------------------------------------------------------------

type InteractiveRootPaneCleanupDeps = {
  /** Live tracked pi/shell pane ids, or `{ok:false}` when unknown. */
  getLiveTrackedPanes?: (cwd: string) => Promise<{ ok: boolean; paneIds?: string[] }>;
  /** Close a pane; may reject (the helper swallows it). */
  closePane?: (paneId: string, cwd: string) => Promise<boolean>;
};

type InteractiveRootPaneCleanupHelpers = {
  closeInteractiveTabRootPane?: (
    anchorPaneId: string | undefined,
    ctx: { cwd: string },
    deps: InteractiveRootPaneCleanupDeps,
  ) => Promise<void>;
};

async function loadInteractiveCleanupHelpers(): Promise<InteractiveRootPaneCleanupHelpers> {
  return (await import('./index.js')) as unknown as InteractiveRootPaneCleanupHelpers;
}

describe('closeInteractiveTabRootPane — interactive root-pane cleanup (AC7/AC8)', () => {
  const ANCHOR = 'w9:tWL-ABC:p1';
  const CWD = '/repo';

  it('AC7: closes the placeholder root pane after a spawn into a freshly created item tab', async () => {
    const helpers = await loadInteractiveCleanupHelpers();
    const closePane = vi.fn().mockResolvedValue(true);
    // A freshly created item tab's placeholder root pane hosts no tracked
    // pi/shell pane → liveness positively excludes the anchor → close it.
    await helpers.closeInteractiveTabRootPane!(
      ANCHOR,
      { cwd: CWD },
      {
        getLiveTrackedPanes: vi.fn().mockResolvedValue({ ok: true, paneIds: [] }),
        closePane,
      },
    );
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(closePane).toHaveBeenCalledWith(ANCHOR, CWD);
  });

  it('AC7: NEVER closes a reused live tracked pane (existing item-tab anchor)', async () => {
    const helpers = await loadInteractiveCleanupHelpers();
    const closePane = vi.fn().mockResolvedValue(true);
    await helpers.closeInteractiveTabRootPane!(
      ANCHOR,
      { cwd: CWD },
      {
        getLiveTrackedPanes: vi
          .fn()
          .mockResolvedValue({ ok: true, paneIds: ['w9:tWL-ABC:p2', ANCHOR] }),
        closePane,
      },
    );
    expect(closePane).not.toHaveBeenCalled();
  });

  it('AC7 fail-safe: a failed liveness query (ok:false) leaves the anchor open', async () => {
    const helpers = await loadInteractiveCleanupHelpers();
    const closePane = vi.fn().mockResolvedValue(true);
    await helpers.closeInteractiveTabRootPane!(
      ANCHOR,
      { cwd: CWD },
      {
        getLiveTrackedPanes: vi
          .fn()
          .mockResolvedValue({ ok: false, error: 'herdr unavailable' }),
        closePane,
      },
    );
    expect(closePane).not.toHaveBeenCalled();
  });

  it('AC7 fail-safe: an absent liveness dep leaves the anchor open', async () => {
    const helpers = await loadInteractiveCleanupHelpers();
    const closePane = vi.fn().mockResolvedValue(true);
    await helpers.closeInteractiveTabRootPane!(ANCHOR, { cwd: CWD }, { closePane });
    expect(closePane).not.toHaveBeenCalled();
  });

  it('AC7 fail-safe: a liveness payload without paneIds is treated as unknown', async () => {
    const helpers = await loadInteractiveCleanupHelpers();
    const closePane = vi.fn().mockResolvedValue(true);
    await helpers.closeInteractiveTabRootPane!(
      ANCHOR,
      { cwd: CWD },
      { getLiveTrackedPanes: vi.fn().mockResolvedValue({ ok: true }), closePane },
    );
    expect(closePane).not.toHaveBeenCalled();
  });

  it('AC7 fail-safe: a throwing liveness probe never throws and leaves the anchor open', async () => {
    const helpers = await loadInteractiveCleanupHelpers();
    const closePane = vi.fn().mockResolvedValue(true);
    await expect(
      helpers.closeInteractiveTabRootPane!(
        ANCHOR,
        { cwd: CWD },
        {
          getLiveTrackedPanes: vi
            .fn()
            .mockRejectedValue(new Error('herdr pane list blew up')),
          closePane,
        },
      ),
    ).resolves.toBeUndefined();
    expect(closePane).not.toHaveBeenCalled();
  });

  it('AC7 fail-open: a throwing closePane never throws (dispatch outcome unchanged)', async () => {
    const helpers = await loadInteractiveCleanupHelpers();
    const closePane = vi.fn().mockRejectedValue(new Error('herdr pane close blew up'));
    await expect(
      helpers.closeInteractiveTabRootPane!(
        ANCHOR,
        { cwd: CWD },
        {
          getLiveTrackedPanes: vi.fn().mockResolvedValue({ ok: true, paneIds: [] }),
          closePane,
        },
      ),
    ).resolves.toBeUndefined();
    expect(closePane).toHaveBeenCalledTimes(1);
  });

  it('AC7: a missing anchor (no item tab) is a no-op', async () => {
    const helpers = await loadInteractiveCleanupHelpers();
    const closePane = vi.fn().mockResolvedValue(true);
    const getLiveTrackedPanes = vi.fn().mockResolvedValue({ ok: true, paneIds: [] });
    await helpers.closeInteractiveTabRootPane!(
      undefined,
      { cwd: CWD },
      { getLiveTrackedPanes, closePane },
    );
    expect(getLiveTrackedPanes).not.toHaveBeenCalled();
    expect(closePane).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// End-to-end validation of the interactive (operator) dispatch priority chain
// (WL-0MVGC6JVP00812DS, parent WL-0MVE1NZ4J000H5NH)
//
// The interactive dispatch path was built (WL-0MVF3Q3VL000UNCN) to send an
// operator-dispatched work item's priority to the proxy as a per-request
// `X-Priority` header so it outranks unattended background work. The mapping
// functions, the argument builder and the Pi extension are unit-tested, but
// the seam `resolveInteractiveDispatchPriority` — as wired in `onCommand`:
// `extractWorkItemId(command)` → `wl show` lookup → interactive mapping —
// had no direct test. These specs validate the whole chain end to end:
//
//   work item priority → resolveInteractiveDispatchPriority →
//     --request-priority (buildSendToPiArgs, pane path) /
//     HERDR_REQUEST_PRIORITY (spawnBackgroundPi, headless path)
//
// The parent AC2 mapping table and the fail-open contract are FIXED: the
// assertions below pin that they hold for a real operator dispatch, and are
// characterisation-style where the code already behaves. The injected-lookup
// form of `resolveInteractiveDispatchPriority` (itemId, lookup) is the seam
// AC1 names; it was missing from the production signature and is added by
// this item's minimal wiring fix.
// ---------------------------------------------------------------------------

/**
 * Target signature of `resolveInteractiveDispatchPriority` once the
 * injectable lookup seam lands (AC1: `resolveInteractiveDispatchPriority(
 * commandId, lookup)`). Declared here so the injected-lookup specs fail RED
 * before the production signature is widened.
 */

describe('resolveInteractiveDispatchPriority — interactive operator dispatch seam (WL-0MVGC6JVP00812DS AC1)', () => {
  afterEach(() => {
    resetExecFileAsync();
  });

  it('maps each operator-dispatched work item priority through the interactive table', async () => {
    const cases: Array<[string, 'medium' | 'high']> = [
      ['low', 'medium'],
      ['medium', 'high'],
      ['high', 'high'],
      ['critical', 'high'],
    ];
    for (const [workItemPriority, expected] of cases) {
      await expect(
        resolveInteractiveDispatchPriorityWithLookup('WL-1', () => workItemPriority),
      ).resolves.toBe(expected);
    }
  });

  it('uses the injected lookup only when an id resolves (driveable seam)', async () => {
    const lookup = vi.fn(() => 'low');
    const resolved = await resolveInteractiveDispatchPriorityWithLookup('WL-1', lookup);
    expect(resolved).toBe('medium');
    expect(lookup).toHaveBeenCalledWith('WL-1');

    // Without an id the lookup is never consulted (fail-open default).
    await expect(
      resolveInteractiveDispatchPriorityWithLookup(undefined, lookup),
    ).resolves.toBe('high');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('fails open to high when the lookup returns nothing', async () => {
    await expect(
      resolveInteractiveDispatchPriorityWithLookup('WL-1', () => undefined),
    ).resolves.toBe('high');
    await expect(
      resolveInteractiveDispatchPriorityWithLookup('WL-1', () => null),
    ).resolves.toBe('high');
  });

  it('fails open to high when the lookup throws (dispatch never blocked)', async () => {
    await expect(
      resolveInteractiveDispatchPriorityWithLookup('WL-1', () => {
        throw new Error('wl show failed');
      }),
    ).resolves.toBe('high');
  });

  it('fails open to high when the lookup times out (dispatch never blocked)', async () => {
    const hangingLookup = () => new Promise<string | undefined>(() => {});
    await expect(
      resolveInteractiveDispatchPriorityWithLookup('WL-1', hangingLookup, 10),
    ).resolves.toBe('high');
  });

  it('drives the production wl show lookup: extractWorkItemId → wl show → interactive mapping', async () => {
    // Real wiring: the command's work-item id is extracted by
    // extractWorkItemId and resolved through the same seam `onCommand` uses.
    const command = '/skill:implement WL-0MVGC6JVP00812DS';
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        workItem: {
          id: 'WL-0MVGC6JVP00812DS',
          title: 'A dispatchable item',
          status: 'open',
          priority: 'critical',
        },
      }),
      stderr: '',
    });
    setExecFileAsync(mockExec as never);

    const itemId = extractWorkItemId(command);
    await expect(resolveInteractiveDispatchPriority(itemId)).resolves.toBe('high');

    // The lookup ran the real `wl show <id> --json` under the hood.
    expect(mockExec).toHaveBeenCalledWith(
      'wl',
      ['show', 'WL-0MVGC6JVP00812DS', '--json'],
      expect.anything(),
    );
  });
});

describe('Interactive operator dispatch — work-item priority survives the whole chain (WL-0MVGC6JVP00812DS AC2)', () => {
  afterEach(() => {
    resetExecFileAsync();
  });

  it.each([
    ['low', 'medium'],
    ['medium', 'high'],
    ['high', 'high'],
    ['critical', 'high'],
  ] as Array<[string, 'low' | 'medium' | 'high']>)(
    'a %s work item is dispatched at request priority %s on both the pane and headless paths',
    async (workItemPriority, expected) => {
      const command = `/skill:implement WL-${workItemPriority}`;

      // 1. Sort → resolve (the production `wl show` lookup).
      const mockExec = vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          success: true,
          workItem: { id: `WL-${workItemPriority}`, title: 'Item', status: 'open', priority: workItemPriority },
        }),
        stderr: '',
      });
      setExecFileAsync(mockExec as never);
      const requestPriority = await resolveInteractiveDispatchPriority(
        extractWorkItemId(command),
      );
      expect(requestPriority).toBe(expected);

      // 2. Pane path: buildSendToPiArgs forwards --request-priority AND the
      //    command stays the final argv token so send-to-pi.sh parses it.
      const args = buildSendToPiArgsWithPriority(
        command,
        '/project',
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        requestPriority,
      );
      expect(paneDispatchPriority(args)).toBe(expected);
      expect(args[args.length - 1]).toBe(command);

      // 3. Headless path: spawnBackgroundPi puts the mapped value in the
      //    launched process env for the Worklog pi extension.
      const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
      spawnBackgroundPi(command, '/project', undefined, '/tmp/log', {
        spawn: spawnFn as never,
        openSync: () => 9,
        requestPriority,
      });
      expect(spawnFn).toHaveBeenCalledWith(
        'pi',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ HERDR_REQUEST_PRIORITY: expected }),
        }),
      );
    },
  );

  it('a dispatch with no resolvable work-item id still proceeds at the interactive default high', async () => {
    // Free-form `/prompt:` — no id, so no `wl show` round-trip happens and
    // the pane + headless paths still carry `high` (fail-open).
    const command = '/prompt:Review this design';
    const mockExec = vi.fn();
    setExecFileAsync(mockExec as never);

    const requestPriority = await resolveInteractiveDispatchPriority(
      extractWorkItemId(command),
    );
    expect(requestPriority).toBe('high');
    expect(mockExec).not.toHaveBeenCalled();

    const args = buildSendToPiArgsWithPriority(
      command,
      '/project',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      requestPriority,
    );
    expect(paneDispatchPriority(args)).toBe('high');
  });
});
