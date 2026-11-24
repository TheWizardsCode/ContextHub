/**
 * packages/herdr/src/downtime-run-ledger.test.ts — the machine-scoped run
 * ledger that makes the twice-in-succession bound leadership-independent.
 *
 * Work item: WL-0MWT3Z9M9002Z9BF (parent WL-0MWKE9VF800101V9 AC1); revised by
 * WL-0MWT54AR8005LMKN (write inside the round-robin charge critical section).
 *
 * Pins:
 *  1. a fresh ledger records the first dispatch of a root as a run of `1`;
 *  2. repeated dispatches to one root increment the run;
 *  3. a dispatch to a different root starts a fresh run of `1`;
 *  4. the record survives a "leadership hand-off" — a different caller reading
 *     the SAME machine directory sees the previous run (the whole point);
 *  5. every reader/writer is fail-open on a missing/corrupt/malformed ledger;
 *  6. the on-disk shape is a single `{ root, runLength, at }` record written
 *     atomically (no leftover `.tmp`);
 *  7. `advanceRoot` (the round-robin charge) advances the ledger under the SAME
 *     lock hold, keyed on the same `worklogRoot` identity as the cursor
 *     (`advanceRoot` is the production write path — no second acquisition; the
 *     dedicated single-acquisition spy lives in
 *     `downtime-run-ledger.lock.test.ts`).
 *
 * Deterministic: real temporary coordination directory, injected clock, no
 * live `wl`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withCoordLock } from './coordination.js';
import {
  RUN_LEDGER_FILE_NAME,
  loadDispatchRun,
  readCurrentDispatchRun,
  writeDispatchRunLocked,
} from './downtime-run-ledger.js';
import {
  ROUND_ROBIN_BY_ROOT_FILE_NAME,
  advanceRoot,
  loadRoundRobinCursor,
} from './downtime-round-robin-by-root.js';

let coordinationDir: string;

beforeEach(() => {
  coordinationDir = mkdtempSync(join(tmpdir(), 'herdr-run-ledger-'));
});

afterEach(() => {
  rmSync(coordinationDir, { recursive: true, force: true });
});

function ledgerPath(): string {
  return join(coordinationDir, RUN_LEDGER_FILE_NAME);
}

/**
 * Seed/record a run the way the production charge does: hold the coordination
 * lock and write the ledger record. The dispatcher itself never obtains a lock
 * here — `advanceRoot` already holds it and calls `writeDispatchRunLocked`.
 */
function recordRun(root: string, now: number): number {
  const value = withCoordLock(coordinationDir, () => writeDispatchRunLocked(coordinationDir, root, now));
  if (value === null) throw new Error('coordination lock unavailable in test');
  return value;
}

describe('run ledger — ordering-independent consecutive-run accounting', () => {
  it('records the first dispatch of a root as a run of 1', () => {
    expect(recordRun('/repo/a', 1_000)).toBe(1);
    expect(loadDispatchRun(coordinationDir)).toEqual({
      root: '/repo/a',
      runLength: 1,
      at: new Date(1_000).toISOString(),
    });
  });

  it('increments the run for repeated dispatches to one root', () => {
    expect(recordRun('/repo/a', 1_000)).toBe(1);
    expect(recordRun('/repo/a', 2_000)).toBe(2);
    expect(recordRun('/repo/a', 3_000)).toBe(3);
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 3 });
  });

  it('starts a fresh run of 1 when the dispatching root changes', () => {
    recordRun('/repo/a', 1_000);
    recordRun('/repo/a', 2_000);
    expect(recordRun('/repo/b', 3_000)).toBe(1);
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/b', length: 1 });
  });

  it('keeps a live run across a leadership hand-off (a different caller reads the same dir)', () => {
    // Leader 1 (whatever its own project root) dispatches twice to /repo/a.
    recordRun('/repo/a', 1_000);
    recordRun('/repo/a', 2_000);

    // Leadership moves to a different root/project: the ONLY shared state is
    // the machine coordination directory, so a fresh read still sees run = 2.
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 2 });
    // The next dispatch to /repo/a — from the new leader — extends, not resets.
    expect(recordRun('/repo/a', 3_000)).toBe(3);
  });
});

