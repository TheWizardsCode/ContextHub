/**
 * tests/herdr/send-to-pi.test.ts — Tests for shared/send-to-pi.sh
 *
 * Verifies that the new pi agent pane is created in the correct project
 * directory (WL-0MS8SVY7P0094K6D): when a target CWD is available
 * (--cwd arg, HERDR_RESOLVED_CWD env, or $PWD), the script passes
 * `--cwd <target>` to `herdr pane split` so the new pane inherits the
 * correct project root instead of the source pane's CWD.
 *
 * The herdr CLI is mocked via HERDR_BIN_PATH pointing at a fake `herdr`
 * binary that records every invocation to a log file and returns a valid
 * pane_id for the split call.
 *
 * These tests exercise the PLAIN split path (--no-resize): the `--cwd`
 * propagation is implemented on `herdr pane split`, which resize mode
 * (the default) delegates to grid.py instead. Resize-mode behavior is
 * covered by packages/herdr/shared/tests/test_scripts.sh.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
let logFile: string;
let fakeHerdr: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'send-to-pi-test-'));
  logFile = join(tmpDir, 'herdr.log');

  // Fake herdr CLI: logs "$*" to the log file. For `pane split` it returns
  // a valid pane_id so the script proceeds; all other commands exit 0.
  fakeHerdr = join(tmpDir, 'herdr');
  writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env bash
echo "$*" >> "${logFile}"
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  echo '{"pane_id":"pane-123"}'
fi
exit 0
`,
  );
  chmodSync(fakeHerdr, 0o755);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run the script with the given args and env overrides.
 * Returns the exit status plus the recorded herdr invocations.
 */
