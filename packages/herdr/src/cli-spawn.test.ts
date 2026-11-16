/**
 * packages/herdr/src/cli-spawn.test.ts — the shared CLI-resolution + spawn
 * plumbing (WL-0MWHWHB3X004H9VG AC1).
 *
 * Pins the single convention every wl/herdr subprocess boundary shares:
 *  - the canonical `wl`→`worklog` probe order ({@link CLI_BINARIES});
 *  - the bounded timeout (60 s default, mapped onto the execFile `timeout`
 *    option);
 *  - the stdout shape normalisation for promisify(execFile) variants
 *    (`{stdout}` object, raw string/Buffer, and the test-harness raw-value
 *    shapes);
 *  - the error normalisation (ENOENT probes the next binary; other errors
 *    wrap with stderr > stdout > message precedence; a hung child is
 *    classified `cliTimedOut`).
 *
 * These are exactly the semantics the fetcher family's suites pin through
 * `runWl` (fetcher-timeout.test.ts, fetcher-spawn-cap.test.ts) — this module
 * is the primitive they now share with the herdr invoke sites.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CLI_BINARIES,
  DEFAULT_CLI_TIMEOUT_MS,
  isCliTimeoutError,
  spawnCliStdout,
  wrapCliSpawnError,
} from './cli-spawn.js';
// Formerly-independent call-site constants, imported so the pins below prove
// they BIND the canonical declarations rather than re-declaring them
// (AC1: "constants shared, not re-declared").
import {
  CLI_BINARIES as FETCHER_CLI_BINARIES,
  DEFAULT_WL_TIMEOUT_MS,
} from './fetcher.cli.js';
import { CLI_COMMAND_TIMEOUT_MS } from './pane-close-cli.js';

/** A rejected ENOENT exec error (binary absent from PATH). */
function enoent(binary: string): Error {
  const err = new Error(`spawn ${binary} ENOENT`) as Error & { code?: string };
  err.code = 'ENOENT';
  return err;
}

type Exec = (file: string, args: string[], options?: unknown) => Promise<unknown>;

const okExec = (stdout: string): Exec =>
  (async () => ({ stdout, stderr: '' })) as Exec;

describe('CLI_BINARIES / DEFAULT_CLI_TIMEOUT_MS (AC1 canonical declarations)', () => {
  it('declares the single wl→worklog probe order', () => {
    expect([...CLI_BINARIES]).toEqual(['wl', 'worklog']);
  });

  it('declares the single 60 s bounded-spawn timeout', () => {
    expect(DEFAULT_CLI_TIMEOUT_MS).toBe(60_000);
  });

  it('is the ONE declaration every call site binds (no re-declaration)', () => {
    // fetcher.cli.ts re-exports the same array; pane-close-cli.ts binds the
    // same timeout. If either re-declared its own copy these identities break.
    expect(FETCHER_CLI_BINARIES).toBe(CLI_BINARIES);
    expect(DEFAULT_WL_TIMEOUT_MS).toBe(DEFAULT_CLI_TIMEOUT_MS);
    expect(CLI_COMMAND_TIMEOUT_MS).toBe(DEFAULT_CLI_TIMEOUT_MS);
  });
});

describe('spawnCliStdout — probe order (AC1 binary probe)', () => {
  it('probes the next binary only when the previous one is ENOENT', async () => {
    const calls: string[] = [];
    const exec = (async (file: string): Promise<unknown> => {
      calls.push(file);
      if (file === 'wl') throw enoent('wl');
      return { stdout: '{"ok":true}', stderr: '' };
    }) as Exec;
    await expect(spawnCliStdout(exec, CLI_BINARIES, ['list'])).resolves.toBe('{"ok":true}');
    expect(calls).toEqual(['wl', 'worklog']);
  });

  it('returns the first binary stdout without probing further', async () => {
    const exec = (async (file: string): Promise<unknown> => {
      expect(file).toBe('wl');
      return { stdout: '{"ok":true}', stderr: '' };
    }) as Exec;
    await expect(spawnCliStdout(exec, CLI_BINARIES, ['list'])).resolves.toBe('{"ok":true}');
  });

  it('throws a not-found error when every candidate is ENOENT', async () => {
    const exec = (async () => {
      throw enoent('wl');
    }) as Exec;
    await expect(spawnCliStdout(exec, CLI_BINARIES, ['list'])).rejects.toThrow(/wl CLI not found:/);
  });
});

describe('spawnCliStdout — stdout shape normalisation', () => {
  it('extracts stdout from the promisify(execFile) { stdout, stderr } shape', async () => {
    await expect(spawnCliStdout(okExec('payload'), ['b'], [])).resolves.toBe('payload');
  });

  it('passes through a raw string result (test-harness promisify shape)', async () => {
    const exec = (async () => 'raw payload') as Exec;
    await expect(spawnCliStdout(exec, ['b'], [])).resolves.toBe('raw payload');
  });

  it('decodes a raw Buffer result (no encoding option)', async () => {
    const exec = (async () => Buffer.from('buffer payload', 'utf8')) as Exec;
    await expect(spawnCliStdout(exec, ['b'], [])).resolves.toBe('buffer payload');
  });

  it('decodes a Buffer stdout inside the result object', async () => {
    const exec = (async () => ({ stdout: Buffer.from('obj buffer', 'utf8'), stderr: '' })) as Exec;
    await expect(spawnCliStdout(exec, ['b'], [])).resolves.toBe('obj buffer');
  });

  it('yields the empty string when stdout is absent', async () => {
    const exec = (async () => ({ stderr: '' })) as Exec;
    await expect(spawnCliStdout(exec, ['b'], [])).resolves.toBe('');
  });
});