describe('run ledger — the round-robin charge is the write path', () => {
  it('advanceRoot writes both the cursor and the ledger under one lock hold', () => {
    advanceRoot(coordinationDir, '/repo/a', 1_000);
    advanceRoot(coordinationDir, '/repo/a', 2_000);

    // The cursor key and the ledger root are the SAME `worklogRoot` identity.
    expect(loadRoundRobinCursor(coordinationDir)).toEqual({
      '/repo/a': new Date(2_000).toISOString(),
    });
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 2 });
    expect(readdirSync(coordinationDir).sort()).toEqual(
      [ROUND_ROBIN_BY_ROOT_FILE_NAME, RUN_LEDGER_FILE_NAME].sort(),
    );
  });

  it('an empty root is a no-op for both the cursor and the ledger (defensive)', () => {
    advanceRoot(coordinationDir, '', 1_000);
    expect(loadRoundRobinCursor(coordinationDir)).toEqual({});
    expect(loadDispatchRun(coordinationDir)).toBeNull();
  });

  it('ledger records a root change while the cursor keeps one entry per root', () => {
    advanceRoot(coordinationDir, '/repo/a', 1_000);
    advanceRoot(coordinationDir, '/repo/a', 2_000);
    advanceRoot(coordinationDir, '/repo/b', 3_000);

    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/b', length: 1 });
    // The cursor is last-write-wins per root, so both roots remain recorded.
    expect(Object.keys(loadRoundRobinCursor(coordinationDir)).sort()).toEqual([
      '/repo/a',
      '/repo/b',
    ]);
  });
});

describe('run ledger — fail-open contract', () => {
  it('resolves null for a missing ledger', () => {
    expect(loadDispatchRun(coordinationDir)).toBeNull();
    expect(readCurrentDispatchRun(coordinationDir)).toBeNull();
  });

  it('resolves null for an empty ledger file', () => {
    writeFileSync(ledgerPath(), '   \n', 'utf-8');
    expect(readCurrentDispatchRun(coordinationDir)).toBeNull();
  });

  it('resolves null for corrupt JSON without throwing', () => {
    writeFileSync(ledgerPath(), 'not-json{{{\n', 'utf-8');
    expect(readCurrentDispatchRun(coordinationDir)).toBeNull();
  });

  it('resolves null for a malformed record (wrong/missing fields)', () => {
    for (const bad of [
      { root: '', runLength: 2, at: '2026-01-01T00:00:00.000Z' },
      { root: '/a', runLength: 0, at: '2026-01-01T00:00:00.000Z' },
      { root: '/a', runLength: 2, at: 'not-a-date' },
      { root: 42, runLength: 2, at: '2026-01-01T00:00:00.000Z' },
      { root: '/a', runLength: 2 },
    ]) {
      writeFileSync(ledgerPath(), JSON.stringify(bad), 'utf-8');
      expect(readCurrentDispatchRun(coordinationDir)).toBeNull();
    }
  });

  it('fail-open: a record after a corrupt ledger restarts the run at 1', () => {
    writeFileSync(ledgerPath(), 'not-json{{{\n', 'utf-8');
    expect(recordRun('/repo/a', 1_000)).toBe(1);
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 1 });
  });

  it('records an empty root as a no-op run of 1 (defensive)', () => {
    expect(recordRun('', 1_000)).toBe(1);
    expect(loadDispatchRun(coordinationDir)).toBeNull();
  });
});

describe('run ledger — on-disk shape', () => {
  it('writes one atomic JSON record and leaves no temp file behind', () => {
    recordRun('/repo/a', 1_000);
    recordRun('/repo/a', 2_000);

    const raw = readFileSync(ledgerPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['at', 'root', 'runLength']);
    expect(parsed).toEqual({ root: '/repo/a', runLength: 2, at: new Date(2_000).toISOString() });
    // tmp+rename: the temporary sibling never survives a successful write.
    expect(readdirSync(coordinationDir).sort()).toEqual([RUN_LEDGER_FILE_NAME]);
  });
});