function runScript(
  args: string[],
  envOverrides: Record<string, string> = {},
  scriptPath: string = SCRIPT,
): { status: number; log: string[] } {
  let status = 0;
  // Strip herdr-related env from the test runner itself so the script
  // uses only what we explicitly pass.
  const env: Record<string, string | undefined> = {
    ...process.env,
    HERDR_BIN_PATH: fakeHerdr,
  };
  delete env.HERDR_PANE_ID;
  delete env.HERDR_ENV;
  delete env.HERDR_RESOLVED_CWD;
  Object.assign(env, envOverrides);
  try {
    execFileSync('bash', [scriptPath, ...args], {
      encoding: 'utf-8',
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number };
    status = e.status ?? 1;
  }
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf-8').split('\n').filter(Boolean) : [];
  // Reset the log between runs
  rmSync(logFile, { force: true });
  return { status, log };
}

/** Return the `pane split` invocation (if any) from the recorded log. */
function splitInvocation(log: string[]): string | undefined {
  return log.find((line) => line.includes('pane split'));
}

/**
 * Extract the arguments forwarded to `run-pi-agent.sh` from a `pane run`
 * log line. The logged line is:
 *
 *   pane run <pane-id> exec bash <launcher-path> <lease-id> [--model <m>] <cmd>
 *
 * The launcher path is an absolute path into the checkout/worktree, so it can
 * legitimately contain arbitrary substrings (e.g. `code`). Assertions about
 * the forwarded pi arguments must therefore exclude it; otherwise the test is
 * sensitive to where the repository happens to be checked out
 * (WL-0MTT7XTN6006MHHV).
 */
function piArgsFromRunLine(run: string): string {
  const marker = 'run-pi-agent.sh';
  const idx = run.lastIndexOf(marker);
  if (idx === -1) return run;
  return run.slice(idx + marker.length).trim();
}

describe('send-to-pi.sh --cwd propagation', () => {
  it('passes --cwd to pane split when --cwd arg is provided', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root', '/skill:audit <id>']);
    expect(status).toBe(0);
    const split = splitInvocation(log);
    expect(split).toBeDefined();
    expect(split).toContain('--cwd');
    expect(split).toContain('/tmp/project-root');
  });

  it('passes HERDR_RESOLVED_CWD to pane split when set', () => {
    const { status, log } = runScript(['--no-resize', '/skill:audit <id>'], {
      HERDR_RESOLVED_CWD: '/home/user/projects/podcast',
    });
    expect(status).toBe(0);
    const split = splitInvocation(log);
    expect(split).toBeDefined();
    expect(split).toContain('--cwd');
    expect(split).toContain('/home/user/projects/podcast');
  });

  it('falls back to the script PWD when no target CWD is available', () => {
    const cwd = join(tmpDir, 'workdir');
    mkdirSync(cwd, { recursive: true });
    let status = 0;
    try {
      execFileSync('bash', [SCRIPT, '--no-resize', '/skill:audit <id>'], {
        encoding: 'utf-8',
        cwd,
        env: {
          ...process.env,
          HERDR_BIN_PATH: fakeHerdr,
          HERDR_PANE_ID: '',
          HERDR_ENV: '',
          HERDR_RESOLVED_CWD: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number };
      status = e.status ?? 1;
    }
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf-8').split('\n').filter(Boolean) : [];
    rmSync(logFile, { force: true });
    expect(status).toBe(0);
    const split = splitInvocation(log);
    expect(split).toBeDefined();
    expect(split).toContain('--cwd');
    expect(split).toContain(cwd);
  });

  it('still sends the command to the pi pane', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root', '/skill:audit <id>']);
    expect(status).toBe(0);
    // The command is bash-escaped (printf %q) when forwarded, so match on
    // the unescaped token rather than the exact string.
    expect(log.some((line) => line.includes('pane run') && line.includes('/skill:audit'))).toBe(true);
  });
});

describe('send-to-pi.sh --model forwarding', () => {
  it('passes --model to the pi invocation when --model is provided', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root', '--model', 'code', '/skill:implement <id>']);
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    expect(run).toContain('--model');
    expect(run).toContain('code');
    expect(run).toContain('/skill:implement');
  });

  it('supports the --model=<pattern> syntax', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root', '--model=code', '/skill:implement <id>']);
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    expect(run).toContain('--model');
    expect(run).toContain('code');
  });

  it('omits --model from the pi invocation when not provided', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root', '/skill:implement <id>']);
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    // Assert on the forwarded pi args only — the launcher path may itself
    // contain `code` depending on the checkout location (WL-0MTT7XTN6006MHHV).
    const piArgs = piArgsFromRunLine(run!);
    expect(piArgs).not.toContain('--model');
    expect(piArgs).not.toContain('code');
  });

  it('omits --model even when the checkout path contains "code" (path-insensitive)', () => {
    // Reproduce a checkout/worktree whose absolute path contains `code`: the
    // launcher path baked into the `pane run` log line then contains `code`
    // too. The assertion must only inspect the forwarded pi args, so the test
    // passes regardless of where the repository lives (WL-0MTT7XTN6006MHHV).
    const codeDir = join(tmpDir, 'some-code-checkout');
    mkdirSync(codeDir, { recursive: true });
    writeFileSync(join(codeDir, 'run-pi-agent.sh'), '#!/usr/bin/env bash\n');
    const codeScript = join(codeDir, 'send-to-pi.sh');
    writeFileSync(codeScript, readFileSync(SCRIPT, 'utf-8'));

    const { status, log } = runScript(
      ['--no-resize', '--cwd', '/tmp/project-root', '/skill:implement <id>'],
      {},
      codeScript,
    );
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    // Sanity check: the raw line really does contain `code` (via the path),
    // so a naive assertion on the whole line would fail here.
    expect(run).toContain('code');
    const piArgs = piArgsFromRunLine(run!);
    expect(piArgs).not.toContain('--model');
    expect(piArgs).not.toContain('code');
  });
});

