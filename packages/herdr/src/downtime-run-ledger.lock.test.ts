/**
 * packages/herdr/src/downtime-run-ledger.lock.test.ts — pins the LOCK PLACEMENT
 * of the machine-scoped run ledger.
 *
 * Work item: WL-0MWT54AR8005LMKN (remediation AC2, parent WL-0MWT3Z9M9002Z9BF).
 *
 * The ledger write must happen INSIDE the existing round-robin charge critical
 * section, so a consumed dispatch costs exactly ONE coordination-lock
 * acquisition for both `downtime-round-robin-by-root.json` AND
 * `downtime-run-by-root.json`. The spy below counts the acquisitions made by
 * `advanceRoot`; two would mean the ledger took its own lock (the defect this
 * test pins against).
 *
 * Deterministic: real temporary coordination directory, injected clock, no
 * live `wl`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lockCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('./coordination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./coordination.js')>();
  return {
    ...actual,
    tryAcquireCoordLock: (dir: string) => {
      lockCalls.count += 1;
      return actual.tryAcquireCoordLock(dir);
    },
  };
});

import { tryAcquireCoordLock } from './coordination.js';
import {
  ROUND_ROBIN_BY_ROOT_FILE_NAME,
  advanceRoot,
  loadRoundRobinCursor,
} from './downtime-round-robin-by-root.js';
import {
  RUN_LEDGER_FILE_NAME,
  readCurrentDispatchRun,
} from './downtime-run-ledger.js';

let coordinationDir: string;

beforeEach(() => {
  coordinationDir = mkdtempSync(join(tmpdir(), 'herdr-run-ledger-lock-'));
  lockCalls.count = 0;
});

afterEach(() => {
  rmSync(coordinationDir, { recursive: true, force: true });
});

describe('run ledger lock placement (WL-0MWT54AR8005LMKN AC2)', () => {
  it('advances cursor AND ledger under exactly ONE coordination-lock acquisition', () => {
    advanceRoot(coordinationDir, '/repo/a', 1_000);

    // ONE acquisition for the whole charge: the ledger piggybacks on the
    // cursor's existing critical section and never takes a lock of its own.
    expect(lockCalls.count).toBe(1);
    expect(loadRoundRobinCursor(coordinationDir)).toEqual({
      '/repo/a': new Date(1_000).toISOString(),
    });
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 1 });

    // The cursor file format is unchanged: still a flat `{ root: ISO-8601 }`
    // map, with the run state in its SEPARATE record.
    expect(Object.keys(loadRoundRobinCursor(coordinationDir))).toEqual(['/repo/a']);
    expect(RUN_LEDGER_FILE_NAME).not.toBe(ROUND_ROBIN_BY_ROOT_FILE_NAME);
  });

  it('a failed lock acquisition leaves BOTH files unchanged (fail-open, one attempt)', () => {
    const release = tryAcquireCoordLock(coordinationDir);
    expect(release).not.toBeNull();
    try {
      lockCalls.count = 0;
      advanceRoot(coordinationDir, '/repo/a', 1_000);
      expect(lockCalls.count).toBe(1); // exactly one attempt, never a retry loop
    } finally {
      release!();
    }
    expect(loadRoundRobinCursor(coordinationDir)).toEqual({});
    expect(readCurrentDispatchRun(coordinationDir)).toBeNull();
  });
});
