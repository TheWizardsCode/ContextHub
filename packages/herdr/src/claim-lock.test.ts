/**
 * packages/herdr/src/claim-lock.test.ts — contract tests for the claim-holder
 * heldness probe (WL-0MVWDAZL10025P8J).
 *
 * These tests pin the behaviour the hydrator's "busy = pane OR live claim
 * holder" cycle (sibling child) depends on:
 *
 *  - a lock file CURRENTLY `flock`ed by another process is `held` (taken with
 *    a REAL holder process, not a fake);
 *  - a lock file whose `flock` is free AND whose recorded pid is dead is NOT
 *    held, so demotion still releases genuinely stuck claims;
 *  - a missing lock file is not held, creates nothing and never shells out;
 *  - every ambiguous state (unenumerable `locks/`, corrupt metadata, thrown
 *    `fs`/`flock` error) fails OPEN (`held`) with a distinct named reason;
 *  - the recorded-pid fallback is guarded against pid reuse via the process
 *    start time;
 *  - a 50-candidate batch performs exactly ONE lock-directory read and no
 *    per-item `wl`/`herdr` spawn;
 *  - probing is side-effect free (the `locks/` directory is byte-identical
 *    afterwards);
 *  - unknown/extra fields and a token-bearing (re-entrant) holder never break
 *    the parse.
 *
 * Run: npx vitest run packages/herdr/src/claim-lock.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  createFlockProber,
  probeClaimHolders,
  type ClaimHolderVerdict,
  type ClaimLockDeps,
} from './claim-lock.js';

// ── Fixtures & helpers ────────────────────────────────────────────────

const tempRoots: string[] = [];
const holders: ChildProcess[] = [];

/** Create a temp worklog root with an empty `locks/` directory. */
function makeWorklog(): string {
  const root = mkdtempSync(join(tmpdir(), 'herdr-claim-lock-'));
  mkdirSync(join(root, 'locks'));
  tempRoots.push(root);
  return root;
}

function lockPath(worklog: string, id: string): string {
  return join(worklog, 'locks', `child-${id}.lock`);
}

/** Write a lock file with the given metadata and return its path. */
function writeLock(
  worklog: string,
  id: string,
  meta: Record<string, unknown> = defaultMeta(),
): string {
  const p = lockPath(worklog, id);
  writeFileSync(p, JSON.stringify(meta), 'utf8');
  return p;
}

function defaultMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: 'implement',
    pid: 2_147_483_647, // a pid that is never alive on this host
    session_id: 'herdr-test-session',
    started_at: '2026-10-31T09:03:53.158119+00:00',
    token: 'deadbeef',
    ...overrides,
  };
}

/**
 * A deps stub with every seam overridable — the "injected counters". Defaults
 * read the REAL filesystem so a test only overrides the seam it exercises.
 */
function depsStub(overrides: Partial<ClaimLockDeps> = {}): ClaimLockDeps {
  return {
    readLockDir: async (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return null;
      }
    },
    readLockFile: async (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    isFlockHeld: async () => false,
    isPidAlive: () => false,
    getProcessStartMs: () => undefined,
    now: () => Date.parse('2026-10-31T12:00:00Z'),
    ...overrides,
  };
}

/**
 * Spawn a REAL process that holds an exclusive `flock` on *path* for its
 * lifetime and poll until the lock is actually observed as held.
 */
async function spawnHolder(path: string): Promise<ChildProcess> {
  const child = spawn('flock', ['-n', path, 'sleep', '60'], { stdio: 'ignore' });
  holders.push(child);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // Fresh prober per poll: a prober caches its `/proc/locks` snapshot for
    // the lifetime of one batch, so reuse would never see the new lock.
    const held = await createFlockProber({ platform: 'linux' })(path);
    if (held === true) return child;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the flock holder to acquire the lock');
}