describe('send-to-pi.sh --anchor (Dispatcher anchor-by-ID, C0 WL-0MTR01EU7005SYZG)', () => {
  it('splits the given anchor pane by ID and never calls pane current (no-resize mode)', () => {
    const { status, log } = runScript(['--no-resize', '--anchor', 'wD:pANCHOR', '--cwd', '/repo', '/skill:audit <id>']);
    expect(status).toBe(0);
    expect(log.some((line) => line.includes('pane current'))).toBe(false);
    const split = splitInvocation(log);
    expect(split).toBeDefined();
    expect(split).toContain('--pane');
    expect(split).toContain('wD:pANCHOR');
    expect(split).toContain('--cwd');
    expect(split).toContain('/repo');
  });

  it('resize mode passes the anchor id to the grid helper and never calls pane current', () => {
    // Resize mode (default) delegates the split to grid.py via HERDR_GRID_BIN.
    const gridLog = join(tmpDir, 'grid.log');
    writeFileSync(
      join(tmpDir, 'mock-grid.py'),
      `#!/usr/bin/env python3
import sys, json
with open("${gridLog}", "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
print('{"pane_id": "grid-pane-1"}')
`,
      { mode: 0o755 },
    );
    const { status, log } = runScript(
      ['--anchor', 'wD:pANCHOR', '--cwd', '/repo', '/skill:audit <id>'],
      { HERDR_GRID_BIN: join(tmpDir, 'mock-grid.py') },
    );
    expect(status).toBe(0);
    expect(log.some((line) => line.includes('pane current'))).toBe(false);
    const gridArgs = existsSync(gridLog) ? readFileSync(gridLog, 'utf-8').trim() : '';
    expect(gridArgs).toContain('wD:pANCHOR');
    expect(gridArgs).toContain('--cwd');
    expect(gridArgs).toContain('/repo');
    // The pane still receives the command + --no-focus (focus not stolen).
    expect(log.some((line) => line.includes('pane run') && line.includes('/skill:audit'))).toBe(true);
  });

  it('without --anchor keeps the legacy pane-current fallback (backward compat)', () => {
    const { log } = runScript(['--no-resize', '--cwd', '/tmp/project-root', '/skill:audit <id>']);
    // Legacy no-resize path resolves the current pane only for --anchor; the
    // plain split uses --current (mock herdr logs the pane split args).
    const split = splitInvocation(log);
    expect(split).toBeDefined();
    expect(split).toContain('--current');
  });
});

// ---------------------------------------------------------------------------
// Request-priority passthrough (test-first WL-0MVF3PYO3000EVJ3, parent
// WL-0MVE1NZ4J000H5NH)
//
// The pane process is launched by herdr's `pane run`, so an environment
// variable set on send-to-pi.sh itself does NOT reach pi. The script must
// forward the mapped request priority explicitly, as the `exec env
// HERDR_REQUEST_PRIORITY=<value> bash run-pi-agent.sh …` form.
//
// `--request-priority` forwarding implemented by WL-0MVF3Q3VL000UNCN;
// these are real assertions pinning the `HERDR_REQUEST_PRIORITY` passthrough
// into the pane process.
// ---------------------------------------------------------------------------

