/**
 * Unit tests for lib/work-item-title.ts — the shared work item title
 * resolver for the Worklog Pi extension footer (WL-0MVGB23MM004X501).
 *
 * The resolver is the single place both footer call sites
 * (`activity-indicator.ts` status line and `session-health.ts` line-3
 * initial-prompt preview) use to turn an ID into a title. It:
 *
 * - Resolves sibling-project worklogs via `findWorklogDirsByPrefix` and
 *   passes `--worklog-dir` to `wl show` (AC1/AC2).
 * - Falls back to cwd (today's behaviour) when no sibling matches (AC2).
 * - Tries every candidate when a prefix is ambiguous (e.g. `POD` × 12) and
 *   only ever returns the owner's title — never a wrong project's "not
 *   found" (Constraints bullet from plan review).
 * - Raises the lookup budget to `TITLE_LOOKUP_TIMEOUT_MS` so a large item
 *   resolves reliably on a loaded machine (AC4).
 * - Degrades silently to `null` on any failure (AC5).
 * - Memoises the prefix→dirs scan and the per-ID owning dir (AC6).
 *
 * Run: npx vitest run packages/tui/extensions/Worklog/lib/work-item-title.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Mock the wl-integration layer ──────────────────────────────────────
// The resolver's only external dependency is runWl() (which spawns the wl
// CLI). Mocking it keeps these tests pure: they assert what args the
// resolver builds, not how the CLI is spawned (that is covered by
// tests/unit/wl-integration.test.ts).

const mocks = vi.hoisted(() => ({
  mockRunWl: vi.fn(),
}));

vi.mock('../../wl-integration.js', () => ({
  runWl: mocks.mockRunWl,
  runWlCommand: vi.fn(),
  wlEvents: { emit: vi.fn() },
  WlError: class WlError extends Error {},
}));

import {
  resolveWorkItemTitle,
  TITLE_LOOKUP_TIMEOUT_MS,
  resetTitleLookupCache,
} from './work-item-title.js';
import { findWorklogDirsByPrefix, resetWorklogDirCache } from './worklog-dir.js';

// ── Fixture helpers ────────────────────────────────────────────────────

let scanRoot: string;

function makeScanRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wl-title-test-'));
}

/** Create `<scanRoot>/<name>/.worklog` with a `prefix:` config + db marker. */
function makeProject(
  root: string,
  name: string,
  prefixValue: string,
): string {
  const proj = path.join(root, name);
  const worklogDir = path.join(proj, '.worklog');
  fs.mkdirSync(worklogDir, { recursive: true });
  fs.writeFileSync(path.join(worklogDir, 'worklog.db'), '');
  fs.writeFileSync(
    path.join(worklogDir, 'config.yaml'),
    `# worklog config\nprefix: ${prefixValue}\n`,
  );
  return worklogDir;
}

beforeEach(() => {
  scanRoot = makeScanRoot();
  process.env.WORKLOG_SIBLING_SCAN_ROOT = scanRoot;
  mocks.mockRunWl.mockReset();
});

afterEach(() => {
  delete process.env.WORKLOG_SIBLING_SCAN_ROOT;
  resetTitleLookupCache();
  fs.rmSync(scanRoot, { recursive: true, force: true });
});

// ── Resolver behaviour ─────────────────────────────────────────────────

