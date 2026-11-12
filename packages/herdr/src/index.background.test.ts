/**
 * packages/herdr/src/index.background.test.ts — background shell/pi spawn
 * helpers and failure formatting tests (work item WL-0MVOA238A0078J2H).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBackgroundLogPath,
  spawnBackgroundShell,
  spawnBackgroundPi,
  formatBackgroundFailure,
} from './index.js';
import { setupHostCpuPin } from './index.fixtures.js';

setupHostCpuPin();

// ---------------------------------------------------------------------------
// Background (no-pane) dispatch helpers (WL-0MSJLD1I70045ZUL)
// ---------------------------------------------------------------------------

describe('buildBackgroundLogPath', () => {
  it('places logs under the tmpdir herdr-background-logs directory', () => {
    const path = buildBackgroundLogPath('wl update <id> --priority high');
    expect(path).toContain('herdr-background-logs');
    expect(path.endsWith('.log')).toBe(true);
  });

  it('produces distinct paths for different commands', () => {
    const a = buildBackgroundLogPath('wl update <id> --priority high');
    const b = buildBackgroundLogPath('wl update <id> --priority low');
    expect(a).not.toBe(b);
  });
});

describe('spawnBackgroundShell', () => {
  it('spawns bash -c detached with stdout/stderr redirected to the log file', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    const openSyncFn = vi.fn(() => 7);
    const child = spawnBackgroundShell(
      'wl reviewed WL-1 false',
      '/project',
      '/tmp/herdr-background-logs/x.log',
      { spawn: spawnFn as never, openSync: openSyncFn },
    );
    expect(spawnFn).toHaveBeenCalledWith(
      'bash',
      ['-c', 'wl reviewed WL-1 false'],
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 7, 7],
        cwd: '/project',
      }),
    );
    expect(openSyncFn).toHaveBeenCalledWith('/tmp/herdr-background-logs/x.log', 'a');
    expect(child.unref).toHaveBeenCalled();
  });

  it('fires onExit when the background child exits (completion → refresh)', () => {
    let exitHandler: ((code: number | null, signal: string | null) => void) | undefined;
    const child = {
      unref: vi.fn(),
      on: vi.fn((_event: string, cb: (code: number | null, signal: string | null) => void) => {
        exitHandler = cb;
        return child;
      }),
    } as never;
    const onExit = vi.fn();
    spawnBackgroundShell('wl reviewed WL-1 false', '/project', '/tmp/log', {
      spawn: vi.fn(() => child),
      openSync: () => 7,
      onExit,
    });
    expect(child.on).toHaveBeenCalledWith('exit', expect.any(Function));
    // Simulate the child exiting with code 0 — the refresh is triggered.
    exitHandler?.(0, null);
    expect(onExit).toHaveBeenCalledWith(0, null);
  });

  it('fires onExit for a non-zero exit (failure still refreshes)', () => {
    let exitHandler: ((code: number | null, signal: string | null) => void) | undefined;
    const child = {
      unref: vi.fn(),
      on: vi.fn((_event: string, cb: (code: number | null, signal: string | null) => void) => {
        exitHandler = cb;
        return child;
      }),
    } as never;
    const onExit = vi.fn();
    spawnBackgroundShell('false', '/project', '/tmp/log', {
      spawn: vi.fn(() => child),
      openSync: () => 7,
      onExit,
    });
    exitHandler?.(1, null);
    expect(onExit).toHaveBeenCalledWith(1, null);
  });
});

describe('formatBackgroundFailure (WL-0MUEBQLRD00288VV AC4)', () => {
  it('returns null for a clean (exit 0) run so no toast is shown', () => {
    expect(formatBackgroundFailure('wl audit-set X', 0, null, '/tmp/log')).toBeNull();
  });

  it('surfaces the command, exit code and log path on failure', () => {
    const failure = formatBackgroundFailure(
      'wl reviewed WL-1 false && wl audit-set WL-1 --ready-to-close yes',
      1,
      null,
      '/tmp/herdr-background-logs/x.log',
    );
    expect(failure).not.toBeNull();
    expect(failure!.title).toBe('Background command failed');
    expect(failure!.body).toContain('wl audit-set');
    expect(failure!.body).toContain('exit 1');
    expect(failure!.body).toContain('/tmp/herdr-background-logs/x.log');
  });

  it('includes a short output excerpt when one is available', () => {
    const failure = formatBackgroundFailure(
      'wl audit-set WL-1 --ready-to-close yes',
      1,
      null,
      '/tmp/log',
      'table audit_results has no column named fingerprint',
    );
    expect(failure!.body).toContain('no column named fingerprint');
    expect(failure!.body).not.toContain('/tmp/log');
  });

  it('reports a termination signal when there is no exit code', () => {
    const failure = formatBackgroundFailure('wl x', null, 'SIGTERM', '/tmp/log');
    expect(failure!.body).toContain('signal SIGTERM');
  });

  it('collapses whitespace and bounds the excerpt length', () => {
    const failure = formatBackgroundFailure('wl x', 2, null, '/tmp/log', 'a\n\n  b '.repeat(200));
    expect(failure!.body).toContain('a b');
    // command + reason + 200-char excerpt bound
    expect(failure!.body.length).toBeLessThan(300);
  });
});

describe('spawnBackgroundPi', () => {
  it('spawns pi -p --mode json with the model and prompt, detached with log redirect', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    const openSyncFn = vi.fn(() => 9);
    const child = spawnBackgroundPi(
      '/skill:audit WL-1',
      '/project',
      'plan',
      '/tmp/herdr-background-logs/y.log',
      { spawn: spawnFn as never, openSync: openSyncFn },
    );
    expect(spawnFn).toHaveBeenCalledWith(
      'pi',
      ['-p', '--mode', 'json', '--model', 'plan', '/skill:audit WL-1'],
      expect.objectContaining({
        detached: true,
        stdio: ['ignore', 9, 9],
        cwd: '/project',
      }),
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it('omits --model when no model is provided', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    const openSyncFn = vi.fn(() => 9);
    spawnBackgroundPi(
      '/intake My item',
      '/project',
      undefined,
      '/tmp/herdr-background-logs/z.log',
      { spawn: spawnFn as never, openSync: openSyncFn },
    );
    expect(spawnFn).toHaveBeenCalledWith(
      'pi',
      ['-p', '--mode', 'json', '/intake My item'],
      expect.any(Object),
    );
  });

  it('registers an exit handler when onExit is provided (completion → refresh)', () => {
    const on = vi.fn();
    const child = { on, unref: vi.fn() } as never;
    const onExit = vi.fn();
    spawnBackgroundPi('/skill:audit WL-1', '/project', undefined, '/tmp/log', {
      spawn: vi.fn(() => child),
      openSync: () => 9,
      onExit,
    });
    expect(on).toHaveBeenCalledWith('exit', expect.any(Function));
  });
});

describe('spawnBackgroundPi — request priority env (WL-0MVF3PYO3000EVJ3 AC3)', () => {
  /** Build the (future) spawn deps carrying the already-mapped priority. */
  const piDeps = (
    spawnFn: ReturnType<typeof vi.fn>,
    requestPriority?: 'low' | 'medium' | 'high',
  ): Parameters<typeof spawnBackgroundPi>[4] =>
    ({ spawn: spawnFn as never, openSync: () => 9, requestPriority }) as Parameters<typeof spawnBackgroundPi>[4];

  it('adds HERDR_REQUEST_PRIORITY (already-mapped value) to the child process env', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    spawnBackgroundPi('/skill:implement WL-1', '/project', 'code', '/tmp/log', piDeps(spawnFn, 'low'));
    expect(spawnFn).toHaveBeenCalledWith(
      'pi',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ HERDR_REQUEST_PRIORITY: 'low' }),
      }),
    );
  });

  it('defaults an unmapped/unresolvable dispatch to high', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() }));
    spawnBackgroundPi('/prompt:Review this', '/project', undefined, '/tmp/log', piDeps(spawnFn));
    expect(spawnFn).toHaveBeenCalledWith(
      'pi',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ HERDR_REQUEST_PRIORITY: 'high' }),
      }),
    );
  });
});
