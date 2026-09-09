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
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createDowntimeDeps } from '../../packages/herdr/src/index.js';
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
