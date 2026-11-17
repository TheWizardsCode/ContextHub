/**
 * packages/herdr/src/dispatcher-anchor.provision.test.ts — shared
 * find-or-provision-under-lock helper (WL-0MWHWH68L007L7IO AC1).
 *
 * Pins the single coordination-lock + double-check + create + persist
 * sequence that all three placement strategies (`getItemTabAnchor`,
 * `getDispatcherTabAnchor`, `getDispatcherAnchor`) delegate to. The strategy
 * suites (`dispatcher-anchor.test.ts`, the stale-anchor regression fixtures)
 * exercise the delegation end-to-end; this file pins the helper's contract
 * directly: fast-path adoption, lock-busy raced re-check, in-lock double
 * check, create/persist failure semantics and the per-boundary fail-closed
 * detail reporting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findOrProvisionUnderLock,
  type ProvisionFind,
} from './dispatcher-anchor.provision.js';
import type { PlacementFailureDetail } from './dispatcher-anchor.contract.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'da-provision-'));
}
function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

let tmpDir: string;
let saved: string | undefined;

beforeEach(() => {
  tmpDir = mkTmp();
  saved = process.env.HERDR_COORDINATION_DIR;
  process.env.HERDR_COORDINATION_DIR = tmpDir;
});

afterEach(() => {
  if (saved !== undefined) process.env.HERDR_COORDINATION_DIR = saved;
  else delete process.env.HERDR_COORDINATION_DIR;
  cleanup(tmpDir);
  vi.restoreAllMocks();
});

/** Hold the coordination lock by creating the lock file directly. */
function holdLock(): string {
  const lockPath = path.join(tmpDir, 'downtime-coordination.lock');
  fs.writeFileSync(lockPath, '');
  return lockPath;
}

interface Hook<R> {
  find: () => Promise<ProvisionFind<R>>;
  create?: () => Promise<R | null>;
  adoptFound?: (value: R) => void;
  adoptCreated?: (value: R) => boolean | Promise<boolean>;
}

function run<R>(
  hooks: Hook<R>,
  report?: (detail: PlacementFailureDetail) => void,
) {
  return findOrProvisionUnderLock<R>({
    dir: tmpDir,
    find: hooks.find,
    create: hooks.create ?? (async () => null),
    ...(hooks.adoptFound ? { adoptFound: hooks.adoptFound } : {}),
    ...(hooks.adoptCreated ? { adoptCreated: hooks.adoptCreated } : {}),
    report,
    fastUnknownDetail: 'herdr-unreadable' as PlacementFailureDetail,
    inLockUnknownDetail: 'herdr-unreadable' as PlacementFailureDetail,
    racedUnknownDetail: 'dispatcher-workspace-unprovisionable' as PlacementFailureDetail,
    racedMissDetail: 'dispatcher-workspace-unprovisionable' as PlacementFailureDetail,
    createFailDetail: 'dispatcher-workspace-unprovisionable' as PlacementFailureDetail,
  });
}

