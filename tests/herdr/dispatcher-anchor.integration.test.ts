/**
 * tests/herdr/dispatcher-anchor.integration.test.ts — Dispatcher anchor
 * end-to-end integration (F3 WL-0MTR2JOTE006T3XT, parent C0
 * WL-0MTR01EU7005SYZG)
 *
 * Verifies the anchored spawn chain end-to-end through the REAL production
 * seams (no worker-level mocks):
 *
 *  - `createDowntimeDeps(...).spawnAgentPane` (index.ts) builds the
 *    send-to-pi.sh argument vector via `buildDowntimePaneArgs`. When the
 *    resolved Dispatcher anchor id is threaded through the opts, the REAL
 *    args contain `--anchor <id>` (AC1/AC3 anchor usage + propagation).
 *  - send-to-pi.sh run against a mock herdr CLI: in anchor mode the split
 *    targets the Dispatcher anchor pane by ID and `pane current` is NEVER
 *    called (AC2); in legacy mode the current-pane path is unchanged (AC4).
 *  - `--no-focus` is preserved in both modes (C0 AC5).
 *
 * Uses a mock herdr CLI (HERDR_BIN_PATH) that records every invocation, so
 * the split path is observable without a live herdr session.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createDowntimeDeps } from '../../packages/herdr/src/index.js';
import {
  createDispatcherAnchorDeps,
  getDispatcherAnchor,
  getItemTabAnchor,
  resolveProjectWorkspace,
} from '../../packages/herdr/src/dispatcher-anchor.js';
import type { DowntimeSpawn } from '../../packages/herdr/src/downtime-worker.js';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'herdr',
  'shared',
  'send-to-pi.sh',
);

let tmpDir: string;
let herdrLog: string;
let fakeHerdr: string;
let workdir: string;

/** Fake herdr CLI: records "$*" for every invocation. */
function makeFakeHerdr(): void {
  fakeHerdr = join(tmpDir, 'herdr');
  writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env bash
echo "$*" >> "${herdrLog}"
case "$1 $2" in
  "pane split") echo '{"pane_id":"split-pane-1","success":true}' ;;
  "pane current") echo '{"pane_id":"current-pane-9","success":true}' ;;
  "pane run") echo 'mock run ok' ;;
  *) echo 'ok' ;;