afterEach(() => {
  for (const h of holders.splice(0)) {
    try {
      h.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const r of tempRoots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ── AC1: live claim holder suppresses demotion ───────────────────────

describe('probeClaimHolders — live claim holder', () => {
  it('reports held when the lock file is currently flocked by a real process', async () => {
    const worklog = makeWorklog();
    const id = 'WL-HOLDER0001';
    const path = writeLock(worklog, id);
    await spawnHolder(path);

    const verdicts = await probeClaimHolders([id], { worklogDir: worklog });
    const verdict = verdicts.get(id)!;

    expect(verdict.held).toBe(true);
    expect(verdict.reason).toBe('flock-held');
    // Diagnostic metadata is surfaced when readable.
    expect(verdict.agent).toBe('implement');
    expect(verdict.sessionId).toBe('herdr-test-session');
    expect(verdict.startedAt).toBe('2026-10-31T09:03:53.158119+00:00');
  });

  it('sees a held lock through the portable flock-spawn fallback too', async () => {
    const worklog = makeWorklog();
    const id = 'WL-HOLDER0002';
    const path = writeLock(worklog, id);
    await spawnHolder(path);

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      // Force the non-Linux path (per-file `flock` spawn).
      platform: 'darwin',
    });

    expect(verdicts.get(id)!.held).toBe(true);
    expect(verdicts.get(id)!.reason).toBe('flock-held');
  });
});

// ── AC2: dead holders are still released ─────────────────────────────

describe('probeClaimHolders — dead holder release (no regression to stuck claims)', () => {
  it('reports not held when the flock is free and the recorded pid is dead', async () => {
    const worklog = makeWorklog();
    const id = 'WL-STALE00001';
    writeLock(worklog, id);

    const verdicts = await probeClaimHolders([id], { worklogDir: worklog });
    const verdict = verdicts.get(id)!;

    expect(verdict.held).toBe(false);
    expect(verdict.reason).toBe('stale');
  });

  it('reports stale via the portable fallback when the recorded pid is dead', async () => {
    const worklog = makeWorklog();
    const id = 'WL-STALE00002';
    writeLock(worklog, id);

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      platform: 'darwin',
    });

    expect(verdicts.get(id)!.held).toBe(false);
    expect(verdicts.get(id)!.reason).toBe('stale');
  });
});

// ── AC3: missing file ────────────────────────────────────────────────

describe('probeClaimHolders — missing lock file', () => {
  it('reports not held with zero spawns and creates no file', async () => {
    const worklog = makeWorklog();
    const id = 'WL-NOLOCK0001';

    const readLockFile = vi.fn(async () => null);
    const isFlockHeld = vi.fn(async () => false);

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      deps: depsStub({ readLockFile, isFlockHeld }),
    });

    expect(verdicts.get(id)).toMatchObject({ held: false, reason: 'no-lock-file' });
    // Never read or probed a file that is not there.
    expect(readLockFile).not.toHaveBeenCalled();
    expect(isFlockHeld).not.toHaveBeenCalled();
    expect(readdirSync(join(worklog, 'locks'))).toEqual([]);
  });
});

// ── AC4: fail-open on ambiguity ──────────────────────────────────────

describe('probeClaimHolders — fail-open on ambiguity', () => {
  it('reports held with a named reason when the locks directory is unenumerable', async () => {
    const worklog = makeWorklog();
    const verdicts = await probeClaimHolders(['WL-DIRERROR01', 'WL-DIRERROR02'], {
      worklogDir: worklog,
      deps: depsStub({ readLockDir: async () => null }),
    });

    for (const verdict of verdicts.values()) {
      expect(verdict.held).toBe(true);
      expect(verdict.reason).toBe('locks-dir-unreadable');
    }
  });

  it('reports held with a named reason when the lock metadata is corrupt', async () => {
    const worklog = makeWorklog();
    const id = 'WL-CORRUPT001';
    writeFileSync(lockPath(worklog, id), '{not json', 'utf8');

    const verdicts = await probeClaimHolders([id], { worklogDir: worklog });
    expect(verdicts.get(id)).toMatchObject({ held: true, reason: 'corrupt-lock-file' });
  });

  it('reports held with a named reason when reading the lock file throws', async () => {
    const worklog = makeWorklog();
    const id = 'WL-FSERROR001';
    writeLock(worklog, id);

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      deps: depsStub({
        readLockFile: async () => {
          throw new Error('EACCES');
        },
      }),
    });
    expect(verdicts.get(id)).toMatchObject({ held: true, reason: 'probe-error' });
  });

  it('reports held with a named reason when the flock probe throws', async () => {
    const worklog = makeWorklog();
    const id = 'WL-FLOCKERR01';
    writeLock(worklog, id);

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      deps: depsStub({
        isFlockHeld: async () => {
          throw new Error('flock exploded');
        },
      }),
    });
    expect(verdicts.get(id)).toMatchObject({ held: true, reason: 'probe-error' });
  });

  it('reports held when the flock probe cannot decide (null)', async () => {
    const worklog = makeWorklog();
    const id = 'WL-FLOCKNULL1';
    writeLock(worklog, id);

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      deps: depsStub({ isFlockHeld: async () => null }),
    });
    expect(verdicts.get(id)).toMatchObject({ held: true, reason: 'probe-error' });
  });

  it('reports held (never released) for an empty lock file', async () => {
    const worklog = makeWorklog();
    const id = 'WL-EMPTY00001';
    writeFileSync(lockPath(worklog, id), '', 'utf8');

    const verdicts = await probeClaimHolders([id], { worklogDir: worklog });
    expect(verdicts.get(id)).toMatchObject({ held: true, reason: 'corrupt-lock-file' });
  });
});

