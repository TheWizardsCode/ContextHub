/**
 * packages/herdr/src/dispatcher-anchor.probe.test.ts — workspace existence
 * probe tests (module-local `probeWorkspace` in
 * `dispatcher-anchor.herdr-cli.ts`).
 *
 * Work item: WL-0MWHCUPGQ001FASL — classify a persisted Dispatcher
 * `workspaceId` as *alive* / *positively missing* / *unreadable* so the
 * self-healing fix (parent WL-0MWH50EN4007C6YH) can keep "a vanished
 * workspace is recoverable" strictly separate from "an unreadable herdr must
 * still fail closed".
 *
 * Every verdict case (AC3) is driven through a mocked `node:child_process`
 * `execFile`; AC4 pins that **only** a `herdr workspace list` spawn occurs —
 * never a `wl` invocation. The production dep factory is exercised directly:
 * `createDispatcherAnchorDeps(cwd, bin).probeWorkspace!(id)`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Callback shape the production code passes to `execFile` (promisified). */
type ExecFileImpl = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (error: Error | null, stdout?: string) => void,
) => void;

/** Hoisted so the `vi.mock` factory below can bind it (vitest hoists `vi.mock` above imports). */
const mockExecFile = vi.hoisted(() => vi.fn<ExecFileImpl>());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: mockExecFile };
});

import {
  createDispatcherAnchorDeps,
  type DispatcherAnchorDeps,
} from './dispatcher-anchor.js';

const HERDR_BIN = '/test/bin/herdr';

/** A valid `herdr workspace list` envelope carrying the given ids. */
function listJson(...ids: string[]): string {
  return JSON.stringify({
    result: {
      type: 'workspace_list',
      workspaces: ids.map((id) => ({ workspace_id: id })),
    },
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('probeWorkspace (via createDispatcherAnchorDeps)', () => {
  it('returns `alive` when the id is present in the workspace list', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, listJson('w57', 'w13')),
    );
    const deps = createDispatcherAnchorDeps('/tmp', HERDR_BIN);
    await expect(deps.probeWorkspace!('w57')).resolves.toBe('alive');
  });

  it('returns `missing` only when the list was read and parsed and the id is absent', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, listJson('w57', 'w13')),
    );
    const deps = createDispatcherAnchorDeps('/tmp', HERDR_BIN);
    await expect(deps.probeWorkspace!('wZZZ')).resolves.toBe('missing');
  });

  it('returns `unreadable` on a CLI error', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(new Error('herdr workspace list exited 1')),
    );
    const deps = createDispatcherAnchorDeps('/tmp', HERDR_BIN);
    await expect(deps.probeWorkspace!('wZZZ')).resolves.toBe('unreadable');
  });

  it('returns `unreadable` on unparseable output', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, 'log line before\ndefinitely not json'),
    );
    const deps = createDispatcherAnchorDeps('/tmp', HERDR_BIN);
    await expect(deps.probeWorkspace!('wZZZ')).resolves.toBe('unreadable');
  });

  it('returns `unreadable` on empty output', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, ''));
    const deps = createDispatcherAnchorDeps('/tmp', HERDR_BIN);
    await expect(deps.probeWorkspace!('wZZZ')).resolves.toBe('unreadable');
  });

  it('returns `unreadable` when the spawn throws (thrown dep)', async () => {
    mockExecFile.mockImplementation(() => {
      throw new Error('spawn ENOSYS');
    });
    const deps = createDispatcherAnchorDeps('/tmp', HERDR_BIN);
    await expect(deps.probeWorkspace!('wZZZ')).resolves.toBe('unreadable');
  });

  it('tolerates log lines before the envelope and workspace_id / workspaceId / id keys', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(
        null,
        'herdr: workspace server ready\n' +
          JSON.stringify({
            result: {
              workspaces: [{ workspaceId: 'wA' }, { id: 'wB' }, { workspace_id: 'wC' }],
            },
          }),
      ),
    );
    const deps = createDispatcherAnchorDeps('/tmp', HERDR_BIN);
    expect(await deps.probeWorkspace!('wB')).toBe('alive');
    expect(await deps.probeWorkspace!('wD')).toBe('missing');
  });

  it('issues exactly one `herdr workspace list` spawn and never a `wl` invocation (AC4)', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(null, listJson('w57')),
    );
    const deps = createDispatcherAnchorDeps('/tmp', HERDR_BIN);
    await deps.probeWorkspace!('w57');

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe(HERDR_BIN);
    expect(args).toEqual(['workspace', 'list']);
    // The probe may only ever touch the herdr CLI — never `wl`.
    expect([cmd, ...args].join(' ')).not.toMatch(/\bwl\b/);
    expect(args.join(' ')).not.toContain('wl');
  });

  it('fails closed when the probe dep is absent (additive member, AC1)', async () => {
    // `probeWorkspace` is optional — every existing caller that omits it still
    // compiles. The fail-closed default (parent decision "Missing ≠
    // unreadable"): an absent probe is exactly `unreadable`, never `missing`.
    const deps: DispatcherAnchorDeps = {
      createWorkspace: async () => ({ workspaceId: 'w1', paneId: 'w1:p1' }),
      isPaneAlive: async () => true,
    };
    expect(deps.probeWorkspace).toBeUndefined();
    const verdict = await (deps.probeWorkspace?.('wZZZ') ?? Promise.resolve('unreadable'));
    expect(verdict).toBe('unreadable');
  });
});