describe('findOrProvisionUnderLock', () => {
  it('adopts a fast-path hit (no lock, no create)', async () => {
    const adoptFound = vi.fn();
    const got = await run({ find: async () => ({ status: 'found', value: 'A' }), adoptFound }, vi.fn());
    expect(got).toBe('A');
    expect(adoptFound).toHaveBeenCalledWith('A');
    expect(fs.existsSync(path.join(tmpDir, 'downtime-coordination.lock'))).toBe(false);
  });

  it('fails closed on a fast-path unknown and reports the fast boundary', async () => {
    const report = vi.fn();
    const got = await run({ find: async () => ({ status: 'unknown' }) }, report);
    expect(got).toBeNull();
    expect(report).toHaveBeenCalledWith('herdr-unreadable');
  });

  it('double-checks inside the lock and adopts a found anchor (no duplicate create)', async () => {
    let calls = 0;
    const create = vi.fn(async () => {
      throw new Error('must not create — a racer already provisioned');
    });
    const got = await run({
      find: async () => {
        calls += 1;
        return calls === 1 ? { status: 'none' } : { status: 'found', value: 'B' };
      },
      create,
    });
    expect(got).toBe('B');
    expect(create).not.toHaveBeenCalled();
    // The lock was released after the double-check.
    expect(fs.existsSync(path.join(tmpDir, 'downtime-coordination.lock'))).toBe(false);
  });

  it('creates under the lock when both the fast path and the double-check miss', async () => {
    let calls = 0;
    const create = vi.fn(async () => 'C');
    const adoptCreated = vi.fn(async () => true);
    const got = await run({
      find: async () => {
        calls += 1;
        return { status: 'none' };
      },
      create,
      adoptCreated,
    });
    expect(got).toBe('C');
    expect(create).toHaveBeenCalledTimes(1);
    expect(adoptCreated).toHaveBeenCalledWith('C');
  });

  it('fails closed when create() returns null and reports the create boundary', async () => {
    const report = vi.fn();
    const got = await run({ find: async () => ({ status: 'none' }), create: async () => null }, report);
    expect(got).toBeNull();
    expect(report).toHaveBeenCalledWith('dispatcher-workspace-unprovisionable');
  });

  it('fails closed when the created anchor cannot be persisted (adoptCreated false)', async () => {
    const report = vi.fn();
    const got = await run({
      find: async () => ({ status: 'none' }),
      create: async () => 'C',
      adoptCreated: async () => false,
    }, report);
    expect(got).toBeNull();
    expect(report).toHaveBeenCalledWith('dispatcher-workspace-unprovisionable');
  });

  it('reports the in-lock unknown boundary when the double-check cannot be read', async () => {
    const report = vi.fn();
    let calls = 0;
    const got = await run({
      find: async () => {
        calls += 1;
        return calls === 1 ? { status: 'none' } : { status: 'unknown' };
      },
    }, report);
    expect(got).toBeNull();
    expect(report).toHaveBeenCalledWith('herdr-unreadable');
  });

  it('adopts a racing caller result when the lock is already held (single raced re-check)', async () => {
    const lockPath = holdLock();
    const adoptFound = vi.fn();
    const create = vi.fn(async () => 'C');
    const got = await run({
      find: async () => ({ status: 'found', value: 'R' }),
      create,
      adoptFound,
    });
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    expect(got).toBe('R');
    expect(create).not.toHaveBeenCalled();
    expect(adoptFound).toHaveBeenCalledWith('R');
  });

  it('fails closed when the lock is held and the raced re-check misses', async () => {
    const lockPath = holdLock();
    const report = vi.fn();
    const got = await run({ find: async () => ({ status: 'none' }) }, report);
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    expect(got).toBeNull();
    expect(report).toHaveBeenCalledWith('dispatcher-workspace-unprovisionable');
  });

  it('reports the raced unknown boundary (never guesses from an unreadable list)', async () => {
    const lockPath = holdLock();
    const report = vi.fn();
    let calls = 0;
    const got = await run({
      find: async () => {
        calls += 1;
        // Fast path misses (lock acquisition is impossible — it is held), so
        // the raced single re-check is the one that cannot be read.
        return calls === 1 ? { status: 'none' } : { status: 'unknown' };
      },
    }, report);
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    expect(got).toBeNull();
    expect(report).toHaveBeenCalledWith('dispatcher-workspace-unprovisionable');
  });

  it('reports nothing and still fails closed when no report callback is wired', async () => {
    const got = await run({ find: async () => ({ status: 'unknown' }) });
    expect(got).toBeNull();
  });

  it('fails closed on an unreadable double-check without leaving the lock behind', async () => {
    let calls = 0;
    const report = vi.fn();
    const got = await run({
      find: async () => {
        calls += 1;
        return calls === 1 ? { status: 'none' } : { status: 'unknown' };
      },
    }, report);
    expect(got).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'downtime-coordination.lock'))).toBe(false);
  });
});