describe('send-to-pi.sh --request-priority forwarding (WL-0MVF3PYO3000EVJ3 AC4)', () => {
  it('passes HERDR_REQUEST_PRIORITY into the pane process', () => {
    const { status, log } = runScript([
      '--no-resize',
      '--cwd',
      '/tmp/project-root',
      '--request-priority',
      'high',
      '/skill:implement <id>',
    ]);
    expect(status).toBe(0);
    // The implementation chooses the passthrough form (`exec env …` on the
    // `pane run` command today, `pane split --env`/`grid.py` passthrough on
    // the resize path). Pin the OBSERVABLE requirement — the pane process is
    // handed the mapped priority — rather than one mechanism.
    expect(
      log.some(
        (line) =>
          line.includes('HERDR_REQUEST_PRIORITY=high') ||
          (line.includes('HERDR_REQUEST_PRIORITY') && line.includes('--env')),
      ),
    ).toBe(true);
  });

  it('omits HERDR_REQUEST_PRIORITY when no priority is supplied (backward compatible)', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root', '/skill:implement <id>']);
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    expect(log.some((line) => line.includes('HERDR_REQUEST_PRIORITY'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reservation-ticket passthrough (parent WL-0MVIKRFP0005JDL8 AC1, slice C2)
//
// The dispatcher only spawns a pane after the proxy granted a reservation
// ticket, and forwards it as `--reservation-ticket <id>`. Like the request
// priority, the value must be injected into the PANE process (an env var set
// on send-to-pi.sh does not reach pi): the Worklog pi extension reads
// PI_LOCAL_RESERVATION_TICKET and sends `X-Local-Reservation` on the session's
// first request.
// ---------------------------------------------------------------------------

describe('send-to-pi.sh --reservation-ticket forwarding (C2 AC1)', () => {
  it('passes PI_LOCAL_RESERVATION_TICKET into the pane process', () => {
    const { status, log } = runScript([
      '--no-resize',
      '--cwd',
      '/tmp/project-root',
      '--reservation-ticket',
      'tkt-granted-1',
      '/skill:implement <id>',
    ]);
    expect(status).toBe(0);
    expect(
      log.some(
        (line) =>
          line.includes('PI_LOCAL_RESERVATION_TICKET=tkt-granted-1') ||
          (line.includes('PI_LOCAL_RESERVATION_TICKET') && line.includes('--env')),
      ),
    ).toBe(true);
  });

  it('forwarded alongside the request priority and the model', () => {
    const { status, log } = runScript([
      '--no-resize',
      '--cwd',
      '/tmp/project-root',
      '--request-priority',
      'low',
      '--reservation-ticket',
      'tkt-2',
      '--model',
      'code',
      '/skill:implement <id>',
    ]);
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    expect(run).toContain('PI_LOCAL_RESERVATION_TICKET=tkt-2');
    expect(run).toContain('HERDR_REQUEST_PRIORITY=low');
    expect(run).toContain('--model');
    expect(run).toContain('code');
  });

  it('omits PI_LOCAL_RESERVATION_TICKET when no ticket is supplied (backward compatible)', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root', '/skill:implement <id>']);
    expect(status).toBe(0);
    expect(log.some((line) => line.includes('PI_LOCAL_RESERVATION_TICKET'))).toBe(false);
  });

  it('ignores an invalid ticket (token-safe fail-open, launch not aborted)', () => {
    const { status, log } = runScript([
      '--no-resize',
      '--cwd',
      '/tmp/project-root',
      '--reservation-ticket',
      'bad ticket; rm -rf /',
      '/skill:implement <id>',
    ]);
    expect(status).toBe(0);
    expect(log.some((line) => line.includes('PI_LOCAL_RESERVATION_TICKET'))).toBe(false);
    expect(log.some((line) => line.includes('pane run'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Local-preference passthrough (slice C4, parent WL-0MVIKRFP0005JDL8 AC4)
//
// Herdr conveys the per-turn locality preference per spawn. Like the request
// priority and the reservation ticket, the value must be injected into the
// PANE process (an env var set on send-to-pi.sh does not reach pi): the
// Worklog pi extension reads HERDR_LOCAL_PREFERENCE, sends
// `X-Local-Preference` on every request and records the response route
// headers in `<cwd>/.worklog/local-route.log`.
// ---------------------------------------------------------------------------

describe('send-to-pi.sh --local-preference forwarding (C4-AC1)', () => {
  it('passes both preference values into the pane process', () => {
    for (const preference of ['local-only', 'remote-ok']) {
      const { status, log } = runScript([
        '--no-resize',
        '--cwd',
        '/tmp/project-root',
        '--local-preference',
        preference,
        '/skill:implement <id>',
      ]);
      expect(status).toBe(0);
      expect(
        log.some(
          (line) =>
            line.includes(`HERDR_LOCAL_PREFERENCE=${preference}`) ||
            (line.includes('HERDR_LOCAL_PREFERENCE') && line.includes('--env')),
        ),
      ).toBe(true);
    }
  });

  it('forwards the preference alongside the ticket, priority and model', () => {
    const { status, log } = runScript([
      '--no-resize',
      '--cwd',
      '/tmp/project-root',
      '--request-priority',
      'low',
      '--reservation-ticket',
      'tkt-2',
      '--local-preference',
      'local-only',
      '--model',
      'code',
      '/skill:implement <id>',
    ]);
    expect(status).toBe(0);
    const run = log.find((line) => line.includes('pane run'));
    expect(run).toBeDefined();
    expect(run).toContain('HERDR_LOCAL_PREFERENCE=local-only');
    expect(run).toContain('PI_LOCAL_RESERVATION_TICKET=tkt-2');
    expect(run).toContain('HERDR_REQUEST_PRIORITY=low');
  });

  it('omits HERDR_LOCAL_PREFERENCE when none is supplied (byte-identical launch)', () => {
    const { status, log } = runScript(['--no-resize', '--cwd', '/tmp/project-root', '/skill:implement <id>']);
    expect(status).toBe(0);
    expect(log.some((line) => line.includes('HERDR_LOCAL_PREFERENCE'))).toBe(false);
  });

  it('ignores an invalid preference (fail-open, launch not aborted)', () => {
    const { status, log } = runScript([
      '--no-resize',
      '--cwd',
      '/tmp/project-root',
      '--local-preference',
      'auto; rm -rf /',
      '/skill:implement <id>',
    ]);
    expect(status).toBe(0);
    expect(log.some((line) => line.includes('HERDR_LOCAL_PREFERENCE'))).toBe(false);
    expect(log.some((line) => line.includes('pane run'))).toBe(true);
  });
});