esac
exit 0
`,
  );
  chmodSync(fakeHerdr, 0o755);
}

/** Record spawn invocations without spawning real processes. */
function capturingSpawn(log: Array<{ script: string; args: string[] }>): DowntimeSpawn {
  return ((script: string, args: string[], _opts: unknown) => {
    log.push({ script, args });
    const handle = { unref: () => {}, once: () => {} };
    return handle as never;
  }) as unknown as DowntimeSpawn;
}

/** Run send-to-pi.sh with a clean env against the fake herdr CLI. */
function runSendToPi(args: string[]): { status: number; calls: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HERDR_BIN_PATH: fakeHerdr,
  };
  delete env.HERDR_PANE_ID;
  delete env.HERDR_ENV;
  delete env.HERDR_RESOLVED_CWD;
  let status = 0;
  try {
    execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf-8',
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number };
    status = e.status ?? 1;
  }
  const calls = existsSync(herdrLog) ? readFileSync(herdrLog, 'utf-8') : '';
  rmSync(herdrLog, { force: true });
  return { status, calls };
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'anchor-int-'));
  herdrLog = join(tmpDir, 'herdr.log');
  makeFakeHerdr();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  workdir = mkdtempSync(join(tmpDir, 'wl-'));
  rmSync(herdrLog, { force: true });
});

describe('dispatcher-anchor end-to-end integration (F3)', () => {
  it('AC1/AC3: real spawnAgentPane forwards --anchor <id> when the anchor id is threaded', async () => {
    const spawns: Array<{ script: string; args: string[] }> = [];
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map', capturingSpawn(spawns));

    await deps.spawnAgentPane('Run /skill:plan WL-ABC — Some task.', {
      model: 'plan',
      cwd: workdir,
      anchorId: 'wD:pANCHOR',
    });

    expect(spawns).toHaveLength(1);
    const args = spawns[0].args;
    // The anchor id is threaded into the real send-to-pi.sh arg vector.
    expect(args).toContain('--anchor');
    expect(args[args.indexOf('--anchor') + 1]).toBe('wD:pANCHOR');
    // C0 AC5: the pane must never steal focus.
    expect(args).toContain('--no-focus');
    expect(args).toContain('--cwd');
    expect(args).toContain('--model');
  });

  it('AC4 backward compat: no anchorId → no --anchor in the real spawn args', async () => {
    const spawns: Array<{ script: string; args: string[] }> = [];
    const deps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map', capturingSpawn(spawns));

    await deps.spawnAgentPane('Run /skill:plan WL-ABC — Some task.', {
      model: 'plan',
      cwd: workdir,
    });

    expect(spawns).toHaveLength(1);
    expect(spawns[0].args).not.toContain('--anchor');
    expect(spawns[0].args).toContain('--no-focus');
  });

  it('AC2: send-to-pi.sh with --anchor splits the anchor pane and never calls pane current', () => {
    const { status, calls } = runSendToPi([
      '--no-resize',
      '--anchor',
      'wD:pANCHOR',
      '--cwd',
      workdir,
      '/skill:audit WL-AUD',
    ]);

    expect(status).toBe(0);
    // The split targets the Dispatcher anchor pane id.
    expect(calls).toContain('pane split --pane wD:pANCHOR');
    // `pane current` is NEVER consulted in anchor mode.
    expect(calls).not.toContain('pane current');
  });

  it('AC4: legacy mode (no --anchor) still resolves via pane current', () => {
    const { status, calls } = runSendToPi(['--no-resize', '--cwd', workdir, '/skill:audit WL-AUD']);

    expect(status).toBe(0);
    // Legacy plain split targets the current pane.
    expect(calls).toContain('pane split --current');
    expect(calls).not.toContain('--pane wD:pANCHOR');
  });

  it('C0 AC5: --no-focus survives in anchor mode (mock herdr never sees a zoom)', () => {
    const { status, calls } = runSendToPi([
      '--no-resize',
      '--anchor',
      'wD:pANCHOR',
      '--no-focus',
      '--cwd',
      workdir,
      '/skill:audit WL-AUD',
    ]);

    expect(status).toBe(0);
    expect(calls).toContain('pane split --pane wD:pANCHOR');
    expect(calls).not.toContain('pane zoom');
  });
});

// ── Project-workspace + item-ID tab end-to-end (WL-0MU321YK70035AYT) ──

describe('project-workspace placement end-to-end (WL-0MU321YK70035AYT)', () => {
  let intTmp: string;
  let stateDir: string;
  let savedCoord: string | undefined;

  /**
   * Stateful fake herdr CLI:
   *  - machine-wide `pane list` returns a `Work Items` plugin pane (unless the
   *    malformed flag is set);
   *  - `pane process-info` returns a synthetic shell pid;
   *  - `tab list` reports the item tab only after `tab create` ran (so the
   *    second `getItemTabAnchor` call exercises reuse).
   */
  function writeProjectFakeHerdr(opts: { malformedPaneList?: boolean } = {}): string {
    const bin = join(intTmp, 'herdr');
    const malformed = opts.malformedPaneList === true ? '1' : '0';
    writeFileSync(
      bin,
      `#!/usr/bin/env bash
echo "$*" >> "${herdrLog}"
case "$*" in
  "pane list --workspace"*)
    if [ -f "${stateDir}/tab_created" ]; then echo '{"result":{"panes":[{"pane_id":"wC:tWL-ABC:p1","tab_id":"wC:tWL-ABC"}]}}'; else echo '{"result":{"panes":[]}}'; fi ;;
  "pane list")
    if [ "${malformed}" = "1" ]; then echo 'not-json-at-all'; else echo '{"result":{"panes":[{"pane_id":"wC:pB","workspace_id":"wC","tab_id":"wC:tPlugin","label":"Work Items","focused":true}]}}'; fi ;;
  "pane process-info"*) echo '{"result":{"process_info":{"shell_pid":"4242"}}}' ;;
  "tab list --workspace"*)
    if [ -f "${stateDir}/tab_created" ]; then echo '{"result":{"tabs":[{"tab_id":"wC:tWL-ABC","label":"WL-ABC"}]}}'; else echo '{"result":{"tabs":[]}}'; fi ;;
  "tab create --workspace"*) touch "${stateDir}/tab_created"; echo '{"result":{"tab":{"tab_id":"wC:tWL-ABC","label":"WL-ABC"},"root_pane":{"pane_id":"wC:tWL-ABC:p1"}}}' ;;
  "workspace create"*) echo '{"result":{"workspace":{"workspace_id":"wD"},"root_pane":{"pane_id":"wD:p1"}}}' ;;
  "pane get"*| "pane move"*) echo '{}' ;;
  *) echo '{}' ;;