// ── AC5: pid-reuse guard ─────────────────────────────────────────────

describe('probeClaimHolders — pid-reuse guard', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');

  it('reports held when the lock started before the recorded process started (reused pid)', async () => {
    const worklog = makeWorklog();
    const id = 'WL-PIDREUSE01';
    writeLock(worklog, id, defaultMeta({ pid: 4242, started_at: '2026-10-31T11:00:00Z' }));

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      deps: depsStub({
        isFlockHeld: async () => false,
        isPidAlive: () => true,
        // The process currently owning pid 4242 started well AFTER the lock.
        getProcessStartMs: () => Date.parse('2026-10-31T11:30:00Z'),
        now: () => now,
      }),
    });

    expect(verdicts.get(id)).toMatchObject({ held: true, reason: 'pid-reuse-suspected' });
  });

  it('trusts the pid when the lock is not older than the process start', async () => {
    const worklog = makeWorklog();
    const id = 'WL-PIDTRUST01';
    writeLock(worklog, id, defaultMeta({ pid: 4242, started_at: '2026-10-31T11:45:00Z' }));

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      deps: depsStub({
        isFlockHeld: async () => false,
        isPidAlive: () => true,
        getProcessStartMs: () => Date.parse('2026-10-31T11:30:00Z'),
        now: () => now,
      }),
    });

    expect(verdicts.get(id)).toMatchObject({ held: true, reason: 'pid-alive' });
  });

  it('fails open when the process start time is unavailable (cannot prove reuse)', async () => {
    const worklog = makeWorklog();
    const id = 'WL-PIDNOINFO1';
    writeLock(worklog, id, defaultMeta({ pid: 4242 }));

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      deps: depsStub({
        isFlockHeld: async () => false,
        isPidAlive: () => true,
        getProcessStartMs: () => undefined,
        now: () => now,
      }),
    });

    expect(verdicts.get(id)).toMatchObject({ held: true, reason: 'pid-alive' });
  });
});

// ── AC6: bounded cost ────────────────────────────────────────────────

describe('probeClaimHolders — bounded cost', () => {
  it('does exactly one lock-directory read and no wl/herdr spawn for 50 candidates', async () => {
    const worklog = makeWorklog();
    const ids = Array.from({ length: 50 }, (_, i) => `WL-COST${String(i).padStart(5, '0')}`);
    for (const id of ids) writeLock(worklog, id);

    const recordSpawn = vi.fn();
    const readLockDir = vi.fn(async (dir: string) => readdirSync(dir));
    const readLockFile = vi.fn(async (p: string) => readFileSync(p, 'utf8'));

    const verdicts = await probeClaimHolders(ids, {
      worklogDir: worklog,
      // Real flock prober: on Linux this uses ONE /proc/locks snapshot (zero
      // spawns). The injected `recordSpawn` counter proves no wl/herdr spawn.
      deps: { readLockDir, readLockFile, recordSpawn, isPidAlive: () => false },
    });

    expect(verdicts.size).toBe(50);
    expect(readLockDir).toHaveBeenCalledTimes(1);
    // Never shells out to wl/herdr per item; any spawn recorded is a flock probe.
    for (const call of recordSpawn.mock.calls) {
      expect(['wl', 'herdr']).not.toContain(call[0]);
    }
  });
});

