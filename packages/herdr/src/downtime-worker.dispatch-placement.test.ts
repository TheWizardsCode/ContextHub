/**
 * packages/herdr/src/downtime-worker.dispatch-placement.test.ts — pins the
 * current `resolveDispatchPlacement` placement precedence
 * (WL-0MWHWGN23001KMQW AC5).
 *
 * Characterisation before WL-0MWHW3PKX0048ZYL changes the placement logic:
 *
 *   1. **Project workspace + item-ID tab (primary)** — the item tab's root
 *      pane is the anchor (`anchorIsTabRoot: true`). A workspace that
 *      resolves but whose tab cannot be provisioned FAILS CLOSED — never a
 *      wrong-placement fallback.
 *   2. **Per-prefix tab in the Dispatcher workspace (fallback)** — only when
 *      no project workspace resolves. A null/failed resolution or an empty
 *      prefix is `anchor-unavailable` and NEVER falls back to the legacy
 *      anchor (fail-safe, never a wrong-tab placement).
 *   3. **Legacy single Dispatcher anchor (retained)** — only when no
 *      project workspace AND no per-prefix resolver is wired. `null` fails
 *      closed; the legacy anchor is never a tab root.
 *
 * No placement dep at all keeps the legacy current-pane split behaviour:
 * `{ ok: true, anchorId: undefined, anchorIsTabRoot: false }`.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveDispatchPlacement } from './downtime-worker.dispatch-placement.js';

type Deps = Parameters<typeof resolveDispatchPlacement>[0];

const depsOf = (): Deps => ({}) as Deps;

describe('AC5 — resolveDispatchPlacement precedence', () => {
  it('no placement deps: legacy current-pane split (anchorId undefined)', async () => {
    const deps = depsOf();
    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' })).toEqual({
      ok: true,
      anchorId: undefined,
      anchorIsTabRoot: false,
    });
  });

  it('project workspace + item-ID tab is primary: the tab root pane is the anchor (tab root)', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue({ paneId: 'w1:p10', workspaceId: 'ws1', tabId: 't1' });
    deps.getItemTabAnchor = vi.fn().mockResolvedValue({ tabId: 't1', paneId: 'w1:p11' });

    const result = await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' });

    expect(result).toEqual({ ok: true, anchorId: 'w1:p11', anchorIsTabRoot: true });
    expect(deps.resolveProjectWorkspace).toHaveBeenCalledWith('/repo');
    expect(deps.getItemTabAnchor).toHaveBeenCalledWith('/repo', 'ws1', 'WL-0ABC');
  });

  it('project workspace resolves but the item tab cannot be provisioned → fail closed, fallbacks NOT consulted', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue({ paneId: 'w1:p10', workspaceId: 'ws1', tabId: 't1' });
    deps.getItemTabAnchor = vi.fn().mockResolvedValue(null);
    deps.getDispatcherTabAnchor = vi.fn().mockResolvedValue({ workspaceId: 'dw', tabId: 'dt', paneId: 'w9:p7' });
    deps.getDispatcherAnchor = vi.fn().mockResolvedValue({ paneId: 'w9:pA', workspaceId: 'dw' });

    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' })).toEqual({ ok: false });
    // The fail-closed return happens before the fallback resolvers run —
    // never a wrong-placement fallback (AC2/AC3).
    expect(deps.getDispatcherTabAnchor).not.toHaveBeenCalled();
    expect(deps.getDispatcherAnchor).not.toHaveBeenCalled();
  });

  it('no project workspace → per-prefix Dispatcher tab fallback (prefix extracted from the item id)', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue(null);
    deps.getDispatcherTabAnchor = vi.fn().mockResolvedValue({ workspaceId: 'dw', tabId: 'dt', paneId: 'w9:p7' });

    const result = await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' });

    expect(result).toEqual({ ok: true, anchorId: 'w9:p7', anchorIsTabRoot: true });
    expect(deps.getDispatcherTabAnchor).toHaveBeenCalledWith('/repo', 'WL');
  });

  it('extracts the item-id prefix (WL / TCE) for the per-prefix resolver', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue(null);
    deps.getDispatcherTabAnchor = vi.fn().mockResolvedValue({ workspaceId: 'dw', tabId: 'dt', paneId: 'w9:p7' });

    await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'TCE-0XYZ' });
    expect(deps.getDispatcherTabAnchor).toHaveBeenCalledWith('/repo', 'TCE');
  });

  it('per-prefix resolution fails (null) → anchor-unavailable, legacy anchor NOT used as a fallback (fail-safe)', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue(null);
    deps.getDispatcherTabAnchor = vi.fn().mockResolvedValue(null);
    deps.getDispatcherAnchor = vi.fn().mockResolvedValue({ paneId: 'w9:pA', workspaceId: 'dw' });

    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' })).toEqual({ ok: false });
    expect(deps.getDispatcherAnchor).not.toHaveBeenCalled();
  });

  it('empty prefix with the per-prefix resolver wired → fail closed (cannot route by prefix)', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue(null);
    deps.getDispatcherTabAnchor = vi.fn().mockResolvedValue({ workspaceId: 'dw', tabId: 'dt', paneId: 'w9:p7' });

    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: '' })).toEqual({ ok: false });
    expect(deps.getDispatcherTabAnchor).not.toHaveBeenCalled();
  });

  it('legacy Dispatcher anchor (no project/per-prefix wiring): anchor used, NOT a tab root', async () => {
    const deps = depsOf();
    deps.getDispatcherAnchor = vi.fn().mockResolvedValue({ paneId: 'w9:pA', workspaceId: 'dw' });

    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' })).toEqual({
      ok: true,
      anchorId: 'w9:pA',
      anchorIsTabRoot: false,
    });
    expect(deps.getDispatcherAnchor).toHaveBeenCalledWith('/repo');
  });

  it('legacy anchor resolution fails (null) → fail closed', async () => {
    const deps = depsOf();
    deps.getDispatcherAnchor = vi.fn().mockResolvedValue(null);

    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' })).toEqual({ ok: false });
  });

  it('precedence: project workspace beats per-prefix and legacy; neither fallback runs', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue({ paneId: 'w1:p10', workspaceId: 'ws1', tabId: 't1' });
    deps.getItemTabAnchor = vi.fn().mockResolvedValue({ tabId: 't1', paneId: 'w1:p11' });
    deps.getDispatcherTabAnchor = vi.fn().mockResolvedValue({ workspaceId: 'dw', tabId: 'dt', paneId: 'w9:p7' });
    deps.getDispatcherAnchor = vi.fn().mockResolvedValue({ paneId: 'w9:pA', workspaceId: 'dw' });

    const result = await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' });

    expect(result).toEqual({ ok: true, anchorId: 'w1:p11', anchorIsTabRoot: true });
    expect(deps.getDispatcherTabAnchor).not.toHaveBeenCalled();
    expect(deps.getDispatcherAnchor).not.toHaveBeenCalled();
  });

  it('precedence: per-prefix Dispatcher tab beats the legacy anchor when both are wired', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue(null);
    deps.getDispatcherTabAnchor = vi.fn().mockResolvedValue({ workspaceId: 'dw', tabId: 'dt', paneId: 'w9:p7' });
    deps.getDispatcherAnchor = vi.fn().mockResolvedValue({ paneId: 'w9:pA', workspaceId: 'dw' });

    const result = await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' });

    expect(result).toEqual({ ok: true, anchorId: 'w9:p7', anchorIsTabRoot: true });
    expect(deps.getDispatcherAnchor).not.toHaveBeenCalled();
  });

  it('a throwing project-workspace resolver falls through to the next strategy (current behaviour)', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockRejectedValue(new Error('herdr CLI failed'));
    deps.getDispatcherTabAnchor = vi.fn().mockResolvedValue({ workspaceId: 'dw', tabId: 'dt', paneId: 'w9:p7' });

    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' })).toEqual({
      ok: true,
      anchorId: 'w9:p7',
      anchorIsTabRoot: true,
    });
  });

  it('a throwing item-tab resolver fails closed (never a wrong placement)', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue({ paneId: 'w1:p10', workspaceId: 'ws1', tabId: 't1' });
    deps.getItemTabAnchor = vi.fn().mockRejectedValue(new Error('tab list failed'));

    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' })).toEqual({ ok: false });
  });

  it('a throwing per-prefix resolver fails closed', async () => {
    const deps = depsOf();
    deps.resolveProjectWorkspace = vi.fn().mockResolvedValue(null);
    deps.getDispatcherTabAnchor = vi.fn().mockRejectedValue(new Error('prefix tab failed'));

    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' })).toEqual({ ok: false });
  });

  it('a throwing legacy-anchor resolver fails closed', async () => {
    const deps = depsOf();
    deps.getDispatcherAnchor = vi.fn().mockRejectedValue(new Error('anchor read failed'));

    expect(await resolveDispatchPlacement(deps, { cwd: '/repo', itemId: 'WL-0ABC' })).toEqual({ ok: false });
  });
});