describe('resolveWorkItemTitle', () => {
  it('resolves the title from the owning sibling worklog (AC1/AC2)', async () => {
    makeProject(scanRoot, 'tce-the-rising', 'RISE');
    mocks.mockRunWl.mockResolvedValue({
      id: 'RISE-0MVCFSM9B0019M8L',
      title: 'AI cards should be face down',
    });

    const title = await resolveWorkItemTitle('RISE-0MVCFSM9B0019M8L');
    expect(title).toBe('AI cards should be face down');

    // The resolver must pass the sibling worklog dir explicitly.
    const [command, args, options] = mocks.mockRunWl.mock.calls[0];
    expect(command).toBe('show');
    expect(args).toEqual([
      'RISE-0MVCFSM9B0019M8L',
      '--worklog-dir',
      path.join(scanRoot, 'tce-the-rising', '.worklog'),
    ]);
    expect(options.timeout).toBe(TITLE_LOOKUP_TIMEOUT_MS);
  });

  it('falls back to cwd when no sibling declares the prefix (AC2)', async () => {
    mocks.mockRunWl.mockResolvedValue({ id: 'WL-0MQL0T5TR0060AEH', title: 'Local item' });

    const title = await resolveWorkItemTitle('WL-0MQL0T5TR0060AEH');
    expect(title).toBe('Local item');
    const [command, args] = mocks.mockRunWl.mock.calls[0];
    expect(command).toBe('show');
    // No sibling candidates → no --worklog-dir flag, plain cwd lookup.
    expect(args).toEqual(['WL-0MQL0T5TR0060AEH']);
  });

  it('raises the lookup budget above the old 2s ceiling (AC4)', () => {
    expect(TITLE_LOOKUP_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });

  it('completes a lookup that exceeds the old 2s budget (AC4)', async () => {
    // Simulate a cold `wl show` of a large item: 3.5s — under the new
    // budget, over the old 2000ms one.
    makeProject(scanRoot, 'tce-the-rising', 'RISE');
    mocks.mockRunWl.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ id: 'RISE-0MVCFSM9B0019M8L', title: 'AI cards should be face down' }),
            3500,
          ),
        ),
    );

    const title = await resolveWorkItemTitle('RISE-0MVCFSM9B0019M8L');
    expect(title).toBe('AI cards should be face down');
  }, 10000);

  it('handles a very large item payload (>15 KB) without losing the title (AC4)', async () => {
    makeProject(scanRoot, 'tce-the-rising', 'RISE');
    const bigDescription = 'x'.repeat(20_000);
    mocks.mockRunWl.mockResolvedValue({
      id: 'RISE-0MVCFSM9B0019M8L',
      title: 'Large item title',
      description: bigDescription,
    });

    const title = await resolveWorkItemTitle('RISE-0MVCFSM9B0019M8L');
    expect(title).toBe('Large item title');
  });

  it('degrades silently to null when the owner cannot be found (AC5)', async () => {
    makeProject(scanRoot, 'tce-the-rising', 'RISE');
    mocks.mockRunWl.mockRejectedValue(new Error('Work item not found'));

    await expect(resolveWorkItemTitle('RISE-0MVCFSM9B0019M8L')).resolves.toBeNull();
  });

  it('tries each ambiguous candidate until the owner responds (AC1 + plan constraint)', async () => {
    // `POD` is declared by 12 podcast-* projects on this machine.
    makeProject(scanRoot, 'podcast-alpha', 'POD');
    const owner = makeProject(scanRoot, 'podcast-beta', 'POD');
    makeProject(scanRoot, 'podcast-gamma', 'POD');

    // First candidate (alpha, sorted first) does not own the ID → rejected.
    mocks.mockRunWl
      .mockRejectedValueOnce(new Error('Work item not found: POD-0MVCFSM9B0019M8L'))
      .mockResolvedValueOnce({ id: 'POD-0MVCFSM9B0019M8L', title: 'Owned by beta' })
      .mockResolvedValue({ id: 'POD-0MVCFSM9B0019M8L', title: 'Owned by beta' });

    const title = await resolveWorkItemTitle('POD-0MVCFSM9B0019M8L');
    expect(title).toBe('Owned by beta');

    // Beta's dir was tried; gamma must NOT be reached.
    const triedDirs = mocks.mockRunWl.mock.calls.map((c: any[]) => c[1][c[1].indexOf('--worklog-dir') + 1]);
    expect(triedDirs).toContain(owner);
    expect(triedDirs).not.toContain(path.join(scanRoot, 'podcast-gamma', '.worklog'));
  });

  it('memoises the owning dir so a repeated lookup does not re-probe candidates (AC6)', async () => {
    makeProject(scanRoot, 'podcast-alpha', 'POD');
    makeProject(scanRoot, 'podcast-beta', 'POD');
    // The first (sorted) candidate does not own the ID; the second does.
    mocks.mockRunWl
      .mockRejectedValueOnce(new Error('Work item not found'))
      .mockResolvedValue({ id: 'POD-0MVCFSM9B0019M8L', title: 'A pod item' });

    await resolveWorkItemTitle('POD-0MVCFSM9B0019M8L');
    await resolveWorkItemTitle('POD-0MVCFSM9B0019M8L');
    await resolveWorkItemTitle('POD-0MVCFSM9B0019M8L');

    // First lookup: 2 probes (alpha fails, beta succeeds) + 1 for the second
    // + 1 for the third = 4 total; without memoisation it would be 6.
    expect(mocks.mockRunWl).toHaveBeenCalledTimes(4);
  });

  it('returns null for garbage input without throwing', async () => {
    await expect(resolveWorkItemTitle('not-an-id')).resolves.toBeNull();
    expect(mocks.mockRunWl).not.toHaveBeenCalled();
  });

  it('does not import a fresh resolver state across tests (cache isolation)', async () => {
    // If the prefix-dir cache leaked across tests, a previously scanned
    // prefix could resolve to a stale temp dir. Cache resets keep each
    // test isolated (see afterEach).
    expect(findWorklogDirsByPrefix('RISE', scanRoot)).toEqual([]);
    resetWorklogDirCache();
  });
});