// ── AC7: no side effects ─────────────────────────────────────────────

describe('probeClaimHolders — no side effects', () => {
  it('leaves the locks directory byte-identical after probing a mixed batch', async () => {
    const worklog = makeWorklog();
    const locksDir = join(worklog, 'locks');

    const heldId = 'WL-SIDEFECTH1';
    const staleId = 'WL-SIDEFECTS1';
    const corruptId = 'WL-SIDEFECTC1';
    const missingId = 'WL-SIDEFECTM1';

    const heldPath = writeLock(worklog, heldId);
    writeLock(worklog, staleId);
    writeFileSync(lockPath(worklog, corruptId), '{not json', 'utf8');
    await spawnHolder(heldPath);

    const snapshot = (): Array<{ name: string; size: number; bytes: string }> =>
      readdirSync(locksDir)
        .sort()
        .map((name) => ({
          name,
          size: statSync(join(locksDir, name)).size,
          bytes: readFileSync(join(locksDir, name), 'utf8'),
        }));

    const before = snapshot();
    const verdicts = await probeClaimHolders([heldId, staleId, corruptId, missingId], {
      worklogDir: worklog,
    });
    const after = snapshot();

    expect(after).toEqual(before);
    expect(verdicts.get(heldId)!.held).toBe(true);
    expect(verdicts.get(staleId)!.held).toBe(false);
    expect(verdicts.get(corruptId)!.held).toBe(true);
    expect(verdicts.get(missingId)!.held).toBe(false);
  });
});

// ── AC8: defensive parsing ───────────────────────────────────────────

describe('probeClaimHolders — defensive parsing', () => {
  it('ignores unknown/extra fields and a token-bearing re-entrant holder', async () => {
    const worklog = makeWorklog();
    const id = 'WL-EXTRAFIEL1';
    const path = writeLock(
      worklog,
      id,
      defaultMeta({
        // Re-entrant holder chain: the token is present but must not matter.
        token: 'chain-token-abc',
        extra_unknown_field: { nested: [1, 2, 3] },
        another: 'ignored',
      }),
    );
    await spawnHolder(path);

    const verdicts = await probeClaimHolders([id], { worklogDir: worklog });
    const verdict = verdicts.get(id)!;

    expect(verdict.held).toBe(true);
    expect(verdict.reason).toBe('flock-held');
    // The probe never writes: the file is byte-identical afterwards.
    expect(JSON.parse(readFileSync(path, 'utf8')).extra_unknown_field).toEqual({
      nested: [1, 2, 3],
    });
  });

  it('tolerates a lock file with a non-numeric pid (unprovable → held)', async () => {
    const worklog = makeWorklog();
    const id = 'WL-BADPID0001';
    writeLock(worklog, id, defaultMeta({ pid: 'not-a-number' }));

    const verdicts = await probeClaimHolders([id], {
      worklogDir: worklog,
      deps: depsStub({ isFlockHeld: async () => false }),
    });

    expect(verdicts.get(id)!.held).toBe(true);
    expect(verdicts.get(id)!.reason).toBe('probe-error');
  });
});

// ── Verdict shape ────────────────────────────────────────────────────

describe('probeClaimHolders — result map', () => {
  it('returns a verdict for every requested id, including duplicates', async () => {
    const worklog = makeWorklog();
    const verdicts = await probeClaimHolders(['WL-A', 'WL-B', 'WL-A'], {
      worklogDir: worklog,
    });

    expect(verdicts.size).toBe(2);
    expect(verdicts.get('WL-A')!.held).toBe(false);
    expect(verdicts.get('WL-B')!.held).toBe(false);
  });

  it('exposes the documented verdict shape', () => {
    const verdict: ClaimHolderVerdict = {
      held: true,
      reason: 'flock-held',
      pid: 1,
      sessionId: 's',
      agent: 'a',
      startedAt: 't',
    };
    expect(verdict.held).toBe(true);
  });
});