esac
exit 0
`,
      'utf-8',
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  beforeEach(() => {
    intTmp = mkdtempSync(join(tmpdir(), 'pw-int-'));
    stateDir = mkdtempSync(join(intTmp, 'state-'));
    savedCoord = process.env.HERDR_COORDINATION_DIR;
    process.env.HERDR_COORDINATION_DIR = stateDir;
  });

  afterEach(() => {
    if (savedCoord !== undefined) process.env.HERDR_COORDINATION_DIR = savedCoord;
    else delete process.env.HERDR_COORDINATION_DIR;
    rmSync(intTmp, { recursive: true, force: true });
  });

  it('AC1/AC2/AC7: root → project workspace → item tab (create then reuse) → --anchor forwarded to send-to-pi.sh', async () => {
    const fakeHerdr = writeProjectFakeHerdr();
    // Override the /proc env read so the test never depends on the live host.
    const deps = {
      ...createDispatcherAnchorDeps(intTmp, fakeHerdr),
      readProcEnviron: async () =>
        'HERDR_RESOLVED_CWD=/home/op/proj\0HERDR_WORKSPACE_ID=wC\0',
    };

    const target = await resolveProjectWorkspace(intTmp, deps, '/home/op/proj');
    expect(target).toEqual({ paneId: 'wC:pB', workspaceId: 'wC', tabId: 'wC:tPlugin' });

    // First dispatch: no tab yet → create it.
    const first = await getItemTabAnchor(intTmp, deps, target!.workspaceId, 'WL-ABC');
    expect(first).toEqual({ tabId: 'wC:tWL-ABC', paneId: 'wC:tWL-ABC:p1' });

    // Second dispatch for the SAME item: reuse the created tab (no duplicate).
    const second = await getItemTabAnchor(intTmp, deps, target!.workspaceId, 'WL-ABC');
    expect(second).toEqual(first);
    const calls = readFileSync(herdrLog, 'utf-8');
    expect(calls.match(/tab create/g)?.length ?? 0).toBe(1);

    // The resolved tab anchor flows into the REAL send-to-pi.sh arg vector.
    const spawns: Array<{ script: string; args: string[] }> = [];
    const realDeps = createDowntimeDeps('/path/to/send-to-pi.sh', 'Map', capturingSpawn(spawns));
    await realDeps.spawnAgentPane('Run /skill:plan WL-ABC', {
      model: 'plan',
      cwd: intTmp,
      anchorId: second!.paneId,
    });
    const args = spawns[0].args;
    expect(args).toContain('--anchor');
    expect(args[args.indexOf('--anchor') + 1]).toBe('wC:tWL-ABC:p1');
    expect(args).toContain('--no-focus');
  });

  it('AC4: no plugin pane → falls back to the Dispatcher anchor (workspace create)', async () => {
    const fakeHerdr = writeProjectFakeHerdr({ malformedPaneList: true });
    const deps = {
      ...createDispatcherAnchorDeps(intTmp, fakeHerdr),
      readProcEnviron: async () => '',
    };
    const target = await resolveProjectWorkspace(intTmp, deps, '/home/op/proj');
    expect(target).toBeNull();

    const anchor = await getDispatcherAnchor(intTmp, deps);
    expect(anchor).toEqual({ paneId: 'wD:p1', workspaceId: 'wD' });
  });

  it('AC3: malformed machine pane list fails closed (null, no wrong placement)', async () => {
    const fakeHerdr = writeProjectFakeHerdr({ malformedPaneList: true });
    const deps = createDispatcherAnchorDeps(intTmp, fakeHerdr);
    const target = await resolveProjectWorkspace(intTmp, deps, '/home/op/proj');
    expect(target).toBeNull();
  });
});
