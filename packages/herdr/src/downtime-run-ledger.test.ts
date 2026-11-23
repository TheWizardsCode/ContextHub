/**
 * packages/herdr/src/downtime-run-ledger.test.ts — the machine-scoped run
 * ledger that makes the twice-in-succession bound leadership-independent.
 *
 * Work item: WL-0MWT3Z9M9002Z9BF (parent WL-0MWKE9VF800101V9 AC1).
 *
 * Pins:
 *  1. a fresh ledger records the first dispatch of a root as a run of `1`;
 *  2. repeated dispatches to one root increment the run;
 *  3. a dispatch to a different root starts a fresh run of `1`;
 *  4. the record survives a "leadership hand-off" — a different caller reading
 *     the SAME machine directory sees the previous run (the whole point);
 *  5. every reader/writer is fail-open on a missing/corrupt/malformed ledger;
 *  6. `peekNextRunLength` derives the next value WITHOUT mutating the file, so
 *     the fail-open path stays consistent with the ledger;
 *  7. the on-disk shape is a single `{ root, runLength, at }` record written
 *     atomically (no leftover `.tmp`).
 *
 * Deterministic: real temporary coordination directory, injected clock, no
 * live `wl`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RUN_LEDGER_FILE_NAME,
  loadDispatchRun,
  peekNextRunLength,
  readCurrentDispatchRun,
  recordDispatchRun,
} from './downtime-run-ledger.js';

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

describe('run ledger — ordering-independent consecutive-run accounting', () => {
  it('records the first dispatch of a root as a run of 1', () => {
    expect(recordDispatchRun(coordinationDir, '/repo/a', 1_000)).toBe(1);
    expect(loadDispatchRun(coordinationDir)).toEqual({
      root: '/repo/a',
      runLength: 1,
      at: new Date(1_000).toISOString(),
    });
  });

  it('increments the run for repeated dispatches to one root', () => {
    expect(recordDispatchRun(coordinationDir, '/repo/a', 1_000)).toBe(1);
    expect(recordDispatchRun(coordinationDir, '/repo/a', 2_000)).toBe(2);
    expect(recordDispatchRun(coordinationDir, '/repo/a', 3_000)).toBe(3);
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 3 });
  });

  it('starts a fresh run of 1 when the dispatching root changes', () => {
    recordDispatchRun(coordinationDir, '/repo/a', 1_000);
    recordDispatchRun(coordinationDir, '/repo/a', 2_000);
    expect(recordDispatchRun(coordinationDir, '/repo/b', 3_000)).toBe(1);
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/b', length: 1 });
  });

  it('keeps a live run across a leadership hand-off (a different caller reads the same dir)', () => {
    // Leader 1 (whatever its own project root) dispatches twice to /repo/a.
    recordDispatchRun(coordinationDir, '/repo/a', 1_000);
    recordDispatchRun(coordinationDir, '/repo/a', 2_000);

    // Leadership moves to a different root/project: the ONLY shared state is
    // the machine coordination directory, so a fresh read still sees run = 2.
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 2 });
    // The next dispatch to /repo/a — from the new leader — extends, not resets.
    expect(recordDispatchRun(coordinationDir, '/repo/a', 3_000)).toBe(3);
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
    expect(recordDispatchRun(coordinationDir, '/repo/a', 1_000)).toBe(1);
    expect(readCurrentDispatchRun(coordinationDir)).toEqual({ root: '/repo/a', length: 1 });
  });

  it('records an empty root as a no-op run of 1 (defensive)', () => {
    expect(recordDispatchRun(coordinationDir, '', 1_000)).toBe(1);
    expect(loadDispatchRun(coordinationDir)).toBeNull();
  });
});

describe('run ledger — peek is a pure read', () => {
  it('derives the next length for the same root without mutating the ledger', () => {
    recordDispatchRun(coordinationDir, '/repo/a', 1_000);
    recordDispatchRun(coordinationDir, '/repo/a', 2_000);
    const before = readFileSync(ledgerPath(), 'utf-8');

    expect(peekNextRunLength(coordinationDir, '/repo/a')).toBe(3);
    expect(peekNextRunLength(coordinationDir, '/repo/b')).toBe(1);
    expect(readFileSync(ledgerPath(), 'utf-8')).toBe(before);
  });

  it('resolves 1 with no usable history', () => {
    expect(peekNextRunLength(coordinationDir, '/repo/a')).toBe(1);
  });
});

describe('run ledger — on-disk shape', () => {
  it('writes one atomic JSON record and leaves no temp file behind', () => {
    recordDispatchRun(coordinationDir, '/repo/a', 1_000);
    recordDispatchRun(coordinationDir, '/repo/a', 2_000);

    const raw = readFileSync(ledgerPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['at', 'root', 'runLength']);
    expect(parsed).toEqual({ root: '/repo/a', runLength: 2, at: new Date(2_000).toISOString() });
    // tmp+rename: the temporary sibling never survives a successful write.
    expect(readdirSync(coordinationDir).sort()).toEqual([RUN_LEDGER_FILE_NAME]);
  });
});
