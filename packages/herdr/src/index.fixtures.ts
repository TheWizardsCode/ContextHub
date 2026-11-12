/**
 * packages/herdr/src/index.fixtures.ts — shared test-support fixtures for the
 * decomposed `index*.test.ts` modules.
 *
 * Work item: WL-0MVOA238A0078J2H (decompose `packages/herdr/src/index.test.ts`).
 * Parent: WL-0MVGKGFFN009UCM6 (`index.ts` split).
 *
 * Test-support only — this module contains NO production behaviour. The
 * `.fixtures.ts` suffix keeps it out of the index-family production gates
 * (`isTestOrFixture` in `packages/herdr/test/split-guard/scan.ts`).
 *
 * Every helper here was previously duplicated (or inlined) in the monolithic
 * `index.test.ts`; the decomposed modules import them from this single module
 * rather than repeating the arrange/setup code.
 */

import { beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSendToPiArgs,
  resolveInteractiveDispatchPriority,
  setHostCpuSamplerForTests,
} from './index.js';
import { resetExecFileAsync, resetWorklogDir } from './fetcher.js';
import type {
  DispatcherAnchorDeps,
  DispatcherPaneInfo,
  DispatcherTabInfo,
  ItemTabAnchor,
} from './dispatcher-anchor.js';

// Re-exported so the decomposed test modules import these types through the
// fixture module. The dispatcher-anchor split guard then sees a single frozen
// consumer (`index.fixtures.ts`) instead of every index test module.
export type { DispatcherAnchorDeps, DispatcherPaneInfo, DispatcherTabInfo, ItemTabAnchor };

// ── Host-CPU gate ─────────────────────────────────────────────────────

/**
 * Deterministic host-CPU gate (WL-0MVK0UO3Q002TXW6 AC6): `createDowntimeDeps`
 * wires the REAL `/proc/stat` sampler in production. Every suite that exercises
 * it pins a low-utilisation fixture so dispatch behaviour never depends on the
 * host's current load (tests must never read the real /proc/stat).
 */
export function setupHostCpuPin(): void {
  beforeEach(() => {
    setHostCpuSamplerForTests(() => ({ ok: true, percent: 5, source: 'proc-stat' }));
  });

  afterEach(() => {
    setHostCpuSamplerForTests(null);
  });
}

// ── Machine-wide coordination dir ─────────────────────────────────────

/**
 * Isolate the machine-wide coordination dir from the developer's live
 * `~/.herdr/downtime/` (WL-0MUIVE0YG000UVIA): the host-wide audit
 * serialisation marker must never leak to/from real state during a test.
 * Tests that need a specific dir override it themselves; the previous value is
 * restored on teardown.
 */