describe('spawnCliStdout — bounded timeout + spawn options', () => {
  it('maps timeoutMs onto the execFile `timeout` option (the fetch contract)', async () => {
    const exec = vi.fn(async (_file: string, _args: string[], opts?: unknown) => {
      expect((opts as { timeout?: number }).timeout).toBe(DEFAULT_CLI_TIMEOUT_MS);
      return { stdout: 'x', stderr: '' };
    });
    await spawnCliStdout(exec as Exec, ['wl'], ['list'], { timeoutMs: DEFAULT_CLI_TIMEOUT_MS });
    expect(exec).toHaveBeenCalledWith('wl', ['list'], { timeout: DEFAULT_CLI_TIMEOUT_MS });
  });

  it('passes maxBuffer / cwd / encoding through to the exec seam', async () => {
    const exec = vi.fn(async () => ({ stdout: 'x', stderr: '' }));
    await spawnCliStdout(exec as Exec, ['h'], ['pane', 'list'], {
      timeoutMs: 5000,
      maxBuffer: 8 * 1024 * 1024,
      cwd: '/proj',
      encoding: 'utf8',
    });
    expect(exec).toHaveBeenCalledWith('h', ['pane', 'list'], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      cwd: '/proj',
      encoding: 'utf8',
    });
  });
});

describe('spawnCliStdout — error normalisation', () => {
  it('wraps a non-ENOENT error with stderr > stdout > message precedence', async () => {
    const exec = (async () => {
      const err = new Error('generic message') as Error & { stderr?: string; stdout?: string };
      err.stderr = '  real stderr  ';
      err.stdout = 'real stdout';
      throw err;
    }) as Exec;
    await expect(spawnCliStdout(exec, ['b'], [])).rejects.toThrow('real stderr');
  });

  it('falls back to stdout, then message, then String(error)', async () => {
    const stdoutExec = (async () => {
      const err = new Error('generic') as Error & { stdout?: string };
      err.stdout = 'stdout-only';
      throw err;
    }) as Exec;
    await expect(spawnCliStdout(stdoutExec, ['b'], [])).rejects.toThrow('stdout-only');

    const messageExec = (async () => {
      throw new Error('message-only');
    }) as Exec;
    await expect(spawnCliStdout(messageExec, ['b'], [])).rejects.toThrow('message-only');
  });

  it('does NOT retry the next binary after a non-ENOENT failure', async () => {
    const calls: string[] = [];
    const exec = (async (file: string): Promise<unknown> => {
      calls.push(file);
      throw new Error('rejecting CLI');
    }) as Exec;
    await expect(spawnCliStdout(exec, CLI_BINARIES, ['list'])).rejects.toThrow('rejecting CLI');
    expect(calls).toEqual(['wl']);
  });
});

describe('spawnCliStdout / wrapCliSpawnError — hung-child classification', () => {
  it('marks the wrapped error cliTimedOut for a killed child', () => {
    const err = new Error('killed') as Error & { killed?: boolean };
    err.killed = true;
    expect(wrapCliSpawnError(err).cliTimedOut).toBe(true);
  });

  it('marks the wrapped error cliTimedOut for SIGTERM / SIGKILL signals', () => {
    expect(wrapCliSpawnError({ signal: 'SIGTERM' }).cliTimedOut).toBe(true);
    expect(wrapCliSpawnError({ signal: 'SIGKILL' }).cliTimedOut).toBe(true);
  });

  it('marks the wrapped error cliTimedOut for ETIMEDOUT codes', () => {
    expect(wrapCliSpawnError({ code: 'ETIMEDOUT' }).cliTimedOut).toBe(true);
  });

  it('marks the wrapped error cliTimedOut for a "timed out" message', () => {
    expect(wrapCliSpawnError(new Error('wl child killed: timeout')).cliTimedOut).toBe(true);
  });

  it('leaves an ordinary rejection unclassified', async () => {
    const exec = (async () => {
      throw new Error('wl rejected the command');
    }) as Exec;
    const promise = spawnCliStdout(exec, ['b'], []);
    await expect(promise).rejects.toThrow('wl rejected the command');
    await promise.catch((error: { cliTimedOut?: boolean }) => {
      expect(error.cliTimedOut).toBeUndefined();
    });
  });
});

describe('isCliTimeoutError', () => {
  it('classifies a hung child and nothing else', () => {
    expect(isCliTimeoutError({ killed: true })).toBe(true);
    expect(isCliTimeoutError({ signal: 'SIGTERM' })).toBe(true);
    expect(isCliTimeoutError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isCliTimeoutError(new Error('timed out'))).toBe(true);
    expect(isCliTimeoutError(new Error('command failed'))).toBe(false);
    expect(isCliTimeoutError(null)).toBe(false);
    expect(isCliTimeoutError(undefined)).toBe(false);
    expect(isCliTimeoutError('string')).toBe(false);
  });
});