export function useIsolatedCoordinationDir(): void {
  const savedCoordinationDir = process.env.HERDR_COORDINATION_DIR;
  let isolationCoordDir: string;

  beforeEach(() => {
    isolationCoordDir = mkdtempSync(join(tmpdir(), 'herdr-coord-test-'));
    process.env.HERDR_COORDINATION_DIR = isolationCoordDir;
  });

  afterEach(() => {
    resetExecFileAsync();
    resetWorklogDir();
    if (savedCoordinationDir !== undefined) {
      process.env.HERDR_COORDINATION_DIR = savedCoordinationDir;
    } else {
      delete process.env.HERDR_COORDINATION_DIR;
    }
    if (isolationCoordDir) {
      try { rmSync(isolationCoordDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
}

// ── Temp directories ─────────────────────────────────────────────────

const tempDirs: string[] = [];

/**
 * Create a temp directory for testing. Automatically cleaned up by
 * {@link resetTempDirs} (call it from an `afterEach`).
 */
export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wlroot-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Remove every directory created by {@link makeTempDir}. */
export function resetTempDirs(): void {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempDirs.length = 0;
}

// ── Interactive item-tab helpers ──────────────────────────────────────

/** Minimal `DispatcherAnchorDeps` stub for the interactive item-tab tests. */
export function makeInteractiveAnchorDeps(
  over: Partial<DispatcherAnchorDeps> = {},
): DispatcherAnchorDeps {
  return {
    createWorkspace: async () => ({ workspaceId: 'wDefault', paneId: 'wDefault:p1' }),
    isPaneAlive: async () => true,
    listTabs: async () => [] as DispatcherTabInfo[],
    createTab: async (ws: string, label: string) => ({
      tabId: `${ws}:t${label}`,
      paneId: `${ws}:t${label}:p1`,
    }),
    listPanes: async () => [] as DispatcherPaneInfo[],
    ...over,
  } as DispatcherAnchorDeps;
}

// ── Command/shortcut helpers ─────────────────────────────────────────

export interface ShortcutEntry {
  chord: string[];
  command: string;
  view: string;
  label?: string;
  model?: string;
}

export function loadShortcutsJson(): ShortcutEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, 'shortcuts.json'), 'utf8');
  return JSON.parse(raw) as ShortcutEntry[];
}

// ── Request-priority helpers ─────────────────────────────────────────

/** Target signature of `buildSendToPiArgs` once the priority flag lands. */
export const buildSendToPiArgsWithPriority = buildSendToPiArgs as unknown as (
  command: string,
  targetCwd: string,
  model?: string,
  paneIdFile?: string,
  paneName?: string,
  focus?: boolean,
  anchor?: string,
  requestPriority?: 'low' | 'medium' | 'high',
) => string[];

/**
 * Target signature of `resolveInteractiveDispatchPriority` once the
 * injectable lookup seam lands (AC1: `resolveInteractiveDispatchPriority(
 * commandId, lookup)`). Declared here so the injected-lookup specs fail RED
 * before the production signature is widened.
 */
export const resolveInteractiveDispatchPriorityWithLookup = resolveInteractiveDispatchPriority as unknown as (
  itemId: string | undefined,
  lookup?: (
    id: string,
  ) =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>,
  timeoutMs?: number,
) => Promise<'low' | 'medium' | 'high'>;

/** RESOLVE then pipe the mapped request priority into the pane-spawn args. */
export function paneDispatchPriority(args: string[]): 'low' | 'medium' | 'high' | undefined {
  const flagIndex = args.indexOf('--request-priority');
  if (flagIndex < 0) return undefined;
  return args[flagIndex + 1] as 'low' | 'medium' | 'high';
}

// ── Downtime-deps stubs ──────────────────────────────────────────────

/**
 * Route-aware `wl` mock for the critical-tier lookup (F3): `wl list` returns
 * the critical batch; `wl dep list` returns the outbound depends-on edges for
 * the queried item (its blockers); `wl show` enriches a blocker with the full
 * workItem fields. Unblocked items (no outbound edges) resolve to themselves in
 * the frontier walk, so the F2 expectations carry over unchanged.
 */
export function criticalWlMock(
  workItems: unknown[],
  blockersByItem: Record<string, unknown[]> = {},
  showItems: Record<string, Record<string, unknown>> = {},
) {
  return vi.fn().mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === 'dep') {
      const itemId = args[2];
      return Promise.resolve({
        stdout: JSON.stringify({ success: true, item: itemId, inbound: [], outbound: blockersByItem[itemId] ?? [] }),
        stderr: '',
      });
    }
    if (args[0] === 'show') {
      const itemId = args[1];
      return Promise.resolve({
        stdout: JSON.stringify({ success: true, workItem: showItems[itemId] ?? { id: itemId, title: 'blocker', status: 'open', stage: 'intake_complete', risk: 'low', effort: 'small', sortIndex: 10 } }),
        stderr: '',
      });
    }
    return Promise.resolve({
      stdout: JSON.stringify({ success: true, count: workItems.length, workItems }),
      stderr: '',
    });
  });
}
